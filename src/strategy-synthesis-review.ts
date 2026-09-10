import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  compareCrossProjectExperienceRefs,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import type { RunExperienceProjectReader } from "./experience-store.ts";
import {
  scanCrossProjectTrialEvidence,
  type CrossProjectTrialEvidenceProjection,
  type CrossProjectTrialProjectInventory,
  type CrossProjectTrialSubject,
} from "./cross-project-trial-validation.ts";
import {
  isCanonicalStrategySynthesisCandidateId,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  validateStrategySynthesisCandidateArtifact,
  type StrategySynthesisCandidateReader,
  type StrategySynthesisCandidateV1,
} from "./strategy-synthesis-candidates.ts";
import {
  createStrategySynthesisDecision as createStrategySynthesisDecisionArtifact,
  readSynthesisTrialGlobalArtifacts,
  validateStrategySynthesisDecisionArtifact,
  validateStrategySynthesisDecisionBinding,
  type StrategySynthesisDecisionReader,
  type StrategySynthesisDecisionStore,
  type StrategySynthesisDecisionTerminal,
  type StrategySynthesisDecisionV1,
} from "./strategy-synthesis-decisions.ts";
import {
  readScopeTrialGlobalArtifacts,
  type ScopeTrialGlobalArtifacts,
} from "./strategy-trust-scope-artifacts.ts";
import {
  validateStrategyTrustScopeSourceStrategy,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeSourceStrategyV1,
} from "./strategy-trust-scope-candidates.ts";
import {
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
  type StrategyDerivationDecisionV1,
} from "./strategy-derivation-decisions.ts";
import {
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type StrategyRevisionSelection,
} from "./policy.ts";
import type {
  ScopeProjectTrustReader,
  ScopeProjectTrustSnapshot,
} from "./strategy-trust-scope-review.ts";
import type { GlobalWriterLock } from "./store.ts";
import { getProjectId } from "./store.ts";
import { MAX_USER_GLOBAL_DERIVED_STRATEGIES } from "./strategy-trust-scope-constants.ts";
import { SEED_STRATEGIES } from "./strategies.ts";

export const MAX_SYNTHESIS_REVIEW_PROJECT_DETAILS = 16;
export const MAX_SYNTHESIS_REVIEW_RECORD_DETAILS = 8;
export const MAX_SYNTHESIS_REVIEW_REASON_DETAILS = 24;
export const MAX_SYNTHESIS_REVIEW_TEXT_LENGTH = 256;
export const MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH = 192;

const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/u;
const DERIVED_ENTRY_FIELDS = [
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function shortIdentity(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 8);
}

