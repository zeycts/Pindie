import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPindieSystemContract,
  createPindieStateCheckpointMessage,
  createPindieRunBaselineMessage,
  isPindieStateCheckpointMessage,
  isPindieRunBaselineMessage,
  PINDIE_STATE_CHECKPOINT_END,
  PINDIE_STATE_CHECKPOINT_START,
  PINDIE_STATE_CHECKPOINT_TYPE,
  PINDIE_RUN_BASELINE_END,
  PINDIE_RUN_BASELINE_START,
  PINDIE_RUN_BASELINE_TYPE,
  PINDIE_SYSTEM_CONTRACT_END,
  PINDIE_SYSTEM_CONTRACT_START,
  renderCurrentPindieActionEligibility,
  renderCurrentPindieTaskState,
  renderPindieRunBaseline,
  renderPindieStateCheckpoint,
  renderPindieSystemContract,
} from "../src/context.ts";
import { createPolicySnapshot } from "../src/policy.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function state(): PindieState {
  return {
    task: {
      goal: "Wire Pindie into Pi",
      constraints: ["Preserve Pi's Agent Loop"],
      successCriteria: [{ id: "c1", description: "Extension wiring works" }],
      openLoops: {
        blockers: ["Awaiting API access"],
        questions: ["Which release channel?"],
        nextIntent: "Run tests",
      },
      verification: {
        stale: false,
        checks: [{
          name: "tests",
          status: "passed",
          covers: ["c1"],
          evidence: "Extension tests passed.",
        }],
      },
      humanGate: {
        kind: "decision",
        question: "Choose a release strategy.",
        options: ["Canary", "Immediate"],
      },
      completed: false,
    },
  };
}

const snapshot: SemanticSnapshot = {
  authority: "coherent",
  taskStatus: "waiting_human",
  verificationStatus: "passed",
  hasBlockers: true,
  hasQuestions: true,
  completionReady: false,
  taskRelation: "preexisting_untouched",
  completionRelation: "not_completed",
  gateRelation: "existed_before_run",
};

test("stable Pindie System Contract is deterministic, complete, and excludes current Policy", () => {
  const first = renderPindieSystemContract();
  assert.equal(first, renderPindieSystemContract());
  assert.match(first, new RegExp(`^${PINDIE_SYSTEM_CONTRACT_START}`));
  assert.match(first, new RegExp(`${PINDIE_SYSTEM_CONTRACT_END}$`));
  assert.match(first, /Execution Gateway is authoritative/);
  assert.match(first, /Tool visibility is not authorization/);
  assert.match(first, /Use current Task, verification, Human Gate, and runtime facts/);
  assert.match(first, /Gateway denial is factual runtime feedback/);
  assert.match(first, /latest Pindie Run Baseline/);
  assert.match(first, /append-only runtime updates/i);
  assert.match(first, /Seed Strategies are optional, advisory/);
  assert.match(first, /Seed Strategies:/);
  assert.doesNotMatch(first, /Current Policy Snapshot/);
  assert.doesNotMatch(first, /Approach: architecture-first/);
});

test("Pindie appends the stable contract to Pi's prompt idempotently", () => {
  const base = "Pi system contract";
  const appended = appendPindieSystemContract(base);
  assert.match(appended, /^Pi system contract\n\n<PINDIE_SYSTEM_CONTRACT>/);
  assert.ok(appended.startsWith(base));
  assert.equal(appendPindieSystemContract(appended), appended);
  assert.equal((appended.match(/<PINDIE_SYSTEM_CONTRACT>/g) ?? []).length, 1);
});

