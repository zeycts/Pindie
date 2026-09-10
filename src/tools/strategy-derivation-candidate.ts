import { isDeepStrictEqual } from "node:util";

import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  deriveDerivationSufficiency,
  selectDerivationSourceEvidence,
  type DerivationRuntime,
} from "../strategy-derivation.ts";
import {
  createStrategyDerivationCandidate,
  hasExactTrustedStrategySemanticDuplicate,
  LOGICAL_STRATEGY_ID_PATTERN,
  MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS,
  MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH,
  MAX_DERIVATION_CANDIDATE_HYPOTHESIS_LENGTH,
  MAX_DERIVATION_CANDIDATE_SOURCE_RECORD_ID_LENGTH,
  MAX_DERIVATION_CANDIDATE_SOURCE_RECORDS,
  MAX_DERIVATION_CANDIDATE_SUMMARY_LENGTH,
  MAX_DERIVED_STRATEGY_ID_LENGTH,
  MIN_DERIVATION_CANDIDATE_SOURCE_RECORDS,
  type StrategyDerivationCandidateProposal,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateStore,
} from "../strategy-derivation-candidates.ts";
import type {
  RunExperienceReader,
  RunExperienceSourceRecord,
} from "../experience-store.ts";
import {
  sameTrustedPortfolioSnapshot,
  trustedLogicalStrategyIds,
  type TrustedStrategyPortfolio,
} from "../strategy-portfolio.ts";
import type {
  StrategyCandidateReader,
} from "../strategy-candidates.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "../liveness.ts";
import {
  PindieLearningArtifactPublicationUncertainError,
  publishImmutableLearningArtifact,
} from "../learning-artifact-liveness.ts";
import type { StrategyRevisionDecisionReader } from "../strategy-decisions.ts";

const StrategyDerivationCandidateParameters = Type.Object(
  {
    strategyId: Type.String({
      minLength: 1,
      maxLength: MAX_DERIVED_STRATEGY_ID_LENGTH,
      pattern: LOGICAL_STRATEGY_ID_PATTERN.source,
      description: "New lowercase ASCII kebab-case logical Strategy ID; the Harness rejects trusted-ID collisions.",
    }),
    kind: Type.Union([
      Type.Literal("approach"),
      Type.Literal("modifier"),
    ], { description: "New Strategy role." }),
    summary: Type.String({
      minLength: 1,
      maxLength: MAX_DERIVATION_CANDIDATE_SUMMARY_LENGTH,
      description: "Bounded proposed advisory Strategy summary.",
    }),
    useWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded situations where the proposed Strategy may apply.",
    }),
    avoidWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH }), {
      maxItems: MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded situations where the proposed Strategy should be avoided.",
    }),
    principles: Type.Array(Type.String({ minLength: 1, maxLength: MAX_DERIVATION_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_DERIVATION_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded advisory principles for the proposed Strategy.",
    }),
    sourceRecordIds: Type.Array(Type.String({ minLength: 1, maxLength: MAX_DERIVATION_CANDIDATE_SOURCE_RECORD_ID_LENGTH }), {
      minItems: MIN_DERIVATION_CANDIDATE_SOURCE_RECORDS,
      maxItems: MAX_DERIVATION_CANDIDATE_SOURCE_RECORDS,
      uniqueItems: true,
      description: "Exact source Experience IDs from the active Derivation Packet; the submitted set must satisfy the complete sufficiency gate.",
    }),
    hypothesis: Type.String({
      minLength: 1,
      maxLength: MAX_DERIVATION_CANDIDATE_HYPOTHESIS_LENGTH,
      description: "Bounded missing-abstraction hypothesis; this is not proof of novelty, usefulness, superiority, or causality.",
    }),
  },
  { additionalProperties: false },
);

export interface StrategyDerivationCandidateToolOptions {
  readonly derivation: DerivationRuntime;
  readonly experienceReader: RunExperienceReader;
  readonly candidateStore: StrategyDerivationCandidateStore;
  /** Existing exact Candidate reader used for bounded save reconciliation. */
  readonly candidateReader: StrategyDerivationCandidateReader;
  readonly getProjectRoot: () => string | null;
  readonly getAgentRunGeneration: () => number | null;
  /** Fresh trust reconstruction; malformed v0.6 artifacts fail closed. */
  readonly loadPortfolio: (projectRoot: string) => Promise<TrustedStrategyPortfolio>;
  /** Test seam; production uses the shared Slice A deadline. */
  readonly livenessTimeoutMs?: number;
}

