import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileGlobalWriterLock } from "./store.ts";
import { canonicalJson, learningArtifactFingerprint, validateLearningArtifactRef, validateExactEvidenceRef, PROJECT_ID, UUID_V4, type ExactEvidenceRef, type LearningArtifactRef, type StrategyHypothesisV2, isExecutableStrategyHypothesis } from "./learning-v1-contract.ts";
import { hypothesisRef } from "./discovery-hypotheses.ts";
import { validateTrialAssignmentV2, type TrialAssignmentV2 } from "./trial-assignment-v2.ts";
import { parseRunExperience, type RunExperience, type RunExperienceExecution } from "./run-experience.ts";
import { runExperienceRecordFingerprint } from "./run-experience-fingerprint.ts";
import { strategySelectionId, strategySelectionRevisionIdentity, strategySelectionRevisionFingerprint, strategySelectionRevisionStatus } from "./policy.ts";

/** Immutable observational support. No delivery, attention, causal use or eligibility verdict. */
export interface TrialEvidenceV2 {
  readonly schemaVersion: 2; readonly id: string; readonly fingerprint: string; readonly projectId: string;
  readonly assignment: LearningArtifactRef; readonly hypothesis: LearningArtifactRef; readonly source: ExactEvidenceRef;
  readonly workEpisodeId: string; readonly recordedAt: string;
  readonly selection: { readonly strategyId: string; readonly kind: "approach" | "modifier"; readonly revisionIdentity: string; readonly revisionFingerprint: string };
  readonly postDeclaration: RunExperienceExecution;
  readonly outcome: RunExperience["outcome"]; readonly metrics: RunExperience["metrics"];
  readonly comparison: readonly ExactEvidenceRef[];
}
const keys = (value: object, fields: string) => Object.keys(value).sort().join() === fields;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const counters = ["toolCalls", "observations", "consequentialCalls", "projectMutationEffectCalls", "verificationCalls", "toolErrors", "deniedCalls"] as const;
export function validateTrialEvidenceV2(value: unknown): value is TrialEvidenceV2 {
  if (!object(value)) return false;
  const v = value as unknown as TrialEvidenceV2;
  try {
    if (!keys(value, "assignment,comparison,fingerprint,hypothesis,id,metrics,outcome,postDeclaration,projectId,recordedAt,schemaVersion,selection,source,workEpisodeId") ||
      v.schemaVersion !== 2 || typeof v.projectId !== "string" || !PROJECT_ID.test(v.projectId) || typeof v.id !== "string" || !UUID_V4.test(v.id) ||
      typeof v.workEpisodeId !== "string" || !UUID_V4.test(v.workEpisodeId) || typeof v.recordedAt !== "string" || new Date(v.recordedAt).toISOString() !== v.recordedAt ||
      !validateLearningArtifactRef(v.assignment, "trial-assignment") || !validateLearningArtifactRef(v.hypothesis, "strategy-hypothesis") ||
      v.assignment.scope.kind !== "project" || v.assignment.scope.projectId !== v.projectId || v.hypothesis.scope.kind !== "project" || v.hypothesis.scope.projectId !== v.projectId ||
      !validateExactEvidenceRef(v.source) || v.source.projectId !== v.projectId || v.source.recordId !== `${v.id}.json` ||
      !object(v.selection) || !keys(v.selection, "kind,revisionFingerprint,revisionIdentity,strategyId") || typeof v.selection.strategyId !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v.selection.strategyId) || v.selection.strategyId.length > 64 ||
      !["approach", "modifier"].includes(v.selection.kind) || v.selection.revisionIdentity !== v.hypothesis.id || v.selection.revisionFingerprint !== v.hypothesis.fingerprint ||
      !object(v.postDeclaration) || !keys(v.postDeclaration, [...counters].sort().join()) || !counters.every((key) => uint(v.postDeclaration[key])) || v.postDeclaration.toolCalls < 1 ||
      v.postDeclaration.observations + v.postDeclaration.consequentialCalls !== v.postDeclaration.toolCalls || v.postDeclaration.projectMutationEffectCalls > v.postDeclaration.consequentialCalls || v.postDeclaration.verificationCalls > v.postDeclaration.consequentialCalls || v.postDeclaration.toolErrors > v.postDeclaration.toolCalls ||
      !object(v.outcome) || !keys(v.outcome, "completionRelation,hasBlockers,hasQuestions,humanGateOpen,taskStatus,verificationStatus") ||
      !object(v.metrics) || !keys(v.metrics, "cost,durationMs") ||
      !Array.isArray(v.comparison) || v.comparison.length > 8 || !v.comparison.every((r) => validateExactEvidenceRef(r) && r.projectId === v.projectId) || new Set(v.comparison.map(canonicalJson)).size !== v.comparison.length) return false;
    // Reuse the existing factual outcome/cost contract, without saving synthetic Experience.
    const parsed = parseRunExperience({ schemaVersion: 5, workEpisodeId: v.workEpisodeId, recordedAt: v.recordedAt,
      runStart: { taskStatus: "active", taskGoal: "support" }, task: { goal: "support", taskRelation: "preexisting_changed" },
      policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
      execution: v.postDeclaration, outcome: v.outcome, metrics: v.metrics });
    return parsed !== null && v.outcome.completionRelation !== "completed_before_run" && v.fingerprint === learningArtifactFingerprint(value);
  } catch { return false; }
}
export function assignmentRef(a: TrialAssignmentV2): LearningArtifactRef {
  return { schemaVersion: 1, family: "trial-assignment", scope: { kind: "project", projectId: a.projectId }, id: a.id, fingerprint: a.fingerprint };
}
export function trialEvidenceRef(e: TrialEvidenceV2): LearningArtifactRef {
  return { schemaVersion: 1, family: "trial-evidence", scope: { kind: "project", projectId: e.projectId }, id: e.id, fingerprint: e.fingerprint };
}
export function matchesTrialEvidenceV2Assignment(e: TrialEvidenceV2, a: TrialAssignmentV2): boolean {
  return validateTrialEvidenceV2(e) && validateTrialAssignmentV2(a) && canonicalJson(e.assignment) === canonicalJson(assignmentRef(a)) &&
    canonicalJson(e.hypothesis) === canonicalJson(a.hypothesis) && e.workEpisodeId === a.workEpisodeId && canonicalJson(e.comparison) === canonicalJson(a.comparison);
}
/** Exact selected role/revision plus chronological authorized ordinary work; no cognition claim. */
export function materializeTrialEvidenceV2(a: TrialAssignmentV2, h: StrategyHypothesisV2, source: ExactEvidenceRef, experience: RunExperience): TrialEvidenceV2 | null {
  if (!validateTrialAssignmentV2(a) || !isExecutableStrategyHypothesis(h) || canonicalJson(hypothesisRef(h)) !== canonicalJson(a.hypothesis) ||
    !validateExactEvidenceRef(source) || source.projectId !== a.projectId || parseRunExperience(experience) === null ||
    runExperienceRecordFingerprint(experience) !== source.fingerprint) throw new Error("Invalid exact Trial evidence input.");
  if (experience.schemaVersion !== 5 || experience.workEpisodeId !== a.workEpisodeId || experience.outcome.completionRelation === "completed_before_run") return null;
  const snapshot = experience.policy.finalSnapshot, frontier = experience.policy.finalPolicyLastDeclaredAfter;
  if (!snapshot || !frontier) return null;
  const selection = h.kind === "approach" ? snapshot.approach : snapshot.modifiers.find((s) => strategySelectionRevisionIdentity(s) === h.id);
  if (!selection || selection.kind !== h.kind || strategySelectionId(selection) !== h.logicalId || strategySelectionRevisionIdentity(selection) !== h.id ||
    strategySelectionRevisionFingerprint(selection) !== h.fingerprint || strategySelectionRevisionStatus(selection) !== "trial") return null;
  const postDeclaration = Object.fromEntries(counters.map((key) => [key, experience.execution[key] - frontier[key]])) as unknown as RunExperienceExecution;
  if (postDeclaration.toolCalls < 1) return null;
  const content = { schemaVersion: 2 as const, id: source.recordId.slice(0, -5), projectId: a.projectId, assignment: assignmentRef(a), hypothesis: a.hypothesis,
    source, workEpisodeId: a.workEpisodeId, recordedAt: experience.recordedAt,
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint }, postDeclaration,
    outcome: experience.outcome, metrics: experience.metrics, comparison: a.comparison };
  const evidence = { ...content, fingerprint: learningArtifactFingerprint(content) };
  if (!validateTrialEvidenceV2(evidence)) throw new Error("Invalid Trial evidence publication.");
  return evidence;
}
export const MAX_TRIAL_EVIDENCE_V2 = 4096;
const MAX_BYTES = 16_384;
/** Separate immutable namespace; source UUID gives deterministic retry identity, refs stay schema 1. */
export class FileTrialEvidenceV2Store {
  private readonly options: { projectsBaseDir: string; beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void> };
  constructor(options: FileTrialEvidenceV2Store["options"]) { this.options = options; }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid Trial evidence namespace.");
    return join(this.options.projectsBaseDir, projectId, "learning-v1", "trial-evidence-v2");
  }
  async list(projectId: string): Promise<readonly TrialEvidenceV2[]> {
    const dir = this.dir(projectId);
    let names: string[];
    try { names = await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    names = names.filter((n) => n !== "writer.lock");
    if (names.length > MAX_TRIAL_EVIDENCE_V2 || names.some((n) => !n.endsWith(".json") || !UUID_V4.test(n.slice(0, -5)))) throw new Error("Malformed/full Trial evidence history.");
    const result: TrialEvidenceV2[] = [];
    for (const name of names.sort()) {
      const path = join(dir, name);
      if ((await stat(path)).size > MAX_BYTES) throw new Error("Oversized Trial evidence.");
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Oversized Trial evidence.");
      const value: unknown = JSON.parse(text);
      if (!validateTrialEvidenceV2(value) || value.projectId !== projectId || `${value.id}.json` !== name) throw new Error("Corrupt Trial evidence history.");
      result.push(value);
    }
    return result;
  }
  async readExact(ref: LearningArtifactRef): Promise<TrialEvidenceV2> {
    if (!validateLearningArtifactRef(ref, "trial-evidence") || ref.scope.kind !== "project") throw new Error("Invalid exact Trial evidence ref.");
    const found = (await this.list(ref.scope.projectId)).find((e) => e.id === ref.id && e.fingerprint === ref.fingerprint);
    if (!found) throw new Error("Missing exact Trial evidence.");
    return found;
  }
  /** One validated history scan per batch; no cache survives the read operation. */
  async readExactMany(refs: readonly LearningArtifactRef[]): Promise<readonly TrialEvidenceV2[]> {
    const request: unknown = JSON.parse(canonicalJson(refs));
    if (!Array.isArray(request) || request.length < 1 || request.length > MAX_TRIAL_EVIDENCE_V2 ||
      !request.every((ref) => validateLearningArtifactRef(ref, "trial-evidence") && ref.scope.kind === "project" &&
        ref.scope.projectId === request[0].scope.projectId)) throw new Error("Invalid exact Trial evidence batch refs.");
    const history = new Map((await this.list(request[0].scope.projectId)).map((e) => [e.id, e]));
    return request.map((ref) => {
      const found = history.get(ref.id);
      if (!found || found.fingerprint !== ref.fingerprint) throw new Error("Missing exact Trial evidence.");
      return found;
    });
  }
  async publish(evidence: TrialEvidenceV2, signal?: AbortSignal, isCurrent: () => boolean = () => true): Promise<TrialEvidenceV2> {
    // Freeze before await; callers cannot mutate publication under the writer lock.
    const text = canonicalJson(evidence), frozen: unknown = JSON.parse(text);
    if (!validateTrialEvidenceV2(frozen) || Buffer.byteLength(text) > MAX_BYTES) throw new Error("Invalid Trial evidence write.");
    const e = frozen, dir = this.dir(e.projectId);
    return new FileGlobalWriterLock({ baseDir: dir }).withLock(async () => {
      signal?.throwIfAborted();
      if (!isCurrent()) throw new Error("Stale Trial evidence authority.");
      const history = await this.list(e.projectId), existing = history.find((v) => v.id === e.id);
      if (existing) {
        if (canonicalJson(existing) !== text) throw new Error("Conflicting exact Trial evidence.");
        return existing;
      }
      if (history.length >= MAX_TRIAL_EVIDENCE_V2) throw new Error("Trial evidence capacity; no pruning.");
      await mkdir(dir, { recursive: true });
      const temp = join(dir, "writer.lock", `${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text, { flag: "wx" });
        await this.options.beforePublish?.();
        signal?.throwIfAborted();
        if (!isCurrent()) throw new Error("Stale Trial evidence authority.");
        linkSync(temp, join(dir, `${e.id}.json`));
        await this.options.afterPublish?.();
        return e;
      } finally { await rm(temp, { force: true }); }
    }, signal);
  }
}
