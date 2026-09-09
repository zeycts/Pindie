import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

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
  /** Core-owned measurement sources consumed by Presentation. */
  runTimer: RunTimer;
  runCost: RunCostTracker;
  taskMetrics: TaskMetricsTracker;
  uiEnabled?: boolean;
}

/** Runtime-only reasoning, activity, efficiency, and status presentation ownership. */
export class PresentationIntegration {
  private readonly pi: ExtensionAPI;
  private readonly uiEnabled: boolean;
  readonly reasoning: ReasoningController | null;
  readonly runActivity: RunActivityTracker | null;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly taskMetrics: TaskMetricsTracker;
  private readonly getState: () => PindieState | null;
  private readonly getProjectRoot: () => string | null;
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
    this.uiEnabled = options.uiEnabled !== false;
    this.reasoning = this.uiEnabled ? new ReasoningController() : null;
    this.runActivity = this.uiEnabled
      ? new RunActivityTracker({
          now: options.now ?? Date.now,
          lingerMs: options.activityLingerMs,
        })
      : null;
    this.getState = options.getState;
    this.getProjectRoot = options.getProjectRoot;
    this.getAuthoritativeState = options.getAuthoritativeState;
    this.getStateUnavailableReason = options.getStateUnavailableReason;
    this.getRunStale = options.getRunStale;
    this.subscriptionUsageProvider = options.subscriptionUsageProvider ??
      chatGptSubscriptionUsageProvider;
    this.getStatusWidth = options.getStatusWidth ??
      (() => process.stdout.columns);
    this.now = options.now ?? Date.now;
    this.runCost = options.runCost;
    this.runTimer = options.runTimer;
    this.taskMetrics = options.taskMetrics;
    this.scheduleActivityRefresh = (callback, delayMs) =>
      options.scheduleActivityRefresh?.(callback, delayMs) ??
      (setTimeout(callback, delayMs) as ReturnType<typeof setTimeout>);
    this.clearActivityRefresh = (timer) => {
      if (options.clearActivityRefresh) options.clearActivityRefresh(timer);
      else clearTimeout(timer);
    };
  }

  setStatusContext(ctx: ExtensionContext | null): void {
    this.statusContext = this.uiEnabled ? ctx : null;
  }

  resetTrackers(): void {
    if (!this.uiEnabled) return;
    this.clearActivityLingerRefresh();
    this.reasoning?.reset(this.pi.getThinkingLevel());
    this.runActivity?.reset();
    // RunCostTracker, RunTimer, and TaskMetricsTracker are Core-owned
    // measurement sources. Presentation only consumes their current facts.
  }

  resetSubscriptionUsage(): void {
    this.subscriptionUsage = null;
    this.lastUsageFetchAt = null;
  }

  clearStatus(ctx: ExtensionContext): void {
    if (!this.uiEnabled) return;
    this.presentStatusBestEffort(ctx, () => undefined);
  }

  refreshStatus(ctx = this.statusContext): void {
    if (!this.uiEnabled) return;
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
        reasoningMode: this.reasoning?.snapshot.mode ?? null,
        activity: this.runActivity?.activity ?? null,
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
    if (!this.uiEnabled) return;
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
    const reasoning = this.reasoning;
    if (reasoning === null || reasoning.snapshot.mode === "manual") return;
    this.pi.setThinkingLevel(reasoning.snapshot.requestedLevel);
    reasoning.synchronizeEffective(this.pi.getThinkingLevel());
  }

  reasoningStatus(): string {
    const snapshot = this.reasoning?.snapshot;
    if (snapshot === undefined) return "Reasoning presentation is disabled.";
    const { mode, requestedLevel, effectiveLevel } = snapshot;
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
    const runActivity = this.runActivity;
    if (runActivity === null) return;
    this.clearActivityLingerRefresh();
    const delayMs = runActivity.nextPresentationChangeInMs;
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
    if (!this.uiEnabled) return;
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
    const reasoning = this.reasoning;
    if (reasoning === null) return;
    if (args.trim()) {
      ctx.ui.notify("Usage: /efficiency", "warning");
      return;
    }
    const entries = ctx.sessionManager.getEntries();
    const report = formatEfficiencyReport(deriveEfficiencySnapshot({
      entries,
      contextUsage: ctx.getContextUsage(),
      reasoning: reasoning.snapshot,
      runCost: this.runCost.snapshot(entries),
    }));
    ctx.ui.notify(report, "info");
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
    const reasoning = this.reasoning;
    if (reasoning === null) return;
    if (value === "auto") reasoning.setAuto();
    else if (value === "manual") reasoning.setManual();
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
    if (this.reasoning?.decideNext(state, toolResults)) {
      this.applyRequestedThinkingLevel();
      this.refreshStatus(ctx);
    }
  }

  synchronizeThinkingLevel(
    level: Parameters<ReasoningController["synchronizeEffective"]>[0],
    ctx: ExtensionContext,
  ): void {
    this.reasoning?.synchronizeEffective(level);
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
