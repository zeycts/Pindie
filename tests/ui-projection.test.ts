import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import {
  appendUserDelivery,
  createProjection,
  projectSessionHistory,
  rebuildProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjectionInput,
  type UiMessageBlock,
  type UiWorkBlock,
} from "../src/ui-projection.ts";

function runtime(
  overrides: Partial<PindieUiProjectionInput["session"]["runtime"]> = {},
) {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    pendingMessageCount: 0,
    ...overrides,
  };
}

function state(
  overrides: Record<string, unknown> = {},
): PindiePresentationSnapshot["status"]["state"] {
  return {
    task: {
      goal: "Keep the projection truthful.",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Projection is useful." }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
      ...overrides,
    },
  } as PindiePresentationSnapshot["status"]["state"];
}

function presentation(
  overrides: Partial<PindiePresentationSnapshot> = {},
): PindiePresentationSnapshot {
  return {
    semantic: {
      ok: true,
      snapshot: {
        authority: "coherent",
        taskStatus: "active",
        verificationStatus: "pending",
        hasBlockers: false,
        hasQuestions: false,
        completionReady: false,
        taskRelation: "introduced_during_run",
        completionRelation: "not_completed",
        gateRelation: "none",
      },
    },
    status: {
      consumption: { scope: "run", durationMs: 1_000, cost: 0.01 },
      reasoningMode: "auto",
      activity: "thinking",
      state: state(),
      stateUnavailableReason: null,
      runStale: false,
      quotaResumeWaiting: false,
      subscriptionUsage: null,
    },
    quotaResumeWaiting: null,
    projectRoot: "/project",
    ...overrides,
  };
}

function input(
  overrides: Partial<PindieUiProjectionInput> = {},
): PindieUiProjectionInput {
  return {
    presentation: presentation(),
    session: {
      sessionId: "session-1",
      displayIdentity: "A useful Session",
      model: { provider: "test-provider", modelId: "test-model" },
      thinkingLevel: "high",
      runtime: runtime(),
      branch: [],
    },
    ...overrides,
  };
}

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-21T00:00:00.000Z",
    message,
  } as unknown as SessionEntry;
}

function customMessageEntry(
  id: string,
  customType: string,
  content: string,
  display: boolean,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-09-21T00:00:00.000Z",
    customType,
    content,
    display,
  } as unknown as SessionEntry;
}

function userEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, { role: "user", content: text, timestamp: 1 });
}

function assistantEntry(
  id: string,
  text: string,
  stopReason: string = "stop",
): SessionEntry {
  return messageEntry(id, {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test-provider",
    model: "test-model",
    usage: {},
    stopReason,
    timestamp: 1,
  });
}

function assistantMessage(
  textParts: readonly Record<string, unknown>[],
  stopReason = "pending",
): Record<string, unknown> {
  return {
    role: "assistant",
    content: textParts,
    api: "test",
    provider: "test-provider",
    model: "test-model",
    usage: {},
    stopReason,
    timestamp: 1,
  };
}

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function messageBlocks(projection: ReturnType<typeof createProjection>): UiMessageBlock[] {
  return projection.timeline.filter(
    (block): block is UiMessageBlock => block.type === "message",
  );
}

function workBlocks(projection: ReturnType<typeof createProjection>): UiWorkBlock[] {
  return projection.timeline.filter(
    (block): block is UiWorkBlock => block.type === "work",
  );
}

