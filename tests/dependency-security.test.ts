import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import { CONTROL_MAX_TOOL_INPUT_ELEMENTS, createPindieControlMcpServer } from "../src/control-mcp.ts";
import { CONTROL_MAX_REQUEST_BODY_SIZE, startControlMcpProcess } from "../src/control-mcp-process.ts";
import type { PindieControlWorkspace } from "../src/control-workspace.ts";

async function listen(server: Server): Promise<URL> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("Control caps nested tool input before schema validation and workspace dispatch", async () => {
  let observed = 0;
  const workspace = { observe: () => { observed++; return { state: "no_active_project" }; } } as unknown as PindieControlWorkspace;
  const server = createPindieControlMcpServer(workspace);
  const peer = new Client({ name: "bounded-input-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await peer.connect(right);
  try {
    for (const value of [Array(CONTROL_MAX_TOOL_INPUT_ELEMENTS + 1).fill(null),
      Object.fromEntries(Array.from({ length: CONTROL_MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => [`k${i}`, null]))]) {
      const result = await peer.callTool({ name: "pindie_observe", arguments: { nested: value } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /maximum of 64 elements/);
    }
    assert.equal(observed, 0);
    assert.equal((await peer.listTools()).tools.length, 13);
    assert.equal((await peer.callTool({ name: "pindie_observe", arguments: {} })).isError, undefined);
    assert.equal(observed, 1);
  } finally { await peer.close(); await server.close(); }
});

test("Control rejects oversized fixed and chunked HTTP bodies and remains discoverable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-security-http-"));
  const handle = await startControlMcpProcess({ workspaceRoot: root, port: 0 });
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "pindie_input", arguments: { lease: "unused", text: "x".repeat(CONTROL_MAX_REQUEST_BODY_SIZE) },
    } });
    assert.equal((await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status, 413);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => {
        res.resume(); resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.write(body.slice(0, body.length / 2));
      req.end(body.slice(body.length / 2));
    });
    assert.equal(chunkedStatus, 413);
    const peer = new Client({ name: "after-rejection", version: "1" });
    try {
      await peer.connect(new StreamableHTTPClientTransport(url));
      assert.equal((await peer.listTools()).tools.length, 13);
      // A substantial ordinary prompt still reaches Control, not the body limiter.
      const result = await peer.callTool({ name: "pindie_input", arguments: { lease: "unused", text: "x".repeat(64 * 1024) } });
      assert.equal(result.structuredContent?.code, "no_active_project");
    } finally { await peer.close(); }
  } finally { await handle.close(); await rm(root, { recursive: true, force: true }); }
});

test("MCP HTTP client does not forward initialize bodies across origins", async () => {
  let leaked = 0;
  const target = createServer((_req, res) => { leaked++; res.writeHead(400).end(); });
  const targetUrl = await listen(target);
  const redirect = createServer((_req, res) => { res.writeHead(307, { Location: targetUrl.href }).end(); });
  const sourceUrl = await listen(redirect);
  const peer = new Client({ name: "redirect-test", version: "1" });
  try {
    await assert.rejects(peer.connect(new StreamableHTTPClientTransport(sourceUrl)));
    assert.equal(leaked, 0);
  } finally { await peer.close(); await close(redirect); await close(target); }
});

test("Zod rejects oversized constrained collections before parsing their elements", () => {
  let parsed = 0;
  const schema = z.array(z.preprocess((value) => { parsed++; return value; }, z.string())).max(1);
  const result = schema.safeParse(Array(1_000).fill(42));
  assert.equal(result.success, false);
  assert.equal(parsed, 0);
  assert.equal(result.error?.issues.length, 1);
  assert.deepEqual(schema.parse(["ordinary"]), ["ordinary"]);
});

test("both Undici lines survive excessive content encodings; pinned Pi dispatcher remains compatible", () => {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const require = createRequire(import.meta.url);
  assert.equal(require("undici/package.json").version, "6.29.1");
  assert.equal(piRequire("undici/package.json").version, "8.12.2");
  const script = `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:net';
    import { createServer as httpServer } from 'node:http';
    import { gzipSync } from 'node:zlib';
    import { pathToFileURL } from 'node:url';
    const six = await import(pathToFileURL(process.argv[1]).href);
    const eight = await import(pathToFileURL(process.argv[2]).href);
    const dispatcherModule = await import(pathToFileURL(process.argv[3]).href);
    const bad = createServer(socket => socket.once('data', () => socket.end(
      'HTTP/1.1 200 OK\\r\\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\nContent-Length: 1\\r\\nConnection: close\\r\\n\\r\\n')));
    await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve));
    try {
      for (const implementation of [six, eight]) {
        const agent = new implementation.Agent();
        try { await assert.rejects(implementation.fetch('http://127.0.0.1:' + bad.address().port, { dispatcher: agent })); }
        finally { await agent.close(); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } finally { await new Promise(resolve => bad.close(resolve)); }
    const good = httpServer((_req, res) => { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(gzipSync('{"ok":true}')); });
    await new Promise(resolve => good.listen(0, '127.0.0.1', resolve));
    dispatcherModule.configureHttpDispatcher(30_000);
    assert.ok(eight.getGlobalDispatcher() instanceof eight.EnvHttpProxyAgent);
    try { assert.deepEqual(await (await fetch('http://127.0.0.1:' + good.address().port)).json(), { ok: true }); }
    finally { await eight.getGlobalDispatcher().close(); await new Promise(resolve => good.close(resolve)); }
    console.log('isolated-undici-security-and-Pi-dispatcher-PASS');
  `;
  // No production credentials/proxy/preferences are inherited by this isolated probe.
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script,
    require.resolve("undici"), piRequire.resolve("undici"),
    fileURLToPath(new URL("core/http-dispatcher.js", import.meta.resolve("@earendil-works/pi-coding-agent")))],
  { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH } });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.match(child.stdout, /isolated-undici-security-and-Pi-dispatcher-PASS/);
});
