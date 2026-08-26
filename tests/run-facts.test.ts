import assert from "node:assert/strict";
import test from "node:test";

import {
  beginAgentRunFacts,
  deriveSemanticRunFacts,
  recordSuccessfulCapability,
} from "../src/run-facts.ts";
import { EMPTY_STATE, type HumanGate, type PindieState, type PindieTask } from "../src/state.ts";
import { reduceState } from "../src/transitions.ts";

function task(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Cut over the semantic gateway",
    constraints: [],
    successCriteria: [{ id: "c1", description: "M2 works" }],
    openLoops: { blockers: [], questions: [], nextIntent: "Implement M2" },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function completedTask(): PindieTask {
  return task({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: {
      stale: false,
      checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "passed" }],
    },
    completed: true,
  });
}

function gate(): HumanGate {
  return { kind: "decision", question: "Ship?", options: ["Yes", "No"] };
}

function coherentFacts(context: ReturnType<typeof beginAgentRunFacts>, state: PindieState) {
  const facts = deriveSemanticRunFacts(context, state, context.externalStateEpochAtRunStart);
  assert.equal(facts.stateAvailable, true);
  assert.equal(facts.runCoherent, true);
  return facts;
}

test("R01 no current Task derives empty coherent relations", () => {
  const facts = coherentFacts(beginAgentRunFacts(EMPTY_STATE, 0), EMPTY_STATE);
  assert.equal(facts.taskRelation, "none");
  assert.equal(facts.completionRelation, "not_completed");
  assert.equal(facts.gateRelation, "none");
});

test("R02 preexisting untouched active Task preserves identity relation", () => {
  const state = { task: task() };
  assert.equal(coherentFacts(beginAgentRunFacts(state, 2), state).taskRelation, "preexisting_untouched");
});

test("R03 real semantic change creates a changed Task relation", () => {
  const state = { task: task() };
  const result = reduceState(state, { type: "refine_task", goal: "Refined M2" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.state.task, state.task);
  assert.equal(coherentFacts(beginAgentRunFacts(state, 0), result.state).taskRelation, "preexisting_changed");
});

test("R04 no-op semantic transition keeps the Task untouched", () => {
  const state = { task: task() };
  const result = reduceState(state, { type: "refine_task", goal: state.task.goal });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state, state);
  assert.equal(coherentFacts(beginAgentRunFacts(state, 0), result.state).taskRelation, "preexisting_untouched");
});

test("R05 idle Run records a successful start as introduced", () => {
  const context = recordSuccessfulCapability(beginAgentRunFacts(EMPTY_STATE, 0), "task.start");
  assert.equal(coherentFacts(context, { task: task() }).taskRelation, "introduced_during_run");
});

test("R06 preexisting Run records a successful replacement as introduced", () => {
  const initial = { task: task({ goal: "Old" }) };
  const context = recordSuccessfulCapability(beginAgentRunFacts(initial, 0), "task.replace");
  assert.equal(coherentFacts(context, { task: task({ goal: "New" }) }).taskRelation, "introduced_during_run");
});

test("R07 task.start records introduction", () => {
  const context = recordSuccessfulCapability(beginAgentRunFacts(EMPTY_STATE, 0), "task.start");
  assert.equal(context.taskIntroducedDuringRun, true);
});

test("R08 task.replace records introduction", () => {
  const context = recordSuccessfulCapability(beginAgentRunFacts({ task: task() }, 0), "task.replace");
  assert.equal(context.taskIntroducedDuringRun, true);
});

test("R09 unrelated capability leaves introduction unchanged", () => {
  const context = beginAgentRunFacts({ task: task() }, 0);
  assert.equal(recordSuccessfulCapability(context, "task.refine"), context);
  const introduced = recordSuccessfulCapability(context, "task.start");
  assert.equal(recordSuccessfulCapability(introduced, "project.mutate"), introduced);
});

test("R10 completed Task already present at Run start completed before Run", () => {
  const state = { task: completedTask() };
  assert.equal(coherentFacts(beginAgentRunFacts(state, 0), state).completionRelation, "completed_before_run");
});

test("R11 Task completed after Run start completed during Run", () => {
  const initial = { task: task() };
  const current = { task: completedTask() };
  assert.equal(coherentFacts(beginAgentRunFacts(initial, 0), current).completionRelation, "completed_during_run");
});

test("R12 Gate existing at Run start retains existed-before relation", () => {
  const state = { task: task({ humanGate: gate() }) };
  assert.equal(coherentFacts(beginAgentRunFacts(state, 0), state).gateRelation, "existed_before_run");
});

test("R13 Gate opened during Run derives opened-during relation", () => {
  const initial = { task: task() };
  const current = { task: { ...initial.task, humanGate: gate() } };
  assert.equal(coherentFacts(beginAgentRunFacts(initial, 0), current).gateRelation, "opened_during_run");
});

test("R14 resolving an old Gate then opening an identical Gate derives opened during Run", () => {
  const originalGate = gate();
  const initial = { task: task({ humanGate: originalGate }) };
  const resolved = reduceState(initial, { type: "resolve_human_gate" });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const opened = reduceState(resolved.state, {
    type: "open_human_gate",
    gate: { ...originalGate, options: [...originalGate.options!] },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.state.task?.humanGate, originalGate);
  assert.notEqual(opened.state.task?.humanGate, originalGate);
  assert.equal(coherentFacts(beginAgentRunFacts(initial, 0), opened.state).gateRelation, "opened_during_run");
});

test("R15 external epoch mismatch derives stale available authority", () => {
  const state = { task: task() };
  assert.deepEqual(deriveSemanticRunFacts(beginAgentRunFacts(state, 3), state, 4), {
    stateAvailable: true,
    runCoherent: false,
  });
});

test("R16 available State without Run context derives stale authority", () => {
  assert.deepEqual(deriveSemanticRunFacts(null, EMPTY_STATE, 0), {
    stateAvailable: true,
    runCoherent: false,
  });
});

test("R17 unavailable authoritative State derives unavailable authority", () => {
  assert.deepEqual(deriveSemanticRunFacts(null, null, 0), { stateAvailable: false });
});

test("R18 coherent idle baseline reconstructs a newly appearing Task", () => {
  const context = beginAgentRunFacts(EMPTY_STATE, 0);
  assert.equal(context.taskIntroducedDuringRun, false);
  assert.equal(coherentFacts(context, { task: task() }).taskRelation, "introduced_during_run");
});
