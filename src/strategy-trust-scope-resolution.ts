import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isCanonicalStrategyCandidateId,
  validateStrategyRevisionCandidateArtifact,
} from "./strategy-candidates.ts";
import {
  STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME,
  isCanonicalStrategyDerivationCandidateId,
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME,
  createPromotedDerivedStrategyCatalog,
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
  type PromotedDerivedStrategyCatalog,
  type StrategyDerivationDecisionV1,
} from "./strategy-derivation-decisions.ts";
import {
  SEED_STRATEGIES,
} from "./strategies.ts";
import {
  createStrategyRevisionSelection,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  isCanonicalStrategyTrustScopeProjectId,
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";

export const STRATEGY_REVISION_DIRECTORY_NAME = "strategy-candidates";

export interface StrategyTrustScopeSourceResolverOptions {
  /** User-local project namespace root, normally ~/.pindie/projects. */
  projectsBaseDir?: string;
}

export interface ResolvedStrategyTrustScopeSource {
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  readonly candidate: StrategyDerivationCandidateV1;
  readonly decision: StrategyDerivationDecisionV1;
  /** Ephemeral Harness projection; the source Candidate remains semantics authority. */
  readonly selection: StrategyRevisionSelection;
  readonly promotedDerivedCatalog: PromotedDerivedStrategyCatalog;
}

export interface StrategyTrustScopeSourceResolver {
  resolve(sourceStrategy: StrategyTrustScopeSourceStrategyV1): Promise<ResolvedStrategyTrustScopeSource>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid Strategy Trust Scope source binding: ${message}`);
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

function sourceStrategyFromCandidate(
  candidate: StrategyDerivationCandidateV1,
): StrategyTrustScopeSourceStrategyV1 {
  return Object.freeze({
    sourceProjectId: candidate.projectId,
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
  });
}

async function readJson(path: string): Promise<unknown | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Could not read source Strategy artifact '${path}': ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not read source Strategy artifact '${path}': invalid JSON (${errorMessage(error)}).`);
  }
}

async function canonicalFileNames(
  directory: string,
  pattern: RegExp,
): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return Object.freeze([]);
    throw new Error(`Could not enumerate source Strategy namespace '${directory}': ${errorMessage(error)}`);
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && !entry.isFile()) {
      throw new Error(`Source Strategy namespace '${directory}' contains a non-file JSON artifact '${entry.name}'.`);
    }
    if (entry.isFile() && entry.name.endsWith(".json") && !pattern.test(entry.name)) {
      throw new Error(`Source Strategy namespace '${directory}' contains a non-canonical JSON artifact '${entry.name}'.`);
    }
  }
  return Object.freeze(entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText));
}

const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

/**
 * Resolve one exact promoted v0.7 Derived revision directly by project ID.
 * No source repository root is required or inferred.
 */
export class FileStrategyTrustScopeSourceResolver implements StrategyTrustScopeSourceResolver {
  private readonly projectsBaseDir: string;

  constructor(options: StrategyTrustScopeSourceResolverOptions = {}) {
    this.projectsBaseDir = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
  }

