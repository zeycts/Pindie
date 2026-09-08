import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeCrossProjectExperienceRefs,
  compareCrossProjectExperienceRefs,
  MAX_CROSS_PROJECT_EXPERIENCE_REFS,
  type CrossProjectExperienceRefV1,
  validateCrossProjectExperienceRefArtifact,
} from "./cross-project-experience.ts";
import {
  isCanonicalStrategyTrustScopeCandidateId,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";

export const STRATEGY_TRUST_SCOPE_DECISION_SCHEMA_VERSION = 1 as const;
export const STRATEGY_SCOPE_DECISION_DIRECTORY_NAME = "strategy-scope-decisions";
export const MAX_STRATEGY_TRUST_SCOPE_DECISION_TIMESTAMP_LENGTH = 64;

export type StrategyTrustScopeDecisionTerminal = "promoted" | "rejected";

export interface StrategyTrustScopeDecisionV1 {
  readonly schemaVersion: typeof STRATEGY_TRUST_SCOPE_DECISION_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly decidedAt: string;
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  readonly currentTrustScope: "project";
  readonly proposedTrustScope: "user-global";
  readonly decision: StrategyTrustScopeDecisionTerminal;
  readonly evidence: {
    readonly trialRefs: readonly CrossProjectExperienceRefV1[];
  };
}

export type StrategyTrustScopeDecision = StrategyTrustScopeDecisionV1;

export interface CreateStrategyTrustScopeDecisionInput {
  readonly candidate: StrategyTrustScopeCandidateV1;
  readonly decision: StrategyTrustScopeDecisionTerminal;
  readonly trialRefs: readonly CrossProjectExperienceRefV1[];
  /** Optional test seam; the Harness owns the runtime timestamp. */
  readonly decidedAt?: string;
}

export interface StrategyTrustScopeDecisionReader {
  read(candidateId: string): Promise<StrategyTrustScopeDecisionV1 | null>;
  readAll(): Promise<readonly StrategyTrustScopeDecisionV1[]>;
}

export interface StrategyTrustScopeDecisionStore extends StrategyTrustScopeDecisionReader {
  save(decision: StrategyTrustScopeDecisionV1): Promise<void>;
}

export interface FileStrategyTrustScopeDecisionStoreOptions {
  /** User-global root, normally ~/.pindie/global. */
  baseDir?: string;
}

const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const DECISION_FIELDS = [
  "schemaVersion",
  "candidateId",
  "candidateFingerprint",
  "decidedAt",
  "sourceStrategy",
  "currentTrustScope",
  "proposedTrustScope",
  "decision",
  "evidence",
] as const;
const EVIDENCE_FIELDS = ["trialRefs"] as const;
const CANONICAL_DECISION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

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

function invalid(message: string): never {
  throw new Error(`Invalid Strategy Trust Scope Decision: ${message}`);
}

function invalidBinding(message: string): never {
  throw new Error(`Invalid Strategy Trust Scope Decision binding: ${message}`);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) return invalid(`${field} must be at most ${maxLength} characters.`);
  return value;
}

function validateTimestamp(value: unknown): string {
  const timestamp = boundedString(value, "decidedAt", MAX_STRATEGY_TRUST_SCOPE_DECISION_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(timestamp))) return invalid("decidedAt must be a valid timestamp.");
  return timestamp;
}

function validateRefs(
  value: unknown,
  decision: StrategyTrustScopeDecisionTerminal,
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
    const order = compareCrossProjectExperienceRefs(refs[index - 1]!, refs[index]!);
    if (order >= 0) {
      return invalid("evidence.trialRefs must be unique and sorted by projectId, recordId, and recordFingerprint.");
    }
  }
  if (decision === "promoted") {
    if (refs.length < 2) return invalid("promoted Decisions require at least two trialRefs.");
    if (new Set(refs.map((ref) => ref.projectId)).size < 2) {
      return invalid("promoted Decisions require trialRefs from at least two distinct target projects.");
    }
  }
  return Object.freeze(refs);
}

