import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { createPindieHost, createPindieRuntimeFactory, getPindieResourcePaths } from "../src/host.ts";
import { getCommittedRolloverPublisher } from "../src/long-task-control.ts";
import { PINDIE_LONG_TASK_RESUME_TYPE, formatLongTaskResume } from "../src/long-task-resume.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { registerPindieExtension } from "../src/extension.ts";
import {
  PINDIE_CONTEXT_LIFECYCLE_START,
  PINDIE_CONTEXT_LIFECYCLE_TYPE,
} from "../src/context-governor.ts";
import { PINDIE_RUN_BASELINE_START } from "../src/context.ts";
import { FileStateStore } from "../src/store.ts";
import { createTaskContinuity } from "../src/task-continuity.ts";

const PINDIE_TOOL_NAMES = [
  "pindie_gate_open",
  "pindie_gate_resolve",
  "pindie_git_observe",
  "pindie_policy_set",
  "pindie_strategy_candidate_create",
  "pindie_task_complete",
  "pindie_task_progress",
  "pindie_task_refine",
  "pindie_task_replace",
  "pindie_task_start",
  "pindie_task_handoff",
  "pindie_verification_record",
];

function assertPindieSurface(session: AgentSession): void {
  const toolNames = new Set(session.getAllTools().map((tool) => tool.name));
  for (const name of PINDIE_TOOL_NAMES) assert.equal(toolNames.has(name), true, `missing ${name}`);

  const commandNames = new Set(session.extensionRunner.getRegisteredCommands().map((command) => command.name));
  assert.equal(commandNames.has("experience"), true);
  assert.equal(commandNames.has("adapt"), true);
  assert.equal(commandNames.has("trial"), true);
  assert.equal(session.resourceLoader.getSkills().skills.some((skill) => skill.name === "git-workflow"), true);
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part !== "object" || part === null) return "";
    if ("text" in part && typeof part.text === "string") return part.text;
    if ("thinking" in part && typeof part.thinking === "string") return part.thinking;
    return "";
  }).join("\n");
}

async function executeExtensionTool(
  session: AgentSession,
  name: string,
  params: Record<string, unknown>,
): Promise<{ details?: unknown }> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `missing ${name}`);
  return tool.execute(
    `runtime-independence-${name}`,
    params,
    undefined,
    undefined,
    session.createReplacedSessionContext(),
  );
}

