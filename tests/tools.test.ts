import assert from "node:assert/strict";
import test from "node:test";

import { PindieRuntime } from "../src/runtime.ts";
import { EMPTY_STATE, getTaskStatus, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";
import {
  createPindieGateOpenTool,
  createPindieGateResolveTool,
} from "../src/tools/gate.ts";
import {
  createPindieTaskCompleteTool,
  createPindieTaskProgressTool,
  createPindieTaskRefineTool,
  createPindieTaskReplaceTool,
  createPindieTaskStartTool,
  createPindieVerificationRecordTool,
} from "../src/tools/task.ts";

class ToolTestStore implements PindieStateStore {
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  persistedState: PindieState;
  saveError: Error | null = null;

  constructor(initialState: PindieState) {
    this.persistedState = initialState;
  }

  async load(): Promise<PindieState> {
    return this.persistedState;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.saves.push({ projectRoot, state });
    this.persistedState = state;
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

function activeState(): PindieState {
  return {
    task: {
      goal: "Implement narrow tools",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Tools work" }],
      openLoops: { blockers: [], questions: [], nextIntent: "Continue" },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  };
}

function verifiedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      verification: {
        stale: false,
        checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "passed" }],
      },
    },
  };
}

function gatedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      humanGate: { kind: "approval", question: "Approve?" },
    },
  };
}

async function harness(initialState: PindieState = EMPTY_STATE) {
  const store = new ToolTestStore(initialState);
  const runtime = new PindieRuntime(store);
  await runtime.load("/repo");
  let changes = 0;
  const options = { onStateChange: () => { changes += 1; } };
  const tools = {
    start: createPindieTaskStartTool(runtime, options),
    replace: createPindieTaskReplaceTool(runtime, options),
    refine: createPindieTaskRefineTool(runtime, options),
    progress: createPindieTaskProgressTool(runtime, options),
    verify: createPindieVerificationRecordTool(runtime, options),
    complete: createPindieTaskCompleteTool(runtime, {
      ...options,
      getRunDuration: () => 522_000,
    }),
    gateOpen: createPindieGateOpenTool(runtime, options),
    gateResolve: createPindieGateResolveTool(runtime, options),
  };
  return { store, runtime, tools, get changes() { return changes; } };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

test("all eight narrow semantic tools have exact names, strict schemas, and sequential execution", async () => {
  const { tools } = await harness();
  assert.deepEqual(Object.values(tools).map((tool) => tool.name), [
    "pindie_task_start",
    "pindie_task_replace",
    "pindie_task_refine",
    "pindie_task_progress",
    "pindie_verification_record",
    "pindie_task_complete",
    "pindie_gate_open",
    "pindie_gate_resolve",
  ]);
  for (const tool of Object.values(tools)) {
    assert.equal(tool.executionMode, "sequential", tool.name);
    assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false, tool.name);
  }
});

test("start dispatches start_task with defaults and returns generated criterion IDs", async () => {
  const h = await harness();
  const result = await h.tools.start.execute("start", {
    goal: "Build M3",
    successCriteria: ["Surface works", "Gateway remains"],
  });
  assert.equal(h.runtime.state.task?.goal, "Build M3");
  assert.deepEqual(h.runtime.state.task?.constraints, []);
  assert.equal(h.runtime.state.task?.openLoops.nextIntent, null);
  assert.match(textOf(result), /- c1: Surface works\s*\n- c2: Gateway remains/);
  assert.equal(h.changes, 1);
});

test("start and replace require goal plus non-empty successCriteria", async () => {
  for (const name of ["start", "replace"] as const) {
    const h = await harness(name === "start" ? EMPTY_STATE : activeState());
    await assert.rejects((h.tools[name].execute as any)("call", { successCriteria: ["Works"] }), /goal is required/i);
    await assert.rejects((h.tools[name].execute as any)("call", { goal: "Task", successCriteria: [] }), /at least one success criterion/i);
  }
});

test("replace dispatches replace_task and preserves optional fields", async () => {
  const h = await harness(activeState());
  const result = await h.tools.replace.execute("replace", {
    goal: "Replacement",
    constraints: ["Focused"],
    successCriteria: ["Done"],
    nextIntent: "Implement",
  });
  assert.equal(h.runtime.state.task?.goal, "Replacement");
  assert.deepEqual(h.runtime.state.task?.constraints, ["Focused"]);
  assert.equal(h.runtime.state.task?.openLoops.nextIntent, "Implement");
  assert.match(textOf(result), /unfinished task replaced/i);
});

