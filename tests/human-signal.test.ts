import assert from "node:assert/strict";
import test from "node:test";

import { classifyHumanSignal } from "../src/human-signal.ts";
import type { CoreSettlementFacts } from "../src/core-integration.ts";
import type { PindieState, PindieTask } from "../src/state.ts";

function task(options: { blockers?: string[]; gate?: PindieTask["humanGate"]; completed?: boolean } = {}): PindieTask {
  return {
    goal: "Implement Human Signal policy",
    constraints: [],
    successCriteria: [{ id: "c1", description: "works" }],
    openLoops: { blockers: options.blockers ?? [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: options.gate ?? null,
    completed: options.completed ?? false,
  };
}

function settlement(currentTask: PindieTask, generation = 7): CoreSettlementFacts {
  const state: PindieState = { task: currentTask };
  const status = currentTask.completed ? "done" : currentTask.humanGate ? "waiting_human" : currentTask.openLoops.blockers.length ? "blocked" : "active";
  return {
    settlementGeneration: generation,
    projectRoot: "/repo",
    state,
    task: currentTask,
    snapshot: {
      authority: "coherent",
      taskStatus: status,
      verificationStatus: "pending",
      hasBlockers: currentTask.openLoops.blockers.length > 0,
      hasQuestions: false,
      completionReady: false,
    },
    runStartTaskStatus: "active",
    runStartTaskGoal: currentTask.goal,
    execution: { toolCalls: 0, observations: 0, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    durationMs: 1,
    cost: 0,
    taskConsumption: null,
  };
}

function current(currentTask: PindieTask, isIdle: boolean, automaticWorkSettled = isIdle) {
  return classifyHumanSignal({
    phase: "current",
    sessionId: "session",
    authority: "coherent",
    authorityUnavailableReason: null,
    taskStatus: currentTask.openLoops.blockers.length ? "blocked" : currentTask.humanGate ? "waiting_human" : "active",
    task: currentTask,
    isIdle,
    automaticWorkSettled,
    pendingMessageCount: 0,
    quotaResumeWaiting: false,
  });
}

function settled(currentTask: PindieTask, options: { automatic?: boolean; quota?: boolean; generation?: number } = {}) {
  return classifyHumanSignal({
    phase: "settlement",
    sessionId: "session",
    settlementGeneration: options.generation ?? 7,
    facts: settlement(currentTask, options.generation ?? 7),
    automaticSuccessorCommitted: options.automatic ?? false,
    quotaSuccessorCommitted: options.quota ?? false,
  });
}

test("running blocked work remains autonomous", () => {
  assert.equal(current(task({ blockers: ["missing credential"] }), false), null);
});

test("current and settlement phases own distinct blocked external eligibility", () => {
  const blockedTask = task({ blockers: ["missing credential"] });
  const currentSignal = current(blockedTask, true);
  assert.equal(currentSignal?.kind, "settled-blocked");
  assert.equal(currentSignal?.local, "soft");
  assert.equal(currentSignal?.external, "none");

  const settlementSignal = settled(blockedTask);
  assert.equal(settlementSignal?.kind, "settled-blocked");
  assert.equal(settlementSignal?.local, "soft");
  assert.equal(settlementSignal?.external, "attention");
});

test("idle blocked work requires automatic work to be settled", () => {
  assert.equal(current(task({ blockers: ["missing credential"] }), true, false), null);
});

test("Human Gate and unavailable authority are hard current signals", () => {
  const gate = current(task({ gate: { kind: "decision", question: "Choose", options: ["A", "B"] } }), false);
  assert.equal(gate?.kind, "human-gate");
  assert.equal(gate?.local, "hard");
  assert.equal(gate?.external, "attention");

  const unavailable = classifyHumanSignal({
    phase: "current", sessionId: "session", authority: "unavailable",
    authorityUnavailableReason: "state lease unavailable", taskStatus: "blocked",
    task: task({ blockers: ["x"], gate: { kind: "input", question: "ignored by precedence" } }),
    isIdle: true, automaticWorkSettled: true, pendingMessageCount: 0, quotaResumeWaiting: false,
  });
  assert.equal(unavailable?.kind, "authority-unavailable");
  assert.equal(unavailable?.local, "hard");
});

test("settlement classifies completed, blocked, and stopped without overlap", () => {
  assert.equal(settled(task({ completed: true }))?.kind, "completed");
  const blocked = settled(task({ blockers: ["missing credential"] }));
  assert.equal(blocked?.kind, "settled-blocked");
  assert.deepEqual(blocked?.detail, ["missing credential"]);
  assert.equal(settled(task())?.kind, "stopped");
});

test("automatic and quota successors suppress stopped and settled-blocked", () => {
  for (const currentTask of [task(), task({ blockers: ["missing"] })]) {
    assert.equal(settled(currentTask, { automatic: true }), null);
    assert.equal(settled(currentTask, { quota: true }), null);
  }
});

test("settlement generation participates in otherwise identical signal identity", () => {
  const currentTask = task({ blockers: ["same blocker"] });
  assert.notEqual(settled(currentTask, { generation: 7 })?.key, settled(currentTask, { generation: 8 })?.key);
});
