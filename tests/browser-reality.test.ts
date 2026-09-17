import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createBrowserRealityRuntime,
  registerBrowserRealityExtension,
  REQUIRED_BROWSER_TOOL_NAMES,
  resolveBrowserRealityConfig,
  type BrowserRealityStatus,
  type BrowserRealityToolClient,
} from "../src/browser-reality.ts";

function config() {
  return resolveBrowserRealityConfig({
    PINDIE_BROWSER_ENABLED: "true",
    PINDIE_BROWSER_URL: "http://127.0.0.1:9222",
  });
}

class BrowserExtensionHarness {
  readonly tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  readonly handlers = new Map<string, (...args: any[]) => any>();
  readonly notices: string[] = [];

  readonly api = {
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
      this.tools.set(tool.name, tool);
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      this.handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  context() {
    return {
      hasUI: true,
      ui: {
        notify: (message: string) => this.notices.push(message),
      },
    };
  }
}

function discoveredTools() {
  return REQUIRED_BROWSER_TOOL_NAMES.map((name) => ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
  }));
}

test("Browser Reality defaults on and preserves explicit boolean configuration", () => {
  assert.equal(resolveBrowserRealityConfig({}).enabled, true);
  assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_ENABLED: "false" }).enabled, false);
  for (const value of ["1", "true", "yes", "on"]) {
    assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_ENABLED: value }).enabled, true);
  }
});

test("explicitly disabled Browser Reality does not launch or probe Chrome", async () => {
  let probes = 0;
  let launches = 0;
  const runtime = createBrowserRealityRuntime(resolveBrowserRealityConfig({
    PINDIE_BROWSER_ENABLED: "false",
  }), {
    probe: async () => { probes += 1; return false; },
    launch: async () => { launches += 1; return { pid: 1 }; },
  });

  assert.deepEqual(await runtime.start(), {
    enabled: false,
    available: false,
    reason: null,
  });
  assert.equal(probes, 0);
  assert.equal(launches, 0);
  await runtime.dispose();
});

test("Browser Reality starts one dedicated browser and stops it idempotently", async () => {
  let probes = 0;
  let launches = 0;
  let stops = 0;
  const runtime = createBrowserRealityRuntime(config(), {
    probe: async () => ++probes >= 2,
    launch: async () => { launches += 1; return { pid: 42 }; },
    stop: async (browser) => { assert.equal(browser.pid, 42); stops += 1; },
    sleep: async () => {},
  });

  assert.deepEqual(await runtime.start(), {
    enabled: true,
    available: true,
    reason: null,
  });
  assert.equal(launches, 1);
  assert.equal((await runtime.status()).available, true);
  await Promise.all([runtime.dispose(), runtime.dispose()]);
  assert.equal(stops, 1);
});

test("Browser Reality refuses an occupied endpoint instead of attaching to an unknown profile", async () => {
  let launches = 0;
  const runtime = createBrowserRealityRuntime(config(), {
    probe: async () => true,
    launch: async () => { launches += 1; return { pid: 1 }; },
  });

  const status = await runtime.start();
  assert.equal(status.available, false);
  assert.match(status.reason ?? "", /refused to attach.*dedicated Dev Browser/i);
  assert.equal(launches, 0);
});

test("Browser launch failure remains a factual isolated runtime status", async () => {
  const runtime = createBrowserRealityRuntime(config(), {
    probe: async () => false,
    launch: async () => { throw new Error("Windows Chrome missing"); },
  });

  const status = await runtime.start();
  assert.equal(status.available, false);
  assert.match(status.reason ?? "", /could not start.*Windows Chrome missing/i);
  assert.deepEqual(await runtime.status(), status);
  await runtime.dispose();
});

test("Browser extension discovers and registers only the required Chrome DevTools tools", async () => {
  const harness = new BrowserExtensionHarness();
  let closes = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: BrowserRealityToolClient = {
    listAllTools: async () => [
      ...discoveredTools(),
      { name: "lighthouse_audit", inputSchema: { type: "object" } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "observed" }] };
    },
    close: async () => { closes += 1; },
  };
  const available: BrowserRealityStatus = {
    enabled: true,
    available: true,
    reason: null,
  };

  registerBrowserRealityExtension(harness.api, {
    config: config(),
    status: async () => available,
    createClient: () => client,
  });
  await harness.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    harness.context(),
  );

  assert.deepEqual(
    [...harness.tools.keys()].sort(),
    REQUIRED_BROWSER_TOOL_NAMES.map((name) => `browser_${name}`).sort(),
  );
  const result = await harness.tools.get("browser_evaluate_script")?.execute(
    "call",
    { function: "() => document.title", pageId: 1 },
    undefined,
  );
  assert.equal(result.content[0].text, "observed");
  assert.deepEqual(calls, [{
    name: "evaluate_script",
    args: { function: "() => document.title", pageId: 1 },
  }]);

  await harness.handlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "quit" },
    harness.context(),
  );
  assert.equal(closes, 1);
});

test("Browser extension isolates discovery failure and exposes the factual reason to the model", async () => {
  const harness = new BrowserExtensionHarness();
  let closes = 0;
  const client: BrowserRealityToolClient = {
    listAllTools: async () => { throw new Error("ECONNREFUSED"); },
    callTool: async () => ({ content: [] }),
    close: async () => { closes += 1; },
  };

  registerBrowserRealityExtension(harness.api, {
    config: config(),
    status: async () => ({ enabled: true, available: true, reason: null }),
    createClient: () => client,
  });
  await harness.handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    harness.context(),
  );

  assert.equal(harness.tools.size, 0);
  assert.equal(closes, 1);
  assert.match(harness.notices[0] ?? "", /Browser Reality unavailable.*ECONNREFUSED/);
  const result = await harness.handlers.get("before_agent_start")?.({
    type: "before_agent_start",
    systemPrompt: "base",
  }, harness.context());
  assert.match(result.systemPrompt, /Browser Reality is enabled but unavailable.*ECONNREFUSED/);
});
