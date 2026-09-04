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
  type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "./pi-runtime.ts";
import {
  installCommittedRolloverReceiver,
  type CommittedRolloverRequest,
} from "./long-task-control.ts";
import {
  LongTaskRolloverSupervisor,
  type LongTaskRolloverSupervisorOptions,
} from "./long-task-rollover.ts";

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
}

export interface PindieHostOptions {
  cwd?: string;
  agentDir?: string;
  sessionManager?: SessionManager;
  interactiveModeOptions?: InteractiveModeOptions;
  longTaskRollover?: LongTaskRolloverSupervisorOptions;
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
): CreateAgentSessionRuntimeFactory {
  const createServices = dependencies.createAgentSessionServices ?? createAgentSessionServices;
  const createSession = dependencies.createAgentSessionFromServices ?? createAgentSessionFromServices;
  const resources = getPindieResourcePaths();

  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [resources.extensionPath],
        additionalSkillPaths: [resources.skillsPath],
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

  let nativeRuntime: AgentSessionRuntime | undefined;
  let runtime: PiRuntimeAdapter | undefined;
  let rolloverSupervisor: LongTaskRolloverSupervisor | undefined;
  let releaseControlBridge: (() => void) | undefined;
  releaseControlBridge = installCommittedRolloverReceiver((request: CommittedRolloverRequest) => {
    if (!rolloverSupervisor) {
      console.warn("[Pindie] Ignored a committed rollover request while Host runtime was bootstrapping.");
      return;
    }
    rolloverSupervisor.request(request);
  });

  const releaseHostControl = async (): Promise<void> => {
    releaseControlBridge?.();
    releaseControlBridge = undefined;
    await rolloverSupervisor?.dispose();
  };

  try {
    nativeRuntime = await createRuntime(createPindieRuntimeFactory(dependencies), {
      cwd,
      agentDir,
      sessionManager,
    });
    runtime = new PiRuntimeAdapter(nativeRuntime);
    rolloverSupervisor = new LongTaskRolloverSupervisor(runtime, options.longTaskRollover);

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
        await runtime!.dispose();
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
    throw error;
  }
}

export async function runPindieHost(options: PindieHostOptions = {}): Promise<void> {
  const host = await createPindieHost(options);
  await host.run();
}
