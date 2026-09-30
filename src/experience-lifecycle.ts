import { isDeepStrictEqual } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { FileRunExperienceReader, type RunExperienceReadResult } from "./experience-store.ts";
import { FileStrategyKnowledge } from "./strategy-knowledge-file.ts";
import { getProjectId } from "./store.ts";
import { parseRunExperience, type RunExperience } from "./run-experience.ts";
import { strategyCandidateSemanticFingerprint } from "./strategy-candidates.ts";
import { strategyDerivationCandidateSemanticFingerprint } from "./strategy-derivation-candidates.ts";
import { strategySynthesisCandidateSemanticFingerprint } from "./strategy-synthesis-candidates.ts";
import { validateStrategyRevisionDecisionBinding } from "./strategy-decisions.ts";
import { validateStrategyDerivationDecisionBinding } from "./strategy-derivation-decisions.ts";
import { validateStrategyTrustScopeDecisionBinding } from "./strategy-trust-scope-decisions.ts";
import { validateStrategySynthesisDecisionBinding } from "./strategy-synthesis-decisions.ts";
import { strategySelectionRevisionFingerprint, strategySelectionRevisionIdentity, strategySelectionRevisionStatus } from "./policy.ts";
import { FileV1HypothesisExperienceProtectionReader, type V1ExperienceProtectionReader } from "./v1-experience-protection.ts";
import { FileTrialOfferStore } from "./trial-offer-store.ts";
import { canonicalJson } from "./learning-v1-contract.ts";

export const MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT = 256;

/** Only the writer's canonical ISO instants have an unambiguous chronological order.
 * Schema-v4 permits other nonempty strings: refuse pruning rather than guessing recency. */
function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Experience recency is not a canonical ISO instant; pruning refused.");
  }
  return time;
}

function selections(experience: RunExperience) {
  const snapshot = experience.policy.finalSnapshot;
  return snapshot === null ? [] : [snapshot.approach, ...snapshot.modifiers];
}
function trial(experience: RunExperience): boolean {
  return selections(experience).some((selection) => strategySelectionRevisionStatus(selection) === "trial");
}
function eligibleTrial(experience: RunExperience, id: string, fingerprint: string, createdAt?: string): boolean {
  if (experience.outcome.completionRelation === "completed_before_run" ||
    (createdAt !== undefined && instant(experience.recordedAt) < instant(createdAt))) return false;
  const after = experience.policy.finalPolicyLastDeclaredAfter;
  if (after === null || experience.execution.toolCalls <= after.toolCalls) return false;
  return selections(experience).some((selection) =>
    strategySelectionRevisionStatus(selection) === "trial" &&
    strategySelectionRevisionIdentity(selection) === id &&
    strategySelectionRevisionFingerprint(selection) === fingerprint);
}

/** Validates *every* artifact in each participating family before deriving any protection.
 * Decisions terminate source/Trial protection; historical global discovery and terminal
 * Trial refs are audit provenance, not a renewable trust requirement. */
