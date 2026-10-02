import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, PROJECT_ID } from "./learning-v1-contract.ts";
import { FileRecoveryAdmissionStore } from "./recovery-admission-store.ts";
import { MAX_RECOVERY_ADMISSIONS_V1, validateRecoveryAdmissionRef, detachedRecoveryValue, sameRecoveryValue, type RecoveryAdmissionRef } from "./recovery-admission.ts";
import { MAX_RECOVERY_SUCCESSOR_BINDING_BYTES, validateRecoverySuccessorBindingRef, recoverySuccessorBindingSnapshot, assertRecoverySuccessorAdmission,
  type RecoverySuccessorBindingV1, type RecoverySuccessorBindingRef, type RecoverySuccessorBindingSnapshot } from "./recovery-successor-binding.ts";

function directory(root: string, project: string): string {
  if (!PROJECT_ID.test(project)) throw new Error("Invalid recovery successor project.");
  return join(root, project, "learning-v1", "recovery-successor-bindings-v1");
}
const slot = (r: RecoveryAdmissionRef) => `${r.fingerprint.slice(7)}.json`;
export async function syncRecoveryDirectory(path: string): Promise<void> {
  const d = await open(path, "r"); try { await d.sync(); } finally { await d.close(); }
}
export async function recoverySuccessorBindingHistory(root: string, project: string): Promise<RecoverySuccessorBindingSnapshot[]> {
  const dir = directory(root, project);
  let names: string[];
  try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  names = names.filter(n => n !== "writer.lock");
  if (names.length > MAX_RECOVERY_ADMISSIONS_V1) throw new Error("RecoverySuccessorBinding capacity exceeded.");
  const result: RecoverySuccessorBindingSnapshot[] = [], targets = new Set<string>(), opportunities = new Set<string>();
  const admissions = new FileRecoveryAdmissionStore({ projectsBaseDir: root });
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Malformed successor binding history.");
    const path = join(dir, name);
    if ((await stat(path)).size > MAX_RECOVERY_SUCCESSOR_BINDING_BYTES + 256) throw new Error("Oversized successor binding artifact.");
    const bytes = await readFile(path, "utf8");
    if (Buffer.byteLength(bytes) > MAX_RECOVERY_SUCCESSOR_BINDING_BYTES + 256) throw new Error("Oversized successor binding artifact.");
    const v = JSON.parse(bytes);
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "binding,fingerprint,schemaVersion" || v.schemaVersion !== 1 || canonicalJson(v) !== bytes)
      throw new Error("Corrupt successor binding envelope.");
    const s = recoverySuccessorBindingSnapshot(v.binding), b = s.binding;
    if (b.projectId !== project || slot(b.admissionRef) !== name || s.ref.fingerprint !== v.fingerprint) throw new Error("Corrupt successor binding identity/digest.");
    assertRecoverySuccessorAdmission(b, (await admissions.get(b.admissionRef)).admission);
    if (targets.has(b.successorRunId) || opportunities.has(b.opportunityKey)) throw new Error("Conflicting sibling successor binding.");
    targets.add(b.successorRunId); opportunities.add(b.opportunityKey); result.push(s);
  }
  return result;
}
/** Exact historical reads only; a binding does not authorize run publication or execution. */
export class FileRecoverySuccessorBindingStore {
  readonly storageBaseDir: string;
  constructor(options: { projectsBaseDir: string }) { this.storageBaseDir = resolve(options.projectsBaseDir); }
  async find(admissionRef: RecoveryAdmissionRef): Promise<RecoverySuccessorBindingSnapshot | null> {
    if (!validateRecoveryAdmissionRef(admissionRef)) throw new Error("Invalid exact admission ref.");
    const r = detachedRecoveryValue(admissionRef);
    // Reject foreign/missing admissions even if no binding has yet been selected.
    await new FileRecoveryAdmissionStore({ projectsBaseDir: this.storageBaseDir }).get(r);
    return (await recoverySuccessorBindingHistory(this.storageBaseDir, r.projectId)).find(s => sameRecoveryValue(s.binding.admissionRef, r)) ?? null;
  }
  async get(ref: RecoverySuccessorBindingRef): Promise<RecoverySuccessorBindingSnapshot> {
    if (!validateRecoverySuccessorBindingRef(ref)) throw new Error("Invalid exact successor binding ref.");
    const r = detachedRecoveryValue(ref), found = await this.find(r.admissionRef);
    if (!found || !sameRecoveryValue(found.ref, r)) throw new Error("Missing/mismatched exact successor binding.");
    return found;
  }
}
/** Internal immutable selection primitive. Caller holds global → Run → Lease locks.
 * This selects metadata only and exposes no EvaluationRun publication capability. */
export async function selectRecoverySuccessorBinding(root: string, input: RecoverySuccessorBindingV1, hooks: {
  revalidate(): Promise<void>; beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>;
}): Promise<RecoverySuccessorBindingSnapshot> {
  const s = recoverySuccessorBindingSnapshot(input), b = s.binding, dir = directory(root, b.projectId);
  return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
    assertRecoverySuccessorAdmission(b, (await new FileRecoveryAdmissionStore({ projectsBaseDir: root }).get(b.admissionRef)).admission);
    const history = await recoverySuccessorBindingHistory(root, b.projectId), existing = history.find(v => sameRecoveryValue(v.binding.admissionRef, b.admissionRef));
    if (existing) {
      if (!sameRecoveryValue(existing, s)) throw new Error("Conflicting successor selection.");
      await syncRecoveryDirectory(dir); return existing;
    }
    if (history.some(v => v.binding.successorRunId === b.successorRunId) || history.length >= MAX_RECOVERY_ADMISSIONS_V1) throw new Error("Conflicting/capacity successor selection.");
    const bytes = canonicalJson({ schemaVersion: 1, binding: b, fingerprint: s.ref.fingerprint }), temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
    try {
      const f = await open(temp, "wx"); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      if (await readFile(temp, "utf8") !== bytes) throw new Error("Invalid temporary successor binding write.");
      await hooks.beforePublish?.(); await hooks.revalidate();
      linkSync(temp, join(dir, slot(b.admissionRef))); await syncRecoveryDirectory(dir); await hooks.afterPublish?.(); return s;
    } finally { await rm(temp, { force: true }); }
  });
}
