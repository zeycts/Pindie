import assert from "node:assert/strict";
import test from "node:test";

import {
  getCommittedRolloverPublisher,
  getSessionLifecyclePublisher,
  installCommittedRolloverReceiver,
} from "../src/long-task-control.ts";
import { createTaskContinuity } from "../src/task-continuity.ts";

function checkpoint(sourceSessionId = "session-1") {
  return createTaskContinuity({
    createdAt: "2026-09-04T00:00:00.000Z",
    taskFingerprint: `sha256:${"a".repeat(64)}`,
    sourceSessionId,
    progressSummary: "The current work frontier is coherent.",
    decisions: ["Keep durable Task truth in PindieState."],
  });
}

test("committed rollover publisher is unavailable without a Host receiver", () => {
  assert.equal(getCommittedRolloverPublisher(), null);
});

test("an installed Host receiver receives the exact committed request", () => {
  let received: unknown;
  const release = installCommittedRolloverReceiver((request) => {
    received = request;
  });
  try {
    const publisher = getCommittedRolloverPublisher();
    assert.ok(publisher);
    const request = { sourceSessionId: "session-1", checkpoint: checkpoint() };
    publisher(request);
    assert.equal(received, request);
  } finally {
    release();
  }
});

test("the Host lifecycle publisher is session-bound and released with the control bridge", () => {
  const boundaries: unknown[] = [];
  const release = installCommittedRolloverReceiver(
    () => undefined,
    (boundary) => boundaries.push(boundary),
  );
  const publisher = getSessionLifecyclePublisher();
  assert.ok(publisher);
  const boundary = { sessionId: "session-1", reason: "reload" as const };
  publisher(boundary);
  assert.equal(boundaries[0], boundary);
  release();

  assert.equal(getSessionLifecyclePublisher(), null);
  assert.throws(() => publisher(boundary), /lease is no longer active/i);
});

test("releasing a Host lease removes the bridge", () => {
  const release = installCommittedRolloverReceiver(() => undefined);
  const publisher = getCommittedRolloverPublisher();
  assert.ok(publisher);
  release();

  assert.equal(getCommittedRolloverPublisher(), null);
  assert.throws(
    () => publisher({ sourceSessionId: "session-1", checkpoint: checkpoint() }),
    /lease is no longer active/i,
  );
});

test("a second Host cannot overwrite the active receiver and released publishers cannot target it", () => {
  const firstRequests: unknown[] = [];
  const firstRelease = installCommittedRolloverReceiver((request) => firstRequests.push(request));
  const firstPublisher = getCommittedRolloverPublisher();
  assert.ok(firstPublisher);
  try {
    assert.throws(
      () => installCommittedRolloverReceiver(() => undefined),
      /already owns/i,
    );
    firstPublisher({ sourceSessionId: "session-1", checkpoint: checkpoint() });
    assert.equal(firstRequests.length, 1);
  } finally {
    firstRelease();
  }

  const laterRequests: unknown[] = [];
  const laterRelease = installCommittedRolloverReceiver((request) => laterRequests.push(request));
  try {
    assert.throws(
      () => firstPublisher({ sourceSessionId: "session-1", checkpoint: checkpoint() }),
      /lease is no longer active/i,
    );
    assert.equal(laterRequests.length, 0);
  } finally {
    laterRelease();
  }
});
