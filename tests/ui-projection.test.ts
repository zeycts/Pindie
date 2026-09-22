import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import {
  appendUserDelivery,
  classifyToolPresentation,
  createProjection,
  projectSessionHistory,
  rebuildProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjectionInput,
  type UiMessageBlock,
  type UiObservationWorkBlock,
  type UiToolWorkBlock,
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

function assistantToolEntry(
  id: string,
  calls: readonly Record<string, unknown>[],
  text?: string,
): SessionEntry {
  return messageEntry(id, assistantMessage([
    ...(text === undefined ? [] : [{ type: "text", text }]),
    ...calls.map((call) => ({ type: "toolCall", ...call })),
  ], "toolUse"));
}

function toolResultEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  options: { readonly isError?: boolean; readonly text?: string; readonly details?: unknown } = {},
): SessionEntry {
  return messageEntry(id, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: options.text === undefined
      ? []
      : [{ type: "text", text: options.text }],
    details: options.details,
    isError: options.isError ?? false,
    timestamp: 1,
  });
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

function observationBlocks(projection: ReturnType<typeof createProjection>): UiObservationWorkBlock[] {
  return workBlocks(projection).filter(
    (block): block is UiObservationWorkBlock => block.kind === "observation",
  );
}

function toolWorkBlocks(projection: ReturnType<typeof createProjection>): UiToolWorkBlock[] {
  return workBlocks(projection).filter(
    (block): block is UiToolWorkBlock => block.kind !== "observation",
  );
}

test("presentation classifier reserves semantic tools without changing execution semantics", () => {
  assert.equal(classifyToolPresentation("read"), "observation");
  assert.equal(classifyToolPresentation("grep"), "observation");
  assert.equal(classifyToolPresentation("edit"), "edit");
  assert.equal(classifyToolPresentation("write"), "edit");
  assert.equal(classifyToolPresentation("bash"), "command");
  assert.equal(classifyToolPresentation("pindie_task_progress"), "semantic");
  assert.equal(classifyToolPresentation("pindie_memory_capture"), "external");
  assert.equal(classifyToolPresentation("browser_navigate"), "external");
  assert.equal(classifyToolPresentation("future_tool"), "generic");
});

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

test("rebuilds persisted assistant toolCall plus toolResult into one observation WorkBlock", () => {
  const timeline = projectSessionHistory([
    userEntry("history-user", "inspect the project"),
    assistantToolEntry("history-assistant", [
      { id: "read-1", name: "read", arguments: { path: "src/runtime.ts" } },
    ], "I will inspect that."),
    toolResultEntry("history-result", "read-1", "read", { text: "file contents" }),
  ]);

  assert.deepEqual(timeline.map((block) => [block.type, block.id]), [
    ["message", "history-user"],
    ["message", "history-assistant"],
    ["work", "observe:read-1"],
  ]);
  const observation = timeline[2] as UiObservationWorkBlock;
  assert.equal(observation.kind, "observation");
  assert.equal(observation.lifecycle, "complete");
  assert.equal(observation.defaultDisplayMode, "compact");
  assert.equal(observation.items[0]?.toolCallId, "read-1");
  assert.equal(observation.items[0]?.lifecycle, "complete");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes('"role":"toolResult"')), false);
});

test("groups consecutive historical read, grep, and ls calls into one observation burst", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("assistant-observe", [
      { id: "read-1", name: "read", arguments: { path: "a.ts" } },
      { id: "grep-1", name: "grep", arguments: { pattern: "quotaResume", path: "src" } },
      { id: "ls-1", name: "ls", arguments: { path: "src" } },
    ]),
    toolResultEntry("result-read", "read-1", "read"),
    toolResultEntry("result-grep", "grep-1", "grep"),
    toolResultEntry("result-ls", "ls-1", "ls"),
  ]);

  const observations = timeline.filter(
    (block): block is UiObservationWorkBlock => block.type === "work" && block.kind === "observation",
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), [
    "read-1",
    "grep-1",
    "ls-1",
  ]);
  assert.equal(observations[0]?.lifecycle, "complete");
  assert.equal(observations[0]?.defaultDisplayMode, "compact");
});