test("PiRuntimeAdapter replaces a real Pindie Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-runtime-replacement-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  let runtime: AgentSessionRuntime | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    runtime = await createAgentSessionRuntime(createPindieRuntimeFactory(), {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const adapter = new PiRuntimeAdapter(runtime);
    const beforeSessionId = adapter.activeSessionId;

    const directToolNames = new Set(runtime.session.getAllTools().map((tool) => tool.name));
    assert.equal(directToolNames.has("pindie_task_handoff"), false);

    const result = await adapter.replaceWithFreshSession();

    assert.deepEqual(result, { cancelled: false });
    assert.notEqual(beforeSessionId, adapter.activeSessionId);
    const directReplacementToolNames = new Set(runtime.session.getAllTools().map((tool) => tool.name));
    assert.equal(directReplacementToolNames.has("pindie_task_handoff"), false);
    assert.equal(adapter.activeSession, runtime.session);
    await adapter.dispose();
    runtime = undefined;
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("PiRuntimeAdapter lifecycle binding observes real replacement ordering and clears cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-runtime-lifecycle-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  let runtime: AgentSessionRuntime | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    runtime = await createAgentSessionRuntime(createPindieRuntimeFactory(), {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const adapter = new PiRuntimeAdapter(runtime);
    const sessionA = adapter.activeSession;
    const events: string[] = [];

    adapter.setActiveSessionClientLifecycle({
      beforeSessionInvalidate: () => {
        events.push(`before:${adapter.activeSessionId}`);
      },
      rebindSession: async () => {
        events.push(`rebind:${adapter.activeSessionId}`);
      },
    });

    const replacement = await adapter.replaceWithFreshSession();
    assert.deepEqual(replacement, { cancelled: false });
    const sessionB = adapter.activeSession;
    assert.notEqual(sessionA, sessionB);
    assert.deepEqual(events, [`before:${sessionA.sessionId}`, `rebind:${sessionB.sessionId}`]);

    adapter.setActiveSessionClientLifecycle();
    await adapter.replaceWithFreshSession();
    const sessionC = adapter.activeSession;
    assert.notEqual(sessionB, sessionC);
    assert.deepEqual(events, [`before:${sessionA.sessionId}`, `rebind:${sessionB.sessionId}`]);

    await adapter.dispose();
    runtime = undefined;
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host presentation reader lease follows Session replacement and disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-presentation-lease-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousHome = process.env.HOME;
  let host: Awaited<ReturnType<typeof createPindieHost>> | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    await mkdir(home);
    process.env.HOME = home;
    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      env: { PINDIE_BROWSER_ENABLED: "false" },
      dependencies: {
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });

    const firstReader = host.presentation.current();
    assert.ok(firstReader);
    assert.deepEqual(Object.keys(host.presentation), ["current"]);
    assert.equal("set" in host.presentation, false);
    assert.equal("clear" in host.presentation, false);

    await host.runtime.replaceWithFreshSession();
    const secondReader = host.presentation.current();
    assert.ok(secondReader);
    assert.notEqual(firstReader, secondReader);
    assert.equal(host.presentation.current(), secondReader);

    await host.dispose();
    assert.equal(host.presentation.current(), null);
    host = undefined;
  } finally {
    await host?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Host presentation reader lease stays null when replacement construction fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-presentation-lease-failure-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousHome = process.env.HOME;
  const replacementFailure = new Error("fresh Pindie runtime failed");
  let serviceCalls = 0;
  let replacementStarted!: () => void;
  const replacementStartedPromise = new Promise<void>((resolve) => {
    replacementStarted = resolve;
  });
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let host: Awaited<ReturnType<typeof createPindieHost>> | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    await mkdir(home);
    process.env.HOME = home;
    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      env: { PINDIE_BROWSER_ENABLED: "false" },
      dependencies: {
        createAgentSessionServices: async (serviceOptions) => {
          serviceCalls += 1;
          if (serviceCalls > 1) {
            replacementStarted();
            await failureGate;
            throw replacementFailure;
          }
          return createAgentSessionServices(serviceOptions);
        },
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });

    assert.ok(host.presentation.current());
    const replacement = host.runtime.replaceWithFreshSession();
    await replacementStartedPromise;
    assert.equal(host.presentation.current(), null);
    releaseFailure();
    await assert.rejects(replacement, replacementFailure);

    await host.dispose();
    host = undefined;
  } finally {
    releaseFailure?.();
    await host?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("Host-owned automatic rollover persists native lineage naming without adding it to LLM context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-session-lineage-name-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const previousHome = process.env.HOME;
  const previousDiscordEnvironment = {
    PINDIE_DISCORD_TOKEN: process.env.PINDIE_DISCORD_TOKEN,
    PINDIE_DISCORD_USER_ID: process.env.PINDIE_DISCORD_USER_ID,
    PINDIE_DISCORD_GUILD_ID: process.env.PINDIE_DISCORD_GUILD_ID,
  };
  const faux = fauxProvider({ provider: `pindie-lineage-name-${Date.now()}-${Math.random()}` });
  let host: Awaited<ReturnType<typeof createPindieHost>> | undefined;
  let providerContext: unknown;

  try {
    await mkdir(cwd);
    await mkdir(agentDir, { recursive: true });
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.PINDIE_DISCORD_TOKEN;
    delete process.env.PINDIE_DISCORD_USER_ID;
    delete process.env.PINDIE_DISCORD_GUILD_ID;

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });

    const sessionManager = SessionManager.create(cwd, sessionDir);
    const sourcePrompt = "  Persist the original Long Task identity.\n";
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: sourcePrompt }],
      timestamp: Date.now(),
    } as never);
    sessionManager.appendMessage(fauxAssistantMessage("persist the source Session") as never);
    assert.equal(sessionManager.getSessionName(), undefined);

    const scheduled: Array<() => void> = [];
    let freshSessionRebound!: () => void;
    const freshSessionReboundPromise = new Promise<void>((resolve) => {
      freshSessionRebound = resolve;
    });
    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager,
      longTaskRollover: { schedule: (callback) => scheduled.push(callback) },
      dependencies: {
        createAgentSessionServices: async (serviceOptions) =>
          createAgentSessionServices({ ...serviceOptions, modelRuntime }),
        createAgentSessionFromServices: async (sessionOptions) =>
          createAgentSessionFromServices({ ...sessionOptions, model: faux.getModel() }),
        createInteractiveMode: (nativeRuntime) => {
          nativeRuntime.setRebindSession(async (session) => {
            await session.bindExtensions({});
            freshSessionRebound();
          });
          return { run: async () => {} };
        },
      },
    });
    await host.runtime.activeSession.bindExtensions({});

    const sourceSessionId = host.runtime.activeSessionId;
    const expectedName = "cont. 2 · Persist the original Long Task identity.";
    const checkpoint = createTaskContinuity({
      createdAt: "2026-09-04T00:00:00.000Z",
      taskFingerprint: `sha256:${"e".repeat(64)}`,
      sourceSessionId,
      progressSummary: "The current Session reached a durable handoff frontier.",
      decisions: ["Keep Session naming outside semantic Task state."],
    });
    faux.setResponses([(context) => {
      providerContext = context;
      return fauxAssistantMessage("deterministic automatic resume response");
    }]);

    const publisher = getCommittedRolloverPublisher();
    assert.ok(publisher);
    publisher({ sourceSessionId, checkpoint });
    const scheduledRollover = scheduled.shift();
    assert.ok(scheduledRollover);
    scheduledRollover();
    await freshSessionReboundPromise;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const currentSession = host.runtime.activeSession;
      if (
        currentSession.sessionId !== sourceSessionId &&
        currentSession.sessionManager.getSessionName() !== undefined
      ) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.notEqual(host.runtime.activeSessionId, sourceSessionId);
    const freshSession = host.runtime.activeSession;
    for (let attempt = 0; attempt < 1_000 && providerContext === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(providerContext, "hidden resume should reach the faux provider");
    await freshSession.waitForIdle();
    assert.equal(freshSession.sessionManager.getSessionName(), expectedName);
    const sessionInfoEntries = freshSession.sessionManager.getEntries().filter((entry) => entry.type === "session_info");
    assert.equal(sessionInfoEntries.length, 1);
    assert.equal((sessionInfoEntries[0] as { name?: string }).name, expectedName);
    const freshSessionFile = freshSession.sessionFile;
    assert.ok(freshSessionFile);
    assert.equal(SessionManager.open(freshSessionFile).getSessionName(), expectedName);

    const contextMessages = freshSession.sessionManager.buildSessionContext().messages;
    assert.equal(contextMessages.some((message) => messageText(message).includes(expectedName)), false);
    assert.equal(
      contextMessages.some((message) => (message as unknown as { type?: unknown }).type === "session_info"),
      false,
    );
    const providerMessages = (providerContext as { messages?: readonly unknown[] } | undefined)?.messages ?? [];
    assert.equal(providerMessages.some((message) => messageText(message).includes(expectedName)), false);

    await host.dispose();
    host = undefined;
  } finally {
    await host?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const [name, value] of Object.entries(previousDiscordEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Host-owned replacement preserves the Pindie extension surface and project State", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-host-compatibility-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousHome = process.env.HOME;
  const previousDiscordEnvironment = {
    PINDIE_DISCORD_TOKEN: process.env.PINDIE_DISCORD_TOKEN,
    PINDIE_DISCORD_USER_ID: process.env.PINDIE_DISCORD_USER_ID,
    PINDIE_DISCORD_GUILD_ID: process.env.PINDIE_DISCORD_GUILD_ID,
  };
  let host: Awaited<ReturnType<typeof createPindieHost>> | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    process.env.HOME = home;
    delete process.env.PINDIE_DISCORD_TOKEN;
    delete process.env.PINDIE_DISCORD_USER_ID;
    delete process.env.PINDIE_DISCORD_GUILD_ID;

    const stateStore = new FileStateStore();
    let bridgeWasInstalledBeforeExtensionLoad = false;
    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      dependencies: {
        createAgentSessionServices: async (serviceOptions) => {
          bridgeWasInstalledBeforeExtensionLoad = getCommittedRolloverPublisher() !== null;
          return createAgentSessionServices(serviceOptions);
        },
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });

    assert.equal(bridgeWasInstalledBeforeExtensionLoad, true);
    await host.runtime.activeSession.bindExtensions({});
    const firstSession = host.runtime.activeSession;
    assertPindieSurface(firstSession);
    const firstId = host.runtime.activeSessionId;

    const started = await executeExtensionTool(firstSession, "pindie_task_start", {
      goal: "Preserve the current Pindie State across a fresh Pi Session.",
      successCriteria: ["The project-local State remains authoritative after replacement."],
    });
    assert.equal(
      (started.details as { state?: { task?: { goal?: string } } } | undefined)?.state?.task?.goal,
      "Preserve the current Pindie State across a fresh Pi Session.",
    );

    const replacement = await host.runtime.replaceWithFreshSession();
    assert.deepEqual(replacement, { cancelled: false });
    assert.notEqual(firstId, host.runtime.activeSessionId);
    await host.runtime.activeSession.bindExtensions({});
    assertPindieSurface(host.runtime.activeSession);

    const refined = await executeExtensionTool(host.runtime.activeSession, "pindie_task_refine", {
      goal: "Preserve the refined Pindie State across a fresh Pi Session.",
    });
    assert.equal(
      (refined.details as { state?: { task?: { goal?: string } } } | undefined)?.state?.task?.goal,
      "Preserve the refined Pindie State across a fresh Pi Session.",
    );
    assert.equal((await stateStore.load(cwd)).task?.goal, "Preserve the refined Pindie State across a fresh Pi Session.");

    await Promise.all([host.dispose(), host.dispose()]);
    host = undefined;
  } finally {
    await host?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const [name, value] of Object.entries(previousDiscordEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Host-owned hidden resume follows the normal Pindie Run-start contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-run-start-conformance-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousHome = process.env.HOME;
  const previousDiscordEnvironment = {
    PINDIE_DISCORD_TOKEN: process.env.PINDIE_DISCORD_TOKEN,
    PINDIE_DISCORD_USER_ID: process.env.PINDIE_DISCORD_USER_ID,
    PINDIE_DISCORD_GUILD_ID: process.env.PINDIE_DISCORD_GUILD_ID,
  };
  const faux = fauxProvider({ provider: `pindie-conformance-${Date.now()}-${Math.random()}` });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  let host: Awaited<ReturnType<typeof createPindieHost>> | undefined;
  let providerContext: unknown;

  try {
    await mkdir(cwd);
    await mkdir(agentDir, { recursive: true });
    await mkdir(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.PINDIE_DISCORD_TOKEN;
    delete process.env.PINDIE_DISCORD_USER_ID;
    delete process.env.PINDIE_DISCORD_GUILD_ID;

    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      dependencies: {
        createAgentSessionServices: async (serviceOptions) =>
          createAgentSessionServices({ ...serviceOptions, modelRuntime }),
        createAgentSessionFromServices: async (sessionOptions) =>
          createAgentSessionFromServices({ ...sessionOptions, model: faux.getModel() }),
        createInteractiveMode: (nativeRuntime) => {
          nativeRuntime.setRebindSession(async (session) => {
            await session.bindExtensions({});
          });
          return { run: async () => {} };
        },
      },
    });

    const initialSession = host.runtime.activeSession;
    assertPindieSurface(initialSession);
    await initialSession.bindExtensions({});
    const started = await executeExtensionTool(initialSession, "pindie_task_start", {
      goal: "Continue this Task across a hidden runtime Session rollover.",
      successCriteria: ["The fresh Agent Run receives authoritative Pindie context."],
    });
    assert.equal(
      (started.details as { state?: { task?: { goal?: string } } } | undefined)?.state?.task?.goal,
      "Continue this Task across a hidden runtime Session rollover.",
    );

    faux.setResponses([
      (context) => {
        providerContext = context;
        return fauxAssistantMessage("deterministic resumed response");
      },
      fauxAssistantMessage("deterministic continuation response"),
    ]);
    const checkpoint = createTaskContinuity({
      createdAt: "2026-09-04T00:00:00.000Z",
      taskFingerprint: `sha256:${"d".repeat(64)}`,
      sourceSessionId: initialSession.sessionId,
      progressSummary: "The current Session reached a durable handoff frontier.",
      decisions: ["Use current PindieState and project Reality as authority."],
    });

    const replacement = await host.runtime.replaceWithFreshSession({
      withSession: async (replacedContext) => {
        await replacedContext.sendMessage(
          {
            customType: PINDIE_LONG_TASK_RESUME_TYPE,
            content: formatLongTaskResume(checkpoint),
            display: false,
          },
          { triggerTurn: true },
        );
      },
    });

    assert.deepEqual(replacement, { cancelled: false });
    const resumedSession = host.runtime.activeSession;
    assertPindieSurface(resumedSession);
    assert.equal(resumedSession.getActiveToolNames().includes("pindie_task_handoff"), true);

    const messages = (providerContext as { messages?: readonly unknown[] } | undefined)?.messages ?? [];
    const baseline = messages.find((message) => messageText(message).includes("<PINDIE_RUN_BASELINE>"));
    const resume = messages.find((message) => messageText(message).includes("<PINDIE_LONG_TASK_RESUME>"));
    assert.ok(baseline, "normal Pindie Run Baseline should be sent to the provider");
    assert.match(messageText(baseline), /Agent Run authority: coherent/);
    assert.ok(resume, "hidden runtime continuation should be sent to the provider");
    assert.match(messageText(resume), /current durable Pindie Task/i);
    assert.match(messageText(resume), /The current Session reached a durable handoff frontier\./);
    assert.match(messageText(resume), /This is not new user intent\./i);
    assert.equal(resumedSession.messages.some((message) => message.role === "user"), false);

    await host.dispose();
    host = undefined;
  } finally {
    await host?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const [name, value] of Object.entries(previousDiscordEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi context projection carries one ephemeral Context Lifecycle guidance and preserves compaction checkpointing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-context-governor-conformance-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previousHome = process.env.HOME;
  const faux = fauxProvider({ provider: `pindie-context-governor-${Date.now()}-${Math.random()}` });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  let session: AgentSession | undefined;
  let integration: ReturnType<typeof registerPindieExtension> | undefined;
  const providerContexts: unknown[] = [];
  const longResponse = "bounded history ".repeat(1_000);

  try {
    await mkdir(cwd);
    await mkdir(agentDir, { recursive: true });
    await mkdir(home, { recursive: true });
    process.env.HOME = home;

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        additionalSkillPaths: [getPindieResourcePaths().skillsPath],
        extensionFactories: [{
          name: "pindie-context-governor-conformance",
          hidden: true,
          factory: (pi) => {
            integration = registerPindieExtension(pi, {
              enableTaskHandoff: true,
              contextGovernorTuning: {
                elevatedPercent: 0.0000001,
                highPercent: 99,
                postCompactionRegrowthDelta: 25,
              },
            });
          },
        }],
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model: faux.getModel(),
    });
    session = created.session;
    await session.bindExtensions({});

    const started = await executeExtensionTool(session, "pindie_task_start", {
      goal: "Verify Context Lifecycle guidance stays ephemeral in a real Pi Session.",
      successCriteria: ["Provider context receives bounded runtime guidance."],
    });
    assert.ok(started);

    faux.setResponses([
      (providerContext) => {
        providerContexts.push(providerContext);
        return fauxAssistantMessage("first deterministic response");
      },
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage(longResponse),
      fauxAssistantMessage("deterministic compaction summary"),
      fauxAssistantMessage("deterministic compaction summary"),
      fauxAssistantMessage("deterministic compaction summary"),
      fauxAssistantMessage("deterministic compaction summary"),
      fauxAssistantMessage("deterministic compaction summary"),
    ]);

    await session.prompt("Continue the bounded verification work.");
    assert.ok(integration);
    assert.equal(providerContexts.length, 1);
    const providerMessages = (providerContexts[0] as { messages?: readonly unknown[] }).messages ?? [];
    const lifecycleMessages = providerMessages.filter((message) =>
      messageText(message).includes(PINDIE_CONTEXT_LIFECYCLE_START),
    );
    const baselineMessages = providerMessages.filter((message) =>
      messageText(message).includes(PINDIE_RUN_BASELINE_START),
    );
    assert.equal(baselineMessages.length, 1);
    assert.equal(lifecycleMessages.length, 1);
    assert.match(messageText(lifecycleMessages[0]), /Context Lifecycle Guidance: elevated/);
    assert.match(messageText(lifecycleMessages[0]), /not new user intent/i);
    assert.equal(
      session.messages.some((message) => messageText(message).includes(PINDIE_CONTEXT_LIFECYCLE_START)),
      false,
    );
    assert.equal(
      session.sessionManager.getEntries().some((entry) =>
        entry.type === "custom_message" && entry.customType === PINDIE_CONTEXT_LIFECYCLE_TYPE,
      ),
      false,
    );

    await session.prompt("Add enough bounded history for a compaction check.");
    await session.prompt("Add one more bounded history check.");
    await session.prompt("Finish the pre-compaction history check.");
    const compaction = await session.compact();
    assert.match(compaction.summary, /deterministic compaction summary/);
    assert.equal(session.getContextUsage()?.percent, null);
    assert.equal(integration.contextGovernor.snapshot.pressure, "normal");
    assert.equal(integration.contextGovernor.snapshot.contextPercent, null);
    assert.equal(integration.contextGovernor.snapshot.postCompactionBaselinePercent, null);
    assert.equal(integration.contextGovernor.snapshot.successfulCompactions, 1);
    assert.equal(integration.contextGovernor.snapshot.pressureCompactions, 0);

    const entries = session.sessionManager.getEntries();
    assert.equal(
      entries.some((entry) => entry.type === "custom_message" && entry.customType === "pindie-state-checkpoint"),
      true,
    );
    assert.equal(
      entries.some((entry) => entry.type === "custom_message" && entry.customType === PINDIE_CONTEXT_LIFECYCLE_TYPE),
      false,
    );
  } finally {
    session?.dispose();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
