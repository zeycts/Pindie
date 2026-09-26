import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { appendPindieSystemContract } from "./context.ts";
import {
  ContextLifecycleGovernor,
  type ContextGovernorTuning,
} from "./context-governor.ts";
import {
  authorizeToolEffect,
  classifyToolEffect,
  type AuthorizationDecision,
  type ToolEffect,
} from "./execution-semantics.ts";
import { ExecutionIntegration } from "./execution-integration.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  runBoundedOperation,
} from "./liveness.ts";
import type { ProjectFingerprint } from "./project-mutation.ts";
import { PindieRuntime } from "./runtime.ts";
import { RunIntegration } from "./run-integration.ts";
import type {
  RunExperienceExecution,
  RunExperiencePolicy,
} from "./run-experience.ts";
import { RunCostTracker, type RunCost } from "./run-cost.ts";
import { RunTimer } from "./run-timer.ts";
import {
  deriveCapabilities,
  type PindieCapability,
  type SemanticSnapshot,
} from "./semantics.ts";
import {
  type PindieState,
  type PindieTask,
  type TaskStatus,
} from "./state.ts";
import {
  type ConsumptionMetrics,
  TaskMetricsTracker,
} from "./task-metrics.ts";
import {
  createTaskContinuity,
  taskContractFingerprint,
} from "./task-continuity.ts";
import { TaskHandoffRuntime } from "./task-handoff-runtime.ts";
import {
  createPindieGateOpenTool,
  createPindieGateResolveTool,
} from "./tools/gate.ts";
import { createPindieGitObserveTool } from "./tools/git-observe.ts";
import { createPindiePolicySetTool } from "./tools/policy.ts";
import {
  createPindieTaskCompleteTool,
  createPindieTaskHandoffTool,
  createPindieTaskProgressTool,
  createPindieTaskRefineTool,
  createPindieTaskReplaceTool,
  createPindieTaskStartTool,
  createPindieVerificationRecordTool,
} from "./tools/task.ts";
import type {
  PindieStateStore,
  TaskContinuityStore,
} from "./store.ts";
import type {
  PolicySnapshot,
  StrategyRevisionSelection,
  StrategyRevisionSelector,
} from "./policy.ts";
import type { CommittedRolloverPublisher } from "./long-task-control.ts";

/** Immutable optional text appended after the Core-owned system contract. */
export interface CorePromptContribution {
  readonly content: string;
}

export interface CoreIntegrationOptions {
  readonly store: PindieStateStore;
  readonly continuityStore: TaskContinuityStore;
  readonly committedRolloverPublisher?: CommittedRolloverPublisher | null;
  readonly taskHandoffEnabled?: boolean;
  readonly now?: () => number;
  readonly runTimer?: RunTimer;
  readonly runCost?: RunCostTracker;
  readonly taskMetrics?: TaskMetricsTracker;
  readonly contextGovernorTuning?: ContextGovernorTuning;
  readonly captureProjectFingerprint?: (
    projectRoot: string,
  ) => Promise<ProjectFingerprint>;
}

export interface CoreToolRegistrationOptions {
  /** Optional learned-selector resolver; omitted means Seed/base Policy only. */
  readonly resolveRevisionSelector?: (
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    ctx: ExtensionContext,
  ) => StrategyRevisionSelection | Promise<StrategyRevisionSelection>;
  /** Read-only observation after Core stages the Policy Snapshot. */
  readonly onPolicySet?: (snapshot: PolicySnapshot) => void;
  /** Read-only projection refresh after a Core semantic State transition. */
  readonly onSemanticStateChange?: () => void;
  /** Optional model-facing suffix for successful in-Run Task completion. */
  readonly completionLearningCheckpoint?: () => string | null;
}

export interface CoreSettlementFacts {
  readonly settlementGeneration: number | null;
  readonly projectRoot: string | null;
  readonly state: PindieState | null;
  readonly task: PindieTask | null;
  readonly snapshot: SemanticSnapshot | null;
  readonly runStartTaskStatus: TaskStatus | null;
  readonly runStartTaskGoal: string | null;
  readonly execution: RunExperienceExecution;
  readonly policy: RunExperiencePolicy;
  readonly durationMs: number | null;
  readonly cost: number | null;
  readonly taskConsumption: ConsumptionMetrics | null;
}

