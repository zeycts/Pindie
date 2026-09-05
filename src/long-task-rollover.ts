import {
  validateTaskContinuity,
  type TaskContinuityV1,
} from "./task-continuity.ts";
import {
  formatLongTaskResume,
  PINDIE_LONG_TASK_RESUME_TYPE,
} from "./long-task-resume.ts";
import {
  formatLongTaskContinuationSessionName,
  PiRuntimeAdapter,
  type SessionReplacementOptions,
} from "./pi-runtime.ts";
import type {
  CommittedRolloverRequest,
  SessionLifecycleBoundary,
} from "./long-task-control.ts";
import type { TaskMetricsTracker } from "./task-metrics.ts";

export type LongTaskRolloverScheduler = (callback: () => void) => void;

export interface LongTaskRolloverSupervisorOptions {
  readonly schedule?: LongTaskRolloverScheduler;
  readonly maxAutomaticRollovers?: number;
  readonly logger?: (message: string) => void;
  readonly taskMetrics?: TaskMetricsTracker;
}

const DEFAULT_MAX_AUTOMATIC_ROLLOVERS = 8;

function defaultSchedule(callback: () => void): void {
  setImmediate(callback);
}

function isCommittedRolloverRequest(value: unknown): value is CommittedRolloverRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as { sourceSessionId?: unknown; checkpoint?: unknown };
  if (typeof request.sourceSessionId !== "string" || request.sourceSessionId.trim() === "") {
    return false;
  }
  const checkpoint = request.checkpoint;
  const validation = validateTaskContinuity(checkpoint);
  return validation.ok && request.sourceSessionId === (checkpoint as TaskContinuityV1).sourceSessionId;
}

/** Owns one fail-closed automatic Session replacement attempt at a time. */
export class LongTaskRolloverSupervisor {
  private readonly runtime: PiRuntimeAdapter;
  private readonly schedule: LongTaskRolloverScheduler;
  private readonly maxAutomaticRollovers: number;
  private readonly logger: (message: string) => void;
  private readonly taskMetrics: TaskMetricsTracker | null;
  private pendingRequest: CommittedRolloverRequest | null = null;
  private scheduled = false;
  private inProgress = false;
  private inProgressPromise: Promise<void> | undefined;
  private disposed = false;
  private activeReplacementSourceSessionId: string | null = null;
  private lifecycleInvalidated = false;
  private chainSessionId: string | null = null;
  private chainCount = 0;

  constructor(
    runtime: PiRuntimeAdapter,
    options: LongTaskRolloverSupervisorOptions = {},
  ) {
    this.runtime = runtime;
    this.schedule = options.schedule ?? defaultSchedule;
    this.maxAutomaticRollovers = options.maxAutomaticRollovers ?? DEFAULT_MAX_AUTOMATIC_ROLLOVERS;
    if (!Number.isInteger(this.maxAutomaticRollovers) || this.maxAutomaticRollovers < 1) {
      throw new Error("maxAutomaticRollovers must be a positive integer.");
    }
    this.logger = options.logger ?? ((message) => console.warn(`[Pindie] ${message}`));
    this.taskMetrics = options.taskMetrics ?? null;
  }

