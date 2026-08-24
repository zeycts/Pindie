import {
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieRuntimeContextMessage,
  injectPindieCore,
  isPindieRuntimeContextMessage,
} from "./context.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import {
  FIXED_THINKING_LEVELS,
  isFixedThinkingLevel,
  ReasoningController,
  type ThinkingLevel,
} from "./reasoning.ts";
import {
  deriveEfficiencySnapshot,
  formatEfficiencyReport,
} from "./efficiency.ts";
import { RunActivityTracker } from "./run-activity.ts";
import { RunCostTracker } from "./run-cost.ts";
import { RunTimer } from "./run-timer.ts";
import { PindieRuntime } from "./runtime.ts";
import { StateLockBusyError } from "./store.ts";
import {
  validateState,
  type HumanGate,
  type PindieTask,
} from "./state.ts";
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
import { createPindieGateTool } from "./tools/gate.ts";
import { createPindieGitObserveTool } from "./tools/git-observe.ts";
import { createPindieStateTool } from "./tools/state.ts";

type ProjectRootResolver = (cwd: string) => Promise<string>;

interface ActionInput extends Record<string, unknown> {
  action?: unknown;
}

export interface PindieExtensionOptions {
  store?: PindieStateStore;
  resolveProjectRoot?: ProjectRootResolver;
  subscriptionUsageProvider?: SubscriptionUsageProvider;
  getStatusWidth?: () => number | undefined;
  now?: () => number;
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
const PINDIE_ACTIVE_TASK_CONTINUATION_MESSAGE = "The current Pindie Task is still unfinished. First re-evaluate whether the latest actual user intent calls for consequential execution of this current Task. If it clearly requests a different Task, reconcile it through replace_task when this Agent Run boundary permits, then continue only the new current Task. If it asks to stop, pause, return control, or only inspect, explain, or discuss, do not resume consequential Task work; allow this Agent Run to settle normally. If the Task boundary is consequentially ambiguous, use the existing Human Gate or return control appropriately. Otherwise continue this current Task now. Re-observe only what is necessary, then take the smallest safe next action. Do not stop merely to summarize remaining work, restate next steps, re-plan, or because more implementation, test, or verification iterations are required. If consequential human judgment is genuinely required, use the existing Human Gate. If a real external blocker prevents progress, record it. Otherwise continue toward current verified completion. Persisting nextIntent records continuation context; it is not permission to yield.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReadOnlyObservation(event: ToolCallEvent): boolean {
  return (
    isToolCallEventType("read", event) ||
    isToolCallEventType("grep", event) ||
    isToolCallEventType("find", event) ||
    isToolCallEventType("ls", event) ||
    isToolCallEventType("pindie_git_observe", event)
  );
}

const STALE_EXTENSION_CONTEXT_ERROR = "This extension ctx is stale after session replacement or reload.";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR);
}

function hasAction<TName extends string>(
  event: ToolCallEvent,
  toolName: TName,
  action: string,
): boolean {
  return (
    isToolCallEventType<TName, ActionInput>(toolName, event) &&
    event.input.action === action
  );
}

