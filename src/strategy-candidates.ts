import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createStrategyRevisionSelection,
  type StrategyRevisionSelection,
  type StrategyRevisionStatusAtRun,
} from "./policy.ts";
import {
  getSeedStrategy,
  seedStrategyFingerprint,
  seedStrategySemantics,
  type SeedStrategy,
  type SeedStrategyKind,
} from "./strategies.ts";
import { getProjectId } from "./store.ts";

export const STRATEGY_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const STRATEGY_CANDIDATE_DIRECTORY_NAME = "strategy-candidates";
export const MAX_ADAPTATION_PACKET_RUNS = 8;
export const MAX_CANDIDATE_SUMMARY_LENGTH = 512;
export const MAX_CANDIDATE_GUIDANCE_LENGTH = 256;
export const MAX_CANDIDATE_HYPOTHESIS_LENGTH = 1024;
export const MAX_CANDIDATE_SOURCE_RECORD_ID_LENGTH = 128;
export const MAX_CANDIDATE_GUIDANCE_ITEMS = 8;
export const MAX_CANDIDATE_COMMAND_LABEL_LENGTH = 160;

export interface StrategyRevisionCandidate {
  readonly schemaVersion: typeof STRATEGY_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly target: {
    readonly strategyId: string;
    readonly kind: SeedStrategyKind;
    readonly baseFingerprint: string;
  };
  readonly proposal: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
  readonly evidence: {
    readonly sourceRecordIds: readonly string[];
  };
  readonly hypothesis: string;
}

export interface StrategyCandidateProposal {
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly hypothesis: string;
}

export interface CreateStrategyRevisionCandidateInput {
  readonly target: SeedStrategy;
  readonly proposal: StrategyCandidateProposal;
  /** Optional seams for deterministic tests; the runtime always owns these values. */
  readonly candidateId?: string;
  readonly createdAt?: string;
}

export interface StrategyCandidateReader {
  /** Read one immutable Candidate by its exact canonical project-local ID. */
  read(projectRoot: string, candidateId: string): Promise<StrategyRevisionCandidate | null>;
  /** Read every canonical immutable Candidate artifact for the current project. */
  readAll?(projectRoot: string): Promise<readonly StrategyRevisionCandidate[]>;
}

export interface StrategyCandidateStore {
  save(projectRoot: string, candidate: StrategyRevisionCandidate): Promise<void>;
}

export interface FileStrategyCandidateStoreOptions {
  baseDir?: string;
}

const CANONICAL_CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateId",
  "createdAt",
  "target",
  "proposal",
  "evidence",
  "hypothesis",
] as const;
const TARGET_FIELDS = ["strategyId", "kind", "baseFingerprint"] as const;
const PROPOSAL_FIELDS = [
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
  "sourceRecordIds",
  "hypothesis",
] as const;
const ARTIFACT_PROPOSAL_FIELDS = [
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
] as const;
const EVIDENCE_FIELDS = ["sourceRecordIds"] as const;

type CandidateProposalField = typeof PROPOSAL_FIELDS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function invalid(message: string): never {
  throw new Error(`Invalid strategy revision Candidate: ${message}`);
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    return invalid(`${field} must be at most ${maxLength} characters.`);
  }
  return value;
}

function boundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  minItems = 0,
): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    return invalid(`${field} must contain between ${minItems} and ${maxItems} items.`);
  }
  return value.map((item, index) =>
    boundedString(item, `${field}[${index}]`, MAX_CANDIDATE_GUIDANCE_LENGTH));
}

function exactProposalFields(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  const expected = [...PROPOSAL_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid(`input must contain only ${PROPOSAL_FIELDS.join(", ")}.`);
  }
}

/** Validate and defensively copy only the bounded model-authored proposal fields. */
export function validateStrategyCandidateProposal(
  value: unknown,
): StrategyCandidateProposal {
  if (!isRecord(value)) return invalid("proposal fields are required.");
  exactProposalFields(value);
  const sourceRecordIds = boundedStringArray(
    value.sourceRecordIds,
    "sourceRecordIds",
    MAX_ADAPTATION_PACKET_RUNS,
    2,
  );
  if (new Set(sourceRecordIds).size !== sourceRecordIds.length) {
    return invalid("sourceRecordIds must be unique.");
  }
  sourceRecordIds.forEach((id, index) => {
    if (id.length > MAX_CANDIDATE_SOURCE_RECORD_ID_LENGTH) {
      invalid(`sourceRecordIds[${index}] must be at most ${MAX_CANDIDATE_SOURCE_RECORD_ID_LENGTH} characters.`);
    }
  });
  return Object.freeze({
    summary: boundedString(value.summary, "summary", MAX_CANDIDATE_SUMMARY_LENGTH),
    useWhen: Object.freeze(boundedStringArray(value.useWhen, "useWhen", MAX_CANDIDATE_GUIDANCE_ITEMS, 1)),
    avoidWhen: Object.freeze(boundedStringArray(value.avoidWhen, "avoidWhen", MAX_CANDIDATE_GUIDANCE_ITEMS)),
    principles: Object.freeze(boundedStringArray(value.principles, "principles", MAX_CANDIDATE_GUIDANCE_ITEMS, 1)),
    sourceRecordIds: Object.freeze(sourceRecordIds),
    hypothesis: boundedString(value.hypothesis, "hypothesis", MAX_CANDIDATE_HYPOTHESIS_LENGTH),
  });
}