  request(request: CommittedRolloverRequest): void {
    if (this.disposed || this.inProgress || this.pendingRequest !== null) return;
    this.pendingRequest = request;
    if (this.scheduled) return;
    this.scheduled = true;
    try {
      this.schedule(() => {
        this.scheduled = false;
        const pending = this.pendingRequest;
        this.pendingRequest = null;
        if (pending === null || this.disposed) return;
        this.inProgress = true;
        this.activeReplacementSourceSessionId = null;
        this.lifecycleInvalidated = false;
        const attempt = this.attemptRollover(pending)
          .catch((error: unknown) => {
            this.breakChain();
            this.report(`Automatic Long Task rollover failed: ${errorMessage(error)}`);
          })
          .finally(() => {
            this.inProgress = false;
            this.activeReplacementSourceSessionId = null;
            this.lifecycleInvalidated = false;
            this.inProgressPromise = undefined;
          });
        this.inProgressPromise = attempt;
        void attempt;
      });
    } catch (error) {
      this.scheduled = false;
      this.pendingRequest = null;
      this.breakChain();
      this.report(`Automatic Long Task rollover could not be scheduled: ${errorMessage(error)}`);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingRequest = null;
    this.taskMetrics?.cancelAutomaticRollover();
    this.breakChain();
    await this.inProgressPromise;
  }

  /**
   * Invalidate pending automatic state when native Pi tears down a Session for
   * any reason other than the replacement currently owned by this supervisor.
   * Reload keeps the native Session ID, so the explicit lifecycle signal is
   * required instead of relying on an ID change to reset the safety chain.
   */
  observeSessionLifecycle(boundary: SessionLifecycleBoundary): void {
    if (this.disposed) return;
    const isOwnedAutomaticReplacement = this.inProgress &&
      this.activeReplacementSourceSessionId === boundary.sessionId &&
      boundary.reason === "new";
    if (isOwnedAutomaticReplacement) return;

    this.pendingRequest = null;
    this.taskMetrics?.cancelAutomaticRollover();
    this.breakChain();
    if (this.inProgress) this.lifecycleInvalidated = true;
  }

  private async attemptRollover(request: CommittedRolloverRequest): Promise<void> {
    if (!isCommittedRolloverRequest(request)) {
      this.breakChain();
      this.report("Ignored an invalid committed Long Task rollover request.");
      return;
    }

    const facts = this.runtime.getActiveSessionFacts();
    if (facts.sessionId !== request.sourceSessionId) {
      this.breakChain();
      return;
    }
    if (facts.isStreaming || facts.isCompacting || facts.pendingMessageCount > 0) {
      this.breakChain();
      return;
    }

    const nextChainCount = this.chainSessionId === request.sourceSessionId
      ? this.chainCount + 1
      : 1;
    if (nextChainCount > this.maxAutomaticRollovers) {
      this.breakChain();
      this.report("Automatic Long Task rollover safety fuse tripped; returning control to the current Session.");
      return;
    }

    // This is intentionally the final factual read before Pi's native
    // replacement call. Pi's newSession start is the rollover linearization point.
    const finalFacts = this.runtime.getActiveSessionFacts();
    if (
      finalFacts.sessionId !== request.sourceSessionId ||
      finalFacts.isStreaming ||
      finalFacts.isCompacting ||
      finalFacts.pendingMessageCount > 0
    ) {
      this.breakChain();
      return;
    }

    // Presentation lineage is derived once from the outgoing native Session,
    // before replacement. It is independent of the safety-fuse chain count.
    let continuationName: string;
    try {
      continuationName = formatLongTaskContinuationSessionName(
        this.runtime.getActiveSessionDisplayIdentity(),
      );
    } catch {
      continuationName = formatLongTaskContinuationSessionName(undefined);
    }

    this.activeReplacementSourceSessionId = request.sourceSessionId;
    this.lifecycleInvalidated = false;
    this.taskMetrics?.prepareAutomaticRollover(
      request.sourceSessionId,
      request.checkpoint.taskFingerprint,
    );

    let replacementStarted = false;
    let resumeSuppressed = false;
    const options: SessionReplacementOptions = {
      withSession: async (replacementContext) => {
        replacementStarted = true;
        if (this.disposed || this.lifecycleInvalidated) {
          resumeSuppressed = true;
          return;
        }
        try {
          // withSession runs after Pi installs and rebinds the fresh Session.
          this.runtime.setActiveSessionName(continuationName);
        } catch {
          // Display metadata is best effort; never block or roll back resume.
          this.report("Automatic Long Task Session lineage naming failed; continuing hidden resume.");
        }

        // A real user message may be accepted while Pi is rebinding the fresh
        // Session. Never place stale automatic continuation in front of that
        // input: the fresh Session can continue its native user/run queue.
        const freshFacts = this.runtime.getActiveSessionFacts();
        if (
          freshFacts.isStreaming ||
          freshFacts.isCompacting ||
          freshFacts.pendingMessageCount > 0
        ) {
          resumeSuppressed = true;
          return;
        }

        // Pi 0.84.4's sendMessage(triggerTurn: true) Promise covers the full
        // Agent Run. Do not hold replacement ownership for that lifetime: the
        // fresh Session must be able to commit and request the next rollover.
        let resumePromise: Promise<void>;
        try {
          resumePromise = replacementContext.sendMessage(
            {
              customType: PINDIE_LONG_TASK_RESUME_TYPE,
              content: formatLongTaskResume(request.checkpoint),
              display: false,
            },
            { triggerTurn: true },
          );
        } catch (error) {
          resumeSuppressed = true;
          this.breakChain();
          this.report(`Automatic Long Task resume message failed after Pi installed the fresh Session: ${errorMessage(error)}`);
          return;
        }
        void resumePromise.catch((error: unknown) => {
          this.breakChain();
          this.report(`Automatic Long Task resume message failed after Pi installed the fresh Session: ${errorMessage(error)}`);
        });
      },
    };

    try {
      const result = await this.runtime.replaceWithFreshSession(options);
      this.taskMetrics?.cancelAutomaticRollover();
      if (result.cancelled || resumeSuppressed || this.disposed || this.lifecycleInvalidated) {
        this.breakChain();
        return;
      }
      this.chainSessionId = this.runtime.activeSessionId;
      this.chainCount = nextChainCount;
    } catch (error) {
      this.taskMetrics?.cancelAutomaticRollover();
      this.breakChain();
      this.report(
        replacementStarted
          ? `Automatic Long Task Session replacement failed after the fresh Session began: ${errorMessage(error)}`
          : `Automatic Long Task Session replacement failed: ${errorMessage(error)}`,
      );
    }
  }

  private breakChain(): void {
    this.chainSessionId = null;
    this.chainCount = 0;
  }

  private report(message: string): void {
    try {
      this.logger(message);
    } catch {
      // Runtime-control diagnostics must not become another control failure.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
