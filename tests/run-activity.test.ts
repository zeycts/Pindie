import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_ACTIVITY_LINGER_MS,
  RunActivityTracker,
} from "../src/run-activity.ts";

function startedTracker(now: () => number): RunActivityTracker {
  const tracker = new RunActivityTracker({ now });
  tracker.start();
  return tracker;
}

test("RA-V01 a new active Run starts thinking", () => {
  assert.equal(startedTracker(() => 0).activity, "thinking");
});

test("RA-V02 through RA-V04 map known tools", () => {
  const cases = [
    ["read", "reading"],
    ["pindie_git_observe", "reading"],
    ["edit", "editing"],
    ["write", "editing"],
    ["bash", "running"],
    ["pindie_state", "updating"],
    ["pindie_gate", "updating"],
  ] as const;

  for (const [toolName, activity] of cases) {
    const tracker = startedTracker(() => 0);
    tracker.toolExecutionStart("call", toolName);
    assert.equal(tracker.activity, activity, toolName);
  }
});

test("RA-V05 and RA-V06 final tool activity lingers, then returns to thinking", () => {
  let time = 0;
  const tracker = startedTracker(() => time);
  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionEnd("read");

  assert.equal(tracker.activity, "reading");
  assert.equal(tracker.nextPresentationChangeInMs, RUN_ACTIVITY_LINGER_MS);
  time = RUN_ACTIVITY_LINGER_MS - 1;
  assert.equal(tracker.activity, "reading");
  time = RUN_ACTIVITY_LINGER_MS;
  assert.equal(tracker.activity, "thinking");
  assert.equal(tracker.nextPresentationChangeInMs, null);
});

test("RA-V07 a real tool immediately supersedes lingering activity", () => {
  let time = 0;
  const tracker = startedTracker(() => time);
  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionEnd("read");
  assert.equal(tracker.activity, "reading");

  time += 100;
  tracker.toolExecutionStart("edit", "edit");
  assert.equal(tracker.activity, "editing");
  assert.equal(tracker.nextPresentationChangeInMs, null);
});

test("RA-V08 and RA-V09 parallel actual tools win until the final end", () => {
  let time = 0;
  const tracker = startedTracker(() => time);
  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionStart("edit", "edit");
  assert.equal(tracker.activity, "working");

  tracker.toolExecutionEnd("edit");
  assert.equal(tracker.activity, "reading");
  assert.equal(tracker.nextPresentationChangeInMs, null);

  tracker.toolExecutionEnd("read");
  assert.equal(tracker.activity, "reading");
  time += RUN_ACTIVITY_LINGER_MS;
  assert.equal(tracker.activity, "thinking");
});

test("parallel same-kind tools retain their activity", () => {
  const tracker = startedTracker(() => 0);
  tracker.toolExecutionStart("read-a", "read");
  tracker.toolExecutionStart("read-b", "read");
  assert.equal(tracker.activity, "reading");
  tracker.toolExecutionEnd("read-a");
  assert.equal(tracker.activity, "reading");
});

test("RA-V10 settlement clears actual and lingering activity", () => {
  const tracker = startedTracker(() => 0);
  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionEnd("read");
  tracker.settle();
  assert.equal(tracker.activity, null);
  assert.equal(tracker.nextPresentationChangeInMs, null);
});

test("RA-V11 reset clears activity and rejects late execution events", () => {
  const tracker = startedTracker(() => 0);
  tracker.toolExecutionStart("bash", "bash");
  tracker.reset();
  tracker.toolExecutionStart("late", "edit");
  tracker.toolExecutionEnd("late");
  assert.equal(tracker.activity, null);
  assert.equal(tracker.nextPresentationChangeInMs, null);
});

test("RA-V12 unknown tools map to working and duplicate ends are harmless", () => {
  const tracker = startedTracker(() => 0);
  tracker.toolExecutionStart("custom", "some_extension_tool");
  assert.equal(tracker.activity, "working");
  tracker.toolExecutionEnd("missing");
  assert.equal(tracker.activity, "working");
  tracker.toolExecutionEnd("custom");
  tracker.toolExecutionEnd("custom");
  assert.equal(tracker.activity, "working");
});
