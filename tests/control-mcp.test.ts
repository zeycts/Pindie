import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PindieControlError, type PindieControlClient, type PindieControlSnapshot } from "../src/control-client.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import { resolveControlWorkspaceRoot, startControlMcpProcess } from "../src/control-mcp-process.ts";
import { PindieControlWorkspace } from "../src/control-workspace.ts";
import { isPindieTuiEnabled, type PindieHost } from "../src/host.ts";

const asClient = (value: object) => value as PindieControlClient;
const safe = (lease: string, overrides: object = {}) => ({
  lease, revision: 1, runtime: { idle: true, automaticWorkSettled: true, pendingMessageCount: 0 },
  semantic: { humanGate: null }, recovery: { quotaWaiting: null }, ...overrides,
}) as PindieControlSnapshot;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pindie-workspace-"));
  await mkdir(join(root, "Pindie"));
  await mkdir(join(root, "Modeloom"));
  await mkdir(join(root, "Pindie", "nested"));
  await writeFile(join(root, "file"), "x");
  const external = await mkdtemp(join(tmpdir(), "pindie-external-"));
  await symlink(external, join(root, "escape"));
  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(external, { recursive: true, force: true }); } };
}
async function linked(workspace: PindieControlWorkspace) {
  const server = createPindieControlMcpServer(workspace);
  const peer = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await peer.connect(right);
  return { peer, close: async () => { await peer.close(); await server.close(); } };
}

test("bounded deterministic direct-child discovery and name validation", async () => {
  await assert.rejects(resolveControlWorkspaceRoot(undefined), /PINDIE_WORKSPACE_ROOT/);
  const { root, cleanup } = await fixture();
  try {
    await assert.rejects(resolveControlWorkspaceRoot(join(root, "file")), /directory/);
    const workspace = await PindieControlWorkspace.create({ workspaceRoot: root });
    assert.deepEqual((await workspace.listProjects()).projects, [
      { name: "Modeloom", active: false }, { name: "Pindie", active: false },
    ]);
    for (const name of [".", "..", "../Pindie", "/tmp", "Pindie/nested", "Pindie\\nested", "escape", "file"]) {
      await assert.rejects(workspace.openProject(name), (error: { code: string }) => ["invalid_project", "project_not_found"].includes(error.code));
    }
    await assert.rejects(workspace.openProject("missing"), (error: { code: string }) => error.code === "project_not_found");
    await workspace.close();
  } finally { await cleanup(); }
});

test("MCP exposes exactly eight tools, no-active state and structured fail-closed writes", async () => {
  const { root, cleanup } = await fixture();
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root });
  const wire = await linked(workspace);
  try {
    const { tools } = await wire.peer.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "pindie_observe", "pindie_input", "pindie_respond", "pindie_stop",
      "pindie_fresh_session", "pindie_configure", "pindie_list_projects", "pindie_open_project",
    ]);
    assert.deepEqual(tools.map((tool) => [tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint]), [
      [true, false], [false, false], [false, true], [false, true], [false, true], [false, false], [true, false], [false, true],
    ]);
    assert.deepEqual((await wire.peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent,
      { state: "no_active_project", workspaceRoot: root, activeProject: null });
    assert.equal((await wire.peer.callTool({ name: "pindie_list_projects", arguments: {} })).structuredContent?.activeProject, null);
    for (const [name, args] of [
      ["input", { lease: "x", text: "hi" }], ["respond", { lease: "x", gateKey: "x", response: "yes" }],
      ["stop", { lease: "x" }], ["fresh_session", { lease: "x" }], ["configure", { lease: "x", thinkingLevel: "low" }],
    ] as const) {
      const result = await wire.peer.callTool({ name: `pindie_${name}`, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, "no_active_project");
    }
    for (const name of ["pindie_observe", "pindie_list_projects", "pindie_open_project"]) {
      const invalid = await wire.peer.callTool({ name, arguments: { path: "/secret", ...(name === "pindie_open_project" ? { project: "Pindie" } : {}) } });
      assert.equal(invalid.isError, true);
    }
  } finally { await wire.close(); await workspace.close(); await cleanup(); }
});

