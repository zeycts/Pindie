import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchesLearningArtifactRef, PROJECT_ID, UUID_V4, validateTrialAssignment, type TrialAssignment } from "./learning-v1-contract.ts";
import { validateTrialOfferReceipt, type TrialOfferReceipt } from "./trial-offer-contract.ts";

/** Frozen v1 compatibility reader. No reservation, watcher, preflight or publication. */
export interface TrialOfferCommit { readonly schemaVersion: 1; readonly receipt: TrialOfferReceipt; readonly assignment: TrialAssignment | null }
export function validateTrialOfferCommit(v: unknown): v is TrialOfferCommit {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "assignment,receipt,schemaVersion") return false;
  const c = v as TrialOfferCommit;
  if (c.schemaVersion !== 1 || !validateTrialOfferReceipt(c.receipt)) return false;
  const a = c.assignment, r = c.receipt;
  return r.outcome === "no-offer" ? a === null : a !== null && validateTrialAssignment(a) &&
    matchesLearningArtifactRef(r.assignment, a) && a.projectId === r.projectId && a.workEpisodeId === r.workEpisodeId &&
    a.offerPolicyVersion === r.offerPolicyVersion && a.offerPolicyFingerprint === r.offerPolicyFingerprint && a.createdAt === r.createdAt;
}
export class FileTrialOfferStore {
  private readonly root: string;
  constructor(options: { projectsBaseDir?: string } = {}) { this.root = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects"); }
  async find(projectId: string, episodeId: string): Promise<TrialOfferCommit | null> {
    if (!PROJECT_ID.test(projectId) || !UUID_V4.test(episodeId)) throw new Error("Invalid offer namespace/episode.");
    const dir = join(this.root, projectId, "learning-v1", "trial-offers");
    const json = async (name: string): Promise<unknown | null> => {
      try { const text = await readFile(join(dir, name), "utf8"); if (text.length > 16_384) throw new Error("Oversized offer artifact."); const value: unknown = JSON.parse(text); if (value === null) throw new Error("Malformed null offer artifact."); return value; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    };
    const c = await json(`${episodeId}.json`), intent = await json(`${episodeId}.pending.json`);
    if (intent !== null && (!validateTrialOfferReceipt(intent) || intent.projectId !== projectId || intent.workEpisodeId !== episodeId || intent.reason !== "interrupted" || intent.outcome !== "no-offer")) throw new Error("Malformed offer intent.");
    if (c === null) return null; // Never finalize an obsolete interrupted publication.
    if (!validateTrialOfferCommit(c) || c.receipt.projectId !== projectId || c.receipt.workEpisodeId !== episodeId) throw new Error("Malformed offer commit.");
    if (!validateTrialOfferReceipt(intent) || c.receipt.offerPolicyFingerprint !== intent.offerPolicyFingerprint || c.receipt.createdAt !== intent.createdAt) throw new Error("Ambiguous committed offer intent.");
    return c;
  }
}
