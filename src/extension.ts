import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieRuntimeContextMessage,
  isPindieRuntimeContextMessage,
} from "./context.ts";
import {
  authorizeToolEffect,
  classifyToolEffect,
  type ToolEffect,
} from "./execution-semantics.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import {
  captureProjectFingerprint as defaultCaptureProjectFingerprint,
  type ProjectFingerprint,
} from "./project-mutation.ts";
import { ReasoningController } from "./reasoning.ts";
import {
  deriveEfficiencySnapshot,
  formatEfficiencyReport,
} from "./efficiency.ts";
import { RunActivityTracker } from "./run-activity.ts";
import { RunCostTracker } from "./run-cost.ts";
import { RunTimer } from "./run-timer.ts";
import {
  beginAgentRunFacts,
  deriveSemanticRunFacts,
  recordSuccessfulCapability,
  type AgentRunFactsContext,
} from "./run-facts.ts";
import { PindieRuntime } from "./runtime.ts";
import {
  deriveCapabilities,
  deriveSemanticSnapshot,
  type SemanticSnapshot,
} from "./semantics.ts";
import { deriveEffectiveToolNames } from "./tool-surface.ts";
import { StateLockBusyError } from "./store.ts";
import { validateState } from "./state.ts";
import {
  deriveStatusLayout,
  renderStatusLayout,
} from "./status-line.ts";
import {
  chatGptSubscriptionUsageProvider,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
} from "./subscription-usage.ts";
import { FileStateStore, type PindieStateStore } from "./store.ts";
import {
  createPindieGateOpenTool,
  createPindieGateResolveTool,
} from "./tools/gate.ts";
import { createPindieGitObserveTool } from "./tools/git-observe.ts";
import {
  createPindieTaskCompleteTool,
  createPindieTaskProgressTool,
  createPindieTaskRefineTool,
  createPindieTaskReplaceTool,
  createPindieTaskStartTool,
  createPindieVerificationRecordTool,
} from "./tools/task.ts";

type ProjectRootResolver = (cwd: string) => Promise<string>;

export interface PindieExtensionOptions {
  store?: PindieStateStore;
  resolveProjectRoot?: ProjectRootResolver;
  subscriptionUsageProvider?: SubscriptionUsageProvider;
  getStatusWidth?: () => number | undefined;
  now?: () => number;
  /** Internal test seams for runtime-only activity presentation expiry. */
  activityLingerMs?: number;
  scheduleActivityRefresh?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearActivityRefresh?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Internal test seam for runtime-only project mutation observation. */
  captureProjectFingerprint?: (projectRoot: string) => Promise<ProjectFingerprint>;
}

export interface PindieExtensionIntegration {
  readonly runtime: PindieRuntime;
  readonly runActivity: RunActivityTracker;
  readonly reasoning: ReasoningController;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly stateUnavailableReason: string | null;
}

const PINDIE_STATUS_ID = "pindie-status";
const PINDIE_ACTIVE_TASK_CONTINUATION_TYPE = "pindie-active-task-continuation";
const PINDIE_ACTIVE_TASK_CONTINUATION_MESSAGE = "The current Pindie Task is still unfinished. First re-evaluate whether the latest actual user intent calls for consequential execution of this current Task. If it clearly requests a different Task, reconcile it through pindie_task_replace when this Agent Run boundary permits, then continue only the new current Task. If it asks to stop, pause, return control, or only inspect, explain, or discuss, do not resume consequential Task work; allow this Agent Run to settle normally. If the Task boundary is consequentially ambiguous, use the existing Human Gate or return control appropriately. Otherwise continue this current Task now. Re-observe only what is necessary, then take the smallest safe next action. Do not stop merely to summarize remaining work, restate next steps, re-plan, or because more implementation, test, or verification iterations are required. If consequential human judgment is genuinely required, use the existing Human Gate. If a real external blocker prevents progress, record it. Otherwise continue toward current verified completion. Persisting nextIntent records continuation context; it is not permission to yield.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MutationWindow {
  projectRoot: string;
  baseline: ProjectFingerprint;
  pendingToolCallIds: Set<string>;
}

