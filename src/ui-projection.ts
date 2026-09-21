import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  isPindieContinuationProbeMessage,
  PINDIE_CONTINUATION_PROBE_TYPE,
} from "./continuation.ts";
import type { PindiePresentationSnapshot } from "./presentation-integration.ts";
import type { ActiveSessionFacts } from "./pi-runtime.ts";
import type { RunActivity } from "./run-activity.ts";
import type {
  ConsumptionStatus,
  PindieStatusSnapshot,
  VerificationProgress,
} from "./status-line.ts";
import type { SubscriptionUsageSnapshot } from "./subscription-usage.ts";
import type {
  HumanGate,
  PindieTask,
  TaskStatus,
  VerificationStatus,
} from "./state.ts";
import type { QuotaResumeWaitingStatus } from "./quota-resume-control.ts";

/** Renderer-independent density guidance. User fold state belongs to the view. */
export type UiDisplayMode = "compact" | "preview" | "full";

export type UiSemanticAuthority =
  | "coherent"
  | "stale"
  | "unavailable"
  | "presentation-unavailable";

export type UiTaskStatus = TaskStatus | null;
export type UiVerificationStatus = VerificationStatus | "none" | null;

export interface UiModelProjection {
  readonly provider: string;
  readonly modelId: string;
}

export interface UiHeaderProjection {
  readonly projectRoot: string | null;
  readonly displayIdentity: string;
  readonly sessionId: string;
  readonly model: UiModelProjection | null;
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly taskStatus: UiTaskStatus;
  readonly semanticAuthority: UiSemanticAuthority;
}

export interface UiStatusProjection {
  readonly presentationAvailability: "available" | "unavailable";
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isIdle: boolean;
  readonly pendingMessageCount: number;
  readonly activity: RunActivity | null;
  readonly consumption: ConsumptionStatus | null;
  readonly reasoningMode: PindieStatusSnapshot["reasoningMode"] | null;
  readonly taskStatus: UiTaskStatus;
  readonly verificationStatus: UiVerificationStatus;
  readonly verificationProgress: VerificationProgress | null;
  readonly hasBlockers: boolean | null;
  readonly hasQuestions: boolean | null;
  readonly semanticAuthority: UiSemanticAuthority;
  readonly stateUnavailableReason: string | null;
  readonly quotaResumeWaiting: QuotaResumeWaitingStatus | null;
  readonly subscriptionUsage: SubscriptionUsageSnapshot | null;
}

export interface UiMessageBlock {
  readonly type: "message";
  /** Persisted entry IDs or a session-local `live:...` ephemeral ID. */
  readonly id: string;
  readonly source: "session" | "live";
  readonly role: "user" | "assistant" | "custom";
  readonly text: string;
  readonly lifecycle: "streaming" | "complete" | "error";
  readonly defaultDisplayMode: UiDisplayMode;
  readonly customType?: string;
}

export interface UiToolResultProjection {
  readonly isError: boolean;
  readonly summary: string;
  readonly details: UiPlainValue | null;
}

export interface UiWorkBlock {
  readonly type: "work";
  /** Tool execution identity; this is never an array index. */
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly lifecycle: "running" | "complete" | "failed";
  readonly input: UiPlainValue | null;
  readonly result: UiToolResultProjection | null;
  readonly defaultDisplayMode: UiDisplayMode;
}

/** The Slice C vocabulary reserved for later semantic projection work. */
export interface UiSemanticBlock {
  readonly type: "semantic";
  readonly id: string;
  readonly category: "task" | "verification" | "human-gate" | "completion" | "generic";
  readonly title: string;
  readonly detail?: string;
  readonly defaultDisplayMode: UiDisplayMode;
}

/** The Slice C vocabulary reserved for later runtime projection work. */
export interface UiRuntimeBlock {
  readonly type: "runtime";
  readonly id: string;
  readonly category: "quota" | "rollover" | "stop" | "retry" | "permission" | "generic";
  readonly title: string;
  readonly detail?: string;
  readonly defaultDisplayMode: UiDisplayMode;
}

