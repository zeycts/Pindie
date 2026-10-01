import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID, UUID_V4, isExecutableStrategyHypothesis } from "./learning-v1-contract.ts";
import { hypothesisRef } from "./discovery-hypotheses.ts";
import { trialEvidenceRef, validateTrialEvidenceV2 } from "./trial-evidence-v2.ts";
import { evaluationPacketRef, validateEvaluationPacket, validateEvaluationRef, MAX_EVALUATION_PACKET_BYTES, type EvaluationPacket, type EvaluationRef } from "./evaluation-contract.ts";
import type { EvaluationPacketReaders } from "./evaluation-packet-builder.ts";

export const MAX_EVALUATION_PACKETS_V1 = 4096;
const MAX_ARTIFACT_BYTES = MAX_EVALUATION_PACKET_BYTES + 256;
interface StoredPacket { readonly schemaVersion: 1; readonly createdAt: string; readonly packet: EvaluationPacket }
export interface EvaluationPacketMetadata {
  readonly createdAt: string; readonly packetRef: EvaluationRef;
  readonly artifactSize: number; readonly referencedEvidenceCount: number;
}
export interface EvaluationPacketStore {
  publish(packet: EvaluationPacket, signal?: AbortSignal, isCurrent?: () => boolean): Promise<EvaluationPacket>;
  get(ref: EvaluationRef): Promise<EvaluationPacket>;
  exists(ref: EvaluationRef): Promise<boolean>;
  validate(ref: EvaluationRef): Promise<EvaluationPacketMetadata>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
/** R4-C1 standalone immutable inputs only; no lifecycle, execution or trust wiring. */
export class FileEvaluationPacketStore implements EvaluationPacketStore {
  private readonly options: {
    projectsBaseDir: string; readers: EvaluationPacketReaders;
    /** Test-only transaction barriers. */
    beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
  };
  constructor(options: FileEvaluationPacketStore["options"]) { this.options = options; }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Evaluation packet namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "evaluation-packets-v1");
  }
  private request(ref: EvaluationRef): EvaluationRef {
    const copy: unknown = JSON.parse(canonicalJson(ref));
    if (!validateEvaluationRef(copy, "evaluation-packet")) throw new Error("Invalid exact Evaluation packet ref.");
    return freeze(copy);
  }
  private async read(projectId: string, id: string): Promise<{ stored: StoredPacket; size: number } | null> {
    const path = join(this.dir(projectId), `${id}.json`);
    let size: number;
    try { size = (await stat(path)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (size > MAX_ARTIFACT_BYTES) throw new Error("Oversized Evaluation packet artifact.");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_ARTIFACT_BYTES) throw new Error("Oversized Evaluation packet artifact.");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "createdAt,packet,schemaVersion") throw new Error("Corrupt Evaluation packet envelope.");
    const stored = value as StoredPacket;
    if (stored.schemaVersion !== 1 || typeof stored.createdAt !== "string" || new Date(stored.createdAt).toISOString() !== stored.createdAt ||
      !validateEvaluationPacket(stored.packet) || stored.packet.id !== id || stored.packet.scope.projectId !== projectId || canonicalJson(stored) !== text) throw new Error("Corrupt Evaluation packet artifact.");
    return { stored: freeze(stored), size: Buffer.byteLength(text) };
  }
  private async exact(ref: EvaluationRef) {
    const request = this.request(ref), found = await this.read(request.scope.projectId, request.id);
    if (found && !same(evaluationPacketRef(found.stored.packet), request)) throw new Error("Mismatched exact Evaluation packet.");
    return found;
  }
  async get(ref: EvaluationRef): Promise<EvaluationPacket> {
    const found = await this.exact(ref);
    if (!found) throw new Error("Missing exact Evaluation packet.");
    return found.stored.packet;
  }
  /** False only for absence; malformed or conflicting artifacts throw, never appear absent. */
  async exists(ref: EvaluationRef): Promise<boolean> { return (await this.exact(ref)) !== null; }
  async validate(ref: EvaluationRef): Promise<EvaluationPacketMetadata> {
    const found = await this.exact(ref);
    if (!found) throw new Error("Missing exact Evaluation packet.");
    return freeze({ createdAt: found.stored.createdAt, packetRef: evaluationPacketRef(found.stored.packet), artifactSize: found.size, referencedEvidenceCount: found.stored.packet.trials.length });
  }
  async publish(packet: EvaluationPacket, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<EvaluationPacket> {
    // Detach and freeze canonical bytes before the first await.
    const text = canonicalJson(packet), value: unknown = JSON.parse(text);
    if (!validateEvaluationPacket(value)) throw new Error("Invalid Evaluation packet write.");
    const p = freeze(value), dir = this.dir(p.scope.projectId);
    const check = () => { signal?.throwIfAborted(); if (!isCurrent()) throw new Error("Stale Evaluation packet authority."); };
    check();
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      check();
      const names = (await readdir(dir)).filter((n) => n !== "writer.lock");
      if (names.length > MAX_EVALUATION_PACKETS_V1 || names.some((n) => !n.endsWith(".json") || !UUID_V4.test(n.slice(0, -5)))) throw new Error("Malformed/full Evaluation packet history.");
      let existing: StoredPacket | undefined;
      for (const name of names.sort()) {
        const found = await this.read(p.scope.projectId, name.slice(0, -5));
        if (!found) throw new Error("Missing Evaluation packet history.");
        if (found.stored.packet.id === p.id) existing = found.stored;
      }
      if (existing && !same(existing.packet, p)) throw new Error("Conflicting exact Evaluation packet.");
      if (!existing && names.length >= MAX_EVALUATION_PACKETS_V1) throw new Error("Evaluation packet capacity; no pruning.");
      // Re-resolve only immutable inputs, including excluded entries. Never dereference nested raw provenance.
      const h: unknown = JSON.parse(canonicalJson(await this.options.readers.hypothesis.readExact(p.hypothesis))); check();
      if (!isExecutableStrategyHypothesis(h) || !same(hypothesisRef(h), p.hypothesis) || !same(h, p.hypothesisSnapshot)) throw new Error("Unresolved exact Evaluation hypothesis.");
      const refs = freeze(p.trials.map((t) => t.ref));
      const raw = this.options.readers.evidence.readExactMany ? await this.options.readers.evidence.readExactMany(refs) : await Promise.all(refs.map((r) => this.options.readers.evidence.readExact(r)));
      const evidence: unknown = JSON.parse(canonicalJson(raw)); check();
      if (!Array.isArray(evidence) || evidence.length !== refs.length || !evidence.every((e, i) => validateTrialEvidenceV2(e) && same(trialEvidenceRef(e), refs[i]) && same(e, p.trials[i].snapshot))) throw new Error("Unresolved exact Evaluation TrialEvidence.");
      if (existing) return existing.packet;
      const stored: StoredPacket = { schemaVersion: 1, createdAt: new Date().toISOString(), packet: p }, bytes = canonicalJson(stored);
      const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
      try {
        const file = await open(temp, "wx");
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        // Validate the actual temporary bytes, not merely the caller's object.
        if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary Evaluation packet write.");
        await this.options.beforePublish?.(); check();
        // Synchronous unique creation keeps the authority check adjacent to the commit frontier.
        linkSync(temp, join(dir, `${p.id}.json`));
        const directory = await open(dir, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        await this.options.afterPublish?.();
        return p;
      } finally { await rm(temp, { force: true }); }
    }, signal);
  }
}
