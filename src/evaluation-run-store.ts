import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID, UUID_V4, learningFingerprint } from "./learning-v1-contract.ts";
import { evaluationPacketRef, validateEvaluationPacket, type EvaluationPacket, type EvaluationRef } from "./evaluation-contract.ts";
import { evaluationRunRef, validateEvaluationRun, validateEvaluationRunRef, isEvaluationRunTransition, transitionEvaluationRun, MAX_EVALUATION_RUN_BYTES, type EvaluationRunV1, type EvaluationRunRef } from "./evaluation-run.ts";

export const MAX_EVALUATION_RUNS_V1 = 4096;
/** Only the caller that uniquely publishes running receives this settlement capability. */
export interface EvaluationExecutionClaim {
  readonly running: EvaluationRunV1 & { readonly status: "running" };
  publishTerminal(run: EvaluationRunV1): Promise<EvaluationRunV1>;
}
export interface EvaluationRunStore {
  publish(run: EvaluationRunV1, signal?: AbortSignal, isCurrent?: () => boolean): Promise<EvaluationRunV1>;
  claimExecution(created: EvaluationRunV1, startedAt: string): Promise<EvaluationExecutionClaim>;
  get(ref: EvaluationRunRef): Promise<EvaluationRunV1>;
  getCurrent(projectId: string, runId: string): Promise<EvaluationRunV1>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
/** Only injected capability is exact packet READ. No evaluator, runtime or semantic-store writes. */
export class FileEvaluationRunStore implements EvaluationRunStore {
  private readonly options: {
    projectsBaseDir: string;
    packets: { get(ref: EvaluationRef): Promise<EvaluationPacket> };
    /** Test-only transaction barriers. */
    beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
  };
  constructor(options: FileEvaluationRunStore["options"]) { this.options = options; }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid EvaluationRun namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "evaluation-runs-v1");
  }
  private async history(projectId: string): Promise<Map<string, EvaluationRunV1[]>> {
    const dir = this.dir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw e; }
    names = names.filter((n) => n !== "writer.lock");
    if (names.length > MAX_EVALUATION_RUNS_V1 * 3) throw new Error("Oversized EvaluationRun history.");
    const runs = new Map<string, EvaluationRunV1[]>();
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
    return runs;
  }
  async get(ref: EvaluationRunRef): Promise<EvaluationRunV1> {
    const request: unknown = JSON.parse(canonicalJson(ref));
    if (!validateEvaluationRunRef(request)) throw new Error("Invalid exact EvaluationRun ref.");
    const found = (await this.history(request.projectId)).get(request.runId)?.find((r) => r.status === request.status);
    if (!found || !same(evaluationRunRef(found), request)) throw new Error("Missing/mismatched exact EvaluationRun.");
    return found;
  }
  async getCurrent(projectId: string, runId: string): Promise<EvaluationRunV1> {
    if (!UUID_V4.test(runId)) throw new Error("Invalid EvaluationRun identity.");
    const chain = (await this.history(projectId)).get(runId);
    if (!chain) throw new Error("Missing EvaluationRun.");
    return chain[chain.length - 1];
  }
  /** Caller holds the namespace lock; all lifecycle writes share the same commit frontier. */
  private async writeSnapshot(r: EvaluationRunV1, check: () => void = () => {}): Promise<EvaluationRunV1> {
    const dir = this.dir(r.packetRef.scope.projectId);
    const bytes = canonicalJson({ schemaVersion: 1, fingerprint: learningFingerprint(r), run: r });
    const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx");
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary EvaluationRun write.");
      await this.options.beforePublish?.(); check();
      linkSync(temp, join(dir, `${r.runId}.${r.status}.json`));
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      await this.options.afterPublish?.();
      return r;
    } finally { await rm(temp, { force: true }); }
  }
  async claimExecution(created: EvaluationRunV1, startedAt: string): Promise<EvaluationExecutionClaim> {
    const value: unknown = JSON.parse(canonicalJson(created));
    if (!validateEvaluationRun(value) || value.status !== "created") throw new Error("Execution claim requires a valid created EvaluationRun.");
    const request = freeze(value);
    const running = freeze(transitionEvaluationRun(request, "running", startedAt)) as EvaluationExecutionClaim["running"];
    const dir = this.dir(request.packetRef.scope.projectId);
    await new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      const chain = (await this.history(request.packetRef.scope.projectId)).get(request.runId);
      if (!chain || !same(chain[0], request)) throw new Error("Missing/mismatched committed EvaluationRun.");
      // An identical running publication is NOT an ownership retry. Only its unique creator may execute.
      if (chain.length !== 1) throw new Error("EvaluationRun execution already claimed or terminal.");
      // Created publication already validated the exact packet binding. Claim before loading it so
      // missing/corrupt packets can leave a durable execution failure rather than a stranded created run.
      await this.writeSnapshot(running);
    });
    return Object.freeze({ running, publishTerminal: (run: EvaluationRunV1) => this.publishExecutionTerminal(running, run) });
  }
  private async publishExecutionTerminal(running: EvaluationExecutionClaim["running"], terminal: EvaluationRunV1): Promise<EvaluationRunV1> {
    const value: unknown = JSON.parse(canonicalJson(terminal));
    if (!validateEvaluationRun(value) || !isEvaluationRunTransition(running, value)) throw new Error("Invalid claimed EvaluationRun terminal transition.");
    const run = freeze(value), dir = this.dir(run.packetRef.scope.projectId);
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      const chain = (await this.history(run.packetRef.scope.projectId)).get(run.runId);
      if (!chain || !same(chain[1], running)) throw new Error("Missing/mismatched EvaluationRun execution claim.");
      const current = chain[chain.length - 1];
      if (current.status !== "running") {
        if (same(current, run)) return current;
        throw new Error("Conflicting EvaluationRun terminal publication.");
      }
      // Settlement attests execution of this exact committed attempt, not current packet availability.
      // No packet/source read here: loss of immutable inputs must not prevent recording a failure.
      return this.writeSnapshot(run);
    });
  }
  async publish(run: EvaluationRunV1, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<EvaluationRunV1> {
    const value: unknown = JSON.parse(canonicalJson(run));
    if (!validateEvaluationRun(value)) throw new Error("Invalid EvaluationRun write.");
    const r = freeze(value), dir = this.dir(r.packetRef.scope.projectId);
    const check = () => { signal?.throwIfAborted(); if (!isCurrent()) throw new Error("Stale EvaluationRun authority."); };
    check();
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      check();
      const history = await this.history(r.packetRef.scope.projectId), chain = history.get(r.runId);
      const existing = chain?.find((v) => v.status === r.status);
      if (existing && !same(existing, r)) throw new Error("Conflicting EvaluationRun publication.");
      if (!existing && (chain ? !isEvaluationRunTransition(chain[chain.length - 1], r) : r.status !== "created")) throw new Error("Invalid EvaluationRun transition.");
      if (!chain && history.size >= MAX_EVALUATION_RUNS_V1) throw new Error("EvaluationRun capacity; no pruning.");
      // Read only the immutable packet, including retries; never re-resolve live/raw sources.
      const packet: unknown = JSON.parse(canonicalJson(await this.options.packets.get(r.packetRef))); check();
      if (!validateEvaluationPacket(packet) || !same(evaluationPacketRef(packet), r.packetRef) || packet.fingerprint !== r.packetFingerprint) throw new Error("Unresolved exact EvaluationRun packet.");
      if (existing) return existing;
      return this.writeSnapshot(r, check);
    }, signal);
  }
}
