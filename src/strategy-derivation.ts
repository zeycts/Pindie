import { randomUUID } from "node:crypto";

import {
  evaluateRunExperience,
  policyEvidenceProfileId,
  type RunEvaluation,
} from "./experience-evaluation.ts";
import type { RunExperienceSourceRecord } from "./experience-store.ts";
import { getProjectId } from "./store.ts";
import {
  policySnapshotIdentity,
  serializeStrategyRevisionSelection,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type PolicyStrategySelection,
} from "./policy.ts";
import { parseRunExperience } from "./run-experience.ts";
import {
  type TrustedPortfolioManifestEntry,
  type TrustedPortfolioResolvedEntry,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";

export const MAX_DERIVATION_PACKET_RUNS = 8;
export const MIN_DERIVATION_SOURCE_RECORDS = 3;
export const MIN_DERIVATION_SOURCE_GOALS = 2;
export const MIN_DERIVATION_SOURCE_POLICY_PROFILES = 2;
export const MAX_DERIVATION_PACKET_TASK_GOAL_LENGTH = 512;

export interface DerivationSufficiency {
  readonly distinctRecordCount: number;
  readonly distinctExactGoalCount: number;
  readonly distinctPolicyProfileCount: number;
  readonly sufficient: boolean;
}

export interface DerivationSourceSelection {
  readonly eligible: readonly RunEvaluation[];
  readonly shown: readonly RunEvaluation[];
  readonly sufficiency: DerivationSufficiency;
}

export interface DerivationPacketPortfolioEntry extends TrustedPortfolioManifestEntry {
  readonly semantics: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
}

export interface DerivationPacketRun {
  readonly sourceRecordId: string;
  /** Bounded presentation; exact goal identity is retained only for gate computation. */
  readonly taskGoal: string;
  readonly finalPolicy: {
    readonly policyIdentity: string;
    readonly policyProfileId: string;
    readonly approach: {
      readonly strategyId: string;
      readonly kind: "approach";
      readonly revisionIdentity: string;
      readonly revisionFingerprint: string;
      readonly revisionStatusAtRun: "seed" | "trial" | "promoted";
    };
    readonly modifiers: readonly {
      readonly strategyId: string;
      readonly kind: "modifier";
      readonly revisionIdentity: string;
      readonly revisionFingerprint: string;
      readonly revisionStatusAtRun: "seed" | "trial" | "promoted";
    }[];
  };
  readonly declarationCount: number;
  readonly finalPolicyDeclarationCount: number;
  readonly finalPolicyFirstDeclarationProgress: number | null;
  readonly finalPolicyLastActivationProgress: number | null;
  readonly finalPolicyExposureCalls: number;
  readonly finalPolicyExposureRatio: number | null;
  readonly verificationPassed: boolean;
  readonly completedDuringRun: boolean;
  readonly toolErrors: number;
  readonly deniedCalls: number;
  readonly durationMs: number | null;
  readonly cost: number | null;
}

export interface DerivationPacket {
  readonly projectId: string;
  readonly portfolio: {
    readonly fingerprintVersion: 1;
    readonly fingerprint: string;
    /** Canonical identity-only manifest entries. */
    readonly entries: readonly TrustedPortfolioManifestEntry[];
    /** Runtime-resolved semantics paired with the canonical entries for context. */
    readonly resolvedEntries: readonly DerivationPacketPortfolioEntry[];
  };
  readonly evidence: {
    readonly eligibleRunCount: number;
    readonly shownRunCount: number;
    readonly omittedRunCount: number;
    readonly runs: readonly DerivationPacketRun[];
  };
  readonly sufficiency: DerivationSufficiency;
  readonly sourceRecordIds: readonly string[];
  readonly boundaryText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function boundedTaskGoal(goal: string): string {
  return goal.length <= MAX_DERIVATION_PACKET_TASK_GOAL_LENGTH
    ? goal
    : `${goal.slice(0, MAX_DERIVATION_PACKET_TASK_GOAL_LENGTH - 14)} [truncated]`;
}

function uniqueValidExperienceSources(
  records: readonly RunExperienceSourceRecord[],
): readonly RunExperienceSourceRecord[] {
  const raw = records.flatMap((record) => {
    if (!isRecord(record) || typeof record.recordId !== "string" || record.recordId.trim() === "") {
      return [];
    }
    let parsed;
    try {
      parsed = parseRunExperience(record.experience);
    } catch {
      parsed = null;
    }
    return parsed === null
      ? []
      : [{ recordId: record.recordId, experience: parsed }];
  });
  const counts = new Map<string, number>();
  for (const record of raw) counts.set(record.recordId, (counts.get(record.recordId) ?? 0) + 1);
  return Object.freeze(raw
    .filter((record) => counts.get(record.recordId) === 1)
    .sort((left, right) => compareText(left.recordId, right.recordId))
    .map((record) => Object.freeze(record)));
}

function selectionIdentity(selection: PolicyStrategySelection): {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
  readonly revisionStatusAtRun: "seed" | "trial" | "promoted";
} {
  return {
    strategyId: strategySelectionId(selection),
    kind: selection.kind,
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
    revisionStatusAtRun: strategySelectionRevisionStatus(selection),
  };
}

function copySelectionIdentity(
  selection: PolicyStrategySelection,
): ReturnType<typeof selectionIdentity> {
  return Object.freeze(selectionIdentity(selection));
}

function copyApproachIdentity(
  selection: PolicyStrategySelection,
): DerivationPacketRun["finalPolicy"]["approach"] {
  const identity = selectionIdentity(selection);
  if (identity.kind !== "approach") {
    throw new Error("Final Policy approach has the wrong Strategy kind.");
  }
  return Object.freeze({ ...identity, kind: "approach" as const });
}

function copyModifierIdentity(
  selection: PolicyStrategySelection,
): DerivationPacketRun["finalPolicy"]["modifiers"][number] {
  const identity = selectionIdentity(selection);
  if (identity.kind !== "modifier") {
    throw new Error("Final Policy modifier has the wrong Strategy kind.");
  }
  return Object.freeze({ ...identity, kind: "modifier" as const });
}

function finalPolicySelections(
  snapshot: NonNullable<RunEvaluation["policy"]["finalSnapshot"]>,
): readonly PolicyStrategySelection[] {
  return [snapshot.approach, ...snapshot.modifiers];
}

/** Resolve every final Policy selection against one captured trusted portfolio. */
export function finalPolicyUsesOnlyTrustedRevisions(
  evaluation: RunEvaluation,
  portfolio: TrustedStrategyPortfolio,
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (
    !evaluation.attributionEligible ||
    snapshot === null ||
    evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0
  ) return false;

  // A Trial selection excludes the complete Run, including any co-occurring
  // trusted Seed selections. The status check is explicit before resolution.
  if (finalPolicySelections(snapshot).some((selection) =>
    strategySelectionRevisionStatus(selection) === "trial")) return false;

  return finalPolicySelections(snapshot).every((selection) =>
    strategySelectionRevisionStatus(selection) === "seed" ||
    strategySelectionRevisionStatus(selection) === "promoted"
      ? trustedSelectionIsExact(selection, portfolio)
      : false);
}

function trustedSelectionIsExact(
  selection: PolicyStrategySelection,
  portfolio: TrustedStrategyPortfolio,
): boolean {
  // The portfolio resolver checks origin/status, exact revision identity and
  // fingerprint, and the immutable source semantics. No display label or
  // logical Strategy ID alone can establish trust.
  const resolved = portfolio.resolvedEntries.find((entry) => {
    const manifest = entry.manifest;
    const status = strategySelectionRevisionStatus(selection);
    const expectedOrigin = status === "seed" ? "seed" : "promoted-seed-revision";
    return manifest.origin === expectedOrigin &&
      manifest.strategyId === strategySelectionId(selection) &&
      manifest.kind === selection.kind &&
      manifest.revisionIdentity === strategySelectionRevisionIdentity(selection) &&
      manifest.revisionFingerprint === strategySelectionRevisionFingerprint(selection);
  });
  if (resolved === undefined) return false;
  const semantics = serializeStrategyRevisionSelection(selection).semantics;
  return JSON.stringify({
    summary: semantics.summary,
    useWhen: [...semantics.useWhen],
    avoidWhen: [...semantics.avoidWhen],
    principles: [...semantics.principles],
  }) === JSON.stringify({
    summary: resolved.semantics.summary,
    useWhen: [...resolved.semantics.useWhen],
    avoidWhen: [...resolved.semantics.avoidWhen],
    principles: [...resolved.semantics.principles],
  });
}

/** Select only valid current schema-v4 trusted-policy source Runs. */
export function selectDerivationSourceEvidence(
  portfolio: TrustedStrategyPortfolio,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const evaluations = uniqueValidExperienceSources(records)
    .map((record) => evaluateRunExperience(record))
    .filter((evaluation) => finalPolicyUsesOnlyTrustedRevisions(evaluation, portfolio))
    .sort(compareNewest);
  return Object.freeze(evaluations);
}

export const selectEligibleDerivationEvidence = selectDerivationSourceEvidence;
export const selectDerivationEvidence = selectDerivationSourceEvidence;

/** Compute only the deterministic factual sufficiency gate. */
export function deriveDerivationSufficiency(
  evaluations: readonly RunEvaluation[],
): DerivationSufficiency {
  const records = new Set<string>();
  const goals = new Set<string>();
  const profiles = new Set<string>();
  for (const evaluation of evaluations) {
    records.add(evaluation.source.recordId);
    goals.add(evaluation.source.taskGoal);
    profiles.add(policyEvidenceProfileId(evaluation.policy.finalSnapshot));
  }
  const distinctRecordCount = records.size;
  const distinctExactGoalCount = goals.size;
  const distinctPolicyProfileCount = profiles.size;
  return Object.freeze({
    distinctRecordCount,
    distinctExactGoalCount,
    distinctPolicyProfileCount,
    sufficient: distinctRecordCount >= MIN_DERIVATION_SOURCE_RECORDS &&
      distinctExactGoalCount >= MIN_DERIVATION_SOURCE_GOALS &&
      distinctPolicyProfileCount >= MIN_DERIVATION_SOURCE_POLICY_PROFILES,
  });
}

export const deriveDerivationEvidenceSufficiency = deriveDerivationSufficiency;

/**
 * Select a bounded shown set that itself satisfies the sufficiency gate, then
 * fill remaining capacity by the stable newest-record ordering.
 */
export function selectBoundedDerivationSourceEvidence(
  eligible: readonly RunEvaluation[],
): DerivationSourceSelection {
  const ordered = [...eligible].sort(compareNewest);
  const shown: RunEvaluation[] = [];
  const selected = new Set<string>();

  for (const evaluation of ordered) {
    if (shown.length >= MAX_DERIVATION_PACKET_RUNS) break;
    const current = deriveDerivationSufficiency(shown);
    const addsGoal = !new Set(shown.map((item) => item.source.taskGoal)).has(evaluation.source.taskGoal);
    const addsProfile = !new Set(shown.map((item) =>
      policyEvidenceProfileId(item.policy.finalSnapshot))).has(
      policyEvidenceProfileId(evaluation.policy.finalSnapshot),
    );
    if (
      shown.length < MIN_DERIVATION_SOURCE_RECORDS ||
      (!current.sufficient && (addsGoal || addsProfile))
    ) {
      shown.push(evaluation);
      selected.add(evaluation.source.recordId);
    }
    if (deriveDerivationSufficiency(shown).sufficient) break;
  }

  if (deriveDerivationSufficiency(shown).sufficient) {
    for (const evaluation of ordered) {
      if (shown.length >= MAX_DERIVATION_PACKET_RUNS) break;
      if (selected.has(evaluation.source.recordId)) continue;
      shown.push(evaluation);
      selected.add(evaluation.source.recordId);
    }
  }

  const frozenShown = Object.freeze(shown);
  return Object.freeze({
    eligible: Object.freeze(ordered),
    shown: frozenShown,
    sufficiency: deriveDerivationSufficiency(frozenShown),
  });
}

export const selectDerivationSourceRuns = selectBoundedDerivationSourceEvidence;

function copyPortfolioEntry(
  entry: TrustedPortfolioResolvedEntry,
): DerivationPacketPortfolioEntry {
  return Object.freeze({
    ...entry.manifest,
    semantics: Object.freeze({
      summary: entry.semantics.summary,
      useWhen: Object.freeze([...entry.semantics.useWhen]),
      avoidWhen: Object.freeze([...entry.semantics.avoidWhen]),
      principles: Object.freeze([...entry.semantics.principles]),
    }),
  });
}

function copyRun(evaluation: RunEvaluation): DerivationPacketRun {
  const snapshot = evaluation.policy.finalSnapshot;
  if (snapshot === null || evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0) {
    throw new Error("Cannot put a non-eligible Run into the Derivation Packet.");
  }
  return Object.freeze({
    sourceRecordId: evaluation.source.recordId,
    taskGoal: boundedTaskGoal(evaluation.source.taskGoal),
    finalPolicy: Object.freeze({
      policyIdentity: policySnapshotIdentity(snapshot),
      policyProfileId: policyEvidenceProfileId(snapshot),
      approach: copyApproachIdentity(snapshot.approach),
      modifiers: Object.freeze(snapshot.modifiers.map(copyModifierIdentity)),
    }),
    declarationCount: evaluation.policy.declarationCount,
    finalPolicyDeclarationCount: evaluation.policy.finalPolicyDeclarationCount,
    finalPolicyFirstDeclarationProgress: evaluation.policy.finalPolicyFirstDeclarationProgress,
    finalPolicyLastActivationProgress: evaluation.policy.finalPolicyLastActivationProgress,
    finalPolicyExposureCalls: evaluation.policy.finalPolicyExposureCalls,
    finalPolicyExposureRatio: evaluation.policy.finalPolicyExposureRatio,
    verificationPassed: evaluation.outcome.verificationPassed,
    completedDuringRun: evaluation.outcome.completedDuringRun,
    toolErrors: evaluation.execution.toolErrors,
    deniedCalls: evaluation.execution.deniedCalls,
    durationMs: evaluation.metrics.durationMs,
    cost: evaluation.metrics.cost,
  });
}

/** Build the one bounded factual packet for an explicit /derive Run. */
export function buildDerivationPacket(
  projectRoot: string,
  portfolio: TrustedStrategyPortfolio,
  records: readonly RunExperienceSourceRecord[],
): DerivationPacket {
  if (portfolio.projectId !== getProjectId(projectRoot)) {
    throw new Error("Trusted portfolio is not bound to the current project root.");
  }
  const selection = selectBoundedDerivationSourceEvidence(
    selectDerivationSourceEvidence(portfolio, records),
  );
  if (!selection.sufficiency.sufficient) {
    throw new Error("Derivation source evidence is insufficient for a bounded packet.");
  }

  const resolvedEntries = Object.freeze(portfolio.resolvedEntries.map(copyPortfolioEntry));
  const shown = Object.freeze(selection.shown.map(copyRun));
  const sufficiency = deriveDerivationSufficiency(selection.shown);
  if (!sufficiency.sufficient) {
    throw new Error("The shown Derivation Packet evidence does not satisfy its sufficiency gate.");
  }
  return Object.freeze({
    projectId: portfolio.projectId,
    portfolio: Object.freeze({
      fingerprintVersion: portfolio.fingerprintVersion,
      fingerprint: portfolio.fingerprint,
      entries: Object.freeze(portfolio.entries.map((entry) => Object.freeze({ ...entry }))),
      resolvedEntries,
    }),
    evidence: Object.freeze({
      eligibleRunCount: selection.eligible.length,
      shownRunCount: shown.length,
      omittedRunCount: selection.eligible.length - shown.length,
      runs: shown,
    }),
    sufficiency,
    sourceRecordIds: Object.freeze(shown.map((run) => run.sourceRecordId)),
    boundaryText: "This evidence permits only an optional missing-abstraction hypothesis. It does not establish novelty, usefulness, superiority, or causality.",
  });
}

export const buildStrategyDerivationPacket = buildDerivationPacket;

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return String(value);
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatSelection(selection: ReturnType<typeof selectionIdentity>): string {
  return `${selection.strategyId} (${selection.kind}; revision ${selection.revisionIdentity}; fingerprint ${selection.revisionFingerprint}; status ${selection.revisionStatusAtRun})`;
}

/** Render only the bounded factual packet allowed in an explicit /derive Run. */
export function formatDerivationPacket(packet: DerivationPacket): string {
  const lines = [
    "<PINDIE_DERIVATION_PACKET>",
    "Explicit Self-Improvement derivation slow-path work; this is not a project implementation Task.",
    "Do not create, replace, refine, progress, verify, gate, or complete a Pindie Task for this derivation.",
    "Do not mutate the project. Inspect this bounded factual evidence and optionally propose one inactive new-logical-Strategy Candidate.",
    "",
    "Project binding:",
    `- projectId: ${packet.projectId}`,
    "",
    "Current trusted Strategy portfolio:",
    `- Fingerprint version: ${packet.portfolio.fingerprintVersion}`,
    `- Portfolio fingerprint: ${packet.portfolio.fingerprint}`,
  ];
  for (const entry of packet.portfolio.resolvedEntries) {
    lines.push(
      `- ${entry.origin}: ${entry.strategyId} (${entry.kind})`,
      `  Revision identity: ${entry.revisionIdentity}`,
      `  Revision fingerprint: ${entry.revisionFingerprint}`,
      `  Summary: ${entry.semantics.summary}`,
      "  Use when:",
      ...entry.semantics.useWhen.map((value) => `    - ${value}`),
      "  Avoid when:",
      ...(entry.semantics.avoidWhen.length > 0
        ? entry.semantics.avoidWhen.map((value) => `    - ${value}`)
        : ["    - none"]),
      "  Principles:",
      ...entry.semantics.principles.map((value) => `    - ${value}`),
    );
  }

  lines.push(
    "",
    "Source evidence inventory:",
    `- Eligible source Runs: ${packet.evidence.eligibleRunCount}`,
    `- Shown source Runs: ${packet.evidence.shownRunCount}`,
    `- Omitted source Runs: ${packet.evidence.omittedRunCount}`,
    "",
    "Shown eligible source Runs:",
  );
  for (const run of packet.evidence.runs) {
    lines.push(
      `- Source record ID: ${run.sourceRecordId}`,
      `  Task goal: ${run.taskGoal}`,
      `  Policy identity: ${run.finalPolicy.policyIdentity}`,
      `  Policy Evidence Profile identity: ${run.finalPolicy.policyProfileId}`,
      `  Final approach: ${formatSelection(run.finalPolicy.approach)}`,
      `  Final modifiers: ${run.finalPolicy.modifiers.length > 0
        ? run.finalPolicy.modifiers.map(formatSelection).join("; ")
        : "none"}`,
      `  Policy declarations: ${run.declarationCount}`,
      `  Final-Policy declarations: ${run.finalPolicyDeclarationCount}`,
      `  First final-Policy declaration progress: ${formatRatio(run.finalPolicyFirstDeclarationProgress)}`,
      `  Last final-Policy activation progress: ${formatRatio(run.finalPolicyLastActivationProgress)}`,
      `  Continuous final-Policy exposure calls: ${run.finalPolicyExposureCalls}`,
      `  Continuous final-Policy exposure ratio: ${formatRatio(run.finalPolicyExposureRatio)}`,
      `  Verification passed: ${run.verificationPassed}`,
      `  Completed during Run: ${run.completedDuringRun}`,
      `  Tool errors: ${run.toolErrors}`,
      `  Denied calls: ${run.deniedCalls}`,
      `  Duration: ${formatNumber(run.durationMs)}`,
      `  Cost: ${formatNumber(run.cost)}`,
    );
  }
  lines.push(
    "",
    "Sufficiency facts for the shown packet:",
    `- Distinct source records: ${packet.sufficiency.distinctRecordCount}`,
    `- Distinct exact Task goals: ${packet.sufficiency.distinctExactGoalCount}`,
    `- Distinct Policy Evidence Profile identities: ${packet.sufficiency.distinctPolicyProfileCount}`,
    `- Minimum gate satisfied: ${packet.sufficiency.sufficient}`,
    "",
    "Derivation boundary:",
    `- ${packet.boundaryText}`,
    "- This permits only an optional missing-abstraction hypothesis; it is not a finding about the portfolio or any Strategy.",
    "- It does not establish novelty, usefulness, superiority, causality, quality, score, reward, ranking, or similarity.",
    "- Candidate creation is optional. If justified, call pindie_strategy_derivation_candidate_create once with only its proposal and cited packet source IDs.",
    "- A Derivation Candidate is an inactive immutable hypothesis and is not usable as Policy in Slice A.",
    "</PINDIE_DERIVATION_PACKET>",
  );
  return lines.join("\n");
}

export const renderDerivationPacket = formatDerivationPacket;

export interface DerivationLease {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly portfolio: TrustedStrategyPortfolio;
  readonly packet: DerivationPacket;
  readonly sourceRecordIds: readonly string[];
  readonly renderedPacket: string;
  readonly agentRunGeneration: number | null;
}

/** Runtime-only pending/active explicit /derive lease. */
export class DerivationRuntime {
  private pending: DerivationLease | null = null;
  private active: DerivationLease | null = null;

  get hasDerivation(): boolean {
    return this.pending !== null || this.active !== null;
  }

  get hasAttempt(): boolean {
    return this.hasDerivation;
  }

  get hasPendingDerivation(): boolean {
    return this.pending !== null;
  }

  get hasActiveDerivation(): boolean {
    return this.active !== null;
  }

  get pendingDerivation(): DerivationLease | null {
    return this.pending;
  }

  get activeDerivation(): DerivationLease | null {
    return this.active;
  }

  establish(
    sessionId: string,
    portfolio: TrustedStrategyPortfolio,
    packet: DerivationPacket,
  ): boolean {
    if (
      sessionId.trim() === "" ||
      this.hasDerivation ||
      packet.projectId !== portfolio.projectId ||
      packet.portfolio.fingerprint !== portfolio.fingerprint
    ) return false;
    this.pending = Object.freeze({
      attemptId: randomUUID(),
      sessionId,
      projectId: portfolio.projectId,
      portfolio,
      packet,
      sourceRecordIds: Object.freeze([...packet.sourceRecordIds]),
      renderedPacket: formatDerivationPacket(packet),
      agentRunGeneration: null,
    });
    return true;
  }

  bind(sessionId: string, agentRunGeneration: number): DerivationLease | null {
    if (
      this.pending === null ||
      this.active !== null ||
      this.pending.sessionId !== sessionId ||
      !Number.isSafeInteger(agentRunGeneration) ||
      agentRunGeneration < 0
    ) return null;
    this.active = Object.freeze({ ...this.pending, agentRunGeneration });
    this.pending = null;
    return this.active;
  }

  isActiveForGeneration(agentRunGeneration: number | null): boolean {
    return this.active !== null &&
      agentRunGeneration !== null &&
      this.active.agentRunGeneration === agentRunGeneration;
  }

  activeFor(
    sessionId: string | null,
    agentRunGeneration: number | null,
  ): DerivationLease | null {
    if (
      this.active === null ||
      sessionId === null ||
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