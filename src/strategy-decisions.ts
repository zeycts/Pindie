import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isStrategyRevisionSelector,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";
import {
  isCanonicalStrategyCandidateId,
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  validateStrategyRevisionCandidateArtifact,
  type StrategyCandidateReader,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  SEED_STRATEGIES,
  type SeedStrategyKind,
} from "./strategies.ts";
import { getProjectId } from "./store.ts";

export const STRATEGY_REVISION_DECISION_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DECISION_DIRECTORY_NAME = "strategy-decisions";
export const MAX_DECISION_TRIAL_RECORD_IDS = 1024;
export const MAX_DECISION_TRIAL_RECORD_ID_LENGTH = 128;
export const MAX_DECISION_TIMESTAMP_LENGTH = 64;
export const MAX_PROMOTED_STRATEGY_REVISIONS = SEED_STRATEGIES.length;

export type StrategyRevisionDecisionTerminal = "promoted" | "rejected";

/** Immutable human-owned terminal trust decision for one Candidate. */
export interface StrategyRevisionDecisionV1 {
  readonly schemaVersion: typeof STRATEGY_REVISION_DECISION_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly decidedAt: string;
  readonly target: {
    readonly strategyId: string;
    readonly kind: SeedStrategyKind;
    readonly baseFingerprint: string;
  };
  readonly decision: StrategyRevisionDecisionTerminal;
  readonly evidence: {
    /** Eligible Candidate Trial Experience record IDs cited by the decision. */
    readonly trialRecordIds: readonly string[];
  };
}

export type StrategyRevisionDecision = StrategyRevisionDecisionV1;
export type StrategyDecision = StrategyRevisionDecisionV1;

export interface CreateStrategyRevisionDecisionInput {
  readonly candidate: StrategyRevisionCandidate;
  readonly decision: StrategyRevisionDecisionTerminal;
  readonly trialRecordIds: readonly string[];
  /** Optional test seam; the runtime owns the decision timestamp. */
  readonly decidedAt?: string;
}

export interface StrategyRevisionDecisionReader {
  /** Read one immutable Decision by its exact canonical project-local ID. */
  read(projectRoot: string, candidateId: string): Promise<StrategyRevisionDecision | null>;
  /** Read every canonical Decision artifact for the current project. */
  readAll(projectRoot: string): Promise<readonly StrategyRevisionDecision[]>;
}

export interface StrategyRevisionDecisionStore extends StrategyRevisionDecisionReader {
  save(projectRoot: string, decision: StrategyRevisionDecision): Promise<void>;
}

/** Descriptive short aliases for callers using the storage concept. */
export type StrategyDecisionReader = StrategyRevisionDecisionReader;
export type StrategyDecisionStore = StrategyRevisionDecisionStore;

export interface FileStrategyDecisionStoreOptions {
  baseDir?: string;
}

const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_DECISION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const DECISION_FIELDS = [
  "schemaVersion",
  "candidateId",
  "candidateFingerprint",
  "decidedAt",
  "target",
  "decision",
  "evidence",
] as const;
const TARGET_FIELDS = ["strategyId", "kind", "baseFingerprint"] as const;
const EVIDENCE_FIELDS = ["trialRecordIds"] as const;

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
  throw new Error(`Invalid Strategy Revision Decision: ${message}`);
}

function invalidBinding(message: string): never {
  throw new Error(`Invalid Strategy Revision Decision binding: ${message}`);
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

function validateTrialRecordIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) ||
    value.length > MAX_DECISION_TRIAL_RECORD_IDS) {
    return invalid(`evidence.trialRecordIds must contain at most ${MAX_DECISION_TRIAL_RECORD_IDS} items.`);
  }
  const ids = value.map((recordId, index) =>
    boundedString(recordId, `evidence.trialRecordIds[${index}]`, MAX_DECISION_TRIAL_RECORD_ID_LENGTH));
  if (new Set(ids).size !== ids.length) {
    return invalid("evidence.trialRecordIds must be unique.");
  }
  return Object.freeze(ids);
}

function validateDecisionTimestamp(value: unknown): string {
  const timestamp = boundedString(value, "decidedAt", MAX_DECISION_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(timestamp))) {
    return invalid("decidedAt must be a valid timestamp.");
  }
  return timestamp;
}

