import { learningArtifactFingerprint, learningFingerprint } from "../../src/learning-v1-contract.ts";
import type { LearningArtifactRef } from "../../src/learning-v1-contract.ts";
/** Frozen T1 persisted shape, not a running deprecated scheduler. */
// Recorded default TrialOfferPolicy v1 fingerprint; the retired policy source is gone.
const FROZEN_OFFER_POLICY = { schemaVersion: 1, version: 1, enabled: true, maxOffersPerHypothesis: 3, cooldownMs: 86_400_000, leaseMs: 86_400_000, operationTimeoutMs: 100 } as const;
const FROZEN_OFFER_POLICY_FINGERPRINT = learningFingerprint(FROZEN_OFFER_POLICY);
export function legacyTrialFixture(projectId: string, hypothesis: LearningArtifactRef) {
  const a = { schemaVersion: 1 as const, id: "00000000-0000-4000-8000-000000000001", projectId, workEpisodeId: "00000000-0000-4000-8000-000000000002",
    sessionId: "historical-session", hypothesis, comparison: [], offerPolicyVersion: 1 as const, offerPolicyFingerprint: FROZEN_OFFER_POLICY_FINGERPRINT,
    hostId: "00000000-0000-4000-8000-000000000003", authorityGeneration: 1, createdAt: 1000, expiresAt: 2000, status: "untrusted-advisory" as const };
  const assignment = { ...a, fingerprint: learningArtifactFingerprint(a) };
  const r = { schemaVersion: 1 as const, id: "00000000-0000-4000-8000-000000000004", projectId, workEpisodeId: a.workEpisodeId,
    offerPolicyVersion: a.offerPolicyVersion, offerPolicyFingerprint: a.offerPolicyFingerprint, createdAt: a.createdAt, outcome: "offered" as const, reason: "selected" as const,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope: { kind: "project" as const, projectId }, id: assignment.id, fingerprint: assignment.fingerprint } };
  const receipt = { ...r, fingerprint: learningArtifactFingerprint(r) };
  const pendingContent = { ...r, assignment: null, outcome: "no-offer" as const, reason: "interrupted" as const };
  return { commit: { schemaVersion: 1 as const, assignment, receipt }, pending: { ...pendingContent, fingerprint: learningArtifactFingerprint(pendingContent) } };
}
