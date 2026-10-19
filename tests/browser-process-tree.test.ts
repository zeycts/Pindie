import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLinuxBrowserRealityHost } from "../src/browser-reality-host.ts";

test("Linux teardown stops the owned real process group after its leader exits", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-owned-group-"));
  const executable = join(root, "inert-browser");
  const marker = join(root, "descendant");
  await writeFile(executable, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => writeFileSync(${JSON.stringify(marker)}, String(child.pid)));
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o700);
  const host = createLinuxBrowserRealityHost({ stopGracePeriodMs: 50, forceKillWaitMs: 1_000 });
  let browser: Awaited<ReturnType<typeof host.launch>> | undefined;
  try {
    browser = await host.launch({ browserUrl: "http://127.0.0.1:9999", profileDirectory: root, chromeExecutable: executable, headless: true });
    let descendant = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { descendant = Number(await readFile(marker, "utf8")); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.ok(descendant > 0, "inert descendant reached ready state");
    await host.stop(browser);
    // Zombies can briefly remain under an external reaper; they hold no profile
    // handles and cannot execute. No unrelated process is signaled or removed.
    for (const pid of [browser.pid, descendant]) {
      try {
        const text = await readFile(`/proc/${pid}/stat`, "utf8");
        assert.match(text.slice(text.lastIndexOf(")") + 2), /^[ZX] /u);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } finally {
    if (browser) await host.stop(browser);
    await rm(root, { recursive: true, force: true });
  }
});
