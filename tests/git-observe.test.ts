import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

import {
  BoundedOutput,
  GIT_OBSERVE_ACTIONS,
  GIT_OBSERVE_MAX_OUTPUT_BYTES,
  GIT_OBSERVE_MAX_OUTPUT_LINES,
  buildGitObserveArgv,
  createPindieGitObserveTool,
  runGitObservation,
  safeGitEnvironment,
  type GitObservationInvocation,
} from "../src/tools/git-observe.ts";

const execFile = promisify(execFileCallback);
const ctx = { cwd: process.cwd() } as any;

function fakeTool() {
  const calls: GitObservationInvocation[] = [];
  const tool = createPindieGitObserveTool({
    runner: async (call) => { calls.push(call); return { stdout: "observed\n", stderr: "", truncated: false }; },
  });
  return { tool, calls };
}

async function execute(tool: any, params: any, cwd = process.cwd()) {
  return tool.execute("call", params, undefined, undefined, { cwd });
}

function text(result: any): string { return result.content[0].text; }

test("SO-T01-T02 exposes exactly the fixed action and parameter surface", () => {
  const { tool } = fakeTool();
  assert.deepEqual(GIT_OBSERVE_ACTIONS, [
    "status", "branch", "root", "diff", "diff_cached", "diff_check", "log", "remote",
  ]);
  assert.ok(!GIT_OBSERVE_ACTIONS.some((action) => ["ls_remote", "fetch", "pr", "checks", "reviews"].includes(action)));
  assert.deepEqual(tool.parameters.properties.action.enum, GIT_OBSERVE_ACTIONS);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["action", "limit", "paths"]);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /command|args|flags|env|cwd|shell|executable/i);
});

test("SO-T03-T05 fixed status, branch, root, remote, and log argv", async () => {
  const { tool, calls } = fakeTool();
  for (const action of ["status", "branch", "root", "remote", "log"] as const) await execute(tool, { action });
  const safe = ["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false"];
  assert.deepEqual(calls.map((call) => call.argv), [
    [...safe, "status", "--short", "--branch"],
    [...safe, "branch", "--show-current"],
    [...safe, "rev-parse", "--show-toplevel"],
    [...safe, "remote", "-v"],
    [...safe, "log", "--oneline", "--decorate", "--max-count=10"],
  ]);
  await execute(tool, { action: "log", limit: 1 });
  await execute(tool, { action: "log", limit: 50 });
  assert.match(calls.at(-2)!.argv.join(" "), /--max-count=1$/);
  assert.match(calls.at(-1)!.argv.join(" "), /--max-count=50$/);
  for (const limit of [0, 51, 1.5]) assert.throws(() => buildGitObserveArgv({ action: "log", limit }), /integer from 1 to 50/);
});

test("SO-T06-T10 limits paths and uses safe diff argv", () => {
  for (const action of ["status", "branch", "log"] as const) {
    assert.throws(() => buildGitObserveArgv({ action, paths: ["src/a.ts"] }), /paths are allowed only/);
  }
  for (const action of ["status", "diff"] as const) {
    assert.throws(() => buildGitObserveArgv({ action, limit: 2 }), /limit is allowed only/);
  }
  for (const action of ["diff", "diff_cached", "diff_check"] as const) {
    const argv = buildGitObserveArgv({ action, paths: ["--output=hacked", "src/a.ts"] });
    assert.ok(argv.includes("--no-ext-diff"));
    assert.ok(argv.includes("--no-textconv"));
    assert.deepEqual(argv.slice(argv.indexOf("--")), ["--", "--output=hacked", "src/a.ts"]);
  }
  assert.throws(() => buildGitObserveArgv({ action: "diff", paths: [""] }), /non-empty/);
  assert.throws(() => buildGitObserveArgv({ action: "diff", paths: ["a\0b"] }), /NUL/);
  assert.throws(() => buildGitObserveArgv({ action: "diff", paths: Array.from({ length: 51 }, (_, n) => String(n)) }), /at most 50/);
});

