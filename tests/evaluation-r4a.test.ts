import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { learningArtifactFingerprint, hypothesisFingerprint, validateLearningArtifactRef, validateStrategyEvaluation, canonicalJson, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { trialEvidenceRef, validateTrialEvidenceV2, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { validateEvaluationPacket, validateEvaluationResult, validateEvaluationRef, evaluationPacketRef, evaluationResultRef, matchesEvaluationResultPacket, MAX_EVALUATION_PACKET_BYTES, MAX_EVALUATION_RESULT_BYTES, type EvaluationPacket, type EvaluationResult } from "../src/evaluation-contract.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
function fixture() {
  const semantics = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check changed contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
  const hypothesis = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope, id: h.id, fingerprint: h.fingerprint };
  const id = randomUUID();
  const e: TrialEvidenceV2 = seal({ schemaVersion: 2 as const, id, projectId, hypothesis,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash },
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: randomUUID(), recordedAt: "2026-01-01T00:00:00.000Z",
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] });
  assert.ok(validateTrialEvidenceV2(e));
  const p: EvaluationPacket = seal({ schemaVersion: 1 as const, id: randomUUID(), scope, gateVersion: 1 as const, analysisMode: "observational" as const, hypothesis, hypothesisSnapshot: h,
    trials: [{ handle: "T1", ref: trialEvidenceRef(e), snapshot: e, disposition: "included" as const }], diversity: { projectCount: 1 as const, workEpisodeCount: 1 }, comparisonStatus: "unavailable" as const });
  const r: EvaluationResult = seal({ schemaVersion: 1 as const, id: randomUUID(), scope, packet: evaluationPacketRef(p), hypothesis, gateVersion: 1 as const, analysisMode: "observational" as const,
    verdict: "continue-testing" as const, rationale: "One observed episode provides limited support.", limitations: ["No comparison; confounding and task heterogeneity remain."], citedHandles: ["T1"] });
  return { h, e, p, r };
}
test("R4-A exact immutable snapshots and four observational recommendations, never frozen trust inputs", () => {
  const { p, r } = fixture(); assert.ok(validateEvaluationPacket(p));
  for (const verdict of ["promote", "continue-testing", "revise", "reject"] as const) {
    const result = seal({ ...r, verdict }); assert.ok(validateEvaluationResult(result)); assert.ok(matchesEvaluationResultPacket(result, p));
    assert.ok(validateEvaluationRef(evaluationResultRef(result), "evaluation-result"));
    assert.equal(validateLearningArtifactRef(evaluationResultRef(result)), false); assert.equal(validateStrategyEvaluation(result), false);
  }
  assert.equal(validateLearningArtifactRef(evaluationPacketRef(p)), false);
  assert.equal(validateEvaluationRef(r.packet, "evaluation-result"), false);
});
test("R4-A strict packet identity, schema and observational boundary", () => {
  const { p, e } = fixture();
  const changes = [
    { schemaVersion: 2 }, { gateVersion: 2 }, { analysisMode: "causal" }, { comparisonStatus: "available" },
    { scope: { kind: "user-global" } }, { liveExperience: e.source }, { reward: 1 }, { trust: true },
    { hypothesisSnapshot: { ...p.hypothesisSnapshot, principles: ["changed"] } },
    { hypothesis: { ...p.hypothesis, id: randomUUID() } }, { trials: [] },
    { diversity: { projectCount: 1, workEpisodeCount: 2 } },
  ];
  for (const change of changes) assert.equal(validateEvaluationPacket(seal({ ...p, ...change })), false, JSON.stringify(change));
  for (const change of [{ handle: "T2" }, { disposition: "excluded-hypothesis" }, { ref: { ...trialEvidenceRef(e), fingerprint: hash } },
    { ref: e.source }, { snapshot: seal({ ...e, schemaVersion: 1 }) }, { snapshot: seal({ ...e, used: true }) },
    { ref: { ...trialEvidenceRef(e), scope: { kind: "project", projectId: "c".repeat(64) } } }]) {
    assert.equal(validateEvaluationPacket(seal({ ...p, trials: [{ ...p.trials[0], ...change }] })), false);
  }
  assert.equal(validateEvaluationPacket({ ...p, fingerprint: hash }), false);
  for (const v of [null, [], {}, { ...p, trials: [null] }]) assert.equal(validateEvaluationPacket(v), false);
});
function withTrials(p: EvaluationPacket, evidence: TrialEvidenceV2[]): EvaluationPacket {
  return seal({ ...p, trials: evidence.sort((a, b) => a.id.localeCompare(b.id)).map((snapshot, i) => ({ handle: `T${i + 1}`, ref: trialEvidenceRef(snapshot), snapshot,
    disposition: canonicalJson(snapshot.hypothesis) === canonicalJson(p.hypothesis) ? "included" as const : "excluded-hypothesis" as const })) });
}
test("R4-A diversity counts included WorkEpisodes, not Runs; exclusions and citations bind exact target", () => {
  const { p, e, r } = fixture();
  const id = randomUUID(), other = seal({ ...e, id, source: { ...e.source, recordId: `${id}.json` } });
  const two = withTrials(p, [e, other]); assert.ok(validateEvaluationPacket(two));
  assert.equal(validateEvaluationPacket(seal({ ...two, diversity: { projectCount: 1, workEpisodeCount: 2 } })), false);
  const otherHypothesis = { ...e.hypothesis, id: randomUUID() };
  const excluded = seal({ ...other, hypothesis: otherHypothesis, selection: { ...other.selection, revisionIdentity: otherHypothesis.id } });
  const mixed = withTrials(p, [e, excluded]); assert.ok(validateEvaluationPacket(mixed));
  const includedHandle = mixed.trials.find((t) => t.disposition === "included")!.handle;
  const excludedHandle = mixed.trials.find((t) => t.disposition !== "included")!.handle;
  assert.ok(matchesEvaluationResultPacket(seal({ ...r, packet: evaluationPacketRef(mixed), citedHandles: [includedHandle] }), mixed));
  assert.equal(matchesEvaluationResultPacket(seal({ ...r, packet: evaluationPacketRef(mixed), citedHandles: [excludedHandle] }), mixed), false);
  assert.equal(validateEvaluationPacket(withTrials(p, [excluded])), false);
  assert.equal(validateEvaluationPacket(withTrials(p, [e, e])), false);
  assert.equal(validateEvaluationPacket(seal({ ...two, trials: [...two.trials].reverse() })), false);
});
test("R4-A raw source/comparison refs are provenance only, with no fabricated comparison observations", () => {
  const { p, e, r } = fixture();
  const snapshot = seal({ ...e, comparison: [e.source] });
  const packet = withTrials(p, [snapshot]); assert.ok(validateEvaluationPacket(packet));
  assert.ok(matchesEvaluationResultPacket(seal({ ...r, packet: evaluationPacketRef(packet) }), packet));
  assert.equal(validateEvaluationPacket(seal({ ...packet, comparisonFacts: [{ ref: e.source, cost: 0 }] })), false);
});
test("R4-A result exact binding, bounds and citation membership fail closed", () => {
  const { p, r } = fixture();
  for (const change of [{ verdict: "suspend" }, { rationale: " " }, { rationale: "x".repeat(1025) }, { limitations: [] },
    { limitations: ["x".repeat(513)] }, { limitations: Array(9).fill("limited") }, { citedHandles: [] }, { citedHandles: ["T1", "T1"] },
    { citedHandles: ["T0"] }, { citedHandles: ["T33"] }, { decision: "promote" }, { policy: {} }, { causalSuperiority: true },
    { packet: { ...r.packet, family: "strategy-evaluation" } }]) assert.equal(validateEvaluationResult(seal({ ...r, ...change })), false);
  for (const change of [{ citedHandles: ["T2"] }, { packet: { ...r.packet, id: randomUUID() } }, { packet: { ...r.packet, fingerprint: hash } },
    { hypothesis: { ...r.hypothesis, id: randomUUID() } }]) assert.equal(matchesEvaluationResultPacket(seal({ ...r, ...change }), p), false);
  assert.equal(validateEvaluationResult({ ...r, fingerprint: hash }), false);
  assert.equal(matchesEvaluationResultPacket(r, seal({ ...p, gateVersion: 2 })), false);
  const oversized = seal({ ...r, rationale: "观".repeat(1024), limitations: Array(8).fill("限".repeat(512)),
    citedHandles: Array.from({ length: 16 }, (_, i) => `T${i + 1}`) });
  assert.ok(Buffer.byteLength(canonicalJson(oversized)) > MAX_EVALUATION_RESULT_BYTES);
  assert.equal(validateEvaluationResult(oversized), false);
});
test("R4-A canonical byte budget and count limits", () => {
  const { p, e } = fixture();
  const trials = Array.from({ length: 33 }, () => { const id = randomUUID(); return seal({ ...e, id, source: { ...e.source, recordId: `${id}.json` } }); });
  assert.equal(validateEvaluationPacket(withTrials(p, trials)), false);
  const comparisons = Array.from({ length: 8 }, () => ({ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }));
  const { id: _id, fingerprint: _fingerprint, ...semantic } = p.hypothesisSnapshot;
  const expanded = { ...semantic, useWhen: Array(8).fill("观察".repeat(128)), avoidWhen: Array(8).fill("限制".repeat(128)) };
  const hypothesisSnapshot = { ...expanded, id: p.hypothesisSnapshot.id, fingerprint: hypothesisFingerprint(expanded) };
  const hypothesis = { ...p.hypothesis, fingerprint: hypothesisSnapshot.fingerprint };
  const large = withTrials({ ...p, hypothesisSnapshot, hypothesis }, trials.slice(0, 32).map((t) => seal({ ...t, hypothesis,
    selection: { ...t.selection, revisionFingerprint: hypothesis.fingerprint }, comparison: comparisons })));
  assert.ok(Buffer.byteLength(canonicalJson(large)) > MAX_EVALUATION_PACKET_BYTES);
  assert.equal(validateEvaluationPacket(large), false);
});
