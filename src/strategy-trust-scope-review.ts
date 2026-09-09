import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  compareCrossProjectExperienceRefs,
  createCrossProjectExperienceRef,
  MAX_CROSS_PROJECT_EXPERIENCE_REFS,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import {
  evaluateRunExperience,
  type RunEvaluation,
} from "./experience-evaluation.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
} from "./experience-store.ts";
import {
  parseRunExperience,
  type RunExperience,
} from "./run-experience.ts";
import {
  isCanonicalStrategyCandidateId,
  validateStrategyRevisionCandidateArtifact,
} from "./strategy-candidates.ts";
import {
  createStrategyRevisionSelection,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  MAX_PROMOTED_DERIVED_STRATEGIES,
  createPromotedDerivedStrategyCatalog,
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
  type StrategyDerivationDecisionV1,
} from "./strategy-derivation-decisions.ts";
import {
  STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME,
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  isCanonicalStrategyTrustScopeCandidateId,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionReader,
  StrategyTrustScopeDecisionV1,
} from "./strategy-trust-scope-decisions.ts";
import {
  readScopeTrialGlobalArtifacts,
  type ScopeTrialGlobalArtifacts,
} from "./strategy-trust-scope-trial.ts";
import {
  STRATEGY_REVISION_DIRECTORY_NAME,
  type ResolvedStrategyTrustScopeSource,
  type StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import { SEED_STRATEGIES } from "./strategies.ts";
import { getProjectId } from "./store.ts";

/** The v0.1 bound for future user-global Derived trust. */
export const MAX_USER_GLOBAL_DERIVED_STRATEGIES = 8;
/** Human detail bounds; aggregate facts are never truncated by these values. */
export const MAX_SCOPE_REVIEW_PROJECT_DETAILS = 16;
export const MAX_SCOPE_REVIEW_RECORD_DETAILS = 8;
export const MAX_SCOPE_REVIEW_REASON_DETAILS = 24;
export const MAX_SCOPE_REVIEW_TEXT_LENGTH = 256;

const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANONICAL_RECORD_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const DERIVATION_TRUST_FIELDS = [
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
] as const;

export interface ScopeProjectTrustedDerivedEntry {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
}

export interface ScopeProjectTrustSnapshot {
  readonly projectId: string;
  readonly promotedDerived: readonly ScopeProjectTrustedDerivedEntry[];
}

/**
 * Project-ID-addressed local trust access for the cross-project conflict scan.
 * It never infers a project ID from a display path.
 */
export interface ScopeProjectTrustReader {
  readProjectId(projectId: string): Promise<ScopeProjectTrustSnapshot>;
}

export interface FileScopeProjectTrustReaderOptions {
  projectsBaseDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  return actual.length === fields.length &&
    actual.every((field, index) => field === fields[index]);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameSourceBinding(
  left: StrategyTrustScopeSourceStrategyV1,
  right: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return left.sourceProjectId === right.sourceProjectId &&
    left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint;
}

function sameTrustEntry(
  left: Pick<ScopeProjectTrustedDerivedEntry, "strategyId" | "kind" | "revisionIdentity" | "revisionFingerprint">,
  right: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint;
}

function sameSemantics(
  selection: { readonly summary: string; readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[]; readonly principles: readonly string[] },
  candidate: StrategyDerivationCandidateV1,
): boolean {
  return JSON.stringify(selection) === JSON.stringify({
    summary: candidate.proposal.summary,
    useWhen: [...candidate.proposal.useWhen],
    avoidWhen: [...candidate.proposal.avoidWhen],
    principles: [...candidate.proposal.principles],
  });
}

function shortIdentity(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 8);
}

function boundedText(value: string): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return escaped.length <= MAX_SCOPE_REVIEW_TEXT_LENGTH
    ? escaped
    : `${escaped.slice(0, MAX_SCOPE_REVIEW_TEXT_LENGTH - 12)} [truncated]`;
}

function invalidProjectId(projectId: string): never {
  throw new Error(`Project namespace '${projectId}' is not a canonical lowercase project identity.`);
}

function validateProjectId(projectId: string): string {
  if (!CANONICAL_PROJECT_ID.test(projectId)) return invalidProjectId(projectId);
  return projectId;
}

function validateScopeProjectTrustSnapshot(
  value: unknown,
  expectedProjectId: string,
): ScopeProjectTrustSnapshot {
  if (!isRecord(value) || typeof value.projectId !== "string") {
    throw new Error("Project trust reader returned an invalid project snapshot.");
  }
  const projectId = validateProjectId(value.projectId);
  if (projectId !== expectedProjectId) {
    throw new Error("project trust reader returned the wrong project identity");
  }
  if (!Array.isArray(value.promotedDerived) ||
    value.promotedDerived.length > MAX_PROMOTED_DERIVED_STRATEGIES) {
    throw new Error("Project trust reader returned an invalid promoted Derived collection.");
  }
  const entries = value.promotedDerived.map((raw, index) => {
    if (!isRecord(raw) || !hasExactFields(raw, DERIVATION_TRUST_FIELDS)) {
      throw new Error(`Project trust entry ${index} has invalid identity fields.`);
    }
    const source = validateStrategyTrustScopeSourceStrategy({
      sourceProjectId: projectId,
      strategyId: raw.strategyId,
      kind: raw.kind,
      revisionIdentity: raw.revisionIdentity,
      revisionFingerprint: raw.revisionFingerprint,
    });
    if (SEED_STRATEGIES.some((seed) => seed.id === source.strategyId)) {
      throw new Error(`Project trust entry '${source.strategyId}' collides with an immutable Seed.`);
    }
    return Object.freeze({
      strategyId: source.strategyId,
      kind: source.kind,
      revisionIdentity: source.revisionIdentity,
      revisionFingerprint: source.revisionFingerprint,
    });
  }).sort((left, right) => compareText(manifestEntryKey(left), manifestEntryKey(right)));
  const logicalIds = new Set<string>();
  for (const entry of entries) {
    if (logicalIds.has(entry.strategyId)) {
      throw new Error(`Project trust contains more than one promoted Derived revision for logical Strategy ID '${entry.strategyId}'.`);
    }
    logicalIds.add(entry.strategyId);
  }
  return Object.freeze({
    projectId,
    promotedDerived: Object.freeze(entries),
  });
}

function manifestEntryKey(entry: ScopeProjectTrustedDerivedEntry): string {
  return [entry.strategyId, entry.kind, entry.revisionIdentity, entry.revisionFingerprint].join("\0");
}

function sourceIdentityKey(source: StrategyTrustScopeSourceStrategyV1): string {
  return [source.strategyId, source.kind, source.revisionIdentity, source.revisionFingerprint].join("\0");
}

function fingerprintProjection(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Authority projection could not be serialized deterministically.");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function sourceStrategyAuthorityProjection(
  source: StrategyTrustScopeSourceStrategyV1,
): Record<string, unknown> {
  return {
    sourceProjectId: source.sourceProjectId,
    strategyId: source.strategyId,
    kind: source.kind,
    revisionIdentity: source.revisionIdentity,
    revisionFingerprint: source.revisionFingerprint,
  };
}

function strategySelectionAuthorityProjection(
  selection: StrategyRevisionSelection,
): Record<string, unknown> {
  return {
    strategyId: strategySelectionId(selection),
    kind: selection.kind,
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
    revisionStatusAtRun: strategySelectionRevisionStatus(selection),
    semantics: {
      summary: selection.semantics.summary,
      useWhen: [...selection.semantics.useWhen],
      avoidWhen: [...selection.semantics.avoidWhen],
      principles: [...selection.semantics.principles],
    },
  };
}

function strategyCandidateAuthorityProjection(
  candidate: StrategyDerivationCandidateV1,
): Record<string, unknown> {
  return {
    schemaVersion: candidate.schemaVersion,
    candidateId: candidate.candidateId,
    createdAt: candidate.createdAt,
    projectId: candidate.projectId,
    basePortfolio: {
      fingerprintVersion: candidate.basePortfolio.fingerprintVersion,
      fingerprint: candidate.basePortfolio.fingerprint,
      entries: candidate.basePortfolio.entries.map((entry) => ({
        origin: entry.origin,
        strategyId: entry.strategyId,
        kind: entry.kind,
        revisionIdentity: entry.revisionIdentity,
        revisionFingerprint: entry.revisionFingerprint,
      })),
    },
    proposal: {
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    },
    evidence: {
      sourceRecordIds: [...candidate.evidence.sourceRecordIds],
    },
    hypothesis: candidate.hypothesis,
  };
}