const STALE_EXTENSION_CONTEXT_ERROR = "This extension ctx is stale after session replacement or reload.";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR);
}

function gatewayDenialReason(
  snapshot: SemanticSnapshot,
  requiredCapability: ToolEffect["requiredCapability"],
): string {
  const authority = snapshot.authority === "coherent"
    ? ""
    : ` Agent Run authority is ${snapshot.authority};`;
  if (snapshot.authority === "unavailable") {
    return `Pindie blocked this call:${authority} missing capability '${requiredCapability}'.`;
  }
  return `Pindie blocked this call:${authority} missing capability '${requiredCapability}'. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
}

export function registerPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions = {},
): PindieExtensionIntegration {
  const runtime = new PindieRuntime(options.store ?? new FileStateStore());
  const reasoning = new ReasoningController();
  const now = options.now ?? Date.now;
  const runActivity = new RunActivityTracker({
    now,
    lingerMs: options.activityLingerMs,
  });
  const runCost = new RunCostTracker();
  const runTimer = new RunTimer();
  const resolveProjectRoot =
    options.resolveProjectRoot ?? defaultResolveProjectRoot;
  const captureProjectFingerprint =
    options.captureProjectFingerprint ?? defaultCaptureProjectFingerprint;
  let mutationWindow: MutationWindow | null = null;
  const authorizedToolEffects = new Map<string, ToolEffect>();
  const subscriptionUsageProvider =
    options.subscriptionUsageProvider ?? chatGptSubscriptionUsageProvider;
  const scheduleActivityRefresh = (
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> =>
    options.scheduleActivityRefresh?.(callback, delayMs) ??
    (setTimeout(callback, delayMs) as ReturnType<typeof setTimeout>);
  const clearActivityRefresh = (timer: ReturnType<typeof setTimeout>): void => {
    if (options.clearActivityRefresh) options.clearActivityRefresh(timer);
    else clearTimeout(timer);
  };
  const getStatusWidth = options.getStatusWidth ?? (() => process.stdout.columns);
  let subscriptionUsage: SubscriptionUsageSnapshot | null = null;
  let lastUsageFetchAt: number | null = null;
  let stateUnavailableReason: string | null = null;
  let statusContext: ExtensionContext | null = null;
  let agentRunFactsContext: AgentRunFactsContext | null = null;
  let runToolBaseline: readonly string[] | null = null;
  let activeTaskContinuationAttempted = false;
  let activityLingerTimer: ReturnType<typeof setTimeout> | null = null;
  let activityLingerGeneration = 0;

  const clearActivityLingerRefresh = (): void => {
    activityLingerGeneration += 1;
    const timer = activityLingerTimer;
    activityLingerTimer = null;
    if (timer === null) return;
    try {
      clearActivityRefresh(timer);
    } catch {
      // Presentation cleanup must not alter semantic or runtime behavior.
    }
  };

  const scheduleActivityLingerRefresh = (): void => {
    clearActivityLingerRefresh();
    const delayMs = runActivity.nextPresentationChangeInMs;
    if (delayMs === null) return;
    const generation = activityLingerGeneration;
    try {
      activityLingerTimer = scheduleActivityRefresh(() => {
        if (generation !== activityLingerGeneration) return;
        activityLingerTimer = null;
        refreshStatus();
      }, delayMs);
    } catch {
      // Presentation scheduling must not alter semantic or runtime behavior.
    }
  };

  const clearAgentRunBookkeeping = (): void => {
    agentRunFactsContext = null;
    activeTaskContinuationAttempted = false;
    authorizedToolEffects.clear();
  };

  const currentAuthoritativeState = () =>
    runtime.projectRoot === null || stateUnavailableReason !== null
      ? null
      : runtime.state;

  const currentSemanticRunFacts = () => deriveSemanticRunFacts(
    agentRunFactsContext,
    currentAuthoritativeState(),
    runtime.externalStateEpoch,
  );

  const currentAgentRunIsStale = (): boolean => {
    const facts = currentSemanticRunFacts();
    return facts.stateAvailable && !facts.runCoherent;
  };

  const sameToolNames = (
    left: readonly string[],
    right: readonly string[],
  ): boolean =>
    left.length === right.length && left.every((name, index) => name === right[index]);

  const applyToolSurface = (
    capabilities: ReturnType<typeof deriveCapabilities>,
  ): void => {
    if (runToolBaseline === null) return;
    const effective = deriveEffectiveToolNames(runToolBaseline, capabilities);
    if (!sameToolNames(pi.getActiveTools(), effective)) {
      pi.setActiveTools(effective);
    }
  };

  const restoreRunToolBaseline = (bestEffort = false): void => {
    const baseline = runToolBaseline;
    if (baseline === null) return;
    try {
      if (!sameToolNames(pi.getActiveTools(), baseline)) {
        pi.setActiveTools([...baseline]);
      }
      runToolBaseline = null;
    } catch (error) {
      if (!bestEffort) throw error;
      runToolBaseline = null;
    }
  };

  const presentStatusBestEffort = (
    ctx: ExtensionContext | null,
    getStatus: () => string | undefined,
  ): void => {
    try {
      if (!ctx?.hasUI) return;
      ctx.ui.setStatus(PINDIE_STATUS_ID, getStatus());
    } catch {
      // Status presentation must not alter semantic or runtime behavior.
    }
  };

  const refreshStatus = (ctx = statusContext): void => {
    presentStatusBestEffort(ctx, () => {
      const layout = deriveStatusLayout({
        timing:
          runTimer.durationMs === null
            ? null
            : { durationMs: runTimer.durationMs, active: runTimer.active },
        runCost: runCost.snapshot(ctx!.sessionManager.getEntries()),
        reasoningMode: reasoning.snapshot.mode,
        activity: runActivity.activity,
        state: runtime.projectRoot === null ? null : runtime.state,
        stateUnavailableReason,
        runStale:
          runTimer.active &&
          currentAuthoritativeState() !== null &&
          currentAgentRunIsStale(),
        subscriptionUsage,
      }, now());
      return renderStatusLayout(ctx!.ui.theme, layout, getStatusWidth());
    });
  };

  const clearPindieStatus = (ctx: ExtensionContext): void => {
    presentStatusBestEffort(ctx, () => undefined);
  };

  const applyRequestedThinkingLevel = (): void => {
    if (reasoning.snapshot.mode === "manual") return;
    pi.setThinkingLevel(reasoning.snapshot.requestedLevel);
    reasoning.synchronizeEffective(pi.getThinkingLevel());
  };

  const reasoningStatus = (): string => {
    const { mode, requestedLevel, effectiveLevel } = reasoning.snapshot;
    return `Reasoning: ${mode}; requested ${requestedLevel}; effective ${effectiveLevel}.`;
  };

  const refreshSubscriptionUsage = async (ctx: ExtensionContext): Promise<void> => {
    if (lastUsageFetchAt !== null && now() - lastUsageFetchAt < 5 * 60_000) return;
    lastUsageFetchAt = now();
    try {
      const next = await subscriptionUsageProvider.fetchUsage(ctx);
      if (next) subscriptionUsage = next;
    } catch {
      // Account observation is runtime-only and intentionally silent.
    }
    refreshStatus(ctx);
  };

  const markUnavailable = (reason: string): void => {
    runtime.unload();
    stateUnavailableReason = reason;
    clearAgentRunBookkeeping();
    applyToolSurface(deriveCapabilities({ authority: "unavailable" }));
    refreshStatus();
  };

  const refreshToolSurface = (): void => {
    if (runToolBaseline === null) return;
    const derivation = deriveSemanticSnapshot(
      currentAuthoritativeState(),
      currentSemanticRunFacts(),
    );
    if (!derivation.ok) {
      markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
      return;
    }
    applyToolSurface(deriveCapabilities(derivation.snapshot));
  };

  const semanticStateChanged = (): void => {
    refreshStatus();
    refreshToolSurface();
  };

  const taskToolOptions = {
    getRunDuration: () => runTimer.durationMs,
    onStateChange: semanticStateChanged,
  };
  pi.registerTool(createPindieTaskStartTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskReplaceTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskRefineTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskProgressTool(runtime, taskToolOptions));
  pi.registerTool(createPindieVerificationRecordTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskCompleteTool(runtime, taskToolOptions));
  pi.registerTool(createPindieGateOpenTool(runtime, { onStateChange: semanticStateChanged }));
  pi.registerTool(createPindieGateResolveTool(runtime, { onStateChange: semanticStateChanged }));
  pi.registerTool(createPindieGitObserveTool());

  pi.registerCommand("efficiency", {
    description: "Show read-only runtime efficiency facts",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /efficiency", "warning");
        return;
      }
      const entries = ctx.sessionManager.getEntries();
      const report = formatEfficiencyReport(deriveEfficiencySnapshot({
        entries,
        contextUsage: ctx.getContextUsage(),
        reasoning: reasoning.snapshot,
        runCost: runCost.snapshot(entries),
      }));
      ctx.ui.notify(report, "info");
    },
  });

  pi.registerCommand("reasoning", {
    description: "Choose who controls thinking level (auto|manual)",
    getArgumentCompletions: (prefix) => ["auto", "manual"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      let value = args.trim().toLowerCase();
      if (!value && ctx.mode === "tui") {
        const selected = await ctx.ui.select("Reasoning", ["auto", "manual"]);
        if (!selected) return;
        value = selected;
      }
      if (value === "auto") reasoning.setAuto();
      else if (value === "manual") reasoning.setManual();
      else {
        ctx.ui.notify("Usage: /reasoning [auto|manual]", "warning");
        return;
      }
      applyRequestedThinkingLevel();
      refreshStatus(ctx);
      ctx.ui.notify(reasoningStatus(), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreRunToolBaseline(true);
    statusContext = ctx;
    clearActivityLingerRefresh();
    reasoning.reset(pi.getThinkingLevel());
    runActivity.reset();
    runCost.reset();
    runTimer.reset();
    clearPindieStatus(ctx);
    subscriptionUsage = null;
    lastUsageFetchAt = null;
    runtime.unload();
    stateUnavailableReason = null;
    clearAgentRunBookkeeping();
    mutationWindow = null;

    try {
      const projectRoot = await resolveProjectRoot(ctx.cwd);
      await runtime.load(projectRoot);
    } catch (error) {
      markUnavailable(
        `Could not load Pindie State for '${ctx.cwd}': ${errorMessage(error)}`,
      );
    }
    refreshStatus(ctx);
    void refreshSubscriptionUsage(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    restoreRunToolBaseline(true);
    clearActivityLingerRefresh();
    reasoning.reset(pi.getThinkingLevel());
    runActivity.reset();
    runCost.reset();
    runTimer.reset();
    clearPindieStatus(ctx);
    runtime.unload();
    stateUnavailableReason = null;
    clearAgentRunBookkeeping();
    mutationWindow = null;
    statusContext = null;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    statusContext = ctx;
    if (runToolBaseline === null) {
      runToolBaseline = [...pi.getActiveTools()];
    }
    clearAgentRunBookkeeping();
    mutationWindow = null;
    if (runtime.projectRoot !== null && stateUnavailableReason === null) {
      try {
        await runtime.refresh();
      } catch (error) {
        markUnavailable(
          `Could not refresh Pindie State before this Agent Run: ${errorMessage(error)}`,
        );
      }
    }
    // Refresh precedes all identity snapshots so a new Run always begins from
    // authoritative project State rather than a previous session snapshot.
    const state = currentAuthoritativeState();
    if (state !== null) {
      agentRunFactsContext = beginAgentRunFacts(
        state,
        runtime.externalStateEpoch,
      );
    }
    refreshToolSurface();
    reasoning.beforeAgentStart();
    applyRequestedThinkingLevel();
    clearActivityLingerRefresh();
    runActivity.start();
    runCost.start(ctx.sessionManager.getEntries());
    runTimer.start(ctx.hasUI ? () => refreshStatus(ctx) : undefined);
    refreshStatus(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    if (activeTaskContinuationAttempted || ctx.hasPendingMessages()) return;
    if (runtime.projectRoot === null || stateUnavailableReason !== null) return;
    const facts = currentSemanticRunFacts();
    if (!facts.stateAvailable || !facts.runCoherent) return;

    const task = runtime.state.task;
    const finalAssistantMessage = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !task ||
      task.completed ||
      task.humanGate !== null ||
      task.openLoops.blockers.length > 0 ||
      finalAssistantMessage?.stopReason !== "stop"
    ) {
      return;
    }

    activeTaskContinuationAttempted = true;
    pi.sendMessage(
      {
        customType: PINDIE_ACTIVE_TASK_CONTINUATION_TYPE,
        content: PINDIE_ACTIVE_TASK_CONTINUATION_MESSAGE,
        display: false,
      },
      { deliverAs: "followUp" },
    );
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => !isPindieRuntimeContextMessage(message),
    );
    let state = currentAuthoritativeState();
    let derivation = deriveSemanticSnapshot(state, currentSemanticRunFacts());
    if (!derivation.ok) {
      markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
      state = currentAuthoritativeState();
      derivation = deriveSemanticSnapshot(state, currentSemanticRunFacts());
    }
    if (!derivation.ok) {
      throw new Error(`Pindie unavailable semantic derivation failed: ${derivation.error}`);
    }
    const unavailableReason =
      stateUnavailableReason ??
      (state === null ? "No project State has been loaded for this session." : null);

    return {
      messages: [
        ...messages,
        createPindieRuntimeContextMessage(
          state,
          derivation.snapshot,
          unavailableReason,
        ),
      ],
    };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    clearActivityLingerRefresh();
    runActivity.toolExecutionStart(event.toolCallId, event.toolName);
    refreshStatus(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runActivity.toolExecutionEnd(event.toolCallId);
    scheduleActivityLingerRefresh();
    refreshStatus(ctx);
  });

  pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
    const effect = classifyToolEffect(event.toolName);
    if (
      effect.requiredCapability === "observe.project" ||
      effect.requiredCapability === "observe.git"
    ) {
      return;
    }

    let facts = currentSemanticRunFacts();
    if (
      facts.stateAvailable &&
      facts.runCoherent &&
      runtime.projectRoot !== null
    ) {
      try {
        if (await runtime.refresh()) semanticStateChanged();
      } catch (error) {
        markUnavailable(
          `Could not refresh Pindie State before consequential work: ${errorMessage(error)}`,
        );
      }
      facts = currentSemanticRunFacts();
    }

    const state = currentAuthoritativeState();
    const derivation = deriveSemanticSnapshot(state, facts);
    if (!derivation.ok) {
      const reason = derivation.error;
      markUnavailable(`Internal semantic derivation failed: ${reason}`);
      return {
        block: true,
        reason: `Pindie blocked this call: internal semantic derivation failed: ${reason}`,
      };
    }

    const snapshot = derivation.snapshot;
    const capabilities = deriveCapabilities(snapshot);
    applyToolSurface(capabilities);
    const authorization = authorizeToolEffect(capabilities, effect);
    if (!authorization.allowed) {
      return {
        block: true,
        reason: gatewayDenialReason(snapshot, authorization.requiredCapability),
      };
    }

    if (effect.projectMutation === "ambiguous") {
      const projectRoot = runtime.projectRoot!;
      if (mutationWindow === null) {
        let baseline: ProjectFingerprint;
        try {
          baseline = await captureProjectFingerprint(projectRoot);
        } catch (error) {
          baseline = { kind: "unknown", reason: errorMessage(error) };
        }
        mutationWindow = { projectRoot, baseline, pendingToolCallIds: new Set() };
      } else if (mutationWindow.projectRoot !== projectRoot) {
        // A session has one loaded project. Do not mix an impossible second root
        // into a known window; fail closed for verification instead.
        mutationWindow.baseline = { kind: "unknown", reason: "Mutation window project root changed." };
      }
      mutationWindow.pendingToolCallIds.add(event.toolCallId);
    }

    if (
      effect.projectMutation !== "none" ||
      effect.requiredCapability === "task.start" ||
      effect.requiredCapability === "task.replace"
    ) {
      authorizedToolEffects.set(event.toolCallId, effect);
    }
  });

  const invalidateVerificationAfterProjectMutation = async (): Promise<void> => {
    if (runtime.projectRoot === null || stateUnavailableReason !== null || !runtime.state.task) return;
    try {
      const result = await runtime.dispatch({
        type: "invalidate_verification",
      });
      if (!result.ok) {
        markUnavailable(
          `Pindie could not invalidate verification after project mutation: ${result.error.message}`,
        );
      }
    } catch (error) {
      if (error instanceof StateLockBusyError) {
        refreshStatus();
        throw error;
      }
      markUnavailable(
        `Pindie could not persist verification invalidation: ${errorMessage(error)}`,
      );
      throw error;
    }

    semanticStateChanged();
  };

  pi.on("tool_result", async (event) => {
    const effect = authorizedToolEffects.get(event.toolCallId);
    if (!effect) return;
    authorizedToolEffects.delete(event.toolCallId);

    if (
      !event.isError &&
      agentRunFactsContext !== null &&
      (effect.requiredCapability === "task.start" ||
        effect.requiredCapability === "task.replace")
    ) {
      agentRunFactsContext = recordSuccessfulCapability(
        agentRunFactsContext,
        effect.requiredCapability,
      );
      refreshToolSurface();
    }

    if (!event.isError && effect.projectMutation === "known") {
      await invalidateVerificationAfterProjectMutation();
      return;
    }

    if (effect.projectMutation !== "ambiguous") return;

    const window = mutationWindow;
    if (!window || !window.pendingToolCallIds.delete(event.toolCallId)) return;
    // Consume before observation/dispatch so duplicate results cannot act twice.
    if (window.pendingToolCallIds.size === 0) mutationWindow = null;
    if (window.baseline.kind === "unknown") {
      await invalidateVerificationAfterProjectMutation();
      return;
    }
    let after: ProjectFingerprint;
    try {
      after = await captureProjectFingerprint(window.projectRoot);
    } catch (error) {
      after = { kind: "unknown", reason: errorMessage(error) };
    }
    if (after.kind !== "known" || after.digest !== window.baseline.digest) {
      await invalidateVerificationAfterProjectMutation();
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (event.toolResults.length === 0) return;
    const state = runtime.projectRoot === null ? { task: null } : runtime.state;
    if (reasoning.decideNext(state, event.toolResults)) {
      applyRequestedThinkingLevel();
      refreshStatus(ctx);
    }
  });

  pi.on("thinking_level_select", (event, ctx) => {
    reasoning.synchronizeEffective(event.level);
    refreshStatus(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Pi can dispose an old session runner before its in-flight Agent Run reaches
    // the finally-path that emits agent_settled. Its context is then deliberately
    // stale; that obsolete run must not touch or reset this runtime's state.
    let entries;
    try {
      entries = ctx.sessionManager.getEntries();
    } catch (error) {
      if (isStaleExtensionContextError(error)) return;
      throw error;
    }

    statusContext = ctx;
    restoreRunToolBaseline();
    clearActivityLingerRefresh();
    runActivity.settle();
    runCost.finish(entries);
    runTimer.finish();
    refreshStatus(ctx);
    void refreshSubscriptionUsage(ctx);
    if (runtime.projectRoot === null) return;

    const validation = validateState(runtime.state);
    if (!validation.ok) {
      markUnavailable(
        `Pindie in-memory State failed validation: ${validation.errors.join(" ")}`,
      );
    }
  });

  return {
    runtime,
    reasoning,
    runActivity,
    runCost,
    runTimer,
    get stateUnavailableReason() {
      return stateUnavailableReason;
    },
  };
}

export default function pindieExtension(pi: ExtensionAPI): void {
  registerPindieExtension(pi);
}
