import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer, request } from "node:http";
import { handleControlMcpHttp, logControlMcpFailure } from "../src/control-mcp-errors.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startControlMcpProcess } from "../src/control-mcp-process.ts";
import { PindieControlError, type PindieControlClient, type PindieControlSnapshot } from "../src/control-client.ts";
import { PindieWorkspaceError } from "../src/control-workspace.ts";
import { spawnSync } from "node:child_process";
import type { PindieHost } from "../src/host.ts";

// Derived from the preserved P0 fixture: real local HTTP/SDK, stub execution,
// no provider or production route; not public-tunnel authentication evidence.
async function fixture(hostFailure?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "pindie-phase4-p0-"));
  await mkdir(join(root, "project"));
  let accepted = 0;
  let failure: unknown = new Error("AUDIT_PRIVATE_ERROR_MARKER");
  let release!: () => void;
  let entered!: () => void;
  const acceptedBarrier = new Promise<void>(resolve => { entered = resolve; });
  const acknowledgementBarrier = new Promise<void>(resolve => { release = resolve; });
  const snapshot = () => ({
    lease: "audit-lease", revision: accepted + 1, session: { id: "audit-session" },
    runtime: { idle: accepted === 0, automaticWorkSettled: accepted === 0, pendingMessageCount: 0 },
    semantic: { humanGate: null }, recovery: { quotaWaiting: null },
    dispatches: accepted ? [{ dispatchId: "audit-dispatch", state: "running" }] : [],
  }) as unknown as PindieControlSnapshot;
  const handle = await startControlMcpProcess({ workspaceRoot: root, port: 0,
    createHost: async () => {
      if (hostFailure !== undefined) throw hostFailure;
      return { dispose: async () => {} } as PindieHost;
    },
    createClient: () => ({ start: async () => {}, dispose: () => {}, observe: snapshot,
      input: async () => { accepted++; entered(); await acknowledgementBarrier;
        return { dispatch: { dispatchId: "audit-dispatch", state: "running" } }; },
      respond: async () => { throw failure; },
    }) as unknown as PindieControlClient,
  });
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  const peers: Client[] = [];
  const connect = async (authorization?: string) => {
    const peer = new Client({ name: "phase4-p0-audit", version: "1" });
    peers.push(peer);
    await peer.connect(new StreamableHTTPClientTransport(url,
      authorization ? { requestInit: { headers: { Authorization: authorization } } } : {}));
    return peer;
  };
  return { url, connect, acceptedBarrier, release, count: () => accepted, setFailure: (value: unknown) => { failure = value; },
    close: async () => { release(); await Promise.all(peers.map(p => p.close())); await handle.close(); await rm(root, { recursive: true }); },
  };
}

test("P4 audit: local Host/Origin guards are not bearer authentication or per-tool RBAC", async () => {
  const f = await fixture();
  try {
    for (const authorization of [undefined, "Bearer AUDIT_INVALID_CREDENTIAL"]) {
      const peer = await f.connect(authorization);
      assert.equal((await peer.listTools()).tools.length, 13);
      const open = await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
      assert.equal(open.isError, undefined, "local lifecycle write is not authenticated by bearer");
      const observed = await peer.callTool({ name: "pindie_observe", arguments: {} });
      assert.equal(observed.structuredContent?.state, "active_project");
      assert.equal(JSON.stringify(observed).includes("AUDIT_INVALID_CREDENTIAL"), false);
      await peer.close();
    }
    // undici fetch does not reliably preserve a caller-supplied Host; use raw HTTP.
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(f.url, { method: "POST", headers: { Host: "untrusted.invalid" } }, res => {
        res.resume(); resolve(res.statusCode ?? 0);
      });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    const response = await fetch(f.url, { method: "POST", headers: { Origin: "https://untrusted.invalid" } });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  } finally { await f.close(); }
});

test("P4 audit: SDK timeout after local acceptance is not Run failure; reconnect never resends input", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.connect();
    await first.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    const pending = first.callTool({ name: "pindie_input", arguments: { lease: "audit-lease", text: "synthetic work" } }, { timeout: 500 });
    const rejected = assert.rejects(pending);
    await f.acceptedBarrier;
    await rejected;
    assert.equal(f.count(), 1);
    f.release();
    await first.close();
    const second = await f.connect();
    const observed = await second.callTool({ name: "pindie_observe", arguments: {} });
    const snapshot = observed.structuredContent?.control as { lease: string; dispatches: { state: string }[] };
    assert.equal(snapshot.lease, "audit-lease", "HTTP reconnect alone must not rotate a still-live Host lease");
    assert.equal(snapshot.dispatches[0]?.state, "running", "lost acknowledgement is neither success nor Run failure");
    assert.equal(f.count(), 1, "read-only reconnect/observe performs no automatic replay");
    // Explicit repeat is intentionally a new operation, NOT an idempotent retry.
    await second.callTool({ name: "pindie_input", arguments: { lease: "audit-lease", text: "synthetic work" } });
    assert.equal(f.count(), 2, "audit confirms resend risk, not exactly-once delivery");
  } finally { await f.close(); }
});

