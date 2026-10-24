import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { MonitorControlError, PindieControlMonitorClient, resolvePindieControlMonitorEndpoint, verifyMonitorToolSurface, type MonitorAdvertisedTool, type MonitorSnapshot } from "../src/control-monitor-client.ts";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";
import { PindieControlError, type PindieControlClient, type PindieControlErrorCode } from "../src/control-client.ts";
import { PindieWorkspaceError } from "../src/control-workspace.ts";
import type { PindieHost } from "../src/host.ts";

const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const surfaces = [
  { name: "pindie_observe", properties: {}, required: [] },
  { name: "pindie_read_timeline", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, required: [] },
  { name: "pindie_wait", properties: { lease: { type: "string" }, until: { type: "string", enum: ["meaningful_change", "settled", "human_gate"] }, afterRevision: { type: "integer", minimum: 0 }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 } }, required: ["lease", "until"] },
].map((tool) => ({ ...tool, annotations, inputSchema: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false } })) as MonitorAdvertisedTool[];

test("monitor endpoint is always numeric-port loopback; arbitrary URL/remote host is rejected", () => {
  assert.equal(resolvePindieControlMonitorEndpoint().href, "http://127.0.0.1:8765/mcp");
  assert.equal(resolvePindieControlMonitorEndpoint("12345").href, "http://127.0.0.1:12345/mcp");
  for (const invalid of ["https://example.com/mcp", "localhost", "0", "65536", "12x"]) assert.throws(() => resolvePindieControlMonitorEndpoint(invalid));
});

test("required read-only tool surface fails closed for missing/incompatible annotations and schema", () => {
  verifyMonitorToolSurface(surfaces);
  assert.throws(() => verifyMonitorToolSurface(surfaces.slice(1)), /Incompatible Pindie Control service/);
  for (const [key, value] of [["readOnlyHint", false], ["destructiveHint", true], ["openWorldHint", true]] as const) {
    const tools = structuredClone(surfaces); tools[0]!.annotations![key] = value;
    assert.throws(() => verifyMonitorToolSurface(tools), /Incompatible Pindie Control service/);
  }
  const incompatible = structuredClone(surfaces); incompatible[1]!.inputSchema.properties = { limit: {}, extra: {} };
  assert.throws(() => verifyMonitorToolSurface(incompatible), /Incompatible Pindie Control service/);
});

test("monitor accepts old observation or exact optional read-only views, rejecting required or unknown additions", () => {
  const extended = structuredClone(surfaces);
  extended[0]!.inputSchema.properties = { view: { type: "string", enum: ["snapshot", "models"] } };
  verifyMonitorToolSurface(extended);
  extended[0]!.inputSchema.properties = { view: { type: "string", enum: ["snapshot", "models", "efficiency"] } };
  verifyMonitorToolSurface(extended);
  extended[0]!.inputSchema.required = ["view"];
  assert.throws(() => verifyMonitorToolSurface(extended), /Incompatible/);
  extended[0]!.inputSchema.required = [];
  for (const properties of [
    { view: { type: "string", enum: ["snapshot", "execute"] } },
    { view: { type: "string", enum: ["snapshot", "models", "efficiency", "execute"] } },
    { view: { type: "string", enum: ["snapshot", "efficiency"] } },
    { view: { type: "string", enum: ["snapshot", "models", "efficiency"] }, execute: {} },
    { view: { type: "string", enum: ["snapshot", "models"] }, execute: {} },
  ]) {
    extended[0]!.inputSchema.properties = properties;
    assert.throws(() => verifyMonitorToolSurface(extended), /Incompatible/);
  }
});

