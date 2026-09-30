import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { PROJECT_ID } from "./learning-v1-contract.ts";

type DirectoryWatch = (root: string, listener: (event: string, name: string | Buffer | null) => void) => Pick<FSWatcher, "on" | "close" | "unref">;
const watchDirectory: DirectoryWatch = (root, listener) => watch(root, { recursive: true }, listener);

/** Detached storage observation, not a Task-path stat/read or a semantic classifier. */
export function trialEligibilityObserver(projectsBaseDir: string, globalBaseDir: string, observeDirectory: DirectoryWatch = watchDirectory) {
  return async (projectId: string, invalidate: (unavailable?: boolean) => void): Promise<() => void> => {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Trial eligibility namespace.");
    // Global transfer trust can depend on exact artifacts in OTHER source projects.
    const roots = [projectsBaseDir, globalBaseDir];
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const watchers: ReturnType<DirectoryWatch>[] = [];
    try {
      for (const root of roots) {
        const watcher = observeDirectory(root, (_event, name) => {
          const path = name?.toString().replaceAll("\\", "/");
          // Task/Experience/offer writes are NOT eligibility changes. All legacy trust
          // artifacts and the D2 immutable open history are, including atomic temp/link events.
          if (!path || /(^|\/)(strategy-[^/]+|hypotheses)(\/|$)/.test(path)) invalidate();
        });
        watcher.on("error", (error: NodeJS.ErrnoException) => {
          // Node 22's recursive watcher can stat a directory, then scandir it
          // after lock release removes it. That error leaves the root watcher
          // running; writer.lock and project state.lock (including reclaim
          // children) are operational, never eligibility dependencies.
          // Never forgive missing roots, trust/hypothesis paths or other errors.
          const path = typeof error.path === "string" ? relative(root, error.path) : null;
          const parts = path?.split(sep) ?? [];
          const operationalLock = path === "writer.lock" || path?.startsWith(`writer.lock${sep}`) ||
            (root === projectsBaseDir && PROJECT_ID.test(parts[0] ?? "") && parts[1] === "state.lock");
          if (error.code === "ENOENT" && error.syscall === "scandir" && path !== null && !isAbsolute(path) && operationalLock) return;
          invalidate(true);
        });
        watcher.unref();
        watchers.push(watcher);
      }
    } catch (error) { watchers.forEach((watcher) => watcher.close()); throw error; }
    return () => watchers.forEach((watcher) => watcher.close());
  };
}
