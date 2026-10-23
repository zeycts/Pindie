import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

const DEFAULT_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const OUTPUT_TAIL_BYTES = 32 * 1024;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface OwnedSmokeOptions {
  label: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  baseTempDir?: string;
  keepArtifacts?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface OwnedSmokeResult {
  workspace: string;
  retainedWorkspace: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}

function appendTail(current: Buffer, chunk: Buffer): Buffer {
  const combined = Buffer.concat([current, chunk]);
  return combined.length > OUTPUT_TAIL_BYTES
    ? combined.subarray(combined.length - OUTPUT_TAIL_BYTES)
    : combined;
}

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function assertPosix(): void {
  if (process.platform === "win32") {
    throw new Error("pi-smoke v0.1 requires POSIX/WSL; Windows is not supported.");
  }
}

export function validateLabel(label: string): void {
  if (!SAFE_LABEL.test(label)) {
    throw new Error("Smoke label must be 1–64 characters, start alphanumeric, and use only letters, digits, ., _, or -.");
  }
}

export function smokeRoot(baseTempDir = tmpdir(), uid = process.getuid?.()): string {
  if (uid === undefined) throw new Error("pi-smoke v0.1 requires a POSIX user ID.");
  return join(baseTempDir, `pindie-${uid}`, "smoke");
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`pi-smoke namespace path must be a real directory: ${path}`);
    }
    return;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await ensureOwnedDirectory(path);
}

async function ensureSmokeRoot(baseTempDir = tmpdir()): Promise<string> {
  const root = smokeRoot(baseTempDir);
  await ensureOwnedDirectory(dirname(root));
  await ensureOwnedDirectory(root);
  return root;
}

async function confirmGroupGone(pid: number): Promise<void> {
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  do {
    try { process.kill(-pid, 0); }
    catch (error) { if (isGone(error)) return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("Smoke process group termination is unconfirmed.");
}

async function terminateOwnedGroup(pid: number, exited: Promise<void>): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (isGone(error)) {
      await exited;
      return;
    }
    throw error;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  await exited;
}

export async function runOwnedSmoke(options: OwnedSmokeOptions): Promise<OwnedSmokeResult> {
  assertPosix();
  validateLabel(options.label);
  if (!options.command) throw new Error("Smoke command is required.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Smoke timeout must be a positive finite integer in milliseconds.");
  }

  const baseTempDir = options.baseTempDir ?? tmpdir();
  // Age and PID liveness cannot prove ownership (long runs, PID reuse, other Hosts).
  // Never reclaim earlier workspaces here; only finally-clean the one we allocate.
  const root = await realpath(await ensureSmokeRoot(baseTempDir));
  const workspace = await mkdtemp(join(root, `${options.label}-`));
  const workspaceIdentity = await lstat(workspace);
  const keepArtifacts = options.keepArtifacts ?? process.env.PINDIE_KEEP_ARTIFACTS === "1";

  let result: OwnedSmokeResult | undefined;
  let cleanupAllowed = true;
  try {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const spawnOptions: SpawnOptionsWithoutStdio = {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env, PINDIE_SMOKE_DIR: workspace },
    };
    const child = spawn(options.command, options.args ?? [], spawnOptions);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk); });
    const outputSettled = Promise.allSettled([
      child.stdout ? finished(child.stdout, { cleanup: true }) : Promise.resolve(),
      child.stderr ? finished(child.stderr, { cleanup: true }) : Promise.resolve(),
    ]);

    let settle!: (value: { exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
    const settled = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => { settle = resolve; });
    child.once("error", (error) => settle({ exitCode: null, signal: null, error }));
    child.once("exit", (exitCode, signal) => settle({ exitCode, signal }));
    const exited = settled.then(() => undefined);
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    const outcome = await Promise.race([
      // Descendants may inherit pipes after the direct child exits. Keep the
      // deadline armed until both streams finish, not merely until child exit.
      settled.then(async (value) => { await outputSettled; return { kind: "exit" as const, value }; }),
      timeout,
    ]);
    clearTimeout(timeoutHandle!);

    let final;
    let timedOut;
    if (outcome.kind === "timeout") {
      if (child.pid !== undefined) {
        cleanupAllowed = false;
        // A reaped leader no longer anchors signal authority. Do not signal a
        // potentially reused PGID just because inherited pipes are still open.
        if (child.exitCode !== null || child.signalCode !== null) {
          child.stdout?.destroy(); child.stderr?.destroy();
          throw new Error(`Smoke output deadline exceeded after child exit; workspace retained at ${workspace}`);
        }
        try {
          await terminateOwnedGroup(child.pid, exited);
          await confirmGroupGone(child.pid);
        } catch (error) {
          child.stdout?.destroy(); child.stderr?.destroy();
          throw new Error(`${String(error)} Workspace retained at ${workspace}`);
        }
      }
      final = await settled;
      timedOut = true;
    } else {
      final = outcome.value;
      timedOut = false;
    }
    if (final.error) throw final.error;
    // Even a normally exited command can leave background processes using its
    // workspace. Absence, not direct-child exit, authorizes recursive removal.
    if (child.pid !== undefined) {
      cleanupAllowed = false;
      try { await confirmGroupGone(child.pid); }
      catch (error) { throw new Error(`${String(error)} Workspace retained at ${workspace}`); }
    }
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const streamResults = await Promise.race([
      outputSettled,
      new Promise<never>((_resolve, reject) => {
        drainTimer = setTimeout(() => {
          child.stdout?.destroy(); child.stderr?.destroy();
          reject(new Error(`Smoke output drain is unconfirmed; workspace retained at ${workspace}`));
        }, TERMINATION_GRACE_MS);
      }),
    ]).finally(() => clearTimeout(drainTimer));
    cleanupAllowed = true;
    const streamFailure = streamResults.find((streamResult) => streamResult.status === "rejected");
    if (streamFailure) throw streamFailure.reason;
    result = { workspace, retainedWorkspace: null, exitCode: final.exitCode, signal: final.signal, timedOut, stdoutTail: stdout.toString(), stderrTail: stderr.toString() };
  } finally {
    if (!cleanupAllowed) {
      // Unknown live users of this invocation's scratch: retain, never scavenge.
    } else if (keepArtifacts && result) {
      result.retainedWorkspace = workspace;
    } else {
      if (await realpath(root) !== root) throw new Error(`Smoke namespace changed; cleanup refused at ${workspace}`);
      let entry;
      try { entry = await lstat(workspace); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== workspaceIdentity.dev || entry.ino !== workspaceIdentity.ino)) {
        throw new Error(`Smoke workspace identity changed; cleanup refused at ${workspace}`);
      }
      if (entry) await rm(workspace, { recursive: true, force: true });
    }
  }
  return result!;
}

