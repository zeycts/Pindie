import { canonicalJson, learningFingerprint, learningArtifactFingerprint, validateLearningArtifactRef, isExecutableStrategyHypothesis, type LearningArtifactRef, type StrategyHypothesis } from "./learning-v1-contract.ts";
import { hypothesisRef } from "./discovery-hypotheses.ts";
import { MAX_TRIAL_EVIDENCE_V2, validateTrialEvidenceV2, trialEvidenceRef, type TrialEvidenceV2 } from "./trial-evidence-v2.ts";
import { MAX_EVALUATION_PACKET_BYTES, validateEvaluationPacket, type EvaluationPacket } from "./evaluation-contract.ts";

export interface EvaluationPacketReaders {
  readonly hypothesis: { readExact(ref: LearningArtifactRef): Promise<unknown> };
  readonly evidence: {
    readExact(ref: LearningArtifactRef): Promise<unknown>;
    readExactMany?(refs: readonly LearningArtifactRef[]): Promise<readonly unknown[]>;
  };
}
export interface EvaluationPacketBuilderConfig {
  readonly maxTrials: number; readonly maxPacketBytes: number;
}
export const DEFAULT_EVALUATION_PACKET_BUILDER_CONFIG: EvaluationPacketBuilderConfig = Object.freeze({ maxTrials: 32, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const copy = <T>(v: T): T => JSON.parse(canonicalJson(v));
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
/** Read immutable history only; never consult open/trusted Strategy projections. */
export function immutableHypothesisReader(store: { list(projectId: string): Promise<readonly StrategyHypothesis[]> }): EvaluationPacketReaders["hypothesis"] {
  return { async readExact(ref) {
    if (!validateLearningArtifactRef(ref, "strategy-hypothesis") || ref.scope.kind !== "project") throw new Error("Invalid exact hypothesis ref.");
    const found = (await store.list(ref.scope.projectId)).filter((h) => h.id === ref.id);
    if (found.length !== 1 || !isExecutableStrategyHypothesis(found[0]) || !same(hypothesisRef(found[0]), ref)) throw new Error("Missing/ambiguous exact executable hypothesis.");
    return found[0];
  } };
}
/** R4-B read-only bridge. All refs resolve before bounded selection; no partial evidence fallback. */
export async function buildEvaluationPacket(
  input: { readonly hypothesis: LearningArtifactRef; readonly trialEvidence: readonly LearningArtifactRef[] },
  readers: EvaluationPacketReaders,
  config: EvaluationPacketBuilderConfig = DEFAULT_EVALUATION_PACKET_BUILDER_CONFIG,
  authority: { readonly signal?: AbortSignal; readonly isCurrent?: () => boolean } = {},
): Promise<EvaluationPacket> {
  const check = () => { authority.signal?.throwIfAborted(); if (authority.isCurrent && !authority.isCurrent()) throw new Error("Stale Evaluation packet authority."); };
  check();
  // Freeze caller-owned inputs before any await, including reader arguments.
  const request = freeze(copy(input)), limits = freeze(copy(config));
  if (Object.keys(request).sort().join() !== "hypothesis,trialEvidence" ||
    Object.keys(limits).sort().join() !== "maxPacketBytes,maxTrials" || !Number.isSafeInteger(limits.maxTrials) || limits.maxTrials < 1 || limits.maxTrials > 32 ||
    !Number.isSafeInteger(limits.maxPacketBytes) || limits.maxPacketBytes < 1 || limits.maxPacketBytes > MAX_EVALUATION_PACKET_BYTES ||
    !validateLearningArtifactRef(request.hypothesis, "strategy-hypothesis") || request.hypothesis.scope.kind !== "project" ||
    !Array.isArray(request.trialEvidence) || request.trialEvidence.length < 1 || request.trialEvidence.length > MAX_TRIAL_EVIDENCE_V2) throw new Error("Invalid Evaluation packet input/config.");
  const scope = request.hypothesis.scope, unique = new Map<string, LearningArtifactRef>();
  for (const ref of request.trialEvidence) {
    if (!validateLearningArtifactRef(ref, "trial-evidence") || !same(ref.scope, scope)) throw new Error("Invalid exact TrialEvidence project/ref.");
    const previous = unique.get(ref.id);
    if (previous && !same(previous, ref)) throw new Error("Conflicting TrialEvidence refs.");
    unique.set(ref.id, ref); // identical duplicate refs do not count twice
  }
  const refs = [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const hypothesisSnapshot = copy(await readers.hypothesis.readExact(request.hypothesis)); check();
  if (!isExecutableStrategyHypothesis(hypothesisSnapshot) || !same(hypothesisRef(hypothesisSnapshot), request.hypothesis)) throw new Error("Unresolved exact executable hypothesis.");
  const candidates: TrialEvidenceV2[] = [];
  let batch: readonly unknown[] | undefined;
  if (readers.evidence.readExactMany) {
    check(); batch = copy(await readers.evidence.readExactMany(freeze(refs))); check();
    if (!Array.isArray(batch) || batch.length !== refs.length) throw new Error("Invalid exact TrialEvidence batch.");
  }
  for (const [index, ref] of refs.entries()) {
    check(); const snapshot = batch ? batch[index] : copy(await readers.evidence.readExact(ref)); check();
    if (!validateTrialEvidenceV2(snapshot) || !same(trialEvidenceRef(snapshot), ref) || Buffer.byteLength(canonicalJson(snapshot)) > 16_384) throw new Error("Invalid exact TrialEvidence snapshot.");
    candidates.push(snapshot);
  }
  // Content-derived UUID with the schema-required v4/variant bits; no randomness or clock.
  const hex = learningFingerprint({ builderVersion: 1, hypothesis: request.hypothesis, hypothesisSnapshot, refs, config: limits }).slice(7, 39).split("");
  hex[12] = "4"; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const raw = hex.join(""), id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const included = (e: TrialEvidenceV2) => same(e.hypothesis, request.hypothesis);
  const packet = (selected: readonly TrialEvidenceV2[]): EvaluationPacket => {
    const sorted = [...selected].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), support = sorted.filter(included);
    const content = { schemaVersion: 1 as const, id, scope, gateVersion: 1 as const, analysisMode: "observational" as const,
      hypothesis: request.hypothesis, hypothesisSnapshot,
      trials: sorted.map((snapshot, i) => ({ handle: `T${i + 1}`, ref: trialEvidenceRef(snapshot), snapshot, disposition: included(snapshot) ? "included" as const : "excluded-hypothesis" as const })),
      diversity: { workEpisodeCount: new Set(support.map((e) => e.workEpisodeId)).size, projectCount: new Set(support.map((e) => e.projectId)).size as 1 }, comparisonStatus: "unavailable" as const };
    return { ...content, fingerprint: learningArtifactFingerprint(content) };
  };
  const selected: TrialEvidenceV2[] = [];
  // Included first, then excluded, each already UUID-ordered. Greedy byte fit is stable.
  for (const candidate of [...candidates.filter(included), ...candidates.filter((e) => !included(e))]) {
    if (selected.length === limits.maxTrials) break;
    if (Buffer.byteLength(canonicalJson(packet([...selected, candidate]))) <= limits.maxPacketBytes) selected.push(candidate);
  }
  const result = packet(selected); check();
  if (!validateEvaluationPacket(result)) throw new Error("No valid bounded Evaluation packet support.");
  return freeze(result);
}
