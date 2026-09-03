import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  type LoadExtensionsResult,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  createPindieHost,
  createPindieRuntimeFactory,
  getPindieResourcePaths,
  type PindieInteractiveMode,
} from "../src/host.ts";

function fakeRuntime() {
  let disposeCalls = 0;
  const runtime = {
    diagnostics: [],
    modelFallbackMessage: undefined,
    dispose: async () => {
      disposeCalls += 1;
    },
  } as unknown as AgentSessionRuntime;
  return {
    runtime,
    disposeCalls: () => disposeCalls,
  };
}

function fakeSessionServices(): AgentSessionServices {
  return {} as AgentSessionServices;
}

test("Pindie extension resource path is relative to the package", () => {
  const paths = getPindieResourcePaths();

  assert.equal(paths.extensionPath, fileURLToPath(new URL("../src/extension.ts", import.meta.url)));
  assert.equal(paths.extensionPath.endsWith("/src/extension.ts"), true);
});

test("bundled Skills resource path is relative to the package", () => {
  const paths = getPindieResourcePaths();

  assert.equal(paths.skillsPath, fileURLToPath(new URL("../skills/", import.meta.url)));
  assert.equal(paths.skillsPath.endsWith("/skills/"), true);
});

test("runtime factory passes project cwd and package resources to Pi services", async () => {
  const projectCwd = "/tmp/pindie-host-project";
  const agentDir = "/tmp/pindie-host-agent";
  const sessionManager = SessionManager.inMemory(projectCwd);
  const services = fakeSessionServices();
  const session = {} as AgentSession;
  let servicesOptions: CreateAgentSessionServicesOptions | undefined;
  let sessionOptions: unknown;

  const factory = createPindieRuntimeFactory({
    createAgentSessionServices: async (options) => {
      servicesOptions = options;
      return services;
    },
    createAgentSessionFromServices: async (options) => {
      sessionOptions = options;
      return {
        session,
        extensionsResult: {} as LoadExtensionsResult,
      } satisfies CreateAgentSessionResult;
    },
  });

  const runtimeResult = await factory({ cwd: projectCwd, agentDir, sessionManager });
  const paths = getPindieResourcePaths();

  assert.equal(servicesOptions?.cwd, projectCwd);
  assert.equal(servicesOptions?.agentDir, agentDir);
  assert.deepEqual(servicesOptions?.resourceLoaderOptions, {
    additionalExtensionPaths: [paths.extensionPath],
    additionalSkillPaths: [paths.skillsPath],
  });
  assert.equal((sessionOptions as { services: AgentSessionServices }).services, services);
  assert.equal(runtimeResult.session, session);
  assert.equal(runtimeResult.services, services);
});

test("Host creates one runtime and supplies that same runtime to InteractiveMode", async () => {
  const projectCwd = "/tmp/pindie-host-project";
  const { runtime, disposeCalls } = fakeRuntime();
  const sessionManager = SessionManager.inMemory(projectCwd);
  let runtimeCalls = 0;
  let runtimeOptions: { cwd: string } | undefined;
  let modeRuntime: AgentSessionRuntime | undefined;
  let modeRuns = 0;

  const interactiveMode: PindieInteractiveMode = {
    run: async () => {
      modeRuns += 1;
    },
  };
  const host = await createPindieHost({
    cwd: projectCwd,
    sessionManager,
    dependencies: {
      createAgentSessionRuntime: async (_factory, options) => {
        runtimeCalls += 1;
        runtimeOptions = options;
        return runtime;
      },
      createInteractiveMode: (createdRuntime) => {
        modeRuntime = createdRuntime;
        return interactiveMode;
      },
    },
  });

  assert.equal(runtimeCalls, 1);
  assert.equal(runtimeOptions?.cwd, projectCwd);
  assert.equal(modeRuntime, runtime);

  await host.run();

  assert.equal(modeRuns, 1);
  assert.equal(disposeCalls(), 1);
});

test("InteractiveMode failure still disposes the Host-owned runtime", async () => {
  const { runtime, disposeCalls } = fakeRuntime();
  const modeError = new Error("interactive mode failed");
  const host = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    dependencies: {
      createAgentSessionRuntime: async () => runtime,
      createInteractiveMode: () => ({
        run: async () => {
          throw modeError;
        },
      }),
    },
  });

  await assert.rejects(host.run(), modeError);
  assert.equal(disposeCalls(), 1);
});

test("Host bootstrap failure disposes a runtime created before InteractiveMode", async () => {
  const { runtime, disposeCalls } = fakeRuntime();
  const bootstrapError = new Error("interactive mode construction failed");

  await assert.rejects(
    createPindieHost({
      sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
      dependencies: {
        createAgentSessionRuntime: async () => runtime,
        createInteractiveMode: () => {
          throw bootstrapError;
        },
      },
    }),
    bootstrapError,
  );

  assert.equal(disposeCalls(), 1);
});
