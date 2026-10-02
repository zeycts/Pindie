import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID, UUID_V4 } from "./learning-v1-contract.ts";
import { evaluationRunRef, type EvaluationRunRef } from "./evaluation-run.ts";
import type { EvaluationRunStore } from "./evaluation-run-store.ts";
import type { ExecutionLeaseStore } from "./evaluation-execution-lease-store.ts";
import { assessExecutionLeaseFreshness, validateExecutionLeaseClockSample, validateExecutionLeaseStalePolicy, type ExecutionLeaseStalePolicyV1, type ExecutionLeaseAssessmentClock } from "./evaluation-execution-lease-assessment.ts";
import { executionAuthoritySnapshot, freezeExecutionAuthority, validateExecutionAuthorityRef, validateStaleConfirmation, validateExecutionCessationEvidence,
  MAX_EXECUTION_AUTHORITY_BYTES, type ExecutionAuthorityRef, type ExecutionAuthorityOriginV1, type ExecutionAuthoritySnapshot, type StaleConfirmationV1, type ExecutionCessationEvidenceV1 } from "./evaluation-stale-confirmation.ts";

// Each admitted claim reserves exactly one origin and one revocation slot.
export const MAX_EXECUTION_AUTHORITIES_V1 = 4096;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function evaluationRunWriterDirectory(root: string, projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error("Invalid execution authority project.");
  return join(root, projectId, "learning-v1", "evaluation-runs-v1");
}
function authorityDirectory(root: string, projectId: string): string {
  evaluationRunWriterDirectory(root, projectId);
  return join(root, projectId, "learning-v1", "execution-authorities-v1");
}
async function history(root: string, projectId: string): Promise<Map<string, ExecutionAuthoritySnapshot[]>> {
  const dir = authorityDirectory(root, projectId);
  let names: string[];
  try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw e; }
  if (names.length > MAX_EXECUTION_AUTHORITIES_V1 * 2) throw new Error("Oversized execution authority history.");
  const chains = new Map<string, ExecutionAuthoritySnapshot[]>();
  for (const name of names.sort()) {
    const match = /^(.+)\.([a-f0-9]{64})\.json$/.exec(name);
    if (!match || !UUID_V4.test(match[1])) throw new Error("Malformed execution authority history.");
    const path = join(dir, name);
    if ((await stat(path)).size > MAX_EXECUTION_AUTHORITY_BYTES + 256) throw new Error("Oversized execution authority artifact.");
    const bytes = await readFile(path, "utf8");
    if (Buffer.byteLength(bytes) > MAX_EXECUTION_AUTHORITY_BYTES + 256) throw new Error("Oversized execution authority artifact.");
    const value = JSON.parse(bytes);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "fingerprint,record,schemaVersion" ||
      value.schemaVersion !== 1 || canonicalJson(value) !== bytes) throw new Error("Corrupt execution authority artifact.");
    const s = executionAuthoritySnapshot(value.record);
    if (s.ref.runId !== match[1] || s.ref.projectId !== projectId || s.ref.fingerprint !== value.fingerprint || value.fingerprint !== `sha256:${match[2]}`)
      throw new Error("Corrupt execution authority binding.");
    const chain = chains.get(s.ref.runId) ?? []; chain.push(s); chains.set(s.ref.runId, chain);
  }
  if (chains.size > MAX_EXECUTION_AUTHORITIES_V1) throw new Error("Execution authority capacity exceeded.");
  for (const chain of chains.values()) {
    chain.sort((a, b) => Number(a.record.kind !== "owned") - Number(b.record.kind !== "owned"));
    const origin = chain[0];
    if (origin.record.kind !== "owned" || chain.length > 2) throw new Error("Missing/conflicting execution authority origin.");
    if (chain.length === 2) {
      const next = chain[1].record;
      if (next.kind !== "stale-confirmation" || next.previousLeaseEpoch !== origin.record.epoch || next.newFencingEpoch !== 1 ||
        !same(next.previousAuthorityRef, origin.ref) || !same(next.runningRef, origin.record.runningRef) ||
        next.evidence.claimId !== origin.record.claimId || next.evidence.incarnation !== origin.record.incarnation)
        throw new Error("Corrupt execution authority predecessor/epoch.");
    }
  }
  return chains;
}
async function syncDirectory(dir: string): Promise<void> {
  const d = await open(dir, "r"); try { await d.sync(); } finally { await d.close(); }
}
async function write(root: string, s: ExecutionAuthoritySnapshot, before?: () => Promise<void>, after?: () => Promise<void>, check: () => void = () => {}): Promise<ExecutionAuthoritySnapshot> {
  const dir = authorityDirectory(root, s.ref.projectId);
  await mkdir(dir, { recursive: true });
  const bytes = canonicalJson({ schemaVersion: 1, record: s.record, fingerprint: s.ref.fingerprint });
  const temp = join(evaluationRunWriterDirectory(root, s.ref.projectId), "writer.lock", `${randomUUID()}.tmp`);
  try {
    const f = await open(temp, "wx"); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary execution authority write.");
    await before?.(); check();
    linkSync(temp, join(dir, `${s.ref.runId}.${s.ref.fingerprint.slice(7)}.json`));
    await syncDirectory(dir); await after?.(); return s;
  } finally { await rm(temp, { force: true }); }
}
/** Read-only public artifact store. No confirmation publisher is exposed. */
export class FileExecutionAuthorityStore {
  readonly storageBaseDir: string;
  constructor(options: { projectsBaseDir: string }) { this.storageBaseDir = resolve(options.projectsBaseDir); }
  async get(ref: ExecutionAuthorityRef): Promise<ExecutionAuthoritySnapshot> {
    if (!validateExecutionAuthorityRef(ref)) throw new Error("Invalid exact execution authority ref.");
    const request = freezeExecutionAuthority(JSON.parse(canonicalJson(ref)));
    if (!validateExecutionAuthorityRef(request)) throw new Error("Invalid detached execution authority ref.");
    const found = (await history(this.storageBaseDir, request.projectId)).get(request.runId)?.find(s => same(s.ref, request));
    if (!found) throw new Error("Missing exact execution authority.");
    return found;
  }
  async getCurrent(projectId: string, runId: string): Promise<ExecutionAuthoritySnapshot> {
    if (!UUID_V4.test(runId)) throw new Error("Invalid execution authority run.");
    const chain = (await history(this.storageBaseDir, projectId)).get(runId);
    if (!chain) throw new Error("Missing execution authority.");
    return chain[chain.length - 1];
  }
}
/** Internal claim-publication helper. Caller holds RunStore lock; never reconstructs a live claim. */
export async function initializeExecutionAuthority(root: string, origin: ExecutionAuthorityOriginV1): Promise<ExecutionAuthoritySnapshot> {
  const s = executionAuthoritySnapshot(origin), chains = await history(root, s.ref.projectId);
  if (chains.has(s.ref.runId)) throw new Error("Execution authority already initialized.");
  if (chains.size >= MAX_EXECUTION_AUTHORITIES_V1) throw new Error("Execution authority capacity; no pruning.");
  return write(root, s);
}
/** Internal writer fence. Caller holds RunStore lock until its final artifact link. */
export async function assertExecutionAuthority(root: string, running: EvaluationRunRef, expected?: ExecutionAuthorityRef): Promise<void> {
  const current = await new FileExecutionAuthorityStore({ projectsBaseDir: root }).getCurrent(running.projectId, running.runId);
  if (current.record.kind !== "owned" || !same(current.record.runningRef, running) || expected && !same(current.ref, expected))
    throw new Error("Revoked/stale execution epoch.");
}

