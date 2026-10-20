import { fileURLToPath } from "node:url";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  InteractiveMode,
  SessionManager,
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
import { createNativeInteractiveRuntime } from "./native-interactive-runtime.ts";
import { observeNativeUiIdle } from "./native-ui-idle.ts";
import { canReleaseBrowserIdle } from "./browser-idle-authority.ts";
import { createBrowserRealityManager, type BrowserRealityManager } from "./browser-reality-manager.ts";
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
  run(): Promise<void>;
  dispose(): Promise<void>;
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
            });
            pendingPresentationReader = integration.presentation;
            return integration;
          },
        }, ...(compositionOptions.browserExtensionFactory
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
  const createRuntime = dependencies.createAgentSessionRuntime ?? createAgentSessionRuntime;
  const createMode =
    dependencies.createInteractiveMode ??
    ((runtime: AgentSessionRuntime, modeOptions: InteractiveModeOptions) =>
      new InteractiveMode(runtime, modeOptions));

  const taskMetrics = new TaskMetricsTracker();
  const browserConfig = resolveBrowserRealityConfig(env);
  const makeBrowserReality = dependencies.createBrowserRealityRuntime ??
    createBrowserRealityRuntime;
  let browserReality: BrowserRealityManager | undefined;
  let uiIdle: () => boolean = () => false;
  let nativeRuntime: AgentSessionRuntime | undefined;
  let runtime: PiRuntimeAdapter | undefined;
  let rolloverSupervisor: LongTaskRolloverSupervisor | undefined;
  let quotaResumeSupervisor: QuotaResumeSupervisor | undefined;
  let quotaFallbackSupervisor: QuotaFallbackSupervisor | undefined;
  let quotaBridgeLease: QuotaResumeHostLease | undefined;
  let releaseControlBridge: (() => void) | undefined;
  let releaseFallbackBridge: (() => void) | undefined;
  let currentPresentationReader: PindiePresentationReader | null = null;
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
      browserReality = createBrowserRealityManager(browserConfig, {
        createRuntime: makeBrowserReality,
        canIdleRelease: () => runtime !== undefined && canReleaseBrowserIdle({
          session: runtime.getActiveSessionFacts(),
          bashRunning: runtime.activeSession.isBashRunning,
          presentation: currentPresentationReader?.snapshot() ?? null,
          uiIdle: uiIdle(),
        }),
      });
    }
    nativeRuntime = await createRuntime(createPindieRuntimeFactory(dependencies, taskMetrics, {
      featureSelection,
      storageRoots: options.storageRoots,
      ...(browserReality
        ? {
            browserExtensionFactory: (pi) => registerBrowserRealityExtension(pi, {
              manager: browserReality!,
            }),
          }
        : {}),
      onPresentationReaderChange: (reader) => {
        currentPresentationReader = reader;
      },
    }), {
      cwd,
      agentDir,
      sessionManager,
    });
    runtime = new PiRuntimeAdapter(nativeRuntime);
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
      // Preserve Pi 0.99.1 precedence: explicit Host option, effective explicit
      // Pi setting, then regular. Pi 1.x getTuiMode() cannot distinguish unset.
      tuiMode: options.interactiveModeOptions?.tuiMode
        ?? nativeRuntime.session.settingsManager?.getSettings().tuiMode
        ?? "regular",
    };
    let disposePromise: Promise<void> | undefined;
    const interactiveMode = createMode(createNativeInteractiveRuntime(nativeRuntime, dispose), modeOptions);
    uiIdle = observeNativeUiIdle(interactiveMode);
    function dispose(): Promise<void> {
      disposePromise ??= (async () => {
        uiIdle = () => false;
        // Do not leave a Session-bound reader visible while Host teardown is
        // releasing the native runtime. The second assignment covers any
        // cleanup path that publishes during asynchronous teardown.
        currentPresentationReader = null;
        try {
          await releaseHostControl();
        } finally {
          try {
            await runtime!.dispose();
          } finally {
            currentPresentationReader = null;
            await browserReality?.dispose();
          }
        }
      })();
      return disposePromise;
    }

    return {
      runtime,
      interactiveMode,
      presentation,
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
    try { await releaseHostControl(); } catch { /* Still release runtime/browser resources. */ }
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