export type UiTimelineBlock =
  | UiMessageBlock
  | UiWorkBlock
  | UiSemanticBlock
  | UiRuntimeBlock;

export interface UiQueueProjection {
  /** Queue contents are unknown until Pi emits its first full queue_update. */
  readonly state: "unknown" | "authoritative";
  readonly steering: readonly string[] | null;
  readonly followUp: readonly string[] | null;
  readonly pendingMessageCount: number;
}

export type UiAttentionProjection =
  | {
      readonly kind: "human-gate";
      readonly gateKind: HumanGate["kind"];
      readonly question: string;
      readonly options?: readonly string[];
    }
  | {
      readonly kind: "authority-unavailable";
      readonly reason: string;
    };

export interface PindieUiProjection {
  readonly header: UiHeaderProjection;
  readonly status: UiStatusProjection;
  readonly timeline: readonly UiTimelineBlock[];
  readonly queue: UiQueueProjection;
  readonly attention: UiAttentionProjection | null;
}

export interface PindieUiProjectionInput {
  readonly presentation: PindiePresentationSnapshot | null;
  readonly session: {
    readonly sessionId: string;
    readonly displayIdentity: string;
    readonly model: UiModelProjection | null;
    readonly thinkingLevel: AgentSession["thinkingLevel"];
    readonly runtime: ActiveSessionFacts;
    readonly branch: readonly SessionEntry[];
  };
}

/** JSON-shaped values copied into the projection instead of retaining Pi objects. */
export type UiPlainValue =
  | null
  | boolean
  | number
  | string
  | readonly UiPlainValue[]
  | { readonly [key: string]: UiPlainValue };

const LIVE_ASSISTANT_SUFFIX = "assistant";
const MAX_PLAIN_DEPTH = 5;
const MAX_PLAIN_ITEMS = 64;
const MAX_RESULT_SUMMARY_LENGTH = 4_000;

interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly display?: unknown;
  readonly customType?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function messageLike(value: unknown): MessageLike | null {
  const source = record(value);
  return source === null ? null : source as MessageLike;
}

function boundedText(value: string, limit = MAX_RESULT_SUMMARY_LENGTH): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function toPlainValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): UiPlainValue {
  if (value === null) return null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return null;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_PLAIN_DEPTH) return "[truncated]";

  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PLAIN_ITEMS)
      .map((item) => toPlainValue(item, nextSeen, depth + 1));
  }

  const output: Record<string, UiPlainValue> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_PLAIN_ITEMS)) {
    output[key] = toPlainValue(child, nextSeen, depth + 1);
  }
  return output;
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  const singlePart = record(content);
  if (singlePart?.type === "text" && typeof singlePart.text === "string") {
    return singlePart.text;
  }
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const source = record(part);
      return source?.type === "text" && typeof source.text === "string"
        ? [source.text]
        : [];
    })
    .join("\n");
}

function messageText(message: MessageLike): string {
  return visibleText(message.content).trim();
}

function messageRole(message: MessageLike): UiMessageBlock["role"] | null {
  switch (message.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "custom":
      return "custom";
    default:
      return null;
  }
}

function projectMessage(
  id: string,
  message: MessageLike,
  source: UiMessageBlock["source"],
  options: {
    readonly allowEmpty?: boolean;
    readonly customType?: string;
  } = {},
): UiMessageBlock | null {
  if (!id || message.display === false) return null;
  if (isPindieContinuationProbeMessage(message)) return null;

  const role = messageRole(message);
  if (role === null) return null;
  if (role === "assistant" && message.stopReason === "aborted") return null;

  const text = messageText(message);
  if (!text && !options.allowEmpty) return null;
  const lifecycle = message.stopReason === "error" ? "error" : "complete";
  return {
    type: "message",
    id,
    source,
    role,
    text,
    lifecycle,
    defaultDisplayMode: lifecycle === "error" ? "preview" : "full",
    ...(options.customType === undefined ? {} : { customType: options.customType }),
  };
}