test("refine requires at least one field and dispatches refine_task", async () => {
  const h = await harness(activeState());
  await assert.rejects((h.tools.refine.execute as any)("refine", {}), /at least one refinement field/i);
  await h.tools.refine.execute("refine", {
    goal: "Refined",
    constraints: ["Keep M2"],
  });
  assert.equal(h.runtime.state.task?.goal, "Refined");
  assert.deepEqual(h.runtime.state.task?.constraints, ["Keep M2"]);
});

test("progress dispatches set_open_loops with blockers/questions/nextIntent", async () => {
  const h = await harness(activeState());
  await h.tools.progress.execute("progress", {
    blockers: ["Dependency"],
    questions: ["Which API?"],
    nextIntent: "Wait",
  });
  assert.deepEqual(h.runtime.state.task?.openLoops, {
    blockers: ["Dependency"],
    questions: ["Which API?"],
    nextIntent: "Wait",
  });
});

test("verification record preserves the current VerificationCheck semantics", async () => {
  const h = await harness(activeState());
  const check = { name: "tests", status: "passed" as const, covers: ["c1"], evidence: "passed" };
  await h.tools.verify.execute("verify", { check });
  assert.deepEqual(h.runtime.state.task?.verification.checks, [check]);
  assert.match(JSON.stringify(h.tools.verify.parameters), /criterion IDs.*not descriptions/i);
});

test("complete dispatches complete_task, preserves result semantics, and requires a summary", async () => {
  const h = await harness(verifiedState());
  await assert.rejects((h.tools.complete.execute as any)("complete", { summary: "   " }), /non-empty summary/i);
  const result = await h.tools.complete.execute("complete", { summary: "Implemented M3." });
  assert.equal(h.runtime.state.task?.completed, true);
  assert.equal(result.terminate, true);
  assert.match(textOf(result), /Summary:\s*\nImplemented M3\./);
  assert.match(textOf(result), /Duration: 8m 42s/);
  assert.match(textOf(result), /Verification:\s*\n- tests: passed/);
});

test("Gate open and resolve dispatch existing events and preserve result semantics", async () => {
  const opened = await harness(activeState());
  const openResult = await opened.tools.gateOpen.execute("open", {
    kind: "decision",
    question: "Which option?",
    options: ["A", "B"],
  });
  assert.equal(getTaskStatus(opened.runtime.state), "waiting_human");
  assert.equal(openResult.terminate, true);
  assert.match(textOf(openResult), /Options:\s*\n- A\s*\n- B/);

  const resolved = await harness(gatedState());
  const resolveResult = await resolved.tools.gateResolve.execute("resolve", {});
  assert.equal(resolved.runtime.state.task?.humanGate, null);
  assert.notEqual(resolveResult.terminate, true);
  assert.match(textOf(resolveResult), /Re-observe relevant project reality/i);
});

test("reducer and persistence failures propagate without publishing State changes", async () => {
  const reducerFailure = await harness(activeState());
  await assert.rejects(reducerFailure.tools.start.execute("start", {
    goal: "Overwrite",
    successCriteria: ["No"],
  }), /task_already_active/i);
  assert.deepEqual(reducerFailure.store.saves, []);

  const persistenceFailure = await harness();
  persistenceFailure.store.saveError = new Error("disk unavailable");
  await assert.rejects(persistenceFailure.tools.start.execute("start", {
    goal: "Task",
    successCriteria: ["Done"],
  }), /disk unavailable/i);
  assert.equal(persistenceFailure.runtime.state.task, null);
  assert.equal(persistenceFailure.changes, 0);
});

test("required and strict parameter contracts are represented in schemas", async () => {
  const { tools } = await harness();
  const schema = (tool: keyof typeof tools) => tools[tool].parameters as {
    required?: string[];
    minProperties?: number;
    properties: Record<string, { minItems?: number }>;
  };
  assert.deepEqual(schema("start").required, ["goal", "successCriteria"]);
  assert.equal(schema("start").properties.successCriteria.minItems, 1);
  assert.deepEqual(schema("replace").required, ["goal", "successCriteria"]);
  assert.equal(schema("refine").minProperties, 1);
  assert.deepEqual(schema("progress").required, ["blockers", "questions"]);
  assert.deepEqual(schema("verify").required, ["check"]);
  assert.deepEqual(schema("complete").required, ["summary"]);
  assert.deepEqual(schema("gateOpen").required, ["kind", "question"]);
  assert.equal(schema("gateResolve").required, undefined);
});
