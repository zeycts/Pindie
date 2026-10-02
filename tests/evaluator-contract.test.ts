import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, hypothesisFingerprint, learningArtifactFingerprint, learningFingerprint, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { evaluationPacketRef, type EvaluationPacket } from "../src/evaluation-contract.ts";
import { type EvaluationRunV1, type EvaluationPacketRef } from "../src/evaluation-run.ts";
import { validateEvaluator, validateEvaluationExecutionContext, validateEvaluationOutput, matchesEvaluationExecutionContext, matchesEvaluationOutputContext, prepareEvaluationInput, type EvaluatorV1, type EvaluationOutputV1 } from "../src/evaluator-contract.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const start = "2026-01-01T00:00:01.000Z", end = "2026-01-01T00:00:02.000Z";
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
function fixture() {
  const semantics = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
  const hypothesis = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope, id: h.id, fingerprint: h.fingerprint }, id = randomUUID();
  const e: TrialEvidenceV2 = seal({ schemaVersion: 2 as const, id, projectId, hypothesis,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash },
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: randomUUID(), recordedAt: start,
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] });
  const packet: EvaluationPacket = seal({ schemaVersion: 1 as const, id: randomUUID(), scope, gateVersion: 1 as const, analysisMode: "observational" as const, hypothesis, hypothesisSnapshot: h,
    trials: [{ handle: "T1", ref: trialEvidenceRef(e), snapshot: e, disposition: "included" as const }], diversity: { projectCount: 1 as const, workEpisodeCount: 1 }, comparisonStatus: "unavailable" as const });
  const run: EvaluationRunV1 = { schemaVersion: 1, runId: randomUUID(), packetRef: evaluationPacketRef(packet) as EvaluationPacketRef, packetFingerprint: packet.fingerprint,
    evaluator: { name: "observation", version: "1" }, status: "running", createdAt: start, startedAt: start };
  const { context } = prepareEvaluationInput(packet, run);
  const output: EvaluationOutputV1 = { ...context, execution: { startedAt: start, completedAt: end }, observations: ["One work episode is represented."], diagnostics: [{ code: "NO_COMPARISON", message: "Comparison is unavailable." }] };
  return { packet, run, context, output };
}
test("R4-C3-A versioned evaluator interface and valid observation-only output", () => {
  const { context, output, packet } = fixture();
  // Type-only implementation: no evaluator is invoked by this foundation.
  const evaluator: EvaluatorV1 = { schemaVersion: 1, identity: context.evaluator, evaluate: async () => output };
  assert.ok(validateEvaluator(evaluator));
  for (const invalid of [null, {}, { ...evaluator, schemaVersion: 2 }, { ...evaluator, evaluate: undefined }, { ...evaluator, writer: () => {} }, { ...evaluator, identity: { name: "", version: "1" } }]) assert.equal(validateEvaluator(invalid), false);
  assert.ok(validateEvaluationOutput(output)); assert.ok(matchesEvaluationOutputContext(output, context)); assert.ok(matchesEvaluationExecutionContext(context, packet));
  assert.ok(validateEvaluationOutput({ ...output, observations: [], diagnostics: [] }));
});
test("R4-C3-A missing/foreign packet context and invalid execution inputs fail closed", () => {
  const { context, packet, run } = fixture();
  for (const change of [{ packetRef: undefined }, { packetFingerprint: hash }, { runId: "bad" }, { schemaVersion: 2 }, { execution: { startedAt: "bad" } },
    { evaluator: { name: "x", version: "1", trust: 1 } }, { packetRef: { ...context.packetRef, family: "evaluation-result" } }]) assert.equal(validateEvaluationExecutionContext({ ...context, ...change }), false);
  const other = seal({ ...packet, id: randomUUID() });
  assert.equal(matchesEvaluationExecutionContext(context, other), false);
  assert.throws(() => prepareEvaluationInput(other, run), /Mismatched/);
  assert.throws(() => prepareEvaluationInput({ ...packet, fingerprint: hash }, run), /Invalid/);
  assert.throws(() => prepareEvaluationInput(packet, { ...run, status: "created" }), /Invalid/);
});
test("R4-C3-A strict bounded output rejects conclusions and malformed metadata", () => {
  const { output, context } = fixture();
  for (const field of ["score", "verdict", "recommendation", "promotion", "confidence", "trust", "policy", "strategy", "result"]) {
    assert.equal(validateEvaluationOutput({ ...output, [field]: 1 }), false);
    assert.equal(validateEvaluationOutput({ ...output, evaluator: { ...output.evaluator, [field]: 1 } }), false);
    assert.equal(validateEvaluationOutput({ ...output, diagnostics: [{ ...output.diagnostics[0], [field]: 1 }] }), false);
    assert.equal(validateEvaluationOutput({ ...output, execution: { ...output.execution, [field]: 1 } }), false);
  }
  for (const change of [{ schemaVersion: 2 }, { observations: [""] }, { observations: Array(17).fill("x") }, { observations: ["x".repeat(1025)] },
    { observations: Array(16).fill("x".repeat(1024)) }, { diagnostics: Array(17).fill(output.diagnostics[0]) }, { diagnostics: [{ code: "", message: "x" }] },
    { diagnostics: [{ code: "x", message: "x".repeat(1025) }] }, { execution: { startedAt: start, completedAt: "invalid" } }, { execution: { startedAt: end, completedAt: start } },
    { packetRef: undefined }, { packetFingerprint: hash }, { observations: [() => {}] }, { observations: [NaN] }]) assert.equal(validateEvaluationOutput({ ...output, ...change }), false);
  for (const change of [{ runId: randomUUID() }, { packetRef: { ...output.packetRef, id: randomUUID() } }, { evaluator: { name: "other", version: "1" } },
    { evaluator: { ...output.evaluator, version: "2" } }, { execution: { startedAt: end, completedAt: end } }]) assert.equal(matchesEvaluationOutputContext({ ...output, ...change }, context), false);
});
test("R4-C3-A input is detached/deeply frozen and exposes no mutation capability", () => {
  const { packet, run } = fixture(), input = prepareEvaluationInput(packet, run);
  assert.deepEqual(Object.keys(input.context).sort(), ["schemaVersion", "runId", "packetRef", "packetFingerprint", "evaluator", "execution"].sort());
  for (const name of ["experience", "strategy", "policy", "trust", "decision", "store", "runtime", "writer"]) {
    assert.equal(name in input.context, false);
    assert.equal(validateEvaluationExecutionContext({ ...input.context, [name]: {} }), false);
  }
  assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.context.packetRef.scope)); assert.ok(Object.isFrozen(input.packet.trials[0].snapshot.postDeclaration));
  assert.throws(() => { (input.packet.trials as unknown as unknown[]).push({}); }, TypeError);
  assert.throws(() => { (input.context.evaluator as { name: string }).name = "changed"; }, TypeError);
  // Compile-time authority boundary as well as runtime frozen values.
  if (false) {
    // @ts-expect-error No learning state writer is part of the context.
    input.context.writer.save({});
    // @ts-expect-error Packet snapshot fields are readonly.
    input.packet.hypothesisSnapshot.summary = "changed";
  }
  const before = canonicalJson(input);
  (run.evaluator as { name: string }).name = "caller changed";
  (packet.hypothesisSnapshot as { summary: string }).summary = "caller changed";
  assert.equal(canonicalJson(input), before);
});
test("R4-C3-A deterministic serialization and fingerprint independent of key order", () => {
  const { output, context } = fixture();
  const reordered = Object.fromEntries(Object.entries(output).reverse());
  assert.equal(canonicalJson(output), canonicalJson(reordered)); assert.equal(learningFingerprint(output), learningFingerprint(reordered));
  assert.deepEqual(JSON.parse(canonicalJson(output)), output); assert.ok(validateEvaluationOutput(JSON.parse(canonicalJson(output))));
  assert.ok(matchesEvaluationOutputContext(JSON.parse(canonicalJson(output)), JSON.parse(canonicalJson(context))));
  assert.notEqual(learningFingerprint(output), learningFingerprint({ ...output, observations: ["Different observation"] }));
});
