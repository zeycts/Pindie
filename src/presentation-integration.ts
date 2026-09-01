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
}

/** Runtime-only reasoning, activity, efficiency, and status presentation ownership. */
export class PresentationIntegration {
  private readonly pi: ExtensionAPI;
  readonly reasoning = new ReasoningController();
  readonly runActivity: RunActivityTracker;
  readonly runCost = new RunCostTracker();
  readonly runTimer = new RunTimer();
  private readonly getState: () => PindieState | null;
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
    this.getAuthoritativeState = options.getAuthoritativeState;
    this.getStateUnavailableReason = options.getStateUnavailableReason;
    this.getRunStale = options.getRunStale;
    this.subscriptionUsageProvider = options.subscriptionUsageProvider ??
      chatGptSubscriptionUsageProvider;
    this.getStatusWidth = options.getStatusWidth ??
      (() => process.stdout.columns);
    this.now = options.now ?? Date.now;
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
      const layout = deriveStatusLayout({
        timing: this.runTimer.durationMs === null
          ? null
          : {
              durationMs: this.runTimer.durationMs,
              active: this.runTimer.active,
            },
        runCost: this.runCost.snapshot(
          activeContext.sessionManager.getEntries(),
        ),
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
