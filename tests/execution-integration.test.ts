import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionIntegration } from "../src/execution-integration.ts";
import { classifyToolEffect } from "../src/execution-semantics.ts";
import { PINDIE_TOOL_LIVENESS_TIMEOUT_MS } from "../src/liveness.ts";
import type { ProjectFingerprint } from "../src/project-mutation.ts";

function toolCall(toolCallId: string): any {
  return {
    type: "tool_call",
    toolCallId,
    toolName: "bash",
    input: { command: "test" },
  };
}

function toolResult(toolCallId: string): any {
  return {
    type: "tool_result",
    toolCallId,
    toolName: "bash",
    input: { command: "test" },
    content: [{ type: "text", text: "tool output" }],
    details: undefined,
    isError: false,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ambiguousEffect = classifyToolEffect("bash");

test("baseline fingerprint liveness degrades to unknown while authorized bookkeeping settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markCaptureStarted!: () => void;
  let releaseCapture!: (fingerprint: ProjectFingerprint) => void;
  const captureStarted = new Promise<void>((resolve) => { markCaptureStarted = resolve; });
  const capture = new Promise<ProjectFingerprint>((resolve) => { releaseCapture = resolve; });
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: async () => {
      markCaptureStarted();
      return capture;
    },
  });
  const event = toolCall("baseline-hangs");

  const record = execution.recordAuthorizedConsequentialCall(
    event,
    ambiguousEffect,
    "/repo",
    new Set(["project.mutate"]),
  );
  await captureStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await record;

  const authorized = execution.takeAuthorizedExecution(event.toolCallId);
  assert.ok(authorized);
  assert.equal(authorized.effect.projectMutation, "ambiguous");
  assert.deepEqual(authorized.capabilitiesAtCall, new Set(["project.mutate"]));
  assert.equal(
    await execution.settleProjectMutation(toolResult(event.toolCallId), authorized),
    "invalidate",
  );

  releaseCapture({ kind: "known", digest: "late-baseline" });
  await nextTurn();
});

test("settlement fingerprint liveness conservatively invalidates verification", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let captureCount = 0;
  let markSettlementStarted!: () => void;
  let releaseSettlement!: (fingerprint: ProjectFingerprint) => void;
  const settlementStarted = new Promise<void>((resolve) => { markSettlementStarted = resolve; });
  const settlementCapture = new Promise<ProjectFingerprint>((resolve) => { releaseSettlement = resolve; });
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: async () => {
      captureCount += 1;
      if (captureCount === 1) return { kind: "known", digest: "baseline" };
      markSettlementStarted();
      return settlementCapture;
    },
  });
  const event = toolCall("settlement-hangs");

  await execution.recordAuthorizedConsequentialCall(event, ambiguousEffect, "/repo");
  const authorized = execution.takeAuthorizedExecution(event.toolCallId);
  assert.ok(authorized);
  const settlement = execution.settleProjectMutation(toolResult(event.toolCallId), authorized);
  await settlementStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  assert.equal(await settlement, "invalidate");

  releaseSettlement({ kind: "known", digest: "baseline" });
  await nextTurn();
});

test("late settlement fingerprint completion cannot change the decision or recreate the mutation window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let captureCount = 0;
  let releaseSettlement!: (fingerprint: ProjectFingerprint) => void;
  const settlementCapture = new Promise<ProjectFingerprint>((resolve) => { releaseSettlement = resolve; });
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: async () => {
      captureCount += 1;
      if (captureCount === 1) return { kind: "known", digest: "baseline" };
      if (captureCount === 2) return settlementCapture;
      if (captureCount === 3) return { kind: "known", digest: "new-window" };
      return { kind: "known", digest: "after-new-window" };
    },
  });
  const first = toolCall("late-settlement");

  await execution.recordAuthorizedConsequentialCall(first, ambiguousEffect, "/repo");
  const firstExecution = execution.takeAuthorizedExecution(first.toolCallId);
  assert.ok(firstExecution);
  const settlement = execution.settleProjectMutation(toolResult(first.toolCallId), firstExecution);
  await nextTurn();
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  assert.equal(await settlement, "invalidate");

  releaseSettlement({ kind: "known", digest: "baseline" });
  await nextTurn();

  const second = toolCall("new-window");
  await execution.recordAuthorizedConsequentialCall(second, ambiguousEffect, "/repo");
  assert.equal(captureCount, 3);
  const secondExecution = execution.takeAuthorizedExecution(second.toolCallId);
  assert.ok(secondExecution);
  assert.equal(
    await execution.settleProjectMutation(toolResult(second.toolCallId), secondExecution),
    "invalidate",
  );
});

test("ordinary baseline fingerprint failures also allow authorized mutation bookkeeping to proceed", async () => {
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: async () => {
      throw new Error("filesystem detail should remain internal");
    },
  });
  const event = toolCall("baseline-fails");

  await execution.recordAuthorizedConsequentialCall(event, ambiguousEffect, "/repo");
  const authorized = execution.takeAuthorizedExecution(event.toolCallId);
  assert.ok(authorized);
  assert.equal(
    await execution.settleProjectMutation(toolResult(event.toolCallId), authorized),
    "invalidate",
  );
});