function strategyDecisionAuthorityProjection(
  decision: StrategyDerivationDecisionV1,
): Record<string, unknown> {
  return {
    schemaVersion: decision.schemaVersion,
    candidateId: decision.candidateId,
    candidateFingerprint: decision.candidateFingerprint,
    decidedAt: decision.decidedAt,
    projectId: decision.projectId,
    basePortfolioFingerprint: decision.basePortfolioFingerprint,
    strategy: {
      strategyId: decision.strategy.strategyId,
      kind: decision.strategy.kind,
    },
    decision: decision.decision,
    evidence: {
      sourceRecordIds: [...decision.evidence.sourceRecordIds],
      trialRecordIds: [...decision.evidence.trialRecordIds],
    },
  };
}

/** Snapshot the complete source trust/provenance resolution used by a review. */
function sourceResolutionAuthorityFingerprint(
  resolved: ResolvedStrategyTrustScopeSource,
): string {
  const sourceStrategy = validateStrategyTrustScopeSourceStrategy(resolved.sourceStrategy);
  const candidate = validateStrategyDerivationCandidateArtifact(
    resolved.candidate,
    resolved.candidate.candidateId,
  );
  const decision = validateStrategyDerivationDecisionBinding(
    validateStrategyDerivationDecisionArtifact(resolved.decision, candidate.candidateId),
    candidate,
  );
  if (decision.decision !== "promoted") {
    throw new Error("source Strategy promotion is not terminal promoted trust");
  }
  const candidateFingerprint = strategyDerivationCandidateSemanticFingerprint(candidate);
  if (candidate.projectId !== sourceStrategy.sourceProjectId ||
    candidate.proposal.strategyId !== sourceStrategy.strategyId ||
    candidate.proposal.kind !== sourceStrategy.kind ||
    candidate.candidateId !== sourceStrategy.revisionIdentity ||
    candidateFingerprint !== sourceStrategy.revisionFingerprint) {
    throw new Error("source Strategy resolution does not match its exact binding");
  }
  const selection = resolved.selection;
  if (strategySelectionRevisionStatus(selection) !== "promoted" ||
    strategySelectionId(selection) !== candidate.proposal.strategyId ||
    selection.kind !== candidate.proposal.kind ||
    strategySelectionRevisionIdentity(selection) !== candidate.candidateId ||
    strategySelectionRevisionFingerprint(selection) !== candidateFingerprint ||
    !sameSemantics(selection.semantics, candidate)) {
    throw new Error("source Strategy resolution has an invalid promoted selection");
  }
  const promotedDerived = [...resolved.promotedDerivedCatalog.entries]
    .map((entry) => ({
      candidate: strategyCandidateAuthorityProjection(entry.candidate),
      decision: strategyDecisionAuthorityProjection(entry.decision),
      selection: strategySelectionAuthorityProjection(entry.selection),
    }))
    .sort((left, right) => compareText(
      `${left.selection.strategyId}\0${left.selection.kind}\0${left.selection.revisionIdentity}\0${left.selection.revisionFingerprint}`,
      `${right.selection.strategyId}\0${right.selection.kind}\0${right.selection.revisionIdentity}\0${right.selection.revisionFingerprint}`,
    ));
  return fingerprintProjection({
    sourceStrategy: sourceStrategyAuthorityProjection(sourceStrategy),
    candidate: strategyCandidateAuthorityProjection(candidate),
    decision: strategyDecisionAuthorityProjection(decision),
    selection: strategySelectionAuthorityProjection(selection),
    promotedDerived,
  });
}

