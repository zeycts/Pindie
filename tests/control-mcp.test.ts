import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PindieControlError, type PindieControlClient } from "../src/control-client.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import { resolveControlProjectRoot, startControlMcpProcess } from "../src/control-mcp-process.ts";
import { isPindieTuiEnabled, type PindieHost } from "../src/host.ts";

const asClient = (value: object) => value as PindieControlClient;

async function linked(client: PindieControlClient) {
  const server = createPindieControlMcpServer(client);
  const peer = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await peer.connect(right);
  return { peer, close: async () => { await peer.close(); await server.close(); } };
}

test("MCP surface registers exactly six bounded tools with appropriate hints and strict inputs", async () => {
  const wire = await linked(asClient({ observe: () => ({ lease: "live", revision: 1 }) }));
  try {
    const { tools } = await wire.peer.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "pindie_observe", "pindie_input", "pindie_respond", "pindie_stop",
      "pindie_fresh_session", "pindie_configure",
    ]);
    assert.deepEqual(tools.map((tool) => [tool.annotations?.readOnlyHint, tool.annotations?.destructiveHint]), [
      [true, false], [false, false], [false, true], [false, true], [false, true], [false, false],
    ]);
    const observed = await wire.peer.callTool({ name: "pindie_observe", arguments: {} });
    assert.deepEqual(observed.structuredContent, { lease: "live", revision: 1 });
    const invalid = await wire.peer.callTool({ name: "pindie_input", arguments: { lease: "live" } });
    assert.equal(invalid.isError, true);
    const extra = await wire.peer.callTool({ name: "pindie_observe", arguments: { path: "/secret" } });
    assert.equal(extra.isError, true);
  } finally { await wire.close(); }
});

test("each MCP action delegates unchanged to Control client; stale lease returns structured recovery snapshot", async () => {
  const calls: unknown[] = [];
  const snapshot = { lease: "current", revision: 8 };
  const fake = asClient({
    observe: () => snapshot,
    input: (arg: unknown) => { calls.push(["input", arg]); return { delivery: "steer", snapshot }; },
    respond: (arg: unknown) => { calls.push(["respond", arg]); return { delivery: "prompt", snapshot }; },
    stop: (arg: unknown) => { calls.push(["stop", arg]); return { stopped: true, snapshot }; },
    freshSession: (arg: unknown) => { calls.push(["fresh", arg]); return { cancelled: false, snapshot }; },
    configure: (arg: unknown) => { calls.push(["configure", arg]); return snapshot; },
  });
  const wire = await linked(fake);
  try {
    const invoke = (name: string, args: object) => wire.peer.callTool({ name: `pindie_${name}`, arguments: args });
    assert.equal((await invoke("input", { lease: "live", text: "hi", timing: "after_current_run" })).structuredContent?.delivery, "steer");
    await invoke("respond", { lease: "live", gateKey: "gate", response: "yes" });
    await invoke("stop", { lease: "live" });
    await invoke("fresh_session", { lease: "live" });
    await invoke("configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" });
    assert.deepEqual(calls, [
      ["input", { lease: "live", text: "hi", timing: "after_current_run" }],
      ["respond", { lease: "live", gateKey: "gate", response: "yes" }],
      ["stop", { lease: "live" }], ["fresh", { lease: "live" }],
      ["configure", { lease: "live", model: { provider: "p", modelId: "m" }, thinkingLevel: "low" }],
    ]);
  } finally { await wire.close(); }

  const stale = await linked(asClient({ input: () => { throw new PindieControlError("stale_control_lease", "Observe again", snapshot as never); } }));
  try {
    const result = await stale.peer.callTool({ name: "pindie_input", arguments: { lease: "old", text: "hello" } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { code: "stale_control_lease", message: "Observe again", snapshot });
  } finally { await stale.close(); }
});

test("loopback MCP disconnect/reconnect retains one headless Host; explicit shutdown disposes once", async () => {
  await assert.rejects(resolveControlProjectRoot(undefined), /PINDIE_PROJECT_ROOT/);
  const root = await mkdtemp(join(tmpdir(), "pindie-mcp-"));
  const oldTui = process.env.PINDIE_TUI;
  process.env.PINDIE_TUI = "1";
  try {
    const file = join(root, "file");
    await writeFile(file, "x");
    await assert.rejects(resolveControlProjectRoot(file), /directory/);
    let hostCreated = 0;
    let hostDisposed = 0;
    let clientDisposed = 0;
    let clientStarted = 0;
    let stopped = 0;
    let aborted = 0;
    const lease = "same-host-lease";
    const handle = await startControlMcpProcess({
      projectRoot: root,
      port: 0,
      createHost: async (options) => {
        hostCreated++;
        assert.equal(options.cwd, root);
        assert.equal(options.env?.PINDIE_TUI, "0");
        assert.equal(isPindieTuiEnabled(options.env!), false);
        assert.ok(options.dependencies?.createInteractiveMode);
        assert.equal(options.dependencies.createPindieInteractiveMode, undefined);
        return { dispose: async () => { hostDisposed++; }, runtime: { abortActiveSession: () => { aborted++; } } } as PindieHost;
      },
      createClient: () => asClient({
        start: async () => { clientStarted++; },
        dispose: () => { clientDisposed++; },
        observe: () => ({ lease, revision: 1 }),
        stop: () => { stopped++; },
      }),
    });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    try {
      const connect = async () => {
        const peer = new Client({ name: "tunnel", version: "1" });
        await peer.connect(new StreamableHTTPClientTransport(url));
        return peer;
      };
      const first = await connect();
      assert.equal((await first.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.lease, lease);
      await first.close();
      assert.deepEqual([hostCreated, hostDisposed, clientStarted, clientDisposed, stopped, aborted], [1, 0, 1, 0, 0, 0]);
      const second = await connect();
      assert.equal((await second.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.lease, lease);
      await second.close();
      assert.deepEqual([hostCreated, hostDisposed, clientStarted, clientDisposed, stopped, aborted], [1, 0, 1, 0, 0, 0]);
      const rebindingStatus = await new Promise<number>((resolve, reject) => {
        const req = request(url, { method: "POST", headers: { Host: "attacker.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(rebindingStatus, 403);
      const hostileOrigin = await fetch(url, { method: "POST", headers: { Origin: "https://attacker.example" } });
      assert.equal(hostileOrigin.status, 403);
      assert.equal(hostDisposed, 0);
    } finally { await handle.close(); await handle.close(); }
    assert.deepEqual([hostDisposed, clientDisposed, stopped, aborted], [1, 1, 0, 0]);
    await assert.rejects(startControlMcpProcess({
      projectRoot: root,
      port: 0,
      createHost: async () => ({ dispose: async () => { hostDisposed++; } }) as PindieHost,
      createClient: () => { throw new Error("binding failed"); },
    }), /binding failed/);
    assert.equal(hostDisposed, 2);
  } finally {
    if (oldTui === undefined) delete process.env.PINDIE_TUI;
    else process.env.PINDIE_TUI = oldTui;
    await rm(root, { recursive: true, force: true });
  }
});
