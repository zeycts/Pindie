import { DEFAULT_FALLBACK_CONFIG, copyFallbackConfig, isAllowedFallbackModel, isFallbackThinking, type QuotaFallbackConfig, type FallbackModelIdentity } from "./quota-fallback-config.ts";
import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionLifecycleBoundary } from "./long-task-control.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import { detectCodexQuotaIncident } from "./quota-resume-incident.ts";
import { MAX_QUOTA_RESUME_WAIT_MS, type QuotaResumeScheduler } from "./quota-resume-supervisor.ts";

export const QUOTA_FALLBACK_PROVIDER = DEFAULT_FALLBACK_CONFIG.model.provider;
export const QUOTA_FALLBACK_MODEL_ID = DEFAULT_FALLBACK_CONFIG.model.modelId;
export const PINDIE_QUOTA_FALLBACK_TYPE = "pindie-quota-fallback";
export const PINDIE_QUOTA_FALLBACK_MESSAGE = `<PINDIE_QUOTA_FALLBACK>

Runtime-generated continuation after the previous Agent Run was
interrupted by confirmed OpenAI Codex subscription quota exhaustion.

The active model has temporarily changed to the configured backup model.
This is runtime metadata, not new user intent.

Continue the latest actual user request using the current transcript
and the new Pindie Run Baseline. Do not broaden the user's request.

</PINDIE_QUOTA_FALLBACK>`;

export interface QuotaFallbackPlan {
  readonly sessionId: string;
  readonly anchorEntryId: string;
  readonly provider: "openai-codex";
  readonly modelId: string;
  readonly detectedAt: number;
  readonly restoreAt: number;
  readonly backup?: QuotaFallbackConfig;
}

export interface QuotaFallbackSupervisorOptions {
  readonly now?: () => number;
  readonly schedule?: QuotaResumeScheduler;
  readonly logger?: (message: string) => void;
}

export interface FallbackModelSelection {
  readonly sessionId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly source: "set" | "cycle" | "restore";
}

/** Only the terminal backup assistant provider error is a backup failure. */
export function detectQuotaFallbackBackupFailure(branch: readonly SessionEntry[], backup: FallbackModelIdentity = DEFAULT_FALLBACK_CONFIG.model): boolean {
  const latest = [...branch].reverse().find((entry) => entry.type === "message");
  if (latest?.type !== "message") return false;
  const message = latest.message;
  return message.role === "assistant" && message.provider === backup.provider &&
    message.model === backup.modelId && message.stopReason === "error" &&
    typeof message.errorMessage === "string";
}

interface FallbackLease {
  readonly generation: number;
  readonly plan: QuotaFallbackPlan;
  readonly sourceThinkingLevel: AgentSession["thinkingLevel"];
  readonly backup: QuotaFallbackConfig;
  readonly cancelTimer: () => void;
  readonly unsubscribe: () => void;
  restoreDue: boolean;
  restoring: boolean;
}

const defaultSchedule: QuotaResumeScheduler = (delayMs, callback) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Host-owned, process-local ownership of one temporary model change in one Session. */
export class QuotaFallbackSupervisor {
  private lease: FallbackLease | null = null;
  private generation = 0;
  private committing = false;
  private committingSessionId: string | null = null;
  private ownedMutation: { generation: number; sessionId: string; provider: string; modelId: string } | null = null;
  private disposed = false;
  private readonly runtime: PiRuntimeAdapter;
  private readonly now: () => number;
  private readonly schedule: QuotaResumeScheduler;
  private readonly logger: (message: string) => void;

  constructor(runtime: PiRuntimeAdapter, options: QuotaFallbackSupervisorOptions = {}) {
    this.runtime = runtime;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.logger = options.logger ?? ((message) => console.warn(`[Pindie] ${message}`));
  }