function projectSessionEntry(entry: SessionEntry): UiMessageBlock | null {
  if (!entry.id) return null;

  if (entry.type === "message") {
    return projectMessage(entry.id, entry.message, "session");
  }

  if (entry.type === "custom_message") {
    if (
      entry.display === false ||
      entry.customType === PINDIE_CONTINUATION_PROBE_TYPE
    ) return null;
    return projectMessage(
      entry.id,
      { role: "custom", content: entry.content },
      "session",
      { customType: entry.customType },
    );
  }

  return null;
}

/** Rebuild the useful Slice C baseline from the current Pi branch. */
export function projectSessionHistory(
  entries: readonly SessionEntry[],
): readonly UiTimelineBlock[] {
  return entries.flatMap((entry) => {
    const block = projectSessionEntry(entry);
    return block === null ? [] : [block];
  });
}

function copyConsumption(
  consumption: PindieStatusSnapshot["consumption"],
): ConsumptionStatus | null {
  return consumption === null ? null : { ...consumption };
}

function copySubscriptionUsage(
  usage: SubscriptionUsageSnapshot | null | undefined,
): SubscriptionUsageSnapshot | null {
  if (usage === null || usage === undefined) return null;
  return {
    windows: usage.windows.map((window) => ({ ...window })),
    ...(usage.resetCredits === undefined
      ? {}
      : {
          resetCredits: {
            ...usage.resetCredits,
            ...(usage.resetCredits.credits === undefined
              ? {}
              : { credits: usage.resetCredits.credits.map((credit) => ({ ...credit })) }),
          },
        }),
    fetchedAt: usage.fetchedAt,
  };
}

interface SemanticProjection {
  readonly authority: UiSemanticAuthority;
  readonly taskStatus: UiTaskStatus;
  readonly verificationStatus: UiVerificationStatus;
  readonly hasBlockers: boolean | null;
  readonly hasQuestions: boolean | null;
  readonly verificationProgress: VerificationProgress | null;
  readonly unavailableReason: string | null;
}

// This is presentation-only progress, not a second semantic authority. Keep it
// local so the Projection Core has no runtime dependency on status-line/pi-tui.
function projectVerificationProgress(task: PindieTask): VerificationProgress {
  const coveredCriteria = new Set(
    task.verification.checks
      .filter((check) => check.status === "passed")
      .flatMap((check) => check.covers),
  );
  return {
    covered: task.successCriteria.filter((criterion) => coveredCriteria.has(criterion.id)).length,
    total: task.successCriteria.length,
  };
}

function semanticProjection(
  presentation: PindiePresentationSnapshot | null,
): SemanticProjection {
  if (presentation === null) {
    return {
      authority: "presentation-unavailable",
      taskStatus: null,
      verificationStatus: null,
      hasBlockers: null,
      hasQuestions: null,
      verificationProgress: null,
      unavailableReason: null,
    };
  }

  const stateUnavailableReason = presentation.status.stateUnavailableReason;
  if (stateUnavailableReason !== null) {
    return {
      authority: "unavailable",
      taskStatus: null,
      verificationStatus: null,
      hasBlockers: null,
      hasQuestions: null,
      verificationProgress: null,
      unavailableReason: stateUnavailableReason,
    };
  }

  const semantic = presentation.semantic;
  if (!semantic.ok) {
    return {
      authority: "unavailable",
      taskStatus: null,
      verificationStatus: null,
      hasBlockers: null,
      hasQuestions: null,
      verificationProgress: null,
      unavailableReason: semantic.error,
    };
  }

  if (semantic.snapshot.authority === "unavailable") {
    return {
      authority: "unavailable",
      taskStatus: null,
      verificationStatus: null,
      hasBlockers: null,
      hasQuestions: null,
      verificationProgress: null,
      unavailableReason: "Pindie semantic authority is unavailable.",
    };
  }

  const task = presentation.status.state?.task;
  return {
    authority: semantic.snapshot.authority,
    taskStatus: semantic.snapshot.taskStatus,
    verificationStatus: semantic.snapshot.verificationStatus,
    hasBlockers: semantic.snapshot.hasBlockers,
    hasQuestions: semantic.snapshot.hasQuestions,
    verificationProgress: task === null || task === undefined
      ? null
      : projectVerificationProgress(task),
    unavailableReason: null,
  };
}