export interface StrategyDerivationCandidateToolDetails {
  readonly candidateId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proposal(value: unknown): StrategyDerivationCandidateProposal {
  if (!isRecord(value)) {
    throw new Error("Invalid Strategy Derivation Candidate proposal: strategyId, kind, summary, useWhen, avoidWhen, principles, sourceRecordIds, and hypothesis are required.");
  }
  const expected = [
    "strategyId",
    "kind",
    "summary",
    "useWhen",
    "avoidWhen",
    "principles",
    "sourceRecordIds",
    "hypothesis",
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid Strategy Derivation Candidate proposal: only model-owned proposal fields are accepted; Candidate ID, project, portfolio, and trust fields are Harness-owned.");
  }
  return value as unknown as StrategyDerivationCandidateProposal;
}

function samePortfolio(
  left: TrustedStrategyPortfolio,
  right: TrustedStrategyPortfolio,
): boolean {
  return sameTrustedPortfolioSnapshot(left, right);
}

function recordsById(
  records: readonly RunExperienceSourceRecord[],
): Map<string, RunExperienceSourceRecord> {
  return new Map(records.map((record) => [record.recordId, record]));
}

function candidateResult(candidate: { candidateId: string; proposal: { strategyId: string; kind: string }; evidence: { sourceRecordIds: readonly string[] } }) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "Strategy Derivation Candidate created.",
        "",
        `Candidate ID: ${candidate.candidateId}`,
        `Proposed Strategy: ${candidate.proposal.strategyId} (${candidate.proposal.kind})`,
        `Evidence records: ${candidate.evidence.sourceRecordIds.length}`,
        "Candidate is inactive and immutable; Slice A does not make it usable as Policy.",
      ].join("\n"),
    }],
    details: { candidateId: candidate.candidateId } satisfies StrategyDerivationCandidateToolDetails,
  };
}

/**
 * Narrow model-callable creation of one inactive new-logical-Strategy
 * hypothesis. All identity, project, portfolio, and provenance bindings come
 * from the active runtime lease and fresh Harness reads.
 */
