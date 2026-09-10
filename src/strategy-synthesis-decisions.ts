import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeCrossProjectExperienceRefs,
  compareCrossProjectExperienceRefs,
  MAX_CROSS_PROJECT_EXPERIENCE_REFS,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import {
  isCanonicalStrategySynthesisCandidateId,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  validateStrategySynthesisCandidateArtifact,
  type StrategySynthesisCandidateReader,
  type StrategySynthesisCandidateV1,
} from "./strategy-synthesis-candidates.ts";

export const STRATEGY_SYNTHESIS_DECISION_SCHEMA_VERSION = 1 as const;
export const STRATEGY_SYNTHESIS_DECISION_DIRECTORY_NAME = "strategy-synthesis-decisions";
export const MAX_STRATEGY_SYNTHESIS_DECISION_TIMESTAMP_LENGTH = 64;

export type StrategySynthesisDecisionTerminal = "promoted" | "rejected";

/** The exact immutable terminal artifact for one Synthesis Candidate. */
export interface StrategySynthesisDecisionV1 {
  readonly schemaVersion: typeof STRATEGY_SYNTHESIS_DECISION_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly candidateArtifactFingerprint: string;
  readonly candidateSemanticFingerprint: string;
  readonly decidedAt: string;
  readonly decision: StrategySynthesisDecisionTerminal;
  readonly evidence: {
    readonly trialRefs: readonly CrossProjectExperienceRefV1[];
  };
}

export type StrategySynthesisDecision = StrategySynthesisDecisionV1;

export interface CreateStrategySynthesisDecisionInput {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly decision: StrategySynthesisDecisionTerminal;
  readonly trialRefs: readonly CrossProjectExperienceRefV1[];
  /** Harness-owned in production; injectable only for deterministic tests. */
  readonly decidedAt?: string;
}

export interface StrategySynthesisDecisionReader {
  read(candidateId: string): Promise<StrategySynthesisDecisionV1 | null>;
  readAll(): Promise<readonly StrategySynthesisDecisionV1[]>;
}

export interface StrategySynthesisDecisionStore extends StrategySynthesisDecisionReader {
  save(decision: StrategySynthesisDecisionV1): Promise<void>;
}

export interface FileStrategySynthesisDecisionStoreOptions {
  /** User-global root, normally ~/.pindie/global. */
  readonly baseDir?: string;
}

const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const CANONICAL_DECISION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const DECISION_FIELDS = [
  "schemaVersion",
  "candidateId",
  "candidateArtifactFingerprint",
  "candidateSemanticFingerprint",
  "decidedAt",
  "decision",
  "evidence",
] as const;
const EVIDENCE_FIELDS = ["trialRefs"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  return actual.length === fields.length && actual.every((field, index) => field === fields[index]);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): never {
  throw new Error(`Invalid Strategy Synthesis Decision: ${message}`);
}

function invalidBinding(message: string): never {
  throw new Error(`Invalid Strategy Synthesis Decision binding: ${message}`);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") return invalid(`${field} must be a non-empty string.`);
  if (value.length > maxLength) return invalid(`${field} must be at most ${maxLength} characters.`);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = boundedString(value, "decidedAt", MAX_STRATEGY_SYNTHESIS_DECISION_TIMESTAMP_LENGTH);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return invalid("decidedAt must be a valid timestamp.");
  let canonical: string;
  try {
    canonical = new Date(parsed).toISOString();
  } catch (error) {
    return invalid(`decidedAt must be a valid timestamp (${errorMessage(error)}).`);
  }
  if (canonical !== timestamp) {
    return invalid("decidedAt must use the canonical ISO representation emitted by Pindie.");
  }
  return timestamp;
}

