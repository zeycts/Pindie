import { isDeepStrictEqual } from "node:util";

import type { ScopeTrialGlobalArtifacts } from "./strategy-trust-scope-trial.ts";
import type { StrategyDerivationCandidateV1 } from "./strategy-derivation-candidates.ts";
import type { StrategyDerivationDecisionV1 } from "./strategy-derivation-decisions.ts";
import {
  createStrategyRevisionSelection,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  getSeedStrategy,
  SEED_STRATEGIES,
} from "./strategies.ts";
import type {
  StrategyTrustScopeCandidateReader,
  StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionReader as ScopeDecisionReader,
} from "./strategy-trust-scope-decisions.ts";
import type {
  ResolvedStrategyTrustScopeSource,
  StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";

import { MAX_USER_GLOBAL_DERIVED_STRATEGIES } from "./strategy-trust-scope-constants.ts";

export { MAX_USER_GLOBAL_DERIVED_STRATEGIES };

export interface UserGlobalTrustedDerivedStrategy {
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  readonly candidate: StrategyDerivationCandidateV1;
  readonly decision: StrategyTrustScopeDecisionRecord;
  /** Ephemeral Harness projection; the source Candidate remains authority. */
  readonly selection: StrategyRevisionSelection;
}

/** A complete read-only projection of valid promoted user-global trust. */
export interface UserGlobalTrustedDerivedStrategyProjection {
  readonly entries: readonly UserGlobalTrustedDerivedStrategy[];
  readonly selections: readonly StrategyRevisionSelection[];
}

export interface UserGlobalTrustedDerivedStrategyProjectionInput {
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: ScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
}

interface ProjectionRuntimeDependencies {
  readonly validateSourceStrategy: typeof import("./strategy-trust-scope-candidates.ts").validateStrategyTrustScopeSourceStrategy;
  readonly fingerprintCandidate: typeof import("./strategy-derivation-candidates.ts").strategyDerivationCandidateSemanticFingerprint;
  readonly validateCandidate: typeof import("./strategy-derivation-candidates.ts").validateStrategyDerivationCandidateArtifact;
  readonly validateDecision: typeof import("./strategy-derivation-decisions.ts").validateStrategyDerivationDecisionArtifact;
  readonly validateDecisionBinding: typeof import("./strategy-derivation-decisions.ts").validateStrategyDerivationDecisionBinding;
}

// Keep this local alias explicit: it prevents the global projection from
// exposing a mutable catalog or making Scope Decision schema fields optional.
type StrategyTrustScopeDecisionRecord = import("./strategy-trust-scope-decisions.ts").StrategyTrustScopeDecisionV1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceIdentityKey(source: StrategyTrustScopeSourceStrategyV1): string {
  return [
    source.strategyId,
    source.kind,
    source.revisionIdentity,
    source.revisionFingerprint,
  ].join("\0");
}

function sourceBindingEqual(
  left: StrategyTrustScopeSourceStrategyV1,
  right: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return left.sourceProjectId === right.sourceProjectId &&
    left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint;
}

function sourceSelection(
  candidate: StrategyDerivationCandidateV1,
  fingerprintCandidate: ProjectionRuntimeDependencies["fingerprintCandidate"],
): StrategyRevisionSelection {
  return createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: fingerprintCandidate(candidate),
    revisionStatusAtRun: "promoted",
    semantics: {
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    },
  });
}

function selectionEqual(
  left: StrategyRevisionSelection,
  right: StrategyRevisionSelection,
): boolean {
  return strategySelectionId(left) === strategySelectionId(right) &&
    left.kind === right.kind &&
    strategySelectionRevisionIdentity(left) === strategySelectionRevisionIdentity(right) &&
    strategySelectionRevisionFingerprint(left) === strategySelectionRevisionFingerprint(right) &&
    strategySelectionRevisionStatus(left) === strategySelectionRevisionStatus(right) &&
    isDeepStrictEqual(left.semantics, right.semantics);
}

function sourceResolvedExactly(
  resolved: ResolvedStrategyTrustScopeSource,
  source: StrategyTrustScopeSourceStrategyV1,
  dependencies: ProjectionRuntimeDependencies,
): {
  readonly candidate: StrategyDerivationCandidateV1;
  readonly selection: StrategyRevisionSelection;
} {
  const resolvedSource = dependencies.validateSourceStrategy(resolved.sourceStrategy);
  if (!sourceBindingEqual(resolvedSource, source)) {
    throw new Error("promoted Scope Decision source binding does not match the freshly resolved source Strategy");
  }
  const resolvedCandidate = dependencies.validateCandidate(
    resolved.candidate,
    source.revisionIdentity,
  );
  if (
    resolvedCandidate.projectId !== source.sourceProjectId ||
    resolvedCandidate.proposal.strategyId !== source.strategyId ||
    resolvedCandidate.proposal.kind !== source.kind ||
    resolvedCandidate.candidateId !== source.revisionIdentity ||
    dependencies.fingerprintCandidate(resolvedCandidate) !== source.revisionFingerprint
  ) {
    throw new Error("promoted Scope Decision source Candidate does not match its exact binding");
  }
  const expectedSelection = sourceSelection(resolvedCandidate, dependencies.fingerprintCandidate);
  if (!selectionEqual(resolved.selection, expectedSelection)) {
    throw new Error("source Strategy resolver returned a non-exact promoted selection");
  }
  const sourceDecision = dependencies.validateDecisionBinding(
    dependencies.validateDecision(resolved.decision, resolvedCandidate.candidateId),
    resolvedCandidate,
  );
  if (sourceDecision.decision !== "promoted") {
    throw new Error("source Strategy Decision is not promoted");
  }
  return { candidate: resolvedCandidate, selection: expectedSelection };
}

