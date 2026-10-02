import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvaluationPacketStore } from "../src/evaluation-packet-store.ts";
import { FileEvaluationRunStore } from "../src/evaluation-run-store.ts";
import { evaluationRunRef } from "../src/evaluation-run.ts";
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
async function setup(t: TestContext) {
  const f = fixture();
  const { startedAt: _, ...base } = f.run;
  const run: EvaluationRunV1 = { ...base, status: "created" };
  let calls = 0;
  const evaluator: EvaluatorV1 = { schemaVersion: 1, identity: run.evaluator, evaluate: async (packet, context) => {
    calls++;
    assert.deepEqual(packet, f.packet);
    return { ...context, execution: { startedAt: context.execution.startedAt, completedAt: end }, observations: [], diagnostics: [] };
  } };
  const root = await mkdtemp(join(tmpdir(), "evaluation-execution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packets = new FileEvaluationPacketStore({ projectsBaseDir: root, readers: {
    hypothesis: { readExact: async () => f.packet.hypothesisSnapshot },
    evidence: { readExact: async () => f.packet.trials[0].snapshot },
  } });
  await packets.publish(f.packet);
  const runs = new FileEvaluationRunStore({ projectsBaseDir: root, packets });
  await runs.publish(run);
  const options = { runs, packets: { get: (ref: EvaluationPacketRef) => packets.get(ref) }, evaluator, now: (() => {
    let tick = 0; return () => tick++ === 0 ? start : end;
  })() };
  return { ...f, root, packets, runs, run, evaluator, options, calls: () => calls,
    runDir: join(root, projectId, "learning-v1", "evaluation-runs-v1"),
    packetPath: join(root, projectId, "learning-v1", "evaluation-packets-v1", `${f.packet.id}.json`),
  };
}
test("R4-C3-B1 success validates output and follows both lifecycle edges", async (t) => {
  const f = await setup(t), before = canonicalJson(f.run);
  let calls = 0;
  f.evaluator.evaluate = async (packet, context) => {
    calls++;
    assert.equal((await f.runs.getCurrent(projectId, f.run.runId)).status, "running");
    assert.deepEqual(await f.runs.get(evaluationRunRef(f.run)), f.run);
    return { ...context, execution: { startedAt: start, completedAt: end }, observations: [], diagnostics: [] };
  };
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.equal(calls, 1);
  assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
  assert.deepEqual(await f.runs.get(evaluationRunRef(outcome.running)), outcome.running);
  assert.equal((await readdir(f.runDir)).length, 3); assert.equal(outcome.run.status, "completed");
  assert.ok(isEvaluationRunTransition(f.run, outcome.running));
  assert.ok(isEvaluationRunTransition(outcome.running, outcome.run));
  assert.ok(matchesEvaluationOutputContext(outcome.output, prepareEvaluationInput(f.packet, outcome.running).context));
  assert.equal(canonicalJson(f.run), before);
  assert.ok(Object.isFrozen(outcome)); assert.ok(Object.isFrozen(outcome.output?.execution));
});
test("R4-C3-B1 missing, corrupt and foreign packets fail without invocation or output", async (t) => {
  for (const [get, code] of [
    [async () => { throw new Error("missing"); }, "PACKET_LOAD_FAILED"],
    [async () => null, "INVALID_PACKET"],
    [async () => ({ ...fixture().packet, fingerprint: hash }), "INVALID_PACKET"],
    [async () => fixture().packet, "PACKET_BINDING_MISMATCH"],
  ] as const) {
    const f = await setup(t);
    const outcome = await createExecutionRunner({ ...f.options, packets: { get: get as () => Promise<EvaluationPacket> } }).execute(f.run);
    assert.equal(outcome.run.status, "failed"); assert.equal(outcome.run.failure?.code, code);
    assert.equal(f.calls(), 0); assert.equal("output" in outcome, false);
    assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
    assert.ok(isEvaluationRunTransition(f.run, outcome.running)); assert.ok(isEvaluationRunTransition(outcome.running, outcome.run));
  }
});
test("R4-C3-B1 evaluator exception is bounded, captured once and never retried", async (t) => {
  const f = await setup(t); let calls = 0;
  f.evaluator.evaluate = async () => { calls++; throw { message: "sensitive".repeat(10000) }; };
  const outcome = await createExecutionRunner(f.options).execute(f.run);
  assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
  assert.equal(calls, 1); assert.equal(outcome.run.status, "failed");
  assert.equal(outcome.run.failure?.code, "EVALUATOR_EXCEPTION");
  assert.equal(canonicalJson(outcome).includes("sensitive"), false); assert.equal("output" in outcome, false);
});
test("R4-C3-B1 invalid schema, conclusions, wrong bindings and future completion fail closed", async (t) => {
  for (const change of [ { schemaVersion: 2 }, { score: 1 }, { runId: randomUUID() }, { packetFingerprint: hash },
    { packetRef: { ...fixture().run.packetRef, id: randomUUID() } }, { evaluator: { name: "other", version: "1" } },
    { evaluator: { name: "observation", version: "2" } }, { execution: { startedAt: end, completedAt: end } },
    { execution: { startedAt: start, completedAt: "2026-01-01T00:00:03.000Z" } } ]) {
    const f = await setup(t);
    const original = f.evaluator.evaluate;
    f.evaluator.evaluate = async (packet, context) => ({ ...await original(packet, context), ...change }) as EvaluationOutputV1;
    const outcome = await createExecutionRunner(f.options).execute(f.run);
    assert.equal(outcome.run.status, "failed"); assert.equal(outcome.run.failure?.code, "INVALID_OUTPUT");
    assert.equal(f.calls(), 1); assert.equal("output" in outcome, false);
    assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
  }
});
test("R4-C3-B1 rejects invalid/non-created runs and unregistered evaluator identity before reads", async (t) => {
  const f = await setup(t); let reads = 0;
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
test("R4-C3-B1 invocation exposes frozen data and a capability-free receiver only", async (t) => {
  const f = await setup(t), before = canonicalJson(f.packet);
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
test("R4-C3-B1 detaches run and registration before awaits and returned output after invocation", async (t) => {
  const f = await setup(t), expected = canonicalJson(f.run); let result: EvaluationOutputV1 | undefined;
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
test("R4-C3-B1 stable metadata uses exact attempt, packet, evaluator version and supplied clock", async (t) => {
  const f = await setup(t);
  const replica = new FileEvaluationRunStore({ projectsBaseDir: join(f.root, "replica"), packets: f.packets });
  await replica.publish(f.run);
  const execute = (runs: FileEvaluationRunStore) => createExecutionRunner({ ...f.options, runs,
    now: (() => { let tick = 0; return () => tick++ === 0 ? start : end; })() }).execute(f.run);
  const outcome = await execute(f.runs);
  assert.equal(canonicalJson(outcome), canonicalJson(await execute(replica)));
  assert.equal(outcome.run.packetFingerprint, f.packet.fingerprint); assert.deepEqual(outcome.run.evaluator, f.run.evaluator);
  assert.equal(outcome.running.startedAt, start); assert.equal(outcome.run.completedAt, end);
});

test("R4-C3-B concurrent runners with identical start timestamps invoke once", { timeout: 15_000 }, async (t) => {
  const f = await setup(t);
  let calls = 0, entered!: () => void, release!: () => void;
  const invoked = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const evaluator: EvaluatorV1 = { schemaVersion: 1, identity: f.run.evaluator, evaluate: async (_packet, context) => {
    calls++; entered(); await gate;
    return { ...context, execution: { startedAt: start, completedAt: end }, observations: [], diagnostics: [] };
  } };
  const other = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets });
  const runners = [f.runs, other].map((runs) => createExecutionRunner({ ...f.options, runs, evaluator,
    now: (() => { let tick = 0; return () => tick++ === 0 ? start : end; })() }));
  const attempts = runners.map((runner) => runner.execute(f.run));
  const settled = Promise.allSettled(attempts);
  try {
    await invoked;
    const rejection = await Promise.race(attempts.map((p) => p.then(() => undefined, (error) => error)));
    assert.match(rejection.message, /already claimed or terminal/);
    assert.equal(calls, 1);
    assert.equal((await other.getCurrent(projectId, f.run.runId)).status, "running");
    // The evaluator does not hold the namespace writer lock while awaiting execution.
    await other.publish({ ...f.run, runId: randomUUID() });
  } finally { release(); }
  const outcomes = await settled;
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
  assert.equal(calls, 1);
  assert.equal((await f.runs.getCurrent(projectId, f.run.runId)).status, "completed");
});

test("R4-C3-B completed and failed attempts reject stale-created replay across runners", async (t) => {
  for (const throws of [false, true]) {
    const f = await setup(t); let calls = 0, reads = 0;
    const original = f.evaluator.evaluate;
    f.evaluator.evaluate = async (packet, context) => { calls++; if (throws) throw new Error("failed"); return original(packet, context); };
    const outcome = await createExecutionRunner(f.options).execute(f.run);
    const replay = createExecutionRunner({ ...f.options,
      runs: new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets }),
      packets: { get: async () => { reads++; return f.packet; } },
    });
    await assert.rejects(replay.execute(f.run), /already claimed or terminal/);
    assert.equal(calls, 1); assert.equal(reads, 0);
    assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
    assert.equal((await readdir(f.runDir)).length, 3);
  }
});

test("R4-C3-B actual packet loss or corruption persists failure and preserves history", async (t) => {
  for (const corrupt of [false, true]) {
    const f = await setup(t), createdBytes = await readFile(join(f.runDir, `${f.run.runId}.created.json`), "utf8");
    if (corrupt) await writeFile(f.packetPath, "{"); else await rm(f.packetPath);
    const outcome = await createExecutionRunner(f.options).execute(f.run);
    assert.equal(outcome.run.status, "failed"); assert.equal(outcome.run.failure?.code, "PACKET_LOAD_FAILED");
    assert.equal(f.calls(), 0);
    assert.deepEqual(await f.runs.getCurrent(projectId, f.run.runId), outcome.run);
    assert.deepEqual(await f.runs.get(evaluationRunRef(outcome.running)), outcome.running);
    assert.equal(await readFile(join(f.runDir, `${f.run.runId}.created.json`), "utf8"), createdBytes);
    if (corrupt) assert.equal(await readFile(f.packetPath, "utf8"), "{");
  }
});

test("R4-C3-B claim publication failure never invokes evaluator or grants replay ownership", async (t) => {
  for (const frontier of ["beforePublish", "afterPublish"] as const) {
    const f = await setup(t);
    const runs = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets,
      [frontier]: async () => { throw new Error("publication failure"); },
    });
    await assert.rejects(createExecutionRunner({ ...f.options, runs }).execute(f.run), /publication failure/);
    assert.equal(f.calls(), 0);
    assert.equal((await f.runs.getCurrent(projectId, f.run.runId)).status, frontier === "beforePublish" ? "created" : "running");
    if (frontier === "afterPublish") {
      await assert.rejects(createExecutionRunner(f.options).execute(f.run), /already claimed or terminal/);
      assert.equal(f.calls(), 0);
    }
  }
});

test("R4-C3-B terminal publication failure propagates without returning an uncommitted outcome", async (t) => {
  for (const frontier of ["beforePublish", "afterPublish"] as const) {
    const f = await setup(t); let publications = 0;
    const runs = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets,
      [frontier]: async () => { if (++publications === 2) throw new Error("terminal publication failure"); },
    });
    await assert.rejects(createExecutionRunner({ ...f.options, runs }).execute(f.run), /terminal publication failure/);
    assert.equal(f.calls(), 1);
    assert.equal((await f.runs.getCurrent(projectId, f.run.runId)).status, frontier === "beforePublish" ? "running" : "completed");
    await assert.rejects(createExecutionRunner(f.options).execute(f.run), /already claimed or terminal/);
    assert.equal(f.calls(), 1);
  }
});
