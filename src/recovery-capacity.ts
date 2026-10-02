import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, learningFingerprint } from "./learning-v1-contract.ts";
import { MAX_EVALUATION_RUN_BYTES } from "./evaluation-run.ts";
import { recoveryAdmissionHistory } from "./recovery-admission-store.ts";
import { recoverySuccessorBindingHistory } from "./recovery-successor-binding-store.ts";
import { recoverySuccessorCreatedRun } from "./recovery-successor-binding.ts";

export async function recoveryNamespaceNames(root: string, project: string, family: string): Promise<string[]> {
  try { return (await readdir(join(root, project, "learning-v1", family))).filter(n => n !== "writer.lock"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
/** Caller holds Run lock. Materialized runs consume their reserved run slot exactly once.
 * Recovered execution is disabled, so every admission still reserves authority/lease space. */
export async function recoveryCapacityReservations(root: string, project: string): Promise<{ runSlots: number; authoritySlots: number; leaseSlots: number }> {
  const admissions = await recoveryAdmissionHistory(root, project), bindings = await recoverySuccessorBindingHistory(root, project);
  let materialized = 0;
  for (const s of bindings) {
    const run = recoverySuccessorCreatedRun(s.binding);
    let bytes: string;
    try {
      const path = join(root, project, "learning-v1", "evaluation-runs-v1", `${run.runId}.created.json`);
      if ((await stat(path)).size > MAX_EVALUATION_RUN_BYTES + 256) throw new Error("Oversized reserved recovery target.");
      bytes = await readFile(path, "utf8");
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (bytes !== canonicalJson({ schemaVersion: 1, fingerprint: learningFingerprint(run), run })) throw new Error("Conflicting recovery reserved target.");
    materialized++;
  }
  return { runSlots: admissions.length - materialized, authoritySlots: admissions.length, leaseSlots: admissions.length };
}