test("reconstructs edit, command, unknown, and reserved semantic history without chat leaks", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("assistant-work", [
      { id: "edit-1", name: "edit", arguments: { path: "src/runtime.ts", oldText: "a", newText: "b" } },
    ]),
    toolResultEntry("result-edit", "edit-1", "edit"),
    assistantToolEntry("assistant-command", [
      { id: "bash-1", name: "bash", arguments: { command: "pnpm test" } },
    ]),
    toolResultEntry("result-bash", "bash-1", "bash", { text: "ok" }),
    assistantToolEntry("assistant-unknown", [
      { id: "unknown-1", name: "future_tool", arguments: { value: "kept" } },
      { id: "semantic-1", name: "pindie_task_progress", arguments: { nextIntent: "continue" } },
    ]),
    toolResultEntry("result-unknown", "unknown-1", "future_tool", { text: "future result" }),
    toolResultEntry("result-semantic", "semantic-1", "pindie_task_progress"),
  ]);

  const work = timeline.filter((block): block is UiWorkBlock => block.type === "work");
  assert.deepEqual(work.map((block) => block.kind), ["edit", "command", "generic"]);
  assert.equal((work[0] as UiToolWorkBlock).toolCallId, "edit-1");
  assert.equal((work[1] as UiToolWorkBlock).toolCallId, "bash-1");
  assert.equal((work[2] as UiToolWorkBlock).toolCallId, "unknown-1");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("pindie_task_progress")), false);
  assert.equal(timeline.some((block) => JSON.stringify(block).includes('"role":"toolResult"')), false);
});

test("historical tool calls without results remain visible as non-success work", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("interrupted", [
      { id: "unfinished", name: "bash", arguments: { command: "pnpm test" } },
    ]),
  ]);
  const work = timeline[0] as UiToolWorkBlock;
  assert.equal(work.kind, "command");
  assert.equal(work.lifecycle, "failed");
  assert.equal(work.defaultDisplayMode, "full");
  assert.match(work.result?.summary ?? "", /not persisted/);
});

test("assistant tool history keeps thinking absent", () => {
  const timeline = projectSessionHistory([
    messageEntry("thinking-and-tool", assistantMessage([
      { type: "thinking", thinking: "private chain" },
      { type: "toolCall", id: "read-thinking", name: "read", arguments: { path: "a.ts" } },
    ])),
    toolResultEntry("read-thinking-result", "read-thinking", "read"),
  ]);
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("private chain")), false);
  assert.equal(timeline.some((block) => block.type === "message" && block.text.length === 0), false);
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

  assert.deepEqual(workBlocks(projection).map((block) => block.kind), ["observation", "command"]);
  const observed = workBlocks(projection)[0] as UiObservationWorkBlock;
  assert.deepEqual(observed.items.map((item) => item.toolCallId), ["tool-a"]);
  assert.equal(observed.items[0]?.result?.summary, "latest preview");

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

  const finalA = workBlocks(projection).find(
    (block): block is UiObservationWorkBlock => block.kind === "observation",
  );
  const finalB = workBlocks(projection).find(
    (block): block is UiToolWorkBlock => block.kind === "command",
  );
  assert.equal(finalA?.lifecycle, "complete");
  assert.equal(finalA?.items[0]?.result?.summary, "done");
  assert.equal(finalB?.lifecycle, "failed");
  assert.equal(finalB?.result?.isError, true);
});

test("live consecutive observations share one deterministic group and compact on success", () => {
  let projection = createProjection(input());
  for (const [toolCallId, toolName, args] of [
    ["read-live-1", "read", { path: "a.ts" }],
    ["read-live-2", "read", { path: "b.ts" }],
    ["grep-live-1", "grep", { pattern: "quotaResume", path: "src" }],
    ["ls-live-1", "ls", { path: "src" }],
  ] as const) {
    projection = reduceProjectionEvent(projection, event({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args,
    }));
    projection = reduceProjectionEvent(projection, event({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [] },
      isError: false,
    }));
  }

  const observations = observationBlocks(projection);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.id, "observe:read-live-1");
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), [
    "read-live-1",
    "read-live-2",
    "grep-live-1",
    "ls-live-1",
  ]);
  assert.equal(observations[0]?.lifecycle, "complete");
  assert.equal(observations[0]?.defaultDisplayMode, "compact");
});

test("visible user and assistant messages close live observation bursts", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "before-user",
    toolName: "read",
    args: { path: "a.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "before-user",
    toolName: "read",
    result: { content: [] },
    isError: false,
  }));
  projection = appendUserDelivery(projection, {
    id: "live:user-boundary",
    text: "continue",
    delivery: "prompt",
  });
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "after-user",
    toolName: "read",
    args: { path: "b.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "after-user",
    toolName: "read",
    result: { content: [] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "done" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "done" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "after-assistant",
    toolName: "read",
    args: { path: "c.ts" },
  }));

  assert.deepEqual(observationBlocks(projection).map((block) => block.id), [
    "observe:before-user",
    "observe:after-user",
    "observe:after-assistant",
  ]);
});

