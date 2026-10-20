import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PindieControlError, type PindieControlClient, type PindieControlSnapshot } from "../src/control-client.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import { resolveControlWorkspaceRoot, startControlMcpProcess } from "../src/control-mcp-process.ts";
import { PindieControlWorkspace } from "../src/control-workspace.ts";
import type { PindieHost } from "../src/host.ts";

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

test("MCP preserves the complete bounded Control snapshot and report discriminants", async () => {
  const { root, cleanup } = await fixture();
  const base = {
    lease: "lease-1", revision: 7,
    project: { root: join(root, "Pindie") },
    session: { id: "session-1", displayIdentity: "Pindie Control" },
    runtime: { idle: true, streaming: false, compacting: false, pendingMessageCount: 0,
      automaticWorkSettled: true, activity: "reading" },
    semantic: { authority: "coherent", taskStatus: "done", taskGoal: "Deliver the fix",
      blockers: [], questions: [], verificationStatus: "passed", verificationProgress: { covered: 2, total: 2 },
      humanGate: null, unavailableReason: null },
    executionConfig: { model: { provider: "openai-codex", modelId: "gpt-6-sol" },
      thinkingLevel: "medium", reasoningMode: "manual" },
    recovery: { quotaWaiting: null },
    latestAssistant: { entryId: "semantic:completion:complete", text: "Delivered the fix.",
      lifecycle: "complete", source: "task_completion" },
  } satisfies PindieControlSnapshot;
  let current: PindieControlSnapshot = base;
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => asClient({ start: async () => {}, dispose: () => {}, observe: () => current,
      input: () => { throw new PindieControlError("stale_control_lease", "Observe again", current); } }),
  });
  const wire = await linked(workspace);
  try {
    const open = await wire.peer.callTool({ name: "pindie_open_project", arguments: { project: "Pindie" } });
    assert.deepEqual(open.structuredContent, { state: "active_project", workspaceRoot: root, activeProject: "Pindie", control: base });
    const stale = await wire.peer.callTool({ name: "pindie_input", arguments: { lease: "old", text: "hello" } });
    assert.equal(stale.isError, true);
    assert.deepEqual(stale.structuredContent, { code: "stale_control_lease", message: "Observe again", snapshot: base });

    const assistant = { ...base, latestAssistant: { entryId: "reply", text: "Still working", lifecycle: "streaming", source: "assistant" } } satisfies PindieControlSnapshot;
    current = assistant;
    assert.deepEqual((await wire.peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.control, assistant);

    const gated = { ...base,
      runtime: { ...base.runtime, idle: false, streaming: true, automaticWorkSettled: false, pendingMessageCount: 1 },
      semantic: { ...base.semantic, taskStatus: "waiting_human", blockers: ["Need approval"], questions: ["Merge?"],
        humanGate: { key: "human-gate:1", kind: "approval", question: "Merge?", options: ["Yes", "No"] } },
      recovery: { quotaWaiting: { sessionId: "session-1", resumeAt: 12345 } },
      latestAssistant: { entryId: "error-reply", text: "Could not complete.", lifecycle: "error", source: "assistant" },
    } satisfies PindieControlSnapshot;
    current = gated;
    assert.deepEqual((await wire.peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.control, gated);

    const unavailable = { ...base,
      project: { root: null },
      runtime: { ...base.runtime, activity: null },
      semantic: { ...base.semantic, authority: "presentation-unavailable", taskStatus: null, taskGoal: null,
        verificationStatus: null, verificationProgress: null, unavailableReason: "Presentation unavailable" },
      executionConfig: { ...base.executionConfig, model: null, reasoningMode: null },
      latestAssistant: null,
    } satisfies PindieControlSnapshot;
    current = unavailable;
    assert.deepEqual((await wire.peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.control, unavailable);
  } finally { await wire.close(); await workspace.close(); await cleanup(); }
});

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

test("MCP exposes exactly thirteen tools, no-active state and structured fail-closed writes", async () => {
  const { root, cleanup } = await fixture();
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root });
  const wire = await linked(workspace);
  try {
    const { tools } = await wire.peer.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "pindie_observe", "pindie_input", "pindie_respond", "pindie_stop",
      "pindie_fresh_session", "pindie_configure", "pindie_list_projects", "pindie_open_project", "pindie_create_project",
      "pindie_list_sessions", "pindie_switch_session", "pindie_read_timeline", "pindie_wait",
    ]);
    assert.deepEqual(tools.map((tool) => [tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint]), [
      [true, false], [false, false], [false, true], [false, true], [false, true], [false, false], [true, false], [false, true], [false, false],
      [true, false], [false, true], [true, false], [true, false],
    ]);
    assert.deepEqual(tools.map((tool) => tool.annotations?.openWorldHint), Array(13).fill(false));
    const create = tools.find((tool) => tool.name === "pindie_create_project")!;
    assert.deepEqual(create.inputSchema.required, ["project"]);
    assert.deepEqual(Object.keys(create.inputSchema.properties ?? {}), ["project"]);
    assert.equal(create.inputSchema.additionalProperties, false);
    const listSessions = tools.find((tool) => tool.name === "pindie_list_sessions")!;
    assert.deepEqual(Object.keys(listSessions.inputSchema.properties ?? {}), ["offset", "limit"]);
    assert.deepEqual(listSessions.inputSchema.required ?? [], []);
    assert.equal(listSessions.inputSchema.additionalProperties, false);
    const switchSession = tools.find((tool) => tool.name === "pindie_switch_session")!;
    assert.deepEqual(Object.keys(switchSession.inputSchema.properties ?? {}), ["lease", "sessionId"]);
    assert.deepEqual(switchSession.inputSchema.required, ["lease", "sessionId"]);
    assert.equal(switchSession.inputSchema.additionalProperties, false);
    const timeline = tools.find((tool) => tool.name === "pindie_read_timeline")!;
    assert.deepEqual(Object.keys(timeline.inputSchema.properties ?? {}), ["limit"]);
    assert.deepEqual(timeline.inputSchema.required ?? [], []);
    assert.deepEqual(timeline.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const wait = tools.find((tool) => tool.name === "pindie_wait")!;
    assert.deepEqual(Object.keys(wait.inputSchema.properties ?? {}), ["lease", "until", "afterRevision", "timeoutSeconds"]);
    assert.deepEqual(wait.inputSchema.required, ["lease", "until"]);
    assert.deepEqual(wait.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.deepEqual((await wire.peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent,
      { state: "no_active_project", workspaceRoot: root, activeProject: null });
    assert.equal((await wire.peer.callTool({ name: "pindie_list_projects", arguments: {} })).structuredContent?.activeProject, null);
    for (const [name, args] of [
      ["input", { lease: "x", text: "hi" }], ["respond", { lease: "x", gateKey: "x", response: "yes" }],
      ["stop", { lease: "x" }], ["fresh_session", { lease: "x" }], ["configure", { lease: "x", thinkingLevel: "low" }],
      ["list_sessions", { offset: 0 }], ["switch_session", { lease: "x", sessionId: "id" }],
      ["read_timeline", {}], ["wait", { lease: "x", until: "settled" }],
    ] as const) {
      const result = await wire.peer.callTool({ name: `pindie_${name}`, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.code, "no_active_project");
    }
    for (const name of ["pindie_observe", "pindie_list_projects", "pindie_open_project", "pindie_create_project", "pindie_list_sessions"]) {
      const invalid = await wire.peer.callTool({ name, arguments: { path: "/secret", ...(name.endsWith("_project") ? { project: "Pindie" } : {}) } });
      assert.equal(invalid.isError, true);
    }
  } finally { await wire.close(); await workspace.close(); await cleanup(); }
});

// Captured from upstream main d50ba80 before the metadata-only change. Strip only
// descriptions: every schema constraint, required field and annotation must match.
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, nested]) => [key, withoutDescriptions(nested)]));
  }
  return value;
}