function boundedText(value: string): string {
  const escaped = value.replace(/[\u0000-\u001f\u007f]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  return escaped.length <= MAX_SYNTHESIS_REVIEW_TEXT_LENGTH
    ? escaped
    : `${escaped.slice(0, MAX_SYNTHESIS_REVIEW_TEXT_LENGTH - 12)} [truncated]`;
}

function sameStrategyIdentity(
  left: Pick<StrategyTrustScopeSourceStrategyV1, "strategyId" | "kind" | "revisionIdentity" | "revisionFingerprint">,
  right: Pick<StrategyTrustScopeSourceStrategyV1, "strategyId" | "kind" | "revisionIdentity" | "revisionFingerprint">,
): boolean {
  return left.strategyId === right.strategyId &&
    left.kind === right.kind &&
    left.revisionIdentity === right.revisionIdentity &&
    left.revisionFingerprint === right.revisionFingerprint;
}

function strategySemantics(candidate: StrategySynthesisCandidateV1): {
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
} {
  return {
    summary: candidate.proposal.summary,
    useWhen: [...candidate.proposal.useWhen],
    avoidWhen: [...candidate.proposal.avoidWhen],
    principles: [...candidate.proposal.principles],
  };
}

function synthesisSubject(
  candidate: StrategySynthesisCandidateV1,
): CrossProjectTrialSubject {
  return Object.freeze({
    origin: "synthesis" as const,
    subjectId: candidate.candidateId,
    strategy: Object.freeze({
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
      semantics: Object.freeze(strategySemantics(candidate)),
    }),
    // Discovery projects are context only. Synthesis Trials are allowed in
    // every project, including projects represented in the receipt.
    excludedTrialProjectIds: Object.freeze([]),
    minimumTrialRecordedAt: candidate.createdAt,
  });
}

function fingerprintProjection(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Synthesis authority projection could not be serialized deterministically.");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function sourceSelectionMatches(
  selection: StrategyRevisionSelection,
  sourceCandidate: StrategyDerivationCandidateV1,
  source: StrategyTrustScopeSourceStrategyV1,
): boolean {
  return strategySelectionRevisionStatus(selection) === "promoted" &&
    strategySelectionId(selection) === sourceCandidate.proposal.strategyId &&
    selection.kind === sourceCandidate.proposal.kind &&
    strategySelectionRevisionIdentity(selection) === sourceCandidate.candidateId &&
    strategySelectionRevisionFingerprint(selection) === strategyDerivationCandidateSemanticFingerprint(sourceCandidate) &&
    isDeepStrictEqual(selection.semantics, {
      summary: sourceCandidate.proposal.summary,
      useWhen: [...sourceCandidate.proposal.useWhen],
      avoidWhen: [...sourceCandidate.proposal.avoidWhen],
      principles: [...sourceCandidate.proposal.principles],
    }) &&
    sameStrategyIdentity(source, {
      strategyId: sourceCandidate.proposal.strategyId,
      kind: sourceCandidate.proposal.kind,
      revisionIdentity: sourceCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(sourceCandidate),
    });
}

function validateTransferSourceResolution(
  source: StrategyTrustScopeSourceStrategyV1,
  resolved: {
    readonly sourceStrategy: StrategyTrustScopeSourceStrategyV1;
    readonly candidate: StrategyDerivationCandidateV1;
    readonly decision: StrategyDerivationDecisionV1;
    readonly selection: StrategyRevisionSelection;
  },
): void {
  const validatedSource = validateStrategyTrustScopeSourceStrategy(resolved.sourceStrategy);
  if (!sameStrategyIdentity(validatedSource, source) || validatedSource.sourceProjectId !== source.sourceProjectId) {
    throw new Error("promoted Scope source binding changed during Synthesis review");
  }
  const candidate = validateStrategyDerivationCandidateArtifact(
    resolved.candidate,
    source.revisionIdentity,
  );
  if (
    candidate.projectId !== source.sourceProjectId ||
    candidate.proposal.strategyId !== source.strategyId ||
    candidate.proposal.kind !== source.kind ||
    candidate.candidateId !== source.revisionIdentity ||
    strategyDerivationCandidateSemanticFingerprint(candidate) !== source.revisionFingerprint
  ) throw new Error("promoted Scope source Candidate does not match its exact binding");
  const decision = validateStrategyDerivationDecisionBinding(
    validateStrategyDerivationDecisionArtifact(resolved.decision, candidate.candidateId),
    candidate,
  );
  if (decision.decision !== "promoted" || !sourceSelectionMatches(resolved.selection, candidate, source)) {
    throw new Error("promoted Scope source resolution is not an exact current project-local trust binding");
  }
}

interface GlobalPromotedIdentity {
  readonly origin: "transfer" | "synthesis";
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
  readonly sourceProjectId?: string;
}

interface SynthesisGlobalReviewFacts {
  readonly candidateBindingValid: boolean;
  readonly candidateOpen: boolean;
  readonly terminalDecision: StrategySynthesisDecisionV1 | null;
  readonly globalStateComplete: boolean;
  readonly globalStateReasons: readonly string[];
  readonly promotedGlobalEntries: readonly GlobalPromotedIdentity[];
  readonly globalLogicalIdAvailable: boolean;
  readonly userGlobalCapacityAvailable: boolean;
  readonly authorityFingerprint: string;
}

interface TransferAuthorityInput {
  readonly scopeCandidateReader?: StrategyTrustScopeCandidateReader;
  readonly scopeDecisionReader?: import("./strategy-trust-scope-decisions.ts").StrategyTrustScopeDecisionReader;
  readonly sourceResolver?: import("./strategy-trust-scope-resolution.ts").StrategyTrustScopeSourceResolver;
}

function transferReaders(input: StrategySynthesisTrialReviewInput): TransferAuthorityInput {
  return {
    scopeCandidateReader: input.scopeCandidateReader ?? input.transferCandidateReader,
    scopeDecisionReader: input.scopeDecisionReader ?? input.transferDecisionReader,
    sourceResolver: input.sourceResolver ?? input.transferSourceResolver,
  };
}

async function deriveSynthesisGlobalReviewFacts(
  candidate: StrategySynthesisCandidateV1,
  input: StrategySynthesisTrialReviewInput,
): Promise<SynthesisGlobalReviewFacts> {
  const reasons: string[] = [];
  const candidateArtifactFingerprint = strategySynthesisCandidateArtifactFingerprint(candidate);
  let candidateBindingValid = true;
  let terminalDecision: StrategySynthesisDecisionV1 | null = null;
  try {
    const freshCandidate = await input.candidateReader.read(candidate.candidateId);
    if (freshCandidate === null) {
      candidateBindingValid = false;
      reasons.push("Synthesis Candidate is missing from the current global Candidate namespace");
    } else {
      const validated = validateStrategySynthesisCandidateArtifact(freshCandidate, candidate.candidateId);
      if (strategySynthesisCandidateArtifactFingerprint(validated) !== candidateArtifactFingerprint) {
        candidateBindingValid = false;
        reasons.push("Synthesis Candidate artifact changed while reviewing");
      }
    }
  } catch (error) {
    candidateBindingValid = false;
    reasons.push(`Synthesis Candidate could not be freshly resolved: ${errorMessage(error)}`);
  }

  let synthesisArtifacts: Awaited<ReturnType<typeof readSynthesisTrialGlobalArtifacts>> | null = null;
  try {
    synthesisArtifacts = await readSynthesisTrialGlobalArtifacts(
      input.candidateReader,
      input.decisionReader,
    );
    terminalDecision = synthesisArtifacts.decisions.find((decision) =>
      decision.candidateId === candidate.candidateId) ?? null;
  } catch (error) {
    reasons.push(`global Synthesis artifacts could not be completely read: ${errorMessage(error)}`);
  }

  const transfer = transferReaders(input);
  let scopeArtifacts: ScopeTrialGlobalArtifacts | null = null;
  const haveAnyTransferReader = transfer.scopeCandidateReader !== undefined ||
    transfer.scopeDecisionReader !== undefined || transfer.sourceResolver !== undefined;
  const haveCompleteTransferReaders = transfer.scopeCandidateReader !== undefined &&
    transfer.scopeDecisionReader !== undefined && transfer.sourceResolver !== undefined;
  if (haveAnyTransferReader && !haveCompleteTransferReaders) {
    reasons.push("global transfer authority dependencies are incomplete");
  } else if (haveCompleteTransferReaders) {
    try {
      scopeArtifacts = await readScopeTrialGlobalArtifacts(
        transfer.scopeCandidateReader,
        transfer.scopeDecisionReader,
      );
    } catch (error) {
      reasons.push(`global transfer artifacts could not be completely read: ${errorMessage(error)}`);
    }
  }

  const promotedGlobalEntries: GlobalPromotedIdentity[] = [];
  const logicalIds = new Set<string>();
  if (scopeArtifacts !== null && transfer.sourceResolver !== undefined) {
    for (const decision of scopeArtifacts.decisions.filter((item) => item.decision === "promoted")) {
      try {
        const resolved = await transfer.sourceResolver.resolve(decision.sourceStrategy);
        validateTransferSourceResolution(decision.sourceStrategy, resolved);
        const identity: GlobalPromotedIdentity = Object.freeze({
          origin: "transfer",
          strategyId: decision.sourceStrategy.strategyId,
          kind: decision.sourceStrategy.kind,
          revisionIdentity: decision.sourceStrategy.revisionIdentity,
          revisionFingerprint: decision.sourceStrategy.revisionFingerprint,
          sourceProjectId: decision.sourceStrategy.sourceProjectId,
        });
        if (logicalIds.has(identity.strategyId)) {
          throw new Error(`multiple promoted user-global revisions own logical Strategy ID '${identity.strategyId}'`);
        }
        logicalIds.add(identity.strategyId);
        promotedGlobalEntries.push(identity);
      } catch (error) {
        reasons.push(`promoted transfer trust for '${decision.sourceStrategy.strategyId}' could not be freshly resolved: ${errorMessage(error)}`);
      }
    }
  }
  if (synthesisArtifacts !== null) {
    for (const decision of synthesisArtifacts.decisions.filter((item) => item.decision === "promoted")) {
      const promotedCandidate = synthesisArtifacts.candidates.find((item) => item.candidateId === decision.candidateId);
      if (promotedCandidate === undefined) {
        reasons.push(`promoted Synthesis Decision '${decision.candidateId}' is missing its immutable Candidate`);
        continue;
      }
      try {
        const validatedCandidate = validateStrategySynthesisCandidateArtifact(promotedCandidate, decision.candidateId);
        validateStrategySynthesisDecisionBinding(decision, validatedCandidate);
        const identity: GlobalPromotedIdentity = Object.freeze({
          origin: "synthesis",
          strategyId: validatedCandidate.proposal.strategyId,
          kind: validatedCandidate.proposal.kind,
          revisionIdentity: validatedCandidate.candidateId,
          revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(validatedCandidate),
        });
        if (logicalIds.has(identity.strategyId)) {
          throw new Error(`multiple promoted user-global revisions own logical Strategy ID '${identity.strategyId}'`);
        }
        logicalIds.add(identity.strategyId);
        promotedGlobalEntries.push(identity);
      } catch (error) {
        reasons.push(`promoted Synthesis trust for '${decision.candidateId}' is invalid: ${errorMessage(error)}`);
      }
    }
  }
  promotedGlobalEntries.sort((left, right) => compareText(
    `${left.strategyId}\0${left.kind}\0${left.revisionIdentity}\0${left.revisionFingerprint}`,
    `${right.strategyId}\0${right.kind}\0${right.revisionIdentity}\0${right.revisionFingerprint}`,
  ));

  const globalStateComplete = candidateBindingValid && synthesisArtifacts !== null &&
    (!haveAnyTransferReader || (scopeArtifacts !== null && haveCompleteTransferReaders)) &&
    reasons.length === 0;
  const globalLogicalIdAvailable = globalStateComplete && !logicalIds.has(candidate.proposal.strategyId) &&
    !SEED_STRATEGIES.some((seed) => seed.id === candidate.proposal.strategyId);
  const userGlobalCapacityAvailable = globalStateComplete &&
    promotedGlobalEntries.length < MAX_USER_GLOBAL_DERIVED_STRATEGIES;
  const authorityFingerprint = fingerprintProjection({
    candidateArtifactFingerprint,
    candidateBindingValid,
    terminalDecision,
    scopeArtifacts,
    synthesisArtifacts,
    promotedGlobalEntries,
    globalLogicalIdAvailable,
    userGlobalCapacityAvailable,
    reasons,
  });
  return Object.freeze({
    candidateBindingValid,
    candidateOpen: candidateBindingValid && terminalDecision === null,
    terminalDecision,
    globalStateComplete,
    globalStateReasons: Object.freeze([...new Set(reasons)]),
    promotedGlobalEntries: Object.freeze(promotedGlobalEntries),
    globalLogicalIdAvailable,
    userGlobalCapacityAvailable,
    authorityFingerprint,
  });
}

function validateProjectId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_PROJECT_ID.test(value)) {
    throw new Error("Experience project namespace contains a non-canonical project identity");
  }
  return value;
}

function validateProjectIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Experience project namespace reader returned an invalid collection");
  const ids = value.map(validateProjectId);
  if (new Set(ids).size !== ids.length) throw new Error("Experience project namespace reader returned duplicate project IDs");
  return Object.freeze([...ids].sort(compareText));
}

function validateProjectTrustSnapshot(
  value: unknown,
  expectedProjectId: string,
): ScopeProjectTrustSnapshot {
  if (!isRecord(value) || value.projectId !== expectedProjectId || !Array.isArray(value.promotedDerived)) {
    throw new Error("project-local trust reader returned an invalid project snapshot");
  }
  const entries = value.promotedDerived.map((raw, index) => {
    if (!isRecord(raw) || Object.keys(raw).sort().join("\0") !== [...DERIVED_ENTRY_FIELDS].sort().join("\0")) {
      throw new Error(`project-local trust entry ${index} has invalid identity fields`);
    }
    if (
      typeof raw.strategyId !== "string" || raw.strategyId.trim() === "" ||
      (raw.kind !== "approach" && raw.kind !== "modifier") ||
      typeof raw.revisionIdentity !== "string" || raw.revisionIdentity.trim() === "" ||
      typeof raw.revisionFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.revisionFingerprint)
    ) throw new Error(`project-local trust entry ${index} is invalid`);
    return Object.freeze({
      strategyId: raw.strategyId,
      kind: raw.kind,
      revisionIdentity: raw.revisionIdentity,
      revisionFingerprint: raw.revisionFingerprint,
    });
  }).sort((left, right) => compareText(
    `${left.strategyId}\0${left.kind}\0${left.revisionIdentity}\0${left.revisionFingerprint}`,
    `${right.strategyId}\0${right.kind}\0${right.revisionIdentity}\0${right.revisionFingerprint}`,
  ));
  const logicalIds = new Set<string>();
  for (const entry of entries) {
    if (logicalIds.has(entry.strategyId)) throw new Error(`project-local trust contains duplicate logical Strategy ID '${entry.strategyId}'`);
    logicalIds.add(entry.strategyId);
  }
  return Object.freeze({
    projectId: expectedProjectId,
    promotedDerived: Object.freeze(entries),
  });
}

interface ProjectTrustFacts {
  readonly complete: boolean;
  readonly projectIds: readonly string[];
  readonly snapshots: ReadonlyMap<string, ScopeProjectTrustSnapshot>;
  readonly reasons: readonly string[];
}

