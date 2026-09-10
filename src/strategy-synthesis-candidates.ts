import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeCrossProjectExperienceRefs,
  isSortedCrossProjectExperienceRefs,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import {
  deriveCrossProjectSynthesisCitationSufficiency as derivePacketCitationSufficiency,
  validateCrossProjectSynthesisPacket,
  type CrossProjectDerivationPacketV1,
  type CrossProjectSynthesisPacket,
} from "./cross-project-synthesis.ts";
import { LOGICAL_STRATEGY_ID_PATTERN, MAX_DERIVED_STRATEGY_ID_LENGTH } from "./strategy-derivation-candidates.ts";

export const STRATEGY_SYNTHESIS_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const STRATEGY_SYNTHESIS_CANDIDATE_DIRECTORY_NAME = "strategy-synthesis-candidates";
export const MAX_SYNTHESIS_CANDIDATE_SUMMARY_LENGTH = 512;
export const MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH = 256;
export const MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS = 8;
export const MAX_SYNTHESIS_CANDIDATE_HYPOTHESIS_LENGTH = 1024;
export const MAX_SYNTHESIS_CANDIDATE_TIMESTAMP_LENGTH = 64;
export const MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS = 3;
export const MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS = 8;

const CANONICAL_CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_CANDIDATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateType",
  "candidateId",
  "createdAt",
  "proposal",
  "hypothesis",
  "evidence",
  "derivationReceipt",
] as const;
const PROPOSAL_FIELDS = [
  "strategyId",
  "kind",
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
] as const;
const EVIDENCE_FIELDS = ["sourceRefs"] as const;
const RECEIPT_FIELDS = [
  "packetVersion",
  "selectionVersion",
  "sufficiencyVersion",
  "capturedAt",
  "selection",
  "sourceRefs",
  "evidence",
  "sufficiency",
  "inventory",
  "trustedStrategyComparison",
  "boundaryText",
  "packetFingerprint",
] as const;

export interface StrategySynthesisCandidateV1 {
  readonly schemaVersion: typeof STRATEGY_SYNTHESIS_CANDIDATE_SCHEMA_VERSION;
  readonly candidateType: "cross-project-synthesis";
  readonly candidateId: string;
  readonly createdAt: string;
  readonly proposal: {
    readonly strategyId: string;
    readonly kind: "approach" | "modifier";
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
  readonly hypothesis: string;
  readonly evidence: {
    readonly sourceRefs: readonly CrossProjectExperienceRefV1[];
  };
  readonly derivationReceipt: CrossProjectDerivationPacketV1;
}

export interface StrategySynthesisCandidateProposal {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
  readonly hypothesis: string;
}

export interface CreateStrategySynthesisCandidateInput {
  readonly proposal: StrategySynthesisCandidateProposal;
  readonly sourceRefs: readonly CrossProjectExperienceRefV1[];
  readonly derivationReceipt: CrossProjectDerivationPacketV1;
  /** Harness-owned attempt-stable values. */
  readonly candidateId?: string;
  readonly createdAt?: string;
}

export interface StrategySynthesisCandidateReader {
  read(candidateId: string): Promise<StrategySynthesisCandidateV1 | null>;
  readAll(): Promise<readonly StrategySynthesisCandidateV1[]>;
}

export interface StrategySynthesisCandidateStore extends StrategySynthesisCandidateReader {
  save(candidate: StrategySynthesisCandidateV1): Promise<void>;
}

export interface FileStrategySynthesisCandidateStoreOptions {
  /** User-global root, normally ~/.pindie/global. */
  readonly baseDir?: string;
}

/** Runtime packet binding consumed by the CPL-owned creation tool. */
export interface StrategySynthesisCandidateRunBinding {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly invocationRoot: string;
  readonly projectId: string;
  readonly agentRunGeneration: number;
  readonly candidateId: string;
  readonly createdAt: string;
  readonly packet: CrossProjectSynthesisPacket;
}

export interface StrategySynthesisCandidateRuntimeAccess {
  activeFor(
    sessionId: string,
    invocationRoot: string,
    agentRunGeneration: number | null,
  ): StrategySynthesisCandidateRunBinding | null;
  claimPublication(attemptId: string): boolean;
  releasePublication(attemptId: string): void;
  completePublication(attemptId: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): never {
  throw new Error(`Invalid Strategy Synthesis Candidate: ${message}`);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") return invalid(`${field} must be a non-empty string.`);
  if (value.length > maxLength) return invalid(`${field} must be at most ${maxLength} characters.`);
  return value;
}

function boundedGuidanceArray(value: unknown, field: string, minItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS) {
    return invalid(`${field} must contain between ${minItems} and ${MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS} items.`);
  }
  return Object.freeze(value.map((item, index) =>
    boundedString(item, `${field}[${index}]`, MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH)));
}

function validateStrategyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_DERIVED_STRATEGY_ID_LENGTH ||
    value.trim() !== value ||
    !LOGICAL_STRATEGY_ID_PATTERN.test(value)
  ) return invalid(`strategyId must be lowercase ASCII kebab-case with 1..${MAX_DERIVED_STRATEGY_ID_LENGTH} characters.`);
  return value;
}

