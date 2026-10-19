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

function processStat(pid: number, group = pid, state = "S", started = "123"): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[2] = String(group);
  fields[3] = String(group);
  fields[19] = started;
  return `${pid} (browser (test)) ${fields.join(" ")}`;
}

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
    readFile: (async () => processStat(321)) as never,
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
  assert.deepEqual(calls[0]?.options, { stdio: "ignore", detached: true, env: { PATH: "/bin" } });
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

async function groupFixture(onSignal: (signal: string | number | undefined, members: Map<number, string>) => void) {
  const members = new Map([[321, processStat(321)], [322, processStat(322, 321)]]);
  const signals: Array<[number, string | number | undefined]> = [];
  const child = Object.assign(new EventEmitter(), { pid: 321 });
  const host = createLinuxBrowserRealityHost({
    access: async () => {},
    spawn: (() => { queueMicrotask(() => child.emit("spawn")); return child; }) as never,
    readFile: (async (path: string) => {
      const content = members.get(Number(path.split("/")[2]));
      if (!content) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return content;
    }) as never,
    kill: (pid, signal) => {
      if (signal === 0) {
        if (members.size === 0) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
        return true;
      }
      signals.push([pid, signal]); onSignal(signal, members); return true;
    },
    stopGracePeriodMs: 5,
    forceKillWaitMs: 5,
  });
  const browser = await host.launch({ browserUrl: "http://127.0.0.1:9999", profileDirectory: "/isolated", headless: true });
  return { host, browser, members, signals, child };
}

test("Linux group stop waits for descendants even after the direct child exits", async () => {
  const fixture = await groupFixture((signal, members) => {
    members.delete(321);
    if (signal === "SIGKILL") members.delete(322);
  });
  fixture.child.emit("exit", 0);
  await fixture.host.stop(fixture.browser);
  assert.deepEqual(fixture.signals, [[-321, "SIGTERM"], [-321, "SIGKILL"]]);
  await fixture.host.stop(fixture.browser);
  assert.equal(fixture.signals.length, 2);
});

test("Linux group stop tolerates kernel-confirmed absence but never treats a zombie-only snapshot as proof", async () => {
  const fixture = await groupFixture(() => {});
  fixture.members.delete(321);
  fixture.members.set(322, processStat(322, 321, "Z"));
  await assert.rejects(fixture.host.stop(fixture.browser), /did not stop after SIGKILL/);
  fixture.members.clear();
  await fixture.host.stop(fixture.browser);
  assert.equal(fixture.signals.length, 2);
});

test("Linux group stop refuses foreign handles and PID reuse without signaling", async () => {
  const fixture = await groupFixture(() => {});
  await assert.rejects(fixture.host.stop({ pid: 321 }), /not launched by this Host/);
  fixture.members.set(321, processStat(321, 321, "S", "456"));
  await assert.rejects(fixture.host.stop(fixture.browser), /identity changed/);
  assert.deepEqual(fixture.signals, []);
});

test("Linux group stop is bounded and does not claim termination from child exit alone", async () => {
  const fixture = await groupFixture(() => {});
  fixture.child.emit("exit", 0);
  const start = Date.now();
  await assert.rejects(fixture.host.stop(fixture.browser), /did not stop after SIGKILL/);
  assert.equal(Date.now() - start < 500, true);
  assert.deepEqual(fixture.signals, [[-321, "SIGTERM"], [-321, "SIGKILL"]]);
});
