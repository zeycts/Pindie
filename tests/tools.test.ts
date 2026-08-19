import assert from "node:assert/strict";
import test from "node:test";

import { PindieRuntime } from "../src/runtime.ts";
import { EMPTY_STATE, getTaskStatus, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";
import { createPindieGateTool } from "../src/tools/gate.ts";
import { createPindieStateTool } from "../src/tools/state.ts";

class ToolTestStore implements PindieStateStore {
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  persistedState: PindieState;
  beforeSave: (() => Promise<void>) | null = null;

  constructor(initialState: PindieState) {
    this.persistedState = initialState;
  }

  async load(): Promise<PindieState> {
    return this.persistedState;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    this.saves.push({ projectRoot, state });
    if (this.beforeSave) await this.beforeSave();
    this.persistedState = state;
  }
}

function activeState(): PindieState {
  return {
    task: {
      goal: "Implement Pindie tools",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Tool behavior works" }],
      openLoops: { blockers: [], questions: [], nextIntent: "Write tool tests" },
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
        checks: [
          {
            name: "tests",
            status: "passed",
            covers: ["c1"],
            evidence: "Tool tests passed.",
          },
        ],
      },
    },
  };
}

function gatedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      humanGate: {
        kind: "approval",
        question: "Approve the tool interface?",
      },
    },
  };
}

