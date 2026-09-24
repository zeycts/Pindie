import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
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
      projectRoot: project,
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
      assert.ok(host);
      // The actual MCP process starts Control only after Pi's public bindExtensions
      // completes; an independent client here would overwrite its lifecycle slot.
      const snapshot = host.presentation.current()?.snapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.projectRoot, project);
      assert.ok(snapshot.status.state);
      assert.equal(snapshot.status.stateUnavailableReason, null);
      const peer = new Client({ name: "headless-regression", version: "1" });
      try {
        await peer.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)));
        const observed = await peer.callTool({ name: "pindie_observe", arguments: {} });
        assert.equal(observed.isError, undefined);
        const control = observed.structuredContent as { project: { root: string }; semantic: { authority: string } };
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
