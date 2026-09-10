import { spawn } from "node:child_process";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const GIT_OBSERVE_ACTIONS = [
  "status", "branch", "root", "diff", "diff_cached", "diff_check", "log", "remote",
] as const;

type GitObserveAction = (typeof GIT_OBSERVE_ACTIONS)[number];

const DIFF_ACTIONS: readonly GitObserveAction[] = ["diff", "diff_cached", "diff_check"];
const DEFAULT_LIMIT = 10;
export const GIT_OBSERVE_TIMEOUT_MS = 10_000;
export const GIT_OBSERVE_MAX_OUTPUT_BYTES = 64 * 1024;
export const GIT_OBSERVE_MAX_OUTPUT_LINES = 400;

const PindieGitObserveParameters = Type.Object({
  action: StringEnum(GIT_OBSERVE_ACTIONS, {
    description: "Fixed read-only Git observation: status, branch, root, diff, diff_cached, diff_check, log, or remote.",
  }),
  paths: Type.Optional(Type.Array(Type.String(), { maxItems: 50, description: "Positional paths for diff actions only." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Log entry limit for log only (default 10)." })),
}, { additionalProperties: false });

export interface GitObserveParams {
  action: GitObserveAction;
  paths?: string[];
  limit?: number;
}

export interface GitObservationInvocation {
  executable: "git";
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
}

export interface GitObservationResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type GitObservationRunner = (invocation: GitObservationInvocation) => Promise<GitObservationResult>;

function isDiffAction(action: GitObserveAction): boolean {
  return DIFF_ACTIONS.includes(action);
}

export function buildGitObserveArgv(params: GitObserveParams): string[] {
  const { action, paths, limit } = params;
  if (paths !== undefined && !isDiffAction(action)) {
    throw new Error(`Invalid pindie_git_observe input for '${action}': paths are allowed only for diff actions.`);
  }
  if (limit !== undefined && action !== "log") {
    throw new Error(`Invalid pindie_git_observe input for '${action}': limit is allowed only for log.`);
  }
  if (paths !== undefined) {
    if (paths.length > 50) throw new Error("Invalid pindie_git_observe input: paths may contain at most 50 entries.");
    for (const path of paths) {
      if (path.length === 0) throw new Error("Invalid pindie_git_observe input: paths must be non-empty.");
      if (path.includes("\0")) throw new Error("Invalid pindie_git_observe input: paths must not contain NUL.");
    }
  }
  const safe = ["--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false"];
  switch (action) {
    case "status": return [...safe, "status", "--short", "--branch"];
    case "branch": return [...safe, "branch", "--show-current"];
    case "root": return [...safe, "rev-parse", "--show-toplevel"];
    case "remote": return [...safe, "remote", "-v"];
    case "log": {
      const count = limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        throw new Error("Invalid pindie_git_observe input: log limit must be an integer from 1 to 50.");
      }
      return [...safe, "log", "--oneline", "--decorate", `--max-count=${count}`];
    }
    case "diff":
    case "diff_cached":
    case "diff_check": {
      const command = action === "diff" ? ["diff"]
        : action === "diff_cached" ? ["diff", "--cached"]
          : ["diff", "--check"];
      return [...safe, ...command, "--no-ext-diff", "--no-textconv", "--", ...(paths ?? [])];
    }
  }
}

/** A byte- and line-bounded collector that continues accepting discarded input. */
export class BoundedOutput {
  private readonly chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  private bytes = 0;
  private lines = 0;
  truncated = false;
  private readonly maxBytes: number;
  private readonly maxLines: number;

  constructor(maxBytes = GIT_OBSERVE_MAX_OUTPUT_BYTES, maxLines = GIT_OBSERVE_MAX_OUTPUT_LINES) {
    this.maxBytes = maxBytes;
    this.maxLines = maxLines;
  }

  push(channel: "stdout" | "stderr", chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let index = 0; index < bytes.length; index += 1) {
      if (this.bytes >= this.maxBytes || this.lines >= this.maxLines) {
        this.truncated = true;
        continue;
      }
      this.chunks[channel].push(bytes.subarray(index, index + 1));
      this.bytes += 1;
      if (bytes[index] === 0x0a) this.lines += 1;
    }
  }

  text(channel: "stdout" | "stderr"): string {
    return Buffer.concat(this.chunks[channel]).toString("utf8");
  }

  get retainedBytes(): number { return this.bytes; }
  get retainedLines(): number { return this.lines; }
}

export function safeGitEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...inherited,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function runGitObservation(
  invocation: GitObservationInvocation,
  spawnGit: typeof spawn = spawn,
): Promise<GitObservationResult> {
  if (invocation.signal?.aborted) {
    return Promise.reject(new Error("Git observation was cancelled."));
  }
  return new Promise((resolve, reject) => {
    const collector = new BoundedOutput(invocation.maxOutputBytes, invocation.maxOutputLines);
    let settled = false;
    let terminationCause: "timeout" | "abort" | undefined;
    let killEscalation: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      invocation.signal?.removeEventListener("abort", abort);
      callback();
    };
    const child = spawnGit("git", invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (cause: "timeout" | "abort") => {
      if (terminationCause !== undefined) return;
      terminationCause = cause;
      child.kill("SIGTERM");
      killEscalation = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(
          cause === "timeout"
            ? new Error(`Git observation timed out after ${invocation.timeoutMs / 1000}s.`)
            : new Error("Git observation was cancelled."),
        ));
      }, 250);
    };
    const abort = () => terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), invocation.timeoutMs);
    if (invocation.signal?.aborted) abort();
    else invocation.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => collector.push("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collector.push("stderr", chunk));
    child.on("error", (error) => settle(() => reject(new Error(`Git observation failed to start: ${error.message}`))));
    child.on("close", (code) => settle(() => {
      if (terminationCause === "timeout") return reject(new Error(`Git observation timed out after ${invocation.timeoutMs / 1000}s.`));
      if (terminationCause === "abort") return reject(new Error("Git observation was cancelled."));
      if (code !== 0) return reject(new GitObservationExitError(code, collector.text("stdout"), collector.text("stderr"), collector.truncated));
      resolve({ stdout: collector.text("stdout"), stderr: collector.text("stderr"), truncated: collector.truncated });
    }));
  });
}

