import type {
  AgentSession,
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  classifyToolPresentation,
  createObservationBlock,
  createObservationItem,
  createToolWorkBlock,
  projectToolResult,
  readToolCall,
  readToolResultMessage,
  refreshToolWorkBlock,
  toPlainValue,
  visibleText,
  type UiDisplayMode,
  type UiObservationItem,
  type UiObservationWorkBlock,
  type UiPlainValue,
  type UiToolPresentationKind,
  type UiToolResultProjection,
  type UiToolWorkBlock,
  type UiWorkBlock,
  type UiWorkLifecycle,
} from "./ui-timeline.ts";
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
export type { UiDisplayMode, UiPlainValue } from "./ui-timeline.ts";
export type {
  UiObservationItem,
  UiObservationWorkBlock,
  UiToolPresentationKind,
  UiToolResultProjection,
  UiToolWorkBlock,
  UiWorkBlock,
  UiWorkLifecycle,
} from "./ui-timeline.ts";
export { classifyToolPresentation, isSemanticPresentationTool } from "./ui-timeline.ts";

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

export type UiUserDelivery = "prompt" | "steer" | "followUp";

export interface UiMessageBlock {
  readonly type: "message";
  /** Persisted entry IDs or a session-local `live:...` ephemeral ID. */
  readonly id: string;
  readonly source: "session" | "live";
  readonly role: "user" | "assistant" | "custom";
  readonly text: string;
  readonly lifecycle: "streaming" | "complete" | "error";
  readonly defaultDisplayMode: UiDisplayMode;
  /** Local delivery provenance for ephemeral user input echoes. */
  readonly delivery?: UiUserDelivery;
  readonly customType?: string;
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

interface LiveAssistantProjectionState {
  /** The only live assistant that message_update/message_end may mutate. */
  readonly activeId: string | null;
  /** The next sequence is disposable and scoped to this Projection instance. */
  readonly nextSequence: number;
}

interface WorkTimelineReducerState {
  /** Null means a boundary closed the current observation burst. */
  readonly observationBurstId: string | null;
}

export interface PindieUiProjection {
  readonly header: UiHeaderProjection;
  readonly status: UiStatusProjection;
  readonly timeline: readonly UiTimelineBlock[];
  readonly queue: UiQueueProjection;
  readonly attention: UiAttentionProjection | null;
  /** Reducer-only metadata; views and persistence must ignore this field. */
  readonly liveAssistant: LiveAssistantProjectionState;
  /** Reducer-only grouping metadata; views and persistence must ignore this field. */
  readonly workTimeline: WorkTimelineReducerState;
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

interface TimelineBuildState {
  readonly timeline: readonly UiTimelineBlock[];
  readonly observationBurstId: string | null;
  readonly results: ReadonlyMap<string, UiToolResultProjection>;
}

function emptyTimelineBuildState(): TimelineBuildState {
  return { timeline: [], observationBurstId: null, results: new Map() };
}

function closeObservationBurst(state: TimelineBuildState): TimelineBuildState {
  return state.observationBurstId === null
    ? state
    : { ...state, observationBurstId: null };
}

function replaceTimelineBlock(
  timeline: readonly UiTimelineBlock[],
  index: number,
  block: UiTimelineBlock,
): readonly UiTimelineBlock[] {
  return timeline.map((candidate, candidateIndex) =>
    candidateIndex === index ? block : candidate);
}

function workBlockIndex(
  timeline: readonly UiTimelineBlock[],
  toolCallId: string,
): number {
  return timeline.findIndex((candidate) =>
    candidate.type === "work" && (
      candidate.kind === "observation"
        ? candidate.items.some((item) => item.toolCallId === toolCallId)
        : candidate.toolCallId === toolCallId
    ));
}

function observationItemIndex(
  block: UiObservationWorkBlock,
  toolCallId: string,
): number {
  return block.items.findIndex((item) => item.toolCallId === toolCallId);
}

function incompleteResult(): UiToolResultProjection {
  return {
    isError: true,
    summary: "Tool result was not persisted; work may have been interrupted.",
    details: null,
  };
}

function updateObservationBlock(
  block: UiObservationWorkBlock,
  toolCallId: string,
  lifecycle: UiWorkLifecycle,
  result: UiToolResultProjection | null,
  input?: UiPlainValue | null,
  toolName?: string,
): UiObservationWorkBlock {
  const itemIndex = observationItemIndex(block, toolCallId);
  if (itemIndex < 0) return block;
  const current = block.items[itemIndex];
  const nextItem: UiObservationItem = {
    ...current,
    ...(input === undefined ? {} : { input }),
    ...(toolName === undefined ? {} : { toolName }),
    lifecycle,
    result: result ?? current.result,
  };
  const items = block.items.map((item, index) => index === itemIndex ? nextItem : item);
  return createObservationBlock(block.items[0]?.toolCallId ?? toolCallId, items);
}

function appendObservationItem(
  state: TimelineBuildState,
  call: ReturnType<typeof readToolCall>,
  lifecycle: UiWorkLifecycle,
  result: UiToolResultProjection | null,
): TimelineBuildState {
  if (call === null) return closeObservationBurst(state);
  const existingIndex = workBlockIndex(state.timeline, call.id);
  if (existingIndex >= 0) {
    const existing = state.timeline[existingIndex];
    if (existing?.type !== "work") return state;
    if (existing.kind !== "observation") return state;
    const next = updateObservationBlock(
      existing,
      call.id,
      lifecycle,
      result,
      toPlainValue(call.arguments),
      call.name,
    );
    const open = next.lifecycle === "failed" ? null : state.observationBurstId;
    return {
      ...state,
      timeline: replaceTimelineBlock(state.timeline, existingIndex, next),
      observationBurstId: open,
    };
  }

  const item = createObservationItem(call, lifecycle, result);
  const currentIndex = state.observationBurstId === null
    ? -1
    : state.timeline.findIndex((candidate) =>
      candidate.type === "work" && candidate.kind === "observation" &&
      candidate.id === state.observationBurstId);
  const current = currentIndex < 0 ? undefined : state.timeline[currentIndex];
  if (current?.type === "work" && current.kind === "observation" &&
      current.lifecycle !== "failed") {
    const next = createObservationBlock(current.items[0]?.toolCallId ?? call.id, [
      ...current.items,
      item,
    ]);
    return {
      ...state,
      timeline: replaceTimelineBlock(state.timeline, currentIndex, next),
      observationBurstId: next.lifecycle === "failed" ? null : next.id,
    };
  }

  const next = createObservationBlock(call.id, [item]);
  return {
    ...state,
    timeline: [...state.timeline, next],
    observationBurstId: next.lifecycle === "failed" ? null : next.id,
  };
}

function appendToolCallToTimeline(
  state: TimelineBuildState,
  call: ReturnType<typeof readToolCall>,
): TimelineBuildState {
  if (call === null) return closeObservationBurst(state);
  const kind = classifyToolPresentation(call.name);
  const recordedResult = state.results.get(call.id);
  const lifecycle: UiWorkLifecycle = recordedResult === undefined
    ? "running"
    : recordedResult.isError ? "failed" : "complete";
  if (kind === "semantic") return closeObservationBurst(state);
  if (kind === "observation") {
    return appendObservationItem(state, call, lifecycle, recordedResult ?? null);
  }

  const existingIndex = workBlockIndex(state.timeline, call.id);
  if (existingIndex >= 0) {
    const existing = state.timeline[existingIndex];
    if (existing?.type === "work" && existing.kind === "observation") {
      const next = updateObservationBlock(
        existing,
        call.id,
        existing.items[observationItemIndex(existing, call.id)]?.lifecycle ?? lifecycle,
        existing.items[observationItemIndex(existing, call.id)]?.result ?? recordedResult ?? null,
        toPlainValue(call.arguments),
        call.name,
      );
      return {
        ...state,
        timeline: replaceTimelineBlock(state.timeline, existingIndex, next),
        observationBurstId: next.lifecycle === "failed" ? null : state.observationBurstId,
      };
    }
    if (existing?.type === "work") {
      const next = refreshToolWorkBlock(
        existing,
        call.name,
        existing.input ?? toPlainValue(call.arguments),
        existing.lifecycle,
        existing.result ?? recordedResult ?? null,
      );
      return {
        ...closeObservationBurst(state),
        timeline: replaceTimelineBlock(state.timeline, existingIndex, next),
      };
    }
    return closeObservationBurst(state);
  }
  const block = createToolWorkBlock(call, lifecycle, recordedResult ?? null);
  if (block === null) return closeObservationBurst(state);
  return {
    ...closeObservationBurst(state),
    timeline: [...state.timeline, block],
  };
}

function applyToolResultToTimeline(
  state: TimelineBuildState,
  resultMessage: ReturnType<typeof readToolResultMessage>,
): TimelineBuildState {
  if (resultMessage === null) return state;
  const result = projectToolResult(
    { content: resultMessage.content, details: resultMessage.details },
    resultMessage.isError,
    resultMessage.toolName,
  );
  const results = new Map(state.results);
  if (result !== null) results.set(resultMessage.toolCallId, result);
  const lifecycle: UiWorkLifecycle = resultMessage.isError ? "failed" : "complete";
  const existingIndex = workBlockIndex(state.timeline, resultMessage.toolCallId);
  if (existingIndex >= 0) {
    const existing = state.timeline[existingIndex];
    if (existing?.type === "work" && existing.kind === "observation") {
      const next = updateObservationBlock(
        existing,
        resultMessage.toolCallId,
        lifecycle,
        result,
      );
      return {
        ...state,
        results,
        timeline: replaceTimelineBlock(state.timeline, existingIndex, next),
        observationBurstId: resultMessage.isError && state.observationBurstId === next.id
          ? null
          : state.observationBurstId,
      };
    }
    if (existing?.type === "work") {
      const next = refreshToolWorkBlock(
        existing,
        resultMessage.toolName,
        existing.input,
        lifecycle,
        result,
      );
      return {
        ...state,
        results,
        timeline: replaceTimelineBlock(state.timeline, existingIndex, next),
        observationBurstId: null,
      };
    }
  }

  const call = {
    id: resultMessage.toolCallId,
    name: resultMessage.toolName,
    arguments: null,
  };
  if (classifyToolPresentation(call.name) === "semantic") {
    return { ...closeObservationBurst(state), results };
  }
  if (classifyToolPresentation(call.name) === "observation") {
    const next = appendObservationItem(
      { ...state, results },
      call,
      lifecycle,
      result,
    );
    return {
      ...next,
      observationBurstId: resultMessage.isError ? null : next.observationBurstId,
    };
  }
  const block = createToolWorkBlock(call, lifecycle, result);
  return block === null
    ? { ...closeObservationBurst(state), results }
    : { ...closeObservationBurst(state), results, timeline: [...state.timeline, block] };
}

function assistantContentParts(
  message: MessageLike,
): readonly ({ readonly kind: "text"; readonly text: string } | {
  readonly kind: "tool";
  readonly call: NonNullable<ReturnType<typeof readToolCall>>;
})[] {
  if (!Array.isArray(message.content)) {
    const text = visibleText(message.content);
    return text.length === 0 ? [] : [{ kind: "text", text }];
  }
  const parts: Array<
    { readonly kind: "text"; readonly text: string } | {
      readonly kind: "tool";
      readonly call: NonNullable<ReturnType<typeof readToolCall>>;
    }
  > = [];
  for (const part of message.content) {
    const call = readToolCall(part);
    if (call !== null) {
      parts.push({ kind: "tool", call });
      continue;
    }
    const source = record(part);
    if (source?.type === "text" && typeof source.text === "string" && source.text.length > 0) {
      parts.push({ kind: "text", text: source.text });
    }
  }
  return parts;
}

function appendPersistedMessage(
  state: TimelineBuildState,
  id: string,
  message: MessageLike,
  customType?: string,
): TimelineBuildState {
  const parts = message.role === "assistant"
    ? assistantContentParts(message)
    : messageText(message).length === 0
      ? []
      : [{ kind: "text" as const, text: messageText(message) }];
  let next = state;
  let textSequence = 0;
  for (const part of parts) {
    if (part.kind === "tool") {
      next = appendToolCallToTimeline(next, part.call);
      continue;
    }
    const textBlock = projectMessage(
      textSequence === 0 ? id : `${id}:text:${textSequence}`,
      { ...message, content: part.text },
      "session",
      { customType },
    );
    textSequence += 1;
    if (textBlock === null) continue;
    next = {
      ...closeObservationBurst(next),
      timeline: [...next.timeline, textBlock],
    };
  }
  return next;
}

function finalizeHistoricalWork(state: TimelineBuildState): readonly UiTimelineBlock[] {
  return state.timeline.map((block) => {
    if (block.type !== "work") return block;
    if (block.kind === "observation") {
      const items = block.items.map((item) => item.lifecycle === "running"
        ? { ...item, lifecycle: "failed" as const, result: item.result ?? incompleteResult() }
        : item);
      return items.some((item, index) => item !== block.items[index])
        ? createObservationBlock(block.items[0]?.toolCallId ?? block.id, items)
        : block;
    }
    return block.lifecycle === "running"
      ? refreshToolWorkBlock(block, block.toolName, block.input, "failed", block.result ?? incompleteResult())
      : block;
  });
}

/** Rebuild human-meaningful work from the authoritative ordered Session branch. */
export function projectSessionHistory(
  entries: readonly SessionEntry[],
): readonly UiTimelineBlock[] {
  let state = emptyTimelineBuildState();
  for (const entry of entries) {
    if (!entry.id) continue;
    if (entry.type === "message") {
      const message = messageLike(entry.message);
      if (message === null) continue;
      const toolResult = readToolResultMessage(message);
      if (toolResult !== null) {
        state = applyToolResultToTimeline(state, toolResult);
        continue;
      }
      if (message.role === "assistant") {
        state = appendPersistedMessage(state, entry.id, message);
        continue;
      }
      const block = projectSessionEntry(entry);
      if (block === null) continue;
      state = {
        ...closeObservationBurst(state),
        timeline: [...state.timeline, block],
      };
      continue;
    }
    if (entry.type === "custom_message") {
      const block = projectSessionEntry(entry);
      if (block === null) continue;
      state = {
        ...closeObservationBurst(state),
        timeline: [...state.timeline, block],
      };
    }
  }
  return finalizeHistoricalWork(state);
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
    liveAssistant: {
      activeId: null,
      nextSequence: 1,
    },
    workTimeline: {
      // A rebuild is a strict observation boundary. Live calls after resume
      // start a fresh burst even if the persisted tail ended with a read.
      observationBurstId: null,
    },
  };
}

/** Alias with the descriptive name used by the future controller. */
export const createPindieUiProjection = createProjection;

function liveAssistantId(sessionId: string, sequence: number): string {
  return `live:${sessionId}:assistant:${sequence}`;
}

function isLiveAssistant(block: UiTimelineBlock): block is UiMessageBlock {
  return block.type === "message" && block.source === "live" && block.role === "assistant";
}

function findLiveAssistantIndex(
  timeline: readonly UiTimelineBlock[],
  id: string,
): number {
  return timeline.findIndex((block) => isLiveAssistant(block) && block.id === id);
}

function findLatestLiveAssistantIndex(
  timeline: readonly UiTimelineBlock[],
  text?: string,
): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const block = timeline[index];
    if (isLiveAssistant(block) && (text === undefined || block.text === text)) {
      return index;
    }
  }
  return -1;
}

