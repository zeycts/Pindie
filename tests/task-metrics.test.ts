import assert from "node:assert/strict";
import test from "node:test";

import { TaskMetricsTracker, type ConsumptionMetrics } from "../src/task-metrics.ts";

const zero = { durationMs: 0, cost: 0 } satisfies ConsumptionMetrics;
const bindingA = `sha256:${"a".repeat(64)}`;
const bindingB = `sha256:${"b".repeat(64)}`;

function value(durationMs: number, cost: number): ConsumptionMetrics {
  return { durationMs, cost };
}

test("Task metrics exclude pre-Task consumption and replacement starts a fresh epoch", () => {
  const tracker = new TaskMetricsTracker();

  tracker.startRunWithoutTask();
  tracker.startTask("/repo", bindingA, value(4_000, 0.03));
  assert.deepEqual(tracker.snapshot(value(10_000, 0.08)), value(6_000, 0.05));

  tracker.startTask("/repo", bindingB, value(12_000, 0.1));
  assert.deepEqual(tracker.snapshot(value(15_000, 0.14)), value(3_000, 0.04));
});

test("Task refinement preserves accumulated and live consumption", () => {
  const tracker = new TaskMetricsTracker();
  tracker.startTask("/repo", bindingA, zero);
  assert.deepEqual(tracker.snapshot(value(7_000, 0.07)), value(7_000, 0.07));

  tracker.refineTask("/repo", bindingB);
  assert.deepEqual(tracker.snapshot(value(9_000, 0.09)), value(9_000, 0.09));
  assert.equal(tracker.prepareAutomaticRollover("session-a", bindingB), true);
});

test("two Runs accumulate while each Run starts from its own baseline", () => {
  const tracker = new TaskMetricsTracker();
  tracker.startRunForTask("/repo", bindingA, zero);
  assert.deepEqual(tracker.settleRun(value(12_000, 0.11)), value(12_000, 0.11));

  tracker.startRunForTask("/repo", bindingA, zero);
  assert.deepEqual(tracker.snapshot(value(17_000, 0.21)), value(29_000, 0.32));
  assert.deepEqual(tracker.settleRun(value(17_000, 0.21)), value(29_000, 0.32));
});

test("automatic Session rollover preserves Task metrics but resets Run ownership", () => {
  const tracker = new TaskMetricsTracker();
  tracker.startRunForTask("/repo", bindingA, zero);
  tracker.settleRun(value(12_000, 0.11));
  assert.equal(tracker.prepareAutomaticRollover("session-a", bindingA), true);

  assert.equal(tracker.enterSession("/repo", bindingA), true);
  assert.equal(tracker.currentRunBelongsToTask, false);
  tracker.startRunForTask("/repo", bindingA, zero);
  assert.deepEqual(tracker.snapshot(value(17_000, 0.21)), value(29_000, 0.32));
});

test("three automatic Sessions produce cumulative final Task consumption", () => {
  const tracker = new TaskMetricsTracker();
  const contributions = [
    value(12 * 60_000, 0.11),
    value(17 * 60_000, 0.21),
    value(8 * 60_000, 0.14),
  ];

  tracker.startRunForTask("/repo", bindingA, zero);
  tracker.settleRun(contributions[0]!);
  assert.equal(tracker.prepareAutomaticRollover("session-a", bindingA), true);
  assert.equal(tracker.enterSession("/repo", bindingA), true);

  tracker.startRunForTask("/repo", bindingA, zero);
  tracker.settleRun(contributions[1]!);
  assert.equal(tracker.prepareAutomaticRollover("session-b", bindingA), true);
  assert.equal(tracker.enterSession("/repo", bindingA), true);

  tracker.startRunForTask("/repo", bindingA, zero);
  assert.deepEqual(
    tracker.completeTask(contributions[2]!),
    value(37 * 60_000, 0.46),
  );
});

test("completion freezes metrics before Run settlement and unrelated Runs cannot extend them", () => {
  const tracker = new TaskMetricsTracker();
  tracker.startRunForTask("/repo", bindingA, zero);
  assert.deepEqual(tracker.completeTask(value(5_000, 0.05)), value(5_000, 0.05));
  assert.deepEqual(tracker.settleRun(value(9_000, 0.09)), value(5_000, 0.05));

  tracker.startRunWithoutTask();
  assert.equal(tracker.currentRunBelongsToTask, false);
  assert.equal(tracker.snapshot(value(20_000, 0.2)), null);

  tracker.startTask("/repo", bindingB, value(20_000, 0.2));
  assert.deepEqual(tracker.snapshot(value(23_000, 0.24)), value(3_000, 0.04));
});

test("manual Session, project, and incompatible Task boundaries reject stale metrics", () => {
  for (const [projectRoot, binding] of [
    ["/repo", bindingA],
    ["/other", bindingA],
    ["/repo", bindingB],
  ] as const) {
    const tracker = new TaskMetricsTracker();
    tracker.startRunForTask("/repo", bindingA, zero);
    tracker.settleRun(value(5_000, 0.05));
    if (projectRoot !== "/repo" || binding !== bindingA) {
      tracker.prepareAutomaticRollover("session-a", bindingA);
    }
    assert.equal(tracker.enterSession(projectRoot, binding), false);
    tracker.startRunForTask(projectRoot, binding, zero);
    assert.deepEqual(tracker.snapshot(value(1_000, 0.01)), value(1_000, 0.01));
  }
});