async function readProjectTrustFacts(
  experienceReader: RunExperienceProjectReader,
  projectTrustReader: ScopeProjectTrustReader | undefined,
): Promise<ProjectTrustFacts> {
  const reasons: string[] = [];
  let projectIds: readonly string[] = [];
  try {
    projectIds = validateProjectIds(await experienceReader.listProjectIds());
  } catch (error) {
    return Object.freeze({
      complete: false,
      projectIds: Object.freeze([]),
      snapshots: new Map(),
      reasons: Object.freeze([`project-local trust namespace could not be enumerated: ${errorMessage(error)}`]),
    });
  }
  if (projectTrustReader === undefined) {
    return Object.freeze({
      complete: false,
      projectIds,
      snapshots: new Map(),
      reasons: Object.freeze(["project-local trust reader is unavailable for the complete collision scan"]),
    });
  }
  const snapshots = new Map<string, ScopeProjectTrustSnapshot>();
  for (const projectId of projectIds) {
    try {
      snapshots.set(projectId, validateProjectTrustSnapshot(
        await projectTrustReader.readProjectId(projectId),
        projectId,
      ));
    } catch (error) {
      reasons.push(`project ${shortIdentity(projectId)} local trust scan failed: ${errorMessage(error)}`);
    }
  }
  return Object.freeze({
    complete: reasons.length === 0 && snapshots.size === projectIds.length,
    projectIds,
    snapshots,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function sameProjectTrustFacts(left: ProjectTrustFacts, right: ProjectTrustFacts): boolean {
  if (left.complete !== right.complete || !isDeepStrictEqual(left.projectIds, right.projectIds) || left.snapshots.size !== right.snapshots.size) return false;
  for (const projectId of left.projectIds) {
    const leftSnapshot = left.snapshots.get(projectId);
    const rightSnapshot = right.snapshots.get(projectId);
    if (leftSnapshot === undefined || rightSnapshot === undefined || !isDeepStrictEqual(leftSnapshot, rightSnapshot)) return false;
  }
  return true;
}

function deriveLocalConflict(
  candidate: StrategySynthesisCandidateV1,
  projectTrust: ProjectTrustFacts,
): { readonly conflictFree: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  const fingerprint = strategySynthesisCandidateSemanticFingerprint(candidate);
  for (const snapshot of projectTrust.snapshots.values()) {
    for (const entry of snapshot.promotedDerived) {
      if (entry.strategyId !== candidate.proposal.strategyId) continue;
      if (
        entry.kind !== candidate.proposal.kind ||
        entry.revisionIdentity !== candidate.candidateId ||
        entry.revisionFingerprint !== fingerprint
      ) {
        reasons.push(`project ${shortIdentity(snapshot.projectId)} has a conflicting local revision for logical Strategy ID '${candidate.proposal.strategyId}'`);
      }
    }
  }
  return Object.freeze({
    conflictFree: projectTrust.complete && reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export interface StrategySynthesisPromotionEligibility {
  readonly eligible: boolean;
  readonly requiredEligibleTrialRunCount: 2;
  readonly eligibleTrialRunCount: number;
  readonly requiredDistinctTrialProjectCount: 2;
  readonly distinctEligibleTrialProjectCount: number;
  readonly candidateValid: boolean;
  readonly synthesisCandidateValid: boolean;
  readonly candidateOpen: boolean;
  readonly noTerminalSynthesisDecision: boolean;
  readonly candidateBindingValid: boolean;
  readonly noSeedLogicalIdCollision: boolean;
  readonly globalLogicalIdAvailable: boolean;
  readonly projectLocalConflictFree: boolean;
  readonly userGlobalCapacityAvailable: boolean;
  readonly evidenceCompletenessValid: boolean;
  readonly selectedEvidenceRefsValid: boolean;
  readonly retainedEligibleRefCount: number;
  readonly omittedEligibleRefCount: number;
  readonly reasons: readonly string[];
}

export interface StrategySynthesisTrialReview {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly candidateArtifactFingerprint: string;
  readonly candidateSemanticFingerprint: string;
  readonly terminalDecision: StrategySynthesisDecisionV1 | null;
  readonly inventories: readonly CrossProjectTrialProjectInventory[];
  readonly matchingRecordCount: number;
  readonly ineligibleMatchingRunCount: number;
  readonly eligibleTrialRunCount: number;
  readonly distinctEligibleTrialProjectCount: number;
  readonly eligibleTrialProjectIds: readonly string[];
  readonly selectedEvidenceRefs: readonly CrossProjectExperienceRefV1[];
  readonly omittedEligibleRefCount: number;
  readonly evidenceScanComplete: boolean;
  readonly selectedEvidenceRefsValid: boolean;
  readonly globalStateComplete: boolean;
  readonly projectTrustScanComplete: boolean;
  readonly discoverySourceProjectIds: readonly string[];
  readonly discoveryProjectIds: readonly string[];
  readonly discoveryReceiptProjectIds: readonly string[];
  readonly trialProjectIds: readonly string[];
  readonly matchingTrialProjectIds: readonly string[];
  readonly overlappingProjectIds: readonly string[];
  readonly newlyRepresentedTrialProjectIds: readonly string[];
  readonly overlapProjectIds: readonly string[];
  readonly newTrialProjectIds: readonly string[];
  readonly promotionEligibility: StrategySynthesisPromotionEligibility;
  readonly reasons: readonly string[];
}

export interface StrategySynthesisTrialReviewInput extends TransferAuthorityInput {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly candidateReader: StrategySynthesisCandidateReader;
  readonly decisionReader: StrategySynthesisDecisionReader;
  readonly experienceReader: RunExperienceProjectReader;
  readonly projectTrustReader?: ScopeProjectTrustReader;
  readonly currentProjectRoot?: string | null;
  /** Compatibility aliases for callers that name transfer artifacts explicitly. */
  readonly transferCandidateReader?: StrategyTrustScopeCandidateReader;
  readonly transferDecisionReader?: import("./strategy-trust-scope-decisions.ts").StrategyTrustScopeDecisionReader;
  readonly transferSourceResolver?: import("./strategy-trust-scope-resolution.ts").StrategyTrustScopeSourceResolver;
}

export type SynthesisTrialReview = StrategySynthesisTrialReview;
export type SynthesisPromotionEligibility = StrategySynthesisPromotionEligibility;

/**
 * Recompute one read-only Synthesis Trial review from the immutable Candidate,
 * fresh cross-project Experience, and current transfer/local trust authority.
 * Discovery receipt records are never used as Trial evidence.
 */
export async function deriveStrategySynthesisTrialReview(
  input: StrategySynthesisTrialReviewInput,
): Promise<StrategySynthesisTrialReview> {
  const candidate = validateStrategySynthesisCandidateArtifact(
    input.candidate,
    input.candidate.candidateId,
  );
  const candidateArtifactFingerprint = strategySynthesisCandidateArtifactFingerprint(candidate);
  const candidateSemanticFingerprint = strategySynthesisCandidateSemanticFingerprint(candidate);
  const subject = synthesisSubject(candidate);
  const reasons: string[] = [];

  const [initialGlobal, initialProjectTrust] = await Promise.all([
    deriveSynthesisGlobalReviewFacts(candidate, input),
    readProjectTrustFacts(input.experienceReader, input.projectTrustReader),
  ]);
  reasons.push(...initialGlobal.globalStateReasons, ...initialProjectTrust.reasons);

  let evidence: CrossProjectTrialEvidenceProjection;
  try {
    evidence = await scanCrossProjectTrialEvidence({
      subject,
      experienceReader: input.experienceReader,
    });
  } catch (error) {
    evidence = Object.freeze({
      subject,
      inventories: Object.freeze([]),
      matchingRecordCount: 0,
      ineligibleMatchingRunCount: 0,
      eligibleTrialRunCount: 0,
      distinctEligibleTrialProjectCount: 0,
      eligibleTrialProjectIds: Object.freeze([]),
      selectedEvidenceRefs: Object.freeze([]),
      omittedEligibleRefCount: 0,
      evidenceScanComplete: false,
      selectedEvidenceRefsValid: false,
      reasons: Object.freeze([`cross-project Synthesis Trial evidence scan failed: ${errorMessage(error)}`]),
    });
  }
  reasons.push(...evidence.reasons);

  const [finalGlobal, finalProjectTrust] = await Promise.all([
    deriveSynthesisGlobalReviewFacts(candidate, input),
    readProjectTrustFacts(input.experienceReader, input.projectTrustReader),
  ]);
  reasons.push(...finalGlobal.globalStateReasons, ...finalProjectTrust.reasons);

  const globalAuthorityFresh = initialGlobal.authorityFingerprint === finalGlobal.authorityFingerprint &&
    initialGlobal.globalStateComplete === finalGlobal.globalStateComplete;
  if (!globalAuthorityFresh) reasons.push("global transfer/Synthesis authority changed during review; the read snapshot is not coherent");
  const projectTrustAuthorityFresh = sameProjectTrustFacts(initialProjectTrust, finalProjectTrust);
  if (!projectTrustAuthorityFresh) reasons.push("project-local trust namespace or promoted Derived identity projection changed during review; the collision scan is not coherent");

  const projectConflict = deriveLocalConflict(candidate, finalProjectTrust);
  reasons.push(...projectConflict.reasons);
  const evidenceCompletenessValid = evidence.evidenceScanComplete &&
    initialProjectTrust.complete && finalProjectTrust.complete &&
    initialGlobal.globalStateComplete && finalGlobal.globalStateComplete &&
    globalAuthorityFresh && projectTrustAuthorityFresh;
  const selectedEvidenceRefsValid = evidence.selectedEvidenceRefsValid && globalAuthorityFresh && projectTrustAuthorityFresh;
  if (!selectedEvidenceRefsValid) reasons.push("the selected Synthesis Trial evidence reference set is not fully resolvable and eligible");

  const noSeedLogicalIdCollision = !SEED_STRATEGIES.some((seed) => seed.id === candidate.proposal.strategyId);
  const candidateBindingValid = initialGlobal.candidateBindingValid && finalGlobal.candidateBindingValid && globalAuthorityFresh;
  const candidateOpen = finalGlobal.candidateOpen && candidateBindingValid;
  const noTerminalSynthesisDecision = finalGlobal.terminalDecision === null;
  const globalLogicalIdAvailable = finalGlobal.globalLogicalIdAvailable && globalAuthorityFresh;
  const userGlobalCapacityAvailable = finalGlobal.userGlobalCapacityAvailable && globalAuthorityFresh;
  const localConflictFree = projectConflict.conflictFree && projectTrustAuthorityFresh;
  const eligible = candidateBindingValid && candidateOpen && noTerminalSynthesisDecision &&
    noSeedLogicalIdCollision && globalLogicalIdAvailable && localConflictFree &&
    userGlobalCapacityAvailable && evidenceCompletenessValid && selectedEvidenceRefsValid &&
    evidence.eligibleTrialRunCount >= 2 && evidence.distinctEligibleTrialProjectCount >= 2;

  if (!candidateBindingValid) reasons.push("Synthesis Candidate binding is invalid or stale");
  if (!candidateOpen) reasons.push("Synthesis Candidate is not a fresh open hypothesis");
  if (!noTerminalSynthesisDecision) reasons.push("a terminal Synthesis Decision already exists for this Candidate");
  if (!noSeedLogicalIdCollision) reasons.push("proposed logical Strategy ID collides with an immutable Seed");
  if (!globalLogicalIdAvailable) reasons.push("current user-global logical Strategy ID is unavailable");
  if (!localConflictFree) reasons.push("project-local trust conflict or incomplete local trust state prevents a deterministic collision scan");
  if (!userGlobalCapacityAvailable) reasons.push("combined user-global Derived Strategy capacity is unavailable");

  const discoverySourceProjectIds = Object.freeze([...new Set(candidate.evidence.sourceRefs.map((ref) => ref.projectId))].sort(compareText));
  const discoveryReceiptProjectIds = Object.freeze([...new Set(candidate.derivationReceipt.sourceRefs.map((ref) => ref.projectId))].sort(compareText));
  const trialProjectIds = Object.freeze([...evidence.eligibleTrialProjectIds].sort(compareText));
  const matchingTrialProjectIds = Object.freeze(evidence.inventories
    .filter((inventory) => inventory.matchingRecordCount > 0)
    .map((inventory) => inventory.projectId)
    .sort(compareText));
  const overlappingProjectIds = Object.freeze(trialProjectIds.filter((projectId) => discoverySourceProjectIds.includes(projectId)));
  const newlyRepresentedTrialProjectIds = Object.freeze(trialProjectIds.filter((projectId) => !discoverySourceProjectIds.includes(projectId)));
  const promotionReasons = Object.freeze([...new Set(reasons)]);
  const promotionEligibility: StrategySynthesisPromotionEligibility = Object.freeze({
    eligible,
    requiredEligibleTrialRunCount: 2,
    eligibleTrialRunCount: evidence.eligibleTrialRunCount,
    requiredDistinctTrialProjectCount: 2,
    distinctEligibleTrialProjectCount: evidence.distinctEligibleTrialProjectCount,
    candidateValid: candidateBindingValid,
    synthesisCandidateValid: candidateBindingValid,
    candidateOpen,
    noTerminalSynthesisDecision,
    candidateBindingValid,
    noSeedLogicalIdCollision,
    globalLogicalIdAvailable,
    projectLocalConflictFree: localConflictFree,
    userGlobalCapacityAvailable,
    evidenceCompletenessValid,
    selectedEvidenceRefsValid,
    retainedEligibleRefCount: evidence.selectedEvidenceRefs.length,
    omittedEligibleRefCount: evidence.omittedEligibleRefCount,
    reasons: promotionReasons,
  });

  // Keep the current-project fact available for callers that want to render
  // context, without making it an eligibility rule or a Trial exclusion.
  if (input.currentProjectRoot !== undefined && input.currentProjectRoot !== null) {
    try {
      getProjectId(input.currentProjectRoot);
    } catch (error) {
      reasons.push(`current project context is not canonical: ${errorMessage(error)}`);
    }
  }

  return Object.freeze({
    candidate,
    candidateArtifactFingerprint,
    candidateSemanticFingerprint,
    terminalDecision: finalGlobal.terminalDecision,
    inventories: evidence.inventories,
    matchingRecordCount: evidence.matchingRecordCount,
    ineligibleMatchingRunCount: evidence.ineligibleMatchingRunCount,
    eligibleTrialRunCount: evidence.eligibleTrialRunCount,
    distinctEligibleTrialProjectCount: evidence.distinctEligibleTrialProjectCount,
    eligibleTrialProjectIds: trialProjectIds,
    selectedEvidenceRefs: evidence.selectedEvidenceRefs,
    omittedEligibleRefCount: evidence.omittedEligibleRefCount,
    evidenceScanComplete: evidence.evidenceScanComplete,
    selectedEvidenceRefsValid,
    globalStateComplete: initialGlobal.globalStateComplete && finalGlobal.globalStateComplete && globalAuthorityFresh,
    projectTrustScanComplete: initialProjectTrust.complete && finalProjectTrust.complete && projectTrustAuthorityFresh,
    discoverySourceProjectIds,
    discoveryProjectIds: discoverySourceProjectIds,
    discoveryReceiptProjectIds,
    trialProjectIds,
    matchingTrialProjectIds,
    overlappingProjectIds,
    newlyRepresentedTrialProjectIds,
    overlapProjectIds: overlappingProjectIds,
    newTrialProjectIds: newlyRepresentedTrialProjectIds,
    promotionEligibility,
    reasons: promotionReasons,
  });
}

export const deriveSynthesisTrialReview = deriveStrategySynthesisTrialReview;
export const buildStrategySynthesisTrialReview = deriveStrategySynthesisTrialReview;
export const deriveSynthesisPromotionEligibility = (
  review: StrategySynthesisTrialReview,
): StrategySynthesisPromotionEligibility => review.promotionEligibility;

function formatCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "0";
}

function formatRecordOutcome(
  record: CrossProjectTrialEvidenceProjection["inventories"][number]["detailRecords"][number],
): string {
  const evaluation = record.evaluation;
  const facts = [
    evaluation.outcome.verificationPassed ? "Verification passed" : "Verification not passed",
    evaluation.outcome.completedDuringRun ? "Task completed during Run" : "Task not completed during Run",
  ];
  if (evaluation.outcome.hasBlockers) facts.push("blockers present");
  if (evaluation.outcome.hasQuestions) facts.push("questions present");
  if (evaluation.execution.toolErrors > 0) facts.push(`tool errors ${evaluation.execution.toolErrors}`);
  if (evaluation.execution.deniedCalls > 0) facts.push(`denied calls ${evaluation.execution.deniedCalls}`);
  facts.push(record.eligible ? "eligible exact Synthesis Trial Run" : `ineligible: ${record.reasons.join("; ")}`);
  return facts.map(boundedText).join(" · ");
}

function formatInventory(inventory: CrossProjectTrialProjectInventory): string[] {
  const lines = [
    `  ${shortIdentity(inventory.projectId)}`,
    `    Matching Synthesis Trial records: ${formatCount(inventory.matchingRecordCount)}`,
    `    Eligible Runs: ${formatCount(inventory.eligibleRunCount)}`,
    `    Ineligible matching Runs: ${formatCount(inventory.ineligibleRunCount)}`,
    `    Verification passed: ${formatCount(inventory.outcomes.verificationPassedCount)} · not passed: ${formatCount(inventory.outcomes.verificationNotPassedCount)}`,
    `    Task completed during Run: ${formatCount(inventory.outcomes.completedDuringRunCount)} · not completed: ${formatCount(inventory.outcomes.notCompletedDuringRunCount)}`,
    `    Blockers: ${formatCount(inventory.outcomes.runsWithBlockers)} · questions: ${formatCount(inventory.outcomes.runsWithQuestions)} · tool errors: ${formatCount(inventory.outcomes.totalToolErrors)} · denied calls: ${formatCount(inventory.outcomes.totalDeniedCalls)}`,
    "    Bounded relevant outcomes:",
  ];
  if (inventory.detailRecords.length === 0) lines.push("      - none");
  else for (const record of inventory.detailRecords) {
    lines.push(`      - ${shortIdentity(record.ref.recordId)}: ${formatRecordOutcome(record)}`);
  }
  if (inventory.omittedDetailRecordCount > 0) {
    lines.push(`      ... ${inventory.omittedDetailRecordCount} matching detail record(s) omitted by the Human presentation bound`);
  }
  return lines;
}

/** Render a bounded factual Synthesis review; no score or causal claim is added. */
export function formatStrategySynthesisTrialReview(
  review: StrategySynthesisTrialReview,
): string {
  const candidate = review.candidate;
  const eligibility = review.promotionEligibility;
  const lines = [
    "Cross-Project Strategy Synthesis Review",
    "",
    "Strategy hypothesis",
    `  Logical ID: ${boundedText(candidate.proposal.strategyId)}`,
    `  Kind: ${candidate.proposal.kind}`,
    `  Revision identity: ${shortIdentity(candidate.candidateId)}`,
    `  Candidate: ${shortIdentity(candidate.candidateId)}`,
    `  Summary: ${boundedText(candidate.proposal.summary)}`,
    `  Candidate created at: ${candidate.createdAt}`,
    "",
    "Discovery context",
    `  Discovery-source projects: ${review.discoverySourceProjectIds.map(shortIdentity).join(", ") || "none"}`,
    `  Trial projects: ${review.trialProjectIds.map(shortIdentity).join(", ") || "none"}`,
    `  Overlap: ${review.overlappingProjectIds.map(shortIdentity).join(", ") || "none"}`,
    `  Newly represented Trial projects: ${review.newlyRepresentedTrialProjectIds.map(shortIdentity).join(", ") || "none"}`,
    "",
    "Trial evidence",
    `  Matching Synthesis Trial records: ${formatCount(review.matchingRecordCount)}`,
    `  Eligible Trial Runs: ${formatCount(review.eligibleTrialRunCount)}`,
    `  Ineligible matching Runs: ${formatCount(review.ineligibleMatchingRunCount)}`,
    `  Distinct eligible Trial projects: ${formatCount(review.distinctEligibleTrialProjectCount)}`,
    `  Retained eligible evidence refs: ${formatCount(review.selectedEvidenceRefs.length)} / ${formatCount(review.eligibleTrialRunCount)}`,
  ];
  if (review.omittedEligibleRefCount > 0) {
    lines.push(`  ${review.omittedEligibleRefCount} eligible evidence ref(s) omitted from the retained set bound`);
  }
  lines.push("", "Per Trial project:");
  const visibleInventories = review.inventories.slice(0, MAX_SYNTHESIS_REVIEW_PROJECT_DETAILS);
  if (visibleInventories.length === 0) lines.push("  - none");
  else for (const inventory of visibleInventories) lines.push(...formatInventory(inventory));
  if (review.inventories.length > visibleInventories.length) {
    lines.push(`  ... ${review.inventories.length - visibleInventories.length} project detail row(s) omitted by the Human presentation bound`);
  }
  lines.push(
    "",
    "Eligibility gates",
    `  Eligible Trial Runs: ${formatCount(eligibility.eligibleTrialRunCount)} / ${eligibility.requiredEligibleTrialRunCount}`,
    `  Distinct Trial projects: ${formatCount(eligibility.distinctEligibleTrialProjectCount)} / ${eligibility.requiredDistinctTrialProjectCount}`,
    `  Candidate binding: ${eligibility.candidateBindingValid ? "valid" : "invalid"}`,
    `  Terminal Synthesis Decision: ${eligibility.noTerminalSynthesisDecision ? "absent" : "present"}`,
    `  Evidence completeness: ${eligibility.evidenceCompletenessValid ? "valid" : "invalid"}`,
    `  Global logical-ID availability: ${eligibility.globalLogicalIdAvailable ? "valid" : "conflict"}`,
    `  Project-local logical-ID scan: ${eligibility.projectLocalConflictFree ? "conflict-free" : "conflict or unavailable"}`,
    `  Combined user-global capacity: ${eligibility.userGlobalCapacityAvailable ? "available" : "full or unavailable"}`,
    `  Selected evidence refs: ${eligibility.selectedEvidenceRefsValid ? "valid" : "invalid"}`,
    "",
    `Promotion Eligibility: ${eligibility.eligible ? "eligible for Human review" : "not eligible"}`,
    "Promotion Eligibility means only that enough auditable cross-project Trial evidence exists for Human trust review.",
  );
  if (eligibility.reasons.length > 0) {
    lines.push("Reasons");
    const visibleReasons = eligibility.reasons.slice(0, MAX_SYNTHESIS_REVIEW_REASON_DETAILS);
    for (const reason of visibleReasons) lines.push(`  - ${boundedText(reason)}`);
    if (eligibility.reasons.length > visibleReasons.length) {
      lines.push(`  ... ${eligibility.reasons.length - visibleReasons.length} deterministic reason(s) omitted by the Human presentation bound`);
    }
  }
  lines.push(
    "",
    "Negative factual outcomes remain visible; no score, ranking, reward, usefulness, superiority, universality, or causal claim is derived.",
    "This read-only review writes no Synthesis Decision, trust projection, Experience record, State, or runtime lease.",
  );
  return lines.join("\n");
}

export const formatSynthesisTrialReview = formatStrategySynthesisTrialReview;
export const formatStrategySynthesisReview = formatStrategySynthesisTrialReview;

export const SYNTHESIS_TRIAL_REVIEW_COMMAND_PREFIX = "synthesis:";
export const SYNTHESIS_DECISION_COMMAND_PREFIX = SYNTHESIS_TRIAL_REVIEW_COMMAND_PREFIX;

export function synthesisTrialReviewCommandValue(candidateId: string): string {
  if (!isCanonicalStrategySynthesisCandidateId(candidateId)) {
    throw new Error("Synthesis review Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return `${SYNTHESIS_TRIAL_REVIEW_COMMAND_PREFIX}${candidateId}`;
}

export const synthesisDecisionCommandValue = synthesisTrialReviewCommandValue;
export const synthesisReviewCommandValue = synthesisTrialReviewCommandValue;

export function parseSynthesisTrialReviewCommandValue(value: string): string | null {
  if (!value.startsWith(SYNTHESIS_TRIAL_REVIEW_COMMAND_PREFIX)) return null;
  const candidateId = value.slice(SYNTHESIS_TRIAL_REVIEW_COMMAND_PREFIX.length);
  if (!isCanonicalStrategySynthesisCandidateId(candidateId)) {
    throw new Error("Synthesis review Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return candidateId;
}

export const parseSynthesisDecisionCommandValue = parseSynthesisTrialReviewCommandValue;
export const parseSynthesisReviewCommandValue = parseSynthesisTrialReviewCommandValue;

export interface SynthesisTrialReviewCommandProjection {
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

async function readSynthesisCandidates(
  reader: StrategySynthesisCandidateReader,
): Promise<readonly StrategySynthesisCandidateV1[]> {
  const rawCandidates = await reader.readAll();
  if (!Array.isArray(rawCandidates)) throw new Error("Strategy Synthesis Candidate reader returned an invalid collection.");
  const ids = new Set<string>();
  const candidates: StrategySynthesisCandidateV1[] = [];
  for (const raw of rawCandidates) {
    const candidate = validateStrategySynthesisCandidateArtifact(raw);
    if (ids.has(candidate.candidateId)) throw new Error(`Duplicate Synthesis Candidates exist for '${candidate.candidateId}'.`);
    ids.add(candidate.candidateId);
    candidates.push(candidate);
  }
  return Object.freeze(candidates.sort((left, right) => compareText(left.candidateId, right.candidateId)));
}

async function readSynthesisDecisions(
  candidateReader: StrategySynthesisCandidateReader,
  decisionReader: StrategySynthesisDecisionReader,
): Promise<ReadonlyMap<string, StrategySynthesisDecisionV1>> {
  const artifacts = await readSynthesisTrialGlobalArtifacts(candidateReader, decisionReader);
  return new Map(artifacts.decisions.map((decision) => [decision.candidateId, decision]));
}

function synthesisReviewLabel(
  candidate: StrategySynthesisCandidateV1,
  decision: StrategySynthesisDecisionV1 | null,
): string {
  const sourceProjects = [...new Set(candidate.evidence.sourceRefs.map((ref) => ref.projectId))].length;
  const label = `${candidate.proposal.strategyId} (${candidate.proposal.kind}) · candidate ${shortIdentity(candidate.candidateId)} · discovery ${sourceProjects} project${sourceProjects === 1 ? "" : "s"} · Synthesis review${decision === null ? "" : ` · ${decision.decision}`}`;
  return label.length <= MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH
    ? label
    : `${label.slice(0, MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH - 1)}…`;
}

export async function buildSynthesisTrialReviewCommandProjection(input: {
  readonly candidateReader: StrategySynthesisCandidateReader;
  readonly decisionReader: StrategySynthesisDecisionReader;
}): Promise<SynthesisTrialReviewCommandProjection> {
  const [candidates, decisions] = await Promise.all([
    readSynthesisCandidates(input.candidateReader),
    readSynthesisDecisions(input.candidateReader, input.decisionReader),
  ]);
  const options = candidates.map((candidate) => ({
    value: synthesisTrialReviewCommandValue(candidate.candidateId),
    label: synthesisReviewLabel(candidate, decisions.get(candidate.candidateId) ?? null),
  }));
  return Object.freeze({ options: Object.freeze(options) });
}

export const buildSynthesisReviewCommandProjection = buildSynthesisTrialReviewCommandProjection;

export function filterSynthesisTrialReviewCommandOptions(
  projection: SynthesisTrialReviewCommandProjection,
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

export const filterSynthesisReviewCommandOptions = filterSynthesisTrialReviewCommandOptions;

export type StrategySynthesisDecisionCommand = "promote" | "reject";

export interface SynthesisDecisionCommandProjectionEntry {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly review: StrategySynthesisTrialReview | null;
  readonly decision: StrategySynthesisDecisionV1 | null;
  readonly label: string;
  readonly option: { readonly value: string; readonly label: string };
}

export interface SynthesisDecisionCommandProjection {
  readonly command: StrategySynthesisDecisionCommand;
  readonly entries: readonly SynthesisDecisionCommandProjectionEntry[];
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface SynthesisDecisionCommandProjectionInput extends Omit<StrategySynthesisTrialReviewInput, "candidate"> {
  readonly command: StrategySynthesisDecisionCommand;
}

export async function buildSynthesisDecisionCommandProjection(
  input: SynthesisDecisionCommandProjectionInput,
): Promise<SynthesisDecisionCommandProjection> {
  const [candidates, decisions] = await Promise.all([
    readSynthesisCandidates(input.candidateReader),
    readSynthesisDecisions(input.candidateReader, input.decisionReader),
  ]);
  const entries: SynthesisDecisionCommandProjectionEntry[] = [];
  for (const candidate of candidates) {
    const decision = decisions.get(candidate.candidateId) ?? null;
    if (decision !== null) continue;
    if (input.command === "reject") {
      const label = `${synthesisReviewLabel(candidate, null)} · open hypothesis; rejection is not falsification`;
      entries.push({
        candidate,
        review: null,
        decision,
        label,
        option: Object.freeze({ value: synthesisDecisionCommandValue(candidate.candidateId), label }),
      });
      continue;
    }
    const review = await deriveStrategySynthesisTrialReview({ ...input, candidate });
    if (!review.promotionEligibility.eligible) continue;
    const label = `${synthesisReviewLabel(candidate, null)} · promotion eligible · ${review.eligibleTrialRunCount} eligible Runs · ${review.distinctEligibleTrialProjectCount} Trial projects`;
    entries.push({
      candidate,
      review,
      decision,
      label: label.length <= MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH
        ? label
        : `${label.slice(0, MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH - 1)}…`,
      option: Object.freeze({
        value: synthesisDecisionCommandValue(candidate.candidateId),
        label: label.length <= MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH
          ? label
          : `${label.slice(0, MAX_SYNTHESIS_DECISION_COMMAND_LABEL_LENGTH - 1)}…`,
      }),
    });
  }
  entries.sort((left, right) => {
    const labelOrder = compareText(left.label, right.label);
    return labelOrder !== 0 ? labelOrder : compareText(left.candidate.candidateId, right.candidate.candidateId);
  });
  return Object.freeze({
    command: input.command,
    entries: Object.freeze(entries),
    options: Object.freeze(entries.map((entry) => entry.option)),
  });
}

export function filterSynthesisDecisionCommandOptions(
  projection: SynthesisDecisionCommandProjection,
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> {
  return projection.options.filter((option) => option.value.startsWith(prefix));
}

export interface CreateStrategySynthesisDecisionForHumanInput {
  readonly candidateId: string;
  readonly decision: StrategySynthesisDecisionTerminal;
  readonly decidedAt?: string;
  readonly currentProjectRoot?: string | null;
}

export interface StrategySynthesisDecisionCreationDependencies extends Omit<StrategySynthesisTrialReviewInput, "candidate"> {
  readonly writerLock: GlobalWriterLock;
  readonly decisionStore: StrategySynthesisDecisionStore;
}

export interface StrategySynthesisDecisionCreationResult {
  readonly decision: StrategySynthesisDecisionV1;
  readonly review: StrategySynthesisTrialReview | null;
}

function sameDecision(left: StrategySynthesisDecisionV1, right: StrategySynthesisDecisionV1): boolean {
  return isDeepStrictEqual(left, right);
}


/** Lock-protected Human Synthesis Decision creation with fresh Promotion. */
export async function createStrategySynthesisDecisionForHuman(
  input: CreateStrategySynthesisDecisionForHumanInput,
  dependencies: StrategySynthesisDecisionCreationDependencies,
): Promise<StrategySynthesisDecisionCreationResult> {
  if (!isCanonicalStrategySynthesisCandidateId(input.candidateId)) {
    throw new Error("Synthesis Decision Candidate ID must be a canonical lowercase UUID-v4.");
  }
  return dependencies.writerLock.withLock(async () => {
    let candidateRaw: StrategySynthesisCandidateV1 | null;
    try {
      candidateRaw = await dependencies.candidateReader.read(input.candidateId);
    } catch (error) {
      throw new Error(`Synthesis Candidate read failed; no Decision was written: ${errorMessage(error)}`);
    }
    if (candidateRaw === null) {
      throw new Error(`Synthesis Candidate '${input.candidateId}' was not found; no Decision was written.`);
    }
    const candidate = validateStrategySynthesisCandidateArtifact(candidateRaw, input.candidateId);
    let artifacts: Awaited<ReturnType<typeof readSynthesisTrialGlobalArtifacts>>;
    try {
      artifacts = await readSynthesisTrialGlobalArtifacts(
        dependencies.candidateReader,
        dependencies.decisionReader,
      );
    } catch (error) {
      throw new Error(`Global Synthesis artifacts are malformed or ambiguous; no Decision was written: ${errorMessage(error)}`);
    }
    if (artifacts.decisions.some((decision) => decision.candidateId === input.candidateId)) {
      throw new Error("An immutable terminal Synthesis Decision already exists; no replacement Decision was written.");
    }
    // Re-read the open Candidate after the complete terminal-artifact scan as
    // well. This keeps rejection (which intentionally has no Trial gate) from
    // accepting a Candidate that changed between the initial read and write.
    let latestCandidateRaw: StrategySynthesisCandidateV1 | null;
    try {
      latestCandidateRaw = await dependencies.candidateReader.read(input.candidateId);
    } catch (error) {
      throw new Error(`Synthesis Candidate revalidation failed; no Decision was written: ${errorMessage(error)}`);
    }
    if (latestCandidateRaw === null) {
      throw new Error(`Synthesis Candidate '${input.candidateId}' disappeared during Decision preparation; no Decision was written.`);
    }
    const latestCandidate = validateStrategySynthesisCandidateArtifact(latestCandidateRaw, input.candidateId);
    if (strategySynthesisCandidateArtifactFingerprint(latestCandidate) !== strategySynthesisCandidateArtifactFingerprint(candidate)) {
      throw new Error("Synthesis Candidate changed while preparing the immutable Decision; no Decision was written.");
    }

    let review: StrategySynthesisTrialReview | null = null;
    let trialRefs: readonly CrossProjectExperienceRefV1[] = Object.freeze([]);
    if (input.decision === "promoted") {
      try {
        review = await deriveStrategySynthesisTrialReview({
          ...dependencies,
          candidate,
          currentProjectRoot: input.currentProjectRoot,
        });
      } catch (error) {
        throw new Error(`Synthesis Promotion Eligibility review failed; no Decision was written: ${errorMessage(error)}`);
      }
      if (!review.promotionEligibility.eligible) {
        const visibleReasons = review.promotionEligibility.reasons.slice(0, 8);
        throw new Error(`Synthesis Promotion Eligibility is not satisfied; no Decision was written.${visibleReasons.length > 0 ? ` Reasons: ${visibleReasons.join("; ")}` : ""}`);
      }
      trialRefs = review.selectedEvidenceRefs;
    }

    const decision = createStrategySynthesisDecisionArtifact({
      candidate,
      decision: input.decision,
      trialRefs,
      decidedAt: input.decidedAt,
    });
    validateStrategySynthesisDecisionBinding(decision, candidate);
    try {
      await dependencies.decisionStore.save(decision);
    } catch (error) {
      // A save may have succeeded before its caller observed an error. Re-read
      // only this preallocated Candidate identity and accept the exact same
      // immutable artifact; never replace or mint a second terminal Decision.
      let existing: StrategySynthesisDecisionV1 | null;
      try {
        existing = await dependencies.decisionStore.read(candidate.candidateId);
      } catch (readError) {
        throw new Error(`Synthesis Decision persistence/reconciliation failed after the write error: ${errorMessage(readError)} (${errorMessage(error)})`);
      }
      if (existing !== null) {
        try {
          const validatedExisting = validateStrategySynthesisDecisionBinding(
            validateStrategySynthesisDecisionArtifact(existing, candidate.candidateId),
            candidate,
          );
          if (sameDecision(validatedExisting, decision)) {
            return Object.freeze({ decision: validatedExisting, review });
          }
        } catch {
          // Fall through to the fail-closed message below.
        }
        throw new Error(`Synthesis Decision persistence/reconciliation failed closed: existing terminal Decision '${candidate.candidateId}' does not exactly match the intended immutable artifact.`);
      }
      throw new Error(`Synthesis Decision was not persisted; no trust transition occurred: ${errorMessage(error)}`);
    }
    return Object.freeze({ decision, review });
  });
}

export const createSynthesisDecisionForHuman = createStrategySynthesisDecisionForHuman;
export const createStrategySynthesisDecision = createStrategySynthesisDecisionForHuman;

export function sortSynthesisTrialRefs(
  refs: readonly CrossProjectExperienceRefV1[],
): readonly CrossProjectExperienceRefV1[] {
  return Object.freeze([...refs].sort(compareCrossProjectExperienceRefs));
}
