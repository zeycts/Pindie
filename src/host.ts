import { fileURLToPath } from "node:url";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";
import {
  createBrowserRealityRuntime,
  registerBrowserRealityExtension,
  resolveBrowserRealityConfig,
  type BrowserRealityConfig,
  type BrowserRealityRuntime,
} from "./browser-reality.ts";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import {
  PindieInteractiveMode as OwnedPindieInteractiveMode,
  type PindieInteractiveModeOptions,
} from "./tui/pindie-interactive-mode.ts";
import { registerConfiguredPindieExtension } from "./extension.ts";
import type { PindiePresentationReader } from "./presentation-integration.ts";
import {
  resolvePindieFeatureSelection,
  type PindieFeatureSelectionOverrides,
  type PindieStorageRootOverrides,
} from "./composition.ts";
import { TaskMetricsTracker } from "./task-metrics.ts";
import {
  installCommittedRolloverReceiver,
  type CommittedRolloverRequest,
  type SessionLifecycleBoundary,
} from "./long-task-control.ts";
import {
  LongTaskRolloverSupervisor,
  type LongTaskRolloverSupervisorOptions,
} from "./long-task-rollover.ts";
import {
  installQuotaResumeReceiver,
  type QuotaResumeControlEvent,
  type QuotaResumeHostLease,
  type QuotaResumeWaitingStatus,
} from "./quota-resume-control.ts";
import {
  QuotaResumeSupervisor,
  type QuotaResumeSupervisorOptions,
} from "./quota-resume-supervisor.ts";
import {
  QuotaFallbackSupervisor,
  type QuotaFallbackSupervisorOptions,
} from "./quota-fallback-supervisor.ts";

import { installQuotaFallbackReceiver } from "./quota-fallback-control.ts";
import { FileLearningBudgetLedger } from "./learning-budget-store.ts";
import { FileLearningJobLedger } from "./learning-job-store.ts";
import { LearningSupervisor, type LearningJobHandler } from "./learning-supervisor.ts";
import { createLearningSessionRunner, resolveLearningModel, type LearningModelPolicy } from "./learning-session-runner.ts";
import { resolvePindieStorageRoots } from "./composition.ts";
import { resolveProjectRoot } from "./project.ts";
import { getProjectId } from "./store.ts";
import { FileRunExperienceReader } from "./experience-store.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import { FileDiscoveryPacketStore } from "./discovery-packets.ts";
import { FileDiscoveryReceiptStore } from "./discovery-receipts.ts";
import { enqueueProjectDiscovery } from "./project-discovery.ts";
import { createProjectDiscoveryHandler } from "./project-discovery-handler.ts";
import { FileDiscoveryHypothesisStore } from "./discovery-hypotheses.ts";
import { validateProjectDiscoveryPolicy, type ProjectDiscoveryPolicy } from "./discovery-contract.ts";

export interface PindieResourcePaths {
  extensionPath: string;
  skillsPath: string;
}

export interface PindieInteractiveMode {
  run(): Promise<void>;
}

export interface PindieHostDependencies {
  createAgentSessionRuntime?: typeof createAgentSessionRuntime;
  createAgentSessionServices?: typeof createAgentSessionServices;
  createAgentSessionFromServices?: typeof createAgentSessionFromServices;
  createInteractiveMode?: (
    runtime: AgentSessionRuntime,
    options: InteractiveModeOptions,
  ) => PindieInteractiveMode;
  createPindieInteractiveMode?: (
    runtime: PiRuntimeAdapter,
    options: PindieInteractiveModeOptions,
  ) => PindieInteractiveMode;
  createBrowserRealityRuntime?: (
    config: BrowserRealityConfig,
  ) => BrowserRealityRuntime;
}

export interface PindieHostOptions {
  cwd?: string;
  agentDir?: string;
  featureSelection?: PindieFeatureSelectionOverrides;
  storageRoots?: PindieStorageRootOverrides;
  sessionManager?: SessionManager;
  interactiveModeOptions?: InteractiveModeOptions;
  longTaskRollover?: LongTaskRolloverSupervisorOptions;
  quotaResume?: QuotaResumeSupervisorOptions;
  quotaFallback?: QuotaFallbackSupervisorOptions;
  /** D2 registers project-discovery by default; override for isolated Host/runtime tests. */
  learningHandlers?: readonly LearningJobHandler[];
  /** Explicit isolated learning model. When omitted, the Host baseline model is frozen once at start. */
  learningModel?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel?: "off" | "low" | "medium" };
  /** Human-controlled v1 local discovery threshold/corpus configuration. */
  discoveryPolicy?: ProjectDiscoveryPolicy;
  env?: Record<string, string | undefined>;
  dependencies?: PindieHostDependencies;
}

