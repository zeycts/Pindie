import { isDeepStrictEqual } from "node:util";

import {
  composeConfiguredPindieExtension,
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
import { PresentationIntegration } from "./presentation-integration.ts";
import { SelfImprovementIntegration } from "./self-improvement-integration.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReader,
  RunExperienceStore,
} from "./experience-store.ts";
import type {
  StrategyCandidateReader,
  StrategyCandidateStore,
} from "./strategy-candidates.ts";
import type {
  StrategyDerivationCandidateReader,
  StrategyDerivationCandidateStore,
} from "./strategy-derivation-candidates.ts";
import type {
  StrategyTrustScopeCandidateStore,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionStore,
} from "./strategy-trust-scope-decisions.ts";
import type { StrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import type { ScopeProjectTrustReader } from "./strategy-trust-scope-review.ts";
import {
  emptyPromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
  type StrategyRevisionDecisionStore,
  type PromotedStrategyRevisionCatalog,
} from "./strategy-decisions.ts";
import type {
  StrategyDerivationDecisionReader,
  StrategyDerivationDecisionStore,
} from "./strategy-derivation-decisions.ts";
import type {
  TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import type { TrialRuntime } from "./strategy-trial.ts";
import type { DerivationRuntime } from "./strategy-derivation.ts";
import type { RemoteCompanion, RemotePi, RemoteStatusFacts } from "./remote-companion.ts";
import type { DiscordRemote } from "./discord-remote.ts";
import type { RemoteRoutingStore } from "./remote-routing.ts";
import type { ProjectMemorySink } from "./project-memory.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import type { PolicySnapshot } from "./policy.ts";
import type { ProjectFingerprint } from "./project-mutation.ts";
import type { ReasoningController } from "./reasoning.ts";
import type { RunActivityTracker } from "./run-activity.ts";
import type { RunCostTracker } from "./run-cost.ts";
import type { RunTimer } from "./run-timer.ts";
import type { TaskMetricsTracker } from "./task-metrics.ts";
import type { PindieRuntime } from "./runtime.ts";
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
  type GlobalWriterLock,
  type TaskContinuityStore,
  type PindieStateStore,
} from "./store.ts";
import { taskContractFingerprint } from "./task-continuity.ts";
import {
  getCommittedRolloverPublisher,
  getSessionLifecyclePublisher,
} from "./long-task-control.ts";
import { PINDIE_TASK_HANDOFF_TOOL } from "./task-handoff-runtime.ts";
import type { SubscriptionUsageProvider } from "./subscription-usage.ts";
import { createPindieMemoryCaptureTool } from "./tools/memory.ts";

type ProjectRootResolver = (cwd: string) => Promise<string>;

export interface PindieExtensionOptions {
  /** Startup selection; composition resolves this before registration. */
  featureSelection?: Partial<PindieFeatureSelection>;
  /** Explicit production/test storage namespaces; never inferred from a Store class. */
  storageRoots?: Partial<PindieStorageRoots>;
  /** Explicit Remote routing storage used when composition constructs Remote. */
  remoteRoutingStore?: RemoteRoutingStore;
  store?: PindieStateStore;
  continuityStore?: TaskContinuityStore;
  experienceStore?: RunExperienceStore;
  experienceReader?: RunExperienceReader;
  strategyCandidateStore?: StrategyCandidateStore;
  strategyCandidateReader?: StrategyCandidateReader;
  strategyDerivationCandidateStore?: StrategyDerivationCandidateStore;
  strategyDerivationCandidateReader?: StrategyDerivationCandidateReader;
  strategyDecisionStore?: StrategyRevisionDecisionStore;
  strategyDecisionReader?: StrategyRevisionDecisionReader;
  strategyDerivationDecisionStore?: StrategyDerivationDecisionStore;
  strategyDerivationDecisionReader?: StrategyDerivationDecisionReader;
  strategyTrustScopeCandidateStore?: StrategyTrustScopeCandidateStore;
  strategyTrustScopeDecisionStore?: StrategyTrustScopeDecisionStore;
  strategyTrustScopeSourceResolver?: StrategyTrustScopeSourceResolver;
  strategyTrustScopeWriterLock?: GlobalWriterLock;
  crossProjectExperienceReader?: RunExperienceProjectReader;
  scopeProjectTrustReader?: ScopeProjectTrustReader;
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
  readonly core: CoreIntegration;
  readonly runtime: PindieRuntime;
  readonly runActivity: RunActivityTracker | null;
  readonly reasoning: ReasoningController | null;
  readonly runCost: RunCostTracker;
  readonly runTimer: RunTimer;
  readonly taskMetrics: TaskMetricsTracker;
  readonly contextGovernor: CoreIntegration["contextGovernor"];
  readonly trial: TrialRuntime | null;
  readonly derivation: DerivationRuntime | null;
  readonly promotedStrategyRevisionCatalog: PromotedStrategyRevisionCatalog;
  /** Runtime-derived Seeds plus valid promoted Seed/Derived trust entries. */
  readonly trustedStrategyPortfolio: TrustedStrategyPortfolio | null;
  readonly policySnapshot: PolicySnapshot | null;
  readonly stateUnavailableReason: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH = 256;

function optionalGlobalUnavailableReason(error: unknown): string {
  const reason = `optional user-global layer unavailable: ${errorMessage(error)}`
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return reason.length <= MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH
    ? reason
    : `${reason.slice(0, MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH - 1)}…`;
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
  // Capture the Host lease at extension registration. A released extension
  // publisher must never be able to target a later Host in this process.
  const committedRolloverPublisher = getCommittedRolloverPublisher();
  const sessionLifecyclePublisher = getSessionLifecyclePublisher();
  const taskHandoffEnabled = options.enableTaskHandoff === true || committedRolloverPublisher !== null;
  // Composition supplies Core's production dependencies explicitly. Feature
  // dependencies are validated and assembled only when Self-Improvement is
  // selected; Core-only assembly never manufactures or touches them.
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

  let selfImprovement: SelfImprovementIntegration | null = null;
  if (featureSelection.selfImprovement) {
    const {
      experienceStore,
      experienceReader,
      crossProjectExperienceReader,
      strategyCandidateStore,
      strategyCandidateReader,
      strategyDerivationCandidateStore,
      strategyDerivationCandidateReader,
      strategyDecisionStore,
      strategyDecisionReader,
      strategyDerivationDecisionStore,
      strategyDerivationDecisionReader,
      strategyTrustScopeCandidateStore,
      strategyTrustScopeDecisionStore,
      strategyTrustScopeSourceResolver,
      strategyTrustScopeWriterLock,
      scopeProjectTrustReader,
    } = options;
    if (
      experienceStore === undefined || experienceReader === undefined ||
      strategyCandidateStore === undefined || strategyCandidateReader === undefined ||
      strategyDerivationCandidateStore === undefined || strategyDerivationCandidateReader === undefined ||
      strategyDecisionStore === undefined || strategyDecisionReader === undefined ||
      strategyDerivationDecisionStore === undefined || strategyDerivationDecisionReader === undefined ||
      strategyTrustScopeCandidateStore === undefined || strategyTrustScopeDecisionStore === undefined ||
      strategyTrustScopeSourceResolver === undefined || strategyTrustScopeWriterLock === undefined ||
      scopeProjectTrustReader === undefined
    ) {
      throw new Error("Self-Improvement composition is missing an explicit production dependency.");
    }
    selfImprovement = new SelfImprovementIntegration({
      pi,
      core: {
        getProjectRoot: () => runtime.projectRoot,
        getActiveAgentRunGeneration: () => run.activeAgentRunGeneration,
        isAgentRunCurrent: (generation) => run.isAgentRunCurrent(generation),
      },
      experienceStore,
      experienceReader,
      crossProjectExperienceReader,
      strategyCandidateStore,
      strategyCandidateReader,
      strategyDerivationCandidateStore,
      strategyDerivationCandidateReader,
      strategyDecisionStore,
      strategyDecisionReader,
      strategyDerivationDecisionStore,
      strategyDerivationDecisionReader,
      strategyTrustScopeCandidateStore,
      strategyTrustScopeDecisionStore,
      strategyTrustScopeSourceResolver,
      strategyTrustScopeWriterLock,
      scopeProjectTrustReader,
      now: continuityNow,
    });
  }
  const presentation = new PresentationIntegration(pi, {
    getState: () => runtime.projectRoot === null ? null : runtime.state,
    getProjectRoot: () => runtime.projectRoot,
    getAuthoritativeState: () => run.authoritativeState,
    getStateUnavailableReason: () => run.stateUnavailableReason,
    getRunStale: () => run.agentRunIsStale,
    subscriptionUsageProvider: options.subscriptionUsageProvider,
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
  type LiveRemoteSession = { sessionId: string; ctx: ExtensionContext; generation: number };
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

  const markUnavailable = (reason: string): void => {
    core.markAuthorityUnavailable(reason);
    presentation.refreshStatus();
    void options.remoteCompanion?.companion.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
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
    core.notifySemanticStateChanged();
    presentation.refreshStatus();
    projectRemoteSemantics();
  };

  const invalidateVerificationAfterProjectMutation = async (): Promise<string | null> => {
    execution.advanceEvidenceGeneration();
    if (
      runtime.projectRoot === null ||
      run.stateUnavailableReason !== null ||
      !runtime.state.task
    ) {
      return null;
    }
    const beforeVerification = structuredClone(runtime.state.task.verification);
    const beforeCompleted = runtime.state.task.completed;
    const hadCurrentChecks = beforeVerification.checks.length > 0;
    try {
      const result = await runtime.dispatch({ type: "invalidate_verification" });
      if (!result.ok) {
        markUnavailable(
          `Pindie could not invalidate verification after project mutation: ${result.error.message}`,
        );
        return null;
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
    const afterTask = runtime.state.task;
    const semanticChanged = afterTask !== null && (
      beforeCompleted !== afterTask.completed ||
      !isDeepStrictEqual(beforeVerification, afterTask.verification)
    );
    semanticStateChanged();
    if (!semanticChanged) return null;
    const derivation = run.deriveSnapshot();
    return renderPindieProjectMutationUpdate(
      runtime.state,
      derivation.ok ? derivation.snapshot : undefined,
      hadCurrentChecks,
    );
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
    resolveRevisionSelector: selfImprovement === null
      ? undefined
      : (selector, kind, ctx) => selfImprovement!.resolveRevisionSelector(selector, kind, ctx),
  });
  selfImprovement?.registerTools();

  if (options.projectMemorySink !== undefined) {
    pi.registerTool(createPindieMemoryCaptureTool({
      sink: options.projectMemorySink,
      getProjectRoot: () => runtime.projectRoot,
      getState: () => run.authoritativeState,
      now: () => new Date(continuityNow()),
    }));
  }
  if (featureSelection.presentation) {
    pi.registerCommand("efficiency", {
      description: "Show read-only runtime efficiency facts",
      handler: async (args, ctx) => presentation.handleEfficiencyCommand(args, ctx),
    });
  }
  selfImprovement?.registerCommands();

  if (featureSelection.presentation) {
    pi.registerCommand("reasoning", {
      description: "Choose who controls thinking level (auto|manual)",
      getArgumentCompletions: (prefix) => ["auto", "manual"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => presentation.handleReasoningCommand(args, ctx),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
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
    selfImprovement?.resetForSession();
    core.resetRuntimeForSession(nativeSessionId);
    lastCheckpointCompactionId = null;

    try {
      const projectRoot = await resolveProjectRoot(ctx.cwd);
      await run.loadProject(projectRoot);
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

  pi.on("session_shutdown", (event, ctx) => {
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
    selfImprovement?.resetForSession();
    core.resetRuntimeForSession(null);
    lastCheckpointCompactionId = null;
    presentation.setStatusContext(null);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      presentation.setStatusContext(ctx);
      core.resetAgentRunBookkeeping();
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
      core.beginAgentRunFacts(ctx);
      const selfImprovementRun = selfImprovement === null
        ? {
            adaptationLease: null,
            trialLease: null,
            derivationLease: null,
            promptContributions: [] as readonly string[],
          }
        : await selfImprovement.prepareAgentRun(ctx);

      let derivation = run.deriveSnapshot();
      if (!derivation.ok) {
        markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
        derivation = run.deriveSnapshot();
      }
      presentation.reasoning?.beforeAgentStart();
      presentation.applyRequestedThinkingLevel();
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
        selfImprovementRun.adaptationLease === null &&
        selfImprovementRun.trialLease === null &&
        selfImprovementRun.derivationLease === null &&
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
        selfImprovement?.resetForSession();
        throw new Error(
          `Pindie unavailable semantic derivation failed: ${derivation.error}`,
        );
      }
      const state = run.authoritativeState;
      const promptContributions = [
        ...(options.projectMemorySink === undefined
          ? []
          : [corePromptContribution(appendPindieWorkMemoryContract(""))]),
        ...selfImprovementRun.promptContributions.map((content) => corePromptContribution(content)),
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
      run.policySnapshot,
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
    if (selfImprovement?.hasPacketForGeneration(agentRunGeneration) === true) return;

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

  pi.on("agent_end", (event, ctx) => {
    if (selfImprovement?.isSelfImprovementRunForGeneration(run.activeAgentRunGeneration) === true) return;
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

  pi.on("tool_call", async (event): Promise<ToolCallEventResult | void> => {
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
    const selfImprovementRestriction = selfImprovement?.restrictToolCall(effect) ?? null;
    if (selfImprovementRestriction !== null) {
      cancelToolAdmission();
      run.recordDeniedCall(effect);
      return { block: true, reason: selfImprovementRestriction };
    }
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
      cancelToolAdmission();
      const reason = derivation.error;
      markUnavailable(`Internal semantic derivation failed: ${reason}`);
      return {
        block: true,
        reason: `Pindie blocked this call: internal semantic derivation failed: ${reason}`,
      };
    }

    const snapshot = derivation.snapshot;
    const adaptationActive = selfImprovement?.isAdaptationRunActive === true;
    const derivationActive = selfImprovement?.isDerivationRunActive === true;
    const capabilities = new Set<PindieCapability>(deriveCapabilities(snapshot));
    if (effect.requiredCapability === "policy.adapt" && adaptationActive) {
      capabilities.add("policy.adapt");
    }
    if (effect.requiredCapability === "policy.derive" && derivationActive) {
      capabilities.add("policy.derive");
    }
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
    if (telemetryKind === "policy") {
      if (event.isError) run.recordFailedPolicyDeclaration();
      else run.recordSuccessfulPolicyDeclaration();
      return;
    }
    if (telemetryKind === "self-improvement" || telemetryKind === "memory") return;
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
      const update = await invalidateVerificationAfterProjectMutation();
      if (update === null) return;
      const eligibility = renderEligibilityAfterSemanticChange(
        authorizedExecution.capabilitiesAtCall,
      );
      return {
        content: [
          ...event.content,
          { type: "text", text: update },
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

  if (featureSelection.presentation) {
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
  }

  pi.on("agent_settled", async (_event, ctx) => {
    // Pi can dispose an old session runner before its in-flight Agent Run reaches
    // the finally-path that emits agent_settled. Its context is then deliberately
    // stale; that obsolete run must not touch or reset this runtime's state.
    const entries = safeSessionEntries(ctx);
    if (!entries) return;

    presentation.setStatusContext(ctx);
    const result = await core.settleAgentRun(
      ctx,
      entries,
      selfImprovement?.createSettlementObserver(),
    );
    if (result.status !== "settled") return;

    presentation.clearActivityLingerRefresh();
    presentation.runActivity?.settle();
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
    featureSelection,
    core,
    runtime,
    reasoning: presentation.reasoning,
    runActivity: presentation.runActivity,
    runCost: presentation.runCost,
    runTimer: presentation.runTimer,
    taskMetrics: presentation.taskMetrics,
    contextGovernor,
    trial: selfImprovement?.trial ?? null,
    derivation: selfImprovement?.derivation ?? null,
    get promotedStrategyRevisionCatalog() {
      return selfImprovement?.promotedStrategyRevisionCatalog ?? emptyPromotedStrategyRevisionCatalog();
    },
    get trustedStrategyPortfolio() {
      return selfImprovement?.trustedStrategyPortfolio ?? null;
    },
    get policySnapshot() {
      return run.policySnapshot;
    },
    get stateUnavailableReason() {
      return run.stateUnavailableReason;
    },
  };
}

export function registerConfiguredPindieExtension(
  pi: ExtensionAPI,
  options: PindieExtensionOptions = {},
  env: Record<string, string | undefined> = process.env,
): void {
  const composition = composeConfiguredPindieExtension(options, env);
  for (const warning of composition.warnings) console.warn(warning);
  registerComposedPindieExtension(
    pi,
    composition.extensionOptions,
    composition.featureSelection,
  );
}

export default function pindieExtension(pi: ExtensionAPI): void {
  registerConfiguredPindieExtension(pi);
}
