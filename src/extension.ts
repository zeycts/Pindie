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
import { PINDIE_REMOTE_NOTICE_TYPE, renderPindieRemoteNotice } from "./remote-notice.ts";
import { CrossProjectLearningIntegration } from "./cross-project-learning-integration.ts";
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
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import type {
  StrategySynthesisCandidateReader,
  StrategySynthesisCandidateStore,
} from "./strategy-synthesis-candidates.ts";
import type {
  StrategySynthesisDecisionReader,
  StrategySynthesisDecisionStore,
} from "./strategy-synthesis-decisions.ts";
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
import type { GlobalDerivationRuntime } from "./strategy-global-derivation.ts";
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
import {
  chatGptSubscriptionUsageProvider,
  SubscriptionUsageMonitor,
  type SubscriptionUsageProvider,
} from "./subscription-usage.ts";
import {
  registerQuotaResumeIntegration,
  type QuotaResumePreferenceStore,
} from "./quota-resume.ts";
import {
  getQuotaResumePublisher,
  getQuotaResumeStatusObserver,
} from "./quota-resume-control.ts";
import { buildQuotaResumePlan } from "./quota-resume-incident.ts";
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
  crossProjectTrustReader?: ProjectTrustedStrategyPortfolioReader;
  scopeProjectTrustReader?: ScopeProjectTrustReader;
  /** Read-only Synthesis authority used by SI even when CPL is disabled. */
  strategySynthesisCandidateReader?: StrategySynthesisCandidateReader;
  strategySynthesisDecisionReader?: StrategySynthesisDecisionReader;
  /** Mutable Synthesis workflow stores; assembled only when CPL is enabled. */
  strategySynthesisCandidateStore?: StrategySynthesisCandidateStore;
  strategySynthesisDecisionStore?: StrategySynthesisDecisionStore;
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
  readonly globalDerivation: GlobalDerivationRuntime | null;
  readonly promotedStrategyRevisionCatalog: PromotedStrategyRevisionCatalog;
  /** Runtime-derived Seeds plus valid promoted Seed/Derived trust entries. */
  readonly trustedStrategyPortfolio: TrustedStrategyPortfolio | null;
  readonly policySnapshot: PolicySnapshot | null;
  readonly stateUnavailableReason: string | null;
  readonly quotaAutoResumeEnabled: boolean;
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
  const quotaResumeStatusObserver = getQuotaResumeStatusObserver();
  let quotaPlanningGeneration = 0;
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
  let crossProjectLearning: CrossProjectLearningIntegration | null = null;
  if (featureSelection.selfImprovement) {
    const {
      experienceStore,
      experienceReader,
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
      strategySynthesisCandidateReader,
      strategySynthesisDecisionReader,
    } = options;
    if (
      experienceStore === undefined || experienceReader === undefined ||
      strategyCandidateStore === undefined || strategyCandidateReader === undefined ||
      strategyDerivationCandidateStore === undefined || strategyDerivationCandidateReader === undefined ||
      strategyDecisionStore === undefined || strategyDecisionReader === undefined ||
      strategyDerivationDecisionStore === undefined || strategyDerivationDecisionReader === undefined ||
      strategyTrustScopeCandidateStore === undefined || strategyTrustScopeDecisionStore === undefined ||
      strategyTrustScopeSourceResolver === undefined || strategyTrustScopeWriterLock === undefined ||
      strategySynthesisCandidateReader === undefined || strategySynthesisDecisionReader === undefined
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
      strategySynthesisCandidateReader,
      strategySynthesisDecisionReader,
      now: continuityNow,
    });
  }
  if (featureSelection.crossProjectLearning) {
    if (selfImprovement === null) {
      throw new Error("Cross-Project Learning requires Self-Improvement.");
    }
    if (
      options.crossProjectExperienceReader === undefined ||
      options.crossProjectTrustReader === undefined ||
      options.scopeProjectTrustReader === undefined ||
      options.strategySynthesisCandidateStore === undefined ||
      options.strategySynthesisDecisionStore === undefined
    ) {
      throw new Error("Cross-Project Learning composition is missing an explicit production dependency.");
    }
    crossProjectLearning = new CrossProjectLearningIntegration({
      pi,
      learning: selfImprovement.learningAccess,
      trust: selfImprovement.strategyTrustAccess,
      crossProjectExperienceReader: options.crossProjectExperienceReader,
      crossProjectTrustReader: options.crossProjectTrustReader,
      scopeProjectTrustReader: options.scopeProjectTrustReader,
      strategySynthesisCandidateStore: options.strategySynthesisCandidateStore,
      strategySynthesisDecisionStore: options.strategySynthesisDecisionStore,
      now: continuityNow,
    });
    selfImprovement.attachCrossProjectLearning(crossProjectLearning.asAttachment());
  }
  const subscriptionUsageMonitor = new SubscriptionUsageMonitor(
    options.subscriptionUsageProvider ?? chatGptSubscriptionUsageProvider,
    continuityNow,
  );
  const presentation = new PresentationIntegration(pi, {
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
    resolveRevisionSelector: selfImprovement === null
      ? undefined
      : (selector, kind, ctx) => selfImprovement!.resolveRevisionSelector(selector, kind, ctx),
  });
  selfImprovement?.registerTools();
  crossProjectLearning?.registerTools();

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
  crossProjectLearning?.registerCommands();

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
    await quotaResume.restoreSession(ctx);
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
    cancelQuotaResume(ctx);
    await quotaResume.restoreBranch(ctx);
  });

  pi.on("input", (event, ctx) => {
    cancelQuotaResume(ctx);
    options.remoteCompanion?.companion.observeInput(event.source, event.streamingBehavior);
  });
  pi.on("model_select", (_event, ctx) => cancelQuotaResume(ctx));

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

  pi.on("session_shutdown", (event, ctx) => {
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
    selfImprovement?.resetForSession();
    core.resetRuntimeForSession(null);
    lastCheckpointCompactionId = null;
    presentation.setStatusContext(null);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let preparationGeneration: number | null = null;
    try {
      presentation.setStatusContext(ctx);
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
      const selfImprovementRun = selfImprovement === null
        ? {
            adaptationLease: null,
            trialLease: null,
            derivationLease: null,
            globalDerivationLease: null,
            promptContributions: [] as readonly string[],
          }
        : await runBoundedOperation({
            label: "Pindie Self-Improvement Run preparation",
            timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
            run: (signal) => selfImprovement.prepareAgentRun(ctx, signal),
          });

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
      const synthesisTrialRun = selfImprovementRun.trialLease !== null &&
        "candidateType" in selfImprovementRun.trialLease &&
        selfImprovementRun.trialLease.candidateType === "cross-project-synthesis";
      if (
        derivation.ok &&
        derivation.snapshot.authority === "coherent" &&
        selfImprovementRun.adaptationLease === null &&
        (selfImprovementRun.trialLease === null || synthesisTrialRun) &&
        selfImprovementRun.derivationLease === null &&
        selfImprovementRun.globalDerivationLease === null &&
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
      if (preparationGeneration !== null) {
        selfImprovement?.abortAgentRunPreparation(preparationGeneration);
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
    const selfImprovementRestriction = selfImprovement?.restrictToolCall(effect, event.toolName) ?? null;
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
    const adaptationActive = selfImprovement?.isAdaptationRunActive === true;
    const derivationActive = selfImprovement?.isDerivationRunActive === true;
    const globalDerivationActive = selfImprovement?.isGlobalDerivationRunActive === true;
    const capabilities = new Set<PindieCapability>(deriveCapabilities(snapshot));
    if (effect.requiredCapability === "policy.adapt" && adaptationActive) {
      capabilities.add("policy.adapt");
    }
    if (effect.requiredCapability === "policy.derive" && (derivationActive || globalDerivationActive)) {
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
    if (quotaResumePublisher !== null && quotaResume.quotaAutoResumeEnabled) {
      let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]> | null = null;
      try {
        branch = ctx.sessionManager.getBranch();
      } catch {
        // A stale Extension context cannot authorize autonomous planning.
      }
      if (branch !== null) {
        const planningGeneration = quotaPlanningGeneration;
        void buildQuotaResumePlan({
          ctx,
          branch,
          monitor: subscriptionUsageMonitor,
          enabled: true,
          now: continuityNow,
        }).then((plan) => {
          if (
            plan === null ||
            !quotaResume.quotaAutoResumeEnabled ||
            planningGeneration !== quotaPlanningGeneration
          ) return;
          quotaResumePublisher({ type: "schedule", plan });
        }).catch(() => undefined);
      }
    }
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
    globalDerivation: selfImprovement?.globalDerivation ?? null,
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
    get quotaAutoResumeEnabled() {
      return quotaResume.quotaAutoResumeEnabled;
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
