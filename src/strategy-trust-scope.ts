import { isDeepStrictEqual } from "node:util";
import { FileStrategyKnowledge } from "./strategy-knowledge-file.ts";

import {
  createStrategyTrustScopeCandidate,
  isCanonicalStrategyTrustScopeCandidateId,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeCandidateStore,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  validateStrategyTrustScopeDecisionArtifact,
  validateStrategyTrustScopeDecisionBinding,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionStore,
  type StrategyTrustScopeDecisionTerminal,
  type StrategyTrustScopeDecisionV1,
} from "./strategy-trust-scope-decisions.ts";
import {
  type ResolvedStrategyTrustScopeSource,
  type StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import {
  FileGlobalWriterLock,
  type GlobalWriterLock,
  getProjectId,
} from "./store.ts";
import {
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
} from "./strategy-derivation-decisions.ts";
import {
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
} from "./policy.ts";
import type { RunExperienceProjectReader } from "./experience-store.ts";
import type { StrategySynthesisCandidateReader } from "./strategy-synthesis-candidates.ts";
import type { StrategySynthesisDecisionReader } from "./strategy-synthesis-decisions.ts";
import {
  deriveStrategyTrustScopeTrialReview,
  type ScopeProjectTrustReader,
  type StrategyTrustScopeTrialReview,
} from "./strategy-trust-scope-review.ts";
import {
  readScopeTrialGlobalArtifacts,
  type ScopeTrialGlobalArtifacts,
} from "./strategy-trust-safety.ts";
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
 * Validate the complete immutable source chain required by a Scope Decision.
 * Scope artifacts carry identity only; the source resolver remains the
 * authority for Derived semantics and project-local promotion.
 */
export function validateStrategyTrustScopeSourceResolution(
  candidate: StrategyTrustScopeCandidateV1,
  resolved: ResolvedStrategyTrustScopeSource,
): ResolvedStrategyTrustScopeSource {
  const validatedCandidate = validateStrategyTrustScopeCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const source = validateStrategyTrustScopeSourceStrategy(resolved.sourceStrategy);
  if (!sameSourceBinding(source, validatedCandidate.sourceStrategy)) {
    throw new Error("resolved source Strategy binding does not match the immutable Scope Candidate");
  }
  const sourceCandidate = validateStrategyDerivationCandidateArtifact(
    resolved.candidate,
    validatedCandidate.sourceStrategy.revisionIdentity,
  );
  const sourceFingerprint = strategyDerivationCandidateSemanticFingerprint(sourceCandidate);
  if (
    sourceCandidate.projectId !== source.sourceProjectId ||
    sourceCandidate.proposal.strategyId !== source.strategyId ||
    sourceCandidate.proposal.kind !== source.kind ||
    sourceCandidate.candidateId !== source.revisionIdentity ||
    sourceFingerprint !== source.revisionFingerprint
  ) {
    throw new Error("resolved source Derivation Candidate does not match the immutable Scope Candidate");
  }
  const sourceDecision = validateStrategyDerivationDecisionBinding(
    validateStrategyDerivationDecisionArtifact(
      resolved.decision,
      sourceCandidate.candidateId,
    ),
    sourceCandidate,
  );
  if (sourceDecision.decision !== "promoted") {
    throw new Error("resolved source Strategy is not currently promoted in its project");
  }
  const expectedSemantics = {
    summary: sourceCandidate.proposal.summary,
    useWhen: [...sourceCandidate.proposal.useWhen],
    avoidWhen: [...sourceCandidate.proposal.avoidWhen],
    principles: [...sourceCandidate.proposal.principles],
  };
  const selection = resolved.selection;
  if (
    strategySelectionRevisionStatus(selection) !== "promoted" ||
    strategySelectionId(selection) !== sourceCandidate.proposal.strategyId ||
    selection.kind !== sourceCandidate.proposal.kind ||
    strategySelectionRevisionIdentity(selection) !== sourceCandidate.candidateId ||
    strategySelectionRevisionFingerprint(selection) !== sourceFingerprint ||
    !isDeepStrictEqual(selection.semantics, expectedSemantics)
  ) {
    throw new Error("resolved source Strategy selection is not the exact promoted Derived revision");
  }
  return resolved;
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

export interface CreateStrategyTrustScopeDecisionForHumanInput {
  readonly candidateId: string;
  readonly decision: StrategyTrustScopeDecisionTerminal;
  /** Optional deterministic test seam; the Harness owns this timestamp. */
  readonly decidedAt?: string;
  readonly currentProjectRoot?: string | null;
}

export interface StrategyTrustScopeDecisionCreationDependencies {
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionStore: StrategyTrustScopeDecisionStore;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
  readonly writerLock: GlobalWriterLock;
  /** Required for promotion; rejection intentionally has no evidence gate. */
  readonly experienceReader?: RunExperienceProjectReader;
  /** Required for promotion's complete local-collision scan. */
  readonly projectTrustReader?: ScopeProjectTrustReader;
  /** Shared user-global trust safety readers supplied by SI. */
  readonly synthesisCandidateReader?: StrategySynthesisCandidateReader;
  readonly synthesisDecisionReader?: StrategySynthesisDecisionReader;
}

export interface StrategyTrustScopeDecisionCreationResult {
  readonly decision: StrategyTrustScopeDecisionV1;
  readonly review: StrategyTrustScopeTrialReview | null;
}

/**
 * Perform one Human Scope Decision as a lock-protected read/check/write. The
 * lock covers the final review and selected evidence revalidation; the
 * immutable Decision store is the no-replacement backstop.
 */
export async function createStrategyTrustScopeDecisionForHuman(
  input: CreateStrategyTrustScopeDecisionForHumanInput,
  dependencies: StrategyTrustScopeDecisionCreationDependencies,
): Promise<StrategyTrustScopeDecisionCreationResult> {
  if (!isCanonicalStrategyTrustScopeCandidateId(input.candidateId)) {
    throw new Error("Scope Decision Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return dependencies.writerLock.withLock(async () => {
    let artifacts: ScopeTrialGlobalArtifacts;
    try {
      artifacts = await readScopeTrialGlobalArtifacts(
        dependencies.candidateReader,
        dependencies.decisionStore,
      );
    } catch (error) {
      throw new Error(`Global Scope artifacts are malformed or ambiguous; no Decision was written: ${errorMessage(error)}`);
    }
    const candidate = artifacts.candidates.find((item) => item.candidateId === input.candidateId);
    if (candidate === undefined) {
      throw new Error(`Scope Candidate '${input.candidateId}' was not found; no Decision was written.`);
    }
    if (artifacts.decisions.some((item) => item.candidateId === input.candidateId)) {
      throw new Error("An immutable terminal Scope Decision already exists; no replacement Decision was written.");
    }

    let resolved: ResolvedStrategyTrustScopeSource;
    try {
      resolved = await dependencies.sourceResolver.resolve(candidate.sourceStrategy);
      validateStrategyTrustScopeSourceResolution(candidate, resolved);
    } catch (error) {
      throw new Error(`Source Strategy resolution failed closed; no Decision was written: ${errorMessage(error)}`);
    }

    let review: StrategyTrustScopeTrialReview | null = null;
    let trialRefs: readonly import("./cross-project-experience.ts").CrossProjectExperienceRefV1[] = [];
    if (input.decision === "promoted") {
      if (dependencies.experienceReader === undefined || dependencies.projectTrustReader === undefined) {
        throw new Error("Promotion requires the complete cross-project Experience and local-trust readers; no Decision was written.");
      }
      try {
        review = await deriveStrategyTrustScopeTrialReview({
          candidate,
          candidateReader: dependencies.candidateReader,
          decisionReader: dependencies.decisionStore,
          sourceResolver: dependencies.sourceResolver,
          experienceReader: dependencies.experienceReader,
          projectTrustReader: dependencies.projectTrustReader,
          synthesisCandidateReader: dependencies.synthesisCandidateReader,
          synthesisDecisionReader: dependencies.synthesisDecisionReader,
          currentProjectRoot: input.currentProjectRoot,
        });
      } catch (error) {
        throw new Error(`Scope Promotion Eligibility review failed; no Decision was written: ${errorMessage(error)}`);
      }
      if (!review.promotionEligibility.eligible) {
        const reasons = review.promotionEligibility.reasons.slice(0, 8);
        throw new Error(
          `Scope Promotion Eligibility is not satisfied; no Decision was written.${reasons.length > 0 ? ` Reasons: ${reasons.join("; ")}` : ""}`,
        );
      }
      // The review's final authority pass is deliberately the last read/check
      // before constructing this immutable artifact. Its selected refs have
      // already been directly re-read, fingerprint-checked, and revalidated.
      trialRefs = review.selectedEvidenceRefs;
    }

    let decision: StrategyTrustScopeDecisionV1;
    try {
      decision = createStrategyTrustScopeDecision({
        candidate,
        decision: input.decision,
        trialRefs,
        decidedAt: input.decidedAt,
      });
      validateStrategyTrustScopeDecisionBinding(decision, candidate);
    } catch (error) {
      throw new Error(`Scope Decision construction failed; no Decision was written: ${errorMessage(error)}`);
    }
    try {
      await dependencies.decisionStore.save(decision);
    } catch (error) {
      throw new Error(`Scope Decision was not persisted; no trust transition occurred: ${errorMessage(error)}`);
    }
    return Object.freeze({ decision, review });
  });
}

export const createTrustScopeDecisionForHuman = createStrategyTrustScopeDecisionForHuman;

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
  const knowledge = new FileStrategyKnowledge(options);
  const candidateStore = knowledge.scopeCandidates;
  const decisionStore = knowledge.scopeDecisions;
  const sourceResolver = knowledge.sourceResolver;
  const writerLock = new FileGlobalWriterLock({ baseDir: options.globalBaseDir });
  return { candidateStore, decisionReader: decisionStore, sourceResolver, writerLock };
}
