import {
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { injectPindieCore } from "./context.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import { RunTimer } from "./run-timer.ts";
import { PindieRuntime } from "./runtime.ts";
import {
  validateState,
  type HumanGate,
  type PindieTask,
} from "./state.ts";
import {
  deriveStatusSegments,
  renderStatusSegments,
} from "./status-line.ts";
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
}

export interface PindieExtensionIntegration {
  readonly runtime: PindieRuntime;
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
  const runTimer = new RunTimer();
  const resolveProjectRoot =
    options.resolveProjectRoot ?? defaultResolveProjectRoot;
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
      const segments = deriveStatusSegments({
        timing:
          runTimer.durationMs === null
            ? null
            : { durationMs: runTimer.durationMs, active: runTimer.active },
        state: runtime.projectRoot === null ? null : runtime.state,
        stateUnavailableReason,
      });
      return segments.length === 0
        ? undefined
        : renderStatusSegments(ctx!.ui.theme, segments);
    });
  };

  const clearPindieStatus = (ctx: ExtensionContext): void => {
    presentStatusBestEffort(ctx, () => undefined);
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

  pi.on("session_start", async (_event, ctx) => {
    statusContext = ctx;
    runTimer.reset();
    clearPindieStatus(ctx);
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
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runTimer.reset();
    clearPindieStatus(ctx);
    runtime.unload();
    stateUnavailableReason = null;
    clearAgentRunSnapshot();
    statusContext = null;
  });

  pi.on("before_agent_start", (event, ctx) => {
    statusContext = ctx;
    runTimer.start(ctx.hasUI ? () => refreshStatus(ctx) : undefined);
    const state = runtime.projectRoot === null ? null : runtime.state;
    const task = stateUnavailableReason === null ? state?.task ?? null : null;
    gateAtAgentRunStart = task?.humanGate ?? null;
    completedTaskAtAgentRunStart = task?.completed ? task : null;
    const unavailableReason =
      stateUnavailableReason ??
      (state === null ? "No project State has been loaded for this session." : null);

    return {
      systemPrompt: injectPindieCore(
        event.systemPrompt,
        state,
        unavailableReason,
      ),
    };
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

  pi.on("agent_settled", (_event, ctx) => {
    statusContext = ctx;
    runTimer.finish();
    refreshStatus(ctx);
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
    runTimer,
    get stateUnavailableReason() {
      return stateUnavailableReason;
    },
  };
}

export default function pindieExtension(pi: ExtensionAPI): void {
  registerPindieExtension(pi);
}
