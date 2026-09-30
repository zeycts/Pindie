import { FINGERPRINT, PROJECT_ID, UUID_V4, learningArtifactFingerprint, learningFingerprint, validateLearningArtifactRef, type LearningArtifactRef } from "./learning-v1-contract.ts";

export interface TrialOfferPolicy {
  readonly schemaVersion: 1; readonly version: 1; readonly enabled: boolean;
  readonly maxOffersPerHypothesis: number; readonly cooldownMs: number;
  readonly leaseMs: number; readonly operationTimeoutMs: number;
}
export const DEFAULT_TRIAL_OFFER_POLICY: TrialOfferPolicy = Object.freeze({
  schemaVersion: 1, version: 1, enabled: true, maxOffersPerHypothesis: 3,
  cooldownMs: 86_400_000, leaseMs: 86_400_000, operationTimeoutMs: 100,
});
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).sort().join() === [...fields].sort().join();
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validateTrialOfferPolicy(v: unknown): v is TrialOfferPolicy {
  return obj(v) && exact(v, Object.keys(DEFAULT_TRIAL_OFFER_POLICY)) && v.schemaVersion === 1 && v.version === 1 &&
    typeof v.enabled === "boolean" && uint(v.maxOffersPerHypothesis) && v.maxOffersPerHypothesis >= 1 && v.maxOffersPerHypothesis <= 10 &&
    uint(v.cooldownMs) && v.cooldownMs <= 2_592_000_000 && uint(v.leaseMs) && v.leaseMs > 0 && v.leaseMs <= 604_800_000 &&
    uint(v.operationTimeoutMs) && v.operationTimeoutMs > 0 && v.operationTimeoutMs <= 1_000;
}
export function trialOfferPolicyFingerprint(policy: TrialOfferPolicy): string {
  if (!validateTrialOfferPolicy(policy)) throw new Error("Invalid TrialOfferPolicy.");
  return learningFingerprint(policy);
}
export const TRIAL_OFFER_REASONS = ["selected", "disabled", "no-open-hypothesis", "lineage-conflict", "cooldown-or-limit", "unavailable", "interrupted"] as const;
export interface TrialOfferReceipt {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly projectId: string; readonly workEpisodeId: string;
  readonly offerPolicyVersion: 1; readonly offerPolicyFingerprint: string;
  readonly createdAt: number; readonly outcome: "no-offer" | "offered";
  readonly reason: typeof TRIAL_OFFER_REASONS[number]; readonly assignment: LearningArtifactRef | null;
}
export function validateTrialOfferReceipt(v: unknown): v is TrialOfferReceipt {
  if (!obj(v) || !exact(v, ["schemaVersion", "id", "fingerprint", "projectId", "workEpisodeId", "offerPolicyVersion", "offerPolicyFingerprint", "createdAt", "outcome", "reason", "assignment"]) ||
    v.schemaVersion !== 1 || typeof v.id !== "string" || !UUID_V4.test(v.id) || typeof v.projectId !== "string" || !PROJECT_ID.test(v.projectId) ||
    typeof v.workEpisodeId !== "string" || !UUID_V4.test(v.workEpisodeId) || v.offerPolicyVersion !== 1 ||
    typeof v.offerPolicyFingerprint !== "string" || !FINGERPRINT.test(v.offerPolicyFingerprint) || !uint(v.createdAt)) return false;
  if (v.outcome === "offered") {
    if (v.reason !== "selected" || !validateLearningArtifactRef(v.assignment, "trial-assignment") || v.assignment.scope.kind !== "project" || v.assignment.scope.projectId !== v.projectId) return false;
  } else if (v.outcome !== "no-offer" || v.assignment !== null || !(TRIAL_OFFER_REASONS as readonly unknown[]).includes(v.reason) || v.reason === "selected") return false;
  try { return v.fingerprint === learningArtifactFingerprint(v); } catch { return false; }
}
/** Deterministic UUID-shaped operational identity, not random selection. */
export function trialOperationalId(value: unknown): string {
  const hex = learningFingerprint(value).slice(7, 39).split("");
  hex[12] = "4"; hex[16] = "8";
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
