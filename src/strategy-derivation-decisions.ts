import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isStrategyRevisionSelector,
  createStrategyRevisionSelection,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";
import {
  isCanonicalStrategyDerivationCandidateId,
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  validateStrategyDerivationCandidateBinding,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import type {
  StrategyCandidateReader,
} from "./strategy-candidates.ts";
import {
  SEED_STRATEGIES,
  type SeedStrategyKind,
} from "./strategies.ts";
import { getProjectId } from "./store.ts";

export const STRATEGY_DERIVATION_DECISION_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME = "strategy-derivation-decisions";
export const MAX_DERIVATION_DECISION_SOURCE_RECORD_IDS = 8;
export const MIN_DERIVATION_DECISION_SOURCE_RECORD_IDS = 3;
export const MAX_DERIVATION_DECISION_TRIAL_RECORD_IDS = 1024;
export const MAX_DERIVATION_DECISION_RECORD_ID_LENGTH = 128;
export const MAX_DERIVATION_DECISION_TIMESTAMP_LENGTH = 64;
export const MAX_DERIVATION_DECISION_STRATEGY_ID_LENGTH = 64;
export const MAX_PROMOTED_DERIVED_STRATEGIES = 8;

const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const LOGICAL_STRATEGY_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CANONICAL_DECISION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const DECISION_FIELDS = [
  "schemaVersion",
  "candidateId",
  "candidateFingerprint",
  "decidedAt",
  "projectId",
  "basePortfolioFingerprint",
  "strategy",
  "decision",
  "evidence",
] as const;
const STRATEGY_FIELDS = ["strategyId", "kind"] as const;
const EVIDENCE_FIELDS = ["sourceRecordIds", "trialRecordIds"] as const;

export type StrategyDerivationDecisionTerminal = "promoted" | "rejected";

/** Immutable Human-owned terminal trust decision for one Derivation Candidate. */
export interface StrategyDerivationDecisionV1 {
  readonly schemaVersion: typeof STRATEGY_DERIVATION_DECISION_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly decidedAt: string;
  readonly projectId: string;
  readonly basePortfolioFingerprint: string;
  readonly strategy: {
    readonly strategyId: string;
    readonly kind: SeedStrategyKind;
  };
  readonly decision: StrategyDerivationDecisionTerminal;
  readonly evidence: {
    readonly sourceRecordIds: readonly string[];
    readonly trialRecordIds: readonly string[];
  };
}

export type StrategyDerivationDecision = StrategyDerivationDecisionV1;

export interface CreateStrategyDerivationDecisionInput {
  readonly candidate: StrategyDerivationCandidateV1;
  readonly decision: StrategyDerivationDecisionTerminal;
  readonly trialRecordIds: readonly string[];
  /** Optional test seam; the runtime owns the decision timestamp. */
  readonly decidedAt?: string;
}

export interface StrategyDerivationDecisionReader {
  read(projectRoot: string, candidateId: string): Promise<StrategyDerivationDecisionV1 | null>;
  readAll(projectRoot: string): Promise<readonly StrategyDerivationDecisionV1[]>;
}

export interface StrategyDerivationDecisionStore extends StrategyDerivationDecisionReader {
  save(projectRoot: string, decision: StrategyDerivationDecisionV1): Promise<void>;
}

export interface FileStrategyDerivationDecisionStoreOptions {
  baseDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length &&
    actual.every((field, index) => field === expected[index]);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): never {
  throw new Error(`Invalid Strategy Derivation Decision: ${message}`);
}

function invalidBinding(message: string): never {
  throw new Error(`Invalid Strategy Derivation Decision binding: ${message}`);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    return invalid(`${field} must be at most ${maxLength} characters.`);
  }
  return value;
}

function validateRecordIds(
  value: unknown,
  field: string,
  minItems: number,
  maxItems: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    return invalid(`${field} must contain between ${minItems} and ${maxItems} items.`);
  }
  const ids = value.map((id, index) =>
    boundedString(id, `${field}[${index}]`, MAX_DERIVATION_DECISION_RECORD_ID_LENGTH));
  if (new Set(ids).size !== ids.length) return invalid(`${field} must be unique.`);
  return Object.freeze(ids);
}