function copyGate(
  gate: HumanGate,
): Extract<UiAttentionProjection, { kind: "human-gate" }> {
  return {
    kind: "human-gate",
    gateKind: gate.kind,
    question: gate.question,
    ...(gate.options === undefined ? {} : { options: [...gate.options] }),
  };
}

function projectAttention(
  presentation: PindiePresentationSnapshot | null,
  semantic: SemanticProjection,
): UiAttentionProjection | null {
  // A temporary Presentation Read Port gap is not evidence that semantic
  // authority is unsafe, and therefore is never Human Attention by itself.
  if (presentation === null) return null;

  if (semantic.authority === "unavailable") {
    return {
      kind: "authority-unavailable",
      reason: semantic.unavailableReason ?? "Pindie semantic authority is unavailable.",
    };
  }

  const gate = presentation.status.state?.task?.humanGate;
  return gate === null || gate === undefined ? null : copyGate(gate);
}

function copyModel(
  model: UiModelProjection | null,
): UiModelProjection | null {
  return model === null ? null : { provider: model.provider, modelId: model.modelId };
}

/** Build a disposable projection from one Session-scoped source snapshot. */
export function createProjection(
  input: PindieUiProjectionInput,
): PindieUiProjection {
  const semantic = semanticProjection(input.presentation);
  const presentationStatus = input.presentation?.status;
  const runtime = input.session.runtime;
  const status: UiStatusProjection = {
    presentationAvailability: input.presentation === null ? "unavailable" : "available",
    isStreaming: runtime.isStreaming,
    isCompacting: runtime.isCompacting,
    isIdle: runtime.isIdle,
    pendingMessageCount: runtime.pendingMessageCount,
    activity: presentationStatus?.activity ?? null,
    consumption: copyConsumption(presentationStatus?.consumption ?? null),
    reasoningMode: presentationStatus?.reasoningMode ?? null,
    taskStatus: semantic.taskStatus,
    verificationStatus: semantic.verificationStatus,
    verificationProgress: semantic.verificationProgress === null
      ? null
      : { ...semantic.verificationProgress },
    hasBlockers: semantic.hasBlockers,
    hasQuestions: semantic.hasQuestions,
    semanticAuthority: semantic.authority,
    stateUnavailableReason: presentationStatus?.stateUnavailableReason ?? null,
    quotaResumeWaiting: input.presentation?.quotaResumeWaiting === null ||
        input.presentation?.quotaResumeWaiting === undefined
      ? null
      : { ...input.presentation.quotaResumeWaiting },
    subscriptionUsage: copySubscriptionUsage(presentationStatus?.subscriptionUsage),
  };

  return {
    header: {
      projectRoot: input.presentation?.projectRoot ?? null,
      displayIdentity: input.session.displayIdentity,
      sessionId: input.session.sessionId,
      model: copyModel(input.session.model),
      thinkingLevel: input.session.thinkingLevel,
      taskStatus: semantic.taskStatus,
      semanticAuthority: semantic.authority,
    },
    status,
    timeline: projectSessionHistory(input.session.branch),
    queue: {
      state: "unknown",
      steering: null,
      followUp: null,
      pendingMessageCount: runtime.pendingMessageCount,
    },
    attention: projectAttention(input.presentation, semantic),
  };
}

/** Alias with the descriptive name used by the future controller. */
export const createPindieUiProjection = createProjection;

function liveAssistantId(state: PindieUiProjection): string {
  return `live:${state.header.sessionId}:${LIVE_ASSISTANT_SUFFIX}`;
}

