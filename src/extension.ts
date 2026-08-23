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
import { RunActivityTracker } from "./run-activity.ts";
import { RunCostTracker } from "./run-cost.ts";
import { RunTimer } from "./run-timer.ts";
import { PindieRuntime } from "./runtime.ts";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReadOnlyObservation(event: ToolCallEvent): boolean {
  return (
    isToolCallEventType("read", event) ||
    isToolCallEventType("grep", event) ||
    isToolCallEventType("find", event) ||
    isToolCallEventType("ls", event)
  );
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
  const reasoning = new ReasoningController(pi.getThinkingLevel());
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
  let completedTaskAtAgentRunStart: PindieTask | null = null;

  const clearAgentRunSnapshot = (): void => {
    gateAtAgentRunStart = null;
    completedTaskAtAgentRunStart = null;
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

  pi.on("before_agent_start", (event, ctx) => {
    statusContext = ctx;
    reasoning.beforeAgentStart();
    applyRequestedThinkingLevel();
    runActivity.start();
    runCost.start(ctx.sessionManager.getEntries());
    runTimer.start(ctx.hasUI ? () => refreshStatus(ctx) : undefined);
    const state = runtime.projectRoot === null ? null : runtime.state;
    const task = stateUnavailableReason === null ? state?.task ?? null : null;
    gateAtAgentRunStart = task?.humanGate ?? null;
    completedTaskAtAgentRunStart = task?.completed ? task : null;
    return { systemPrompt: injectPindieCore(event.systemPrompt) };
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

  pi.on("tool_call", (event): ToolCallEventResult | void => {
    if (isReadOnlyObservation(event)) return;

    if (runtime.projectRoot === null || stateUnavailableReason !== null) {
      return {
        block: true,
        reason: `Pindie State is unavailable. ${stateUnavailableReason ?? "Reload the session to restore project State."} Only read-only observation tools are allowed until State is restored.`,
      };
    }

    const task = runtime.state.task;
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
    if (!task || task.completed) return;

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
    statusContext = ctx;
    runActivity.settle();
    runCost.finish(ctx.sessionManager.getEntries());
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
