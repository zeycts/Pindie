import assert from "node:assert/strict";
import test from "node:test";

import { RunActivityTracker } from "../src/run-activity.ts";

function startedTracker(): RunActivityTracker {
  const tracker = new RunActivityTracker();
  tracker.start();
  return tracker;
}

test("a new Agent Run starts thinking", () => {
  assert.equal(startedTracker().activity, "thinking");
});

test("known Pi tools map to observable activities", () => {
  const cases = [
    ["read", "reading"],
    ["edit", "editing"],
    ["write", "editing"],
    ["bash", "running"],
    ["pindie_state", "updating"],
    ["pindie_gate", "updating"],
  ] as const;

  for (const [toolName, activity] of cases) {
    const tracker = startedTracker();
    tracker.toolExecutionStart("call", toolName);
    assert.equal(tracker.activity, activity, toolName);
  }
});

test("unknown tool execution maps to working", () => {
  const tracker = startedTracker();
  tracker.toolExecutionStart("custom", "some_extension_tool");

  assert.equal(tracker.activity, "working");
});

test("tool completion returns an active Run to thinking", () => {
  const tracker = startedTracker();
  tracker.toolExecutionStart("edit", "edit");
  assert.equal(tracker.activity, "editing");

  tracker.toolExecutionEnd("edit");
  assert.equal(tracker.activity, "thinking");
});

test("parallel tools derive same and mixed activities deterministically", () => {
  const tracker = startedTracker();
  tracker.toolExecutionStart("read-a", "read");
  tracker.toolExecutionStart("read-b", "read");
  assert.equal(tracker.activity, "reading");

  tracker.toolExecutionEnd("read-a");
  assert.equal(tracker.activity, "reading");
  tracker.toolExecutionEnd("read-b");
  assert.equal(tracker.activity, "thinking");

  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionStart("edit", "edit");
  assert.equal(tracker.activity, "working");
  tracker.toolExecutionEnd("edit");
  assert.equal(tracker.activity, "reading");
  tracker.toolExecutionEnd("read");
  assert.equal(tracker.activity, "thinking");
});

test("settlement clears activity and a later Run starts clean", () => {
  const tracker = startedTracker();
  tracker.toolExecutionStart("bash", "bash");
  tracker.settle();
  assert.equal(tracker.activity, null);

  tracker.start();
  assert.equal(tracker.activity, "thinking");
});

test("session resets and unknown or duplicate ends cannot leak or throw", () => {
  const tracker = startedTracker();
  tracker.toolExecutionStart("read", "read");
  tracker.toolExecutionEnd("unknown");
  assert.equal(tracker.activity, "reading");
  tracker.toolExecutionEnd("read");
  tracker.toolExecutionEnd("read");
  assert.equal(tracker.activity, "thinking");

  tracker.toolExecutionStart("bash", "bash");
  tracker.reset();
  assert.equal(tracker.activity, null);
  tracker.toolExecutionStart("late", "edit");
  assert.equal(tracker.activity, null);
});
