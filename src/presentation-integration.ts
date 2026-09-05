import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  deriveCandidateTrialReview,
  deriveExperienceEvaluation,
  deriveStrategyDerivationTrialReview,
  formatCandidateTrialReview,
  formatExperienceReport,
  formatStrategyDerivationTrialReview,
} from "./experience-evaluation.ts";
import type { RunExperienceReader } from "./experience-store.ts";
import {
  isCanonicalStrategyCandidateId,
  type StrategyCandidateReader,
} from "./strategy-candidates.ts";
import {
  validateStrategyRevisionDecisionBinding,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  validateStrategyDerivationDecisionBinding,
  validateStrategyDerivationDecisionProjectBinding,
  type StrategyDerivationDecisionReader,
} from "./strategy-derivation-decisions.ts";
import { resolveTrialCandidate } from "./strategy-candidate-resolution.ts";
import type { StrategyDerivationCandidateReader } from "./strategy-derivation-candidates.ts";
import type { TrustedStrategyPortfolio } from "./strategy-portfolio.ts";
import {
  deriveEfficiencySnapshot,
  formatEfficiencyReport,
} from "./efficiency.ts";
import { ReasoningController } from "./reasoning.ts";
import { RunActivityTracker } from "./run-activity.ts";
import { RunCostTracker, type RunCost } from "./run-cost.ts";
import { RunTimer } from "./run-timer.ts";
import type { PindieState } from "./state.ts";
import {
  TaskMetricsTracker,
  type ConsumptionMetrics,
} from "./task-metrics.ts";
import {
  deriveStatusLayout,
  renderStatusLayout,
} from "./status-line.ts";
import {
  chatGptSubscriptionUsageProvider,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
} from "./subscription-usage.ts";

const PINDIE_STATUS_ID = "pindie-status";

export interface PresentationIntegrationOptions {
  getState: () => PindieState | null;
  getProjectRoot: () => string | null;
  experienceReader: RunExperienceReader;
  strategyCandidateReader: StrategyCandidateReader;
  strategyDerivationCandidateReader: StrategyDerivationCandidateReader;
  strategyDecisionReader?: StrategyRevisionDecisionReader;
  strategyDerivationDecisionReader?: StrategyDerivationDecisionReader;
  loadTrustedPortfolio?: (projectRoot: string) => Promise<TrustedStrategyPortfolio>;
  getAuthoritativeState: () => PindieState | null;
  getStateUnavailableReason: () => string | null;
  getRunStale: () => boolean;
  subscriptionUsageProvider?: SubscriptionUsageProvider;
  getStatusWidth?: () => number | undefined;
  now?: () => number;
  activityLingerMs?: number;
  scheduleActivityRefresh?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearActivityRefresh?: (timer: ReturnType<typeof setTimeout>) => void;
  runTimer?: RunTimer;
  runCost?: RunCostTracker;
  taskMetrics?: TaskMetricsTracker;
}

/** Runtime-only reasoning, activity, efficiency, and status presentation ownership. */
export class PresentationIntegration {
  private readonly pi: ExtensionAPI;
  readonly reasoning = new ReasoningController();
  readonly runActivity: RunActivityTracker;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly taskMetrics: TaskMetricsTracker;
  private readonly getState: () => PindieState | null;
  private readonly getProjectRoot: () => string | null;
  private readonly experienceReader: RunExperienceReader;
  private readonly strategyCandidateReader: StrategyCandidateReader;
  private readonly strategyDerivationCandidateReader: StrategyDerivationCandidateReader;
  private readonly strategyDecisionReader: StrategyRevisionDecisionReader | null;
  private readonly strategyDerivationDecisionReader: StrategyDerivationDecisionReader | null;
  private readonly loadTrustedPortfolio: ((projectRoot: string) => Promise<TrustedStrategyPortfolio>) | null;
  private readonly getAuthoritativeState: () => PindieState | null;
  private readonly getStateUnavailableReason: () => string | null;
  private readonly getRunStale: () => boolean;
  private readonly subscriptionUsageProvider: SubscriptionUsageProvider;
  private readonly getStatusWidth: () => number | undefined;
  private readonly now: () => number;
  private readonly scheduleActivityRefresh: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearActivityRefresh: (
    timer: ReturnType<typeof setTimeout>,
  ) => void;
  private statusContext: ExtensionContext | null = null;
  private subscriptionUsage: SubscriptionUsageSnapshot | null = null;
  private lastUsageFetchAt: number | null = null;
  private activityLingerTimer: ReturnType<typeof setTimeout> | null = null;
  private activityLingerGeneration = 0;