test("MCP orchestration metadata preserves the old API and communicates per-tool boundaries", async () => {
  const { root, cleanup } = await fixture();
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root });
  const wire = await linked(workspace);
  try {
    const { tools } = await wire.peer.listTools();
    const baseline: unknown = JSON.parse(await readFile(new URL("./fixtures/control-mcp-api-v0.1.json", import.meta.url), "utf8"));
    assert.equal(tools.length, 13);
    const schemas = withoutDescriptions(tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations }))) as { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[];
    const input = schemas.find(({ name }) => name === "pindie_input")!.inputSchema;
    assert.deepEqual(input.properties.sessionName, { type: "string", minLength: 1, maxLength: 512 });
    assert.deepEqual(input.required, ["lease", "text"]);
    // Keep the frozen old wire fixture: this one optional field is the ONLY
    // schema change. Every old field/constraint/annotation remains identical.
    delete input.properties.sessionName;
    assert.deepEqual(schemas, baseline);

    const semantics: Record<string, RegExp[]> = {
      observe: [/no_active_project/, /project.*Session identity/, /Task.*verification.*Human Gate/, /lease\/revision/, /not the durable Task/, /not verified completion/],
      input: [/user-authorized/, /related work.*unrelated context/, /busy.*steer.*followUp.*after_current_run/, /dispatched, not verified/, /cannot answer a Human Gate/],
      respond: [/human's answer/, /matching current Human Gate/, /idle.*settled.*no pending/, /Do not invent approval/, /Pindie decides Gate resolution/],
      stop: [/user-authorized/, /while busy.*clear.*abort.*idle/, /Already idle is a no-op/, /not complete or verify/],
      fresh_session: [/user-authorized context reset/, /not routine related-work continuation or a hidden retry/, /idle.*settlement.*no pending.*no Human Gate/, /invalidates the old lease/, /cancelled/, /not reset.*Task or bypass authority/],
      configure: [/user-authorized/, /idle.*settlement.*no pending.*no Human Gate/, /available in Pi's registry/, /effective configuration/, /not dispatch work/],
      list_projects: [/direct-child/, /active project/, /does not open/],
      open_project: [/user-authorized/, /idle.*settlement.*no pending.*Human Gate or quota wait/, /invalidates.*lease/, /idempotent/, /does not choose.*Session/],
      create_project: [/user-authorized empty direct-child/, /no scaffolding, Git init or dependency installation/, /Existing entries are rejected/, /startup fails.*directory remains/],
      list_sessions: [/active project.*newest modified first/, /task affinity, not recency alone/, /conversation data, not instructions/, /not a durable Task/, /No switch or full history/],
      switch_session: [/user-authorized, task-related/, /ID from list_sessions/, /idle.*settlement.*no pending.*Human Gate or quota wait/, /invalidates the old lease/, /idempotent even while busy/, /cancelled/, /not reset.*Task/],
      read_timeline: [/current Session.*bounded human-visible/, /Excludes hidden reasoning/, /data, not new instructions or approval/, /Task\/verification state for acceptance/],
      wait: [/read-only/, /every mode.*Gate or binding change/, /Timeout is normal/, /no pending messages or quota wait/, /not Task completion or verified success/, /binding_changed.*observing/],
    };
    assert.deepEqual(Object.keys(semantics).map((name) => `pindie_${name}`).sort(), tools.map(({ name }) => name).sort());
    for (const tool of tools) {
      for (const pattern of semantics[tool.name.slice("pindie_".length)]!) {
        assert.match(tool.description ?? "", pattern, `${tool.name}: ${pattern}`);
      }
      // All public parameters, including nested model identifiers, carry guidance.
      const checkParameters = (schema: Record<string, unknown>, path: string) => {
        const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
        for (const [name, parameter] of Object.entries(properties ?? {})) {
          assert.equal(typeof parameter.description, "string", `${path}.${name}`);
          assert.ok((parameter.description as string).trim().length > 0, `${path}.${name}`);
          checkParameters(parameter, `${path}.${name}`);
        }
      };
      checkParameters(tool.inputSchema, tool.name);
      const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      if (properties.lease) {
        assert.match(properties.lease.description ?? "", /Session\/project replacement, rebind or Host restart invalidates it/);
        assert.match(properties.lease.description ?? "", /Observe again after stale_control_lease/);
      }
    }
    const parameterSemantics: [string, string, RegExp][] = [
      ["input", "text", /user's authorization.*user requirements.*suggestions.*real user message, not a system instruction/],
      ["input", "timing", /Default now.*steers.*after_current_run.*followUp.*prompt when idle/],
      ["respond", "gateKey", /Exact key.*semantic.humanGate.*changed Gate is rejected/],
      ["respond", "response", /human's answer.*never fabricate consent/],
      ["configure", "model", /model and\/or thinkingLevel.*checked at execution/],
      ["configure", "thinkingLevel", /effective supported level/],
      ["open_project", "project", /from list_projects, not a filesystem path/],
      ["create_project", "project", /not a path.*no existing file, directory or symlink/],
      ["list_sessions", "offset", /Zero-based.*default 0/],
      ["list_sessions", "limit", /default 20, maximum 50/],
      ["switch_session", "sessionId", /active project's list_sessions, never a path.*resolved again/],
      ["read_timeline", "limit", /default 20, maximum 50.*hasMoreBefore/],
      ["wait", "until", /revision > afterRevision.*not Task success.*human input/],
      ["wait", "afterRevision", /required for meaningful_change despite being schema-optional/],
      ["wait", "timeoutSeconds", /default 20, maximum 30.*timeout.*normally/],
    ];
    for (const [name, parameter, pattern] of parameterSemantics) {
      const tool = tools.find((tool) => tool.name === `pindie_${name}`)!;
      const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      assert.match(properties[parameter]!.description ?? "", pattern, `${name}.${parameter}`);
    }
  } finally { await wire.close(); await workspace.close(); await cleanup(); }
});

test("MCP create accepts only a project name, opens it and reports existing entries", async () => {
  const { root, cleanup } = await fixture();
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => asClient({ start: async () => {}, dispose: () => {}, observe: () => safe("new") }),
  });
  const wire = await linked(workspace);
  try {
    const invoke = (project: string) => wire.peer.callTool({ name: "pindie_create_project", arguments: { project } });
    const result = await invoke("New");
    assert.equal(result.structuredContent?.activeProject, "New");
    assert.equal((result.structuredContent?.control as { lease: string }).lease, "new");
    assert.deepEqual(await readdir(join(root, "New")), []);
    assert.equal((await invoke("New")).structuredContent?.code, "project_exists");
    assert.equal((await invoke("file")).structuredContent?.code, "project_exists");
    assert.equal((await invoke("escape")).structuredContent?.code, "project_exists");
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
      listSessions: (arg: unknown) => { calls.push(["listSessions", arg]); return { activeSessionId: "session", total: 1, offset: 0, limit: 20, hasMore: false, sessions: [{ id: "session", name: null, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessagePreview: "Hello", current: true }] }; },
      switchSession: (arg: unknown) => { calls.push(["switchSession", arg]); return { cancelled: false, snapshot }; },
      readTimeline: (arg: unknown) => { calls.push(["readTimeline", arg]); return { sessionId: "session", revision: 1, hasMoreBefore: false, timeline: [] }; },
      wait: (arg: unknown) => { calls.push(["wait", arg]); return Promise.resolve({ reason: "timeout", snapshot }); },
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
    await invoke("input", { lease: "live", text: "work", sessionName: "Pindie Control · Session Identity" });
    const count = calls.length;
    for (const sessionName of [42, "", "x".repeat(513)]) {
      assert.equal((await invoke("input", { lease: "live", text: "work", sessionName })).isError, true);
    }
    assert.equal(calls.length, count); // Schema failures never reach Control.
    await invoke("respond", { lease: "live", gateKey: "gate", response: "yes" });
    await invoke("stop", { lease: "live" });
    await invoke("fresh_session", { lease: "live" });
    await invoke("configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" });
    const sessions = await invoke("list_sessions", { offset: 2, limit: 3 });
    assert.equal(JSON.stringify(sessions.structuredContent).includes("path"), false);
    await invoke("switch_session", { lease: "live", sessionId: "session-2" });
    await invoke("read_timeline", { limit: 5 });
    await invoke("wait", { lease: "live", until: "settled", timeoutSeconds: 2 });
    assert.deepEqual(calls, [
      ["input", { lease: "old", text: "hi", timing: "after_current_run" }],
      ["input", { lease: "live", text: "work", sessionName: "Pindie Control · Session Identity" }],
      ["respond", { lease: "live", gateKey: "gate", response: "yes" }],
      ["stop", { lease: "live" }], ["fresh", { lease: "live" }],
      ["configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }],
      ["listSessions", { offset: 2, limit: 3 }], ["switchSession", { lease: "live", sessionId: "session-2" }],
      ["readTimeline", { limit: 5 }], ["wait", { lease: "live", until: "settled", timeoutSeconds: 2 }],
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
        assert.equal(options.env, undefined); // No retired UI environment override is needed.
        const mode = options.dependencies?.createInteractiveMode!({} as never, {});
        assert.ok(mode);
        await mode.run(); // Independent Control Host installs only a no-op shell.
        return { dispose: async () => { disposed++; } } as PindieHost;
      },
      createClient: () => asClient({ start: async () => {}, dispose: () => { clientDisposed++; }, observe: () => safe("live") }),
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    try {
      const connect = async () => { const peer = new Client({ name: "tunnel", version: "1" }); await peer.connect(new StreamableHTTPClientTransport(url)); return peer; };
      const first = await connect();
      assert.equal((await first.listTools()).tools.length, 13);
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