export function usage(): string {
  return "Usage: pnpm smoke -- <label> [--timeout-ms <ms>] -- <command> [args...]";
}

export function parseCli(argv: string[]): { label: string; command: string; args: string[]; timeoutMs: number } {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [label, ...rest] = args;
  if (!label) throw new Error("Smoke label is required.");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let index = 0;
  while (index < rest.length && rest[index] !== "--") {
    if (rest[index] !== "--timeout-ms" || index + 1 >= rest.length) throw new Error("Invalid smoke arguments.");
    const value = Number(rest[index + 1]);
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error("Smoke timeout must be a positive finite integer in milliseconds.");
    timeoutMs = value;
    index += 2;
  }
  if (rest[index] !== "--" || !rest[index + 1]) throw new Error("Smoke command is required.");
  validateLabel(label);
  return { label, timeoutMs, command: rest[index + 1], args: rest.slice(index + 2) };
}

async function main(): Promise<void> {
  try {
    const parsed = parseCli(process.argv.slice(2));
    const result = await runOwnedSmoke(parsed);
    if (result.timedOut) {
      console.error(`pi-smoke: command timed out after ${parsed.timeoutMs}ms (signal: ${result.signal ?? "none"})`);
      if (result.stderrTail) console.error(result.stderrTail);
      if (result.stdoutTail) console.error(result.stdoutTail);
      console.error(result.retainedWorkspace ? `pi-smoke: artifacts retained at ${result.retainedWorkspace}` : "pi-smoke: artifacts cleaned");
      process.exitCode = 124;
    } else if (result.exitCode !== 0) {
      console.error(`pi-smoke: command failed (exit code: ${result.exitCode ?? "unknown"}, signal: ${result.signal ?? "none"})`);
      if (result.stderrTail) console.error(result.stderrTail);
      if (result.stdoutTail) console.error(result.stdoutTail);
      console.error(result.retainedWorkspace ? `pi-smoke: artifacts retained at ${result.retainedWorkspace}` : "pi-smoke: artifacts cleaned");
      process.exitCode = result.exitCode && result.exitCode > 0 ? result.exitCode : 1;
    } else {
      console.log("pi-smoke: command succeeded");
      if (result.retainedWorkspace) console.log(`pi-smoke: artifacts retained at ${result.retainedWorkspace}`);
    }
  } catch (error) {
    console.error(`pi-smoke: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) void main();
