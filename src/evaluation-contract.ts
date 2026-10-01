import { canonicalJson, learningArtifactFingerprint, validateLearningArtifactRef, isExecutableStrategyHypothesis, PROJECT_ID, UUID_V4, FINGERPRINT, type LearningArtifactRef, type StrategyHypothesisV2 } from "./learning-v1-contract.ts";
import { validateTrialEvidenceV2, trialEvidenceRef, type TrialEvidenceV2 } from "./trial-evidence-v2.ts";

/** R4-A pure observational contracts. No storage, execution or trust authority. */
export interface EvaluationRef {
  readonly schemaVersion: 1;
  readonly family: "evaluation-packet" | "evaluation-result";
  readonly scope: { readonly kind: "project"; readonly projectId: string };
  readonly id: string; readonly fingerprint: string;
}
export interface EvaluationPacket {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly scope: EvaluationRef["scope"];
  readonly gateVersion: 1; readonly analysisMode: "observational";
  readonly hypothesis: LearningArtifactRef; readonly hypothesisSnapshot: StrategyHypothesisV2;
  readonly trials: readonly {
    readonly handle: string; readonly ref: LearningArtifactRef; readonly snapshot: TrialEvidenceV2;
    readonly disposition: "included" | "excluded-hypothesis";
  }[];
  readonly diversity: { readonly workEpisodeCount: number; readonly projectCount: 1 };
  readonly comparisonStatus: "unavailable";
}
export interface EvaluationResult {
  readonly schemaVersion: 1; readonly id: string; readonly fingerprint: string;
  readonly scope: EvaluationRef["scope"]; readonly packet: EvaluationRef;
  readonly hypothesis: LearningArtifactRef; readonly gateVersion: 1; readonly analysisMode: "observational";
  readonly verdict: "promote" | "continue-testing" | "revise" | "reject";
  readonly rationale: string; readonly limitations: readonly string[]; readonly citedHandles: readonly string[];
}
export const MAX_EVALUATION_PACKET_BYTES = 131_072;
export const MAX_EVALUATION_RESULT_BYTES = 16_384;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, fields: string) => Object.keys(v).sort().join() === fields;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const scope = (v: unknown): v is EvaluationRef["scope"] => object(v) && keys(v, "kind,projectId") && v.kind === "project" && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function base(v: Record<string, unknown>, max: number): boolean {
  return v.schemaVersion === 1 && typeof v.id === "string" && UUID_V4.test(v.id) && scope(v.scope) &&
    v.gateVersion === 1 && v.analysisMode === "observational" && typeof v.fingerprint === "string" &&
    FINGERPRINT.test(v.fingerprint) && v.fingerprint === learningArtifactFingerprint(v) && Buffer.byteLength(canonicalJson(v)) <= max;
}
export function validateEvaluationRef(v: unknown, family?: EvaluationRef["family"]): v is EvaluationRef {
  return object(v) && keys(v, "family,fingerprint,id,schemaVersion,scope") && v.schemaVersion === 1 &&
    (v.family === "evaluation-packet" || v.family === "evaluation-result") && (family === undefined || family === v.family) &&
    scope(v.scope) && typeof v.id === "string" && UUID_V4.test(v.id) && typeof v.fingerprint === "string" && FINGERPRINT.test(v.fingerprint);
}
export function validateEvaluationPacket(value: unknown): value is EvaluationPacket {
  try {
    if (!object(value) || !keys(value, "analysisMode,comparisonStatus,diversity,fingerprint,gateVersion,hypothesis,hypothesisSnapshot,id,schemaVersion,scope,trials") || !base(value, MAX_EVALUATION_PACKET_BYTES)) return false;
    const p = value as unknown as EvaluationPacket, h = p.hypothesisSnapshot;
    if (!validateLearningArtifactRef(p.hypothesis, "strategy-hypothesis") || !isExecutableStrategyHypothesis(h) ||
      !same(h.scope, p.scope) || !same(p.hypothesis.scope, p.scope) || p.hypothesis.id !== h.id || p.hypothesis.fingerprint !== h.fingerprint ||
      p.comparisonStatus !== "unavailable" || !Array.isArray(p.trials) || p.trials.length < 1 || p.trials.length > 32) return false;
    const episodes = new Set<string>(); let previous = "";
    for (let i = 0; i < p.trials.length; i++) {
      const t = p.trials[i];
      if (!object(t) || !keys(t, "disposition,handle,ref,snapshot") || t.handle !== `T${i + 1}` ||
        !validateLearningArtifactRef(t.ref, "trial-evidence") || !validateTrialEvidenceV2(t.snapshot) ||
        !same(t.ref.scope, p.scope) || !same(t.ref, trialEvidenceRef(t.snapshot)) || t.ref.id <= previous) return false;
      previous = t.ref.id;
      const included = same(t.snapshot.hypothesis, p.hypothesis);
      if (t.disposition !== (included ? "included" : "excluded-hypothesis")) return false;
      if (included) episodes.add(t.snapshot.workEpisodeId);
    }
    return episodes.size > 0 && object(p.diversity) && keys(p.diversity, "projectCount,workEpisodeCount") &&
      p.diversity.projectCount === 1 && p.diversity.workEpisodeCount === episodes.size;
  } catch { return false; }
}
export function evaluationPacketRef(p: EvaluationPacket): EvaluationRef {
  return { schemaVersion: 1, family: "evaluation-packet", scope: p.scope, id: p.id, fingerprint: p.fingerprint };
}
export function evaluationResultRef(r: EvaluationResult): EvaluationRef {
  return { schemaVersion: 1, family: "evaluation-result", scope: r.scope, id: r.id, fingerprint: r.fingerprint };
}
export function validateEvaluationResult(value: unknown): value is EvaluationResult {
  try {
    if (!object(value) || !keys(value, "analysisMode,citedHandles,fingerprint,gateVersion,hypothesis,id,limitations,packet,rationale,schemaVersion,scope,verdict") || !base(value, MAX_EVALUATION_RESULT_BYTES)) return false;
    const r = value as unknown as EvaluationResult;
    return validateEvaluationRef(r.packet, "evaluation-packet") && same(r.packet.scope, r.scope) &&
      validateLearningArtifactRef(r.hypothesis, "strategy-hypothesis") && same(r.hypothesis.scope, r.scope) &&
      ["promote", "continue-testing", "revise", "reject"].includes(r.verdict) && text(r.rationale, 1024) &&
      Array.isArray(r.limitations) && r.limitations.length >= 1 && r.limitations.length <= 8 && r.limitations.every((s) => text(s, 512)) &&
      Array.isArray(r.citedHandles) && r.citedHandles.length >= 1 && r.citedHandles.length <= 16 &&
      r.citedHandles.every((s) => typeof s === "string" && /^T(?:[1-9]|[12][0-9]|3[0-2])$/.test(s)) && new Set(r.citedHandles).size === r.citedHandles.length;
  } catch { return false; }
}
/** Internal binding only. Publication must separately resolve immutable inputs; no live Experience reader. */
export function matchesEvaluationResultPacket(result: unknown, packet: unknown): boolean {
  return validateEvaluationResult(result) && validateEvaluationPacket(packet) && same(result.packet, evaluationPacketRef(packet)) &&
    same(result.hypothesis, packet.hypothesis) && result.gateVersion === packet.gateVersion &&
    result.citedHandles.every((handle) => packet.trials.some((t) => t.handle === handle && t.disposition === "included"));
}
