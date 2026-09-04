import { randomUUID } from "node:crypto";

import {
  deriveRunEvaluations,
  type RunEvaluation,
} from "./experience-evaluation.ts";
import type { RunExperienceSourceRecord } from "./experience-store.ts";
import { isSeedStrategySelection } from "./policy.ts";
import { MAX_ADAPTATION_PACKET_RUNS } from "./strategy-candidates.ts";
import {
  seedStrategyFingerprint,
  type SeedStrategy,
  type SeedStrategyKind,
} from "./strategies.ts";

export interface AdaptationPacketRun {
  readonly sourceRecordId: string;
  readonly taskGoal: string;
  readonly finalPolicy: {
    readonly approachId: string;
    readonly modifierIds: readonly string[];
  };
  readonly finalPolicyExposureRatio: number | null;
  readonly firstDeclarationProgress: number | null;
  readonly lastActivationProgress: number | null;
  readonly verificationPassed: boolean;
  readonly completedDuringRun: boolean;
  readonly toolErrors: number;
  readonly deniedCalls: number;
  readonly durationMs: number | null;
  readonly cost: number | null;
}

export interface AdaptationPacket {
  readonly target: {
    readonly strategyId: string;
    readonly kind: SeedStrategyKind;
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
    readonly baseFingerprint: string;
  };
  readonly evidence: {
    readonly eligibleRunCount: number;
    readonly shownRunCount: number;
    readonly omittedRunCount: number;
    readonly runs: readonly AdaptationPacketRun[];
  };
  readonly sourceRecordIds: readonly string[];
}