export function registerPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions = {},
): PindieExtensionIntegration {
  const runtime = new PindieRuntime(options.store ?? new FileStateStore());
  const reasoning = new ReasoningController();
  const runActivity = new RunActivityTracker();
  const runCost = new RunCostTracker();
  const runTimer = new RunTimer();
  const resolveProjectRoot =
    options.resolveProjectRoot ?? defaultResolveProjectRoot;
  const subscriptionUsageProvider =
    options.subscriptionUsageProvider ?? chatGptSubscriptionUsageProvider;
  const now = options.now ?? Date.now;
  const getStatusWidth = options.getStatusWidth ?? (() => process.stdout.columns);
  let subscriptionUsage: SubscriptionUsageSnapshot | null = null;
  let lastUsageFetchAt: number | null = null;
  let stateUnavailableReason: string | null = null;
  let statusContext: ExtensionContext | null = null;
  let gateAtAgentRunStart: HumanGate | null = null;
  let replaceableTaskAtAgentRunStart: PindieTask | null = null;
  let completedTaskAtAgentRunStart: PindieTask | null = null;
  let activeTaskContinuationAttempted = false;
  let externalStateEpochAtAgentRunStart = 0;

  const clearAgentRunSnapshot = (): void => {
    gateAtAgentRunStart = null;
    replaceableTaskAtAgentRunStart = null;
    completedTaskAtAgentRunStart = null;
    activeTaskContinuationAttempted = false;
    externalStateEpochAtAgentRunStart = 0;
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
        subscriptionUsage,
      }, now());
      return renderStatusLayout(ctx!.ui.theme, layout, getStatusWidth());
    });
  };

  const clearPindieStatus = (ctx: ExtensionContext): void => {
    presentStatusBestEffort(ctx, () => undefined);
  };

  const applyRequestedThinkingLevel = (): void => {
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
    clearAgentRunSnapshot();
    refreshStatus();
  };

  pi.registerTool(
    createPindieStateTool(runtime, {
      getRunDuration: () => runTimer.durationMs,
      onStateChange: refreshStatus,
    }),
  );
  pi.registerTool(createPindieGateTool(runtime, { onStateChange: refreshStatus }));
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
    description: "Set or show adaptive reasoning (auto|minimal|low|medium|high|xhigh|max|status)",
    getArgumentCompletions: (prefix) => ["auto", ...FIXED_THINKING_LEVELS, "status"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "status") {
        ctx.ui.notify(reasoningStatus(), "info");
        return;
      }
      if (value === "auto") reasoning.setAuto();
      else if (isFixedThinkingLevel(value)) {
        reasoning.setFixed(value);
      } else if (!value && ctx.mode === "tui") {
        const selected = await ctx.ui.select("Reasoning", ["auto", ...FIXED_THINKING_LEVELS]);
        if (!selected) return;
        if (selected === "auto") reasoning.setAuto();
        else reasoning.setFixed(selected as ThinkingLevel);
      } else {
        ctx.ui.notify(`${reasoningStatus()} Usage: /reasoning [auto|minimal|low|medium|high|xhigh|max|status]`, "warning");
        return;
      }
      applyRequestedThinkingLevel();
      refreshStatus(ctx);
      ctx.ui.notify(reasoningStatus(), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    statusContext = ctx;
    reasoning.reset(pi.getThinkingLevel());
    runActivity.reset();
    runCost.reset();
    runTimer.reset();
    clearPindieStatus(ctx);
    subscriptionUsage = null;
    lastUsageFetchAt = null;
    runtime.unload();
    stateUnavailableReason = null;
    clearAgentRunSnapshot();

    try {
      const projectRoot = await resolveProjectRoot(ctx.cwd);
      await runtime.load(projectRoot);
    } catch (error) {
      markUnavailable(
        `Could not load Pindie State for '${ctx.cwd}': ${errorMessage(error)} Restore or repair the project State, then reload the session.`,
      );
    }
    refreshStatus(ctx);
    void refreshSubscriptionUsage(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    reasoning.reset(pi.getThinkingLevel());
    runActivity.reset();
    runCost.reset();
    runTimer.reset();
    clearPindieStatus(ctx);
    runtime.unload();
    stateUnavailableReason = null;
    clearAgentRunSnapshot();
    statusContext = null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    statusContext = ctx;
    clearAgentRunSnapshot();
    if (runtime.projectRoot !== null && stateUnavailableReason === null) {
      try {
        await runtime.refresh();
      } catch (error) {
        markUnavailable(
          `Could not refresh Pindie State before this Agent Run: ${errorMessage(error)} Restore or repair the project State, then reload the session.`,
        );
      }
    }
    // Refresh precedes all identity snapshots so a new Run always begins from
    // authoritative project State rather than a previous session snapshot.
    const state = runtime.projectRoot === null ? null : runtime.state;
    const task = stateUnavailableReason === null ? state?.task ?? null : null;
    gateAtAgentRunStart = task?.humanGate ?? null;
    replaceableTaskAtAgentRunStart = task && !task.completed ? task : null;
    completedTaskAtAgentRunStart = task?.completed ? task : null;
    externalStateEpochAtAgentRunStart = runtime.externalStateEpoch;
    reasoning.beforeAgentStart();
    applyRequestedThinkingLevel();
    runActivity.start();
    runCost.start(ctx.sessionManager.getEntries());
    runTimer.start(ctx.hasUI ? () => refreshStatus(ctx) : undefined);
    refreshStatus(ctx);
    return { systemPrompt: injectPindieCore(event.systemPrompt) };
  });

  pi.on("agent_end", (event, ctx) => {
    if (activeTaskContinuationAttempted || ctx.hasPendingMessages()) return;
    if (runtime.projectRoot === null || stateUnavailableReason !== null) return;
    if (runtime.externalStateEpoch !== externalStateEpochAtAgentRunStart) return;

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
    const state = runtime.projectRoot === null ? null : runtime.state;
    const unavailableReason =
      stateUnavailableReason ??
      (state === null ? "No project State has been loaded for this session." : null);

    return {
      messages: [
        ...messages,
        createPindieRuntimeContextMessage(state, unavailableReason),
      ],
    };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    runActivity.toolExecutionStart(event.toolCallId, event.toolName);
    refreshStatus(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    runActivity.toolExecutionEnd(event.toolCallId);
    refreshStatus(ctx);
  });

  pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
    if (isReadOnlyObservation(event)) return;

    if (runtime.projectRoot === null || stateUnavailableReason !== null) {
      return {
        block: true,
        reason: `Pindie State is unavailable. ${stateUnavailableReason ?? "Reload the session to restore project State."} Only read-only observation tools are allowed until State is restored.`,
      };
    }
    if (runtime.externalStateEpoch !== externalStateEpochAtAgentRunStart) {
      return {
        block: true,
        reason: "Project State changed outside this Agent Run. Pindie refreshed to the latest authoritative State. Return control and begin a new user-driven Agent Run before consequential work. Read-only observation remains available.",
      };
    }
    try {
      if (await runtime.refresh()) {
        refreshStatus();
        return {
          block: true,
          reason: "Project State changed outside this Agent Run. Pindie refreshed to the latest authoritative State. Return control and begin a new user-driven Agent Run before consequential work. Read-only observation remains available.",
        };
      }
    } catch (error) {
      markUnavailable(
        `Could not refresh Pindie State before consequential work: ${errorMessage(error)} Restore or repair the project State, then reload the session.`,
      );
      return {
        block: true,
        reason: `Pindie State is unavailable. ${stateUnavailableReason} Only read-only observation tools are allowed until State is restored.`,
      };
    }

    const task = runtime.state.task;
    if (task === null && !hasAction(event, "pindie_state", "start_task")) {
      return {
        block: true,
        reason:
          "No active Pindie Task exists. Establish the current Task with pindie_state(start_task) before consequential project action. Read-only observation does not require a Task.",
      };
    }

    if (hasAction(event, "pindie_state", "replace_task")) {
      if (task && !task.completed && task !== replaceableTaskAtAgentRunStart) {
        return {
          block: true,
          reason:
            "This Agent run may only replace the unfinished Task that existed at the start of the run, before it was semantically mutated. Start or continue a new run before replacing this Task.",
        };
      }
      if (!task || !task.completed) return;
    }

    if (task?.humanGate) {
      if (
        hasAction(event, "pindie_state", "refine_task") ||
        hasAction(event, "pindie_gate", "resolve")
      ) {
        if (task.humanGate === gateAtAgentRunStart) return;

        return {
          block: true,
          reason:
            "This Human Gate was opened during the current Agent run. Wait for new human input before refining the Task Contract or resolving the gate.",
        };
      }

      return {
        block: true,
        reason: `A Human Gate is open: ${task.humanGate.question} Wait for human input. Only read-only observation, pindie_state(refine_task), and pindie_gate(resolve) are allowed.`,
      };
    }

    if (task?.completed) {
      if (hasAction(event, "pindie_state", "start_task")) {
        if (task === completedTaskAtAgentRunStart) return;

        return {
          block: true,
          reason:
            "The current task completed during this Agent run. Start a new task only after a new user-driven Agent run begins.",
        };
      }

      return {
        block: true,
        reason:
          "The current Pindie task is completed and terminal. Start a new task with pindie_state(start_task) before consequential project action.",
      };
    }
  });

  pi.on("tool_result", async (event) => {
    if (
      event.isError ||
      runtime.projectRoot === null ||
      stateUnavailableReason !== null ||
      (!isEditToolResult(event) && !isWriteToolResult(event))
    ) {
      return;
    }

    const task = runtime.state.task;
    if (!task) return;

    try {
      const result = await runtime.dispatch({
        type: "invalidate_verification",
      });
      if (!result.ok) {
        markUnavailable(
          `Pindie could not invalidate verification after project mutation: ${result.error.message} Reload the session after repairing State.`,
        );
      }
    } catch (error) {
      if (error instanceof StateLockBusyError) {
        refreshStatus();
        throw error;
      }
      markUnavailable(
        `Pindie could not persist verification invalidation: ${errorMessage(error)} Reload the session after restoring State persistence.`,
      );
      throw error;
    }

    refreshStatus();
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
    runActivity.settle();
    runCost.finish(entries);
    runTimer.finish();
    refreshStatus(ctx);
    void refreshSubscriptionUsage(ctx);
    if (runtime.projectRoot === null) return;

    const validation = validateState(runtime.state);
    if (!validation.ok) {
      markUnavailable(
        `Pindie in-memory State failed validation: ${validation.errors.join(" ")} Reload the session after repairing State.`,
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
