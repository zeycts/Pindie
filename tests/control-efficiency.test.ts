import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type AgentSessionRuntime, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { PindieControlClient } from "../src/control-client.ts";
import { PindieControlWorkspace } from "../src/control-workspace.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import { projectControlEfficiency } from "../src/control-efficiency.ts";
import type { PindieHost } from "../src/host.ts";

const usage = { input: 10, output: 2, cacheRead: 30, cacheWrite: 10,
  get cost() { assert.fail("must not read native catalog cost"); } };
const entry = (type: string, value: unknown = usage): SessionEntry => ({ type,
  ...(type === "message" ? { message: { role: "assistant", usage: value,
    get content() { assert.fail("must not read content"); } } } : { usage: value }),
}) as unknown as SessionEntry;

test("fixed efficiency projection includes all Pi usage sources, latest branch only and no secrets/prices", () => {
  const entries = [entry("message"), entry("usage"), entry("compaction"), entry("branch_summary"),
    { type: "message", message: { role: "toolResult", usage } } as unknown as SessionEntry];
  const snapshot = projectControlEfficiency({ sessionId: "id", entries, branch: [entries[0]!],
    context: { tokens: 60, contextWindow: 100, percent: 60 } });
  assert.deepEqual(snapshot.sessionUsage, { input: 50, output: 10, cacheRead: 150, cacheWrite: 50 });
  assert.deepEqual(snapshot.latestRequest, { input: 10, output: 2, cacheRead: 30, cacheWrite: 10 });
  assert.equal(snapshot.latestCacheHitPercent, 60);
  assert.deepEqual(snapshot.context, { tokens: 60, windowTokens: 100, percent: 60 });
  assert.equal(snapshot.cost, null);
  assert.ok(!JSON.stringify(snapshot).includes("content"));
});

test("unknown counters stay null, latest absent usage never falls back, zero is valid and context may be unknown", () => {
  const project = (entries: SessionEntry[]) => projectControlEfficiency({ sessionId: "id", entries, branch: entries,
    context: { tokens: null, contextWindow: 100, percent: null } });
  assert.equal(project([]).sessionUsage, null);
  const partial = project([entry("message"), entry("message", { input: 0, output: NaN, cacheRead: -1 })]);
  assert.deepEqual(partial.sessionUsage, { input: 10, output: null, cacheRead: null, cacheWrite: null });
  assert.equal(partial.latestCacheHitPercent, null);
  assert.deepEqual(partial.context, { tokens: null, windowTokens: 100, percent: null });
  const absent = project([entry("message"), entry("message", null)]);
  assert.deepEqual(absent.latestRequest, { input: null, output: null, cacheRead: null, cacheWrite: null });
  const zeros = project([entry("message", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })]);
  assert.equal(zeros.latestRequest?.input, 0);
  assert.equal(zeros.latestCacheHitPercent, null);
  const overflow = project([entry("message", { input: Number.MAX_VALUE }), entry("message", { input: Number.MAX_VALUE })]);
  assert.equal(overflow.sessionUsage?.input, null);
});

test("runtime reads only active in-memory Session; replacement is fresh and no model/credentials/history operations occur", () => {
  // Real native manager, no files, model runtime or Agent loop. Fixtures are not cost-saving evidence.
  const manager = SessionManager.inMemory();
  const session = (id: string) => ({ sessionId: id, sessionManager: manager,
    getContextUsage: () => undefined,
    get modelRuntime() { assert.fail("no model runtime"); },
    get model() { assert.fail("no model catalog"); },
    get sessionFile() { assert.fail("no path"); },
  });
  const native = { session: session("one") };
  const adapter = new PiRuntimeAdapter(native as unknown as AgentSessionRuntime);
  assert.equal(adapter.getActiveSessionEfficiency().sessionUsage, null);
  assert.equal(adapter.getActiveSessionEfficiency().context, null);
  native.session = session("two");
  assert.equal(adapter.getActiveSessionEfficiency().sessionId, "two");
});

test("Control efficiency requires binding, returns only existing duration scope, isolates unavailable presentation", () => {
  for (const scope of ["run", "task", "unavailable", "throws"] as const) {
    const result = PindieControlClient.prototype.readEfficiency.call({
      requireActiveBinding: () => ({}),
      runtime: { getActiveSessionEfficiency: () => ({ sessionId: "id" }) },
      presentation: { current: () => scope === "unavailable" ? null : { snapshot: () => {
        if (scope === "throws") throw new Error("secret native path");
        return { status: { consumption: { scope, durationMs: 123, get cost() { assert.fail("no cost"); } } } };
      } } },
    } as unknown as PindieControlClient);
    assert.deepEqual(result.duration, scope === "unavailable" || scope === "throws" ? null :
      { scope: scope === "run" ? "run_current_or_latest" : "task", durationMs: 123 });
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
  assert.throws(() => PindieControlClient.prototype.readEfficiency.call({
    requireActiveBinding: () => { throw new Error("unbound"); },
    get runtime() { assert.fail("must check binding first"); },
  } as unknown as PindieControlClient), /unbound/);
});

test("MCP efficiency stays optional, project-scoped, read-only and does not affect snapshot/models/13 tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-efficiency-"));
  await mkdir(join(root, "project"));
  let reads = 0;
  const efficiency = { sessionId: "id", cost: null };
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => ({ start: async () => {}, dispose: () => {}, observe: () => ({ lease: "live" }),
      readEfficiency: () => { reads++; return efficiency; }, listModels: () => ({ models: [] }),
      configure: () => assert.fail("must not configure"), input: () => assert.fail("must not prompt"),
    }) as unknown as PindieControlClient,
  });
  const server = createPindieControlMcpServer(workspace);
  const peer = new Client({ name: "efficiency-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await peer.connect(right);
    const noProject = await peer.callTool({ name: "pindie_observe", arguments: { view: "efficiency" } });
    assert.equal(noProject.structuredContent?.code, "no_active_project");
    assert.equal(reads, 0);
    await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    const normal = await peer.callTool({ name: "pindie_observe", arguments: {} });
    const explicit = await peer.callTool({ name: "pindie_observe", arguments: { view: "snapshot" } });
    assert.deepEqual(normal.structuredContent, explicit.structuredContent);
    assert.equal(reads, 0);
    const result = await peer.callTool({ name: "pindie_observe", arguments: { view: "efficiency" } });
    assert.deepEqual(result.structuredContent, efficiency);
    assert.equal(reads, 1);
    const tools = (await peer.listTools()).tools;
    assert.equal(tools.length, 13);
    assert.deepEqual(tools.find((tool) => tool.name === "pindie_observe")?.annotations,
      { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.equal((await peer.callTool({ name: "pindie_observe", arguments: { view: "efficiency", lease: "extra" } })).isError, true);
  } finally { await peer.close(); await server.close(); await workspace.close(); await rm(root, { recursive: true }); }
});
