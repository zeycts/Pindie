import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hypothesisFingerprint, learningArtifactFingerprint, learningFingerprint, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { hypothesisRef } from "../src/discovery-hypotheses.ts";
import { trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { buildEvaluationPacket } from "../src/evaluation-packet-builder.ts";
import { evaluationPacketRef, type EvaluationPacket } from "../src/evaluation-contract.ts";
import { FileEvaluationPacketStore } from "../src/evaluation-packet-store.ts";
import { FileEvaluationRunStore, MAX_EVALUATION_RUNS_V1 } from "../src/evaluation-run-store.ts";
import { validateEvaluationRun, transitionEvaluationRun, evaluationRunRef, type EvaluationRunV1, type EvaluationPacketRef } from "../src/evaluation-run.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const copy = <T>(v: T): T => JSON.parse(canonicalJson(v));
const at = "2026-01-01T00:00:00.000Z", start = "2026-01-01T00:00:01.000Z", end = "2026-01-01T00:00:02.000Z";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "evaluation-run-")); t.after(() => rm(root, { recursive: true, force: true }));
  const semantic = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) }, id = randomUUID();
  const content = { schemaVersion: 2 as const, id, projectId,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash }, hypothesis: hypothesisRef(h),
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: randomUUID(), recordedAt: at,
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] };
  const evidence: TrialEvidenceV2 = { ...content, fingerprint: learningArtifactFingerprint(content) };
  const readers = { hypothesis: { readExact: async () => h }, evidence: { readExact: async () => evidence } };
  const packet = await buildEvaluationPacket({ hypothesis: hypothesisRef(h), trialEvidence: [trialEvidenceRef(evidence)] }, readers);
  const packets = new FileEvaluationPacketStore({ projectsBaseDir: root, readers }); await packets.publish(packet);
  const run: EvaluationRunV1 = { schemaVersion: 1, runId: randomUUID(), packetRef: evaluationPacketRef(packet) as EvaluationPacketRef, packetFingerprint: packet.fingerprint,
    evaluator: { name: "observational", version: "1" }, status: "created", createdAt: at };
  const dir = join(root, projectId, "learning-v1", "evaluation-runs-v1");
  const store = new FileEvaluationRunStore({ projectsBaseDir: root, packets });
  return { root, packets, packet, run, dir, store, path: (r: EvaluationRunV1) => join(dir, `${r.runId}.${r.status}.json`) };
}
test("R4-C2 strict minimal schema and lifecycle validation", async (t) => {
  const { run } = await fixture(t), running = transitionEvaluationRun(run, "running", start);
  const completed = transitionEvaluationRun(running, "completed", end), failed = transitionEvaluationRun(running, "failed", end, { code: "ERROR", message: "Attempt failed" });
  for (const r of [run, running, completed, failed]) assert.ok(validateEvaluationRun(r));
  for (const r of [ { ...run, score: 1 }, { ...run, schemaVersion: 2 }, { ...run, runId: "../escape" }, { ...run, packetFingerprint: hash },
    { ...run, evaluator: { ...run.evaluator, model: "x" } }, { ...run, evaluator: { name: "", version: "1" } }, { ...run, createdAt: "bad" },
    { ...run, startedAt: start }, { ...running, startedAt: "2025-01-01T00:00:00.000Z" }, { ...completed, completedAt: at }, { ...completed, failure: { code: "x", message: "x" } },
    { ...failed, failure: undefined }, { ...failed, failure: { code: "", message: "x" } }, { ...run, packetRef: { ...run.packetRef, family: "evaluation-result" } } ]) assert.equal(validateEvaluationRun(r), false);
  for (const [prior, status] of [[run, "completed"], [run, "failed"], [running, "created"], [running, "running"], [completed, "running"], [failed, "completed"]] as const) assert.throws(() => transitionEvaluationRun(prior, status, end));
  assert.throws(() => transitionEvaluationRun(run, "running", start, { code: "x", message: "x" }));
});
test("R4-C2 immutable snapshots, exact lookup, lifecycle and retry after terminal", async (t) => {
  const f = await fixture(t); await assert.rejects(f.store.getCurrent(projectId, f.run.runId), /Missing/);
  const created = await f.store.publish(f.run), bytes = await readFile(f.path(f.run), "utf8");
  assert.ok(Object.isFrozen(created.packetRef.scope));
  const running = transitionEvaluationRun(f.run, "running", start), completed = transitionEvaluationRun(running, "completed", end);
  await f.store.publish(running); await f.store.publish(completed);
  assert.deepEqual(await f.store.getCurrent(projectId, f.run.runId), completed);
  for (const r of [f.run, running, completed]) { assert.deepEqual(await f.store.get(evaluationRunRef(r)), r); assert.deepEqual(await f.store.publish(r), r); }
  assert.equal(await readFile(f.path(f.run), "utf8"), bytes); assert.equal((await readdir(f.dir)).length, 3);
  await assert.rejects(f.store.get({ ...evaluationRunRef(f.run), fingerprint: hash }), /exact/);
  await assert.rejects(f.store.get({ ...evaluationRunRef(f.run), runId: "../escape" }), /Invalid/);
  await assert.rejects(f.store.publish(transitionEvaluationRun(running, "failed", end, { code: "x", message: "x" })), /transition/);
});
test("R4-C2 failed branch, skipped edges and changed identity/evaluator fail closed", async (t) => {
  const f = await fixture(t), running = transitionEvaluationRun(f.run, "running", start);
  await assert.rejects(f.store.publish(running), /transition/);
  await f.store.publish(f.run);
  for (const change of [{ evaluator: { name: "other", version: "1" } }, { createdAt: "2025-01-01T00:00:00.000Z" }]) await assert.rejects(f.store.publish({ ...running, ...change }), /transition/);
  await f.store.publish(running);
  const failed = transitionEvaluationRun(running, "failed", end, { code: "ERROR", message: "Failed" }); await f.store.publish(failed);
  assert.deepEqual(await f.store.getCurrent(projectId, f.run.runId), failed);
  await assert.rejects(f.store.publish(transitionEvaluationRun(running, "completed", end)), /transition/);
});
test("R4-C2 missing/corrupt/mismatched packet rejected without run publication", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, projectId, "learning-v1", "evaluation-packets-v1", `${f.packet.id}.json`), bytes = await readFile(path, "utf8");
  await rm(path); await assert.rejects(f.store.publish(f.run), /Missing/);
  await writeFile(path, "{"); await assert.rejects(f.store.publish(f.run));
  await writeFile(path, bytes);
  await assert.rejects(f.store.publish({ ...f.run, packetRef: { ...f.run.packetRef, fingerprint: hash }, packetFingerprint: hash }), /Mismatched/);
  for (const bad of [null, { ...f.packet, schemaVersion: 2 }, { ...f.packet, fingerprint: hash }]) {
    const store = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: { get: async () => bad as EvaluationPacket } });
    await assert.rejects(store.publish(f.run));
  }
  assert.deepEqual(await readdir(f.dir), []);
});
test("R4-C2 concurrent identical/conflicting publication and terminal races", async (t) => {
  const f = await fixture(t), other = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets });
  assert.deepEqual(await Promise.all([f.store.publish(f.run), other.publish(f.run)]), [f.run, f.run]);
  const conflict = { ...f.run, evaluator: { name: "other", version: "1" } };
  const before = await readFile(f.path(f.run), "utf8"); await assert.rejects(other.publish(conflict), /Conflicting/); assert.equal(await readFile(f.path(f.run), "utf8"), before);
  const fresh = { ...f.run, runId: randomUUID() }, changed = { ...fresh, evaluator: conflict.evaluator };
  const results = await Promise.allSettled([f.store.publish(fresh), other.publish(changed)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const running = transitionEvaluationRun(f.run, "running", start); await f.store.publish(running);
  const terminals = await Promise.allSettled([f.store.publish(transitionEvaluationRun(running, "completed", end)), other.publish(transitionEvaluationRun(running, "failed", end, { code: "x", message: "x" }))]);
  assert.equal(terminals.filter((r) => r.status === "fulfilled").length, 1); assert.equal(terminals.filter((r) => r.status === "rejected").length, 1);
});
for (const corruption of ["json", "digest", "version", "unknown", "noncanonical", "oversize", "identity", "chain"]) test(`R4-C2 corruption fails closed: ${corruption}`, async (t) => {
  const f = await fixture(t); await f.store.publish(f.run); const value = JSON.parse(await readFile(f.path(f.run), "utf8"));
  if (corruption === "digest") value.fingerprint = hash;
  if (corruption === "version") value.schemaVersion = 2;
  if (corruption === "unknown") value.extra = true;
  if (corruption === "identity") { value.run.runId = randomUUID(); value.fingerprint = learningFingerprint(value.run); }
  if (corruption === "chain") {
    await rm(f.path(f.run)); const running = transitionEvaluationRun(f.run, "running", start);
    await writeFile(f.path(running), canonicalJson({ schemaVersion: 1, run: running, fingerprint: learningFingerprint(running) }));
  } else await writeFile(f.path(f.run), corruption === "json" ? "{" : corruption === "oversize" ? "x".repeat(9000) : corruption === "noncanonical" ? JSON.stringify(value, null, 2) : canonicalJson(value));
  await assert.rejects(f.store.get(evaluationRunRef(f.run))); await assert.rejects(f.store.getCurrent(projectId, f.run.runId)); await assert.rejects(f.store.publish(f.run));
});
test("R4-C2 atomic precommit isolation, input freeze, stale/abort and postcommit reconciliation", async (t) => {
  const f = await fixture(t); let current = true;
  const input = copy(f.run);
  const store = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets, beforePublish: async () => {
    input.evaluator.name = "mutated"; await assert.rejects(f.store.getCurrent(projectId, f.run.runId), /Missing/); current = false;
  } });
  await assert.rejects(store.publish(input, undefined, () => current), /Stale/); assert.deepEqual(await readdir(f.dir), []);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.store.publish(f.run, controller.signal));
  const after = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: f.packets, afterPublish: async () => { throw new Error("lost acknowledgement"); } });
  await assert.rejects(after.publish(f.run), /acknowledgement/); assert.deepEqual(await f.store.publish(f.run), f.run);
});
test("R4-C2 isolated writes leave packets and all semantic/runtime namespaces untouched", async (t) => {
  const f = await fixture(t), base = join(f.root, projectId, "learning-v1");
  const protectedNames = ["experience", "trial-evidence-v2", "strategy", "policy", "trust", "decision"];
  for (const name of protectedNames) { await mkdir(join(base, name)); await writeFile(join(base, name, "sentinel"), name); }
  const packetPath = join(base, "evaluation-packets-v1", `${f.packet.id}.json`), before = await readFile(packetPath, "utf8");
  await f.store.publish(f.run); const running = transitionEvaluationRun(f.run, "running", start); await f.store.publish(running); await f.store.publish(transitionEvaluationRun(running, "completed", end));
  for (const name of protectedNames) { assert.deepEqual(await readdir(join(base, name)), ["sentinel"]); assert.equal(await readFile(join(base, name, "sentinel"), "utf8"), name); }
  assert.equal(await readFile(packetPath, "utf8"), before);
  // Module is standalone: no production imports and no execution/mutation capability dependency.
  const source = await readFile(new URL("../src/evaluation-run-store.ts", import.meta.url), "utf8");
  assert.ok(!/from ["'].*(?:experience|trial-evidence|strategy|policy|trust|decision|runtime|extension)/.test(source));
});
test("R4-C2 capacity rejects new attempts but preserves lifecycle completion and exact retries", async (t) => {
  const f = await fixture(t); await mkdir(f.dir, { recursive: true });
  await writeFile(join(f.dir, "unexpected.tmp"), "partial"); await assert.rejects(f.store.publish(f.run), /Malformed/); await rm(join(f.dir, "unexpected.tmp"));
  for (let i = 0; i < MAX_EVALUATION_RUNS_V1; i++) {
    const run = i === 0 ? f.run : { ...f.run, runId: randomUUID() };
    await writeFile(f.path(run), canonicalJson({ schemaVersion: 1, fingerprint: learningFingerprint(run), run }));
  }
  await assert.rejects(f.store.publish({ ...f.run, runId: randomUUID() }), /capacity/);
  await f.store.publish(f.run); const running = transitionEvaluationRun(f.run, "running", start);
  await f.store.publish(running); await f.store.publish(transitionEvaluationRun(running, "completed", end));
  assert.equal((await readdir(f.dir)).length, MAX_EVALUATION_RUNS_V1 + 2);
});
test("R4-C2 real process death at publication frontiers preserves attempt identity", async (t) => {
  const f = await fixture(t), input = join(f.root, "input.json"); await writeFile(input, canonicalJson({ run: f.run, packet: f.packet }));
  const module = new URL("../src/evaluation-run-store.ts", import.meta.url).href;
  for (const frontier of ["beforePublish", "afterPublish"]) {
    const script = `import { readFile } from 'node:fs/promises'; import { FileEvaluationRunStore } from ${JSON.stringify(module)};
      const {run,packet}=JSON.parse(await readFile(${JSON.stringify(input)},'utf8'));
      const store=new FileEvaluationRunStore({projectsBaseDir:${JSON.stringify(f.root)},packets:{get:async()=>packet},${frontier}:async()=>process.exit(0)});
      await store.publish(run);`;
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script]);
    if (frontier === "beforePublish") await assert.rejects(f.store.getCurrent(projectId, f.run.runId), /Missing/);
    else assert.deepEqual(await f.store.get(evaluationRunRef(f.run)), f.run);
    assert.deepEqual(await f.store.publish(f.run), f.run);
    if (frontier === "beforePublish") await rm(f.path(f.run));
  }
});
test("R4-C2 packet-only reads survive unavailable original evidence and detach before await", async (t) => {
  const f = await fixture(t);
  const fail = async () => { throw new Error("Original sources unavailable"); };
  const packets = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: { hypothesis: { readExact: fail }, evidence: { readExact: fail } } });
  const input = copy(f.run);
  const store = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets, beforePublish: async () => { input.evaluator.name = "mutated"; } });
  assert.deepEqual(await store.publish(input), f.run);
  assert.deepEqual(await store.getCurrent(projectId, f.run.runId), f.run);
});