/** Validate only the model-owned semantic proposal and hypothesis. */
export function validateStrategySynthesisCandidateProposal(
  value: unknown,
): StrategySynthesisCandidateProposal {
  if (!isRecord(value) || !hasExactFields(value, [...PROPOSAL_FIELDS, "hypothesis"])) {
    return invalid("proposal must contain only strategyId, kind, summary, useWhen, avoidWhen, principles, and hypothesis.");
  }
  return Object.freeze({
    strategyId: validateStrategyId(value.strategyId),
    kind: value.kind === "approach" || value.kind === "modifier"
      ? value.kind
      : invalid("kind must be approach or modifier."),
    summary: boundedString(value.summary, "summary", MAX_SYNTHESIS_CANDIDATE_SUMMARY_LENGTH),
    useWhen: boundedGuidanceArray(value.useWhen, "useWhen", 1),
    avoidWhen: boundedGuidanceArray(value.avoidWhen, "avoidWhen", 0),
    principles: boundedGuidanceArray(value.principles, "principles", 1),
    hypothesis: boundedString(value.hypothesis, "hypothesis", MAX_SYNTHESIS_CANDIDATE_HYPOTHESIS_LENGTH),
  });
}

export function isCanonicalStrategySynthesisCandidateId(value: string): boolean {
  return CANONICAL_CANDIDATE_ID.test(value);
}

function refKey(ref: CrossProjectExperienceRefV1): string {
  return `${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function proposalSemanticProjection(
  proposal: Pick<StrategySynthesisCandidateV1, "proposal">["proposal"],
): Record<string, unknown> {
  return {
    strategyId: proposal.strategyId,
    kind: proposal.kind,
    summary: proposal.summary,
    useWhen: [...proposal.useWhen],
    avoidWhen: [...proposal.avoidWhen],
    principles: [...proposal.principles],
  };
}

/** Deterministic Strategy revision identity; evidence, receipt, ID, and time are excluded. */
export function strategySynthesisCandidateSemanticFingerprint(
  candidate: Pick<StrategySynthesisCandidateV1, "proposal">,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(proposalSemanticProjection(candidate.proposal)), "utf8")
    .digest("hex")}`;
}

export const strategySynthesisCandidateFingerprint = strategySynthesisCandidateSemanticFingerprint;
export const synthesisCandidateSemanticFingerprint = strategySynthesisCandidateSemanticFingerprint;

/** Deterministic provenance identity of the complete immutable Candidate artifact. */
export function strategySynthesisCandidateArtifactFingerprint(
  candidate: StrategySynthesisCandidateV1,
): string {
  const validated = validateStrategySynthesisCandidateArtifact(candidate, candidate.candidateId);
  return `sha256:${createHash("sha256")
    .update(canonicalJson(validated), "utf8")
    .digest("hex")}`;
}

export const synthesisCandidateArtifactFingerprint = strategySynthesisCandidateArtifactFingerprint;