class GitObservationExitError extends Error {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;

  constructor(code: number | null, stdout: string, stderr: string, truncated: boolean) {
    super("Git observation exited unsuccessfully.");
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.truncated = truncated;
  }
}

function withTruncation(text: string, truncated: boolean): string {
  return `${text.trimEnd()}${truncated ? `${text.trimEnd() ? "\n" : ""}[output truncated]` : ""}`;
}

function observationText(action: GitObserveAction, result: GitObservationResult): string {
  const stdout = withTruncation(result.stdout, result.truncated);
  const stderr = result.stderr.trim();
  return [
    stdout || "(no output)",
    ...(stderr ? ["", "Git warnings:", stderr] : []),
  ].join("\n");
}

export function createPindieGitObserveTool(options: {
  runner?: GitObservationRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
} = {}) {
  const runner = options.runner ?? runGitObservation;
  const timeoutMs = options.timeoutMs ?? GIT_OBSERVE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_OBSERVE_MAX_OUTPUT_BYTES;
  const maxOutputLines = options.maxOutputLines ?? GIT_OBSERVE_MAX_OUTPUT_LINES;
  return defineTool({
    name: "pindie_git_observe",
    label: "Pindie Git Observe",
    description: "Perform one fixed, read-only Git observation without a shell.",
    promptSnippet: "Observe supported read-only Git repository facts safely",
    parameters: PindieGitObserveParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const argv = buildGitObserveArgv(params);
      try {
        const result = await runner({
          executable: "git", argv, cwd: ctx.cwd, env: safeGitEnvironment(), shell: false,
          signal, timeoutMs, maxOutputBytes, maxOutputLines,
        });
        return { content: [{ type: "text" as const, text: observationText(params.action, result) }], details: undefined };
      } catch (error) {
        if (error instanceof GitObservationExitError) {
          const diagnostic = withTruncation(error.stderr || error.stdout, error.truncated) || "no diagnostic output";
          throw new Error(`Git observation '${params.action}' failed${error.code === null ? "" : ` (exit ${error.code})`}: ${diagnostic}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Git observation timed out")) {
          throw new Error(`Git observation '${params.action}' timed out after ${timeoutMs / 1000}s.`);
        }
        throw error;
      }
    },
  });
}
