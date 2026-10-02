import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID } from "./learning-v1-contract.ts";
import { evaluationPacketRef, validateEvaluationPacket } from "./evaluation-contract.ts";
import type { EvaluationPacketStore } from "./evaluation-packet-store.ts";
import { FileExecutionAuthorityStore, evaluationRunWriterDirectory, MAX_EXECUTION_AUTHORITIES_V1 } from "./evaluation-execution-authority-store.ts";
import { MAX_EVALUATION_RUNS_V1, type EvaluationRunStore } from "./evaluation-run-store.ts";
import { MAX_EXECUTION_LEASE_SNAPSHOTS_V1, type ExecutionLeaseStore } from "./evaluation-execution-lease-store.ts";
import { evaluationRunRef } from "./evaluation-run.ts";
import { recoveryAdmissionSnapshot, validateRecoveryAdmissionRef, validateRecoveryAdmissionController, validateEvaluationRecoveryPolicy,
  validateRecoveryReconciliation, isSafeRecoveryReconciliation, validateRecoveryResources, detachedRecoveryValue, sameRecoveryValue,
  recoveryUsageWithin, recoveryPolicyAllows, MAX_RECOVERY_ADMISSION_BYTES, MAX_RECOVERY_ADMISSIONS_V1, type RecoveryAdmissionV1, type RecoveryAdmissionRef, type RecoveryAdmissionSnapshot,
  type RecoveryAdmissionBindingV1, type RecoveryReconciliationV1, type RecoveryResourcesV1, type EvaluationRecoveryPolicyV1,
  type RecoveryAdmissionControllerV1, type RecoveryUsageV1 } from "./recovery-admission.ts";