export interface CoreSettlementObserver {
  /** Called after Core claims the Run and before final authority refresh. */
  begin?(settlementGeneration: number | null): void;
  /**
   * Receives frozen Run facts before Core clears Run authority/bookkeeping.
   * Observer failure is isolated from Core settlement.
   */
  observe(facts: CoreSettlementFacts, signal?: AbortSignal): Promise<void> | void;
}

export type CoreSettlementStatus = "ignored" | "invalidated" | "settled";

export interface CoreSettlementResult {
  readonly status: CoreSettlementStatus;
  readonly facts: CoreSettlementFacts | null;
  /** Runtime-only acknowledgement that Host accepted an automatic rollover request. */
  readonly automaticSuccessorCommitted: boolean;
}

export interface CoreAuthorizationResult {
  readonly effect: ToolEffect;
  readonly snapshot: SemanticSnapshot | null;
  readonly capabilities: ReadonlySet<PindieCapability>;
  readonly decision: AuthorizationDecision | null;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneState(state: PindieState | null): PindieState | null {
  return state === null ? null : structuredClone(state);
}

function freezeMetrics(
  metrics: ConsumptionMetrics | null,
): ConsumptionMetrics | null {
  return metrics === null
    ? null
    : Object.freeze({
        durationMs: metrics.durationMs,
        cost: metrics.cost,
      });
}

/**
 * Core-owned user-facing explanation for Gateway denials. Feature integrations
 * may add no authority here; they can only provide narrow run restrictions.
 */
export function coreGatewayDenialReason(
  snapshot: SemanticSnapshot,
  requiredCapability: ToolEffect["requiredCapability"],
): string {
  if (requiredCapability === "policy.adapt") {
    return "Pindie blocked this call: Strategy Candidate creation requires a live Seed-targeted adaptation lease (explicit /adapt <strategy-id> or matching autonomously admitted learning Run). Outside an admitted Run, use /adapt <strategy-id> while the Agent is idle.";
  }
  if (requiredCapability === "policy.derive") {
    return "Pindie blocked this call: Strategy Derivation or Synthesis Candidate creation requires a live matching lease (explicit /derive or /derive-global Run, or matching autonomously admitted learning Run). Outside an admitted Run, use /derive or /derive-global as appropriate while the Agent is idle.";
  }
  if (snapshot.authority === "coherent" && requiredCapability === "task.replace") {
    if (snapshot.taskStatus === "done") {
      return `Pindie blocked this call: the completed Task is terminal and cannot be replaced. Use pindie_task_start to begin new durable work. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
    }
    if (snapshot.taskStatus === "idle") {
      return `Pindie blocked this call: There is no unfinished Task to replace. Use pindie_task_start to begin a Task. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
    }
  }

  const authority = snapshot.authority === "coherent"
    ? ""
    : ` Agent Run authority is ${snapshot.authority};`;
  if (snapshot.authority === "unavailable") {
    return `Pindie blocked this call:${authority} missing capability '${requiredCapability}'.`;
  }
  return `Pindie blocked this call:${authority} missing capability '${requiredCapability}'. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
}

/**
 * The independently loadable Pindie product foundation.
 *
 * This module deliberately imports only Core/state/Pi contracts. Optional
 * feature implementations are assembled by composition and cross this boundary
 * through the narrow resolver, prompt, state-projection, and settlement seams.
 */
export class CoreIntegration {
  readonly runtime: PindieRuntime;
  readonly run: RunIntegration;
  readonly execution: ExecutionIntegration;
  readonly handoff: TaskHandoffRuntime;
  readonly contextGovernor: ContextLifecycleGovernor;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly taskMetrics: TaskMetricsTracker;

  private readonly continuityStore: TaskContinuityStore;
  private readonly committedRolloverPublisher: CommittedRolloverPublisher | null;
  private readonly taskHandoffEnabled: boolean;
  private readonly now: () => number;
  private measurementContext: ExtensionContext | null = null;

  constructor(options: CoreIntegrationOptions) {
    this.runtime = new PindieRuntime(options.store);
    this.run = new RunIntegration(this.runtime);
    this.execution = new ExecutionIntegration({
      captureProjectFingerprint: options.captureProjectFingerprint,
    });
    this.handoff = new TaskHandoffRuntime();
    this.contextGovernor = new ContextLifecycleGovernor(options.contextGovernorTuning);
    this.runCost = options.runCost ?? new RunCostTracker();
    this.runTimer = options.runTimer ?? new RunTimer();
    this.taskMetrics = options.taskMetrics ?? new TaskMetricsTracker();
    this.continuityStore = options.continuityStore;
    this.committedRolloverPublisher = options.committedRolloverPublisher ?? null;
    this.taskHandoffEnabled = options.taskHandoffEnabled === true ||
      this.committedRolloverPublisher !== null;
    this.now = options.now ?? Date.now;
  }

  /** Register only Core tools; no feature store or adapter is constructed. */
  registerTools(
    pi: ExtensionAPI,
    options: CoreToolRegistrationOptions = {},
  ): void {
    const onSemanticStateChange = (): void => {
      this.notifySemanticStateChanged();
      options.onSemanticStateChange?.();
    };
    const onMutationUncertain = (reason: string): void => {
      this.markAuthorityUnavailable(reason);
      options.onSemanticStateChange?.();
    };
    const taskToolOptions = {
      captureTaskMetricsBaseline: (): ConsumptionMetrics => this.currentRunMetrics(),
      onTaskEpochStarted: (state: PindieState, baseline: ConsumptionMetrics) => {
        const task = state.task;
        if (this.runtime.projectRoot === null || task === null) return;
        this.taskMetrics.startTask(
          this.runtime.projectRoot,
          taskContractFingerprint(task),
          baseline,
        );
        options.onSemanticStateChange?.();
      },
      onTaskRefined: (state: PindieState) => {
        const task = state.task;
        if (this.runtime.projectRoot === null || task === null) return;
        this.taskMetrics.refineTask(
          this.runtime.projectRoot,
          taskContractFingerprint(task),
        );
        options.onSemanticStateChange?.();
      },
      onTaskCompleted: (): ConsumptionMetrics | null => {
        const result = this.taskMetrics.completeTask(this.currentRunMetrics());
        options.onSemanticStateChange?.();
        return result;
      },
      completionLearningCheckpoint: options.completionLearningCheckpoint,
      onStateChange: onSemanticStateChange,
      onMutationUncertain,
    };

    pi.registerTool(createPindiePolicySetTool({
      onPolicySet: (snapshot) => {
        this.run.setPolicySnapshot(snapshot);
        options.onPolicySet?.(snapshot);
      },
      resolveRevisionSelector: options.resolveRevisionSelector,
    }));
    pi.registerTool(createPindieTaskStartTool(this.runtime, taskToolOptions));
    pi.registerTool(createPindieTaskReplaceTool(this.runtime, taskToolOptions));
    pi.registerTool(createPindieTaskRefineTool(this.runtime, taskToolOptions));
    pi.registerTool(createPindieTaskProgressTool(this.runtime, taskToolOptions));
    pi.registerTool(createPindieVerificationRecordTool(this.runtime, {
      ...taskToolOptions,
      resolveEvidence: (refs) => this.execution.resolveVerificationEvidence(refs),
    }));
    pi.registerTool(createPindieTaskCompleteTool(this.runtime, taskToolOptions));
    if (this.taskHandoffEnabled) {
      pi.registerTool(createPindieTaskHandoffTool(this.runtime, {
        ...taskToolOptions,
        onHandoffStaged: (toolCallId, state, progressSummary, decisions) => {
          if (state.task === null) {
            throw new Error("Pindie rejected this handoff: no current Task is available to stage.");
          }
          this.handoff.stageHandoff(
            toolCallId,
            state.task,
            progressSummary,
            decisions,
          );
        },
      }));
    }
    pi.registerTool(createPindieGateOpenTool(this.runtime, {
      onStateChange: onSemanticStateChange,
      onMutationUncertain,
    }));
    pi.registerTool(createPindieGateResolveTool(this.runtime, {
      onStateChange: onSemanticStateChange,
      onMutationUncertain,
    }));
    pi.registerTool(createPindieGitObserveTool());
  }

  /** Core base contract plus immutable optional prompt/context contributions. */
  buildSystemPrompt(
    systemPrompt: string,
    contributions: readonly CorePromptContribution[] = [],
  ): string {
    let result = appendPindieSystemContract(systemPrompt);
    for (const contribution of contributions) {
      const content = contribution.content;
      if (content.trim() === "" || result.includes(content)) continue;
      result = `${result}${result.length === 0 ? "" : "\n\n"}${content}`;
    }
    return result;
  }

  classifyToolEffect(toolName: string): ToolEffect {
    return classifyToolEffect(toolName);
  }

  authorizeToolEffect(
    capabilities: ReadonlySet<PindieCapability>,
    effect: ToolEffect,
  ): AuthorizationDecision {
    return authorizeToolEffect(capabilities, effect);
  }

  /** Derive current Core authority for focused callers and Core-only tests. */
  authorizeTool(toolName: string): CoreAuthorizationResult {
    const effect = this.classifyToolEffect(toolName);
    const derivation = this.run.deriveSnapshot();
    if (!derivation.ok) {
      return {
        effect,
        snapshot: null,
        capabilities: new Set(),
        decision: null,
        error: derivation.error,
      };
    }
    const capabilities = new Set<PindieCapability>(
      deriveCapabilities(derivation.snapshot),
    );
    return {
      effect,
      snapshot: derivation.snapshot,
      capabilities,
      decision: this.authorizeToolEffect(capabilities, effect),
      error: null,
    };
  }

  setMeasurementContext(ctx: ExtensionContext | null): void {
    this.measurementContext = ctx;
  }

  resetRunMeasurements(): void {
    this.runCost.reset();
    this.runTimer.reset();
  }

  resetTaskMetrics(): void {
    this.taskMetrics.reset();
  }

  enterTaskMetricsSession(
    projectRoot: string,
    taskBinding: string | null,
  ): boolean {
    return this.taskMetrics.enterSession(projectRoot, taskBinding);
  }

  startRunMeasurements(
    ctx: ExtensionContext,
    onRefresh?: () => void,
  ): void {
    this.setMeasurementContext(ctx);
    this.runCost.start(ctx.sessionManager.getEntries());
    this.runTimer.start(ctx.hasUI ? onRefresh : undefined);
  }

  currentRunMetrics(): ConsumptionMetrics {
    const durationMs = this.runTimer.durationMs ?? 0;
    try {
      const entries = this.measurementContext?.sessionManager.getEntries() ?? [];
      return {
        durationMs,
        cost: this.runCost.snapshot(entries)?.cost ?? 0,
      };
    } catch {
      return { durationMs, cost: 0 };
    }
  }

  startRunForTask(projectRoot: string, taskBinding: string): void {
    this.taskMetrics.startRunForTask(
      projectRoot,
      taskBinding,
      this.currentRunMetrics(),
    );
  }

  startRunWithoutTask(): void {
    this.taskMetrics.startRunWithoutTask();
  }

  notifySemanticStateChanged(): void {
    this.execution.semanticStateChanged(this.runtime.externalStateEpoch);
  }

  markAuthorityUnavailable(reason: string): void {
    this.execution.semanticAuthorityUnavailable();
    this.run.markUnavailable(reason);
  }

  resetRuntimeForSession(sessionId: string | null): void {
    this.run.resetStateAuthority();
    this.resetAgentRunBookkeeping();
    if (sessionId === null) this.handoff.shutdownSession();
    else if (this.taskHandoffEnabled) this.handoff.startSession(sessionId);
    this.contextGovernor.reset();
    this.setMeasurementContext(null);
    this.resetRunMeasurements();
  }

  resetAgentRunBookkeeping(): void {
    this.run.resetAgentRun();
    this.execution.discardRuntime();
  }

  /**
   * Fail closed for one preparation generation without touching a newer Run.
   * Preparation has not crossed the measurement frontier yet, but Core still
   * owns the generation, evidence, handoff, and settlement bookkeeping.
   */
  abortAgentRunPreparation(agentRunGeneration: number): boolean {
    if (!this.run.isAgentRunCurrent(agentRunGeneration)) return false;
    this.handoff.clear();
    this.setMeasurementContext(null);
    this.resetAgentRunBookkeeping();
    return true;
  }

  beginAgentRunFacts(ctx: ExtensionContext): void {
    this.setMeasurementContext(ctx);
    this.execution.beginEvidenceScope(this.runtime.externalStateEpoch);
    this.run.beginAgentRunFacts();
    if (this.taskHandoffEnabled) {
      this.handoff.beginAgentRun(
        ctx.sessionManager.getSessionId(),
        this.run.activeAgentRunGeneration!,
      );
    }
  }

  beginAgentRun(
    ctx: ExtensionContext,
    onRefresh?: () => void,
  ): void {
    this.resetAgentRunBookkeeping();
    this.beginAgentRunFacts(ctx);
    this.startRunMeasurements(ctx, onRefresh);
  }

  async settleAgentRun(
    ctx: ExtensionContext,
    entries: readonly SessionEntry[],
    observer?: CoreSettlementObserver,
  ): Promise<CoreSettlementResult> {
    if (this.run.hasActiveAgentRun && !this.run.claimAgentRunSettlement()) {
      return { status: "ignored", facts: null, automaticSuccessorCommitted: false };
    }

    const settlementGeneration = this.run.activeAgentRunGeneration;
    const isCurrentSettlement = (): boolean =>
      settlementGeneration !== null && this.run.isAgentRunCurrent(settlementGeneration);
    const isSafeNoGenerationSettlement = (): boolean =>
      settlementGeneration === null && !this.run.hasActiveAgentRun;
    const isSettlementStillCurrent = (): boolean =>
      isCurrentSettlement() || isSafeNoGenerationSettlement();
    let automaticSuccessorCommitted = false;

    try {
      try {
        observer?.begin?.(settlementGeneration);
      } catch (error) {
        console.warn(`[Pindie] Settlement observer setup failed: ${errorMessage(error)}`);
      }

      const projectRoot = this.runtime.projectRoot;
      let finalDerivation = this.run.deriveSnapshot();
      if (
        projectRoot !== null &&
        this.run.authoritativeState !== null &&
        this.run.hasActiveAgentRun
      ) {
        try {
          await runBoundedOperation({
            label: "Pindie final Run authority refresh",
            timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
            run: (signal) => this.run.refreshAuthoritativeState(signal),
          });
          if (!isSettlementStillCurrent()) {
            return { status: "invalidated", facts: null, automaticSuccessorCommitted: false };
          }
          finalDerivation = this.run.deriveSnapshot();
        } catch {
          if (!isSettlementStillCurrent()) {
            return { status: "invalidated", facts: null, automaticSuccessorCommitted: false };
          }
          finalDerivation = {
            ok: false,
            error: "Final authority refresh failed.",
          };
        }
      }

      if (!isSettlementStillCurrent()) {
        return { status: "invalidated", facts: null, automaticSuccessorCommitted: false };
      }

      const finalState = cloneState(this.run.authoritativeState);
      const task = finalState?.task ?? null;
      const settledDurationMs = this.runTimer.finish();
      const settledCost: RunCost | null = this.runCost.finish(entries);
      const taskConsumption = this.taskMetrics.settleRun({
        durationMs: settledDurationMs ?? 0,
        cost: settledCost?.cost ?? 0,
      });
      const facts: CoreSettlementFacts = Object.freeze({
        settlementGeneration,
        projectRoot,
        state: finalState,
        task,
        snapshot: finalDerivation.ok ? finalDerivation.snapshot : null,
        runStartTaskStatus: this.run.taskStatusAtRunStart,
        runStartTaskGoal: this.run.taskGoalAtRunStart,
        execution: this.run.executionCounters,
        policy: this.run.policyAttribution,
        durationMs: settledDurationMs,
        cost: settledCost?.cost ?? null,
        taskConsumption: freezeMetrics(taskConsumption),
      });

      if (observer !== undefined) {
        try {
          await runBoundedOperation({
            label: "Pindie Run settlement observer",
            timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
            run: (signal) => Promise.resolve(observer.observe(facts, signal)),
          });
        } catch (error) {
          console.warn(`[Pindie] Settlement observer failed: ${errorMessage(error)}`);
        }
      }

      if (!isSettlementStillCurrent()) {
        return { status: "invalidated", facts, automaticSuccessorCommitted: false };
      }

      try {
        await runBoundedOperation({
          label: "Pindie Task handoff settlement",
          timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
          run: async (signal) => {
            automaticSuccessorCommitted = await this.settleTaskHandoff(ctx, settlementGeneration, signal);
          },
        });
      } catch (error) {
        console.warn(`[Pindie] Task handoff settlement failed closed: ${errorMessage(error)}`);
      }

      if (!isSettlementStillCurrent()) {
        return { status: "invalidated", facts, automaticSuccessorCommitted: false };
      }
      return { status: "settled", facts, automaticSuccessorCommitted };
    } finally {
      if (isSettlementStillCurrent()) {
        this.handoff.clear();
        try {
          this.execution.discardRuntime();
        } finally {
          this.run.resetAgentRun();
        }
      }
    }
  }

  private async settleTaskHandoff(
    ctx: ExtensionContext,
    settlementGeneration: number | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const pending = this.handoff.pendingHandoff;
    if (pending === null) return false;

    const failClosed = (): void => this.handoff.clearHandoffIfCurrent(pending);
    try {
      signal?.throwIfAborted();
      if (
        settlementGeneration === null ||
        !this.run.isAgentRunCurrent(settlementGeneration) ||
        !this.handoff.isPendingFor(pending.sourceSessionId, pending.agentRunGeneration)
      ) {
        failClosed();
        return false;
      }

      let currentSessionId: string;
      try {
        currentSessionId = ctx.sessionManager.getSessionId();
        if (ctx.hasPendingMessages()) {
          failClosed();
          return false;
        }
      } catch {
        failClosed();
        return false;
      }
      if (
        currentSessionId !== pending.sourceSessionId ||
        this.handoff.currentSessionId !== pending.sourceSessionId ||
        this.runtime.projectRoot === null
      ) {
        failClosed();
        return false;
      }

      signal?.throwIfAborted();
      await this.run.refreshAuthoritativeState(signal);
      signal?.throwIfAborted();
      if (
        !this.run.isAgentRunCurrent(settlementGeneration) ||
        !this.handoff.isPendingFor(pending.sourceSessionId, pending.agentRunGeneration)
      ) {
        failClosed();
        return false;
      }

      const derivation = this.run.deriveSnapshot();
      const state = this.run.authoritativeState;
      const task = state?.task ?? null;
      if (!derivation.ok || derivation.snapshot.authority !== "coherent") {
        failClosed();
        return false;
      }
      if (
        derivation.snapshot.taskStatus !== "active" ||
        task === null ||
        task.completed ||
        task.humanGate !== null ||
        task.openLoops.blockers.length > 0 ||
        taskContractFingerprint(task) !== pending.taskFingerprint
      ) {
        failClosed();
        return false;
      }

      try {
        signal?.throwIfAborted();
        if (ctx.hasPendingMessages()) {
          failClosed();
          return false;
        }
      } catch {
        failClosed();
        return false;
      }

      let checkpoint;
      try {
        checkpoint = createTaskContinuity({
          createdAt: new Date(this.now()).toISOString(),
          taskFingerprint: pending.taskFingerprint,
          sourceSessionId: pending.sourceSessionId,
          progressSummary: pending.progressSummary,
          decisions: pending.decisions,
        });
        signal?.throwIfAborted();
        await this.continuityStore.save(this.runtime.projectRoot, checkpoint, signal);
        signal?.throwIfAborted();
      } catch (error) {
        console.warn(`[Pindie] Dropped Task continuity checkpoint: ${errorMessage(error)}`);
        failClosed();
        throw error;
      }
      if (
        !this.run.isAgentRunCurrent(settlementGeneration) ||
        !this.handoff.isPendingFor(pending.sourceSessionId, pending.agentRunGeneration)
      ) {
        failClosed();
        return false;
      }
      signal?.throwIfAborted();
      let automaticSuccessorCommitted = false;
      if (this.committedRolloverPublisher !== null) {
        try {
          if (checkpoint.sourceSessionId !== pending.sourceSessionId) {
            throw new Error("Committed continuity checkpoint Session identity did not match the pending handoff.");
          }
          automaticSuccessorCommitted = this.committedRolloverPublisher({
            sourceSessionId: checkpoint.sourceSessionId,
            checkpoint,
          }) === true;
        } catch (error) {
          console.warn(`[Pindie] Committed Task continuity checkpoint could not reach Host rollover control: ${errorMessage(error)}`);
        }
      }
      failClosed();
      return automaticSuccessorCommitted;
    } catch (error) {
      failClosed();
      throw error;
    }
  }
}

export function createCoreIntegration(
  options: CoreIntegrationOptions,
): CoreIntegration {
  return new CoreIntegration(options);
}

export function corePromptContribution(content: string): CorePromptContribution {
  return Object.freeze({ content });
}
