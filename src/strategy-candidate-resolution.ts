import {
  isCanonicalStrategyCandidateId,
  validateStrategyRevisionCandidateArtifact,
  type StrategyCandidateReader,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  validateStrategyDerivationCandidateBinding,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";

/** The validated artifact kind selected by the exact project-local store. */
export type TrialCandidateRef =
  | {
      readonly kind: "revision";
      readonly candidate: StrategyRevisionCandidate;
    }
  | {
      readonly kind: "derivation";
      readonly candidate: StrategyDerivationCandidateV1;
    };

export interface TrialCandidateResolutionInput {
  readonly projectRoot: string;
  readonly candidateId: string;
  readonly revisionReader: StrategyCandidateReader;
  readonly derivationReader: StrategyDerivationCandidateReader;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve one exact Candidate ID from the two immutable stores without ever
 * guessing its kind from labels or logical Strategy identity. Both stores are
 * consulted so a cross-store duplicate is an ambiguity, not a preference.
 */
export async function resolveTrialCandidate(
  input: TrialCandidateResolutionInput,
): Promise<TrialCandidateRef | null> {
  if (!isCanonicalStrategyCandidateId(input.candidateId)) {
    throw new Error("Candidate ID must be a canonical lowercase UUID-v4.");
  }

  const [rawRevision, rawDerivation] = await Promise.all([
    input.revisionReader.read(input.projectRoot, input.candidateId),
    input.derivationReader.read(input.projectRoot, input.candidateId),
  ]);

  let revision: StrategyRevisionCandidate | null = null;
  if (rawRevision !== null) {
    try {
      revision = validateStrategyRevisionCandidateArtifact(
        rawRevision,
        input.candidateId,
      );
    } catch (error) {
      throw new Error(`Revision Candidate artifact is malformed: ${errorMessage(error)}`);
    }
  }

  let derivation: StrategyDerivationCandidateV1 | null = null;
  if (rawDerivation !== null) {
    try {
      derivation = validateStrategyDerivationCandidateBinding(
        rawDerivation,
        input.projectRoot,
      );
    } catch (error) {
      throw new Error(`Derivation Candidate artifact or project binding is invalid: ${errorMessage(error)}`);
    }
  }

  if (revision !== null && derivation !== null) {
    throw new Error("Candidate ID is ambiguous: both Revision and Derivation Candidate stores contain it.");
  }
  if (revision !== null) {
    return Object.freeze({ kind: "revision" as const, candidate: revision });
  }
  if (derivation !== null) {
    return Object.freeze({ kind: "derivation" as const, candidate: derivation });
  }
  return null;
}

export const resolveCandidateById = resolveTrialCandidate;