test("pinned Streamable HTTP monitor adapter verifies 13-tool service and decodes only the read-only projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-monitor-client-"));
  const project = join(root, "Modeloom"); await mkdir(project);
  const snapshot: MonitorSnapshot = {
    lease: "lease-1", revision: 4, session: { id: "session-1", displayIdentity: "Learning Loop" },
    runtime: { idle: false, pendingMessageCount: 1, automaticWorkSettled: false },
    semantic: { taskStatus: "active", verificationStatus: "pending", verificationProgress: { covered: 1, total: 2 }, humanGate: null },
    executionConfig: { model: { modelId: "gpt-test" }, thinkingLevel: "high" },
  };
  let current: unknown = snapshot;
  let badTimeline = false;
  let displayBlock: unknown = null;
  let toolError: Error | null = null;
  const fakeControl = {
    start: async () => {}, dispose: () => {}, observe: () => current,
    readTimeline: () => { if (toolError) throw toolError; return badTimeline ? { sessionId: 7, revision: "bad", hasMoreBefore: false, timeline: [] } : {
      sessionId: "session-1", revision: 4, hasMoreBefore: false,
      timeline: [displayBlock ?? { type: "runtime", id: "r1", category: "generic", title: "Observed", detail: "safe value", defaultDisplayMode: "preview" }],
    }; },
    wait: async () => { if (toolError) throw toolError; return { reason: "changed", snapshot }; },
  } as unknown as PindieControlClient;
  const processHandle = await startControlMcpProcess({ workspaceRoot: root, port: 0,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => fakeControl,
  });
  const oldPort = process.env.PINDIE_CONTROL_PORT;
  process.env.PINDIE_CONTROL_PORT = String(processHandle.port);
  let monitor: PindieControlMonitorClient | undefined;
  const peer = new Client({ name: "test-control-monitor", version: "1" });
  try {
    monitor = await PindieControlMonitorClient.connect();
    await peer.connect(new (await import("@modelcontextprotocol/client")).StreamableHTTPClientTransport(resolvePindieControlMonitorEndpoint()));
    const { tools } = await peer.listTools();
    assert.equal(tools.length, 13);
    assert.deepEqual((await monitor.observe()), { state: "no_active_project", activeProject: null });
    await peer.callTool({ name: "pindie_open_project", arguments: { project: "Modeloom" } });
    current = snapshot;
    const attached = await monitor.observe();
    assert.equal(attached.state, "active_project");
    if (attached.state === "active_project") {
      assert.equal(attached.control.lease, "lease-1");
      assert.equal(attached.control.semantic.authority, undefined); // old server: unknown, not coherent
    }
    for (const authority of ["coherent", "stale", "unavailable", "presentation-unavailable", "unexpected"]) {
      current = { ...snapshot, semantic: { ...snapshot.semantic, authority } };
      const observed = await monitor.observe();
      assert.equal(observed.state, "active_project");
      if (observed.state === "active_project") assert.equal(observed.control.semantic.authority, authority === "unexpected" ? undefined : authority);
    }
    for (const taskGoal of [undefined, null, "Concise authoritative goal", 42, "x".repeat(50_001)]) {
      current = { ...snapshot, semantic: { ...snapshot.semantic, taskGoal } };
      const observed = await monitor.observe();
      assert.equal(observed.state, "active_project");
      if (observed.state === "active_project") {
        assert.equal(observed.control.semantic.taskGoal, taskGoal === null || (typeof taskGoal === "string" && taskGoal.length <= 50_000) ? taskGoal : undefined);
      }
    }
    current = snapshot;
    const timeline = await monitor.readTimeline(50);
    assert.equal(timeline.timeline.length, 1);
    assert.equal(timeline.timeline[0]?.type, "runtime");
    displayBlock = { type: "work", kind: "observation", id: "r", title: "Reading", lifecycle: "complete", defaultDisplayMode: "compact", items: [
      { toolCallId: "r", toolName: "read", label: "Reading a", input: { path: "a", offset: 2, secret: "discard" }, lifecycle: "complete", result: { isError: false, summary: "safe", textContent: "safe", details: null } },
    ] };
    const read = (await monitor.readTimeline()).timeline[0]!;
    assert.equal(read.type, "work");
    if (read.type === "work" && read.kind === "observation") {
      assert.deepEqual(read.items[0]!.input, { path: "a", offset: 2 });
      assert.equal(read.items[0]!.result?.textContent, "safe");
    } else assert.fail("Expected read projection");
    (displayBlock as any).items[0].input = { path: "a", offset: -1 };
    (displayBlock as any).items[0].result.textContent = "not the summary";
    const invalid = (await monitor.readTimeline()).timeline[0]!;
    if (invalid.type === "work" && invalid.kind === "observation") {
      assert.equal(invalid.items[0]!.input, null);
      assert.equal(invalid.items[0]!.result?.textContent, undefined);
    } else assert.fail("Expected fallback data");
    const waitRequest = { lease: "lease-1", until: "meaningful_change" as const, afterRevision: 4, timeoutSeconds: 2 };
    assert.equal((await monitor.wait(waitRequest)).reason, "changed");
    toolError = new PindieControlError("stale_control_lease", "Observe again");
    await assert.rejects(monitor.wait(waitRequest), (error: unknown) => error instanceof MonitorControlError && error.code === "stale_control_lease");
    toolError = new PindieWorkspaceError("no_active_project", "No project");
    await assert.rejects(monitor.readTimeline(), (error: unknown) => error instanceof MonitorControlError && error.code === "no_active_project");
    toolError = new PindieControlError("unexpected_code" as PindieControlErrorCode, "Unknown");
    await assert.rejects(monitor.wait(waitRequest), /Incompatible Pindie Control service/);
    toolError = new PindieControlError("stale_control_lease", "");
    await assert.rejects(monitor.wait(waitRequest), /Incompatible Pindie Control service/);
    toolError = new Error("unstructured failure");
    await assert.rejects(monitor.wait(waitRequest), /Incompatible Pindie Control service/);
    toolError = null;
    assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(monitor)).sort(), ["close", "constructor", "observe", "readTimeline", "wait"]);
    current = { lease: "x" };
    await assert.rejects(monitor.observe(), /Incompatible Pindie Control service/);
    current = { state: "active_project", activeProject: "Modeloom", control: snapshot };
    badTimeline = true;
    await assert.rejects(monitor.readTimeline(50), /Incompatible Pindie Control service/);
    const closed = monitor;
    await monitor.close(); monitor = undefined;
    await assert.rejects(closed.observe(), /closed/);
  } finally {
    await monitor?.close();
    await peer.close();
    if (oldPort === undefined) delete process.env.PINDIE_CONTROL_PORT; else process.env.PINDIE_CONTROL_PORT = oldPort;
    await processHandle.close(); await rm(root, { recursive: true, force: true });
  }
});
