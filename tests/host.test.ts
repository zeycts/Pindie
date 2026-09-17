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
import {
  getCommittedRolloverPublisher,
  getSessionLifecyclePublisher,
} from "../src/long-task-control.ts";
import { createTaskContinuity } from "../src/task-continuity.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";
import type {
  BrowserRealityConfig,
  BrowserRealityRuntime,
} from "../src/browser-reality.ts";

class ManualScheduler {
  readonly callbacks: Array<() => void> = [];

  readonly schedule = (callback: () => void): void => {
    this.callbacks.push(callback);
  };
}

function committedRequest(sourceSessionId: string) {
  return {
    sourceSessionId,
    checkpoint: createTaskContinuity({
      createdAt: "2026-09-04T00:00:00.000Z",
      taskFingerprint: `sha256:${"c".repeat(64)}`,
      sourceSessionId,
      progressSummary: "Preserve the runtime while the native replacement is active.",
      decisions: ["Pi owns native Session replacement."],
    }),
  };
}

function fakeRuntime() {
  let disposeCalls = 0;
  let newSessionCalls = 0;
  const session = { sessionId: "session-1" } as AgentSession;
  const runtime = {
    session,
    newSession: async () => {
      newSessionCalls += 1;
      return { cancelled: false };
    },
    diagnostics: [],
    modelFallbackMessage: undefined,
    dispose: async () => {
      disposeCalls += 1;
    },
  } as unknown as AgentSessionRuntime;
  return {
    runtime,
    disposeCalls: () => disposeCalls,
    newSessionCalls: () => newSessionCalls,
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
  assert.deepEqual(
    servicesOptions?.resourceLoaderOptions?.additionalSkillPaths,
    [paths.skillsPath],
  );
  const extensionFactories = servicesOptions?.resourceLoaderOptions?.extensionFactories;
  assert.equal(extensionFactories?.length, 1);
  assert.equal(
    typeof (extensionFactories?.[0] as { factory?: unknown } | undefined)?.factory,
    "function",
  );
  assert.equal((sessionOptions as { services: AgentSessionServices }).services, services);
  assert.equal(runtimeResult.session, session);
  assert.equal(runtimeResult.services, services);
});

test("runtime factory adds Browser Reality only when an enabled Host supplies it", async () => {
  const services = fakeSessionServices();
  let servicesOptions: CreateAgentSessionServicesOptions | undefined;
  const browserFactory = () => {};
  const factory = createPindieRuntimeFactory(
    {
      createAgentSessionServices: async (options) => {
        servicesOptions = options;
        return services;
      },
      createAgentSessionFromServices: async () => ({
        session: {} as AgentSession,
        extensionsResult: {} as LoadExtensionsResult,
      }),
    },
    new TaskMetricsTracker(),
    { browserExtensionFactory: browserFactory },
  );

  await factory({
    cwd: "/tmp/pindie-host-project",
    agentDir: "/tmp/pindie-host-agent",
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
  });

  const extensionFactories = servicesOptions?.resourceLoaderOptions?.extensionFactories;
  assert.deepEqual(extensionFactories?.map((entry) => entry.name), [
    "pindie",
    "pindie-browser-reality",
  ]);
  assert.equal(extensionFactories?.[1]?.factory, browserFactory);
});

test("runtime factory omits Pindie-added Skills when the startup selection disables them", async () => {
  const services = fakeSessionServices();
  let servicesOptions: CreateAgentSessionServicesOptions | undefined;
  const factory = createPindieRuntimeFactory(
    {
      createAgentSessionServices: async (options) => {
        servicesOptions = options;
        return services;
      },
      createAgentSessionFromServices: async () => ({
        session: {} as AgentSession,
        extensionsResult: {} as LoadExtensionsResult,
      }),
    },
    new TaskMetricsTracker(),
    { featureSelection: { bundledSkills: false } },
  );

  await factory({
    cwd: "/tmp/pindie-host-project",
    agentDir: "/tmp/pindie-host-agent",
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
  });

  assert.deepEqual(
    servicesOptions?.resourceLoaderOptions?.additionalSkillPaths,
    [],
  );
});

test("Host creates one runtime and supplies that same runtime to InteractiveMode", async () => {
  const projectCwd = "/tmp/pindie-host-project";
  const { runtime, disposeCalls, newSessionCalls } = fakeRuntime();
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
  assert.equal(host.runtime.activeSession, runtime.session);

  await host.runtime.replaceWithFreshSession();
  assert.equal(newSessionCalls(), 1);

  await host.run();

  assert.equal(modeRuns, 1);
  assert.equal(disposeCalls(), 1);
});