/** Validate one immutable schema-v1 Decision without repairing or activating it. */
export function validateStrategyRevisionDecisionArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyRevisionDecision {
  if (!isRecord(value) || !hasExactFields(value, DECISION_FIELDS)) {
    invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_REVISION_DECISION_SCHEMA_VERSION) {
    invalid("schemaVersion must be 1.");
  }
  if (
    typeof value.candidateId !== "string" ||
    !isCanonicalStrategyCandidateId(value.candidateId)
  ) {
    invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  if (requestedCandidateId !== undefined && value.candidateId !== requestedCandidateId) {
    invalid("requested Candidate ID does not match artifact candidateId.");
  }
  if (
    typeof value.candidateFingerprint !== "string" ||
    !CANONICAL_FINGERPRINT.test(value.candidateFingerprint)
  ) {
    invalid("candidateFingerprint must be a lowercase SHA-256 fingerprint.");
  }
  const decidedAt = validateDecisionTimestamp(value.decidedAt);
  if (!isRecord(value.target) || !hasExactFields(value.target, TARGET_FIELDS)) {
    invalid("target fields are invalid.");
  }
  if (
    typeof value.target.strategyId !== "string" ||
    value.target.strategyId.trim() === "" ||
    (value.target.kind !== "approach" && value.target.kind !== "modifier") ||
    typeof value.target.baseFingerprint !== "string" ||
    !CANONICAL_FINGERPRINT.test(value.target.baseFingerprint)
  ) {
    invalid("target identity is invalid.");
  }
  if (value.decision !== "promoted" && value.decision !== "rejected") {
    invalid("decision must be promoted or rejected.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    invalid("evidence fields are invalid.");
  }
  const trialRecordIds = validateTrialRecordIds(value.evidence.trialRecordIds);

  return Object.freeze({
    schemaVersion: STRATEGY_REVISION_DECISION_SCHEMA_VERSION,
    candidateId: value.candidateId,
    candidateFingerprint: value.candidateFingerprint,
    decidedAt,
    target: Object.freeze({
      strategyId: value.target.strategyId,
      kind: value.target.kind,
      baseFingerprint: value.target.baseFingerprint,
    }),
    decision: value.decision,
    evidence: Object.freeze({ trialRecordIds }),
  });
}

export const parseStrategyRevisionDecision = validateStrategyRevisionDecisionArtifact;

/** Validate all Candidate, Seed, and semantic-fingerprint bindings for a Decision. */
export function validateStrategyRevisionDecisionBinding(
  decision: StrategyRevisionDecision,
  candidate: StrategyRevisionCandidate,
): StrategyRevisionDecision {
  let validatedDecision: StrategyRevisionDecision;
  try {
    validatedDecision = validateStrategyRevisionDecisionArtifact(
      decision,
      decision.candidateId,
    );
  } catch (error) {
    return invalidBinding(errorMessage(error));
  }

  let validatedCandidate: StrategyRevisionCandidate;
  try {
    validatedCandidate = validateStrategyRevisionCandidateArtifact(
      candidate,
      candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  const candidateFingerprint = strategyCandidateSemanticFingerprint(validatedCandidate);
  if (
    validatedDecision.candidateId !== validatedCandidate.candidateId ||
    validatedDecision.candidateFingerprint !== candidateFingerprint
  ) {
    return invalidBinding("Candidate ID or semantic fingerprint does not match the immutable Candidate.");
  }
  if (
    validatedDecision.target.strategyId !== validatedCandidate.target.strategyId ||
    validatedDecision.target.kind !== validatedCandidate.target.kind ||
    validatedDecision.target.baseFingerprint !== validatedCandidate.target.baseFingerprint
  ) {
    return invalidBinding("target Strategy, role, or Seed base fingerprint does not match the immutable Candidate.");
  }
  return validatedDecision;
}

export function isStrategyRevisionDecision(value: unknown): value is StrategyRevisionDecision {
  try {
    validateStrategyRevisionDecisionArtifact(value);
    return true;
  } catch {
    return false;
  }
}

/** Construct a frozen Decision; only the caller performing the explicit human command should call this. */
export function createStrategyRevisionDecision(
  input: CreateStrategyRevisionDecisionInput,
): StrategyRevisionDecision {
  let candidate: StrategyRevisionCandidate;
  try {
    candidate = validateStrategyRevisionCandidateArtifact(
      input.candidate,
      input.candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  if (input.decision !== "promoted" && input.decision !== "rejected") {
    return invalid(`decision must be promoted or rejected.`);
  }
  const trialRecordIds = validateTrialRecordIds(input.trialRecordIds);
  const decidedAt = validateDecisionTimestamp(
    input.decidedAt ?? new Date().toISOString(),
  );
  return Object.freeze({
    schemaVersion: STRATEGY_REVISION_DECISION_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    candidateFingerprint: strategyCandidateSemanticFingerprint(candidate),
    decidedAt,
    target: Object.freeze({
      strategyId: candidate.target.strategyId,
      kind: candidate.target.kind,
      baseFingerprint: candidate.target.baseFingerprint,
    }),
    decision: input.decision,
    evidence: Object.freeze({ trialRecordIds }),
  });
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable project-local storage for immutable terminal Decisions. */
export class FileStrategyDecisionStore implements StrategyRevisionDecisionStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyDecisionStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  private async readFromDirectory(
    directory: string,
    candidateId: string,
  ): Promise<StrategyRevisionDecision | null> {
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    const decisionPath = join(directory, `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(decisionPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(
        `Could not read Pindie Strategy Revision Decision file '${decisionPath}': ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `Could not read Pindie Strategy Revision Decision file '${decisionPath}': invalid JSON (${errorMessage(error)}).`,
      );
    }
    try {
      return validateStrategyRevisionDecisionArtifact(parsed, candidateId);
    } catch (error) {
      throw new Error(
        `Could not read Pindie Strategy Revision Decision file '${decisionPath}': ${errorMessage(error)}`,
      );
    }
  }

  private async readAllFromDirectory(
    directory: string,
  ): Promise<readonly StrategyRevisionDecision[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(
        `Could not read Pindie Strategy Revision Decision directory '${directory}': ${errorMessage(error)}`,
      );
    }

    const decisions: StrategyRevisionDecision[] = [];
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && CANONICAL_DECISION_FILE.test(candidate.name))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const candidateId = entry.name.slice(0, -".json".length);
      const decision = await this.readFromDirectory(directory, candidateId);
      if (decision === null) {
        throw new Error(
          `Could not read Pindie Strategy Revision Decision file '${join(directory, entry.name)}': the artifact disappeared while reading.`,
        );
      }
      decisions.push(decision);
    }
    return Object.freeze(decisions);
  }

  async read(
    projectRoot: string,
    candidateId: string,
  ): Promise<StrategyRevisionDecision | null> {
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(this.strategyDecisionDirectory(projectRoot), candidateId);
  }

  /** Read one Decision directly from a canonical project namespace. */
  async readProjectId(
    projectId: string,
    candidateId: string,
  ): Promise<StrategyRevisionDecision | null> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Revision Decision: projectId must be canonical.");
    }
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(this.strategyDecisionDirectoryForProjectId(projectId), candidateId);
  }

  async readAll(projectRoot: string): Promise<readonly StrategyRevisionDecision[]> {
    return this.readAllFromDirectory(this.strategyDecisionDirectory(projectRoot));
  }

  /** Read every Decision directly from a canonical project namespace. */
  async readAllProjectId(projectId: string): Promise<readonly StrategyRevisionDecision[]> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Revision Decisions: projectId must be canonical.");
    }
    return this.readAllFromDirectory(this.strategyDecisionDirectoryForProjectId(projectId));
  }

  async save(projectRoot: string, decision: StrategyRevisionDecision): Promise<void> {
    const validated = validateStrategyRevisionDecisionArtifact(
      decision,
      decision.candidateId,
    );
    const directory = this.strategyDecisionDirectory(projectRoot);
    const decisionPath = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // A hard-link create is atomic and never replaces an existing terminal
      // artifact. This is the immutable duplicate/conflict backstop.
      await link(temporaryPath, decisionPath);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST" &&
        (errorMessage(error).includes(decisionPath) || errorMessage(error).includes("EEXIST"))) {
        throw new Error(
          `Could not save Pindie Strategy Revision Decision file '${decisionPath}': terminal Decision already exists.`,
        );
      }
      throw new Error(
        `Could not save Pindie Strategy Revision Decision file '${decisionPath}': ${errorMessage(error)}`,
      );
    }
  }

  strategyDecisionDirectory(projectRoot: string): string {
    return this.strategyDecisionDirectoryForProjectId(getProjectId(projectRoot));
  }

  strategyDecisionDirectoryForProjectId(projectId: string): string {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Strategy Revision Decision namespace requires a canonical project identity.");
    }
    return join(this.baseDir, projectId, STRATEGY_DECISION_DIRECTORY_NAME);
  }
}

