import assert from "node:assert/strict";
import test from "node:test";

import {
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "../src/liveness.ts";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("runBoundedOperation rejects a never-settling operation at its deadline", async () => {
  await assert.rejects(
    runBoundedOperation({
      label: "hung operation",
      timeoutMs: 5,
      run: async () => new Promise<never>(() => {}),
    }),
    (error: unknown) => {
      assert.ok(error instanceof PindieLivenessTimeoutError);
      assert.equal(error.label, "hung operation");
      assert.equal(error.timeoutMs, 5);
      return true;
    },
  );
});

test("runBoundedOperation aborts the inner operation and rejects promptly", async () => {
  const controller = new AbortController();
  let innerSignal: AbortSignal | undefined;
  const operation = runBoundedOperation({
    label: "cancelled operation",
    timeoutMs: 10_000,
    signal: controller.signal,
    run: async (signal) => {
      innerSignal = signal;
      return new Promise<never>(() => {});
    },
  });

  await nextTurn();
  controller.abort();
  await assert.rejects(operation, (error: unknown) => error instanceof PindieLivenessAbortError);
  assert.equal(innerSignal?.aborted, true);
});

test("runBoundedOperation does not invoke an already-aborted operation", async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = false;

  await assert.rejects(
    runBoundedOperation({
      label: "already cancelled operation",
      timeoutMs: 10_000,
      signal: controller.signal,
      run: async () => {
        invoked = true;
        return "unexpected";
      },
    }),
    (error: unknown) => error instanceof PindieLivenessAbortError,
  );
  assert.equal(invoked, false);
});

test("runBoundedOperation preserves normal resolve and original reject behavior", async () => {
  assert.equal(
    await runBoundedOperation({
      label: "normal operation",
      timeoutMs: 100,
      run: async () => "value",
    }),
    "value",
  );

  const original = new Error("original failure");
  await assert.rejects(
    runBoundedOperation({
      label: "failed operation",
      timeoutMs: 100,
      run: async () => { throw original; },
    }),
    (error: unknown) => error === original,
  );
});

test("late results after timeout cannot settle the caller or cause an unhandled rejection", async () => {
  let resolveInner!: (value: string) => void;
  let markResolveStarted!: () => void;
  const resolveStarted = new Promise<void>((resolve) => { markResolveStarted = resolve; });
  const lateResolve = runBoundedOperation({
    label: "late resolve operation",
    timeoutMs: 5,
    run: async () => new Promise<string>((resolve) => {
      resolveInner = resolve;
      markResolveStarted();
    }),
  });
  await resolveStarted;
  await assert.rejects(lateResolve, PindieLivenessTimeoutError);
  resolveInner("late value");
  await nextTurn();

  let rejectInner!: (error: Error) => void;
  let markRejectStarted!: () => void;
  const rejectStarted = new Promise<void>((resolve) => { markRejectStarted = resolve; });
  const lateReject = runBoundedOperation({
    label: "late reject operation",
    timeoutMs: 5,
    run: async () => new Promise<string>((_resolve, reject) => {
      rejectInner = reject;
      markRejectStarted();
    }),
  });
  await rejectStarted;
  await assert.rejects(lateReject, PindieLivenessTimeoutError);

  let unhandled = false;
  const lateError = new Error("late inner failure");
  const onUnhandled = (reason: unknown): void => {
    if (reason === lateError) unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    rejectInner(lateError);
    await nextTurn();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, false);
});