test("Host isolates unavailable Browser Reality and cleans its runtime on shutdown", async () => {
  const { runtime, disposeCalls } = fakeRuntime();
  let browserStarts = 0;
  let browserDisposals = 0;
  let resolvedConfig: BrowserRealityConfig | undefined;
  const browserRuntime: BrowserRealityRuntime = {
    config: {
      enabled: true,
      browserUrl: "http://127.0.0.1:9222",
      chromeExecutable: "chrome.exe",
    },
    start: async () => {
      browserStarts += 1;
      return { enabled: true, available: false, reason: "Chrome unavailable" };
    },
    status: async () => ({
      enabled: true,
      available: false,
      reason: "Chrome unavailable",
    }),
    dispose: async () => { browserDisposals += 1; },
  };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };

  try {
    const host = await createPindieHost({
      env: { PINDIE_BROWSER_ENABLED: "true" },
      sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
      dependencies: {
        createBrowserRealityRuntime: (config) => {
          resolvedConfig = config;
          return browserRuntime;
        },
        createAgentSessionRuntime: async () => runtime,
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });

    assert.equal(resolvedConfig?.enabled, true);
    assert.equal(browserStarts, 1);
    assert.match(String(warnings[0]?.[0]), /Browser Reality unavailable.*Chrome unavailable/);
    await host.dispose();
    assert.equal(disposeCalls(), 1);
    assert.equal(browserDisposals, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("Host disposal is idempotent and disposes the native runtime once", async () => {
  const { runtime, disposeCalls } = fakeRuntime();
  const host = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    dependencies: {
      createAgentSessionRuntime: async () => runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });

  await Promise.all([host.dispose(), host.dispose()]);

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

test("Host bootstrap failure releases process-local control ownership", async () => {
  await assert.rejects(
    createPindieHost({
      sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
      dependencies: {
        createAgentSessionRuntime: async () => {
          throw new Error("runtime bootstrap failed");
        },
      },
    }),
    /runtime bootstrap failed/,
  );

  const host = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    dependencies: {
      createAgentSessionRuntime: async () => fakeRuntime().runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });
  await host.dispose();
});

test("Host control bridge rejects a second live Host and releases on disposal", async () => {
  const first = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    dependencies: {
      createAgentSessionRuntime: async () => fakeRuntime().runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });

  try {
    await assert.rejects(
      createPindieHost({
        sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
        dependencies: {
          createAgentSessionRuntime: async () => fakeRuntime().runtime,
          createInteractiveMode: () => ({ run: async () => {} }),
        },
      }),
      /already owns.*control bridge/i,
    );
  } finally {
    await first.dispose();
  }

  const afterRelease = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    dependencies: {
      createAgentSessionRuntime: async () => fakeRuntime().runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });
  await afterRelease.dispose();
});

test("Host lifecycle boundaries reset rollover state even when native Session identity is reused", async () => {
  const scheduler = new ManualScheduler();
  const control = fakeRuntime();
  const host = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    longTaskRollover: {
      schedule: scheduler.schedule,
      maxAutomaticRollovers: 1,
    },
    dependencies: {
      createAgentSessionRuntime: async () => control.runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });

  try {
    const publisher = getCommittedRolloverPublisher();
    const lifecycle = getSessionLifecyclePublisher();
    assert.ok(publisher);
    assert.ok(lifecycle);

    publisher(committedRequest("session-1"));
    const first = scheduler.callbacks.shift();
    assert.ok(first);
    first();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(control.newSessionCalls(), 1);

    // /reload keeps the native Session ID. The Host lifecycle signal must still
    // break the old automatic chain before the next committed request.
    lifecycle({ sessionId: "session-1", reason: "reload" });
    publisher(committedRequest("session-1"));
    const second = scheduler.callbacks.shift();
    assert.ok(second);
    second();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(control.newSessionCalls(), 2);
  } finally {
    await host.dispose();
  }
});

test("Host disposal waits for an in-flight native replacement before disposing Pi", async () => {
  const scheduler = new ManualScheduler();
  const facts = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  let nativeReplacementEntered!: () => void;
  const nativeReplacementEnteredPromise = new Promise<void>((resolve) => {
    nativeReplacementEntered = resolve;
  });
  let releaseNativeReplacement!: () => void;
  const nativeReplacement = new Promise<void>((resolve) => {
    releaseNativeReplacement = resolve;
  });
  let nativeDisposeCalls = 0;
  const session = {
    sessionId: "session-1",
    get isStreaming() { return facts.isStreaming; },
    get isCompacting() { return facts.isCompacting; },
    get pendingMessageCount() { return facts.pendingMessageCount; },
  } as unknown as AgentSession;
  const runtime = {
    get session() { return session; },
    diagnostics: [],
    modelFallbackMessage: undefined,
    newSession: async () => {
      nativeReplacementEntered();
      await nativeReplacement;
      return { cancelled: false };
    },
    dispose: async () => {
      nativeDisposeCalls += 1;
    },
  } as unknown as AgentSessionRuntime;
  const host = await createPindieHost({
    sessionManager: SessionManager.inMemory("/tmp/pindie-host-project"),
    longTaskRollover: { schedule: scheduler.schedule },
    dependencies: {
      createAgentSessionRuntime: async () => runtime,
      createInteractiveMode: () => ({ run: async () => {} }),
    },
  });

  try {
    const publisher = getCommittedRolloverPublisher();
    assert.ok(publisher);
    publisher(committedRequest("session-1"));
    const scheduled = scheduler.callbacks.shift();
    assert.ok(scheduled);
    scheduled();
    await nativeReplacementEnteredPromise;

    const disposing = host.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(nativeDisposeCalls, 0);

    releaseNativeReplacement();
    await disposing;
    assert.equal(nativeDisposeCalls, 1);
  } finally {
    releaseNativeReplacement();
    await host.dispose();
  }
});