test("Run Baseline preserves all useful Runtime Context facts as hidden metadata", () => {
  const content = renderPindieRunBaseline(state(), snapshot);
  for (const expected of [
    "Agent Run authority: coherent",
    "Task status: waiting_human",
    "Verification status: passed",
    "Goal:\nWire Pindie into Pi",
    "Constraints:\n- Preserve Pi's Agent Loop",
    "Success criteria:\n- c1: Extension wiring works",
    "Blockers:\n- Awaiting API access",
    "Questions:\n- Which release channel?",
    "Next intent:\nRun tests",
    "tests — passed — covers: c1\n  Evidence: Extension tests passed.",
    "Human Gate:\n- Kind: decision\n- Question: Choose a release strategy.",
    "- Options:\n  - Canary\n  - Immediate",
    "Current Pindie Action Eligibility:",
    "- task refine: allowed",
  ]) assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, new RegExp(`^${PINDIE_RUN_BASELINE_START}`));
  assert.match(content, new RegExp(`${PINDIE_RUN_BASELINE_END}$`));

  const message = createPindieRunBaselineMessage(state(), snapshot);
  assert.equal(message.customType, PINDIE_RUN_BASELINE_TYPE);
  assert.equal(message.display, false);
  assert.ok(isPindieRunBaselineMessage({ ...message, role: "custom" }));
  assert.equal(isPindieRunBaselineMessage({ ...message, customType: "other", role: "custom" }), false);
});

test("current Action Eligibility uses the same capability derivation across important Run states", () => {
  const snapshot = (overrides: Partial<Extract<SemanticSnapshot, { authority: "coherent" }>>): SemanticSnapshot => ({
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  });
  const expected = (rendered: string, label: string, value: "allowed" | "not eligible") => {
    assert.match(rendered, new RegExp(`^- ${label}: ${value}$`, "m"));
  };

  const idle = renderCurrentPindieActionEligibility(snapshot({
    taskStatus: "idle",
    taskRelation: "none",
  }));
  expected(idle, "task start", "allowed");
  expected(idle, "project mutation", "not eligible");
  expected(idle, "task refine", "not eligible");

  const active = renderCurrentPindieActionEligibility(snapshot({}));
  for (const label of ["project mutation", "task replace", "task refine", "task progress", "verification record", "gate open"]) {
    expected(active, label, "allowed");
  }
  expected(active, "task complete", "not eligible");

  const introduced = renderCurrentPindieActionEligibility(snapshot({
    taskRelation: "introduced_during_run",
  }));
  expected(introduced, "task replace", "not eligible");
  const changed = renderCurrentPindieActionEligibility(snapshot({
    taskRelation: "preexisting_changed",
  }));
  expected(changed, "task replace", "not eligible");

  const blocked = renderCurrentPindieActionEligibility(snapshot({
    taskStatus: "blocked",
    hasBlockers: true,
  }));
  expected(blocked, "project mutation", "allowed");
  expected(blocked, "task progress", "allowed");
  expected(blocked, "task complete", "not eligible");

  const waitingHuman = renderCurrentPindieActionEligibility(snapshot({
    taskStatus: "waiting_human",
    gateRelation: "existed_before_run",
  }));
  expected(waitingHuman, "task refine", "allowed");
  expected(waitingHuman, "gate resolve", "allowed");
  expected(waitingHuman, "project mutation", "not eligible");
  expected(waitingHuman, "gate open", "not eligible");

  const ready = renderCurrentPindieActionEligibility(snapshot({
    completionReady: true,
    verificationStatus: "passed",
  }));
  expected(ready, "task complete", "allowed");

  const done = renderCurrentPindieActionEligibility(snapshot({
    taskStatus: "done",
    completionRelation: "completed_before_run",
  }));
  expected(done, "task start", "allowed");
  expected(done, "project mutation", "not eligible");
  expected(done, "task complete", "not eligible");

  const completedDuringRun = renderCurrentPindieActionEligibility(snapshot({
    taskStatus: "done",
    taskRelation: "preexisting_changed",
    completionRelation: "completed_during_run",
  }));
  expected(completedDuringRun, "task start", "not eligible");
  expected(completedDuringRun, "policy declaration", "allowed");

  const stale = renderCurrentPindieActionEligibility({
    authority: "stale",
    taskStatus: "active",
    verificationStatus: "stale",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
  });
  expected(stale, "policy declaration", "allowed");
  expected(stale, "project mutation", "not eligible");
  expected(stale, "task refine", "not eligible");

  const unavailable = renderCurrentPindieActionEligibility({ authority: "unavailable" });
  expected(unavailable, "policy declaration", "allowed");
  expected(unavailable, "task start", "not eligible");
});

