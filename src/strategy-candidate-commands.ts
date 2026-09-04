import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  deriveCandidateTrialReview,
  type CandidateTrialReview,
} from "./experience-evaluation.ts";
import type { RunExperienceReader } from "./experience-store.ts";
import {
  formatCandidateCommandLabel,
  isCanonicalStrategyCandidateId,
  MAX_CANDIDATE_COMMAND_LABEL_LENGTH,
  validateStrategyRevisionCandidateArtifact,
  type StrategyCandidateReader,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  validateStrategyRevisionDecisionArtifact,
  validateStrategyRevisionDecisionBinding,
  type StrategyRevisionDecision,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";

export type CandidateCommandName = "trial" | "trial-review" | "promote" | "reject";

export interface CandidateCommandProjectionInput {
  readonly projectRoot: string;
  readonly command: CandidateCommandName;
  readonly candidateReader: StrategyCandidateReader;
  readonly decisionReader: StrategyRevisionDecisionReader;
  readonly experienceReader: RunExperienceReader;
}

export interface CandidateCommandProjectionEntry {
  readonly candidate: StrategyRevisionCandidate;
  readonly decision: StrategyRevisionDecision | null;
  readonly trialReview: CandidateTrialReview;
  readonly promotionEligible: boolean;
  readonly label: string;
  readonly option: AutocompleteItem;
}

export interface CandidateCommandProjection {
  readonly command: CandidateCommandName;
  readonly entries: readonly CandidateCommandProjectionEntry[];
  readonly options: readonly AutocompleteItem[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateTargetKey(candidate: StrategyRevisionCandidate): string {
  return `${candidate.target.strategyId}\0${candidate.target.kind}\0${candidate.target.baseFingerprint}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readAllCandidates(
  reader: StrategyCandidateReader,
  projectRoot: string,
): Promise<readonly StrategyRevisionCandidate[]> {
  if (typeof reader.readAll !== "function") {
    throw new Error("Candidate enumeration is unavailable for this project reader.");
  }
  const rawCandidates = await reader.readAll(projectRoot);
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Candidate reader returned an invalid collection.");
  }

  const candidateIds = new Set<string>();
  const candidates = rawCandidates.map((rawCandidate) => {
    const candidate = validateStrategyRevisionCandidateArtifact(rawCandidate);
    if (!isCanonicalStrategyCandidateId(candidate.candidateId)) {
      throw new Error("Candidate reader returned a non-canonical Candidate ID.");
    }
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error("Candidate reader returned duplicate Candidate IDs.");
    }
    candidateIds.add(candidate.candidateId);
    return candidate;
  });
  return Object.freeze(candidates.sort((left, right) =>
    compareText(left.candidateId, right.candidateId)));
}

async function readDecisions(
  reader: StrategyRevisionDecisionReader,
  projectRoot: string,
  candidates: readonly StrategyRevisionCandidate[],
): Promise<ReadonlyMap<string, StrategyRevisionDecision>> {
  const rawDecisions = await reader.readAll(projectRoot);
  if (!Array.isArray(rawDecisions)) {
    throw new Error("Decision reader returned an invalid collection.");
  }
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const decisions = new Map<string, StrategyRevisionDecision>();
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategyRevisionDecisionArtifact(rawDecision);
    if (decisions.has(decision.candidateId)) {
      throw new Error("Duplicate or conflicting terminal Decisions were found for one Candidate.");
    }
    const candidate = candidatesById.get(decision.candidateId);
    if (candidate === undefined) {
      throw new Error(`Decision '${decision.candidateId}' is missing its immutable Candidate artifact.`);
    }
    const bound = validateStrategyRevisionDecisionBinding(decision, candidate);
    decisions.set(bound.candidateId, bound);
  }
  return decisions;
}

function eligibleTrialCount(entry: CandidateCommandProjectionEntry): number {
  return entry.trialReview.candidateProfile.runCount;
}

function reviewHint(entry: CandidateCommandProjectionEntry): string {
  const count = eligibleTrialCount(entry);
  const parts = [`${count} eligible trial${count === 1 ? "" : "s"}`];
  if (entry.promotionEligible) parts.push("promotion eligible");
  else if (entry.decision !== null) parts.push(`decision: ${entry.decision.decision}`);
  return parts.join(" · ");
}

function boundedLabel(value: string): string {
  if (value.length <= MAX_CANDIDATE_COMMAND_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_CANDIDATE_COMMAND_LABEL_LENGTH - 1)}…`;
}

function labelFor(
  entry: Pick<CandidateCommandProjectionEntry, "candidate" | "trialReview" | "decision" | "promotionEligible">,
  command: CandidateCommandName,
  includeCandidateId: boolean,
  candidateIdLength: number,
): string {
  const hint = command === "trial" || command === "trial-review"
    ? reviewHint(entry as CandidateCommandProjectionEntry)
    : command === "promote"
      ? "promotion eligible"
      : "";
  const hintSuffixLength = hint.length === 0 ? 0 : 3 + hint.length;
  const label = formatCandidateCommandLabel(entry.candidate, {
    includeCandidateId,
    candidateIdLength,
    maxLength: MAX_CANDIDATE_COMMAND_LABEL_LENGTH - hintSuffixLength,
  });
  return boundedLabel(hint.length === 0 ? label : `${label} · ${hint}`);
}

function disambiguatedLabels(
  entries: readonly CandidateCommandProjectionEntry[],
  command: CandidateCommandName,
): readonly string[] {
  const baseLabels = entries.map((entry) => labelFor(entry, command, false, 8));
  const groups = new Map<string, number[]>();
  baseLabels.forEach((label, index) => {
    const group = groups.get(label) ?? [];
    group.push(index);
    groups.set(label, group);
  });

  const labels = [...baseLabels];
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    let suffixLength = 8;
    while (true) {
      const suffixes = new Set(indexes.map((index) =>
        entries[index]!.candidate.candidateId.slice(0, suffixLength)));
      if (suffixes.size === indexes.length || suffixLength >= 36) break;
      suffixLength = Math.min(36, suffixLength + 4);
    }
    for (const index of indexes) {
      labels[index] = labelFor(entries[index]!, command, true, suffixLength);
    }
  }
  return Object.freeze(labels);
}

function sortEntries(
  entries: CandidateCommandProjectionEntry[],
  command: CandidateCommandName,
): CandidateCommandProjectionEntry[] {
  if (command === "trial-review") {
    entries.sort((left, right) => {
      const evidenceOrder = eligibleTrialCount(right) - eligibleTrialCount(left);
      if (evidenceOrder !== 0) return evidenceOrder;
      const labelOrder = compareText(left.label, right.label);
      return labelOrder !== 0
        ? labelOrder
        : compareText(left.candidate.candidateId, right.candidate.candidateId);
    });
    return entries;
  }
  return entries.sort((left, right) => {
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.candidate.candidateId, right.candidate.candidateId);
  });
}

/**
 * Read and derive one fresh, read-only Candidate command projection. The
 * returned options contain canonical UUID values; all lifecycle facts are
 * recomputed from immutable artifacts for this call.
 */
export async function buildCandidateCommandProjection(
  input: CandidateCommandProjectionInput,
): Promise<CandidateCommandProjection> {
  const candidates = await readAllCandidates(input.candidateReader, input.projectRoot);
  const decisions = await readDecisions(input.decisionReader, input.projectRoot, candidates);
  const experience = await input.experienceReader.read(input.projectRoot);
  const promotedTargets = new Set(
    [...decisions.values()]
      .filter((decision) => decision.decision === "promoted")
      .map((decision) => {
        const candidate = candidates.find((value) => value.candidateId === decision.candidateId);
        return candidate === undefined ? null : candidateTargetKey(candidate);
      })
      .filter((key): key is string => key !== null),
  );

  const allEntries = candidates.map((candidate) => {
    const decision = decisions.get(candidate.candidateId) ?? null;
    const trialReview = deriveCandidateTrialReview(candidate, experience.records, {
      currentProjectMatch: true,
      priorTerminalDecision: decision !== null,
    });
    const promotionEligible = decision === null &&
      trialReview.promotionEligibility.eligible &&
      !promotedTargets.has(candidateTargetKey(candidate));
    return {
      candidate,
      decision,
      trialReview,
      promotionEligible,
      label: "",
      option: { value: candidate.candidateId, label: "" },
    } satisfies CandidateCommandProjectionEntry;
  });

  const filtered = allEntries.filter((entry) => {
    switch (input.command) {
      case "trial":
        return entry.decision === null;
      case "trial-review":
        return true;
      case "promote":
        return entry.promotionEligible;
      case "reject":
        return entry.decision === null;
    }
  });
  const labels = disambiguatedLabels(filtered, input.command);
  const labeled = filtered.map((entry, index) => {
    const label = labels[index]!;
    return Object.freeze({
      ...entry,
      label,
      option: Object.freeze({ value: entry.candidate.candidateId, label }),
    });
  });
  const sorted = sortEntries(labeled, input.command);
  return Object.freeze({
    command: input.command,
    entries: Object.freeze(sorted),
    options: Object.freeze(sorted.map((entry) => entry.option)),
  });
}

/** Resolve a completion prefix without treating labels as parser-visible IDs. */
export function filterCandidateCommandOptions(
  projection: CandidateCommandProjection,
  prefix: string,
): AutocompleteItem[] {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

/** Render a bounded diagnostic for failed advisory completion reads. */
export function candidateCommandProjectionError(error: unknown): string {
  return errorMessage(error);
}
