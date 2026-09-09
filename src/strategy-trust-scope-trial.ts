import { isDeepStrictEqual } from "node:util";

import {
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  createStrategyRevisionSelection,
  isStrategyRevisionSelector,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";
import {
  SEED_STRATEGIES,
} from "./strategies.ts";
import {
  getProjectId,
} from "./store.ts";
import {
  isCanonicalStrategyTrustScopeCandidateId,
  isCanonicalStrategyTrustScopeProjectId,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import {
  validateStrategyTrustScopeDecisionArtifact,
  validateStrategyTrustScopeDecisionBinding,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionV1,
} from "./strategy-trust-scope-decisions.ts";
import {
  type ResolvedStrategyTrustScopeSource,
  type StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import type {
  TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";

/** Explicit namespace used by `/trial` for global Scope Candidates. */
export const SCOPE_TRIAL_COMMAND_PREFIX = "scope:";
export const STRATEGY_TRUST_SCOPE_TRIAL_COMMAND_PREFIX = SCOPE_TRIAL_COMMAND_PREFIX;
export const MAX_SCOPE_TRIAL_COMMAND_LABEL_LENGTH = 160;

function trustedPortfolioLogicalIds(
  portfolio: Pick<TrustedStrategyPortfolio, "entries">,
): readonly string[] {
  return [...new Set(portfolio.entries.map((entry) => entry.strategyId))];
}

export interface ScopeTrialPacket {
  readonly candidateType: "strategy-trust-scope";
  /** Generic Candidate ID retained for the shared Trial surface. */
  readonly candidateId: string;
  readonly scopeCandidateId: string;
  readonly scopeCandidateFingerprint: string;
  readonly transition: {
    readonly currentTrustScope: "project";
    readonly proposedTrustScope: "user-global";
  };
  readonly source: StrategyTrustScopeSourceStrategyV1;
  readonly target: {
    readonly projectId: string;
  };
  readonly proposal: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
  readonly hypothesis: string;
  readonly selector: StrategyRevisionSelector;
  readonly trustBoundary: string;
}

/** Runtime-only binding used to establish a shared TrialRuntime lease. */
export interface ScopeTrialBinding {
  readonly scopeCandidate: StrategyTrustScopeCandidateV1;
  readonly scopeCandidateFingerprint: string;
  readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
  /** Exact source Candidate snapshot; it remains semantics authority. */
  readonly sourceCandidate: StrategyDerivationCandidateV1;
  readonly targetProjectRoot: string;
  readonly targetProjectId: string;
  readonly revisionSelection: StrategyRevisionSelection;
  readonly packet: ScopeTrialPacket;
  readonly renderedPacket: string;
}

export interface ScopeTrialGlobalArtifacts {
  readonly candidates: readonly StrategyTrustScopeCandidateV1[];
  readonly decisions: readonly StrategyTrustScopeDecisionV1[];
}

export interface ScopeTrialResolutionInput {
  readonly candidateId: string;
  readonly targetProjectRoot: string;
  readonly targetPortfolio: TrustedStrategyPortfolio;
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
}

export interface ListScopeTrialCandidatesInput {
  readonly targetProjectRoot: string;
  readonly targetPortfolio: TrustedStrategyPortfolio;
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
}

export interface ScopeTrialCandidateProjectionEntry {
  readonly candidate: StrategyTrustScopeCandidateV1;
  readonly binding: ScopeTrialBinding;
  readonly label: string;
}

export interface ScopeTrialCandidateProjection {
  readonly entries: readonly ScopeTrialCandidateProjectionEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceBindingEqual(
  left: StrategyTrustScopeSourceStrategyV1,
  right: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return left.sourceProjectId === right.sourceProjectId &&
    left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint;
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

function boundedLabel(value: string): string {
  if (value.length <= MAX_SCOPE_TRIAL_COMMAND_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_SCOPE_TRIAL_COMMAND_LABEL_LENGTH - 1)}…`;
}

/** Convert an exact scope Candidate ID to the opaque `/trial` subject value. */
export function scopeTrialCommandValue(candidateId: string): string {
  if (!isCanonicalStrategyTrustScopeCandidateId(candidateId)) {
    throw new Error("Scope Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return `${SCOPE_TRIAL_COMMAND_PREFIX}${candidateId}`;
}

/** Parse only the explicit `scope:<uuid>` subject namespace. */
export function parseScopeTrialCommandValue(value: string): string | null {
  if (!value.startsWith(SCOPE_TRIAL_COMMAND_PREFIX)) return null;
  const candidateId = value.slice(SCOPE_TRIAL_COMMAND_PREFIX.length);
  if (!isCanonicalStrategyTrustScopeCandidateId(candidateId)) {
    throw new Error("Scope Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return candidateId;
}

export function isScopeTrialCommandValue(value: string): boolean {
  try {
    return parseScopeTrialCommandValue(value) !== null;
  } catch {
    return false;
  }
}

function validateGlobalArtifacts(
  rawCandidates: readonly StrategyTrustScopeCandidateV1[],
  rawDecisions: readonly StrategyTrustScopeDecisionV1[],
): ScopeTrialGlobalArtifacts {
  if (!Array.isArray(rawCandidates) || !Array.isArray(rawDecisions)) {
    throw new Error("Global Scope artifact readers returned invalid collections.");
  }
  const candidatesById = new Map<string, StrategyTrustScopeCandidateV1>();
  const candidateFingerprints = new Map<string, string>();
  for (const rawCandidate of rawCandidates) {
    const candidate = validateStrategyTrustScopeCandidateArtifact(
      rawCandidate,
      rawCandidate.candidateId,
    );
    if (candidatesById.has(candidate.candidateId)) {
      throw new Error(`Duplicate global Scope Candidates exist for '${candidate.candidateId}'.`);
    }
    const fingerprint = strategyTrustScopeCandidateFingerprint(candidate);
    const priorId = candidateFingerprints.get(fingerprint);
    if (priorId !== undefined) {
      throw new Error(`Global Scope Candidates '${priorId}' and '${candidate.candidateId}' bind the same exact hypothesis.`);
    }
    candidatesById.set(candidate.candidateId, candidate);
    candidateFingerprints.set(fingerprint, candidate.candidateId);
  }

  const decisionsById = new Map<string, StrategyTrustScopeDecisionV1>();
  for (const rawDecision of rawDecisions) {
    const decision = validateStrategyTrustScopeDecisionArtifact(
      rawDecision,
      rawDecision.candidateId,
    );
    if (decisionsById.has(decision.candidateId)) {
      throw new Error(`Duplicate global Scope Decisions exist for '${decision.candidateId}'.`);
    }
    const candidate = candidatesById.get(decision.candidateId);
    if (candidate === undefined) {
      throw new Error(`Global Scope Decision '${decision.candidateId}' is missing its immutable Candidate.`);
    }
    validateStrategyTrustScopeDecisionBinding(decision, candidate);
    decisionsById.set(decision.candidateId, decision);
  }

  const candidates = [...candidatesById.values()].sort((left, right) =>
    compareText(left.candidateId, right.candidateId));
  const decisions = [...decisionsById.values()].sort((left, right) =>
    compareText(left.candidateId, right.candidateId));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    decisions: Object.freeze(decisions),
  });
}

/** Read and strictly validate the complete global Scope namespace. */
export async function readScopeTrialGlobalArtifacts(
  candidateReader: StrategyTrustScopeCandidateReader,
  decisionReader: StrategyTrustScopeDecisionReader,
): Promise<ScopeTrialGlobalArtifacts> {
  const [candidates, decisions] = await Promise.all([
    candidateReader.readAll(),
    decisionReader.readAll(),
  ]);
  return validateGlobalArtifacts(candidates, decisions);
}

function sourceSelectionFromCandidate(
  sourceCandidate: StrategyDerivationCandidateV1,
  revisionStatusAtRun: "trial" | "promoted",
): StrategyRevisionSelection {
  const candidate = validateStrategyDerivationCandidateArtifact(
    sourceCandidate,
    sourceCandidate.candidateId,
  );
  const fingerprint = strategyDerivationCandidateSemanticFingerprint(candidate);
  return createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: fingerprint,
    revisionStatusAtRun,
    semantics: {
      summary: candidate.proposal.summary,
      useWhen: [...candidate.proposal.useWhen],
      avoidWhen: [...candidate.proposal.avoidWhen],
      principles: [...candidate.proposal.principles],
    },
  });
}

function trialSelectionFromSourceCandidate(
  sourceCandidate: StrategyDerivationCandidateV1,
): StrategyRevisionSelection {
  return sourceSelectionFromCandidate(sourceCandidate, "trial");
}

export const strategyRevisionSelectionFromScopeTrial = trialSelectionFromSourceCandidate;
export const createScopeTrialRevisionSelection = trialSelectionFromSourceCandidate;

/** Build the bounded packet for one fresh source/target binding. */
export function buildScopeTrialPacket(input: {
  readonly scopeCandidate: StrategyTrustScopeCandidateV1;
  readonly sourceCandidate: StrategyDerivationCandidateV1;
  readonly targetProjectId: string;
}): ScopeTrialPacket {
  const scopeCandidate = validateStrategyTrustScopeCandidateArtifact(
    input.scopeCandidate,
    input.scopeCandidate.candidateId,
  );
  const sourceCandidate = validateStrategyDerivationCandidateArtifact(
    input.sourceCandidate,
    input.sourceCandidate.candidateId,
  );
  const scopeCandidateFingerprint = strategyTrustScopeCandidateFingerprint(scopeCandidate);
  const sourceFingerprint = strategyDerivationCandidateSemanticFingerprint(sourceCandidate);
  if (sourceCandidate.projectId !== scopeCandidate.sourceStrategy.sourceProjectId ||
    sourceCandidate.proposal.strategyId !== scopeCandidate.sourceStrategy.strategyId ||
    sourceCandidate.proposal.kind !== scopeCandidate.sourceStrategy.kind ||
    sourceCandidate.candidateId !== scopeCandidate.sourceStrategy.revisionIdentity ||
    sourceFingerprint !== scopeCandidate.sourceStrategy.revisionFingerprint) {
    throw new Error("Scope Trial packet source binding does not match the exact source Candidate.");
  }
  if (!isCanonicalStrategyTrustScopeProjectId(input.targetProjectId)) {
    throw new Error("Scope Trial packet target project identity is not canonical.");
  }
  const selection = trialSelectionFromSourceCandidate(sourceCandidate);
  return Object.freeze({
    candidateType: "strategy-trust-scope" as const,
    candidateId: scopeCandidate.candidateId,
    scopeCandidateId: scopeCandidate.candidateId,
    scopeCandidateFingerprint,
    transition: Object.freeze({
      currentTrustScope: "project" as const,
      proposedTrustScope: "user-global" as const,
    }),
    source: Object.freeze({ ...scopeCandidate.sourceStrategy }),
    target: Object.freeze({ projectId: input.targetProjectId }),
    proposal: Object.freeze({
      summary: sourceCandidate.proposal.summary,
      useWhen: Object.freeze([...sourceCandidate.proposal.useWhen]),
      avoidWhen: Object.freeze([...sourceCandidate.proposal.avoidWhen]),
      principles: Object.freeze([...sourceCandidate.proposal.principles]),
    }),
    hypothesis: sourceCandidate.hypothesis,
    selector: Object.freeze({
      strategyId: selection.strategyId,
      revisionIdentity: selection.revisionIdentity,
      revisionFingerprint: selection.revisionFingerprint,
    }),
    trustBoundary: "This Scope Candidate is a trust-expansion hypothesis; the Trial does not grant user-global trust or add the revision to the target portfolio.",
  });
}

export const createScopeTrialPacket = buildScopeTrialPacket;

function renderList(lines: string[], label: string, values: readonly string[]): void {
  lines.push(
    `${label}:`,
    ...(values.length > 0 ? values.map((value) => `  - ${value}`) : ["  - none"]),
  );
}

/** Render one bounded, advisory cross-project Scope Trial packet. */
export function formatScopeTrialPacket(packet: ScopeTrialPacket): string {
  const lines = [
    "<PINDIE_SCOPE_TRIAL_PACKET>",
    "This is an explicitly requested cross-project Strategy Scope Trial.",
    "This is not new user Task intent and does not start an Agent Run by itself.",
    "The normal Pindie Task / Gateway / Verification authority is unchanged.",
    "",
    "Scope hypothesis:",
    `- Scope Candidate ID: ${packet.scopeCandidateId}`,
    `- Scope Candidate fingerprint: ${packet.scopeCandidateFingerprint}`,
    "- Current trust scope: project",
    "- Proposed trust scope: user-global",
    "",
    "Source Strategy revision:",
    `- Source project ID: ${packet.source.sourceProjectId}`,
    `- Strategy ID: ${packet.source.strategyId}`,
    `- Kind: ${packet.source.kind}`,
    `- Revision identity: ${packet.source.revisionIdentity}`,
    `- Revision fingerprint: ${packet.source.revisionFingerprint}`,
    "",
    "Target project:",
    `- Target project ID: ${packet.target.projectId}`,
    "",
    "Source Candidate semantics:",
    `- Summary: ${packet.proposal.summary}`,
  ];
  renderList(lines, "- Use when", packet.proposal.useWhen);
  renderList(lines, "- Avoid when", packet.proposal.avoidWhen);
  renderList(lines, "- Principles", packet.proposal.principles);
  lines.push(
    "",
    "Source Candidate hypothesis:",
    packet.hypothesis,
    "",
    "Controlled-Trial boundary:",
    `- ${packet.trustBoundary}`,
    "- This exact transferred revision is optional cognitive Policy for one target project and one Agent Run only.",
    "- The model must explicitly declare the exact revision selector if it materially guides the Task.",
    "- Merely receiving or arming this packet does NOT create Experience attribution.",
    "- Only a successful exact declaration followed by real non-policy execution can be eligible evidence.",
    "- Do not infer usefulness, superiority, universality, or causality from this Trial.",
    "- The source Candidate remains the immutable semantics and provenance authority; no source or target artifact is mutated.",
    "",
    "Exact Policy revision selector allowed for this Run:",
    `- Declare it under ${packet.source.kind === "approach" ? "approach" : "modifiers"} exactly as this object:`,
    JSON.stringify(packet.selector, null, 2),
    "- The Harness supplies exact kind, semantics, and revisionStatusAtRun = trial; do not author additional revision data.",
    "</PINDIE_SCOPE_TRIAL_PACKET>",
  );
  return lines.join("\n");
}

export const renderScopeTrialPacket = formatScopeTrialPacket;

/** Validate the synchronous shape captured by a runtime Scope Trial lease. */
export function validateScopeTrialBindingSnapshot(
  input: ScopeTrialBinding,
): ScopeTrialBinding {
  if (!isRecord(input) || typeof input.targetProjectRoot !== "string" || input.targetProjectRoot.trim() === "") {
    throw new Error("Scope Trial binding target project root is invalid.");
  }
  const scopeCandidate = validateStrategyTrustScopeCandidateArtifact(
    input.scopeCandidate,
    input.scopeCandidate.candidateId,
  );
  const sourceCandidate = validateStrategyDerivationCandidateArtifact(
    input.sourceCandidate,
    input.sourceCandidate.candidateId,
  );
  const sourceStrategy = validateStrategyTrustScopeSourceStrategy(input.sourceStrategy);
  const scopeCandidateFingerprint = strategyTrustScopeCandidateFingerprint(scopeCandidate);
  if (input.scopeCandidateFingerprint !== scopeCandidateFingerprint) {
    throw new Error("Scope Trial binding has the wrong Scope Candidate fingerprint.");
  }
  if (!sourceBindingEqual(scopeCandidate.sourceStrategy, sourceStrategy)) {
    throw new Error("Scope Trial binding source identity does not match its Scope Candidate.");
  }
  const sourceFingerprint = strategyDerivationCandidateSemanticFingerprint(sourceCandidate);
  if (sourceCandidate.projectId !== sourceStrategy.sourceProjectId ||
    sourceCandidate.proposal.strategyId !== sourceStrategy.strategyId ||
    sourceCandidate.proposal.kind !== sourceStrategy.kind ||
    sourceCandidate.candidateId !== sourceStrategy.revisionIdentity ||
    sourceFingerprint !== sourceStrategy.revisionFingerprint) {
    throw new Error("Scope Trial binding source Candidate does not match its exact source identity.");
  }
  if (!isCanonicalStrategyTrustScopeProjectId(input.targetProjectId)) {
    throw new Error("Scope Trial binding target project identity is not canonical.");
  }
  if (input.targetProjectId === input.sourceStrategy.sourceProjectId) {
    throw new Error("Scope Trial target project must differ from the source project.");
  }
  if (SEED_STRATEGIES.some((seed) => seed.id === input.sourceStrategy.strategyId)) {
    throw new Error("Seed Strategies and promoted Seed revisions are not Scope Trial subjects.");
  }
  const expectedSelection = trialSelectionFromSourceCandidate(sourceCandidate);
  if (!selectionEqual(input.revisionSelection, expectedSelection)) {
    throw new Error("Scope Trial binding selection is not the exact Harness-derived trial revision.");
  }
  const expectedPacket = buildScopeTrialPacket({
    scopeCandidate,
    sourceCandidate,
    targetProjectId: input.targetProjectId,
  });
  if (!isDeepStrictEqual(input.packet, expectedPacket) ||
    input.renderedPacket !== formatScopeTrialPacket(expectedPacket)) {
    throw new Error("Scope Trial binding packet is not the exact Harness-derived packet.");
  }
  return input;
}

/** Compare the immutable facts that must remain unchanged across revalidation. */
export function sameScopeTrialBinding(
  left: Pick<ScopeTrialBinding, "scopeCandidate" | "scopeCandidateFingerprint" | "sourceStrategy" | "sourceCandidate" | "targetProjectRoot" | "targetProjectId" | "revisionSelection">,
  right: Pick<ScopeTrialBinding, "scopeCandidate" | "scopeCandidateFingerprint" | "sourceStrategy" | "sourceCandidate" | "targetProjectRoot" | "targetProjectId" | "revisionSelection">,
): boolean {
  return left.scopeCandidateFingerprint === right.scopeCandidateFingerprint &&
    left.targetProjectRoot === right.targetProjectRoot &&
    left.targetProjectId === right.targetProjectId &&
    isDeepStrictEqual(left.scopeCandidate, right.scopeCandidate) &&
    isDeepStrictEqual(left.sourceStrategy, right.sourceStrategy) &&
    isDeepStrictEqual(left.sourceCandidate, right.sourceCandidate) &&
    selectionEqual(left.revisionSelection, right.revisionSelection);
}

/** Freshly validate the source binding, target portfolio, and collision gate. */
export async function createScopeTrialBinding(
  scopeCandidateInput: StrategyTrustScopeCandidateV1,
  targetProjectRoot: string,
  targetPortfolio: TrustedStrategyPortfolio,
  sourceResolver: StrategyTrustScopeSourceResolver,
): Promise<ScopeTrialBinding> {
  const scopeCandidate = validateStrategyTrustScopeCandidateArtifact(
    scopeCandidateInput,
    scopeCandidateInput.candidateId,
  );
  const targetProjectId = getProjectId(targetProjectRoot);
  if (targetProjectId === scopeCandidate.sourceStrategy.sourceProjectId) {
    throw new Error("Scope Trial target cannot be the source project.");
  }
  if (targetPortfolio.projectId !== targetProjectId) {
    throw new Error("Target trusted Strategy portfolio does not match the current target project.");
  }
  if (SEED_STRATEGIES.some((seed) => seed.id === scopeCandidate.sourceStrategy.strategyId)) {
    throw new Error("Seed Strategies and promoted Seed revisions are not Scope Trial subjects.");
  }
  if (trustedPortfolioLogicalIds(targetPortfolio).includes(scopeCandidate.sourceStrategy.strategyId)) {
    throw new Error("The target project already trusts this logical Strategy ID; same-ID Scope Trials are denied.");
  }

  let resolved: ResolvedStrategyTrustScopeSource;
  try {
    resolved = await sourceResolver.resolve(scopeCandidate.sourceStrategy);
  } catch (error) {
    throw new Error(`Source Strategy resolution failed closed: ${errorMessage(error)}`);
  }
  const sourceCandidate = validateStrategyDerivationCandidateArtifact(
    resolved.candidate,
    scopeCandidate.sourceStrategy.revisionIdentity,
  );
  const resolvedSourceStrategy = validateStrategyTrustScopeSourceStrategy(
    resolved.sourceStrategy,
  );
  if (!sourceBindingEqual(resolvedSourceStrategy, scopeCandidate.sourceStrategy)) {
    throw new Error("Source Strategy binding changed while validating the Scope Trial.");
  }
  if (sourceCandidate.projectId !== scopeCandidate.sourceStrategy.sourceProjectId ||
    sourceCandidate.proposal.strategyId !== scopeCandidate.sourceStrategy.strategyId ||
    sourceCandidate.proposal.kind !== scopeCandidate.sourceStrategy.kind ||
    sourceCandidate.candidateId !== scopeCandidate.sourceStrategy.revisionIdentity ||
    strategyDerivationCandidateSemanticFingerprint(sourceCandidate) !== scopeCandidate.sourceStrategy.revisionFingerprint) {
    throw new Error("Source Derivation Candidate does not match the Scope Candidate binding.");
  }
  const expectedPromotedSelection = sourceSelectionFromCandidate(sourceCandidate, "promoted");
  if (!selectionEqual(resolved.selection, expectedPromotedSelection)) {
    throw new Error("Source project-local promotion is not the exact transferred revision.");
  }

  const revisionSelection = trialSelectionFromSourceCandidate(sourceCandidate);
  const packet = buildScopeTrialPacket({
    scopeCandidate,
    sourceCandidate,
    targetProjectId,
  });
  const binding: ScopeTrialBinding = Object.freeze({
    scopeCandidate,
    scopeCandidateFingerprint: strategyTrustScopeCandidateFingerprint(scopeCandidate),
    sourceStrategy: scopeCandidate.sourceStrategy,
    sourceCandidate,
    targetProjectRoot,
    targetProjectId,
    revisionSelection,
    packet,
    renderedPacket: formatScopeTrialPacket(packet),
  });
  return validateScopeTrialBindingSnapshot(binding);
}

export const validateScopeTrialCandidateForTarget = createScopeTrialBinding;
export const prepareScopeTrialBinding = createScopeTrialBinding;

/** Resolve one exact namespaced Scope Trial subject from fresh global facts. */
export async function resolveScopeTrialBinding(
  input: ScopeTrialResolutionInput,
): Promise<ScopeTrialBinding> {
  if (!isCanonicalStrategyTrustScopeCandidateId(input.candidateId)) {
    throw new Error("Scope Trial Candidate ID must be a canonical lowercase UUID-v4.");
  }
  const artifacts = await readScopeTrialGlobalArtifacts(
    input.candidateReader,
    input.decisionReader,
  );
  const candidate = artifacts.candidates.find((item) => item.candidateId === input.candidateId);
  if (candidate === undefined) {
    throw new Error(`Scope Candidate '${input.candidateId}' was not found.`);
  }
  if (artifacts.decisions.some((decision) => decision.candidateId === input.candidateId)) {
    throw new Error("An immutable terminal Scope Decision already exists for this Candidate.");
  }
  return createScopeTrialBinding(
    candidate,
    input.targetProjectRoot,
    input.targetPortfolio,
    input.sourceResolver,
  );
}

export const resolveScopeTrialCandidate = resolveScopeTrialBinding;

/** Build advisory completion entries; stale candidates are omitted per entry. */
export async function listOpenScopeTrialCandidates(
  input: ListScopeTrialCandidatesInput,
): Promise<ScopeTrialCandidateProjection> {
  const artifacts = await readScopeTrialGlobalArtifacts(
    input.candidateReader,
    input.decisionReader,
  );
  const terminalIds = new Set(artifacts.decisions.map((decision) => decision.candidateId));
  const entries: ScopeTrialCandidateProjectionEntry[] = [];
  for (const candidate of artifacts.candidates) {
    if (terminalIds.has(candidate.candidateId)) continue;
    try {
      const binding = await createScopeTrialBinding(
        candidate,
        input.targetProjectRoot,
        input.targetPortfolio,
        input.sourceResolver,
      );
      entries.push({
        candidate,
        binding,
        label: formatScopeTrialCommandLabel(candidate, binding),
      });
    } catch {
      // Completion is advisory and fail-closed per Scope Candidate. The Human
      // command repeats the complete fresh binding gate before arming.
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

export function formatScopeTrialCommandLabel(
  candidate: StrategyTrustScopeCandidateV1,
  binding: Pick<ScopeTrialBinding, "sourceStrategy">,
): string {
  const source = binding.sourceStrategy;
  return boundedLabel(
    `${source.strategyId} (${source.kind}) · source ${source.sourceProjectId.slice(0, 8)} · promoted ${source.revisionIdentity.slice(0, 8)} · explicit cross-project Scope Trial`,
  );
}

export function filterScopeTrialCommandOptions(
  entries: readonly ScopeTrialCandidateProjectionEntry[],
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return entries
    .map((entry) => ({
      value: scopeTrialCommandValue(entry.candidate.candidateId),
      label: entry.label,
    }))
    .filter((option) => option.value.startsWith(prefix));
}

/** Revalidate an active lease against current source/global/target facts. */
export async function revalidateScopeTrialBinding(
  lease: Pick<ScopeTrialBinding, "scopeCandidate" | "targetProjectRoot" | "targetProjectId">,
  targetPortfolio: TrustedStrategyPortfolio,
  dependencies: Omit<ScopeTrialResolutionInput, "candidateId" | "targetProjectRoot" | "targetPortfolio">,
): Promise<ScopeTrialBinding> {
  const fresh = await resolveScopeTrialBinding({
    candidateId: lease.scopeCandidate.candidateId,
    targetProjectRoot: lease.targetProjectRoot,
    targetPortfolio,
    ...dependencies,
  });
  if (fresh.targetProjectId !== lease.targetProjectId) {
    throw new Error("Scope Trial target project changed while revalidating the active lease.");
  }
  return fresh;
}

export const validateActiveScopeTrialBinding = revalidateScopeTrialBinding;