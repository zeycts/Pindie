import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isCanonicalStrategyDerivationCandidateId,
  LOGICAL_STRATEGY_ID_PATTERN,
  MAX_DERIVED_STRATEGY_ID_LENGTH,
} from "./strategy-derivation-candidates.ts";

export const STRATEGY_TRUST_SCOPE_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const STRATEGY_SCOPE_CANDIDATE_DIRECTORY_NAME = "strategy-scope-candidates";
export const MAX_STRATEGY_TRUST_SCOPE_CANDIDATE_TIMESTAMP_LENGTH = 64;

export type StrategyTrustScope = "project" | "user-global";

export interface StrategyTrustScopeSourceStrategyV1 {
  readonly sourceProjectId: string;
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
}

export interface StrategyTrustScopeCandidateV1 {
  readonly schemaVersion: typeof STRATEGY_TRUST_SCOPE_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  readonly currentTrustScope: "project";
  readonly proposedTrustScope: "user-global";
}

export type StrategyTrustScopeCandidate = StrategyTrustScopeCandidateV1;
export type StrategyTrustScopeSourceStrategy = StrategyTrustScopeSourceStrategyV1;

export interface CreateStrategyTrustScopeCandidateInput {
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  /** Optional test seams; the Harness owns these values at runtime. */
  readonly candidateId?: string;
  readonly createdAt?: string;
}

export interface StrategyTrustScopeCandidateReader {
  read(candidateId: string): Promise<StrategyTrustScopeCandidateV1 | null>;
  readAll(): Promise<readonly StrategyTrustScopeCandidateV1[]>;
}

export interface StrategyTrustScopeCandidateStore extends StrategyTrustScopeCandidateReader {
  save(candidate: StrategyTrustScopeCandidateV1): Promise<void>;
}

export interface FileStrategyTrustScopeCandidateStoreOptions {
  /** User-global root, normally ~/.pindie/global. */
  baseDir?: string;
}

const CANONICAL_CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateId",
  "createdAt",
  "sourceStrategy",
  "currentTrustScope",
  "proposedTrustScope",
] as const;
const SOURCE_STRATEGY_FIELDS = [
  "sourceProjectId",
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
] as const;

type ScopeFingerprintInput = Pick<
  StrategyTrustScopeCandidateV1,
  "sourceStrategy" | "currentTrustScope" | "proposedTrustScope"
>;

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
  throw new Error(`Invalid Strategy Trust Scope Candidate: ${message}`);
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

function validateCandidateId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_CANDIDATE_ID.test(value)) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string {
  const timestamp = boundedString(value, field, MAX_STRATEGY_TRUST_SCOPE_CANDIDATE_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(timestamp))) return invalid(`${field} must be a valid timestamp.`);
  return timestamp;
}

export function isCanonicalStrategyTrustScopeCandidateId(value: string): boolean {
  return CANONICAL_CANDIDATE_ID.test(value);
}

export function isCanonicalStrategyTrustScopeProjectId(value: string): boolean {
  return CANONICAL_PROJECT_ID.test(value);
}

export function isCanonicalStrategyTrustScopeFingerprint(value: string): boolean {
  return CANONICAL_FINGERPRINT.test(value);
}

/** Validate the exact source identity carried by a Scope artifact. */
export function validateStrategyTrustScopeSourceStrategy(
  value: unknown,
): StrategyTrustScopeSourceStrategyV1 {
  if (!isRecord(value) || !hasExactFields(value, SOURCE_STRATEGY_FIELDS)) {
    return invalid("sourceStrategy fields are invalid.");
  }
  const sourceProjectId = value.sourceProjectId;
  if (typeof sourceProjectId !== "string" || !CANONICAL_PROJECT_ID.test(sourceProjectId)) {
    return invalid("sourceStrategy.sourceProjectId must be a canonical lowercase project identity.");
  }
  const strategyId = value.strategyId;
  if (
    typeof strategyId !== "string" ||
    strategyId.length < 1 ||
    strategyId.length > MAX_DERIVED_STRATEGY_ID_LENGTH ||
    strategyId.trim() !== strategyId ||
    !LOGICAL_STRATEGY_ID_PATTERN.test(strategyId)
  ) return invalid("sourceStrategy.strategyId must be lowercase ASCII kebab-case with 1..64 characters.");
  if (value.kind !== "approach" && value.kind !== "modifier") {
    return invalid("sourceStrategy.kind must be approach or modifier.");
  }
  if (
    typeof value.revisionIdentity !== "string" ||
    !isCanonicalStrategyDerivationCandidateId(value.revisionIdentity)
  ) return invalid("sourceStrategy.revisionIdentity must be a canonical lowercase UUID-v4.");
  if (
    typeof value.revisionFingerprint !== "string" ||
    !CANONICAL_FINGERPRINT.test(value.revisionFingerprint)
  ) return invalid("sourceStrategy.revisionFingerprint must be a lowercase SHA-256 fingerprint.");
  return Object.freeze({
    sourceProjectId,
    strategyId,
    kind: value.kind,
    revisionIdentity: value.revisionIdentity,
    revisionFingerprint: value.revisionFingerprint,
  });
}

function validateScopeTransition(value: ScopeFingerprintInput): ScopeFingerprintInput {
  if (value.currentTrustScope !== "project") {
    return invalid("currentTrustScope must be project.");
  }
  if (value.proposedTrustScope !== "user-global") {
    return invalid("proposedTrustScope must be user-global.");
  }
  return Object.freeze({
    sourceStrategy: validateStrategyTrustScopeSourceStrategy(value.sourceStrategy),
    currentTrustScope: "project",
    proposedTrustScope: "user-global",
  });
}

