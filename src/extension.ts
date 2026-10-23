import { isDeepStrictEqual } from "node:util";
import { createWatchCommand } from "./watch-command.ts";

import {
  composePindieExtension,
  type PindieFeatureSelection,
  type PindieStorageRoots,
} from "./composition.ts";
import {
  coreGatewayDenialReason,
  corePromptContribution,
  createCoreIntegration,
  type CoreIntegration,
} from "./core-integration.ts";
import {
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieStateCheckpointMessage,
  appendPindieWorkMemoryContract,
  createPindieRunBaselineMessage,
  renderCurrentPindieActionEligibility,
  renderPindieProjectMutationUpdate,
} from "./context.ts";
import {
  formatContextLifecycleGuidance,
  PINDIE_CONTEXT_LIFECYCLE_TYPE,
  type ContextGovernorTuning,
} from "./context-governor.ts";
import {
  PINDIE_CONTINUATION_PROBE_MESSAGE,
  PINDIE_CONTINUATION_PROBE_TYPE,
  shouldProbeContinuation,
} from "./continuation.ts";
import {
  PresentationIntegration,
  type PindiePresentationReader,
} from "./presentation-integration.ts";
import { PINDIE_REMOTE_NOTICE_TYPE, renderPindieRemoteNotice } from "./remote-notice.ts";
import type { RemoteCompanion, RemotePi, RemoteStatusFacts } from "./remote-companion.ts";
import { classifyHumanSignal } from "./human-signal.ts";
import type { DiscordRemote } from "./discord-remote.ts";
import { FileDiscordRemotePreferenceStore, registerDiscordRemotePreferenceCommand } from "./remote-preference.ts";
import type { RemoteRoutingStore } from "./remote-routing.ts";
import type { ProjectMemorySink } from "./project-memory.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import type { ProjectFingerprint } from "./project-mutation.ts";
import type { RunActivityTracker } from "./run-activity.ts";
import type { RunCostTracker } from "./run-cost.ts";
import type { RunTimer } from "./run-timer.ts";
import type { TaskMetricsTracker } from "./task-metrics.ts";
import {
  PindieStateMutationUncertainError,
  type PindieRuntime,
} from "./runtime.ts";
import {
  deriveCapabilities,
  type PindieCapability,
  type SemanticSnapshot,
} from "./semantics.ts";
import {
  getTaskStatus,
  getVerificationStatus,
  validateState,
  type PindieState,
} from "./state.ts";
import {
  StateLockBusyError,
  type TaskContinuityStore,
  type PindieStateStore,
} from "./store.ts";
import { taskContractFingerprint } from "./task-continuity.ts";
import {
  getCommittedRolloverPublisher,
  getSessionLifecyclePublisher,
} from "./long-task-control.ts";
import { PINDIE_TASK_HANDOFF_TOOL } from "./task-handoff-runtime.ts";
import {
  chatGptSubscriptionUsageProvider,
  SubscriptionUsageMonitor,
  type SubscriptionUsageProvider,
} from "./subscription-usage.ts";
import {
  registerQuotaResumeIntegration,
  type QuotaResumePreferenceStore,
} from "./quota-resume.ts";
import { registerQuotaFallbackIntegration, type QuotaFallbackPreferenceStore } from "./quota-fallback.ts";
import {
  getQuotaResumePublisher,
  getQuotaResumeStatusObserver,
} from "./quota-resume-control.ts";
import {
  buildCodexQuotaRecoveryFacts,
  detectCodexQuotaIncident,
  quotaResumePlanFromRecoveryFacts,
} from "./quota-resume-incident.ts";
import { getQuotaFallbackController } from "./quota-fallback-control.ts";
import { detectQuotaFallbackBackupFailure } from "./quota-fallback-supervisor.ts";
import {
  PINDIE_QUOTA_RESUME_TYPE,
} from "./quota-resume-supervisor.ts";
import { createPindieMemoryCaptureTool } from "./tools/memory.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "./liveness.ts";

type ProjectRootResolver = (cwd: string, signal?: AbortSignal) => Promise<string>;

export interface PindieExtensionOptions {
  /** Startup selection; composition resolves this before registration. */
  featureSelection?: Partial<PindieFeatureSelection>;
  /** Explicit production/test storage namespaces; never inferred from a Store class. */
  storageRoots?: Partial<PindieStorageRoots>;
  /** Explicit Remote routing storage used when composition constructs Remote. */
  remoteRoutingStore?: RemoteRoutingStore;
  store?: PindieStateStore;
  continuityStore?: TaskContinuityStore;
  quotaResumePreferenceStore?: QuotaResumePreferenceStore;
  quotaFallbackPreferenceStore?: QuotaFallbackPreferenceStore;
  resolveProjectRoot?: ProjectRootResolver;
  subscriptionUsageProvider?: SubscriptionUsageProvider;
  getStatusWidth?: () => number | undefined;
  now?: () => number;
  /** Internal test seams for runtime-only activity presentation expiry. */
  activityLingerMs?: number;
  scheduleActivityRefresh?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearActivityRefresh?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Runtime-only measurement/test seams; the Host supplies Task ownership in production. */
  runTimer?: RunTimer;
  runCost?: RunCostTracker;
  taskMetrics?: TaskMetricsTracker;
  /** Explicit isolated-test seam; Host ownership is the production activation path. */
  enableTaskHandoff?: boolean;
  /** Isolated tuning seam for the session-scoped Context Lifecycle Governor. */
  contextGovernorTuning?: ContextGovernorTuning;
  /** Internal test seam for runtime-only project mutation observation. */
  captureProjectFingerprint?: (projectRoot: string) => Promise<ProjectFingerprint>;
  /** Optional transport-independent Work Memory sink; production may provide Notion. */
  projectMemorySink?: ProjectMemorySink;
  /** Optional transport-independent Remote core; omitted keeps the existing extension unchanged. */
  remoteCompanion?: { companion: RemoteCompanion; guildId: string; discord?: DiscordRemote };
}