  constructor(pi: ExtensionAPI, options: PresentationIntegrationOptions) {
    this.pi = pi;
    this.getState = options.getState;
    this.getProjectRoot = options.getProjectRoot;
    this.experienceReader = options.experienceReader;
    this.strategyCandidateReader = options.strategyCandidateReader;
    this.strategyDerivationCandidateReader = options.strategyDerivationCandidateReader;
    this.strategyDecisionReader = options.strategyDecisionReader ?? null;
    this.strategyDerivationDecisionReader = options.strategyDerivationDecisionReader ?? null;
    this.loadTrustedPortfolio = options.loadTrustedPortfolio ?? null;
    this.getAuthoritativeState = options.getAuthoritativeState;
    this.getStateUnavailableReason = options.getStateUnavailableReason;
    this.getRunStale = options.getRunStale;
    this.subscriptionUsageProvider = options.subscriptionUsageProvider ??
      chatGptSubscriptionUsageProvider;
    this.getStatusWidth = options.getStatusWidth ??
      (() => process.stdout.columns);
    this.now = options.now ?? Date.now;
    this.runCost = options.runCost ?? new RunCostTracker();
    this.runTimer = options.runTimer ?? new RunTimer();
    this.taskMetrics = options.taskMetrics ?? new TaskMetricsTracker();
    this.runActivity = new RunActivityTracker({
      now: this.now,
      lingerMs: options.activityLingerMs,
    });
    this.scheduleActivityRefresh = (callback, delayMs) =>
      options.scheduleActivityRefresh?.(callback, delayMs) ??
      (setTimeout(callback, delayMs) as ReturnType<typeof setTimeout>);
    this.clearActivityRefresh = (timer) => {
      if (options.clearActivityRefresh) options.clearActivityRefresh(timer);
      else clearTimeout(timer);
    };
  }

  setStatusContext(ctx: ExtensionContext | null): void {
    this.statusContext = ctx;
  }

  resetTrackers(): void {
    this.clearActivityLingerRefresh();
    this.reasoning.reset(this.pi.getThinkingLevel());
    this.runActivity.reset();
    this.runCost.reset();
    this.runTimer.reset();
  }

  resetSubscriptionUsage(): void {
    this.subscriptionUsage = null;
    this.lastUsageFetchAt = null;
  }

  clearStatus(ctx: ExtensionContext): void {
    this.presentStatusBestEffort(ctx, () => undefined);
  }

  refreshStatus(ctx = this.statusContext): void {
    this.presentStatusBestEffort(ctx, (activeContext) => {
      const runDurationMs = this.runTimer.durationMs;
      const runCost = this.runCost.snapshot(
        activeContext.sessionManager.getEntries(),
      );
      const runMetrics = runDurationMs === null
        ? null
        : {
            durationMs: runDurationMs,
            cost: runCost?.cost ?? 0,
          };
      const taskMetrics = runMetrics === null
        ? null
        : this.taskMetrics.snapshot(runMetrics);
      const layout = deriveStatusLayout({
        consumption: runMetrics === null
          ? null
          : taskMetrics === null
            ? { scope: "run", ...runMetrics }
            : { scope: "task", ...taskMetrics },
        reasoningMode: this.reasoning.snapshot.mode,
        activity: this.runActivity.activity,
        state: this.getState(),
        stateUnavailableReason: this.getStateUnavailableReason(),
        runStale: this.runTimer.active &&
          this.getAuthoritativeState() !== null &&
          this.getRunStale(),
        subscriptionUsage: this.subscriptionUsage,
      }, this.now());
      return renderStatusLayout(
        activeContext.ui.theme,
        layout,
        this.getStatusWidth(),
      );
    });
  }

  async refreshSubscriptionUsage(ctx: ExtensionContext): Promise<void> {
    if (
      this.lastUsageFetchAt !== null &&
      this.now() - this.lastUsageFetchAt < 5 * 60_000
    ) {
      return;
    }
    this.lastUsageFetchAt = this.now();
    try {
      const next = await this.subscriptionUsageProvider.fetchUsage(ctx);
      if (next) this.subscriptionUsage = next;
    } catch {
      // Account observation is runtime-only and intentionally silent.
    }
    this.refreshStatus(ctx);
  }

  applyRequestedThinkingLevel(): void {
    if (this.reasoning.snapshot.mode === "manual") return;
    this.pi.setThinkingLevel(this.reasoning.snapshot.requestedLevel);
    this.reasoning.synchronizeEffective(this.pi.getThinkingLevel());
  }