async function protectedRecords(projectRoot: string, read: RunExperienceReadResult, knowledge: FileStrategyKnowledge): Promise<Set<string>> {
  const projectId = getProjectId(projectRoot);
  const protectedIds = new Set<string>();
  const present = new Set(read.records.map((record) => record.recordId));
  const cite = (ids: readonly string[]) => {
    for (const id of ids) {
      if (!present.has(id)) throw new Error(`Unresolved learning source Experience '${id}'; pruning refused.`);
      protectedIds.add(id);
    }
  };
  const revisionCandidates = await knowledge.revisionCandidates.readAllProjectId(projectId);
  const revisionDecisions = await knowledge.revisionDecisions.readAllProjectId(projectId);
  const derivationCandidates = await knowledge.derivationCandidates.readAllProjectId(projectId);
  const derivationDecisions = await knowledge.derivationDecisions.readAllProjectId(projectId);
  const byRevision = new Map(revisionCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const byDerivation = new Map(derivationCandidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const candidate of revisionCandidates) {
    if (byDerivation.has(candidate.candidateId)) throw new Error("Ambiguous local Candidate identity; pruning refused.");
  }
  const revisionTerminal = new Set<string>();
  for (const decision of revisionDecisions) {
    const candidate = byRevision.get(decision.candidateId);
    if (!candidate) throw new Error("Orphan Revision Decision; pruning refused.");
    validateStrategyRevisionDecisionBinding(decision, candidate);
    revisionTerminal.add(decision.candidateId);
  }
  const derivationTerminal = new Set<string>();
  for (const decision of derivationDecisions) {
    const candidate = byDerivation.get(decision.candidateId);
    if (!candidate) throw new Error("Orphan Derivation Decision; pruning refused.");
    validateStrategyDerivationDecisionBinding(decision, candidate);
    derivationTerminal.add(decision.candidateId);
  }
  const openTrials: { id: string; fingerprint: string; createdAt?: string }[] = [];
  for (const candidate of revisionCandidates) {
    if (revisionTerminal.has(candidate.candidateId)) continue;
    cite(candidate.evidence.sourceRecordIds);
    openTrials.push({ id: candidate.candidateId, fingerprint: strategyCandidateSemanticFingerprint(candidate) });
  }
  for (const candidate of derivationCandidates) {
    if (derivationTerminal.has(candidate.candidateId)) continue;
    cite(candidate.evidence.sourceRecordIds);
    openTrials.push({ id: candidate.candidateId, fingerprint: strategyDerivationCandidateSemanticFingerprint(candidate) });
  }
  const scopeCandidates = await knowledge.scopeCandidates.readAll();
  const scopeDecisions = await knowledge.scopeDecisions.readAll();
  const synthesisCandidates = await knowledge.synthesisCandidates.readAll();
  const synthesisDecisions = await knowledge.synthesisDecisions.readAll();
  const byScope = new Map(scopeCandidates.map((candidate) => [candidate.candidateId, candidate]));
  const bySynthesis = new Map(synthesisCandidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const candidate of scopeCandidates) {
    if (bySynthesis.has(candidate.candidateId)) throw new Error("Ambiguous global Candidate identity; pruning refused.");
  }
  const scopeTerminal = new Set<string>();
  for (const decision of scopeDecisions) {
    const candidate = byScope.get(decision.candidateId);
    if (!candidate) throw new Error("Orphan Scope Decision; pruning refused.");
    validateStrategyTrustScopeDecisionBinding(decision, candidate);
    scopeTerminal.add(decision.candidateId);
  }
  const synthesisTerminal = new Set<string>();
  for (const decision of synthesisDecisions) {
    const candidate = bySynthesis.get(decision.candidateId);
    if (!candidate) throw new Error("Orphan Synthesis Decision; pruning refused.");
    validateStrategySynthesisDecisionBinding(decision, candidate);
    synthesisTerminal.add(decision.candidateId);
  }
  for (const candidate of scopeCandidates) {
    if (scopeTerminal.has(candidate.candidateId)) continue;
    await knowledge.sourceResolver.resolve(candidate.sourceStrategy);
    if (candidate.sourceStrategy.sourceProjectId === projectId) continue;
    openTrials.push({ id: candidate.sourceStrategy.revisionIdentity,
      fingerprint: candidate.sourceStrategy.revisionFingerprint });
  }
  for (const candidate of synthesisCandidates) {
    if (synthesisTerminal.has(candidate.candidateId)) continue;
    // Synthesis discovery refs are historical even while the Candidate is open.
    openTrials.push({ id: candidate.candidateId,
      fingerprint: strategySynthesisCandidateSemanticFingerprint(candidate), createdAt: candidate.createdAt });
  }
  for (const record of read.records) {
    if (openTrials.some((candidate) => eligibleTrial(record.experience, candidate.id, candidate.fingerprint, candidate.createdAt))) {
      protectedIds.add(record.recordId);
    }
  }
  return protectedIds;
}

export class FileRunExperienceMaintenance {
  private readonly reader: FileRunExperienceReader;
  private readonly knowledge: FileStrategyKnowledge;
  private readonly v1Protection: V1ExperienceProtectionReader;
  private readonly trialOffers: FileTrialOfferStore;

  constructor(options: { projectsBaseDir?: string; globalBaseDir?: string; v1Protection?: V1ExperienceProtectionReader } = {}) {
    this.reader = new FileRunExperienceReader({ baseDir: options.projectsBaseDir });
    this.knowledge = new FileStrategyKnowledge(options);
    this.trialOffers = new FileTrialOfferStore(options);
    this.v1Protection = options.v1Protection ??
      new FileV1HypothesisExperienceProtectionReader({ projectsBaseDir: options.projectsBaseDir });
  }

  /** No artifact or surviving Experience is rewritten. Throw with deletion count on partial failure. */
  async prune(projectRoot: string): Promise<number> {
    const read = await this.reader.read(projectRoot);
    const protectedIds = await protectedRecords(projectRoot, read, this.knowledge);
    // Unresolved D2 hypotheses keep their exact source Experience live. A malformed
    // or ambiguous store throws here, before any deletion; Experience saves stay committed.
    for (const ref of await this.v1Protection.requiredSourceRefs(getProjectId(projectRoot))) protectedIds.add(ref.recordId);
    // T3 does not exist: no exact immutable TrialEvidence can release these
    // dependencies yet. Protect only exact T2 records, not all ordinary history.
    // Lease expiry closes declaration authority, not historical evidence support.
    const offers = await this.trialOffers.readHistory(getProjectId(projectRoot));
    for (const record of read.records) {
      const e = record.experience;
      if (e.schemaVersion !== 6 && e.schemaVersion !== 7) continue;
      const assignment = e.schemaVersion === 6 ? e.trialAttribution.assignment : e.trialAttempt.assignmentProposal;
      const confirmed = e.schemaVersion === 6 || e.trialAttempt.publication === "confirmed";
      if (confirmed && !offers.some((c) => c.assignment && canonicalJson(c.assignment) === canonicalJson(assignment))) {
        throw new Error("Unresolved T2 assignment support; pruning refused.");
      }
      protectedIds.add(record.recordId);
    }
    const ordinary = read.records.filter((record) => !trial(record.experience) &&
      record.experience.schemaVersion !== 6 && record.experience.schemaVersion !== 7)
      .sort((a, b) => instant(b.experience.recordedAt) - instant(a.experience.recordedAt) ||
        (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
    // Validate the timestamp of every record before any deletion, including old Trials.
    for (const record of read.records) instant(record.experience.recordedAt);
    const retained = new Set(ordinary.slice(0, MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT).map((record) => record.recordId));
    const expired = read.records.filter((record) => !retained.has(record.recordId) && !protectedIds.has(record.recordId));
    const directory = this.reader.experienceDirectory(projectRoot);
    let deleted = 0;
    for (const record of expired) {
      try {
        // Detect concurrent mutation rather than deleting a changed or malformed file.
        const path = join(directory, record.recordId);
        const current = parseRunExperience(JSON.parse(await readFile(path, "utf8")));
        if (current === null || !isDeepStrictEqual(current, record.experience)) {
          throw new Error("Experience changed during pruning.");
        }
        await rm(path);
        deleted += 1;
      } catch (error) {
        throw new Error(`Experience pruning stopped after ${deleted} deletions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return deleted;
  }
}
