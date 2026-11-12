import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import { classifyHumanSignal } from "./human-signal.ts";
import { PINDIE_QUOTA_RESUME_TYPE } from "./quota-resume-supervisor.ts";
import {
  quotaResumePhase,
  type QuotaResumeWaitingStatus,
} from "./quota-resume-control.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import type {
  PindiePresentationReader,
  PindiePresentationSnapshot,
} from "./presentation-integration.ts";
import {
  appendUserDelivery,
  rebuildProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjection,
  type PindieUiProjectionFactsInput,
  type PindieUiProjectionInput,
  type UiMessageBlock,
  type UiTimelineBlock,
} from "./ui-projection.ts";

export interface PindieControlPresentationLease {
  current(): PindiePresentationReader | null;
}

export interface PindieControlHumanGate {
  readonly key: string;
  readonly kind: "decision" | "approval" | "input";
  readonly question: string;
  readonly options?: readonly string[];
}

export interface PindieControlSnapshot {
  readonly lease: string;
  readonly revision: number;
  readonly project: {
    readonly root: string | null;
  };
  readonly session: {
    readonly id: string;
    readonly displayIdentity: string;
  };
  readonly runtime: {
    readonly idle: boolean;
    readonly streaming: boolean;
    readonly compacting: boolean;
    readonly pendingMessageCount: number;
    readonly automaticWorkSettled: boolean;
    readonly activity: PindieUiProjection["status"]["activity"];
  };
  /** Bounded runtime-only dispatches, oldest first; empty after a Session epoch change. */
  readonly dispatches: readonly PindieControlDispatch[];
  readonly semantic: {
    readonly authority: PindieUiProjection["status"]["semanticAuthority"];
    readonly taskStatus: PindieUiProjection["status"]["taskStatus"];
    readonly taskGoal: string | null;
    readonly blockers: readonly string[];
    readonly questions: readonly string[];
    readonly verificationStatus: PindieUiProjection["status"]["verificationStatus"];
    readonly verificationProgress: PindieUiProjection["status"]["verificationProgress"];
    readonly humanGate: PindieControlHumanGate | null;
    readonly unavailableReason: string | null;
  };
  readonly executionConfig: {
    readonly model: PindieUiProjection["header"]["model"];
    readonly thinkingLevel: AgentSession["thinkingLevel"];
    readonly reasoningMode: PindieUiProjection["status"]["reasoningMode"];
  };
  readonly recovery: {
    readonly quotaWaiting: PindiePresentationSnapshot["quotaResumeWaiting"];
  };
  /** Latest visible assistant text or successful semantic Task completion, in timeline order. */
  readonly latestAssistant: (
    | { readonly entryId: string; readonly text: string; readonly lifecycle: "streaming" | "complete" | "error"; readonly errorMessage?: string; readonly source: "assistant" }
    | { readonly entryId: string; readonly text: string; readonly lifecycle: "complete"; readonly source: "task_completion" }
  ) | null;
}

export interface PindieControlClientOptions {
  readonly createLease?: () => string;
  /** Headless client binding; Pi emits session_start when this completes. */
  readonly bindActiveSession?: () => Promise<void>;
}

export type PindieControlErrorCode =
  | "invalid_request"
  | "stale_control_lease"
  | "semantic_unavailable"
  | "human_gate_required"
  | "human_gate_mismatch"
  | "unsafe_runtime_state"
  | "model_unavailable"
  | "delivery_failed"
  | "delivery_uncertain"
  | "session_not_found"
  | "session_ambiguous"
  | "session_switch_unsafe"
  | "session_switch_failed"
  | "dispatch_backlog_full";

export class PindieControlError extends Error {
  readonly code: PindieControlErrorCode;
  readonly snapshot: PindieControlSnapshot | null;
  readonly receipt?: {
    readonly dispatchId: string;
    readonly delivery: PindieControlDelivery;
    readonly nextAction: "wait_observe_do_not_resend";
  };

  constructor(
    code: PindieControlErrorCode,
    message: string,
    snapshot: PindieControlSnapshot | null = null,
    receipt?: {
      readonly dispatchId: string;
      readonly delivery: PindieControlDelivery;
      readonly nextAction: "wait_observe_do_not_resend";
    },
  ) {
    super(message);
    this.name = "PindieControlError";
    this.code = code;
    this.snapshot = snapshot;
    this.receipt = receipt;
  }
}

export type PindieControlInputTiming = "now" | "after_current_run";
export type PindieControlDelivery = "prompt" | "steer" | "followUp";

export interface PindieControlDeliveryResult {
  readonly delivery: PindieControlDelivery;
  readonly snapshot: PindieControlSnapshot;
}

/**
 * Runtime-only dispatch correlation: one accepted Control input, the native Pi
 * Run that consumed it, and that Run's recorded assistant output entry IDs.
 * Nothing here is persisted; a Session epoch discards the ledger.
 */
export type PindieControlDispatchState =
  | "accepted"
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "error"
  | "cancelled"
  | "no_result";

export interface PindieControlDispatch {
  readonly dispatchId: string;
  readonly delivery: PindieControlDelivery;
  readonly state: PindieControlDispatchState;
  /** First Run that executed this dispatch, or null while Pi has not started one. */
  readonly runId: string | null;
  /** Every Run of this logical dispatch in order; a terminal error may be resumed as a successor Run. */
  readonly runIds: readonly string[];
  readonly acceptedRevision: number;
  readonly output: {
    readonly entryIds: readonly string[];
    readonly lifecycle: "complete" | "error" | null;
    readonly errorMessage?: string;
  } | null;
}

export interface PindieControlInputResult extends PindieControlDeliveryResult {
  readonly dispatch: PindieControlDispatch;
}

export interface PindieControlStopResult {
  readonly stopped: boolean;
  readonly cleared: {
    readonly steering: number;
    readonly followUp: number;
  };
  readonly snapshot: PindieControlSnapshot;
}

export interface PindieControlFreshSessionResult {
  readonly cancelled: boolean;
  readonly snapshot: PindieControlSnapshot;
}

export interface PindieControlSessionChoice {
  readonly id: string;
  readonly name: string | null;
  readonly created: string;
  readonly modified: string;
  readonly messageCount: number;
  readonly firstMessagePreview: string;
  readonly current: boolean;
}

export interface PindieControlSessionPage {
  readonly activeSessionId: string;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly sessions: readonly PindieControlSessionChoice[];
}

export interface PindieControlSwitchSessionResult {
  readonly cancelled: boolean;
  readonly snapshot: PindieControlSnapshot;
}

export type PindieControlWaitUntil = "meaningful_change" | "settled" | "human_gate";
export type PindieControlWaitReason = "changed" | "settled" | "human_gate" | "timeout" | "binding_changed";

export interface PindieControlWaitResult {
  readonly reason: PindieControlWaitReason;
  readonly snapshot: PindieControlSnapshot | null;
}

export interface PindieControlConfigureRequest {
  readonly lease: string;
  readonly model?: {
    readonly provider: string;
    readonly modelId: string;
  };
  readonly thinkingLevel?: AgentSession["thinkingLevel"];
}

interface ControlBinding {
  readonly generation: number;
  readonly sessionId: string;
  readonly lease: string;
  readonly unsubscribe: () => void;
}

