import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID, UUID_V4, learningFingerprint } from "./learning-v1-contract.ts";
import { evaluationPacketRef, validateEvaluationPacket, type EvaluationPacket, type EvaluationRef } from "./evaluation-contract.ts";
import { evaluationRunRef, validateEvaluationRun, validateEvaluationRunRef, isEvaluationRunTransition, transitionEvaluationRun, MAX_EVALUATION_RUN_BYTES, type EvaluationRun, type EvaluationRunV2, type EvaluationRunV1, type EvaluationRunRef } from "./evaluation-run.ts";
import { initializeExecutionAuthority, assertExecutionAuthority, MAX_EXECUTION_AUTHORITIES_V1 } from "./evaluation-execution-authority-store.ts";
import { FileRecoveryAdmissionStore, allRecoveryAdmissionHistory, recoveryReservationsFit, validateRecoveryAdmissionSources, type RecoveryAdmissionContextV1 } from "./recovery-admission-store.ts";
import { validateRecoveryAdmissionRef, validateRecoveryAdmissionController, validateEvaluationRecoveryPolicy, recoveryPolicyAllows, validateRecoveryReconciliation,
  isSafeRecoveryReconciliation, validateRecoveryResources, recoveryUsageWithin, detachedRecoveryValue, type RecoveryAdmissionControllerV1,
  type EvaluationRecoveryPolicyV1, type RecoveryAdmissionRef, type RecoveryReconciliationV1, type RecoveryResourcesV1 } from "./recovery-admission.ts";
import { FileRecoverySuccessorBindingStore, recoverySuccessorBindingHistory, selectRecoverySuccessorBinding, syncRecoveryDirectory } from "./recovery-successor-binding-store.ts";
import { createRecoverySuccessorBinding, recoverySuccessorCreatedRun, type RecoverySuccessorBindingSnapshot } from "./recovery-successor-binding.ts";
import { recoveryCapacityReservations, recoveryNamespaceNames } from "./recovery-capacity.ts";
import { MAX_EXECUTION_LEASE_SNAPSHOTS_V1, type ExecutionLeaseStore } from "./evaluation-execution-lease-store.ts";
import type { ExecutionAuthorityRef } from "./evaluation-stale-confirmation.ts";

