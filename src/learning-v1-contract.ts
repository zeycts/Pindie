import { createHash, randomUUID } from "node:crypto";
import { EXPERIENCE_RECORD_ID, FINGERPRINT, PROJECT_ID, UUID_V4 } from "./exact-identity.ts";

/** Pure versioned operational/artifact contracts. No Pi, Host or Task authority fields. */
export { FINGERPRINT, PROJECT_ID, UUID_V4 } from "./exact-identity.ts";
export const WORK_EPISODE_ID = UUID_V4; // compatibility name for the operational binding
export const LEARNING_V1_SCHEMA = 1 as const;
export const LEARNING_JOB_KINDS = ["project-discovery", "revision-discovery", "evaluation", "portfolio-maintenance", "global-discovery"] as const;
export type LearningJobKind = typeof LEARNING_JOB_KINDS[number];
export type LearningJobState = "pending" | "running" | "completed" | "cancelled";
export const LEARNING_STOP_REASONS = ["human-work", "project-change", "session-change", "timeout", "budget", "transient", "retry-exhausted", "stale-input", "explicit-cancel"] as const;
export type LearningStopReason = typeof LEARNING_STOP_REASONS[number];
export type LearningScope = { readonly kind: "project"; readonly projectId: string } | { readonly kind: "user-global" };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).sort().join() === [...fields].sort().join();
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const uuid = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && FINGERPRINT.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const list = (v: unknown, max: number, check: (item: unknown) => boolean, min = 0): v is unknown[] =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(check);
const unique = (v: readonly unknown[]): boolean => new Set(v.map((item) => JSON.stringify(item))).size === v.length;
export function validateLearningScope(v: unknown): v is LearningScope {
  return object(v) && (v.kind === "project"
    ? exact(v, ["kind", "projectId"]) && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId)
    : v.kind === "user-global" && exact(v, ["kind"]));
}
/** Canonical ordered JSON for v1 identities only; v4 Experience uses its frozen projection. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Non-canonical learning identity input.");
}
export function learningFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
export function newWorkEpisodeId(): string { return randomUUID(); }
export function learningJobKey(kind: LearningJobKind, scope: LearningScope, inputFingerprint: string, policyVersion: number): string {
  if (!LEARNING_JOB_KINDS.includes(kind) || !validateLearningScope(scope) || !hash(inputFingerprint) ||
    !uint(policyVersion) || policyVersion === 0) throw new Error("Invalid learning job identity.");
  return learningFingerprint({ schemaVersion: LEARNING_V1_SCHEMA, kind, scope, inputFingerprint, policyVersion });
}
export interface WorkEpisodeBinding {
  readonly schemaVersion: 1; readonly projectId: string; readonly episodeId: string;
  readonly observedStateFingerprint: string; readonly openedAt: string; readonly closedAt: string | null;
}
export function validateWorkEpisodeBinding(v: unknown, projectId?: string): v is WorkEpisodeBinding {
  return object(v) && exact(v, ["schemaVersion", "projectId", "episodeId", "observedStateFingerprint", "openedAt", "closedAt"]) &&
    v.schemaVersion === 1 && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) &&
    (projectId === undefined || v.projectId === projectId) && uuid(v.episodeId) && hash(v.observedStateFingerprint) &&
    instant(v.openedAt) && (v.closedAt === null || (instant(v.closedAt) && v.closedAt >= v.openedAt));
}
export interface LearningBudgetPolicy {
  readonly schemaVersion: 1; readonly dailyTokenCeiling: number; readonly dailyTimeMsCeiling: number;
  readonly perJobTokenCap: number; readonly perJobTimeMsCap: number;
  readonly maxAttempts: number; readonly retryBaseMs: number; readonly retryMaxMs: number;
}
export const DEFAULT_LEARNING_BUDGET_POLICY: LearningBudgetPolicy = Object.freeze({
  schemaVersion: 1, dailyTokenCeiling: 20_000, dailyTimeMsCeiling: 600_000,
  perJobTokenCap: 4_000, perJobTimeMsCap: 120_000, maxAttempts: 3,
  retryBaseMs: 30_000, retryMaxMs: 3_600_000,
});
export function validateLearningBudgetPolicy(value: unknown): value is LearningBudgetPolicy {
  if (!object(value) || !exact(value, Object.keys(DEFAULT_LEARNING_BUDGET_POLICY)) || value.schemaVersion !== 1) return false;
  const positive = (n: unknown) => uint(n) && n > 0;
  return positive(value.dailyTokenCeiling) && positive(value.dailyTimeMsCeiling) &&
    positive(value.perJobTokenCap) && positive(value.perJobTimeMsCap) &&
    positive(value.maxAttempts) && positive(value.retryBaseMs) && positive(value.retryMaxMs) &&
    (value.perJobTokenCap as number) <= (value.dailyTokenCeiling as number) &&
    (value.perJobTimeMsCap as number) <= (value.dailyTimeMsCeiling as number) &&
    (value.retryBaseMs as number) <= (value.retryMaxMs as number);
}
export const LEARNING_ARTIFACT_FAMILIES = [
  "discovery-receipt", "strategy-hypothesis", "trial-assignment", "trial-evidence",
  "strategy-evaluation", "strategy-decision", "terminal-output",
] as const;
export type LearningArtifactFamily = typeof LEARNING_ARTIFACT_FAMILIES[number];
/** Exact lookup key: family and scope locate the immutable artifact; ID and digest revalidate it. */
export interface LearningArtifactRef {
  readonly schemaVersion: 1;
  readonly family: LearningArtifactFamily;
  readonly scope: LearningScope;
  readonly id: string;
  readonly fingerprint: string;
}
export function validateLearningArtifactRef(v: unknown, family?: LearningArtifactFamily): v is LearningArtifactRef {
  return object(v) && exact(v, ["schemaVersion", "family", "scope", "id", "fingerprint"]) &&
    v.schemaVersion === 1 && LEARNING_ARTIFACT_FAMILIES.includes(v.family as LearningArtifactFamily) &&
    (family === undefined || v.family === family) && validateLearningScope(v.scope) &&
    ((v.family !== "trial-assignment" && v.family !== "trial-evidence") || v.scope.kind === "project") &&
    uuid(v.id) && hash(v.fingerprint);
}
/** Exact persisted-content digest: includes schema and ID; excludes only its own fingerprint field. */
export function learningArtifactFingerprint(value: Record<string, unknown>): string {
  const { fingerprint: _fingerprint, ...content } = value;
  return learningFingerprint(content);
}
function authentic(v: Record<string, unknown>): boolean {
  try { return hash(v.fingerprint) && v.fingerprint === learningArtifactFingerprint(v); }
  catch { return false; }
}
const refs = (v: unknown, family: LearningArtifactFamily, max: number, min = 0): v is LearningArtifactRef[] =>
  list(v, max, (x) => validateLearningArtifactRef(x, family), min) && unique(v);

