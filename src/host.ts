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
import { registerConfiguredPindieExtension } from "./extension.ts";
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
  env?: Record<string, string | undefined>;
  dependencies?: PindieHostDependencies;
}

export interface PindieHost {
  readonly runtime: PiRuntimeAdapter;
  readonly interactiveMode: PindieInteractiveMode;
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
  } = {},
): CreateAgentSessionRuntimeFactory {
  const createServices = dependencies.createAgentSessionServices ?? createAgentSessionServices;
  const createSession = dependencies.createAgentSessionFromServices ?? createAgentSessionFromServices;
  const resources = getPindieResourcePaths();
  const featureSelection = resolvePindieFeatureSelection(
    compositionOptions.featureSelection,
  );

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalSkillPaths: featureSelection.bundledSkills
          ? [resources.skillsPath]
          : [],
        extensionFactories: [{
          name: "pindie",
          factory: (pi) => registerConfiguredPindieExtension(pi, {
            taskMetrics,
            featureSelection: compositionOptions.featureSelection,
            storageRoots: compositionOptions.storageRoots,
          }),
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
  const createRuntime = dependencies.createAgentSessionRuntime ?? createAgentSessionRuntime;
  const createMode =
    dependencies.createInteractiveMode ??
    ((runtime: AgentSessionRuntime, modeOptions: InteractiveModeOptions) =>
      new InteractiveMode(runtime, modeOptions));

  const taskMetrics = new TaskMetricsTracker();
  const browserConfig = resolveBrowserRealityConfig(options.env ?? process.env);
  const makeBrowserReality = dependencies.createBrowserRealityRuntime ??
    createBrowserRealityRuntime;
  let browserReality: BrowserRealityRuntime | undefined;
  let nativeRuntime: AgentSessionRuntime | undefined;
  let runtime: PiRuntimeAdapter | undefined;
  let rolloverSupervisor: LongTaskRolloverSupervisor | undefined;
  let quotaResumeSupervisor: QuotaResumeSupervisor | undefined;
  let quotaBridgeLease: QuotaResumeHostLease | undefined;
  let releaseControlBridge: (() => void) | undefined;
  quotaBridgeLease = installQuotaResumeReceiver((event: QuotaResumeControlEvent) => {
    if (!quotaResumeSupervisor) {
      console.warn("[Pindie] Ignored a quota resume event while Host runtime was bootstrapping.");
      return;
    }
    if (event.type === "schedule") return quotaResumeSupervisor.request(event.plan);
    quotaResumeSupervisor.cancel(event.sessionId);
  });
  try {
    releaseControlBridge = installCommittedRolloverReceiver(
      (request: CommittedRolloverRequest) => {
        if (!rolloverSupervisor) {
          console.warn("[Pindie] Ignored a committed rollover request while Host runtime was bootstrapping.");
          return;
        }
        rolloverSupervisor.request(request);
      },
      (boundary: SessionLifecycleBoundary) => {
        rolloverSupervisor?.observeSessionLifecycle(boundary);
      },
    );
  } catch (error) {
    quotaBridgeLease.release();
    throw error;
  }

  const releaseHostControl = async (): Promise<void> => {
    quotaResumeSupervisor?.dispose();
    quotaResumeSupervisor = undefined;
    quotaBridgeLease?.release();
    quotaBridgeLease = undefined;
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
      featureSelection: options.featureSelection,
      storageRoots: options.storageRoots,
      ...(browserReality
        ? {
            browserExtensionFactory: (pi) => registerBrowserRealityExtension(pi, {
              config: browserReality!.config,
              status: () => browserReality!.status(),
            }),
          }
        : {}),
    }), {
      cwd,
      agentDir,
      sessionManager,
    });
    runtime = new PiRuntimeAdapter(nativeRuntime);
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
    const interactiveMode = createMode(nativeRuntime, modeOptions);
    let disposePromise: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposePromise ??= (async () => {
        await releaseHostControl();
        try {
          await runtime!.dispose();
        } finally {
          await browserReality?.dispose();
        }
      })();
      return disposePromise;
    };

    return {
      runtime,
      interactiveMode,
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