export const MAX_EVALUATION_RUNS_V1 = 4096;
/** Only the caller that uniquely publishes running receives this settlement capability. */
export interface EvaluationExecutionClaim {
  readonly running: EvaluationRunV1 & { readonly status: "running" };
  publishTerminal(run: EvaluationRunV1): Promise<EvaluationRunV1>;
}
// Process-local provenance only: persisted running bytes never reconstruct a live claim.
const executionClaims = new WeakMap<EvaluationExecutionClaim, { root: string; running: EvaluationExecutionClaim["running"] }>();
const executionIncarnation = randomUUID();
/** Metadata publication may consume a genuine claim, but never mint execution authority. */
export function readEvaluationExecutionClaim(claim: EvaluationExecutionClaim, projectsBaseDir: string): EvaluationExecutionClaim["running"] {
  const binding = executionClaims.get(claim);
  if (!binding || binding.root !== resolve(projectsBaseDir)) throw new Error("Missing/foreign live EvaluationRun execution claim.");
  return binding.running;
}
export interface EvaluationRunStore {
  publish(run: EvaluationRun, signal?: AbortSignal, isCurrent?: () => boolean): Promise<EvaluationRun>;
  claimExecution(created: EvaluationRun, startedAt: string): Promise<EvaluationExecutionClaim>;
  get(ref: EvaluationRunRef): Promise<EvaluationRun>;
  getCurrent(projectId: string, runId: string): Promise<EvaluationRun>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
/** Only injected capability is exact packet READ. No evaluator, runtime or semantic-store writes. */
export class FileEvaluationRunStore implements EvaluationRunStore {
  readonly storageBaseDir: string;
  private readonly options: {
    projectsBaseDir: string;
    packets: { get(ref: EvaluationRef): Promise<EvaluationPacket> };
    /** Test-only transaction barriers. */
    beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
  };
  constructor(options: FileEvaluationRunStore["options"]) {
    this.options = { ...options }; this.storageBaseDir = resolve(options.projectsBaseDir);
    materializationStores.set(this, (options, admissionRef, proposedRunId) => this.#materializeRecovery(options, admissionRef, proposedRunId));
  }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid EvaluationRun namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "evaluation-runs-v1");
  }
  private async history(projectId: string): Promise<Map<string, EvaluationRun[]>> {
    const dir = this.dir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw e; }
    names = names.filter((n) => n !== "writer.lock");
    if (names.length > MAX_EVALUATION_RUNS_V1 * 3) throw new Error("Oversized EvaluationRun history.");
    const runs = new Map<string, EvaluationRun[]>();
    for (const name of names.sort()) {
      const match = /^(.+)\.(created|running|completed|failed)\.json$/.exec(name);
      if (!match || !UUID_V4.test(match[1])) throw new Error("Malformed EvaluationRun history.");
      const path = join(dir, name);
      if ((await stat(path)).size > MAX_EVALUATION_RUN_BYTES + 256) throw new Error("Oversized EvaluationRun artifact.");
      const bytes = await readFile(path, "utf8");
      if (Buffer.byteLength(bytes) > MAX_EVALUATION_RUN_BYTES + 256) throw new Error("Oversized EvaluationRun artifact.");
      const value = JSON.parse(bytes);
      if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "fingerprint,run,schemaVersion" || value.schemaVersion !== 1 ||
        !validateEvaluationRun(value.run) || value.fingerprint !== learningFingerprint(value.run) || canonicalJson(value) !== bytes ||
        value.run.packetRef.scope.projectId !== projectId || value.run.runId !== match[1] || value.run.status !== match[2]) throw new Error("Corrupt EvaluationRun artifact.");
      const chain = runs.get(match[1]) ?? []; chain.push(freeze(value.run)); runs.set(match[1], chain);
    }
    if (runs.size > MAX_EVALUATION_RUNS_V1) throw new Error("Oversized EvaluationRun history.");
    for (const chain of runs.values()) {
      const order = { created: 0, running: 1, completed: 2, failed: 2 };
      chain.sort((a, b) => order[a.status] - order[b.status]);
      if (chain[0].status !== "created" || chain.length > 3 || chain.some((r, i) => i > 0 && !isEvaluationRunTransition(chain[i - 1], r))) throw new Error("Corrupt EvaluationRun lifecycle.");
    }
    const bindings = await recoverySuccessorBindingHistory(this.storageBaseDir, projectId);
    for (const s of bindings) {
      const chain = runs.get(s.binding.successorRunId);
      if (chain && !same(chain[0], recoverySuccessorCreatedRun(s.binding))) throw new Error("Conflicting selected successor run.");
    }
    for (const chain of runs.values()) {
      const created = chain[0];
      if (created.schemaVersion !== 2) continue;
      const binding = bindings.find(s => same(s.binding.admissionRef, created.recovery.admissionRef));
      if (!binding || !same(recoverySuccessorCreatedRun(binding.binding), created)) throw new Error("Unbound/conflicting recovered EvaluationRun lineage.");
      const root = runs.get(created.recovery.rootCreatedRef.runId)?.[0];
      const parent = runs.get(created.recovery.parentRunningRef.runId)?.find(r => r.status === "running");
      if (!root || root.schemaVersion !== 1 || !same(evaluationRunRef(root), created.recovery.rootCreatedRef) ||
        !parent || !same(evaluationRunRef(parent), created.recovery.parentRunningRef) ||
        (parent.schemaVersion === 1 ? created.recoveryGeneration !== 1 : created.recoveryGeneration !== parent.recoveryGeneration + 1) ||
        !same(parent.packetRef, created.packetRef) || !same(parent.evaluator, created.evaluator)) throw new Error("Corrupt recovered EvaluationRun root/parent lineage.");
    }
    return runs;
  }
  async get(ref: EvaluationRunRef): Promise<EvaluationRun> {
    const request: unknown = JSON.parse(canonicalJson(ref));
    if (!validateEvaluationRunRef(request)) throw new Error("Invalid exact EvaluationRun ref.");
    const found = (await this.history(request.projectId)).get(request.runId)?.find((r) => r.status === request.status);
    if (!found || !same(evaluationRunRef(found), request)) throw new Error("Missing/mismatched exact EvaluationRun.");
    return found;
  }
  async getCurrent(projectId: string, runId: string): Promise<EvaluationRun> {
    if (!UUID_V4.test(runId)) throw new Error("Invalid EvaluationRun identity.");
    const chain = (await this.history(projectId)).get(runId);
    if (!chain) throw new Error("Missing EvaluationRun.");
    return chain[chain.length - 1];
  }
  /** Caller holds the namespace lock; all lifecycle writes share the same commit frontier. */
  async #writeSnapshot<T extends EvaluationRun>(r: T, check: () => void = () => {}, revalidate?: () => Promise<void>): Promise<T> {
    const dir = this.dir(r.packetRef.scope.projectId);
    const bytes = canonicalJson({ schemaVersion: 1, fingerprint: learningFingerprint(r), run: r });
    const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx");
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary EvaluationRun write.");
      await this.options.beforePublish?.(); await revalidate?.(); check();
      linkSync(temp, join(dir, `${r.runId}.${r.status}.json`));
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.options.afterPublish?.();
      return r;
    } finally { await rm(temp, { force: true }); }
  }
  async claimExecution(created: EvaluationRun, startedAt: string): Promise<EvaluationExecutionClaim> {
    const value: unknown = JSON.parse(canonicalJson(created));
    if (!validateEvaluationRun(value) || value.status !== "created") throw new Error("Execution claim requires a valid created EvaluationRun.");
    if (value.schemaVersion === 2) throw new Error("Recovered EvaluationRun execution remains disabled.");
    const request = freeze(value);
    const running = freeze(transitionEvaluationRun(request, "running", startedAt)) as EvaluationExecutionClaim["running"];
    const dir = this.dir(request.packetRef.scope.projectId);
    let authority: ExecutionAuthorityRef;
    await new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      const chain = (await this.history(request.packetRef.scope.projectId)).get(request.runId);
      if (!chain || !same(chain[0], request)) throw new Error("Missing/mismatched committed EvaluationRun.");
      // An identical running publication is NOT an ownership retry. Only its unique creator may execute.
      if (chain.length !== 1) throw new Error("EvaluationRun execution already claimed or terminal.");
      // Created publication already validated the exact packet binding. Claim before loading it so
      // missing/corrupt packets can leave a durable execution failure rather than a stranded created run.
      const reserved = await recoveryCapacityReservations(this.storageBaseDir, request.packetRef.scope.projectId);
      const authorityNames = await recoveryNamespaceNames(this.storageBaseDir, request.packetRef.scope.projectId, "execution-authorities-v1");
      if (new Set(authorityNames.map(n => n.split(".")[0])).size + reserved.authoritySlots >= MAX_EXECUTION_AUTHORITIES_V1)
        throw new Error("Execution authority capacity/reservations; no pruning.");
      await this.#writeSnapshot(running);
      authority = (await initializeExecutionAuthority(this.storageBaseDir, { schemaVersion: 1, kind: "owned", epoch: 0,
        runningRef: evaluationRunRef(running), claimId: randomUUID(), incarnation: executionIncarnation })).ref;
    });
    const claim = Object.freeze({ running, publishTerminal: (run: EvaluationRunV1) => this.publishExecutionTerminal(running, authority!, run) });
    executionClaims.set(claim, { root: resolve(this.options.projectsBaseDir), running });
    return claim;
  }
  private async publishExecutionTerminal(running: EvaluationExecutionClaim["running"], authority: ExecutionAuthorityRef, terminal: EvaluationRunV1): Promise<EvaluationRunV1> {
    const value: unknown = JSON.parse(canonicalJson(terminal));
    if (!validateEvaluationRun(value) || value.schemaVersion !== 1 || !isEvaluationRunTransition(running, value)) throw new Error("Invalid claimed EvaluationRun terminal transition.");
    const run = freeze(value), dir = this.dir(run.packetRef.scope.projectId);
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      const chain = (await this.history(run.packetRef.scope.projectId)).get(run.runId);
      if (!chain || !same(chain[1], running)) throw new Error("Missing/mismatched EvaluationRun execution claim.");
      await assertExecutionAuthority(this.storageBaseDir, evaluationRunRef(running), authority);
      const current = chain[chain.length - 1];
      if (current.status !== "running") {
        if (current.schemaVersion === 1 && same(current, run)) return current;
        throw new Error("Conflicting EvaluationRun terminal publication.");
      }
      // Settlement attests execution of this exact committed attempt, not current packet availability.
      // No packet/source read here: loss of immutable inputs must not prevent recording a failure.
      return this.#writeSnapshot(run);
    });
  }
  async publish(run: EvaluationRun, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<EvaluationRun> {
    const value: unknown = JSON.parse(canonicalJson(run));
    if (!validateEvaluationRun(value)) throw new Error("Invalid EvaluationRun write.");
    if (value.schemaVersion === 2) throw new Error("Recovered v2 publication requires unique successor materialization.");
    const r = freeze(value), dir = this.dir(r.packetRef.scope.projectId);
    const check = () => { signal?.throwIfAborted(); if (!isCurrent()) throw new Error("Stale EvaluationRun authority."); };
    check();
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      check();
      const history = await this.history(r.packetRef.scope.projectId), chain = history.get(r.runId);
      if ((await recoverySuccessorBindingHistory(this.storageBaseDir, r.packetRef.scope.projectId)).some(s => s.binding.successorRunId === r.runId))
        throw new Error("Selected recovery target requires narrow materialization.");
      const existing = chain?.find((v) => v.status === r.status);
      if (existing && !same(existing, r)) throw new Error("Conflicting EvaluationRun publication.");
      if (!existing && (chain ? !isEvaluationRunTransition(chain[chain.length - 1], r) : r.status !== "created")) throw new Error("Invalid EvaluationRun transition.");
      // Terminal writes cannot bypass a revoked claim through the ordinary publisher.
      // Legacy unfenced running history remains readable, but cannot settle online.
      if (r.status === "completed" || r.status === "failed" || r.status === "running" && chain?.some(v => v.status === "running")) {
        const running = chain?.find(v => v.status === "running");
        if (!running) throw new Error("Missing EvaluationRun execution authority.");
        await assertExecutionAuthority(this.storageBaseDir, evaluationRunRef(running));
      }
      if (!chain && history.size + (await recoveryCapacityReservations(this.storageBaseDir, r.packetRef.scope.projectId)).runSlots >= MAX_EVALUATION_RUNS_V1)
        throw new Error("EvaluationRun capacity/reservations; no pruning.");
      // Read only the immutable packet, including retries; never re-resolve live/raw sources.
      const packet: unknown = JSON.parse(canonicalJson(await this.options.packets.get(r.packetRef))); check();
      if (!validateEvaluationPacket(packet) || !same(evaluationPacketRef(packet), r.packetRef) || packet.fingerprint !== r.packetFingerprint) throw new Error("Unresolved exact EvaluationRun packet.");
      if (existing) return existing;
      return this.#writeSnapshot(r, check);
    }, signal);
  }
  /** Only the registered factory can reach this locked creation primitive. Never returns a claim. */
  async #materializeRecovery(options: RecoverySuccessorMaterializerOptions, admissionRef: RecoveryAdmissionRef, proposedRunId?: string): Promise<RecoverySuccessorMaterialization> {
    if (!validateRecoveryAdmissionRef(admissionRef) || proposedRunId !== undefined && !UUID_V4.test(proposedRunId)) throw new Error("Invalid recovery materialization request.");
    const ref = detachedRecoveryValue(admissionRef), root = this.storageBaseDir, project = ref.projectId;
    const runs = { get: this.get.bind(this), getCurrent: this.getCurrent.bind(this) };
    return new FileGlobalWriterLock({ baseDir: join(root, "recovery-admission-control-v1") }).withLock(() =>
      new FileGlobalWriterLock({ baseDir: this.dir(project) }).withLock(() =>
        new FileGlobalWriterLock({ baseDir: join(root, project, "learning-v1", "execution-leases-v1") }).withLock(async () => {
          const admission = await new FileRecoveryAdmissionStore({ projectsBaseDir: root }).get(ref), a = admission.admission, b = a.binding;
          const context = detachedRecoveryValue({ binding: b, originAuthorityRef: a.originAuthorityRef });
          const bindings = new FileRecoverySuccessorBindingStore({ projectsBaseDir: root });
          let selected = await bindings.find(ref);
          if (selected && proposedRunId !== undefined && proposedRunId !== selected.binding.successorRunId) throw new Error("Conflicting successor selection.");
          const validate = async () => {
            if (options.isAuthorized(context) !== true) throw new Error("Unauthorized recovery materialization.");
            if (!recoveryPolicyAllows(options.policy, b)) throw new Error("Recovery materialization policy forbids existing admission.");
            if (!same((await new FileRecoveryAdmissionStore({ projectsBaseDir: root }).get(ref)), admission)) throw new Error("Changed exact admission.");
            await validateRecoveryAdmissionSources(root, a, { runs, leases: options.leases, packets: this.options.packets });
            const report = await options.reconciliation.inspect(context), resource = await options.resources.inspect(context), at = options.now();
            if (!validateRecoveryReconciliation(report) || !isSafeRecoveryReconciliation(report) || report.observedAt !== at || Date.parse(at) < Date.parse(a.admittedAt) || selected !== null && Date.parse(at) < Date.parse(selected.binding.selectedAt) ||
              !same({ ...report, observedAt: a.admittedAt }, a.reconciliation)) throw new Error("Unsafe/changed current recovery reconciliation.");
            if (!validateRecoveryResources(resource) || resource.opportunityKey !== b.opportunityKey || resource.observedAt !== at ||
              !same(resource.reservation, a.resources.reservation) || !recoveryUsageWithin(a.resources.oldAttemptUsage, resource.oldAttemptUsage) ||
              !recoveryUsageWithin(resource.oldAttemptUsage, resource.evaluationBaseUsage) || !recoveryUsageWithin(resource.evaluationBaseUsage, resource.globalBaseUsage))
              throw new Error("Unknown/changed recovery resource facts.");
            const admissions = await allRecoveryAdmissionHistory(root);
            const evaluationReservations = admissions.filter(s => s.ref.logicalEvaluationKey === b.logicalEvaluationKey).map(s => s.admission.resources.reservation);
            if (evaluationReservations.length > options.policy.maxRecoveryAdmissions || !recoveryUsageWithin(a.resources.reservation, options.policy.perAdmission) ||
              !recoveryReservationsFit(resource.evaluationBaseUsage, evaluationReservations, options.policy.perEvaluation) ||
              !recoveryReservationsFit(resource.globalBaseUsage, admissions.map(s => s.admission.resources.reservation), options.policy.global)) throw new Error("Recovery materialization budget exhausted.");
            const history = await this.history(project), reserved = await recoveryCapacityReservations(root, project);
            const authorities = await recoveryNamespaceNames(root, project, "execution-authorities-v1"), leases = await recoveryNamespaceNames(root, project, "execution-leases-v1");
            // The current admission is already in reserved counts. No extra slot or generation is charged.
            if (Math.min(resource.capacity.runSlots, MAX_EVALUATION_RUNS_V1 - history.size) < reserved.runSlots ||
              Math.min(resource.capacity.authoritySlots, MAX_EXECUTION_AUTHORITIES_V1 - new Set(authorities.map(n => n.split(".")[0])).size) < reserved.authoritySlots ||
              Math.min(resource.capacity.leaseSlots, MAX_EXECUTION_LEASE_SNAPSHOTS_V1 - leases.length) < reserved.leaseSlots)
              throw new Error("Insufficient current recovery reservation capacity.");
            for (const family of ["evaluation-results-v1", "evaluation-outputs-v1"])
              if ((await recoveryNamespaceNames(root, project, family)).length) throw new Error("Unsupported committed/ambiguous output surface.");
            if (options.isAuthorized(context) !== true) throw new Error("Unauthorized recovery materialization.");
          };
          await validate();
          await syncRecoveryDirectory(join(root, project, "learning-v1", "recovery-admissions-v1"));
          if (!selected) {
            const binding = createRecoverySuccessorBinding(a, proposedRunId ?? randomUUID(), options.now());
            if ((await this.history(project)).has(binding.successorRunId)) throw new Error("Conflicting occupied successor target.");
            selected = await selectRecoverySuccessorBinding(root, binding, { revalidate: validate, beforePublish: options.beforeBindingPublish, afterPublish: options.afterBindingPublish });
          } else await syncRecoveryDirectory(join(root, project, "learning-v1", "recovery-successor-bindings-v1"));
          await validate();
          const created = detachedRecoveryValue(recoverySuccessorCreatedRun(selected.binding));
          const chain = (await this.history(project)).get(created.runId);
          if (chain) {
            if (chain.length !== 1 || !same(chain[0], created)) throw new Error("Conflicting successor run history.");
            await syncRecoveryDirectory(this.dir(project));
          } else {
            // Fresh gates run after temp preparation as well, immediately before the exclusive link.
            await this.#writeSnapshot(created, () => { if (options.isAuthorized(context) !== true) throw new Error("Unauthorized recovery materialization."); }, validate);
          }
          return detachedRecoveryValue({ successor: selected, run: created, runRef: evaluationRunRef(created) });
        })));
  }

}

