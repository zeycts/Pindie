import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, learningFingerprint, PROJECT_ID, UUID_V4, FINGERPRINT } from "./learning-v1-contract.ts";
import { createExecutionLease, validateExecutionLease, isExecutionLeaseHeartbeat, type ExecutionLeaseV1 } from "./evaluation-execution-lease.ts";
import { evaluationRunRef, validateEvaluationRunRef, type EvaluationRunRef } from "./evaluation-run.ts";
import { readEvaluationExecutionClaim, type EvaluationExecutionClaim } from "./evaluation-run-store.ts";

export interface ExecutionLeaseRef {
  readonly schemaVersion: 1; readonly family: "execution-lease";
  readonly projectId: string; readonly runId: string; readonly fingerprint: string;
}
interface LeaseContent {
  readonly schemaVersion: 1; readonly lease: ExecutionLeaseV1;
  readonly runningRef: EvaluationRunRef; readonly previousFingerprint: string | null;
}
export interface ExecutionLeaseSnapshot extends LeaseContent { readonly ref: ExecutionLeaseRef }
export interface ExecutionLeaseStore {
  createLease(claim: EvaluationExecutionClaim, ownerId: string): Promise<ExecutionLeaseSnapshot>;
  heartbeat(previous: ExecutionLeaseRef, next: ExecutionLeaseV1): Promise<ExecutionLeaseSnapshot>;
  get(ref: ExecutionLeaseRef): Promise<ExecutionLeaseSnapshot>;
  getCurrent(projectId: string, runId: string): Promise<ExecutionLeaseSnapshot>;
}
export const MAX_EXECUTION_LEASE_SNAPSHOTS_V1 = 4096;
const MAX_ARTIFACT_BYTES = 4096;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
const detach = <T>(v: T): T => freeze(JSON.parse(canonicalJson(v)));
export function validateExecutionLeaseRef(v: unknown): v is ExecutionLeaseRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).sort().join() === "family,fingerprint,projectId,runId,schemaVersion" && r.schemaVersion === 1 && r.family === "execution-lease" &&
    typeof r.projectId === "string" && PROJECT_ID.test(r.projectId) && typeof r.runId === "string" && UUID_V4.test(r.runId) &&
    typeof r.fingerprint === "string" && FINGERPRINT.test(r.fingerprint);
}
function snapshot(content: LeaseContent): ExecutionLeaseSnapshot {
  return freeze({ ...content, ref: { schemaVersion: 1, family: "execution-lease", projectId: content.runningRef.projectId,
    runId: content.lease.runId, fingerprint: learningFingerprint(content) } });
}

