import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

function resolveGitRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", windowsHide: true, signal },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const root = stdout.trim();
        if (!root) {
          reject(new Error("Git returned an empty repository root."));
          return;
        }

        resolve(root);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"));
}

export async function resolveProjectRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const canonicalCwd = await realpath(cwd);
  signal?.throwIfAborted();

  try {
    const gitRoot = await resolveGitRoot(canonicalCwd, signal);
    signal?.throwIfAborted();
    return await realpath(gitRoot);
  } catch (error) {
    // A normal Git failure preserves the historical non-Git fallback. An
    // abort/deadline is lifecycle authority, not an ordinary Git failure.
    if (signal?.aborted || isAbortError(error)) throw error;
    return canonicalCwd;
  }
}
