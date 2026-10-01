import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { FINGERPRINT, PROJECT_ID, UUID_V4, canonicalJson, learningArtifactFingerprint, learningFingerprint, validateLearningArtifactRef, isExecutableStrategyHypothesis, validateExactEvidenceRef, type ExactEvidenceRef, type LearningArtifactRef, type StrategyHypothesisV2 } from "./learning-v1-contract.ts";
import { nonconflictingOpenHypotheses, validateOpenHypotheses, type OpenHypothesisReader } from "./open-hypotheses.ts";
import { hypothesisRef } from "./discovery-hypotheses.ts";

export interface AssignmentPolicy {
  readonly version: 1; readonly enabled: boolean; readonly maxAssignmentsPerHypothesis: number;
  readonly cooldownMs: number; readonly operationTimeoutMs: number;
}
export const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = Object.freeze({ version: 1, enabled: true, maxAssignmentsPerHypothesis: 3, cooldownMs: 86_400_000, operationTimeoutMs: 100 });
export function validateAssignmentPolicy(value: unknown): value is AssignmentPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as AssignmentPolicy;
  return Object.keys(p).sort().join() === Object.keys(DEFAULT_ASSIGNMENT_POLICY).sort().join() && p.version === 1 && typeof p.enabled === "boolean" &&
    Number.isSafeInteger(p.maxAssignmentsPerHypothesis) && p.maxAssignmentsPerHypothesis > 0 && Number.isSafeInteger(p.cooldownMs) && p.cooldownMs >= 0 &&
    Number.isSafeInteger(p.operationTimeoutMs) && p.operationTimeoutMs > 0 && p.operationTimeoutMs <= 1000;
}
export interface TrialAssignmentV2 {
  readonly schemaVersion: 2; readonly id: string; readonly fingerprint: string; readonly projectId: string; readonly workEpisodeId: string;
  readonly hypothesis: LearningArtifactRef; readonly comparison: readonly ExactEvidenceRef[];
  readonly assignmentPolicyVersion: number; readonly assignmentPolicyFingerprint: string; readonly createdAt: string;
}
export function validateTrialAssignmentV2(value: unknown): value is TrialAssignmentV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as TrialAssignmentV2;
  try {
    return Object.keys(a).sort().join() === "assignmentPolicyFingerprint,assignmentPolicyVersion,comparison,createdAt,fingerprint,hypothesis,id,projectId,schemaVersion,workEpisodeId" &&
      a.schemaVersion === 2 && typeof a.id === "string" && UUID_V4.test(a.id) && typeof a.projectId === "string" && PROJECT_ID.test(a.projectId) && typeof a.workEpisodeId === "string" && UUID_V4.test(a.workEpisodeId) &&
      validateLearningArtifactRef(a.hypothesis, "strategy-hypothesis") && a.hypothesis.scope.kind === "project" && a.hypothesis.scope.projectId === a.projectId &&
      Array.isArray(a.comparison) && a.comparison.length <= 8 && a.comparison.every((r) => validateExactEvidenceRef(r) && r.projectId === a.projectId) &&
      new Set(a.comparison.map(canonicalJson)).size === a.comparison.length && Number.isSafeInteger(a.assignmentPolicyVersion) && a.assignmentPolicyVersion > 0 &&
      typeof a.assignmentPolicyFingerprint === "string" && FINGERPRINT.test(a.assignmentPolicyFingerprint) && typeof a.createdAt === "string" && new Date(a.createdAt).toISOString() === a.createdAt &&
      a.fingerprint === learningArtifactFingerprint(a as unknown as Record<string, unknown>);
  } catch { return false; }
}
export const MAX_TRIAL_ASSIGNMENTS_V2 = 2048;
export type AssignmentResult = { readonly status: "created" | "existing"; readonly assignment: TrialAssignmentV2 } | { readonly status: "none" };
export interface AssignmentAuthority { readonly projectId: string; readonly workEpisodeId: string; readonly signal: AbortSignal; readonly isCurrent: () => boolean; readonly deadline?: number }
export interface TrialAssignmentStore {
  assignIfAbsent(authority: AssignmentAuthority, policy: AssignmentPolicy, reader: OpenHypothesisReader, now: () => number): Promise<AssignmentResult>;
  readExact(assignment: TrialAssignmentV2): Promise<TrialAssignmentV2>;
}
function checkpoint(a: AssignmentAuthority): void {
  a.signal.throwIfAborted();
  if (!a.isCurrent() || (a.deadline !== undefined && (!Number.isFinite(a.deadline) || Date.now() >= a.deadline))) throw new Error("Stale/expired assignment authority.");
}
const sameHypothesis = (a: TrialAssignmentV2, h: StrategyHypothesisV2) => canonicalJson(a.hypothesis) === canonicalJson(hypothesisRef(h));
/** One filesystem writer lock per project; no Task State lock or legacy offer namespace. */
export class FileTrialAssignmentStore implements TrialAssignmentStore {
  private readonly options: { projectsBaseDir: string; beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void> };
  constructor(options: FileTrialAssignmentStore["options"]) { this.options = options; }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid assignment namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "trial-assignments-v2");
  }
  private async history(projectId: string, check: () => void = () => {}): Promise<TrialAssignmentV2[]> {
    const dir = this.dir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    names = names.filter((n) => n !== "writer.lock");
    if (names.length > MAX_TRIAL_ASSIGNMENTS_V2 || names.some((n) => !UUID_V4.test(n.slice(0, -5)) || !n.endsWith(".json"))) throw new Error("Malformed/full assignment history.");
    const result: TrialAssignmentV2[] = [];
    for (const name of names.sort()) {
      check();
      const path = join(dir, name);
      if ((await stat(path)).size > 16_384) throw new Error("Oversized assignment.");
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 16_384) throw new Error("Oversized assignment.");
      const value: unknown = JSON.parse(text);
      if (!validateTrialAssignmentV2(value) || value.projectId !== projectId || `${value.workEpisodeId}.json` !== name) throw new Error("Corrupt assignment history.");
      result.push(value);
    }
    if (new Set(result.map((a) => a.id)).size !== result.length || new Set(result.map((a) => a.fingerprint)).size !== result.length) throw new Error("Ambiguous assignment history.");
    return result;
  }
  async readExact(a: TrialAssignmentV2): Promise<TrialAssignmentV2> {
    if (!validateTrialAssignmentV2(a)) throw new Error("Invalid exact assignment.");
    const found = (await this.history(a.projectId)).find((v) => v.workEpisodeId === a.workEpisodeId);
    if (!found || found.id !== a.id || found.fingerprint !== a.fingerprint) throw new Error("Missing exact assignment.");
    return found;
  }
  async assignIfAbsent(a: AssignmentAuthority, policy: AssignmentPolicy, reader: OpenHypothesisReader, now: () => number): Promise<AssignmentResult> {
    if (!validateAssignmentPolicy(policy) || !UUID_V4.test(a.workEpisodeId)) throw new Error("Invalid scheduling input.");
    a = { ...a, deadline: Math.min(a.deadline ?? Infinity, Date.now() + policy.operationTimeoutMs) };
    checkpoint(a);
    const dir = this.dir(a.projectId);
    const lock = new FileGlobalWriterLock({ baseDir: dir, lockTimeoutMs: policy.operationTimeoutMs, lockRetryMs: 5 });
    return lock.withLock(async () => {
      checkpoint(a);
      const history = await this.history(a.projectId, () => checkpoint(a));
      checkpoint(a);
      const existing = history.find((v) => v.workEpisodeId === a.workEpisodeId);
      if (existing) return { status: "existing", assignment: existing };
      if (history.length >= MAX_TRIAL_ASSIGNMENTS_V2) throw new Error("Assignment history capacity; no pruning.");
      if (!policy.enabled) return { status: "none" };
      const open = await reader.readOpen(a.projectId);
      checkpoint(a); validateOpenHypotheses(open, a.projectId);
      // Identify competing v1/v2 leaves BEFORE executable filtering.
      const candidates = nonconflictingOpenHypotheses(open).filter(isExecutableStrategyHypothesis).map((h) => {
        const prior = history.filter((v) => sameHypothesis(v, h));
        return { h, count: prior.length, last: Math.max(-Infinity, ...prior.map((v) => Date.parse(v.createdAt))) };
      }).filter((v) => v.count < policy.maxAssignmentsPerHypothesis && now() - v.last >= policy.cooldownMs)
        .sort((x, y) => x.count - y.count || x.last - y.last || x.h.fingerprint.localeCompare(y.h.fingerprint) || x.h.id.localeCompare(y.h.id));
      const selected = candidates[0]?.h;
      if (!selected) return { status: "none" };
      const content = { schemaVersion: 2 as const, id: randomUUID(), projectId: a.projectId, workEpisodeId: a.workEpisodeId, hypothesis: hypothesisRef(selected), comparison: [],
        assignmentPolicyVersion: policy.version, assignmentPolicyFingerprint: learningFingerprint(policy), createdAt: new Date(now()).toISOString() };
      const assignment = { ...content, fingerprint: learningArtifactFingerprint(content) };
      if (!validateTrialAssignmentV2(assignment)) throw new Error("Invalid assignment publication.");
      // Temp files live outside canonical history. A crash leaves no committed attempt until unique link.
      await mkdir(dir, { recursive: true });
      const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
      try {
        await writeFile(temp, canonicalJson(assignment), { flag: "wx" });
        await this.options.beforePublish?.();
        checkpoint(a); // Commit frontier. The native link itself cannot be cancelled.
        linkSync(temp, join(dir, `${a.workEpisodeId}.json`));
        await this.options.afterPublish?.();
        return { status: "created", assignment };
      } finally { await rm(temp, { force: true }); }
    }, a.signal); // Lock stays owned until actual I/O finishes, even when the caller stops waiting.
  }
}