function withoutLiveAssistant(
  timeline: readonly UiTimelineBlock[],
): readonly UiTimelineBlock[] {
  return timeline.filter((block) =>
    !(block.type === "message" && block.source === "live" && block.role === "assistant")
  );
}

function replaceOrAppendBlock(
  timeline: readonly UiTimelineBlock[],
  next: UiTimelineBlock,
): readonly UiTimelineBlock[] {
  const index = timeline.findIndex((block) => block.type === next.type && block.id === next.id);
  if (index < 0) return [...timeline, next];
  return timeline.map((block, blockIndex) => blockIndex === index ? next : block);
}

function upsertLiveAssistant(
  timeline: readonly UiTimelineBlock[],
  next: UiMessageBlock,
): readonly UiTimelineBlock[] {
  const index = timeline.findIndex((block) =>
    block.type === "message" && block.source === "live" && block.role === "assistant",
  );
  if (index < 0) return [...withoutLiveAssistant(timeline), next];
  return timeline.map((block, blockIndex) => blockIndex === index ? next : block)
    .filter((block, blockIndex) =>
      blockIndex === index || !(block.type === "message" && block.source === "live" && block.role === "assistant"),
    );
}

function reconcilePersistedAssistant(
  timeline: readonly UiTimelineBlock[],
  next: UiMessageBlock,
): readonly UiTimelineBlock[] {
  let replaced = false;
  const reconciled: UiTimelineBlock[] = [];
  for (const block of timeline) {
    const isLiveAssistant = block.type === "message" &&
      block.source === "live" &&
      block.role === "assistant";
    const isSamePersistedBlock = block.type === next.type && block.id === next.id;
    if (isLiveAssistant || isSamePersistedBlock) {
      if (!replaced) {
        reconciled.push(next);
        replaced = true;
      }
      continue;
    }
    reconciled.push(block);
  }
  return replaced ? reconciled : [...reconciled, next];
}

function projectLiveAssistant(
  state: PindieUiProjection,
  message: MessageLike,
  lifecycle: UiMessageBlock["lifecycle"],
): UiMessageBlock {
  const text = messageText(message);
  return {
    type: "message",
    id: liveAssistantId(state),
    source: "live",
    role: "assistant",
    text,
    lifecycle,
    defaultDisplayMode: lifecycle === "complete" ? "full" : "preview",
  };
}

function projectToolResult(
  value: unknown,
  isError: boolean,
): UiToolResultProjection | null {
  if (value === undefined || value === null) return null;
  const source = record(value);
  const contentText = visibleText(source?.content ?? value).trim();
  const details = source && "details" in source
    ? toPlainValue(source.details)
    : null;
  let summary = contentText;
  if (!summary && details !== null) {
    try {
      summary = JSON.stringify(details) ?? "";
    } catch {
      summary = "";
    }
  }
  return {
    isError,
    summary: boundedText(summary),
    details,
  };
}

function projectWorkBlock(
  toolCallId: string,
  toolName: string,
  args: unknown,
  lifecycle: UiWorkBlock["lifecycle"],
  result: UiToolResultProjection | null,
): UiWorkBlock {
  return {
    type: "work",
    id: toolCallId,
    toolCallId,
    toolName,
    lifecycle,
    input: toPlainValue(args),
    result,
    defaultDisplayMode: lifecycle === "failed" ? "full" : lifecycle === "complete" ? "compact" : "preview",
  };
}

function reduceMessageEvent(
  state: PindieUiProjection,
  event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
): PindieUiProjection {
  const message = messageLike(event.message);
  if (message === null || message.role !== "assistant") return state;

  if (
    event.type === "message_end" &&
    (message.stopReason === "aborted" || !messageText(message))
  ) {
    return { ...state, timeline: withoutLiveAssistant(state.timeline) };
  }
  // Thinking-only partials do not create an empty human-facing MessageBlock.
  if (!messageText(message)) return state;

  const lifecycle: UiMessageBlock["lifecycle"] = event.type === "message_end"
    ? message.stopReason === "error" ? "error" : "complete"
    : "streaming";
  const block = projectLiveAssistant(state, message, lifecycle);
  return {
    ...state,
    timeline: upsertLiveAssistant(state.timeline, block),
  };
}

