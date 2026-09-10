import { isDeepStrictEqual } from "node:util";

import {
  isCanonicalStrategySynthesisCandidateId,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  validateStrategySynthesisCandidateArtifact,
  type StrategySynthesisCandidateReader,
  type StrategySynthesisCandidateV1,
} from "./strategy-synthesis-candidates.ts";
import {
  createStrategyRevisionSelection,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  trustedLogicalStrategyIds,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import { getProjectId } from "./store.ts";
import type {
  SynthesisTrialBinding,
  SynthesisTrialPacket,
} from "./strategy-trial.ts";

/** Explicit namespace used by `/trial` for Synthesis Candidates. */
export const SYNTHESIS_TRIAL_COMMAND_PREFIX = "synthesis:";
export const STRATEGY_SYNTHESIS_TRIAL_COMMAND_PREFIX = SYNTHESIS_TRIAL_COMMAND_PREFIX;
export const MAX_SYNTHESIS_TRIAL_COMMAND_LABEL_LENGTH = 160;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionEqual(
  left: StrategyRevisionSelection,
  right: StrategyRevisionSelection,
): boolean {
  return left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint &&
    left.revisionStatusAtRun === right.revisionStatusAtRun &&
    isDeepStrictEqual(left.semantics, right.semantics);
}

function validTargetRoot(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function candidateProposal(
  candidate: StrategySynthesisCandidateV1,
): SynthesisTrialPacket["proposal"] {
  return Object.freeze({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    summary: candidate.proposal.summary,
    useWhen: Object.freeze([...candidate.proposal.useWhen]),
    avoidWhen: Object.freeze([...candidate.proposal.avoidWhen]),
    principles: Object.freeze([...candidate.proposal.principles]),
  });
}

function candidateRevisionSemantics(
  candidate: StrategySynthesisCandidateV1,
): StrategyRevisionSelection["semantics"] {
  return Object.freeze({
    summary: candidate.proposal.summary,
    useWhen: Object.freeze([...candidate.proposal.useWhen]),
    avoidWhen: Object.freeze([...candidate.proposal.avoidWhen]),
    principles: Object.freeze([...candidate.proposal.principles]),
  });
}

/** Convert one immutable Synthesis Candidate into its exact Trial Policy. */
export function strategyRevisionSelectionFromSynthesisTrial(
  candidate: StrategySynthesisCandidateV1,
): StrategyRevisionSelection {
  const validated = validateStrategySynthesisCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  return createStrategyRevisionSelection({
    strategyId: validated.proposal.strategyId,
    kind: validated.proposal.kind,
    revisionIdentity: validated.candidateId,
    revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(validated),
    revisionStatusAtRun: "trial",
    semantics: candidateRevisionSemantics(validated),
  });
}

export const createSynthesisTrialRevisionSelection = strategyRevisionSelectionFromSynthesisTrial;
export const strategyRevisionSelectionFromSynthesisCandidate = strategyRevisionSelectionFromSynthesisTrial;

/** Build the bounded model-facing packet for one target-project Synthesis Trial. */
export function buildSynthesisTrialPacket(input: {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly targetProjectId: string;
}): SynthesisTrialPacket {
  const candidate = validateStrategySynthesisCandidateArtifact(
    input.candidate,
    input.candidate.candidateId,
  );
  const candidateSemanticFingerprint = strategySynthesisCandidateSemanticFingerprint(candidate);
  const selection = strategyRevisionSelectionFromSynthesisTrial(candidate);
  if (!/^[0-9a-f]{64}$/u.test(input.targetProjectId)) {
    throw new Error("Synthesis Trial packet target project identity is not canonical.");
  }
  return Object.freeze({
    candidateType: "cross-project-synthesis" as const,
    candidateId: candidate.candidateId,
    candidateSemanticFingerprint,
    target: Object.freeze({ projectId: input.targetProjectId }),
    proposal: candidateProposal(candidate),
    hypothesis: candidate.hypothesis,
    selector: Object.freeze({
      strategyId: selection.strategyId,
      revisionIdentity: selection.revisionIdentity,
      revisionFingerprint: selection.revisionFingerprint,
    }),
    trustBoundary: "This Synthesis Candidate is an inactive hypothesis; Trial does not make it trusted or grant user-global authority.",
  });
}

export const createSynthesisTrialPacket = buildSynthesisTrialPacket;

function renderList(lines: string[], label: string, values: readonly string[]): void {
  lines.push(
    `${label}:`,
    ...(values.length > 0 ? values.map((value) => `  - ${value}`) : ["  - none"]),
  );
}

/** Render one bounded, advisory Synthesis Trial packet. */
export function formatSynthesisTrialPacket(
  packet: SynthesisTrialPacket,
): string {
  const lines = [
    "<PINDIE_SYNTHESIS_TRIAL_PACKET>",
    "This is an explicitly requested cross-project Strategy Synthesis Trial.",
    "This is not new user Task intent and does not start an Agent Run by itself.",
    "The normal Pindie Task / Gateway / Verification / Policy authority is unchanged.",
    "",
    "Synthesis hypothesis:",
    `- Candidate ID: ${packet.candidateId}`,
    `- Candidate semantic fingerprint: ${packet.candidateSemanticFingerprint}`,
    `- Target project ID: ${packet.target.projectId}`,
    "",
    "Proposed logical Strategy:",
    `- Strategy ID: ${packet.proposal.strategyId}`,
    `- Kind: ${packet.proposal.kind}`,
    `- Summary: ${packet.proposal.summary}`,
  ];
  renderList(lines, "- Use when", packet.proposal.useWhen);
  renderList(lines, "- Avoid when", packet.proposal.avoidWhen);
  renderList(lines, "- Principles", packet.proposal.principles);
  lines.push(
    "",
    "Candidate hypothesis:",
    packet.hypothesis,
    "",
    "Controlled-Trial boundary:",
    `- ${packet.trustBoundary}`,
    "- This exact proposed revision is optional cognitive Policy for one target project and one Agent Run only.",
    "- The model must explicitly declare the exact revision selector if it materially guides the Task.",
    "- Merely receiving or arming this packet does NOT create Candidate attribution.",
    "- Only a successful exact declaration followed by real non-policy execution can produce Trial Experience evidence.",
    "- It is valid to use a normal Seed or promoted Policy instead, or not to use this Candidate.",
    "- Do not infer novelty, usefulness, superiority, universality, or causality from this Trial.",
    "- Candidate creation, Trial, and this packet grant no user-global trust or promotion authority.",
    "",
    "Exact Policy revision selector allowed for this Run:",
    `- Declare it under ${packet.proposal.kind === "approach" ? "approach" : "modifiers"} exactly as this object:`,
    JSON.stringify(packet.selector, null, 2),
    "- The Harness supplies exact kind, semantics, and revisionStatusAtRun = trial; do not author additional revision data.",
    "</PINDIE_SYNTHESIS_TRIAL_PACKET>",
  );
  return lines.join("\n");
}

export const renderSynthesisTrialPacket = formatSynthesisTrialPacket;

/** Validate the complete runtime binding without performing live reads. */
export function validateSynthesisTrialBindingSnapshot(
  input: SynthesisTrialBinding,
): SynthesisTrialBinding {
  if (
    input.candidateType !== "cross-project-synthesis" ||
    !validTargetRoot(input.targetProjectRoot) ||
    !/^[0-9a-f]{64}$/u.test(input.targetProjectId)
  ) throw new Error("Synthesis Trial binding target identity is invalid.");
  const candidate = validateStrategySynthesisCandidateArtifact(
    input.candidate,
    input.candidate.candidateId,
  );
  const semanticFingerprint = strategySynthesisCandidateSemanticFingerprint(candidate);
  const artifactFingerprint = strategySynthesisCandidateArtifactFingerprint(candidate);
  if (input.candidateSemanticFingerprint !== semanticFingerprint) {
    throw new Error("Synthesis Trial binding has the wrong Candidate semantic fingerprint.");
  }
  if (input.candidateArtifactFingerprint !== artifactFingerprint) {
    throw new Error("Synthesis Trial binding has the wrong Candidate artifact fingerprint.");
  }
  if (input.targetProjectId !== getProjectId(input.targetProjectRoot)) {
    throw new Error("Synthesis Trial binding target project identity does not match its root.");
  }
  const expectedSelection = strategyRevisionSelectionFromSynthesisTrial(candidate);
  if (!selectionEqual(input.revisionSelection, expectedSelection)) {
    throw new Error("Synthesis Trial binding selection is not the exact Harness-derived trial revision.");
  }
  const expectedPacket = buildSynthesisTrialPacket({
    candidate,
    targetProjectId: input.targetProjectId,
  });
  if (
    !isDeepStrictEqual(input.packet, expectedPacket) ||
    input.renderedPacket !== formatSynthesisTrialPacket(expectedPacket)
  ) throw new Error("Synthesis Trial binding packet is not the exact Harness-derived packet.");
  return input;
}

/** Compare the immutable facts that must remain unchanged across revalidation. */
export function sameSynthesisTrialBinding(
  left: Pick<SynthesisTrialBinding, "candidate" | "candidateSemanticFingerprint" | "candidateArtifactFingerprint" | "targetProjectRoot" | "targetProjectId" | "revisionSelection" | "packet">,
  right: Pick<SynthesisTrialBinding, "candidate" | "candidateSemanticFingerprint" | "candidateArtifactFingerprint" | "targetProjectRoot" | "targetProjectId" | "revisionSelection" | "packet">,
): boolean {
  return left.candidateSemanticFingerprint === right.candidateSemanticFingerprint &&
    left.candidateArtifactFingerprint === right.candidateArtifactFingerprint &&
    left.targetProjectRoot === right.targetProjectRoot &&
    left.targetProjectId === right.targetProjectId &&
    isDeepStrictEqual(left.candidate, right.candidate) &&
    selectionEqual(left.revisionSelection, right.revisionSelection) &&
    isDeepStrictEqual(left.packet, right.packet);
}

/** Freshly validate Candidate identity and target trust before arming. */
export function createSynthesisTrialBinding(
  candidateInput: StrategySynthesisCandidateV1,
  targetProjectRoot: string,
  targetPortfolio: TrustedStrategyPortfolio,
): SynthesisTrialBinding {
  if (!validTargetRoot(targetProjectRoot)) {
    throw new Error("Synthesis Trial target project root is invalid.");
  }
  const candidate = validateStrategySynthesisCandidateArtifact(
    candidateInput,
    candidateInput.candidateId,
  );
  const targetProjectId = getProjectId(targetProjectRoot);
  if (targetPortfolio.projectId !== targetProjectId) {
    throw new Error("Target trusted Strategy portfolio does not match the current target project.");
  }
  if (trustedLogicalStrategyIds(targetPortfolio).includes(candidate.proposal.strategyId)) {
    throw new Error("The target project already trusts this logical Strategy ID; Synthesis Trials with a trusted logical ID are denied.");
  }
  if (targetPortfolio.entries.some((entry) => entry.revisionIdentity === candidate.candidateId)) {
    throw new Error("The target project already trusts this Candidate revision identity; the Synthesis Trial is ambiguous.");
  }
  const candidateSemanticFingerprint = strategySynthesisCandidateSemanticFingerprint(candidate);
  const binding: SynthesisTrialBinding = Object.freeze({
    candidateType: "cross-project-synthesis" as const,
    candidate,
    candidateSemanticFingerprint,
    candidateArtifactFingerprint: strategySynthesisCandidateArtifactFingerprint(candidate),
    targetProjectRoot,
    targetProjectId,
    revisionSelection: strategyRevisionSelectionFromSynthesisTrial(candidate),
    packet: buildSynthesisTrialPacket({ candidate, targetProjectId }),
    renderedPacket: "",
  });
  const complete = Object.freeze({
    ...binding,
    renderedPacket: formatSynthesisTrialPacket(binding.packet),
  });
  return validateSynthesisTrialBindingSnapshot(complete);
}

export const validateSynthesisTrialCandidateForTarget = createSynthesisTrialBinding;
export const prepareSynthesisTrialBinding = createSynthesisTrialBinding;

export interface SynthesisTrialResolutionInput {
  readonly candidateId: string;
  readonly targetProjectRoot: string;
  readonly targetPortfolio: TrustedStrategyPortfolio;
  readonly candidateReader: StrategySynthesisCandidateReader;
}

/** Resolve one exact global Synthesis Candidate for a target project. */
export async function resolveSynthesisTrialBinding(
  input: SynthesisTrialResolutionInput,
): Promise<SynthesisTrialBinding> {
  if (!isCanonicalStrategySynthesisCandidateId(input.candidateId)) {
    throw new Error("Synthesis Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  const candidate = await input.candidateReader.read(input.candidateId);
  if (candidate === null) {
    throw new Error(`Strategy Synthesis Candidate '${input.candidateId}' was not found.`);
  }
  return createSynthesisTrialBinding(
    candidate,
    input.targetProjectRoot,
    input.targetPortfolio,
  );
}

export const resolveSynthesisTrialCandidate = resolveSynthesisTrialBinding;

export interface SynthesisTrialCandidateProjectionEntry {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly binding: SynthesisTrialBinding;
  readonly label: string;
}

export interface SynthesisTrialCandidateProjection {
  readonly entries: readonly SynthesisTrialCandidateProjectionEntry[];
}

/** Build advisory completion entries; stale/colliding Candidates are omitted. */
export async function listOpenSynthesisTrialCandidates(
  input: Pick<SynthesisTrialResolutionInput, "targetProjectRoot" | "targetPortfolio" | "candidateReader">,
): Promise<SynthesisTrialCandidateProjection> {
  const rawCandidates = await input.candidateReader.readAll();
  if (!Array.isArray(rawCandidates)) {
    throw new Error("Strategy Synthesis Candidate reader returned an invalid collection.");
  }
  const ids = new Set<string>();
  const entries: SynthesisTrialCandidateProjectionEntry[] = [];
  for (const rawCandidate of rawCandidates) {
    const candidate = validateStrategySynthesisCandidateArtifact(rawCandidate);
    if (ids.has(candidate.candidateId)) {
      throw new Error("Strategy Synthesis Candidate reader returned duplicate Candidate IDs.");
    }
    ids.add(candidate.candidateId);
    try {
      const binding = createSynthesisTrialBinding(
        candidate,
        input.targetProjectRoot,
        input.targetPortfolio,
      );
      entries.push({
        candidate,
        binding,
        label: formatSynthesisTrialCommandLabel(candidate),
      });
    } catch {
      // Completion is advisory and fail-closed per Candidate. The command
      // repeats the complete fresh binding gate before arming.
    }
  }
  entries.sort((left, right) => {
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0
      ? labelOrder
      : compareText(left.candidate.candidateId, right.candidate.candidateId);
  });
  return Object.freeze({ entries: Object.freeze(entries) });
}

export function formatSynthesisTrialCommandLabel(
  candidate: Pick<StrategySynthesisCandidateV1, "proposal" | "candidateId">,
): string {
  const value = `${candidate.proposal.strategyId} (${candidate.proposal.kind}) · candidate ${candidate.candidateId.slice(0, 8)} · explicit cross-project Synthesis Trial`;
  return value.length <= MAX_SYNTHESIS_TRIAL_COMMAND_LABEL_LENGTH
    ? value
    : `${value.slice(0, MAX_SYNTHESIS_TRIAL_COMMAND_LABEL_LENGTH - 1)}…`;
}

export function synthesisTrialCommandValue(candidateId: string): string {
  if (!isCanonicalStrategySynthesisCandidateId(candidateId)) {
    throw new Error("Synthesis Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return `${SYNTHESIS_TRIAL_COMMAND_PREFIX}${candidateId}`;
}

/** Parse only the explicit `synthesis:<uuid>` subject namespace. */
export function parseSynthesisTrialCommandValue(value: string): string | null {
  if (!value.startsWith(SYNTHESIS_TRIAL_COMMAND_PREFIX)) return null;
  const candidateId = value.slice(SYNTHESIS_TRIAL_COMMAND_PREFIX.length);
  if (!isCanonicalStrategySynthesisCandidateId(candidateId)) {
    throw new Error("Synthesis Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return candidateId;
}

export function isSynthesisTrialCommandValue(value: string): boolean {
  try {
    return parseSynthesisTrialCommandValue(value) !== null;
  } catch {
    return false;
  }
}

export function filterSynthesisTrialCommandOptions(
  entries: readonly SynthesisTrialCandidateProjectionEntry[],
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return entries
    .map((entry) => ({
      value: synthesisTrialCommandValue(entry.candidate.candidateId),
      label: entry.label,
    }))
    .filter((option) => option.value.startsWith(prefix));
}

/** Revalidate an active Synthesis Trial against the current Candidate/target trust. */
export async function revalidateSynthesisTrialBinding(
  lease: Pick<SynthesisTrialBinding, "candidate" | "targetProjectRoot" | "targetProjectId">,
  targetPortfolio: TrustedStrategyPortfolio,
  candidateReader: StrategySynthesisCandidateReader,
): Promise<SynthesisTrialBinding> {
  const fresh = await resolveSynthesisTrialBinding({
    candidateId: lease.candidate.candidateId,
    targetProjectRoot: lease.targetProjectRoot,
    targetPortfolio,
    candidateReader,
  });
  if (fresh.targetProjectId !== lease.targetProjectId) {
    throw new Error("Synthesis Trial target project changed while revalidating the active lease.");
  }
  return fresh;
}

export const validateActiveSynthesisTrialBinding = revalidateSynthesisTrialBinding;
