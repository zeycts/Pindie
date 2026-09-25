import { isDeepStrictEqual } from "node:util";

import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { PINDIE_TOOL_LIVENESS_TIMEOUT_MS } from "../liveness.ts";
import {
  PindieLearningArtifactPublicationUncertainError,
  publishImmutableLearningArtifact,
} from "../learning-artifact-liveness.ts";

import {
  crossProjectSynthesisEvidenceHandleIndex,
} from "../cross-project-synthesis.ts";
import {
  createStrategySynthesisCandidate,
  MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS,
  MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH,
  MAX_SYNTHESIS_CANDIDATE_HYPOTHESIS_LENGTH,
  MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS,
  MAX_SYNTHESIS_CANDIDATE_SUMMARY_LENGTH,
  MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  validateStrategySynthesisCandidateArtifact,
  validateStrategySynthesisCandidateProposal,
  type StrategySynthesisCandidateProposal,
  type StrategySynthesisCandidateRuntimeAccess,
  type StrategySynthesisCandidateStore,
} from "../strategy-synthesis-candidates.ts";

const StrategySynthesisCandidateParameters = Type.Object(
  {
    strategyId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      description: "New lowercase ASCII kebab-case logical Strategy ID; the Harness rejects trusted-ID collisions in the frozen comparison context.",
    }),
    kind: Type.Union([
      Type.Literal("approach"),
      Type.Literal("modifier"),
    ], { description: "New Strategy role." }),
    summary: Type.String({
      minLength: 1,
      maxLength: MAX_SYNTHESIS_CANDIDATE_SUMMARY_LENGTH,
      description: "Bounded proposed advisory Strategy summary.",
    }),
    useWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded situations where the proposed Strategy may apply.",
    }),
    avoidWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH }), {
      maxItems: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded situations where the proposed Strategy should be avoided.",
    }),
    principles: Type.Array(Type.String({ minLength: 1, maxLength: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_SYNTHESIS_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded advisory principles for the proposed Strategy.",
    }),
    evidenceHandles: Type.Array(Type.String({
      minLength: 2,
      maxLength: 2,
      pattern: "^E[1-8]$",
    }), {
      minItems: MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS,
      maxItems: MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS,
      uniqueItems: true,
      description: "Exact model-facing evidence handles (for example E1, E2, E3) from the frozen synthesis packet; the cited subset must satisfy the complete discovery gate.",
    }),
    hypothesis: Type.String({
      minLength: 1,
      maxLength: MAX_SYNTHESIS_CANDIDATE_HYPOTHESIS_LENGTH,
      description: "Bounded missing-abstraction hypothesis; this is not proof of novelty, usefulness, superiority, or causality.",
    }),
  },
  { additionalProperties: false },
);

export interface StrategySynthesisCandidateToolOptions {
  readonly runtime: StrategySynthesisCandidateRuntimeAccess;
  readonly candidateStore: StrategySynthesisCandidateStore;
  readonly getProjectRoot: () => string | null;
  readonly getAgentRunGeneration: () => number | null;
  /** Test seam; production uses the shared Slice A deadline. */
  readonly livenessTimeoutMs?: number;
}

export interface StrategySynthesisCandidateToolDetails {
  readonly candidateId: string;
  readonly semanticFingerprint: string;
  readonly artifactFingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proposal(value: unknown): {
  readonly proposal: StrategySynthesisCandidateProposal;
  readonly evidenceHandles: readonly string[];
} {
  if (!isRecord(value)) {
    throw new Error("Invalid Strategy Synthesis Candidate proposal: strategyId, kind, summary, useWhen, avoidWhen, principles, evidenceHandles, and hypothesis are required.");
  }
  const expected = [
    "strategyId",
    "kind",
    "summary",
    "useWhen",
    "avoidWhen",
    "principles",
    "evidenceHandles",
    "hypothesis",
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid Strategy Synthesis Candidate proposal: only model-owned proposal fields and evidenceHandles are accepted; Candidate ID, receipt, and fingerprints are Harness-owned.");
  }
  const evidenceHandles = value.evidenceHandles;
  if (!Array.isArray(evidenceHandles) ||
    evidenceHandles.length < MIN_SYNTHESIS_CANDIDATE_SOURCE_REFS ||
    evidenceHandles.length > MAX_SYNTHESIS_CANDIDATE_SOURCE_REFS ||
    evidenceHandles.some((handle) => typeof handle !== "string") ||
    new Set(evidenceHandles).size !== evidenceHandles.length) {
    throw new Error("Invalid Strategy Synthesis Candidate proposal: evidenceHandles must contain 3..8 unique packet handles.");
  }
  return {
    proposal: validateStrategySynthesisCandidateProposal({
      strategyId: value.strategyId,
      kind: value.kind,
      summary: value.summary,
      useWhen: value.useWhen,
      avoidWhen: value.avoidWhen,
      principles: value.principles,
      hypothesis: value.hypothesis,
    }),
    evidenceHandles: Object.freeze([...evidenceHandles]),
  };
}

function result(candidate: {
  readonly candidateId: string;
  readonly proposal: { readonly strategyId: string; readonly kind: string };
  readonly evidence: { readonly sourceRefs: readonly unknown[] };
  readonly semanticFingerprint: string;
  readonly artifactFingerprint: string;
}) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "Strategy Synthesis Candidate created.",
        "",
        `Candidate ID: ${candidate.candidateId}`,
        `Proposed Strategy: ${candidate.proposal.strategyId} (${candidate.proposal.kind})`,
        `Evidence refs: ${candidate.evidence.sourceRefs.length}`,
        `Strategy semantic fingerprint: ${candidate.semanticFingerprint}`,
        `Candidate artifact fingerprint: ${candidate.artifactFingerprint}`,
        "Candidate is inactive and immutable; no Trial, Policy, Decision, or Promotion authority was granted.",
      ].join("\n"),
    }],
    details: {
      candidateId: candidate.candidateId,
      semanticFingerprint: candidate.semanticFingerprint,
      artifactFingerprint: candidate.artifactFingerprint,
    } satisfies StrategySynthesisCandidateToolDetails,
  };
}

