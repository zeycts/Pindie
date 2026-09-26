import assert from "node:assert/strict";
import test from "node:test";

import { PindieRuntime } from "../src/runtime.ts";
import { LearningSignalHolder, createCompletionLearningDispositionSeam } from "../src/learning-signal.ts";
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

function verifiedGatedState(): PindieState {
  const state = verifiedState();
  return {
    task: {
      ...state.task!,
      humanGate: { kind: "approval", question: "Approve?" },
    },
  };
}

async function harness(
  initialState: PindieState = EMPTY_STATE,
  resolveEvidence: (refs: readonly string[]) => string = (refs) =>
    `Harness factual evidence for ${refs.join(", ")}.`,
) {
  const store = new ToolTestStore(initialState);
  const runtime = new PindieRuntime(store);
  await runtime.load("/repo");
  let changes = 0;
  const resolverCalls: string[][] = [];
  const options = { onStateChange: () => { changes += 1; } };
  const tools = {
    start: createPindieTaskStartTool(runtime, options),
    replace: createPindieTaskReplaceTool(runtime, options),
    refine: createPindieTaskRefineTool(runtime, options),
    progress: createPindieTaskProgressTool(runtime, options),
    verify: createPindieVerificationRecordTool(runtime, {
      ...options,
      resolveEvidence: (refs) => {
        resolverCalls.push([...refs]);
        return resolveEvidence(refs);
      },
    }),
    complete: createPindieTaskCompleteTool(runtime, {
      ...options,
      onTaskCompleted: () => ({ durationMs: 522_000, cost: 0.46 }),
    }),
    gateOpen: createPindieGateOpenTool(runtime, options),
    gateResolve: createPindieGateResolveTool(runtime, options),
  };
  return {
    store,
    runtime,
    tools,
    resolverCalls,
    get changes() { return changes; },
  };
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

test("Task tool descriptions distinguish starting completed work from replacing unfinished work", async () => {
  const { tools } = await harness();
  assert.match(tools.start.description, /no current Task.*previous Task is completed/i);
  assert.match(tools.replace.description, /different unfinished current Task/i);
  assert.match(tools.replace.description, /completed Task.*pindie_task_start/i);
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

test("state-changing semantic results include focused causal projections", async () => {
  const started = await harness();
  const start = await started.tools.start.execute("start", {
    goal: "Visible Task",
    constraints: ["Stay focused"],
    successCriteria: ["Current state is visible"],
    nextIntent: "Refine the contract",
  });
  assert.match(textOf(start), /Current Task Contract:/);
  assert.match(textOf(start), /Task status: active/);
  assert.match(textOf(start), /Goal:\nVisible Task/);

  const refined = await started.tools.refine.execute("refine", { goal: "Refined Task" });
  assert.match(textOf(refined), /Current Task Contract:[\s\S]*Goal:\nRefined Task/);
  assert.match(textOf(refined), /Verification status: stale/);

  const progressed = await started.tools.progress.execute("progress", {
    blockers: ["Waiting on input"],
    questions: ["Which input?"],
    nextIntent: "Ask the human",
  });
  assert.match(textOf(progressed), /Current Pindie Progress:[\s\S]*Task status: blocked/);
  assert.match(textOf(progressed), /Blockers:\n- Waiting on input/);
  assert.match(textOf(progressed), /Questions:\n- Which input\?/);
  assert.match(textOf(progressed), /Next intent:\nAsk the human/);
  assert.doesNotMatch(textOf(progressed), /Verification checks:|Extension tests passed/);

  const verified = await harness(activeState(), () => "Tool: read\nOutcome: success");
  const verification = await verified.tools.verify.execute("verify", {
    check: { name: "tests", status: "passed", covers: ["c1"], evidenceRefs: ["ev:read"] },
  });
  assert.match(textOf(verification), /Recorded verification check:[\s\S]*Name: tests/);
  assert.match(textOf(verification), /Status: passed[\s\S]*Covers: c1/);
  assert.match(textOf(verification), /Verification status: passed/);
  assert.match(textOf(verification), /Criterion coverage: 1\/1/);
  assert.doesNotMatch(textOf(verification), /Tool: read|Harness factual evidence/);

  const gated = await harness({
    task: {
      ...verifiedState().task!,
      humanGate: null,
      verification: {
        stale: false,
        checks: [{
          name: "tests",
          status: "passed",
          covers: ["c1"],
          evidence: "unrelated materialized verification evidence",
        }],
      },
    },
  });
  const opened = await gated.tools.gateOpen.execute("open", {
    kind: "approval",
    question: "Approve this step?",
    options: ["Yes", "No"],
  });
  assert.match(textOf(opened), /Task status: waiting_human[\s\S]*Human Gate:[\s\S]*Question: Approve this step\?/);
  assert.doesNotMatch(textOf(opened), /unrelated materialized verification evidence/);
  const resolved = await (await harness(verifiedGatedState())).tools.gateResolve.execute("resolve", {});
  assert.match(textOf(resolved), /Task status: active/);
  assert.match(textOf(resolved), /Human Gate: none/);
  assert.doesNotMatch(textOf(resolved), /Verification checks:|unrelated materialized verification evidence/);
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

test("T01-T05 verification record accepts refs, calls the resolver exactly, and stores Harness evidence", async () => {
  const h = await harness(activeState(), () => "Tool: read\nOutcome: success");
  const schemaText = JSON.stringify(h.tools.verify.parameters);
  assert.doesNotMatch(schemaText, /"evidence"/);
  assert.match(schemaText, /evidenceRefs/);

  await assert.rejects(
    (h.tools.verify.execute as any)("verify-free-text", {
      check: { name: "tests", status: "passed", covers: ["c1"], evidence: "invented" },
    }),
    /free-text evidence is not accepted/,
  );
  await h.tools.verify.execute("verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: ["ev:read-1"],
    },
  });

  assert.deepEqual(h.resolverCalls, [["ev:read-1"]]);
  assert.deepEqual(h.runtime.state.task?.verification.checks, [{
    name: "tests",
    status: "passed",
    covers: ["c1"],
    evidence: "Tool: read\nOutcome: success",
  }]);
  assert.match(schemaText, /criterion IDs.*not descriptions/i);
});

test("T02-T03 verification schema requires one to four unique current refs", async () => {
  const { tools } = await harness(activeState());
  const checkSchema = (tools.verify.parameters as any).properties.check;
  assert.deepEqual(checkSchema.required, ["name", "status", "covers", "evidenceRefs"]);
  assert.equal(checkSchema.properties.evidenceRefs.minItems, 1);
  assert.equal(checkSchema.properties.evidenceRefs.maxItems, 4);
  assert.equal(checkSchema.properties.evidenceRefs.uniqueItems, true);
  assert.match(
    checkSchema.properties.evidenceRefs.description,
    /actual tool results.*Agent Run/i,
  );
});

test("T06-T07 model status and coverage are preserved while reducer validates criterion IDs", async () => {
  const passedErrorEvidence = await harness(activeState(), () => "Tool: read\nOutcome: error");
  await passedErrorEvidence.tools.verify.execute("verify", {
    check: {
      name: "rejection",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: ["ev:error-result"],
    },
  });
  assert.deepEqual(passedErrorEvidence.runtime.state.task?.verification.checks[0], {
    name: "rejection",
    status: "passed",
    covers: ["c1"],
    evidence: "Tool: read\nOutcome: error",
  });

  const invalidCoverage = await harness(activeState());
  await assert.rejects(
    invalidCoverage.tools.verify.execute("verify", {
      check: {
        name: "tests",
        status: "failed",
        covers: ["c999"],
        evidenceRefs: ["ev:read-1"],
      },
    }),
    /unknown_success_criterion.*c999/i,
  );
  assert.deepEqual(invalidCoverage.runtime.state.task?.verification.checks, []);
});

test("T08 resolver failures prevent dispatch and leave State unchanged", async () => {
  const h = await harness(activeState(), (refs) => {
    throw new Error(`Unknown or stale Pindie evidence reference: ${refs[0]}`);
  });
  const before = structuredClone(h.runtime.state);
  await assert.rejects(
    h.tools.verify.execute("verify", {
      check: {
        name: "tests",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: ["ev:fabricated"],
      },
    }),
    /Unknown or stale Pindie evidence reference: ev:fabricated/,
  );
  assert.deepEqual(h.runtime.state, before);
  assert.deepEqual(h.store.saves, []);
  assert.equal(h.changes, 0);
});

test("T09-T11 direct execution rejects empty, excessive, and duplicate refs", async () => {
  const { tools } = await harness(activeState());
  const check = { name: "tests", status: "passed", covers: ["c1"] };
  await assert.rejects(
    (tools.verify.execute as any)("empty", { check: { ...check, evidenceRefs: [] } }),
    /at least one evidence reference/,
  );
  await assert.rejects(
    (tools.verify.execute as any)("many", {
      check: { ...check, evidenceRefs: ["ev:1", "ev:2", "ev:3", "ev:4", "ev:5"] },
    }),
    /at most 4 evidence references/,
  );
  await assert.rejects(
    (tools.verify.execute as any)("duplicate", {
      check: { ...check, evidenceRefs: ["ev:1", "ev:1"] },
    }),
    /must be unique/,
  );
});

test("T12-T13 factual error evidence may support passed judgment without copying raw evidence", async () => {
  const rawLog = "raw-log-line".repeat(1000);
  const h = await harness(activeState(), () => `Tool: bash\nOutcome: error\nResult:\n${rawLog}`);
  const verification = await h.tools.verify.execute("verify", {
    check: {
      name: "invalid input rejected",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: ["ev:bash-error"],
    },
  });
  assert.equal(h.runtime.state.task?.verification.checks[0]?.status, "passed");
  assert.match(textOf(verification), /Verification check 'invalid input rejected' recorded\./);
  assert.match(textOf(verification), /Covers: c1/);
  assert.match(textOf(verification), /Criterion coverage: 1\/1/);
  assert.doesNotMatch(textOf(verification), /raw-log-line/);
});

test("complete dispatches complete_task, preserves result semantics, and requires a summary", async () => {
  const h = await harness(verifiedState());
  await assert.rejects((h.tools.complete.execute as any)("complete", { summary: "   " }), /non-empty summary/i);
  const result = await h.tools.complete.execute("complete", { summary: "Implemented M3." });
  assert.equal(h.runtime.state.task?.completed, true);
  assert.equal(result.terminate, true);
  assert.match(textOf(result), /Summary:\s*\nImplemented M3\./);
  assert.match(textOf(result), /Duration: 8m 42s/);
  assert.match(textOf(result), /Cost: \$0\.46/);
  assert.match(textOf(result), /Verification:\s*\n- tests: passed/);
});

test("Core-only completion stays terminal without SI disposition", async () => {
  const h = await harness(verifiedState());
  const result = await h.tools.complete.execute("complete", { summary: "Finished." });
  assert.equal(result.terminate, true);
  assert.doesNotMatch(textOf(result), /learning checkpoint/i);
  assert.equal(h.runtime.state.task?.completed, true);
});

test("completion seam stages before dispatch, commits on success and rolls back only its own signal on failure", async () => {
  const h = await harness(verifiedState());
  const holder = new LearningSignalHolder();
  holder.begin(1);
  const learningDisposition = createCompletionLearningDispositionSeam({
    holder, getGeneration: () => 1, isRequired: () => true,
  });
  const complete = createPindieTaskCompleteTool(h.runtime, { learningDisposition });
  const input = { summary: "Done", learningDisposition: { kind: "signal" as const, signal: { intent: "derive-local" as const, reason: "Lesson" } } };
  const originalSave = h.store.save.bind(h.store);
  let observedBeforeSave = false;
  h.store.save = async (root, state) => {
    observedBeforeSave = holder.has(1) && h.runtime.state.task?.completed === false;
    throw new Error("save failed");
  };
  await assert.rejects(complete.execute("failed", input), /save failed/);
  assert.equal(observedBeforeSave, true, "signal was staged before asynchronous dispatch");
  assert.equal(holder.has(1), false, "failed dispatch rolls back the staged signal");
  assert.equal(h.runtime.state.task?.completed, false);
  h.store.save = originalSave;
  assert.equal((await complete.execute("success", input)).terminate, true);
  assert.equal(holder.has(1), true, "successful dispatch retains the staged signal");
  assert.equal(holder.take(1)?.reason, "Lesson");

  const callbackFailure = await harness(verifiedState());
  const committedSignal = new LearningSignalHolder();
  committedSignal.begin(3);
  await assert.rejects(createPindieTaskCompleteTool(callbackFailure.runtime, {
    learningDisposition: createCompletionLearningDispositionSeam({
      holder: committedSignal, getGeneration: () => 3, isRequired: () => true,
    }),
    onStateChange: () => { throw new Error("projection failed after commit"); },
  }).execute("committed", input), /projection failed after commit/);
  assert.equal(callbackFailure.runtime.state.task?.completed, true);
  assert.equal(committedSignal.take(3)?.reason, "Lesson", "post-commit callback failure must not roll back the signal");

  const prior = await harness(verifiedState());
  const earlier = new LearningSignalHolder();
  earlier.begin(2);
  assert.equal(earlier.accept(2, { intent: "derive-local", reason: "Earlier" }), true);
  const priorSeam = createCompletionLearningDispositionSeam({ holder: earlier, getGeneration: () => 2, isRequired: () => true });
  prior.store.saveError = new Error("save failed");
  await assert.rejects(createPindieTaskCompleteTool(prior.runtime, { learningDisposition: priorSeam }).execute("prior", {
    summary: "Done", learningDisposition: { kind: "already-signaled" },
  }), /save failed/);
  assert.equal(earlier.take(2)?.reason, "Earlier", "independent earlier signal is not rolled back");
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