function validateFingerprint(value: unknown, field: string): string {
  if (typeof value !== "string" || !CANONICAL_FINGERPRINT.test(value)) {
    return invalid(`${field} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function validateRefs(
  value: unknown,
  decision: StrategySynthesisDecisionTerminal,
): readonly CrossProjectExperienceRefV1[] {
  if (!Array.isArray(value) || value.length > MAX_CROSS_PROJECT_EXPERIENCE_REFS) {
    return invalid(`evidence.trialRefs must contain between 0 and ${MAX_CROSS_PROJECT_EXPERIENCE_REFS} items.`);
  }
  const refs = value.map((ref, index) => {
    try {
      return validateCrossProjectExperienceRefArtifact(ref);
    } catch (error) {
      return invalid(`evidence.trialRefs[${index}] is invalid: ${errorMessage(error)}`);
    }
  });
  for (let index = 1; index < refs.length; index += 1) {
    if (compareCrossProjectExperienceRefs(refs[index - 1]!, refs[index]!) >= 0) {
      return invalid("evidence.trialRefs must be unique and sorted by projectId, recordId, and recordFingerprint.");
    }
  }
  if (decision === "promoted") {
    if (refs.length < 2) return invalid("promoted Decisions require at least two trialRefs.");
    if (new Set(refs.map((ref) => ref.projectId)).size < 2) {
      return invalid("promoted Decisions require trialRefs from at least two distinct target projects.");
    }
  }
  return Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));
}

/** Validate one strict schema-v1 artifact without live reads or repair. */
export function validateStrategySynthesisDecisionArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategySynthesisDecisionV1 {
  if (!isRecord(value) || !hasExactFields(value, DECISION_FIELDS)) return invalid("artifact fields are invalid.");
  if (value.schemaVersion !== STRATEGY_SYNTHESIS_DECISION_SCHEMA_VERSION) return invalid("schemaVersion must be 1.");
  if (typeof value.candidateId !== "string" || !isCanonicalStrategySynthesisCandidateId(value.candidateId)) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  if (requestedCandidateId !== undefined && value.candidateId !== requestedCandidateId) {
    return invalid("requested Candidate ID does not match artifact candidateId.");
  }
  const candidateId = value.candidateId;
  const candidateArtifactFingerprint = validateFingerprint(
    value.candidateArtifactFingerprint,
    "candidateArtifactFingerprint",
  );
  const candidateSemanticFingerprint = validateFingerprint(
    value.candidateSemanticFingerprint,
    "candidateSemanticFingerprint",
  );
  const decidedAt = canonicalTimestamp(value.decidedAt);
  if (value.decision !== "promoted" && value.decision !== "rejected") {
    return invalid("decision must be promoted or rejected.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    return invalid("evidence fields are invalid.");
  }
  const trialRefs = validateRefs(value.evidence.trialRefs, value.decision);
  return Object.freeze({
    schemaVersion: STRATEGY_SYNTHESIS_DECISION_SCHEMA_VERSION,
    candidateId,
    candidateArtifactFingerprint,
    candidateSemanticFingerprint,
    decidedAt,
    decision: value.decision,
    evidence: Object.freeze({ trialRefs }),
  });
}

export const parseStrategySynthesisDecision = validateStrategySynthesisDecisionArtifact;
export const validateStrategySynthesisDecision = validateStrategySynthesisDecisionArtifact;

/** Bind both provenance and semantic fingerprints to one exact Candidate. */
export function validateStrategySynthesisDecisionBinding(
  decision: StrategySynthesisDecisionV1,
  candidate: StrategySynthesisCandidateV1,
): StrategySynthesisDecisionV1 {
  let validatedDecision: StrategySynthesisDecisionV1;
  try {
    validatedDecision = validateStrategySynthesisDecisionArtifact(decision, decision.candidateId);
  } catch (error) {
    return invalidBinding(errorMessage(error));
  }
  let validatedCandidate: StrategySynthesisCandidateV1;
  try {
    validatedCandidate = validateStrategySynthesisCandidateArtifact(candidate, candidate.candidateId);
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  const candidateArtifactFingerprint = strategySynthesisCandidateArtifactFingerprint(validatedCandidate);
  const candidateSemanticFingerprint = strategySynthesisCandidateSemanticFingerprint(validatedCandidate);
  if (
    validatedDecision.candidateId !== validatedCandidate.candidateId ||
    validatedDecision.candidateArtifactFingerprint !== candidateArtifactFingerprint ||
    validatedDecision.candidateSemanticFingerprint !== candidateSemanticFingerprint
  ) {
    return invalidBinding("Candidate ID or immutable Candidate fingerprint does not match.");
  }
  return validatedDecision;
}

/** Construct a frozen terminal artifact; current Trial facts are checked by review. */
export function createStrategySynthesisDecision(
  input: CreateStrategySynthesisDecisionInput,
): StrategySynthesisDecisionV1 {
  let candidate: StrategySynthesisCandidateV1;
  try {
    candidate = validateStrategySynthesisCandidateArtifact(
      input.candidate,
      input.candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  if (input.decision !== "promoted" && input.decision !== "rejected") {
    return invalid("decision must be promoted or rejected.");
  }
  let refs: readonly CrossProjectExperienceRefV1[];
  try {
    refs = canonicalizeCrossProjectExperienceRefs(input.trialRefs);
  } catch (error) {
    return invalid(errorMessage(error));
  }
  if (refs.length > MAX_CROSS_PROJECT_EXPERIENCE_REFS) {
    return invalid(`evidence.trialRefs must contain at most ${MAX_CROSS_PROJECT_EXPERIENCE_REFS} items.`);
  }
  if (input.decision === "promoted") {
    if (refs.length < 2) return invalid("promoted Decisions require at least two trialRefs.");
    if (new Set(refs.map((ref) => ref.projectId)).size < 2) {
      return invalid("promoted Decisions require trialRefs from at least two distinct target projects.");
    }
  }
  const decision = {
    schemaVersion: STRATEGY_SYNTHESIS_DECISION_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    candidateArtifactFingerprint: strategySynthesisCandidateArtifactFingerprint(candidate),
    candidateSemanticFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
    decidedAt: canonicalTimestamp(input.decidedAt ?? new Date().toISOString()),
    decision: input.decision,
    evidence: { trialRefs: [...refs] },
  } satisfies StrategySynthesisDecisionV1;
  return validateStrategySynthesisDecisionArtifact(decision, candidate.candidateId);
}

export const createStrategySynthesisDecisionV1 = createStrategySynthesisDecision;

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable user-global immutable Synthesis Decision storage. */
export class FileStrategySynthesisDecisionStore implements StrategySynthesisDecisionStore {
  private readonly baseDir: string;

  constructor(options: FileStrategySynthesisDecisionStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
  }

  async read(candidateId: string): Promise<StrategySynthesisDecisionV1 | null> {
    if (!isCanonicalStrategySynthesisCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Synthesis Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    const path = join(this.strategySynthesisDecisionDirectory(), `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Strategy Synthesis Decision file '${path}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Strategy Synthesis Decision file '${path}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      return validateStrategySynthesisDecisionArtifact(parsed, candidateId);
    } catch (error) {
      throw new Error(`Could not read Strategy Synthesis Decision file '${path}': ${errorMessage(error)}`);
    }
  }

  async readAll(): Promise<readonly StrategySynthesisDecisionV1[]> {
    const directory = this.strategySynthesisDecisionDirectory();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Strategy Synthesis Decision directory '${directory}': ${errorMessage(error)}`);
    }
    const decisions: StrategySynthesisDecisionV1[] = [];
    for (const entry of entries
      .filter((item) => item.isFile())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.name.endsWith(".json") && !CANONICAL_DECISION_FILE.test(entry.name)) {
        throw new Error(`Could not read Strategy Synthesis Decision directory '${directory}': non-canonical JSON artifact '${entry.name}'.`);
      }
      if (!CANONICAL_DECISION_FILE.test(entry.name)) continue;
      const candidateId = entry.name.slice(0, -".json".length);
      const decision = await this.read(candidateId);
      if (decision === null) {
        throw new Error(`Could not read Strategy Synthesis Decision file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      }
      decisions.push(decision);
    }
    return Object.freeze(decisions);
  }

  async save(decision: StrategySynthesisDecisionV1): Promise<void> {
    const validated = validateStrategySynthesisDecisionArtifact(decision, decision.candidateId);
    const directory = this.strategySynthesisDecisionDirectory();
    const path = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      // Hard-link publication is atomic and cannot replace a terminal artifact.
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Could not save Strategy Synthesis Decision file '${path}': terminal Decision already exists.`);
      }
      throw new Error(`Could not save Strategy Synthesis Decision file '${path}': ${errorMessage(error)}`);
    }
  }

  strategySynthesisDecisionDirectory(): string {
    return join(this.baseDir, STRATEGY_SYNTHESIS_DECISION_DIRECTORY_NAME);
  }

  decisionDirectory(): string {
    return this.strategySynthesisDecisionDirectory();
  }
}

export { FileStrategySynthesisDecisionStore as FileStrategySynthesisDecisionV1Store };

/** Read terminal Synthesis artifacts without enumerating inactive Candidates. */
export interface SynthesisTrialGlobalArtifacts {
  readonly decisions: readonly StrategySynthesisDecisionV1[];
  readonly candidates: readonly StrategySynthesisCandidateV1[];
}

/**
 * The durable global trust projection only needs Candidates referenced by a
 * terminal Decision. A malformed unrelated inactive Candidate therefore does
 * not poison ordinary trust reconstruction.
 */
export async function readSynthesisTrialGlobalArtifacts(
  candidateReader: StrategySynthesisCandidateReader,
  decisionReader: StrategySynthesisDecisionReader,
): Promise<SynthesisTrialGlobalArtifacts> {
  const rawDecisions = await decisionReader.readAll();
  if (!Array.isArray(rawDecisions)) throw new Error("Global Synthesis Decision reader returned an invalid collection.");
  const decisionsById = new Map<string, StrategySynthesisDecisionV1>();
  const candidates: StrategySynthesisCandidateV1[] = [];
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategySynthesisDecisionArtifact(rawDecision, rawDecision.candidateId);
    if (decisionsById.has(decision.candidateId)) {
      throw new Error(`Duplicate global Synthesis Decisions exist for '${decision.candidateId}'.`);
    }
    const candidate = await candidateReader.read(decision.candidateId);
    if (candidate === null) {
      throw new Error(`Global Synthesis Decision '${decision.candidateId}' is missing its immutable Candidate.`);
    }
    const validatedCandidate = validateStrategySynthesisCandidateArtifact(candidate, decision.candidateId);
    validateStrategySynthesisDecisionBinding(decision, validatedCandidate);
    decisionsById.set(decision.candidateId, decision);
    candidates.push(validatedCandidate);
  }
  const decisions = [...decisionsById.values()].sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
  candidates.sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
  return Object.freeze({
    decisions: Object.freeze(decisions),
    candidates: Object.freeze(candidates),
  });
}

export const readStrategySynthesisTrialGlobalArtifacts = readSynthesisTrialGlobalArtifacts;