interface ControlWaiter {
  readonly binding: ControlBinding;
  readonly until: PindieControlWaitUntil;
  readonly afterRevision?: number;
  readonly resolve: (result: PindieControlWaitResult) => void;
  readonly releasePins: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DispatchRecord {
  readonly dispatchId: string;
  readonly delivery: PindieControlDelivery;
  /** Same string reference as the projected delivery text; never re-serialized. */
  readonly text: string;
  readonly acceptedRevision: number;
  /** Runs that executed this logical dispatch, in order (first consumes the input). */
  runIds: string[];
  /** Input Pi never consumed: unattached at settlement, or still queued then. */
  discardedBeforeConsumption: boolean;
  /** Factual native execution rejection; no provider prose retained. */
  executionRejected?: boolean;
  executionPending?: boolean;
  /** Native preflight/queue acknowledgement; matching queue text alone proves no acceptance. */
  deliveryConfirmed: boolean;
  /**
   * A reported quota wait keeps a failed dispatch from being pruned. It never
   * authorizes successor association by itself.
   */
  awaitingQuotaRecovery: boolean;
  /** Waiters pin their invocation-time dispatches so a bounded ledger cannot drop them. */
  pins: number;
}

interface RunRecord {
  readonly runId: string;
  /** Timeline index at agent_start; the Run's outputs are the assistant blocks after it. */
  readonly timelineOffset: number;
  /** True when Control adopted a Run already streaming at Session bind. */
  readonly adopted: boolean;
  outputIds: string[];
  lifecycle: "complete" | "error" | null;
  errorMessage?: string;
  settled: boolean;
  aborted: boolean;
  executionRejected?: boolean;
  /**
   * Persisted Pi entry of this Run's terminal assistant message, read from the
   * Session branch at settlement. Quota-incident correlation compares this
   * identity with Pindie's validated `anchorEntryId`; error text is never used.
   */
  terminalEntryId?: string;
}

/** Terminal history retained for read-back; nonterminal dispatches are never evicted. */
const MAX_DISPATCH_RECORDS = 4;
/** Hard backpressure bound for simultaneously nonterminal dispatches. */
const MAX_PENDING_DISPATCH_RECORDS = 32;
const MAX_RUN_RECORDS = 8;

const DEFAULT_WAIT_TIMEOUT_SECONDS = 20;
const MAX_WAIT_TIMEOUT_SECONDS = 30;
const MEANINGFUL_TIMELINE_FINGERPRINT_BLOCKS = 32;
const DEFAULT_TIMELINE_LIMIT = 20;
const MAX_TIMELINE_LIMIT = 50;

/**
 * Transport-independent read/control client over the Host-owned Pi runtime.
 *
 * It owns only disposable binding/settlement/revision bookkeeping and routes
 * bounded control operations through Pi-native primitives. Conversation and
 * semantic truth remain Pi Session/PindieState.
 */
export class PindieControlClient {
  private readonly runtime: PiRuntimeAdapter;
  private readonly presentation: PindieControlPresentationLease;
  private readonly createLease: () => string;
  private readonly bindActiveSession?: () => Promise<void>;
  private binding: ControlBinding | null = null;
  private nextBindingGeneration = 0;
  private automaticWorkSettled = false;
  private revision = 0;
  private lastFingerprint = "";
  private currentSnapshot: PindieControlSnapshot | null = null;
  private projection: PindieUiProjection | null = null;
  private nextDeliverySequence = 1;
  private records: DispatchRecord[] = [];
  private readonly runs = new Map<string, RunRecord>();
  private nextRunSequence = 1;
  private activeRunId: string | null = null;
  /**
   * Incident anchors observed on a resume message before its successor Run
   * started; applied at the next `agent_start`.
   */
  private pendingQuotaAnchors = new Set<string>();
  private readonly waiters = new Set<ControlWaiter>();
  private started = false;
  private disposed = false;

  constructor(
    runtime: PiRuntimeAdapter,
    presentation: PindieControlPresentationLease,
    options: PindieControlClientOptions = {},
  ) {
    this.runtime = runtime;
    this.presentation = presentation;
    this.createLease = options.createLease ?? randomUUID;
    this.bindActiveSession = options.bindActiveSession;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Pindie Control client is disposed.");
    if (this.started) return;
    this.started = true;
    this.runtime.setActiveSessionClientLifecycle({
      beforeSessionInvalidate: () => this.beforeSessionInvalidate(),
      rebindSession: () => this.rebindSession(),
    });
    try {
      await this.rebindSession();
    } catch (error) {
      this.runtime.setActiveSessionClientLifecycle();
      this.started = false;
      throw error;
    }
  }

  observe(): PindieControlSnapshot {
    this.requireActiveBinding();
    this.refresh();
    return this.currentSnapshot!;
  }

  readTimeline(request: { readonly limit?: number } = {}): {
    readonly sessionId: string;
    readonly revision: number;
    readonly hasMoreBefore: boolean;
    readonly timeline: readonly UiTimelineBlock[];
  } {
    const snapshot = this.observe();
    const limit = request.limit ?? DEFAULT_TIMELINE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
      throw new PindieControlError("invalid_request", "Timeline limit must be an integer between 1 and 50.", snapshot);
    }
    const timeline = this.projection?.timeline;
    if (timeline === undefined) throw new Error("Pindie Control live projection is unavailable.");
    const count = Math.min(limit, timeline.length);
    return {
      sessionId: snapshot.session.id,
      revision: snapshot.revision,
      hasMoreBefore: timeline.length > count,
      timeline: timeline.slice(-count),
    };
  }

  wait(request: {
    readonly lease: string;
    readonly until: PindieControlWaitUntil;
    readonly afterRevision?: number;
    readonly timeoutSeconds?: number;
  }): Promise<PindieControlWaitResult> {
    const binding = this.requireLease(request.lease);
    if (request.until !== "meaningful_change" && request.until !== "settled" && request.until !== "human_gate") {
      throw new PindieControlError("invalid_request", "Pindie Control wait condition is invalid.");
    }
    if (request.afterRevision !== undefined &&
      (!Number.isInteger(request.afterRevision) || request.afterRevision < 0)) {
      throw new PindieControlError("invalid_request", "afterRevision must be an integer >= 0.");
    }
    if (request.until === "meaningful_change" && request.afterRevision === undefined) {
      throw new PindieControlError("invalid_request", "meaningful_change requires afterRevision >= 0.");
    }
    const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_WAIT_TIMEOUT_SECONDS) {
      throw new PindieControlError("invalid_request", "Wait timeoutSeconds must be an integer between 1 and 30.");
    }

    const snapshot = this.observe();
    const immediate = this.waitReason(request.until, request.afterRevision, snapshot);
    if (immediate !== null) return Promise.resolve({ reason: immediate, snapshot });

