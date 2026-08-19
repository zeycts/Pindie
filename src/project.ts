import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

function resolveGitRoot(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8", windowsHide: true },
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

export async function resolveProjectRoot(cwd: string): Promise<string> {
  const canonicalCwd = await realpath(cwd);

  try {
    const gitRoot = await resolveGitRoot(canonicalCwd);
    return await realpath(gitRoot);
  } catch {
    return canonicalCwd;
  }
}
