import assert from "node:assert/strict";
import test from "node:test";

import {
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "../src/liveness.ts";
import {
  PindieLearningArtifactPublicationUncertainError,
  publishImmutableLearningArtifact,
} from "../src/learning-artifact-liveness.ts";

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

test("immutable publication bounds a never-settling save as an uncertain outcome", async () => {
  let saveStarted = false;
  await assert.rejects(
    publishImmutableLearningArtifact({
      label: "Test Revision",
      timeoutMs: 5,
      save: async () => {
        saveStarted = true;
        await new Promise<never>(() => {});
      },
      read: async () => null,
      isExact: () => true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PindieLearningArtifactPublicationUncertainError);
      assert.match(error.message, /Candidate publication timed out.*durable Candidate outcome is currently uncertain/i);
      assert.match(error.message, /must not be retried automatically/i);
      assert.doesNotMatch(error.message, /semantic authority is unavailable|Core State/i);
      return true;
    },
  );
  assert.equal(saveStarted, true);
});

test("immutable publication aborts before save without producing uncertainty", async () => {
  const controller = new AbortController();
  controller.abort();
  let saveStarted = false;
  await assert.rejects(
    publishImmutableLearningArtifact({
      label: "Test Revision",
      timeoutMs: 5,
      signal: controller.signal,
      save: async () => {
        saveStarted = true;
      },
      read: async () => null,
      isExact: () => true,
    }),
    (error: unknown) => error instanceof PindieLivenessAbortError,
  );
  assert.equal(saveStarted, false);
});

test("immutable publication reconciles one exact durable artifact without a second save", async () => {
  const durable = new Map<string, { readonly id: string; readonly value: string }>();
  const intended = { id: "candidate", value: "exact" } as const;
  let saves = 0;
  await publishImmutableLearningArtifact({
    label: "Test Revision",
    timeoutMs: 50,
    save: async () => {
      saves += 1;
      durable.set(intended.id, intended);
      throw new Error("save acknowledgement lost");
    },
    read: async () => durable.get(intended.id) ?? null,
    isExact: (artifact) => artifact.id === intended.id && artifact.value === intended.value,
  });
  assert.equal(saves, 1);
});

test("immutable publication preserves a known no-artifact save failure", async () => {
  const original = new Error("disk unavailable");
  await assert.rejects(
    publishImmutableLearningArtifact({
      label: "Test Revision",
      timeoutMs: 50,
      save: async () => { throw original; },
      read: async () => null,
      isExact: () => true,
    }),
    (error: unknown) => error === original,
  );
});

test("immutable publication bounds a never-settling reconciliation read as uncertain", async () => {
  await assert.rejects(
    publishImmutableLearningArtifact({
      label: "Test Derivation",
      timeoutMs: 5,
      save: async () => { throw new Error("save acknowledgement lost"); },
      read: async () => new Promise<never>(() => {}),
      isExact: () => true,
    }),
    (error: unknown) => error instanceof PindieLearningArtifactPublicationUncertainError,
  );
});

test("late immutable publication settlement is observed without a second caller settlement", async () => {
  let resolveSave!: () => void;
  const savePromise = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  await assert.rejects(
    publishImmutableLearningArtifact({
      label: "Test Synthesis",
      timeoutMs: 5,
      save: async () => savePromise,
      read: async () => null,
      isExact: () => true,
    }),
    PindieLearningArtifactPublicationUncertainError,
  );
  resolveSave();
  await nextTurn();

  let rejectSave!: (error: Error) => void;
  const lateRejectSave = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  const rejectedPublication = publishImmutableLearningArtifact({
    label: "Test Synthesis",
    timeoutMs: 5,
    save: async () => lateRejectSave,
    read: async () => null,
    isExact: () => true,
  });
  await assert.rejects(rejectedPublication, PindieLearningArtifactPublicationUncertainError);
  const lateError = new Error("late save failure");
  let unhandled = false;
  const onUnhandled = (reason: unknown): void => {
    if (reason === lateError) unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    rejectSave(lateError);
    await nextTurn();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, false);
});
