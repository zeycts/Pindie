import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";
import { createPindieHost, type PindieHost } from "../src/host.ts";
import { DiscordRemote } from "../src/discord-remote.ts";
import { FileDiscordRemotePreferenceStore } from "../src/remote-preference.ts";

test("saved Discord OFF: real Pi headless MCP, Watch reads, Task and Session replacement work without Remote work or resource changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-discord-off-control-"));
  const project = join(root, "project"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  const globalBaseDir = join(root, "global"), remoteRoutingBaseDir = join(root, "routing");
  const previousEnv = { ...process.env };
  const originalStart = DiscordRemote.prototype.start;
  const originalEnsureProject = DiscordRemote.prototype.ensureProject;
  const originalEnsureSession = DiscordRemote.prototype.ensureSession;
  let discordCalls = 0;
  // Fail safely rather than ever connecting if startup gating regresses.
  DiscordRemote.prototype.start = async () => { discordCalls++; throw new Error("Discord must not start"); };
  DiscordRemote.prototype.ensureProject = async () => { discordCalls++; throw new Error("Discord must not create/sync channels"); };
  DiscordRemote.prototype.ensureSession = async () => { discordCalls++; throw new Error("Discord must not create/sync threads"); };
  let host: PindieHost | undefined;
  let interactiveRuns = 0;
  try {
    await Promise.all([project, agentDir, sessionDir, remoteRoutingBaseDir].map((path) => mkdir(path)));
    await new FileDiscordRemotePreferenceStore(globalBaseDir).saveDefault(false);
    Object.assign(process.env, { PINDIE_DISCORD_TOKEN: "synthetic-token", PINDIE_DISCORD_USER_ID: "123456789012345678", PINDIE_DISCORD_GUILD_ID: "987654321098765432", PINDIE_REMOTE_ENABLED: "true" });
    const old = SessionManager.create(project, sessionDir);
    old.appendMessage({ role: "user", content: "Synthetic existing Session", timestamp: Date.now() });
    old.appendMessage(fauxAssistantMessage("Synthetic existing reply") as never);
    const oldPath = old.getSessionFile()!;
    const oldBytes = await readFile(oldPath);
    const handle = await startControlMcpProcess({
      workspaceRoot: root, port: 0,
      createHost: async (options) => {
        host = await createPindieHost({ ...options, agentDir, sessionManager: SessionManager.inMemory(project),
          storageRoots: { globalBaseDir, remoteRoutingBaseDir, projectsBaseDir: join(root, "state") },
          env: { PINDIE_BROWSER_ENABLED: "false" },
          dependencies: { createInteractiveMode: () => ({ run: async () => { interactiveRuns++; } }) },
        });
        return host;
      },
    });
    const peer = new Client({ name: "isolated-discord-off", version: "1" });
    try {
      await peer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
      const opened = await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
      assert.equal(opened.isError, undefined);
      assert.ok(host);
      const session = host.runtime.activeSession;
      const tool = session.getToolDefinition("pindie_task_start");
      assert.ok(tool);
      await tool.execute("discord-off-task", { goal: "Isolated disabled Remote check", successCriteria: ["Control remains operational"] }, undefined, undefined, session.createReplacedSessionContext());
      const observed = await peer.callTool({ name: "pindie_observe", arguments: {} });
      assert.equal(observed.isError, undefined);
      const control = (observed.structuredContent as any).control;
      assert.equal(control.semantic.taskStatus, "active");
      for (const name of ["pindie_list_sessions", "pindie_read_timeline"]) {
        const result = await peer.callTool({ name, arguments: {} });
        assert.equal(result.isError, undefined, name);
      }
      const replaced = await peer.callTool({ name: "pindie_fresh_session", arguments: { lease: control.lease } });
      assert.equal(replaced.isError, undefined);
      assert.notEqual(host.runtime.activeSessionId, session.sessionId);
      assert.ok(host.runtime.activeSession.extensionRunner.getRegisteredCommands().some((command) => command.name === "discord-remote"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(discordCalls, 0);
      assert.equal(interactiveRuns, 0);
      assert.deepEqual(await readdir(remoteRoutingBaseDir), []);
      assert.deepEqual(await readFile(oldPath), oldBytes);
      assert.equal(new FileDiscordRemotePreferenceStore(globalBaseDir).loadDefault(), false);
    } finally { await peer.close(); await handle.close(); }
    assert.equal(discordCalls, 0);
  } finally {
    await host?.dispose();
    DiscordRemote.prototype.start = originalStart;
    DiscordRemote.prototype.ensureProject = originalEnsureProject;
    DiscordRemote.prototype.ensureSession = originalEnsureSession;
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(root, { recursive: true, force: true });
  }
});