const same = sameRecoveryValue;
const dir = (root: string, project: string) => {
  if (!PROJECT_ID.test(project)) throw new Error("Invalid recovery admission project.");
  return join(root, project, "learning-v1", "recovery-admissions-v1");
};
const slotName = (ref: RecoveryAdmissionRef) => `${ref.logicalEvaluationKey.slice(7)}.${ref.generation}.json`;
async function syncDirectory(path: string): Promise<void> {
  const d = await open(path, "r"); try { await d.sync(); } finally { await d.close(); }
}
async function namesOrEmpty(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
async function history(root: string, project: string): Promise<RecoveryAdmissionSnapshot[]> {
  const path = dir(root, project), names = (await namesOrEmpty(path)).filter(n => n !== "writer.lock");
  if (names.length > MAX_RECOVERY_ADMISSIONS_V1) throw new Error("RecoveryAdmission capacity exceeded.");
  const snapshots: RecoveryAdmissionSnapshot[] = [], parents = new Set<string>(), slots = new Set<string>();
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.[1-9][0-9]*\.json$/.test(name)) throw new Error("Malformed RecoveryAdmission history.");
    const file = join(path, name);
    if ((await stat(file)).size > MAX_RECOVERY_ADMISSION_BYTES + 256) throw new Error("Oversized RecoveryAdmission artifact.");
    const bytes = await readFile(file, "utf8");
    if (Buffer.byteLength(bytes) > MAX_RECOVERY_ADMISSION_BYTES + 256) throw new Error("Oversized RecoveryAdmission artifact.");
    const v = JSON.parse(bytes);
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "admission,fingerprint,schemaVersion" || v.schemaVersion !== 1 || canonicalJson(v) !== bytes)
      throw new Error("Corrupt RecoveryAdmission envelope.");
    const s = recoveryAdmissionSnapshot(v.admission), b = s.admission.binding;
    if (s.ref.projectId !== project || slotName(s.ref) !== name || s.ref.fingerprint !== v.fingerprint) throw new Error("Corrupt RecoveryAdmission identity/digest.");
    // C7-A has no recovered runs or successor bindings from which to prove later generations.
    if (b.generation !== 1 || b.previousAdmissionRef !== null) throw new Error("Unsupported/incomplete recovery lineage.");
    if (parents.has(b.oldRunningRef.runId) || slots.has(`${b.logicalEvaluationKey}.${b.generation}`)) throw new Error("Conflicting RecoveryAdmission parent/slot.");
    parents.add(b.oldRunningRef.runId); slots.add(`${b.logicalEvaluationKey}.${b.generation}`); snapshots.push(s);
  }
  return snapshots;
}
/** Exact historical metadata lookup; no source reads, publication or execution capability. */
export class FileRecoveryAdmissionStore {
  readonly storageBaseDir: string;
  constructor(options: { projectsBaseDir: string }) { this.storageBaseDir = resolve(options.projectsBaseDir); }
  async get(ref: RecoveryAdmissionRef): Promise<RecoveryAdmissionSnapshot> {
    if (!validateRecoveryAdmissionRef(ref)) throw new Error("Invalid exact RecoveryAdmission ref.");
    const request = detachedRecoveryValue(ref);
    if (!validateRecoveryAdmissionRef(request)) throw new Error("Invalid detached RecoveryAdmission ref.");
    const found = (await history(this.storageBaseDir, request.projectId)).find(s => same(s.ref, request));
    if (!found) throw new Error("Missing/mismatched exact RecoveryAdmission.");
    return found;
  }
}
async function allHistory(root: string): Promise<RecoveryAdmissionSnapshot[]> {
  const entries = await readdir(root, { withFileTypes: true }), result: RecoveryAdmissionSnapshot[] = [];
  const projects = entries.filter(e => PROJECT_ID.test(e.name));
  if (projects.length > MAX_RECOVERY_ADMISSIONS_V1) throw new Error("Oversized recovery project inventory.");
  for (const e of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) throw new Error("Invalid recovery project inventory.");
    result.push(...await history(root, e.name));
    if (result.length > MAX_RECOVERY_ADMISSIONS_V1) throw new Error("RecoveryAdmission global capacity exceeded.");
  }
  return result;
}
function fits(base: RecoveryUsageV1, reservations: readonly RecoveryUsageV1[], limit: RecoveryUsageV1): boolean {
  return (["tokens", "costMicros", "durationMs"] as const).every(k => {
    let total = base[k];
    for (const r of reservations) { total += r[k]; if (!Number.isSafeInteger(total)) return false; }
    return total <= limit[k];
  });
}
export interface RecoveryAdmissionCoordinator {
  admit(record: RecoveryAdmissionV1): Promise<RecoveryAdmissionSnapshot>;
}
export interface RecoveryAdmissionContextV1 {
  readonly binding: RecoveryAdmissionBindingV1; readonly originAuthorityRef: RecoveryAdmissionV1["originAuthorityRef"];
}
/** Separate registration from C6 confirmation. Receives reads/factual gates only, never execution writers. */
export function createRecoveryAdmissionCoordinator(options: {
  projectsBaseDir: string; controller: RecoveryAdmissionControllerV1; policy: EvaluationRecoveryPolicyV1;
  runs: Pick<EvaluationRunStore, "get" | "getCurrent"> & { readonly storageBaseDir: string };
  leases: Pick<ExecutionLeaseStore, "getCurrent"> & { readonly storageBaseDir: string };
  packets: Pick<EvaluationPacketStore, "get">;
  reconciliation: { inspect(context: RecoveryAdmissionContextV1): Promise<RecoveryReconciliationV1> };
  resources: { inspect(context: RecoveryAdmissionContextV1): Promise<RecoveryResourcesV1> };
  now(): string;
  isAuthorized(context: RecoveryAdmissionContextV1): boolean;
  /** Test-only transaction barriers. */
  beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
}): RecoveryAdmissionCoordinator {
  const root = resolve(options.projectsBaseDir);
  if (!validateRecoveryAdmissionController(options.controller) || !validateEvaluationRecoveryPolicy(options.policy) || options.runs.storageBaseDir !== root || options.leases.storageBaseDir !== root ||
    typeof options.packets?.get !== "function" || typeof options.reconciliation?.inspect !== "function" || typeof options.resources?.inspect !== "function" || typeof options.now !== "function" || typeof options.isAuthorized !== "function")
    throw new Error("Invalid recovery admission registration.");
  const controller = detachedRecoveryValue(options.controller), policy = detachedRecoveryValue(options.policy);
  if (!validateRecoveryAdmissionController(controller) || !validateEvaluationRecoveryPolicy(policy)) throw new Error("Invalid detached recovery registration.");
  const getRun = options.runs.get.bind(options.runs), currentRun = options.runs.getCurrent.bind(options.runs);
  const currentLease = options.leases.getCurrent.bind(options.leases), getPacket = options.packets.get.bind(options.packets);
  const inspect = options.reconciliation.inspect.bind(options.reconciliation), resources = options.resources.inspect.bind(options.resources);
  const now = options.now, authorized = options.isAuthorized, before = options.beforePublish, after = options.afterPublish;
  const authorities = new FileExecutionAuthorityStore({ projectsBaseDir: root });
  return Object.freeze({ async admit(input: RecoveryAdmissionV1): Promise<RecoveryAdmissionSnapshot> {
    const s = recoveryAdmissionSnapshot(input), a = s.admission, b = a.binding;
    const context = detachedRecoveryValue({ binding: b, originAuthorityRef: a.originAuthorityRef });
    const checkAuthorization = () => {
      if (!same(a.controller, controller) || !same(a.policy, policy) || authorized(context) !== true) throw new Error("Unauthorized recovery admission.");
    };
    checkAuthorization();
    if (b.generation !== 1 || b.previousAdmissionRef !== null) throw new Error("Unsupported recovery generation; successor lineage is not implemented.");
    // Resource accounting serializes all admissions in this projects-root scope, before project locks.
    return new FileGlobalWriterLock({ baseDir: join(root, "recovery-admission-control-v1") }).withLock(() =>
      new FileGlobalWriterLock({ baseDir: evaluationRunWriterDirectory(root, b.projectId) }).withLock(() =>
        new FileGlobalWriterLock({ baseDir: join(root, b.projectId, "learning-v1", "execution-leases-v1") }).withLock(() =>
          new FileGlobalWriterLock({ baseDir: dir(root, b.projectId) }).withLock(async () => {
            const validateSources = async () => {
              checkAuthorization();
              const run = await currentRun(b.projectId, b.oldRunningRef.runId), created = await getRun(b.rootCreatedRef);
              if (run.status !== "running" || !same(evaluationRunRef(run), b.oldRunningRef) || !same(run.packetRef, b.packetRef) || run.packetFingerprint !== b.packetFingerprint ||
                !same(run.evaluator, b.evaluator) || !same(created.packetRef, b.packetRef) || !same(created.evaluator, b.evaluator)) throw new Error("Changed old run/packet/evaluator binding.");
              const revoked = await authorities.get(b.confirmationRef), current = await authorities.getCurrent(b.projectId, run.runId), origin = await authorities.get(a.originAuthorityRef);
              if (!same(current, revoked) || revoked.record.kind !== "stale-confirmation" || origin.record.kind !== "owned" ||
                !same(revoked.record.runningRef, b.oldRunningRef) || !same(revoked.record.previousAuthorityRef, a.originAuthorityRef) || revoked.record.newFencingEpoch !== b.fencingEpoch ||
                !same(origin.record.runningRef, b.oldRunningRef) || origin.record.epoch !== 0) throw new Error("Missing/exact revoked authority required.");
              const lease = await currentLease(b.projectId, run.runId);
              if (!same(lease.ref, revoked.record.previousLeaseRef) || !same(lease.runningRef, b.oldRunningRef) || lease.lease.ownerId !== revoked.record.previousOwnerId || lease.lease.acquiredAt !== run.startedAt)
                throw new Error("Changed stale-confirmation lease predecessor.");
              const packet = await getPacket(b.packetRef);
              if (!validateEvaluationPacket(packet) || !same(evaluationPacketRef(packet), b.packetRef)) throw new Error("Changed exact EvaluationPacket.");
              if (Date.parse(a.admittedAt) < Date.parse(revoked.record.confirmedAt) || a.reconciliation.cessation.claimId !== origin.record.claimId ||
                a.reconciliation.cessation.incarnation !== origin.record.incarnation || a.reconciliation.cessation.handleId !== revoked.record.evidence.handleId)
                throw new Error("Incomplete/mismatched cessation provenance.");
              // Acknowledge the exact validated fence's directory durability without writing authority bytes.
              await syncDirectory(join(root, b.projectId, "learning-v1", "execution-authorities-v1"));
            };
            await validateSources();
            const existingHistory = await allHistory(root);
            const existing = existingHistory.find(v => v.ref.projectId === b.projectId &&
              (v.admission.binding.oldRunningRef.runId === b.oldRunningRef.runId || v.ref.logicalEvaluationKey === b.logicalEvaluationKey && v.ref.generation === b.generation));
            if (existing) {
              if (!same(existing, s)) throw new Error("Conflicting recovery admission.");
              await syncDirectory(dir(root, b.projectId)); checkAuthorization(); return existing;
            }
            if (existingHistory.length >= MAX_RECOVERY_ADMISSIONS_V1) throw new Error("RecoveryAdmission capacity; no pruning.");
            const validateEligibility = async () => {
              await validateSources();
              if (!recoveryPolicyAllows(policy, b)) throw new Error("Recovery generation/evaluator policy forbids admission.");
              const report = await inspect(context), resource = await resources(context);
              if (!validateRecoveryReconciliation(report) || !isSafeRecoveryReconciliation(report) || !same(report, a.reconciliation)) throw new Error("Unsafe/ambiguous recovery reconciliation.");
              if (!validateRecoveryResources(resource) || !same(resource, a.resources)) throw new Error("Unknown/changed recovery resource facts.");
              const timestamp = now();
              if (timestamp !== a.admittedAt) throw new Error("Stale recovery admission clock/proof sample.");
              const r = a.resources, evaluationReservations = existingHistory.filter(v => v.ref.logicalEvaluationKey === b.logicalEvaluationKey).map(v => v.admission.resources.reservation);
              const globalReservations = existingHistory.map(v => v.admission.resources.reservation);
              if (!recoveryUsageWithin(r.oldAttemptUsage, r.evaluationBaseUsage) || !recoveryUsageWithin(r.evaluationBaseUsage, r.globalBaseUsage) ||
                !recoveryUsageWithin(r.reservation, policy.perAdmission) || !fits(r.evaluationBaseUsage, [...evaluationReservations, r.reservation], policy.perEvaluation) ||
                !fits(r.globalBaseUsage, [...globalReservations, r.reservation], policy.global) || evaluationReservations.length >= policy.maxRecoveryAdmissions)
                throw new Error("Recovery budget/attempt limit exceeded.");
              const pending = existingHistory.filter(v => v.ref.projectId === b.projectId).length;
              const runNames = await namesOrEmpty(evaluationRunWriterDirectory(root, b.projectId));
              const authorityNames = await namesOrEmpty(join(root, b.projectId, "learning-v1", "execution-authorities-v1"));
              const leaseNames = await namesOrEmpty(join(root, b.projectId, "learning-v1", "execution-leases-v1"));
              const runCount = runNames.filter(n => n.endsWith(".created.json")).length;
              const authorityCount = new Set(authorityNames.map(n => n.split(".")[0])).size;
              const leaseCount = leaseNames.filter(n => n !== "writer.lock").length;
              if (Math.min(r.capacity.runSlots, MAX_EVALUATION_RUNS_V1 - runCount) <= pending ||
                Math.min(r.capacity.authoritySlots, MAX_EXECUTION_AUTHORITIES_V1 - authorityCount) <= pending ||
                Math.min(r.capacity.leaseSlots, MAX_EXECUTION_LEASE_SNAPSHOTS_V1 - leaseCount) <= pending)
                throw new Error("Insufficient recovery capacity.");
              for (const family of ["evaluation-results-v1", "evaluation-outputs-v1"]) {
                if ((await namesOrEmpty(join(root, b.projectId, "learning-v1", family))).length) throw new Error("Unsupported committed/ambiguous output surface.");
              }
              checkAuthorization();
            };
            await validateEligibility();
            const path = dir(root, b.projectId), bytes = canonicalJson({ schemaVersion: 1, admission: a, fingerprint: s.ref.fingerprint });
            const temp = join(path, "writer.lock", `${randomUUID()}.tmp`);
            try {
              const file = await open(temp, "wx"); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
              if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary RecoveryAdmission write.");
              await before?.(); await validateEligibility();
              linkSync(temp, join(path, slotName(s.ref))); await syncDirectory(path); await after?.(); return s;
            } finally { await rm(temp, { force: true }); }
          }))));
  } });
}