/**
 * Derive the immutable scope-hypothesis identity. Candidate occurrence and
 * creation time are intentionally excluded from this projection.
 */
export function strategyTrustScopeCandidateFingerprint(
  value: ScopeFingerprintInput,
): string {
  const validated = validateScopeTransition(value);
  const canonical = {
    fingerprintVersion: 1,
    sourceStrategy: {
      sourceProjectId: validated.sourceStrategy.sourceProjectId,
      strategyId: validated.sourceStrategy.strategyId,
      kind: validated.sourceStrategy.kind,
      revisionIdentity: validated.sourceStrategy.revisionIdentity,
      revisionFingerprint: validated.sourceStrategy.revisionFingerprint,
    },
    currentTrustScope: "project" as const,
    proposedTrustScope: "user-global" as const,
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

export const strategyTrustScopeFingerprint = strategyTrustScopeCandidateFingerprint;
export const scopeCandidateFingerprint = strategyTrustScopeCandidateFingerprint;

/** Validate one immutable exact-field Scope Candidate artifact without repair. */
export function validateStrategyTrustScopeCandidateArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyTrustScopeCandidateV1 {
  if (!isRecord(value) || !hasExactFields(value, CANDIDATE_FIELDS)) {
    return invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_TRUST_SCOPE_CANDIDATE_SCHEMA_VERSION) {
    return invalid("schemaVersion must be 1.");
  }
  const candidateId = validateCandidateId(value.candidateId);
  if (requestedCandidateId !== undefined && candidateId !== requestedCandidateId) {
    return invalid("requested Candidate ID does not match artifact candidateId.");
  }
  const createdAt = validateTimestamp(value.createdAt, "createdAt");
  const sourceStrategy = validateStrategyTrustScopeSourceStrategy(value.sourceStrategy);
  if (value.currentTrustScope !== "project") {
    return invalid("currentTrustScope must be project.");
  }
  if (value.proposedTrustScope !== "user-global") {
    return invalid("proposedTrustScope must be user-global.");
  }
  return Object.freeze({
    schemaVersion: STRATEGY_TRUST_SCOPE_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    createdAt,
    sourceStrategy,
    currentTrustScope: "project",
    proposedTrustScope: "user-global",
  });
}

export const parseStrategyTrustScopeCandidate = validateStrategyTrustScopeCandidateArtifact;
export const validateStrategyTrustScopeCandidate = validateStrategyTrustScopeCandidateArtifact;

/** Construct a frozen Scope Candidate from Harness-owned identity facts. */
export function createStrategyTrustScopeCandidate(
  input: CreateStrategyTrustScopeCandidateInput,
): StrategyTrustScopeCandidateV1 {
  const candidateId = validateCandidateId(input.candidateId ?? randomUUID());
  const createdAt = validateTimestamp(
    input.createdAt ?? new Date().toISOString(),
    "createdAt",
  );
  const sourceStrategy = validateStrategyTrustScopeSourceStrategy(input.sourceStrategy);
  return Object.freeze({
    schemaVersion: STRATEGY_TRUST_SCOPE_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    createdAt,
    sourceStrategy,
    currentTrustScope: "project",
    proposedTrustScope: "user-global",
  });
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable user-global immutable Scope Candidate storage. */
export class FileStrategyTrustScopeCandidateStore implements StrategyTrustScopeCandidateStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyTrustScopeCandidateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
  }

  async read(candidateId: string): Promise<StrategyTrustScopeCandidateV1 | null> {
    const validatedId = validateCandidateId(candidateId);
    const path = join(this.strategyScopeCandidateDirectory(), `${validatedId}.json`);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Strategy Trust Scope Candidate file '${path}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Strategy Trust Scope Candidate file '${path}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      return validateStrategyTrustScopeCandidateArtifact(parsed, validatedId);
    } catch (error) {
      throw new Error(`Could not read Strategy Trust Scope Candidate file '${path}': ${errorMessage(error)}`);
    }
  }

  async readAll(): Promise<readonly StrategyTrustScopeCandidateV1[]> {
    const directory = this.strategyScopeCandidateDirectory();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Strategy Trust Scope Candidate directory '${directory}': ${errorMessage(error)}`);
    }
    const candidates: StrategyTrustScopeCandidateV1[] = [];
    for (const entry of entries
      .filter((item) => item.isFile())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.name.endsWith(".json") && !CANONICAL_CANDIDATE_FILE.test(entry.name)) {
        throw new Error(`Could not read Strategy Trust Scope Candidate directory '${directory}': non-canonical JSON artifact '${entry.name}'.`);
      }
      if (!CANONICAL_CANDIDATE_FILE.test(entry.name)) continue;
      const candidateId = entry.name.slice(0, -".json".length);
      const candidate = await this.read(candidateId);
      if (candidate === null) {
        throw new Error(`Could not read Strategy Trust Scope Candidate file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      }
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  async save(candidate: StrategyTrustScopeCandidateV1): Promise<void> {
    const validated = validateStrategyTrustScopeCandidateArtifact(candidate, candidate.candidateId);
    const directory = this.strategyScopeCandidateDirectory();
    const path = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // A hard-link create is atomic and cannot replace an immutable artifact.
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Could not save Strategy Trust Scope Candidate file '${path}': Candidate file already exists.`);
      }
      throw new Error(`Could not save Strategy Trust Scope Candidate file '${path}': ${errorMessage(error)}`);
    }
  }

  strategyScopeCandidateDirectory(): string {
    return join(this.baseDir, STRATEGY_SCOPE_CANDIDATE_DIRECTORY_NAME);
  }

  candidateDirectory(): string {
    return this.strategyScopeCandidateDirectory();
  }
}

export { FileStrategyTrustScopeCandidateStore as FileStrategyTrustScopeCandidateV1Store };