    // Pin the invocation-time dispatches so their outcome cannot be silently
    // replaced by a newer dispatch while this wait is outstanding.
    const releasePins = this.pinDispatches();
    return new Promise((resolve) => {
      const waiter: ControlWaiter = {
        binding,
        until: request.until,
        ...(request.afterRevision === undefined ? {} : { afterRevision: request.afterRevision }),
        resolve,
        releasePins,
        timer: setTimeout(() => {
          let current = this.currentSnapshot;
          try {
            if (this.binding === binding) {
              this.refresh();
              current = this.currentSnapshot;
            }
          } catch { /* Return only the last safely bound snapshot. */ }
          this.resolveWaiter(waiter, { reason: "timeout", snapshot: current });
        }, timeoutSeconds * 1000),
      };
      this.waiters.add(waiter);
    });
  }

  /** Lease-free observation, independent of snapshot refresh/revision and write authority. */
  readEfficiency() {
    this.requireActiveBinding();
    const efficiency = this.runtime.getActiveSessionEfficiency();
    let duration: { scope: "run_current_or_latest" | "task"; durationMs: number } | null = null;
    try {
      const consumption = this.presentation.current()?.snapshot().status.consumption;
      if (consumption && Number.isFinite(consumption.durationMs) && consumption.durationMs >= 0) {
        duration = { scope: consumption.scope === "task" ? "task" : "run_current_or_latest", durationMs: consumption.durationMs };
      }
    } catch { /* Optional presentation telemetry must not invalidate native usage. */ }
    return { ...efficiency, duration,
      durationSource: "Existing Presentation consumption from Core RunTimer / Host TaskMetricsTracker; active Run time, not Task wall time. Process-local; resets on restart/manual Session replacement. Only the available scope is returned; null if unavailable.",
    };
  }

  /** Availability means membership in Pi's current registry snapshot, not provider health. */
  listModels() {
    this.requireActiveBinding();
    return { source: "pi_available_registry_snapshot" as const, models: this.runtime.getAvailableModelCatalog() };
  }

  async input(request: {
    readonly lease: string;
    readonly text: string;
    readonly timing?: PindieControlInputTiming;
    readonly sessionName?: string;
  }): Promise<PindieControlInputResult> {
    const binding = this.requireLease(request.lease);
    const text = request.text.trim();
    if (!text) {
      throw new PindieControlError("invalid_request", "Pindie Control input text is required.");
    }

    const sessionName = request.sessionName === undefined ? undefined : normalizeInputSessionName(request.sessionName);
    const snapshot = this.observe();
    this.requireOrdinaryInputAllowed(snapshot);
    const facts = this.runtime.getActiveSessionFacts();
    const timing = request.timing ?? "now";
    const delivery: PindieControlDelivery = facts.isIdle
      ? "prompt"
      : timing === "after_current_run"
        ? "followUp"
        : "steer";

    let nameStartedPrompt: (() => void) | undefined;
    if (sessionName !== undefined && delivery === "prompt" && facts.pendingMessageCount === 0 &&
      snapshot.runtime.automaticWorkSettled && snapshot.recovery.quotaWaiting === null) {
      try {
        nameStartedPrompt = this.runtime.prepareInitialSessionName(sessionName);
      } catch { /* Unavailable native metadata must not affect prompt delivery. */ }
    }

    // Identity exists before Pi can start the Run so agent_start can attach it.
    const accepted = this.beginDispatch(text, delivery, snapshot.revision);
    let refused = false;
    try {
      if (delivery === "prompt") {
        await this.launchPrompt(text, accepted, () => { refused = true; }, nameStartedPrompt);
        this.requireSameBinding(binding);
      } else if (delivery === "steer") {
        const disposition = await this.runtime.steer(text);
        refused = disposition === "handled";
        this.requireSameBinding(binding);
        this.requireQueuedDelivery(disposition);
        this.confirmQueuedDelivery(accepted);
      } else {
        const disposition = await this.runtime.followUp(text);
        refused = disposition === "handled";
        this.requireSameBinding(binding);
        this.requireQueuedDelivery(disposition);
        this.confirmQueuedDelivery(accepted);
      }
      this.appendDelivery(text, delivery, accepted.dispatchId);
    } catch (error) {
      if (refused) {
        this.abandonDispatch(accepted);
        throw error;
      }
      throw this.uncertainDelivery(accepted, error);
    }

    return this.deliveryResult(accepted);
  }

  async respond(request: {
    readonly lease: string;
    readonly gateKey: string;
    readonly response: string;
  }): Promise<PindieControlInputResult> {
    const binding = this.requireLease(request.lease);
    const response = request.response.trim();
    if (!response) {
      throw new PindieControlError("invalid_request", "Pindie Control gate response is required.");
    }

    const snapshot = this.observe();
    const gate = snapshot.semantic.humanGate;
    if (gate === null) {
      throw new PindieControlError(
        "human_gate_mismatch",
        "Pindie Control has no current Human Gate to answer.",
        snapshot,
      );
    }
    if (gate.key !== request.gateKey) {
      throw new PindieControlError(
        "human_gate_mismatch",
        "Pindie Control Human Gate changed before this response was applied.",
        snapshot,
      );
    }
    this.requireSafeIdle(snapshot);

    // A Gate response is an accepted user input for the Run it starts.
    const accepted = this.beginDispatch(response, "prompt", snapshot.revision);
    let refused = false;
    try {
      await this.launchPrompt(response, accepted, () => { refused = true; });
      this.requireSameBinding(binding);
      this.appendDelivery(response, "prompt", accepted.dispatchId);
    } catch (error) {
      if (refused) {
        this.abandonDispatch(accepted);
        throw error;
      }
      throw this.uncertainDelivery(accepted, error);
    }

    return this.deliveryResult(accepted);
  }

  async stop(request: { readonly lease: string }): Promise<PindieControlStopResult> {
    this.requireLease(request.lease);
    const facts = this.runtime.getActiveSessionFacts();
    if (facts.isIdle) {
      return {
        stopped: false,
        cleared: { steering: 0, followUp: 0 },
        snapshot: this.observe(),
      };
    }

    const queued = this.runtime.clearActiveSessionQueue();
    await this.runtime.abortActiveSession();
    await this.runtime.waitForActiveSessionIdle();

    return {
      stopped: true,
      cleared: {
        steering: queued.steering.length,
        followUp: queued.followUp.length,
      },
      snapshot: this.observe(),
    };
  }

  async freshSession(request: {
    readonly lease: string;
  }): Promise<PindieControlFreshSessionResult> {
    const binding = this.requireLease(request.lease);
    const snapshot = this.observe();
    this.requireSafeIdle(snapshot);
    if (snapshot.semantic.humanGate !== null) {
      throw new PindieControlError(
        "human_gate_required",
        "Resolve the current Human Gate before replacing the active Session.",
        snapshot,
      );
    }

    const result = await this.runtime.replaceWithFreshSession();
    if (result.cancelled) {
      this.requireSameBinding(binding);
      return { cancelled: true, snapshot: this.observe() };
    }

    const next = this.requireActiveBinding();
    if (next === binding || next.lease === binding.lease) {
      throw new PindieControlError(
        "stale_control_lease",
        "Pindie replaced the Session without establishing a fresh Control lease.",
        this.safeSnapshot(),
      );
    }
    return { cancelled: false, snapshot: this.observe() };
  }

  async listSessions(
    request: { readonly offset?: number; readonly limit?: number } = {},
  ): Promise<PindieControlSessionPage> {
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new PindieControlError("invalid_request", "Session listing requires offset >= 0 and limit between 1 and 50.");
    }

    const binding = this.requireActiveBinding();
    let choices: Awaited<ReturnType<PiRuntimeAdapter["getActiveProjectSessionChoices"]>>;
    try {
      choices = await this.runtime.getActiveProjectSessionChoices();
    } catch {
      // Pi's internal Session path must not escape through discovery errors.
      throw new Error("Pindie Control could not list Sessions.");
    }
    this.requireSameSessionBinding(binding);
    const snapshot = this.observe();
    const sessions = choices
      .map((choice): PindieControlSessionChoice => ({
        id: choice.id,
        name: boundedSessionText(choice.name ?? "", 96) || null,
        created: choice.created.toISOString(),
        modified: choice.modified.toISOString(),
        messageCount: choice.messageCount,
        firstMessagePreview: boundedSessionText(choice.firstMessage, 160),
        current: choice.current,
      }))
      .sort((left, right) => {
        if (left.modified !== right.modified) return left.modified > right.modified ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    return {
      activeSessionId: snapshot.session.id,
      total: sessions.length,
      offset,
      limit,
      hasMore: offset + limit < sessions.length,
      sessions: sessions.slice(offset, offset + limit),
    };
  }

  async switchSession(
    request: { readonly lease: string; readonly sessionId: string },
  ): Promise<PindieControlSwitchSessionResult> {
    const binding = this.requireLease(request.lease);
    let choices: Awaited<ReturnType<PiRuntimeAdapter["getActiveProjectSessionChoices"]>>;
    try {
      choices = await this.runtime.getActiveProjectSessionChoices();
    } catch {
      throw new PindieControlError(
        "session_switch_failed",
        "Pindie Control could not resolve the requested Session.",
        this.safeSnapshot(),
      );
    }
    this.requireSameSessionBinding(binding);
    const matches = choices.filter((choice) => choice.id === request.sessionId);
    if (matches.length === 0) {
      throw new PindieControlError(
        "session_not_found",
        "The requested Session is not available in the active project.",
        this.safeSnapshot(),
      );
    }
    if (matches.length > 1) {
      throw new PindieControlError(
        "session_ambiguous",
        "The requested Session ID is ambiguous in the active project.",
        this.safeSnapshot(),
      );
    }

    const target = matches[0]!;
    if (target.current || target.id === binding.sessionId) {
      return { cancelled: false, snapshot: this.observe() };
    }

    const snapshot = this.observe();
    const facts = this.runtime.getActiveSessionFacts();
    if (
      !facts.isIdle ||
      !snapshot.runtime.automaticWorkSettled ||
      facts.pendingMessageCount !== 0 ||
      snapshot.semantic.humanGate !== null ||
      snapshot.recovery.quotaWaiting !== null
    ) {
      throw new PindieControlError(
        "session_switch_unsafe",
        "Pindie Control requires an idle, settled Session with no pending messages, Human Gate, or quota wait.",
        snapshot,
      );
    }

    this.requireSameBinding(binding);
    let result: Awaited<ReturnType<PiRuntimeAdapter["switchActiveSession"]>>;
    try {
      result = await this.runtime.switchActiveSession(target.path);
    } catch {
      throw new PindieControlError(
        "session_switch_failed",
        "Pi could not switch to the requested Session.",
        this.safeSnapshot(),
      );
    }
    if (result.cancelled) {
      this.requireSameSessionBinding(binding);
      return { cancelled: true, snapshot: this.observe() };
    }

    let next: ControlBinding;
    try {
      next = this.requireActiveBinding();
    } catch {
      throw new PindieControlError(
        "session_switch_failed",
        "Pi replaced the Session without completing Control bootstrap.",
        this.safeSnapshot(),
      );
    }
    if (next === binding || next.lease === binding.lease || this.runtime.activeSessionId !== request.sessionId) {
      this.beforeSessionInvalidate();
      throw new PindieControlError(
        "session_switch_failed",
        "Pi did not establish the requested Session with a fresh Control lease.",
        this.safeSnapshot(),
      );
    }
    const switchedSnapshot = this.observe();
    if (switchedSnapshot.session.id !== request.sessionId) {
      this.beforeSessionInvalidate();
      throw new PindieControlError(
        "session_switch_failed",
        "Pi did not expose the requested Session in the Control projection.",
        this.safeSnapshot(),
      );
    }
    return { cancelled: false, snapshot: switchedSnapshot };
  }

  async configure(
    request: PindieControlConfigureRequest,
  ): Promise<PindieControlSnapshot> {
    const binding = this.requireLease(request.lease);
    if (request.model === undefined && request.thinkingLevel === undefined) {
      throw new PindieControlError(
        "invalid_request",
        "Pindie Control configure requires a model and/or thinking level.",
      );
    }

    let snapshot = this.observe();
    this.requireSafeIdle(snapshot);
    this.requireOrdinaryInputAllowed(snapshot);

    if (request.model !== undefined) {
      const { provider, modelId } = request.model;
      if (!this.runtime.isActiveSessionModelAvailable(provider, modelId)) {
        throw new PindieControlError(
          "model_unavailable",
          `Pindie model is unavailable: ${provider}/${modelId}`,
          snapshot,
        );
      }
      await this.runtime.setActiveSessionModel(provider, modelId);
      this.requireSameBinding(binding);
      snapshot = this.observe();
      this.requireSafeIdle(snapshot);
    }

    if (request.thinkingLevel !== undefined) {
      this.runtime.setActiveSessionThinkingLevel(request.thinkingLevel);
      this.requireSameBinding(binding);
    }

    return this.observe();
  }

  dispose(): void {
    if (this.disposed) return;
    const snapshot = this.currentSnapshot;
    this.resolveAllWaiters({ reason: "binding_changed", snapshot });
    this.disposed = true;
    this.binding?.unsubscribe();
    this.binding = null;
    this.projection = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
    if (this.started) this.runtime.setActiveSessionClientLifecycle();
    this.started = false;
  }

  private requireLease(lease: string): ControlBinding {
    const binding = this.requireActiveBinding();
    if (binding.lease === lease) return binding;
    throw new PindieControlError(
      "stale_control_lease",
      "Pindie Control lease is stale. Observe the current Session before retrying.",
      this.safeSnapshot(),
    );
  }

  private requireSameSessionBinding(expected: ControlBinding): void {
    try {
      this.requireSameBinding(expected);
    } catch {
      throw new PindieControlError(
        "stale_control_lease",
        "Pindie Control binding changed while the Session operation was in flight.",
        this.safeSnapshot(),
      );
    }
  }

  private requireSameBinding(expected: ControlBinding): void {
    const current = this.requireActiveBinding();
    if (
      current !== expected ||
      current.generation !== expected.generation ||
      current.lease !== expected.lease ||
      this.runtime.activeSessionId !== expected.sessionId
    ) {
      throw new PindieControlError(
        "stale_control_lease",
        "Pindie Control binding changed while the operation was in flight.",
        this.safeSnapshot(),
      );
    }
  }

  private requireOrdinaryInputAllowed(snapshot: PindieControlSnapshot): void {
    if (
      snapshot.semantic.authority === "unavailable" ||
      snapshot.semantic.authority === "presentation-unavailable"
    ) {
      throw new PindieControlError(
        "semantic_unavailable",
        "Pindie semantic authority is unavailable; ordinary remote input is fail-closed.",
        snapshot,
      );
    }
    if (snapshot.semantic.humanGate !== null) {
      throw new PindieControlError(
        "human_gate_required",
        "Pindie is waiting for a Human Gate response; use the gate-response operation.",
        snapshot,
      );
    }
  }

  private requireSafeIdle(snapshot: PindieControlSnapshot): void {
    if (
      !snapshot.runtime.idle ||
      !snapshot.runtime.automaticWorkSettled ||
      snapshot.runtime.pendingMessageCount !== 0
    ) {
      throw new PindieControlError(
        "unsafe_runtime_state",
        "Pindie Control requires an idle, settled Session with no pending messages.",
        snapshot,
      );
    }
  }

  private appendDelivery(text: string, delivery: PindieControlDelivery, dispatchId: string): void {
    const binding = this.requireActiveBinding();
    if (this.projection === null) throw new Error("Pindie Control live projection is unavailable.");
    this.projection = appendUserDelivery(this.projection, {
      id: dispatchId,
      text,
      delivery,
      dispatchId,
    });
    this.refresh();
  }

  private beginDispatch(
    text: string,
    delivery: PindieControlDelivery,
    acceptedRevision: number,
  ): DispatchRecord {
    const binding = this.requireActiveBinding();
    const pending = this.records.filter((record) => !this.dispatchTerminal(record)).length;
    if (pending >= MAX_PENDING_DISPATCH_RECORDS) {
      // Fail closed before delivery: never accept work the ledger cannot track.
      throw new PindieControlError(
        "dispatch_backlog_full",
        "Pindie Control dispatch backlog is full; wait for pending work to settle before dispatching more.",
        this.safeSnapshot(),
      );
    }
    const record: DispatchRecord = {
      dispatchId: `live:${binding.sessionId}:control:${this.nextDeliverySequence++}`,
      delivery,
      text,
      acceptedRevision,
      // steer/followUp are consumed inside the current Run; an idle prompt
      // stays unattached until the Run it starts emits agent_start.
      runIds: this.activeRunId === null ? [] : [this.activeRunId],
      discardedBeforeConsumption: false,
      deliveryConfirmed: false,
      awaitingQuotaRecovery: false,
      pins: 0,
    };
    this.records = [...this.records, record];
    // Evict terminal history only; an accepted dispatch is never silently lost.
    this.pruneDispatchRecords();
    return record;
  }

  /** A dispatch is terminal once its last Run settled (or Pi never consumed it). */
  private dispatchTerminal(record: DispatchRecord): boolean {
    if (record.executionPending) return false;
    if (record.discardedBeforeConsumption || record.executionRejected) return true;
    // A reported quota wait protects a failed dispatch until it is continued.
    if (record.awaitingQuotaRecovery) return false;
    const lastRunId = record.runIds.at(-1);
    if (lastRunId === undefined) return false;
    return this.runs.get(lastRunId)?.settled === true && !this.runExecutionPending(lastRunId);
  }

  private runExecutionPending(runId: string): boolean {
    return this.records.some((record) => record.executionPending && record.runIds[0] === runId);
  }

  private pruneDispatchRecords(): void {
    const pinned = this.records.filter((record) => record.pins > 0).length;
    while (this.records.length > MAX_DISPATCH_RECORDS + pinned) {
      const index = this.records.findIndex((record) => record.pins === 0 && this.dispatchTerminal(record));
      if (index < 0) return;
      this.records = this.records.filter((_record, candidateIndex) => candidateIndex !== index);
    }
  }

  private deliveryResult(record: DispatchRecord): PindieControlInputResult {
    try {
      const snapshot = this.observe();
      const dispatch = snapshot.dispatches.find((entry) => entry.dispatchId === record.dispatchId);
      if (dispatch !== undefined) return { delivery: record.delivery, dispatch, snapshot };
    } catch { /* Delivery already happened: never invite a blind resend. */ }
    throw this.uncertainDelivery(record);
  }

  private uncertainDelivery(record: DispatchRecord, cause?: unknown): PindieControlError {
    return new PindieControlError(
      cause instanceof PindieControlError && cause.code === "stale_control_lease"
        ? "stale_control_lease" : "delivery_uncertain",
      "Native delivery may already have occurred. Wait and observe this dispatch; do not resend the input. A new input is a new dispatch, not a retry.",
      this.safeSnapshot(),
      { dispatchId: record.dispatchId, delivery: record.delivery, nextAction: "wait_observe_do_not_resend" },
    );
  }

  private abandonDispatch(record: DispatchRecord): void {
    this.records = this.records.filter((candidate) => candidate !== record);
  }

  /**
   * Which dispatches Pi's authoritative queue still holds.
   *
   * Pi 1.5 enqueues steer text in `steering` and followUp text in `followUp`,
   * and on a consumed user message removes the **first** match from `steering`,
   * else the first from `followUp`. Both queues therefore behave as independent
   * FIFO lists, with steering preferred when the same text sits in both. Reading
   * that from Pi's own queue snapshot is not a second queue model, and an idle
   * prompt is never treated as queued because Control only prompts when idle.
   */
  private unconsumedDispatchIds(projection: PindieUiProjection): Set<string> | null {
    const queue = projection.queue;
    if (queue.state !== "authoritative") return null;
    const queued = new Set<string>();
    const queues = [
      ["steer", queue.steering],
      ["followUp", queue.followUp],
    ] as const;
    for (const [delivery, contents] of queues) {
      if (contents === null) continue;
      const remaining = new Map<string, number>();
      for (const text of contents) remaining.set(text, (remaining.get(text) ?? 0) + 1);
      const byText = new Map<string, DispatchRecord[]>();
      for (const record of this.records) {
        // Unacknowledged attempts may never have entered Pi's queue. Including
        // them would steal an older identical delivery's occurrence and can
        // falsely report that acknowledged input as consumed at settlement.
        if (record.delivery !== delivery || !record.deliveryConfirmed) continue;
        const group = byText.get(record.text);
        if (group === undefined) byText.set(record.text, [record]);
        else group.push(record);
      }
      for (const [text, group] of byText) {
        const count = remaining.get(text) ?? 0;
        if (count <= 0) continue;
        // Pi removes the first matching text, so the newest occurrences remain.
        for (const record of group.slice(-count)) queued.add(record.dispatchId);
      }
    }
    return queued;
  }

  /** Pin invocation-time dispatches for the duration of one wait call. */
  private pinDispatches(): () => void {
    const pinned = [...this.records];
    for (const record of pinned) record.pins += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const record of pinned) record.pins = Math.max(0, record.pins - 1);
      this.pruneDispatchRecords();
    };
  }

  /**
   * Runtime-only dispatch/Run correlation from public Pi events.
   *
   * Regular assistant messages are persisted without `entry_appended`, which
   * Pi 1.5 emits only for custom/boundary/context-edit entries. Run output is
   * therefore read from Control's own live projection: the assistant blocks
   * appended after `agent_start`, using their existing epoch-scoped block IDs.
   *
   * A ledger failure must never perturb the Run; the caller isolates this call.
   */
  private recordDispatchEvent(event: AgentSessionEvent): void {
    if (event.type === "agent_start") {
      const binding = this.binding;
      if (binding === null) return;
      // Native boundary continuation emits another agent_start inside the
      // same Session Run, with only one agent_settled after all continuations.
      // Keep its identity/output window until that authoritative settlement.
      const runId = this.activeRunId ?? `${binding.sessionId}:run:${this.nextRunSequence++}`;
      if (this.activeRunId === null) {
        this.runs.set(runId, {
          runId,
          timelineOffset: this.projection?.timeline.length ?? 0,
          adopted: false,
          outputIds: [],
          lifecycle: null,
          settled: false,
          aborted: false,
        });
        this.activeRunId = runId;
      }
      // Independent new dispatches attach to this Run.
      for (const record of this.records) {
        if (record.runIds.length === 0 && !record.discardedBeforeConsumption && !record.executionRejected) {
          record.runIds = [runId];
        }
      }
      // An already-observed resume anchor continues exactly its incident's failed
      // work in this Run too; both cases are evaluated, never mutually exclusive.
      for (const anchor of [...this.pendingQuotaAnchors]) this.associateQuotaResume(runId, anchor);
      this.pruneRuns();
      return;
    }
    if (event.type === "message_start" && isQuotaResumeMessage(event.message)) {
      // Pindie Auto Resume delivers a hidden custom message that carries the
      // validated incident anchor. Without it nothing may be continued.
      const anchor = quotaAnchorFromMessage(event.message);
      if (anchor === null) {
        // An unattributable resume signal continues nothing; releasing avoids a
        // wait that could never settle. The dispatch stays factually `error`.
        this.releaseQuotaProtection(undefined);
        return;
      }
      // Pi emits agent_start before this message_start; the reverse ordering is
      // applied by the pending-anchor path at the next agent_start.
      if (this.activeRunId !== null) this.associateQuotaResume(this.activeRunId, anchor);
      else this.pendingQuotaAnchors.add(anchor);
      return;
    }
    const run = this.activeRunId === null ? undefined : this.runs.get(this.activeRunId);
    if (event.type === "message_end") {
      if (run !== undefined) this.captureRunOutput(run);
      return;
    }
    if (event.type === "agent_settled") {
      if (run !== undefined) {
        this.captureRunOutput(run);
        run.settled = true;
        run.aborted = event.aborted === true;
        // Only a recorded, non-aborted terminal error can be a quota-incident
        // anchor; successful and aborted Runs stay branch-free here.
        if (run.lifecycle === "error" && !run.aborted) {
          run.terminalEntryId = this.latestPersistedAssistantEntryId();
        }
      }
      // Input Pi never consumed cannot be reported as Run output: input with no
      // Run at settlement, or steer/followUp still in Pi's queue when it ended.
      // Read the current authoritative queue directly (unknown is not empty).
      const stillQueued = this.projection === null ? null : this.unconsumedDispatchIds(this.projection);
      const settlingRunId = run?.runId;
      for (const record of this.records) {
        const ownsRun = settlingRunId !== undefined
          ? record.runIds.length === 0 || record.runIds.at(-1) === settlingRunId
          : record.runIds.length === 0;
        if (ownsRun && (record.runIds.length === 0 || stillQueued?.has(record.dispatchId) === true)) {
          record.discardedBeforeConsumption = true;
        }
      }
      this.activeRunId = null;
    }
  }

  /**
   * Adopt the native Run already streaming when this Session was bound.
   *
   * Pi exposes no Run identifier, so this is a derived `runId` whose output
   * window starts at the currently streaming assistant block (or the current
   * timeline tail). Busy steer/followUp then attach to a real Run instead of
   * becoming unattached and later cancelled.
   */
  private adoptRunningRun(binding: ControlBinding): void {
    if (this.projection === null) return;
    const runId = `${binding.sessionId}:run:${this.nextRunSequence++}`;
    const timeline = this.projection.timeline;
    let offset = timeline.length;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const block = timeline[index];
      if (block !== undefined && block.type === "message" && block.role === "assistant" && block.lifecycle === "streaming") {
        offset = index;
        break;
      }
    }
    this.runs.set(runId, {
      runId,
      timelineOffset: offset,
      adopted: true,
      outputIds: [],
      lifecycle: null,
      settled: false,
      aborted: false,
    });
    this.activeRunId = runId;
    this.pruneRuns();
  }

  private captureRunOutput(run: RunRecord): void {
    if (this.projection === null) return;
    const blocks = this.projection.timeline.slice(run.timelineOffset)
      .filter((block): block is UiMessageBlock => block.type === "message" && block.role === "assistant");
    run.outputIds = blocks.map((block) => block.id);
    const terminal = blocks.at(-1);
    if (terminal === undefined) {
      run.lifecycle = null;
      run.errorMessage = undefined;
      return;
    }
    run.lifecycle = terminal.lifecycle === "streaming" ? null : terminal.lifecycle;
    run.errorMessage = terminal.errorMessage;
  }

  private pruneRuns(): void {
    if (this.runs.size <= MAX_RUN_RECORDS) return;
    const referenced = new Set<string>();
    for (const record of this.records) {
      for (const runId of record.runIds) referenced.add(runId);
    }
    if (this.activeRunId !== null) referenced.add(this.activeRunId);
    for (const [runId, run] of this.runs) {
      if (this.runs.size <= MAX_RUN_RECORDS) break;
      // A retained dispatch must keep its Run record, or its outcome is lost.
      if (!run.settled || referenced.has(runId)) continue;
      this.runs.delete(runId);
    }
  }

  private projectDispatch(
    record: DispatchRecord,
    unconsumed: Set<string> | null,
    gateActive: boolean,
    quotaWaiting: boolean,
  ): PindieControlDispatch {
    const chain = record.runIds
      .map((runId) => this.runs.get(runId))
      .filter((run): run is RunRecord => run !== undefined);
    const run = chain.at(-1);
    // Unknown queue contents fall back to Run attachment rather than guessing.
    const queued = unconsumed === null ? false : unconsumed.has(record.dispatchId);
    let state: PindieControlDispatchState;
    if (record.executionRejected) state = "error";
    else if (record.discardedBeforeConsumption) state = "cancelled";
    // A reported quota wait keeps failed work readable and unsettled, even
    // though its predecessor Run has already settled.
    else if (record.awaitingQuotaRecovery) state = "waiting";
    else if (run === undefined) state = queued ? "queued" : "accepted";
    else if (run.executionRejected && !run.aborted) state = "error";
    else if (!run.settled) state = gateActive || quotaWaiting ? "waiting" : queued ? "queued" : "running";
    else if (run.aborted) state = "cancelled";
    else if (this.runExecutionPending(run.runId)) state = "running";
    else if (!record.deliveryConfirmed) state = "no_result";
    else if (run.lifecycle === "error") state = "error";
    // Only a recorded terminal completion counts; blocks without one are not
    // success. This requires message_end capture, not mere streaming text.
    else if (run.lifecycle === "complete") state = "complete";
    else state = "no_result";
    const outputIds = chain.flatMap((entry) => entry.outputIds);
    return {
      dispatchId: record.dispatchId,
      delivery: record.delivery,
      state,
      runId: record.runIds[0] ?? null,
      runIds: [...record.runIds],
      acceptedRevision: record.acceptedRevision,
      output: run === undefined || (outputIds.length === 0 && run.lifecycle === null)
        ? null
        : {
            entryIds: outputIds,
            lifecycle: run.lifecycle,
            ...(run.errorMessage === undefined ? {} : { errorMessage: run.errorMessage }),
          },
    };
  }

  /**
   * Continue every dispatch whose failed Run is the exact incident anchor named
   * by a quota-resume signal. Unrelated errored Runs are never affected.
   */
  private associateQuotaResume(runId: string, anchorEntryId: string): void {
    for (const record of this.records) {
      const previousRunId = record.runIds.at(-1);
      if (previousRunId === undefined || record.runIds.includes(runId)) continue;
      const previous = this.runs.get(previousRunId);
      if (previous === undefined || !previous.settled || previous.aborted) continue;
      if (previous.lifecycle !== "error" || previous.terminalEntryId !== anchorEntryId) continue;
      record.runIds = [...record.runIds, runId];
      record.awaitingQuotaRecovery = false;
    }
    this.pendingQuotaAnchors.delete(anchorEntryId);
  }

  /**
   * Apply one quota-recovery lifecycle signal to the dispatch ledger.
   *
   * The Supervisor owns one current incident. Any current anchored phase
   * supersedes an older incident, even if the snapshot overwrote its cancellation.
   * `waiting` protects the anchored Run; `wake_started` retains its protection.
   * `null` changes nothing; terminal abandonment releases its own protection.
   */
  private noteQuotaRecovery(status: QuotaResumeWaitingStatus | null): void {
    if (status === null || status.sessionId !== this.binding?.sessionId) return;
    const phase = quotaResumePhase(status);
    const anchor = status.anchorEntryId;
    if (anchor !== undefined && anchor.trim() !== "") {
      // Reconcile only existing quota protection, not error outcomes or Run IDs.
      // The new incident may even be cancelled before Control observes it: its
      // current terminal status still supersedes the previous incident's wait.
      for (const record of this.records) {
        if (!record.awaitingQuotaRecovery) continue;
        const run = this.runs.get(record.runIds.at(-1) ?? "");
        if (run?.terminalEntryId !== anchor) record.awaitingQuotaRecovery = false;
      }
    }
    if (phase === "waiting" || phase === "wake_started") {
      // An unanchored legacy status cannot identify or replace an incident.
      if (anchor === undefined || anchor.trim() === "") return;
      if (phase === "waiting") {
        for (const record of this.records) {
          const run = this.runs.get(record.runIds.at(-1) ?? "");
          if (run?.settled === true && !run.aborted && run.lifecycle === "error" &&
            run.terminalEntryId === anchor) record.awaitingQuotaRecovery = true;
        }
      }
      return;
    }
    this.releaseQuotaProtection(anchor);
  }

  /** Release protection for one anchor, or every protected record when unknown. */
  private releaseQuotaProtection(anchorEntryId: string | undefined): void {
    for (const record of this.records) {
      if (!record.awaitingQuotaRecovery) continue;
      const run = this.runs.get(record.runIds.at(-1) ?? "");
      if (anchorEntryId === undefined || run?.terminalEntryId === anchorEntryId) {
        record.awaitingQuotaRecovery = false;
      }
    }
    if (anchorEntryId !== undefined) this.pendingQuotaAnchors.delete(anchorEntryId);
  }

  /** The persisted identity of the Run's terminal assistant message, if any. */
  private latestPersistedAssistantEntryId(): string | undefined {
    try {
      const branch = this.runtime.getActiveSessionBranch();
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
        return entry.id;
      }
    } catch {
      // Identity is best effort: without it no dispatch is continued.
    }
    return undefined;
  }

  private waitReason(
    until: PindieControlWaitUntil,
    afterRevision: number | undefined,
    snapshot: PindieControlSnapshot,
  ): PindieControlWaitReason | null {
    if (snapshot.semantic.humanGate !== null) return "human_gate";
    if (until === "human_gate") return null;
    if (until === "meaningful_change" && snapshot.revision > afterRevision!) return "changed";
    if (until === "settled" && snapshot.runtime.idle && snapshot.runtime.automaticWorkSettled &&
      snapshot.runtime.pendingMessageCount === 0 && snapshot.recovery.quotaWaiting === null &&
      !snapshot.dispatches.some(({ state }) => state === "waiting")) return "settled";
    return null;
  }

  private notifyWaiters(binding: ControlBinding, snapshot: PindieControlSnapshot): void {
    for (const waiter of this.waiters) {
      if (waiter.binding !== binding) {
        this.resolveWaiter(waiter, { reason: "binding_changed", snapshot: this.currentSnapshot });
        continue;
      }
      const reason = this.waitReason(waiter.until, waiter.afterRevision, snapshot);
      if (reason !== null) this.resolveWaiter(waiter, { reason, snapshot });
    }
  }

  private resolveWaiter(waiter: ControlWaiter, result: PindieControlWaitResult): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.releasePins();
    waiter.resolve(result);
  }

  private resolveAllWaiters(result: PindieControlWaitResult): void {
    for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, result);
  }

  private confirmQueuedDelivery(record: DispatchRecord): void {
    record.deliveryConfirmed = true;
    const runId = record.runIds.at(-1);
    // Settlement may beat the acknowledgement continuation. Such input is
    // still unconsumed if Pi's authoritative queue holds it after settlement.
    if (runId !== undefined && this.runs.get(runId)?.settled && this.projection !== null &&
      this.unconsumedDispatchIds(this.projection)?.has(record.dispatchId)) {
      record.discardedBeforeConsumption = true;
    }
  }

  private requireQueuedDelivery(disposition: Awaited<ReturnType<PiRuntimeAdapter["steer"]>>): void {
    if (disposition === "handled") {
      throw new PindieControlError("delivery_failed", "Pi consumed the input without queuing it.", this.safeSnapshot());
    }
  }

  private async launchPrompt(
    text: string,
    record: DispatchRecord,
    onRefused: () => void,
    nameStartedPrompt?: () => void,
  ): Promise<void> {
    const binding = this.binding;
    let reportPreflight!: (accepted: boolean) => void;
    let preflightReported = false;
    let acceptedByPi = false;
    const preflight = new Promise<boolean>((resolve) => {
      reportPreflight = (accepted) => {
        if (preflightReported) return;
        preflightReported = true;
        resolve(accepted);
      };
    });

    let pending: Promise<void>;
    record.executionPending = true;
    try {
      pending = this.runtime.prompt(text, {
        // Pi 0.99 distinguishes extension-consumed input from an actual run/queue.
        preflightResult: (disposition) => {
          if (preflightReported) return;
          const accepted = disposition === "started" || disposition === "queued";
          acceptedByPi = accepted;
          record.deliveryConfirmed = accepted;
          if (!accepted) onRefused();
          // Preflight precedes agent_start. Close the settled window before
          // naming can emit a native session_info_changed event.
          if (accepted && this.binding === binding) this.automaticWorkSettled = false;
          if (disposition === "started" && nameStartedPrompt !== undefined && binding !== null) {
            try {
              this.requireSameBinding(binding);
              const current = this.observe();
              this.requireOrdinaryInputAllowed(current);
              nameStartedPrompt();
            } catch {
              // Pi has already accepted the prompt. Metadata writes are not atomic
              // and may update memory before failing on disk: never report a
              // delivery failure or roll back/retry already-dispatched work.
            }
          }
          reportPreflight(accepted);
        },
      } satisfies PromptOptions);
    } catch (error) {
      record.executionPending = false;
      if (!acceptedByPi) onRefused();
      else if (this.binding === binding) this.recordExecutionRejection(record);
      throw new PindieControlError(
        "delivery_failed",
        `Pindie prompt delivery failed: ${errorMessage(error)}`,
        this.safeSnapshot(),
      );
    }
    const finish = (rejected: boolean) => {
      record.executionPending = false;
      if (rejected) {
        reportPreflight(false);
        if (!acceptedByPi) onRefused();
        else if (this.binding === binding) {
          // A recorded completion cannot override a rejected execution promise.
          this.recordExecutionRejection(record);
        }
      }
      // Pi owns diagnostics/history; retain only the runtime rejection fact.
      if (this.binding !== binding) return;
      try {
        this.refresh();
      } catch {
        // A later explicit observation can recover current facts.
      }
    };
    void pending.then(() => finish(false), () => finish(true));

    if (!await preflight) {
      throw new PindieControlError(
        "delivery_failed",
        "Pindie prompt delivery was rejected during Pi preflight.",
        this.safeSnapshot(),
      );
    }
  }

  private recordExecutionRejection(record: DispatchRecord): void {
    const runId = record.runIds[0];
    const run = runId === undefined ? undefined : this.runs.get(runId);
    if (run === undefined) record.executionRejected = true;
    else run.executionRejected = true;
  }

  private get workSettled(): boolean {
    return this.automaticWorkSettled && !this.records.some((record) => record.executionPending);
  }

  private safeSnapshot(): PindieControlSnapshot | null {
    try {
      this.refresh();
      return this.currentSnapshot;
    } catch {
      return this.currentSnapshot;
    }
  }

  private requireActiveBinding(): ControlBinding {
    if (this.disposed) throw new Error("Pindie Control client is disposed.");
    if (!this.started || this.binding === null) {
      throw new Error("Pindie Control client has no active Session binding.");
    }
    return this.binding;
  }

  private beforeSessionInvalidate(): void {
    this.resolveAllWaiters({ reason: "binding_changed", snapshot: this.currentSnapshot });
    this.binding?.unsubscribe();
    this.binding = null;
    this.projection = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
    this.records = [];
    this.runs.clear();
    this.activeRunId = null;
    this.pendingQuotaAnchors = new Set<string>();
  }

  private async rebindSession(): Promise<void> {
    if (this.disposed) return;
    this.binding?.unsubscribe();
    this.binding = null;
    this.projection = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
    this.nextDeliverySequence = 1;
    this.records = [];
    this.runs.clear();
    this.nextRunSequence = 1;
    this.activeRunId = null;
    this.pendingQuotaAnchors = new Set<string>();
    const generation = ++this.nextBindingGeneration;
    // Do not expose a lease until Pi's extension session_start has finished.
    // The same lifecycle callback handles initial bootstrap and native replacement.
    await this.bindActiveSession?.();
    const sessionId = this.runtime.activeSessionId;
    const binding: ControlBinding = { generation, sessionId, lease: this.createLease(), unsubscribe: () => {} };
    this.binding = binding;
    const facts = this.runtime.getActiveSessionFacts();
    this.automaticWorkSettled = facts.isIdle;
    this.lastFingerprint = "";
    try {
      const presentation = this.presentation.current()?.snapshot() ?? null;
      this.projection = rebuildProjection(this.projectionRebuildInput(binding, presentation));
      // A bind that happens mid-Run missed agent_start; adopt only a genuinely
      // streaming Run. Pi is non-idle while compacting too, which has no Run.
      if (this.projection.status.isStreaming) this.adoptRunningRun(binding);
      this.refresh(true);
      const unsubscribe = this.runtime.subscribeActiveSession((event) => {
        this.handleSessionEvent(sessionId, generation, event);
      });
      this.binding = { ...binding, unsubscribe };
    } catch (error) {
      if (this.binding?.generation === generation) {
        this.binding.unsubscribe();
        this.binding = null;
        this.projection = null;
        this.currentSnapshot = null;
        this.automaticWorkSettled = false;
      }
      throw error;
    }
  }

  private handleSessionEvent(
    sessionId: string,
    generation: number,
    event: AgentSessionEvent,
  ): void {
    const binding = this.binding;
    if (
      binding === null ||
      binding.sessionId !== sessionId ||
      binding.generation !== generation ||
      this.runtime.activeSessionId !== sessionId
    ) return;

    if (event.type === "agent_start") this.automaticWorkSettled = false;
    if (event.type === "agent_settled") this.automaticWorkSettled = true;

    // Projection is an optional control surface. A projection failure must not
    // perturb the underlying Agent Run.
    try {
      if (this.projection === null) return;
      this.projection = reduceProjectionEvent(this.projection, event);
      // Dispatch bookkeeping reads the updated live projection; a ledger
      // failure must never skip the projection refresh below.
      try {
        this.recordDispatchEvent(event);
      } catch {
        // A subsequent explicit observation still reports current runtime facts.
      }
      this.refresh();
    } catch {
      // A subsequent explicit observation can retry current facts without
      // inventing a competing timeline when the live projection is absent.
    }
  }

  private projectionFactsInput(
    binding: ControlBinding,
    presentation: PindiePresentationSnapshot | null,
  ): PindieUiProjectionFactsInput {
    return {
      presentation,
      session: {
        sessionId: binding.sessionId,
        displayIdentity: this.runtime.getActiveSessionDisplayIdentity(),
        model: this.runtime.getActiveSessionModelIdentity(),
        thinkingLevel: this.runtime.getActiveSessionThinkingLevel(),
        runtime: this.runtime.getActiveSessionFacts(),
        automaticWorkSettled: this.workSettled,
      },
    };
  }

  private projectionRebuildInput(
    binding: ControlBinding,
    presentation: PindiePresentationSnapshot | null,
  ): PindieUiProjectionInput {
    const facts = this.projectionFactsInput(binding, presentation);
    return {
      ...facts,
      session: {
        ...facts.session,
        branch: this.runtime.getActiveSessionBranch(),
      },
    };
  }

  private refresh(force = false): void {
    const binding = this.requireActiveBinding();
    if (this.runtime.activeSessionId !== binding.sessionId) {
      throw new Error("Pindie Control Session binding is stale.");
    }
    if (this.projection === null) throw new Error("Pindie Control live projection is unavailable.");

    const presentation = this.presentation.current()?.snapshot() ?? null;
    this.projection = refreshProjectionFacts(
      this.projection,
      this.projectionFactsInput(binding, presentation),
    );
    // Protection must be current before dispatch states are derived. The full
    // lifecycle signal is used; the wait-only field cannot express abandonment.
    this.noteQuotaRecovery(presentation?.quotaResumeEvent ?? presentation?.quotaResumeWaiting ?? null);
    const next = this.project(binding, presentation, this.projection);
    const fingerprint = `${controlFingerprint(next)}\u0000${timelineObservationFingerprint(this.projection.timeline)}`;

    if (force || fingerprint !== this.lastFingerprint) {
      this.revision += 1;
      this.lastFingerprint = fingerprint;
    }

    this.currentSnapshot = { ...next, revision: this.revision };
    this.notifyWaiters(binding, this.currentSnapshot);
  }

  private project(
    binding: ControlBinding,
    presentation: PindiePresentationSnapshot | null,
    projection: PindieUiProjection,
  ): Omit<PindieControlSnapshot, "revision"> {
    const task = presentation?.status.state?.task ?? null;
    const unavailableReason = projection.attention?.kind === "authority-unavailable"
      ? projection.attention.reason
      : presentation?.status.stateUnavailableReason ?? null;
    const signal = presentation === null
      ? null
      : classifyHumanSignal({
          phase: "current",
          sessionId: binding.sessionId,
          authority: projection.status.semanticAuthority,
          authorityUnavailableReason: unavailableReason,
          taskStatus: projection.status.taskStatus,
          task,
          isIdle: projection.status.isIdle,
          automaticWorkSettled: this.workSettled,
          pendingMessageCount: projection.status.pendingMessageCount,
          quotaResumeWaiting: presentation.quotaResumeWaiting !== null,
        });

    const latestReport = [...projection.timeline]
      .reverse()
      .find((block) => (block.type === "message" && block.role === "assistant") ||
        (block.type === "semantic" && block.category === "completion" && block.lifecycle === "complete"));

    return {
      lease: binding.lease,
      project: {
        root: projection.header.projectRoot,
      },
      session: {
        id: projection.header.sessionId,
        displayIdentity: projection.header.displayIdentity,
      },
      runtime: {
        idle: projection.status.isIdle,
        streaming: projection.status.isStreaming,
        compacting: projection.status.isCompacting,
        pendingMessageCount: projection.status.pendingMessageCount,
        automaticWorkSettled: this.workSettled,
        activity: projection.status.activity,
      },
      dispatches: (() => {
        const unconsumed = this.unconsumedDispatchIds(projection);
        return this.records.map((record) => this.projectDispatch(
          record,
          unconsumed,
          signal?.kind === "human-gate",
          presentation?.quotaResumeWaiting !== null && presentation?.quotaResumeWaiting !== undefined,
        ));
      })(),
      semantic: {
        authority: projection.status.semanticAuthority,
        taskStatus: projection.status.taskStatus,
        taskGoal: task?.goal ?? null,
        blockers: task ? [...task.openLoops.blockers] : [],
        questions: task ? [...task.openLoops.questions] : [],
        verificationStatus: projection.status.verificationStatus,
        verificationProgress: projection.status.verificationProgress === null
          ? null
          : { ...projection.status.verificationProgress },
        humanGate: signal?.kind === "human-gate" && task?.humanGate
          ? {
              key: signal.key,
              kind: task.humanGate.kind,
              question: task.humanGate.question,
              ...(task.humanGate.options === undefined
                ? {}
                : { options: [...task.humanGate.options] }),
            }
          : null,
        unavailableReason,
      },
      executionConfig: {
        model: projection.header.model === null
          ? null
          : { ...projection.header.model },
        thinkingLevel: projection.header.thinkingLevel,
        reasoningMode: projection.status.reasoningMode,
      },
      recovery: {
        quotaWaiting: presentation?.quotaResumeWaiting === null ||
            presentation?.quotaResumeWaiting === undefined
          ? null
          : { ...presentation.quotaResumeWaiting },
      },
      latestAssistant: latestReport?.type === "message"
        ? {
            entryId: latestReport.id,
            text: latestReport.text,
            lifecycle: latestReport.lifecycle,
            ...(latestReport.errorMessage === undefined ? {} : { errorMessage: latestReport.errorMessage }),
            source: "assistant",
          }
        : latestReport?.type === "semantic" && latestReport.category === "completion"
          ? {
              entryId: latestReport.id,
              text: latestReport.summary,
              lifecycle: "complete",
              source: "task_completion",
            }
          : null,
    };
  }
}

