import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createNativeInteractiveRuntime } from "../src/native-interactive-runtime.ts";

test("native runtime facade preserves getter/method receivers and live Session changes", async () => {
  class Runtime {
    #session = { id: 1 };
    get session() { return this.#session; }
    replace() { this.#session = { id: 2 }; }
    disposeCalls = 0;
    async dispose() { this.disposeCalls++; }
  }
  const original = new Runtime();
  let hostDisposals = 0;
  const facade = createNativeInteractiveRuntime(original as unknown as AgentSessionRuntime, async () => {
    hostDisposals++;
    await original.dispose();
  }) as unknown as Runtime;
  assert.equal(facade.session, original.session);
  const replace = facade.replace;
  replace();
  assert.equal(facade.session.id, 2);
  await facade.dispose();
  assert.equal(hostDisposals, 1);
  assert.equal(original.disposeCalls, 1);
});

for (const signal of ["SIGTERM", "SIGHUP"]) {
  test(`pinned Pi ${signal} handler reaches awaited Host disposal before real exit`, { skip: process.platform === "win32" }, () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { writeSync } from "node:fs";
      import { InteractiveMode } from "@earendil-works/pi-coding-agent";
      import { createNativeInteractiveRuntime } from "./src/native-interactive-runtime.ts";
      const log = text => writeSync(1, text + "\\n");
      const runtime = { dispose: async () => log("native-disposed") };
      const mode = Object.create(InteractiveMode.prototype);
      mode.signalCleanupHandlers = [];
      mode.runtimeHost = createNativeInteractiveRuntime(runtime, async () => {
        log("host-start");
        await new Promise(resolve => setTimeout(resolve, 20));
        await runtime.dispose();
        log("host-complete");
      });
      mode.themeController = { disableAutoSync: () => {} };
      mode.ui = { terminal: { drainInput: async () => {} } };
      mode.stop = () => mode.unregisterSignalHandlers();
      mode.registerSignalHandlers();
      setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 0);
      setInterval(() => {}, 1000);
    `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.deepEqual(result.stdout.trim().split("\n"), ["host-start", "native-disposed", "host-complete"]);
  });
}

test("pinned Pi emergency terminal exit bypasses async disposal (no stale-cleanup claim)", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { writeSync } from "node:fs";
    import { InteractiveMode } from "@earendil-works/pi-coding-agent";
    const mode = Object.create(InteractiveMode.prototype);
    mode.signalCleanupHandlers = [];
    mode.runtimeHost = { dispose: async () => writeSync(1, "unexpected-disposal") };
    mode.emergencyTerminalExit();
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 129, result.stderr);
  assert.equal(result.stdout, "");
});

for (const fromSignal of [false, true]) {
  test(`pinned Pi native shutdown awaits Host-disposal facade before actual subprocess exit (signal=${fromSignal})`, () => {
    // Execute Pi's actual unmodified shutdown implementation. Only the terminal
    // and Session are inert fixtures; process.exit is real and never patched.
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { writeSync } from "node:fs";
      import { InteractiveMode } from "@earendil-works/pi-coding-agent";
      import { createNativeInteractiveRuntime } from "./src/native-interactive-runtime.ts";
      const log = (text) => writeSync(1, text + "\\n");
      const runtime = { session: { sessionManager: {} }, dispose: async () => log("native-disposed") };
      const facade = createNativeInteractiveRuntime(runtime, async () => {
        log("host-dispose-start");
        await new Promise(resolve => setTimeout(resolve, 20));
        await runtime.dispose();
        log("host-dispose-complete");
      });
      const mode = Object.create(InteractiveMode.prototype);
      mode.runtimeHost = facade;
      mode.themeController = { disableAutoSync: () => log("theme-stop") };
      mode.ui = { terminal: { drainInput: async () => log("terminal-drain") } };
      mode.stop = () => log("tui-stop");
      await mode.shutdown({ fromSignal: ${fromSignal} });
      throw new Error("Pi shutdown returned instead of exiting");
    `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), fromSignal
      ? ["host-dispose-start", "native-disposed", "host-dispose-complete", "theme-stop", "terminal-drain", "tui-stop"]
      : ["theme-stop", "terminal-drain", "tui-stop", "host-dispose-start", "native-disposed", "host-dispose-complete"]);
  });
}
