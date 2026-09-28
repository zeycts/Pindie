import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileGlobalWriterLock, type GlobalWriterLock } from "./store.ts";
import {
  LEARNING_STOP_REASONS, MAX_LEARNING_LEASE_OWNER_LENGTH, learningJobKey, validateLearningArtifactRef, validateLearningJob,
  type LearningArtifactRef, type LearningJob, type LearningJobKind, type LearningScope, type LearningStopReason,
} from "./learning-v1-contract.ts";

const MAX_JOBS = 2048; // No eviction: capacity pressure fails closed, including for terminal entries.
const safe = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).sort().join() === [...fields].sort().join();
export interface LearningJobLedger {
  enqueue(kind: LearningJobKind, scope: LearningScope, inputFingerprint: string, policyVersion: number, now: number): Promise<LearningJob>;
  listEligible(now: number): Promise<readonly LearningJob[]>;
  claim(key: string, owner: string, now: number, leaseMs: number, reservedTokens: number, reservedTimeMs: number): Promise<LearningJob | null>;
  attachReservation(key: string, token: string, tokens: number, timeMs: number): Promise<LearningJob>;
  complete(key: string, token: string, receiptRef: LearningArtifactRef): Promise<LearningJob>;
  cancel(key: string, token: string | null, reason: LearningStopReason, receiptRef?: LearningArtifactRef): Promise<LearningJob>;
  release(key: string, token: string, eligibleAfter: number, reason: LearningStopReason): Promise<LearningJob>;
  reconcileExpired(now: number): Promise<number>;
  read(): Promise<readonly LearningJob[]>;
}
export class FileLearningJobLedger implements LearningJobLedger {
  private readonly root: string;
  private readonly lock: GlobalWriterLock;
  private readonly onBeforeRename?: () => Promise<void>;
  constructor(options: { globalBaseDir?: string; lock?: GlobalWriterLock; onBeforeRename?: () => Promise<void> } = {}) {
    this.root = options.globalBaseDir ?? join(homedir(), ".pindie", "global");
    this.lock = options.lock ?? new FileGlobalWriterLock({ baseDir: this.root });
    this.onBeforeRename = options.onBeforeRename;
  }
  private path() { return join(this.root, "learning-v1", "jobs.json"); }
  async read(): Promise<readonly LearningJob[]> {
    let text: string;
    try { text = await readFile(this.path(), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []; // Independent v1 stores may create the directory first.
      }
      throw error;
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("Malformed LearningJob ledger."); }
    if (!record(data) || !exact(data, ["schemaVersion", "jobs"]) || data.schemaVersion !== 1 ||
      !Array.isArray(data.jobs) || data.jobs.length > MAX_JOBS || !data.jobs.every(validateLearningJob)) throw new Error("Malformed LearningJob ledger.");
    const jobs = data.jobs as LearningJob[];
    if (new Set(jobs.map((job) => job.key)).size !== jobs.length ||
      jobs.filter((job) => job.state === "running").length > 1) throw new Error("Ambiguous LearningJob ledger.");
    return jobs;
  }
  private async change<T>(operation: (jobs: LearningJob[]) => T | Promise<T>): Promise<T> {
    return this.lock.withLock(async () => {
      const jobs = [...await this.read()];
      const before = JSON.stringify(jobs);
      const result = await operation(jobs);
      if (JSON.stringify(jobs) !== before) {
        if (jobs.length > MAX_JOBS || !jobs.every(validateLearningJob)) throw new Error("LearningJob ledger capacity or validation failure.");
        const path = this.path();
        const temp = `${path}.${randomUUID()}.tmp`;
        await mkdir(join(this.root, "learning-v1"), { recursive: true });
        try {
          await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, jobs }, null, 2)}\n`, { flag: "wx" });
          await this.onBeforeRename?.();
          await rename(temp, path);
        } finally { await rm(temp, { force: true }); }
      }
      return result;
    });
  }
  async enqueue(kind: LearningJobKind, scope: LearningScope, inputFingerprint: string, policyVersion: number, now: number): Promise<LearningJob> {
    const key = learningJobKey(kind, scope, inputFingerprint, policyVersion);
    if (!safe(now)) throw new Error("Invalid enqueue time.");
    return this.change((jobs) => {
      const existing = jobs.find((job) => job.key === key);
      if (existing) return existing;
      const job: LearningJob = { schemaVersion: 1, key, kind, scope, inputFingerprint, policyVersion,
        state: "pending", attempt: 0, eligibleAfter: now, reservedTokens: 0, reservedTimeMs: 0,
        leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminalReceiptRef: null, stopReason: null, createdAt: now };
      jobs.push(job);
      return job;
    });
  }
  async listEligible(now: number): Promise<readonly LearningJob[]> {
    if (!safe(now)) throw new Error("Invalid eligibility time.");
    return (await this.read()).filter((job) => job.state === "pending" && job.eligibleAfter <= now)
      .sort((a, b) => a.eligibleAfter - b.eligibleAfter || a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }
  async claim(key: string, owner: string, now: number, leaseMs: number, reservedTokens: number, reservedTimeMs: number): Promise<LearningJob | null> {
    if (!owner.trim() || owner.length > MAX_LEARNING_LEASE_OWNER_LENGTH || !safe(now) || !safe(leaseMs) || leaseMs === 0 || !safe(reservedTokens) || !safe(reservedTimeMs) ||
      !safe(now + leaseMs)) throw new Error("Invalid LearningJob claim.");
    return this.change((jobs) => {
      const i = jobs.findIndex((job) => job.key === key);
      if (i < 0 || jobs[i]!.state !== "pending" || jobs[i]!.eligibleAfter > now ||
        jobs.some((job) => job.state === "running")) return null;
      return jobs[i] = { ...jobs[i]!, state: "running", attempt: jobs[i]!.attempt + 1,
        leaseOwner: owner, leaseToken: randomUUID(), leaseExpiresAt: now + leaseMs,
        reservedTokens, reservedTimeMs, stopReason: null };
    });
  }
  private async settle(key: string, token: string | null, update: (job: LearningJob) => LearningJob): Promise<LearningJob> {
    return this.change((jobs) => {
      const i = jobs.findIndex((job) => job.key === key);
      if (i < 0 || (token === null ? jobs[i]!.state !== "pending" : jobs[i]!.state !== "running" || jobs[i]!.leaseToken !== token))
        throw new Error("Stale LearningJob lease/fence.");
      return jobs[i] = update(jobs[i]!);
    });
  }
  /** Only the current running lease can record a charged reservation, once. */
  async attachReservation(key: string, token: string, tokens: number, timeMs: number): Promise<LearningJob> {
    if (!safe(tokens) || tokens === 0 || !safe(timeMs) || timeMs === 0) throw new Error("Invalid learning reservation.");
    return this.settle(key, token, (job) => {
      if (job.reservedTokens !== 0 || job.reservedTimeMs !== 0) throw new Error("Learning reservation already attached.");
      return { ...job, reservedTokens: tokens, reservedTimeMs: timeMs };
    });
  }
  async complete(key: string, token: string, receiptRef: LearningArtifactRef): Promise<LearningJob> {
    if (!validateLearningArtifactRef(receiptRef)) throw new Error("Invalid terminal receipt ref.");
    return this.settle(key, token, (job) => ({ ...job, state: "completed", terminalReceiptRef: receiptRef,
      leaseOwner: null, leaseToken: null, leaseExpiresAt: null }));
  }
  async cancel(key: string, token: string | null, reason: LearningStopReason, receiptRef?: LearningArtifactRef): Promise<LearningJob> {
    if (!LEARNING_STOP_REASONS.includes(reason) || (receiptRef !== undefined && !validateLearningArtifactRef(receiptRef))) throw new Error("Invalid cancellation.");
    return this.settle(key, token, (job) => ({ ...job, state: "cancelled", stopReason: reason,
      terminalReceiptRef: receiptRef ?? null, leaseOwner: null, leaseToken: null, leaseExpiresAt: null }));
  }
  async release(key: string, token: string, eligibleAfter: number, reason: LearningStopReason): Promise<LearningJob> {
    if (!safe(eligibleAfter) || !LEARNING_STOP_REASONS.includes(reason)) throw new Error("Invalid release.");
    return this.settle(key, token, (job) => ({ ...job, state: "pending", eligibleAfter,
      reservedTokens: 0, reservedTimeMs: 0, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, stopReason: reason }));
  }
  async reconcileExpired(now: number): Promise<number> {
    if (!safe(now)) throw new Error("Invalid reconciliation time.");
    return this.change((jobs) => {
      let count = 0;
      for (let i = 0; i < jobs.length; i++) if (jobs[i]!.state === "running" && jobs[i]!.leaseExpiresAt! <= now) {
        jobs[i] = { ...jobs[i]!, state: "pending", leaseOwner: null, leaseToken: null, leaseExpiresAt: null,
          reservedTokens: 0, reservedTimeMs: 0, stopReason: "timeout" }; count++;
      }
      return count;
    });
  }
}