async function createHarness(initialState: PindieState = EMPTY_STATE) {
  const store = new ToolTestStore(initialState);
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");

  return {
    store,
    runtime,
    stateTool: createPindieStateTool(runtime),
    gateTool: createPindieGateTool(runtime),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

test("S01 pindie_state maps start_task with defaults", async () => {
  const { runtime, store, stateTool } = await createHarness();

  const result = await stateTool.execute("call", {
    action: "start_task",
    goal: "Build custom tools",
    successCriteria: ["Both tools are Pi-compatible"],
  });

  assert.equal(runtime.state.task?.goal, "Build custom tools");
  assert.deepEqual(runtime.state.task?.constraints, []);
  assert.equal(runtime.state.task?.openLoops.nextIntent, null);
  assert.deepEqual(runtime.state.task?.successCriteria, [
    { id: "c1", description: "Both tools are Pi-compatible" },
  ]);
  assert.equal(store.saves.length, 1);
  assert.deepEqual(result.details, { state: runtime.state });
});

test("S02 pindie_state maps refine_task", async () => {
  const { runtime, stateTool } = await createHarness(activeState());

  await stateTool.execute("call", {
    action: "refine_task",
    goal: "Implement current Pi custom tools",
    constraints: ["Use sequential execution"],
  });

  assert.equal(runtime.state.task?.goal, "Implement current Pi custom tools");
  assert.deepEqual(runtime.state.task?.constraints, ["Use sequential execution"]);
});

test("S03 pindie_state maps one atomic set_open_loops event", async () => {
  const { runtime, stateTool } = await createHarness(activeState());

  await stateTool.execute("call", {
    action: "set_open_loops",
    blockers: ["Waiting for access"],
    questions: ["Which environment?"],
  });

  assert.deepEqual(runtime.state.task?.openLoops, {
    blockers: ["Waiting for access"],
    questions: ["Which environment?"],
    nextIntent: null,
  });
});

test("S04 pindie_state maps one record_verification check", async () => {
  const { runtime, stateTool } = await createHarness(activeState());
  const check = {
    name: "tests",
    status: "passed" as const,
    covers: ["c1"],
    evidence: "Tool tests passed.",
  };

  await stateTool.execute("call", { action: "record_verification", check });

  assert.deepEqual(runtime.state.task?.verification.checks, [check]);
});

test("S05 and S10 complete_task persists completion and terminates", async () => {
  const { runtime, store, stateTool } = await createHarness(verifiedState());

  const result = await stateTool.execute("call", { action: "complete_task" });

  assert.equal(runtime.state.task?.completed, true);
  assert.equal(store.persistedState.task?.completed, true);
  assert.equal(result.terminate, true);
});

test("S06 pindie_state exposes only approved semantic actions", async () => {
  const { stateTool } = await createHarness();
  const schema = stateTool.parameters as {
    properties: { action: { enum: string[] } };
  };

  assert.deepEqual(schema.properties.action.enum, [
    "start_task",
    "refine_task",
    "set_open_loops",
    "record_verification",
    "complete_task",
  ]);
  const serialized = JSON.stringify(stateTool.parameters);
  assert.doesNotMatch(serialized, /patch_state|replace_state|set_completed/);
  assert.doesNotMatch(serialized, /invalidate_verification|human_gate/);
});

test("S07 invalid action-specific parameters are rejected", async () => {
  const { stateTool } = await createHarness();

  await assert.rejects(
    stateTool.execute("call", {
      action: "start_task",
      goal: "Invalid task",
      successCriteria: [],
    }),
    /at least one success criterion/i,
  );
  await assert.rejects(
    stateTool.execute("call", { action: "refine_task" }),
    /at least one.*refinement/i,
  );
});

test("S08 reducer transition failures surface code and actionable message", async () => {
  const { store, stateTool } = await createHarness(activeState());

  await assert.rejects(
    stateTool.execute("call", {
      action: "start_task",
      goal: "Overwrite active task",
      successCriteria: ["Replacement succeeds"],
    }),
    /task_already_active.*Complete the current task/i,
  );
  assert.deepEqual(store.saves, []);
});

test("refine_task with no success criteria surfaces the Core State rejection", async () => {
  const initialState = activeState();
  const { runtime, store, stateTool } = await createHarness(initialState);

  await assert.rejects(
    stateTool.execute("call", {
      action: "refine_task",
      successCriteria: [],
    }),
    /invalid_state.*at least one success criterion/i,
  );

  assert.equal(runtime.state, initialState);
  assert.deepEqual(store.saves, []);
});

test("S09 successful pindie_state results include current State details", async () => {
  const { runtime, stateTool } = await createHarness(activeState());

  const result = await stateTool.execute("call", {
    action: "set_open_loops",
    blockers: [],
    questions: [],
    nextIntent: "Continue",
  });

  assert.deepEqual(result.details, { state: runtime.state });
});

test("S11 rejected complete_task does not terminate or persist", async () => {
  const { runtime, store, stateTool } = await createHarness(activeState());

  const error = await stateTool
    .execute("call", { action: "complete_task" })
    .then(
      () => assert.fail("Expected complete_task to reject"),
      (failure: unknown) => failure,
    );

  assert.match(String(error), /verification_pending/);
  assert.equal((error as { terminate?: boolean }).terminate, undefined);
  assert.equal(runtime.state.task?.completed, false);
  assert.deepEqual(store.saves, []);
});

test("S12 pindie_state execution is sequential", async () => {
  const { stateTool } = await createHarness();
  assert.equal(stateTool.executionMode, "sequential");
});

test("G01 opening a gate persists waiting_human before terminating", async () => {
  const { runtime, store, gateTool } = await createHarness(activeState());

  const result = await gateTool.execute("call", {
    action: "open",
    kind: "decision",
    question: "Which tool wording should we use?",
    options: ["Short", "Detailed"],
  });

  assert.equal(getTaskStatus(runtime.state), "waiting_human");
  assert.equal(store.persistedState.task?.humanGate?.kind, "decision");
  assert.match(textOf(result), /Which tool wording should we use\?/);
  assert.match(textOf(result), /Options:\s*\n- Short\s*\n- Detailed/);
  assert.equal(result.terminate, true);
});

test("G02 gate result waits for persistence before terminating", async () => {
  const harness = await createHarness(activeState());
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  harness.store.beforeSave = () =>
    new Promise<void>((resolve) => {
      releaseSave = resolve;
      markSaveStarted();
    });
  let settled = false;

  const execution = harness.gateTool
    .execute("call", {
      action: "open",
      kind: "approval",
      question: "Approve release?",
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await saveStarted;

  assert.equal(settled, false);
  assert.equal(harness.runtime.state.task?.humanGate, null);
  assert.equal(harness.store.persistedState.task?.humanGate, null);

  releaseSave();
  const result = await execution;

  assert.equal(result.terminate, true);
  assert.equal(harness.store.persistedState.task?.humanGate?.kind, "approval");
});

test("G03 opening a gate without a task rejects without termination", async () => {
  const { store, gateTool } = await createHarness();

  const error = await gateTool
    .execute("call", {
      action: "open",
      kind: "input",
      question: "Provide requirements",
    })
    .then(
      () => assert.fail("Expected open to reject"),
      (failure: unknown) => failure,
    );

  assert.match(String(error), /no_current_task/);
  assert.equal((error as { terminate?: boolean }).terminate, undefined);
  assert.deepEqual(store.saves, []);
});

test("G04 a second gate is rejected and the existing gate is preserved", async () => {
  const initialState = gatedState();
  const { runtime, store, gateTool } = await createHarness(initialState);

  await assert.rejects(
    gateTool.execute("call", {
      action: "open",
      kind: "input",
      question: "Another question?",
    }),
    /human_gate_already_open/,
  );

  assert.equal(runtime.state, initialState);
  assert.deepEqual(store.saves, []);
});

test("G05 resolving a gate persists and reminds the model to re-observe", async () => {
  const { runtime, store, gateTool } = await createHarness(gatedState());

  const result = await gateTool.execute("call", { action: "resolve" });

  assert.equal(runtime.state.task?.humanGate, null);
  assert.equal(store.persistedState.task?.humanGate, null);
  assert.notEqual(result.terminate, true);
  assert.match(textOf(result), /Human Gate resolved.*Re-observe relevant project reality/i);
});

test("G06 resolving without a gate is rejected", async () => {
  const { store, gateTool } = await createHarness(activeState());

  await assert.rejects(
    gateTool.execute("call", { action: "resolve" }),
    /no_human_gate/,
  );
  assert.deepEqual(store.saves, []);
});

test("G07 pindie_gate exposes only open/resolve and executes sequentially", async () => {
  const { gateTool } = await createHarness();
  const schema = gateTool.parameters as {
    properties: { action: { enum: string[] } };
  };

  assert.deepEqual(schema.properties.action.enum, ["open", "resolve"]);
  assert.equal(gateTool.executionMode, "sequential");
});
