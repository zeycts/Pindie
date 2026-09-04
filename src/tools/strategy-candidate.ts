import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  evaluateRunExperience,
  type RunEvaluation,
} from "../experience-evaluation.ts";
import {
  type RunExperienceReader,
  type RunExperienceSourceRecord,
} from "../experience-store.ts";
import { parseRunExperience } from "../run-experience.ts";
import {
  AdaptationRuntime,
  type AdaptationLease,
} from "../strategy-adaptation.ts";
import {
  createStrategyRevisionCandidate,
  MAX_ADAPTATION_PACKET_RUNS,
  MAX_CANDIDATE_GUIDANCE_ITEMS,
  MAX_CANDIDATE_GUIDANCE_LENGTH,
  MAX_CANDIDATE_HYPOTHESIS_LENGTH,
  MAX_CANDIDATE_SOURCE_RECORD_ID_LENGTH,
  MAX_CANDIDATE_SUMMARY_LENGTH,
  type StrategyCandidateProposal,
  type StrategyCandidateStore,
  type StrategyRevisionCandidate,
  validateStrategyCandidateProposal,
} from "../strategy-candidates.ts";
import { isSeedStrategySelection } from "../policy.ts";
import {
  getSeedStrategy,
  seedStrategyFingerprint,
} from "../strategies.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const StrategyCandidateParameters = Type.Object(
  {
    summary: Type.String({
      minLength: 1,
      maxLength: MAX_CANDIDATE_SUMMARY_LENGTH,
      description: "Bounded proposed replacement summary for the target Seed Strategy.",
    }),
    useWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded proposed situations where the target Strategy is useful.",
    }),
    avoidWhen: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_GUIDANCE_LENGTH }), {
      maxItems: MAX_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded proposed situations where the target Strategy should be avoided.",
    }),
    principles: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_GUIDANCE_LENGTH }), {
      minItems: 1,
      maxItems: MAX_CANDIDATE_GUIDANCE_ITEMS,
      description: "Bounded proposed advisory principles for the target Strategy.",
    }),
    sourceRecordIds: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_SOURCE_RECORD_ID_LENGTH }), {
      minItems: 2,
      maxItems: MAX_ADAPTATION_PACKET_RUNS,
      uniqueItems: true,
      description: "At least two distinct source record IDs from the active Adaptation Packet.",
    }),
    hypothesis: Type.String({
      minLength: 1,
      maxLength: MAX_CANDIDATE_HYPOTHESIS_LENGTH,
      description: "Bounded hypothesis text; this is not factual evidence or proof of improvement.",
    }),
  },
  { additionalProperties: false },
);

export interface StrategyCandidateToolOptions {
  readonly adaptation: AdaptationRuntime;
  readonly experienceReader: RunExperienceReader;
  readonly candidateStore: StrategyCandidateStore;
  readonly getProjectRoot: () => string | null;
  readonly getAgentRunGeneration: () => number | null;
}

export interface StrategyCandidateToolDetails {
  readonly candidateId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function proposal(value: unknown): StrategyCandidateProposal {
  if (!isRecord(value)) {
    throw new Error("Invalid Candidate proposal: summary, useWhen, avoidWhen, principles, sourceRecordIds, and hypothesis are required.");
  }
  // The model tool schema performs this check in normal Pi execution. Keep a
  // direct-execution check here as well because tool tests and future callers
  // may invoke the adapter without provider-side schema validation.
  const expected = ["summary", "useWhen", "avoidWhen", "principles", "sourceRecordIds", "hypothesis"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== [...expected].sort()[index])) {
    throw new Error("Invalid Candidate proposal: only proposal fields are accepted; target identity is adaptation-owned.");
  }
  return value as unknown as StrategyCandidateProposal;
}

function targetParticipated(
  evaluation: RunEvaluation,
  targetId: string,
  targetKind: "approach" | "modifier",
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (!evaluation.attributionEligible || snapshot === null) return false;
  return targetKind === "approach"
    ? snapshot.approach.id === targetId && isSeedStrategySelection(snapshot.approach)
    : snapshot.modifiers.some((modifier) =>
      modifier.id === targetId && isSeedStrategySelection(modifier));
}

