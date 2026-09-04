import { isDeepStrictEqual } from "node:util";

import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieStateCheckpointMessage,
  appendPindieSystemContract,
  createPindieRunBaselineMessage,
  renderCurrentPindieActionEligibility,
  renderPindieProjectMutationUpdate,
} from "./context.ts";
import {
  ContextLifecycleGovernor,
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
  deriveCandidateTrialReview,
} from "./experience-evaluation.ts";
import { ExecutionIntegration } from "./execution-integration.ts";
import {
  FileRunExperienceReader,
  FileRunExperienceStore,
  type RunExperienceReader,
  type RunExperienceStore,
} from "./experience-store.ts";
import {
  AdaptationRuntime,
  buildAdaptationPacket,
} from "./strategy-adaptation.ts";
import {
  FileStrategyCandidateStore,
  isCanonicalStrategyCandidateId,
  type StrategyCandidateReader,
  type StrategyCandidateStore,
} from "./strategy-candidates.ts";
import {
  createStrategyRevisionDecision,
  emptyPromotedStrategyRevisionCatalog,
  FileStrategyDecisionStore,
  formatPromotedStrategyRevisionCatalog,
  loadPromotedStrategyRevisionCatalog,
  validateStrategyRevisionDecisionBinding,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
  type StrategyRevisionDecisionStore,
} from "./strategy-decisions.ts";
import { getSeedStrategy, SEED_STRATEGIES } from "./strategies.ts";
import {
  assembleRunExperience,
  isEligibleRunExperience,
} from "./run-experience.ts";
import {
  authorizeToolEffect,
  classifyToolEffect,
  type ToolEffect,
} from "./execution-semantics.ts";
import { PresentationIntegration } from "./presentation-integration.ts";
import { RemoteCompanion, type RemotePi, type RemoteStatusFacts } from "./remote-companion.ts";
import { DiscordRemote, discordRemoteConfig } from "./discord-remote.ts";
import { resolveProjectRoot as defaultResolveProjectRoot } from "./project.ts";
import type {
  PolicySnapshot,
  StrategyRevisionSelection,
  StrategyRevisionSelector,
} from "./policy.ts";
import type { ProjectFingerprint } from "./project-mutation.ts";
import type { ReasoningController } from "./reasoning.ts";
import type { RunActivityTracker } from "./run-activity.ts";
import type { RunCostTracker } from "./run-cost.ts";
import { RunIntegration } from "./run-integration.ts";
import type { RunTimer } from "./run-timer.ts";
import { PindieRuntime } from "./runtime.ts";
import {
  deriveCapabilities,
  type PindieCapability,
  type SemanticSnapshot,
} from "./semantics.ts";
import { getTaskStatus, getVerificationStatus, validateState } from "./state.ts";
import {
  FileStateStore,
  StateLockBusyError,
  FileTaskContinuityStore,
  type TaskContinuityStore,
  type PindieStateStore,
} from "./store.ts";
import {
  createTaskContinuity,
  taskContractFingerprint,
} from "./task-continuity.ts";
import { getCommittedRolloverPublisher } from "./long-task-control.ts";
import {
  PINDIE_TASK_HANDOFF_TOOL,
  TaskHandoffRuntime,
} from "./task-handoff-runtime.ts";
import {
  TrialRuntime,
} from "./strategy-trial.ts";
import type { SubscriptionUsageProvider } from "./subscription-usage.ts";
import {
  createPindieGateOpenTool,
  createPindieGateResolveTool,
} from "./tools/gate.ts";
import { createPindiePolicySetTool } from "./tools/policy.ts";
import { createPindieStrategyCandidateTool } from "./tools/strategy-candidate.ts";
import { createPindieGitObserveTool } from "./tools/git-observe.ts";
import {
  createPindieTaskCompleteTool,
  createPindieTaskHandoffTool,
  createPindieTaskProgressTool,
  createPindieTaskRefineTool,
  createPindieTaskReplaceTool,
  createPindieTaskStartTool,
  createPindieVerificationRecordTool,
} from "./tools/task.ts";

type ProjectRootResolver = (cwd: string) => Promise<string>;