/** One validated promoted Candidate revision exposed to normal Policy selection. */
export interface PromotedStrategyRevision {
  readonly candidate: StrategyRevisionCandidate;
  readonly decision: StrategyRevisionDecision;
  readonly selection: StrategyRevisionSelection;
}

export interface PromotedStrategyRevisionCatalog {
  /** Only promoted entries; inactive and rejected Candidates are absent. */
  readonly entries: readonly PromotedStrategyRevision[];
  /** Compact exact selections corresponding to entries, for runtime callers/tests. */
  readonly selections: readonly StrategyRevisionSelection[];
  /** Resolve only an exact catalog selector; semantics/status come from the Harness. */
  resolve(
    selector: unknown,
    kind: SeedStrategyKind,
  ): StrategyRevisionSelection;
}

function targetKey(
  target: { strategyId: string; kind: SeedStrategyKind; baseFingerprint: string },
): string {
  return `${target.strategyId}\0${target.kind}\0${target.baseFingerprint}`;
}

/** Build a frozen bounded catalog and reject duplicate/conflicting trust facts. */
export function createPromotedStrategyRevisionCatalog(
  entries: readonly PromotedStrategyRevision[],
): PromotedStrategyRevisionCatalog {
  if (entries.length > MAX_PROMOTED_STRATEGY_REVISIONS) {
    throw new Error("Promoted Strategy catalog exceeds the bounded project-local portfolio.");
  }
  const candidateIds = new Set<string>();
  const targets = new Set<string>();
  const validated = entries.map((entry) => {
    const candidate = validateStrategyRevisionCandidateArtifact(
      entry.candidate,
      entry.candidate.candidateId,
    );
    const decision = validateStrategyRevisionDecisionBinding(entry.decision, candidate);
    if (decision.decision !== "promoted") {
      throw new Error("Rejected Candidates cannot enter the promoted Strategy catalog.");
    }
    const key = targetKey(candidate.target);
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error("Duplicate terminal Decision for one Candidate was found.");
    }
    if (targets.has(key)) {
      throw new Error("More than one promoted Candidate revision targets the same Seed Strategy.");
    }
    candidateIds.add(candidate.candidateId);
    targets.add(key);
    const selection = strategyRevisionSelectionFromCandidate(candidate, "promoted");
    if (
      entry.selection.strategyId !== selection.strategyId ||
      entry.selection.kind !== selection.kind ||
      entry.selection.revisionIdentity !== selection.revisionIdentity ||
      entry.selection.revisionFingerprint !== selection.revisionFingerprint ||
      entry.selection.revisionStatusAtRun !== "promoted" ||
      JSON.stringify(entry.selection.semantics) !== JSON.stringify(selection.semantics)
    ) {
      throw new Error("Promoted Strategy selection is not Harness-derived from the immutable Candidate.");
    }
    return Object.freeze({ candidate, decision, selection });
  }).sort((left, right) => {
    const leftKey = `${left.selection.strategyId}\0${left.selection.kind}\0${left.selection.revisionIdentity}`;
    const rightKey = `${right.selection.strategyId}\0${right.selection.kind}\0${right.selection.revisionIdentity}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const frozenEntries = Object.freeze(validated);
  const frozenSelections = Object.freeze(frozenEntries.map((entry) => entry.selection));
  return Object.freeze({
    entries: frozenEntries,
    selections: frozenSelections,
    resolve(selector: unknown, kind: SeedStrategyKind): StrategyRevisionSelection {
      if (!isStrategyRevisionSelector(selector)) {
        throw new Error("Promoted Strategy selector is malformed; use the exact selector from the current Strategy context.");
      }
      const entry = frozenEntries.find((candidate) =>
        candidate.selection.kind === kind &&
        candidate.selection.strategyId === selector.strategyId &&
        candidate.selection.revisionIdentity === selector.revisionIdentity &&
        candidate.selection.revisionFingerprint === selector.revisionFingerprint);
      if (entry === undefined) {
        throw new Error("Promoted Strategy revision is unavailable in the current project catalog or has the wrong role.");
      }
      return entry.selection;
    },
  });
}

export function emptyPromotedStrategyRevisionCatalog(): PromotedStrategyRevisionCatalog {
  return createPromotedStrategyRevisionCatalog([]);
}

/**
 * Read and validate all project-local Decisions before exposing any promoted
 * revision. Any trust read/binding failure rejects the whole catalog so normal
 * Policy availability safely falls back to immutable Seeds.
 */
async function loadPromotedStrategyRevisionCatalogFromSources(
  rawDecisions: readonly StrategyRevisionDecision[],
  readCandidate: (candidateId: string) => Promise<StrategyRevisionCandidate | null>,
): Promise<PromotedStrategyRevisionCatalog> {
  if (!Array.isArray(rawDecisions)) {
    throw new Error("Strategy Revision Decision reader returned an invalid collection.");
  }
  const decisions: StrategyRevisionDecision[] = [];
  const candidateIds = new Set<string>();
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategyRevisionDecisionArtifact(rawDecision);
    if (candidateIds.has(decision.candidateId)) {
      throw new Error("Duplicate or conflicting terminal Decisions were found for one Candidate.");
    }
    candidateIds.add(decision.candidateId);
    decisions.push(decision);
  }

  const entries: PromotedStrategyRevision[] = [];
  for (const decision of decisions) {
    const candidate = await readCandidate(decision.candidateId);
    if (candidate === null) {
      throw new Error(`Decision '${decision.candidateId}' is missing its immutable Candidate artifact.`);
    }
    const validatedCandidate = validateStrategyRevisionCandidateArtifact(
      candidate,
      decision.candidateId,
    );
    const validatedDecision = validateStrategyRevisionDecisionBinding(
      decision,
      validatedCandidate,
    );
    if (validatedDecision.decision !== "promoted") continue;
    entries.push({
      candidate: validatedCandidate,
      decision: validatedDecision,
      selection: strategyRevisionSelectionFromCandidate(validatedCandidate, "promoted"),
    });
  }
  return createPromotedStrategyRevisionCatalog(entries);
}

export async function loadPromotedStrategyRevisionCatalog(
  projectRoot: string,
  decisionReader: StrategyRevisionDecisionReader,
  candidateReader: StrategyCandidateReader,
): Promise<PromotedStrategyRevisionCatalog> {
  return loadPromotedStrategyRevisionCatalogFromSources(
    await decisionReader.readAll(projectRoot),
    (candidateId) => candidateReader.read(projectRoot, candidateId),
  );
}

/** Reconstruct promoted Seed revisions from a project namespace without a root. */
export async function loadPromotedStrategyRevisionCatalogByProjectId(
  projectId: string,
  decisionReader: {
    readAllProjectId(projectId: string): Promise<readonly StrategyRevisionDecision[]>;
  },
  candidateReader: {
    readProjectId(projectId: string, candidateId: string): Promise<StrategyRevisionCandidate | null>;
  },
): Promise<PromotedStrategyRevisionCatalog> {
  if (!CANONICAL_PROJECT_ID.test(projectId)) {
    throw new Error("Strategy Revision portfolio reads require a canonical project identity.");
  }
  return loadPromotedStrategyRevisionCatalogFromSources(
    await decisionReader.readAllProjectId(projectId),
    (candidateId) => candidateReader.readProjectId(projectId, candidateId),
  );
}

/** Render only the bounded promoted portfolio for normal model-facing context. */
export function formatPromotedStrategyRevisionCatalog(
  catalog: PromotedStrategyRevisionCatalog,
): string {
  if (catalog.entries.length === 0) return "";
  const lines = [
    "<PINDIE_PROMOTED_STRATEGIES>",
    "Project-local promoted Strategy revisions available for explicit normal Policy declaration:",
    "Promotion means only that this exact revision is trusted enough to be selectable; it is not a default, superiority claim, or Seed replacement.",
    "Seed revisions remain selectable by their existing shorthand.",
    "",
  ];
  for (const entry of catalog.entries.slice(0, MAX_PROMOTED_STRATEGY_REVISIONS)) {
    const selection = entry.selection;
    lines.push(
      `- ${selection.strategyId} (${selection.kind}) · revision ${selection.revisionIdentity}`,
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
    "Declare a promoted revision only with its exact selector; the Harness supplies its validated semantics and records revisionStatusAtRun = promoted.",
    "Inactive and rejected Candidates are not included in normal context.",
    "</PINDIE_PROMOTED_STRATEGIES>",
  );
  return lines.join("\n");
}

export const renderPromotedStrategyRevisionCatalog = formatPromotedStrategyRevisionCatalog;

// Compatibility aliases for callers that use the longer class name.
export { FileStrategyDecisionStore as FileStrategyRevisionDecisionStore };