export interface PindieExtensionIntegration {
  readonly featureSelection: PindieFeatureSelection;
  readonly presentation: PindiePresentationReader;
  readonly core: CoreIntegration;
  readonly runtime: PindieRuntime;
  readonly runActivity: RunActivityTracker | null;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly taskMetrics: TaskMetricsTracker;
  readonly contextGovernor: CoreIntegration["contextGovernor"];
  readonly stateUnavailableReason: string | null;
  readonly quotaAutoResumeEnabled: boolean;
  readonly quotaFallbackEnabled: boolean;
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

function sameCapabilities(
  left: ReadonlySet<PindieCapability> | null,
  right: ReadonlySet<PindieCapability>,
): boolean {
  if (left === null || left.size !== right.size) return false;
  for (const capability of right) {
    if (!left.has(capability)) return false;
  }
  return true;
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

function isQuotaResumeAgentRun(event: BeforeAgentStartEvent): boolean {
  // Native Pi exposes the trigger before it is appended to the branch.
  // User text (even the exact hidden marker) and historical entries are not triggers.
  return event.messageType === "custom" && event.message.customType === PINDIE_QUOTA_RESUME_TYPE;
}

export function registerPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions = {},
): PindieExtensionIntegration {
  const composition = composePindieExtension(options);
  return registerComposedPindieExtension(
    pi,
    composition.extensionOptions,
    composition.featureSelection,
  );
}

function registerComposedPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions,
  featureSelection: PindieFeatureSelection,
): PindieExtensionIntegration {
  pi.registerEntryRenderer(PINDIE_REMOTE_NOTICE_TYPE, renderPindieRemoteNotice);

  const discord = options.remoteCompanion?.discord;
  if (discord) {
    if (typeof discord.setWarningSink === "function") {
      discord.setWarningSink((message) => {
        try {
          pi.appendEntry(PINDIE_REMOTE_NOTICE_TYPE, { message });
        } catch {
          // Remote notices are best-effort presentation and must not affect Pi.
        }
      });
    }
  }

  // Capture the Host lease at extension registration. A released extension
  // publisher must never be able to target a later Host in this process.
  const committedRolloverPublisher = getCommittedRolloverPublisher();
  const sessionLifecyclePublisher = getSessionLifecyclePublisher();
  const quotaResumePublisher = getQuotaResumePublisher();
  const fallbackController = getQuotaFallbackController();
  const quotaResumeStatusObserver = getQuotaResumeStatusObserver();
  let quotaPlanningGeneration = 0;
  let agentRunLifecycleGeneration = 0;
  let remoteCompletionReport: { generation: number; sessionId: string; text: string } | null = null;
  const taskHandoffEnabled = options.enableTaskHandoff === true || committedRolloverPublisher !== null;
  // Composition supplies Core's production dependencies explicitly.
  const stateStore = options.store!;
  const continuityStore = options.continuityStore!;
  const continuityNow = options.now ?? Date.now;
  const core = createCoreIntegration({
    store: stateStore,
    continuityStore,
    committedRolloverPublisher,
    taskHandoffEnabled,
    now: continuityNow,
    runTimer: options.runTimer,
    runCost: options.runCost,
    taskMetrics: options.taskMetrics,
    contextGovernorTuning: options.contextGovernorTuning,
    captureProjectFingerprint: options.captureProjectFingerprint,
  });
  const runtime = core.runtime;
  const run = core.run;
  const handoff = core.handoff;
  const contextGovernor = core.contextGovernor;
  const execution = core.execution;
  const resolveProjectRoot = options.resolveProjectRoot ??
    defaultResolveProjectRoot;

  const subscriptionUsageMonitor = new SubscriptionUsageMonitor(
    options.subscriptionUsageProvider ?? chatGptSubscriptionUsageProvider,
    continuityNow,
  );
  const presentation = new PresentationIntegration(pi, {
    getSemanticSnapshot: () => run.deriveSnapshot(),
    getState: () => runtime.projectRoot === null ? null : runtime.state,
    getProjectRoot: () => runtime.projectRoot,
    getAuthoritativeState: () => run.authoritativeState,
    getStateUnavailableReason: () => run.stateUnavailableReason,
    getRunStale: () => run.agentRunIsStale,
    subscriptionUsageMonitor,
    getStatusWidth: options.getStatusWidth,
    now: options.now,
    activityLingerMs: options.activityLingerMs,
    scheduleActivityRefresh: options.scheduleActivityRefresh,
    clearActivityRefresh: options.clearActivityRefresh,
    runTimer: core.runTimer,
    runCost: core.runCost,
    taskMetrics: core.taskMetrics,
    uiEnabled: featureSelection.presentation,
  });
  const presentationReader: PindiePresentationReader = {
    snapshot: () => presentation.snapshot(),
  };
  let releaseQuotaStatusObserver = quotaResumeStatusObserver?.subscribe((status) => {
    presentation.setQuotaResumeWaiting(status);
  }) ?? null;
  presentation.setQuotaResumeWaiting(quotaResumeStatusObserver?.getSnapshot() ?? null);
  const cancelQuotaResume = (ctx: ExtensionContext): void => {
    ++quotaPlanningGeneration;
    if (quotaResumePublisher === null) return;
    try {
      quotaResumePublisher({ type: "cancel", sessionId: ctx.sessionManager.getSessionId() });
    } catch {
      // Host control may already be released during teardown.
    }
  };
  const quotaResume = registerQuotaResumeIntegration(pi, options.quotaResumePreferenceStore!, {
    onPreferenceChanged: (enabled, ctx) => {
      if (!enabled) cancelQuotaResume(ctx);
    },
  });
  const quotaFallback = registerQuotaFallbackIntegration(pi, options.quotaFallbackPreferenceStore!, {
    canEnable: (sessionId) => {
      try { return fallbackController?.canUseBackup(sessionId) === true; }
      catch { return false; } // Released Host and stale Session fail closed.
    },
  });
  type LiveRemoteSession = { projectRoot: string; sessionId: string; ctx: ExtensionContext; generation: number };
  let liveRemoteSession: LiveRemoteSession | null = null;
  let nextRemoteLeaseGeneration = 0;
  let lastCheckpointCompactionId: string | null = null;
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

  const bootstrapRemoteForSession = async (
    live: LiveRemoteSession,
    remoteSessionId: string,
    remoteSessionName: string | undefined,
  ): Promise<void> => {
    const remote = options.remoteCompanion;
    if (!remote || liveRemoteSession !== live) return;
    const remoteLeaseGeneration = live.generation;
    await remote.companion.bind(
      live.projectRoot,
      remote.guildId,
      remoteSessionId,
      { sessionName: remoteSessionName, taskGoal: runtime.state.task?.goal, status: remoteStatusFacts(), getStatus: remoteStatusFacts },
    );
    if (liveRemoteSession !== live) return;
    projectRemoteSemantics(false);
    if (remote.companion.activeSessionId !== remoteSessionId) {
      liveRemoteSession = null;
      remote.companion.shutdown(remoteSessionId);
      return;
    }
    if (remote.discord) {
      if (liveRemoteSession !== live || remote.companion.activeSessionId !== remoteSessionId) return;
      void remote.discord.start(
        (threadId, text) => {
          const current = liveRemoteSession;
          if (!current || current.sessionId !== remoteSessionId || current.generation !== remoteLeaseGeneration) return Promise.resolve("failed" as const);
          if (remote.companion.activeSessionId !== remoteSessionId) return Promise.resolve("failed" as const);
          const currentPi = remotePiFor(remoteSessionId, remoteLeaseGeneration);
          if (!currentPi) return Promise.resolve("failed" as const);
          return remote.companion.input(threadId, text, currentPi);
        },
        () => {
          const current = liveRemoteSession;
          if (!current || current.sessionId !== remoteSessionId || current.generation !== remoteLeaseGeneration) return;
          if (remote.companion.activeSessionId !== remoteSessionId) return;
          const entries = safeSessionEntries(current.ctx);
          if (!entries) return;
          void remote.companion.catchUp(entries).catch(() => undefined);
        },
        (threadId) => remote.companion.isMappedThread(threadId),
      ).catch(() => undefined);
      return;
    }
    if (liveRemoteSession !== live || remote.companion.activeSessionId !== remoteSessionId) return;
    const entries = safeSessionEntries(live.ctx);
    if (!entries) return;
    await remote.companion.catchUp(entries);
    if (liveRemoteSession !== live || remote.companion.activeSessionId !== remoteSessionId) return;
  };

  const markUnavailable = (reason: string): void => {
    core.markAuthorityUnavailable(reason);
    presentation.refreshStatus();
    projectRemoteSemantics();
  };

  const remoteStatusFacts = (): RemoteStatusFacts => {
    const task = runtime.state.task;
    return {
      taskGoal: task?.goal ?? null,
      taskStatus: getTaskStatus(runtime.state),
      activity: presentation.runActivity?.activity ?? null,
      verificationStatus: task ? getVerificationStatus(task) : null,
      elapsedMs: core.runTimer.durationMs,
      semanticAuthority: run.stateUnavailableReason !== null
        ? "unavailable"
        : run.agentRunIsStale ? "stale" : "coherent",
      localUiPrompt: false,
    };
  };

  const projectRemoteSemantics = (includeMilestones = true): void => {
    const remote = options.remoteCompanion?.companion;
    const live = liveRemoteSession;
    const task = runtime.state.task;
    if (!remote) return;
    void remote.status(remoteStatusFacts());
    if (live !== null) {
      let isIdle = false;
      let pendingMessageCount = 1;
      try {
        isIdle = live.ctx.isIdle();
        pendingMessageCount = live.ctx.hasPendingMessages() ? 1 : 0;
      } catch {
        // A stale ExtensionContext cannot authorize an immediate signal.
      }
      const signal = classifyHumanSignal({
        phase: "current",
        sessionId: live.sessionId,
        authority: run.stateUnavailableReason !== null
          ? "unavailable"
          : run.agentRunIsStale ? "stale" : "coherent",
        authorityUnavailableReason: run.stateUnavailableReason,
        taskStatus: getTaskStatus(runtime.state),
        task,
        isIdle,
        automaticWorkSettled: false,
        pendingMessageCount,
        quotaResumeWaiting: quotaResumeStatusObserver?.getSnapshot()?.sessionId === live.sessionId,
      });
      if (signal?.external === "attention") {
        void remote.humanSignal(signal);
      }
    }
    if (!includeMilestones || !task) return;
    void remote.milestone(`verification:${getVerificationStatus(task)}`, `VERIFICATION · ${getVerificationStatus(task).toUpperCase()}`);
  };

  const semanticStateChanged = (): void => {
    core.notifySemanticStateChanged();
    presentation.refreshStatus();
    projectRemoteSemantics();
  };

  const invalidateVerificationAfterProjectMutation = async (): Promise<{
    update: string | null;
    authorityUnavailable: boolean;
  }> => {
    execution.advanceEvidenceGeneration();
    if (
      runtime.projectRoot === null ||
      run.stateUnavailableReason !== null ||
      !runtime.state.task
    ) {
      return { update: null, authorityUnavailable: false };
    }
    const beforeVerification = structuredClone(runtime.state.task.verification);
    const beforeCompleted = runtime.state.task.completed;
    const hadCurrentChecks = beforeVerification.checks.length > 0;
    try {
      const result = await runtime.dispatchBounded({ type: "invalidate_verification" });
      if (!result.ok) {
        markUnavailable(
          `Pindie could not invalidate verification after project mutation: ${result.error.message}`,
        );
        return { update: null, authorityUnavailable: false };
      }
    } catch (error) {
      if (error instanceof PindieStateMutationUncertainError) {
        const warning = "Pindie could not establish verification freshness after this project mutation; semantic authority is unavailable for this Run.";
        markUnavailable(warning);
        return { update: warning, authorityUnavailable: true };
      }
      if (error instanceof StateLockBusyError) {
        presentation.refreshStatus();
        throw error;
      }
      markUnavailable(
        `Pindie could not persist verification invalidation: ${errorMessage(error)}`,
      );
      throw error;
    }
    const afterTask = runtime.state.task;
    const semanticChanged = afterTask !== null && (
      beforeCompleted !== afterTask.completed ||
      !isDeepStrictEqual(beforeVerification, afterTask.verification)
    );
    semanticStateChanged();
    if (!semanticChanged) return { update: null, authorityUnavailable: false };
    const derivation = run.deriveSnapshot();
    return {
      update: renderPindieProjectMutationUpdate(
        runtime.state,
        derivation.ok ? derivation.snapshot : undefined,
        hadCurrentChecks,
      ),
      authorityUnavailable: false,
    };
  };

  const renderEligibilityAfterSemanticChange = (
    capabilitiesAtCall: ReadonlySet<PindieCapability> | null,
  ): string | null => {
    if (capabilitiesAtCall === null) return null;
    const derivation = run.deriveSnapshot();
    if (
      !derivation.ok ||
      sameCapabilities(capabilitiesAtCall, deriveCapabilities(derivation.snapshot))
    ) {
      return null;
    }
    return renderCurrentPindieActionEligibility(derivation.snapshot);
  };

  core.registerTools(pi, {
    onSemanticStateChange: () => {
      presentation.refreshStatus();
      projectRemoteSemantics();
    },
    onCompletionReport: (text) => {
      const generation = run.activeAgentRunGeneration;
      if (generation !== null && liveRemoteSession !== null) {
        remoteCompletionReport = { generation, sessionId: liveRemoteSession.sessionId, text };
      }
    },
  });

  if (options.projectMemorySink !== undefined) {
    pi.registerTool(createPindieMemoryCaptureTool({
      sink: options.projectMemorySink,
      getProjectRoot: () => runtime.projectRoot,
      getState: () => run.authoritativeState,
      now: () => new Date(continuityNow()),
    }));
  }
  const watch = featureSelection.presentation
    ? createWatchCommand(pi, {}, () => presentation.beginWatchStatus())
    : null;
  if (featureSelection.presentation) {
    pi.registerCommand("efficiency", {
      description: "Show read-only runtime efficiency facts",
      handler: async (args, ctx) => presentation.handleEfficiencyCommand(args, ctx),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    watch?.sessionStart(ctx);
    ++agentRunLifecycleGeneration;
    await quotaResume.restoreSession(ctx);
    await quotaFallback.restoreSession(ctx);
    const nativeSessionId = options.remoteCompanion || taskHandoffEnabled
      ? ctx.sessionManager.getSessionId()
      : null;
    const remoteSessionId = options.remoteCompanion ? nativeSessionId : null;
    const remoteSessionName = options.remoteCompanion
      ? ctx.sessionManager.getSessionName()
      : undefined;
    presentation.setStatusContext(ctx);
    presentation.resetTrackers();
    presentation.clearStatus(ctx);
    presentation.resetSubscriptionUsage();
    core.resetRuntimeForSession(nativeSessionId);
    lastCheckpointCompactionId = null;

    let projectRoot: string | null = null;
    try {
      projectRoot = await runBoundedOperation({
        label: "Pindie project root resolution",
        timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
        run: (signal) => resolveProjectRoot(ctx.cwd, signal),
      });
    } catch (error) {
      core.resetTaskMetrics();
      markUnavailable(
        `Could not resolve Pindie project root for '${ctx.cwd}': ${errorMessage(error)}`,
      );
    }
    if (projectRoot !== null) {
      try {
        await runBoundedOperation({
          label: "Pindie project State load",
          timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
          run: (signal) => run.loadProject(projectRoot!, signal),
        });
        const task = run.authoritativeState?.task ?? null;
        core.enterTaskMetricsSession(
          projectRoot,
          task !== null && !task.completed
            ? taskContractFingerprint(task)
            : null,
        );
      } catch (error) {
        core.resetTaskMetrics();
        markUnavailable(
          `Could not load Pindie State for '${ctx.cwd}': ${errorMessage(error)}`,
        );
      }
    }
    presentation.refreshStatus(ctx);
    void presentation.refreshSubscriptionUsage(ctx);
    if (options.remoteCompanion && runtime.projectRoot !== null && remoteSessionId !== null) {
      const live: LiveRemoteSession = {
        projectRoot: runtime.projectRoot,
        sessionId: remoteSessionId,
        ctx,
        generation: ++nextRemoteLeaseGeneration,
      };
      liveRemoteSession = live;
      // Remote is an optional projection. Its bind/catch-up work is detached so
      // an unavailable external transport cannot hold local Session startup.
      void bootstrapRemoteForSession(live, remoteSessionId, remoteSessionName).catch(() => undefined);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    ++agentRunLifecycleGeneration;
    cancelQuotaResume(ctx);
    try { fallbackController?.cancel(ctx.sessionManager.getSessionId()); } catch { /* Released Host. */ }
    await quotaResume.restoreBranch(ctx);
    await quotaFallback.restoreBranch(ctx);
  });

  pi.on("input", (event, ctx) => {
    ++agentRunLifecycleGeneration;
    cancelQuotaResume(ctx);
    options.remoteCompanion?.companion.observeInput(event.source, event.streamingBehavior);
  });
  pi.on("model_select", (event, ctx) => {
    let ownedByFallback = false;
    try {
      ownedByFallback = fallbackController?.observeModelSelect({
        sessionId: ctx.sessionManager.getSessionId(),
        provider: event.model.provider,
        modelId: event.model.id,
        source: event.source,
      }) === true;
    } catch { /* Released Host or stale context: treat as external. */ }
    if (ownedByFallback) return;
    ++agentRunLifecycleGeneration;
    cancelQuotaResume(ctx);
  });

  if (options.remoteCompanion) {
    // Pi remains transcript truth: session history is projected after each
    // finalized message, serialized by RemoteCompanion behind any catch-up.
    pi.on("message_end", () => {
      const live = liveRemoteSession;
      if (!live) return;
      const entries = safeSessionEntries(live.ctx);
      if (!entries) return;
      void options.remoteCompanion!.companion.catchUp(entries).catch(() => undefined);
    });
    pi.on("session_info_changed", (event) => {
      void options.remoteCompanion!.companion
        .rename(event.name ?? "")
        .catch(() => undefined);
    });
    pi.on("ui_prompt_start", () => options.remoteCompanion!.companion.setLocalUiPrompt(true));
    pi.on("ui_prompt_end", () => options.remoteCompanion!.companion.setLocalUiPrompt(false));
  }

  pi.on("session_shutdown", async (event, ctx) => {
    const watchStopped = watch?.shutdown();
    ++agentRunLifecycleGeneration;
    cancelQuotaResume(ctx);
    releaseQuotaStatusObserver?.();
    releaseQuotaStatusObserver = null;
    presentation.setQuotaResumeWaiting(null);
    let nativeSessionId: string | null = null;
    try {
      nativeSessionId = ctx.sessionManager.getSessionId();
    } catch {
      // A stale shutdown context cannot identify a lifecycle boundary.
    }
    if (nativeSessionId !== null && sessionLifecyclePublisher !== null) {
      try {
        sessionLifecyclePublisher({ sessionId: nativeSessionId, reason: event.reason });
      } catch {
        // Host lifecycle control is best effort during teardown; native cleanup continues.
      }
    }

    const remote = options.remoteCompanion;
    const sessionId = liveRemoteSession?.sessionId ?? remote?.companion.activeSessionId ?? null;
    liveRemoteSession = null;
    if (remote && sessionId !== null) remote.companion.shutdown(sessionId);
    remote?.discord?.stop();
    presentation.resetTrackers();
    presentation.clearStatus(ctx);
    core.resetRuntimeForSession(null);
    lastCheckpointCompactionId = null;
    presentation.setStatusContext(null);
    await watchStopped;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    ++agentRunLifecycleGeneration;
    remoteCompletionReport = null;
    let preparationGeneration: number | null = null;
    try {
      presentation.setStatusContext(ctx);
      if (isQuotaResumeAgentRun(event)) {
        void presentation.refreshSubscriptionUsage(ctx, { force: true }).catch(() => undefined);
      }
      core.resetAgentRunBookkeeping();
      if (run.authoritativeState !== null) {
        try {
          await runBoundedOperation({
            label: "Pindie pre-Run authoritative State refresh",
            timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
            run: (signal) => run.refreshAuthoritativeState(signal),
          });
        } catch (error) {
          markUnavailable(
            `Could not refresh Pindie State before this Agent Run: ${errorMessage(error)}`,
          );
        }
      }
      // Refresh precedes all identity snapshots so a new Run always begins from
      // authoritative project State rather than a previous session snapshot.
      core.beginAgentRunFacts(ctx);
      preparationGeneration = run.activeAgentRunGeneration;
      let derivation = run.deriveSnapshot();
      if (!derivation.ok) {
        markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
        derivation = run.deriveSnapshot();
      }
      presentation.clearActivityLingerRefresh();
      presentation.runActivity?.start();
      core.startRunMeasurements(
        ctx,
        featureSelection.presentation ? () => presentation.refreshStatus(ctx) : undefined,
      );
      const taskAtRunStart = run.authoritativeState?.task ?? null;
      if (
        derivation.ok &&
        derivation.snapshot.authority === "coherent" &&
        runtime.projectRoot !== null &&
        taskAtRunStart !== null &&
        !taskAtRunStart.completed
      ) {
        core.startRunForTask(
          runtime.projectRoot,
          taskContractFingerprint(taskAtRunStart),
        );
      } else {
        core.startRunWithoutTask();
      }
      presentation.refreshStatus(ctx);
      void options.remoteCompanion?.companion.status(remoteStatusFacts());

      if (!derivation.ok) {
        throw new Error(
          `Pindie unavailable semantic derivation failed: ${derivation.error}`,
        );
      }
      const state = run.authoritativeState;
      const promptContributions = [
        ...(options.projectMemorySink === undefined
          ? []
          : [corePromptContribution(appendPindieWorkMemoryContract(""))]),
      ];
      const systemPrompt = core.buildSystemPrompt(
        event.systemPrompt,
        promptContributions,
      );
      const unavailableReason = run.stateUnavailableReason ??
        (state === null
          ? "No project State has been loaded for this session."
          : null);
      return {
        systemPrompt,
        message: createPindieRunBaselineMessage(
          state,
          derivation.snapshot,
          unavailableReason,
        ),
      };
    } catch (error) {
      if (preparationGeneration !== null) {
        core.abortAgentRunPreparation(preparationGeneration);
      }
      throw error;
    }
  });

  pi.on("session_compact", (event, ctx) => {
    contextGovernor.observeSuccessfulCompaction({
      id: event.compactionEntry.id,
      reason: event.reason,
    });
    const compactionId = event.compactionEntry.id;
    if (lastCheckpointCompactionId === compactionId) return;
    lastCheckpointCompactionId = compactionId;

    let derivation = run.deriveSnapshot();
    if (!derivation.ok) {
      markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
      derivation = run.deriveSnapshot();
    }
    if (!derivation.ok) return;
    const state = run.authoritativeState;
    const unavailableReason = run.stateUnavailableReason ??
      (state === null ? "No project State has been loaded for this session." : null);
    const checkpoint = createPindieStateCheckpointMessage(
      state,
      derivation.snapshot,
      unavailableReason,
    );

    // A compaction during an active run is followed by another model request
    // (including overflow recovery). Queue the checkpoint as steering content
    // so Pi places it before that next decision. A completed/manual compaction
    // appends it without manufacturing an extra model turn.
    if (event.willRetry || ctx.hasPendingMessages()) {
      pi.sendMessage(checkpoint);
    } else {
      pi.sendMessage(checkpoint, { triggerTurn: false });
    }
  });

  // Failed or aborted compactions do not establish a new model-history
  // boundary, so they must not emit a potentially misleading checkpoint.
  pi.on("session_compact_failed", () => undefined);

  pi.on("context", (event, ctx) => {
    contextGovernor.observeUsage(ctx.getContextUsage());

    if (!taskHandoffEnabled || !run.hasActiveAgentRun) return;
    const guidance = formatContextLifecycleGuidance(
      contextGovernor.snapshot.pressure,
    );
    if (guidance === null) return;

    const agentRunGeneration = run.activeAgentRunGeneration;
    if (agentRunGeneration === null) return;

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      return;
    }
    if (!run.isAgentRunCurrent(agentRunGeneration)) return;
    if (handoff.isPendingFor(sessionId, agentRunGeneration)) return;

    const derivation = run.deriveSnapshot();
    const state = run.authoritativeState;
    const task = state?.task;
    if (
      !derivation.ok ||
      derivation.snapshot.authority !== "coherent" ||
      derivation.snapshot.taskStatus !== "active" ||
      task === undefined ||
      task === null ||
      task.humanGate !== null ||
      task.openLoops.blockers.length > 0
    ) return;

    return {
      messages: [
        ...event.messages.filter((message) =>
          !(message.role === "custom" && message.customType === PINDIE_CONTEXT_LIFECYCLE_TYPE)
        ),
        {
          role: "custom" as const,
          customType: PINDIE_CONTEXT_LIFECYCLE_TYPE,
          content: guidance,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (taskHandoffEnabled) {
      try {
        if (handoff.shouldSuppressContinuation({
          sessionId: ctx.sessionManager.getSessionId(),
          agentRunGeneration: run.activeAgentRunGeneration!,
        })) return;
      } catch {
        return;
      }
    } else if (handoff.shouldSuppressContinuation()) return;
    const derivation = run.deriveSnapshot();
    if (!derivation.ok) return;
    const finalAssistantMessage = [...event.context.contextMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    const shouldProbe = shouldProbeContinuation(derivation.snapshot, {
      probeAlreadyAttempted: run.activeTaskContinuationAttempted,
      hasPendingMessages: ctx.hasPendingMessages() || event.context.pendingMessages.length > 0,
      stoppedNormally: event.outcome === "completed" && finalAssistantMessage?.stopReason === "stop",
    });
    if (!shouldProbe) return;

    run.markContinuationAttempted();
    return {
      entries: [...event.entries, {
        type: "custom_message" as const,
        customType: PINDIE_CONTINUATION_PROBE_TYPE,
        content: PINDIE_CONTINUATION_PROBE_MESSAGE,
        display: false,
      }],
      continue: true,
    };
  });

  if (featureSelection.presentation || options.remoteCompanion) {
    pi.on("tool_execution_start", (event, ctx) => {
      options.remoteCompanion?.companion.recordToolStart(event.toolCallId, event.toolName, event.args);
      presentation.clearActivityLingerRefresh();
      presentation.runActivity?.toolExecutionStart(
        event.toolCallId,
        event.toolName,
      );
      presentation.refreshStatus(ctx);
      void options.remoteCompanion?.companion.status(remoteStatusFacts());
    });

    pi.on("tool_execution_end", (event, ctx) => {
      options.remoteCompanion?.companion.recordToolEnd(event.toolCallId, event.toolName, event.isError);
      presentation.runActivity?.toolExecutionEnd(event.toolCallId);
      presentation.scheduleActivityLingerRefresh();
      presentation.refreshStatus(ctx);
      void options.remoteCompanion?.companion.status(remoteStatusFacts());
    });
  }

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
    const effect = core.classifyToolEffect(event.toolName);
    const isHandoffCall = taskHandoffEnabled &&
      event.toolName === PINDIE_TASK_HANDOFF_TOOL;
    if (isHandoffCall) {
      // Reserve and arm the provisional terminal frontier before any async
      // authoritative-State refresh or Gateway work can yield to another call.
      const admission = handoff.reserveHandoff(event.toolCallId);
      if (!admission.allowed) {
        const reason = admission.reason === "work_in_flight"
          ? "Pindie rejected this handoff at the current work frontier: another authorized tool call is still in flight. Retry the handoff after that call settles."
          : admission.reason === "terminal_latch"
            ? "Pindie rejected this call: the current Run already has a terminal handoff reservation."
            : "Pindie rejected this handoff: no current Agent Run is available.";
        return { block: true, reason };
      }
    } else if (!handoff.beginNormalToolCall(event.toolCallId)) {
      return {
        block: true,
        reason: "Pindie blocked this call: a Task handoff has reserved the current Run's terminal work frontier.",
      };
    }
    const cancelToolAdmission = (): void => {
      if (isHandoffCall) handoff.cancelHandoffReservation(event.toolCallId);
      else handoff.cancelNormalToolCall(event.toolCallId);
    };
    if (
      effect.requiredCapability === "observe.project" ||
      effect.requiredCapability === "observe.git"
    ) {
      execution.recordAuthorizedObservation(event, effect);
      run.recordAuthorizedCall(event.toolCallId, effect);
      return;
    }

    let facts = run.semanticRunFacts;
    if (
      facts.stateAvailable &&
      facts.runCoherent &&
      runtime.projectRoot !== null
    ) {
      try {
        if (await runBoundedOperation({
          label: "Authoritative State refresh",
          timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
          run: (signal) => run.refreshAuthoritativeState(signal),
        })) semanticStateChanged();
      } catch (error) {
        if (
          error instanceof PindieLivenessTimeoutError ||
          error instanceof PindieLivenessAbortError
        ) {
          cancelToolAdmission();
          run.recordDeniedCall(effect);
          markUnavailable(
            `Could not refresh Pindie State before consequential work: ${error.message}`,
          );
          return {
            block: true,
            reason: error instanceof PindieLivenessTimeoutError
              ? "Pindie blocked this call: authoritative State refresh timed out; semantic authority is unavailable for this Run."
              : "Pindie blocked this call: authoritative State refresh was aborted; semantic authority is unavailable for this Run.",
          };
        }
        markUnavailable(
          `Could not refresh Pindie State before consequential work: ${errorMessage(error)}`,
        );
      }
      facts = run.semanticRunFacts;
    }

    const derivation = run.deriveSnapshot();
    if (!derivation.ok) {
      cancelToolAdmission();
      const reason = derivation.error;
      markUnavailable(`Internal semantic derivation failed: ${reason}`);
      return {
        block: true,
        reason: `Pindie blocked this call: internal semantic derivation failed: ${reason}`,
      };
    }

    const snapshot = derivation.snapshot;
    const capabilities = deriveCapabilities(snapshot);
    const authorization = core.authorizeToolEffect(capabilities, effect);
    if (!authorization.allowed) {
      cancelToolAdmission();
      run.recordDeniedCall(effect);
      return {
        block: true,
        reason: coreGatewayDenialReason(
          snapshot,
          authorization.requiredCapability,
        ),
      };
    }

    if (isHandoffCall) {
      if (snapshot.authority !== "coherent") {
        cancelToolAdmission();
        run.recordDeniedCall(effect);
        return {
          block: true,
          reason: "Pindie rejected this handoff: coherent Task authority is required at the current work frontier.",
        };
      }
      if (snapshot.taskStatus !== "active") {
        cancelToolAdmission();
        run.recordDeniedCall(effect);
        return {
          block: true,
          reason: "Pindie rejected this handoff: an active, unblocked Task is required at the current work frontier.",
        };
      }
    }

    if (isHandoffCall) {
      if (!handoff.isHandoffReservedFor(event.toolCallId)) {
        return {
          block: true,
          reason: "Pindie rejected this handoff: its provisional Session or Agent Run reservation is stale.",
        };
      }
      run.recordAuthorizedCall(event.toolCallId, effect);
      return;
    }

    await execution.recordAuthorizedConsequentialCall(
      event,
      effect,
      runtime.projectRoot!,
      capabilities,
    );
    run.recordAuthorizedCall(event.toolCallId, effect);
  });

  pi.on("tool_result", async (event, ctx) => {
    let handoffBinding: { sessionId: string; agentRunGeneration: number } | null | undefined;
    if (taskHandoffEnabled) {
      try {
        const agentRunGeneration = run.activeAgentRunGeneration;
        handoffBinding = agentRunGeneration === null
          ? null
          : {
              sessionId: ctx.sessionManager.getSessionId(),
              agentRunGeneration,
            };
      } catch {
        handoffBinding = null;
      }
    }
    const handoffResult = handoff.handleToolResult(
      event.toolCallId,
      event.toolName,
      event.isError,
      handoffBinding,
    );
    const telemetryKind = event.toolName === PINDIE_TASK_HANDOFF_TOOL &&
      handoffResult === "ignored"
      ? null
      : run.recordToolResult(event.toolCallId, event.isError);
    if (
      handoffResult === "handoff_invalidated" ||
      handoffResult === "handoff_failed"
    ) {
      if (handoffResult === "handoff_invalidated") {
        console.warn("[Pindie] Task handoff settlement was invalidated fail-closed.");
      }
      return;
    }
    if (handoffResult === "handoff_succeeded") return;
    const authorizedExecution = execution.takeAuthorizedExecution(
      event.toolCallId,
    );
    if (telemetryKind === "memory") return;
    if (!authorizedExecution) return;
    const { effect } = authorizedExecution;
    if (
      !event.isError &&
      (effect.requiredCapability === "task.start" ||
        effect.requiredCapability === "task.replace")
    ) {
      run.recordSuccessfulCapability(effect.requiredCapability);
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
      const invalidation = await invalidateVerificationAfterProjectMutation();
      if (invalidation.authorityUnavailable) {
        return {
          content: [
            ...event.content,
            { type: "text", text: invalidation.update! },
          ],
        };
      }
      if (invalidation.update === null) return;
      const eligibility = renderEligibilityAfterSemanticChange(
        authorizedExecution.capabilitiesAtCall,
      );
      return {
        content: [
          ...event.content,
          { type: "text", text: invalidation.update },
          ...(eligibility === null ? [] : [{ type: "text" as const, text: eligibility }]),
        ],
      };
    }

    const evidenceResult = execution.captureEvidenceIfEligible(
      authorizedExecution,
      event,
      run.authoritativeState,
      run.semanticRunFacts,
    );
    if (event.isError) return evidenceResult;
    const eligibility = renderEligibilityAfterSemanticChange(
      authorizedExecution.capabilitiesAtCall,
    );
    if (eligibility === null) return evidenceResult;
    return {
      content: [
        ...(evidenceResult?.content ?? event.content),
        { type: "text" as const, text: eligibility },
      ],
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // Pi can dispose an old session runner before its in-flight Agent Run reaches
    // the finally-path that emits agent_settled. Its context is then deliberately
    // stale; that obsolete run must not touch or reset this runtime's state.
    const entries = safeSessionEntries(ctx);
    if (!entries) return;

    const settlementLifecycleGeneration = agentRunLifecycleGeneration;
    const settlementRemoteLease = liveRemoteSession;
    let settlementSessionId: string | null = null;
    try {
      settlementSessionId = ctx.sessionManager.getSessionId();
    } catch {
      // A context without a stable native Session identity cannot emit a final
      // attention milestone.
    }
    const isCurrentSettlement = (): boolean => {
      if (
        settlementSessionId === null ||
        agentRunLifecycleGeneration !== settlementLifecycleGeneration ||
        run.hasActiveAgentRun
      ) return false;
      try {
        if (
          ctx.sessionManager.getSessionId() !== settlementSessionId ||
          ctx.hasPendingMessages()
        ) return false;
      } catch {
        return false;
      }
      return !options.remoteCompanion || liveRemoteSession === settlementRemoteLease;
    };

    presentation.setStatusContext(ctx);
    const result = await core.settleAgentRun(ctx, entries);
    if (result.status !== "settled") return;

    presentation.clearActivityLingerRefresh();
    presentation.runActivity?.settle();
    presentation.refreshStatus(ctx);

    // Quota planning remains detached for ordinary lifecycle work, but only a
    // detected quota incident starts the external usage refresh. Remote final
    // delivery waits for this narrow successor decision before classifying a
    // genuine stop.
    let quotaSuccessorPromise: Promise<boolean> | null = null;
    if (
      result.facts !== null &&
      result.facts.settlementGeneration !== null &&
      (fallbackController !== null ||
        (quotaResumePublisher !== null && quotaResume.quotaAutoResumeEnabled))
    ) {
      let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]> | null = null;
      try {
        branch = ctx.sessionManager.getBranch();
      } catch {
        // A stale Extension context cannot authorize autonomous planning.
      }
      if (branch !== null) {
        const planningGeneration = quotaPlanningGeneration;
        if (detectCodexQuotaIncident(branch) !== null &&
          ((quotaFallback.quotaFallbackEnabled && fallbackController !== null) ||
            (quotaResumePublisher !== null && quotaResume.quotaAutoResumeEnabled))) {
          quotaSuccessorPromise = (async () => {
            const facts = await buildCodexQuotaRecoveryFacts({ ctx, branch, monitor: subscriptionUsageMonitor, now: continuityNow });
            if (facts === null || planningGeneration !== quotaPlanningGeneration || !isCurrentSettlement()) return false;
            if (quotaFallback.quotaFallbackEnabled && fallbackController !== null) {
              try {
                if (await fallbackController.request({
                  sessionId: facts.sessionId, anchorEntryId: facts.anchorEntryId,
                  provider: facts.provider, modelId: facts.modelId,
                  detectedAt: facts.detectedAt, restoreAt: facts.recoveryAt,
                })) return true; // Commit is final even if the new Run makes this settlement stale.
              } catch { /* Resume may still take over if planning remains current. */ }
            }
            if (planningGeneration !== quotaPlanningGeneration || !isCurrentSettlement() ||
              !quotaResume.quotaAutoResumeEnabled || quotaResumePublisher === null) return false;
            try { return quotaResumePublisher({ type: "schedule", plan: quotaResumePlanFromRecoveryFacts(facts) }) === true; }
            catch { return false; }
          })().catch(() => false);
        } else if (detectQuotaFallbackBackupFailure(branch) && fallbackController !== null && settlementSessionId !== null) {
          quotaSuccessorPromise = (async () => {
            if (!isCurrentSettlement()) return false;
            const plan = await fallbackController.backupFailed(settlementSessionId);
            if (plan === null || !quotaResume.quotaAutoResumeEnabled || quotaResumePublisher === null ||
              continuityNow() >= plan.restoreAt || planningGeneration !== quotaPlanningGeneration || !isCurrentSettlement()) return false;
            try { return quotaResumePublisher({ type: "schedule", plan: {
              sessionId: plan.sessionId, anchorEntryId: plan.anchorEntryId, provider: plan.provider,
              modelId: plan.modelId, detectedAt: plan.detectedAt, resumeAt: plan.restoreAt,
            } }) === true; }
            catch { return false; }
          })().catch(() => false);
        }
        if (quotaSuccessorPromise) void quotaSuccessorPromise;
      }
    }
    void presentation.refreshSubscriptionUsage(ctx);
    if (options.remoteCompanion) {
      const remote = options.remoteCompanion.companion;
      const lastEntry = entries.at(-1);
      const finalizeRemoteSettlement = async (): Promise<void> => {
        const quotaSuccessorCommitted = quotaSuccessorPromise === null
          ? false
          : await quotaSuccessorPromise;
        if (!isCurrentSettlement()) return;

        await remote.status(remoteStatusFacts());
        if (!isCurrentSettlement()) return;
        await remote.catchUp(entries);
        if (!isCurrentSettlement()) return;
        if (lastEntry) await remote.flushExecution(lastEntry.id);
        if (!isCurrentSettlement()) return;
        const facts = result.facts;
        if (facts === null || settlementSessionId === null) return;
        const signal = classifyHumanSignal({
          phase: "settlement",
          sessionId: settlementSessionId,
          authorityUnavailableReason: run.stateUnavailableReason,
          settlementGeneration: facts.settlementGeneration,
          facts,
          automaticSuccessorCommitted: result.automaticSuccessorCommitted,
          quotaSuccessorCommitted,
        });
        if (signal === null || !isCurrentSettlement()) return;
        const completionReport = signal.kind === "completed" &&
          remoteCompletionReport?.generation === facts.settlementGeneration &&
          remoteCompletionReport.sessionId === settlementSessionId
          ? remoteCompletionReport.text : undefined;
        await remote.humanSignal(signal, { isCurrent: isCurrentSettlement, completionReport });
      };
      void finalizeRemoteSettlement().catch(() => undefined);
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
    featureSelection,
    presentation: presentationReader,
    core,
    runtime,
    runActivity: presentation.runActivity,
    runCost: presentation.runCost,
    runTimer: presentation.runTimer,
    taskMetrics: presentation.taskMetrics,
    contextGovernor,
    get stateUnavailableReason() {
      return run.stateUnavailableReason;
    },
    get quotaAutoResumeEnabled() {
      return quotaResume.quotaAutoResumeEnabled;
    },
    get quotaFallbackEnabled() {
      return quotaFallback.quotaFallbackEnabled;
    },
  };
}

export function registerConfiguredPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions = {},
  env: Record<string, string | undefined> = process.env,
): PindieExtensionIntegration {
  const composition = composePindieExtension(options, { configureOptionalFeatures: true, env });
  for (const warning of composition.warnings) console.warn(warning);
  registerDiscordRemotePreferenceCommand(pi,
    new FileDiscordRemotePreferenceStore(composition.storageRoots.globalBaseDir), composition.featureSelection.remote);
  return registerComposedPindieExtension(
    pi,
    composition.extensionOptions,
    composition.featureSelection,
  );
}

export default function pindieExtension(pi: ExtensionAPI): void {
  registerConfiguredPindieExtension(pi);
}