function trustedSemanticProjection(value: {
  readonly kind: "approach" | "modifier";
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}): string {
  return canonicalJson({
    kind: value.kind,
    summary: value.summary,
    useWhen: [...value.useWhen],
    avoidWhen: [...value.avoidWhen],
    principles: [...value.principles],
  });
}

/** Check logical identity against only the frozen packet comparison context. */
export function hasTrustedStrategyLogicalIdInSynthesisPacket(
  proposal: Pick<StrategySynthesisCandidateProposal, "strategyId">,
  packet: CrossProjectSynthesisPacket,
): boolean {
  return packet.trustedStrategyComparison.some((context) =>
    context.trustedStrategies.some((entry) => entry.strategyId === proposal.strategyId));
}

/** Check exact trusted semantics against only the frozen packet comparison context. */
export function hasExactTrustedStrategySemanticDuplicateInSynthesisPacket(
  proposal: Pick<StrategySynthesisCandidateProposal, "kind" | "summary" | "useWhen" | "avoidWhen" | "principles">,
  packet: CrossProjectSynthesisPacket,
): boolean {
  const proposed = trustedSemanticProjection(proposal);
  return packet.trustedStrategyComparison.some((context) =>
    context.trustedStrategies.some((entry) => trustedSemanticProjection({
      kind: entry.kind,
      ...entry.semantics,
    }) === proposed));
}

function validateSourceRefs(
  value: unknown,
): readonly CrossProjectExperienceRefV1[] {
  if (!Array.isArray(value) || value.length < MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS || value.length > MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS) {
    return invalid(`evidence.sourceRefs must contain between ${MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS} and ${MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS} refs.`);
  }
  const refs = value.map((ref) => validateCrossProjectExperienceRefArtifact(ref));
  if (!isSortedCrossProjectExperienceRefs(refs)) return invalid("evidence.sourceRefs must be canonically sorted without duplicates.");
  return Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));
}

function validateReceipt(value: unknown): CrossProjectSynthesisPacket {
  if (!isRecord(value) || !hasExactFields(value, RECEIPT_FIELDS)) {
    return invalid("derivationReceipt fields are invalid.");
  }
  try {
    return validateCrossProjectSynthesisPacket(value as unknown as CrossProjectSynthesisPacket);
  } catch (error) {
    return invalid(`derivationReceipt is invalid: ${errorMessage(error)}`);
  }
}

function validateSourceBinding(
  sourceRefs: readonly CrossProjectExperienceRefV1[],
  receipt: CrossProjectSynthesisPacket,
): void {
  const receiptRefs = new Set(receipt.sourceRefs.map(refKey));
  if (sourceRefs.some((ref) => !receiptRefs.has(refKey(ref)))) {
    invalid("evidence.sourceRefs must resolve to exact refs in derivationReceipt.sourceRefs.");
  }
  const sufficiency = derivePacketCitationSufficiency(receipt, sourceRefs);
  if (!sufficiency.sufficient) {
    invalid("evidence.sourceRefs must independently satisfy the cross-project discovery gate.");
  }
}

function validateComparisonBinding(
  proposal: StrategySynthesisCandidateProposal,
  receipt: CrossProjectSynthesisPacket,
): void {
  if (hasTrustedStrategyLogicalIdInSynthesisPacket(proposal, receipt)) {
    invalid(`proposal strategyId '${proposal.strategyId}' already belongs to a trusted Strategy in the frozen comparison context.`);
  }
  if (hasExactTrustedStrategySemanticDuplicateInSynthesisPacket(proposal, receipt)) {
    invalid("proposal is an exact semantic duplicate of a trusted Strategy in the frozen comparison context.");
  }
}