  async request(plan: QuotaFallbackPlan): Promise<boolean> {
    if (this.disposed || this.committing) return false;
    if (this.lease) {
      if (this.lease.plan.sessionId === plan?.sessionId && this.lease.plan.anchorEntryId === plan.anchorEntryId) {
        try {
          if (this.matchesBackup(plan.sessionId, this.lease.backup)) return true;
        } catch (error) { this.report(`Quota fallback lease validation failed: ${errorMessage(error)}`); }
        this.clearLease();
      }
      return false; // Never replace a committed temporary model owner with a stale source request.
    }
    const now = this.now();
    if (!plan || plan.provider !== "openai-codex" ||
      typeof plan.sessionId !== "string" || !plan.sessionId.trim() ||
      typeof plan.anchorEntryId !== "string" || !plan.anchorEntryId.trim() ||
      typeof plan.modelId !== "string" || !plan.modelId.trim() ||
      !Number.isFinite(now) || !Number.isFinite(plan.detectedAt) || plan.detectedAt > now ||
      !Number.isFinite(plan.restoreAt) || plan.restoreAt <= now ||
      plan.restoreAt - now > MAX_QUOTA_RESUME_WAIT_MS) return false;

    const requestedBackup = plan.backup === undefined ? { ...DEFAULT_FALLBACK_CONFIG, enabled: true } : plan.backup;
    if (!requestedBackup || typeof requestedBackup.enabled !== "boolean" || !isAllowedFallbackModel(requestedBackup.model) || !isFallbackThinking(requestedBackup.thinking)) return false;
    const backup = copyFallbackConfig(requestedBackup);
    plan = Object.freeze({ ...plan, ...(plan.backup ? { backup } : {}) });
    let sourceThinkingLevel: AgentSession["thinkingLevel"];
    try {
      if (!this.matchesSource(plan) || !backup.enabled || !this.canUseBackup(plan.sessionId, backup)) return false;
      sourceThinkingLevel = this.runtime.getActiveSessionThinkingLevel();
    } catch (error) {
      this.report(`Quota fallback validation failed: ${errorMessage(error)}`);
      return false;
    }

    this.committing = true;
    this.committingSessionId = plan.sessionId;
    const generation = ++this.generation;
    try {
      await this.setOwnedModel(generation, plan.sessionId, backup.model.provider, backup.model.modelId);
      if (!this.current(generation, plan.sessionId) || !this.matchesBackup(plan.sessionId, backup)) throw new Error("Session or backup changed during fallback switch");
      this.runtime.setActiveSessionThinkingLevel(backup.thinking === "source" ? sourceThinkingLevel : backup.thinking);
      if (!this.current(generation, plan.sessionId) || !this.matchesBackup(plan.sessionId, backup)) throw new Error("Session or backup changed during thinking application");

      // Install ownership before invoking Pi: native events can arrive synchronously.
      const unsubscribe = this.runtime.subscribeActiveSession(() => {
        const lease = this.lease;
        if (lease?.generation === generation && lease.restoreDue) void this.tryRestore(lease);
      });
      let cancelTimer: () => void;
      try {
        cancelTimer = this.schedule(plan.restoreAt - this.now(), () => {
          const lease = this.lease;
          if (lease?.generation !== generation) return;
          lease.restoreDue = true;
          void this.tryRestore(lease);
        });
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (!this.current(generation, plan.sessionId) || !this.matchesBackup(plan.sessionId, backup)) {
        cancelTimer();
        unsubscribe();
        throw new Error("Session or backup changed during lease installation");
      }
      const lease: FallbackLease = { generation, plan, backup, sourceThinkingLevel, cancelTimer, unsubscribe, restoreDue: false, restoring: false };
      this.lease = lease;
      // Pi's returned Promise spans the entire Agent Run; only invocation is the commit boundary.
      const run = this.runtime.sendCustomMessage(
        { customType: PINDIE_QUOTA_FALLBACK_TYPE, content: PINDIE_QUOTA_FALLBACK_MESSAGE, display: false },
        { triggerTurn: true },
      );
      void run.catch((error: unknown) => {
        this.report(`Quota fallback continuation failed: ${errorMessage(error)}`);
        if (this.lease !== lease || !this.current(generation, plan.sessionId)) return;
        lease.restoreDue = true;
        void this.tryRestore(lease);
      });
      if (!this.current(generation, plan.sessionId) || this.lease !== lease) throw new Error("Fallback lease invalidated during continuation invocation");
      if (lease.restoreDue) void this.tryRestore(lease);
      return true;
    } catch (error) {
      this.report(`Quota fallback could not commit: ${errorMessage(error)}`);
      const owned = this.generation === generation;
      if (this.lease?.generation === generation) this.clearLease();
      // A failed setModel can itself leave Pi on the backup. Never roll back
      // after lifecycle/disposal has invalidated this transaction.
      if (owned) await this.rollback(this.generation, plan, sourceThinkingLevel, backup);
      return false;
    } finally {
      this.committing = false;
      this.committingSessionId = null;
    }
  }

  /** Configuration preflight: exact Pi model availability, independent of current source or idle state. */
  canUseBackup(sessionId: string, config: QuotaFallbackConfig = DEFAULT_FALLBACK_CONFIG): boolean {
    try {
      return !this.disposed && this.runtime.activeSessionId === sessionId && isAllowedFallbackModel(config.model) && isFallbackThinking(config.thinking) &&
        this.runtime.isFallbackConfigAvailable(config);
    } catch { return false; }
  }

  cancel(sessionId: string): void {
    if (this.lease?.plan.sessionId === sessionId) this.clearLease();
    if (this.committingSessionId === sessionId) ++this.generation;
  }

  observeModelSelection(event: FallbackModelSelection): boolean {
    const guard = this.ownedMutation;
    if (guard && this.generation === guard.generation &&
      event.sessionId === guard.sessionId && event.provider === guard.provider && event.modelId === guard.modelId &&
      event.source === "set") return true;
    this.cancel(event.sessionId);
    return false;
  }

  async handleBackupFailure(sessionId: string): Promise<QuotaFallbackPlan | null> {
    const lease = this.lease;
    if (!lease || lease.plan.sessionId !== sessionId || lease.restoring || !this.current(lease.generation, sessionId)) return null;
    try {
      if (!detectQuotaFallbackBackupFailure(this.runtime.getActiveSessionBranch(), lease.backup.model)) return null;
      const facts = this.runtime.getActiveSessionFacts();
      if (facts.isStreaming || facts.isCompacting || facts.pendingMessageCount !== 0 || !this.matchesBackup(sessionId, lease.backup)) return null;
      lease.restoring = true;
      await this.setOwnedModel(lease.generation, sessionId, lease.plan.provider, lease.plan.modelId);
      if (this.lease !== lease || !this.current(lease.generation, sessionId)) return null;
      this.runtime.setActiveSessionThinkingLevel(lease.sourceThinkingLevel);
      this.clearLease();
      return lease.plan;
    } catch (error) {
      this.report(`Quota fallback backup recovery failed: ${errorMessage(error)}`);
      if (this.lease === lease) this.clearLease();
      return null;
    } finally {
      lease.restoring = false;
    }
  }

  private async setOwnedModel(generation: number, sessionId: string, provider: string, modelId: string): Promise<void> {
    const guard = { generation, sessionId, provider, modelId };
    this.ownedMutation = guard;
    try {
      await this.runtime.setActiveSessionModel(provider, modelId);
    } finally {
      if (this.ownedMutation === guard) this.ownedMutation = null;
    }
  }

  observeSessionLifecycle(boundary: SessionLifecycleBoundary): void {
    if (this.lease?.plan.sessionId === boundary.sessionId) this.clearLease();
    // Invalidate an in-progress switch before it can install a lease.
    if (this.committing && this.runtime.activeSessionId === boundary.sessionId) ++this.generation;
  }

  dispose(): void {
    this.disposed = true;
    this.clearLease();
    ++this.generation;
  }

  private matchesSource(plan: QuotaFallbackPlan): boolean {
    const facts = this.runtime.getActiveSessionFacts();
    const model = this.runtime.getActiveSessionModelIdentity();
    if (facts.sessionId !== plan.sessionId || facts.isStreaming || facts.isCompacting || facts.pendingMessageCount !== 0 ||
      model?.provider !== plan.provider || model.modelId !== plan.modelId) return false;
    const incident = detectCodexQuotaIncident(this.runtime.getActiveSessionBranch());
    return incident?.anchorEntryId === plan.anchorEntryId && incident.provider === plan.provider && incident.modelId === plan.modelId;
  }

  private current(generation: number, sessionId: string): boolean {
    return !this.disposed && this.generation === generation && this.runtime.activeSessionId === sessionId;
  }

  private matchesBackup(sessionId: string, backup: QuotaFallbackConfig): boolean {
    const facts = this.runtime.getActiveSessionFacts();
    const model = this.runtime.getActiveSessionModelIdentity();
    return facts.sessionId === sessionId && model?.provider === backup.model.provider && model.modelId === backup.model.modelId;
  }

  private async rollback(generation: number, plan: QuotaFallbackPlan, thinking: AgentSession["thinkingLevel"], backup: QuotaFallbackConfig): Promise<void> {
    try {
      if (!this.current(generation, plan.sessionId) || !this.matchesBackup(plan.sessionId, backup)) return;
      await this.setOwnedModel(generation, plan.sessionId, plan.provider, plan.modelId);
      if (this.current(generation, plan.sessionId)) this.runtime.setActiveSessionThinkingLevel(thinking);
    } catch (error) {
      this.report(`Quota fallback rollback failed: ${errorMessage(error)}`);
    }
  }

  private async tryRestore(lease: FallbackLease): Promise<void> {
    if (lease.restoring || !lease.restoreDue || this.lease !== lease) return;
    if (!this.current(lease.generation, lease.plan.sessionId)) {
      if (this.lease === lease) this.clearLease();
      return;
    }
    lease.restoring = true;
    try {
      const facts = this.runtime.getActiveSessionFacts();
      const model = this.runtime.getActiveSessionModelIdentity();
      if (facts.sessionId !== lease.plan.sessionId || model?.provider !== lease.backup.model.provider || model.modelId !== lease.backup.model.modelId) {
        this.clearLease(); // Another model owner wins; never force the old source back.
        return;
      }
      if (facts.isStreaming || facts.isCompacting || facts.pendingMessageCount !== 0) return;
      await this.setOwnedModel(lease.generation, lease.plan.sessionId, lease.plan.provider, lease.plan.modelId);
      if (this.lease !== lease || !this.current(lease.generation, lease.plan.sessionId)) return;
      this.runtime.setActiveSessionThinkingLevel(lease.sourceThinkingLevel);
      this.clearLease();
    } catch (error) {
      this.report(`Quota fallback restore failed: ${errorMessage(error)}`);
      if (this.lease === lease) this.clearLease(); // No unbounded retries on a failed model mutation.
    } finally {
      lease.restoring = false;
    }
  }

  private clearLease(): void {
    const lease = this.lease;
    this.lease = null;
    ++this.generation;
    if (lease) {
      try { lease.cancelTimer(); } catch (error) { this.report(`Quota fallback timer cleanup failed: ${errorMessage(error)}`); }
      try { lease.unsubscribe(); } catch (error) { this.report(`Quota fallback subscription cleanup failed: ${errorMessage(error)}`); }
    }
  }

  private report(message: string): void {
    try { this.logger(message); } catch { /* Diagnostics are best effort. */ }
  }
}
