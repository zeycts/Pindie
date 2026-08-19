import assert from "node:assert/strict";
import test from "node:test";

import {
  TransitionErrorCode,
  reduceState,
  type PindieEvent,
  type TransitionResult,
} from "../src/transitions.ts";
import {
  EMPTY_STATE,
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
  type PindieTask,
} from "../src/state.ts";

const START_TASK: PindieEvent = {
  type: "start_task",
  goal: "Add pricing section",
  constraints: ["Follow existing landing page conventions"],
  successCriteria: [
    "Pricing section renders correctly",
    "Mobile layout works",
    "Build passes",
  ],
  nextIntent: "Implement PricingSection",
};

function success(result: TransitionResult): PindieState {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.state;
}

function failure(result: TransitionResult, code: TransitionErrorCode): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, code);
    assert.ok(result.error.message.length > 0);
  }
}

function startTask(): PindieState {
  return success(reduceState(EMPTY_STATE, START_TASK));
}

function apply(state: PindieState, event: PindieEvent): PindieState {
  return success(reduceState(state, event));
}

function fullyVerifiedState(state = startTask()): PindieState {
  return apply(state, {
    type: "record_verification",
    check: {
      name: "all",
      status: "passed",
      covers: ["c1", "c2", "c3"],
      evidence: "All success criteria passed current verification.",
    },
  });
}

function completedState(): PindieState {
  return apply(fullyVerifiedState(), { type: "complete_task" });
}

test("T01 starts the first task with generated criterion IDs", () => {
  const state = startTask();

  assert.deepEqual(state.task?.successCriteria, [
    { id: "c1", description: "Pricing section renders correctly" },
    { id: "c2", description: "Mobile layout works" },
    { id: "c3", description: "Build passes" },
  ]);
  assert.equal(getTaskStatus(state), "active");
});

test("T02 rejects starting a second active task", () => {
  failure(
    reduceState(startTask(), { ...START_TASK, goal: "A different task" }),
    TransitionErrorCode.TASK_ALREADY_ACTIVE,
  );
});

test("T03 a new task may replace a completed task", () => {
  const state = success(
    reduceState(completedState(), {
      type: "start_task",
      goal: "Ship changelog",
      constraints: [],
      successCriteria: ["Changelog is published"],
    }),
  );

  assert.equal(state.task?.goal, "Ship changelog");
  assert.equal(state.task?.completed, false);
});

test("T04 refining the goal invalidates verification", () => {
  const state = apply(fullyVerifiedState(), {
    type: "refine_task",
    goal: "Add a responsive pricing section",
  });

  assert.equal(state.task?.verification.stale, true);
  assert.deepEqual(state.task?.verification.checks, []);
});

test("T05 refining constraints invalidates verification", () => {
  const state = apply(fullyVerifiedState(), {
    type: "refine_task",
    constraints: ["Use existing components only"],
  });

  assert.equal(state.task?.verification.stale, true);
  assert.deepEqual(state.task?.verification.checks, []);
});

test("T06 replacing success criteria regenerates IDs and invalidates verification", () => {
  const state = apply(fullyVerifiedState(), {
    type: "refine_task",
    successCriteria: ["Desktop works", "Mobile works"],
  });

  assert.deepEqual(state.task?.successCriteria, [
    { id: "c1", description: "Desktop works" },
    { id: "c2", description: "Mobile works" },
  ]);
  assert.deepEqual(state.task?.verification, { stale: true, checks: [] });
});

test("T07 a no-op refinement preserves semantic State", () => {
  const state = fullyVerifiedState();
  const result = reduceState(state, {
    type: "refine_task",
    goal: state.task?.goal,
    constraints: state.task?.constraints,
    successCriteria: state.task?.successCriteria.map(({ description }) => description),
  });

  assert.equal(success(result), state);
});

test("T08 adding a blocker derives blocked status", () => {
  const state = apply(startTask(), {
    type: "set_open_loops",
    blockers: ["Test environment is unavailable"],
    questions: [],
    nextIntent: "Retry when the environment is available",
  });

  assert.equal(getTaskStatus(state), "blocked");
  assert.deepEqual(state.task?.openLoops, {
    blockers: ["Test environment is unavailable"],
    questions: [],
    nextIntent: "Retry when the environment is available",
  });
});

test("T09 removing the final blocker derives active status without a gate", () => {
  let state = apply(startTask(), {
    type: "set_open_loops",
    blockers: ["Test environment is unavailable"],
    questions: [],
    nextIntent: "Retry when the environment is available",
  });
  state = apply(state, {
    type: "set_open_loops",
    blockers: [],
    questions: [],
    nextIntent: "Continue implementation",
  });

  assert.equal(getTaskStatus(state), "active");
});

