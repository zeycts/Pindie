import {
  createStrategyTrustScopeCandidate,
  FileStrategyTrustScopeCandidateStore,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeCandidateStore,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import {
  FileStrategyTrustScopeDecisionStore,
  validateStrategyTrustScopeDecisionArtifact,
  validateStrategyTrustScopeDecisionBinding,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionV1,
} from "./strategy-trust-scope-decisions.ts";
import {
  FileStrategyTrustScopeSourceResolver,
  type ResolvedStrategyTrustScopeSource,
  type StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import {
  FileGlobalWriterLock,
  type GlobalWriterLock,
  getProjectId,
} from "./store.ts";
import {
  SEED_STRATEGIES,
} from "./strategies.ts";
import type {
  TrustedPortfolioManifestEntry,
  TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";

export const MAX_TRUST_TRANSFER_COMMAND_LABEL_LENGTH = 192;

export interface CreateStrategyTrustScopeCandidateForProjectInput {
  readonly projectRoot: string;
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  /** Optional deterministic test seams; the Harness owns runtime values. */
  readonly candidateId?: string;
  readonly createdAt?: string;
}

export interface StrategyTrustScopeCandidateCreationDependencies {
  readonly candidateStore: StrategyTrustScopeCandidateStore;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
  readonly writerLock: GlobalWriterLock;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceBindingKey(source: StrategyTrustScopeSourceStrategyV1): string {
  return [
    source.sourceProjectId,
    source.strategyId,
    source.kind,
    source.revisionIdentity,
    source.revisionFingerprint,
  ].join("\0");
}

function sameSourceBinding(
  left: StrategyTrustScopeSourceStrategyV1,
  right: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return sourceBindingKey(left) === sourceBindingKey(right);
}

function sourceBindingFromManifest(
  projectId: string,
  entry: TrustedPortfolioManifestEntry,
): StrategyTrustScopeSourceStrategyV1 {
  return Object.freeze({
    sourceProjectId: projectId,
    strategyId: entry.strategyId,
    kind: entry.kind,
    revisionIdentity: entry.revisionIdentity,
    revisionFingerprint: entry.revisionFingerprint,
  });
}

function validateGlobalFacts(
  candidates: readonly StrategyTrustScopeCandidateV1[],
  decisions: readonly StrategyTrustScopeDecisionV1[],
): void {
  const candidatesById = new Map<string, StrategyTrustScopeCandidateV1>();
  for (const rawCandidate of candidates) {
    const candidate = validateStrategyTrustScopeCandidateArtifact(
      rawCandidate,
      rawCandidate.candidateId,
    );
    if (candidatesById.has(candidate.candidateId)) {
      throw new Error(`Duplicate global Scope Candidates exist for '${candidate.candidateId}'.`);
    }
    candidatesById.set(candidate.candidateId, candidate);
  }
  const decisionIds = new Set<string>();
  for (const rawDecision of decisions) {
    const decision = validateStrategyTrustScopeDecisionArtifact(
      rawDecision,
      rawDecision.candidateId,
    );
    if (decisionIds.has(decision.candidateId)) {
      throw new Error(`Duplicate global Scope Decisions exist for '${decision.candidateId}'.`);
    }
    decisionIds.add(decision.candidateId);
    const candidate = candidatesById.get(decision.candidateId);
    if (candidate === undefined) {
      throw new Error(`Global Scope Decision '${decision.candidateId}' is missing its immutable Candidate.`);
    }
    validateStrategyTrustScopeDecisionBinding(decision, candidate);
  }
}

/**
 * Fresh lock-protected read/check/write for one explicit trust-scope
 * hypothesis. The source resolver, not the caller, supplies authoritative
 * source identity and the Candidate occurrence is the only new artifact.
 */
export async function createStrategyTrustScopeCandidateForProject(
  input: CreateStrategyTrustScopeCandidateForProjectInput,
  dependencies: StrategyTrustScopeCandidateCreationDependencies,
): Promise<StrategyTrustScopeCandidateV1> {
  return dependencies.writerLock.withLock(async () => {
    const currentProjectId = getProjectId(input.projectRoot);
    if (currentProjectId !== input.sourceStrategy.sourceProjectId) {
      throw new Error("Trust-transfer Candidate creation must run from the source project.");
    }

    let resolved: ResolvedStrategyTrustScopeSource;
    try {
      resolved = await dependencies.sourceResolver.resolve(input.sourceStrategy);
    } catch (error) {
      throw new Error(`Source Strategy resolution failed closed: ${errorMessage(error)}`);
    }
    if (!sameSourceBinding(resolved.sourceStrategy, input.sourceStrategy)) {
      throw new Error("Source Strategy binding changed while creating the Scope Candidate.");
    }
    if (SEED_STRATEGIES.some((seed) => seed.id === resolved.sourceStrategy.strategyId)) {
      throw new Error("Seed Strategies and promoted Seed revisions are not transferable subjects.");
    }

    let candidates: readonly StrategyTrustScopeCandidateV1[];
    let decisions;
    try {
      candidates = await dependencies.candidateStore.readAll();
      decisions = await dependencies.decisionReader.readAll();
      validateGlobalFacts(candidates, decisions);
    } catch (error) {
      throw new Error(`Global Scope artifacts are malformed or ambiguous; no hypothesis was created: ${errorMessage(error)}`);
    }

    const expectedFingerprint = strategyTrustScopeCandidateFingerprint({
      sourceStrategy: resolved.sourceStrategy,
      currentTrustScope: "project",
      proposedTrustScope: "user-global",
    });
    if (candidates.some((candidate) =>
      strategyTrustScopeCandidateFingerprint(candidate) === expectedFingerprint)) {
      throw new Error("An identical trust-transfer hypothesis already exists; rejected hypotheses cannot be reopened.");
    }

    if (decisions.some((decision) =>
      decision.decision === "promoted" &&
      decision.sourceStrategy.strategyId === resolved.sourceStrategy.strategyId)) {
      throw new Error("A user-global trusted revision already owns this logical Strategy ID.");
    }

    const candidate = createStrategyTrustScopeCandidate({
      sourceStrategy: resolved.sourceStrategy,
      candidateId: input.candidateId,
      createdAt: input.createdAt,
    });
    await dependencies.candidateStore.save(candidate);
    return candidate;
  });
}

export const createTrustScopeCandidateForProject = createStrategyTrustScopeCandidateForProject;

export interface TrustTransferCompletionEntry {
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  readonly label: string;
  readonly option: { readonly value: string; readonly label: string };
}

export interface TrustTransferCommandProjection {
  readonly entries: readonly TrustTransferCompletionEntry[];
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

function boundedLabel(value: string): string {
  if (value.length <= MAX_TRUST_TRANSFER_COMMAND_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_TRUST_TRANSFER_COMMAND_LABEL_LENGTH - 1)}…`;
}

function sourceEntry(
  projectId: string,
  entry: TrustedPortfolioManifestEntry,
): TrustTransferCompletionEntry {
  const sourceStrategy = sourceBindingFromManifest(projectId, entry);
  const label = boundedLabel(
    `${entry.strategyId} (${entry.kind}) · promoted ${entry.revisionIdentity.slice(0, 8)} · project-local trusted Derived Strategy · transferable to a user-global trust hypothesis`,
  );
  return Object.freeze({
    sourceStrategy,
    label,
    option: Object.freeze({ value: entry.strategyId, label }),
  });
}

/** Build meaning-first completion from identity-only project-local trust. */
export function buildTrustTransferCommandProjection(
  projectRoot: string,
  portfolio: TrustedStrategyPortfolio,
): TrustTransferCommandProjection {
  const projectId = getProjectId(projectRoot);
  const entries = portfolio.resolvedEntries
    .filter((entry) => entry.manifest.origin === "promoted-derived")
    .map((entry) => sourceEntry(projectId, entry.manifest))
    .sort((left, right) => {
      const labelOrder = compareText(left.label, right.label);
      return labelOrder !== 0
        ? labelOrder
        : compareText(sourceBindingKey(left.sourceStrategy), sourceBindingKey(right.sourceStrategy));
    });
  return Object.freeze({
    entries: Object.freeze(entries),
    options: Object.freeze(entries.map((entry) => entry.option)),
  });
}

/**
 * Completion projection that additionally re-resolves every local Derived
 * entry, so stale or ambiguous source namespaces never become options.
 */
export async function listTransferableDerivedStrategies(
  projectRoot: string,
  portfolio: TrustedStrategyPortfolio,
  sourceResolver: StrategyTrustScopeSourceResolver,
): Promise<TrustTransferCommandProjection> {
  const projection = buildTrustTransferCommandProjection(projectRoot, portfolio);
  const valid: TrustTransferCompletionEntry[] = [];
  for (const entry of projection.entries) {
    try {
      const resolved = await sourceResolver.resolve(entry.sourceStrategy);
      if (sameSourceBinding(resolved.sourceStrategy, entry.sourceStrategy)) valid.push(entry);
    } catch {
      // Completion is advisory and fail-closed per entry. The command repeats
      // the exact source resolution under the global writer lock.
    }
  }
  return Object.freeze({
    entries: Object.freeze(valid),
    options: Object.freeze(valid.map((entry) => entry.option)),
  });
}

export function filterTrustTransferCommandOptions(
  projection: TrustTransferCommandProjection,
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

/** Default production dependencies for callers that do not inject test seams. */
export function defaultStrategyTrustScopeDependencies(
  options: {
    readonly projectsBaseDir?: string;
    readonly globalBaseDir?: string;
  } = {},
): StrategyTrustScopeCandidateCreationDependencies {
  const candidateStore = new FileStrategyTrustScopeCandidateStore({ baseDir: options.globalBaseDir });
  const decisionStore = new FileStrategyTrustScopeDecisionStore({ baseDir: options.globalBaseDir });
  const sourceResolver = new FileStrategyTrustScopeSourceResolver({
    projectsBaseDir: options.projectsBaseDir,
  });
  const writerLock = new FileGlobalWriterLock({ baseDir: options.globalBaseDir });
  return { candidateStore, decisionReader: decisionStore, sourceResolver, writerLock };
}