/** Validate Candidate provenance against a fresh current-project Reader result. */
export function validateCandidateProvenance(
  lease: AdaptationLease,
  proposalInput: unknown,
  records: readonly RunExperienceSourceRecord[],
): { target: NonNullable<ReturnType<typeof getSeedStrategy>>; proposal: StrategyCandidateProposal } {
  const currentTarget = getSeedStrategy(lease.target.id);
  if (currentTarget === null || currentTarget.kind !== lease.target.kind) {
    throw new Error("Candidate rejected: the adaptation target is no longer a valid Seed Strategy.");
  }
  const currentFingerprint = seedStrategyFingerprint(currentTarget);
  if (currentFingerprint !== lease.baseFingerprint) {
    throw new Error("Candidate rejected: the target Seed fingerprint changed; start a new /adapt attempt.");
  }
  if (
    lease.packet.target.strategyId !== currentTarget.id ||
    lease.packet.target.kind !== currentTarget.kind ||
    lease.packet.target.baseFingerprint !== lease.baseFingerprint
  ) {
    throw new Error("Candidate rejected: the active Adaptation Packet no longer matches its target.");
  }

  const proposalValue = proposal(proposalInput);
  const validated = validateStrategyCandidateProposal(proposalValue);
  if (validated.sourceRecordIds.length < 2) {
    throw new Error("Candidate rejected: cite at least 2 distinct evidence records.");
  }
  if (validated.sourceRecordIds.length > lease.sourceRecordIds.length ||
    validated.sourceRecordIds.length > MAX_ADAPTATION_PACKET_RUNS) {
    throw new Error("Candidate rejected: evidence references exceed the bounded Adaptation Packet.");
  }
  const packetIds = new Set(lease.sourceRecordIds);
  if (validated.sourceRecordIds.some((recordId) => !packetIds.has(recordId))) {
    throw new Error("Candidate rejected: every evidence reference must come from the active Adaptation Packet.");
  }

  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const evaluations: RunEvaluation[] = [];
  for (const recordId of validated.sourceRecordIds) {
    const record = recordsById.get(recordId);
    const parsed = record ? parseRunExperience(record.experience) : null;
    if (record === undefined || parsed === null) {
      throw new Error(`Candidate rejected: source record '${recordId}' is missing or is not valid supported schema-v3/v4 Experience.`);
    }
    const evaluation = evaluateRunExperience({ recordId, experience: parsed });
    if (!evaluation.attributionEligible) {
      throw new Error(`Candidate rejected: source record '${recordId}' is not attribution-eligible.`);
    }
    if (!targetParticipated(evaluation, currentTarget.id, currentTarget.kind)) {
      throw new Error(`Candidate rejected: source record '${recordId}' does not contain target Strategy '${currentTarget.id}' in its final Policy.`);
    }
    evaluations.push(evaluation);
  }
  if (new Set(evaluations.map((evaluation) => evaluation.source.recordId)).size < 2) {
    throw new Error("Candidate rejected: cite at least 2 distinct evidence records.");
  }
  return { target: currentTarget, proposal: validated };
}

function candidateResult(candidate: StrategyRevisionCandidate) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "Candidate created.",
        "",
        `Candidate ID: ${candidate.candidateId}`,
        `Target Strategy: ${candidate.target.strategyId} (${candidate.target.kind})`,
        `Evidence records: ${candidate.evidence.sourceRecordIds.length}`,
        "Candidate is inactive; it is not active Policy and cannot change normal coding behavior.",
      ].join("\n"),
    }],
    details: { candidateId: candidate.candidateId } satisfies StrategyCandidateToolDetails,
  };
}

/** Narrow model-callable Candidate creation; target identity comes only from the live lease. */
export function createPindieStrategyCandidateTool(
  options: StrategyCandidateToolOptions,
) {
  return defineTool({
    name: "pindie_strategy_candidate_create",
    label: "Create Strategy Revision Candidate",
    description: "Propose one bounded inactive Strategy Revision Candidate during an explicit /adapt <strategy-id> Run. The target Strategy is fixed by that live adaptation attempt; do not use this during ordinary coding Runs. Candidate creation is optional and evidence is not causal proof.",
    parameters: StrategyCandidateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const projectRoot = options.getProjectRoot();
      if (projectRoot === null) {
        throw new Error("Cannot create a Strategy Revision Candidate: no current project root is loaded. Use /adapt <strategy-id> from a loaded project.");
      }
      let sessionId: string;
      try {
        sessionId = ctx.sessionManager.getSessionId();
      } catch (error) {
        throw new Error(`Cannot create a Strategy Revision Candidate: ${errorMessage(error)}`);
      }
      const lease = options.adaptation.activeFor(
        sessionId,
        options.getAgentRunGeneration(),
      );
      if (lease === null) {
        throw new Error("Cannot create a Strategy Revision Candidate without a live adaptation attempt. Use /adapt <strategy-id> while the Agent is idle.");
      }

      let read;
      try {
        read = await options.experienceReader.read(projectRoot);
      } catch (error) {
        throw new Error(`Candidate provenance could not read current Experience: ${errorMessage(error)}`);
      }
      const currentLease = options.adaptation.activeFor(
        sessionId,
        options.getAgentRunGeneration(),
      );
      if (currentLease === null || currentLease.attemptId !== lease.attemptId) {
        throw new Error("Candidate rejected: the adaptation Run is no longer current; start a new /adapt attempt.");
      }
      if (options.getProjectRoot() !== projectRoot) {
        throw new Error("Candidate rejected: the current project changed; start a new /adapt attempt.");
      }
      const validated = validateCandidateProvenance(currentLease, params, read.records);
      const candidate = createStrategyRevisionCandidate({
        target: validated.target,
        proposal: validated.proposal,
      });
      try {
        await options.candidateStore.save(projectRoot, candidate);
      } catch (error) {
        throw new Error(`Candidate was not persisted; the adaptation attempt remains retryable: ${errorMessage(error)}`);
      }
      if (!options.adaptation.consume(lease.attemptId)) {
        throw new Error("Candidate was persisted but the adaptation lease was no longer current.");
      }
      return candidateResult(candidate);
    },
  });
}