function promotedScopeDecisions(
  artifacts: ScopeTrialGlobalArtifacts,
): readonly StrategyTrustScopeDecisionRecord[] {
  return artifacts.decisions.filter((decision) => decision.decision === "promoted");
}

/**
 * Reconstruct the user-global Derived set from immutable Scope artifacts and
 * exact source authorities. Historical Trial refs are intentionally not read:
 * they are audit provenance, not a renewable trust lease.
 */
export async function loadUserGlobalTrustedDerivedStrategyProjection(
  input: UserGlobalTrustedDerivedStrategyProjectionInput,
): Promise<UserGlobalTrustedDerivedStrategyProjection> {
  // These modules depend on the project-local portfolio for frozen v0.7
  // validation. Loading them lazily keeps the optional global projection from
  // introducing a module-initialization cycle into strategy-portfolio.ts.
  const [scopeTrial, derivationCandidates, derivationDecisions, scopeCandidates] = await Promise.all([
    import("./strategy-trust-scope-trial.ts"),
    import("./strategy-derivation-candidates.ts"),
    import("./strategy-derivation-decisions.ts"),
    import("./strategy-trust-scope-candidates.ts"),
  ]);
  const dependencies: ProjectionRuntimeDependencies = {
    validateSourceStrategy: scopeCandidates.validateStrategyTrustScopeSourceStrategy,
    fingerprintCandidate: derivationCandidates.strategyDerivationCandidateSemanticFingerprint,
    validateCandidate: derivationCandidates.validateStrategyDerivationCandidateArtifact,
    validateDecision: derivationDecisions.validateStrategyDerivationDecisionArtifact,
    validateDecisionBinding: derivationDecisions.validateStrategyDerivationDecisionBinding,
  };
  const artifacts = await scopeTrial.readScopeTrialGlobalArtifacts(
    input.candidateReader,
    input.decisionReader,
  );
  const candidatesById = new Map(artifacts.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const entries: UserGlobalTrustedDerivedStrategy[] = [];
  const logicalIds = new Set<string>();

  for (const decision of promotedScopeDecisions(artifacts)) {
    const candidate = candidatesById.get(decision.candidateId);
    if (candidate === undefined) {
      throw new Error(`promoted Scope Decision '${decision.candidateId}' is missing its immutable Candidate`);
    }
    if (SEED_STRATEGIES.some((seed) => seed.id === decision.sourceStrategy.strategyId) ||
      getSeedStrategy(decision.sourceStrategy.strategyId) !== null) {
      throw new Error("a user-global Derived Strategy cannot reuse an immutable Seed logical Strategy ID");
    }
    if (logicalIds.has(decision.sourceStrategy.strategyId)) {
      throw new Error(`multiple promoted user-global Scope Decisions own logical Strategy ID '${decision.sourceStrategy.strategyId}'`);
    }

    let resolved: ResolvedStrategyTrustScopeSource;
    try {
      resolved = await input.sourceResolver.resolve(decision.sourceStrategy);
    } catch (error) {
      throw new Error(`user-global source Strategy '${decision.sourceStrategy.strategyId}' could not be resolved: ${errorMessage(error)}`);
    }
    const sourceResolution = sourceResolvedExactly(resolved, decision.sourceStrategy, dependencies);
    logicalIds.add(decision.sourceStrategy.strategyId);
    entries.push(Object.freeze({
      sourceStrategy: Object.freeze({ ...decision.sourceStrategy }),
      candidate: sourceResolution.candidate,
      decision,
      selection: sourceResolution.selection,
    }));
  }

  if (entries.length > MAX_USER_GLOBAL_DERIVED_STRATEGIES) {
    throw new Error(`user-global Derived Strategy capacity exceeds ${MAX_USER_GLOBAL_DERIVED_STRATEGIES}`);
  }
  const sorted = entries.sort((left, right) =>
    compareText(sourceIdentityKey(left.sourceStrategy), sourceIdentityKey(right.sourceStrategy)));
  return Object.freeze({
    entries: Object.freeze(sorted),
    selections: Object.freeze(sorted.map((entry) => entry.selection)),
  });
}

export const loadUserGlobalDerivedStrategyCatalog = loadUserGlobalTrustedDerivedStrategyProjection;
export const loadPromotedUserGlobalDerivedStrategyCatalog = loadUserGlobalTrustedDerivedStrategyProjection;
export const reconstructUserGlobalTrustedDerivedStrategies = loadUserGlobalTrustedDerivedStrategyProjection;
export const deriveUserGlobalTrustedDerivedStrategies = loadUserGlobalTrustedDerivedStrategyProjection;

/** Validate the projection shape at a caller boundary without persisting it. */
export function isUserGlobalTrustedDerivedStrategyProjection(
  value: unknown,
): value is UserGlobalTrustedDerivedStrategyProjection {
  return isRecord(value) && Array.isArray(value.entries) && Array.isArray(value.selections) &&
    value.entries.length === value.selections.length &&
    value.entries.length <= MAX_USER_GLOBAL_DERIVED_STRATEGIES;
}