  async resolve(
    sourceStrategyInput: StrategyTrustScopeSourceStrategyV1,
  ): Promise<ResolvedStrategyTrustScopeSource> {
    const sourceStrategy = validateStrategyTrustScopeSourceStrategy(sourceStrategyInput);
    if (!isCanonicalStrategyTrustScopeProjectId(sourceStrategy.sourceProjectId)) {
      return invalid("sourceProjectId must be canonical.");
    }
    if (SEED_STRATEGIES.some((seed) => seed.id === sourceStrategy.strategyId)) {
      return invalid("a Seed logical Strategy cannot be a transferable Derived subject.");
    }

    const namespace = join(this.projectsBaseDir, sourceStrategy.sourceProjectId);
    const candidateDirectory = join(namespace, STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME);
    const decisionDirectory = join(namespace, STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME);
    const revisionDirectory = join(namespace, STRATEGY_REVISION_DIRECTORY_NAME);

    const [rawCandidate, rawDecision] = await Promise.all([
      readJson(join(candidateDirectory, `${sourceStrategy.revisionIdentity}.json`)),
      readJson(join(decisionDirectory, `${sourceStrategy.revisionIdentity}.json`)),
    ]);
    if (rawCandidate === null) {
      throw new Error(`Source Derivation Candidate '${sourceStrategy.revisionIdentity}' is missing.`);
    }
    if (rawDecision === null) {
      throw new Error(`Source Derivation Decision '${sourceStrategy.revisionIdentity}' is missing.`);
    }

    let candidate: StrategyDerivationCandidateV1;
    try {
      candidate = validateStrategyDerivationCandidateArtifact(
        rawCandidate,
        sourceStrategy.revisionIdentity,
      );
    } catch (error) {
      throw new Error(`Source Derivation Candidate is malformed: ${errorMessage(error)}`);
    }
    if (candidate.projectId !== sourceStrategy.sourceProjectId) {
      throw new Error("Source Derivation Candidate projectId does not match sourceProjectId.");
    }
    const resolvedBinding = sourceStrategyFromCandidate(candidate);
    if (resolvedBinding.strategyId !== sourceStrategy.strategyId) {
      throw new Error("Source logical Strategy ID does not match the requested binding.");
    }
    if (resolvedBinding.kind !== sourceStrategy.kind) {
      throw new Error("Source Strategy kind does not match the requested binding.");
    }
    if (resolvedBinding.revisionIdentity !== sourceStrategy.revisionIdentity) {
      throw new Error("Source revision identity does not match the requested binding.");
    }
    if (resolvedBinding.revisionFingerprint !== sourceStrategy.revisionFingerprint) {
      throw new Error("Source Derivation Candidate fingerprint does not match the requested binding.");
    }

    let directDecision: StrategyDerivationDecisionV1;
    try {
      directDecision = validateStrategyDerivationDecisionArtifact(
        rawDecision,
        sourceStrategy.revisionIdentity,
      );
      validateStrategyDerivationDecisionBinding(directDecision, candidate);
    } catch (error) {
      throw new Error(`Source Derivation Decision is malformed or not bound to the Candidate: ${errorMessage(error)}`);
    }
    if (directDecision.decision !== "promoted") {
      throw new Error("Source Derivation Decision is not promoted.");
    }

    // Read the complete source Derived namespace to prove that the selected
    // promotion remains a coherent project-local trust projection. Inactive
    // Candidates are validated but do not enter the promoted catalog.
    const candidateNames = await canonicalFileNames(candidateDirectory, CANONICAL_CANDIDATE_FILE);
    const derivationCandidates: StrategyDerivationCandidateV1[] = [];
    const derivationById = new Map<string, StrategyDerivationCandidateV1>();
    for (const name of candidateNames) {
      const id = name.slice(0, -".json".length);
      if (!isCanonicalStrategyDerivationCandidateId(id)) {
        throw new Error(`Source Derivation Candidate filename '${name}' is not canonical.`);
      }
      const parsed = await readJson(join(candidateDirectory, name));
      if (parsed === null) throw new Error(`Source Derivation Candidate '${id}' disappeared while reading.`);
      let value: StrategyDerivationCandidateV1;
      try {
        value = validateStrategyDerivationCandidateArtifact(parsed, id);
      } catch (error) {
        throw new Error(`Source Derivation Candidate '${id}' is malformed: ${errorMessage(error)}`);
      }
      if (value.projectId !== sourceStrategy.sourceProjectId) {
        throw new Error(`Source Derivation Candidate '${id}' has the wrong projectId.`);
      }
      if (derivationById.has(id)) throw new Error(`Duplicate source Derivation Candidate '${id}' was found.`);
      derivationById.set(id, value);
      derivationCandidates.push(value);
    }
    if (!derivationById.has(candidate.candidateId)) {
      throw new Error("The requested source Candidate is not present in the coherent Derived namespace.");
    }

    const decisionNames = await canonicalFileNames(decisionDirectory, CANONICAL_CANDIDATE_FILE);
    const derivationDecisions: StrategyDerivationDecisionV1[] = [];
    const derivationDecisionById = new Map<string, StrategyDerivationDecisionV1>();
    for (const name of decisionNames) {
      const id = name.slice(0, -".json".length);
      if (!isCanonicalStrategyDerivationCandidateId(id)) {
        throw new Error(`Source Derivation Decision filename '${name}' is not canonical.`);
      }
      const parsed = await readJson(join(decisionDirectory, name));
      if (parsed === null) throw new Error(`Source Derivation Decision '${id}' disappeared while reading.`);
      let decision: StrategyDerivationDecisionV1;
      try {
        decision = validateStrategyDerivationDecisionArtifact(parsed, id);
      } catch (error) {
        throw new Error(`Source Derivation Decision '${id}' is malformed: ${errorMessage(error)}`);
      }
      const boundCandidate = derivationById.get(id);
      if (boundCandidate === undefined) {
        throw new Error(`Source Derivation Decision '${id}' is missing its immutable Candidate artifact.`);
      }
      try {
        validateStrategyDerivationDecisionBinding(decision, boundCandidate);
      } catch (error) {
        throw new Error(`Source Derivation Decision '${id}' is not bound to its Candidate: ${errorMessage(error)}`);
      }
      if (derivationDecisionById.has(id)) throw new Error(`Duplicate source Derivation Decision '${id}' was found.`);
      derivationDecisionById.set(id, decision);
      derivationDecisions.push(decision);
    }
    if (derivationDecisionById.get(candidate.candidateId) === undefined) {
      throw new Error("The requested source Candidate is missing its matching Derivation Decision.");
    }

    // A UUID shared by the frozen Revision Candidate namespace and the Derived
    // namespace is ambiguous even when only one side is currently promoted.
    const revisionNames = await canonicalFileNames(revisionDirectory, CANONICAL_CANDIDATE_FILE);
    const revisionIds = new Set<string>();
    for (const name of revisionNames) {
      const id = name.slice(0, -".json".length);
      if (!isCanonicalStrategyCandidateId(id)) {
        throw new Error(`Source Revision Candidate filename '${name}' is not canonical.`);
      }
      const parsed = await readJson(join(revisionDirectory, name));
      if (parsed === null) throw new Error(`Source Revision Candidate '${id}' disappeared while reading.`);
      try {
        validateStrategyRevisionCandidateArtifact(parsed, id);
      } catch (error) {
        throw new Error(`Source Revision Candidate '${id}' is malformed: ${errorMessage(error)}`);
      }
      revisionIds.add(id);
    }
    for (const id of derivationById.keys()) {
      if (revisionIds.has(id)) {
        throw new Error(`Candidate ID '${id}' is ambiguous between Revision and Derivation Candidate stores.`);
      }
    }

    const promotedEntries = derivationDecisions
      .filter((decision) => decision.decision === "promoted")
      .map((decision) => {
        const value = derivationById.get(decision.candidateId);
        if (value === undefined) {
          throw new Error(`Promoted source Decision '${decision.candidateId}' is missing its Candidate.`);
        }
        const fingerprint = strategyDerivationCandidateSemanticFingerprint(value);
        return {
          candidate: value,
          decision,
          selection: createStrategyRevisionSelection({
            strategyId: value.proposal.strategyId,
            kind: value.proposal.kind,
            revisionIdentity: value.candidateId,
            revisionFingerprint: fingerprint,
            revisionStatusAtRun: "promoted",
            semantics: {
              summary: value.proposal.summary,
              useWhen: [...value.proposal.useWhen],
              avoidWhen: [...value.proposal.avoidWhen],
              principles: [...value.proposal.principles],
            },
          }),
        };
      });

    let promotedDerivedCatalog: PromotedDerivedStrategyCatalog;
    try {
      promotedDerivedCatalog = createPromotedDerivedStrategyCatalog(promotedEntries);
    } catch (error) {
      throw new Error(`Source project-local Derived trust is incoherent: ${errorMessage(error)}`);
    }
    const promoted = promotedDerivedCatalog.entries.find((entry) =>
      entry.candidate.candidateId === candidate.candidateId);
    if (promoted === undefined) {
      throw new Error("The requested source revision is not a coherent promoted Derived Strategy.");
    }

    return Object.freeze({
      sourceStrategy: Object.freeze({ ...resolvedBinding }),
      candidate,
      decision: directDecision,
      selection: promoted.selection,
      promotedDerivedCatalog,
    });
  }
}

export const FileStrategyTrustScopeResolver = FileStrategyTrustScopeSourceResolver;
export const resolveStrategyTrustScopeSource = async (
  sourceStrategy: StrategyTrustScopeSourceStrategyV1,
  options: StrategyTrustScopeSourceResolverOptions = {},
): Promise<ResolvedStrategyTrustScopeSource> =>
  new FileStrategyTrustScopeSourceResolver(options).resolve(sourceStrategy);