export interface PindiePresentationReaderLease {
  current(): PindiePresentationReader | null;
}

export interface PindieHost {
  readonly runtime: PiRuntimeAdapter;
  readonly interactiveMode: PindieInteractiveMode;
  readonly presentation: PindiePresentationReaderLease;
  /** Frozen isolated learning model identity, or null when learning is unavailable this Host. */
  readonly learningModelIdentity: LearningModelPolicy | null;
  run(): Promise<void>;
  dispose(): Promise<void>;
}

/** Temporary migration gate: only the exact value `1` selects the owned TUI. */
export function isPindieTuiEnabled(env: Record<string, string | undefined>): boolean {
  return env.PINDIE_TUI === "1";
}

export function getPindieResourcePaths(): PindieResourcePaths {
  return {
    extensionPath: fileURLToPath(new URL("./extension.ts", import.meta.url)),
    skillsPath: fileURLToPath(new URL("../skills/", import.meta.url)),
  };
}

export function createPindieRuntimeFactory(
  dependencies: Pick<
    PindieHostDependencies,
    "createAgentSessionServices" | "createAgentSessionFromServices"
  > = {},
  taskMetrics = new TaskMetricsTracker(),
  compositionOptions: {
    readonly featureSelection?: PindieFeatureSelectionOverrides;
    readonly storageRoots?: PindieStorageRootOverrides;
    readonly browserExtensionFactory?: (pi: ExtensionAPI) => void;
    readonly onPresentationReaderChange?: (reader: PindiePresentationReader | null) => void;
    readonly onExperienceSaved?: (projectRoot: string) => void;
    readonly onHumanRunStart?: () => void;
    readonly onHumanRunSettled?: () => void;
    readonly onSessionChange?: () => void;
    readonly onSessionReady?: (session: AgentSession) => void;
  } = {},
): CreateAgentSessionRuntimeFactory {
  const createServices = dependencies.createAgentSessionServices ?? createAgentSessionServices;
  const createSession = dependencies.createAgentSessionFromServices ?? createAgentSessionFromServices;
  const resources = getPindieResourcePaths();
  const featureSelection = resolvePindieFeatureSelection(
    compositionOptions.featureSelection,
  );

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    // Replacement construction is fail-closed: the outgoing reader is no
    // longer current before any new Session-bound runtime work begins.
    compositionOptions.onSessionChange?.();
    compositionOptions.onPresentationReaderChange?.(null);
    let pendingPresentationReader: PindiePresentationReader | null = null;
    const services = await createServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalSkillPaths: featureSelection.bundledSkills
          ? [resources.skillsPath]
          : [],
        extensionFactories: [{
          name: "pindie",
          factory: (pi) => {
            const integration = registerConfiguredPindieExtension(pi, {
              taskMetrics,
              featureSelection: compositionOptions.featureSelection,
              storageRoots: compositionOptions.storageRoots,
              onExperienceSaved: compositionOptions.onExperienceSaved,
            });
            pendingPresentationReader = integration.presentation;
            return integration;
          },
        }, ...(compositionOptions.onHumanRunStart ? [{
          name: "pindie-learning-host-lifecycle",
          factory: (pi: ExtensionAPI) => {
            pi.on("before_agent_start", () => { compositionOptions.onHumanRunStart?.(); });
            pi.on("agent_settled", () => { compositionOptions.onHumanRunSettled?.(); });
            pi.on("session_shutdown", () => { compositionOptions.onSessionChange?.(); });
          },
        }] : []), ...(compositionOptions.browserExtensionFactory
          ? [{
              name: "pindie-browser-reality",
              factory: compositionOptions.browserExtensionFactory,
            }]
          : [])],
      },
    });
    const created = await createSession({
      services,
      sessionManager,
      sessionStartEvent,
    });
    // Publish only after the complete runtime factory succeeds. If extension
    // or Session construction fails, the lease remains null rather than
    // claiming a partially constructed Session is current.
    compositionOptions.onPresentationReaderChange?.(pendingPresentationReader);
    compositionOptions.onSessionReady?.(created.session);

    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };
}