function isLiveUser(block: UiTimelineBlock): block is UiMessageBlock {
  return block.type === "message" && block.source === "live" && block.role === "user";
}

function findLatestLiveUserIndex(
  timeline: readonly UiTimelineBlock[],
  text: string,
): number {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const block = timeline[index];
    if (isLiveUser(block) && block.text === text) return index;
  }
  return -1;
}

function beginLiveAssistant(
  state: PindieUiProjection,
): { readonly state: PindieUiProjection; readonly id: string } {
  const sequence = state.liveAssistant.nextSequence;
  const id = liveAssistantId(state.header.sessionId, sequence);
  return {
    id,
    state: {
      ...state,
      liveAssistant: {
        activeId: id,
        nextSequence: sequence + 1,
      },
    },
  };
}

function clearActiveLiveAssistant(state: PindieUiProjection): PindieUiProjection {
  if (state.liveAssistant.activeId === null) return state;
  return {
    ...state,
    liveAssistant: {
      ...state.liveAssistant,
      activeId: null,
    },
  };
}

function removeLiveAssistant(
  timeline: readonly UiTimelineBlock[],
  id: string,
): readonly UiTimelineBlock[] {
  const index = findLiveAssistantIndex(timeline, id);
  return index < 0
    ? timeline
    : timeline.filter((_block, blockIndex) => blockIndex !== index);
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
  const index = findLiveAssistantIndex(timeline, next.id);
  if (index < 0) return [...timeline, next];
  return timeline.map((block, blockIndex) => blockIndex === index ? next : block);
}