/** Minimal immutable output for jobs without a DiscoveryReceipt or StrategyEvaluation. */
export interface LearningTerminalOutput {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly scope: LearningScope; readonly jobKey: string;
  readonly state: "completed" | "cancelled";
  readonly stopReason: LearningStopReason | null;
}
export function validateLearningTerminalOutput(v: unknown): v is LearningTerminalOutput {
  return object(v) && exact(v, ["schemaVersion", "id", "fingerprint", "scope", "jobKey", "state", "stopReason"]) &&
    v.schemaVersion === 1 && uuid(v.id) && validateLearningScope(v.scope) && hash(v.jobKey) &&
    (v.state === "completed" ? v.stopReason === null : v.state === "cancelled" &&
      LEARNING_STOP_REASONS.includes(v.stopReason as LearningStopReason)) && authentic(v);
}
export interface LearningJob {
  readonly schemaVersion: 1; readonly key: string; readonly kind: LearningJobKind;
  readonly scope: LearningScope; readonly inputFingerprint: string; readonly policyVersion: number;
  readonly state: LearningJobState; readonly attempt: number; readonly eligibleAfter: number;
  readonly reservedTokens: number; readonly reservedTimeMs: number;
  readonly leaseOwner: string | null; readonly leaseToken: string | null; readonly leaseExpiresAt: number | null;
  readonly terminalReceiptRef: LearningArtifactRef | null; readonly stopReason: LearningStopReason | null;
  readonly createdAt: number;
}
export const MAX_LEARNING_LEASE_OWNER_LENGTH = 128;
export function validateLearningJob(v: unknown): v is LearningJob {
  if (!object(v) || !exact(v, ["schemaVersion", "key", "kind", "scope", "inputFingerprint", "policyVersion",
    "state", "attempt", "eligibleAfter", "reservedTokens", "reservedTimeMs", "leaseOwner", "leaseToken",
    "leaseExpiresAt", "terminalReceiptRef", "stopReason", "createdAt"]) || v.schemaVersion !== 1 ||
    !LEARNING_JOB_KINDS.includes(v.kind as LearningJobKind) || !validateLearningScope(v.scope) || !hash(v.inputFingerprint) ||
    !uint(v.policyVersion) || v.policyVersion === 0 || !uint(v.attempt) || !uint(v.eligibleAfter) ||
    !uint(v.reservedTokens) || !uint(v.reservedTimeMs) || !uint(v.createdAt) ||
    (v.stopReason !== null && !LEARNING_STOP_REASONS.includes(v.stopReason as LearningStopReason)) ||
    (v.terminalReceiptRef !== null && !validateLearningArtifactRef(v.terminalReceiptRef))) return false;
  if (v.key !== learningJobKey(v.kind as LearningJobKind, v.scope, v.inputFingerprint, v.policyVersion)) return false;
  if (v.terminalReceiptRef !== null) {
    const ref = v.terminalReceiptRef as LearningArtifactRef;
    if (canonicalJson(ref.scope) !== canonicalJson(v.scope)) return false;
    if ((v.kind === "project-discovery" || v.kind === "revision-discovery" || v.kind === "global-discovery") &&
      ref.family !== "discovery-receipt" && ref.family !== "terminal-output") return false;
    if (v.kind === "evaluation" && ref.family !== "strategy-evaluation" && ref.family !== "terminal-output") return false;
    if (v.kind === "portfolio-maintenance" && ref.family !== "terminal-output") return false;
  }
  if (v.state === "running") return text(v.leaseOwner, MAX_LEARNING_LEASE_OWNER_LENGTH) && uuid(v.leaseToken) &&
    uint(v.leaseExpiresAt) && v.attempt > 0 && v.terminalReceiptRef === null && v.stopReason === null;
  if (v.leaseOwner !== null || v.leaseToken !== null || v.leaseExpiresAt !== null) return false;
  if (v.state === "pending") return v.terminalReceiptRef === null &&
    (v.attempt === 0 ? v.stopReason === null : v.stopReason !== null);
  if (v.state === "completed") return v.terminalReceiptRef !== null && v.stopReason === null && v.attempt > 0;
  return v.state === "cancelled" && v.stopReason !== null;
}
export interface ExactEvidenceRef { readonly projectId: string; readonly recordId: string; readonly fingerprint: string }
export function validateExactEvidenceRef(v: unknown): v is ExactEvidenceRef {
  return object(v) && exact(v, ["projectId", "recordId", "fingerprint"]) &&
    typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) &&
    typeof v.recordId === "string" && EXPERIENCE_RECORD_ID.test(v.recordId) && hash(v.fingerprint);
}
export interface DiscoveryReceipt {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly jobKey: string; readonly packetFingerprint: string; readonly scope: LearningScope;
  readonly outcome: "none" | "covered" | "published";
  /** Covered means exact refs to preexisting hypotheses; none has no refs. */
  readonly hypotheses: readonly LearningArtifactRef[];
  /** Exact selected packet sources; last source by (recordedAt, recordId) is the assessed boundary. */
  readonly sources: readonly (ExactEvidenceRef & { readonly recordedAt: string })[];
}
export function validateDiscoveryReceipt(v: unknown): v is DiscoveryReceipt {
  return object(v) && exact(v, ["schemaVersion", "id", "fingerprint", "jobKey", "packetFingerprint", "scope", "outcome", "hypotheses", "sources"]) &&
    v.schemaVersion === 1 && uuid(v.id) && hash(v.jobKey) && hash(v.packetFingerprint) && validateLearningScope(v.scope) &&
    (v.outcome === "none" || v.outcome === "covered" || v.outcome === "published") &&
    refs(v.hypotheses, "strategy-hypothesis", 8) &&
    (v.hypotheses as LearningArtifactRef[]).every((ref) => canonicalJson(ref.scope) === canonicalJson(v.scope)) &&
    list(v.sources, 32, (source) => object(source) && exact(source, ["projectId", "recordId", "fingerprint", "recordedAt"]) &&
      validateExactEvidenceRef({ projectId: source.projectId, recordId: source.recordId, fingerprint: source.fingerprint }) && instant(source.recordedAt), 1) &&
    unique(v.sources) && (v.scope.kind !== "project" || (v.sources as DiscoveryReceipt["sources"]).every((source) => source.projectId === (v.scope as { projectId: string }).projectId)) &&
    (v.outcome === "none" ? v.hypotheses.length === 0 : v.hypotheses.length > 0) && authentic(v);
}
export interface StrategyHypothesis {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string; readonly scope: LearningScope;
  readonly logicalId: string; readonly kind: "approach" | "modifier";
  readonly lineage: "new" | "revise"; readonly parent: LearningArtifactRef | null; readonly baseRevisionFingerprint: string | null;
  readonly summary: string; readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[];
  readonly expectedEffect: string; readonly failureSignals: readonly string[]; readonly trialHints: readonly string[];
  readonly sources: readonly ExactEvidenceRef[]; readonly discoveryPacketFingerprint: string;
}
export function hypothesisFingerprint(value: Omit<StrategyHypothesis, "id" | "fingerprint">): string { return learningFingerprint(value); }
/** Shape/provenance validation, not model interpretation of observability or usefulness. */
export function validateStrategyHypothesis(value: unknown): value is StrategyHypothesis {
  if (!object(value) || !exact(value, ["schemaVersion", "id", "fingerprint", "scope", "logicalId", "kind", "lineage",
    "parent", "baseRevisionFingerprint", "summary", "useWhen", "avoidWhen",
    "expectedEffect", "failureSignals", "trialHints", "sources", "discoveryPacketFingerprint"]) ||
    value.schemaVersion !== 1 || !uuid(value.id) || !hash(value.fingerprint) || !validateLearningScope(value.scope) ||
    (value.kind !== "approach" && value.kind !== "modifier") ||
    (value.lineage !== "new" && value.lineage !== "revise") ||
    (value.lineage === "new" ? value.parent !== null || value.baseRevisionFingerprint !== null
      : !validateLearningArtifactRef(value.parent, "strategy-hypothesis") ||
        canonicalJson((value.parent as LearningArtifactRef).scope) !== canonicalJson(value.scope) ||
        (value.parent as LearningArtifactRef).id === value.id ||
        (value.baseRevisionFingerprint !== null && !hash(value.baseRevisionFingerprint))) ||
    typeof value.logicalId !== "string" || value.logicalId.length > 64 ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.logicalId) ||
    !text(value.summary) || !text(value.expectedEffect) || !hash(value.discoveryPacketFingerprint) ||
    !list(value.useWhen, 8, (x) => text(x, 256)) || !list(value.avoidWhen, 8, (x) => text(x, 256)) ||
    !list(value.trialHints, 8, (x) => text(x, 256)) || !list(value.failureSignals, 8, (x) => text(x, 256), 1) ||
    !list(value.sources, 8, validateExactEvidenceRef, 1) || !unique(value.sources)) return false;
  try { const { id: _id, fingerprint, ...semantic } = value; return fingerprint === learningFingerprint(semantic); }
  catch { return false; }
}
export interface TrialAssignment {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly projectId: string; readonly workEpisodeId: string; readonly sessionId: string;
  readonly hypothesis: LearningArtifactRef; readonly comparison: readonly ExactEvidenceRef[];
  readonly offerPolicyFingerprint: string; readonly expiresAt: number;
}
export function validateTrialAssignment(v: unknown): v is TrialAssignment {
  return object(v) && exact(v, ["schemaVersion", "id", "fingerprint", "projectId", "workEpisodeId", "sessionId",
    "hypothesis", "comparison", "offerPolicyFingerprint", "expiresAt"]) && v.schemaVersion === 1 &&
    uuid(v.id) && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && uuid(v.workEpisodeId) &&
    text(v.sessionId, 128) && validateLearningArtifactRef(v.hypothesis, "strategy-hypothesis") &&
    ((v.hypothesis as LearningArtifactRef).scope.kind === "user-global" ||
      ((v.hypothesis as LearningArtifactRef).scope as { projectId: string }).projectId === v.projectId) &&
    hash(v.offerPolicyFingerprint) && uint(v.expiresAt) &&
    list(v.comparison, 8, validateExactEvidenceRef) && unique(v.comparison) &&
    (v.comparison as ExactEvidenceRef[]).every((ref) => ref.projectId === v.projectId) && authentic(v);
}
export interface TrialEvidence {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly assignment: LearningArtifactRef; readonly hypothesis: LearningArtifactRef;
  readonly source: ExactEvidenceRef; readonly workEpisodeId: string; readonly exposed: boolean;
  readonly eligible: boolean; readonly eligibilityReason: string; readonly outcome: string;
  readonly regressions: readonly string[]; readonly comparison: readonly ExactEvidenceRef[];
}
export function validateTrialEvidence(v: unknown): v is TrialEvidence {
  return object(v) && exact(v, ["schemaVersion", "id", "fingerprint", "assignment", "hypothesis", "source",
    "workEpisodeId", "exposed", "eligible", "eligibilityReason", "outcome", "regressions", "comparison"]) &&
    v.schemaVersion === 1 && uuid(v.id) && validateLearningArtifactRef(v.assignment, "trial-assignment") &&
    validateLearningArtifactRef(v.hypothesis, "strategy-hypothesis") && validateExactEvidenceRef(v.source) &&
    (v.assignment as LearningArtifactRef).scope.kind === "project" &&
    ((v.assignment as LearningArtifactRef).scope as { projectId: string }).projectId === (v.source as ExactEvidenceRef).projectId &&
    ((v.hypothesis as LearningArtifactRef).scope.kind === "user-global" ||
      canonicalJson((v.hypothesis as LearningArtifactRef).scope) === canonicalJson((v.assignment as LearningArtifactRef).scope)) &&
    uuid(v.workEpisodeId) && typeof v.exposed === "boolean" && typeof v.eligible === "boolean" &&
    (!v.eligible || v.exposed) && text(v.eligibilityReason, 256) && text(v.outcome, 512) &&
    list(v.regressions, 8, (x) => text(x, 256)) &&
    list(v.comparison, 8, validateExactEvidenceRef) && unique(v.comparison) &&
    (v.comparison as ExactEvidenceRef[]).every((ref) => ref.projectId === (v.source as ExactEvidenceRef).projectId) && authentic(v);
}
export interface StrategyEvaluation {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly hypothesis: LearningArtifactRef; readonly packetFingerprint: string;
  readonly gateVersion: number; readonly trialEvidence: readonly LearningArtifactRef[];
  readonly verdict: "promote" | "continue-testing" | "revise" | "reject";
  readonly rationale: string; readonly citedHandles: readonly string[];
}
export function validateStrategyEvaluation(v: unknown): v is StrategyEvaluation {
  return object(v) && exact(v, ["schemaVersion", "id", "fingerprint", "hypothesis", "packetFingerprint",
    "gateVersion", "trialEvidence", "verdict", "rationale", "citedHandles"]) && v.schemaVersion === 1 && uuid(v.id) &&
    validateLearningArtifactRef(v.hypothesis, "strategy-hypothesis") && hash(v.packetFingerprint) &&
    uint(v.gateVersion) && v.gateVersion > 0 && refs(v.trialEvidence, "trial-evidence", 64, 1) &&
    ((v.hypothesis as LearningArtifactRef).scope.kind === "user-global" ||
      (v.trialEvidence as LearningArtifactRef[]).every((ref) => canonicalJson(ref.scope) === canonicalJson((v.hypothesis as LearningArtifactRef).scope))) &&
    (v.verdict === "promote" || v.verdict === "continue-testing" || v.verdict === "revise" || v.verdict === "reject") &&
    text(v.rationale, 1024) && list(v.citedHandles, 16, (x) => text(x, 64), 1) && unique(v.citedHandles) && authentic(v);
}
export interface StrategyDecision {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string; readonly scope: LearningScope;
  readonly action: "promote" | "reject" | "suspend" | "reinstate";
  readonly actor: "autonomous" | "human"; readonly hypothesis: LearningArtifactRef;
  /** Four-verdict untrusted Evaluation only; never a degradation assessment. */
  readonly evaluation: LearningArtifactRef | null;
  /** Immutable cited TrialEvidence or dedicated terminal assessment/integrity output. */
  readonly evidence: readonly LearningArtifactRef[];
  readonly supersedes: LearningArtifactRef | null; readonly decidedAt: string;
}
export function validateStrategyDecision(v: unknown): v is StrategyDecision {
  if (!object(v) || !exact(v, ["schemaVersion", "id", "fingerprint", "scope", "action", "actor", "hypothesis",
    "evaluation", "evidence", "supersedes", "decidedAt"]) || v.schemaVersion !== 1 ||
    !uuid(v.id) || !validateLearningScope(v.scope) || !validateLearningArtifactRef(v.hypothesis, "strategy-hypothesis") ||
    canonicalJson(v.scope) !== canonicalJson((v.hypothesis as LearningArtifactRef).scope) || !instant(v.decidedAt) ||
    (v.actor !== "autonomous" && v.actor !== "human") ||
    (v.action !== "promote" && v.action !== "reject" && v.action !== "suspend" && v.action !== "reinstate") ||
    !list(v.evidence, 64, (x) => validateLearningArtifactRef(x) &&
      (x.family === "trial-evidence" || x.family === "terminal-output"), 1) || !unique(v.evidence) ||
    ((v.scope as LearningScope).kind === "project" &&
      !(v.evidence as LearningArtifactRef[]).every((ref) => canonicalJson(ref.scope) === canonicalJson(v.scope))) ||
    (v.supersedes !== null && (!validateLearningArtifactRef(v.supersedes, "strategy-hypothesis") ||
      canonicalJson((v.supersedes as LearningArtifactRef).scope) !== canonicalJson(v.scope) ||
      (v.supersedes as LearningArtifactRef).id === (v.hypothesis as LearningArtifactRef).id ||
      (v.supersedes as LearningArtifactRef).fingerprint === (v.hypothesis as LearningArtifactRef).fingerprint ||
      v.action !== "promote"))) return false;
  if (v.action === "promote" || v.action === "reject") {
    if (v.evaluation === null) return v.actor === "human" && authentic(v);
    return validateLearningArtifactRef(v.evaluation, "strategy-evaluation") &&
      canonicalJson((v.evaluation as LearningArtifactRef).scope) === canonicalJson(v.scope) && authentic(v);
  }
  return v.evaluation === null && v.supersedes === null && authentic(v);
}
/** Validate a resolved immutable artifact against the exact scoped reference; never trust ID alone. */
export function matchesLearningArtifactRef(ref: unknown, artifact: unknown): boolean {
  if (!validateLearningArtifactRef(ref) || !object(artifact) || artifact.id !== ref.id || artifact.fingerprint !== ref.fingerprint) return false;
  const validators: Record<Exclude<LearningArtifactFamily, "terminal-output">, (v: unknown) => boolean> = {
    "discovery-receipt": validateDiscoveryReceipt, "strategy-hypothesis": validateStrategyHypothesis,
    "trial-assignment": validateTrialAssignment, "trial-evidence": validateTrialEvidence,
    "strategy-evaluation": validateStrategyEvaluation, "strategy-decision": validateStrategyDecision,
  };
  if (ref.family === "terminal-output") return validateLearningTerminalOutput(artifact) &&
    canonicalJson(artifact.scope) === canonicalJson(ref.scope);
  if (!validators[ref.family](artifact)) return false;
  // Scope is intrinsic to these artifacts; others are resolved in the ref's namespace later.
  if (ref.family === "discovery-receipt" || ref.family === "strategy-hypothesis" || ref.family === "strategy-decision")
    return canonicalJson(artifact.scope) === canonicalJson(ref.scope);
  if (ref.family === "trial-assignment")
    return ref.scope.kind === "project" && artifact.projectId === ref.scope.projectId;
  if (ref.family === "trial-evidence")
    return ref.scope.kind === "project" && (artifact as unknown as TrialEvidence).source.projectId === ref.scope.projectId;
  if (ref.family === "strategy-evaluation")
    return canonicalJson((artifact as unknown as StrategyEvaluation).hypothesis.scope) === canonicalJson(ref.scope);
  return false;
}
/** A terminal job is only reconciled when its exact output is present and bound to its key. */
export function matchesLearningJobOutput(job: LearningJob, output: unknown): boolean {
  if (!validateLearningJob(job) || job.terminalReceiptRef === null ||
    !matchesLearningArtifactRef(job.terminalReceiptRef, output)) return false;
  if (job.terminalReceiptRef.family === "discovery-receipt")
    return (output as DiscoveryReceipt).jobKey === job.key &&
      (job.kind !== "project-discovery" || (output as DiscoveryReceipt).packetFingerprint === job.inputFingerprint);
  if (job.terminalReceiptRef.family === "terminal-output")
    return (output as LearningTerminalOutput).jobKey === job.key && (output as LearningTerminalOutput).state === job.state &&
      (output as LearningTerminalOutput).stopReason === job.stopReason;
  // Evaluation input identity lives in the frozen packet; validate it when the packet store exists.
  return job.terminalReceiptRef.family === "strategy-evaluation";
}
/** Resolve exact linked children before using their provenance for a future decision. */
export function matchesTrialEvidenceAssignment(evidence: TrialEvidence, assignment: TrialAssignment): boolean {
  return validateTrialEvidence(evidence) && validateTrialAssignment(assignment) &&
    matchesLearningArtifactRef(evidence.assignment, assignment) &&
    canonicalJson(evidence.hypothesis) === canonicalJson(assignment.hypothesis) &&
    evidence.workEpisodeId === assignment.workEpisodeId;
}
export function matchesEvaluationTrial(evaluation: StrategyEvaluation, evidence: TrialEvidence): boolean {
  return validateStrategyEvaluation(evaluation) && validateTrialEvidence(evidence) &&
    evaluation.trialEvidence.some((ref) => matchesLearningArtifactRef(ref, evidence)) &&
    canonicalJson(evaluation.hypothesis) === canonicalJson(evidence.hypothesis);
}
export function matchesDecisionEvaluation(decision: StrategyDecision, evaluation: StrategyEvaluation): boolean {
  return validateStrategyDecision(decision) && validateStrategyEvaluation(evaluation) &&
    decision.evaluation !== null && matchesLearningArtifactRef(decision.evaluation, evaluation) &&
    canonicalJson(decision.hypothesis) === canonicalJson(evaluation.hypothesis) &&
    decision.action === evaluation.verdict &&
    (decision.actor === "human" || (decision.evidence.every((ref) => ref.family === "trial-evidence" &&
      evaluation.trialEvidence.some((trial) => canonicalJson(trial) === canonicalJson(ref)))));
}
