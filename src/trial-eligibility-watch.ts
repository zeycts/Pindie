import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { PROJECT_ID } from "./learning-v1-contract.ts";

/** Detached storage observation, not a Task-path stat/read or a semantic classifier. */
export function trialEligibilityObserver(projectsBaseDir: string, globalBaseDir: string) {
  return async (projectId: string, invalidate: (unavailable?: boolean) => void): Promise<() => void> => {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Trial eligibility namespace.");
    // Global transfer trust can depend on exact artifacts in OTHER source projects.
    const roots = [projectsBaseDir, globalBaseDir];
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const watchers: FSWatcher[] = [];
    try {
      for (const root of roots) {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          const path = name?.toString().replaceAll("\\", "/");
          // Task/Experience/offer writes are NOT eligibility changes. All legacy trust
          // artifacts and the D2 immutable open history are, including atomic temp/link events.
          if (!path || /(^|\/)(strategy-[^/]+|hypotheses)(\/|$)/.test(path)) invalidate();
        });
        watcher.on("error", () => invalidate(true));
        watcher.unref();
        watchers.push(watcher);
      }
    } catch (error) { watchers.forEach((watcher) => watcher.close()); throw error; }
    return () => watchers.forEach((watcher) => watcher.close());
  };
}