interface PersistedAssistantReconciliation {
  readonly timeline: readonly UiTimelineBlock[];
  readonly replacedLiveId: string | null;
}

function reconcilePersistedUser(
  timeline: readonly UiTimelineBlock[],
  next: UiMessageBlock,
): readonly UiTimelineBlock[] {
  const candidateIndex = findLatestLiveUserIndex(timeline, next.text);
  const candidate = candidateIndex < 0 ? undefined : timeline[candidateIndex];
  const replacement: UiMessageBlock = candidate !== undefined && isLiveUser(candidate) &&
      candidate.delivery !== undefined
    ? { ...next, delivery: candidate.delivery }
    : next;
  const reconciled: UiTimelineBlock[] = [];
  let inserted = false;

  for (let index = 0; index < timeline.length; index += 1) {
    const block = timeline[index];
    const isCandidate = index === candidateIndex;
    const isSamePersistedBlock = block.type === "message" &&
      block.source === "session" &&
      block.id === next.id;
    if (isCandidate || isSamePersistedBlock) {
      if (!inserted) {
        reconciled.push(replacement);
        inserted = true;
      }
      continue;
    }
    reconciled.push(block);
  }

  return inserted ? reconciled : [...reconciled, replacement];
}

function reconcilePersistedAssistant(
  timeline: readonly UiTimelineBlock[],
  next: UiMessageBlock,
): PersistedAssistantReconciliation {
  // Prefer an exact final-text match. If Pi's entry text differs, the
  // current-most recent live assistant is the bounded v0.1 fallback.
  const matchingIndex = next.text === ""
    ? -1
    : findLatestLiveAssistantIndex(timeline, next.text);
  const candidateIndex = matchingIndex >= 0
    ? matchingIndex
    : findLatestLiveAssistantIndex(timeline);
  const candidate = candidateIndex < 0 ? undefined : timeline[candidateIndex];
  const replacedLiveId = candidate !== undefined && isLiveAssistant(candidate)
    ? candidate.id
    : null;
  const reconciled: UiTimelineBlock[] = [];
  let inserted = false;

  for (let index = 0; index < timeline.length; index += 1) {
    const block = timeline[index];
    const isCandidate = index === candidateIndex;
    const isSamePersistedBlock = block.type === "message" &&
      block.source === "session" &&
      block.id === next.id;
    if (isCandidate || isSamePersistedBlock) {
      if (!inserted) {
        reconciled.push(next);
        inserted = true;
      }
      continue;
    }
    reconciled.push(block);
  }

  if (!inserted) reconciled.push(next);
  return { timeline: reconciled, replacedLiveId };
}