function strategySemanticsEqual(
  left: StrategyRevisionCandidate["proposal"],
  right: ReturnType<typeof seedStrategySemantics>,
): boolean {
  return JSON.stringify(left) === JSON.stringify({
    summary: right.summary,
    useWhen: right.useWhen,
    avoidWhen: right.avoidWhen,
    principles: right.principles,
  });
}

/**
 * Validate one immutable schema-v1 Candidate artifact without repairing it.
 * The returned value is a defensive canonical copy and never contains a
 * derived fingerprint or runtime status field.
 */
export function validateStrategyRevisionCandidateArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyRevisionCandidate {
  if (!isRecord(value) || !hasExactFields(value, CANDIDATE_FIELDS)) {
    invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_CANDIDATE_SCHEMA_VERSION) {
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
  const createdAt = boundedString(value.createdAt, "createdAt", Number.MAX_SAFE_INTEGER);
  if (!isRecord(value.target) || !hasExactFields(value.target, TARGET_FIELDS)) {
    invalid("target fields are invalid.");
  }
  if (
    typeof value.target.strategyId !== "string" ||
    value.target.strategyId.trim() === "" ||
    (value.target.kind !== "approach" && value.target.kind !== "modifier") ||
    typeof value.target.baseFingerprint !== "string" ||
    value.target.baseFingerprint.trim() === ""
  ) {
    invalid("target identity is invalid.");
  }
  if (!isRecord(value.proposal) || !hasExactFields(value.proposal, ARTIFACT_PROPOSAL_FIELDS)) {
    invalid("proposal fields are invalid.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    invalid("evidence fields are invalid.");
  }

  const validatedProposal = validateStrategyCandidateProposal({
    summary: value.proposal.summary,
    useWhen: value.proposal.useWhen,
    avoidWhen: value.proposal.avoidWhen,
    principles: value.proposal.principles,
    sourceRecordIds: value.evidence.sourceRecordIds,
    hypothesis: value.hypothesis,
  });
  const target = getSeedStrategy(value.target.strategyId);
  if (
    target === null ||
    target.kind !== value.target.kind ||
    value.target.baseFingerprint !== seedStrategyFingerprint(target)
  ) {
    invalid("target Strategy or immutable Seed binding is invalid.");
  }
  const proposal = {
    summary: validatedProposal.summary,
    useWhen: [...validatedProposal.useWhen],
    avoidWhen: [...validatedProposal.avoidWhen],
    principles: [...validatedProposal.principles],
  };
  if (strategySemanticsEqual(proposal, seedStrategySemantics(target))) {
    invalid("proposal must differ from the Seed Strategy semantics.");
  }

  return Object.freeze({
    schemaVersion: STRATEGY_CANDIDATE_SCHEMA_VERSION,
    candidateId: value.candidateId,
    createdAt,
    target: Object.freeze({
      strategyId: target.id,
      kind: target.kind,
      baseFingerprint: seedStrategyFingerprint(target),
    }),
    proposal: Object.freeze({
      summary: proposal.summary,
      useWhen: Object.freeze(proposal.useWhen),
      avoidWhen: Object.freeze(proposal.avoidWhen),
      principles: Object.freeze(proposal.principles),
    }),
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...validatedProposal.sourceRecordIds]),
    }),
    hypothesis: validatedProposal.hypothesis,
  });
}

/** Alias used by callers that treat the artifact as a parsed Candidate. */
export const parseStrategyRevisionCandidate = validateStrategyRevisionCandidateArtifact;

/**
 * Deterministic semantic fingerprint for a Candidate revision.
 * Timestamps, evidence provenance, and hypothesis prose are intentionally
 * outside this projection so they cannot change revision identity.
 */
