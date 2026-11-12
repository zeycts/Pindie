import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type { PindieControlInputResult, PindieControlSnapshot } from "../src/control-client.ts";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";
import { createPindieHost, type PindieHost } from "../src/host.ts";
import type { PindieState } from "../src/state.ts";
import { FileStateStore } from "../src/store.ts";
import type { UiTimelineBlock } from "../src/ui-projection.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function taskState(completed: boolean): PindieState {
  return { task: {
    goal: "Isolated P0 semantic fixture", constraints: [],
    successCriteria: [{ id: "c1", description: "Fixture evidence" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: completed
      ? [{ name: "fixture", status: "passed", covers: ["c1"], evidence: "fixture-only" }] : [] },
    humanGate: null, completed,
  } };
}

/** Real HTTP server, workspace, Host, Control client, adapter and pinned Pi loop.
 * Only provider responses and an extension agent_end barrier are controlled.
 * All storage/auth/preferences are fixture-local; no production port/provider.
 */
async function fixture(completed = false) {
  const root = await mkdtemp(join(tmpdir(), "pindie-mcp-p0-"));
  const workspaceRoot = join(root, "workspace");
  const project = join(workspaceRoot, "project");
  const agentDir = join(root, "agent");
  const storageRoots = {
    projectsBaseDir: join(root, "states"), globalBaseDir: join(root, "global"),
    remoteRoutingBaseDir: join(root, "routing"),
  };
  const endReached = barrier(), releaseEnd = barrier();
  const events: string[] = [];
  let host: PindieHost | undefined;
  let handle: Awaited<ReturnType<typeof startControlMcpProcess>> | undefined;
  const peer = new Client({ name: "p0-regression", version: "1" });
  const faux = fauxProvider({ provider: "p0-fixture" });
  try {
    await mkdir(project, { recursive: true });
    await mkdir(agentDir);
    await new FileStateStore({ baseDir: storageRoots.projectsBaseDir }).save(project, taskState(completed));
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    handle = await startControlMcpProcess({ workspaceRoot, port: 0,
      createHost: async (options) => {
        host = await createPindieHost({ ...options, agentDir, storageRoots,
          sessionManager: SessionManager.inMemory(options.cwd),
          featureSelection: { remote: false, workMemory: false, bundledSkills: false },
          env: { PINDIE_BROWSER_ENABLED: "false" },
          dependencies: {
            createAgentSessionServices: (input) => createAgentSessionServices({ ...input, modelRuntime,
              resourceLoaderOptions: { ...input.resourceLoaderOptions, extensionFactories: [
                ...input.resourceLoaderOptions?.extensionFactories ?? [],
                { name: "p0-end-barrier", factory: (pi) => {
                  pi.on("agent_end", async () => { endReached.release(); await releaseEnd.promise; });
                } },
              ] },
            }),
            createAgentSessionFromServices: (input) => createAgentSessionFromServices({ ...input, model: faux.getModel() }),
            createInteractiveMode: () => ({ run: async () => {} }),
          },
        });
        host.runtime.subscribeActiveSession((event) => { events.push(event.type); });
        return host;
      },
    });
    await peer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
  } catch (error) {
    releaseEnd.release(); await peer.close(); await handle?.close(); await host?.dispose();
    await rm(root, { recursive: true, force: true }); throw error;
  }
  const call = (name: string, args: Record<string, unknown> = {}) => peer.callTool({ name: `pindie_${name}`, arguments: args });
  const ok = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await call(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    // Both supported MCP representations must preserve the exact same facts.
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), result.structuredContent);
    return result.structuredContent as T;
  };
  const observe = async () => (await ok<{ control: PindieControlSnapshot }>("observe")).control;
  return { root, project, peer, faux, events, endReached, releaseEnd, call, ok, observe,
    open: async () => { await ok("open_project", { project: "project" }); return observe(); },
    close: async () => {
      releaseEnd.release();
      try { await peer.close(); } finally {
        try { await handle!.close(); } finally { await rm(root, { recursive: true, force: true }); }
      }
    },
  };
}

function durableMeaning(snapshot: PindieControlSnapshot) {
  // Run authority legitimately changes stale→coherent at native agent_start.
  const { authority: _authority, ...meaning } = snapshot.semantic;
  return meaning;
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description").map(([key, item]) => [key, withoutDescriptions(item)]));
  return value;
}

