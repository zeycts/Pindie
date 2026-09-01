import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RunExperience } from "./run-experience.ts";
import { getProjectId } from "./store.ts";

export const EXPERIENCE_DIRECTORY_NAME = "experience";

export interface RunExperienceStore {
  save(projectRoot: string, experience: RunExperience): Promise<void>;
}

export interface FileRunExperienceStoreOptions {
  baseDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Durable, write-only per-project storage for immutable Run Experience records. */
export class FileRunExperienceStore implements RunExperienceStore {
  private readonly baseDir: string;

  constructor(options: FileRunExperienceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  async save(projectRoot: string, experience: RunExperience): Promise<void> {
    const directory = this.experienceDirectory(projectRoot);
    const recordId = randomUUID();
    const recordPath = join(directory, `${recordId}.json`);
    const temporaryPath = join(directory, `.${recordId}.json.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(experience, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, recordPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not save Pindie Run Experience file '${recordPath}': ${errorMessage(error)}`,
      );
    }
  }

  experienceDirectory(projectRoot: string): string {
    return join(
      this.baseDir,
      getProjectId(projectRoot),
      EXPERIENCE_DIRECTORY_NAME,
    );
  }
}