test("SO-T11-T15 runner gets shell-free hardened invocation and stable output", async () => {
  const { tool, calls } = fakeTool();
  assert.equal(text(await execute(tool, { action: "status" })), "observed");
  assert.equal(calls[0].executable, "git");
  assert.equal(calls[0].shell, false);
  assert.equal(calls[0].env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(calls[0].env.GIT_NO_LAZY_FETCH, "1");
  assert.equal(calls[0].env.GIT_LITERAL_PATHSPECS, "1");
  assert.equal(calls[0].env.GIT_PAGER, "cat");
  assert.equal(calls[0].env.PAGER, "cat");
  assert.equal(calls[0].env.GIT_TERMINAL_PROMPT, "0");
  const inherited = safeGitEnvironment({ GIT_NO_LAZY_FETCH: "0", GIT_LITERAL_PATHSPECS: "0", KEEP: "yes" });
  assert.equal(inherited.GIT_NO_LAZY_FETCH, "1");
  assert.equal(inherited.GIT_LITERAL_PATHSPECS, "1");
  assert.equal(inherited.KEEP, "yes");
  const magicPath = buildGitObserveArgv({ action: "diff", paths: [":(glob)**"] });
  assert.deepEqual(magicPath.slice(magicPath.indexOf("--")), ["--", ":(glob)**"]);
  const empty = createPindieGitObserveTool({ runner: async () => ({ stdout: "", stderr: "warning", truncated: false }) });
  assert.match(text(await execute(empty, { action: "branch" })), /^\(no output\)[\s\S]*Git warnings:\nwarning$/);
});

test("SO-T16 nonzero Git exit reports action and diagnostic", async () => {
  const tool = createPindieGitObserveTool();
  await assert.rejects(execute(tool, { action: "status" }, tmpdir()), /Git observation 'status' failed \(exit \d+\):/);
});

test("SO-T17-T19 bounded collector retains no more than fixed bytes or lines", () => {
  const bytes = new BoundedOutput(8, 100);
  bytes.push("stdout", "0123456789");
  assert.equal(bytes.retainedBytes, 8);
  assert.equal(bytes.truncated, true);
  const lines = new BoundedOutput(100, 2);
  lines.push("stdout", "a\nb\nc\n");
  assert.equal(lines.retainedLines, 2);
  assert.equal(lines.text("stdout"), "a\nb\n");
  const normal = new BoundedOutput();
  normal.push("stdout", Buffer.alloc(GIT_OBSERVE_MAX_OUTPUT_BYTES + 1));
  assert.equal(normal.retainedBytes, GIT_OBSERVE_MAX_OUTPUT_BYTES);
  assert.equal(normal.truncated, true);
  const lineBound = new BoundedOutput();
  lineBound.push("stdout", "x\n".repeat(GIT_OBSERVE_MAX_OUTPUT_LINES + 1));
  assert.equal(lineBound.retainedLines, GIT_OBSERVE_MAX_OUTPUT_LINES);
});

test("SO-T20-T21 timeout and AbortSignal terminate and settle a Git child", async (t) => {
  const start = (timeoutMs: number, abortBeforeStart = false) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const killSignals: string[] = [];
    child.kill = (signal: string) => { killSignals.push(signal); return true; };
    const controller = new AbortController();
    if (abortBeforeStart) controller.abort();
    const promise = runGitObservation({
      executable: "git", argv: ["status"], cwd: process.cwd(), env: safeGitEnvironment(), shell: false,
      signal: controller.signal, timeoutMs, maxOutputBytes: 64, maxOutputLines: 10,
    }, (() => child) as any);
    return { child, controller, killSignals, promise };
  };

  await t.test("timeout independently controls the result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(5);
    t.mock.timers.tick(5);
    observation.child.emit("close", null);
    await assert.rejects(observation.promise, /timed out/);
    assert.deepEqual(observation.killSignals, ["SIGTERM"]);
  });

  await t.test("AbortSignal independently controls the result", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(1_000);
    observation.controller.abort();
    observation.child.emit("close", null);
    await assert.rejects(observation.promise, /cancelled/);
    assert.deepEqual(observation.killSignals, ["SIGTERM"]);
  });

  await t.test("an already-aborted signal controls the result without spawning termination", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(1_000, true);
    observation.child.emit("close", null);
    await assert.rejects(observation.promise, /cancelled/);
    assert.deepEqual(observation.killSignals, []);
  });

  await t.test("SIGKILL establishes a hard settlement boundary without close", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(5);
    t.mock.timers.tick(5);
    t.mock.timers.tick(250);
    await assert.rejects(observation.promise, /timed out/);
    assert.deepEqual(observation.killSignals, ["SIGTERM", "SIGKILL"]);
  });

  await t.test("abort remains authoritative when timeout fires before close", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(5);
    observation.controller.abort();
    t.mock.timers.tick(5);
    observation.child.emit("close", null);
    await assert.rejects(observation.promise, /cancelled/);
    t.mock.timers.tick(250);
    assert.deepEqual(observation.killSignals, ["SIGTERM"]);
  });

  await t.test("timeout remains authoritative when abort fires before close", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const observation = start(5);
    t.mock.timers.tick(5);
    observation.controller.abort();
    observation.child.emit("close", null);
    await assert.rejects(observation.promise, /timed out/);
    t.mock.timers.tick(250);
    assert.deepEqual(observation.killSignals, ["SIGTERM"]);
  });
});

test("SO-I01-SO-I04 real isolated Git repository observes status, diffs, branch, root, and log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pindie-git-observe-"));
  const invoke = async (action: any) => runGitObservation({
    executable: "git", argv: buildGitObserveArgv(action), cwd: dir, env: safeGitEnvironment(), shell: false,
    timeoutMs: 10_000, maxOutputBytes: GIT_OBSERVE_MAX_OUTPUT_BYTES, maxOutputLines: GIT_OBSERVE_MAX_OUTPUT_LINES,
  });
  try {
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "tracked.txt"), "one\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: dir });
    await execFile("git", ["-c", "user.name=Pindie Test", "-c", "user.email=pindie@example.invalid", "commit", "-qm", "initial"], { cwd: dir });
    await writeFile(join(dir, "tracked.txt"), "two\n");
    await writeFile(join(dir, "untracked.txt"), "new\n");
    assert.match((await invoke({ action: "status" })).stdout, / M tracked.txt[\s\S]*\?\? untracked.txt/);
    assert.match((await invoke({ action: "diff" })).stdout, /-one[\s\S]*\+two/);
    await execFile("git", ["add", "tracked.txt"], { cwd: dir });
    assert.match((await invoke({ action: "diff_cached" })).stdout, /-one[\s\S]*\+two/);
    assert.equal((await invoke({ action: "branch" })).stdout.trim(), "main");
    assert.equal((await invoke({ action: "root" })).stdout.trim(), dir);
    assert.match((await invoke({ action: "log" })).stdout, /initial/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
