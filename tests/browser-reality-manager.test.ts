import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserRealityManager } from "../src/browser-reality-manager.ts";
import { readBrowserToolCatalog } from "../src/browser-tool-catalog.ts";
import { resolveBrowserRealityConfig, type BrowserRealityToolClient } from "../src/browser-reality.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { start?: Promise<void>; canRelease?: () => boolean; idleMs?: number; shutdownTimeoutMs?: number } = {}) {
  const events: string[] = [];
  let bridgeStopFails = false;
  let schemaDrift = false;
  let call: BrowserRealityToolClient["callTool"] = async () => ({ content: [{ type: "text", text: "ok" }] });
  const manager = createBrowserRealityManager(resolveBrowserRealityConfig({}), {
    canIdleRelease: options.canRelease ?? (() => true), idleMs: options.idleMs, shutdownTimeoutMs: options.shutdownTimeoutMs,
    createRuntime: () => {
      events.push("runtime");
      return {
        config: { enabled: true, headless: true, browserUrl: "http://127.0.0.1:12345" },
        start: async () => {
          events.push("start"); await options.start;
          return { enabled: true, available: true, reason: null };
        },
        status: async () => ({ enabled: true, available: true, reason: null }),
        dispose: async () => { events.push("browser-stop/profile-clean"); },
      };
    },
    createClient: () => {
      events.push("client");
      return {
        listAllTools: async () => { events.push("discover"); return schemaDrift ? [] : [...readBrowserToolCatalog().tools]; },
        callTool: async (...args) => { events.push("call"); return call(...args); },
        close: async () => { events.push("bridge-stop"); if (bridgeStopFails) throw new Error("unconfirmed bridge stop"); },
      };
    },
  });
  return { manager, events, failBridgeStop: () => { bridgeStopFails = true; }, drift: () => { schemaDrift = true; }, setCall: (next: typeof call) => { call = next; } };
}

test("construction/status/unused disposal never creates resources", async () => {
  const { manager, events } = fixture();
  assert.deepEqual(manager.status(), { phase: "idle", inFlight: 0, reason: null });
  await manager.dispose();
  assert.deepEqual(events, []);
  await assert.rejects(manager.callTool("list_pages", {}), /disposed/);
});

test("first calls single-flight startup, validate before dispatch, reuse and explicitly release in order", async () => {
  const start = deferred();
  const { manager, events } = fixture({ start: start.promise });
  const a = manager.callTool("list_pages", {});
  const b = manager.callTool("take_snapshot", {});
  assert.deepEqual(events, ["runtime", "start"]);
  await assert.rejects(manager.release(), /in-flight/);
  start.resolve();
  await Promise.all([a, b]);
  await manager.callTool("list_pages", {});
  assert.deepEqual(events, ["runtime", "start", "client", "discover", "call", "call", "call"]);
  await manager.release();
  assert.deepEqual(events.slice(-2), ["bridge-stop", "browser-stop/profile-clean"]);
  await manager.callTool("list_pages", {});
  assert.equal(events.filter((event) => event === "runtime").length, 2);
  const disposal = manager.dispose();
  assert.equal(manager.dispose(), disposal);
  await disposal;
});

test("one aborted startup waiter does not cancel other callers or the shared startup", async () => {
  const start = deferred();
  const { manager, events } = fixture({ start: start.promise });
  const controller = new AbortController();
  const a = manager.callTool("list_pages", {}, controller.signal);
  const rejected = assert.rejects(a, /cancelled/);
  const b = manager.callTool("list_pages", {});
  controller.abort(new Error("cancelled"));
  await rejected;
  start.resolve();
  await b;
  assert.equal(events.filter((event) => event === "call").length, 1);
  await manager.dispose();
});

test("Host disposal fences late startup, without constructing a late bridge or dispatching", async () => {
  const start = deferred();
  const { manager, events } = fixture({ start: start.promise });
  const pending = manager.callTool("list_pages", {});
  const rejected = assert.rejects(pending, /disposing/);
  const disposal = manager.dispose();
  start.resolve();
  await rejected;
  await disposal;
  assert.deepEqual(events, ["runtime", "start", "browser-stop/profile-clean"]);
});

test("schema drift cannot dispatch and releases bridge before browser", async () => {
  const { manager, events, drift } = fixture();
  drift();
  await assert.rejects(manager.callTool("list_pages", {}), /declaration/);
  assert.equal(events.includes("call"), false);
  assert.deepEqual(events.slice(-2), ["bridge-stop", "browser-stop/profile-clean"]);
  await manager.dispose();
});

test("unconfirmed bridge close prevents browser/profile cleanup and blocks automatic startup retry", async () => {
  const { manager, events, failBridgeStop } = fixture();
  await manager.callTool("list_pages", {});
  failBridgeStop();
  await assert.rejects(manager.release(), /unconfirmed/);
  assert.equal(manager.status().phase, "failed");
  assert.equal(events.includes("browser-stop/profile-clean"), false);
  await assert.rejects(manager.callTool("list_pages", {}), /unconfirmed/);
  assert.equal(events.filter((event) => event === "runtime").length, 1);
  await assert.rejects(manager.dispose(), /unconfirmed/);
});

test("release refuses an executing tool; Host disposal aborts it before ordered teardown", async () => {
  const { manager, setCall, events } = fixture();
  const executing = deferred();
  setCall(async (_name, _args, signal) => {
    executing.resolve();
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  });
  const pending = manager.callTool("list_pages", {});
  const rejected = assert.rejects(pending, /disposing/);
  await executing.promise;
  await assert.rejects(manager.release(), /in-flight/);
  await manager.dispose();
  await rejected;
  assert.deepEqual(events.slice(-2), ["bridge-stop", "browser-stop/profile-clean"]);
});

test("uncooperative tool cannot authorize browser/profile deletion after a bounded shutdown", async () => {
  const { manager, setCall, events } = fixture({ shutdownTimeoutMs: 20 });
  const executing = deferred();
  const finish = deferred<Awaited<ReturnType<BrowserRealityToolClient["callTool"]>>>();
  setCall(async () => { executing.resolve(); return finish.promise; });
  const pending = manager.callTool("list_pages", {});
  await executing.promise;
  await assert.rejects(manager.dispose(), /not confirmed/);
  assert.equal(manager.status().phase, "failed");
  assert.equal(events.includes("browser-stop/profile-clean"), false);
  finish.resolve({ content: [] });
  await pending;
});

test("idle release fails closed on protection/unknown authority and releases once safe", async () => {
  let safe: boolean | null = false;
  const { manager, events } = fixture({ canRelease: () => {
    if (safe === null) throw new Error("authority unavailable");
    return safe;
  }, idleMs: 20 });
  await manager.callTool("list_pages", {});
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(manager.status().phase, "ready");
  safe = null;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(manager.status().phase, "ready");
  safe = true;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(manager.status().phase, "idle");
  assert.deepEqual(events.slice(-2), ["bridge-stop", "browser-stop/profile-clean"]);
  await manager.dispose();
});