test("projects header and ambient status from Presentation and active Session facts", () => {
  const projection = createProjection(input({
    presentation: presentation({
      status: {
        ...presentation().status,
        consumption: { scope: "task", durationMs: 2_000, cost: 0.25 },
        activity: "running",
        reasoningMode: "manual",
      },
      projectRoot: "/workspace/pindie",
    }),
    session: {
      ...input().session,
      sessionId: "session-header",
      displayIdentity: "Pindie work",
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "low",
      runtime: runtime({
        sessionId: "session-header",
        isStreaming: true,
        isCompacting: true,
        isIdle: false,
        pendingMessageCount: 2,
      }),
    },
  }));

  assert.deepEqual(projection.header, {
    projectRoot: "/workspace/pindie",
    displayIdentity: "Pindie work",
    sessionId: "session-header",
    model: { provider: "openai", modelId: "gpt-test" },
    thinkingLevel: "low",
    taskStatus: "active",
    semanticAuthority: "coherent",
  });
  assert.equal(projection.status.isStreaming, true);
  assert.equal(projection.status.isCompacting, true);
  assert.equal(projection.status.pendingMessageCount, 2);
  assert.equal(projection.status.activity, "running");
  assert.equal(projection.status.consumption?.scope, "task");
  assert.equal(projection.status.reasoningMode, "manual");
  assert.equal(projection.status.semanticAuthority, "coherent");
});

test("semantic authority and task facts come from presentation.semantic", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "stale",
          taskStatus: "active",
          verificationStatus: "failed",
          hasBlockers: false,
          hasQuestions: true,
          completionReady: false,
        },
      },
      status: {
        ...presentation().status,
        state: state({
          openLoops: { blockers: ["source state says blocked"], questions: [], nextIntent: null },
        }),
      },
    }),
  }));

  assert.equal(projection.header.semanticAuthority, "stale");
  assert.equal(projection.header.taskStatus, "active");
  assert.equal(projection.status.verificationStatus, "failed");
  assert.equal(projection.status.hasBlockers, false);
  assert.equal(projection.status.hasQuestions, true);
});

test("presentation=null is safe, visibly unavailable, and creates no false attention", () => {
  const projection = createProjection(input({ presentation: null }));

  assert.equal(projection.status.presentationAvailability, "unavailable");
  assert.equal(projection.status.semanticAuthority, "presentation-unavailable");
  assert.equal(projection.header.semanticAuthority, "presentation-unavailable");
  assert.equal(projection.attention, null);
});

test("current Human Gate becomes detached structured attention", () => {
  const gate = { kind: "decision", question: "Ship this change?", options: ["yes", "no"] } as const;
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "coherent",
          taskStatus: "waiting_human",
          verificationStatus: "pending",
          hasBlockers: false,
          hasQuestions: false,
          completionReady: false,
          taskRelation: "introduced_during_run",
          completionRelation: "not_completed",
          gateRelation: "opened_during_run",
        },
      },
      status: { ...presentation().status, state: state({ humanGate: gate }) },
    }),
  }));

  assert.deepEqual(projection.attention, {
    kind: "human-gate",
    gateKind: "decision",
    question: "Ship this change?",
    options: ["yes", "no"],
  });
});

test("blocked Task does not automatically become Attention", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "coherent",
          taskStatus: "blocked",
          verificationStatus: "pending",
          hasBlockers: true,
          hasQuestions: false,
          completionReady: false,
          taskRelation: "introduced_during_run",
          completionRelation: "not_completed",
          gateRelation: "none",
        },
      },
      status: {
        ...presentation().status,
        state: state({
          openLoops: { blockers: ["waiting on a recoverable fact"], questions: [], nextIntent: null },
        }),
      },
    }),
  }));

  assert.equal(projection.header.taskStatus, "blocked");
  assert.equal(projection.status.hasBlockers, true);
  assert.equal(projection.attention, null);
});

test("unavailable semantic authority becomes structured degraded Attention", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: { ok: true, snapshot: { authority: "unavailable" } },
    }),
  }));

  assert.deepEqual(projection.attention, {
    kind: "authority-unavailable",
    reason: "Pindie semantic authority is unavailable.",
  });
  assert.equal(projection.status.semanticAuthority, "unavailable");

  const failed = createProjection(input({
    presentation: presentation({ semantic: { ok: false, error: "derivation failed safely" } }),
  }));
  assert.deepEqual(failed.attention, {
    kind: "authority-unavailable",
    reason: "derivation failed safely",
  });
});

