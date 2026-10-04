import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { PindieControlClient, PindieControlError } from "../src/control-client.ts";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";
import { createPindieHost, type PindieHost } from "../src/host.ts";

test("real pinned Pi headless Control bootstrap binds extensions and restores semantic state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-control-bind-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(project);
  await mkdir(agentDir);
  let host: PindieHost | undefined;
  let interactiveRuns = 0;
  try {
    const handle = await startControlMcpProcess({
      workspaceRoot: root,
      port: 0,
      createHost: async (options) => {
        host = await createPindieHost({
          ...options,
          agentDir,
          sessionManager: SessionManager.inMemory(project),
          env: { ...options.env, PINDIE_BROWSER_ENABLED: "false" },
          dependencies: {
            createInteractiveMode: () => ({ run: async () => { interactiveRuns++; } }),
          },
        });
        return host;
      },
    });
    try {
      assert.equal(host, undefined);
      const peer = new Client({ name: "headless-regression", version: "1" });
      await peer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
      const before = await peer.callTool({ name: "pindie_observe", arguments: {} });
      assert.equal(before.structuredContent?.state, "no_active_project");
      const opened = await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
      assert.equal(opened.isError, undefined);
      assert.ok(host);
      // The actual MCP process starts Control only after Pi's public bindExtensions
      // completes; an independent client here would overwrite its lifecycle slot.
      const snapshot = host.presentation.current()?.snapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.projectRoot, project);
      assert.ok(snapshot.status.state);
      assert.equal(snapshot.status.stateUnavailableReason, null);
      try {
        const observed = await peer.callTool({ name: "pindie_observe", arguments: {} });
        assert.equal(observed.isError, undefined);
        const control = (observed.structuredContent as { control: { project: { root: string }; semantic: { authority: string } } }).control;
        assert.equal(control.project.root, project);
        assert.notEqual(control.semantic.authority, "unavailable");
      } finally {
        await peer.close();
      }
      assert.equal(interactiveRuns, 0);
    } finally {
      await handle.close();
    }
  } finally {
    await host?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real pinned Pi Session navigation lists and switches native persisted Sessions within one Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-control-session-switch-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(project);
  await mkdir(agentDir);
  await mkdir(sessionDir);
  let host: PindieHost | undefined;
  let control: PindieControlClient | undefined;
  try {
    const managerA = SessionManager.create(project, sessionDir);
    managerA.appendMessage({ role: "user", content: [{ type: "text", text: "Session A" }], timestamp: Date.now() } as never);
    managerA.appendMessage(fauxAssistantMessage("Persisted Session A") as never);
    const managerB = SessionManager.create(project, sessionDir);
    managerB.appendMessage({ role: "user", content: [{ type: "text", text: "Session B" }], timestamp: Date.now() } as never);
    managerB.appendMessage(fauxAssistantMessage("Persisted Session B") as never);
    const sessionBId = managerB.getSessionId();
    const sessionBPath = managerB.getSessionFile();

    host = await createPindieHost({
      cwd: project,
      agentDir,
      sessionManager: managerA,
      env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_TUI: "0" },
      dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
    });
    const boundSessions: string[] = [];
    control = new PindieControlClient(host.runtime, host.presentation, {
      bindActiveSession: async () => {
        const id = host!.runtime.activeSessionId;
        await host!.runtime.bindActiveSessionExtensions({ mode: "print" });
        boundSessions.push(id);
      },
    });
    await control.start();
    const before = control.observe();
    assert.equal(before.project.root, project);
    assert.equal(before.session.id, managerA.getSessionId());
    const page = await control.listSessions();
    assert.equal(page.activeSessionId, before.session.id);
    assert.equal(page.total >= 2, true);
    assert.ok(page.sessions.some((choice) => choice.id === before.session.id && choice.current));
    assert.ok(page.sessions.some((choice) => choice.id === sessionBId && !choice.current));
    assert.equal(JSON.stringify(page).includes(sessionBPath), false);

    const switched = await control.switchSession({ lease: before.lease, sessionId: sessionBId });
    assert.equal(switched.cancelled, false);
    assert.equal(switched.snapshot.session.id, sessionBId);
    assert.notEqual(switched.snapshot.lease, before.lease);
    assert.equal(switched.snapshot.project.root, project);
    assert.notEqual(switched.snapshot.semantic.authority, "unavailable");
    assert.deepEqual(boundSessions, [before.session.id, sessionBId]);
    await assert.rejects(control.input({ lease: before.lease, text: "old lease" }),
      (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
  } finally {
    control?.dispose();
    await host?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real pinned Pi Session events reach the live timeline and replacement releases a waiter", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-control-live-events-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(project);
  await mkdir(agentDir);
  let host: PindieHost | undefined;
  let control: PindieControlClient | undefined;
  try {
    host = await createPindieHost({
      cwd: project, agentDir, sessionManager: SessionManager.inMemory(project),
      env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_TUI: "0" },
      dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
    });
    control = new PindieControlClient(host.runtime, host.presentation, {
      bindActiveSession: () => host!.runtime.bindActiveSessionExtensions({ mode: "print" }),
    });
    await control.start();
    const before = control.observe();
    const changed = control.wait({ lease: before.lease, until: "meaningful_change", afterRevision: before.revision, timeoutSeconds: 5 });
    await host.runtime.steer("queued lifecycle observation");
    assert.equal((await changed).reason, "changed");
    const timeline = control.readTimeline();
    assert.equal(timeline.sessionId, before.session.id);
    assert.equal(timeline.timeline.some((block) => block.type === "message" && block.text.includes("queued lifecycle observation")), false);
    host.runtime.clearActiveSessionQueue();
    const pending = control.wait({ lease: before.lease, until: "human_gate", timeoutSeconds: 30 });
    const replacement = await control.freshSession({ lease: before.lease });
    assert.notEqual(replacement.snapshot.session.id, before.session.id);
    assert.equal((await pending).reason, "binding_changed");
  } finally {
    control?.dispose();
    await host?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 1.0.2 real Control prompt disposition, observe/timeline/wait and replacement remain coherent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-control-pi099-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(project);
  await mkdir(agentDir);
  const faux = fauxProvider({ provider: `control-pi099-${Date.now()}` });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  let host: PindieHost | undefined;
  let control: PindieControlClient | undefined;
  try {
    host = await createPindieHost({ cwd: project, agentDir, sessionManager: SessionManager.inMemory(project),
      env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_TUI: "0" },
      dependencies: {
        createAgentSessionServices: (options) => createAgentSessionServices({
          ...options, modelRuntime,
          resourceLoaderOptions: {
            ...options.resourceLoaderOptions,
            extensionFactories: [
              ...options.resourceLoaderOptions?.extensionFactories ?? [],
              { name: "compatibility-input", factory: (pi) => {
                pi.on("input", (event) => event.text.startsWith("consume:") ? { action: "handled" } : undefined);
              } },
            ],
          },
        }),
        createAgentSessionFromServices: (options) => createAgentSessionFromServices({ ...options, model: faux.getModel() }),
        createInteractiveMode: () => ({ run: async () => {} }),
      },
    });
    control = new PindieControlClient(host.runtime, host.presentation, {
      bindActiveSession: () => host!.runtime.bindActiveSessionExtensions({ mode: "print" }),
    });
    await control.start();
    const before = control.observe();
    const allNames = host.runtime.activeSession.getAllTools().map((tool) => tool.name);
    assert.equal(allNames.includes("codemode"), false);
    assert.equal(allNames.includes("tool_search"), false);
    assert.equal(allNames.some((name) => name.startsWith("mcp__")), false);
    assert.equal(host.runtime.activeSession.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"), false);
    assert.equal(host.runtime.activeSession.resourceLoader.getExtensions().extensions.some((extension) => extension.path.startsWith("builtin:")), false);
    await assert.rejects(control.input({ lease: before.lease, text: "consume:idle" }),
      (error: unknown) => error instanceof PindieControlError && error.code === "delivery_failed");
    assert.equal(control.observe().runtime.automaticWorkSettled, true);
    assert.equal(host.runtime.getActiveSessionFacts().pendingMessageCount, 0);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.text === "consume:idle"), false);
    let starts = 0;
    const unsubscribe = host.runtime.activeSession.subscribe((event) => {
      if (event.type === "agent_start") {
        starts++;
        assert.equal(control!.observe().runtime.automaticWorkSettled, false);
      }
    });
    let finish!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    const response = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => { finish = resolve; });
    let providerStarted!: () => void;
    const providerReady = new Promise<void>((resolve) => { providerStarted = resolve; });
    faux.setResponses([async () => { providerStarted(); return response; }]);
    const delivered = await control.input({ lease: before.lease, text: "Harmless compatibility observation" });
    assert.equal(delivered.delivery, "prompt");
    assert.equal(delivered.snapshot.runtime.automaticWorkSettled, false);
    await providerReady;
    for (const delivery of ["steer", "followUp"] as const) {
      const timing = delivery === "steer" ? "now" : "after_current_run";
      await assert.rejects(control.input({ lease: before.lease, text: `consume:${delivery}`, timing }),
        (error: unknown) => error instanceof PindieControlError && error.code === "delivery_failed");
      const queued = await control.input({ lease: before.lease, text: `queued:${delivery}`, timing });
      assert.equal(queued.delivery, delivery);
      assert.equal(control.readTimeline().timeline.filter((block) => block.type === "message" && block.text === `queued:${delivery}`).length, 1);
      assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.text === `consume:${delivery}`), false);
    }
    assert.equal(host.runtime.getActiveSessionFacts().pendingMessageCount, 2);
    host.runtime.clearActiveSessionQueue();
    let resolved = false;
    const settled = control.wait({ lease: before.lease, until: "settled", timeoutSeconds: 5 }).then((result) => { resolved = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, false);
    finish(fauxAssistantMessage("Compatibility observation complete"));
    assert.equal((await settled).reason, "settled");
    assert.equal(starts, 1);
    unsubscribe();
    const after = control.observe();
    assert.ok(after.revision > before.revision);
    assert.equal(after.latestAssistant?.text, "Compatibility observation complete");
    const timeline = control.readTimeline().timeline;
    assert.equal(timeline.filter((block) => block.type === "message" && block.role === "user" && block.text === "Harmless compatibility observation").length, 1);
    assert.equal(timeline.some((block) => block.type === "message" && block.text === "Compatibility observation complete"), true);
    const replacement = await control.freshSession({ lease: after.lease });
    assert.notEqual(replacement.snapshot.lease, after.lease);
    assert.notEqual(replacement.snapshot.session.id, after.session.id);
    assert.equal(replacement.snapshot.latestAssistant, null);
  } finally {
    control?.dispose();
    await host?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real pinned Pi Control rebinds after fresh Session before exposing a new lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-control-rebind-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(project);
  await mkdir(agentDir);
  let host: PindieHost | undefined;
  let control: PindieControlClient | undefined;
  try {
    host = await createPindieHost({
      cwd: project,
      agentDir,
      sessionManager: SessionManager.inMemory(project),
      env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_TUI: "0" },
      dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
    });
    const boundSessions: string[] = [];
    control = new PindieControlClient(host.runtime, host.presentation, {
      bindActiveSession: async () => {
        const sessionId = host!.runtime.activeSessionId;
        await host!.runtime.bindActiveSessionExtensions({ mode: "print" });
        boundSessions.push(sessionId);
      },
    });
    await control.start();
    const before = control.observe();
    assert.deepEqual(boundSessions, [before.session.id]);
    assert.notEqual(before.semantic.authority, "unavailable");
    assert.equal(before.project.root, project);
    const next = await control.freshSession({ lease: before.lease });
    assert.equal(next.cancelled, false);
    assert.notEqual(next.snapshot.session.id, before.session.id);
    assert.deepEqual(boundSessions, [before.session.id, next.snapshot.session.id]);
    assert.notEqual(next.snapshot.lease, before.lease);
    assert.notEqual(next.snapshot.semantic.authority, "unavailable");
    assert.equal(next.snapshot.project.root, project);
    await assert.rejects(control.input({ lease: before.lease, text: "stale" }),
      (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
  } finally {
    control?.dispose();
    await host?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
