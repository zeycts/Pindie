import assert from "node:assert/strict";
import test from "node:test";

import {
  PINDIE_POLICY_CONTEXT_TYPE,
  PINDIE_POLICY_END,
  PINDIE_POLICY_START,
  PINDIE_RUNTIME_CONTEXT_TYPE,
  PINDIE_RUNTIME_END,
  PINDIE_RUNTIME_START,
  createPindiePolicyContextMessage,
  createPindieRuntimeContextMessage,
  isPindiePolicyContextMessage,
  isPindieRuntimeContextMessage,
  renderPindiePolicyContext,
  renderPindieRuntimeContext,
} from "../src/context.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function completeState(): PindieState {
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

function activeState(): PindieState {
  return {
    task: {
      ...completeState().task!,
      openLoops: {
        blockers: [],
        questions: ["Which release channel?"],
        nextIntent: "Run tests",
      },
      humanGate: null,
    },
  };
}

const coherentActiveSnapshot: SemanticSnapshot = {
  authority: "coherent",
  taskStatus: "active",
  verificationStatus: "passed",
  hasBlockers: false,
  hasQuestions: true,
  completionReady: false,
  taskRelation: "preexisting_untouched",
  completionRelation: "not_completed",
  gateRelation: "none",
};

const coherentWaitingSnapshot: SemanticSnapshot = {
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

const staleTaskSnapshot: SemanticSnapshot = {
  authority: "stale",
  taskStatus: "waiting_human",
  verificationStatus: "passed",
  hasBlockers: true,
  hasQuestions: true,
  completionReady: false,
};

test("SI03 Policy Context is bounded, advisory metadata with stable hidden identity", () => {
  const first = renderPindiePolicyContext();
  const second = renderPindiePolicyContext();

  assert.equal(first, second);
  assert.match(first, new RegExp(`^${PINDIE_POLICY_START}`));
  assert.match(first, new RegExp(`${PINDIE_POLICY_END}$`));
  assert.match(first, /Pindie Policy Context/);
  assert.match(first, /Runtime policy metadata only; not user intent or a new request\./);
  assert.match(first, /optional, advisory problem-solving priors/i);
  assert.match(first, /may use a strategy, combine strategies, or ignore strategies/i);
  assert.match(first, /never override actual user intent/i);
  assert.match(first, /project constraints.*Pindie Runtime Context/s);
  assert.match(first, /State or semantic authority/);
  assert.match(first, /capabilities or Execution Gateway decisions/);
  assert.match(first, /verification reality/);
  assert.match(first, /Human Gates/);
  assert.match(first, /not required ceremony/i);

  const message = createPindiePolicyContextMessage();
  assert.equal(message.customType, PINDIE_POLICY_CONTEXT_TYPE);
  assert.equal(message.display, false);
  assert.equal(message.timestamp, 0);
  assert.ok(isPindiePolicyContextMessage(message));
  assert.equal(isPindiePolicyContextMessage({ ...message, customType: "other" }), false);
  assert.equal(isPindiePolicyContextMessage({ ...message, role: "user" }), false);
});

test("K01 coherent active Runtime Context projects Snapshot status and current State details", () => {
  const first = renderPindieRuntimeContext(activeState(), coherentActiveSnapshot);
  const second = renderPindieRuntimeContext(activeState(), coherentActiveSnapshot);

  assert.equal(first, second);
  assert.match(first, /Runtime metadata only; not user intent or a new request\./);
  assert.match(first, /Agent Run authority: coherent/);
  assert.match(first, /Task status: active/);
  assert.match(first, /Verification status: passed/);
  assert.match(first, /Goal:\nWire Pindie into Pi/);
  assert.match(first, /Constraints:\n- Preserve Pi's Agent Loop/);
  assert.match(first, /Success criteria:\n- c1: Extension wiring works/);
  assert.match(first, /Questions:\n- Which release channel\?/);
  assert.match(first, /Next intent:\nRun tests/);
  assert.match(first, /tests — passed — covers: c1\n  Evidence: Extension tests passed\./);
  assert.doesNotMatch(first, /Blockers:|Human gate:/);
  assert.doesNotMatch(first, /Latest actual user intent.*authoritative/);
});

test("K02 coherent idle Runtime Context is minimal and omits verification and Task details", () => {
  const snapshot: SemanticSnapshot = {
    authority: "coherent",
    taskStatus: "idle",
    verificationStatus: "none",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "none",
    completionRelation: "not_completed",
    gateRelation: "none",
  };
  const runtime = renderPindieRuntimeContext({ task: null }, snapshot);

  assert.equal(runtime, `${PINDIE_RUNTIME_START}\nPindie Runtime Context\n\nRuntime metadata only; not user intent or a new request.\n\nAgent Run authority: coherent\nTask status: idle\n${PINDIE_RUNTIME_END}`);
  assert.doesNotMatch(runtime, /Verification status:|Goal:|Constraints:|Success criteria:|Blockers:|Questions:|Next intent:|Verification checks:|Human gate:/);
});

test("K03 stale Runtime Context retains current State facts without procedural guidance", () => {
  const runtime = renderPindieRuntimeContext(completeState(), staleTaskSnapshot);

  assert.match(runtime, /Agent Run authority: stale/);
  assert.match(runtime, /Task status: waiting_human/);
  assert.match(runtime, /Verification status: passed/);
  assert.match(runtime, /Goal:\nWire Pindie into Pi/);
  assert.match(runtime, /Human gate:/);
  assert.doesNotMatch(runtime, /start a new Run|return control|do not mutate|call (?:a|the|pindie_)/i);
});

test("K04 unavailable Runtime Context renders only factual unavailability", () => {
  const runtime = renderPindieRuntimeContext(
    completeState(),
    { authority: "unavailable" },
    "Could not parse the project State file.",
  );

  assert.equal(runtime, `${PINDIE_RUNTIME_START}\nPindie Runtime Context\n\nRuntime metadata only; not user intent or a new request.\n\nAgent Run authority: unavailable\nReason: Could not parse the project State file.\n${PINDIE_RUNTIME_END}`);
  assert.doesNotMatch(runtime, /Task status:|Verification status:|Goal:|Success criteria:|Human gate:/);
  assert.doesNotMatch(runtime, /Do not make consequential|Restore|Reload|call (?:a|the|pindie_)/i);
});

test("K05 empty optional Runtime Context sections are omitted", () => {
  const complete = renderPindieRuntimeContext(
    completeState(),
    coherentWaitingSnapshot,
  );
  assert.match(complete, /Constraints:/);
  assert.match(complete, /Blockers:/);
  assert.match(complete, /Questions:/);
  assert.match(complete, /Next intent:/);
  assert.match(complete, /Verification checks:/);
  assert.match(complete, /Human gate:/);

  const state: PindieState = {
    task: {
      ...completeState().task!,
      constraints: [],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
    },
  };
  const snapshot: SemanticSnapshot = {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
  };
  const runtime = renderPindieRuntimeContext(state, snapshot);

  assert.match(runtime, /Task status: active/);
  assert.match(runtime, /Verification status: pending/);
  assert.doesNotMatch(runtime, /Constraints:|Blockers:|Questions:|Next intent:|Verification checks:|Human gate:/);
});

test("K06 Runtime Context messages use the stable hidden custom-message identity", () => {
  const message = createPindieRuntimeContextMessage(
    completeState(),
    coherentWaitingSnapshot,
  );

  assert.equal(message.customType, PINDIE_RUNTIME_CONTEXT_TYPE);
  assert.equal(message.display, false);
  assert.equal(message.timestamp, 0);
  assert.ok(isPindieRuntimeContextMessage(message));
  assert.equal(isPindieRuntimeContextMessage({ ...message, customType: "other" }), false);
  assert.match(String(message.content), new RegExp(PINDIE_RUNTIME_START));
});
