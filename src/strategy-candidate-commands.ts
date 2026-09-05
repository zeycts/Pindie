import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  deriveCandidateTrialReview,
  deriveStrategyDerivationTrialReview,
  type CandidateTrialReview,
  type StrategyDerivationTrialReview,
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
import {
  validateStrategyDerivationCandidateBinding,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  trustedLogicalStrategyIds,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";

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

export interface TrialCommandProjectionInput {
  readonly projectRoot: string;
  readonly candidateReader: StrategyCandidateReader;
  readonly derivationCandidateReader: StrategyDerivationCandidateReader;
  readonly decisionReader: StrategyRevisionDecisionReader;
  readonly experienceReader: RunExperienceReader;
  /** Fresh current trust used to exclude stale or collided Derivation Candidates. */
  readonly trustedPortfolio: TrustedStrategyPortfolio;
}

export interface TrialReviewCommandProjectionInput {
  readonly projectRoot: string;
  readonly candidateReader: StrategyCandidateReader;
  readonly derivationCandidateReader: StrategyDerivationCandidateReader;
  readonly decisionReader: StrategyRevisionDecisionReader;
  readonly experienceReader: RunExperienceReader;
  /** Fresh current trust; null keeps review options but makes the gate false. */
  readonly trustedPortfolio: TrustedStrategyPortfolio | null;
}

export type TrialCommandProjectionEntry =
  | (CandidateCommandProjectionEntry & { readonly kind: "revision" })
  | {
      readonly kind: "derivation";
      readonly candidate: StrategyDerivationCandidateV1;
      readonly label: string;
      readonly option: AutocompleteItem;
    };

export type TrialReviewCommandProjectionEntry =
  | (CandidateCommandProjectionEntry & { readonly kind: "revision" })
  | {
      readonly kind: "derivation";
      readonly candidate: StrategyDerivationCandidateV1;
      readonly trialReview: StrategyDerivationTrialReview;
      readonly promotionEligible: boolean;
      readonly label: string;
      readonly option: AutocompleteItem;
    };

export interface TrialReviewCommandProjection {
  readonly entries: readonly TrialReviewCommandProjectionEntry[];
  readonly options: readonly AutocompleteItem[];
}

export interface TrialCommandProjection {
  readonly entries: readonly TrialCommandProjectionEntry[];
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

async function readAllDerivationCandidates(
  reader: StrategyDerivationCandidateReader,
  projectRoot: string,
  trustedPortfolio: TrustedStrategyPortfolio,
): Promise<readonly StrategyDerivationCandidateV1[]> {
  if (typeof reader.readAll !== "function") {
    throw new Error("Strategy Derivation Candidate enumeration is unavailable for this project reader.");
  }
  const rawCandidates = await reader.readAll(projectRoot);
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Strategy Derivation Candidate reader returned an invalid collection.");
  }

  const candidateIds = new Set<string>();
  const candidates: StrategyDerivationCandidateV1[] = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = validateStrategyDerivationCandidateBinding(
      rawCandidate,
      projectRoot,
      trustedPortfolio,
    );
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error("Strategy Derivation Candidate reader returned duplicate Candidate IDs.");
    }
    candidateIds.add(candidate.candidateId);
    // Keep every validated ID in this intermediate collection so a
    // cross-store UUID collision is detected even when the proposed logical
    // identity is no longer available for Trial options.
    candidates.push(candidate);
  }
  return Object.freeze(candidates.sort((left, right) =>
    compareText(left.candidateId, right.candidateId)));
}

async function readAllDerivationCandidatesForReview(
  reader: StrategyDerivationCandidateReader,
  projectRoot: string,
): Promise<readonly StrategyDerivationCandidateV1[]> {
  if (typeof reader.readAll !== "function") {
    throw new Error("Strategy Derivation Candidate enumeration is unavailable for this project reader.");
  }
  const rawCandidates = await reader.readAll(projectRoot);
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Strategy Derivation Candidate reader returned an invalid collection.");
  }
  const candidateIds = new Set<string>();
  const candidates: StrategyDerivationCandidateV1[] = [];
  for (const rawCandidate of rawCandidates) {
    // Review intentionally does not compare with current trust here. A stale
    // Candidate remains selectable for historical evidence inspection; its
    // current-portfolio gate is derived by the review itself.
    const candidate = validateStrategyDerivationCandidateBinding(
      rawCandidate,
      projectRoot,
    );
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error("Strategy Derivation Candidate reader returned duplicate Candidate IDs.");
    }
    candidateIds.add(candidate.candidateId);
    candidates.push(candidate);
  }
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

