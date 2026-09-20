import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBrowserRealityHost,
  createLinuxBrowserRealityHost,
  detectBrowserRealityPlatform,
  resolveLinuxBrowserExecutable,
} from "../src/browser-reality-host.ts";

test("platform detection distinguishes WSL signals from native Linux", () => {
  assert.equal(detectBrowserRealityPlatform({
    platform: "linux", release: "6.8.0-generic", env: { WSL_DISTRO_NAME: "Ubuntu" },
  }), "wsl-windows");
  assert.equal(detectBrowserRealityPlatform({
    platform: "linux", release: "6.8.0-generic", env: { WSL_INTEROP: "/run/WSL/1_interop" },
  }), "wsl-windows");
  assert.equal(detectBrowserRealityPlatform({
    platform: "linux", release: "5.15.146.1-Microsoft-standard-WSL2", env: {},
  }), "wsl-windows");
  assert.equal(detectBrowserRealityPlatform({
    platform: "linux", release: "6.8.0-85-generic", env: {},
  }), "linux");
});

test("WSL selects the existing PowerShell/Windows Host implementation", () => {
  assert.equal(createBrowserRealityHost("wsl-windows").platform, "wsl-windows");
  assert.equal(createBrowserRealityHost("linux").platform, "linux");
});

test("Linux allocates a dynamic loopback port", async () => {
  const port = await createLinuxBrowserRealityHost().allocatePort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0 && port <= 65_535, true);
});

test("Linux creates unique cache profiles and removes owned profiles", async () => {
  const home = await mkdtemp(join(tmpdir(), "pindie-browser-home-"));
  const host = createLinuxBrowserRealityHost({ env: {}, homeDirectory: home });
  const first = await host.allocateProfileDirectory("runtime-a");
  const second = await host.allocateProfileDirectory("runtime-b");

  assert.equal(first, join(home, ".cache", "pindie", "dev-browser", "runtime-a"));
  assert.equal(second, join(home, ".cache", "pindie", "dev-browser", "runtime-b"));
  assert.notEqual(first, second);
  assert.equal((await stat(first)).isDirectory(), true);
  await host.cleanupProfile(first);
  await assert.rejects(stat(first), { code: "ENOENT" });
  await host.cleanupProfile(second);
  await host.cleanupProfile(home);
});

test("Linux executable resolution prefers an explicit override", async () => {
  const checked: string[] = [];
  const resolved = await resolveLinuxBrowserExecutable(
    "custom-chrome",
    { PATH: "/first:/second" },
    async (path) => {
      checked.push(String(path));
      if (path !== "/second/custom-chrome") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  );
  assert.equal(resolved, "/second/custom-chrome");
  assert.deepEqual(checked, ["/first/custom-chrome", "/second/custom-chrome"]);
});

test("Linux executable resolution scans supported PATH candidates", async () => {
  const resolved = await resolveLinuxBrowserExecutable(undefined, { PATH: "/bin:/opt/bin" }, async (path) => {
    if (path !== "/opt/bin/chromium") throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  assert.equal(resolved, "/opt/bin/chromium");
});

test("Linux executable resolution reports a clear factual failure", async () => {
  await assert.rejects(
    resolveLinuxBrowserExecutable(undefined, { PATH: "/empty" }, async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    /No supported Chrome\/Chromium executable was found.*PINDIE_BROWSER_EXECUTABLE/s,
  );
});

test("Linux launch passes loopback-only unquoted arguments to spawn", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.pid = 321;
  child.kill = () => true;
  const host = createLinuxBrowserRealityHost({
    env: { PATH: "/bin" },
    access: async () => {},
    spawn: ((executable: string, args: readonly string[], options: unknown) => {
      calls.push({ executable, args, options });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as never,
  });

  const browser = await host.launch({
    browserUrl: "http://127.0.0.1:43123",
    chromeExecutable: "/opt/chrome",
    profileDirectory: "/home/dev/cache profile",
    headless: true,
  });

  assert.equal(browser.pid, 321);
  assert.equal(calls[0]?.executable, "/opt/chrome");
  assert.deepEqual(calls[0]?.args, [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=43123",
    "--user-data-dir=/home/dev/cache profile",
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ]);
});

test("Linux stop tolerates an already-dead browser process", async () => {
  const host = createLinuxBrowserRealityHost();
  await host.stop({
    pid: 999,
    process: {
      kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    } as never,
  });
});
