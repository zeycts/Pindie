import { createHash, randomUUID } from "node:crypto";

/** Pure, versioned v1 identities. No Task State, Pi, Host or authority fields. */
export const LEARNING_V1_SCHEMA = 1 as const;
export const WORK_EPISODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FINGERPRINT = /^[0-9a-f]{64}$/;
export const PROJECT_ID = FINGERPRINT;
export const LEARNING_JOB_KINDS = ["project-discovery", "revision-discovery", "evaluation", "portfolio-maintenance", "global-discovery"] as const;
export type LearningJobKind = typeof LEARNING_JOB_KINDS[number];
export type LearningJobState = "pending" | "running" | "completed" | "cancelled";
export type LearningStopReason = "human-work" | "project-change" | "session-change" | "timeout" | "budget" | "stale-input" | "explicit-cancel";
export type LearningScope = { readonly kind: "project"; readonly projectId: string } | { readonly kind: "user-global" };
export interface WorkEpisodeBinding {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly episodeId: string;
  readonly observedStateFingerprint: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
}
export interface LearningBudgetPolicy {
  readonly schemaVersion: 1;
  readonly dailyTokenCeiling: number;
  readonly dailyTimeMsCeiling: number;
  readonly perJobTokenCap: number;
  readonly perJobTimeMsCap: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}