/**
 * Read one fresh unified `/trial` projection. Revision Candidates retain the
 * frozen v0.6 projection and hints; Derivation Candidates are added only after
 * exact project/portfolio validation. A UUID present in both stores is an
 * ambiguity and invalidates the whole projection rather than being guessed.
 */
export async function buildTrialCommandProjection(
  input: TrialCommandProjectionInput,
): Promise<TrialCommandProjection> {
  const revisionIds = await readAllCandidates(input.candidateReader, input.projectRoot);
  const revisionIdSet = new Set(revisionIds.map((candidate) => candidate.candidateId));
  const revisionProjection = await buildCandidateCommandProjection({
    projectRoot: input.projectRoot,
    command: "trial",
    candidateReader: input.candidateReader,
    decisionReader: input.decisionReader,
    experienceReader: input.experienceReader,
  });
  const allDerivationCandidates = await readAllDerivationCandidates(
    input.derivationCandidateReader,
    input.projectRoot,
    input.trustedPortfolio,
  );
  if (allDerivationCandidates.some((candidate) => revisionIdSet.has(candidate.candidateId))) {
    throw new Error("Candidate ID is ambiguous: both Revision and Derivation Candidate stores contain it.");
  }
  const trustedIds = new Set(trustedLogicalStrategyIds(input.trustedPortfolio));
  const derivationCandidates = allDerivationCandidates.filter((candidate) =>
    !trustedIds.has(candidate.proposal.strategyId));

  const entries: TrialCommandProjectionEntry[] = revisionProjection.entries.map((entry) => ({
    ...entry,
    kind: "revision" as const,
  }));
  entries.push(...derivationCandidates.map((candidate) => ({
    kind: "derivation" as const,
    candidate,
    label: boundedLabel(`${candidate.proposal.strategyId} · ${candidate.proposal.summary.replace(/\s+/gu, " ").trim()} · derivation`),
    option: { value: candidate.candidateId, label: "" },
  })));

  // Keep labels bounded and disambiguate only display collisions. Values are
  // always the exact canonical UUID and never parsed from the label.
  const labels = entries.map((entry) => entry.label);
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const group = groups.get(label) ?? [];
    group.push(index);
    groups.set(label, group);
  });
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
      const entry = entries[index]!;
      const id = entry.candidate.candidateId.slice(0, suffixLength);
      const base = entry.label.slice(
        0,
        Math.max(1, MAX_CANDIDATE_COMMAND_LABEL_LENGTH - 3 - suffixLength),
      );
      labels[index] = `${base} · ${id}`.slice(0, MAX_CANDIDATE_COMMAND_LABEL_LENGTH);
    }
  }
  const labeled = entries.map((entry, index) => {
    const label = labels[index]!;
    return Object.freeze({
      ...entry,
      label,
      option: Object.freeze({ value: entry.candidate.candidateId, label }),
    });
  });
  labeled.sort((left, right) => {
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.candidate.candidateId, right.candidate.candidateId);
  });
  return Object.freeze({
    entries: Object.freeze(labeled),
    options: Object.freeze(labeled.map((entry) => entry.option)),
  });
}

function trialReviewEvidenceCount(entry: TrialReviewCommandProjectionEntry): number {
  return entry.kind === "revision"
    ? entry.trialReview.candidateProfile.runCount
    : entry.trialReview.candidateTrialEvidence.profile.runCount;
}

