import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_STATE,
  getTaskStatus,
  getVerificationStatus,
  validateState,
  type PindieState,
  type PindieTask,
} from "../src/state.ts";

function createTask(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Add pricing section",
    constraints: ["Follow existing landing page conventions"],
    successCriteria: [
      { id: "c1", description: "Pricing section renders correctly" },
      { id: "c2", description: "Mobile layout works" },
      { id: "c3", description: "Build passes" },
    ],
    openLoops: {
      blockers: [],
      questions: [],
      nextIntent: "Implement PricingSection",
    },
    verification: {
      stale: false,
      checks: [],
    },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function stateWith(task: PindieTask): PindieState {
  return { task };
}

test("EMPTY_STATE derives idle task status", () => {
  assert.equal(getTaskStatus(EMPTY_STATE), "idle");
});

test("an ordinary current task derives active status", () => {
  assert.equal(getTaskStatus(stateWith(createTask())), "active");
});

test("a blocker derives blocked status", () => {
  const task = createTask({
    openLoops: {
      blockers: ["Supabase test environment unavailable"],
      questions: [],
      nextIntent: "Retry verification when the environment is available",
    },
  });

  assert.equal(getTaskStatus(stateWith(task)), "blocked");
});

test("an open Human Gate takes precedence over blockers", () => {
  const task = createTask({
    openLoops: {
      blockers: ["A secondary external blocker"],
      questions: [],
      nextIntent: null,
    },
    humanGate: {
      kind: "decision",
      question: "Which pricing structure should we use?",
      options: ["Free + Pro", "Three tiers"],
    },
  });

  assert.equal(getTaskStatus(stateWith(task)), "waiting_human");
});

test("completed task derives done status", () => {
  const task = createTask({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: {
      stale: false,
      checks: [
        {
          name: "ui",
          status: "passed",
          covers: ["c1", "c2"],
          evidence: "Rendered and inspected the pricing section at desktop and mobile widths.",
        },
        {
          name: "build",
          status: "passed",
          covers: ["c3"],
          evidence: "Build command exited successfully.",
        },
      ],
    },
    completed: true,
  });

  assert.equal(getTaskStatus(stateWith(task)), "done");
});

test("new task verification derives pending when there are no checks", () => {
  assert.equal(getVerificationStatus(createTask()), "pending");
});

test("stale verification takes precedence over checks", () => {
  const task = createTask({
    verification: { stale: true, checks: [] },
  });

  assert.equal(getVerificationStatus(task), "stale");
});

test("partial passed coverage remains pending", () => {
  const task = createTask({
    verification: {
      stale: false,
      checks: [
        {
          name: "build",
          status: "passed",
          covers: ["c3"],
          evidence: "Build command exited successfully.",
        },
      ],
    },
  });

  assert.equal(getVerificationStatus(task), "pending");
});

test("any current failed verification check derives failed", () => {
  const task = createTask({
    verification: {
      stale: false,
      checks: [
        {
          name: "ui",
          status: "passed",
          covers: ["c1"],
          evidence: "Desktop render inspected.",
        },
        {
          name: "mobile-ui",
          status: "failed",
          covers: ["c2"],
          evidence: "Cards overflow the 375px viewport.",
        },
      ],
    },
  });

  assert.equal(getVerificationStatus(task), "failed");
});

test("full passed coverage derives passed", () => {
  const task = createTask({
    verification: {
      stale: false,
      checks: [
        {
          name: "ui",
          status: "passed",
          covers: ["c1", "c2"],
          evidence: "Desktop and mobile renders inspected successfully.",
        },
        {
          name: "build",
          status: "passed",
          covers: ["c3"],
          evidence: "Build command exited successfully.",
        },
      ],
    },
  });

  assert.equal(getVerificationStatus(task), "passed");
});

test("validateState accepts a valid active task", () => {
  assert.deepEqual(validateState(stateWith(createTask())), { ok: true });
});

test("validateState rejects duplicate criterion IDs", () => {
  const task = createTask({
    successCriteria: [
      { id: "c1", description: "First" },
      { id: "c1", description: "Duplicate" },
    ],
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /criterion IDs must be unique/i);
  }
});

test("validateState rejects duplicate current verification check names", () => {
  const task = createTask({
    verification: {
      stale: false,
      checks: [
        { name: "build", status: "passed", covers: ["c3"], evidence: "first" },
        { name: "build", status: "passed", covers: ["c3"], evidence: "second" },
      ],
    },
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /check names must be unique/i);
  }
});

test("validateState rejects verification references to unknown criteria", () => {
  const task = createTask({
    verification: {
      stale: false,
      checks: [
        {
          name: "mystery",
          status: "passed",
          covers: ["c99"],
          evidence: "Invalid reference for test purposes.",
        },
      ],
    },
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /unknown success criterion 'c99'/i);
  }
});

test("validateState rejects stale verification that retains checks", () => {
  const task = createTask({
    verification: {
      stale: true,
      checks: [
        {
          name: "build",
          status: "passed",
          covers: ["c3"],
          evidence: "Old evidence that should have been discarded.",
        },
      ],
    },
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /stale verification must not retain current checks/i);
  }
});

test("validateState accepts a structurally valid completed task", () => {
  const task = createTask({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: {
      stale: false,
      checks: [
        {
          name: "all",
          status: "passed",
          covers: ["c1", "c2", "c3"],
          evidence: "All success criteria were verified by current evidence.",
        },
      ],
    },
    completed: true,
  });

  assert.deepEqual(validateState(stateWith(task)), { ok: true });
});

test("validateState rejects completed task with an open Human Gate", () => {
  const task = createTask({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: {
      stale: false,
      checks: [
        {
          name: "all",
          status: "passed",
          covers: ["c1", "c2", "c3"],
          evidence: "All success criteria were verified.",
        },
      ],
    },
    humanGate: {
      kind: "approval",
      question: "Approve release?",
    },
    completed: true,
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /completed task cannot have an open Human Gate/i);
  }
});

test("validateState rejects completed task with open loops", () => {
  const task = createTask({
    openLoops: {
      blockers: ["External dependency unavailable"],
      questions: ["One unresolved question"],
      nextIntent: "Try again later",
    },
    verification: {
      stale: false,
      checks: [
        {
          name: "all",
          status: "passed",
          covers: ["c1", "c2", "c3"],
          evidence: "All criteria covered despite intentionally invalid open loops.",
        },
      ],
    },
    completed: true,
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    const message = result.errors.join("\n");
    assert.match(message, /cannot have blockers/i);
    assert.match(message, /cannot have unresolved questions/i);
    assert.match(message, /cannot have a next intent/i);
  }
});

test("validateState rejects completed task without passed verification", () => {
  const task = createTask({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    completed: true,
  });

  const result = validateState(stateWith(task));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.join("\n"), /requires current passed verification/i);
  }
});
