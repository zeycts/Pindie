import { randomUUID } from "node:crypto";
import { FileLearningBudgetLedger } from "./learning-budget-store.ts";
import { FileLearningJobLedger, type LearningJobLedger } from "./learning-job-store.ts";
import type { LearningSessionRunner } from "./learning-session-runner.ts";
import {
  DEFAULT_LEARNING_BUDGET_POLICY, validateLearningBudgetPolicy, validateLearningArtifactRef,
  type LearningArtifactRef, type LearningBudgetPolicy, type LearningJob, type LearningJobKind, type LearningStopReason,
} from "./learning-v1-contract.ts";

export interface LearningAttemptResult {
  /** Exact immutable output already committed by the handler, never raw model text. */
  readonly receiptRef: LearningArtifactRef;
  readonly usage?: { readonly tokens: number; readonly timeMs: number };
}
export interface LearningJobHandler {
  readonly kind: LearningJobKind;
  /** Only an exact, still-current frozen input can be executed. */
  isCurrent(job: LearningJob): Promise<boolean>;
  /** Resolve an interrupted prior publication before issuing another model Run. */
  resolveCommitted(job: LearningJob): Promise<LearningArtifactRef | null>;
  /** Must fence publication with the supplied lease and authority before committing an immutable output. */
  execute(job: LearningJob, authority: () => Promise<boolean>, signal: AbortSignal, runner?: LearningSessionRunner): Promise<LearningAttemptResult>;
  /** Verify the exact immutable job/output binding even if Human work has arrived. */
  matchesOutput(job: LearningJob, ref: LearningArtifactRef): Promise<boolean>;
}
export interface LearningIdleAuthority {
  /** Synchronous gate; never treat an incoherent or replacing Human Session as idle. */
  idle(): boolean;
  /** Changes synchronously at Human work start, project/Session replacement and shutdown. */
  generation(): number;
}
export interface LearningSupervisorOptions {
  readonly ledger?: LearningJobLedger;
  readonly budget?: FileLearningBudgetLedger;
  readonly policy?: LearningBudgetPolicy;
  readonly handlers?: readonly LearningJobHandler[];
  readonly authority: LearningIdleAuthority;
  readonly runner?: LearningSessionRunner;
  readonly now?: () => number;
}