test("history rebuild uses Session entry IDs and excludes aborted content", () => {
  const timeline = projectSessionHistory([
    userEntry("entry-user", "human intent"),
    assistantEntry("entry-assistant", "visible answer"),
    assistantEntry("entry-aborted", "misleading partial answer", "aborted"),
  ]);

  assert.deepEqual(timeline.map((block) => [block.type, block.id]), [
    ["message", "entry-user"],
    ["message", "entry-assistant"],
  ]);
  assert.equal((timeline[0] as UiMessageBlock).text, "human intent");
  assert.equal((timeline[1] as UiMessageBlock).text, "visible answer");
});

test("hidden/internal messages and thinking do not leak into normal Timeline", () => {
  const timeline = projectSessionHistory([
    userEntry("visible-user", "visible"),
    customMessageEntry("hidden-custom", "pindie-state-checkpoint", "secret state", false),
    customMessageEntry("hidden-probe", "pindie-active-task-continuation", "probe", true),
    messageEntry("thinking-only", assistantMessage([{ type: "thinking", thinking: "private chain" }])),
    messageEntry("mixed", assistantMessage([
      { type: "thinking", thinking: "private chain" },
      { type: "text", text: "visible answer" },
    ], "stop")),
  ]);

  assert.deepEqual(timeline.map((block) => block.id), ["visible-user", "mixed"]);
  assert.equal((timeline[1] as UiMessageBlock).text, "visible answer");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("private chain")), false);

  const thinkingOnly = reduceProjectionEvent(
    createProjection(input()),
    event({
      type: "message_start",
      message: assistantMessage([{ type: "thinking", thinking: "private live chain" }]),
    }),
  );
  assert.equal(thinkingOnly.timeline.length, 0);
});

test("assistant streaming updates one session-local live MessageBlock", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "first" }, { type: "thinking", thinking: "hidden" }]),
    assistantMessageEvent: {},
  }));
  const firstBlock = messageBlocks(projection)[0];
  assert.equal(firstBlock?.id, "live:session-1:assistant:1");
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "latest" }]),
    assistantMessageEvent: {},
  }));
  assert.equal(messageBlocks(projection).length, 1);
  assert.equal(messageBlocks(projection)[0]?.id, firstBlock?.id);

  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "latest" }], "stop"),
  }));

  assert.equal(projection.timeline.length, 1);
  const block = projection.timeline[0] as UiMessageBlock;
  assert.equal(block.type, "message");
  assert.equal(block.source, "live");
  assert.equal(block.id, firstBlock?.id);
  assert.equal(block.lifecycle, "complete");
  assert.equal(block.text, "latest");
});

test("sequential assistant messages remain distinct completed live blocks", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [
    { id: "live:session-1:assistant:1", text: "answer A", lifecycle: "complete" },
    { id: "live:session-1:assistant:2", text: "answer B", lifecycle: "complete" },
  ]);
});

test("aborting the current assistant removes only that live block", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B partial" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer B latest" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B latest" }], "aborted"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [{
    id: "live:session-1:assistant:1",
    text: "answer A",
    lifecycle: "complete",
  }]);
});

test("assistant error history remains visible after the stream ends", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "failed answer" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "failed answer" }], "error"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [{
    id: "live:session-1:assistant:1",
    text: "failed answer",
    lifecycle: "error",
  }]);
});

test("entry_appended reconciles only the matching latest live assistant", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: assistantEntry("persisted-assistant-b", "answer B"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "live:session-1:assistant:1", source: "live", text: "answer A" },
    { id: "persisted-assistant-b", source: "session", text: "answer B" },
  ]);
});

test("mismatched persisted assistant reconciliation preserves older live history", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: assistantEntry("persisted-assistant-b", "persisted B wording"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "live:session-1:assistant:1", source: "live", text: "answer A" },
    { id: "persisted-assistant-b", source: "session", text: "persisted B wording" },
  ]);
});

