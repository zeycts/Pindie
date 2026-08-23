import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseCli,
  runOwnedSmoke,
  scavengeStaleWorkspaces,
  smokeRoot,
} from "../scripts/pi-smoke.ts";

const skipWindows = process.platform === "win32";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pindie-pi-smoke-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("EH02 successful child removes only its owned workspace", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const result = await runOwnedSmoke({ label: "success", command: process.execPath, args: ["-e", "console.log('ok')"], baseTempDir: root });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await exists(result.workspace), false);
  assert.match(result.stdoutTail, /ok/);
});

test("EH03 non-zero child preserves its meaningful result and cleans workspace", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const result = await runOwnedSmoke({ label: "failure", command: process.execPath, args: ["-e", "process.exit(17)"], baseTempDir: root });

  assert.equal(result.exitCode, 17);
  assert.equal(result.timedOut, false);
  assert.equal(await exists(result.workspace), false);
});

test("EH04 timeout terminates the owned child and removes workspace", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const result = await runOwnedSmoke({ label: "timeout", command: process.execPath, args: ["-e", "setInterval(() => {}, 1_000)"], timeoutMs: 50, baseTempDir: root });

  assert.equal(result.timedOut, true);
  assert.equal(await exists(result.workspace), false);
});

test("EH05 timeout kills the spawn-owned descendant group without touching this test process", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const pidFile = join(root, "descendant.pid");
  const termFile = join(root, "descendant-ignored-term");
  const descendantProgram = `const { writeFileSync } = require('node:fs'); process.on('SIGTERM', () => writeFileSync(process.env.DESCENDANT_TERM_FILE, 'ignored')); setInterval(() => {}, 1000);`;
  const program = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', process.env.DESCENDANT_PROGRAM], { stdio: 'ignore', env: process.env }); writeFileSync(process.env.DESCENDANT_PID_FILE, String(child.pid)); setInterval(() => {}, 1000);`;
  const result = await runOwnedSmoke({
    label: "descendant",
    command: process.execPath,
    args: ["-e", program],
    timeoutMs: 300,
    baseTempDir: root,
    env: { DESCENDANT_PID_FILE: pidFile, DESCENDANT_TERM_FILE: termFile, DESCENDANT_PROGRAM: descendantProgram },
  });
  const descendantPid = Number(await (await import("node:fs/promises")).readFile(pidFile, "utf8"));

  assert.equal(result.timedOut, true);
  assert.equal(await exists(termFile), true);
  await waitUntil(() => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
    }
  });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.equal(await exists(result.workspace), false);
});

test("EH06 keep-artifacts preserves only files after timeout cleanup", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const result = await runOwnedSmoke({ label: "keep", command: process.execPath, args: ["-e", "setInterval(() => {}, 1_000)"], timeoutMs: 50, baseTempDir: root, keepArtifacts: true });

  assert.equal(result.timedOut, true);
  assert.equal(result.retainedWorkspace, result.workspace);
  assert.equal(await exists(result.workspace), true);
  await rm(result.workspace, { recursive: true, force: true });
});

test("EH07 concurrent invocation cleanup cannot remove a sibling workspace", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const ready = join(root, "sibling-ready");
  const siblingProgram = `require('node:fs').writeFileSync(process.env.READY_FILE, 'ready'); setTimeout(() => {}, 250);`;
  const siblingPromise = runOwnedSmoke({
    label: "sibling", command: process.execPath, args: ["-e", siblingProgram], baseTempDir: root,
    keepArtifacts: true, env: { READY_FILE: ready },
  });
  await waitUntil(() => existsSync(ready));
  const cleaned = await runOwnedSmoke({ label: "cleaned", command: process.execPath, args: ["-e", ""], baseTempDir: root });
  const sibling = await siblingPromise;

  assert.notEqual(sibling.workspace, cleaned.workspace);
  assert.equal(await exists(cleaned.workspace), false);
  assert.equal(await exists(sibling.workspace), true);
  await rm(sibling.workspace, { recursive: true, force: true });
});

test("EH08-EH09 stale scavenging is age- and namespace-bound", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const smoke = smokeRoot(root);
  const oldWorkspace = join(smoke, "old-ABC123");
  const freshWorkspace = join(smoke, "fresh-ABC123");
  const foreignFile = join(root, "pi-bash-example.log");
  const foreignDirectory = join(root, "chrome-example");
  const mcpDirectory = join(root, "mcp-example");
  const unrelated = join(root, "another-unrelated-directory");
  await Promise.all([mkdir(oldWorkspace, { recursive: true }), mkdir(freshWorkspace, { recursive: true }), mkdir(foreignDirectory), mkdir(mcpDirectory), mkdir(unrelated), writeFile(foreignFile, "foreign")]);
  const linkedWorkspace = join(smoke, "linked-ABC123");
  await symlink(unrelated, linkedWorkspace);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(oldWorkspace, old, old);

  await scavengeStaleWorkspaces({ baseTempDir: root, now: () => Date.now() });

  assert.equal(await exists(oldWorkspace), false);
  assert.equal(await exists(freshWorkspace), true);
  for (const foreign of [foreignFile, foreignDirectory, mcpDirectory, unrelated, linkedWorkspace]) assert.equal(await exists(foreign), true);
});

test("namespace root symlink fails closed without touching its foreign target", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const smoke = smokeRoot(root);
  const pindieRoot = join(smoke, "..");
  const foreign = join(root, "foreign-root");
  const foreignChild = join(foreign, "old-workspace");
  await mkdir(foreign, { recursive: true });
  await writeFile(foreignChild, "foreign");
  await symlink(foreign, pindieRoot);

  await assert.rejects(scavengeStaleWorkspaces({ baseTempDir: root }), /real directory/i);
  assert.equal(await exists(foreignChild), true);
});

test("smoke root symlink fails closed without touching its foreign target", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  const smoke = smokeRoot(root);
  const foreign = join(root, "foreign-smoke");
  const foreignChild = join(foreign, "old-workspace");
  await mkdir(join(smoke, ".."), { recursive: true });
  await mkdir(foreign, { recursive: true });
  await writeFile(foreignChild, "foreign");
  await symlink(foreign, smoke);

  await assert.rejects(scavengeStaleWorkspaces({ baseTempDir: root }), /real directory/i);
  assert.equal(await exists(foreignChild), true);
});

test("keep-artifacts spawn failure cleans the unreported workspace", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    runOwnedSmoke({ label: "spawn-failure", command: "pindie-command-that-does-not-exist", baseTempDir: root, keepArtifacts: true }),
  );
  assert.deepEqual(await readdir(smokeRoot(root)), []);
});

test("CLI accepts pnpm's leading separator and rejects invalid input", () => {
  assert.deepEqual(parseCli(["--", "local", "--timeout-ms", "10", "--", "node", "-e", ""]), {
    label: "local", timeoutMs: 10, command: "node", args: ["-e", ""],
  });
  assert.throws(() => parseCli(["local", "--timeout-ms", "0", "--", "node"]), /positive finite integer/i);
  assert.throws(() => parseCli(["local", "--"]), /command is required/i);
});

test("EH10 invalid labels are rejected before any owned namespace is created", { skip: skipWindows }, async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    runOwnedSmoke({ label: "../escape", command: process.execPath, args: ["-e", ""], baseTempDir: root }),
    /label/i,
  );
  assert.equal(await exists(smokeRoot(root)), false);
});