export interface RecoverySuccessorMaterializerOptions {
  projectsBaseDir: string; runs: FileEvaluationRunStore;
  controller: RecoveryAdmissionControllerV1; policy: EvaluationRecoveryPolicyV1;
  leases: Pick<ExecutionLeaseStore, "getCurrent"> & { readonly storageBaseDir: string };
  reconciliation: { inspect(context: RecoveryAdmissionContextV1): Promise<RecoveryReconciliationV1> };
  resources: { inspect(context: RecoveryAdmissionContextV1): Promise<RecoveryResourcesV1> };
  now(): string;
  isAuthorized(context: RecoveryAdmissionContextV1): boolean;
  /** Test-only binding transaction barriers. Run publication uses the RunStore barriers. */
  beforeBindingPublish?: () => Promise<void>; afterBindingPublish?: () => Promise<void>;
}
export interface RecoverySuccessorMaterialization {
  readonly successor: RecoverySuccessorBindingSnapshot;
  readonly run: EvaluationRunV2;
  readonly runRef: EvaluationRunRef;
}
export interface RecoverySuccessorMaterializer {
  materialize(ref: RecoveryAdmissionRef, proposedRunId?: string): Promise<RecoverySuccessorMaterialization>;
}
// No exported raw v2 writer or persistable bearer token. Registered capability closes over the genuine store.
const materializationStores = new WeakMap<FileEvaluationRunStore, (options: RecoverySuccessorMaterializerOptions, ref: RecoveryAdmissionRef, proposedRunId?: string) => Promise<RecoverySuccessorMaterialization>>();
export function createRecoverySuccessorMaterializer(options: RecoverySuccessorMaterializerOptions): RecoverySuccessorMaterializer {
  const root = resolve(options.projectsBaseDir), materialize = materializationStores.get(options.runs);
  if (!materialize || options.runs.storageBaseDir !== root || options.leases.storageBaseDir !== root ||
    !validateRecoveryAdmissionController(options.controller) || !validateEvaluationRecoveryPolicy(options.policy) ||
    typeof options.reconciliation?.inspect !== "function" || typeof options.resources?.inspect !== "function" || typeof options.now !== "function" || typeof options.isAuthorized !== "function")
    throw new Error("Invalid recovery materialization registration.");
  const captured = { ...options, projectsBaseDir: root, controller: detachedRecoveryValue(options.controller), policy: detachedRecoveryValue(options.policy),
    leases: { storageBaseDir: root, getCurrent: options.leases.getCurrent.bind(options.leases) },
    reconciliation: { inspect: options.reconciliation.inspect.bind(options.reconciliation) }, resources: { inspect: options.resources.inspect.bind(options.resources) } };
  return Object.freeze({ materialize: (ref: RecoveryAdmissionRef, proposedRunId?: string) => materialize(captured, ref, proposedRunId) });
}