function derivationReviewLabel(
  candidate: StrategyDerivationCandidateV1,
  review: StrategyDerivationTrialReview,
): string {
  const count = review.candidateTrialEvidence.profile.runCount;
  const trialText = `${count} eligible trial${count === 1 ? "" : "s"}`;
  const suffix = review.promotionEligibility.eligible
    ? `${trialText} · promotion eligible`
    : trialText;
  return boundedLabel(
    `${candidate.proposal.strategyId} · ${candidate.proposal.summary.replace(/\s+/gu, " ").trim()} · derivation · ${suffix}`,
  );
}

/**
 * Read one fresh unified `/trial-review` projection. Revision entries use the
 * unchanged v0.6 review projection; Derivation entries use their separate
 * source/Trial review and remain available when their portfolio is stale.
 */
export async function buildTrialReviewCommandProjection(
  input: TrialReviewCommandProjectionInput,
): Promise<TrialReviewCommandProjection> {
  const revisionProjection = await buildCandidateCommandProjection({
    projectRoot: input.projectRoot,
    command: "trial-review",
    candidateReader: input.candidateReader,
    decisionReader: input.decisionReader,
    experienceReader: input.experienceReader,
  });
  const derivationCandidates = await readAllDerivationCandidatesForReview(
    input.derivationCandidateReader,
    input.projectRoot,
  );
  const revisionIds = new Set(revisionProjection.entries.map((entry) =>
    entry.candidate.candidateId));
  if (derivationCandidates.some((candidate) => revisionIds.has(candidate.candidateId))) {
    throw new Error("Candidate ID is ambiguous: both Revision and Derivation Candidate stores contain it.");
  }
  const experience = await input.experienceReader.read(input.projectRoot);
  const derivationEntries: TrialReviewCommandProjectionEntry[] = [];
  for (const candidate of derivationCandidates) {
    const trialReview = await deriveStrategyDerivationTrialReview(
      candidate,
      experience.records,
      {
        projectRoot: input.projectRoot,
        currentPortfolio: input.trustedPortfolio,
        revisionCandidateReader: input.candidateReader,
        revisionDecisionReader: input.decisionReader,
        priorTerminalDecision: false,
      },
    );
    derivationEntries.push({
      kind: "derivation",
      candidate,
      trialReview,
      promotionEligible: trialReview.promotionEligibility.eligible,
      label: derivationReviewLabel(candidate, trialReview),
      option: { value: candidate.candidateId, label: "" },
    });
  }

  const entries: TrialReviewCommandProjectionEntry[] = [
    ...revisionProjection.entries.map((entry) => ({
      ...entry,
      kind: "revision" as const,
    })),
    ...derivationEntries,
  ];
  const labels = entries.map((entry) => entry.label);
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const group = groups.get(label) ?? [];
    group.push(index);
    groups.set(label, group);
  });
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
      const entry = entries[index]!;
      const id = entry.candidate.candidateId.slice(0, suffixLength);
      const base = entry.label.slice(
        0,
        Math.max(1, MAX_CANDIDATE_COMMAND_LABEL_LENGTH - 3 - suffixLength),
      );
      labels[index] = `${base} · ${id}`.slice(0, MAX_CANDIDATE_COMMAND_LABEL_LENGTH);
    }
  }

  const labeled = entries.map((entry, index) => {
    const label = labels[index]!;
    return Object.freeze({
      ...entry,
      label,
      option: Object.freeze({ value: entry.candidate.candidateId, label }),
    });
  });
  labeled.sort((left, right) => {
    const evidenceOrder = trialReviewEvidenceCount(right) - trialReviewEvidenceCount(left);
    if (evidenceOrder !== 0) return evidenceOrder;
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.candidate.candidateId, right.candidate.candidateId);
  });
  return Object.freeze({
    entries: Object.freeze(labeled),
    options: Object.freeze(labeled.map((entry) => entry.option)),
  });
}

/** Resolve a unified `/trial-review` completion prefix without parsing labels. */
export function filterTrialReviewCommandOptions(
  projection: TrialReviewCommandProjection,
  prefix: string,
): AutocompleteItem[] {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

/** Resolve a unified `/trial` completion prefix without parsing labels. */
export function filterTrialCommandOptions(
  projection: TrialCommandProjection,
  prefix: string,
): AutocompleteItem[] {
  return projection.options.filter((option) => option.value.startsWith(prefix));
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