export interface RecoveryCoordinator {
  confirm(record: StaleConfirmationV1): Promise<ExecutionAuthoritySnapshot>;
}
/** Registration grants a narrow confirmation capability, never execution or retry authority. */
export function createRecoveryCoordinator(options: {
  projectsBaseDir: string;
  confirmer: StaleConfirmationV1["confirmer"];
  runs: Pick<EvaluationRunStore, "getCurrent"> & { readonly storageBaseDir: string };
  leases: Pick<ExecutionLeaseStore, "getCurrent"> & { readonly storageBaseDir: string };
  ownerMonitor: { inspect(origin: ExecutionAuthoritySnapshot): Promise<ExecutionCessationEvidenceV1> };
  clock: ExecutionLeaseAssessmentClock;
  policy: ExecutionLeaseStalePolicyV1;
  isAuthorized(record: StaleConfirmationV1): boolean;
  /** Test-only publication barriers. */
  beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
}): RecoveryCoordinator {
  if (!options.confirmer || Object.keys(options.confirmer).sort().join() !== "id,incarnation" ||
    [options.confirmer.id, options.confirmer.incarnation].some(v => typeof v !== "string" || !v.trim() || v.length > 128))
    throw new Error("Invalid confirmer identity.");
  const root = resolve(options.projectsBaseDir), identity = freezeExecutionAuthority(JSON.parse(canonicalJson(options.confirmer)));
  if (!validateExecutionLeaseStalePolicy(options.policy)) throw new Error("Invalid confirmation policy.");
  const policy = freezeExecutionAuthority(JSON.parse(canonicalJson(options.policy)));
  if (!validateExecutionLeaseStalePolicy(policy)) throw new Error("Invalid detached confirmation policy.");
  if (options.runs.storageBaseDir !== root || options.leases.storageBaseDir !== root ||
    !identity || Object.keys(identity).sort().join() !== "id,incarnation" || [identity.id, identity.incarnation].some(v => typeof v !== "string" || !v.trim() || v.length > 128) ||
    typeof options.ownerMonitor?.inspect !== "function" || typeof options.clock?.now !== "function" || typeof options.isAuthorized !== "function")
    throw new Error("Invalid Recovery Coordinator registration.");
  // Capture configured functions/receivers; later caller mutation cannot replace authority sources.
  const getRun = options.runs.getCurrent.bind(options.runs), getLease = options.leases.getCurrent.bind(options.leases);
  const inspect = options.ownerMonitor.inspect.bind(options.ownerMonitor), now = options.clock.now.bind(options.clock);
  const authorized = options.isAuthorized, before = options.beforePublish, after = options.afterPublish;
  return Object.freeze({ async confirm(input: StaleConfirmationV1): Promise<ExecutionAuthoritySnapshot> {
    if (!validateStaleConfirmation(input)) throw new Error("Invalid stale confirmation.");
    const s = executionAuthoritySnapshot(input), record = s.record as StaleConfirmationV1;
    const check = () => { if (!same(record.confirmer, identity) || !same(record.policy, policy) || authorized(record) !== true) throw new Error("Unauthorized stale confirmation."); };
    check();
    return new FileGlobalWriterLock({ baseDir: evaluationRunWriterDirectory(root, s.ref.projectId) }).withLock(() =>
      new FileGlobalWriterLock({ baseDir: join(root, s.ref.projectId, "learning-v1", "execution-leases-v1") }).withLock(async () => {
        check();
        const chains = await history(root, s.ref.projectId), chain = chains.get(record.runId);
        if (!chain) throw new Error("Missing execution authority origin.");
        const current = chain[chain.length - 1];
        if (current.record.kind === "stale-confirmation") {
          if (!same(current, s)) throw new Error("Conflicting stale confirmation.");
          // Reconcile linked-but-unacknowledged publication without re-deciding or executing.
          await syncDirectory(authorityDirectory(root, s.ref.projectId)); check(); return current;
        }
        if (!same(current.ref, record.previousAuthorityRef) || record.previousLeaseEpoch !== current.record.epoch ||
          record.evidence.claimId !== current.record.claimId || record.evidence.incarnation !== current.record.incarnation)
          throw new Error("Stale execution authority predecessor/epoch.");
        const run = await getRun(s.ref.projectId, record.runId), lease = await getLease(s.ref.projectId, record.runId);
        if (run.status !== "running" || !same(evaluationRunRef(run), record.runningRef) || !same(current.record.runningRef, record.runningRef) ||
          !same(lease.runningRef, record.runningRef) || !same(lease.ref, record.previousLeaseRef) || lease.lease.ownerId !== record.previousOwnerId || lease.lease.acquiredAt !== run.startedAt)
          throw new Error("Stale run/lease predecessor.");
        const proof = await inspect(current);
        if (!validateExecutionCessationEvidence(proof) || !same(proof, record.evidence) || Date.parse(proof.observedAt) < Date.parse(lease.lease.heartbeatAt))
          throw new Error("Missing/conflicting exact cessation proof.");
        const clock = now();
        if (!validateExecutionLeaseClockSample(clock) || !same(clock, record.clock) ||
          assessExecutionLeaseFreshness(lease.lease, record.policy, clock).state !== "STALE_CANDIDATE") throw new Error("Unconfirmed stale candidate.");
        check();
        return write(root, s, before, after, check);
      }));
  } });
}
