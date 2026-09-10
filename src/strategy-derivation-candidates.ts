import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  getProjectId,
} from "./store.ts";
import {
  MAX_TRUSTED_PORTFOLIO_ENTRIES,
  sameTrustedPortfolioSnapshot,
  trustedLogicalStrategyIds,
  trustedPortfolioFingerprint,
  type TrustedPortfolioManifestEntry,
  type TrustedPortfolioResolvedEntry,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import type { SeedStrategyKind } from "./strategies.ts";

export const STRATEGY_DERIVATION_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME = "strategy-derivation-candidates";
export const MAX_DERIVATION_CANDIDATE_SUMMARY_LENGTH = 512;
export const MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH = 256;
export const MAX_DERIVATION_CANDIDATE_HYPOTHESIS_LENGTH = 1024;
export const MAX_DERIVATION_CANDIDATE_SOURCE_RECORD_ID_LENGTH = 128;
export const MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS = 8;
export const MIN_DERIVATION_CANDIDATE_SOURCE_RECORDS = 3;
export const MAX_DERIVATION_CANDIDATE_SOURCE_RECORDS = 8;
export const MAX_DERIVATION_CANDIDATE_TIMESTAMP_LENGTH = 64;
export const MAX_DERIVED_STRATEGY_ID_LENGTH = 64;
export const LOGICAL_STRATEGY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const CANONICAL_CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateId",
  "createdAt",
  "projectId",
  "basePortfolio",
  "proposal",
  "evidence",
  "hypothesis",
] as const;
const BASE_PORTFOLIO_FIELDS = ["fingerprintVersion", "fingerprint", "entries"] as const;
const MANIFEST_ENTRY_FIELDS = [
  "origin",
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
] as const;
const PROPOSAL_FIELDS = [
  "strategyId",
  "kind",
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
] as const;
const EVIDENCE_FIELDS = ["sourceRecordIds"] as const;

export interface StrategyDerivationCandidateV1 {
  readonly schemaVersion: typeof STRATEGY_DERIVATION_CANDIDATE_SCHEMA_VERSION;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly projectId: string;
  readonly basePortfolio: {
    readonly fingerprintVersion: 1;
    readonly fingerprint: string;
    readonly entries: readonly TrustedPortfolioManifestEntry[];
  };
  readonly proposal: {
    readonly strategyId: string;
    readonly kind: SeedStrategyKind;
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

export type StrategyDerivationCandidate = StrategyDerivationCandidateV1;

export interface StrategyDerivationCandidateProposal {
  readonly strategyId: string;
  readonly kind: SeedStrategyKind;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly hypothesis: string;
}

export interface CreateStrategyDerivationCandidateInput {
  readonly projectId: string;
  readonly basePortfolio: TrustedStrategyPortfolio;
  readonly proposal: StrategyDerivationCandidateProposal;
  /** Optional seams for deterministic tests; runtime owns these values. */
  readonly candidateId?: string;
  readonly createdAt?: string;
}

export interface StrategyDerivationCandidateReader {
  read(projectRoot: string, candidateId: string): Promise<StrategyDerivationCandidateV1 | null>;
  readAll?(projectRoot: string): Promise<readonly StrategyDerivationCandidateV1[]>;
}

export interface StrategyDerivationCandidateStore extends StrategyDerivationCandidateReader {
  save(projectRoot: string, candidate: StrategyDerivationCandidateV1): Promise<void>;
}

export interface FileStrategyDerivationCandidateStoreOptions {
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
  throw new Error(`Invalid Strategy Derivation Candidate: ${message}`);
}

function invalidBinding(message: string): never {
  throw new Error(`Invalid Strategy Derivation Candidate binding: ${message}`);
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

function boundedGuidanceArray(
  value: unknown,
  field: string,
  minItems: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minItems ||
    value.length > MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS
  ) return invalid(`${field} must contain between ${minItems} and ${MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS} items.`);
  return Object.freeze(value.map((item, index) =>
    boundedString(item, `${field}[${index}]`, MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH)));
}

function validateLogicalStrategyId(value: unknown, field = "strategyId"): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_DERIVED_STRATEGY_ID_LENGTH ||
    value.trim() !== value ||
    !LOGICAL_STRATEGY_ID_PATTERN.test(value)
  ) return invalid(`${field} must be lowercase ASCII kebab-case with 1..${MAX_DERIVED_STRATEGY_ID_LENGTH} characters.`);
  return value;
}

function validateSourceRecordIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < MIN_DERIVATION_CANDIDATE_SOURCE_RECORDS ||
    value.length > MAX_DERIVATION_CANDIDATE_SOURCE_RECORDS
  ) return invalid(`sourceRecordIds must contain between ${MIN_DERIVATION_CANDIDATE_SOURCE_RECORDS} and ${MAX_DERIVATION_CANDIDATE_SOURCE_RECORDS} items.`);
  const ids = value.map((item, index) =>
    boundedString(item, `sourceRecordIds[${index}]`, MAX_DERIVATION_CANDIDATE_SOURCE_RECORD_ID_LENGTH));
  if (new Set(ids).size !== ids.length) return invalid("sourceRecordIds must be unique.");
  return Object.freeze(ids);
}

/** Validate only the eight model-owned Derivation proposal fields. */
export function validateStrategyDerivationCandidateProposal(
  value: unknown,
): StrategyDerivationCandidateProposal {
  if (!isRecord(value)) return invalid("proposal fields are required.");
  if (!hasExactFields(value, [...PROPOSAL_FIELDS, "sourceRecordIds", "hypothesis"])) {
    return invalid("input must contain only strategyId, kind, summary, useWhen, avoidWhen, principles, sourceRecordIds, and hypothesis.");
  }
  return Object.freeze({
    strategyId: validateLogicalStrategyId(value.strategyId),
    kind: value.kind === "approach" || value.kind === "modifier"
      ? value.kind
      : invalid("kind must be approach or modifier."),
    summary: boundedString(value.summary, "summary", MAX_DERIVATION_CANDIDATE_SUMMARY_LENGTH),
    useWhen: boundedGuidanceArray(value.useWhen, "useWhen", 1),
    avoidWhen: boundedGuidanceArray(value.avoidWhen, "avoidWhen", 0),
    principles: boundedGuidanceArray(value.principles, "principles", 1),
    sourceRecordIds: validateSourceRecordIds(value.sourceRecordIds),
    hypothesis: boundedString(value.hypothesis, "hypothesis", MAX_DERIVATION_CANDIDATE_HYPOTHESIS_LENGTH),
  });
}

