import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_STATE,
  validateState,
  type HumanGate,
  type PindieState,
  type PindieTask,
  type VerificationCheck,
} from "./state.ts";

const STATE_FILE_NAME = "state.json";

export interface PindieStateStore {
  load(projectRoot: string): Promise<PindieState>;
  save(projectRoot: string, state: PindieState): Promise<void>;
}

export interface FileStateStoreOptions {
  baseDir?: string;
}

export function getProjectId(canonicalProjectRoot: string): string {
  return createHash("sha256").update(canonicalProjectRoot).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isVerificationCheck(value: unknown): value is VerificationCheck {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.status === "passed" || value.status === "failed") &&
    isStringArray(value.covers) &&
    typeof value.evidence === "string"
  );
}

function isHumanGate(value: unknown): value is HumanGate {
  return (
    isRecord(value) &&
    (value.kind === "decision" ||
      value.kind === "approval" ||
      value.kind === "input") &&
    typeof value.question === "string" &&
    (value.options === undefined || isStringArray(value.options))
  );
}

function isPindieTask(value: unknown): value is PindieTask {
  if (!isRecord(value)) return false;

  return (
    typeof value.goal === "string" &&
    isStringArray(value.constraints) &&
    Array.isArray(value.successCriteria) &&
    value.successCriteria.every(
      (criterion) =>
        isRecord(criterion) &&
        typeof criterion.id === "string" &&
        typeof criterion.description === "string",
    ) &&
    isRecord(value.openLoops) &&
    isStringArray(value.openLoops.blockers) &&
    isStringArray(value.openLoops.questions) &&
    (typeof value.openLoops.nextIntent === "string" ||
      value.openLoops.nextIntent === null) &&
    isRecord(value.verification) &&
    typeof value.verification.stale === "boolean" &&
    Array.isArray(value.verification.checks) &&
    value.verification.checks.every(isVerificationCheck) &&
    (value.humanGate === null || isHumanGate(value.humanGate)) &&
    typeof value.completed === "boolean"
  );
}

function isPindieState(value: unknown): value is PindieState {
  return isRecord(value) && (value.task === null || isPindieTask(value.task));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export class FileStateStore implements PindieStateStore {
  private readonly baseDir: string;

  constructor(options: FileStateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  async load(projectRoot: string): Promise<PindieState> {
    const statePath = this.statePath(projectRoot);
    let contents: string;

    try {
      contents = await readFile(statePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_STATE;

      throw new Error(
        `Could not read Pindie State file '${statePath}': ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `Could not parse Pindie State file '${statePath}': ${errorMessage(error)}`,
      );
    }

    if (!isPindieState(parsed)) {
      throw new Error(`Pindie State file '${statePath}' has an invalid structure.`);
    }

    const validation = validateState(parsed);
    if (!validation.ok) {
      throw new Error(
        `Pindie State file '${statePath}' violates State invariants: ${validation.errors.join(" ")}`,
      );
    }

    return parsed;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    const validation = validateState(state);
    if (!validation.ok) {
      throw new Error(
        `Cannot save invalid Pindie State: ${validation.errors.join(" ")}`,
      );
    }

    const statePath = this.statePath(projectRoot);
    const stateDir = join(this.baseDir, getProjectId(projectRoot));
    const temporaryPath = join(stateDir, `.${STATE_FILE_NAME}.${randomUUID()}.tmp`);

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not save Pindie State file '${statePath}': ${errorMessage(error)}`,
      );
    }
  }

  private statePath(projectRoot: string): string {
    return join(this.baseDir, getProjectId(projectRoot), STATE_FILE_NAME);
  }
}
