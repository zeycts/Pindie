import { learningArtifactFingerprint } from "../../src/learning-v1-contract.ts";
import { DEFAULT_TRIAL_OFFER_POLICY, trialOfferPolicyFingerprint } from "../../src/trial-offer-contract.ts";
import type { LearningArtifactRef } from "../../src/learning-v1-contract.ts";
/** Frozen T1 persisted shape, not a running deprecated scheduler. */
export function legacyTrialFixture(projectId: string, hypothesis: LearningArtifactRef) {
  const a = { schemaVersion: 1 as const, id: "00000000-0000-4000-8000-000000000001", projectId, workEpisodeId: "00000000-0000-4000-8000-000000000002",
    sessionId: "historical-session", hypothesis, comparison: [], offerPolicyVersion: 1 as const, offerPolicyFingerprint: trialOfferPolicyFingerprint(DEFAULT_TRIAL_OFFER_POLICY),
    hostId: "00000000-0000-4000-8000-000000000003", authorityGeneration: 1, createdAt: 1000, expiresAt: 2000, status: "untrusted-advisory" as const };
  const assignment = { ...a, fingerprint: learningArtifactFingerprint(a) };
  const r = { schemaVersion: 1 as const, id: "00000000-0000-4000-8000-000000000004", projectId, workEpisodeId: a.workEpisodeId,
    offerPolicyVersion: a.offerPolicyVersion, offerPolicyFingerprint: a.offerPolicyFingerprint, createdAt: a.createdAt, outcome: "offered" as const, reason: "selected" as const,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope: { kind: "project" as const, projectId }, id: assignment.id, fingerprint: assignment.fingerprint } };
  const receipt = { ...r, fingerprint: learningArtifactFingerprint(r) };
  const pendingContent = { ...r, assignment: null, outcome: "no-offer" as const, reason: "interrupted" as const };
  return { commit: { schemaVersion: 1 as const, assignment, receipt }, pending: { ...pendingContent, fingerprint: learningArtifactFingerprint(pendingContent) } };
}