test("P0 HTTP: all 13 contracts reject invalid parameters and preserve no-project/stale-lease errors through real Control", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const { tools } = await f.peer.listTools();
    const baseline = JSON.parse(await readFile(new URL("./fixtures/control-mcp-api-v0.1.json", import.meta.url), "utf8"));
    const schemas = withoutDescriptions(tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations }))) as typeof baseline;
    assert.equal(tools.length, 13);
    // Explicitly account for the only additions to the frozen 13-tool API.
    const input = schemas.find((x: { name: string }) => x.name === "pindie_input").inputSchema;
    assert.deepEqual(input.properties.sessionName, { type: "string", minLength: 1, maxLength: 512 });
    const observe = schemas.find((x: { name: string }) => x.name === "pindie_observe").inputSchema;
    assert.deepEqual(observe.properties.view, { type: "string", enum: ["snapshot", "models", "efficiency"] });
    delete input.properties.sessionName; delete observe.properties.view;
    assert.deepEqual(schemas, baseline);

    const args: Record<string, Record<string, unknown>> = {
      observe: {}, input: { lease: "old", text: "work" },
      respond: { lease: "old", gateKey: "gate", response: "yes" }, stop: { lease: "old" },
      fresh_session: { lease: "old" }, configure: { lease: "old", thinkingLevel: "low" },
      list_projects: {}, open_project: { project: "project" }, create_project: { project: "project" },
      list_sessions: {}, switch_session: { lease: "old", sessionId: "missing" }, read_timeline: {},
      wait: { lease: "old", until: "settled", timeoutSeconds: 1 },
    };
    assert.deepEqual(Object.keys(args).map((x) => `pindie_${x}`).sort(), tools.map((x) => x.name).sort());
    for (const tool of tools) {
      const name = tool.name.slice("pindie_".length), valid = args[name]!;
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal((await f.call(name, { ...valid, unknown: true })).isError, true, `${name}: unknown field`);
      for (const required of tool.inputSchema.required ?? []) {
        const missing = { ...valid }; delete missing[required];
        assert.equal((await f.call(name, missing)).isError, true, `${name}: missing ${required}`);
      }
    }
    assert.equal((await f.ok<{ state: string }>("observe")).state, "no_active_project");
    assert.equal((await f.ok<{ activeProject: null }>("list_projects")).activeProject, null);
    for (const name of ["input", "respond", "stop", "fresh_session", "configure", "list_sessions", "switch_session", "read_timeline", "wait"]) {
      const result = await f.call(name, args[name]);
      assert.equal(result.isError, true); assert.equal(result.structuredContent?.code, "no_active_project");
    }
    for (const [name, data, code] of [
      ["open_project", { project: "missing" }, "project_not_found"],
      ["open_project", { project: "../escape" }, "invalid_project"],
      ["create_project", { project: "project" }, "project_exists"],
    ] as const) {
      const result = await f.call(name, data); assert.equal(result.isError, true); assert.equal(result.structuredContent?.code, code);
    }
    const before = await f.open();
    for (const name of ["input", "respond", "stop", "fresh_session", "configure", "switch_session", "wait"]) {
      const result = await f.call(name, args[name]);
      assert.equal(result.isError, true); assert.equal(result.structuredContent?.code, "stale_control_lease", name);
      assert.deepEqual(result.structuredContent?.snapshot, before);
      assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), result.structuredContent);
    }
    for (const [name, data] of [
      ["observe", { view: "quota" }], ["input", { text: "work", timing: "later" }],
      ["input", { text: "work", sessionName: "x".repeat(513) }],
      ["configure", { model: { provider: "p", modelId: "m", unknown: true } }],
      ["configure", { thinkingLevel: "automatic" }], ["list_sessions", { offset: -1 }],
      ["list_sessions", { limit: 51 }], ["read_timeline", { limit: 0 }],
      ["wait", { until: "settled", timeoutSeconds: 0 }], ["wait", { until: "settled", timeoutSeconds: 31 }],
      ["wait", { until: "settled", timeoutSeconds: 1.5 }], ["wait", { until: "settled", dispatchId: "not-supported" }],
    ] as const) {
      const leased = "lease" in (tools.find((tool) => tool.name === `pindie_${name}`)!.inputSchema.properties ?? {});
      assert.equal((await f.call(name, { ...(leased ? { lease: before.lease } : {}), ...data })).isError, true, `${name}: ${JSON.stringify(data)}`);
    }
    const invalid = await f.call("wait", { lease: before.lease, until: "meaningful_change" });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent?.code, "invalid_request");
    const mismatch = await f.call("respond", { lease: before.lease, gateKey: "absent", response: "yes" });
    assert.equal(mismatch.structuredContent?.code, "human_gate_mismatch");
    const unavailable = await f.call("configure", { lease: before.lease, model: { provider: "absent", modelId: "absent" } });
    assert.equal(unavailable.structuredContent?.code, "model_unavailable");
    const missing = await f.call("switch_session", { lease: before.lease, sessionId: "absent" });
    assert.equal(missing.structuredContent?.code, "session_not_found");
    assert.deepEqual((await f.observe()).dispatches, []);
    assert.deepEqual((await f.observe()).executionConfig, before.executionConfig);
    assert.equal(f.faux.state.callCount, 0); // Rejections never invoke even the local provider.
  } finally { await f.close(); }
});

