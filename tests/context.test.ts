import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCurrentPindieTaskState,
  appendPindieSystemContract,
  createPindieRunBaselineMessage,
  isPindieRunBaselineMessage,
  PINDIE_RUN_BASELINE_END,
  PINDIE_RUN_BASELINE_START,
  PINDIE_RUN_BASELINE_TYPE,
  PINDIE_SYSTEM_CONTRACT_END,
  PINDIE_SYSTEM_CONTRACT_START,
  renderCurrentPindieTaskState,
  renderPindieRunBaseline,
  renderPindieSystemContract,
} from "../src/context.ts";
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
  ]) assert.match(content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, new RegExp(`^${PINDIE_RUN_BASELINE_START}`));
  assert.match(content, new RegExp(`${PINDIE_RUN_BASELINE_END}$`));

  const message = createPindieRunBaselineMessage(state(), snapshot);
  assert.equal(message.customType, PINDIE_RUN_BASELINE_TYPE);
  assert.equal(message.display, false);
  assert.ok(isPindieRunBaselineMessage({ ...message, role: "custom" }));
  assert.equal(isPindieRunBaselineMessage({ ...message, customType: "other", role: "custom" }), false);
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
  assert.match(
    appendCurrentPindieTaskState("Task contract refined.", state()),
    /Task contract refined\.[\s\S]*Current Pindie State:/,
  );
});