test("live observation grouping closes around edits", () => {
  let projection = createProjection(input());
  const reduce = (value: Record<string, unknown>) => {
    projection = reduceProjectionEvent(projection, event(value));
  };
  reduce({ type: "tool_execution_start", toolCallId: "read-a", toolName: "read", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-a", toolName: "read", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "edit-a", toolName: "edit", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "edit-a", toolName: "edit", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "grep-b", toolName: "grep", args: { pattern: "next" } });
  reduce({ type: "tool_execution_end", toolCallId: "grep-b", toolName: "grep", result: { content: [] }, isError: false });

  assert.deepEqual(workBlocks(projection).map((block) => block.kind), ["observation", "edit", "observation"]);
  assert.equal((workBlocks(projection)[0] as UiObservationWorkBlock).id, "observe:read-a");
  assert.equal((workBlocks(projection)[2] as UiObservationWorkBlock).id, "observe:grep-b");
});

test("observation failure seals its group and leaves the next observation separate", () => {
  let projection = createProjection(input());
  const reduce = (value: Record<string, unknown>) => {
    projection = reduceProjectionEvent(projection, event(value));
  };
  reduce({ type: "tool_execution_start", toolCallId: "read-ok", toolName: "read", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-ok", toolName: "read", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "grep-fail", toolName: "grep", args: { pattern: "missing" } });
  reduce({ type: "tool_execution_end", toolCallId: "grep-fail", toolName: "grep", result: { content: [{ type: "text", text: "not found" }] }, isError: true });
  reduce({ type: "tool_execution_start", toolCallId: "read-next", toolName: "read", args: { path: "b.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-next", toolName: "read", result: { content: [] }, isError: false });

  const observations = observationBlocks(projection);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), ["read-ok", "grep-fail"]);
  assert.equal(observations[0]?.lifecycle, "failed");
  assert.equal(observations[0]?.defaultDisplayMode, "full");
  assert.deepEqual(observations[1]?.items.map((item) => item.toolCallId), ["read-next"]);
});

test("live edit and command updates retain one block identity and bounded command output", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "edit-live",
    toolName: "edit",
    args: { path: "src/runtime.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "edit-live",
    toolName: "edit",
    args: { path: "src/runtime.ts" },
    partialResult: { content: [{ type: "text", text: "preview" }] },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "edit-live",
    toolName: "edit",
    result: { content: [] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "bash-live",
    toolName: "bash",
    args: { command: "pnpm test" },
  }));
  const huge = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "bash-live",
    toolName: "bash",
    args: { command: "pnpm test" },
    partialResult: { content: [{ type: "text", text: huge }] },
  }));

  assert.equal(toolWorkBlocks(projection).length, 2);
  const edit = toolWorkBlocks(projection).find((block) => block.toolCallId === "edit-live");
  const command = toolWorkBlocks(projection).find((block) => block.toolCallId === "bash-live");
  assert.equal(edit?.lifecycle, "complete");
  assert.equal(edit?.defaultDisplayMode, "compact");
  assert.equal(command?.lifecycle, "running");
  assert.equal(command?.defaultDisplayMode, "preview");
  assert.ok((command?.result?.summary.length ?? 0) <= 3_000);
  assert.match(command?.result?.summary ?? "", /line 79/);
});

test("entry_appended tool history reconciles by toolCallId without duplicating unrelated work", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "live-read",
    toolName: "read",
    args: { path: "live.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "unrelated-edit",
    toolName: "edit",
    args: { path: "other.ts" },
  }));
  const persistedAssistant = assistantToolEntry("persisted-assistant", [
    { id: "live-read", name: "read", arguments: { path: "live.ts" } },
  ]);
  projection = reduceProjectionEvent(projection, event({ type: "entry_appended", entry: persistedAssistant }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: toolResultEntry("persisted-result", "live-read", "read", { text: "done" }),
  }));

  assert.equal(workBlocks(projection).filter((block) =>
    block.kind === "observation" && block.items.some((item) => item.toolCallId === "live-read")).length, 1);
  assert.equal(workBlocks(projection).some((block) =>
    block.kind !== "observation" && block.toolCallId === "unrelated-edit"), true);
  const readGroup = observationBlocks(projection).find((block) =>
    block.items.some((item) => item.toolCallId === "live-read"));
  assert.equal(readGroup?.items.find((item) => item.toolCallId === "live-read")?.lifecycle, "complete");
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
