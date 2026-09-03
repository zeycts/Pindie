import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface StrategyCandidateStore {
  save(projectRoot: string, candidate: StrategyRevisionCandidate): Promise<void>;
}

export interface FileStrategyCandidateStoreOptions {
  baseDir?: string;
}

const CANONICAL_CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROPOSAL_FIELDS = [
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
  "sourceRecordIds",
  "hypothesis",
] as const;

type CandidateProposalField = typeof PROPOSAL_FIELDS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function isCanonicalStrategyCandidateId(value: string): boolean {
  return CANONICAL_CANDIDATE_ID.test(value);
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

  return Object.freeze({
    schemaVersion: STRATEGY_CANDIDATE_SCHEMA_VERSION,
    candidateId,
    createdAt,
    target: Object.freeze({
      strategyId: target.id,
      kind: target.kind,
      baseFingerprint: seedStrategyFingerprint(target),
    }),
    proposal: Object.freeze({
      summary: normalizedProposal.summary,
      useWhen: Object.freeze(normalizedProposal.useWhen),
      avoidWhen: Object.freeze(normalizedProposal.avoidWhen),
      principles: Object.freeze(normalizedProposal.principles),
    }),
    evidence: Object.freeze({
      sourceRecordIds: Object.freeze([...proposal.sourceRecordIds]),
    }),
    hypothesis: proposal.hypothesis,
  });
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Durable, project-local, write-only storage for immutable Candidates. */
export class FileStrategyCandidateStore implements StrategyCandidateStore {
  private readonly baseDir: string;

  constructor(options: FileStrategyCandidateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "projects");
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
    return join(
      this.baseDir,
      getProjectId(projectRoot),
      STRATEGY_CANDIDATE_DIRECTORY_NAME,
    );
  }
}
