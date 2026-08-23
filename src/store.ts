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
const LOCK_DIRECTORY_NAME = "state.lock";
const LOCK_OWNER_FILE_NAME = "owner.json";
const LOCK_RECLAIM_DIRECTORY_NAME = ".reclaim";

export class StateLockBusyError extends Error {
  constructor() {
    super("Another Pindie process currently owns this project's State lock. Retry shortly.");
    this.name = "StateLockBusyError";
  }
}

export interface PindieStateStore {
  load(projectRoot: string): Promise<PindieState>;
  save(projectRoot: string, state: PindieState): Promise<void>;
  withProjectLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T>;
}

export interface FileStateStoreOptions {
  baseDir?: string;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  /** Test-only barrier after exclusively claiming a valid dead-owner lock. */
  onReclaimClaimed?: () => Promise<void>;
}

interface LockOwner {
  token: string;
  pid: number;
  acquiredAt: number;
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
  return isRecord(value) && typeof value.name === "string" &&
    (value.status === "passed" || value.status === "failed") &&
    isStringArray(value.covers) && typeof value.evidence === "string";
}

function isHumanGate(value: unknown): value is HumanGate {
  return isRecord(value) && (value.kind === "decision" || value.kind === "approval" || value.kind === "input") &&
    typeof value.question === "string" && (value.options === undefined || isStringArray(value.options));
}

function isPindieTask(value: unknown): value is PindieTask {
  if (!isRecord(value)) return false;
  return typeof value.goal === "string" && isStringArray(value.constraints) &&
    Array.isArray(value.successCriteria) && value.successCriteria.every((criterion) =>
      isRecord(criterion) && typeof criterion.id === "string" && typeof criterion.description === "string"
    ) && isRecord(value.openLoops) && isStringArray(value.openLoops.blockers) &&
    isStringArray(value.openLoops.questions) &&
    (typeof value.openLoops.nextIntent === "string" || value.openLoops.nextIntent === null) &&
    isRecord(value.verification) && typeof value.verification.stale === "boolean" &&
    Array.isArray(value.verification.checks) && value.verification.checks.every(isVerificationCheck) &&
    (value.humanGate === null || isHumanGate(value.humanGate)) && typeof value.completed === "boolean";
}

function isPindieState(value: unknown): value is PindieState {
  return isRecord(value) && (value.task === null || isPindieTask(value.task));
}

function isLockOwner(value: unknown): value is LockOwner {
  return isRecord(value) && typeof value.token === "string" && value.token.length > 0 &&
    typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
    typeof value.acquiredAt === "number" && Number.isFinite(value.acquiredAt);
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.token === right.token && left.pid === right.pid && left.acquiredAt === right.acquiredAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export class FileStateStore implements PindieStateStore {
  private readonly baseDir: string;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly onReclaimClaimed: (() => Promise<void>) | undefined;

  constructor(options: FileStateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
    this.lockRetryMs = options.lockRetryMs ?? 20;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 500;
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.onReclaimClaimed = options.onReclaimClaimed;
  }

  async load(projectRoot: string): Promise<PindieState> {
    const statePath = this.statePath(projectRoot);
    let contents: string;
    try {
      contents = await readFile(statePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return EMPTY_STATE;
      throw new Error(`Could not read Pindie State file '${statePath}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch (error) {
      throw new Error(`Could not parse Pindie State file '${statePath}': ${errorMessage(error)}`);
    }
    if (!isPindieState(parsed)) throw new Error(`Pindie State file '${statePath}' has an invalid structure.`);
    const validation = validateState(parsed);
    if (!validation.ok) throw new Error(`Pindie State file '${statePath}' violates State invariants: ${validation.errors.join(" ")}`);
    return parsed;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`Cannot save invalid Pindie State: ${validation.errors.join(" ")}`);
    const statePath = this.statePath(projectRoot);
    const stateDir = this.stateDir(projectRoot);
    const temporaryPath = join(stateDir, `.${STATE_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, statePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(`Could not save Pindie State file '${statePath}': ${errorMessage(error)}`);
    }
  }

  async withProjectLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(projectRoot);
    const token = randomUUID();
    await this.acquireLock(projectRoot, lockPath, token);
    try {
      return await operation();
    } finally {
      await this.releaseLock(lockPath, token);
    }
  }

  private async acquireLock(projectRoot: string, lockPath: string, token: string): Promise<void> {
    await mkdir(this.stateDir(projectRoot), { recursive: true });
    const deadline = this.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath);
        try {
          await writeFile(join(lockPath, LOCK_OWNER_FILE_NAME), JSON.stringify({ token, pid: process.pid, acquiredAt: this.now() }), { encoding: "utf8", flag: "wx" });
          return;
        } catch (error) {
          // A successful mkdir created this ownerless lock. Ambiguous ownerless
          // locks are never reclaimed, so no contender can replace it here.
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw new Error(`Could not establish Pindie State lock ownership: ${errorMessage(error)}`);
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      await this.reclaimIfSafe(lockPath);
      if (this.now() >= deadline) throw new StateLockBusyError();
      await sleep(this.lockRetryMs);
    }
  }

  private async reclaimIfSafe(lockPath: string): Promise<void> {
    const observedOwner = await this.readLockOwner(lockPath);
    // Missing or malformed ownership is deliberately fail-closed. Age cannot
    // prove ownership, and an owner-establishment failure must not let another
    // process replace a lock that its creator may still clean up.
    if (!observedOwner || this.isProcessAlive(observedOwner.pid)) return;

    const reclaimPath = join(lockPath, LOCK_RECLAIM_DIRECTORY_NAME);
    try {
      await mkdir(reclaimPath);
    } catch {
      return;
    }

    try {
      await this.onReclaimClaimed?.();
      // The reclaim marker serializes reclaimers for this exact directory
      // instance. Re-read after claiming it; a stale observation alone is never
      // authority to remove the canonical lock path.
      const currentOwner = await this.readLockOwner(lockPath);
      if (!currentOwner || !sameOwner(currentOwner, observedOwner) || this.isProcessAlive(currentOwner.pid)) return;
      await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    } finally {
      // This operation owns only its marker. If the canonical directory was
      // removed above this is a harmless ENOENT; otherwise release the claim.
      await rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readLockOwner(lockPath: string): Promise<LockOwner | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(lockPath, LOCK_OWNER_FILE_NAME), "utf8"));
      return isLockOwner(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async releaseLock(lockPath: string, token: string): Promise<void> {
    const owner = await this.readLockOwner(lockPath);
    if (!owner || owner.token !== token) return;
    await rm(lockPath, { recursive: true, force: true });
  }

  private stateDir(projectRoot: string): string { return join(this.baseDir, getProjectId(projectRoot)); }
  private statePath(projectRoot: string): string { return join(this.stateDir(projectRoot), STATE_FILE_NAME); }
  private lockPath(projectRoot: string): string { return join(this.stateDir(projectRoot), LOCK_DIRECTORY_NAME); }
}
