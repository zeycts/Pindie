import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseRunExperience,
  type RunExperience,
} from "./run-experience.ts";
import { getProjectId } from "./store.ts";

export const EXPERIENCE_DIRECTORY_NAME = "experience";

export interface RunExperienceStore {
  save(projectRoot: string, experience: RunExperience): Promise<void>;
}

export interface FileRunExperienceStoreOptions {
  baseDir?: string;
}

export interface RunExperienceSourceRecord {
  readonly recordId: string;
  readonly experience: RunExperience;
}

export interface RunExperienceReadResult {
  readonly records: readonly RunExperienceSourceRecord[];
  readonly loadedSchemaV3: number;
  readonly unsupportedSchema: number;
  readonly invalid: number;
}

export interface RunExperienceReader {
  read(projectRoot: string): Promise<RunExperienceReadResult>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EMPTY_READ_RESULT: RunExperienceReadResult = Object.freeze({
  records: Object.freeze([]),
  loadedSchemaV3: 0,
  unsupportedSchema: 0,
  invalid: 0,
});

const CANONICAL_RECORD_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Read-only current-project access to immutable Run Experience records. */
export class FileRunExperienceReader implements RunExperienceReader {
  private readonly baseDir: string;

  constructor(options: FileRunExperienceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  async read(projectRoot: string): Promise<RunExperienceReadResult> {
    const directory = this.experienceDirectory(projectRoot);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return EMPTY_READ_RESULT;
      throw new Error(
        `Could not read Pindie Experience directory '${directory}': ${errorMessage(error)}`,
      );
    }

    const records: RunExperienceSourceRecord[] = [];
    let unsupportedSchema = 0;
    let invalid = 0;
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (!entry.isFile() || !CANONICAL_RECORD_FILE.test(entry.name)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(directory, entry.name), "utf8"));
      } catch {
        invalid += 1;
        continue;
      }
      if (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).schemaVersion === "number" &&
        (parsed as Record<string, unknown>).schemaVersion !== 3
      ) {
        unsupportedSchema += 1;
        continue;
      }
      const experience = parseRunExperience(parsed);
      if (experience === null) {
        invalid += 1;
        continue;
      }
      records.push(Object.freeze({ recordId: entry.name, experience }));
    }

    return Object.freeze({
      records: Object.freeze(records),
      loadedSchemaV3: records.length,
      unsupportedSchema,
      invalid,
    });
  }

  experienceDirectory(projectRoot: string): string {
    return join(
      this.baseDir,
      getProjectId(projectRoot),
      EXPERIENCE_DIRECTORY_NAME,
    );
  }
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
