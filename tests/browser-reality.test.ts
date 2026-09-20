import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildBrowserLaunchArguments,
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
    PINDIE_BROWSER_PROFILE_DIR: "C:\\Pindie\\explicit-profile",
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

test("Browser Reality defaults on and headless without a fixed endpoint or shared profile", () => {
  const defaults = resolveBrowserRealityConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.headless, true);
  assert.equal(defaults.browserUrl, undefined);
  assert.equal(defaults.profileDirectory, undefined);
  assert.equal(defaults.chromeExecutable, undefined);
  assert.equal(resolveBrowserRealityConfig({
    PINDIE_BROWSER_EXECUTABLE: "/opt/chrome",
  }).chromeExecutable, "/opt/chrome");
  assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_ENABLED: "false" }).enabled, false);
  for (const value of ["1", "true", "yes", "on"]) {
    assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_ENABLED: value }).enabled, true);
  }
  assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_HEADLESS: "true" }).headless, true);
  assert.equal(resolveBrowserRealityConfig({ PINDIE_BROWSER_HEADLESS: "false" }).headless, false);
});

test("default launch arguments are headless and the explicit headful override omits it", () => {
  const launchConfig = {
    PINDIE_BROWSER_URL: "http://127.0.0.1:43123",
    PINDIE_BROWSER_PROFILE_DIR: "C:\\Pindie\\runtime",
  };
  const defaultArguments = buildBrowserLaunchArguments(resolveBrowserRealityConfig(launchConfig));
  const headfulArguments = buildBrowserLaunchArguments(resolveBrowserRealityConfig({
    ...launchConfig,
    PINDIE_BROWSER_HEADLESS: "false",
  }));

  assert.equal(defaultArguments.includes("--headless"), true);
  assert.equal(headfulArguments.includes("--headless"), false);
  assert.equal(defaultArguments.includes("--remote-debugging-address=127.0.0.1"), true);
  assert.equal(defaultArguments.includes("--remote-debugging-port=43123"), true);
  assert.equal(headfulArguments.includes("--remote-debugging-port=43123"), true);
  assert.equal(defaultArguments.includes("--user-data-dir=C:\\Pindie\\runtime"), true);
  assert.equal(headfulArguments.includes("--user-data-dir=C:\\Pindie\\runtime"), true);
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

test("two default runtimes allocate independent endpoints and profiles and clean only themselves", async () => {
  const active = new Set<string>();
  const urlsByPid = new Map<number, string>();
  const stopped: number[] = [];
  const cleaned: string[] = [];
  const ports = [41_001, 41_002];
  let nextPid = 100;
  const makeRuntime = (label: string) => createBrowserRealityRuntime(
    resolveBrowserRealityConfig({}),
    {
      allocatePort: async () => ports.shift()!,
      allocateProfileDirectory: async (runtimeId) => `C:\\Pindie\\${label}-${runtimeId}`,
      probe: async (url) => active.has(url),
      launch: async (runtimeConfig) => {
        const pid = nextPid++;
        active.add(runtimeConfig.browserUrl);
        urlsByPid.set(pid, runtimeConfig.browserUrl);
        return { pid };
      },
      stop: async (browser) => {
        stopped.push(browser.pid);
        active.delete(urlsByPid.get(browser.pid)!);
      },
      cleanupProfile: async (profileDirectory) => { cleaned.push(profileDirectory); },
      sleep: async () => {},
    },
  );
  const runtimeA = makeRuntime("A");
  const runtimeB = makeRuntime("B");

  assert.equal((await runtimeA.start()).available, true);
  assert.equal((await runtimeB.start()).available, true);
  assert.equal(runtimeA.config.browserUrl, "http://127.0.0.1:41001");
  assert.equal(runtimeB.config.browserUrl, "http://127.0.0.1:41002");
  assert.notEqual(runtimeA.config.profileDirectory, runtimeB.config.profileDirectory);

  await runtimeA.dispose();
  assert.deepEqual(stopped, [100]);
  assert.deepEqual(cleaned, [runtimeA.config.profileDirectory]);
  assert.equal((await runtimeB.status()).available, true);

  await runtimeB.dispose();
  assert.deepEqual(stopped, [100, 101]);
  assert.deepEqual(cleaned, [
    runtimeA.config.profileDirectory,
    runtimeB.config.profileDirectory,
  ]);
});

test("occupied 9222 does not affect default allocation and an allocation race retries once", async () => {
  const probed: string[] = [];
  const launched: string[] = [];
  const allocatedPorts = [42_001, 42_002];
  const runtime = createBrowserRealityRuntime(resolveBrowserRealityConfig({}), {
    allocatePort: async () => allocatedPorts.shift()!,
    allocateProfileDirectory: async () => "C:\\Pindie\\runtime",
    probe: async (url) => {
      probed.push(url);
      return url === "http://127.0.0.1:9222" ||
        url === "http://127.0.0.1:42001" ||
        launched.includes(url);
    },
    launch: async (runtimeConfig) => {
      launched.push(runtimeConfig.browserUrl);
      return { pid: 200 };
    },
    stop: async () => {},
    cleanupProfile: async () => {},
    sleep: async () => {},
  });

  assert.equal((await runtime.start()).available, true);
  assert.equal(runtime.config.browserUrl, "http://127.0.0.1:42002");
  assert.deepEqual(launched, ["http://127.0.0.1:42002"]);
  assert.equal(probed.includes("http://127.0.0.1:9222"), false);
  await runtime.dispose();
});

test("an explicit developer-managed profile is never cleaned", async () => {
  let cleanups = 0;
  const runtime = createBrowserRealityRuntime(config(), {
    probe: async (url) => url === config().browserUrl,
    launch: async () => ({ pid: 41 }),
    stop: async () => {},
    cleanupProfile: async () => { cleanups += 1; },
  });

  assert.equal((await runtime.start()).available, false);
  await runtime.dispose();
  assert.equal(cleanups, 0);
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

test("startup retry waits for the previous browser to stop before reusing its profile", async () => {
  let launches = 0;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const runtime = createBrowserRealityRuntime(resolveBrowserRealityConfig({}), {
    allocatePort: async () => 43_123 + launches,
    allocateProfileDirectory: async () => "/tmp/pindie-shared-retry-profile",
    probe: async () => launches === 2,
    launch: async () => ({ pid: ++launches }),
    stop: async () => stopped,
    cleanupProfile: async () => {},
    sleep: async () => {},
    now: (() => {
      const values = [0, 0, 10_001, 10_001, 10_001];
      return () => values.shift() ?? 10_001;
    })(),
  });

  const starting = runtime.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(launches, 1);
  resolveStop();
  assert.equal((await starting).available, true);
  assert.equal(launches, 2);
  await runtime.dispose();
});

test("startup does not retry or clean its profile when browser stop is unconfirmed", async () => {
  let launches = 0;
  let cleanups = 0;
  const runtime = createBrowserRealityRuntime(resolveBrowserRealityConfig({}), {
    allocatePort: async () => 43_123 + launches,
    allocateProfileDirectory: async () => "/tmp/pindie-uncertain-stop-profile",
    probe: async () => false,
    launch: async () => ({ pid: ++launches }),
    stop: async () => { throw new Error("process still running"); },
    cleanupProfile: async () => { cleanups += 1; },
    sleep: async () => {},
    now: (() => {
      const values = [0, 10_001];
      return () => values.shift() ?? 10_001;
    })(),
  });

  const status = await runtime.start();
  assert.equal(status.available, false);
  assert.match(status.reason ?? "", /could not be stopped.*process still running/i);
  assert.equal(launches, 1);
  assert.equal(cleanups, 0);
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