export class LearningSupervisor {
  private readonly ledger: LearningJobLedger;
  private readonly budget: FileLearningBudgetLedger;
  private readonly policy: LearningBudgetPolicy;
  private readonly handlers: ReadonlyMap<LearningJobKind, LearningJobHandler>;
  private readonly authority: LearningIdleAuthority;
  private readonly runner?: LearningSessionRunner;
  private readonly now: () => number;
  private readonly owner = randomUUID();
  private active: { controller: AbortController; reason: LearningStopReason | null; work: Promise<void> } | null = null;
  private starting = false;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  constructor(options: LearningSupervisorOptions) {
    this.ledger = options.ledger ?? new FileLearningJobLedger();
    this.budget = options.budget ?? new FileLearningBudgetLedger();
    this.policy = options.policy ?? DEFAULT_LEARNING_BUDGET_POLICY;
    if (!validateLearningBudgetPolicy(this.policy)) throw new Error("Invalid learning budget policy.");
    const handlers = options.handlers ?? [];
    if (new Set(handlers.map((h) => h.kind)).size !== handlers.length) throw new Error("Duplicate learning handler.");
    this.handlers = new Map(handlers.map((h) => [h.kind, h]));
    this.authority = options.authority;
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
  }
  /** Nonblocking Human handoff: invalidate generation at Host before calling this. */
  preempt(reason: LearningStopReason): void {
    if (this.active) {
      this.active.reason = reason;
      this.active.controller.abort();
    }
  }
  private eligible(generation: number): boolean {
    return !this.disposed && this.authority.idle() && this.authority.generation() === generation;
  }
  private backoff(attempt: number): number {
    return Math.min(this.policy.retryMaxMs, this.policy.retryBaseMs * 2 ** Math.min(attempt - 1, 30));
  }
  /** A kick starts at most one job, never queues another model Run. Safe to fire-and-forget from Host. */
  kick(): Promise<void> {
    if (this.disposed || this.starting || this.active || !this.authority.idle()) return Promise.resolve();
    this.starting = true;
    const generation = this.authority.generation();
    const work = this.run(generation).finally(() => {
      this.starting = false;
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    return work;
  }
  private async run(generation: number): Promise<void> {
    await this.ledger.reconcileExpired(this.now());
    if (!this.eligible(generation) || !this.handlers.size) return;
    for (const candidate of await this.ledger.listEligible(this.now())) {
      const handler = this.handlers.get(candidate.kind);
      if (!handler) continue;
      if (!this.eligible(generation)) return;
      if (!(await handler.isCurrent(candidate))) {
        // Stale input is proven by the handler, not guessed by the scheduler.
        await this.ledger.cancel(candidate.key, null, "stale-input");
        continue;
      }
      if (candidate.attempt >= this.policy.maxAttempts && !await handler.resolveCommitted(candidate)) continue;
      const reservation = await this.budget.reserve(this.now(), this.policy);
      if (!reservation) return;
      if (!this.eligible(generation)) return;
      // Lease outlives the timeout to allow abort/settlement without an overlapping claimant.
      const leaseMs = this.policy.perJobTimeMsCap + 30_000;
      const job = await this.ledger.claim(candidate.key, this.owner, this.now(), leaseMs, reservation.tokens, reservation.timeMs);
      if (!job) return;
      const token = job.leaseToken!;
      const controller = new AbortController();
      const active = { controller, reason: null as LearningStopReason | null, work: Promise.resolve() };
      this.active = active;
      const authority = async (): Promise<boolean> => this.eligible(generation) && !controller.signal.aborted &&
        (await this.ledger.read()).some((j) => j.key === job.key && j.state === "running" && j.leaseToken === token) &&
        await handler.isCurrent(job);
      // Race from claim to publishing active: a synchronous Host generation change is still detected here.
      if (!this.eligible(generation)) { active.reason = this.disposed ? "explicit-cancel" : "human-work"; controller.abort(); }
      const task = (async () => {
        let reason: LearningStopReason = "transient";
        try {
          let result: LearningAttemptResult;
          const recovered = await handler.resolveCommitted(job);
          if (recovered) result = { receiptRef: recovered };
          else {
            if (!(await authority())) { reason = active.reason ?? "human-work"; return; }
            result = await handler.execute(job, authority, controller.signal, this.runner);
          }
          try { this.budget.account(reservation, result.usage); }
          catch (error) { reason = "budget"; throw error; }
          if (!validateLearningArtifactRef(result.receiptRef) || !await handler.matchesOutput(job, result.receiptRef)) {
            throw new Error("Learning output is not an exact committed job binding.");
          }
          // Committed immutable output may complete after preemption only on exact revalidation.
          if (!(await handler.isCurrent(job))) { reason = "stale-input"; return; }
          await this.ledger.complete(job.key, token, result.receiptRef);
          return;
        } catch {
          reason = active.reason ?? (controller.signal.aborted ? "timeout" : reason);
        } finally {
          const current = (await this.ledger.read()).find((j) => j.key === job.key);
          if (current?.state === "running" && current.leaseToken === token) {
            try {
              await this.ledger.release(job.key, token, this.now() + this.backoff(job.attempt), active.reason ?? reason);
            } catch { /* A newer lease has fenced this attempt. */ }
          }
        }
      })();
      active.work = task;
      const timer = setTimeout(() => { active.reason ??= "timeout"; controller.abort(); }, this.policy.perJobTimeMsCap);
      try { await task; } finally {
        clearTimeout(timer);
        if (this.active === active) this.active = null;
      }
      return;
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.preempt("explicit-cancel");
    await this.inFlight;
  }
}
