import { detectCodexQuotaIncident, type QuotaResumePlan } from "./quota-resume-incident.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import type { QuotaResumeWaitingStatus } from "./quota-resume-control.ts";

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

  request(plan: QuotaResumePlan): void {
    if (this.disposed || !this.validPlan(plan) || !this.matchesCurrentRuntime(plan)) return;
    if (this.lease?.plan.sessionId === plan.sessionId && this.lease.plan.anchorEntryId === plan.anchorEntryId) return;

    this.clearLease();
    const generation = ++this.generation;
    let cancelTimer: () => void;
    try {
      cancelTimer = this.schedule(plan.resumeAt - this.now(), () => this.wake(generation));
    } catch (error) {
      this.report(`Quota resume could not be scheduled: ${errorMessage(error)}`);
      return;
    }
    this.lease = { generation, plan, cancelTimer };
    this.publishWaiting({ sessionId: plan.sessionId, resumeAt: plan.resumeAt });
  }

  cancel(sessionId: string): void {
    if (this.lease?.plan.sessionId === sessionId) this.clearLease();
  }

  dispose(): void {
    this.disposed = true;
    this.clearLease();
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
      const incident = detectCodexQuotaIncident(this.runtime.getActiveSessionBranch());
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
      this.clearLease();
      return;
    }
    if (!this.matchesCurrentRuntime(lease.plan)) {
      this.clearLease();
      return;
    }

    this.detachLease();
    let resumed: Promise<void>;
    try {
      resumed = this.runtime.sendCustomMessage(
        { customType: PINDIE_QUOTA_RESUME_TYPE, content: PINDIE_QUOTA_RESUME_MESSAGE, display: false },
        { triggerTurn: true },
      );
    } catch (error) {
      this.report(`Quota resume message failed: ${errorMessage(error)}`);
      return;
    }
    void resumed.catch((error: unknown) => this.report(`Quota resume message failed: ${errorMessage(error)}`));
  }

  private clearLease(): void {
    const lease = this.lease;
    this.lease = null;
    ++this.generation;
    if (lease) {
      lease.cancelTimer();
      this.publishWaiting(null);
    }
  }

  private detachLease(): void {
    const lease = this.lease;
    this.lease = null;
    ++this.generation;
    if (lease) this.publishWaiting(null);
  }

  private publishWaiting(status: QuotaResumeWaitingStatus | null): void {
    try { this.onWaitingChange(status); } catch { /* Runtime status is best effort. */ }
  }

  private report(message: string): void {
    try { this.logger(message); } catch { /* diagnostics are best effort */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