export function strategyCandidateSemanticFingerprint(
  candidate: Pick<StrategyRevisionCandidate, "target" | "proposal">,
): string {
  const semanticProjection = {
    target: {
      strategyId: candidate.target.strategyId,
      kind: candidate.target.kind,
      baseFingerprint: candidate.target.baseFingerprint,
    },
    proposal: {
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    },
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(semanticProjection))
    .digest("hex")}`;
}

/** Short aliases for callers that name the artifact rather than its revision. */
export const strategyCandidateFingerprint = strategyCandidateSemanticFingerprint;
export const candidateSemanticFingerprint = strategyCandidateSemanticFingerprint;

/**
 * Represent a validated immutable Candidate as a revision selection. This is
 * only a data conversion for evaluation/tests; it does not activate the
 * Candidate or make it available to the model-facing policy tool.
 */
export function strategyRevisionSelectionFromCandidate(
  candidate: StrategyRevisionCandidate,
  status: Exclude<StrategyRevisionStatusAtRun, "seed">,
): StrategyRevisionSelection {
  const validatedCandidate = validateStrategyRevisionCandidateArtifact(candidate);
  const fingerprint = strategyCandidateSemanticFingerprint(validatedCandidate);
  return createStrategyRevisionSelection({
    strategyId: validatedCandidate.target.strategyId,
    kind: validatedCandidate.target.kind,
    revisionIdentity: validatedCandidate.candidateId,
    revisionFingerprint: fingerprint,
    revisionStatusAtRun: status,
    semantics: {
      summary: validatedCandidate.proposal.summary,
      useWhen: [...validatedCandidate.proposal.useWhen],
      avoidWhen: [...validatedCandidate.proposal.avoidWhen],
      principles: [...validatedCandidate.proposal.principles],
    },
  });
}

export function isCanonicalStrategyCandidateId(value: string): boolean {
  return CANONICAL_CANDIDATE_ID.test(value);
}

function truncateCandidateCommandLabel(value: string, maxLength = MAX_CANDIDATE_COMMAND_LABEL_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export interface CandidateCommandLabelOptions {
  /** Add a short machine-ID suffix only when a caller has a display collision. */
  readonly includeCandidateId?: boolean;
  /** Internal presentation seam for extending a colliding suffix deterministically. */
  readonly candidateIdLength?: number;
  /** Optional smaller bound when a lifecycle hint must share the label. */
  readonly maxLength?: number;
}

/** Format one bounded human-facing Candidate label without changing its identity. */
export function formatCandidateCommandLabel(
  candidate: Pick<StrategyRevisionCandidate, "candidateId" | "target" | "proposal">,
  options: CandidateCommandLabelOptions = {},
): string {
  const summary = candidate.proposal.summary.replace(/\s+/gu, " ").trim();
  const maxLength = Math.min(
    MAX_CANDIDATE_COMMAND_LABEL_LENGTH,
    Math.max(1, options.maxLength ?? MAX_CANDIDATE_COMMAND_LABEL_LENGTH),
  );
  const suffixLength = Math.max(1, options.candidateIdLength ?? 8);
  const base = truncateCandidateCommandLabel(
    `${candidate.target.strategyId} · ${summary}`,
    options.includeCandidateId
      ? Math.max(1, maxLength - 3 - suffixLength)
      : maxLength,
  );
  if (!options.includeCandidateId) return base;
  const suffix = ` · ${candidate.candidateId.slice(0, suffixLength)}`;
  return truncateCandidateCommandLabel(`${base}${suffix}`, maxLength);
}

/** Construct an immutable Candidate bound to the current immutable Seed baseline. */
export function createStrategyRevisionCandidate(
  input: CreateStrategyRevisionCandidateInput,
): StrategyRevisionCandidate {
  const target = getSeedStrategy(input.target.id);
  if (target === null || target.kind !== input.target.kind) {
    invalid("target must be an existing Seed Strategy with its canonical kind.");
  }
  const proposal = validateStrategyCandidateProposal(input.proposal);
  const normalizedSeed = seedStrategySemantics(target);
  const normalizedProposal = {
    summary: proposal.summary,
    useWhen: [...proposal.useWhen],
    avoidWhen: [...proposal.avoidWhen],
    principles: [...proposal.principles],
  };
  if (strategySemanticsEqual(normalizedProposal, normalizedSeed)) {
    invalid("proposal must differ from the Seed Strategy semantics.");
  }

  const candidateId = (input.candidateId ?? randomUUID()).toLowerCase();
  if (!isCanonicalStrategyCandidateId(candidateId)) {
    invalid("candidateId must be a lowercase UUID-v4.");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    invalid("createdAt must be a non-empty string.");
  }

  const targetRecord = Object.freeze({
    strategyId: target.id,
    kind: target.kind,
    baseFingerprint: seedStrategyFingerprint(target),
  });
  const proposalRecord = Object.freeze({
    summary: normalizedProposal.summary,
    useWhen: Object.freeze(normalizedProposal.useWhen),
    avoidWhen: Object.freeze(normalizedProposal.avoidWhen),
    principles: Object.freeze(normalizedProposal.principles),
  });

  return Object.freeze({
    schemaVersion: STRATEGY_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    createdAt,
    target: targetRecord,
    proposal: proposalRecord,
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...proposal.sourceRecordIds]),
    }),
    hypothesis: proposal.hypothesis,
  });
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Durable, project-local storage for immutable Candidates. */
export class FileStrategyCandidateStore implements StrategyCandidateStore, StrategyCandidateReader {
  private readonly baseDir: string;

  constructor(options: FileStrategyCandidateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  private async readFromDirectory(
    directory: string,
    candidateId: string,
  ): Promise<StrategyRevisionCandidate | null> {
    // Validate before constructing the Candidate file path. Do not normalize
    // malformed or uppercase IDs into a different artifact lookup.
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    const candidatePath = join(directory, `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(candidatePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(
        `Could not read Pindie Strategy Revision Candidate file '${candidatePath}': ${errorMessage(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `Could not read Pindie Strategy Revision Candidate file '${candidatePath}': invalid JSON (${errorMessage(error)}).`,
      );
    }
    try {
      return validateStrategyRevisionCandidateArtifact(parsed, candidateId);
    } catch (error) {
      throw new Error(
        `Could not read Pindie Strategy Revision Candidate file '${candidatePath}': ${errorMessage(error)}`,
      );
    }
  }

  private async readAllFromDirectory(
    directory: string,
  ): Promise<readonly StrategyRevisionCandidate[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(
        `Could not read Pindie Strategy Revision Candidate directory '${directory}': ${errorMessage(error)}`,
      );
    }

    const candidates: StrategyRevisionCandidate[] = [];
    for (const entry of entries
      .filter((candidate) => candidate.isFile() && CANONICAL_CANDIDATE_FILE.test(candidate.name))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const candidateId = entry.name.slice(0, -".json".length);
      const candidate = await this.readFromDirectory(directory, candidateId);
      if (candidate === null) {
        throw new Error(
          `Could not read Pindie Strategy Revision Candidate file '${join(directory, entry.name)}': the artifact disappeared while reading.`,
        );
      }
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  async read(
    projectRoot: string,
    candidateId: string,
  ): Promise<StrategyRevisionCandidate | null> {
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(this.strategyCandidateDirectory(projectRoot), candidateId);
  }

  /** Read one Candidate directly from a canonical project namespace. */
  async readProjectId(
    projectId: string,
    candidateId: string,
  ): Promise<StrategyRevisionCandidate | null> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Revision Candidate: projectId must be canonical.");
    }
    if (!isCanonicalStrategyCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Revision Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(this.strategyCandidateDirectoryForProjectId(projectId), candidateId);
  }

  async readAll(projectRoot: string): Promise<readonly StrategyRevisionCandidate[]> {
    return this.readAllFromDirectory(this.strategyCandidateDirectory(projectRoot));
  }

  /** Read every Candidate directly from a canonical project namespace. */
  async readAllProjectId(projectId: string): Promise<readonly StrategyRevisionCandidate[]> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Revision Candidates: projectId must be canonical.");
    }
    return this.readAllFromDirectory(this.strategyCandidateDirectoryForProjectId(projectId));
  }

  async save(projectRoot: string, candidate: StrategyRevisionCandidate): Promise<void> {
    const directory = this.strategyCandidateDirectory(projectRoot);
    const candidatePath = join(directory, `${candidate.candidateId}.json`);
    const temporaryPath = join(directory, `.${candidate.candidateId}.json.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      // A pre-existing ID is historical data, never a mutable Candidate update.
      try {
        await readFile(candidatePath);
        throw new Error("Candidate file already exists.");
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await writeFile(
        temporaryPath,
        `${JSON.stringify(candidate, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryPath, candidatePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Could not save Pindie Strategy Revision Candidate file '${candidatePath}': ${errorMessage(error)}`,
      );
    }
  }

  strategyCandidateDirectory(projectRoot: string): string {
    return this.strategyCandidateDirectoryForProjectId(getProjectId(projectRoot));
  }

  strategyCandidateDirectoryForProjectId(projectId: string): string {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Strategy Revision Candidate namespace requires a canonical project identity.");
    }
    return join(this.baseDir, projectId, STRATEGY_CANDIDATE_DIRECTORY_NAME);
  }
}
