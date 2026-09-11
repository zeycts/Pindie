import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { safeGitEnvironment } from "./tools/git-observe.ts";

export type ProjectFingerprint =
  | { kind: "known"; digest: string }
  | { kind: "unknown"; reason: string };

export const PROJECT_FINGERPRINT_TIMEOUT_MS = 10_000;
export const PROJECT_FINGERPRINT_MAX_PATHS = 50_000;
export const PROJECT_FINGERPRINT_MAX_PATH_LIST_BYTES = 8 * 1024 * 1024;

export interface ProjectFingerprintInvocation {
  executable: "git";
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProjectFingerprintRunner = (invocation: ProjectFingerprintInvocation) => Promise<Buffer>;

export interface ProjectFingerprintOptions {
  timeoutMs?: number;
  maxPaths?: number;
  maxPathListBytes?: number;
  runner?: ProjectFingerprintRunner;
}

export function buildProjectFingerprintArgv(): string[] {
  return [
    "--no-pager", "-c", "color.ui=false", "-c", "core.fsmonitor=false",
    "ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z",
  ];
}

export async function runProjectFingerprintGit(
  invocation: ProjectFingerprintInvocation,
  spawnGit: typeof spawn = spawn,
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let terminationCause: "timeout" | "overflow" | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const child = spawnGit("git", invocation.argv, {
      cwd: invocation.cwd, env: invocation.env, shell: false, detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      callback();
    };
    const terminate = (cause: "timeout" | "overflow") => {
      if (settled || terminationCause !== undefined) return;
      terminationCause = cause;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(
          cause === "timeout"
            ? new Error("Git fingerprint timed out.")
            : new Error("Git fingerprint path list exceeded its byte bound."),
        ));
      }, 250);
    };
    const timer = setTimeout(() => terminate("timeout"), invocation.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled || terminationCause !== undefined) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + next.length > invocation.maxOutputBytes) {
        terminate("overflow");
        return;
      }
      bytes += next.length;
      chunks.push(next);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      if (terminationCause === "timeout") return reject(new Error("Git fingerprint timed out."));
      if (terminationCause === "overflow") return reject(new Error("Git fingerprint path list exceeded its byte bound."));
      if (code !== 0) return reject(new Error(`Git fingerprint enumeration failed (exit ${code ?? "unknown"}).`));
      resolveResult(Buffer.concat(chunks));
    }));
  });
}

function unknown(reason: string): ProjectFingerprint { return { kind: "unknown", reason }; }

/** Parses Git's -z output without lossy filename decoding. */
function decodeGitPaths(output: Buffer): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) paths.push(decoder.decode(output.subarray(start, index)));
    start = index + 1;
  }
  // Git -z emits a trailing NUL. A nonempty trailing segment is malformed but
  // decoded strictly so it cannot silently become a replacement-character path.
  if (start < output.length) paths.push(decoder.decode(output.subarray(start)));
  return paths;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

function frame(hash: ReturnType<typeof createHash>, tag: string, value?: Buffer | string | number): void {
  const tagBytes = Buffer.from(tag, "utf8");
  const valueBytes = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(valueBytes.length));
  hash.update(Buffer.from([tagBytes.length]));
  hash.update(tagBytes);
  hash.update(length);
  hash.update(valueBytes);
}

async function hashStream(hash: ReturnType<typeof createHash>, path: string, deadline: number): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const stream = createReadStream(path);
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      stream.destroy(new Error("Project fingerprint timed out."));
    }, remaining);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", (error) => { clearTimeout(timer); reject(error); });
    stream.on("end", () => { clearTimeout(timer); resolveResult(); });
  });
}

/** Captures only Git-visible worktree content; Git metadata and ignored files are excluded. */
export async function captureProjectFingerprint(
  projectRoot: string,
  options: ProjectFingerprintOptions = {},
): Promise<ProjectFingerprint> {
  const timeoutMs = options.timeoutMs ?? PROJECT_FINGERPRINT_TIMEOUT_MS;
  const maxPaths = options.maxPaths ?? PROJECT_FINGERPRINT_MAX_PATHS;
  const maxPathListBytes = options.maxPathListBytes ?? PROJECT_FINGERPRINT_MAX_PATH_LIST_BYTES;
  const deadline = Date.now() + timeoutMs;
  try {
    const root = await realpath(projectRoot);
    const runner = options.runner ?? runProjectFingerprintGit;
    const output = await runner({
      executable: "git", argv: buildProjectFingerprintArgv(), cwd: root,
      env: safeGitEnvironment(), shell: false, timeoutMs: Math.max(1, deadline - Date.now()),
      maxOutputBytes: maxPathListBytes,
    });
    if (output.length > maxPathListBytes) return unknown("Git path list exceeded its byte bound.");
    if (Date.now() > deadline) return unknown("Project fingerprint timed out.");
    const paths = new Set(decodeGitPaths(output));
    if (paths.size > maxPaths) return unknown("Git path count exceeded its bound.");
    const hash = createHash("sha256");
    frame(hash, "pindie-project-fingerprint-v1");
    for (const path of [...paths].sort()) {
      if (!path || path.includes("\0") || isAbsolute(path)) return unknown(`Unsafe Git path '${path}'.`);
      const candidate = resolve(root, path);
      if (!contained(root, candidate)) return unknown(`Unsafe Git path '${path}'.`);
      frame(hash, "entry-start");
      frame(hash, "path", Buffer.from(path, "utf8"));
      let stat;
      try { stat = await lstat(candidate); } catch (error: any) {
        if (error?.code === "ENOENT") { frame(hash, "kind", "missing"); frame(hash, "entry-end"); continue; }
        return unknown(`Could not inspect '${path}': ${error instanceof Error ? error.message : String(error)}`);
      }
      // Resolve only the parent for final symlinks; their targets are never followed.
      const parent = await realpath(dirname(candidate));
      if (!contained(root, parent)) return unknown(`Path '${path}' escapes the project root.`);
      if (stat.isSymbolicLink()) {
        frame(hash, "kind", "symlink");
        frame(hash, "target", await readlink(candidate, { encoding: "buffer" }));
      } else if (stat.isFile()) {
        const actual = await realpath(candidate);
        if (!contained(root, actual)) return unknown(`Path '${path}' escapes the project root.`);
        frame(hash, "kind", "regular");
        frame(hash, "executable", (stat.mode & 0o111) !== 0 ? "1" : "0");
        frame(hash, "content-length", stat.size);
        await hashStream(hash, actual, deadline);
      } else {
        return unknown(`Unsupported filesystem entry '${path}'.`);
      }
      frame(hash, "entry-end");
      if (Date.now() > deadline) return unknown("Project fingerprint timed out.");
    }
    return { kind: "known", digest: hash.digest("hex") };
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error));
  }
}