/** Isolated immutable ownership metadata. No evaluator or semantic-store capability. */
export class FileExecutionLeaseStore implements ExecutionLeaseStore {
  private readonly options: {
    projectsBaseDir: string;
    /** Test-only transaction barriers. */
    beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
  };
  constructor(options: FileExecutionLeaseStore["options"]) { this.options = options; }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid ExecutionLease namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "execution-leases-v1");
  }
  private async history(projectId: string): Promise<Map<string, ExecutionLeaseSnapshot[]>> {
    const dir = this.dir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw e; }
    names = names.filter((n) => n !== "writer.lock");
    if (names.length > MAX_EXECUTION_LEASE_SNAPSHOTS_V1) throw new Error("Oversized ExecutionLease history.");
    const chains = new Map<string, ExecutionLeaseSnapshot[]>();
    for (const name of names.sort()) {
      const match = /^(.+)\.([a-f0-9]{64})\.json$/.exec(name);
      if (!match || !UUID_V4.test(match[1])) throw new Error("Malformed ExecutionLease history.");
      const path = join(dir, name);
      if ((await stat(path)).size > MAX_ARTIFACT_BYTES) throw new Error("Oversized ExecutionLease artifact.");
      const bytes = await readFile(path, "utf8");
      if (Buffer.byteLength(bytes) > MAX_ARTIFACT_BYTES) throw new Error("Oversized ExecutionLease artifact.");
      const value = JSON.parse(bytes);
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== "fingerprint,lease,previousFingerprint,runningRef,schemaVersion" || value.schemaVersion !== 1 ||
        !validateExecutionLease(value.lease) || !validateEvaluationRunRef(value.runningRef) || value.runningRef.status !== "running" ||
        value.runningRef.projectId !== projectId || value.runningRef.runId !== value.lease.runId || value.lease.runId !== match[1] ||
        !(value.previousFingerprint === null || typeof value.previousFingerprint === "string" && FINGERPRINT.test(value.previousFingerprint)) ||
        canonicalJson(value) !== bytes) throw new Error("Corrupt ExecutionLease artifact.");
      const { fingerprint, ...content } = value;
      const s = snapshot(content);
      if (s.ref.fingerprint !== fingerprint || fingerprint !== `sha256:${match[2]}`) throw new Error("Corrupt ExecutionLease fingerprint.");
      const chain = chains.get(s.lease.runId) ?? []; chain.push(s); chains.set(s.lease.runId, chain);
    }
    for (const chain of chains.values()) {
      chain.sort((a, b) => Date.parse(a.lease.heartbeatAt) - Date.parse(b.lease.heartbeatAt));
      if (chain[0].previousFingerprint !== null || chain[0].lease.acquiredAt !== chain[0].lease.heartbeatAt) throw new Error("Missing ExecutionLease origin.");
      for (let i = 1; i < chain.length; i++) {
        const previous = chain[i - 1], next = chain[i];
        if (next.previousFingerprint !== previous.ref.fingerprint || !same(next.runningRef, previous.runningRef) ||
          !isExecutionLeaseHeartbeat(previous.lease, next.lease) || Date.parse(next.lease.heartbeatAt) <= Date.parse(previous.lease.heartbeatAt))
          throw new Error("Corrupt ExecutionLease heartbeat history.");
      }
    }
    return chains;
  }
  private request(ref: ExecutionLeaseRef): ExecutionLeaseRef {
    const r = detach(ref);
    if (!validateExecutionLeaseRef(r)) throw new Error("Invalid exact ExecutionLease ref.");
    return r;
  }
  async get(ref: ExecutionLeaseRef): Promise<ExecutionLeaseSnapshot> {
    const r = this.request(ref);
    const found = (await this.history(r.projectId)).get(r.runId)?.find((s) => same(s.ref, r));
    if (!found) throw new Error("Missing exact ExecutionLease.");
    return found;
  }
  async getCurrent(projectId: string, runId: string): Promise<ExecutionLeaseSnapshot> {
    if (!UUID_V4.test(runId)) throw new Error("Invalid ExecutionLease run ID.");
    const chain = (await this.history(projectId)).get(runId);
    if (!chain) throw new Error("Missing ExecutionLease.");
    return chain[chain.length - 1];
  }
  private async write(s: ExecutionLeaseSnapshot): Promise<ExecutionLeaseSnapshot> {
    const { ref, ...content } = s, dir = this.dir(ref.projectId);
    const bytes = canonicalJson({ ...content, fingerprint: ref.fingerprint });
    if (Buffer.byteLength(bytes) > MAX_ARTIFACT_BYTES) throw new Error("Oversized ExecutionLease write.");
    const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx");
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary ExecutionLease write.");
      await this.options.beforePublish?.();
      linkSync(temp, join(dir, `${ref.runId}.${ref.fingerprint.slice(7)}.json`));
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.options.afterPublish?.();
      return s;
    } finally { await rm(temp, { force: true }); }
  }
  async createLease(claim: EvaluationExecutionClaim, ownerId: string): Promise<ExecutionLeaseSnapshot> {
    const running = readEvaluationExecutionClaim(claim, this.options.projectsBaseDir);
    const initial = snapshot({ schemaVersion: 1, lease: createExecutionLease(running, ownerId), runningRef: evaluationRunRef(running), previousFingerprint: null });
    return new FileGlobalWriterLock({ baseDir: this.dir(initial.ref.projectId) }).withLock(async () => {
      const history = await this.history(initial.ref.projectId), chain = history.get(initial.lease.runId);
      if (chain) {
        if (same(chain[0], initial)) return chain[0];
        throw new Error("Conflicting ExecutionLease ownership.");
      }
      if ([...history.values()].reduce((n, c) => n + c.length, 0) >= MAX_EXECUTION_LEASE_SNAPSHOTS_V1) throw new Error("ExecutionLease capacity; no pruning.");
      return this.write(initial);
    });
  }
  async heartbeat(previous: ExecutionLeaseRef, next: ExecutionLeaseV1): Promise<ExecutionLeaseSnapshot> {
    const ref = this.request(previous), lease = detach(next);
    if (!validateExecutionLease(lease)) throw new Error("Invalid ExecutionLease heartbeat write.");
    return new FileGlobalWriterLock({ baseDir: this.dir(ref.projectId) }).withLock(async () => {
      const history = await this.history(ref.projectId), chain = history.get(ref.runId), current = chain?.[chain.length - 1];
      if (!current || !same(current.ref, ref) || !isExecutionLeaseHeartbeat(current.lease, lease) ||
        Date.parse(lease.heartbeatAt) <= Date.parse(current.lease.heartbeatAt)) throw new Error("Stale/invalid ExecutionLease heartbeat.");
      if ([...history.values()].reduce((n, c) => n + c.length, 0) >= MAX_EXECUTION_LEASE_SNAPSHOTS_V1) throw new Error("ExecutionLease capacity; no pruning.");
      return this.write(snapshot({ schemaVersion: 1, lease, runningRef: current.runningRef, previousFingerprint: ref.fingerprint }));
    });
  }
}