test("tool calls remain separate and repeated updates replace one WorkBlock", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "tool-b",
    toolName: "bash",
    args: { command: "pwd" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
    partialResult: { content: [{ type: "text", text: "first preview" }] },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
    partialResult: { content: [{ type: "text", text: "latest preview" }] },
  }));

  assert.deepEqual(workBlocks(projection).map((block) => block.toolCallId), ["tool-a", "tool-b"]);
  assert.equal(workBlocks(projection).find((block) => block.toolCallId === "tool-a")?.result?.summary, "latest preview");

  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "tool-a",
    toolName: "read",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "tool-b",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failed" }] },
    isError: true,
  }));

  const finalA = workBlocks(projection).find((block) => block.toolCallId === "tool-a");
  const finalB = workBlocks(projection).find((block) => block.toolCallId === "tool-b");
  assert.equal(finalA?.lifecycle, "complete");
  assert.equal(finalA?.result?.summary, "done");
  assert.equal(finalB?.lifecycle, "failed");
  assert.equal(finalB?.result?.isError, true);
});

test("queue_update replaces full queue state while preserving steering/followUp provenance", () => {
  let projection = createProjection(input({ session: {
    ...input().session,
    runtime: runtime({ pendingMessageCount: 3 }),
  } }));
  assert.equal(projection.queue.state, "unknown");
  assert.equal(projection.queue.steering, null);
  assert.equal(projection.queue.followUp, null);
  assert.equal(projection.queue.pendingMessageCount, 3);

  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: ["steer one"],
    followUp: ["follow one", "follow two"],
  }));
  assert.deepEqual(projection.queue, {
    state: "authoritative",
    steering: ["steer one"],
    followUp: ["follow one", "follow two"],
    pendingMessageCount: 3,
  });

  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: [],
    followUp: ["replacement"],
  }));
  assert.deepEqual(projection.queue.steering, []);
  assert.deepEqual(projection.queue.followUp, ["replacement"]);
  assert.equal(projection.status.pendingMessageCount, 1);
});

test("rebuilding for a new Session ID discards live blocks and queue observations", () => {
  let oldProjection = createProjection(input());
  oldProjection = reduceProjectionEvent(oldProjection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "old" }]),
  }));
  oldProjection = reduceProjectionEvent(oldProjection, event({
    type: "queue_update",
    steering: ["old steer"],
    followUp: [],
  }));
  assert.equal(oldProjection.queue.state, "authoritative");

  const freshProjection = createProjection(input({
    session: {
      ...input().session,
      sessionId: "session-2",
      displayIdentity: "fresh",
      runtime: runtime({ sessionId: "session-2", pendingMessageCount: 1 }),
      branch: [userEntry("fresh-entry", "new Session")],
    },
  }));

  assert.equal(freshProjection.header.sessionId, "session-2");
  assert.deepEqual(freshProjection.timeline.map((block) => block.id), ["fresh-entry"]);
  assert.equal(freshProjection.queue.state, "unknown");
  assert.equal(freshProjection.queue.steering, null);
  assert.equal(freshProjection.timeline.some((block) => block.id.includes("session-1")), false);
});

test("full rebuild replaces ephemeral assistant identities with Session entry IDs", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => block.id), [
    "live:session-1:assistant:1",
    "live:session-1:assistant:2",
  ]);

  const rebuilt = rebuildProjection(input({
    session: {
      ...input().session,
      branch: [
        assistantEntry("entry-a", "answer A"),
        assistantEntry("entry-b", "answer B"),
      ],
    },
  }));

  assert.deepEqual(messageBlocks(rebuilt).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "entry-a", source: "session", text: "answer A" },
    { id: "entry-b", source: "session", text: "answer B" },
  ]);
  assert.equal(rebuilt.timeline.some((block) => block.id.startsWith("live:")), false);
  assert.deepEqual(rebuilt.liveAssistant, { activeId: null, nextSequence: 1 });
});

