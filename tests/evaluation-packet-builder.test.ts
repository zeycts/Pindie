import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, hypothesisFingerprint, learningArtifactFingerprint, learningFingerprint, type StrategyHypothesisV2, type LearningArtifactRef } from "../src/learning-v1-contract.ts";
import { FileDiscoveryHypothesisStore, hypothesisRef } from "../src/discovery-hypotheses.ts";
import { FileTrialEvidenceV2Store, trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { validateEvaluationPacket, MAX_EVALUATION_PACKET_BYTES } from "../src/evaluation-contract.ts";
import { buildEvaluationPacket, immutableHypothesisReader, type EvaluationPacketReaders } from "../src/evaluation-packet-builder.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
function fixture(count = 3) {
  const semantic = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) }, episode = randomUUID();
  const evidence: TrialEvidenceV2[] = Array.from({ length: count }, () => { const id = randomUUID(); return seal({ schemaVersion: 2 as const, id, projectId,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash }, hypothesis: hypothesisRef(h),
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: episode, recordedAt: "2026-01-01T00:00:00.000Z",
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] }); });
  const calls: LearningArtifactRef[] = [];
  const readers: EvaluationPacketReaders = { hypothesis: { readExact: async () => h }, evidence: { readExact: async (ref) => { calls.push(ref); const found = evidence.find((e) => e.id === ref.id); if (!found) throw new Error("Missing evidence"); return found; } } };
  const input = () => ({ hypothesis: hypothesisRef(h), trialEvidence: evidence.map(trialEvidenceRef) });
  return { h, evidence, readers, input, calls };
}
test("R4-B deterministic identity, ordering, exact dedupe, immutable detached snapshots and observational counts", async () => {
  const f = fixture(), a = await buildEvaluationPacket(f.input(), f.readers);
  const b = await buildEvaluationPacket({ ...f.input(), trialEvidence: [...f.input().trialEvidence].reverse() }, f.readers);
  assert.deepEqual(a, b); assert.ok(validateEvaluationPacket(a)); assert.equal(a.diversity.workEpisodeCount, 1); assert.equal(a.diversity.projectCount, 1);
  assert.equal(a.comparisonStatus, "unavailable"); assert.deepEqual(a.trials.map((t) => t.handle), ["T1", "T2", "T3"]);
  assert.deepEqual(a, await buildEvaluationPacket({ ...f.input(), trialEvidence: [...f.input().trialEvidence, f.input().trialEvidence[0]] }, f.readers));
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.trials[0].snapshot.metrics)); assert.ok(Object.isFrozen(a.hypothesisSnapshot.principles));
  Object.assign(f.evidence[0].metrics, { cost: 999, durationMs: 1 });
  assert.equal(a.trials.find((t) => t.snapshot.id === f.evidence[0].id)!.snapshot.metrics.cost, null);
  assert.throws(() => { (a.trials as unknown[]).push({}); }, TypeError);
  const diverse = fixture(); diverse.evidence[1] = seal({ ...diverse.evidence[1], workEpisodeId: randomUUID() });
  assert.equal((await buildEvaluationPacket(diverse.input(), diverse.readers)).diversity.workEpisodeCount, 2);
});
test("R4-B exact target binding excludes different UUID or fingerprint, with included-first bounds", async () => {
  const f = fixture();
  for (const key of ["id", "fingerprint"] as const) {
    const different = { ...hypothesisRef(f.h), [key]: key === "id" ? randomUUID() : hash };
    f.evidence[1] = seal({ ...f.evidence[1], hypothesis: different, selection: { ...f.evidence[1].selection, revisionIdentity: different.id, revisionFingerprint: different.fingerprint } });
    const p = await buildEvaluationPacket(f.input(), f.readers);
    assert.equal(p.trials.find((t) => t.snapshot.id === f.evidence[1].id)!.disposition, "excluded-hypothesis");
    const bounded = await buildEvaluationPacket(f.input(), f.readers, { maxTrials: 1, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES });
    assert.equal(bounded.trials[0].disposition, "included"); assert.equal(f.calls.length >= 3, true);
  }
  await assert.rejects(buildEvaluationPacket({ ...f.input(), trialEvidence: [trialEvidenceRef(f.evidence[1])] }, f.readers), /support/);
});
test("R4-B fails closed on invalid refs, projects, duplicate identity conflicts and missing artifacts", async () => {
  const f = fixture(), input = f.input();
  for (const ref of [{ ...input.trialEvidence[0], family: "strategy-hypothesis" }, { ...input.trialEvidence[0], schemaVersion: 2 },
    { ...input.trialEvidence[0], scope: { kind: "project", projectId: "c".repeat(64) } }, { ...input.trialEvidence[0], fingerprint: "bad" },
    { ...input.trialEvidence[0], extra: true }]) await assert.rejects(buildEvaluationPacket({ ...input, trialEvidence: [ref as LearningArtifactRef] }, f.readers));
  await assert.rejects(buildEvaluationPacket({ ...input, trialEvidence: [input.trialEvidence[0], { ...input.trialEvidence[0], fingerprint: hash }] }, f.readers), /Conflicting/);
  await assert.rejects(buildEvaluationPacket({ ...input, trialEvidence: [{ ...input.trialEvidence[0], id: randomUUID() }] }, f.readers), /Missing/);
  await assert.rejects(buildEvaluationPacket({ ...input, hypothesis: { ...input.hypothesis, fingerprint: hash } }, f.readers), /hypothesis/);
  await assert.rejects(buildEvaluationPacket({ ...input, hypothesis: { ...input.hypothesis, scope: { kind: "user-global" } } }, f.readers));
  await assert.rejects(buildEvaluationPacket(input, { ...f.readers, hypothesis: { readExact: async () => null } }));
});
test("R4-B rejects corrupted/v1/oversized/unbound snapshots even outside the selected count", async () => {
  const f = fixture();
  for (const change of [{ schemaVersion: 1 }, { unexpected: true }, { fingerprint: hash }, { id: randomUUID() }, { huge: "x".repeat(16_385) }]) {
    const readers = { ...f.readers, evidence: { readExact: async () => ({ ...f.evidence[0], ...change }) } };
    await assert.rejects(buildEvaluationPacket(f.input(), readers));
  }
  const last = [...f.evidence].sort((a, b) => a.id < b.id ? -1 : 1).at(-1)!;
  await assert.rejects(buildEvaluationPacket(f.input(), { ...f.readers, evidence: { readExact: async (ref) => ref.id === last.id ? null : f.evidence.find((e) => e.id === ref.id) } },
    { maxTrials: 1, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES }));
});
test("R4-B count and byte selection bounded and deterministic; too-small budgets and invalid configs fail", async () => {
  const f = fixture(40), p = await buildEvaluationPacket(f.input(), f.readers);
  assert.equal(p.trials.length, 32); assert.equal(f.calls.length, 40);
  const one = await buildEvaluationPacket(f.input(), f.readers, { maxTrials: 1, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES });
  const bytes = Buffer.byteLength(canonicalJson(one));
  const bounded = await buildEvaluationPacket(f.input(), f.readers, { maxTrials: 32, maxPacketBytes: bytes });
  assert.equal(bounded.trials.length, 1); assert.ok(Buffer.byteLength(canonicalJson(bounded)) <= bytes);
  assert.deepEqual(bounded, await buildEvaluationPacket({ ...f.input(), trialEvidence: [...f.input().trialEvidence].reverse() }, f.readers, { maxTrials: 32, maxPacketBytes: bytes }));
  for (const config of [{ maxTrials: 33, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES }, { maxTrials: 0, maxPacketBytes: 1 },
    { maxTrials: 1, maxPacketBytes: MAX_EVALUATION_PACKET_BYTES + 1 }, { maxTrials: 1, maxPacketBytes: 1 },
    { maxTrials: 1.5, maxPacketBytes: 1 }, { maxTrials: 1, maxPacketBytes: 10000, unknown: true }]) await assert.rejects(buildEvaluationPacket(f.input(), f.readers, config));
  await assert.rejects(buildEvaluationPacket({ ...f.input(), trialEvidence: Array(4097).fill(f.input().trialEvidence[0]) }, f.readers));
});
test("R4-B default canonical byte ceiling fits whole snapshots without truncation", async () => {
  const f = fixture(32), { id: _id, fingerprint: _fingerprint, ...semantic } = f.h;
  const expanded = { ...semantic, useWhen: Array(8).fill("观察".repeat(128)), avoidWhen: Array(8).fill("限制".repeat(128)) };
  const h = { ...expanded, id: f.h.id, fingerprint: hypothesisFingerprint(expanded) };
  const comparison = Array.from({ length: 8 }, () => ({ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }));
  const evidence = f.evidence.map((e) => seal({ ...e, hypothesis: hypothesisRef(h), selection: { ...e.selection, revisionFingerprint: h.fingerprint }, comparison }));
  const readers = { hypothesis: { readExact: async () => h }, evidence: { readExact: async (ref: LearningArtifactRef) => evidence.find((e) => e.id === ref.id) } };
  const input = { hypothesis: hypothesisRef(h), trialEvidence: evidence.map(trialEvidenceRef) };
  const packet = await buildEvaluationPacket(input, readers);
  assert.ok(packet.trials.length > 0 && packet.trials.length < 32); assert.ok(Buffer.byteLength(canonicalJson(packet)) <= MAX_EVALUATION_PACKET_BYTES);
  assert.deepEqual(packet, await buildEvaluationPacket({ ...input, trialEvidence: [...input.trialEvidence].reverse() }, readers));
  for (const trial of packet.trials) assert.deepEqual(trial.snapshot, evidence.find((e) => e.id === trial.ref.id));
});
test("R4-B input capture and authority checks across asynchronous resolution", async () => {
  const f = fixture(), input = f.input(); let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { reached = r; });
  const readers = { ...f.readers, hypothesis: { readExact: async () => { reached(); await barrier; return f.h; } } };
  const building = buildEvaluationPacket(input, readers); await ready;
  input.trialEvidence.length = 0; release(); assert.equal((await building).trials.length, 3);
  let current = true;
  await assert.rejects(buildEvaluationPacket(f.input(), { ...f.readers, evidence: { readExact: async () => { current = false; return f.evidence[0]; } } }, undefined, { isCurrent: () => current }), /Stale/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(buildEvaluationPacket(f.input(), f.readers, undefined, { signal: controller.signal }));
  const during = new AbortController();
  await assert.rejects(buildEvaluationPacket(f.input(), { ...f.readers, hypothesis: { readExact: async () => { during.abort(); return f.h; } } }, undefined, { signal: during.signal }));
});
test("R4-B filesystem exact adapters resolve only immutable artifacts, without raw Experience or runtime state", async (t) => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), "r4b-builder-")); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, projectId, "learning-v1", "hypotheses"); await mkdir(dir, { recursive: true });
  const commit = { schemaVersion: 2, packetFingerprint: f.h.discoveryPacketFingerprint, outcome: "published", refs: [hypothesisRef(f.h)], newHypotheses: [f.h], modelIdentity: { provider: "faux", modelId: "discovery", thinkingLevel: "off" } };
  await writeFile(join(dir, `${hash.slice(7)}.json`), canonicalJson({ ...commit, fingerprint: learningFingerprint(commit) }));
  const evidence = new FileTrialEvidenceV2Store({ projectsBaseDir: root });
  f.evidence[0] = seal({ ...f.evidence[0], comparison: [f.evidence[0].source] });
  for (const e of f.evidence) await evidence.publish(e);
  const hypothesis = immutableHypothesisReader(new FileDiscoveryHypothesisStore({ projectsBaseDir: root }));
  const p = await buildEvaluationPacket(f.input(), { hypothesis, evidence }); assert.ok(validateEvaluationPacket(p));
  assert.equal(p.comparisonStatus, "unavailable"); // no Experience directory exists, all raw refs unresolved
  await assert.rejects(hypothesis.readExact({ ...hypothesisRef(f.h), id: randomUUID() }));
  await assert.rejects(hypothesis.readExact({ ...hypothesisRef(f.h), fingerprint: hash }));
  await assert.rejects(immutableHypothesisReader({ list: async () => [f.h, f.h] }).readExact(hypothesisRef(f.h)), /ambiguous/);
  const path = join(root, projectId, "learning-v1", "trial-evidence-v2", `${f.evidence[0].id}.json`);
  await writeFile(path, "null"); await assert.rejects(buildEvaluationPacket(f.input(), { hypothesis, evidence }));
});