function removeCurrentOrLatestLiveAssistant(
  state: PindieUiProjection,
): PindieUiProjection {
  const activeId = state.liveAssistant.activeId;
  const index = activeId === null
    ? findLatestLiveAssistantIndex(state.timeline)
    : findLiveAssistantIndex(state.timeline, activeId);

  // A current invisible/empty assistant has no block to remove; do not use an
  // older finalized block as a substitute when an active identity is known.
  if (index < 0) return activeId === null ? state : clearActiveLiveAssistant(state);

  const block = state.timeline[index];
  const nextState: PindieUiProjection = {
    ...state,
    timeline: state.timeline.filter((_candidate, blockIndex) => blockIndex !== index),
  };
  return isLiveAssistant(block) && block.id === activeId
    ? clearActiveLiveAssistant(nextState)
    : nextState;
}

function projectLiveAssistant(
  id: string,
  message: MessageLike,
  lifecycle: UiMessageBlock["lifecycle"],
): UiMessageBlock {
  const text = messageText(message);
  return {
    type: "message",
    id,
    source: "live",
    role: "assistant",
    text,
    lifecycle,
    defaultDisplayMode: lifecycle === "complete" ? "full" : "preview",
  };
}

function reduceMessageEvent(
  state: PindieUiProjection,
  event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" | "message_end" }>,
): PindieUiProjection {
  const message = messageLike(event.message);
  if (message === null || message.role !== "assistant") return state;
  const text = messageText(message);

  if (event.type === "message_start") {
    const started = beginLiveAssistant(state);
    // Thinking-only starts still establish the message-scoped identity. The
    // first visible update will append its block with this same identity.
    if (!text) return started.state;
    return {
      ...started.state,
      workTimeline: { observationBurstId: null },
      timeline: upsertLiveAssistant(
        started.state.timeline,
        projectLiveAssistant(started.id, message, "streaming"),
      ),
    };
  }

  const active = state.liveAssistant.activeId === null
    ? beginLiveAssistant(state)
    : { state, id: state.liveAssistant.activeId };
  const activeId = active.id;
  const activeState = text
    ? { ...active.state, workTimeline: { observationBurstId: null } }
    : active.state;

  if (event.type === "message_end" && message.stopReason === "aborted") {
    return clearActiveLiveAssistant({
      ...activeState,
      timeline: removeLiveAssistant(activeState.timeline, activeId),
    });
  }

  const lifecycle: UiMessageBlock["lifecycle"] = event.type === "message_end"
    ? message.stopReason === "error" ? "error" : "complete"
    : "streaming";
  const activeIndex = findLiveAssistantIndex(activeState.timeline, activeId);

  // Thinking-only partials do not create an empty human-facing MessageBlock.
  // A normal/error end still finalizes any visible text already received.
  if (!text) {
    if (event.type !== "message_end" || activeIndex < 0) {
      return event.type === "message_end" ? clearActiveLiveAssistant(activeState) : activeState;
    }
    const existing = activeState.timeline[activeIndex];
    if (!isLiveAssistant(existing)) return clearActiveLiveAssistant(activeState);
    const finalized: UiMessageBlock = {
      ...existing,
      lifecycle,
      defaultDisplayMode: lifecycle === "error" ? "preview" : "full",
    };
    return clearActiveLiveAssistant({
      ...activeState,
      timeline: activeState.timeline.map((block, blockIndex) =>
        blockIndex === activeIndex ? finalized : block),
    });
  }

  const updated: PindieUiProjection = {
    ...activeState,
    timeline: upsertLiveAssistant(
      activeState.timeline,
      projectLiveAssistant(activeId, message, lifecycle),
    ),
  };
  return event.type === "message_end" ? clearActiveLiveAssistant(updated) : updated;
}

