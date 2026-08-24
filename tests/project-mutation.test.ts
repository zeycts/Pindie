import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildProjectFingerprintArgv,
  captureProjectFingerprint,
  runProjectFingerprintGit,
  type ProjectFingerprintInvocation,
} from "../src/project-mutation.ts";

const execFile = promisify(execFileCallback);

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pindie-pmf-"));
  await execFile("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "a.ts"), "export const a = 'A';\n");
  await execFile("git", ["add", "a.ts"], { cwd: dir });
  await execFile("git", ["-c", "user.name=Pindie Test", "-c", "user.email=pindie@example.invalid", "commit", "-qm", "initial"], { cwd: dir });
  return dir;
}

async function known(dir: string) {
  const result = await captureProjectFingerprint(dir);
  assert.equal(result.kind, "known", result.kind === "unknown" ? result.reason : "");
  return result.digest;
}

test("PMF-F01-F06 Git-visible content is stable and detects tracked and untracked changes", async () => {
  const dir = await repo();
  try {
    const first = await known(dir);
    assert.equal(await known(dir), first);
    await writeFile(join(dir, "a.ts"), "export const a = 'B';\n");
    assert.notEqual(await known(dir), first);
    await unlink(join(dir, "a.ts"));
    assert.notEqual(await known(dir), first);
    await writeFile(join(dir, "untracked.ts"), "one\n");
    const untracked = await known(dir);
    await writeFile(join(dir, "untracked.ts"), "two\n");
    assert.notEqual(await known(dir), untracked);
    await unlink(join(dir, "untracked.ts"));
    assert.notEqual(await known(dir), untracked);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PMF-F07-F10 ignored, staging, commits, and mtime metadata are normalized", async () => {
  const dir = await repo();
  try {
    await writeFile(join(dir, ".gitignore"), "coverage/\n");
    await execFile("git", ["add", ".gitignore"], { cwd: dir });
    await execFile("git", ["-c", "user.name=Pindie Test", "-c", "user.email=pindie@example.invalid", "commit", "-qm", "ignore"], { cwd: dir });
    const first = await known(dir);
    await mkdir(join(dir, "coverage"));
    await writeFile(join(dir, "coverage", "result.json"), "one");
    assert.equal(await known(dir), first);
    await writeFile(join(dir, "new.ts"), "new\n");
    const untracked = await known(dir);
    await execFile("git", ["add", "new.ts"], { cwd: dir });
    assert.equal(await known(dir), untracked);
    await execFile("git", ["-c", "user.name=Pindie Test", "-c", "user.email=pindie@example.invalid", "commit", "-qm", "new"], { cwd: dir });
    assert.equal(await known(dir), untracked);
    await utimes(join(dir, "new.ts"), new Date(), new Date());
    assert.equal(await known(dir), untracked);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PMF-F11-F13 executable modes and symlink target text participate without following links", { skip: process.platform === "win32" }, async () => {
  const dir = await repo();
  const outside = await mkdtemp(join(tmpdir(), "pindie-pmf-outside-"));
  try {
    const first = await known(dir);
    await chmod(join(dir, "a.ts"), 0o755);
    assert.notEqual(await known(dir), first);
    await writeFile(join(outside, "target"), "outside A");
    await symlink(join(outside, "target"), join(dir, "link"));
    const link = await known(dir);
    await writeFile(join(outside, "target"), "outside B");
    assert.equal(await known(dir), link);
    await unlink(join(dir, "link"));
    await symlink("different-target", join(dir, "link"));
    assert.notEqual(await known(dir), link);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("PMF-F14 non-Git projects and unsafe or oversized enumeration fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pindie-pmf-plain-"));
  try {
    assert.equal((await captureProjectFingerprint(dir)).kind, "unknown");
    for (const output of [Buffer.from("../outside\0"), Buffer.from("/absolute\0")]) {
      assert.equal((await captureProjectFingerprint(dir, { runner: async () => output })).kind, "unknown");
    }
    assert.equal((await captureProjectFingerprint(dir, { maxPaths: 1, runner: async () => Buffer.from("a\0b\0") })).kind, "unknown");
    assert.equal((await captureProjectFingerprint(dir, { maxPathListBytes: 2, runner: async () => Buffer.from("abc\0") })).kind, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PMF-F26 invalid UTF-8 Git path bytes fail closed while valid Unicode paths remain known", { skip: process.platform === "win32" }, async () => {
  const dir = await repo();
  try {
    const invalid = await captureProjectFingerprint(dir, { runner: async () => Buffer.from([0xff, 0x00]) });
    assert.equal(invalid.kind, "unknown");
    await writeFile(join(dir, "测试-é.ts"), "unicode\n");
    assert.equal((await captureProjectFingerprint(dir)).kind, "known");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PMF-F24 timeout terminates the Git child and capture fails closed", async () => {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const signals: string[] = [];
  child.kill = (signal: string) => {
    signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => child.emit("close", null));
    return true;
  };
  const invocation: ProjectFingerprintInvocation = {
    executable: "git", argv: buildProjectFingerprintArgv(), cwd: process.cwd(), env: process.env,
    shell: false, timeoutMs: 1, maxOutputBytes: 64,
  };
  await assert.rejects(runProjectFingerprintGit(invocation, (() => child) as any), /timed out/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  const dir = await mkdtemp(join(tmpdir(), "pindie-pmf-timeout-"));
  try {
    const result = await captureProjectFingerprint(dir, { runner: async () => { throw new Error("timeout"); } });
    assert.equal(result.kind, "unknown");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PMF-F15-F19 framing is deterministic and Git invocation is fixed and hardened", async () => {
  const dir = await repo();
  const calls: ProjectFingerprintInvocation[] = [];
  try {
    const runner = async (call: ProjectFingerprintInvocation) => { calls.push(call); return Buffer.from("b\0a.ts\0"); };
    const result = await captureProjectFingerprint(dir, { runner });
    assert.equal(result.kind, "known");
    assert.deepEqual(calls[0]?.argv, buildProjectFingerprintArgv());
    assert.equal(calls[0]?.executable, "git");
    assert.equal(calls[0]?.shell, false);
    assert.equal(calls[0]?.cwd, dir);
    assert.equal(calls[0]?.env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(calls[0]?.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(calls[0]?.env.GIT_PAGER, "cat");
    assert.equal(calls[0]?.env.PAGER, "cat");
    assert.equal(calls[0]?.env.GIT_TERMINAL_PROMPT, "0");
    assert.deepEqual(calls[0]?.argv.slice(0, 5), ["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