async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read cross-project trust artifact '${path}': ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not read cross-project trust artifact '${path}': invalid JSON (${errorMessage(error)}).`);
  }
}

async function canonicalJsonFiles(
  directory: string,
  pattern: RegExp,
  label: string,
): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return Object.freeze([]);
    throw new Error(`Could not enumerate ${label} '${directory}': ${errorMessage(error)}`);
  }
  for (const entry of entries) {
    if (entry.name.endsWith(".json") && !entry.isFile()) {
      throw new Error(`${label} '${directory}' contains a non-file JSON artifact '${entry.name}'.`);
    }
    if (entry.isFile() && entry.name.endsWith(".json") && !pattern.test(entry.name)) {
      throw new Error(`${label} '${directory}' contains a non-canonical JSON artifact '${entry.name}'.`);
    }
  }
  return Object.freeze(entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareText));
}

/** Freshly scan one project-local Derived trust namespace by project ID. */
export class FileScopeProjectTrustReader implements ScopeProjectTrustReader {
  private readonly projectsBaseDir: string;

  constructor(options: FileScopeProjectTrustReaderOptions = {}) {
    this.projectsBaseDir = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
  }

  async readProjectId(projectIdInput: string): Promise<ScopeProjectTrustSnapshot> {
    const projectId = validateProjectId(projectIdInput);
    const namespace = join(this.projectsBaseDir, projectId);
    const candidateDirectory = join(namespace, STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME);
    const decisionDirectory = join(namespace, "strategy-derivation-decisions");
    const revisionDirectory = join(namespace, STRATEGY_REVISION_DIRECTORY_NAME);

    const candidateNames = await canonicalJsonFiles(
      candidateDirectory,
      CANONICAL_CANDIDATE_FILE,
      "Strategy Derivation Candidate namespace",
    );
    const candidates = new Map<string, StrategyDerivationCandidateV1>();
    for (const name of candidateNames) {
      const candidateId = name.slice(0, -".json".length);
      const raw = await readJson(join(candidateDirectory, name));
      const candidate = validateStrategyDerivationCandidateArtifact(raw, candidateId);
      if (candidate.projectId !== projectId) {
        throw new Error(`Strategy Derivation Candidate '${candidateId}' has the wrong projectId.`);
      }
      if (candidates.has(candidateId)) {
        throw new Error(`Duplicate Strategy Derivation Candidate '${candidateId}' was found.`);
      }
      candidates.set(candidateId, candidate);
    }

    const decisionNames = await canonicalJsonFiles(
      decisionDirectory,
      CANONICAL_CANDIDATE_FILE,
      "Strategy Derivation Decision namespace",
    );
    const decisions = new Map<string, StrategyDerivationDecisionV1>();
    for (const name of decisionNames) {
      const candidateId = name.slice(0, -".json".length);
      const raw = await readJson(join(decisionDirectory, name));
      const decision = validateStrategyDerivationDecisionArtifact(raw, candidateId);
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) {
        throw new Error(`Strategy Derivation Decision '${candidateId}' is missing its immutable Candidate artifact.`);
      }
      validateStrategyDerivationDecisionBinding(decision, candidate);
      if (decisions.has(candidateId)) {
        throw new Error(`Duplicate Strategy Derivation Decision '${candidateId}' was found.`);
      }
      decisions.set(candidateId, decision);
    }

    // A Candidate UUID shared with the frozen Revision namespace is an
    // ambiguity even when only one side is promoted.
    const revisionNames = await canonicalJsonFiles(
      revisionDirectory,
      CANONICAL_CANDIDATE_FILE,
      "Strategy Revision Candidate namespace",
    );
    for (const name of revisionNames) {
      const candidateId = name.slice(0, -".json".length);
      if (!isCanonicalStrategyCandidateId(candidateId)) {
        throw new Error(`Strategy Revision Candidate filename '${name}' is not canonical.`);
      }
      const raw = await readJson(join(revisionDirectory, name));
      validateStrategyRevisionCandidateArtifact(raw, candidateId);
      if (candidates.has(candidateId)) {
        throw new Error(`Candidate ID '${candidateId}' is ambiguous between Revision and Derivation Candidate stores.`);
      }
    }

    const promoted = [...decisions.values()]
      .filter((decision) => decision.decision === "promoted")
      .map((decision) => {
        const candidate = candidates.get(decision.candidateId)!;
        const fingerprint = strategyDerivationCandidateSemanticFingerprint(candidate);
        const selection = createStrategyRevisionSelection({
          strategyId: candidate.proposal.strategyId,
          kind: candidate.proposal.kind,
          revisionIdentity: candidate.candidateId,
          revisionFingerprint: fingerprint,
          revisionStatusAtRun: "promoted",
          semantics: candidate.proposal,
        });
        return { candidate, decision, selection };
      });
    const catalog = createPromotedDerivedStrategyCatalog(promoted);
    return Object.freeze({
      projectId,
      promotedDerived: Object.freeze(catalog.entries.map((entry) => Object.freeze({
        strategyId: entry.selection.strategyId,
        kind: entry.selection.kind,
        revisionIdentity: entry.selection.revisionIdentity,
        revisionFingerprint: entry.selection.revisionFingerprint,
      }))),
    });
  }
}

export const FileStrategyTrustScopeProjectReader = FileScopeProjectTrustReader;

export interface ScopeTrialEvidenceRecord {
  readonly ref: CrossProjectExperienceRefV1;
  readonly evaluation: RunEvaluation;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export interface ScopeEvidenceOutcomeSummary {
  readonly verificationPassedCount: number;
  readonly verificationNotPassedCount: number;
  readonly completedDuringRunCount: number;
  readonly notCompletedDuringRunCount: number;
  readonly runsWithBlockers: number;
  readonly runsWithQuestions: number;
  readonly totalToolErrors: number;
  readonly totalDeniedCalls: number;
}

export interface ScopeProjectEvidenceInventory {
  readonly projectId: string;
  readonly sourceProject: boolean;
  readonly matchingRecordCount: number;
  readonly eligibleRunCount: number;
  readonly ineligibleRunCount: number;
  readonly detailRecords: readonly ScopeTrialEvidenceRecord[];
  readonly omittedDetailRecordCount: number;
  readonly outcomes: ScopeEvidenceOutcomeSummary;
}

export interface ScopePromotionEligibility {
  /** True only means enough auditable evidence exists for Human trust review. */
  readonly eligible: boolean;
  readonly requiredEligibleTrialRunCount: 2;
  readonly eligibleTrialRunCount: number;
  readonly requiredDistinctTargetProjectCount: 2;
  readonly distinctEligibleTargetProjectCount: number;
  readonly scopeCandidateValid: boolean;
  readonly scopeCandidateOpen: boolean;
  readonly noTerminalScopeDecision: boolean;
  readonly sourceBindingValid: boolean;
  readonly sourceStrategyTrustValid: boolean;
  readonly proposedTrustScopeValid: boolean;
  readonly noSeedLogicalIdCollision: boolean;
  readonly globalLogicalIdAvailable: boolean;
  readonly projectLocalConflictFree: boolean;
  readonly userGlobalCapacityAvailable: boolean;
  readonly evidenceCompletenessValid: boolean;
  readonly selectedEvidenceRefsValid: boolean;
  readonly retainedEligibleRefCount: number;
  readonly omittedEligibleRefCount: number;
  readonly reasons: readonly string[];
}

export interface StrategyTrustScopeTrialReview {
  readonly candidate: StrategyTrustScopeCandidateV1;
  readonly candidateFingerprint: string;
  readonly sourceCandidate: StrategyDerivationCandidateV1 | null;
  readonly currentProjectIsSource: boolean | null;
  readonly terminalDecision: StrategyTrustScopeDecisionV1 | null;
  readonly inventories: readonly ScopeProjectEvidenceInventory[];
  readonly matchingRecordCount: number;
  readonly ineligibleMatchingRunCount: number;
  readonly eligibleTrialRunCount: number;
  readonly distinctEligibleTargetProjectCount: number;
  readonly eligibleTargetProjectIds: readonly string[];
  readonly selectedEvidenceRefs: readonly CrossProjectExperienceRefV1[];
  readonly omittedEligibleRefCount: number;
  readonly sourceTrustValid: boolean;
  readonly sourceBindingValid: boolean;
  readonly evidenceScanComplete: boolean;
  readonly globalStateComplete: boolean;
  readonly projectTrustScanComplete: boolean;
  readonly promotionEligibility: ScopePromotionEligibility;
  readonly reasons: readonly string[];
}

export type ScopeTrialReview = StrategyTrustScopeTrialReview;

export interface StrategyTrustScopeTrialReviewInput {
  readonly candidate: StrategyTrustScopeCandidateV1;
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
  readonly experienceReader: RunExperienceProjectReader;
  readonly projectTrustReader: ScopeProjectTrustReader;
  readonly currentProjectRoot?: string | null;
}

interface PreparedProjectExperience {
  readonly projectId: string;
  readonly read: RunExperienceReadResult;
  readonly matching: readonly { readonly ref: CrossProjectExperienceRefV1; readonly experience: RunExperience }[];
  readonly matchingDigest: string;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

interface MutableInventory {
  readonly projectId: string;
  readonly sourceProject: boolean;
  matchingRecordCount: number;
  eligibleRunCount: number;
  ineligibleRunCount: number;
  readonly detailRecords: ScopeTrialEvidenceRecord[];
  verificationPassedCount: number;
  completedDuringRunCount: number;
  runsWithBlockers: number;
  runsWithQuestions: number;
  totalToolErrors: number;
  totalDeniedCalls: number;
}

interface GlobalSourceAuthorityProjection {
  readonly source: StrategyTrustScopeSourceStrategyV1;
  readonly resolutionFingerprint: string;
}

interface GlobalReviewFacts {
  readonly artifacts: ScopeTrialGlobalArtifacts | null;
  readonly globalStateComplete: boolean;
  readonly globalStateReasons: readonly string[];
  readonly candidateInGlobalNamespace: boolean;
  readonly candidateOpen: boolean;
  readonly terminalDecision: StrategyTrustScopeDecisionV1 | null;
  readonly promotedGlobalEntries: readonly StrategyTrustScopeSourceStrategyV1[];
  readonly promotedGlobalSourceAuthority: readonly GlobalSourceAuthorityProjection[];
  readonly globalLogicalIdAvailable: boolean;
  readonly userGlobalCapacityAvailable: boolean;
  /** Fingerprint of every global fact used by the review gate. */
  readonly authorityFingerprint: string;
}

interface SourceReviewFacts {
  readonly resolved: ResolvedStrategyTrustScopeSource | null;
  readonly sourceCandidate: StrategyDerivationCandidateV1 | null;
  readonly sourceBindingValid: boolean;
  readonly sourceTrustValid: boolean;
  /** Includes exact source semantics, promotion, and the resolved local catalog. */
  readonly authorityFingerprint: string | null;
  readonly reasons: readonly string[];
}

interface ProjectTrustScanFacts {
  readonly complete: boolean;
  readonly snapshots: ReadonlyMap<string, ScopeProjectTrustSnapshot>;
  readonly reasons: readonly string[];
}

function validateReadResult(value: RunExperienceReadResult): RunExperienceReadResult {
  if (!isRecord(value) || !Array.isArray(value.records) ||
    !Number.isSafeInteger(value.loadedRecords) || value.loadedRecords < 0 ||
    !Number.isSafeInteger(value.unsupportedSchema) || value.unsupportedSchema < 0 ||
    !Number.isSafeInteger(value.invalid) || value.invalid < 0) {
    throw new Error("Experience reader returned an invalid read result.");
  }
  return value;
}

function matchingSelection(
  experience: RunExperience,
  source: StrategyTrustScopeSourceStrategyV1,
): boolean {
  const snapshot = experience.policy.finalSnapshot;
  if (snapshot === null) return false;
  const selections = source.kind === "approach" ? [snapshot.approach] : snapshot.modifiers;
  return selections.some((selection) =>
    strategySelectionId(selection) === source.strategyId &&
    selection.kind === source.kind &&
    strategySelectionRevisionIdentity(selection) === source.revisionIdentity &&
    strategySelectionRevisionFingerprint(selection) === source.revisionFingerprint);
}

function matchingDigest(
  refs: readonly CrossProjectExperienceRefV1[],
): string {
  const hash = createHash("sha256");
  for (const ref of refs) {
    hash.update(`${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function prepareProjectExperience(
  projectId: string,
  rawRead: RunExperienceReadResult,
  source: StrategyTrustScopeSourceStrategyV1,
): PreparedProjectExperience {
  const read = validateReadResult(rawRead);
  const reasons: string[] = [];
  if (read.invalid > 0) {
    reasons.push(`project ${shortIdentity(projectId)} contains ${read.invalid} malformed live Experience record(s)`);
  }
  if (read.unsupportedSchema > 0) {
    reasons.push(`project ${shortIdentity(projectId)} contains ${read.unsupportedSchema} unsupported live Experience record(s)`);
  }
  const byRecordId = new Map<string, { readonly ref: CrossProjectExperienceRefV1; readonly experience: RunExperience }>();
  for (const raw of [...read.records].sort((left, right) => compareText(left.recordId, right.recordId))) {
    if (!isRecord(raw) || typeof raw.recordId !== "string" || !CANONICAL_RECORD_FILE.test(raw.recordId)) {
      reasons.push(`project ${shortIdentity(projectId)} returned a non-canonical Experience record identity`);
      continue;
    }
    const experience = parseRunExperience(raw.experience);
    if (experience === null) {
      reasons.push(`project ${shortIdentity(projectId)} returned a malformed schema-v4 Experience record`);
      continue;
    }
    let ref: CrossProjectExperienceRefV1;
    try {
      ref = createCrossProjectExperienceRef({
        projectId,
        recordId: raw.recordId,
        experience,
      });
    } catch (error) {
      reasons.push(`project ${shortIdentity(projectId)} returned an invalid Experience locator: ${errorMessage(error)}`);
      continue;
    }
    const previous = byRecordId.get(raw.recordId);
    if (previous !== undefined) {
      if (previous.ref.recordFingerprint !== ref.recordFingerprint) {
        reasons.push(`project ${shortIdentity(projectId)} returned contradictory Experience records for '${shortIdentity(raw.recordId)}'`);
      }
      // Exact duplicate qualified refs count once.
      continue;
    }
    byRecordId.set(raw.recordId, Object.freeze({ ref, experience }));
  }
  const matching = [...byRecordId.values()]
    .filter((record) => matchingSelection(record.experience, source))
    .sort((left, right) => compareCrossProjectExperienceRefs(left.ref, right.ref));
  const refs = matching.map((record) => record.ref);
  return Object.freeze({
    projectId,
    read,
    matching: Object.freeze(matching),
    matchingDigest: matchingDigest(refs),
    complete: reasons.length === 0 && read.loadedRecords >= byRecordId.size,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function createMutableInventory(projectId: string, sourceProjectId: string): MutableInventory {
  return {
    projectId,
    sourceProject: projectId === sourceProjectId,
    matchingRecordCount: 0,
    eligibleRunCount: 0,
    ineligibleRunCount: 0,
    detailRecords: [],
    verificationPassedCount: 0,
    completedDuringRunCount: 0,
    runsWithBlockers: 0,
    runsWithQuestions: 0,
    totalToolErrors: 0,
    totalDeniedCalls: 0,
  };
}

function scopeTrialRecordEligibility(
  projectId: string,
  sourceProjectId: string,
  source: StrategyTrustScopeSourceStrategyV1,
  sourceCandidate: StrategyDerivationCandidateV1 | null,
  ref: CrossProjectExperienceRefV1,
  experience: RunExperience,
  facts: {
    readonly refResolved: boolean;
    readonly sourceBindingValid: boolean;
    readonly sourceTrustValid: boolean;
    readonly globalStateComplete: boolean;
  },
): ScopeTrialEvidenceRecord {
  const evaluation = evaluateRunExperience({ recordId: ref.recordId, experience });
  const reasons: string[] = [];
  if (!facts.refResolved) reasons.push("qualified Experience reference did not freshly resolve");
  if (projectId === sourceProjectId) reasons.push("source project Experience is not cross-project Trial evidence");
  if (!evaluation.attributionEligible) reasons.push("RunEvaluation.attributionEligible is false");
  const snapshot = experience.policy.finalSnapshot;
  const selections = snapshot === null
    ? []
    : source.kind === "approach" ? [snapshot.approach] : snapshot.modifiers;
  const selection = selections.find((item) =>
    strategySelectionId(item) === source.strategyId &&
    item.kind === source.kind &&
    strategySelectionRevisionIdentity(item) === source.revisionIdentity &&
    strategySelectionRevisionFingerprint(item) === source.revisionFingerprint);
  if (selection === undefined) {
    reasons.push("final Policy does not contain the exact transferred Strategy identity in the correct role");
  } else {
    if (sourceCandidate === null || !sameSemantics((selection as StrategyRevisionSelection).semantics, sourceCandidate)) {
      reasons.push("recorded Strategy semantics do not exactly match the freshly resolved source Candidate proposal");
    }
    if (strategySelectionRevisionStatus(selection) !== "trial") {
      reasons.push("revisionStatusAtRun is not trial");
    }
  }
  if (
    evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0
  ) {
    reasons.push("final Policy has no continuous non-policy execution exposure");
  }
  if (!facts.sourceBindingValid) reasons.push("source Strategy binding is not freshly valid");
  if (!facts.sourceTrustValid) reasons.push("source project-local promoted trust is not freshly valid");
  if (!facts.globalStateComplete) reasons.push("global Scope binding state is incomplete or contradictory");
  return Object.freeze({
    ref,
    evaluation,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

function finalizeInventory(inventory: MutableInventory): ScopeProjectEvidenceInventory {
  const matchingRecordCount = inventory.matchingRecordCount;
  const eligibleRunCount = inventory.eligibleRunCount;
  return Object.freeze({
    projectId: inventory.projectId,
    sourceProject: inventory.sourceProject,
    matchingRecordCount,
    eligibleRunCount,
    ineligibleRunCount: inventory.ineligibleRunCount,
    detailRecords: Object.freeze([...inventory.detailRecords]),
    omittedDetailRecordCount: Math.max(0, matchingRecordCount - inventory.detailRecords.length),
    outcomes: Object.freeze({
      verificationPassedCount: inventory.verificationPassedCount,
      verificationNotPassedCount: Math.max(0, matchingRecordCount - inventory.verificationPassedCount),
      completedDuringRunCount: inventory.completedDuringRunCount,
      notCompletedDuringRunCount: Math.max(0, matchingRecordCount - inventory.completedDuringRunCount),
      runsWithBlockers: inventory.runsWithBlockers,
      runsWithQuestions: inventory.runsWithQuestions,
      totalToolErrors: inventory.totalToolErrors,
      totalDeniedCalls: inventory.totalDeniedCalls,
    }),
  });
}

async function deriveGlobalReviewFacts(
  candidate: StrategyTrustScopeCandidateV1,
  candidateReader: StrategyTrustScopeCandidateReader,
  decisionReader: StrategyTrustScopeDecisionReader,
  sourceResolver: StrategyTrustScopeSourceResolver,
): Promise<GlobalReviewFacts> {
  const reasons: string[] = [];
  let artifacts: GlobalReviewFacts["artifacts"] = null;
  try {
    artifacts = await readScopeTrialGlobalArtifacts(candidateReader, decisionReader);
  } catch (error) {
    reasons.push(`global Scope artifacts could not be completely read: ${errorMessage(error)}`);
  }

  const globalCandidate = artifacts?.candidates.find((item) => item.candidateId === candidate.candidateId);
  const candidateInGlobalNamespace = globalCandidate !== undefined &&
    strategyTrustScopeCandidateFingerprint(globalCandidate) === strategyTrustScopeCandidateFingerprint(candidate) &&
    JSON.stringify(globalCandidate.sourceStrategy) === JSON.stringify(candidate.sourceStrategy);
  if (!candidateInGlobalNamespace) {
    reasons.push("Scope Candidate is not freshly present and exactly bound in the global Candidate namespace");
  }
  const terminalDecision = artifacts?.decisions.find((decision) => decision.candidateId === candidate.candidateId) ?? null;
  const candidateOpen = candidateInGlobalNamespace && terminalDecision === null;

  const promotedGlobalEntries: StrategyTrustScopeSourceStrategyV1[] = [];
  const promotedGlobalSourceAuthority: GlobalSourceAuthorityProjection[] = [];
  const globalIds = new Set<string>();
  if (artifacts !== null) {
    for (const decision of artifacts.decisions.filter((item) => item.decision === "promoted")) {
      const source = decision.sourceStrategy;
      try {
        const resolved = await sourceResolver.resolve(source);
        if (!sameSourceBinding(resolved.sourceStrategy, source)) {
          throw new Error("promoted Scope Decision source binding changed during resolution");
        }
        const resolutionFingerprint = sourceResolutionAuthorityFingerprint(resolved);
        if (globalIds.has(source.strategyId)) {
          throw new Error(`multiple valid user-global revisions own logical Strategy ID '${source.strategyId}'`);
        }
        globalIds.add(source.strategyId);
        promotedGlobalEntries.push(source);
        promotedGlobalSourceAuthority.push(Object.freeze({
          source: Object.freeze({ ...source }),
          resolutionFingerprint,
        }));
      } catch (error) {
        reasons.push(`promoted user-global Scope Decision for '${source.strategyId}' could not be freshly resolved: ${errorMessage(error)}`);
      }
    }
  }
  promotedGlobalEntries.sort((left, right) => compareText(sourceIdentityKey(left), sourceIdentityKey(right)));
  promotedGlobalSourceAuthority.sort((left, right) => compareText(sourceIdentityKey(left.source), sourceIdentityKey(right.source)));
  const globalStateComplete = artifacts !== null && reasons.length === 0;
  const sourceStrategyId = candidate.sourceStrategy.strategyId;
  const globalLogicalIdAvailable = globalStateComplete && !globalIds.has(sourceStrategyId);
  const userGlobalCapacityAvailable = globalStateComplete &&
    promotedGlobalEntries.length < MAX_USER_GLOBAL_DERIVED_STRATEGIES;
  const authorityFingerprint = fingerprintProjection({
    artifacts,
    candidateInGlobalNamespace,
    candidateOpen,
    terminalDecision,
    promotedGlobalEntries,
    promotedGlobalSourceAuthority,
    globalLogicalIdAvailable,
    userGlobalCapacityAvailable,
  });
  return Object.freeze({
    artifacts,
    globalStateComplete,
    globalStateReasons: Object.freeze([...new Set(reasons)]),
    candidateInGlobalNamespace,
    candidateOpen,
    terminalDecision,
    promotedGlobalEntries: Object.freeze(promotedGlobalEntries),
    promotedGlobalSourceAuthority: Object.freeze(promotedGlobalSourceAuthority),
    globalLogicalIdAvailable,
    userGlobalCapacityAvailable,
    authorityFingerprint,
  });
}

async function deriveSourceReviewFacts(
  candidate: StrategyTrustScopeCandidateV1,
  sourceResolver: StrategyTrustScopeSourceResolver,
): Promise<SourceReviewFacts> {
  const reasons: string[] = [];
  try {
    const resolved = await sourceResolver.resolve(candidate.sourceStrategy);
    const sourceCandidate = validateStrategyDerivationCandidateArtifact(
      resolved.candidate,
      candidate.sourceStrategy.revisionIdentity,
    );
    const resolvedFingerprint = strategyDerivationCandidateSemanticFingerprint(sourceCandidate);
    const sourceBindingValid = sameSourceBinding(resolved.sourceStrategy, candidate.sourceStrategy) &&
      sourceCandidate.projectId === candidate.sourceStrategy.sourceProjectId &&
      sourceCandidate.proposal.strategyId === candidate.sourceStrategy.strategyId &&
      sourceCandidate.proposal.kind === candidate.sourceStrategy.kind &&
      sourceCandidate.candidateId === candidate.sourceStrategy.revisionIdentity &&
      resolvedFingerprint === candidate.sourceStrategy.revisionFingerprint;
    if (!sourceBindingValid) {
      reasons.push("source Strategy identity or fingerprint does not match the freshly resolved Candidate");
    }
    const sourceTrustValid = sourceBindingValid &&
      resolved.decision.decision === "promoted" &&
      resolved.selection.revisionStatusAtRun === "promoted" &&
      strategySelectionId(resolved.selection) === sourceCandidate.proposal.strategyId &&
      resolved.selection.kind === sourceCandidate.proposal.kind &&
      strategySelectionRevisionIdentity(resolved.selection) === sourceCandidate.candidateId &&
      strategySelectionRevisionFingerprint(resolved.selection) === resolvedFingerprint &&
      sameSemantics((resolved.selection as StrategyRevisionSelection).semantics, sourceCandidate);
    if (!sourceTrustValid) reasons.push("source project-local promoted trust is not a valid exact Derived revision");
    const authorityFingerprint = sourceResolutionAuthorityFingerprint(resolved);
    return Object.freeze({
      resolved,
      sourceCandidate,
      sourceBindingValid,
      sourceTrustValid,
      authorityFingerprint,
      reasons: Object.freeze(reasons),
    });
  } catch (error) {
    reasons.push(`exact source Strategy resolution failed closed: ${errorMessage(error)}`);
    return Object.freeze({
      resolved: null,
      sourceCandidate: null,
      sourceBindingValid: false,
      sourceTrustValid: false,
      authorityFingerprint: null,
      reasons: Object.freeze(reasons),
    });
  }
}

function validateProjectIdList(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Experience project namespace reader returned an invalid collection.");
  const ids = value.map((projectId) => validateProjectId(projectId));
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error("Experience project namespace reader returned duplicate project IDs.");
  return Object.freeze([...unique].sort(compareText));
}

async function readProjectTrustSnapshots(
  projectIds: readonly string[],
  projectTrustReader: ScopeProjectTrustReader,
): Promise<ProjectTrustScanFacts> {
  const snapshots = new Map<string, ScopeProjectTrustSnapshot>();
  const reasons: string[] = [];
  let complete = true;
  for (const projectId of projectIds) {
    try {
      const snapshot = validateScopeProjectTrustSnapshot(
        await projectTrustReader.readProjectId(projectId),
        projectId,
      );
      snapshots.set(projectId, snapshot);
    } catch (error) {
      complete = false;
      reasons.push(`project ${shortIdentity(projectId)} fresh local trust scan failed: ${errorMessage(error)}`);
    }
  }
  return Object.freeze({
    complete,
    snapshots,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function sameProjectIdList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((projectId, index) => projectId === right[index]);
}

function sameProjectTrustSnapshot(
  left: ScopeProjectTrustSnapshot,
  right: ScopeProjectTrustSnapshot,
): boolean {
  return left.projectId === right.projectId &&
    left.promotedDerived.length === right.promotedDerived.length &&
    left.promotedDerived.every((entry, index) =>
      manifestEntryKey(entry) === manifestEntryKey(right.promotedDerived[index]!));
}

function sameProjectTrustProjection(
  projectIds: readonly string[],
  left: ReadonlyMap<string, ScopeProjectTrustSnapshot>,
  right: ReadonlyMap<string, ScopeProjectTrustSnapshot>,
): boolean {
  if (left.size !== right.size || left.size !== projectIds.length) return false;
  return projectIds.every((projectId) => {
    const leftSnapshot = left.get(projectId);
    const rightSnapshot = right.get(projectId);
    return leftSnapshot !== undefined && rightSnapshot !== undefined &&
      sameProjectTrustSnapshot(leftSnapshot, rightSnapshot);
  });
}

async function freshSelectedRefs(
  selectedRefs: readonly CrossProjectExperienceRefV1[],
  freshReads: ReadonlyMap<string, PreparedProjectExperience>,
  source: StrategyTrustScopeSourceStrategyV1,
  sourceCandidate: StrategyDerivationCandidateV1 | null,
  facts: Pick<Parameters<typeof scopeTrialRecordEligibility>[6], "sourceBindingValid" | "sourceTrustValid" | "globalStateComplete">,
): Promise<{ readonly valid: boolean; readonly reasons: readonly string[] }> {
  const reasons: string[] = [];
  for (const ref of selectedRefs) {
    const validated = validateCrossProjectExperienceRefArtifact(ref);
    const project = freshReads.get(validated.projectId);
    const record = project?.matching.find((item) => item.ref.recordId === validated.recordId);
    if (project === undefined || record === undefined || record.ref.recordFingerprint !== validated.recordFingerprint) {
      reasons.push(`selected evidence ref '${shortIdentity(validated.recordId)}' is missing or fingerprint-mismatched on fresh resolution`);
      continue;
    }
    const evidence = scopeTrialRecordEligibility(
      validated.projectId,
      source.sourceProjectId,
      source,
      sourceCandidate,
      record.ref,
      record.experience,
      { ...facts, refResolved: true },
    );
    if (!evidence.eligible) {
      reasons.push(`selected evidence ref '${shortIdentity(validated.recordId)}' is no longer eligible: ${evidence.reasons.join("; ")}`);
    }
  }
  return Object.freeze({
    valid: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

/**
 * Recompute the bounded read-only Scope Trial review from current authority.
 * No review result, evidence cache, Experience record, or trust artifact is
 * written by this projection.
 */
export async function deriveStrategyTrustScopeTrialReview(
  input: StrategyTrustScopeTrialReviewInput,
): Promise<StrategyTrustScopeTrialReview> {
  const candidate = validateStrategyTrustScopeCandidateArtifact(
    input.candidate,
    input.candidate.candidateId,
  );
  const candidateFingerprint = strategyTrustScopeCandidateFingerprint(candidate);
  const [globalFacts, sourceFacts] = await Promise.all([
    deriveGlobalReviewFacts(
      candidate,
      input.candidateReader,
      input.decisionReader,
      input.sourceResolver,
    ),
    deriveSourceReviewFacts(candidate, input.sourceResolver),
  ]);
  const reasons: string[] = [
    ...globalFacts.globalStateReasons,
    ...sourceFacts.reasons,
  ];

  let projectIds: readonly string[] = [];
  let evidenceScanComplete = true;
  let projectTrustScanComplete = true;
  try {
    projectIds = validateProjectIdList(await input.experienceReader.listProjectIds());
  } catch (error) {
    evidenceScanComplete = false;
    projectTrustScanComplete = false;
    reasons.push(`cross-project Experience namespace scan could not be completed: ${errorMessage(error)}`);
  }

  const firstReads = new Map<string, PreparedProjectExperience>();
  const trustSnapshots = new Map<string, ScopeProjectTrustSnapshot>();
  const inventories = new Map<string, MutableInventory>();
  const selectedFirstByProject = new Map<string, CrossProjectExperienceRefV1>();
  const selectedExtraRefs: CrossProjectExperienceRefV1[] = [];
  const source = candidate.sourceStrategy;
  for (const projectId of projectIds) {
    let read: RunExperienceReadResult;
    try {
      read = validateReadResult(await input.experienceReader.readProjectId(projectId));
    } catch (error) {
      evidenceScanComplete = false;
      reasons.push(`project ${shortIdentity(projectId)} Experience scan failed: ${errorMessage(error)}`);
      continue;
    }
    let prepared: PreparedProjectExperience;
    try {
      prepared = prepareProjectExperience(projectId, read, source);
    } catch (error) {
      evidenceScanComplete = false;
      reasons.push(`project ${shortIdentity(projectId)} Experience scan failed: ${errorMessage(error)}`);
      continue;
    }
    firstReads.set(projectId, prepared);
    if (!prepared.complete) {
      evidenceScanComplete = false;
      reasons.push(...prepared.reasons);
    }

    try {
      const trust = await input.projectTrustReader.readProjectId(projectId);
      trustSnapshots.set(projectId, validateScopeProjectTrustSnapshot(trust, projectId));
    } catch (error) {
      projectTrustScanComplete = false;
      reasons.push(`project ${shortIdentity(projectId)} local trust scan failed: ${errorMessage(error)}`);
    }

    const inventory = createMutableInventory(projectId, source.sourceProjectId);
    inventories.set(projectId, inventory);
    for (const matching of prepared.matching) {
      const evidence = scopeTrialRecordEligibility(
        projectId,
        source.sourceProjectId,
        source,
        sourceFacts.sourceCandidate,
        matching.ref,
        matching.experience,
        {
          refResolved: true,
          sourceBindingValid: sourceFacts.sourceBindingValid,
          sourceTrustValid: sourceFacts.sourceTrustValid,
          globalStateComplete: globalFacts.globalStateComplete,
        },
      );
      inventory.matchingRecordCount += 1;
      if (evidence.eligible) {
        inventory.eligibleRunCount += 1;
        if (!selectedFirstByProject.has(projectId)) {
          selectedFirstByProject.set(projectId, evidence.ref);
        } else if (selectedExtraRefs.length < MAX_CROSS_PROJECT_EXPERIENCE_REFS) {
          selectedExtraRefs.push(evidence.ref);
        }
      } else {
        inventory.ineligibleRunCount += 1;
      }
      if (inventory.detailRecords.length < MAX_SCOPE_REVIEW_RECORD_DETAILS) {
        inventory.detailRecords.push(evidence);
      }
      inventory.verificationPassedCount += evidence.evaluation.outcome.verificationPassed ? 1 : 0;
      inventory.completedDuringRunCount += evidence.evaluation.outcome.completedDuringRun ? 1 : 0;
      inventory.runsWithBlockers += evidence.evaluation.outcome.hasBlockers ? 1 : 0;
      inventory.runsWithQuestions += evidence.evaluation.outcome.hasQuestions ? 1 : 0;
      inventory.totalToolErrors += evidence.evaluation.execution.toolErrors;
      inventory.totalDeniedCalls += evidence.evaluation.execution.deniedCalls;
    }
  }

  const selectedProjectRefs = [...selectedFirstByProject.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, ref]) => ref);
  const selectedRefs = selectedProjectRefs.length <= MAX_CROSS_PROJECT_EXPERIENCE_REFS
    ? [...selectedProjectRefs, ...selectedExtraRefs
      .sort(compareCrossProjectExperienceRefs)
      .filter((ref) => !selectedProjectRefs.some((selected) => compareCrossProjectExperienceRefs(selected, ref) === 0))]
        .slice(0, MAX_CROSS_PROJECT_EXPERIENCE_REFS)
    : selectedProjectRefs.slice(0, MAX_CROSS_PROJECT_EXPERIENCE_REFS);
  const selectedEvidenceRefs = Object.freeze(
    [...selectedRefs].sort(compareCrossProjectExperienceRefs),
  );

  // Re-read every enumerated namespace. This makes a changing project set or
  // changing matching-record snapshot an explicit incomplete review instead
  // of silently treating a moving read as complete evidence.
  const freshReads = new Map<string, PreparedProjectExperience>();
  try {
    const secondProjectIds = validateProjectIdList(await input.experienceReader.listProjectIds());
    if (JSON.stringify(secondProjectIds) !== JSON.stringify(projectIds)) {
      evidenceScanComplete = false;
      reasons.push("cross-project project namespace set changed during the deterministic scan");
    }
    for (const projectId of secondProjectIds) {
      try {
        const prepared = prepareProjectExperience(
          projectId,
          await input.experienceReader.readProjectId(projectId),
          source,
        );
        freshReads.set(projectId, prepared);
        const first = firstReads.get(projectId);
        if (first === undefined || first.matching.length !== prepared.matching.length ||
          first.matchingDigest !== prepared.matchingDigest ||
          !prepared.complete) {
          evidenceScanComplete = false;
          reasons.push(`project ${shortIdentity(projectId)} matching Experience snapshot changed or is incomplete during review`);
        }
      } catch (error) {
        evidenceScanComplete = false;
        reasons.push(`project ${shortIdentity(projectId)} fresh Experience resolution failed: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    evidenceScanComplete = false;
    reasons.push(`cross-project fresh namespace scan could not be completed: ${errorMessage(error)}`);
  }

  const selectedRefResolution = await freshSelectedRefs(
    selectedEvidenceRefs,
    freshReads,
    source,
    sourceFacts.sourceCandidate,
    {
      sourceBindingValid: sourceFacts.sourceBindingValid,
      sourceTrustValid: sourceFacts.sourceTrustValid,
      globalStateComplete: globalFacts.globalStateComplete,
    },
  );
  if (!selectedRefResolution.valid) reasons.push(...selectedRefResolution.reasons);

  // Final authority pass: the Experience scan remains lock-free, but no
  // eligibility gate may combine its initial global/source/trust facts with a
  // later authority state. These reads are deliberately immediately before
  // the synchronous gate assembly.
  const [finalGlobalFacts, finalSourceFacts] = await Promise.all([
    deriveGlobalReviewFacts(
      candidate,
      input.candidateReader,
      input.decisionReader,
      input.sourceResolver,
    ),
    deriveSourceReviewFacts(candidate, input.sourceResolver),
  ]);

  let finalProjectIds: readonly string[] = [];
  let finalProjectTrustFacts: ProjectTrustScanFacts = {
    complete: false,
    snapshots: new Map(),
    reasons: Object.freeze([]),
  };
  try {
    finalProjectIds = validateProjectIdList(await input.experienceReader.listProjectIds());
    finalProjectTrustFacts = await readProjectTrustSnapshots(
      finalProjectIds,
      input.projectTrustReader,
    );
  } catch (error) {
    reasons.push(`final project-local trust namespace scan could not be completed: ${errorMessage(error)}`);
  }

  const globalAuthorityFresh = globalFacts.globalStateComplete === finalGlobalFacts.globalStateComplete &&
    globalFacts.authorityFingerprint === finalGlobalFacts.authorityFingerprint;
  if (!globalAuthorityFresh) {
    reasons.push("global Scope Candidate/Decision authority or promoted source resolution changed during review; the read snapshot is not coherent");
  }
  if (!finalGlobalFacts.globalStateComplete) reasons.push(...finalGlobalFacts.globalStateReasons);

  const sourceAuthorityFresh = sourceFacts.sourceBindingValid === finalSourceFacts.sourceBindingValid &&
    sourceFacts.sourceTrustValid === finalSourceFacts.sourceTrustValid &&
    sourceFacts.authorityFingerprint === finalSourceFacts.authorityFingerprint;
  if (!sourceAuthorityFresh) {
    reasons.push("source Strategy binding or project-local promoted trust changed during review; the read snapshot is not coherent");
  }
  if (!finalSourceFacts.sourceBindingValid || !finalSourceFacts.sourceTrustValid) {
    reasons.push(...finalSourceFacts.reasons);
  }

  const projectTrustAuthorityFresh = projectTrustScanComplete &&
    finalProjectTrustFacts.complete &&
    sameProjectIdList(projectIds, finalProjectIds) &&
    sameProjectTrustProjection(projectIds, trustSnapshots, finalProjectTrustFacts.snapshots);
  if (!projectTrustAuthorityFresh) {
    reasons.push("project-local trust namespace set or promoted Derived identity projection changed during review; the collision scan is not coherent");
    reasons.push(...finalProjectTrustFacts.reasons);
  }
  const authoritySnapshotFresh = globalAuthorityFresh &&
    sourceAuthorityFresh &&
    projectTrustAuthorityFresh;

  projectTrustScanComplete = projectTrustAuthorityFresh;

  const globalStateComplete = globalFacts.globalStateComplete &&
    finalGlobalFacts.globalStateComplete &&
    globalAuthorityFresh;
  const scopeCandidateOpen = finalGlobalFacts.candidateOpen;
  const noTerminalScopeDecision = finalGlobalFacts.terminalDecision === null;
  const sourceBindingValid = sourceFacts.sourceBindingValid &&
    finalSourceFacts.sourceBindingValid &&
    sourceAuthorityFresh;
  const sourceTrustValid = sourceFacts.sourceTrustValid &&
    finalSourceFacts.sourceTrustValid &&
    sourceAuthorityFresh;
  const globalLogicalIdAvailable = finalGlobalFacts.globalLogicalIdAvailable;
  const userGlobalCapacityAvailable = finalGlobalFacts.userGlobalCapacityAvailable;
  const promotedGlobalSources = finalGlobalFacts.promotedGlobalEntries;
  let localConflictFree = projectTrustScanComplete && projectTrustAuthorityFresh;
  for (const snapshot of trustSnapshots.values()) {
    for (const entry of snapshot.promotedDerived) {
      if (entry.strategyId !== source.strategyId) continue;
      if (!sameTrustEntry(entry, source)) {
        localConflictFree = false;
        reasons.push(`project ${shortIdentity(snapshot.projectId)} has a conflicting local revision for logical Strategy ID '${source.strategyId}'`);
      }
    }
  }
  if (promotedGlobalSources.some((entry) => entry.strategyId === source.strategyId)) {
    // The current Candidate is not available as a new user-global identity
    // once a valid global revision already owns its logical ID.
    reasons.push(`user-global logical Strategy ID '${source.strategyId}' is already owned by a trusted revision`);
  }
  if (!localConflictFree) reasons.push("project-local trust conflict or incomplete local trust state prevents a deterministic collision scan");
  if (!finalGlobalFacts.userGlobalCapacityAvailable && finalGlobalFacts.globalStateComplete) {
    reasons.push(`user-global Derived Strategy capacity is full at ${MAX_USER_GLOBAL_DERIVED_STRATEGIES}`);
  }
  if (!evidenceScanComplete || !projectTrustScanComplete || !globalStateComplete || !authoritySnapshotFresh) {
    reasons.push("evidence completeness cannot be established from a complete deterministic authority scan");
  }

  const inventoriesFinal = Object.freeze([...inventories.values()]
    .sort((left, right) => compareText(left.projectId, right.projectId))
    .map(finalizeInventory));
  const matchingRecordCount = inventoriesFinal.reduce((total, inventory) => total + inventory.matchingRecordCount, 0);
  const eligibleTrialRunCount = inventoriesFinal.reduce((total, inventory) => total + inventory.eligibleRunCount, 0);
  const ineligibleMatchingRunCount = inventoriesFinal.reduce((total, inventory) => total + inventory.ineligibleRunCount, 0);
  const eligibleTargetProjectIds = Object.freeze(inventoriesFinal
    .filter((inventory) => !inventory.sourceProject && inventory.eligibleRunCount > 0)
    .map((inventory) => inventory.projectId));
  const distinctEligibleTargetProjectCount = eligibleTargetProjectIds.length;
  if (eligibleTrialRunCount < 2) reasons.push("at least 2 eligible cross-project Trial Runs are required");
  if (distinctEligibleTargetProjectCount < 2) reasons.push("at least 2 distinct non-source target projects are required");

  const scopeCandidateValid = true;
  const proposedTrustScopeValid = candidate.currentTrustScope === "project" &&
    candidate.proposedTrustScope === "user-global";
  const noSeedLogicalIdCollision = !SEED_STRATEGIES.some((seed) => seed.id === source.strategyId);
  const evidenceCompletenessValid = evidenceScanComplete &&
    projectTrustScanComplete &&
    globalStateComplete &&
    authoritySnapshotFresh;
  const selectedEvidenceRefsValid = selectedRefResolution.valid && authoritySnapshotFresh;
  if (selectedRefResolution.valid && !authoritySnapshotFresh) {
    reasons.push("selected evidence refs were validated against an authority snapshot that changed during review");
  }
  const reasonsUnique = [...new Set(reasons)];
  if (!scopeCandidateOpen) reasonsUnique.push(
    noTerminalScopeDecision
      ? "Scope Candidate is not available as a fresh open global hypothesis"
      : "a terminal Scope Decision already exists for this Candidate",
  );
  if (!noSeedLogicalIdCollision) reasonsUnique.push("proposed logical Strategy ID collides with an immutable Seed");
  if (!sourceBindingValid) reasonsUnique.push("source binding is invalid or stale");
  if (!sourceTrustValid) reasonsUnique.push("source Strategy trust is invalid or stale");
  if (!globalLogicalIdAvailable) reasonsUnique.push("current user-global logical Strategy ID is unavailable");
  if (!userGlobalCapacityAvailable) reasonsUnique.push("user-global Derived Strategy capacity is unavailable");
  if (!selectedEvidenceRefsValid) reasonsUnique.push("the selected evidence reference set is not fully resolvable and eligible");
  const promotionReasons = Object.freeze([...new Set(reasonsUnique)]);
  const promotionEligibility: ScopePromotionEligibility = Object.freeze({
    eligible: scopeCandidateValid && scopeCandidateOpen && noTerminalScopeDecision &&
      sourceBindingValid && sourceTrustValid && proposedTrustScopeValid &&
      noSeedLogicalIdCollision && globalLogicalIdAvailable && localConflictFree &&
      userGlobalCapacityAvailable && evidenceCompletenessValid && selectedEvidenceRefsValid &&
      eligibleTrialRunCount >= 2 && distinctEligibleTargetProjectCount >= 2,
    requiredEligibleTrialRunCount: 2,
    eligibleTrialRunCount,
    requiredDistinctTargetProjectCount: 2,
    distinctEligibleTargetProjectCount,
    scopeCandidateValid,
    scopeCandidateOpen,
    noTerminalScopeDecision,
    sourceBindingValid,
    sourceStrategyTrustValid: sourceTrustValid,
    proposedTrustScopeValid,
    noSeedLogicalIdCollision,
    globalLogicalIdAvailable,
    projectLocalConflictFree: localConflictFree,
    userGlobalCapacityAvailable,
    evidenceCompletenessValid,
    selectedEvidenceRefsValid,
    retainedEligibleRefCount: selectedEvidenceRefs.length,
    omittedEligibleRefCount: Math.max(0, eligibleTrialRunCount - selectedEvidenceRefs.length),
    reasons: promotionReasons,
  });

  const currentProjectIsSource = input.currentProjectRoot === undefined || input.currentProjectRoot === null
    ? null
    : getProjectId(input.currentProjectRoot) === source.sourceProjectId;
  return Object.freeze({
    candidate,
    candidateFingerprint,
    sourceCandidate: sourceFacts.sourceCandidate,
    currentProjectIsSource,
    terminalDecision: finalGlobalFacts.terminalDecision,
    inventories: inventoriesFinal,
    matchingRecordCount,
    ineligibleMatchingRunCount,
    eligibleTrialRunCount,
    distinctEligibleTargetProjectCount,
    eligibleTargetProjectIds,
    selectedEvidenceRefs,
    omittedEligibleRefCount: Math.max(0, eligibleTrialRunCount - selectedEvidenceRefs.length),
    sourceTrustValid,
    sourceBindingValid,
    evidenceScanComplete,
    globalStateComplete,
    projectTrustScanComplete,
    promotionEligibility,
    reasons: promotionReasons,
  });
}

export const deriveScopeTrialReview = deriveStrategyTrustScopeTrialReview;
export const buildStrategyTrustScopeTrialReview = deriveStrategyTrustScopeTrialReview;
export const deriveScopePromotionEligibility = (
  review: StrategyTrustScopeTrialReview,
): ScopePromotionEligibility => review.promotionEligibility;

function formatCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "0";
}

function formatRecordOutcome(record: ScopeTrialEvidenceRecord): string {
  const evaluation = record.evaluation;
  const facts = [
    evaluation.outcome.verificationPassed ? "Verification passed" : "Verification not passed",
    evaluation.outcome.completedDuringRun ? "Task completed during Run" : "Task not completed during Run",
  ];
  if (evaluation.outcome.hasBlockers) facts.push("blockers present");
  if (evaluation.outcome.hasQuestions) facts.push("questions present");
  if (evaluation.execution.toolErrors > 0) facts.push(`tool errors ${evaluation.execution.toolErrors}`);
  if (evaluation.execution.deniedCalls > 0) facts.push(`denied calls ${evaluation.execution.deniedCalls}`);
  if (!record.eligible) facts.push(`ineligible: ${record.reasons.join("; ")}`);
  else facts.push("eligible exact Scope Trial Run");
  return facts.map(boundedText).join(" · ");
}

function formatScopeReviewProject(
  inventory: ScopeProjectEvidenceInventory,
): string[] {
  const lines = [
    `  ${shortIdentity(inventory.projectId)}${inventory.sourceProject ? " (source project; excluded from target diversity)" : ""}`,
    `    Matching Scope Trial records: ${formatCount(inventory.matchingRecordCount)}`,
    `    Eligible Runs: ${formatCount(inventory.eligibleRunCount)}`,
    `    Ineligible matching Runs: ${formatCount(inventory.ineligibleRunCount)}`,
    `    Verification passed: ${formatCount(inventory.outcomes.verificationPassedCount)} · not passed: ${formatCount(inventory.outcomes.verificationNotPassedCount)}`,
    `    Task completed during Run: ${formatCount(inventory.outcomes.completedDuringRunCount)} · not completed: ${formatCount(inventory.outcomes.notCompletedDuringRunCount)}`,
    `    Blockers: ${formatCount(inventory.outcomes.runsWithBlockers)} · questions: ${formatCount(inventory.outcomes.runsWithQuestions)} · tool errors: ${formatCount(inventory.outcomes.totalToolErrors)} · denied calls: ${formatCount(inventory.outcomes.totalDeniedCalls)}`,
    "    Bounded relevant outcomes:",
  ];
  if (inventory.detailRecords.length === 0) lines.push("      - none");
  else {
    for (const record of inventory.detailRecords) {
      lines.push(`      - ${shortIdentity(record.ref.recordId)}: ${formatRecordOutcome(record)}`);
    }
  }
  if (inventory.omittedDetailRecordCount > 0) {
    lines.push(`      ... ${inventory.omittedDetailRecordCount} matching detail record(s) omitted by the Human presentation bound`);
  }
  return lines;
}

/** Format a bounded, meaning-first, non-causal Scope Trust review. */
export function formatStrategyTrustScopeTrialReview(
  review: StrategyTrustScopeTrialReview,
): string {
  const candidate = review.candidate;
  const source = candidate.sourceStrategy;
  const eligibility = review.promotionEligibility;
  const lines = [
    "Strategy Trust Transfer Review",
    "",
    "Strategy",
    `  Logical ID: ${boundedText(source.strategyId)}`,
    `  Kind: ${source.kind}`,
    `  Revision identity: ${shortIdentity(source.revisionIdentity)}`,
    `  Source project: ${shortIdentity(source.sourceProjectId)}${review.currentProjectIsSource === true ? " (current project context)" : ""}`,
    ...(review.sourceCandidate === null ? [] : [
      `  Summary: ${boundedText(review.sourceCandidate.proposal.summary)}`,
    ]),
    `  Scope Candidate: ${shortIdentity(candidate.candidateId)}`,
    "",
    "Evidence",
    `  Matching Scope Trial records: ${formatCount(review.matchingRecordCount)}`,
    `  Eligible Runs: ${formatCount(review.eligibleTrialRunCount)}`,
    `  Ineligible matching Runs: ${formatCount(review.ineligibleMatchingRunCount)}`,
    `  Distinct eligible target projects: ${formatCount(review.distinctEligibleTargetProjectCount)}`,
    `  Retained eligible evidence refs: ${formatCount(review.selectedEvidenceRefs.length)} / ${formatCount(review.eligibleTrialRunCount)}`,
  ];
  if (review.omittedEligibleRefCount > 0) {
    lines.push(`  ${review.omittedEligibleRefCount} eligible evidence ref(s) omitted from the retained set bound of ${MAX_CROSS_PROJECT_EXPERIENCE_REFS}`);
  }
  lines.push("", "Per target project:");
  const visibleInventories = review.inventories.slice(0, MAX_SCOPE_REVIEW_PROJECT_DETAILS);
  if (visibleInventories.length === 0) lines.push("  - none");
  else for (const inventory of visibleInventories) lines.push(...formatScopeReviewProject(inventory));
  if (review.inventories.length > visibleInventories.length) {
    lines.push(`  ... ${review.inventories.length - visibleInventories.length} project detail row(s) omitted by the Human presentation bound`);
  }

  lines.push(
    "",
    "Eligibility gates",
    `  Eligible Trial Runs: ${formatCount(eligibility.eligibleTrialRunCount)} / ${eligibility.requiredEligibleTrialRunCount}`,
    `  Distinct target projects: ${formatCount(eligibility.distinctEligibleTargetProjectCount)} / ${eligibility.requiredDistinctTargetProjectCount}`,
    `  Source Strategy trust: ${eligibility.sourceStrategyTrustValid ? "valid" : "invalid"}`,
    `  Source binding: ${eligibility.sourceBindingValid ? "valid" : "invalid"}`,
    `  Evidence completeness: ${eligibility.evidenceCompletenessValid ? "valid" : "invalid"}`,
    `  Global logical-ID availability: ${eligibility.globalLogicalIdAvailable ? "valid" : "conflict"}`,
    `  User-global capacity: ${eligibility.userGlobalCapacityAvailable ? "available" : "full"}`,
    `  Terminal Scope Decision: ${eligibility.noTerminalScopeDecision ? "absent" : "present"}`,
    `  Selected evidence refs: ${eligibility.selectedEvidenceRefsValid ? "valid" : "invalid"}`,
    "",
    `Promotion Eligibility: ${eligibility.eligible ? "eligible for Human review" : "not eligible"}`,
    "Promotion Eligibility means only that enough auditable cross-environment evidence exists for Human trust review.",
  );
  if (eligibility.reasons.length > 0) {
    lines.push("Reasons");
    const visibleReasons = eligibility.reasons.slice(0, MAX_SCOPE_REVIEW_REASON_DETAILS);
    for (const reason of visibleReasons) lines.push(`  - ${boundedText(reason)}`);
    if (eligibility.reasons.length > visibleReasons.length) {
      lines.push(`  ... ${eligibility.reasons.length - visibleReasons.length} deterministic reason(s) omitted by the Human presentation bound`);
    }
  }
  lines.push(
    "",
    "Negative factual outcomes remain visible; no score, ranking, reward, usefulness, superiority, universality, or causal claim is derived.",
    "This read-only review writes no Scope Decision, trust projection, Experience record, State, or runtime lease.",
  );
  return lines.join("\n");
}

export const formatScopeTrialReview = formatStrategyTrustScopeTrialReview;
export const formatStrategyTrustScopeReview = formatStrategyTrustScopeTrialReview;

export interface ScopeTrialReviewCommandProjection {
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export const SCOPE_TRIAL_REVIEW_COMMAND_PREFIX = "scope:";

export function scopeTrialReviewCommandValue(candidateId: string): string {
  if (!isCanonicalStrategyTrustScopeCandidateId(candidateId)) {
    throw new Error("Scope Trial review Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return `${SCOPE_TRIAL_REVIEW_COMMAND_PREFIX}${candidateId}`;
}

export function parseScopeTrialReviewCommandValue(value: string): string | null {
  if (!value.startsWith(SCOPE_TRIAL_REVIEW_COMMAND_PREFIX)) return null;
  const candidateId = value.slice(SCOPE_TRIAL_REVIEW_COMMAND_PREFIX.length);
  if (!isCanonicalStrategyTrustScopeCandidateId(candidateId)) {
    throw new Error("Scope Trial review Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return candidateId;
}

/** Build bounded completion options without making completion authoritative. */
export async function buildScopeTrialReviewCommandProjection(input: {
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
}): Promise<ScopeTrialReviewCommandProjection> {
  const artifacts = await readScopeTrialGlobalArtifacts(
    input.candidateReader,
    input.decisionReader,
  );
  const decisionIds = new Set(artifacts.decisions.map((decision) => decision.candidateId));
  const entries = [...artifacts.candidates]
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((candidate) => {
      const label = `${candidate.sourceStrategy.strategyId} (${candidate.sourceStrategy.kind}) · source ${shortIdentity(candidate.sourceStrategy.sourceProjectId)} · revision ${shortIdentity(candidate.sourceStrategy.revisionIdentity)} · Scope Trust review${decisionIds.has(candidate.candidateId) ? " · terminal" : ""}`;
      return {
        value: scopeTrialReviewCommandValue(candidate.candidateId),
        label: label.length <= 160 ? label : `${label.slice(0, 159)}…`,
      };
    });
  return Object.freeze({ options: Object.freeze(entries) });
}

export function filterScopeTrialReviewCommandOptions(
  projection: ScopeTrialReviewCommandProjection,
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

// Keep the exact-field constant observable to tests and future Slice D code
// without introducing a second identity schema.
export const SCOPE_PROJECT_TRUST_ENTRY_FIELDS = DERIVATION_TRUST_FIELDS;