function reduceToolEvent(
  state: PindieUiProjection,
  event: Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>,
): PindieUiProjection {
  const eventArguments = event.type === "tool_execution_end" ? undefined : event.args;
  const call = readToolCall({
    type: "toolCall",
    id: event.toolCallId,
    name: event.toolName,
    arguments: eventArguments,
  });
  if (call === null) return state;

  const lifecycle: UiWorkLifecycle = event.type === "tool_execution_end"
    ? event.isError ? "failed" : "complete"
    : "running";
  const result = event.type === "tool_execution_start"
    ? null
    : projectToolResult(
        event.type === "tool_execution_update" ? event.partialResult : event.result,
        event.type === "tool_execution_end" ? event.isError : false,
        event.toolName,
      );
  const kind = classifyToolPresentation(event.toolName);
  const buildState: TimelineBuildState = {
    timeline: state.timeline,
    observationBurstId: state.workTimeline.observationBurstId,
    results: new Map(),
  };

  // Semantic Pindie tools are deliberately reserved for E2. They still close
  // an observation burst so a later read cannot visually cross the boundary.
  if (kind === "semantic") {
    return {
      ...state,
      workTimeline: { observationBurstId: null },
    };
  }

  if (kind === "observation") {
    const next = appendObservationItem(buildState, call, lifecycle, result);
    return {
      ...state,
      timeline: next.timeline,
      workTimeline: { observationBurstId: next.observationBurstId },
    };
  }

  const existingIndex = workBlockIndex(state.timeline, event.toolCallId);
  const existing = existingIndex < 0 ? undefined : state.timeline[existingIndex];
  const input = event.type === "tool_execution_end" && existing?.type === "work" &&
      existing.kind !== "observation"
    ? existing.input
    : toPlainValue(eventArguments);
  const nextResult = result ?? (
    existing?.type === "work" && existing.kind !== "observation" ? existing.result : null
  );
  const nextBlock = existing?.type === "work" && existing.kind !== "observation"
    ? refreshToolWorkBlock(existing, event.toolName, input, lifecycle, nextResult)
    : createToolWorkBlock(call, lifecycle, nextResult);
  if (nextBlock === null) return { ...state, workTimeline: { observationBurstId: null } };
  const closed = closeObservationBurst(buildState);
  return {
    ...state,
    timeline: existingIndex < 0
      ? [...closed.timeline, nextBlock]
      : replaceTimelineBlock(closed.timeline, existingIndex, nextBlock),
    workTimeline: { observationBurstId: null },
  };
}