test("T10 unresolved questions permit active status but prevent completion", () => {
  const state = apply(fullyVerifiedState(), {
    type: "set_open_loops",
    blockers: [],
    questions: ["Which release note format should be used?"],
    nextIntent: "Ask the user",
  });

  assert.equal(getTaskStatus(state), "active");
  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.UNRESOLVED_QUESTIONS,
  );
});

test("T11 new task verification is pending", () => {
  const task = startTask().task;
  assert.ok(task);
  assert.equal(getVerificationStatus(task), "pending");
});

test("T12 partial passed coverage remains pending", () => {
  const state = apply(startTask(), {
    type: "record_verification",
    check: {
      name: "build",
      status: "passed",
      covers: ["c3"],
      evidence: "Build passed.",
    },
  });

  assert.equal(getVerificationStatus(state.task as PindieTask), "pending");
});

test("T13 full current passed coverage derives passed", () => {
  const state = fullyVerifiedState();
  assert.equal(getVerificationStatus(state.task as PindieTask), "passed");
});

test("T14 any current failed check derives failed", () => {
  const state = apply(fullyVerifiedState(), {
    type: "record_verification",
    check: {
      name: "mobile",
      status: "failed",
      covers: ["c2"],
      evidence: "The layout overflowed.",
    },
  });

  assert.equal(getVerificationStatus(state.task as PindieTask), "failed");
});

test("T15 same-name verification checks are upserted", () => {
  let state = apply(startTask(), {
    type: "record_verification",
    check: {
      name: "build",
      status: "failed",
      covers: ["c3"],
      evidence: "Initial build failed.",
    },
  });
  state = apply(state, {
    type: "record_verification",
    check: {
      name: "build",
      status: "passed",
      covers: ["c3"],
      evidence: "Build passed after the fix.",
    },
  });

  assert.deepEqual(state.task?.verification.checks, [
    {
      name: "build",
      status: "passed",
      covers: ["c3"],
      evidence: "Build passed after the fix.",
    },
  ]);
});

test("T16 unknown success-criterion references are rejected", () => {
  failure(
    reduceState(startTask(), {
      type: "record_verification",
      check: {
        name: "mystery",
        status: "passed",
        covers: ["c99"],
        evidence: "Invalid criterion reference.",
      },
    }),
    TransitionErrorCode.UNKNOWN_SUCCESS_CRITERION,
  );
});

test("T17 project mutation invalidates passed verification", () => {
  const state = apply(fullyVerifiedState(), { type: "invalidate_verification" });

  assert.equal(getVerificationStatus(state.task as PindieTask), "stale");
  assert.deepEqual(state.task?.verification.checks, []);
});

test("T18 repeated invalidation is idempotent", () => {
  const stale = apply(fullyVerifiedState(), { type: "invalidate_verification" });
  const result = reduceState(stale, { type: "invalidate_verification" });

  assert.equal(success(result), stale);
});

test("T19 fresh verification clears stale and starts a new evidence set", () => {
  let state = apply(fullyVerifiedState(), { type: "invalidate_verification" });
  state = apply(state, {
    type: "record_verification",
    check: {
      name: "build",
      status: "passed",
      covers: ["c3"],
      evidence: "Fresh build passed.",
    },
  });

  assert.deepEqual(state.task?.verification, {
    stale: false,
    checks: [
      {
        name: "build",
        status: "passed",
        covers: ["c3"],
        evidence: "Fresh build passed.",
      },
    ],
  });
});

test("T20 completion with pending verification is rejected", () => {
  failure(
    reduceState(startTask(), { type: "complete_task" }),
    TransitionErrorCode.VERIFICATION_PENDING,
  );
});

test("T21 completion with failed verification is rejected", () => {
  const state = apply(startTask(), {
    type: "record_verification",
    check: {
      name: "build",
      status: "failed",
      covers: ["c3"],
      evidence: "Build failed.",
    },
  });

  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.VERIFICATION_FAILED,
  );
});

test("T22 completion with stale verification is rejected", () => {
  const state = apply(fullyVerifiedState(), { type: "invalidate_verification" });

  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.VERIFICATION_STALE,
  );
});

test("T23 completion with blockers is rejected", () => {
  const state = apply(fullyVerifiedState(), {
    type: "set_open_loops",
    blockers: ["Deployment access is unavailable"],
    questions: [],
    nextIntent: "Wait for deployment access",
  });

  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.TASK_HAS_BLOCKERS,
  );
});

