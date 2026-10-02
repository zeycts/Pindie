import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalJson, hypothesisFingerprint, learningArtifactFingerprint, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { evaluationPacketRef, type EvaluationPacket } from "../src/evaluation-contract.ts";
import { type EvaluationRunV1, type EvaluationPacketRef } from "../src/evaluation-run.ts";
import { matchesEvaluationOutputContext, prepareEvaluationInput, type EvaluatorV1, type EvaluationOutputV1 } from "../src/evaluator-contract.ts";
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
import { createExecutionRunner } from "../src/evaluation-execution-runner.ts";
import { isEvaluationRunTransition, transitionEvaluationRun } from "../src/evaluation-run.ts";
function setup() {
  const f = fixture();
  const { startedAt: _, ...base } = f.run;
  const run: EvaluationRunV1 = { ...base, status: "created" };
  let calls = 0;
  const evaluator: EvaluatorV1 = { schemaVersion: 1, identity: run.evaluator, evaluate: async (packet, context) => {
    calls++;
    assert.deepEqual(packet, f.packet);
    return { ...context, execution: { startedAt: context.execution.startedAt, completedAt: end }, observations: [], diagnostics: [] };
  } };
  const options = { packets: { get: async () => f.packet }, evaluator, now: (() => {
    let tick = 0; return () => tick++ === 0 ? start : end;
  })() };
  return { ...f, run, evaluator, options, calls: () => calls };
}
test("R4-C3-B1 success validates output and follows both lifecycle edges", async () => {
  const f = setup(), before = canonicalJson(f.run);
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.equal(f.calls(), 1); assert.equal(outcome.run.status, "completed");
  assert.ok(isEvaluationRunTransition(f.run, outcome.running));
  assert.ok(isEvaluationRunTransition(outcome.running, outcome.run));
  assert.ok(matchesEvaluationOutputContext(outcome.output, prepareEvaluationInput(f.packet, outcome.running).context));
  assert.equal(canonicalJson(f.run), before);
  assert.ok(Object.isFrozen(outcome)); assert.ok(Object.isFrozen(outcome.output?.execution));
});
test("R4-C3-B1 missing, corrupt and foreign packets fail without invocation or output", async () => {
  for (const [get, code] of [
    [async () => { throw new Error("missing"); }, "PACKET_LOAD_FAILED"],
    [async () => null, "INVALID_PACKET"],
    [async () => ({ ...setup().packet, fingerprint: hash }), "INVALID_PACKET"],
    [async () => setup().packet, "PACKET_BINDING_MISMATCH"],
  ] as const) {
    const f = setup();
    const outcome = await createExecutionRunner({ ...f.options, packets: { get: get as () => Promise<EvaluationPacket> } }).execute(f.run);
    assert.equal(outcome.run.status, "failed"); assert.equal(outcome.run.failure?.code, code);
    assert.equal(f.calls(), 0); assert.equal("output" in outcome, false);
    assert.ok(isEvaluationRunTransition(f.run, outcome.running)); assert.ok(isEvaluationRunTransition(outcome.running, outcome.run));
  }
});
test("R4-C3-B1 evaluator exception is bounded, captured once and never retried", async () => {
  const f = setup(); let calls = 0;
  f.evaluator.evaluate = async () => { calls++; throw { message: "sensitive".repeat(10000) }; };
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.equal(calls, 1); assert.equal(outcome.run.status, "failed");
  assert.equal(outcome.run.failure?.code, "EVALUATOR_EXCEPTION");
  assert.equal(canonicalJson(outcome).includes("sensitive"), false); assert.equal("output" in outcome, false);
});
test("R4-C3-B1 invalid schema, conclusions, wrong bindings and future completion fail closed", async () => {
  for (const change of [ { schemaVersion: 2 }, { score: 1 }, { runId: randomUUID() }, { packetFingerprint: hash },
    { packetRef: { ...setup().run.packetRef, id: randomUUID() } }, { evaluator: { name: "other", version: "1" } },
    { evaluator: { name: "observation", version: "2" } }, { execution: { startedAt: end, completedAt: end } },
    { execution: { startedAt: start, completedAt: "2026-01-01T00:00:03.000Z" } } ]) {
    const f = setup();
    const original = f.evaluator.evaluate;
    f.evaluator.evaluate = async (packet, context) => ({ ...await original(packet, context), ...change }) as EvaluationOutputV1;
    const outcome = await createExecutionRunner(f.options).execute(f.run);
    assert.equal(outcome.run.status, "failed"); assert.equal(outcome.run.failure?.code, "INVALID_OUTPUT");
    assert.equal(f.calls(), 1); assert.equal("output" in outcome, false);
  }
});
test("R4-C3-B1 rejects invalid/non-created runs and unregistered evaluator identity before reads", async () => {
  const f = setup(); let reads = 0;
  const runner = createExecutionRunner({ ...f.options, packets: { get: async () => { reads++; return f.packet; } } });
  const running = transitionEvaluationRun(f.run, "running", start);
  for (const run of [{ ...f.run, schemaVersion: 2 }, { ...f.run, evaluator: { name: "other", version: "1" } },
    { ...f.run, evaluator: { ...f.run.evaluator, version: "2" } }, running, transitionEvaluationRun(running, "completed", end),
    transitionEvaluationRun(running, "failed", end, { code: "X", message: "Failed" })]) {
    await assert.rejects(runner.execute(run as EvaluationRunV1));
  }
  assert.equal(reads, 0); assert.equal(f.calls(), 0);
  assert.throws(() => createExecutionRunner({ ...f.options, evaluator: { ...f.evaluator, schemaVersion: 2 } as unknown as EvaluatorV1 }));
});
test("R4-C3-B1 invocation exposes frozen data and a capability-free receiver only", async () => {
  const f = setup(), before = canonicalJson(f.packet);
  f.evaluator.evaluate = async function (packet, context) {
    assert.equal(arguments.length, 2);
    assert.deepEqual(Object.keys(this).sort(), ["evaluate", "identity", "schemaVersion"]);
    assert.ok(Object.isFrozen(this)); assert.ok(Object.isFrozen(this.identity));
    for (const field of ["experience", "strategy", "policy", "trust", "decision", "store", "writer", "runtime"]) {
      assert.equal(field in context, false); assert.equal(field in packet, false); assert.equal(field in this, false);
    }
    assert.ok(Object.isFrozen(packet.trials[0].snapshot.postDeclaration)); assert.ok(Object.isFrozen(context.packetRef.scope));
    assert.throws(() => { (packet.hypothesisSnapshot as { summary: string }).summary = "changed"; }, TypeError);
    assert.throws(() => { (context.evaluator as { version: string }).version = "changed"; }, TypeError);
    return { ...context, execution: { startedAt: start, completedAt: end }, observations: [], diagnostics: [] };
  };
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.equal(outcome.run.status, "completed"); assert.equal(canonicalJson(f.packet), before);
});
test("R4-C3-B1 detaches run and registration before awaits and returned output after invocation", async () => {
  const f = setup(), expected = canonicalJson(f.run); let result: EvaluationOutputV1 | undefined;
  f.options.packets.get = async () => {
    (f.run.evaluator as { name: string }).name = "caller changed";
    f.evaluator.evaluate = async () => { throw new Error("replacement"); };
    return f.packet;
  };
  f.evaluator.evaluate = async (packet, context) => {
    result = { ...context, execution: { startedAt: start, completedAt: end }, observations: [], diagnostics: [] };
    return result;
  };
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.equal(outcome.run.status, "completed");
  assert.equal(outcome.run.evaluator.name, JSON.parse(expected).evaluator.name);
  (result!.observations as string[]).push("caller changed");
  assert.deepEqual(outcome.output?.observations, []);
});
test("R4-C3-B1 stable metadata uses exact attempt, packet, evaluator version and supplied clock", async () => {
  const f = setup();
  const execute = () => createExecutionRunner({ ...f.options, now: (() => { let tick = 0; return () => tick++ === 0 ? start : end; })() }).execute(f.run);
  assert.equal(canonicalJson(await execute()), canonicalJson(await execute()));
  const outcome = await execute();
  assert.equal(outcome.run.packetFingerprint, f.packet.fingerprint); assert.deepEqual(outcome.run.evaluator, f.run.evaluator);
  assert.equal(outcome.running.startedAt, start); assert.equal(outcome.run.completedAt, end);
});
