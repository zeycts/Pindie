import { PROJECT_ID, UUID_V4, FINGERPRINT } from "./exact-identity.ts";
import { learningFingerprint, validateExactEvidenceRef, validateLearningArtifactRef, type ExactEvidenceRef, type LearningArtifactRef } from "./learning-v1-contract.ts";

export const DISCOVERY_SELECTION_VERSION = 2 as const;
export interface ProjectDiscoveryPolicy {
  readonly schemaVersion: 1; readonly selectionVersion: 2;
  readonly minNewExperiences: number; readonly minWorkEpisodes: number;
  readonly minOutcomes: number; readonly maxCorpus: number;
}
export const DEFAULT_PROJECT_DISCOVERY_POLICY: ProjectDiscoveryPolicy = Object.freeze({
  schemaVersion: 1, selectionVersion: 2, minNewExperiences: 6, minWorkEpisodes: 3, minOutcomes: 1, maxCorpus: 24,
});
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join() === keys.sort().join();
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const string = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
export function validateProjectDiscoveryPolicy(v: unknown): v is ProjectDiscoveryPolicy {
  return obj(v) && exact(v, ["schemaVersion", "selectionVersion", "minNewExperiences", "minWorkEpisodes", "minOutcomes", "maxCorpus"]) &&
    v.schemaVersion === 1 && v.selectionVersion === DISCOVERY_SELECTION_VERSION && integer(v.minNewExperiences, 2, 32) &&
    integer(v.minWorkEpisodes, 2, 32) && integer(v.minOutcomes, 1, 4) && integer(v.maxCorpus, 2, 32) &&
    v.minWorkEpisodes <= v.minNewExperiences && v.minNewExperiences <= v.maxCorpus;
}
export interface DiscoverySourceSummary {
  readonly ref: ExactEvidenceRef; readonly recordedAt: string; readonly workEpisodeId: string;
  readonly goal: string; readonly taskRelation: string;
  readonly outcome: { readonly taskStatus: string; readonly verificationStatus: string; readonly completionRelation: string };
  readonly policy: readonly { readonly strategyId: string; readonly revisionIdentity: string; readonly revisionFingerprint: string; readonly exposure: string }[];
  readonly execution: { readonly toolCalls: number; readonly consequentialCalls: number; readonly toolErrors: number; readonly deniedCalls: number; readonly verificationCalls: number };
  readonly metrics: { readonly durationMs: number | null; readonly cost: number | null };
}
export interface DiscoveryPacketV1 {
  readonly schemaVersion: 2; readonly selectionVersion: 2; readonly projectId: string;
  readonly policy: ProjectDiscoveryPolicy; readonly eligibleCounts: { readonly new: number; readonly episodes: number; readonly outcomes: number };
  readonly portfolio: { readonly fingerprint: string; readonly revisions: readonly { readonly strategyId: string; readonly kind: "approach" | "modifier"; readonly revisionIdentity: string; readonly revisionFingerprint: string; readonly summary: string; readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[]; readonly principles: readonly string[] }[] };
  readonly openHypotheses: { readonly fingerprint: string; readonly entries: readonly { readonly ref: LearningArtifactRef; readonly logicalId: string; readonly kind: "approach" | "modifier"; readonly summary: string; readonly expectedEffect: string; readonly useWhen: readonly string[]; readonly avoidWhen: readonly string[]; readonly failureSignals: readonly string[] }[] };
  readonly sources: readonly DiscoverySourceSummary[]; readonly fingerprint: string;
}
export function discoveryPacketFingerprint(packet: Omit<DiscoveryPacketV1, "fingerprint">): string { return learningFingerprint(packet); }
export function validateDiscoveryPacket(v: unknown): v is DiscoveryPacketV1 {
  if (!obj(v) || !exact(v, ["schemaVersion", "selectionVersion", "projectId", "policy", "eligibleCounts", "portfolio", "openHypotheses", "sources", "fingerprint"]) ||
    v.schemaVersion !== 2 || v.selectionVersion !== 2 || !string(v.projectId, 64) || !PROJECT_ID.test(v.projectId as string) ||
    !validateProjectDiscoveryPolicy(v.policy) || !obj(v.eligibleCounts) || !exact(v.eligibleCounts, ["new", "episodes", "outcomes"]) ||
    !integer(v.eligibleCounts.new, 2, 100000) || !integer(v.eligibleCounts.episodes, 2, 100000) || !integer(v.eligibleCounts.outcomes, 1, 4) ||
    !obj(v.portfolio) || !exact(v.portfolio, ["fingerprint", "revisions"]) || !FINGERPRINT.test(v.portfolio.fingerprint as string) ||
    !Array.isArray(v.portfolio.revisions) || v.portfolio.revisions.length > 64 || !v.portfolio.revisions.every((r: unknown) => obj(r) && exact(r, ["strategyId", "kind", "revisionIdentity", "revisionFingerprint", "summary", "useWhen", "avoidWhen", "principles"]) && string(r.strategyId, 64) && (r.kind === "approach" || r.kind === "modifier") && string(r.revisionIdentity, 128) && FINGERPRINT.test(r.revisionFingerprint as string) && string(r.summary, 512) && [r.useWhen, r.avoidWhen, r.principles].every((items) => Array.isArray(items) && items.length <= 8 && items.every((x: unknown) => string(x, 256)))) ||
    !obj(v.openHypotheses) || !exact(v.openHypotheses, ["fingerprint", "entries"]) || !FINGERPRINT.test(v.openHypotheses.fingerprint as string) ||
    !Array.isArray(v.openHypotheses.entries) || v.openHypotheses.entries.length > 64 ||
    !v.openHypotheses.entries.every((e: unknown) => obj(e) && exact(e, ["ref", "logicalId", "kind", "summary", "expectedEffect", "useWhen", "avoidWhen", "failureSignals"]) &&
      validateLearningArtifactRef(e.ref, "strategy-hypothesis") && e.ref.scope.kind === "project" && e.ref.scope.projectId === v.projectId &&
      string(e.logicalId, 64) && (e.kind === "approach" || e.kind === "modifier") && string(e.summary, 512) && string(e.expectedEffect, 512) &&
      [e.useWhen, e.avoidWhen, e.failureSignals].every((items) => Array.isArray(items) && items.length <= 8 && items.every((x: unknown) => string(x, 256)))) ||
    v.openHypotheses.fingerprint !== learningFingerprint(v.openHypotheses.entries) ||
    !Array.isArray(v.sources) || v.sources.length < (v.policy as ProjectDiscoveryPolicy).minNewExperiences || v.sources.length > (v.policy as ProjectDiscoveryPolicy).maxCorpus) return false;
  const ids = new Set<string>(); const fingerprints = new Set<string>();
  for (const s of v.sources) {
    if (!obj(s) || !exact(s, ["ref", "recordedAt", "workEpisodeId", "goal", "taskRelation", "outcome", "policy", "execution", "metrics"]) ||
      !validateExactEvidenceRef(s.ref) || s.ref.projectId !== v.projectId || ids.has(s.ref.recordId) || fingerprints.has(s.ref.fingerprint) ||
      !string(s.recordedAt, 32) || Number.isNaN(Date.parse(s.recordedAt as string)) || new Date(s.recordedAt as string).toISOString() !== s.recordedAt ||
      !string(s.workEpisodeId, 64) || !UUID_V4.test(s.workEpisodeId as string) || !string(s.goal, 512) || !string(s.taskRelation, 64) ||
      !obj(s.outcome) || !exact(s.outcome, ["taskStatus", "verificationStatus", "completionRelation"]) ||
      ![s.outcome.taskStatus, s.outcome.verificationStatus, s.outcome.completionRelation].every((x) => string(x, 64)) ||
      !Array.isArray(s.policy) || s.policy.length > 9 || !s.policy.every((p: unknown) => obj(p) && exact(p, ["strategyId", "revisionIdentity", "revisionFingerprint", "exposure"]) && string(p.strategyId, 64) && string(p.revisionIdentity, 128) && FINGERPRINT.test(p.revisionFingerprint as string) && string(p.exposure, 64)) ||
      !obj(s.execution) || !exact(s.execution, ["toolCalls", "consequentialCalls", "toolErrors", "deniedCalls", "verificationCalls"]) ||
      !Object.values(s.execution).every((x) => integer(x, 0, 1000000)) || !obj(s.metrics) || !exact(s.metrics, ["durationMs", "cost"]) ||
      (s.metrics.durationMs !== null && !integer(s.metrics.durationMs, 0, 1000000000)) ||
      (s.metrics.cost !== null && (typeof s.metrics.cost !== "number" || !Number.isFinite(s.metrics.cost) || s.metrics.cost < 0))) return false;
    ids.add(s.ref.recordId); fingerprints.add(s.ref.fingerprint);
  }
  if (ids.size < (v.policy as ProjectDiscoveryPolicy).minNewExperiences ||
    (v.eligibleCounts as DiscoveryPacketV1["eligibleCounts"]).new < ids.size ||
    (v.eligibleCounts as DiscoveryPacketV1["eligibleCounts"]).episodes < new Set((v.sources as DiscoverySourceSummary[]).map((s) => s.workEpisodeId)).size ||
    (v.eligibleCounts as DiscoveryPacketV1["eligibleCounts"]).outcomes < new Set((v.sources as DiscoverySourceSummary[]).map((s) => `${s.outcome.taskStatus}/${s.outcome.verificationStatus}`)).size) return false;
  try { const { fingerprint, ...content } = v; return FINGERPRINT.test(fingerprint as string) && fingerprint === learningFingerprint(content); }
  catch { return false; }
}