export function createPindieStrategyDerivationCandidateTool(
  options: StrategyDerivationCandidateToolOptions,
) {
  return defineTool({
    name: "pindie_strategy_derivation_candidate_create",
    label: "Create Strategy Derivation Candidate",
    description: "Propose one bounded inactive new-logical-Strategy hypothesis during an explicit /derive Run. Candidate creation is optional; evidence permits only a hypothesis and does not establish novelty, usefulness, superiority, or causality.",
    parameters: StrategyDerivationCandidateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const projectRoot = options.getProjectRoot();
      if (projectRoot === null) {
        throw new Error("Cannot create a Strategy Derivation Candidate: no current project root is loaded. Use /derive from a loaded project.");
      }

      let sessionId: string;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch (error) {
        throw new Error(`Cannot create a Strategy Derivation Candidate: ${errorMessage(error)}`);
      }
      const lease = options.derivation.activeFor(
        sessionId,
        options.getAgentRunGeneration(),
      );
      if (lease === null) {
        throw new Error("Cannot create a Strategy Derivation Candidate without a live /derive lease for this Agent Run.");
      }

      let read: Awaited<ReturnType<RunExperienceReader["read"]>>;
      let freshPortfolio: TrustedStrategyPortfolio;
      try {
        [read, freshPortfolio] = await runBoundedOperation({
          label: "Strategy Derivation Candidate preparation",
          timeoutMs: options.livenessTimeoutMs ?? PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
          signal,
          run: async () => Promise.all([
            options.experienceReader.read(projectRoot).catch((error: unknown) => {
              throw new Error(`Strategy Derivation Candidate provenance could not read current Experience: ${errorMessage(error)}`);
            }),
            options.loadPortfolio(projectRoot).catch((error: unknown) => {
              throw new Error(`Strategy Derivation Candidate rejected: trusted portfolio could not be validated: ${errorMessage(error)}`);
            }),
          ]),
        });
      } catch (error) {
        if (error instanceof PindieLivenessAbortError || error instanceof PindieLivenessTimeoutError) throw error;
        throw error;
      }

      const currentLease = options.derivation.activeFor(
        sessionId,
        options.getAgentRunGeneration(),
      );
      if (currentLease === null || currentLease.attemptId !== lease.attemptId) {
        throw new Error("Strategy Derivation Candidate rejected: the /derive Run is no longer current; start a new /derive attempt.");
      }
      if (
        options.getProjectRoot() !== projectRoot ||
        freshPortfolio.projectId !== lease.projectId ||
        !samePortfolio(freshPortfolio, lease.portfolio)
      ) {
        throw new Error("Strategy Derivation Candidate rejected: the current project or trusted portfolio changed; start a new /derive attempt.");
      }

      const validated = proposal(params);
      const proposalValue = (() => {
        // The pure validator is deliberately called by the Candidate factory;
        // this narrow copy prevents any Harness-owned fields from reaching it.
        return validated;
      })();

      if (!lease.sourceRecordIds.length ||
        lease.packet.sourceRecordIds.length !== lease.sourceRecordIds.length ||
        lease.packet.sourceRecordIds.some((id) => !lease.sourceRecordIds.includes(id))) {
        throw new Error("Strategy Derivation Candidate rejected: the active packet membership is incoherent.");
      }
      if (validated.sourceRecordIds.some((recordId) => !lease.sourceRecordIds.includes(recordId))) {
        throw new Error("Strategy Derivation Candidate rejected: every source ID must belong to the active Derivation Packet.");
      }

      const eligible = selectDerivationSourceEvidence(freshPortfolio, read.records);
      const submitted = new Set(validated.sourceRecordIds);
      const eligibleById = recordsById(read.records);
      const submittedEvaluations = eligible.filter((evaluation) => submitted.has(evaluation.source.recordId));
      if (
        submittedEvaluations.length !== validated.sourceRecordIds.length ||
        validated.sourceRecordIds.some((recordId) => !eligibleById.has(recordId))
      ) {
        throw new Error("Strategy Derivation Candidate rejected: every submitted source ID must resolve to a fresh eligible schema-v4 source Run.");
      }
      const sufficiency = deriveDerivationSufficiency(submittedEvaluations);
      if (
        sufficiency.distinctRecordCount !== validated.sourceRecordIds.length ||
        !sufficiency.sufficient
      ) {
        throw new Error("Strategy Derivation Candidate rejected: the exact submitted source set must satisfy 3 distinct records, 2 exact Task goals, and 2 Policy Evidence Profile identities.");
      }

      const logicalIds = new Set(trustedLogicalStrategyIds(freshPortfolio));
      if (logicalIds.has(validated.strategyId)) {
        throw new Error(`Strategy Derivation Candidate rejected: logical Strategy ID '${validated.strategyId}' already belongs to the trusted portfolio.`);
      }
      if (hasExactTrustedStrategySemanticDuplicate(validated, freshPortfolio)) {
        throw new Error("Strategy Derivation Candidate rejected: proposal is an exact semantic duplicate of a trusted Strategy.");
      }

      let candidate;
      try {
        candidate = createStrategyDerivationCandidate({
          projectId: freshPortfolio.projectId,
          basePortfolio: freshPortfolio,
          proposal: proposalValue,
        });
      } catch (error) {
        throw new Error(`Strategy Derivation Candidate rejected: ${errorMessage(error)}`);
      }
      try {
        await publishImmutableLearningArtifact({
          label: "Strategy Derivation",
          timeoutMs: options.livenessTimeoutMs,
          signal,
          save: (publicationSignal) => options.candidateStore.save(projectRoot, candidate, publicationSignal),
          read: (publicationSignal) => options.candidateReader.read(projectRoot, candidate.candidateId, publicationSignal),
          isExact: (existing) => isDeepStrictEqual(existing, candidate),
        });
      } catch (error) {
        if (error instanceof PindieLearningArtifactPublicationUncertainError) {
          options.derivation.consume(lease.attemptId);
          throw error;
        }
        if (error instanceof PindieLivenessAbortError || error instanceof PindieLivenessTimeoutError) throw error;
        throw new Error(`Strategy Derivation Candidate was not persisted; the /derive lease remains retryable: ${errorMessage(error)}`);
      }
      if (!options.derivation.consume(lease.attemptId)) {
        throw new Error("Strategy Derivation Candidate was persisted but the /derive lease was no longer current.");
      }
      return candidateResult(candidate);
    },
  });
}