  reasoningStatus(): string {
    const { mode, requestedLevel, effectiveLevel } = this.reasoning.snapshot;
    return `Reasoning: ${mode}; requested ${requestedLevel}; effective ${effectiveLevel}.`;
  }

  clearActivityLingerRefresh(): void {
    this.activityLingerGeneration += 1;
    const timer = this.activityLingerTimer;
    this.activityLingerTimer = null;
    if (timer === null) return;
    try {
      this.clearActivityRefresh(timer);
    } catch {
      // Presentation cleanup must not alter semantic or runtime behavior.
    }
  }

  scheduleActivityLingerRefresh(): void {
    this.clearActivityLingerRefresh();
    const delayMs = this.runActivity.nextPresentationChangeInMs;
    if (delayMs === null) return;
    const generation = this.activityLingerGeneration;
    try {
      this.activityLingerTimer = this.scheduleActivityRefresh(() => {
        if (generation !== this.activityLingerGeneration) return;
        this.activityLingerTimer = null;
        this.refreshStatus();
      }, delayMs);
    } catch {
      // Presentation scheduling must not alter semantic or runtime behavior.
    }
  }

  startTimer(ctx: ExtensionContext): void {
    this.runTimer.start(ctx.hasUI ? () => this.refreshStatus(ctx) : undefined);
  }

  currentRunMetrics(): ConsumptionMetrics {
    const durationMs = this.runTimer.durationMs ?? 0;
    try {
      const entries = this.statusContext?.sessionManager.getEntries() ?? [];
      return {
        durationMs,
        cost: this.runCost.snapshot(entries)?.cost ?? 0,
      };
    } catch {
      // Runtime presentation telemetry must never disrupt semantic Task tools.
      return { durationMs, cost: 0 };
    }
  }

  enterSession(projectRoot: string, taskBinding: string | null): boolean {
    return this.taskMetrics.enterSession(projectRoot, taskBinding);
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

  startTask(projectRoot: string, taskBinding: string, baseline: ConsumptionMetrics): void {
    this.taskMetrics.startTask(projectRoot, taskBinding, baseline);
  }

  refineTask(projectRoot: string, taskBinding: string): void {
    this.taskMetrics.refineTask(projectRoot, taskBinding);
  }

  completeTask(): ConsumptionMetrics | null {
    return this.taskMetrics.completeTask(this.currentRunMetrics());
  }

  settleTaskRun(metrics: ConsumptionMetrics): ConsumptionMetrics | null {
    return this.taskMetrics.settleRun(metrics);
  }

  handleEfficiencyCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): void {
    if (args.trim()) {
      ctx.ui.notify("Usage: /efficiency", "warning");
      return;
    }
    const entries = ctx.sessionManager.getEntries();
    const report = formatEfficiencyReport(deriveEfficiencySnapshot({
      entries,
      contextUsage: ctx.getContextUsage(),
      reasoning: this.reasoning.snapshot,
      runCost: this.runCost.snapshot(entries),
    }));
    ctx.ui.notify(report, "info");
  }

