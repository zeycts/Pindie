import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import { classifyHumanSignal } from "./human-signal.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import type {
  PindiePresentationReader,
  PindiePresentationSnapshot,
} from "./presentation-integration.ts";
import {
  createPindieUiProjection,
  type PindieUiProjection,
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
  };
  readonly recovery: {
    readonly quotaWaiting: PindiePresentationSnapshot["quotaResumeWaiting"];
  };
  readonly latestAssistant: {
    readonly entryId: string;
    readonly text: string;
    readonly lifecycle: "streaming" | "complete" | "error";
  } | null;
}

export interface PindieControlClientOptions {
  readonly createLease?: () => string;
}

interface ControlBinding {
  readonly generation: number;
  readonly sessionId: string;
  readonly lease: string;
  readonly unsubscribe: () => void;
}

/**
 * Transport-independent read/control client over the Host-owned Pi runtime.
 *
 * v0.1 starts read-only: it owns only disposable binding/settlement/revision
 * bookkeeping. Conversation and semantic truth remain Pi Session/PindieState.
 */
export class PindieControlClient {
  private readonly runtime: PiRuntimeAdapter;
  private readonly presentation: PindieControlPresentationLease;
  private readonly createLease: () => string;
  private binding: ControlBinding | null = null;
  private nextBindingGeneration = 0;
  private automaticWorkSettled = false;
  private revision = 0;
  private lastFingerprint = "";
  private currentSnapshot: PindieControlSnapshot | null = null;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding?.unsubscribe();
    this.binding = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
    if (this.started) this.runtime.setActiveSessionClientLifecycle();
    this.started = false;
  }

  private requireActiveBinding(): ControlBinding {
    if (this.disposed) throw new Error("Pindie Control client is disposed.");
    if (!this.started || this.binding === null) {
      throw new Error("Pindie Control client has no active Session binding.");
    }
    return this.binding;
  }

  private beforeSessionInvalidate(): void {
    this.binding?.unsubscribe();
    this.binding = null;
    this.currentSnapshot = null;
    this.automaticWorkSettled = false;
  }

  private async rebindSession(): Promise<void> {
    if (this.disposed) return;
    this.binding?.unsubscribe();

    const generation = ++this.nextBindingGeneration;
    const sessionId = this.runtime.activeSessionId;
    const lease = this.createLease();
    this.automaticWorkSettled = this.runtime.getActiveSessionFacts().isIdle;

    const unsubscribe = this.runtime.subscribeActiveSession((event) => {
      this.handleSessionEvent(sessionId, generation, event);
    });
    this.binding = { generation, sessionId, lease, unsubscribe };
    this.lastFingerprint = "";
    this.refresh(true);
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
      this.refresh();
    } catch {
      // A subsequent explicit observation can retry against current Reality.
    }
  }

  private refresh(force = false): void {
    const binding = this.requireActiveBinding();
    if (this.runtime.activeSessionId !== binding.sessionId) {
      throw new Error("Pindie Control Session binding is stale.");
    }

    const presentation = this.presentation.current()?.snapshot() ?? null;
    const projection = createPindieUiProjection({
      presentation,
      session: {
        sessionId: binding.sessionId,
        displayIdentity: this.runtime.getActiveSessionDisplayIdentity(),
        model: this.runtime.getActiveSessionModelIdentity(),
        thinkingLevel: this.runtime.getActiveSessionThinkingLevel(),
        runtime: this.runtime.getActiveSessionFacts(),
        automaticWorkSettled: this.automaticWorkSettled,
        branch: this.runtime.getActiveSessionBranch(),
      },
    });
    const next = this.project(binding, presentation, projection);
    const fingerprint = controlFingerprint(next);

    if (force || fingerprint !== this.lastFingerprint) {
      this.revision += 1;
      this.lastFingerprint = fingerprint;
    }

    this.currentSnapshot = {
      ...next,
      revision: this.revision,
    };
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

    const latestAssistant = [...projection.timeline]
      .reverse()
      .find((block) => block.type === "message" && block.role === "assistant");

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
      },
      recovery: {
        quotaWaiting: presentation?.quotaResumeWaiting === null ||
            presentation?.quotaResumeWaiting === undefined
          ? null
          : { ...presentation.quotaResumeWaiting },
      },
      latestAssistant: latestAssistant?.type === "message"
        ? {
            entryId: latestAssistant.id,
            text: latestAssistant.text,
            lifecycle: latestAssistant.lifecycle,
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
    ...rest
  } = snapshot;
  // Activity is useful diagnostic context but is deliberately not a wake-up
  // boundary. Tool-by-tool activity churn must not turn observation into log
  // polling.
  return JSON.stringify({
    ...rest,
    runtime,
  });
}
