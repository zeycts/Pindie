import { strategySelectionId, strategySelectionRevisionIdentity, strategySelectionRevisionFingerprint, strategySelectionRevisionStatus } from "./policy.ts";
import { runExperienceRecordFingerprint } from "./run-experience-fingerprint.ts";
import type { RunExperienceProjectReader } from "./experience-store.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import { MAX_TRUSTED_PORTFOLIO_ENTRIES, trustedPortfolioFingerprint } from "./strategy-portfolio.ts";
import { learningJobKey } from "./learning-v1-contract.ts";
import { DEFAULT_PROJECT_DISCOVERY_POLICY, discoveryPacketFingerprint, validateDiscoveryPacket, validateProjectDiscoveryPolicy,
  type DiscoveryPacketV1, type DiscoverySourceSummary, type ProjectDiscoveryPolicy } from "./discovery-contract.ts";
import { FileDiscoveryPacketStore } from "./discovery-packets.ts";
import { FileDiscoveryReceiptStore } from "./discovery-receipts.ts";
import type { LearningJobLedger } from "./learning-job-store.ts";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const position = (r: { recordedAt: string; recordId: string }) => `${r.recordedAt}\0${r.recordId}`;
export interface ProjectDiscoveryDependencies {
  reader: RunExperienceProjectReader;
  portfolio: ProjectTrustedStrategyPortfolioReader;
  receipts: FileDiscoveryReceiptStore;
  packets: FileDiscoveryPacketStore;
  jobs: LearningJobLedger;
  policy?: ProjectDiscoveryPolicy;
}
/** Purely factual, project-scoped eligibility. A corrupt store is not a partially eligible corpus. */
export async function buildProjectDiscoveryPacket(projectId: string, dependencies: Omit<ProjectDiscoveryDependencies, "jobs">): Promise<DiscoveryPacketV1 | null> {
  const policy = dependencies.policy ?? DEFAULT_PROJECT_DISCOVERY_POLICY;
  if (!validateProjectDiscoveryPolicy(policy)) throw new Error("Invalid project discovery policy.");
  const [read, portfolio, receipts] = await Promise.all([
    dependencies.reader.readProjectId(projectId), dependencies.portfolio.readProjectId(projectId), dependencies.receipts.read(projectId),
  ]);
  if (read.invalid || read.unsupportedSchema || read.loadedRecords !== read.records.length ||
    portfolio.projectId !== projectId || portfolio.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES ||
    portfolio.entries.length !== portfolio.resolvedEntries.length ||
    portfolio.fingerprint !== trustedPortfolioFingerprint(projectId, portfolio.entries) ||
    portfolio.resolvedEntries.some((entry, i) => JSON.stringify(entry.manifest) !== JSON.stringify(portfolio.entries[i]) ||
      !entry.semantics.summary.trim() || entry.semantics.summary.length > 512))
    throw new Error("Incoherent discovery evidence or trusted portfolio.");
  // Terminal semantic receipts assess only their exact packet fingerprints. An
  // unselected older record and a later copy of an assessed record are handled
  // independently of timestamps, pruning, or cancelled operational jobs.
  const assessed = new Set(receipts.flatMap((receipt) => receipt.sources.map((source) => source.fingerprint)));
  const seen = new Set<string>();
  const records = read.records.flatMap(({ recordId, experience }) => {
    if (experience.schemaVersion !== 5 || !experience.workEpisodeId) return [];
    // v5 parser enforces coherent episode/task linkage; no learning/internal Run is recorded by the Work Plane.
    const fingerprint = runExperienceRecordFingerprint(experience);
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    const ref = { projectId, recordId, fingerprint };
    return [{ ref, experience, recordedAt: experience.recordedAt, recordId }];
  }).sort((a, b) => compare(position(b), position(a)));
  const fresh = records.filter((r) => !assessed.has(r.ref.fingerprint));
  const episodes = new Set(fresh.map((r) => r.experience.workEpisodeId));
  const outcomes = new Set(fresh.map((r) => `${r.experience.outcome.taskStatus}/${r.experience.outcome.verificationStatus}`));
  if (fresh.length < policy.minNewExperiences || episodes.size < policy.minWorkEpisodes || outcomes.size < policy.minOutcomes) return null;
  // Recent-first greedy coverage: first pick new episode, then outcome, then policy exposure,
  // then fill newest remaining. All ties use (recordedAt, recordId) descending.
  const chosen: typeof fresh = []; const chosenIds = new Set<string>();
  const exposure = (r: typeof fresh[number]) => r.experience.policy.finalSnapshot === null ? "none" :
    JSON.stringify(r.experience.policy.finalSnapshot.approach);
  const choose = (predicate: (r: typeof fresh[number]) => boolean) => {
    for (const r of fresh) if (chosen.length < policy.maxCorpus && !chosenIds.has(r.recordId) && predicate(r)) {
      chosen.push(r); chosenIds.add(r.recordId);
    }
  };
  const coveredEpisodes = new Set<string>();
  choose((r) => { if (coveredEpisodes.has(r.experience.workEpisodeId)) return false; coveredEpisodes.add(r.experience.workEpisodeId); return true; });
  const coveredOutcomes = new Set(chosen.map((r) => `${r.experience.outcome.taskStatus}/${r.experience.outcome.verificationStatus}`));
  choose((r) => { const key = `${r.experience.outcome.taskStatus}/${r.experience.outcome.verificationStatus}`; if (coveredOutcomes.has(key)) return false; coveredOutcomes.add(key); return true; });
  const coveredExposure = new Set(chosen.map(exposure));
  choose((r) => { const key = exposure(r); if (coveredExposure.has(key)) return false; coveredExposure.add(key); return true; });
  choose(() => true);
  if (new Set(chosen.map((r) => r.experience.workEpisodeId)).size < policy.minWorkEpisodes ||
    new Set(chosen.map((r) => `${r.experience.outcome.taskStatus}/${r.experience.outcome.verificationStatus}`)).size < policy.minOutcomes) return null;
  const sources: DiscoverySourceSummary[] = chosen.sort((a, b) => compare(position(a), position(b))).map(({ ref, experience }) => {
    const snapshot = experience.policy.finalSnapshot;
    return { ref, recordedAt: experience.recordedAt, workEpisodeId: experience.workEpisodeId,
      goal: experience.task.goal.slice(0, 512), taskRelation: experience.task.taskRelation,
      outcome: { taskStatus: experience.outcome.taskStatus, verificationStatus: experience.outcome.verificationStatus, completionRelation: experience.outcome.completionRelation },
      policy: snapshot === null ? [] : [snapshot.approach, ...snapshot.modifiers].map((s) => ({
        strategyId: strategySelectionId(s), revisionIdentity: strategySelectionRevisionIdentity(s), revisionFingerprint: strategySelectionRevisionFingerprint(s),
        exposure: strategySelectionRevisionStatus(s),
      })),
      execution: { toolCalls: experience.execution.toolCalls, consequentialCalls: experience.execution.consequentialCalls,
        toolErrors: experience.execution.toolErrors, deniedCalls: experience.execution.deniedCalls, verificationCalls: experience.execution.verificationCalls },
      metrics: experience.metrics,
    };
  });
  const content = { schemaVersion: 1 as const, selectionVersion: 1 as const, projectId, policy,
    eligibleCounts: { new: fresh.length, episodes: episodes.size, outcomes: outcomes.size },
    portfolio: { fingerprint: portfolio.fingerprint, revisions: portfolio.resolvedEntries.map((entry) => ({
      strategyId: entry.manifest.strategyId, kind: entry.manifest.kind, revisionIdentity: entry.manifest.revisionIdentity,
      revisionFingerprint: entry.manifest.revisionFingerprint, summary: entry.semantics.summary,
    })) }, sources };
  const packet = { ...content, fingerprint: discoveryPacketFingerprint(content) };
  if (!validateDiscoveryPacket(packet)) throw new Error("Invalid generated DiscoveryPacket.");
  return packet;
}
export async function enqueueProjectDiscovery(projectId: string, dependencies: ProjectDiscoveryDependencies): Promise<string | null> {
  try {
    const packet = await buildProjectDiscoveryPacket(projectId, dependencies);
    if (!packet) return null;
    const scope = { kind: "project" as const, projectId };
    const key = learningJobKey("project-discovery", scope, packet.fingerprint, packet.policy.selectionVersion);
    if (await dependencies.receipts.find(projectId, key, packet.fingerprint)) return key;
    await dependencies.packets.publish(packet); // freeze input before durable enqueue
    // A cancelled exact key remains operationally terminal, never reset for
    // endless retries. Its sources remain unassessed for later changed packets.
    await dependencies.jobs.enqueue("project-discovery", scope, packet.fingerprint, packet.policy.selectionVersion, Date.now());
    return key;
  } catch (error) {
    console.warn("[Pindie] Project discovery enqueue skipped:", error instanceof Error ? error.message.slice(0, 160) : "unavailable");
    return null;
  }
}