export interface PindieExtensionOptions {
  store?: PindieStateStore;
  continuityStore?: TaskContinuityStore;
  experienceStore?: RunExperienceStore;
  experienceReader?: RunExperienceReader;
  strategyCandidateStore?: StrategyCandidateStore;
  strategyCandidateReader?: StrategyCandidateReader;
  strategyDecisionStore?: StrategyRevisionDecisionStore;
  strategyDecisionReader?: StrategyRevisionDecisionReader;
  resolveProjectRoot?: ProjectRootResolver;
  subscriptionUsageProvider?: SubscriptionUsageProvider;
  getStatusWidth?: () => number | undefined;
  now?: () => number;
  /** Internal test seams for runtime-only activity presentation expiry. */
  activityLingerMs?: number;
  scheduleActivityRefresh?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearActivityRefresh?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Explicit isolated-test seam; Host ownership is the production activation path. */
  enableTaskHandoff?: boolean;
  /** Isolated tuning seam for the session-scoped Context Lifecycle Governor. */
  contextGovernorTuning?: ContextGovernorTuning;
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
  readonly contextGovernor: ContextLifecycleGovernor;
  readonly trial: TrialRuntime;
  readonly promotedStrategyRevisionCatalog: PromotedStrategyRevisionCatalog;
  readonly policySnapshot: PolicySnapshot | null;
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

function gatewayDenialReason(
  snapshot: SemanticSnapshot,
  requiredCapability: ToolEffect["requiredCapability"],
): string {
  if (requiredCapability === "policy.adapt") {
    return "Pindie blocked this call: Strategy Candidate creation requires a live explicit adaptation attempt. Use /adapt <strategy-id> while the Agent is idle.";
  }
  if (snapshot.authority === "coherent" && requiredCapability === "task.replace") {
    if (snapshot.taskStatus === "done") {
      return `Pindie blocked this call: the completed Task is terminal and cannot be replaced. Use pindie_task_start to begin new durable work. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
    }
    if (snapshot.taskStatus === "idle") {
      return `Pindie blocked this call: There is no unfinished Task to replace. Use pindie_task_start to begin a Task. Task status: ${snapshot.taskStatus}. Verification: ${snapshot.verificationStatus}.`;
    }
  }

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
  // Capture the Host lease at extension registration. A released extension
  // publisher must never be able to target a later Host in this process.
  const committedRolloverPublisher = getCommittedRolloverPublisher();
  const taskHandoffEnabled = options.enableTaskHandoff === true || committedRolloverPublisher !== null;
  const stateStore = options.store ?? new FileStateStore();
  const experienceStorageBaseDir = stateStore instanceof FileStateStore
    ? stateStore.storageBaseDir
    : undefined;
  const experienceStore = options.experienceStore ?? new FileRunExperienceStore({
    baseDir: experienceStorageBaseDir,
  });
  const experienceReader = options.experienceReader ?? new FileRunExperienceReader({
    baseDir: experienceStorageBaseDir,
  });
  const continuityStore = options.continuityStore ?? new FileTaskContinuityStore({
    baseDir: experienceStorageBaseDir,
  });
  const strategyCandidateStore = options.strategyCandidateStore ?? new FileStrategyCandidateStore({
    baseDir: experienceStorageBaseDir,
  });
  const strategyCandidateReader = options.strategyCandidateReader ?? (
    typeof (strategyCandidateStore as Partial<StrategyCandidateReader>).read === "function"
      ? strategyCandidateStore as unknown as StrategyCandidateReader
      : new FileStrategyCandidateStore({ baseDir: experienceStorageBaseDir })
  );
  const strategyDecisionStore = options.strategyDecisionStore ?? new FileStrategyDecisionStore({
    baseDir: experienceStorageBaseDir,
  });
  const strategyDecisionReader = options.strategyDecisionReader ?? strategyDecisionStore;
  const adaptation = new AdaptationRuntime();
  const trial = new TrialRuntime();
  let promotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
  const continuityNow = options.now ?? Date.now;
  // A successful Candidate consumes the lease before settlement, so retain only
  // this generation marker long enough to exclude the adaptation Run from
  // ordinary coding Experience accounting.
  let adaptationRunGeneration: number | null = null;
  const runtime = new PindieRuntime(stateStore);
  const run = new RunIntegration(runtime);
  const handoff = new TaskHandoffRuntime();
  const contextGovernor = new ContextLifecycleGovernor(options.contextGovernorTuning);
  const execution = new ExecutionIntegration({
    captureProjectFingerprint: options.captureProjectFingerprint,
  });
  const presentation = new PresentationIntegration(pi, {
    getState: () => runtime.projectRoot === null ? null : runtime.state,
    getProjectRoot: () => runtime.projectRoot,
    experienceReader,
    strategyCandidateReader,
    strategyDecisionReader,
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
  const loadPromotedCatalog = async (
    projectRoot: string | null,
  ): Promise<PromotedStrategyRevisionCatalog> => {
    if (projectRoot === null) return emptyPromotedStrategyRevisionCatalog();
    try {
      const catalog = await loadPromotedStrategyRevisionCatalog(
        projectRoot,
        strategyDecisionReader,
        strategyCandidateReader,
      );
      return runtime.projectRoot === projectRoot
        ? catalog
        : emptyPromotedStrategyRevisionCatalog();
    } catch (error) {
      // Trust artifacts are outside semantic State. A malformed/unreadable
      // catalog never makes the project unavailable; it simply yields the
      // safe immutable Seed-only Policy surface for this Run.
      console.warn(
        `[Pindie] Promoted Strategy catalog unavailable; using Seed-only Policy availability: ${errorMessage(error)}`,
      );
      return emptyPromotedStrategyRevisionCatalog();
    }
  };
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
    execution.semanticAuthorityUnavailable();
    run.markUnavailable(reason);
    presentation.refreshStatus();
    void options.remoteCompanion?.companion.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
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

  const handleAdaptationCommand = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const requestedId = args.trim();
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /adapt <strategy-id>", "warning");
      return;
    }
    const projectRoot = runtime.projectRoot;
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not start /adapt: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not start /adapt: the Agent is busy.", "warning");
      return;
    }
    if (adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /adapt: another adaptation attempt is already active.", "warning");
      return;
    }
    if (trial.hasTrial) {
      ctx.ui.notify("Pindie could not start /adapt: a Candidate Trial is already pending or active.", "warning");
      return;
    }
    const target = getSeedStrategy(requestedId);
    if (target === null) {
      ctx.ui.notify(`Pindie could not start /adapt: '${requestedId}' is not a valid Seed Strategy ID.`, "warning");
      return;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: ${errorMessage(error)}`, "warning");
      return;
    }
    let read;
    try {
      read = await experienceReader.read(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: Experience reading failed: ${errorMessage(error)}`, "warning");
      return;
    }
    let packet;
    try {
      packet = buildAdaptationPacket(target, read.records);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: evidence evaluation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (packet.evidence.eligibleRunCount < 2) {
      ctx.ui.notify(
        `Pindie could not start /adapt '${target.id}': only ${packet.evidence.eligibleRunCount} eligible attributable Run${packet.evidence.eligibleRunCount === 1 ? " is" : "s are"} available; at least 2 are required.`,
        "warning",
      );
      return;
    }
    if (runtime.projectRoot !== projectRoot) {
      ctx.ui.notify("Pindie could not start /adapt: the current project changed while reading Experience.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not start /adapt: the Agent became busy while reading Experience.", "warning");
      return;
    }
    if (trial.hasTrial) {
      ctx.ui.notify("Pindie could not start /adapt: a Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (!adaptation.establish(sessionId, target, packet)) {
      ctx.ui.notify("Pindie could not start /adapt: another adaptation attempt is already active.", "warning");
      return;
    }
    try {
      pi.sendUserMessage(
        `Begin the explicitly requested Self-Improvement adaptation for Seed Strategy '${target.id}'. Use the bounded Adaptation Packet supplied for this Run. This is optional hypothesis generation, not project implementation work.`,
      );
    } catch (error) {
      adaptation.clear();
      adaptationRunGeneration = null;
      ctx.ui.notify(`Pindie could not launch the /adapt Agent Run: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(
      `Self-Improvement adaptation Run started for '${target.id}' with ${packet.evidence.eligibleRunCount} eligible attributable Runs. Candidate generation is optional.`,
      "info",
    );
  };

  const handleTrialCommand = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const requestedId = args.trim();
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trial <candidate-id>", "warning");
      return;
    }
    // Reject before any Candidate path construction or reader call.
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      ctx.ui.notify(
        "Pindie could not arm /trial: candidate-id must be a canonical lowercase UUID-v4.",
        "warning",
      );
      return;
    }
    const projectRoot = runtime.projectRoot;
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not arm /trial: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not arm /trial: the Agent is busy.", "warning");
      return;
    }
    if (trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: an adaptation attempt is already pending or active.", "warning");
      return;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: ${errorMessage(error)}`, "warning");
      return;
    }

    let candidate;
    try {
      candidate = await strategyCandidateReader.read(projectRoot, requestedId);
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: Candidate read failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidate === null) {
      ctx.ui.notify(`Pindie could not arm /trial: Candidate '${requestedId}' was not found for this project.`, "warning");
      return;
    }
    if (candidate.candidateId !== requestedId) {
      ctx.ui.notify("Pindie could not arm /trial: invalid Candidate identity did not match the requested ID.", "warning");
      return;
    }

    let currentSessionId: string;
    try {
      currentSessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: ${errorMessage(error)}`, "warning");
      return;
    }
    if (
      currentSessionId !== sessionId ||
      runtime.projectRoot !== projectRoot ||
      !ctx.isIdle()
    ) {
      ctx.ui.notify("Pindie could not arm /trial: the current Session, project, or Agent state changed while reading the Candidate.", "warning");
      return;
    }
    if (trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    try {
      if (!trial.establish(sessionId, candidate)) {
        ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: invalid Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(
      `Trial armed for the next Agent Run (Candidate ${candidate.candidateId}).`,
      "info",
    );
  };

  const handleStrategyDecisionCommand = async (
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const requestedId = args.trim();
    const command = terminalDecision === "promoted" ? "/promote" : "/reject";
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify(`Usage: ${command} <candidate-id>`, "warning");
      return;
    }
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: candidate-id must be a canonical lowercase UUID-v4.`,
        "warning",
      );
      return;
    }
    const projectRoot = runtime.projectRoot;
    if (projectRoot === null) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: no current project root is loaded.`,
        "warning",
      );
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: the Agent is busy.`,
        "warning",
      );
      return;
    }

    let candidate;
    try {
      candidate = await strategyCandidateReader.read(projectRoot, requestedId);
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Candidate read failed: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    if (candidate === null) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Candidate '${requestedId}' was not found for this project.`,
        "warning",
      );
      return;
    }
    if (candidate.candidateId !== requestedId) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Candidate identity did not match the requested ID.`,
        "warning",
      );
      return;
    }

    let existingDecision;
    try {
      existingDecision = await strategyDecisionReader.read(projectRoot, requestedId);
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Decision read failed; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    if (existingDecision !== null) {
      try {
        validateStrategyRevisionDecisionBinding(existingDecision, candidate);
      } catch (error) {
        ctx.ui.notify(
          `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: existing Decision binding is invalid; no trust transition occurred: ${errorMessage(error)}`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: an immutable terminal Decision already exists; duplicate or conflicting Decisions are rejected.`,
        "warning",
      );
      return;
    }

    let read;
    try {
      read = await experienceReader.read(projectRoot);
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Experience reading failed; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    if (runtime.projectRoot !== projectRoot || !ctx.isIdle()) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: the current project or Agent state changed while reading evidence; no trust transition occurred.`,
        "warning",
      );
      return;
    }

    let review;
    try {
      review = deriveCandidateTrialReview(candidate, read.records, {
        currentProjectMatch: true,
        priorTerminalDecision: false,
      });
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: evidence evaluation failed; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }

    // Re-read the complete immutable trust set before making the new decision.
    // This validates duplicate/conflicting artifacts and the one-promoted-per-
    // Seed invariant without changing State or Task authority.
    let promotedCatalog: PromotedStrategyRevisionCatalog;
    try {
      promotedCatalog = await loadPromotedStrategyRevisionCatalog(
        projectRoot,
        strategyDecisionReader,
        strategyCandidateReader,
      );
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: trust Decision storage could not be validated; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    if (runtime.projectRoot !== projectRoot || !ctx.isIdle()) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: the current project or Agent state changed while validating trust; no trust transition occurred.`,
        "warning",
      );
      return;
    }

    if (terminalDecision === "promoted" && promotedCatalog.entries.some((entry) =>
      entry.candidate.target.strategyId === candidate.target.strategyId &&
      entry.candidate.target.kind === candidate.target.kind &&
      entry.candidate.target.baseFingerprint === candidate.target.baseFingerprint
    )) {
      ctx.ui.notify(
        `Pindie could not promote Candidate '${requestedId}': this Seed Strategy already has one promoted Candidate revision in this project.`,
        "warning",
      );
      return;
    }

    if (terminalDecision === "promoted" && !review.promotionEligibility.eligible) {
      const reasons = review.promotionEligibility.reasons.length > 0
        ? ` Reasons: ${review.promotionEligibility.reasons.join("; ")}.`
        : "";
      ctx.ui.notify(
        `Pindie could not promote Candidate '${requestedId}': the exact Promotion Eligibility gate is not satisfied.${reasons}`,
        "warning",
      );
      return;
    }

    let decision;
    try {
      decision = createStrategyRevisionDecision({
        candidate,
        decision: terminalDecision,
        trialRecordIds: review.candidateProfile.sourceRecordIds,
        decidedAt: new Date(continuityNow()).toISOString(),
      });
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Decision construction failed; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    try {
      await strategyDecisionStore.save(projectRoot, decision);
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not ${terminalDecision === "promoted" ? "promote" : "reject"} Candidate: Decision was not persisted; no trust transition occurred: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }

    ctx.ui.notify(
      terminalDecision === "promoted"
        ? `Candidate '${requestedId}' promoted for explicit normal Policy selection. The Seed remains selectable and the promoted revision is not a default.`
        : `Candidate '${requestedId}' rejected as a historical hypothesis. Its immutable Decision preserves ${decision.evidence.trialRecordIds.length} eligible Trial Experience ID${decision.evidence.trialRecordIds.length === 1 ? "" : "s"}.`,
      "info",
    );
  };

  const taskToolOptions = {
    getRunDuration: () => presentation.runTimer.durationMs,
    onStateChange: semanticStateChanged,
  };
  pi.registerTool(createPindiePolicySetTool({
    onPolicySet: (snapshot) => run.setPolicySnapshot(snapshot),
    resolveRevisionSelector: (
      selector: StrategyRevisionSelector,
      kind: "approach" | "modifier",
      ctx: ExtensionContext,
    ): StrategyRevisionSelection => {
      let sessionId: string;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch (error) {
        throw new Error(`Candidate revision selector could not resolve the current Session: ${errorMessage(error)}`);
      }
      if (trial.activeFor(sessionId, run.activeAgentRunGeneration) !== null) {
        return trial.resolveRevisionSelector(
          sessionId,
          run.activeAgentRunGeneration,
          selector,
          kind,
        );
      }
      if (promotedStrategyRevisionCatalog.entries.length === 0) {
        throw new Error("Candidate revision selector is unavailable without an active Candidate Trial or a promoted revision in the current project catalog.");
      }
      return promotedStrategyRevisionCatalog.resolve(selector, kind);
    },
  }));
  pi.registerTool(createPindieStrategyCandidateTool({
    adaptation,
    experienceReader,
    candidateStore: strategyCandidateStore,
    getProjectRoot: () => runtime.projectRoot,
    getAgentRunGeneration: () => run.activeAgentRunGeneration,
  }));
  pi.registerTool(createPindieTaskStartTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskReplaceTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskRefineTool(runtime, taskToolOptions));
  pi.registerTool(createPindieTaskProgressTool(runtime, taskToolOptions));
  pi.registerTool(createPindieVerificationRecordTool(runtime, {
    ...taskToolOptions,
    resolveEvidence: (refs) => execution.resolveVerificationEvidence(refs),
  }));
  pi.registerTool(createPindieTaskCompleteTool(runtime, taskToolOptions));
  if (taskHandoffEnabled) {
    pi.registerTool(createPindieTaskHandoffTool(runtime, {
      ...taskToolOptions,
      onHandoffStaged: (toolCallId, state, progressSummary, decisions) => {
        if (state.task === null) {
          throw new Error("Pindie rejected this handoff: no current Task is available to stage.");
        }
        handoff.stageHandoff(
          toolCallId,
          state.task,
          progressSummary,
          decisions,
        );
      },
    }));
  }
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

  pi.registerCommand("experience", {
    description: "Show read-only Run Experience evidence",
    handler: async (args, ctx) => presentation.handleExperienceCommand(args, ctx),
  });

  pi.registerCommand("adapt", {
    description: "Start explicit Strategy Revision Candidate adaptation for a Seed Strategy",
    getArgumentCompletions: (prefix) => SEED_STRATEGIES
      .map((strategy) => strategy.id)
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => handleAdaptationCommand(args, ctx),
  });

  pi.registerCommand("trial", {
    description: "Arm one explicit Strategy Revision Candidate Trial for the next Agent Run",
    handler: async (args, ctx) => handleTrialCommand(args, ctx),
  });

  pi.registerCommand("trial-review", {
    description: "Show read-only evidence and Promotion Eligibility for one Candidate Trial",
    handler: async (args, ctx) => presentation.handleTrialReviewCommand(args, ctx),
  });

  pi.registerCommand("promote", {
    description: "Explicitly promote one eligible Strategy Revision Candidate",
    handler: async (args, ctx) => handleStrategyDecisionCommand("promoted", args, ctx),
  });

  pi.registerCommand("reject", {
    description: "Explicitly reject one Strategy Revision Candidate",
    handler: async (args, ctx) => handleStrategyDecisionCommand("rejected", args, ctx),
  });

  pi.registerCommand("reasoning", {
    description: "Choose who controls thinking level (auto|manual)",
    getArgumentCompletions: (prefix) => ["auto", "manual"]
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => presentation.handleReasoningCommand(args, ctx),
  });

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
    adaptation.clear();
    trial.clear();
    promotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
    adaptationRunGeneration = null;
    run.resetStateAuthority();
    run.resetAgentRun();
    if (nativeSessionId !== null) handoff.startSession(nativeSessionId);
    execution.discardRuntime();
    contextGovernor.reset();
    lastCheckpointCompactionId = null;

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
    presentation.resetTrackers();
    presentation.clearStatus(ctx);
    adaptation.clear();
    trial.clear();
    promotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
    adaptationRunGeneration = null;
    run.resetStateAuthority();
    run.resetAgentRun();
    handoff.shutdownSession();
    execution.discardRuntime();
    contextGovernor.reset();
    lastCheckpointCompactionId = null;
    presentation.setStatusContext(null);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const trialWasArmed = trial.hasTrial;
    let trialBound = false;
    try {
      presentation.setStatusContext(ctx);
      if (trial.hasActiveTrial) trial.clear();
      run.resetAgentRun();
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
      if (taskHandoffEnabled) {
        handoff.beginAgentRun(
          ctx.sessionManager.getSessionId(),
          run.activeAgentRunGeneration!,
        );
      }
      if (adaptation.hasAttempt && trial.hasTrial) {
        adaptation.clear();
        trial.clear();
        adaptationRunGeneration = null;
        throw new Error("Pindie rejected this Agent Run: an Adaptation Packet and Trial Packet cannot coexist.");
      }
      let adaptationLease = null;
      if (adaptation.hasAttempt) {
        try {
          adaptationLease = adaptation.bind(
            ctx.sessionManager.getSessionId(),
            run.activeAgentRunGeneration!,
          );
        } catch (error) {
          adaptation.clear();
          adaptationRunGeneration = null;
          throw error;
        }
        adaptationRunGeneration = adaptationLease?.agentRunGeneration ?? null;
      } else {
        adaptationRunGeneration = null;
      }
      let trialLease = null;
      if (adaptationLease === null && trial.hasPendingTrial) {
        let sessionId: string;
        try {
          sessionId = ctx.sessionManager.getSessionId();
        } catch (error) {
          trial.clear();
          throw error;
        }
        trialLease = trial.bind(sessionId, run.activeAgentRunGeneration!);
        if (trialLease === null) {
          // A pending lease is bound to exactly the Session that armed it.
          // A mismatch is a fail-closed stale lease, not a normal Run input.
          trial.clear();
        } else {
          trialBound = true;
        }
      }
      let derivation = run.deriveSnapshot();
      if (!derivation.ok) {
        markUnavailable(`Internal semantic derivation failed: ${derivation.error}`);
        derivation = run.deriveSnapshot();
      }
      presentation.reasoning.beforeAgentStart();
      presentation.applyRequestedThinkingLevel();
      presentation.clearActivityLingerRefresh();
      presentation.runActivity.start();
      presentation.startCost(ctx.sessionManager.getEntries());
      presentation.startTimer(ctx);
      presentation.refreshStatus(ctx);
      void options.remoteCompanion?.companion.status(remoteStatusFacts());

      if (!derivation.ok) {
        adaptation.clear();
        trial.clear();
        adaptationRunGeneration = null;
        throw new Error(
          `Pindie unavailable semantic derivation failed: ${derivation.error}`,
        );
      }
      promotedStrategyRevisionCatalog = await loadPromotedCatalog(runtime.projectRoot);
      const state = run.authoritativeState;
      const packetLease = adaptationLease ?? trialLease;
      const staticContract = appendPindieSystemContract(event.systemPrompt);
      const promotedContext = packetLease === null
        ? formatPromotedStrategyRevisionCatalog(promotedStrategyRevisionCatalog)
        : "";
      const systemPrompt = packetLease === null
        ? `${staticContract}${promotedContext === "" ? "" : `\n\n${promotedContext}`}`
        : `${staticContract}\n\n${packetLease.renderedPacket}`;
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
      if (trialWasArmed || trialBound) trial.clear();
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
    if (adaptation.isActiveForGeneration(agentRunGeneration)) return;

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

  const settleTaskHandoff = async (
    ctx: ExtensionContext,
    settlementGeneration: number | null,
  ): Promise<void> => {
    const pending = handoff.pendingHandoff;
    if (pending === null) return;

    const failClosed = (): void => handoff.clearHandoff();
    if (
      settlementGeneration === null ||
      !run.isAgentRunCurrent(settlementGeneration) ||
      !handoff.isPendingFor(pending.sourceSessionId, pending.agentRunGeneration)
    ) {
      failClosed();
      return;
    }

    let currentSessionId: string;
    try {
      currentSessionId = ctx.sessionManager.getSessionId();
      if (ctx.hasPendingMessages()) {
        failClosed();
        return;
      }
    } catch {
      failClosed();
      return;
    }
    if (
      currentSessionId !== pending.sourceSessionId ||
      handoff.currentSessionId !== pending.sourceSessionId ||
      runtime.projectRoot === null
    ) {
      failClosed();
      return;
    }

    try {
      await run.refreshAuthoritativeState();
    } catch {
      failClosed();
      return;
    }
    if (
      !run.isAgentRunCurrent(settlementGeneration) ||
      !handoff.isPendingFor(pending.sourceSessionId, pending.agentRunGeneration)
    ) {
      failClosed();
      return;
    }

    let derivation = run.deriveSnapshot();
    const state = run.authoritativeState;
    const task = state?.task ?? null;
    if (!derivation.ok || derivation.snapshot.authority !== "coherent") {
      failClosed();
      return;
    }
    const snapshot = derivation.snapshot;
    if (
      snapshot.taskStatus !== "active" ||
      task === null ||
      task.completed ||
      task.humanGate !== null ||
      task.openLoops.blockers.length > 0 ||
      taskContractFingerprint(task) !== pending.taskFingerprint
    ) {
      failClosed();
      return;
    }

    try {
      if (ctx.hasPendingMessages()) {
        failClosed();
        return;
      }
    } catch {
      failClosed();
      return;
    }

    let checkpoint;
    try {
      checkpoint = createTaskContinuity({
        createdAt: new Date(continuityNow()).toISOString(),
        taskFingerprint: pending.taskFingerprint,
        sourceSessionId: pending.sourceSessionId,
        progressSummary: pending.progressSummary,
        decisions: pending.decisions,
      });
      await continuityStore.save(runtime.projectRoot, checkpoint);
    } catch (error) {
      console.warn(`[Pindie] Dropped Task continuity checkpoint: ${errorMessage(error)}`);
      failClosed();
      return;
    }
    if (committedRolloverPublisher !== null) {
      try {
        if (checkpoint.sourceSessionId !== pending.sourceSessionId) {
          throw new Error("Committed continuity checkpoint Session identity did not match the pending handoff.");
        }
        committedRolloverPublisher({
          sourceSessionId: checkpoint.sourceSessionId,
          checkpoint,
        });
      } catch (error) {
        console.warn(`[Pindie] Committed Task continuity checkpoint could not reach Host rollover control: ${errorMessage(error)}`);
      }
    }
    failClosed();
  };

  pi.on("agent_end", (event, ctx) => {
    if (
      adaptationRunGeneration !== null &&
      adaptationRunGeneration === run.activeAgentRunGeneration
    ) return;
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
    const adaptationRunActive = adaptationRunGeneration !== null &&
      adaptationRunGeneration === run.activeAgentRunGeneration;
    if (adaptationRunActive &&
      effect.requiredCapability !== "observe.project" &&
      effect.requiredCapability !== "observe.git" &&
      effect.requiredCapability !== "policy.adapt") {
      cancelToolAdmission();
      run.recordDeniedCall(effect);
      return {
        block: true,
        reason: "Pindie blocked this call: an adaptation Run is read-only and only permits observation or the active Candidate tool.",
      };
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
    const adaptationActive = adaptation.isActiveForGeneration(run.activeAgentRunGeneration);
    const capabilities = new Set<PindieCapability>(deriveCapabilities(snapshot));
    if (effect.requiredCapability === "policy.adapt" && adaptationActive) {
      capabilities.add("policy.adapt");
    }
    const authorization = authorizeToolEffect(capabilities, effect);
    if (!authorization.allowed) {
      cancelToolAdmission();
      run.recordDeniedCall(effect);
      return {
        block: true,
        reason: gatewayDenialReason(
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
    if (telemetryKind === "self-improvement") return;
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

  pi.on("agent_settled", async (_event, ctx) => {
    // Pi can dispose an old session runner before its in-flight Agent Run reaches
    // the finally-path that emits agent_settled. Its context is then deliberately
    // stale; that obsolete run must not touch or reset this runtime's state.
    const entries = safeSessionEntries(ctx);
    if (!entries) return;
    if (run.hasActiveAgentRun && !run.claimAgentRunSettlement()) return;
    const settlementGeneration = run.activeAgentRunGeneration;
    const isAdaptationRun = settlementGeneration !== null &&
      adaptationRunGeneration === settlementGeneration;
    const isTrialRun = settlementGeneration !== null &&
      trial.isActiveForGeneration(settlementGeneration);
    adaptation.clear();
    adaptationRunGeneration = null;

    presentation.setStatusContext(ctx);

    // Freeze all Experience inputs before clearing Run-scoped Policy, evidence,
    // and execution bookkeeping. This entire path is best-effort and cannot
    // become semantic authority.
    const projectRoot = runtime.projectRoot;
    let finalDerivation = run.deriveSnapshot();
    // A Run that only observed may not have crossed the consequential Gateway
    // preflight. Refresh once at settlement so external State changes still
    // make the final authority stale rather than producing a false record.
    if (projectRoot !== null && run.authoritativeState !== null && run.hasActiveAgentRun) {
      try {
        await run.refreshAuthoritativeState();
        if (
          settlementGeneration === null ||
          !run.isAgentRunCurrent(settlementGeneration)
        ) return;
        finalDerivation = run.deriveSnapshot();
      } catch {
        // Experience eligibility is fail-closed; preserve normal settlement
        // semantics and simply omit this record when final authority cannot be
        // refreshed.
        finalDerivation = { ok: false, error: "Final authority refresh failed." };
      }
    }
    const finalState = run.authoritativeState;
    const task = finalState?.task ?? null;
    const runStartTaskStatus = run.taskStatusAtRunStart;
    const runStartTaskGoal = run.taskGoalAtRunStart;
    const executionFacts = run.executionCounters;
    const policyFacts = run.policyAttribution;
    const durationMs = presentation.runTimer.finish();
    const settledCost = presentation.finishCost(entries);

    if (
      !isAdaptationRun &&
      experienceStore !== null &&
      settlementGeneration !== null &&
      run.isAgentRunCurrent(settlementGeneration) &&
      finalDerivation.ok &&
      isEligibleRunExperience(
        projectRoot,
        finalDerivation.snapshot,
        task,
        executionFacts,
      ) &&
      runStartTaskStatus !== null
    ) {
      try {
        const experience = assembleRunExperience({
          task: task!,
          runStart: {
            taskStatus: runStartTaskStatus,
            taskGoal: runStartTaskGoal,
          },
          snapshot: finalDerivation.snapshot,
          policy: policyFacts,
          execution: executionFacts,
          durationMs,
          cost: settledCost?.cost ?? null,
        });
        await experienceStore.save(projectRoot!, experience);
      } catch (error) {
        console.warn(
          `[Pindie] Dropped Run Experience record: ${errorMessage(error)}`,
        );
      }
    }

    // Trial attribution is observed above while the final Policy Snapshot is
    // still available. Clear the one-Run lease only after Experience has had
    // its complete chance to freeze and persist those inputs.
    if (isTrialRun) trial.clear();
    promotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();

    if (
      settlementGeneration !== null &&
      !run.isAgentRunCurrent(settlementGeneration)
    ) {
      if (handoff.pendingHandoff?.agentRunGeneration === settlementGeneration) {
        handoff.clearHandoff();
      }
      return;
    }

    // Experience is fully frozen and persisted before a staged handoff can
    // become the latest durable continuity checkpoint.
    await settleTaskHandoff(ctx, settlementGeneration);
    handoff.clear();

    execution.discardRuntime();
    run.resetAgentRun();
    presentation.clearActivityLingerRefresh();
    presentation.runActivity.settle();
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
    contextGovernor,
    trial,
    get promotedStrategyRevisionCatalog() {
      return promotedStrategyRevisionCatalog;
    },
    get policySnapshot() {
      return run.policySnapshot;
    },
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
