import { createHash, randomUUID } from "node:crypto";
import { EXPERIENCE_RECORD_ID, FINGERPRINT, PROJECT_ID, UUID_V4 } from "./exact-identity.ts";

/** Pure versioned operational/artifact contracts. No Pi, Host or Task authority fields. */
export { FINGERPRINT, PROJECT_ID, UUID_V4 } from "./exact-identity.ts";
export const WORK_EPISODE_ID = UUID_V4; // compatibility name for the operational binding
export const LEARNING_V1_SCHEMA = 1 as const;
export const LEARNING_JOB_KINDS = ["project-discovery", "revision-discovery", "evaluation", "portfolio-maintenance", "global-discovery"] as const;
export type LearningJobKind = typeof LEARNING_JOB_KINDS[number];
export type LearningJobState = "pending" | "running" | "completed" | "cancelled";
export const LEARNING_STOP_REASONS = ["human-work", "project-change", "session-change", "timeout", "budget", "stale-input", "explicit-cancel"] as const;
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
export interface LearningJob {
  readonly schemaVersion: 1; readonly key: string; readonly kind: LearningJobKind;
  readonly scope: LearningScope; readonly inputFingerprint: string; readonly policyVersion: number;
  readonly state: LearningJobState; readonly attempt: number; readonly eligibleAfter: number;
  readonly reservedTokens: number; readonly reservedTimeMs: number;
  readonly leaseOwner: string | null; readonly leaseToken: string | null; readonly leaseExpiresAt: number | null;
  readonly terminalReceiptRef: string | null; readonly stopReason: LearningStopReason | null;
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
    (v.terminalReceiptRef !== null && !hash(v.terminalReceiptRef))) return false;
  if (v.key !== learningJobKey(v.kind as LearningJobKind, v.scope, v.inputFingerprint, v.policyVersion)) return false;
  if (v.state === "running") return text(v.leaseOwner, MAX_LEARNING_LEASE_OWNER_LENGTH) && uuid(v.leaseToken) &&
    uint(v.leaseExpiresAt) && v.attempt > 0 && v.terminalReceiptRef === null && v.stopReason === null;
  if (v.leaseOwner !== null || v.leaseToken !== null || v.leaseExpiresAt !== null) return false;
  if (v.state === "pending") return v.terminalReceiptRef === null &&
    (v.attempt === 0 ? v.stopReason === null : v.stopReason !== null);
  if (v.state === "completed") return hash(v.terminalReceiptRef) && v.stopReason === null && v.attempt > 0;
  return v.state === "cancelled" && v.stopReason !== null && (v.terminalReceiptRef === null || hash(v.terminalReceiptRef));
}
export interface ExactEvidenceRef { readonly projectId: string; readonly recordId: string; readonly fingerprint: string }
export function validateExactEvidenceRef(v: unknown): v is ExactEvidenceRef {
  return object(v) && exact(v, ["projectId", "recordId", "fingerprint"]) &&
    typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) &&
    typeof v.recordId === "string" && EXPERIENCE_RECORD_ID.test(v.recordId) && hash(v.fingerprint);
}
export interface DiscoveryReceipt {
  readonly schemaVersion: 1; readonly id: string; readonly jobKey: string; readonly packetFingerprint: string;
  readonly outcome: "none" | "covered" | "published"; readonly hypothesisIds: readonly string[];
}
export function validateDiscoveryReceipt(v: unknown): v is DiscoveryReceipt {
  return object(v) && exact(v, ["schemaVersion", "id", "jobKey", "packetFingerprint", "outcome", "hypothesisIds"]) &&
    v.schemaVersion === 1 && uuid(v.id) && hash(v.jobKey) && hash(v.packetFingerprint) &&
    (v.outcome === "none" || v.outcome === "covered" || v.outcome === "published") &&
    list(v.hypothesisIds, 8, uuid) && unique(v.hypothesisIds) &&
    (v.outcome === "published" ? v.hypothesisIds.length > 0 : v.outcome !== "none" || v.hypothesisIds.length === 0);
}
export interface StrategyHypothesis {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string; readonly scope: LearningScope;
  readonly logicalId: string; readonly kind: "approach" | "modifier";
  readonly lineage: "new" | "revise"; readonly parentFingerprint: string | null; readonly baseRevisionFingerprint: string | null;
  readonly summary: string; readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[];
  readonly expectedEffect: string; readonly failureSignals: readonly string[]; readonly trialHints: readonly string[];
  readonly sources: readonly ExactEvidenceRef[]; readonly discoveryPacketFingerprint: string;
}
export function hypothesisFingerprint(value: Omit<StrategyHypothesis, "id" | "fingerprint">): string { return learningFingerprint(value); }
/** Shape/provenance validation, not model interpretation of observability or usefulness. */
export function validateStrategyHypothesis(value: unknown): value is StrategyHypothesis {
  if (!object(value) || !exact(value, ["schemaVersion", "id", "fingerprint", "scope", "logicalId", "kind", "lineage",
    "parentFingerprint", "baseRevisionFingerprint", "summary", "useWhen", "avoidWhen",
    "expectedEffect", "failureSignals", "trialHints", "sources", "discoveryPacketFingerprint"]) ||
    value.schemaVersion !== 1 || !uuid(value.id) || !hash(value.fingerprint) || !validateLearningScope(value.scope) ||
    (value.kind !== "approach" && value.kind !== "modifier") ||
    (value.lineage !== "new" && value.lineage !== "revise") ||
    (value.lineage === "new" ? value.parentFingerprint !== null || value.baseRevisionFingerprint !== null
      : !hash(value.parentFingerprint) || (value.baseRevisionFingerprint !== null && !hash(value.baseRevisionFingerprint))) ||
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
  readonly schemaVersion: 1; readonly id: string; readonly projectId: string; readonly workEpisodeId: string;
  readonly sessionId: string; readonly hypothesisId: string; readonly hypothesisFingerprint: string;
  readonly comparison: readonly ExactEvidenceRef[]; readonly offerPolicyFingerprint: string; readonly expiresAt: number;
}
export function validateTrialAssignment(v: unknown): v is TrialAssignment {
  return object(v) && exact(v, ["schemaVersion", "id", "projectId", "workEpisodeId", "sessionId", "hypothesisId",
    "hypothesisFingerprint", "comparison", "offerPolicyFingerprint", "expiresAt"]) && v.schemaVersion === 1 &&
    uuid(v.id) && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && uuid(v.workEpisodeId) &&
    text(v.sessionId, 128) && uuid(v.hypothesisId) && hash(v.hypothesisFingerprint) &&
    hash(v.offerPolicyFingerprint) && uint(v.expiresAt) &&
    list(v.comparison, 8, validateExactEvidenceRef) && unique(v.comparison);
}
export interface TrialEvidence {
  readonly schemaVersion: 1; readonly id: string; readonly assignmentId: string; readonly hypothesisFingerprint: string;
  readonly source: ExactEvidenceRef; readonly workEpisodeId: string; readonly exposed: boolean;
  readonly eligible: boolean; readonly eligibilityReason: string; readonly outcome: string;
  readonly regressions: readonly string[]; readonly comparison: readonly ExactEvidenceRef[];
}
export function validateTrialEvidence(v: unknown): v is TrialEvidence {
  return object(v) && exact(v, ["schemaVersion", "id", "assignmentId", "hypothesisFingerprint", "source",
    "workEpisodeId", "exposed", "eligible", "eligibilityReason", "outcome", "regressions", "comparison"]) &&
    v.schemaVersion === 1 && uuid(v.id) && uuid(v.assignmentId) && hash(v.hypothesisFingerprint) &&
    validateExactEvidenceRef(v.source) && uuid(v.workEpisodeId) && typeof v.exposed === "boolean" &&
    typeof v.eligible === "boolean" && (!v.eligible || v.exposed) && text(v.eligibilityReason, 256) &&
    text(v.outcome, 512) && list(v.regressions, 8, (x) => text(x, 256)) &&
    list(v.comparison, 8, validateExactEvidenceRef) && unique(v.comparison);
}
export interface StrategyEvaluation {
  readonly schemaVersion: 1; readonly id: string; readonly hypothesisFingerprint: string;
  readonly packetFingerprint: string; readonly gateVersion: number; readonly trialEvidence: readonly string[];
  readonly verdict: "promote" | "continue-testing" | "revise" | "reject";
  readonly rationale: string; readonly citedHandles: readonly string[];
}
export function validateStrategyEvaluation(v: unknown): v is StrategyEvaluation {
  return object(v) && exact(v, ["schemaVersion", "id", "hypothesisFingerprint", "packetFingerprint", "gateVersion",
    "trialEvidence", "verdict", "rationale", "citedHandles"]) && v.schemaVersion === 1 && uuid(v.id) &&
    hash(v.hypothesisFingerprint) && hash(v.packetFingerprint) && uint(v.gateVersion) && v.gateVersion > 0 &&
    list(v.trialEvidence, 64, uuid, 1) && unique(v.trialEvidence) &&
    (v.verdict === "promote" || v.verdict === "continue-testing" || v.verdict === "revise" || v.verdict === "reject") &&
    text(v.rationale, 1024) && list(v.citedHandles, 16, (x) => text(x, 64), 1) && unique(v.citedHandles);
}
export interface StrategyDecision {
  readonly schemaVersion: 1; readonly id: string; readonly scope: LearningScope;
  readonly action: "promote" | "reject" | "suspend" | "reinstate";
  readonly actor: "autonomous" | "human"; readonly hypothesisFingerprint: string;
  readonly evaluationId: string | null; readonly evidenceRefs: readonly string[];
  readonly supersedesFingerprint: string | null; readonly decidedAt: string;
}
export function validateStrategyDecision(v: unknown): v is StrategyDecision {
  if (!object(v) || !exact(v, ["schemaVersion", "id", "scope", "action", "actor", "hypothesisFingerprint",
    "evaluationId", "evidenceRefs", "supersedesFingerprint", "decidedAt"]) || v.schemaVersion !== 1 ||
    !uuid(v.id) || !validateLearningScope(v.scope) || !hash(v.hypothesisFingerprint) || !instant(v.decidedAt) ||
    (v.actor !== "autonomous" && v.actor !== "human") ||
    (v.action !== "promote" && v.action !== "reject" && v.action !== "suspend" && v.action !== "reinstate") ||
    !list(v.evidenceRefs, 64, hash, 1) || !unique(v.evidenceRefs) ||
    (v.supersedesFingerprint !== null && (!hash(v.supersedesFingerprint) || v.action !== "promote"))) return false;
  return v.action === "promote" || v.action === "reject"
    ? uuid(v.evaluationId) || (v.actor === "human" && v.evaluationId === null)
    : v.evaluationId === null;
}
