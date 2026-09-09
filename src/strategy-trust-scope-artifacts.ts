import {
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
} from "./strategy-trust-scope-candidates.ts";
import {
  validateStrategyTrustScopeDecisionArtifact,
  validateStrategyTrustScopeDecisionBinding,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionV1,
} from "./strategy-trust-scope-decisions.ts";

/** Immutable global Scope artifacts shared by trust safety and CPL projections. */
export interface ScopeTrialGlobalArtifacts {
  readonly candidates: readonly StrategyTrustScopeCandidateV1[];
  readonly decisions: readonly StrategyTrustScopeDecisionV1[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Validate the complete immutable global Scope artifact namespace. */
export function validateStrategyTrustScopeGlobalArtifacts(
  rawCandidates: readonly StrategyTrustScopeCandidateV1[],
  rawDecisions: readonly StrategyTrustScopeDecisionV1[],
): ScopeTrialGlobalArtifacts {
  if (!Array.isArray(rawCandidates) || !Array.isArray(rawDecisions)) {
    throw new Error("Global Scope artifact readers returned invalid collections.");
  }
  const candidatesById = new Map<string, StrategyTrustScopeCandidateV1>();
  const candidateFingerprints = new Map<string, string>();
  for (const rawCandidate of rawCandidates) {
    const candidate = validateStrategyTrustScopeCandidateArtifact(
      rawCandidate,
      rawCandidate.candidateId,
    );
    if (candidatesById.has(candidate.candidateId)) {
      throw new Error(`Duplicate global Scope Candidates exist for '${candidate.candidateId}'.`);
    }
    const fingerprint = strategyTrustScopeCandidateFingerprint(candidate);
    const priorId = candidateFingerprints.get(fingerprint);
    if (priorId !== undefined) {
      throw new Error(`Global Scope Candidates '${priorId}' and '${candidate.candidateId}' bind the same exact hypothesis.`);
    }
    candidatesById.set(candidate.candidateId, candidate);
    candidateFingerprints.set(fingerprint, candidate.candidateId);
  }

  const decisionsById = new Map<string, StrategyTrustScopeDecisionV1>();
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategyTrustScopeDecisionArtifact(
      rawDecision,
      rawDecision.candidateId,
    );
    if (decisionsById.has(decision.candidateId)) {
      throw new Error(`Duplicate global Scope Decisions exist for '${decision.candidateId}'.`);
    }
    const candidate = candidatesById.get(decision.candidateId);
    if (candidate === undefined) {
      throw new Error(`Global Scope Decision '${decision.candidateId}' is missing its immutable Candidate.`);
    }
    validateStrategyTrustScopeDecisionBinding(decision, candidate);
    decisionsById.set(decision.candidateId, decision);
  }

  const candidates = [...candidatesById.values()].sort((left, right) =>
    compareText(left.candidateId, right.candidateId));
  const decisions = [...decisionsById.values()].sort((left, right) =>
    compareText(left.candidateId, right.candidateId));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    decisions: Object.freeze(decisions),
  });
}

/** Read and strictly validate the complete global Scope namespace. */
export async function readScopeTrialGlobalArtifacts(
  candidateReader: StrategyTrustScopeCandidateReader,
  decisionReader: StrategyTrustScopeDecisionReader,
): Promise<ScopeTrialGlobalArtifacts> {
  const [candidates, decisions] = await Promise.all([
    candidateReader.readAll(),
    decisionReader.readAll(),
  ]);
  return validateStrategyTrustScopeGlobalArtifacts(candidates, decisions);
}