test("projection operations isolate source Session entries, messages, and tool results", () => {
  const entry = assistantEntry("entry", "unchanged");
  const eventValue = {
    type: "tool_execution_update",
    toolCallId: "tool-copy",
    toolName: "read",
    args: { nested: { value: "before" } },
    partialResult: {
      content: [{ type: "text", text: "result before" }],
      details: { changed: false },
    },
  };
  const entryBefore = structuredClone(entry);
  const eventBefore = structuredClone(eventValue);

  let projection = createProjection(input({ session: { ...input().session, branch: [entry] } }));
  projection = reduceProjectionEvent(projection, event(eventValue));

  assert.deepEqual(entry, entryBefore);
  assert.deepEqual(eventValue, eventBefore);
  const work = workBlocks(projection)[0];
  assert.notEqual(work.input, (eventValue.args as { nested: unknown }));
  assert.notEqual(work.result?.details, (eventValue.partialResult as { details: unknown }).details);
});

test("runtime churn stays ambient rather than becoming permanent RuntimeBlocks", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({ type: "agent_start" }));
  projection = reduceProjectionEvent(projection, event({ type: "compaction_start", reason: "threshold" }));
  projection = reduceProjectionEvent(projection, event({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 10,
    errorMessage: "temporary",
  }));
  projection = reduceProjectionEvent(projection, event({ type: "agent_settled" }));

  assert.equal(projection.timeline.some((block) => block.type === "runtime"), false);
  assert.equal(projection.status.isIdle, true);
  assert.equal(projection.status.isStreaming, false);
  assert.equal(projection.status.isCompacting, false);
});

test("local user deliveries are disposable, session-local, and provenance-aware", () => {
  const projection = appendUserDelivery(createProjection(input()), {
    id: "live:session-1:user:1",
    text: "steer the current work",
    delivery: "steer",
  });
  const block = projection.timeline[0] as UiMessageBlock;

  assert.deepEqual(block, {
    type: "message",
    id: "live:session-1:user:1",
    source: "live",
    role: "user",
    text: "steer the current work",
    lifecycle: "complete",
    defaultDisplayMode: "full",
    delivery: "steer",
  });

  const rebuilt = rebuildProjection(input({
    session: {
      ...input().session,
      branch: [userEntry("authoritative-user", "steer the current work")],
    },
  }));
  assert.deepEqual(rebuilt.timeline.map((candidate) => candidate.id), ["authoritative-user"]);

  const reconciled = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: userEntry("authoritative-user", "steer the current work"),
  }));
  assert.deepEqual(reconciled.timeline.map((candidate) => candidate.id), ["authoritative-user"]);
  assert.equal((reconciled.timeline[0] as UiMessageBlock).source, "session");
  assert.equal((reconciled.timeline[0] as UiMessageBlock).delivery, "steer");
});

test("same-session fact refresh preserves live timeline identity and authoritative queue", () => {
  let projection = createProjection(input({
    session: {
      ...input().session,
      runtime: runtime({ pendingMessageCount: 1 }),
    },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "streaming answer" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: ["queued steer"],
    followUp: [],
  }));
  const timelineBefore = projection.timeline;
  const liveBefore = projection.liveAssistant;

  const refreshed = refreshProjectionFacts(projection, input({
    presentation: presentation({
      status: {
        ...presentation().status,
        activity: "running",
        consumption: { scope: "task", durationMs: 3_000, cost: 0.42 },
      },
    }),
    session: {
      ...input().session,
      runtime: runtime({
        isStreaming: true,
        isIdle: false,
        pendingMessageCount: 1,
      }),
    },
  }));

  assert.equal(refreshed.timeline, timelineBefore);
  assert.deepEqual(refreshed.liveAssistant, liveBefore);
  assert.deepEqual(refreshed.queue, {
    state: "authoritative",
    steering: ["queued steer"],
    followUp: [],
    pendingMessageCount: 1,
  });
  assert.equal(refreshed.status.isStreaming, true);
  assert.equal(refreshed.status.isIdle, false);
  assert.equal(refreshed.status.consumption?.cost, 0.42);
  assert.equal(refreshed.status.activity, "running");
});