function reduceToolEvent(
  state: PindieUiProjection,
  event: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>,
): PindieUiProjection {
  const lifecycle: UiWorkBlock["lifecycle"] = event.type === "tool_execution_end"
    ? event.isError ? "failed" : "complete"
    : "running";
  const result = event.type === "tool_execution_start"
    ? null
    : projectToolResult(
        event.type === "tool_execution_update" ? event.partialResult : event.result,
        event.type === "tool_execution_end" ? event.isError : false,
      );
  const existing = state.timeline.find((candidate): candidate is UiWorkBlock =>
    candidate.type === "work" && candidate.toolCallId === event.toolCallId,
  );
  const input = event.type === "tool_execution_end"
    ? existing?.input ?? null
    : event.args;
  const block = projectWorkBlock(
    event.toolCallId,
    event.toolName,
    input,
    lifecycle,
    result,
  );
  return { ...state, timeline: replaceOrAppendBlock(state.timeline, block) };
}

function reduceEntryAppended(
  state: PindieUiProjection,
  entry: Extract<AgentSessionEvent, { type: "entry_appended" }>["entry"],
): PindieUiProjection {
  const block = projectSessionEntry(entry);
  const isAssistantEntry = entry.type === "message" &&
    messageLike(entry.message)?.role === "assistant";
  if (block === null) {
    const timeline = isAssistantEntry
      ? withoutLiveAssistant(state.timeline)
      : state.timeline;
    return timeline === state.timeline ? state : { ...state, timeline };
  }
  const timeline = isAssistantEntry
    ? reconcilePersistedAssistant(state.timeline, block)
    : replaceOrAppendBlock(state.timeline, block);
  return { ...state, timeline };
}

function updateRuntimeStatus(
  state: PindieUiProjection,
  patch: Partial<Pick<UiStatusProjection, "isStreaming" | "isCompacting" | "isIdle" | "pendingMessageCount">>,
): PindieUiProjection {
  return { ...state, status: { ...state.status, ...patch } };
}

function reduceRuntimeEvent(
  state: PindieUiProjection,
  event: AgentSessionEvent,
): PindieUiProjection {
  switch (event.type) {
    case "agent_start":
      return updateRuntimeStatus(state, { isStreaming: true, isIdle: false });
    case "agent_end":
      return updateRuntimeStatus(state, {
        isStreaming: event.willRetry,
        isIdle: false,
      });
    case "agent_settled":
      return updateRuntimeStatus(state, {
        isStreaming: false,
        isCompacting: false,
        isIdle: true,
      });
    case "compaction_start":
      return updateRuntimeStatus(state, { isCompacting: true, isIdle: false });
    case "compaction_end":
      return updateRuntimeStatus(state, { isCompacting: false });
    case "auto_retry_start":
      return updateRuntimeStatus(state, { isStreaming: true, isIdle: false });
    default:
      return state;
  }
}

/** Apply one public Pi Session event without owning a Session subscription. */
export function reduceProjectionEvent(
  state: PindieUiProjection,
  event: AgentSessionEvent,
): PindieUiProjection {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return reduceMessageEvent(state, event);

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return reduceToolEvent(state, event);

    case "queue_update": {
      const steering = [...event.steering];
      const followUp = [...event.followUp];
      const pendingMessageCount = steering.length + followUp.length;
      return {
        ...state,
        status: { ...state.status, pendingMessageCount },
        queue: {
          state: "authoritative",
          steering,
          followUp,
          pendingMessageCount,
        },
      };
    }

    case "entry_appended":
      return reduceEntryAppended(state, event.entry);

    default:
      return reduceRuntimeEvent(state, event);
  }
}

/** Rebuilding is the explicit Session epoch boundary; no prior live state is retained. */
export const rebuildProjection = createProjection;