export function isCanonicalStrategyDerivationCandidateId(value: string): boolean {
  return CANONICAL_CANDIDATE_ID.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestSortKey(entry: TrustedPortfolioManifestEntry): string {
  return [
    entry.origin,
    entry.strategyId,
    entry.kind,
    entry.revisionIdentity,
    entry.revisionFingerprint,
  ].join("\0");
}

function compareManifestEntries(
  left: TrustedPortfolioManifestEntry,
  right: TrustedPortfolioManifestEntry,
): number {
  return compareText(manifestSortKey(left), manifestSortKey(right));
}

function validateManifestEntry(
  value: unknown,
  field: string,
): TrustedPortfolioManifestEntry {
  if (!isRecord(value) || !hasExactFields(value, MANIFEST_ENTRY_FIELDS)) {
    return invalid(`${field} fields are invalid.`);
  }
  const origin = value.origin;
  if (
    origin !== "seed" &&
    origin !== "promoted-seed-revision" &&
    origin !== "promoted-derived"
  ) return invalid(`${field}.origin is invalid.`);
  const strategyId = validateLogicalStrategyId(value.strategyId, `${field}.strategyId`);
  if (value.kind !== "approach" && value.kind !== "modifier") {
    return invalid(`${field}.kind is invalid.`);
  }
  if (typeof value.revisionIdentity !== "string") {
    return invalid(`${field}.revisionIdentity is invalid.`);
  }
  if (
    origin === "seed"
      ? value.revisionIdentity !== "seed"
      : !CANONICAL_CANDIDATE_ID.test(value.revisionIdentity)
  ) return invalid(`${field}.revisionIdentity does not match its origin.`);
  if (typeof value.revisionFingerprint !== "string" || !CANONICAL_FINGERPRINT.test(value.revisionFingerprint)) {
    return invalid(`${field}.revisionFingerprint must be a lowercase SHA-256 fingerprint.`);
  }
  return Object.freeze({
    origin,
    strategyId,
    kind: value.kind,
    revisionIdentity: value.revisionIdentity,
    revisionFingerprint: value.revisionFingerprint,
  });
}

function validateBasePortfolio(
  value: unknown,
  projectId: string,
): StrategyDerivationCandidateV1["basePortfolio"] {
  if (!isRecord(value) || !hasExactFields(value, BASE_PORTFOLIO_FIELDS)) {
    return invalid("basePortfolio fields are invalid.");
  }
  if (value.fingerprintVersion !== 1) return invalid("basePortfolio.fingerprintVersion must be 1.");
  if (typeof value.fingerprint !== "string" || !CANONICAL_FINGERPRINT.test(value.fingerprint)) {
    return invalid("basePortfolio.fingerprint must be a lowercase SHA-256 fingerprint.");
  }
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES) {
    return invalid(`basePortfolio.entries must contain between 1 and ${MAX_TRUSTED_PORTFOLIO_ENTRIES} items.`);
  }
  const entries = value.entries.map((entry, index) =>
    validateManifestEntry(entry, `basePortfolio.entries[${index}]`));
  for (let index = 1; index < entries.length; index += 1) {
    if (compareManifestEntries(entries[index - 1]!, entries[index]!) >= 0) {
      return invalid("basePortfolio.entries must be in canonical order without duplicates.");
    }
  }
  const expectedFingerprint = trustedPortfolioFingerprint(projectId, entries);
  if (value.fingerprint !== expectedFingerprint) {
    return invalid("basePortfolio fingerprint does not match its project binding and canonical entries.");
  }
  return Object.freeze({
    fingerprintVersion: 1,
    fingerprint: value.fingerprint,
    entries: Object.freeze(entries),
  });
}

/** Validate one immutable v0.7 schema-v1 artifact without repair or normalization. */
export function validateStrategyDerivationCandidateArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategyDerivationCandidateV1 {
  if (!isRecord(value) || !hasExactFields(value, CANDIDATE_FIELDS)) {
    return invalid("artifact fields are invalid.");
  }
  if (value.schemaVersion !== STRATEGY_DERIVATION_CANDIDATE_SCHEMA_VERSION) {
    return invalid("schemaVersion must be 1.");
  }
  if (typeof value.candidateId !== "string" || !CANONICAL_CANDIDATE_ID.test(value.candidateId)) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  if (requestedCandidateId !== undefined && value.candidateId !== requestedCandidateId) {
    return invalid("requested Candidate ID does not match artifact candidateId.");
  }
  const createdAt = boundedString(value.createdAt, "createdAt", MAX_DERIVATION_CANDIDATE_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(createdAt))) return invalid("createdAt must be a valid timestamp.");
  if (typeof value.projectId !== "string" || !CANONICAL_PROJECT_ID.test(value.projectId)) {
    return invalid("projectId must be a canonical project identity.");
  }
  const basePortfolio = validateBasePortfolio(value.basePortfolio, value.projectId);
  if (!isRecord(value.proposal) || !hasExactFields(value.proposal, PROPOSAL_FIELDS)) {
    return invalid("proposal fields are invalid.");
  }
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) {
    return invalid("evidence fields are invalid.");
  }
  const proposal = validateStrategyDerivationCandidateProposal({
    strategyId: value.proposal.strategyId,
    kind: value.proposal.kind,
    summary: value.proposal.summary,
    useWhen: value.proposal.useWhen,
    avoidWhen: value.proposal.avoidWhen,
    principles: value.proposal.principles,
    sourceRecordIds: value.evidence.sourceRecordIds,
    hypothesis: value.hypothesis,
  });
  return Object.freeze({
    schemaVersion: 1,
    candidateId: value.candidateId,
    createdAt,
    projectId: value.projectId,
    basePortfolio,
    proposal: Object.freeze({
      strategyId: proposal.strategyId,
      kind: proposal.kind,
      summary: proposal.summary,
      useWhen: Object.freeze([...proposal.useWhen]),
      avoidWhen: Object.freeze([...proposal.avoidWhen]),
      principles: Object.freeze([...proposal.principles]),
    }),
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...proposal.sourceRecordIds]),
    }),
    hypothesis: proposal.hypothesis,
  });
}