  async handleExperienceCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    if (args.trim()) {
      ctx.ui.notify("Usage: /experience", "warning");
      return;
    }
    const projectRoot = this.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not show /experience: no current project root is loaded.", "warning");
      return;
    }
    try {
      const read = await this.experienceReader.read(projectRoot);
      ctx.ui.notify(
        formatExperienceReport(read, deriveExperienceEvaluation(read.records)),
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not read Pindie Experience: ${message}`, "warning");
    }
  }

  async handleTrialReviewCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trial-review <candidate-id>", "warning");
      return;
    }
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      ctx.ui.notify(
        "Pindie could not show Trial review: candidate-id must be a canonical lowercase UUID-v4.",
        "warning",
      );
      return;
    }
    const projectRoot = this.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not show Trial review: no current project root is loaded.", "warning");
      return;
    }

    let candidateRef;
    try {
      candidateRef = await resolveTrialCandidate({
        projectRoot,
        candidateId: requestedId,
        revisionReader: this.strategyCandidateReader,
        derivationReader: this.strategyDerivationCandidateReader,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Pindie could not show Trial review: Candidate resolution failed: ${message}`, "warning");
      return;
    }
    if (candidateRef === null) {
      ctx.ui.notify(
        `Pindie could not show Trial review: Candidate '${requestedId}' was not found for this project.`,
        "warning",
      );
      return;
    }

    let read;
    try {
      read = await this.experienceReader.read(projectRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Pindie could not show Trial review: Experience reading failed: ${message}`, "warning");
      return;
    }
    if (this.getProjectRoot() !== projectRoot) {
      ctx.ui.notify(
        "Pindie could not show Trial review: the current project changed while reading evidence.",
        "warning",
      );
      return;
    }

    if (candidateRef.kind === "revision") {
      const candidate = candidateRef.candidate;
      let priorTerminalDecision = false;
      if (this.strategyDecisionReader !== null) {
        try {
          const decision = await this.strategyDecisionReader.read(projectRoot, requestedId);
          if (decision !== null) {
            validateStrategyRevisionDecisionBinding(decision, candidate);
            priorTerminalDecision = true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Pindie could not show Trial review: Decision read/binding failed: ${message}`, "warning");
          return;
        }
      }
      try {
        const review = deriveCandidateTrialReview(candidate, read.records, {
          currentProjectMatch: true,
          priorTerminalDecision,
        });
        ctx.ui.notify(formatCandidateTrialReview(read, review), "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Pindie could not show Trial review: evidence evaluation failed: ${message}`, "warning");
      }
      return;
    }

    let priorTerminalDecision = false;
    if (this.strategyDerivationDecisionReader !== null) {
      try {
        const decision = await this.strategyDerivationDecisionReader.read(projectRoot, requestedId);
        if (decision !== null) {
          validateStrategyDerivationDecisionProjectBinding(decision, projectRoot);
          validateStrategyDerivationDecisionBinding(decision, candidateRef.candidate);
          priorTerminalDecision = true;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Pindie could not show Trial review: Derivation Decision read/binding failed: ${message}`, "warning");
        return;
      }
    }

    let currentPortfolio: TrustedStrategyPortfolio | null = null;
    if (this.loadTrustedPortfolio !== null) {
      try {
        currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
      } catch {
        // Historical source provenance remains inspectable when current trust
        // cannot be reconstructed; the current-portfolio gate stays false.
        currentPortfolio = null;
      }
    }
    if (this.getProjectRoot() !== projectRoot) {
      ctx.ui.notify(
        "Pindie could not show Trial review: the current project changed while reading trust artifacts.",
        "warning",
      );
      return;
    }
    try {
      const review = await deriveStrategyDerivationTrialReview(
        candidateRef.candidate,
        read.records,
        {
          projectRoot,
          currentPortfolio,
          revisionCandidateReader: this.strategyCandidateReader,
          revisionDecisionReader: this.strategyDecisionReader ?? undefined,
          derivationCandidateReader: this.strategyDerivationCandidateReader,
          derivationDecisionReader: this.strategyDerivationDecisionReader ?? undefined,
          priorTerminalDecision,
        },
      );
      ctx.ui.notify(formatStrategyDerivationTrialReview(read, review), "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Pindie could not show Trial review: evidence evaluation failed: ${message}`, "warning");
    }
  }

  async handleReasoningCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let value = args.trim().toLowerCase();
    if (!value && ctx.mode === "tui") {
      const selected = await ctx.ui.select("Reasoning", ["auto", "manual"]);
      if (!selected) return;
      value = selected;
    }
    if (value === "auto") this.reasoning.setAuto();
    else if (value === "manual") this.reasoning.setManual();
    else {
      ctx.ui.notify("Usage: /reasoning [auto|manual]", "warning");
      return;
    }
    this.applyRequestedThinkingLevel();
    this.refreshStatus(ctx);
    ctx.ui.notify(this.reasoningStatus(), "info");
  }

  handleTurnEnd(
    state: PindieState,
    toolResults: readonly { toolName: string; isError: boolean }[],
    ctx: ExtensionContext,
  ): void {
    if (this.reasoning.decideNext(state, toolResults)) {
      this.applyRequestedThinkingLevel();
      this.refreshStatus(ctx);
    }
  }

  synchronizeThinkingLevel(
    level: Parameters<ReasoningController["synchronizeEffective"]>[0],
    ctx: ExtensionContext,
  ): void {
    this.reasoning.synchronizeEffective(level);
    this.refreshStatus(ctx);
  }

  startCost(entries: readonly SessionEntry[]): void {
    this.runCost.start(entries);
  }

  finishCost(entries: readonly SessionEntry[]): RunCost | null {
    return this.runCost.finish(entries);
  }

  private presentStatusBestEffort(
    ctx: ExtensionContext | null,
    getStatus: (activeContext: ExtensionContext) => string | undefined,
  ): void {
    try {
      if (!ctx?.hasUI) return;
      ctx.ui.setStatus(PINDIE_STATUS_ID, getStatus(ctx));
    } catch {
      // Status presentation must not alter semantic or runtime behavior.
    }
  }
}