test("T24 completion with unresolved questions is rejected", () => {
  const state = apply(fullyVerifiedState(), {
    type: "set_open_loops",
    blockers: [],
    questions: ["Which release note format should be used?"],
    nextIntent: "Ask the user",
  });

  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.UNRESOLVED_QUESTIONS,
  );
});

test("T25 completion with a Human Gate is rejected", () => {
  const state = apply(fullyVerifiedState(), {
    type: "open_human_gate",
    gate: { kind: "approval", question: "Approve release?" },
  });

  failure(
    reduceState(state, { type: "complete_task" }),
    TransitionErrorCode.HUMAN_GATE_OPEN,
  );
});

test("T26 valid completion is terminal and clears nextIntent", () => {
  const state = completedState();

  assert.equal(state.task?.completed, true);
  assert.equal(state.task?.openLoops.nextIntent, null);
  assert.equal(getTaskStatus(state), "done");
});

test("T27 refining a completed task is rejected", () => {
  failure(
    reduceState(completedState(), { type: "refine_task", goal: "Changed" }),
    TransitionErrorCode.TASK_COMPLETED,
  );
});

test("T28 altering open loops on a completed task is rejected", () => {
  const state = completedState();
  failure(
    reduceState(state, {
      type: "set_open_loops",
      blockers: ["New blocker"],
      questions: ["New question?"],
      nextIntent: "Do more work",
    }),
    TransitionErrorCode.TASK_COMPLETED,
  );
});

test("T29 recording verification on a completed task is rejected", () => {
  failure(
    reduceState(completedState(), {
      type: "record_verification",
      check: {
        name: "again",
        status: "passed",
        covers: ["c1"],
        evidence: "Late evidence.",
      },
    }),
    TransitionErrorCode.TASK_COMPLETED,
  );
});

test("T30 opening a Human Gate on a completed task is rejected", () => {
  failure(
    reduceState(completedState(), {
      type: "open_human_gate",
      gate: { kind: "decision", question: "Change direction?" },
    }),
    TransitionErrorCode.TASK_COMPLETED,
  );
});

test("T31 opening a Human Gate derives waiting_human", () => {
  const state = apply(startTask(), {
    type: "open_human_gate",
    gate: {
      kind: "decision",
      question: "Which pricing model should we use?",
      options: ["Two tiers", "Three tiers"],
    },
  });

  assert.equal(getTaskStatus(state), "waiting_human");
});

test("T32 opening a second Human Gate is rejected", () => {
  const state = apply(startTask(), {
    type: "open_human_gate",
    gate: { kind: "input", question: "Provide a product name." },
  });

  failure(
    reduceState(state, {
      type: "open_human_gate",
      gate: { kind: "approval", question: "Approve release?" },
    }),
    TransitionErrorCode.HUMAN_GATE_ALREADY_OPEN,
  );
});

test("T33 opening a Human Gate without a task is rejected", () => {
  failure(
    reduceState(EMPTY_STATE, {
      type: "open_human_gate",
      gate: { kind: "input", question: "Provide requirements." },
    }),
    TransitionErrorCode.NO_CURRENT_TASK,
  );
});

test("T34 resolving a Human Gate returns to the derived non-gate status", () => {
  let state = apply(startTask(), {
    type: "set_open_loops",
    blockers: ["External service is unavailable"],
    questions: [],
    nextIntent: "Wait or choose a fallback",
  });
  state = apply(state, {
    type: "open_human_gate",
    gate: { kind: "decision", question: "Wait or use a fallback?" },
  });
  state = apply(state, { type: "resolve_human_gate" });

  assert.equal(state.task?.humanGate, null);
  assert.equal(getTaskStatus(state), "blocked");
});

test("T35 resolving a missing Human Gate is rejected", () => {
  failure(
    reduceState(startTask(), { type: "resolve_human_gate" }),
    TransitionErrorCode.NO_HUMAN_GATE,
  );
});

test("successful transitions do not mutate their input State", () => {
  const state = startTask();
  const snapshot = structuredClone(state);

  apply(state, {
    type: "set_open_loops",
    blockers: ["A blocker"],
    questions: [],
    nextIntent: "Resolve the blocker",
  });

  assert.deepEqual(state, snapshot);
});

test("rejected transitions do not mutate their input State", () => {
  const state = startTask();
  const snapshot = structuredClone(state);

  failure(
    reduceState(state, {
      type: "record_verification",
      check: {
        name: "mystery",
        status: "passed",
        covers: ["c99"],
        evidence: "Invalid criterion reference.",
      },
    }),
    TransitionErrorCode.UNKNOWN_SUCCESS_CRITERION,
  );

  assert.deepEqual(state, snapshot);
});
