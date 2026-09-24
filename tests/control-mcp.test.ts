import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PindieControlError, type PindieControlClient } from "../src/control-client.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import { resolveControlProjectRoot, startControlMcpProcess } from "../src/control-mcp-process.ts";
import type { PindieHost } from "../src/host.ts";

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

test("MCP startup validates explicit project root; disconnect disposes headless client and Host only", async () => {
  await assert.rejects(resolveControlProjectRoot(undefined), /PINDIE_PROJECT_ROOT/);
  const root = await mkdtemp(join(tmpdir(), "pindie-mcp-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "x");
    await assert.rejects(resolveControlProjectRoot(file), /directory/);
    let hostDisposed = 0;
    let clientDisposed = 0;
    let semanticMutations = 0;
    let disconnect: (() => void) | undefined;
    const handle = await startControlMcpProcess({
      projectRoot: root,
      createHost: async (options) => {
        assert.equal(options.cwd, root);
        assert.ok(options.dependencies?.createInteractiveMode);
        assert.equal(options.dependencies.createPindieInteractiveMode, undefined);
        return { dispose: async () => { hostDisposed++; } } as PindieHost;
      },
      createClient: () => asClient({ start: async () => {}, dispose: () => { clientDisposed++; }, observe: () => { semanticMutations++; } }),
      serve: (factory) => {
        const server = factory({} as never);
        if (server instanceof Promise) throw new Error("Unexpected async MCP factory");
        disconnect = () => { server.onclose?.(); };
        return { close: async () => { disconnect?.(); } };
      },
    });
    disconnect?.();
    await handle.close();
    await handle.close();
    assert.equal(hostDisposed, 1);
    assert.equal(clientDisposed, 1);
    assert.equal(semanticMutations, 0);
    await assert.rejects(startControlMcpProcess({
      projectRoot: root,
      createHost: async () => ({ dispose: async () => { hostDisposed++; } }) as PindieHost,
      createClient: () => { throw new Error("binding failed"); },
    }), /binding failed/);
    assert.equal(hostDisposed, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