/** Validate one immutable schema-v1 Decision's exact structure. */
export function validateStrategyTrustScopeDecisionArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyTrustScopeDecisionV1 {
  if (!isRecord(value) || !hasExactFields(value, DECISION_FIELDS)) {
    return invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_TRUST_SCOPE_DECISION_SCHEMA_VERSION) {
    return invalid("schemaVersion must be 1.");
  }
  if (
    typeof value.candidateId !== "string" ||
    !isCanonicalStrategyTrustScopeCandidateId(value.candidateId)
  ) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  const candidateId = value.candidateId;
  if (requestedCandidateId !== undefined && candidateId !== requestedCandidateId) {
    return invalid("requested Candidate ID does not match artifact candidateId.");
  }
  if (
    typeof value.candidateFingerprint !== "string" ||
    !CANONICAL_FINGERPRINT.test(value.candidateFingerprint)
  ) return invalid("candidateFingerprint must be a lowercase SHA-256 fingerprint.");
  const decidedAt = validateTimestamp(value.decidedAt);
  const sourceStrategy = validateStrategyTrustScopeSourceStrategy(value.sourceStrategy);
  if (value.currentTrustScope !== "project") return invalid("currentTrustScope must be project.");
  if (value.proposedTrustScope !== "user-global") return invalid("proposedTrustScope must be user-global.");
  if (value.decision !== "promoted" && value.decision !== "rejected") {
    return invalid("decision must be promoted or rejected.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    return invalid("evidence fields are invalid.");
  }
  const trialRefs = validateRefs(value.evidence.trialRefs, value.decision);
  return Object.freeze({
    schemaVersion: STRATEGY_TRUST_SCOPE_DECISION_SCHEMA_VERSION,
    candidateId,
    candidateFingerprint: value.candidateFingerprint,
    decidedAt,
    sourceStrategy,
    currentTrustScope: "project",
    proposedTrustScope: "user-global",
    decision: value.decision,
    evidence: Object.freeze({ trialRefs }),
  });
}

export const parseStrategyTrustScopeDecision = validateStrategyTrustScopeDecisionArtifact;
export const validateStrategyTrustScopeDecision = validateStrategyTrustScopeDecisionArtifact;

/** Strictly bind a terminal Decision to the exact immutable Scope Candidate. */
export function validateStrategyTrustScopeDecisionBinding(
  decision: StrategyTrustScopeDecisionV1,
  candidate: StrategyTrustScopeCandidateV1,
): StrategyTrustScopeDecisionV1 {
  let validatedDecision: StrategyTrustScopeDecisionV1;
  try {
    validatedDecision = validateStrategyTrustScopeDecisionArtifact(
      decision,
      decision.candidateId,
    );
  } catch (error) {
    return invalidBinding(errorMessage(error));
  }
  let validatedCandidate: StrategyTrustScopeCandidateV1;
  try {
    validatedCandidate = validateStrategyTrustScopeCandidateArtifact(
      candidate,
      candidate.candidateId,
    );
  } catch (error) {
    return invalidBinding(`Candidate is invalid: ${errorMessage(error)}`);
  }
  const candidateFingerprint = strategyTrustScopeCandidateFingerprint(validatedCandidate);
  if (
    validatedDecision.candidateId !== validatedCandidate.candidateId ||
    validatedDecision.candidateFingerprint !== candidateFingerprint
  ) return invalidBinding("Candidate ID or scope-candidate fingerprint does not match the immutable Candidate.");
  if (
    JSON.stringify(validatedDecision.sourceStrategy) !== JSON.stringify(validatedCandidate.sourceStrategy) ||
    validatedDecision.currentTrustScope !== validatedCandidate.currentTrustScope ||
    validatedDecision.proposedTrustScope !== validatedCandidate.proposedTrustScope
  ) return invalidBinding("source Strategy identity or trust-scope transition does not match the immutable Candidate.");
  return validatedDecision;
}

/** Construct a frozen terminal Decision; no current evidence is resolved here. */
export function createStrategyTrustScopeDecision(
  input: CreateStrategyTrustScopeDecisionInput,
): StrategyTrustScopeDecisionV1 {
  let candidate: StrategyTrustScopeCandidateV1;
  try {
    candidate = validateStrategyTrustScopeCandidateArtifact(
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
  const decidedAt = validateTimestamp(input.decidedAt ?? new Date().toISOString());
  return Object.freeze({
    schemaVersion: STRATEGY_TRUST_SCOPE_DECISION_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    candidateFingerprint: strategyTrustScopeCandidateFingerprint(candidate),
    decidedAt,
    sourceStrategy: Object.freeze({ ...candidate.sourceStrategy }),
    currentTrustScope: "project",
    proposedTrustScope: "user-global",
    decision: input.decision,
    evidence: Object.freeze({ trialRefs: refs }),
  });
}

export const createStrategyTrustScopeDecisionV1 = createStrategyTrustScopeDecision;

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable user-global immutable Scope Decision storage. */
export class FileStrategyTrustScopeDecisionStore implements StrategyTrustScopeDecisionStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyTrustScopeDecisionStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
  }

  async read(candidateId: string): Promise<StrategyTrustScopeDecisionV1 | null> {
    if (!isCanonicalStrategyTrustScopeCandidateId(candidateId)) {
      throw new Error("Cannot read Strategy Trust Scope Decision: candidateId must be a canonical lowercase UUID-v4.");
    }
    const path = join(this.strategyScopeDecisionDirectory(), `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Strategy Trust Scope Decision file '${path}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Strategy Trust Scope Decision file '${path}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      return validateStrategyTrustScopeDecisionArtifact(parsed, candidateId);
    } catch (error) {
      throw new Error(`Could not read Strategy Trust Scope Decision file '${path}': ${errorMessage(error)}`);
    }
  }

  async readAll(): Promise<readonly StrategyTrustScopeDecisionV1[]> {
    const directory = this.strategyScopeDecisionDirectory();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Strategy Trust Scope Decision directory '${directory}': ${errorMessage(error)}`);
    }
    const decisions: StrategyTrustScopeDecisionV1[] = [];
    for (const entry of entries
      .filter((item) => item.isFile())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.name.endsWith(".json") && !CANONICAL_DECISION_FILE.test(entry.name)) {
        throw new Error(`Could not read Strategy Trust Scope Decision directory '${directory}': non-canonical JSON artifact '${entry.name}'.`);
      }
      if (!CANONICAL_DECISION_FILE.test(entry.name)) continue;
      const candidateId = entry.name.slice(0, -".json".length);
      const decision = await this.read(candidateId);
      if (decision === null) {
        throw new Error(`Could not read Strategy Trust Scope Decision file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      }
      decisions.push(decision);
    }
    return Object.freeze(decisions);
  }

  async save(decision: StrategyTrustScopeDecisionV1): Promise<void> {
    const validated = validateStrategyTrustScopeDecisionArtifact(decision, decision.candidateId);
    const directory = this.strategyScopeDecisionDirectory();
    const path = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // A hard-link create is atomic and cannot replace a terminal artifact.
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Could not save Strategy Trust Scope Decision file '${path}': terminal Decision already exists.`);
      }
      throw new Error(`Could not save Strategy Trust Scope Decision file '${path}': ${errorMessage(error)}`);
    }
  }

  strategyScopeDecisionDirectory(): string {
    return join(this.baseDir, STRATEGY_SCOPE_DECISION_DIRECTORY_NAME);
  }

  decisionDirectory(): string {
    return this.strategyScopeDecisionDirectory();
  }
}

export { FileStrategyTrustScopeDecisionStore as FileStrategyTrustScopeDecisionV1Store };