function controlFingerprint(
  snapshot: Omit<PindieControlSnapshot, "revision">,
): string {
  const {
    runtime: { activity: _activity, ...runtime },
    latestAssistant,
    ...rest
  } = snapshot;
  // Activity and changing streaming text are useful context but not wake-up
  // boundaries; lifecycle identity remains in the timeline fingerprint.
  return JSON.stringify({
    ...rest,
    runtime,
    latestAssistant: latestAssistant?.lifecycle === "streaming"
      ? { ...latestAssistant, text: "" }
      : latestAssistant,
  });
}

function timelineObservationFingerprint(timeline: readonly UiTimelineBlock[]): string {
  return JSON.stringify(timeline.slice(-MEANINGFUL_TIMELINE_FINGERPRINT_BLOCKS).map((block) => {
    if (block.type === "message") return [block.type, block.id, block.role, block.lifecycle, block.errorMessage];
    if (block.type === "work") {
      return block.kind === "observation"
        ? [block.type, block.kind, block.items.map(({ toolCallId, lifecycle }) => [toolCallId, lifecycle])]
        : [block.type, block.kind, block.id, block.lifecycle];
    }
    return block;
  }));
}


function isQuotaResumeMessage(message: unknown): boolean {
  const candidate = message as { readonly role?: unknown; readonly customType?: unknown } | null;
  return candidate?.role === "custom" && candidate.customType === PINDIE_QUOTA_RESUME_TYPE;
}

/** The incident anchor Pindie attached to its validated resume signal. */
function quotaAnchorFromMessage(message: unknown): string | null {
  const candidate = message as {
    readonly details?: { readonly anchorEntryId?: unknown } | null;
  } | null;
  const anchor = candidate?.details?.anchorEntryId;
  return typeof anchor === "string" && anchor.trim() !== "" ? anchor : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sessionTextSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function normalizeInputSessionName(value: string): string {
  // Bound raw work as well as visible length; reject terminal/bidi controls and
  // malformed UTF-16. This is caller-authored display data, never inferred text.
  if (typeof value !== "string" || value.length > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new PindieControlError("invalid_request", "Session name must be short display text without control or format characters.");
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(sessionTextSegmenter.segment(normalized)).length > 96) {
    throw new PindieControlError("invalid_request", "Session name must contain 1–96 visible characters (maximum 512 UTF-16 code units).");
  }
  return normalized;
}

function boundedSessionText(value: string, maxGraphemes: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const segments = Array.from(sessionTextSegmenter.segment(normalized), ({ segment }) => segment);
  return segments.length <= maxGraphemes
    ? normalized
    : `${segments.slice(0, maxGraphemes - 1).join("")}…`;
}
