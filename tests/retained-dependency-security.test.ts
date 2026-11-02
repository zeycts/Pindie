import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";

const require = createRequire(import.meta.url);
const browserRequire = createRequire(require.resolve("@amaster.ai/pi-browser-use"));
const sdkRequire = createRequire(browserRequire.resolve("@modelcontextprotocol/sdk/client/index.js"));
const nodeRequire = createRequire(require.resolve("@modelcontextprotocol/node"));
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

function packageVersion(name: string, from = require, entry = name): string {
  let directory = dirname(from.resolve(entry));
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (metadata.name === name) return metadata.version;
    } catch { /* Continue past dist-level module markers. */ }
    const parent = dirname(directory);
    assert.notEqual(parent, directory, `Package root not found: ${name}`);
    directory = parent;
  }
}

const expressRequire = createRequire(sdkRequire.resolve("express"));
const ajvRequire = createRequire(sdkRequire.resolve("ajv"));
const limiterRequire = createRequire(sdkRequire.resolve("express-rate-limit"));

test("selected retained graph is patched; Pi and direct MCP pins remain unchanged", () => {
  assert.equal(packageVersion("@modelcontextprotocol/sdk", browserRequire, "@modelcontextprotocol/sdk/client/index.js"), "1.32.0");
  assert.equal(packageVersion("hono", nodeRequire), "4.13.11");
  assert.equal(packageVersion("hono", sdkRequire), "4.13.11");
  assert.equal(packageVersion("@hono/node-server", sdkRequire), "2.1.3");
  assert.equal(packageVersion("body-parser", expressRequire), "2.4.0");
  assert.equal(packageVersion("fast-uri", ajvRequire), "3.1.9");
  assert.equal(packageVersion("ip-address", limiterRequire), "10.7.4");
  assert.equal(packageVersion("qs", expressRequire), "6.16.1");
  assert.equal(packageVersion("@modelcontextprotocol/node"), "2.1.0");
  assert.equal(packageVersion("@modelcontextprotocol/client"), "2.3.0");
  assert.equal(packageVersion("@modelcontextprotocol/server"), "2.3.0");
  assert.equal(packageVersion("@earendil-works/pi-coding-agent", piRequire, "./index.js"), "1.4.0");
  // Deliberately retained: do not force major upgrades to hide audit findings.
  assert.equal(packageVersion("@hono/node-server", nodeRequire), "1.19.17");
  assert.equal(packageVersion("minimatch", piRequire), "10.2.6");
});

test("patched browser SDK preserves real credential-free stdio initialize/list/call", async () => {
  const { Client } = await import(pathToFileURL(browserRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(browserRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const serverModule = pathToFileURL(browserRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
  const transportModule = pathToFileURL(browserRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
  const source = `
    const { McpServer } = await import(${JSON.stringify(serverModule)});
    const { StdioServerTransport } = await import(${JSON.stringify(transportModule)});
    const server = new McpServer({ name: 'security-stdio-fixture', version: '1' });
    server.registerTool('inspect', { description: 'Synthetic read-only fixture' }, async () => ({ content: [{ type: 'text', text: 'fixture-ok' }] }));
    await server.connect(new StdioServerTransport());
  `;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--input-type=module", "--eval", source], env: {}, stderr: "pipe" });
  const client = new Client({ name: "browser-sdk-security-test", version: "1" });
  try {
    await client.connect(transport, { timeout: 5_000 });
    assert.deepEqual((await client.listTools()).tools.map((tool: { name: string }) => tool.name), ["inspect"]);
    assert.deepEqual((await client.callTool({ name: "inspect", arguments: {} })).content, [{ type: "text", text: "fixture-ok" }]);
  } finally { await client.close(); await transport.close(); }
});

test("patched URI and IP primitives retain ordinary operation under bounded hostile inputs", () => {
  // A child timeout keeps a future quadratic-regression failure bounded.
  const source = `
    const assert = require('node:assert/strict');
    const uri = require(${JSON.stringify(ajvRequire.resolve("fast-uri"))});
    const { Address6 } = require(${JSON.stringify(limiterRequire.resolve("ip-address"))});
    const qs = require(${JSON.stringify(expressRequire.resolve("qs"))});
    assert.equal(uri.normalize('https://example.com/a'), 'https://example.com/a');
    assert.notEqual(uri.parse('%6aavascript:alert(1)').scheme, 'javascript');
    assert.equal(new Address6('::1').isLoopback(), true);
    assert.throws(() => new Address6('%'.repeat(100_000) + '\\n'));
    assert.equal(qs.stringify({ a: ['one', 'two'] }, { arrayFormat: 'comma' }), 'a=one%2Ctwo');
    console.log('patched-primitives-PASS');
  `;
  const child = spawnSync(process.execPath, ["--eval", source], { encoding: "utf8", timeout: 5_000, env: {} });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  assert.match(child.stdout, /patched-primitives-PASS/);
});

test("retained node adapter exposes no static-file route, including encoded paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-no-static-security-"));
  const handle = await startControlMcpProcess({ workspaceRoot: root, port: 0 });
  try {
    for (const path of ["/static/file.txt", "/static/%252e%252e/private", "/mcp/%252e%252e/private"]) {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`);
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
  } finally { await handle.close(); await rm(root, { recursive: true, force: true }); }
});

test("retained minimatch exposure stays at the documented default optimization level", () => {
  for (const file of ["package-manager.js", "model-resolver.js"]) {
    const source = readFileSync(new URL(`../node_modules/@earendil-works/pi-coding-agent/dist/core/${file}`, import.meta.url), "utf8");
    assert.match(source, /minimatch\(/);
    assert.doesNotMatch(source, /optimizationLevel\s*:/);
  }
  const { minimatch } = piRequire("minimatch");
  assert.equal(minimatch("src/index.ts", "src/**/*.ts"), true);
  assert.equal(minimatch("provider/MODEL", "provider/model", { nocase: true }), true);
});
