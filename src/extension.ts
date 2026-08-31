import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieRuntimeContextMessage,
  isPindieRuntimeContextMessage,
} from "./context.ts";
import {
  PINDIE_CONTINUATION_PROBE_MESSAGE,
  PINDIE_CONTINUATION_PROBE_TYPE,
  isPindieContinuationProbeMessage,
  shouldProbeContinuation,
} from "./continuation.ts";
import { ExecutionIntegration } from "./execution-integration.ts";
import {
  authorizeToolEffect,
  classifyToolEffect,
  type ToolEffect,
} from "./execution-semantics.ts";
import { PresentationIntegration } from "./presentation-integration.ts";
import { RemoteCompanion, type RemotePi, type RemoteStatusFacts } from "./remote-companion.ts";
import { DiscordRemote, discordRemoteConfig } from "./discord-remote.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import type { ProjectFingerprint } from "./project-mutation.ts";
import type { ReasoningController } from "./reasoning.ts";
import type { RunActivityTracker } from "./run-activity.ts";
import type { RunCostTracker } from "./run-cost.ts";
import { RunIntegration } from "./run-integration.ts";
import type { RunTimer } from "./run-timer.ts";
import { PindieRuntime } from "./runtime.ts";
import {
  deriveCapabilities,
  type SemanticSnapshot,
} from "./semantics.ts";
import { getTaskStatus, getVerificationStatus, validateState } from "./state.ts";
import {
  FileStateStore,
  StateLockBusyError,
  type PindieStateStore,
} from "./store.ts";
import type { SubscriptionUsageProvider } from "./subscription-usage.ts";
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
  /** Optional transport-independent Remote core; omitted keeps the existing extension unchanged. */
  remoteCompanion?: { companion: RemoteCompanion; guildId: string; discord?: DiscordRemote };
}

export interface PindieExtensionIntegration {
  readonly runtime: PindieRuntime;
  readonly runActivity: RunActivityTracker;
  readonly reasoning: ReasoningController;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly stateUnavailableReason: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STALE_EXTENSION_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR);
}