test("State Checkpoint preserves current State, eligibility, policy, and hidden metadata", () => {
  const policy = createPolicySnapshot({
    approach: "architecture-first",
    modifiers: ["minimal-change"],
  });
  const content = renderPindieStateCheckpoint(state(), snapshot, policy);
  assert.match(content, new RegExp(`^${PINDIE_STATE_CHECKPOINT_START}`));
  assert.match(content, new RegExp(`${PINDIE_STATE_CHECKPOINT_END}$`));
  for (const expected of [
    "Authoritative Pindie runtime metadata re-established after context compaction.",
    "Agent Run authority: coherent",
    "Task status: waiting_human",
    "Verification status: passed",
    "Goal:\nWire Pindie into Pi",
    "Constraints:\n- Preserve Pi's Agent Loop",
    "Success criteria:\n- c1: Extension wiring works",
    "Blockers:\n- Awaiting API access",
    "Questions:\n- Which release channel?",
    "Next intent:\nRun tests",
    "Verification checks:\n- tests — passed — covers: c1",
    "Verification checks:\n- tests — passed — covers: c1",
    "Evidence: Extension tests passed.",
    "Human Gate:\n- Kind: decision",
    "Current Pindie Action Eligibility:",
    "- task refine: allowed",
    "Current Policy Snapshot:\n- Approach: architecture-first (approach)",
    "  - minimal-change (modifier)",
  ]) assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const message = createPindieStateCheckpointMessage(state(), snapshot, policy);
  assert.equal(message.customType, PINDIE_STATE_CHECKPOINT_TYPE);
  assert.equal(message.display, false);
  assert.ok(isPindieStateCheckpointMessage({ ...message, role: "custom" }));
  assert.equal(isPindieStateCheckpointMessage({ ...message, customType: PINDIE_RUN_BASELINE_TYPE, role: "custom" }), false);
});

test("State Checkpoint preserves an unavailable authority reason without fabricating policy", () => {
  const content = renderPindieStateCheckpoint(
    null,
    { authority: "unavailable" },
    null,
    "State refresh failed during compaction.",
  );
  assert.match(content, /Agent Run authority: unavailable/);
  assert.match(content, /Reason: State refresh failed during compaction\./);
  assert.doesNotMatch(content, /Current Policy Snapshot/);
  assert.doesNotMatch(content, /Goal:|Verification status:|Human Gate:/);
});

test("unavailable Run Baseline retains the factual unavailable reason", () => {
  const content = renderPindieRunBaseline(
    state(),
    { authority: "unavailable" },
    "Could not parse the project State file.",
  );
  assert.match(content, /Agent Run authority: unavailable/);
  assert.match(content, /Reason: Could not parse the project State file\./);
  assert.doesNotMatch(content, /Goal:|Verification status:|Human Gate:/);
});

test("canonical current Task renderer carries state-changing semantic facts", () => {
  const rendered = renderCurrentPindieTaskState(state());
  assert.match(rendered, /Task status: waiting_human/);
  assert.match(rendered, /Verification status: passed/);
  assert.match(rendered, /Goal:\nWire Pindie into Pi/);
  assert.match(rendered, /Blockers:/);
  assert.match(rendered, /Questions:/);
  assert.match(rendered, /Next intent:/);
  assert.match(rendered, /Verification checks:/);
  assert.match(rendered, /Human Gate:/);
});