const MAX_PACKET_TASK_GOAL_LENGTH = 512;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNewest(left: RunEvaluation, right: RunEvaluation): number {
  const leftTime = Date.parse(left.source.recordedAt);
  const rightTime = Date.parse(right.source.recordedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const recordedAt = compareText(right.source.recordedAt, left.source.recordedAt);
  return recordedAt !== 0
    ? recordedAt
    : compareText(left.source.recordId, right.source.recordId);
}

function targetParticipated(
  evaluation: RunEvaluation,
  target: SeedStrategy,
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (!evaluation.attributionEligible || snapshot === null) return false;
  return target.kind === "approach"
    ? snapshot.approach.id === target.id && isSeedStrategySelection(snapshot.approach)
    : snapshot.modifiers.some((modifier) =>
      modifier.id === target.id && isSeedStrategySelection(modifier));
}

function boundedTaskGoal(goal: string): string {
  return goal.length <= MAX_PACKET_TASK_GOAL_LENGTH
    ? goal
    : `${goal.slice(0, MAX_PACKET_TASK_GOAL_LENGTH - 14)} [truncated]`;
}

function copyRun(evaluation: RunEvaluation): AdaptationPacketRun {
  const policy = evaluation.policy.finalSnapshot!;
  return Object.freeze({
    sourceRecordId: evaluation.source.recordId,
    taskGoal: boundedTaskGoal(evaluation.source.taskGoal),
    finalPolicy: Object.freeze({
      approachId: policy.approach.id,
      modifierIds: Object.freeze(policy.modifiers.map((modifier) => modifier.id)),
    }),
    finalPolicyExposureRatio: evaluation.policy.finalPolicyExposureRatio,
    firstDeclarationProgress: evaluation.policy.finalPolicyFirstDeclarationProgress,
    lastActivationProgress: evaluation.policy.finalPolicyLastActivationProgress,
    verificationPassed: evaluation.outcome.verificationPassed,
    completedDuringRun: evaluation.outcome.completedDuringRun,
    toolErrors: evaluation.execution.toolErrors,
    deniedCalls: evaluation.execution.deniedCalls,
    durationMs: evaluation.metrics.durationMs,
    cost: evaluation.metrics.cost,
  });
}

/** Select one target's attributable SI v0.4 evidence deterministically. */
export function selectAdaptationEvidence(
  target: SeedStrategy,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const seen = new Set<string>();
  return Object.freeze(deriveRunEvaluations(records)
    .filter((evaluation) => {
      if (seen.has(evaluation.source.recordId) || !targetParticipated(evaluation, target)) return false;
      seen.add(evaluation.source.recordId);
      return true;
    })
    .sort(compareNewest));
}

/** Build the bounded model-facing packet for one explicit target Seed. */
export function buildAdaptationPacket(
  target: SeedStrategy,
  records: readonly RunExperienceSourceRecord[],
): AdaptationPacket {
  const eligible = selectAdaptationEvidence(target, records);
  const shown = eligible.slice(0, MAX_ADAPTATION_PACKET_RUNS).map(copyRun);
  return Object.freeze({
    target: Object.freeze({
      strategyId: target.id,
      kind: target.kind,
      summary: target.summary,
      useWhen: Object.freeze([...target.useWhen]),
      avoidWhen: Object.freeze([...(target.avoidWhen ?? [])]),
      principles: Object.freeze([...target.principles]),
      baseFingerprint: seedStrategyFingerprint(target),
    }),
    evidence: Object.freeze({
      eligibleRunCount: eligible.length,
      shownRunCount: shown.length,
      omittedRunCount: eligible.length - shown.length,
      runs: Object.freeze(shown),
    }),
    sourceRecordIds: Object.freeze(shown.map((run) => run.sourceRecordId)),
  });
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return String(value);
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatPolicy(run: AdaptationPacketRun): string {
  return `${run.finalPolicy.approachId}${run.finalPolicy.modifierIds.length > 0
    ? ` + ${run.finalPolicy.modifierIds.join(", ")}`
    : ""}`;
}

/** Render only the bounded, evidence-only information allowed in an adaptation Run. */
export function formatAdaptationPacket(packet: AdaptationPacket): string {
  const lines = [
    "<PINDIE_ADAPTATION_PACKET>",
    "Explicit Self-Improvement slow-path work; this is not a project implementation Task.",
    "Do not create, replace, refine, progress, verify, gate, or complete a Pindie Task for this adaptation.",
    "Do not mutate the project. Inspect this bounded evidence and either conclude that no revision is justified or propose one Candidate.",
    "",
    "Target Seed Strategy:",
    `- ID: ${packet.target.strategyId}`,
    `- Kind: ${packet.target.kind}`,
    `- Summary: ${packet.target.summary}`,
    "- Use when:",
    ...packet.target.useWhen.map((item) => `  - ${item}`),
    "- Avoid when:",
    ...(packet.target.avoidWhen.length > 0
      ? packet.target.avoidWhen.map((item) => `  - ${item}`)
      : ["  - none"]),
    "- Principles:",
    ...packet.target.principles.map((item) => `  - ${item}`),
    `- Base fingerprint: ${packet.target.baseFingerprint}`,
    "",
    "Evidence boundary:",
    `- Eligible attributable Runs: ${packet.evidence.eligibleRunCount}`,
    `- Shown Runs: ${packet.evidence.shownRunCount}`,
    `- Omitted Runs: ${packet.evidence.omittedRunCount}`,
    "- This is bounded evidence, not causal proof or proof of superiority.",
    "",
    "Eligible evidence Runs:",
  ];

  if (packet.evidence.runs.length === 0) {
    lines.push("  (none)");
  } else {
    for (const run of packet.evidence.runs) {
      lines.push(
        `- ${run.sourceRecordId}`,
        `  Task goal: ${run.taskGoal}`,
        `  Final Policy: ${formatPolicy(run)}`,
        `  Final-Policy exposure ratio: ${formatRatio(run.finalPolicyExposureRatio)}`,
        `  First declaration progress: ${formatRatio(run.firstDeclarationProgress)}`,
        `  Last activation progress: ${formatRatio(run.lastActivationProgress)}`,
        `  Verification passed: ${run.verificationPassed}`,
        `  Completed during Run: ${run.completedDuringRun}`,
        `  Tool errors: ${run.toolErrors}`,
        `  Denied calls: ${run.deniedCalls}`,
        `  Duration: ${formatNumber(run.durationMs)}`,
        `  Cost: ${formatNumber(run.cost)}`,
      );
    }
  }

  lines.push(
    "",
    "Candidate contract:",
    `- Preserve target Strategy ID '${packet.target.strategyId}' and kind '${packet.target.kind}'.`,
    "- Evidence references must be source record IDs from this packet.",
    "- A Candidate is one bounded hypothesis and remains inactive; it is not active Policy.",
    "- Co-occurring Strategies are confounders.",
    "- An outcome does not prove that the target Strategy caused it.",
    "- It is valid to conclude that current evidence does not justify a revision.",
    "- Candidate creation is optional; call pindie_strategy_candidate_create only for one bounded proposal.",
    "</PINDIE_ADAPTATION_PACKET>",
  );
  return lines.join("\n");
}

export interface AdaptationLease {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly target: SeedStrategy;
  readonly baseFingerprint: string;
  readonly sourceRecordIds: readonly string[];
  readonly packet: AdaptationPacket;
  readonly renderedPacket: string;
  readonly agentRunGeneration: number | null;
}

/** Runtime-only pending/active adaptation identity; nothing here is persisted. */
export class AdaptationRuntime {
  private pending: AdaptationLease | null = null;
  private active: AdaptationLease | null = null;

  get hasAttempt(): boolean {
    return this.pending !== null || this.active !== null;
  }

  establish(
    sessionId: string,
    target: SeedStrategy,
    packet: AdaptationPacket,
  ): boolean {
    if (this.hasAttempt) return false;
    this.pending = Object.freeze({
      attemptId: randomUUID(),
      sessionId,
      target,
      baseFingerprint: packet.target.baseFingerprint,
      sourceRecordIds: packet.sourceRecordIds,
      packet,
      renderedPacket: formatAdaptationPacket(packet),
      agentRunGeneration: null,
    });
    return true;
  }

  bind(sessionId: string, agentRunGeneration: number): AdaptationLease | null {
    if (this.pending === null || this.pending.sessionId !== sessionId) return null;
    this.active = Object.freeze({ ...this.pending, agentRunGeneration });
    this.pending = null;
    return this.active;
  }

  isActiveForGeneration(agentRunGeneration: number | null): boolean {
    return this.active !== null &&
      agentRunGeneration !== null &&
      this.active.agentRunGeneration === agentRunGeneration;
  }

  activeFor(sessionId: string, agentRunGeneration: number | null): AdaptationLease | null {
    if (
      this.active === null ||
      agentRunGeneration === null ||
      this.active.sessionId !== sessionId ||
      this.active.agentRunGeneration !== agentRunGeneration
    ) return null;
    return this.active;
  }

  consume(attemptId: string): boolean {
    if (this.active?.attemptId !== attemptId) return false;
    this.active = null;
    return true;
  }

  clear(): void {
    this.pending = null;
    this.active = null;
  }
}