function reduceEntryAppended(
  state: PindieUiProjection,
  entry: Extract<AgentSessionEvent, { type: "entry_appended" }>["entry"],
): PindieUiProjection {
  if (entry.type === "message") {
    const message = messageLike(entry.message);
    if (message === null) return state;

    const toolResult = readToolResultMessage(message);
    if (toolResult !== null) {
      const next = applyToolResultToTimeline({
        timeline: state.timeline,
        observationBurstId: state.workTimeline.observationBurstId,
        results: new Map(),
      }, toolResult);
      return {
        ...state,
        timeline: next.timeline,
        workTimeline: { observationBurstId: next.observationBurstId },
      };
    }

    if (message.role === "assistant") {
      const parts = assistantContentParts(message);
      let nextState = state;
      let visibleMessageCount = 0;
      let toolCallCount = 0;
      let textSequence = 0;
      for (const part of parts) {
        if (part.kind === "tool") {
          toolCallCount += 1;
          const next = appendToolCallToTimeline({
            timeline: nextState.timeline,
            observationBurstId: nextState.workTimeline.observationBurstId,
            results: new Map(),
          }, part.call);
          nextState = {
            ...nextState,
            timeline: next.timeline,
            workTimeline: { observationBurstId: next.observationBurstId },
          };
          continue;
        }

        const block = projectMessage(
          textSequence === 0 ? entry.id : `${entry.id}:text:${textSequence}`,
          { ...message, content: part.text },
          "session",
        );
        textSequence += 1;
        if (block === null) continue;
        visibleMessageCount += 1;
        const reconciliation = reconcilePersistedAssistant(nextState.timeline, block);
        const liveAssistant = reconciliation.replacedLiveId === nextState.liveAssistant.activeId
          ? { ...nextState.liveAssistant, activeId: null }
          : nextState.liveAssistant;
        nextState = {
          ...nextState,
          timeline: reconciliation.timeline,
          liveAssistant,
          workTimeline: { observationBurstId: null },
        };
      }

      if (visibleMessageCount === 0 && toolCallCount === 0) {
        return removeCurrentOrLatestLiveAssistant(state);
      }
      return nextState;
    }

    const block = projectSessionEntry(entry);
    if (block === null) return state;
    const timeline = block.role === "user"
      ? reconcilePersistedUser(state.timeline, block)
      : replaceOrAppendBlock(state.timeline, block);
    return {
      ...state,
      timeline,
      workTimeline: { observationBurstId: null },
    };
  }

  if (entry.type === "custom_message") {
    const block = projectSessionEntry(entry);
    if (block === null) return state;
    return {
      ...state,
      timeline: replaceOrAppendBlock(state.timeline, block),
      workTimeline: { observationBurstId: null },
    };
  }

  return state;
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

/**
 * Append an immediate local echo for a user delivery.
 *
 * Pi does not expose a convenient authoritative entry event for every normal
 * submission, so the interactive client may project this disposable block
 * until the next authoritative Session rebuild. The caller owns the
 * session-local monotonic ID; this helper owns only the block shape.
 */
export function appendUserDelivery(
  projection: PindieUiProjection,
  input: {
    readonly id: string;
    readonly text: string;
    readonly delivery: UiUserDelivery;
  },
): PindieUiProjection {
  return {
    ...projection,
    workTimeline: { observationBurstId: null },
    timeline: [
      ...projection.timeline,
      {
        type: "message",
        id: input.id,
        source: "live",
        role: "user",
        text: input.text,
        lifecycle: "complete",
        defaultDisplayMode: "full",
        delivery: input.delivery,
      },
    ],
  };
}

/**
 * Refresh current Session-bound facts without rebuilding live Timeline state.
 *
 * A Session identity change is an epoch boundary and therefore performs a full
 * rebuild. Within one Session, the current header/status/attention facts are
 * disposable presentation data; live blocks and an authoritative queue
 * observation remain owned by the existing projection.
 */
export function refreshProjectionFacts(
  current: PindieUiProjection,
  input: PindieUiProjectionInput,
): PindieUiProjection {
  if (current.header.sessionId !== input.session.sessionId) {
    return createProjection(input);
  }

  const fresh = createProjection(input);
  return {
    ...current,
    header: fresh.header,
    status: fresh.status,
    attention: fresh.attention,
    queue: current.queue.state === "authoritative"
      ? current.queue
      : {
          ...current.queue,
          pendingMessageCount: fresh.queue.pendingMessageCount,
        },
  };
}

/** Rebuilding is the explicit Session epoch boundary; no prior live state is retained. */
export const rebuildProjection = createProjection;