function validateTimestamp(value: unknown): string {
  const timestamp = boundedString(value, "decidedAt", MAX_DERIVATION_DECISION_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(timestamp))) return invalid("decidedAt must be a valid timestamp.");
  return timestamp;
}

/** Validate one immutable schema-v1 Derivation Decision without repair. */
export function validateStrategyDerivationDecisionArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyDerivationDecisionV1 {
  if (!isRecord(value) || !hasExactFields(value, DECISION_FIELDS)) {
    return invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_DERIVATION_DECISION_SCHEMA_VERSION) {
    return invalid("schemaVersion must be 1.");
  }
  if (typeof value.candidateId !== "string" || !isCanonicalStrategyDerivationCandidateId(value.candidateId)) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  if (requestedCandidateId !== undefined && value.candidateId !== requestedCandidateId) {
    return invalid("requested Candidate ID does not match artifact candidateId.");
  }
  if (typeof value.candidateFingerprint !== "string" || !CANONICAL_FINGERPRINT.test(value.candidateFingerprint)) {
    return invalid("candidateFingerprint must be a lowercase SHA-256 fingerprint.");
  }
  const decidedAt = validateTimestamp(value.decidedAt);
  if (typeof value.projectId !== "string" || !CANONICAL_PROJECT_ID.test(value.projectId)) {
    return invalid("projectId must be a canonical project identity.");
  }
  if (typeof value.basePortfolioFingerprint !== "string" || !CANONICAL_FINGERPRINT.test(value.basePortfolioFingerprint)) {
    return invalid("basePortfolioFingerprint must be a lowercase SHA-256 fingerprint.");
  }
  if (!isRecord(value.strategy) || !hasExactFields(value.strategy, STRATEGY_FIELDS)) {
    return invalid("strategy fields are invalid.");
  }
  const strategy = value.strategy;
  if (
    typeof strategy.strategyId !== "string" ||
    strategy.strategyId.length < 1 ||
    strategy.strategyId.length > MAX_DERIVATION_DECISION_STRATEGY_ID_LENGTH ||
    strategy.strategyId.trim() !== strategy.strategyId ||
    !LOGICAL_STRATEGY_ID.test(strategy.strategyId) ||
    (strategy.kind !== "approach" && strategy.kind !== "modifier")
  ) return invalid("strategy identity is invalid.");
  if (SEED_STRATEGIES.some((seed) => seed.id === strategy.strategyId)) {
    return invalid("strategy.strategyId must be a new logical Strategy identity.");
  }
  if (value.decision !== "promoted" && value.decision !== "rejected") {
    return invalid("decision must be promoted or rejected.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    return invalid("evidence fields are invalid.");
  }
  const sourceRecordIds = validateRecordIds(
    value.evidence.sourceRecordIds,
    "evidence.sourceRecordIds",
    MIN_DERIVATION_DECISION_SOURCE_RECORD_IDS,
    MAX_DERIVATION_DECISION_SOURCE_RECORD_IDS,
  );
  const trialRecordIds = validateRecordIds(
    value.evidence.trialRecordIds,
    "evidence.trialRecordIds",
    value.decision === "promoted" ? 2 : 0,
    MAX_DERIVATION_DECISION_TRIAL_RECORD_IDS,
  );
  return Object.freeze({
    schemaVersion: 1,
    candidateId: value.candidateId,
    candidateFingerprint: value.candidateFingerprint,
    decidedAt,
    projectId: value.projectId,
    basePortfolioFingerprint: value.basePortfolioFingerprint,
    strategy: Object.freeze({
      strategyId: strategy.strategyId,
      kind: strategy.kind,
    }),
    decision: value.decision,
    evidence: Object.freeze({ sourceRecordIds, trialRecordIds }),
  });
}

export const parseStrategyDerivationDecision = validateStrategyDerivationDecisionArtifact;

/** Validate every immutable Candidate, project, portfolio, identity, and source binding. */
export function validateStrategyDerivationDecisionBinding(
  decision: StrategyDerivationDecisionV1,
  candidate: StrategyDerivationCandidateV1,
): StrategyDerivationDecisionV1 {
  let validatedDecision: StrategyDerivationDecisionV1;
  try {
    validatedDecision = validateStrategyDerivationDecisionArtifact(
      decision,
      decision.candidateId,
    );
  } catch (error) {
    return invalidBinding(errorMessage(error));
  }

  let validatedCandidate: StrategyDerivationCandidateV1;
  try {
    validatedCandidate = validateStrategyDerivationCandidateArtifact(
      candidate,
      candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  const candidateFingerprint = strategyDerivationCandidateSemanticFingerprint(validatedCandidate);
  if (
    validatedDecision.candidateId !== validatedCandidate.candidateId ||
    validatedDecision.candidateFingerprint !== candidateFingerprint
  ) return invalidBinding("Candidate ID or semantic fingerprint does not match the immutable Candidate.");
  if (
    validatedDecision.projectId !== validatedCandidate.projectId ||
    validatedDecision.basePortfolioFingerprint !== validatedCandidate.basePortfolio.fingerprint
  ) return invalidBinding("project or base trusted-portfolio fingerprint does not match the immutable Candidate.");
  if (
    validatedDecision.strategy.strategyId !== validatedCandidate.proposal.strategyId ||
    validatedDecision.strategy.kind !== validatedCandidate.proposal.kind
  ) return invalidBinding("strategy logical ID or kind does not match the immutable Candidate proposal.");
  if (!sameStringArray(
    validatedDecision.evidence.sourceRecordIds,
    validatedCandidate.evidence.sourceRecordIds,
  )) return invalidBinding("sourceRecordIds do not exactly match the Candidate's immutable cited source provenance.");
  return validatedDecision;
}

export function validateStrategyDerivationDecisionProjectBinding(
  decision: StrategyDerivationDecisionV1,
  projectRoot: string,
): StrategyDerivationDecisionV1 {
  const validated = validateStrategyDerivationDecisionArtifact(decision, decision.candidateId);
  if (validated.projectId !== getProjectId(projectRoot)) {
    return invalidBinding("Decision projectId does not match the current project.");
  }
  return validated;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isStrategyDerivationDecision(value: unknown): value is StrategyDerivationDecisionV1 {
  try {
    validateStrategyDerivationDecisionArtifact(value);
    return true;
  } catch {
    return false;
  }
}

/** Construct a Decision from a validated Candidate; provenance is never model-authored. */
export function createStrategyDerivationDecision(
  input: CreateStrategyDerivationDecisionInput,
): StrategyDerivationDecisionV1 {
  let candidate: StrategyDerivationCandidateV1;
  try {
    candidate = validateStrategyDerivationCandidateArtifact(
      input.candidate,
      input.candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  if (input.decision !== "promoted" && input.decision !== "rejected") {
    return invalid("decision must be promoted or rejected.");
  }
  const trialRecordIds = validateRecordIds(
    input.trialRecordIds,
    "evidence.trialRecordIds",
    input.decision === "promoted" ? 2 : 0,
    MAX_DERIVATION_DECISION_TRIAL_RECORD_IDS,
  );
  const decidedAt = validateTimestamp(input.decidedAt ?? new Date().toISOString());
  return Object.freeze({
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    candidateFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
    decidedAt,
    projectId: candidate.projectId,
    basePortfolioFingerprint: candidate.basePortfolio.fingerprint,
    strategy: Object.freeze({
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
    }),
    decision: input.decision,
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...candidate.evidence.sourceRecordIds]),
      trialRecordIds,
    }),
  });
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable project-local immutable storage for Derivation Decisions. */
export class FileStrategyDerivationDecisionStore implements StrategyDerivationDecisionStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyDerivationDecisionStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  async read(projectRoot: string, candidateId: string): Promise<StrategyDerivationDecisionV1 | null> {
    if (!isCanonicalStrategyDerivationCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Derivation Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    const decisionPath = join(
      this.strategyDerivationDecisionDirectory(projectRoot),
      `${candidateId}.json`,
    );
    let contents: string;
    try {
      contents = await readFile(decisionPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Pindie Strategy Derivation Decision file '${decisionPath}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Pindie Strategy Derivation Decision file '${decisionPath}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      return validateStrategyDerivationDecisionProjectBinding(
        validateStrategyDerivationDecisionArtifact(parsed, candidateId),
        projectRoot,
      );
    } catch (error) {
      throw new Error(`Could not read Pindie Strategy Derivation Decision file '${decisionPath}': ${errorMessage(error)}`);
    }
  }

  async readAll(projectRoot: string): Promise<readonly StrategyDerivationDecisionV1[]> {
    const directory = this.strategyDerivationDecisionDirectory(projectRoot);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Pindie Strategy Derivation Decision directory '${directory}': ${errorMessage(error)}`);
    }
    const decisions: StrategyDerivationDecisionV1[] = [];
    for (const entry of entries
      .filter((item) => item.isFile() && CANONICAL_DECISION_FILE.test(item.name))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const candidateId = entry.name.slice(0, -".json".length);
      const decision = await this.read(projectRoot, candidateId);
      if (decision === null) {
        throw new Error(`Could not read Pindie Strategy Derivation Decision file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      }
      decisions.push(decision);
    }
    return Object.freeze(decisions);
  }

  async save(projectRoot: string, decision: StrategyDerivationDecisionV1): Promise<void> {
    const validated = validateStrategyDerivationDecisionProjectBinding(decision, projectRoot);
    const directory = this.strategyDerivationDecisionDirectory(projectRoot);
    const decisionPath = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // Hard-link creation is atomic and cannot replace a terminal artifact.
      await link(temporaryPath, decisionPath);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Could not save Pindie Strategy Derivation Decision file '${decisionPath}': terminal Decision already exists.`);
      }
      throw new Error(`Could not save Pindie Strategy Derivation Decision file '${decisionPath}': ${errorMessage(error)}`);
    }
  }

  strategyDerivationDecisionDirectory(projectRoot: string): string {
    return join(
      this.baseDir,
      getProjectId(projectRoot),
      STRATEGY_DERIVATION_DECISION_DIRECTORY_NAME,
    );
  }
}

export { FileStrategyDerivationDecisionStore as FileStrategyDerivationDecisionV1Store };

export interface PromotedDerivedStrategy {
  readonly candidate: StrategyDerivationCandidateV1;
  readonly decision: StrategyDerivationDecisionV1;
  readonly selection: StrategyRevisionSelection;
}

export interface PromotedDerivedStrategyCatalog {
  /** Only promoted, fully bound Derived Strategies. */
  readonly entries: readonly PromotedDerivedStrategy[];
  readonly selections: readonly StrategyRevisionSelection[];
  resolve(selector: unknown, kind: SeedStrategyKind): StrategyRevisionSelection;
}

function semanticsProjection(selection: StrategyRevisionSelection): Record<string, unknown> {
  return {
    kind: selection.kind,
    summary: selection.semantics.summary,
    useWhen: [...selection.semantics.useWhen],
    avoidWhen: [...selection.semantics.avoidWhen],
    principles: [...selection.semantics.principles],
  };
}

function selectionMatches(
  actual: StrategyRevisionSelection,
  expected: StrategyRevisionSelection,
): boolean {
  return actual.strategyId === expected.strategyId &&
    actual.kind === expected.kind &&
    actual.revisionIdentity === expected.revisionIdentity &&
    actual.revisionFingerprint === expected.revisionFingerprint &&
    actual.revisionStatusAtRun === "promoted" &&
    JSON.stringify(actual.semantics) === JSON.stringify(expected.semantics);
}

/** Build a deterministic bounded catalog from immutable Candidate + Decision pairs. */
export function createPromotedDerivedStrategyCatalog(
  entries: readonly PromotedDerivedStrategy[],
): PromotedDerivedStrategyCatalog {
  if (entries.length > MAX_PROMOTED_DERIVED_STRATEGIES) {
    throw new Error("Promoted Derived Strategy catalog exceeds the bounded project-local limit.");
  }
  const candidateIds = new Set<string>();
  const strategyIds = new Set<string>();
  const semanticIds = new Set<string>();
  const validated = entries.map((entry) => {
    const candidate = validateStrategyDerivationCandidateArtifact(entry.candidate, entry.candidate.candidateId);
    const decision = validateStrategyDerivationDecisionBinding(entry.decision, candidate);
    if (decision.decision !== "promoted") throw new Error("Rejected Derivation Candidates cannot enter the trusted catalog.");
    if (SEED_STRATEGIES.some((seed) => seed.id === candidate.proposal.strategyId)) {
      throw new Error("A promoted Derived Strategy cannot reuse a Seed logical Strategy ID.");
    }
    if (candidateIds.has(candidate.candidateId)) throw new Error("Duplicate Derivation Candidate trust artifacts were found.");
    if (strategyIds.has(candidate.proposal.strategyId)) throw new Error("More than one promoted Derived Strategy has the same logical Strategy ID.");
    const semanticId = JSON.stringify({
      kind: candidate.proposal.kind,
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    });
    if (semanticIds.has(semanticId)) throw new Error("Promoted Derived Strategy catalog contains an exact semantic duplicate.");
    candidateIds.add(candidate.candidateId);
    strategyIds.add(candidate.proposal.strategyId);
    semanticIds.add(semanticId);
    const selection = createStrategyRevisionSelection({
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
      revisionStatusAtRun: "promoted",
      semantics: {
        summary: candidate.proposal.summary,
        useWhen: [...candidate.proposal.useWhen],
        avoidWhen: [...candidate.proposal.avoidWhen],
        principles: [...candidate.proposal.principles],
      },
    });
    if (!selectionMatches(entry.selection, selection)) {
      throw new Error("Promoted Derived Strategy selection is not Harness-derived from the immutable Candidate.");
    }
    return Object.freeze({ candidate, decision, selection });
  }).sort((left, right) => {
    const leftKey = `${left.selection.strategyId}\0${left.selection.kind}\0${left.selection.revisionIdentity}`;
    const rightKey = `${right.selection.strategyId}\0${right.selection.kind}\0${right.selection.revisionIdentity}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const frozenEntries = Object.freeze(validated);
  return Object.freeze({
    entries: frozenEntries,
    selections: Object.freeze(frozenEntries.map((entry) => entry.selection)),
    resolve(selector: unknown, kind: SeedStrategyKind): StrategyRevisionSelection {
      if (!isStrategyRevisionSelector(selector)) {
        throw new Error("Promoted Derived Strategy selector is malformed; use the exact selector from the current Strategy context.");
      }
      const found = frozenEntries.find((entry) =>
        entry.selection.kind === kind &&
        entry.selection.strategyId === selector.strategyId &&
        entry.selection.revisionIdentity === selector.revisionIdentity &&
        entry.selection.revisionFingerprint === selector.revisionFingerprint);
      if (found === undefined) {
        throw new Error("Promoted Derived Strategy is unavailable in the current project catalog or has the wrong role.");
      }
      return found.selection;
    },
  });
}

export const createPromotedStrategyDerivationCatalog = createPromotedDerivedStrategyCatalog;

export function emptyPromotedDerivedStrategyCatalog(): PromotedDerivedStrategyCatalog {
  return createPromotedDerivedStrategyCatalog([]);
}

/**
 * Reconstruct promoted Derived identities from immutable project-local
 * artifacts. Rejected Decisions are validated but never projected.
 */
export async function loadPromotedDerivedStrategyCatalog(
  projectRoot: string,
  decisionReader: StrategyDerivationDecisionReader,
  candidateReader: StrategyDerivationCandidateReader,
  revisionCandidateReader?: StrategyCandidateReader,
): Promise<PromotedDerivedStrategyCatalog> {
  const rawDecisions = await decisionReader.readAll(projectRoot);
  if (!Array.isArray(rawDecisions)) throw new Error("Strategy Derivation Decision reader returned an invalid collection.");
  const decisions: StrategyDerivationDecisionV1[] = [];
  const candidateIds = new Set<string>();
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategyDerivationDecisionProjectBinding(
      validateStrategyDerivationDecisionArtifact(rawDecision),
      projectRoot,
    );
    if (candidateIds.has(decision.candidateId)) throw new Error("Duplicate or conflicting Derivation Decisions were found.");
    candidateIds.add(decision.candidateId);
    decisions.push(decision);
  }

  if (revisionCandidateReader !== undefined) {
    for (const candidateId of candidateIds) {
      const revision = await revisionCandidateReader.read(projectRoot, candidateId);
      if (revision !== null) {
        throw new Error("Candidate ID is ambiguous: both Revision and Derivation Candidate stores contain it.");
      }
    }
  }

  const promoted: PromotedDerivedStrategy[] = [];
  for (const decision of decisions) {
    const candidate = await candidateReader.read(projectRoot, decision.candidateId);
    if (candidate === null) throw new Error(`Decision '${decision.candidateId}' is missing its immutable Derivation Candidate artifact.`);
    const validatedCandidate = validateStrategyDerivationCandidateBinding(candidate, projectRoot);
    const validatedDecision = validateStrategyDerivationDecisionBinding(decision, validatedCandidate);
    if (validatedDecision.decision !== "promoted") continue;
    const selection = createStrategyRevisionSelection({
      strategyId: validatedCandidate.proposal.strategyId,
      kind: validatedCandidate.proposal.kind,
      revisionIdentity: validatedCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(validatedCandidate),
      revisionStatusAtRun: "promoted",
      semantics: {
        summary: validatedCandidate.proposal.summary,
        useWhen: [...validatedCandidate.proposal.useWhen],
        avoidWhen: [...validatedCandidate.proposal.avoidWhen],
        principles: [...validatedCandidate.proposal.principles],
      },
    });
    promoted.push({ candidate: validatedCandidate, decision: validatedDecision, selection });
  }
  return createPromotedDerivedStrategyCatalog(promoted);
}

export const loadPromotedStrategyDerivationCatalog = loadPromotedDerivedStrategyCatalog;

/** Render only the bounded promoted Derived identities for normal context. */
export function formatPromotedDerivedStrategyCatalog(
  catalog: PromotedDerivedStrategyCatalog,
): string {
  if (catalog.entries.length === 0) return "";
  const lines = [
    "<PINDIE_PROMOTED_DERIVED_STRATEGIES>",
    "Project-local promoted Derived Strategies available for explicit normal Policy declaration:",
    "Promotion means only that this exact Strategy hypothesis is trusted enough to be selectable; it is not a default, recommendation, superiority claim, or causal finding.",
    "",
  ];
  for (const entry of catalog.entries.slice(0, MAX_PROMOTED_DERIVED_STRATEGIES)) {
    const selection = entry.selection;
    lines.push(
      `- ${selection.strategyId} (${selection.kind}) · promoted ${selection.revisionIdentity.slice(0, 8)}`,
      `  Revision fingerprint: ${selection.revisionFingerprint}`,
      "  Revision status: promoted",
      "  Exact selector:",
      JSON.stringify({
        strategyId: selection.strategyId,
        revisionIdentity: selection.revisionIdentity,
        revisionFingerprint: selection.revisionFingerprint,
      }, null, 2),
      `  Summary: ${selection.semantics.summary}`,
      "  Use when:",
      ...selection.semantics.useWhen.map((value) => `  - ${value}`),
      "  Avoid when:",
      ...(selection.semantics.avoidWhen.length > 0
        ? selection.semantics.avoidWhen.map((value) => `  - ${value}`)
        : ["  - none"]),
      "  Principles:",
      ...selection.semantics.principles.map((value) => `  - ${value}`),
      "",
    );
  }
  lines.push(
    "Declare a promoted Derived Strategy only with its exact selector; the Harness supplies its validated kind, semantics, fingerprint, and promoted status.",
    "Inactive and rejected Derivation Candidates are not included in normal context.",
    "</PINDIE_PROMOTED_DERIVED_STRATEGIES>",
  );
  return lines.join("\n");
}

export const renderPromotedDerivedStrategyCatalog = formatPromotedDerivedStrategyCatalog;

// Kept as an explicit alias for callers that name the artifact before the
// runtime projection.
export type StrategyDerivationDecisionStoreV1 = StrategyDerivationDecisionStore;
export type StrategyDerivationDecisionReaderV1 = StrategyDerivationDecisionReader;