/** Validate one strict immutable v1 artifact without repair or live reads. */
export function validateStrategySynthesisCandidateArtifact(
  value: unknown,
  requestedCandidateId?: string,
): StrategySynthesisCandidateV1 {
  if (!isRecord(value) || !hasExactFields(value, CANDIDATE_FIELDS)) return invalid("artifact fields are invalid.");
  if (value.schemaVersion !== STRATEGY_SYNTHESIS_CANDIDATE_SCHEMA_VERSION) return invalid("schemaVersion must be 1.");
  if (value.candidateType !== "cross-project-synthesis") return invalid("candidateType must be cross-project-synthesis.");
  if (typeof value.candidateId !== "string" || !CANONICAL_CANDIDATE_ID.test(value.candidateId)) return invalid("candidateId must be a canonical lowercase UUID-v4.");
  if (requestedCandidateId !== undefined && value.candidateId !== requestedCandidateId) return invalid("requested Candidate ID does not match artifact candidateId.");
  const createdAt = boundedString(value.createdAt, "createdAt", MAX_SYNTHESIS_CANDIDATE_TIMESTAMP_LENGTH);
  if (!Number.isFinite(Date.parse(createdAt))) return invalid("createdAt must be a valid timestamp.");
  const rawProposal = isRecord(value.proposal) && hasExactFields(value.proposal, PROPOSAL_FIELDS)
    ? {
        strategyId: value.proposal.strategyId,
        kind: value.proposal.kind,
        summary: value.proposal.summary,
        useWhen: value.proposal.useWhen,
        avoidWhen: value.proposal.avoidWhen,
        principles: value.proposal.principles,
        hypothesis: value.hypothesis,
      }
    : null;
  if (rawProposal === null) return invalid("proposal fields are invalid.");
  const proposal = validateStrategySynthesisCandidateProposal(rawProposal);
  if (!isRecord(value.evidence) || !hasExactFields(value.evidence, EVIDENCE_FIELDS)) return invalid("evidence fields are invalid.");
  const sourceRefs = validateSourceRefs(value.evidence.sourceRefs);
  const receipt = validateReceipt(value.derivationReceipt);
  validateSourceBinding(sourceRefs, receipt);
  validateComparisonBinding(proposal, receipt);
  let copiedReceipt: CrossProjectSynthesisPacket;
  try {
    copiedReceipt = deepFreeze(structuredClone(receipt));
  } catch (error) {
    return invalid(`derivationReceipt could not be copied immutably: ${errorMessage(error)}`);
  }
  return Object.freeze({
    schemaVersion: STRATEGY_SYNTHESIS_CANDIDATE_SCHEMA_VERSION,
    candidateType: "cross-project-synthesis" as const,
    candidateId: value.candidateId,
    createdAt,
    proposal: Object.freeze({
      strategyId: proposal.strategyId,
      kind: proposal.kind,
      summary: proposal.summary,
      useWhen: Object.freeze([...proposal.useWhen]),
      avoidWhen: Object.freeze([...proposal.avoidWhen]),
      principles: Object.freeze([...proposal.principles]),
    }),
    hypothesis: proposal.hypothesis,
    evidence: Object.freeze({
      sourceRefs: Object.freeze(sourceRefs.map((ref) => Object.freeze({ ...ref }))),
    }),
    derivationReceipt: copiedReceipt,
  });
}

export const parseStrategySynthesisCandidate = validateStrategySynthesisCandidateArtifact;
export const validateStrategySynthesisCandidate = validateStrategySynthesisCandidateArtifact;

