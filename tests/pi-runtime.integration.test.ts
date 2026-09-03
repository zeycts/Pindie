import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionRuntime,
  SessionManager,
  type AgentSessionRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createPindieHost, createPindieRuntimeFactory } from "../src/host.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { FileStateStore } from "../src/store.ts";

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
  "pindie_verification_record",
];

function assertPindieSurface(session: AgentSession): void {
  const toolNames = new Set(session.getAllTools().map((tool) => tool.name));
  for (const name of PINDIE_TOOL_NAMES) assert.equal(toolNames.has(name), true, `missing ${name}`);

  const commandNames = new Set(session.extensionRunner.getRegisteredCommands().map((command) => command.name));
  assert.equal(commandNames.has("experience"), true);
  assert.equal(commandNames.has("adapt"), true);
  assert.equal(session.resourceLoader.getSkills().skills.some((skill) => skill.name === "git-workflow"), true);
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

    const result = await adapter.replaceWithFreshSession();

    assert.deepEqual(result, { cancelled: false });
    assert.notEqual(beforeSessionId, adapter.activeSessionId);
    assert.equal(adapter.activeSession, runtime.session);
    await adapter.dispose();
    runtime = undefined;
  } finally {
    await runtime?.dispose();
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
    host = await createPindieHost({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      dependencies: {
        // Keep the test on the real Host/Pi runtime path without starting a TUI.
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });

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
