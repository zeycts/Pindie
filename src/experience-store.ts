import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseRunExperience,
  RUN_EXPERIENCE_SCHEMA_VERSION,
  type RunExperience,
} from "./run-experience.ts";
import { getProjectId } from "./store.ts";

export const EXPERIENCE_DIRECTORY_NAME = "experience";

export interface RunExperienceStore {
  save(projectRoot: string, experience: RunExperience, signal?: AbortSignal): Promise<void>;
}

export interface FileRunExperienceStoreOptions {
  baseDir?: string;
  /** Test-only barrier immediately before the atomic rename. */
  onBeforeRename?: () => Promise<void>;
  /** Best-effort maintenance runs only after a committed Experience write. */
  onSaved?: (projectRoot: string) => Promise<void>;
}

export interface RunExperienceSourceRecord {
  readonly recordId: string;
  readonly experience: RunExperience;
}

export interface RunExperienceReadResult {
  readonly records: readonly RunExperienceSourceRecord[];
  /** Valid current schema-v4 records loaded from the live Experience directory. */
  readonly loadedRecords: number;
  /** Records with a numeric schema version that is not the current schema. */
  readonly unsupportedSchema: number;
  /** Malformed JSON or semantically invalid current-schema records. */
  readonly invalid: number;
}

export interface RunExperienceReader {
  read(projectRoot: string): Promise<RunExperienceReadResult>;
}

/**
 * Read-only project-namespace access used by on-demand cross-project review.
 * Project IDs are addressed directly; no repository root or display path is
 * inferred for another project's records.
 */
export interface RunExperienceProjectReader {
  listProjectIds(): Promise<readonly string[]>;
  readProjectId(projectId: string): Promise<RunExperienceReadResult>;
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
  loadedRecords: 0,
  unsupportedSchema: 0,
  invalid: 0,
});

const CANONICAL_RECORD_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

const CANONICAL_PROJECT_NAMESPACE = /^[0-9a-f]{64}$/;

/** Read-only current-project access to immutable Run Experience records. */
export class FileRunExperienceReader implements RunExperienceReader, RunExperienceProjectReader {
  private readonly baseDir: string;

  constructor(options: FileRunExperienceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  async read(projectRoot: string): Promise<RunExperienceReadResult> {
    return this.readProjectId(getProjectId(projectRoot));
  }

  /** Enumerate only canonical, directly-addressable project namespaces. */
  async listProjectIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return Object.freeze([]);
      throw new Error(
        `Could not enumerate Pindie project namespaces '${this.baseDir}': ${errorMessage(error)}`,
      );
    }
    const projectIds: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !CANONICAL_PROJECT_NAMESPACE.test(entry.name)) {
        throw new Error(
          `Could not enumerate Pindie project namespaces '${this.baseDir}': non-canonical project namespace '${entry.name}'.`,
        );
      }
      projectIds.push(entry.name);
    }
    return Object.freeze(projectIds.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0));
  }

  /** Read one live Experience directory by canonical project identity. */
  async readProjectId(projectId: string): Promise<RunExperienceReadResult> {
    if (!CANONICAL_PROJECT_NAMESPACE.test(projectId)) {
      throw new Error("Pindie Experience projectId must be a canonical lowercase project identity.");
    }
    return this.readDirectory(join(this.baseDir, projectId, EXPERIENCE_DIRECTORY_NAME));
  }

  private async readDirectory(directory: string): Promise<RunExperienceReadResult> {
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
    let loadedRecords = 0;
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
      const schemaVersion = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).schemaVersion
        : undefined;
      if (schemaVersion !== RUN_EXPERIENCE_SCHEMA_VERSION) {
        if (typeof schemaVersion === "number") unsupportedSchema += 1;
        else invalid += 1;
        continue;
      }
      const experience = parseRunExperience(parsed);
      if (experience === null) {
        invalid += 1;
        continue;
      }
      loadedRecords += 1;
      records.push(Object.freeze({ recordId: entry.name, experience }));
    }

    return Object.freeze({
      records: Object.freeze(records),
      loadedRecords,
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

  experienceDirectoryForProjectId(projectId: string): string {
    if (!CANONICAL_PROJECT_NAMESPACE.test(projectId)) {
      throw new Error("Pindie Experience projectId must be a canonical lowercase project identity.");
    }
    return join(this.baseDir, projectId, EXPERIENCE_DIRECTORY_NAME);
  }
}

/** Durable, write-only per-project storage for immutable Run Experience records. */
export class FileRunExperienceStore implements RunExperienceStore {
  private readonly baseDir: string;
  private readonly onBeforeRename: (() => Promise<void>) | undefined;
  private readonly onSaved: ((projectRoot: string) => Promise<void>) | undefined;

  constructor(options: FileRunExperienceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
    this.onBeforeRename = options.onBeforeRename;
    this.onSaved = options.onSaved;
  }

  async save(
    projectRoot: string,
    experience: RunExperience,
    signal?: AbortSignal,
  ): Promise<void> {
    if (experience.schemaVersion !== RUN_EXPERIENCE_SCHEMA_VERSION) {
      throw new Error("Could not save Pindie Run Experience: new records must use schema-v4.");
    }
    signal?.throwIfAborted();
    const directory = this.experienceDirectory(projectRoot);
    const recordId = randomUUID();
    const recordPath = join(directory, `${recordId}.json`);
    const temporaryPath = join(directory, `.${recordId}.json.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      signal?.throwIfAborted();
      await writeFile(
        temporaryPath,
        `${JSON.stringify(experience, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", signal },
      );
      signal?.throwIfAborted();
      await this.onBeforeRename?.();
      signal?.throwIfAborted();
      await rename(temporaryPath, recordPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not save Pindie Run Experience file '${recordPath}': ${errorMessage(error)}`,
      );
    }
    try {
      await this.onSaved?.(projectRoot);
    } catch (error) {
      // The Experience is already committed. Cleanup failures must not turn a
      // successful normal Run into a failed save; report partial deletion explicitly.
      console.warn(`[Pindie] Experience maintenance failed: ${errorMessage(error)}`);
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