function safeSessionEntries(
  ctx: ExtensionContext,
): ReturnType<ExtensionContext["sessionManager"]["getEntries"]> | null {
  try {
    return ctx.sessionManager.getEntries();
  } catch (error) {
    if (isStaleExtensionContextError(error)) return null;
    throw error;
  }
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
  const run = new RunIntegration(pi, runtime);
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: options.captureProjectFingerprint,
  });
  const presentation = new PresentationIntegration(pi, {
    getState: () => runtime.projectRoot === null ? null : runtime.state,
    getAuthoritativeState: () => run.authoritativeState,
    getStateUnavailableReason: () => run.stateUnavailableReason,
    getRunStale: () => run.agentRunIsStale,
    subscriptionUsageProvider: options.subscriptionUsageProvider,
    getStatusWidth: options.getStatusWidth,
    now: options.now,
    activityLingerMs: options.activityLingerMs,
    scheduleActivityRefresh: options.scheduleActivityRefresh,
    clearActivityRefresh: options.clearActivityRefresh,
  });
  const resolveProjectRoot = options.resolveProjectRoot ??
    defaultResolveProjectRoot;
  type LiveRemoteSession = { sessionId: string; ctx: ExtensionContext; generation: number };
  let liveRemoteSession: LiveRemoteSession | null = null;
  let nextRemoteLeaseGeneration = 0;
  const remotePiFor = (sessionId: string, generation: number): RemotePi | null => {
    const lease = liveRemoteSession;
    if (!lease || lease.sessionId !== sessionId || lease.generation !== generation) return null;
    const currentContext = (): ExtensionContext => {
      const current = liveRemoteSession;
      if (current !== lease) throw new Error("Remote Session lease was replaced.");
      return current.ctx;
    };
    return {
      isIdle: () => currentContext().isIdle(),
      abort: () => currentContext().abort(),
      sendUserMessage: (content, inputOptions) => {
        currentContext();
        return pi.sendUserMessage(content, inputOptions);
      },
    };
  };

  const markUnavailable = (reason: string): void => {
    execution.semanticAuthorityUnavailable();
    run.markUnavailable(reason);
    presentation.refreshStatus();
    void options.remoteCompanion?.companion.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
  };

  const refreshRunToolSurface = (): boolean => {
    const derivation = run.refreshToolSurface();
    if (derivation.ok) return true;
    markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
    return false;
  };

  const remoteStatusFacts = (): RemoteStatusFacts => {
    const task = runtime.state.task;
    return {
      taskGoal: task?.goal ?? null,
      taskStatus: getTaskStatus(runtime.state),
      activity: presentation.runActivity.activity,
      verificationStatus: task ? getVerificationStatus(task) : null,
      elapsedMs: presentation.runTimer.durationMs,
      semanticAuthority: run.stateUnavailableReason !== null
        ? "unavailable"
        : run.agentRunIsStale ? "stale" : "coherent",
      localUiPrompt: false,
    };
  };

  const projectRemoteSemantics = (): void => {
    const remote = options.remoteCompanion?.companion;
    const task = runtime.state.task;
    if (!remote) return;
    void remote.status(remoteStatusFacts());
    if (run.stateUnavailableReason !== null) void remote.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
    if (!task) return;
    const taskStatus = getTaskStatus(runtime.state);
    if (task.humanGate) {
      const event = remote.humanGate(task.humanGate.question, task.humanGate.options);
      void remote.milestone(`gate:${task.humanGate.question}\0${(task.humanGate.options ?? []).join("\0")}`, event.text);
    }
    if (taskStatus === "blocked") void remote.milestone(`blocked:${task.openLoops.blockers.join("\\0")}`, `TASK BLOCKED\n${task.openLoops.blockers.join("\n")}`);
    void remote.milestone(`verification:${getVerificationStatus(task)}`, `VERIFICATION · ${getVerificationStatus(task).toUpperCase()}`);
  };

  const semanticStateChanged = (): void => {
    execution.semanticStateChanged(runtime.externalStateEpoch);
    if (!refreshRunToolSurface()) return;
    presentation.refreshStatus();
    projectRemoteSemantics();
  };

  const invalidateVerificationAfterProjectMutation = async (): Promise<void> => {
    execution.advanceEvidenceGeneration();
    if (
      runtime.projectRoot === null ||
      run.stateUnavailableReason !== null ||
      !runtime.state.task
    ) {
      return;
    }
    try {
      const result = await runtime.dispatch({ type: "invalidate_verification" });
      if (!result.ok) {
        markUnavailable(
          `Pindie could not invalidate verification after project mutation: ${result.error.message}`,
        );
      }
    } catch (error) {
      if (error instanceof StateLockBusyError) {
        presentation.refreshStatus();
        throw error;
      }
      markUnavailable(
        `Pindie could not persist verification invalidation: ${errorMessage(error)}`,
      );
      throw error;
    }
    semanticStateChanged();
  };

  const taskToolOptions = {
    getRunDuration: () => presentation.runTimer.durationMs,
    onStateChange: semanticStateChanged,
  };
  pi.registerTool(createPindieTaskStartTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskReplaceTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskRefineTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskProgressTool(runtime, taskToolOptions));
  pi.registerTool(createPindieVerificationRecordTool(runtime, {
    ...taskToolOptions,
    resolveEvidence: (refs) => execution.resolveVerificationEvidence(refs),
  }));
  pi.registerTool(createPindieTaskCompleteTool(runtime, taskToolOptions));
  pi.registerTool(createPindieGateOpenTool(runtime, {
    onStateChange: semanticStateChanged,
  }));
  pi.registerTool(createPindieGateResolveTool(runtime, {
    onStateChange: semanticStateChanged,
  }));
  pi.registerTool(createPindieGitObserveTool());

  pi.registerCommand("efficiency", {
    description: "Show read-only runtime efficiency facts",
    handler: async (args, ctx) => presentation.handleEfficiencyCommand(args, ctx),
  });

  pi.registerCommand("reasoning", {
    description: "Choose who controls thinking level (auto|manual)",
    getArgumentCompletions: (prefix) => ["auto", "manual"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => presentation.handleReasoningCommand(args, ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    const remoteSessionId = options.remoteCompanion
      ? ctx.sessionManager.getSessionId()
      : null;
    const remoteSessionName = options.remoteCompanion
      ? ctx.sessionManager.getSessionName()
      : undefined;
    run.restoreRunToolBaseline(true);
    presentation.setStatusContext(ctx);
    presentation.resetTrackers();
    presentation.clearStatus(ctx);
    presentation.resetSubscriptionUsage();
    run.resetStateAuthority();
    run.clearAgentRunBookkeeping();
    execution.discardRuntime();

    try {
      const projectRoot = await resolveProjectRoot(ctx.cwd);
      await run.loadProject(projectRoot);
    } catch (error) {
      markUnavailable(
        `Could not load Pindie State for '${ctx.cwd}': ${errorMessage(error)}`,
      );
    }
    presentation.refreshStatus(ctx);
    void presentation.refreshSubscriptionUsage(ctx);
    if (options.remoteCompanion && runtime.projectRoot !== null && remoteSessionId !== null) {
      const live = { sessionId: remoteSessionId, ctx, generation: ++nextRemoteLeaseGeneration };
      const remoteLeaseGeneration = live.generation;
      liveRemoteSession = live;
      await options.remoteCompanion.companion.bind(
        runtime.projectRoot,
        options.remoteCompanion.guildId,
        remoteSessionId,
        { sessionName: remoteSessionName, taskGoal: runtime.state.task?.goal, status: remoteStatusFacts(), getStatus: remoteStatusFacts },
      );
      if (liveRemoteSession !== live) return;
      if (options.remoteCompanion.companion.activeSessionId !== remoteSessionId) {
        liveRemoteSession = null;
        options.remoteCompanion.companion.shutdown(remoteSessionId);
        return;
      }
      // Discord login is optional external I/O. Do not make local startup wait for it.
      if (options.remoteCompanion.discord) {
        if (options.remoteCompanion.companion.activeSessionId !== remoteSessionId) return;
        void options.remoteCompanion.discord.start(
          (threadId, text) => {
            const live = liveRemoteSession;
            if (!live || live.sessionId !== remoteSessionId || live.generation !== remoteLeaseGeneration) return Promise.resolve("failed" as const);
            if (options.remoteCompanion!.companion.activeSessionId !== remoteSessionId) return Promise.resolve("failed" as const);
            const currentPi = remotePiFor(remoteSessionId, remoteLeaseGeneration);
            if (!currentPi) return Promise.resolve("failed" as const);
            return options.remoteCompanion!.companion.input(threadId, text, currentPi);
          },
          () => {
            const live = liveRemoteSession;
            if (!live || live.sessionId !== remoteSessionId || live.generation !== remoteLeaseGeneration) return;
            if (options.remoteCompanion!.companion.activeSessionId !== remoteSessionId) return;
            const entries = safeSessionEntries(live.ctx);
            if (!entries) return;
            void options.remoteCompanion!.companion.catchUp(entries).catch(() => undefined);
          },
          (threadId) => options.remoteCompanion!.companion.isMappedThread(threadId),
        ).catch(() => undefined);
      } else {
        const entries = safeSessionEntries(live.ctx);
        if (entries) await options.remoteCompanion.companion.catchUp(entries);
      }
    }
  });

  if (options.remoteCompanion) {
    pi.on("input", (event) => {
      options.remoteCompanion!.companion.observeInput(event.source, event.streamingBehavior);
    });
    // Pi remains transcript truth: session history is projected after each
    // finalized message, serialized by RemoteCompanion behind any catch-up.
    pi.on("message_end", () => {
      const live = liveRemoteSession;
      if (!live) return;
      const entries = safeSessionEntries(live.ctx);
      if (!entries) return;
      void options.remoteCompanion!.companion.catchUp(entries).catch(() => undefined);
    });
    pi.on("session_info_changed", async (event, _ctx) => {
      await options.remoteCompanion!.companion.rename(event.name ?? "");
    });
    pi.on("ui_prompt_start", () => options.remoteCompanion!.companion.setLocalUiPrompt(true));
    pi.on("ui_prompt_end", () => options.remoteCompanion!.companion.setLocalUiPrompt(false));
  }

  pi.on("session_shutdown", (_event, ctx) => {
    const remote = options.remoteCompanion;
    const sessionId = liveRemoteSession?.sessionId ?? remote?.companion.activeSessionId ?? null;
    liveRemoteSession = null;
    if (remote && sessionId !== null) remote.companion.shutdown(sessionId);
    remote?.discord?.stop();
    run.restoreRunToolBaseline(true);
    presentation.resetTrackers();
    presentation.clearStatus(ctx);
    run.resetStateAuthority();
    run.clearAgentRunBookkeeping();
    execution.discardRuntime();
    presentation.setStatusContext(null);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    presentation.setStatusContext(ctx);
    run.captureRunToolBaseline();
    run.clearAgentRunBookkeeping();
    execution.discardRuntime();
    if (run.authoritativeState !== null) {
      try {
        await run.refreshAuthoritativeState();
      } catch (error) {
        markUnavailable(
          `Could not refresh Pindie State before this Agent Run: ${errorMessage(error)}`,
        );
      }
    }
    // Refresh precedes all identity snapshots so a new Run always begins from
    // authoritative project State rather than a previous session snapshot.
    execution.beginEvidenceScope(runtime.externalStateEpoch);
    run.beginAgentRunFacts();
    refreshRunToolSurface();
    presentation.reasoning.beforeAgentStart();
    presentation.applyRequestedThinkingLevel();
    presentation.clearActivityLingerRefresh();
    presentation.runActivity.start();
    presentation.startCost(ctx.sessionManager.getEntries());
    presentation.startTimer(ctx);
    presentation.refreshStatus(ctx);
    void options.remoteCompanion?.companion.status(remoteStatusFacts());
  });

  pi.on("agent_end", (event, ctx) => {
    const derivation = run.deriveSnapshot();
    if (!derivation.ok) return;
    const finalAssistantMessage = [...event.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const shouldProbe = shouldProbeContinuation(derivation.snapshot, {
      probeAlreadyAttempted: run.activeTaskContinuationAttempted,
      hasPendingMessages: ctx.hasPendingMessages(),
      stoppedNormally: finalAssistantMessage?.stopReason === "stop",
    });
    if (!shouldProbe) return;

    run.markContinuationAttempted();
    pi.sendMessage(
      {
        customType: PINDIE_CONTINUATION_PROBE_TYPE,
        content: PINDIE_CONTINUATION_PROBE_MESSAGE,
        display: false,
      },
      { deliverAs: "followUp" },
    );
  });

  pi.on("context", (event) => {
    let latestContinuationProbeIndex = -1;
    if (run.activeTaskContinuationAttempted) {
      for (let index = event.messages.length - 1; index >= 0; index -= 1) {
        if (isPindieContinuationProbeMessage(event.messages[index])) {
          latestContinuationProbeIndex = index;
          break;
        }
      }
    }
    const messages = event.messages.filter((message, index) =>
      !isPindieRuntimeContextMessage(message) &&
      (!isPindieContinuationProbeMessage(message) ||
        index === latestContinuationProbeIndex)
    );
    let state = run.authoritativeState;
    let derivation = run.deriveSnapshot();
    if (!derivation.ok) {
      markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
      state = run.authoritativeState;
      derivation = run.deriveSnapshot();
    }
    if (!derivation.ok) {
      throw new Error(
        `Pindie unavailable semantic derivation failed: ${derivation.error}`,
      );
    }
    const unavailableReason = run.stateUnavailableReason ??
      (state === null
        ? "No project State has been loaded for this session."
        : null);

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
    options.remoteCompanion?.companion.recordToolStart(event.toolCallId, event.toolName, event.args);
    presentation.clearActivityLingerRefresh();
    presentation.runActivity.toolExecutionStart(
      event.toolCallId,
      event.toolName,
    );
    presentation.refreshStatus(ctx);
    void options.remoteCompanion?.companion.status(remoteStatusFacts());
  });

  pi.on("tool_execution_end", (event, ctx) => {
    options.remoteCompanion?.companion.recordToolEnd(event.toolCallId, event.toolName, event.isError);
    presentation.runActivity.toolExecutionEnd(event.toolCallId);
    presentation.scheduleActivityLingerRefresh();
    presentation.refreshStatus(ctx);
    void options.remoteCompanion?.companion.status(remoteStatusFacts());
  });

  pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
    const effect = classifyToolEffect(event.toolName);
    if (
      effect.requiredCapability === "observe.project" ||
      effect.requiredCapability === "observe.git"
    ) {
      execution.recordAuthorizedObservation(event, effect);
      return;
    }

    let facts = run.semanticRunFacts;
    if (
      facts.stateAvailable &&
      facts.runCoherent &&
      runtime.projectRoot !== null
    ) {
      try {
        if (await run.refreshAuthoritativeState()) semanticStateChanged();
      } catch (error) {
        markUnavailable(
          `Could not refresh Pindie State before consequential work: ${errorMessage(error)}`,
        );
      }
      facts = run.semanticRunFacts;
    }

    const derivation = run.deriveSnapshot();
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
    run.applyToolSurface(capabilities);
    const authorization = authorizeToolEffect(capabilities, effect);
    if (!authorization.allowed) {
      return {
        block: true,
        reason: gatewayDenialReason(
          snapshot,
          authorization.requiredCapability,
        ),
      };
    }

    await execution.recordAuthorizedConsequentialCall(
      event,
      effect,
      runtime.projectRoot!,
    );
  });

  pi.on("tool_result", async (event) => {
    const authorizedExecution = execution.takeAuthorizedExecution(
      event.toolCallId,
    );
    if (!authorizedExecution) return;
    const { effect } = authorizedExecution;

    if (
      !event.isError &&
      (effect.requiredCapability === "task.start" ||
        effect.requiredCapability === "task.replace")
    ) {
      run.recordSuccessfulCapability(effect.requiredCapability);
      refreshRunToolSurface();
    }

    if (
      !event.isError &&
      (effect.requiredCapability === "task.start" ||
        effect.requiredCapability === "task.replace" ||
        effect.requiredCapability === "task.refine")
    ) {
      execution.advanceEvidenceGeneration();
    }

    const mutationSettlement = await execution.settleProjectMutation(
      event,
      authorizedExecution,
    );
    if (mutationSettlement === "ignore") return;
    if (mutationSettlement === "invalidate") {
      await invalidateVerificationAfterProjectMutation();
      return;
    }

    return execution.captureEvidenceIfEligible(
      authorizedExecution,
      event,
      run.authoritativeState,
      run.semanticRunFacts,
    );
  });

  pi.on("turn_end", (event, ctx) => {
    if (event.toolResults.length === 0) return;
    const state = runtime.projectRoot === null
      ? { task: null }
      : runtime.state;
    presentation.handleTurnEnd(state, event.toolResults, ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    presentation.synchronizeThinkingLevel(event.level, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Pi can dispose an old session runner before its in-flight Agent Run reaches
    // the finally-path that emits agent_settled. Its context is then deliberately
    // stale; that obsolete run must not touch or reset this runtime's state.
    const entries = safeSessionEntries(ctx);
    if (!entries) return;

    presentation.setStatusContext(ctx);
    execution.discardRuntime();
    run.restoreRunToolBaseline();
    presentation.clearActivityLingerRefresh();
    presentation.runActivity.settle();
    presentation.finishCost(entries);
    presentation.runTimer.finish();
    presentation.refreshStatus(ctx);
    void presentation.refreshSubscriptionUsage(ctx);
    if (options.remoteCompanion) {
      const lastEntry = entries.at(-1);
      void options.remoteCompanion.companion.status(remoteStatusFacts())
        .then(() => options.remoteCompanion!.companion.catchUp(entries))
        .then(async () => {
          if (lastEntry) await options.remoteCompanion!.companion.flushExecution(lastEntry.id);
          await options.remoteCompanion!.companion.settleCompletion();
        });
    }
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
    reasoning: presentation.reasoning,
    runActivity: presentation.runActivity,
    runCost: presentation.runCost,
    runTimer: presentation.runTimer,
    get stateUnavailableReason() {
      return run.stateUnavailableReason;
    },
  };
}

export default function pindieExtension(pi: ExtensionAPI): void {
  const configured = discordRemoteConfig();
  if (!configured.enabled) {
    if (configured.warning) console.warn(configured.warning);
    registerPindieExtension(pi);
    return;
  }
  const discord = new DiscordRemote(configured.config);
  registerPindieExtension(pi, {
    remoteCompanion: {
      companion: new RemoteCompanion(discord),
      guildId: configured.config.guildId,
      discord,
    },
  });
}