for (const completed of [false, true]) {
  test(`P0 HTTP/native Pi: input→timeout→terminal→timeline with Task ${completed ? "done/passed" : "active/pending"}`, { timeout: 30_000 }, async () => {
    const f = await fixture(completed);
    const providerReady = barrier(), releaseProvider = barrier();
    try {
      const before = await f.open();
      assert.equal(before.semantic.taskStatus, completed ? "done" : "active");
      assert.equal(before.semantic.verificationStatus, completed ? "passed" : "pending");
      f.faux.setResponses([
        async () => { providerReady.release(); await releaseProvider.promise; return fauxAssistantMessage("P0 recorded output"); },
        fauxAssistantMessage("No further action requested"),
      ]);
      const receipt = await f.ok<PindieControlInputResult>("input", { lease: before.lease, text: "Read-only fixture work" });
      await providerReady.promise;
      const id = receipt.dispatch.dispatchId;
      assert.equal(receipt.delivery, "prompt");
      assert.equal(receipt.dispatch.acceptedRevision, before.revision);
      const running = await f.observe();
      const dispatch = running.dispatches.find((x) => x.dispatchId === id)!;
      assert.equal(dispatch.state, "running"); assert.ok(dispatch.runId);
      assert.deepEqual(dispatch.runIds, [dispatch.runId]);
      assert.equal(running.runtime.automaticWorkSettled, false);
      assert.deepEqual(durableMeaning(running), durableMeaning(before)); // Even done/passed cannot settle a live Run.
      const timeout = await f.ok<{ reason: string; snapshot: PindieControlSnapshot }>("wait", { lease: before.lease, until: "settled", timeoutSeconds: 1 });
      assert.equal(timeout.reason, "timeout");
      assert.equal(timeout.snapshot.dispatches.find((x) => x.dispatchId === id)!.state, "running");
      assert.equal(timeout.snapshot.runtime.automaticWorkSettled, false);
      assert.equal(f.faux.state.callCount, 1);

      releaseProvider.release(); await f.endReached.promise;
      const blockComplete = await f.observe();
      const output = blockComplete.dispatches.find((x) => x.dispatchId === id)!.output!;
      assert.equal(output.lifecycle, "complete"); assert.equal(output.entryIds.length, 1);
      assert.equal(blockComplete.dispatches.find((x) => x.dispatchId === id)!.state, "running");
      assert.equal(blockComplete.runtime.automaticWorkSettled, false);
      const stillRunning = await f.ok<{ reason: string; snapshot: PindieControlSnapshot }>("wait", { lease: before.lease, until: "settled", timeoutSeconds: 1 });
      assert.equal(stillRunning.reason, "timeout"); // A completed assistant block is not native settlement.
      assert.equal(stillRunning.snapshot.runtime.automaticWorkSettled, false);
      f.releaseEnd.release();
      const terminal = await f.ok<{ reason: string; snapshot: PindieControlSnapshot }>("wait", { lease: before.lease, until: "settled", timeoutSeconds: 5 });
      assert.equal(terminal.reason, "settled");
      assert.equal(terminal.snapshot.runtime.idle, true);
      assert.equal(terminal.snapshot.runtime.automaticWorkSettled, true);
      assert.equal(terminal.snapshot.runtime.pendingMessageCount, 0);
      const final = terminal.snapshot.dispatches.find((x) => x.dispatchId === id)!;
      assert.equal(final.state, "complete", JSON.stringify({ terminal, events: f.events })); assert.equal(final.runId, dispatch.runId);
      assert.deepEqual(final.runIds, dispatch.runIds);
      assert.deepEqual(final.output?.entryIds.slice(0, output.entryIds.length), output.entryIds);
      assert.equal(final.output?.lifecycle, "complete");
      assert.equal(final.output.entryIds.length, completed ? 1 : 2);
      assert.deepEqual(durableMeaning(terminal.snapshot), durableMeaning(before)); // Execution cannot complete/verify the durable Task.
      const timeline = await f.ok<{ sessionId: string; timeline: UiTimelineBlock[] }>("read_timeline", { limit: 50 });
      assert.equal(timeline.sessionId, terminal.snapshot.session.id);
      const echo = timeline.timeline.filter((b) => b.type === "message" && b.dispatchId === id);
      assert.equal(echo.length, 1); assert.equal(echo[0]!.id, id);
      for (const entryId of final.output!.entryIds) {
        const block = timeline.timeline.find((b) => b.id === entryId);
        assert.ok(block?.type === "message" && block.role === "assistant");
        assert.equal(block.lifecycle, "complete");
        assert.equal(block.text, entryId === output.entryIds[0] ? "P0 recorded output" : "No further action requested");
      }
      assert.equal(terminal.snapshot.latestAssistant?.entryId, final.output!.entryIds.at(-1));
      assert.equal(f.faux.state.callCount, completed ? 1 : 2); // Only native continuation adds a call; timeout retries never replay input.
      assert.deepEqual(f.events.filter((type) => ["agent_start", "agent_end", "agent_settled"].includes(type)),
        completed ? ["agent_start", "agent_end", "agent_settled"]
          : ["agent_start", "agent_end", "agent_start", "agent_end", "agent_settled"]);
      assert.equal(terminal.snapshot.dispatches.length, 1);
    } finally { releaseProvider.release(); await f.close(); }
  });
}

