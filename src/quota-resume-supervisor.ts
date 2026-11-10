import { findCodexQuotaIncidentAtAnchor, type QuotaResumePlan } from "./quota-resume-incident.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import type { QuotaResumePhase, QuotaResumeWaitingStatus } from "./quota-resume-control.ts";

export const PINDIE_QUOTA_RESUME_TYPE = "pindie-quota-resume";
export const PINDIE_QUOTA_RESUME_MESSAGE = `<PINDIE_QUOTA_RESUME>

Runtime-generated continuation after the previous Agent Run was
interrupted by OpenAI Codex subscription quota exhaustion.

This is runtime metadata, not new user intent.

Continue the latest actual user request using the current transcript
and the new Pindie Run Baseline. Do not broaden the user's request.

</PINDIE_QUOTA_RESUME>`;
export const MAX_QUOTA_RESUME_WAIT_MS = 8 * 24 * 60 * 60 * 1_000;

export type QuotaResumeScheduler = (delayMs: number, callback: () => void) => () => void;
export interface QuotaResumeSupervisorOptions {
  readonly now?: () => number;
  readonly schedule?: QuotaResumeScheduler;
  readonly logger?: (message: string) => void;
  readonly onWaitingChange?: (status: QuotaResumeWaitingStatus | null) => void;
}

interface WaitingLease {
  readonly generation: number;
  readonly plan: QuotaResumePlan;
  readonly cancelTimer: () => void;
}

const defaultSchedule: QuotaResumeScheduler = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export class QuotaResumeSupervisor {
  private readonly runtime: PiRuntimeAdapter;
  private readonly now: () => number;
  private readonly schedule: QuotaResumeScheduler;
  private readonly logger: (message: string) => void;
  private readonly onWaitingChange: (status: QuotaResumeWaitingStatus | null) => void;
  private lease: WaitingLease | null = null;
  private generation = 0;
  private disposed = false;

  constructor(runtime: PiRuntimeAdapter, options: QuotaResumeSupervisorOptions = {}) {
    this.runtime = runtime;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.logger = options.logger ?? ((message) => console.warn(`[Pindie] ${message}`));
    this.onWaitingChange = options.onWaitingChange ?? (() => undefined);
  }

  request(plan: QuotaResumePlan): boolean {
    if (this.disposed || !this.validPlan(plan) || !this.matchesCurrentRuntime(plan)) return false;
    if (this.lease?.plan.sessionId === plan.sessionId && this.lease.plan.anchorEntryId === plan.anchorEntryId) return true;

    // A replaced plan abandons the previous incident explicitly.
    this.clearLease("cancelled");
    const generation = ++this.generation;
    let cancelTimer: () => void;
    try {
      cancelTimer = this.schedule(plan.resumeAt - this.now(), () => this.wake(generation));
    } catch (error) {
      this.report(`Quota resume could not be scheduled: ${errorMessage(error)}`);
      return false;
    }
    this.lease = { generation, plan, cancelTimer };
    this.publishPhase(plan, "waiting");
    return true;
  }

  cancel(sessionId: string): void {
    if (this.lease?.plan.sessionId === sessionId) this.clearLease("cancelled");
  }

  dispose(): void {
    this.disposed = true;
    this.clearLease("cancelled");
  }

  private validPlan(plan: QuotaResumePlan): boolean {
    const now = this.now();
    const valid = plan.provider === "openai-codex" &&
      typeof plan.sessionId === "string" && plan.sessionId.trim() !== "" &&
      typeof plan.anchorEntryId === "string" && plan.anchorEntryId.trim() !== "" &&
      typeof plan.modelId === "string" && plan.modelId.trim() !== "" &&
      Number.isFinite(plan.detectedAt) && Number.isFinite(plan.resumeAt) &&
      plan.resumeAt > now && plan.resumeAt - now <= MAX_QUOTA_RESUME_WAIT_MS;
    if (!valid) this.report("Ignored an invalid quota resume plan.");
    return valid;
  }

  private matchesCurrentRuntime(plan: QuotaResumePlan): boolean {
    try {
      const facts = this.runtime.getActiveSessionFacts();
      const model = this.runtime.getActiveSessionModelIdentity();
      if (facts.sessionId !== plan.sessionId || facts.isStreaming || facts.isCompacting || facts.pendingMessageCount !== 0 ||
        model?.provider !== plan.provider || model.modelId !== plan.modelId) return false;
      const incident = findCodexQuotaIncidentAtAnchor(this.runtime.getActiveSessionBranch(), plan.anchorEntryId);
      return incident?.anchorEntryId === plan.anchorEntryId && incident.provider === plan.provider && incident.modelId === plan.modelId;
    } catch (error) {
      this.report(`Quota resume runtime validation failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private wake(generation: number): void {
    const lease = this.lease;
    if (this.disposed || lease === null || lease.generation !== generation) return;
    if (!this.matchesCurrentRuntime(lease.plan)) {
      // Session, model or anchor evidence changed: this incident is abandoned.
      this.clearLease("invalidated");
      return;
    }

    const plan = lease.plan;
    // The wait is cleared immediately before the message, so publish the gap as
    // `wake_started` rather than dropping the signal entirely.
    this.detachLease();
    // A late send failure may only speak for this wake while nothing newer
    // (next plan, cancel, dispose) has taken over the lease generation.
    const wakeGeneration = this.generation;
    let resumed: Promise<void>;
    try {
      resumed = this.runtime.sendCustomMessage(
        {
          customType: PINDIE_QUOTA_RESUME_TYPE,
          content: PINDIE_QUOTA_RESUME_MESSAGE,
          display: false,
          // The anchor travels with the signal so Control can continue exactly
          // the dispatches of this incident, without error-text inference.
          details: { anchorEntryId: plan.anchorEntryId, sessionId: plan.sessionId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      if (this.generation === wakeGeneration) this.publishPhase(plan, "wake_failed");
      this.report(`Quota resume message failed: ${errorMessage(error)}`);
      return;
    }
    void resumed.catch((error: unknown) => {
      if (this.generation === wakeGeneration) this.publishPhase(plan, "wake_failed");
      this.report(`Quota resume message failed: ${errorMessage(error)}`);
    });
  }

  private clearLease(phase: QuotaResumePhase): void {
    const lease = this.lease;
    this.lease = null;
    ++this.generation;
    if (lease) {
      lease.cancelTimer();
      this.publishPhase(lease.plan, phase);
    }
  }

  private detachLease(): void {
    const lease = this.lease;
    this.lease = null;
    ++this.generation;
    if (lease) this.publishPhase(lease.plan, "wake_started");
  }

  private publishPhase(plan: QuotaResumePlan, phase: QuotaResumePhase): void {
    this.publish({
      sessionId: plan.sessionId,
      resumeAt: plan.resumeAt,
      anchorEntryId: plan.anchorEntryId,
      phase,
    });
  }

  private publish(status: QuotaResumeWaitingStatus | null): void {
    try { this.onWaitingChange(status); } catch { /* Runtime status is best effort. */ }
  }

  private report(message: string): void {
    try { this.logger(message); } catch { /* diagnostics are best effort */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