export async function createPindieHost(options: PindieHostOptions = {}): Promise<PindieHost> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const sessionManager = options.sessionManager ?? SessionManager.create(cwd);
  const dependencies = options.dependencies ?? {};
  const env = options.env ?? process.env;
  const featureSelection = resolvePindieFeatureSelection(
    options.featureSelection,
    {},
    env,
  );
  const autonomousLearningEnabled = featureSelection.selfImprovement;
  const createRuntime = dependencies.createAgentSessionRuntime ?? createAgentSessionRuntime;
  const createMode =
    dependencies.createInteractiveMode ??
    ((runtime: AgentSessionRuntime, modeOptions: InteractiveModeOptions) =>
      new InteractiveMode(runtime, modeOptions));

  const taskMetrics = new TaskMetricsTracker();
  const browserConfig = resolveBrowserRealityConfig(env);
  const makeBrowserReality = dependencies.createBrowserRealityRuntime ??
    createBrowserRealityRuntime;
  let browserReality: BrowserRealityRuntime | undefined;
  let nativeRuntime: AgentSessionRuntime | undefined;
  let runtime: PiRuntimeAdapter | undefined;
  let rolloverSupervisor: LongTaskRolloverSupervisor | undefined;
  let quotaResumeSupervisor: QuotaResumeSupervisor | undefined;
  let quotaFallbackSupervisor: QuotaFallbackSupervisor | undefined;
  let quotaBridgeLease: QuotaResumeHostLease | undefined;
  let releaseControlBridge: (() => void) | undefined;
  let releaseFallbackBridge: (() => void) | undefined;
  let currentPresentationReader: PindiePresentationReader | null = null;
  let learningSupervisor: LearningSupervisor | undefined;
  let learningModelIdentity: LearningModelPolicy | null = null;
  let learningGeneration = 0;
  let learningHumanActive = false;
  let learningBoundSession: AgentSession | null = null;
  if (options.discoveryPolicy && !validateProjectDiscoveryPolicy(options.discoveryPolicy)) throw new Error("Invalid project discovery policy.");
  const roots = resolvePindieStorageRoots(options.storageRoots);
  const jobs = autonomousLearningEnabled
    ? new FileLearningJobLedger({ globalBaseDir: roots.globalBaseDir })
    : null;
  const discovery = autonomousLearningEnabled && jobs !== null
    ? {
        reader: new FileRunExperienceReader({ baseDir: roots.projectsBaseDir }),
        portfolio: new FileProjectTrustedStrategyPortfolioReader({ projectsBaseDir: roots.projectsBaseDir, globalBaseDir: roots.globalBaseDir }),
        receipts: new FileDiscoveryReceiptStore({ projectsBaseDir: roots.projectsBaseDir }),
        packets: new FileDiscoveryPacketStore(roots.projectsBaseDir),
        hypotheses: new FileDiscoveryHypothesisStore({ projectsBaseDir: roots.projectsBaseDir }),
        jobs,
        ...(options.discoveryPolicy ? { policy: options.discoveryPolicy } : {}),
      }
    : null;
  const enqueue = (projectRoot: string) => {
    if (discovery === null) return;
    void enqueueProjectDiscovery(getProjectId(projectRoot), discovery);
  };
  let currentProjectRoot: string | null = null;
  const preemptLearning = (reason: "human-work" | "session-change") => {
    ++learningGeneration;
    learningSupervisor?.preempt(reason);
  };
  const kickLearning = () => {
    void learningSupervisor?.kick().catch((error: unknown) => {
      console.warn("[Pindie] Learning scheduler unavailable:", error);
    });
  };
  const presentation: PindiePresentationReaderLease = {
    current: () => currentPresentationReader,
  };
  quotaBridgeLease = installQuotaResumeReceiver((event: QuotaResumeControlEvent) => {
    if (!quotaResumeSupervisor) {
      console.warn("[Pindie] Ignored a quota resume event while Host runtime was bootstrapping.");
      return;
    }
    if (event.type === "schedule") return quotaResumeSupervisor.request(event.plan);
    quotaResumeSupervisor.cancel(event.sessionId);
  });
  try {
    releaseFallbackBridge = installQuotaFallbackReceiver({
      request: (plan) => quotaFallbackSupervisor?.request(plan) ?? false,
      canUseBackup: (sessionId) => quotaFallbackSupervisor?.canUseBackup(sessionId) ?? false,
      cancel: (sessionId) => quotaFallbackSupervisor?.cancel(sessionId),
      observeModelSelect: (event) => quotaFallbackSupervisor?.observeModelSelection(event) ?? false,
      backupFailed: (sessionId) => quotaFallbackSupervisor?.handleBackupFailure(sessionId) ?? Promise.resolve(null),
    });
    releaseControlBridge = installCommittedRolloverReceiver(
      (request: CommittedRolloverRequest) => {
        if (!rolloverSupervisor) {
          console.warn("[Pindie] Ignored a committed rollover request while Host runtime was bootstrapping.");
          return;
        }
        return rolloverSupervisor.request(request);
      },
      (boundary: SessionLifecycleBoundary) => {
        rolloverSupervisor?.observeSessionLifecycle(boundary);
        quotaFallbackSupervisor?.observeSessionLifecycle(boundary);
      },
    );
  } catch (error) {
    releaseFallbackBridge?.();
    quotaBridgeLease.release();
    throw error;
  }

  const releaseHostControl = async (): Promise<void> => {
    quotaFallbackSupervisor?.dispose();
    quotaFallbackSupervisor = undefined;
    quotaResumeSupervisor?.dispose();
    quotaResumeSupervisor = undefined;
    quotaBridgeLease?.release();
    quotaBridgeLease = undefined;
    releaseFallbackBridge?.();
    releaseFallbackBridge = undefined;
    releaseControlBridge?.();
    releaseControlBridge = undefined;
    await rolloverSupervisor?.dispose();
  };

  try {
    if (browserConfig.enabled) {
      browserReality = makeBrowserReality(browserConfig);
      const status = await browserReality.start();
      if (!status.available) {
        console.warn(`[Pindie] Browser Reality unavailable: ${status.reason}`);
      }
    }
    nativeRuntime = await createRuntime(createPindieRuntimeFactory(dependencies, taskMetrics, {
      featureSelection,
      storageRoots: options.storageRoots,
      ...(browserReality
        ? {
            browserExtensionFactory: (pi) => registerBrowserRealityExtension(pi, {
              config: browserReality!.config,
              status: () => browserReality!.status(),
            }),
          }
        : {}),
      onPresentationReaderChange: (reader) => {
        currentPresentationReader = reader;
      },
      ...(autonomousLearningEnabled
        ? {
            onExperienceSaved: (root: string) => { if (root === currentProjectRoot) enqueue(root); },
            onHumanRunStart: () => {
              learningHumanActive = true;
              preemptLearning("human-work");
            },
            onHumanRunSettled: () => {
              learningHumanActive = false;
              if (currentProjectRoot) enqueue(currentProjectRoot);
              queueMicrotask(kickLearning);
            },
            onSessionChange: () => {
              learningHumanActive = true;
              learningBoundSession = null;
              preemptLearning("session-change");
            },
            onSessionReady: (session: AgentSession) => {
              // Pi's apply(await createRuntime(...)) publishes the new Session in
              // the await continuation, before the next event-loop turn. A one-shot
              // macrotask therefore observes binding (even if later setup awaits),
              // without kicking against the outgoing Session or polling on failure.
              setTimeout(() => {
                if (!runtime || runtime.activeSession !== session) return;
                learningBoundSession = session;
                // Do not clear a Human Run that began on the newly bound Session.
                if (runtime.getActiveSessionFacts().isIdle) learningHumanActive = false;
                if (currentProjectRoot) enqueue(currentProjectRoot);
                kickLearning();
              }, 0).unref();
            },
          }
        : {}),
    }), {
      cwd,
      agentDir,
      sessionManager,
    });
    runtime = new PiRuntimeAdapter(nativeRuntime);
    if (autonomousLearningEnabled) {
      try { currentProjectRoot = await resolveProjectRoot(cwd); }
      catch { console.warn("[Pindie] Project discovery root unavailable; enqueue skipped."); }
      // Learning model identity is frozen once at Host start; it never follows the
      // mutable Human Session model/fallback. A startup fallback is not a baseline,
      // and absence fails closed so jobs stay pending.
      const learningSession = runtime.activeSession;
      const resolvedLearningModel = resolveLearningModel({
        ...(options.learningModel ? { requested: options.learningModel } : {}),
        baseline: learningSession.model,
        startupFellBack: nativeRuntime.modelFallbackMessage !== undefined,
        resolve: (provider, modelId) => learningSession.modelRuntime?.getModel(provider, modelId),
      });
      const learningRunner = resolvedLearningModel
        ? createLearningSessionRunner({ cwd, model: resolvedLearningModel.model, policy: resolvedLearningModel.policy })
        : undefined;
      learningModelIdentity = learningRunner?.modelIdentity ?? null;
      if (!learningRunner) console.warn("[Pindie] Learning model unavailable (explicit config missing/unresolved or startup fallback); learning jobs remain pending.");
      learningSupervisor = new LearningSupervisor({
        ledger: jobs!,
        budget: new FileLearningBudgetLedger({ globalBaseDir: roots.globalBaseDir }),
        handlers: options.learningHandlers ?? [createProjectDiscoveryHandler(discovery!)],
        runner: learningRunner,
        authority: {
          generation: () => learningGeneration,
          idle: () => {
            if (learningHumanActive || !runtime || runtime.activeSession !== learningBoundSession) return false;
            const facts = runtime.getActiveSessionFacts();
            return facts.isIdle && !facts.isStreaming && !facts.isCompacting && facts.pendingMessageCount === 0;
          },
        },
      });
      if (currentProjectRoot) enqueue(currentProjectRoot);
    }
    quotaFallbackSupervisor = new QuotaFallbackSupervisor(runtime, options.quotaFallback);
    const testWaitingChange = options.quotaResume?.onWaitingChange;
    quotaResumeSupervisor = new QuotaResumeSupervisor(runtime, {
      ...options.quotaResume,
      onWaitingChange: (status: QuotaResumeWaitingStatus | null) => {
        quotaBridgeLease?.publishWaitingStatus(status);
        if (testWaitingChange) testWaitingChange(status);
      },
    });
    rolloverSupervisor = new LongTaskRolloverSupervisor(runtime, {
      ...options.longTaskRollover,
      taskMetrics,
    });

    const modeOptions: InteractiveModeOptions = {
      startupDiagnostics: [...nativeRuntime.diagnostics],
      modelFallbackMessage: nativeRuntime.modelFallbackMessage,
      ...options.interactiveModeOptions,
    };
    const activeRuntime = runtime;
    const interactiveMode = isPindieTuiEnabled(env)
      ? (dependencies.createPindieInteractiveMode ??
        ((adapter, ownedModeOptions) => new OwnedPindieInteractiveMode(adapter, ownedModeOptions)))(
          activeRuntime,
          {
            ...modeOptions,
            cwd,
            agentDir,
            presentation,
          },
        )
      : createMode(nativeRuntime, modeOptions);
    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        // Do not leave a Session-bound reader visible while Host teardown is
        // releasing the native runtime. The second assignment covers any
        // cleanup path that publishes during asynchronous teardown.
        currentPresentationReader = null;
        preemptLearning("session-change");
        await learningSupervisor?.dispose();
        await releaseHostControl();
        try {
          await runtime!.dispose();
        } finally {
          currentPresentationReader = null;
          await browserReality?.dispose();
        }
      })();
      return disposePromise;
    };

    queueMicrotask(kickLearning);
    return {
      runtime,
      interactiveMode,
      presentation,
      learningModelIdentity,
      run: async () => {
        try {
          await interactiveMode.run();
        } finally {
          await dispose();
        }
      },
      dispose,
    };
  } catch (error) {
    currentPresentationReader = null;
    preemptLearning("session-change");
    await learningSupervisor?.dispose();
    await releaseHostControl();
    if (runtime ?? nativeRuntime) {
      try {
        await (runtime ?? nativeRuntime)!.dispose();
      } catch {
        // Preserve the bootstrap error; cleanup is best effort during failed setup.
      }
    }
    try {
      await browserReality?.dispose();
    } catch {
      // Preserve the bootstrap error; Browser cleanup is best effort.
    }
    throw error;
  }
}

export async function runPindieHost(options: PindieHostOptions = {}): Promise<void> {
  const host = await createPindieHost(options);
  await host.run();
}