test("P0 HTTP/native Pi: acknowledged busy input is queued then shares the consuming Run and recorded outputs", { timeout: 30_000 }, async () => {
  const f = await fixture(); const ready = barrier(), release = barrier();
  try {
    const before = await f.open();
    f.faux.setResponses([
      async () => { ready.release(); await release.promise; return fauxAssistantMessage("Initial output"); },
      fauxAssistantMessage("Guidance output"),
      fauxAssistantMessage("No further action requested"),
    ]);
    const first = await f.ok<PindieControlInputResult>("input", { lease: before.lease, text: "Initial work" });
    await ready.promise;
    const queued = await f.ok<PindieControlInputResult>("input", { lease: before.lease, text: "Additional guidance" });
    assert.equal(queued.delivery, "steer"); assert.equal(queued.dispatch.state, "queued");
    assert.notEqual(queued.dispatch.dispatchId, first.dispatch.dispatchId);
    assert.equal(queued.snapshot.runtime.pendingMessageCount, 1);
    release.release(); await f.endReached.promise;
    const consumed = await f.observe();
    assert.equal(consumed.runtime.pendingMessageCount, 0);
    assert.deepEqual(consumed.dispatches.map((d) => d.state), ["running", "running"]);
    f.releaseEnd.release();
    const terminal = await f.ok<{ reason: string; snapshot: PindieControlSnapshot }>("wait", { lease: before.lease, until: "settled", timeoutSeconds: 5 });
    assert.equal(terminal.reason, "settled");
    const [a, b] = terminal.snapshot.dispatches;
    assert.ok(a && b); assert.equal(a.state, "complete", JSON.stringify({ terminal, events: f.events })); assert.equal(b.state, "complete", JSON.stringify(terminal));
    assert.equal(a.runId, b.runId); assert.deepEqual(a.runIds, b.runIds);
    assert.equal(a.output?.entryIds.length, 3); assert.deepEqual(a.output, b.output);
    const timeline = await f.ok<{ timeline: UiTimelineBlock[] }>("read_timeline", { limit: 50 });
    for (const id of [a.dispatchId, b.dispatchId, ...a.output!.entryIds]) assert.ok(timeline.timeline.some((block) => block.id === id), id);
    assert.equal(f.faux.state.callCount, 3); // Two consumed inputs plus the native continuation probe.
    assert.deepEqual(f.events.filter((type) => ["agent_start", "agent_end", "agent_settled"].includes(type)),
      ["agent_start", "agent_end", "agent_start", "agent_end", "agent_settled"]);
    assert.equal(terminal.snapshot.runtime.idle, true); assert.equal(terminal.snapshot.runtime.automaticWorkSettled, true);
    assert.equal(terminal.snapshot.semantic.taskStatus, "active"); assert.equal(terminal.snapshot.semantic.verificationStatus, "pending");
  } finally { release.release(); await f.close(); }
});