/** Create one inactive Candidate from the exact frozen packet and active reservation. */
export function createPindieStrategySynthesisCandidateTool(
  options: StrategySynthesisCandidateToolOptions,
) {
  return defineTool({
    name: "pindie_strategy_synthesis_candidate_create",
    label: "Create Strategy Synthesis Candidate",
    description: "Propose one bounded inactive Strategy Synthesis hypothesis during a live cross-project Synthesis Run (explicit /derive-global or admitted autonomous learning). Candidate creation is optional; cited packet evidence permits only a hypothesis and does not establish novelty, usefulness, superiority, or causality.",
    parameters: StrategySynthesisCandidateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const projectRoot = options.getProjectRoot();
      if (projectRoot === null) {
        throw new Error("Cannot create a Strategy Synthesis Candidate: no current project root is loaded. Use /derive-global from a loaded project.");
      }
      let sessionId: string;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch (error) {
        throw new Error(`Cannot create a Strategy Synthesis Candidate: ${errorMessage(error)}`);
      }
      const generation = options.getAgentRunGeneration();
      const active = options.runtime.activeFor(sessionId, projectRoot, generation);
      if (active === null) {
        throw new Error("Cannot create a Strategy Synthesis Candidate without a live /derive-global reservation for this Agent Run.");
      }

      const submitted = proposal(params);
      const sourceRefs = submitted.evidenceHandles.map((handle) => {
        const index = crossProjectSynthesisEvidenceHandleIndex(handle);
        if (index === null || active.packet.evidence.runs[index] === undefined) {
          throw new Error(`Strategy Synthesis Candidate rejected: '${handle}' is not an exact evidence handle in the frozen synthesis packet.`);
        }
        return active.packet.evidence.runs[index]!.sourceRef;
      });

      let publicationClaimed = false;
      let publicationCompleted = false;
      try {
        if (!options.runtime.claimPublication(active.attemptId)) {
          throw new Error("Strategy Synthesis Candidate rejected: this /derive-global Run already published or is publishing its one Candidate.");
        }
        publicationClaimed = true;
        const candidate = createStrategySynthesisCandidate({
          proposal: submitted.proposal,
          sourceRefs,
          derivationReceipt: active.packet,
          candidateId: active.candidateId,
          createdAt: active.createdAt,
        });
        await publishImmutableLearningArtifact({
          label: "Strategy Synthesis",
          timeoutMs: options.livenessTimeoutMs ?? PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
          signal,
          save: (publicationSignal) => options.candidateStore.save(candidate, publicationSignal),
          read: (publicationSignal) => options.candidateStore.read(candidate.candidateId, publicationSignal),
          isExact: (existing) => {
            const validatedExisting = validateStrategySynthesisCandidateArtifact(existing, candidate.candidateId);
            return isDeepStrictEqual(validatedExisting, candidate) &&
              strategySynthesisCandidateArtifactFingerprint(validatedExisting) === strategySynthesisCandidateArtifactFingerprint(candidate);
          },
        });
        if (!options.runtime.completePublication(active.attemptId)) {
          throw new Error("Strategy Synthesis Candidate was persisted but the /derive-global reservation was no longer current.");
        }
        publicationCompleted = true;
        return result({
          ...candidate,
          semanticFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
          artifactFingerprint: strategySynthesisCandidateArtifactFingerprint(candidate),
        });
      } catch (error) {
        if (
          publicationClaimed &&
          !publicationCompleted &&
          !(error instanceof PindieLearningArtifactPublicationUncertainError)
        ) options.runtime.releasePublication(active.attemptId);
        if (error instanceof Error) throw error;
        throw new Error(`Strategy Synthesis Candidate was not persisted: ${errorMessage(error)}`);
      }
    },
  });
}
