import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, hypothesisFingerprint, learningArtifactFingerprint, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { hypothesisRef } from "../src/discovery-hypotheses.ts";
import { trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { buildEvaluationPacket, type EvaluationPacketReaders } from "../src/evaluation-packet-builder.ts";
import { evaluationPacketRef, type EvaluationPacket } from "../src/evaluation-contract.ts";
import { FileEvaluationPacketStore, MAX_EVALUATION_PACKETS_V1 } from "../src/evaluation-packet-store.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
const copy = <T>(v: T): T => JSON.parse(canonicalJson(v));
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "evaluation-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const semantic = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) }, id = randomUUID();
  const e: TrialEvidenceV2 = seal({ schemaVersion: 2 as const, id, projectId,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash }, hypothesis: hypothesisRef(h),
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: randomUUID(), recordedAt: "2026-01-01T00:00:00.000Z",
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] });
  const readers: EvaluationPacketReaders = { hypothesis: { readExact: async () => h }, evidence: { readExact: async () => e } };
  const packet = await buildEvaluationPacket({ hypothesis: hypothesisRef(h), trialEvidence: [trialEvidenceRef(e)] }, readers);
  const dir = join(root, projectId, "learning-v1", "evaluation-packets-v1"), path = join(dir, `${packet.id}.json`), ref = evaluationPacketRef(packet);
  const store = new FileEvaluationPacketStore({ projectsBaseDir: root, readers });
  return { root, h, e, readers, packet, dir, path, ref, store };
}
test("R4-C1 publish/get preserves exact deterministic packet, metadata, immutable values and retry timestamp", async (t) => {
  const f = await fixture(t), input = copy(f.packet);
  assert.equal(await f.store.exists(f.ref), false);
  const first = await f.store.publish(input), bytes = await readFile(f.path, "utf8"), metadata = await f.store.validate(f.ref);
  assert.deepEqual(first, f.packet); assert.equal(await f.store.exists(f.ref), true);
  assert.deepEqual(await f.store.get(f.ref), f.packet);
  assert.deepEqual(metadata.packetRef, f.ref); assert.equal(metadata.referencedEvidenceCount, 1);
  assert.equal(metadata.artifactSize, (await stat(f.path)).size); assert.equal(new Date(metadata.createdAt).toISOString(), metadata.createdAt);
  assert.ok(Object.isFrozen(first.hypothesisSnapshot.principles)); assert.ok(Object.isFrozen((await f.store.get(f.ref)).trials[0].snapshot.metrics));
  Object.assign(input.diversity, { workEpisodeCount: 999 }); assert.equal(first.diversity.workEpisodeCount, 1);
  await f.store.publish(f.packet); assert.equal(await readFile(f.path, "utf8"), bytes); assert.deepEqual(await f.store.validate(f.ref), metadata);
});
test("R4-C1 same identity with valid different content fails without overwrite", async (t) => {
  const f = await fixture(t); await f.store.publish(f.packet);
  const bytes = await readFile(f.path, "utf8");
  const different = seal({ ...f.packet, trials: [{ ...f.packet.trials[0], snapshot: seal({ ...f.e, metrics: { durationMs: 101, cost: null } }) }] });
  // Bind the changed snapshot to its new exact ref so this is a valid conflicting packet.
  const snapshot = different.trials[0].snapshot;
  const conflict = seal({ ...different, trials: [{ ...different.trials[0], ref: trialEvidenceRef(snapshot) }] });
  await assert.rejects(f.store.publish(conflict), /Conflicting/); assert.equal(await readFile(f.path, "utf8"), bytes);
});
test("R4-C1 missing exact lookup and validate throw; exists is false only for absence", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.get(f.ref), /Missing/); await assert.rejects(f.store.validate(f.ref), /Missing/);
  for (const ref of [{ ...f.ref, family: "evaluation-result" as const }, { ...f.ref, schemaVersion: 2 }, { ...f.ref, id: "../unsafe" }, { ...f.ref, scope: { kind: "project" as const, projectId: "../unsafe" } }]) {
    await assert.rejects(f.store.get(ref as typeof f.ref)); await assert.rejects(f.store.exists(ref as typeof f.ref));
  }
  await f.store.publish(f.packet);
  await assert.rejects(f.store.get({ ...f.ref, fingerprint: hash }), /Mismatched/);
  await assert.rejects(f.store.exists({ ...f.ref, fingerprint: hash }), /Mismatched/);
});
for (const mutation of ["json", "envelope-version", "packet-version", "fingerprint", "id", "project", "hypothesis", "evidence", "timestamp", "unknown", "oversize", "noncanonical"]) {
  test(`R4-C1 corrupted artifact fails closed: ${mutation}`, async (t) => {
    const f = await fixture(t); await f.store.publish(f.packet);
    const stored = JSON.parse(await readFile(f.path, "utf8"));
    if (mutation === "envelope-version") stored.schemaVersion = 2;
    if (mutation === "packet-version") stored.packet.schemaVersion = 2;
    if (mutation === "fingerprint") stored.packet.fingerprint = hash;
    if (mutation === "id") stored.packet.id = randomUUID();
    if (mutation === "project") stored.packet.scope.projectId = "c".repeat(64);
    if (mutation === "hypothesis") stored.packet.hypothesis.id = randomUUID();
    if (mutation === "evidence") stored.packet.trials[0].ref.id = randomUUID();
    if (mutation === "timestamp") stored.createdAt = "not-a-date";
    if (mutation === "unknown") stored.extra = true;
    // Rehash to ensure snapshot identity validation is independent of the outer digest.
    if (["id", "project", "hypothesis", "evidence", "packet-version"].includes(mutation)) stored.packet = seal(stored.packet);
    await writeFile(f.path, mutation === "json" ? "{" : mutation === "oversize" ? "x".repeat(132_000) : mutation === "noncanonical" ? JSON.stringify(stored, null, 2) : canonicalJson(stored));
    for (const read of [() => f.store.get(f.ref), () => f.store.exists(f.ref), () => f.store.validate(f.ref), () => f.store.publish(f.packet)]) await assert.rejects(read());
  });
}
test("R4-C1 immutable resolution rejects forged full snapshots, missing inputs and malformed batches", async (t) => {
  const f = await fixture(t);
  for (const readers of [
    { ...f.readers, hypothesis: { readExact: async () => ({ ...f.h, id: randomUUID() }) } },
    { ...f.readers, hypothesis: { readExact: async () => { throw new Error("missing hypothesis"); } } },
    { ...f.readers, evidence: { readExact: async () => null } },
    { ...f.readers, evidence: { readExact: async () => seal({ ...f.e, metrics: { cost: null, durationMs: 999 } }) } },
    { ...f.readers, evidence: { readExact: async () => f.e, readExactMany: async () => [] } },
  ]) {
    await assert.rejects(new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers }).publish(f.packet));
    assert.equal(await f.store.exists(f.ref), false);
  }
  await assert.rejects(f.store.publish({ ...f.packet, fingerprint: hash }));
});
test("R4-C1 batch resolution validates included and excluded exact snapshots", async (t) => {
  const f = await fixture(t), otherId = randomUUID(), otherHypothesis = { ...hypothesisRef(f.h), id: randomUUID() };
  const excluded = seal({ ...f.e, id: otherId, source: { ...f.e.source, recordId: `${otherId}.json` }, hypothesis: otherHypothesis,
    selection: { ...f.e.selection, revisionIdentity: otherHypothesis.id } });
  const all = [f.e, excluded]; let batches = 0;
  const readers: EvaluationPacketReaders = { ...f.readers, evidence: {
    readExact: async () => { throw new Error("unexpected single read"); },
    readExactMany: async (refs) => { batches++; return refs.map((r) => all.find((e) => e.id === r.id)!); },
  } };
  const packet = await buildEvaluationPacket({ hypothesis: hypothesisRef(f.h), trialEvidence: all.map(trialEvidenceRef) }, readers);
  batches = 0;
  const store = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers });
  await store.publish(packet); assert.equal(batches, 1);
  assert.equal((await store.validate(evaluationPacketRef(packet))).referencedEvidenceCount, 2);
  assert.equal(packet.trials.filter((t) => t.disposition === "excluded-hypothesis").length, 1);
  const bad = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: { ...readers, evidence: { ...readers.evidence,
    readExactMany: async (refs) => refs.map((r) => r.id === excluded.id ? null : f.e),
  } } });
  await assert.rejects(bad.publish(packet), /TrialEvidence/);
});
test("R4-C1 frozen lookup survives unavailable immutable sources; publication still revalidates sources", async (t) => {
  const f = await fixture(t); await f.store.publish(f.packet);
  const fail = async () => { throw new Error("source unavailable"); };
  const store = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: { hypothesis: { readExact: fail }, evidence: { readExact: fail } } });
  assert.deepEqual(await store.get(f.ref), f.packet); await assert.rejects(store.publish(f.packet), /unavailable/);
});
test("R4-C1 transaction barrier hides uncommitted artifact, freezes input, and rejects stale authority", async (t) => {
  const f = await fixture(t); let release!: () => void, entered!: () => void, current = true;
  const wait = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { entered = r; });
  const store = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: f.readers, beforePublish: async () => { entered(); await wait; } });
  const input = copy(f.packet), pending = store.publish(input, undefined, () => current); await ready;
  Object.assign(input, { id: randomUUID() }); assert.equal(await f.store.exists(f.ref), false);
  current = false; release(); await assert.rejects(pending, /Stale/); assert.deepEqual(await readdir(f.dir), []);
  assert.deepEqual(await f.store.publish(f.packet), f.packet);
});
test("R4-C1 interrupted writes and aborted publication leave no final invalid artifact", async (t) => {
  const f = await fixture(t), controller = new AbortController();
  for (const beforePublish of [async () => { throw new Error("interrupted"); }, async () => { controller.abort(); }]) {
    const store = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: f.readers, beforePublish });
    await assert.rejects(store.publish(f.packet, controller.signal)); assert.equal(await f.store.exists(f.ref), false); assert.deepEqual(await readdir(f.dir), []);
  }
  await assert.rejects(f.store.publish(f.packet, undefined, () => false), /Stale/);
});
test("R4-C1 concurrent identical writers converge; conflicting writers yield one commit and one rejection", async (t) => {
  const f = await fixture(t), other = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: f.readers });
  assert.deepEqual(await Promise.all([f.store.publish(f.packet), other.publish(f.packet)]), [f.packet, f.packet]);
  const second = seal({ ...f.packet, id: randomUUID() }), changed = seal({ ...second, trials: [{ ...second.trials[0], snapshot: seal({ ...f.e, metrics: { cost: null, durationMs: 101 } }) }] });
  const conflict = seal({ ...changed, trials: [{ ...changed.trials[0], ref: trialEvidenceRef(changed.trials[0].snapshot) }] });
  const conflictingStore = new FileEvaluationPacketStore({ projectsBaseDir: f.root, readers: { ...f.readers, evidence: { readExact: async () => conflict.trials[0].snapshot } } });
  const outcomes = await Promise.allSettled([f.store.publish(second), conflictingStore.publish(conflict)]);
  assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1); assert.equal(outcomes.filter((v) => v.status === "rejected").length, 1);
  const winner = outcomes.find((v) => v.status === "fulfilled")! as PromiseFulfilledResult<EvaluationPacket>;
  assert.deepEqual(await f.store.get(evaluationPacketRef(winner.value)), winner.value);
});
test("R4-C1 malformed/full namespace fails closed without pruning, exact retry at capacity succeeds", async (t) => {
  const f = await fixture(t); await mkdir(f.dir, { recursive: true }); await writeFile(join(f.dir, "unexpected.tmp"), "partial");
  await assert.rejects(f.store.publish(f.packet), /Malformed/); await rm(join(f.dir, "unexpected.tmp"));
  const base = { schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", packet: f.packet };
  // Real validated artifacts, not fake filenames, exercise the history capacity boundary.
  for (let i = 0; i < MAX_EVALUATION_PACKETS_V1; i++) {
    const packet = i === 0 ? f.packet : seal({ ...f.packet, id: randomUUID() });
    await writeFile(join(f.dir, `${packet.id}.json`), canonicalJson({ ...base, packet }));
  }
  await assert.rejects(f.store.publish(seal({ ...f.packet, id: randomUUID() })), /capacity/);
  await f.store.publish(f.packet); assert.equal((await readdir(f.dir)).length, MAX_EVALUATION_PACKETS_V1);
});
test("R4-C1 real process death before/after atomic frontier recovers with the same identity", async (t) => {
  const f = await fixture(t), input = join(f.root, "input.json"); await writeFile(input, canonicalJson(f.packet));
  const module = new URL("../src/evaluation-packet-store.ts", import.meta.url).href;
  for (const frontier of ["beforePublish", "afterPublish"]) {
    const script = `import { readFile } from 'node:fs/promises'; import { FileEvaluationPacketStore } from ${JSON.stringify(module)};
      const p = JSON.parse(await readFile(${JSON.stringify(input)}, 'utf8'));
      const s = new FileEvaluationPacketStore({projectsBaseDir:${JSON.stringify(f.root)}, readers:{hypothesis:{readExact:async()=>p.hypothesisSnapshot},evidence:{readExact:async()=>p.trials[0].snapshot}}, ${frontier}:async()=>process.exit(0)});
      await s.publish(p);`;
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script]);
    assert.equal(await f.store.exists(f.ref), frontier === "afterPublish");
    assert.deepEqual(await f.store.publish(f.packet), f.packet); // dead-owner lock reclamation + retry
    if (frontier === "beforePublish") await rm(f.path);
  }
});