export const DEFAULT_LEARNING_BUDGET_POLICY: LearningBudgetPolicy = Object.freeze({
  schemaVersion: 1, dailyTokenCeiling: 20_000, dailyTimeMsCeiling: 600_000,
  perJobTokenCap: 4_000, perJobTimeMsCap: 120_000, maxAttempts: 3,
  retryBaseMs: 30_000, retryMaxMs: 3_600_000,
});
export function validateLearningBudgetPolicy(value: LearningBudgetPolicy): boolean {
  const integer = (n: number) => Number.isSafeInteger(n) && n > 0;
  return value.schemaVersion === 1 &&
    Object.keys(value).sort().join() === Object.keys(DEFAULT_LEARNING_BUDGET_POLICY).sort().join() &&
    integer(value.dailyTokenCeiling) && integer(value.dailyTimeMsCeiling) &&
    integer(value.perJobTokenCap) && integer(value.perJobTimeMsCap) &&
    integer(value.maxAttempts) && integer(value.retryBaseMs) && integer(value.retryMaxMs) &&
    value.perJobTokenCap <= value.dailyTokenCeiling &&
    value.perJobTimeMsCap <= value.dailyTimeMsCeiling && value.retryBaseMs <= value.retryMaxMs;
}
/** Canonical object ordering; arrays retain their semantic order. Reject unsupported JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Non-canonical learning identity input.");
}
export function learningFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function newWorkEpisodeId(): string { return randomUUID(); }
export function learningJobKey(kind: LearningJobKind, scope: LearningScope, inputFingerprint: string, policyVersion: number): string {
  if (!LEARNING_JOB_KINDS.includes(kind) || !Number.isSafeInteger(policyVersion) || policyVersion < 1 ||
    !FINGERPRINT.test(inputFingerprint) || (scope.kind === "project"
      ? !PROJECT_ID.test(scope.projectId) || Object.keys(scope).sort().join() !== "kind,projectId"
      : scope.kind !== "user-global" || Object.keys(scope).join() !== "kind")) throw new Error("Invalid learning job identity.");
  return learningFingerprint({ schemaVersion: LEARNING_V1_SCHEMA, kind, scope, inputFingerprint, policyVersion });
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
export interface ExactEvidenceRef { readonly projectId: string; readonly recordId: string; readonly fingerprint: string }
export interface DiscoveryReceipt {
  readonly schemaVersion: 1; readonly id: string; readonly jobKey: string; readonly packetFingerprint: string;
  readonly outcome: "none" | "covered" | "published"; readonly hypothesisIds: readonly string[];
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
/** Strict advisory-only publication shape; semantic observability remains model judgment. */
export function validateStrategyHypothesis(value: unknown): value is StrategyHypothesis {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const fields = ["schemaVersion", "id", "fingerprint", "scope", "logicalId", "kind", "lineage",
    "parentFingerprint", "baseRevisionFingerprint", "summary", "useWhen", "avoidWhen",
    "expectedEffect", "failureSignals", "trialHints", "sources", "discoveryPacketFingerprint"];
  if (Object.keys(v).sort().join() !== fields.sort().join() || v.schemaVersion !== 1 ||
    typeof v.id !== "string" || !WORK_EPISODE_ID.test(v.id) ||
    (v.kind !== "approach" && v.kind !== "modifier") ||
    (v.lineage !== "new" && v.lineage !== "revise") ||
    (v.lineage === "revise") !== (typeof v.parentFingerprint === "string" && FINGERPRINT.test(v.parentFingerprint)) ||
    (v.baseRevisionFingerprint !== null && (typeof v.baseRevisionFingerprint !== "string" || !FINGERPRINT.test(v.baseRevisionFingerprint))) ||
    typeof v.logicalId !== "string" || v.logicalId.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v.logicalId) ||
    typeof v.summary !== "string" || !v.summary.trim() || v.summary.length > 512 ||
    typeof v.expectedEffect !== "string" || !v.expectedEffect.trim() || v.expectedEffect.length > 512 ||
    typeof v.discoveryPacketFingerprint !== "string" || !FINGERPRINT.test(v.discoveryPacketFingerprint)) return false;
  const scope = v.scope as LearningScope;
  if (typeof scope !== "object" || scope === null || (scope.kind === "project"
    ? !PROJECT_ID.test(scope.projectId) || Object.keys(scope).length !== 2
    : scope.kind !== "user-global" || Object.keys(scope).length !== 1)) return false;
  const strings = (items: unknown, max: number) => Array.isArray(items) && items.length <= max &&
    items.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 256);
  if (!strings(v.useWhen, 8) || !strings(v.avoidWhen, 8) || !strings(v.trialHints, 8) ||
    !strings(v.failureSignals, 8) || (v.failureSignals as string[]).length === 0 ||
    !Array.isArray(v.sources) || v.sources.length === 0 || v.sources.length > 8 ||
    !v.sources.every((x: unknown) => typeof x === "object" && x !== null &&
      Object.keys(x).sort().join() === "fingerprint,projectId,recordId" &&
      PROJECT_ID.test((x as ExactEvidenceRef).projectId) && FINGERPRINT.test((x as ExactEvidenceRef).fingerprint) &&
      typeof (x as ExactEvidenceRef).recordId === "string" && (x as ExactEvidenceRef).recordId.length > 0 && (x as ExactEvidenceRef).recordId.length <= 128)) return false;
  try {
    const { id: _id, fingerprint, ...semantic } = v;
    return typeof fingerprint === "string" && fingerprint === learningFingerprint(semantic);
  } catch { return false; }
}
export interface TrialAssignment {
  readonly schemaVersion: 1; readonly id: string; readonly projectId: string; readonly workEpisodeId: string;
  readonly sessionId: string; readonly hypothesisId: string; readonly hypothesisFingerprint: string;
  readonly comparison: readonly ExactEvidenceRef[]; readonly offerPolicyFingerprint: string; readonly expiresAt: number;
}
export interface TrialEvidence {
  readonly schemaVersion: 1; readonly id: string; readonly assignmentId: string; readonly hypothesisFingerprint: string;
  readonly source: ExactEvidenceRef; readonly workEpisodeId: string; readonly exposed: boolean;
  readonly eligible: boolean; readonly eligibilityReason: string; readonly outcome: string;
  readonly regressions: readonly string[]; readonly comparison: readonly ExactEvidenceRef[];
}
export interface StrategyEvaluation {
  readonly schemaVersion: 1; readonly id: string; readonly hypothesisFingerprint: string;
  readonly packetFingerprint: string; readonly gateVersion: number; readonly trialEvidence: readonly string[];
  readonly verdict: "promote" | "continue-testing" | "revise" | "reject";
  readonly rationale: string; readonly citedHandles: readonly string[];
}
export interface StrategyDecision {
  readonly schemaVersion: 1; readonly id: string; readonly scope: LearningScope;
  readonly action: "promote" | "reject" | "suspend" | "reinstate";
  readonly actor: "autonomous" | "human"; readonly hypothesisFingerprint: string;
  readonly evaluationId: string | null; readonly evidenceRefs: readonly string[];
  readonly supersedesFingerprint: string | null; readonly decidedAt: string;
}