test("MCP delegates six scoped operations after open; stale lease remains structured", async () => {
  const { root, cleanup } = await fixture();
  const calls: unknown[] = [];
  const snapshot = safe("current");
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => asClient({
      start: async () => {}, dispose: () => {}, observe: () => snapshot,
      input: (arg: unknown) => { calls.push(["input", arg]); throw new PindieControlError("stale_control_lease", "Observe again", snapshot); },
      respond: (arg: unknown) => { calls.push(["respond", arg]); return { delivery: "prompt", snapshot }; },
      stop: (arg: unknown) => { calls.push(["stop", arg]); return { stopped: true, snapshot }; },
      freshSession: (arg: unknown) => { calls.push(["fresh", arg]); return { cancelled: false, snapshot }; },
      configure: (arg: unknown) => { calls.push(["configure", arg]); return snapshot; },
    }),
  });
  const wire = await linked(workspace);
  try {
    const invoke = (name: string, args: object) => wire.peer.callTool({ name: `pindie_${name}`, arguments: args });
    const opened = await invoke("open_project", { project: "Pindie" });
    assert.equal(opened.structuredContent?.state, "active_project");
    assert.equal((opened.structuredContent?.control as { lease: string }).lease, "current");
    assert.equal((await invoke("observe", {})).structuredContent?.activeProject, "Pindie");
    const stale = await invoke("input", { lease: "old", text: "hi", timing: "after_current_run" });
    assert.deepEqual(stale.structuredContent, { code: "stale_control_lease", message: "Observe again", snapshot });
    await invoke("respond", { lease: "live", gateKey: "gate", response: "yes" });
    await invoke("stop", { lease: "live" });
    await invoke("fresh_session", { lease: "live" });
    await invoke("configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" });
    assert.deepEqual(calls, [
      ["input", { lease: "old", text: "hi", timing: "after_current_run" }],
      ["respond", { lease: "live", gateKey: "gate", response: "yes" }],
      ["stop", { lease: "live" }], ["fresh", { lease: "live" }],
      ["configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }],
    ]);
  } finally { await wire.close(); await workspace.close(); await cleanup(); }
});

test("loopback boots without Host or TUI; disconnect keeps Host; shutdown disposes once", async () => {
  const { root, cleanup } = await fixture();
  const oldTui = process.env.PINDIE_TUI;
  process.env.PINDIE_TUI = "1";
  let created = 0, disposed = 0, clientDisposed = 0;
  try {
    const handle = await startControlMcpProcess({ workspaceRoot: root, port: 0,
      createHost: async (options) => {
        created++;
        assert.equal(options.cwd, join(root, "Pindie"));
        assert.equal(isPindieTuiEnabled(options.env!), false);
        assert.ok(options.dependencies?.createInteractiveMode);
        return { dispose: async () => { disposed++; } } as PindieHost;
      },
      createClient: () => asClient({ start: async () => {}, dispose: () => { clientDisposed++; }, observe: () => safe("live") }),
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    try {
      const connect = async () => { const peer = new Client({ name: "tunnel", version: "1" }); await peer.connect(new StreamableHTTPClientTransport(url)); return peer; };
      const first = await connect();
      assert.equal((await first.listTools()).tools.length, 8);
      assert.equal((await first.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.state, "no_active_project");
      assert.equal(created, 0);
      await first.callTool({ name: "pindie_open_project", arguments: { project: "Pindie" } });
      await first.close();
      const second = await connect();
      assert.equal((await second.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.activeProject, "Pindie");
      await second.close();
      assert.deepEqual([created, disposed], [1, 0]);
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        const req = request(url, { method: "POST", headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("error", reject); req.end();
      });
      assert.equal(rebindingStatus, 403);
      assert.equal((await fetch(url, { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
    } finally { await handle.close(); await handle.close(); }
    assert.deepEqual([created, disposed, clientDisposed], [1, 1, 1]);
  } finally {
    if (oldTui === undefined) delete process.env.PINDIE_TUI; else process.env.PINDIE_TUI = oldTui;
    await cleanup();
  }
});