/** Construct an immutable Candidate from the active frozen packet and Harness-owned identity. */
export function createStrategySynthesisCandidate(
  input: CreateStrategySynthesisCandidateInput,
): StrategySynthesisCandidateV1 {
  const proposal = validateStrategySynthesisCandidateProposal(input.proposal);
  const receipt = validateReceipt(input.derivationReceipt);
  const sourceRefs = canonicalizeCrossProjectExperienceRefs(input.sourceRefs);
  if (sourceRefs.length < MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS || sourceRefs.length > MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS) {
    return invalid(`sourceRefs must contain between ${MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS} and ${MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS} refs.`);
  }
  validateSourceBinding(sourceRefs, receipt);
  validateComparisonBinding(proposal, receipt);
  const candidateId = (input.candidateId ?? randomUUID()).toLowerCase();
  if (!CANONICAL_CANDIDATE_ID.test(candidateId)) return invalid("candidateId must be a canonical lowercase UUID-v4.");
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (typeof createdAt !== "string" || createdAt.trim() === "" || createdAt.length > MAX_SYNTHESIS_CANDIDATE_TIMESTAMP_LENGTH || !Number.isFinite(Date.parse(createdAt))) {
    return invalid("createdAt must be a valid timestamp.");
  }
  return validateStrategySynthesisCandidateArtifact({
    schemaVersion: STRATEGY_SYNTHESIS_CANDIDATE_SCHEMA_VERSION,
    candidateType: "cross-project-synthesis",
    candidateId,
    createdAt,
    proposal: {
      strategyId: proposal.strategyId,
      kind: proposal.kind,
      summary: proposal.summary,
      useWhen: [...proposal.useWhen],
      avoidWhen: [...proposal.avoidWhen],
      principles: [...proposal.principles],
    },
    hypothesis: proposal.hypothesis,
    evidence: { sourceRefs: [...sourceRefs] },
    derivationReceipt: receipt,
  });
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Durable user-global immutable Synthesis Candidate storage. */
export class FileStrategySynthesisCandidateStore implements StrategySynthesisCandidateStore {
  private readonly baseDir: string;

  constructor(options: FileStrategySynthesisCandidateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
  }

  async read(candidateId: string): Promise<StrategySynthesisCandidateV1 | null> {
    if (!CANONICAL_CANDIDATE_ID.test(candidateId)) {
      throw new Error("Cannot read Strategy Synthesis Candidate: candidateId must be a canonical lowercase UUID-v4.");
    }
    const path = join(this.strategySynthesisCandidateDirectory(), `${candidateId}.json`);
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`Could not read Strategy Synthesis Candidate file '${path}': ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Could not read Strategy Synthesis Candidate file '${path}': invalid JSON (${errorMessage(error)}).`);
    }
    try {
      return validateStrategySynthesisCandidateArtifact(parsed, candidateId);
    } catch (error) {
      throw new Error(`Could not read Strategy Synthesis Candidate file '${path}': ${errorMessage(error)}`);
    }
  }

  async readAll(): Promise<readonly StrategySynthesisCandidateV1[]> {
    const directory = this.strategySynthesisCandidateDirectory();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return Object.freeze([]);
      throw new Error(`Could not read Strategy Synthesis Candidate directory '${directory}': ${errorMessage(error)}`);
    }
    const candidates: StrategySynthesisCandidateV1[] = [];
    for (const entry of entries.filter((item) => item.isFile()).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.name.endsWith(".json") && !CANONICAL_CANDIDATE_FILE.test(entry.name)) {
        throw new Error(`Could not read Strategy Synthesis Candidate directory '${directory}': non-canonical JSON artifact '${entry.name}'.`);
      }
      if (!CANONICAL_CANDIDATE_FILE.test(entry.name)) continue;
      const candidate = await this.read(entry.name.slice(0, -".json".length));
      if (candidate === null) throw new Error(`Could not read Strategy Synthesis Candidate file '${join(directory, entry.name)}': artifact disappeared while reading.`);
      candidates.push(candidate);
    }
    return Object.freeze(candidates);
  }

  async save(candidate: StrategySynthesisCandidateV1): Promise<void> {
    const validated = validateStrategySynthesisCandidateArtifact(candidate, candidate.candidateId);
    const directory = this.strategySynthesisCandidateDirectory();
    const path = join(directory, `${validated.candidateId}.json`);
    const temporaryPath = join(directory, `.${validated.candidateId}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await link(temporaryPath, path);
      await rm(temporaryPath, { force: true });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") throw new Error(`Could not save Strategy Synthesis Candidate file '${path}': Candidate file already exists.`);
      throw new Error(`Could not save Strategy Synthesis Candidate file '${path}': ${errorMessage(error)}`);
    }
  }

  strategySynthesisCandidateDirectory(): string {
    return join(this.baseDir, STRATEGY_SYNTHESIS_CANDIDATE_DIRECTORY_NAME);
  }

  candidateDirectory(): string {
    return this.strategySynthesisCandidateDirectory();
  }
}

export { FileStrategySynthesisCandidateStore as FileStrategySynthesisCandidateV1Store };
