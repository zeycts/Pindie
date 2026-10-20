import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  AgentSessionEvent,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import { classifyHumanSignal } from "./human-signal.ts";
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
    | { readonly entryId: string; readonly text: string; readonly lifecycle: "streaming" | "complete" | "error"; readonly source: "assistant" }
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
  | "session_not_found"
  | "session_ambiguous"
  | "session_switch_unsafe"
  | "session_switch_failed";

export class PindieControlError extends Error {
  readonly code: PindieControlErrorCode;
  readonly snapshot: PindieControlSnapshot | null;

  constructor(
    code: PindieControlErrorCode,
    message: string,
    snapshot: PindieControlSnapshot | null = null,
  ) {
    super(message);
    this.name = "PindieControlError";
    this.code = code;
    this.snapshot = snapshot;
  }
}

export type PindieControlInputTiming = "now" | "after_current_run";
export type PindieControlDelivery = "prompt" | "steer" | "followUp";

export interface PindieControlDeliveryResult {
  readonly delivery: PindieControlDelivery;
  readonly snapshot: PindieControlSnapshot;
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
  timer: ReturnType<typeof setTimeout>;
}

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

    return new Promise((resolve) => {
      const waiter: ControlWaiter = {
        binding,
        until: request.until,
        ...(request.afterRevision === undefined ? {} : { afterRevision: request.afterRevision }),
        resolve,
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

  async input(request: {
    readonly lease: string;
    readonly text: string;
    readonly timing?: PindieControlInputTiming;
    readonly sessionName?: string;
  }): Promise<PindieControlDeliveryResult> {
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

    try {
      if (delivery === "prompt") {
        await this.launchPrompt(text, nameStartedPrompt);
        this.requireSameBinding(binding);
      } else if (delivery === "steer") {
        const disposition = await this.runtime.steer(text);
        this.requireSameBinding(binding);
        this.requireQueuedDelivery(disposition);
      } else {
        const disposition = await this.runtime.followUp(text);
        this.requireSameBinding(binding);
        this.requireQueuedDelivery(disposition);
      }
      this.appendDelivery(text, delivery);
    } catch (error) {
      if (error instanceof PindieControlError) throw error;
      throw new PindieControlError(
        "delivery_failed",
        `Pindie Control could not deliver input: ${errorMessage(error)}`,
        this.safeSnapshot(),
      );
    }

    return { delivery, snapshot: this.observe() };
  }

  async respond(request: {
    readonly lease: string;
    readonly gateKey: string;
    readonly response: string;
  }): Promise<PindieControlDeliveryResult> {
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

    try {
      await this.launchPrompt(response);
      this.requireSameBinding(binding);
      this.appendDelivery(response, "prompt");
    } catch (error) {
      if (error instanceof PindieControlError) throw error;
      throw new PindieControlError(
        "delivery_failed",
        `Pindie Control could not deliver the Human Gate response: ${errorMessage(error)}`,
        this.safeSnapshot(),
      );
    }

    return { delivery: "prompt", snapshot: this.observe() };
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

  private appendDelivery(text: string, delivery: PindieControlDelivery): void {
    const binding = this.requireActiveBinding();
    if (this.projection === null) throw new Error("Pindie Control live projection is unavailable.");
    this.projection = appendUserDelivery(this.projection, {
      id: `live:${binding.sessionId}:control:${this.nextDeliverySequence++}`,
      text,
      delivery,
    });
    this.refresh();
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
      snapshot.runtime.pendingMessageCount === 0 && snapshot.recovery.quotaWaiting === null) return "settled";
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
    waiter.resolve(result);
  }

  private resolveAllWaiters(result: PindieControlWaitResult): void {
    for (const waiter of [...this.waiters]) this.resolveWaiter(waiter, result);
  }

  private requireQueuedDelivery(disposition: Awaited<ReturnType<PiRuntimeAdapter["steer"]>>): void {
    if (disposition === "handled") {
      throw new PindieControlError("delivery_failed", "Pi consumed the input without queuing it.", this.safeSnapshot());
    }
  }

  private async launchPrompt(text: string, nameStartedPrompt?: () => void): Promise<void> {
    const binding = this.binding;
    let reportPreflight!: (accepted: boolean) => void;
    let preflightReported = false;
    const preflight = new Promise<boolean>((resolve) => {
      reportPreflight = (accepted) => {
        if (preflightReported) return;
        preflightReported = true;
        resolve(accepted);
      };
    });

    let pending: Promise<void>;
    try {
      pending = this.runtime.prompt(text, {
        // Pi 0.99 distinguishes extension-consumed input from an actual run/queue.
        preflightResult: (disposition) => {
          if (preflightReported) return;
          const accepted = disposition === "started" || disposition === "queued";
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
      throw new PindieControlError(
        "delivery_failed",
        `Pindie prompt delivery failed: ${errorMessage(error)}`,
        this.safeSnapshot(),
      );
    }
    void pending.catch((error) => {
      reportPreflight(false);
      // Pi owns the Agent Run and persists visible failure in Session history.
      // Control must not turn a rejected Run Promise into a second result store.
      try {
        this.refresh();
      } catch {
        // A later explicit observation can recover current facts.
      }
      return error;
    });

    if (!await preflight) {
      throw new PindieControlError(
        "delivery_failed",
        "Pindie prompt delivery was rejected during Pi preflight.",
        this.safeSnapshot(),
      );
    }
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
  }

  private async rebindSession(): Promise<void> {
    if (this.disposed) return;
    this.binding?.unsubscribe();
    this.binding = null;
    this.projection = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
    this.nextDeliverySequence = 1;
    const generation = ++this.nextBindingGeneration;
    // Do not expose a lease until Pi's extension session_start has finished.
    // The same lifecycle callback handles initial bootstrap and native replacement.
    await this.bindActiveSession?.();
    const sessionId = this.runtime.activeSessionId;
    const binding: ControlBinding = { generation, sessionId, lease: this.createLease(), unsubscribe: () => {} };
    this.binding = binding;
    this.automaticWorkSettled = this.runtime.getActiveSessionFacts().isIdle;
    this.lastFingerprint = "";
    try {
      const presentation = this.presentation.current()?.snapshot() ?? null;
      this.projection = rebuildProjection(this.projectionRebuildInput(binding, presentation));
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
        automaticWorkSettled: this.automaticWorkSettled,
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
          automaticWorkSettled: this.automaticWorkSettled,
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
        automaticWorkSettled: this.automaticWorkSettled,
        activity: projection.status.activity,
      },
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
    if (block.type === "message") return [block.type, block.id, block.role, block.lifecycle];
    if (block.type === "work") {
      return block.kind === "observation"
        ? [block.type, block.kind, block.items.map(({ toolCallId, lifecycle }) => [toolCallId, lifecycle])]
        : [block.type, block.kind, block.id, block.lifecycle];
    }
    return block;
  }));
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