test("HTTP MCP errors never expose arbitrary exceptions, nested causes or custom serialization", async () => {
  const f = await fixture();
  const marker = "AUDIT_PRIVATE_ERROR_MARKER";
  let inspected = 0;
  const accessor = Object.defineProperty(new Error(), "message", { get: () => { inspected++; return marker; } });
  try {
    const peer = await f.connect();
    await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    for (const failure of [new Error(marker), marker, { message: marker, cause: { message: marker } },
      new Error(marker, { cause: new Error(marker) }), accessor,
      { toString: () => { inspected++; return marker; }, toJSON: () => { inspected++; return marker; } }]) {
      f.setFailure(failure);
      const response = await peer.callTool({ name: "pindie_respond", arguments: { lease: "audit-lease", gateKey: "synthetic", response: "synthetic" } });
      assert.equal(response.isError, true);
      assert.equal(JSON.stringify(response).includes(marker), false, "raw exception must not cross the wire");
      assert.equal(response.structuredContent?.code, "internal_error");
      assert.deepEqual(JSON.parse((response.content[0] as { text: string }).text), response.structuredContent);
    }
    assert.equal(inspected, 0, "never read/serialize the thrown value");
    assert.equal((await peer.listTools()).tools.length, 13);
    assert.equal((await peer.callTool({ name: "pindie_observe", arguments: {} })).isError, undefined);
  } finally { await f.close(); }
});

test("HTTP MCP controlled codes keep recovery fields, not dynamic messages or extra error members", async () => {
  const f = await fixture();
  const marker = "AUDIT_PRIVATE_ERROR_MARKER";
  try {
    const peer = await f.connect();
    await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    const receipt = { dispatchId: "live:audit:control:1", delivery: "prompt" as const, nextAction: "wait_observe_do_not_resend" as const, privateDetail: marker };
    const snapshot = { lease: "safe-lease" } as PindieControlSnapshot;
    for (const failure of [new PindieControlError("delivery_uncertain", marker, snapshot, receipt),
      new PindieControlError("stale_control_lease", marker, snapshot, receipt),
      new PindieControlError("delivery_failed", marker, snapshot),
      new PindieWorkspaceError("project_open_failed", marker)]) {
      Object.assign(failure, { cause: { message: marker }, privateDetail: marker });
      f.setFailure(failure);
      const response = await peer.callTool({ name: "pindie_respond", arguments: { lease: "audit-lease", gateKey: "synthetic", response: "synthetic" } });
      assert.equal(response.isError, true);
      assert.equal(JSON.stringify(response).includes(marker), false);
      assert.equal(response.structuredContent?.code, failure.code);
      if (failure instanceof PindieControlError) assert.deepEqual(response.structuredContent?.snapshot, snapshot);
      if (failure instanceof PindieControlError && failure.receipt) assert.deepEqual(response.structuredContent?.receipt,
        { dispatchId: receipt.dispatchId, delivery: receipt.delivery, nextAction: receipt.nextAction });
    }
    f.setFailure(new PindieControlError(marker as never, marker));
    assert.equal((await peer.callTool({ name: "pindie_respond", arguments: { lease: "audit-lease", gateKey: "synthetic", response: "synthetic" } })).structuredContent?.code, "internal_error");
  } finally { await f.close(); }
});

test("HTTP Workspace Host bootstrap failure is public-safe without serializing its cause", async () => {
  const marker = "AUDIT_PRIVATE_ERROR_MARKER";
  const f = await fixture(new Error(marker, { cause: { message: marker } }));
  try {
    const peer = await f.connect();
    const response = await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    assert.equal(response.structuredContent?.code, "project_open_failed");
    assert.equal(JSON.stringify(response).includes(marker), false);
    assert.equal((await peer.callTool({ name: "pindie_observe", arguments: {} })).structuredContent?.state, "no_active_project");
  } finally { await f.close(); }
});

test("Node HTTP rejection boundary returns a safe 500 or destroys an already-started response without replay", async () => {
  const marker = "Authorization: Bearer SYNTHETIC_CREDENTIAL Cookie: SYNTHETIC_COOKIE /private/synthetic/session.jsonl";
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  let calls = 0;
  const server = createServer((req, res) => {
    void handleControlMcpHttp(async (_req, response) => {
      calls++;
      if (req.url === "/started") { response.writeHead(200); response.write("safe-prefix"); }
      throw new Error(marker, { cause: { headers: marker, toJSON: () => marker } });
    }, req, res);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    // Raw HTTP observes the reset whether or not response headers reached the client.
    await new Promise<void>((resolve, reject) => {
      const req = request(`${url}/started`, res => {
        res.resume();
        res.on("aborted", resolve);
        res.on("error", resolve);
        res.on("end", () => reject(new Error("partial response must not complete")));
      });
      req.on("error", () => resolve());
      req.end();
    });
    assert.equal(calls, 2, "transport failure must not retry the operation");
    assert.deepEqual(logs, [["Pindie Control MCP transport failed."], ["Pindie Control MCP transport failed."]]);
    assert.equal(JSON.stringify(logs).includes(marker), false);
  } finally {
    console.error = original;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("Control MCP lifecycle logger accepts only a phase and emits fixed bounded diagnostics", () => {
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const phase of ["startup", "shutdown", "transport"] as const) logControlMcpFailure(phase);
    assert.deepEqual(logs, [["Pindie Control MCP startup failed."], ["Pindie Control MCP shutdown failed."], ["Pindie Control MCP transport failed."]]);
  } finally { console.error = original; }
});

test("Control process startup stderr does not print raw filesystem exceptions", () => {
  const marker = "AUDIT_PRIVATE_ERROR_MARKER";
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "src/control-mcp-process.ts"], {
    cwd: process.cwd(), env: { ...process.env, PINDIE_WORKSPACE_ROOT: `/nonexistent/${marker}` }, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(child.status, 1);
  assert.equal((child.stdout + child.stderr).includes(marker), false, "stderr must not echo filesystem path/error");
  assert.match(child.stderr, /Pindie Control MCP startup failed/);
});