export const parseStrategyDerivationCandidate = validateStrategyDerivationCandidateArtifact;

function semanticProjection(
  candidate: Pick<StrategyDerivationCandidateV1, "basePortfolio" | "proposal">,
): Record<string, unknown> {
  return {
    basePortfolioFingerprint: candidate.basePortfolio.fingerprint,
    proposal: {
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    },
  };
}

/** Deterministic semantic identity of a Derivation Candidate proposal. */
export function strategyDerivationCandidateSemanticFingerprint(
  candidate: Pick<StrategyDerivationCandidateV1, "basePortfolio" | "proposal">,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(semanticProjection(candidate)))
    .digest("hex")}`;
}

export const strategyDerivationCandidateFingerprint = strategyDerivationCandidateSemanticFingerprint;
export const derivationCandidateSemanticFingerprint = strategyDerivationCandidateSemanticFingerprint;

function proposalSemantics(
  proposal: Pick<StrategyDerivationCandidateProposal, "kind" | "summary" | "useWhen" | "avoidWhen" | "principles">,
): string {
  return JSON.stringify({
    kind: proposal.kind,
    summary: proposal.summary,
    useWhen: [...proposal.useWhen],
    avoidWhen: [...proposal.avoidWhen],
    principles: [...proposal.principles],
  });
}

/** Exact structural duplicate check against trusted immutable semantics only. */
export function hasExactTrustedStrategySemanticDuplicate(
  proposal: Pick<StrategyDerivationCandidateProposal, "kind" | "summary" | "useWhen" | "avoidWhen" | "principles">,
  portfolio: TrustedStrategyPortfolio,
): boolean {
  const proposed = proposalSemantics(proposal);
  return portfolio.resolvedEntries.some((entry) => proposalSemantics({
    kind: entry.manifest.kind,
    ...entry.semantics,
  }) === proposed);
}

export const isExactTrustedStrategySemanticDuplicate = hasExactTrustedStrategySemanticDuplicate;

/** Validate a Candidate against the current project and, when supplied, a fresh portfolio. */
export function validateStrategyDerivationCandidateBinding(
  candidate: StrategyDerivationCandidateV1,
  projectRoot: string,
  currentPortfolio?: TrustedStrategyPortfolio,
): StrategyDerivationCandidateV1 {
  return validateStrategyDerivationCandidateProjectIdBinding(
    candidate,
    getProjectId(projectRoot),
    currentPortfolio,
  );
}

/** Validate a Derived Candidate against a canonical project namespace without constructing a root. */
export function validateStrategyDerivationCandidateProjectIdBinding(
  candidate: StrategyDerivationCandidateV1,
  projectId: string,
  currentPortfolio?: TrustedStrategyPortfolio,
): StrategyDerivationCandidateV1 {
  if (typeof projectId !== "string" || !CANONICAL_PROJECT_ID.test(projectId)) {
    return invalidBinding("projectId must be a canonical project identity.");
  }
  let validated: StrategyDerivationCandidateV1;
  try {
    validated = validateStrategyDerivationCandidateArtifact(candidate, candidate.candidateId);
  } catch (error) {
    return invalidBinding(errorMessage(error));
  }
  if (validated.projectId !== projectId) {
    return invalidBinding("Candidate projectId does not match the addressed project namespace.");
  }
  if (currentPortfolio !== undefined && !sameTrustedPortfolioSnapshot(
    {
      projectId: validated.projectId,
      fingerprintVersion: validated.basePortfolio.fingerprintVersion,
      fingerprint: validated.basePortfolio.fingerprint,
      entries: validated.basePortfolio.entries,
    },
    currentPortfolio,
  )) {
    return invalidBinding("Candidate base portfolio does not match the current trusted portfolio.");
  }
  return validated;
}

/** Construct an immutable Candidate from Harness-owned project/portfolio facts. */
export function createStrategyDerivationCandidate(
  input: CreateStrategyDerivationCandidateInput,
): StrategyDerivationCandidateV1 {
  if (typeof input.projectId !== "string" || !CANONICAL_PROJECT_ID.test(input.projectId)) {
    return invalid("projectId must be a canonical project identity.");
  }
  const portfolio = input.basePortfolio;
  if (
    !isRecord(portfolio) ||
    portfolio.projectId !== input.projectId ||
    portfolio.fingerprintVersion !== 1
  ) return invalid("basePortfolio must be the current trusted portfolio for projectId.");
  const basePortfolio = validateBasePortfolio({
    fingerprintVersion: portfolio.fingerprintVersion,
    fingerprint: portfolio.fingerprint,
    entries: portfolio.entries,
  }, input.projectId);
  const proposal = validateStrategyDerivationCandidateProposal(input.proposal);
  if (trustedLogicalStrategyIds(portfolio).includes(proposal.strategyId)) {
    return invalid("proposal strategyId already belongs to a trusted logical Strategy.");
  }
  if (hasExactTrustedStrategySemanticDuplicate(proposal, portfolio)) {
    return invalid("proposal is an exact semantic duplicate of a trusted Strategy.");
  }
  const candidateId = (input.candidateId ?? randomUUID()).toLowerCase();
  if (!CANONICAL_CANDIDATE_ID.test(candidateId)) {
    return invalid("candidateId must be a canonical lowercase UUID-v4.");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (typeof createdAt !== "string" || createdAt.trim() === "" ||
    createdAt.length > MAX_DERIVATION_CANDIDATE_TIMESTAMP_LENGTH ||
    !Number.isFinite(Date.parse(createdAt))) {
    return invalid("createdAt must be a valid timestamp.");
  }
  return Object.freeze({
    schemaVersion: 1,
    candidateId,
    createdAt,
    projectId: input.projectId,
    basePortfolio,
    proposal: Object.freeze({
      strategyId: proposal.strategyId,
      kind: proposal.kind,
      summary: proposal.summary,
      useWhen: Object.freeze([...proposal.useWhen]),
      avoidWhen: Object.freeze([...proposal.avoidWhen]),
      principles: Object.freeze([...proposal.principles]),
    }),
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...proposal.sourceRecordIds]),
    }),
    hypothesis: proposal.hypothesis,
  });
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable project-local immutable storage for Derivation Candidates. */
export class FileStrategyDerivationCandidateStore implements StrategyDerivationCandidateStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyDerivationCandidateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
  }

  private async readFromDirectory(
    directory: string,
    projectId: string,
    candidateId: string,
  ): Promise<StrategyDerivationCandidateV1 | null> {
    if (!CANONICAL_CANDIDATE_ID.test(candidateId)) {
      throw new Error("Cannot read Strategy Derivation Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    const candidatePath = join(directory, `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(candidatePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Pindie Strategy Derivation Candidate file '${candidatePath}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Pindie Strategy Derivation Candidate file '${candidatePath}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      const candidate = validateStrategyDerivationCandidateArtifact(parsed, candidateId);
      return validateStrategyDerivationCandidateProjectIdBinding(candidate, projectId);
    } catch (error) {
      throw new Error(`Could not read Pindie Strategy Derivation Candidate file '${candidatePath}': ${errorMessage(error)}`);
    }
  }

  private async readAllFromDirectory(
    directory: string,
    projectId: string,
  ): Promise<readonly StrategyDerivationCandidateV1[]> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Pindie Strategy Derivation Candidate directory '${directory}': ${errorMessage(error)}`);
    }
    const candidates: StrategyDerivationCandidateV1[] = [];
    for (const entry of entries
      .filter((item) => item.isFile() && CANONICAL_CANDIDATE_FILE.test(item.name))
      .sort((left, right) => compareText(left.name, right.name))) {
      const candidateId = entry.name.slice(0, -".json".length);
      const candidate = await this.readFromDirectory(directory, projectId, candidateId);
      if (candidate === null) {
        throw new Error(`Could not read Pindie Strategy Derivation Candidate file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      }
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  async read(
    projectRoot: string,
    candidateId: string,
  ): Promise<StrategyDerivationCandidateV1 | null> {
    if (!CANONICAL_CANDIDATE_ID.test(candidateId)) {
      throw new Error("Cannot read Strategy Derivation Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(
      this.strategyDerivationCandidateDirectory(projectRoot),
      getProjectId(projectRoot),
      candidateId,
    );
  }

  /** Read one Derived Candidate directly from a canonical project namespace. */
  async readProjectId(
    projectId: string,
    candidateId: string,
  ): Promise<StrategyDerivationCandidateV1 | null> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Derivation Candidate: projectId must be canonical.");
    }
    if (!CANONICAL_CANDIDATE_ID.test(candidateId)) {
      throw new Error("Cannot read Strategy Derivation Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    return this.readFromDirectory(
      this.strategyDerivationCandidateDirectoryForProjectId(projectId),
      projectId,
      candidateId,
    );
  }

  async readAll(projectRoot: string): Promise<readonly StrategyDerivationCandidateV1[]> {
    return this.readAllFromDirectory(
      this.strategyDerivationCandidateDirectory(projectRoot),
      getProjectId(projectRoot),
    );
  }

  /** Read every Derived Candidate directly from a canonical project namespace. */
  async readAllProjectId(projectId: string): Promise<readonly StrategyDerivationCandidateV1[]> {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Cannot read Strategy Derivation Candidates: projectId must be canonical.");
    }
    return this.readAllFromDirectory(
      this.strategyDerivationCandidateDirectoryForProjectId(projectId),
      projectId,
    );
  }

  async save(projectRoot: string, candidate: StrategyDerivationCandidateV1): Promise<void> {
    const validated = validateStrategyDerivationCandidateBinding(candidate, projectRoot);
    const directory = this.strategyDerivationCandidateDirectory(projectRoot);
    const candidatePath = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      // Hard-link creation is atomic and cannot replace a historical artifact.
      await link(temporaryPath, candidatePath);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Could not save Pindie Strategy Derivation Candidate file '${candidatePath}': Candidate file already exists.`);
      }
      throw new Error(`Could not save Pindie Strategy Derivation Candidate file '${candidatePath}': ${errorMessage(error)}`);
    }
  }

  strategyDerivationCandidateDirectory(projectRoot: string): string {
    return this.strategyDerivationCandidateDirectoryForProjectId(getProjectId(projectRoot));
  }

  strategyDerivationCandidateDirectoryForProjectId(projectId: string): string {
    if (!CANONICAL_PROJECT_ID.test(projectId)) {
      throw new Error("Strategy Derivation Candidate namespace requires a canonical project identity.");
    }
    return join(this.baseDir, projectId, STRATEGY_DERIVATION_CANDIDATE_DIRECTORY_NAME);
  }
}

export { FileStrategyDerivationCandidateStore as FileStrategyDerivationCandidateV1Store };
