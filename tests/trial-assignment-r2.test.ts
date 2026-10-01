import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hypothesisFingerprint, learningArtifactFingerprint, type StrategyHypothesis, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { hypothesisRef } from "../src/discovery-hypotheses.ts";
import { D2OpenHypothesisReader } from "../src/open-hypotheses.ts";
import { trustedPortfolioFingerprint } from "../src/strategy-portfolio.ts";
import { DEFAULT_ASSIGNMENT_POLICY, FileTrialAssignmentStore, MAX_TRIAL_ASSIGNMENTS_V2, validateAssignmentPolicy, validateTrialAssignmentV2, type TrialAssignmentV2 } from "../src/trial-assignment-v2.ts";
import { OrdinaryTrialOverlay, type OrdinaryTrialBinding } from "../src/ordinary-trial-overlay.ts";
import { runBoundedOperation } from "../src/liveness.ts";

const projectId = "a".repeat(64), policy = { ...DEFAULT_ASSIGNMENT_POLICY, cooldownMs: 0, operationTimeoutMs: 1000 };
function hypothesis(logicalId = "check-first", kind: "approach" | "modifier" = "approach"): StrategyHypothesisV2 {
  const semantics = { schemaVersion: 2 as const, scope: { kind: "project" as const, projectId }, logicalId, kind, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check a bounded affected surface", useWhen: ["Local work"], avoidWhen: [], principles: ["Verify changed contracts"], expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed tests"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"b".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"c".repeat(64)}` };
  return { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
}
function reader(history: () => readonly StrategyHypothesis[]) {
  return new D2OpenHypothesisReader({ list: async () => history() }, { readProjectId: async () => ({ projectId, fingerprintVersion: 1, entries: [], resolvedEntries: [], fingerprint: trustedPortfolioFingerprint(projectId, []) }) });
}
function rehash<T extends StrategyHypothesis>(value: T): T { const { id: _id, fingerprint: _fp, ...semantic } = value; return { ...value, fingerprint: hypothesisFingerprint(semantic) }; }
const authority = (episode = randomUUID(), signal = new AbortController().signal) => ({ projectId, workEpisodeId: episode, signal, isCurrent: () => true });
const binding = (): OrdinaryTrialBinding => ({ projectId, workEpisodeId: randomUUID(), sessionId: "session", generation: 1, occurrenceEpoch: 1, externalStateEpoch: 0 });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function temp(t: Parameters<Parameters<typeof test>[1]>[0]) { const root = await mkdtemp(join(tmpdir(), "r2-assign-")); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test("R2 strict versioned scheduling binding rejects runtime fields, fingerprints and namespaces", async (t) => {
  const root = await temp(t), h = hypothesis(), store = new FileTrialAssignmentStore({ projectsBaseDir: root });
  const result = await store.assignIfAbsent(authority(), policy, reader(() => [h]), () => 1000);
  assert.equal(result.status, "created"); if (result.status === "none") return;
  const a = result.assignment;
  assert.ok(validateTrialAssignmentV2(a)); assert.equal(a.hypothesis.schemaVersion, 1); assert.deepEqual(a.comparison, []);
  for (const field of ["sessionId", "hostId", "generation", "expiresAt", "selected", "used", "status", "providerExposure"]) {
    const v = { ...a, [field]: true }; assert.equal(validateTrialAssignmentV2({ ...v, fingerprint: learningArtifactFingerprint(v) }), false);
  }
  assert.equal(validateTrialAssignmentV2({ ...a, schemaVersion: 1 }), false);
  assert.equal(validateTrialAssignmentV2({ ...a, fingerprint: `sha256:${"0".repeat(64)}` }), false);
  assert.equal(validateTrialAssignmentV2({ ...a, hypothesis: { ...a.hypothesis, scope: { kind: "project", projectId: "d".repeat(64) } } }), false);
  await assert.rejects(store.readExact({ ...a, id: randomUUID() }));
  for (const operationTimeoutMs of [0, -1, 1001, Infinity, 1.5]) assert.equal(validateAssignmentPolicy({ ...policy, operationTimeoutMs }), false);
});

test("R2 filesystem transaction dedupes same episode, enforces cross-episode limits and restart counts", async (t) => {
  const root = await temp(t), h = hypothesis(), open = reader(() => [h]), episode = randomUUID();
  const store = () => new FileTrialAssignmentStore({ projectsBaseDir: root });
  const same = await Promise.all(Array.from({ length: 6 }, () => store().assignIfAbsent(authority(episode), policy, open, () => 1000)));
  assert.equal(same.filter((r) => r.status === "created").length, 1);
  assert.equal(new Set(same.map((r) => r.status === "none" ? "none" : r.assignment.id)).size, 1);
  const different = await Promise.all(Array.from({ length: 6 }, () => store().assignIfAbsent(authority(), policy, open, () => 1000)));
  assert.equal(different.filter((r) => r.status === "created").length, 2);
  assert.equal((await store().assignIfAbsent(authority(), { ...policy, operationTimeoutMs: 999 }, open, () => 2000)).status, "none", "policy/restart never reset exact counts");
  assert.equal((await store().assignIfAbsent(authority(episode), policy, open, () => 2000)).status, "existing");
});

test("R2 committed cooldown and stable count/oldest/exact fairness", async (t) => {
  const root = await temp(t), h = hypothesis(), h2 = hypothesis("verify-next"), store = new FileTrialAssignmentStore({ projectsBaseDir: root });
  const open = reader(() => [h, h2]);
  const assigned: TrialAssignmentV2[] = [];
  for (let i = 0; i < 4; i++) { const r = await store.assignIfAbsent(authority(), policy, open, () => 1000 + i); assert.equal(r.status, "created"); if (r.status !== "none") assigned.push(r.assignment); }
  const sorted = [h, h2].sort((x, y) => x.fingerprint.localeCompare(y.fingerprint) || x.id.localeCompare(y.id));
  assert.deepEqual(assigned.map((a) => a.hypothesis.id), [sorted[0]!.id, sorted[1]!.id, sorted[0]!.id, sorted[1]!.id]);
  const r = await store.assignIfAbsent(authority(), { ...policy, cooldownMs: 100 }, open, () => 1005); assert.equal(r.status, "none");
  assert.equal((await store.assignIfAbsent(authority(), { ...policy, cooldownMs: 100 }, open, () => 1102)).status, "created");
});

test("R2 strict lineage: competing v1/v2, closed parent, orphan, changed base, cross-project", async (t) => {
  const root = await temp(t), h = hypothesis(), store = new FileTrialAssignmentStore({ projectsBaseDir: root });
  const { principles: _p, ...v1Content } = h;
  const v1 = { ...v1Content, schemaVersion: 1 as const, id: randomUUID(), sources: [{ ...h.sources[0]!, recordId: `${randomUUID()}.json` }] };
  const old = rehash(v1);
  assert.equal((await store.assignIfAbsent(authority(), policy, reader(() => [old, h]), Date.now)).status, "none");
  assert.equal((await store.assignIfAbsent(authority(), policy, reader(() => [old]), Date.now)).status, "none");
  const childContent = { ...h, lineage: "revise" as const, parent: hypothesisRef(old) };
  const child = rehash(childContent);
  const assigned = await store.assignIfAbsent(authority(), policy, reader(() => [old, child]), Date.now);
  assert.equal(assigned.status, "created"); if (assigned.status !== "none") assert.equal(assigned.assignment.hypothesis.id, child.id);
  await assert.rejects(store.assignIfAbsent(authority(), policy, reader(() => [child]), Date.now), /Unresolved/);
  const changedContent = { ...h, lineage: "revise" as const, baseRevisionFingerprint: `sha256:${"f".repeat(64)}` };
  const changed = rehash(changedContent);
  assert.equal((await store.assignIfAbsent(authority(), policy, reader(() => [changed]), Date.now)).status, "none");
  await assert.rejects(store.assignIfAbsent(authority(), policy, reader(() => [{ ...h, scope: { kind: "project", projectId: "d".repeat(64) } }]), Date.now));
});

test("R2 corrupt/full history fail closed without deletion", async (t) => {
  const root = await temp(t), store = new FileTrialAssignmentStore({ projectsBaseDir: root }), open = reader(() => [hypothesis()]);
  const dir = join(root, projectId, "learning-v1", "trial-assignments-v2"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${randomUUID()}.json`), "null");
  await assert.rejects(store.assignIfAbsent(authority(), policy, open, Date.now), /Corrupt/);
  await rm(dir, { recursive: true }); await mkdir(dir);
  await Promise.all(Array.from({ length: MAX_TRIAL_ASSIGNMENTS_V2 + 1 }, () => writeFile(join(dir, `${randomUUID()}.json`), "{}")));
  await assert.rejects(store.assignIfAbsent(authority(), policy, open, Date.now), /full/);
  assert.equal((await readdir(dir)).length, MAX_TRIAL_ASSIGNMENTS_V2 + 1);
  await rm(dir, { recursive: true });
  const first = await store.assignIfAbsent(authority(), policy, open, Date.now); assert.equal(first.status, "created"); if (first.status === "none") return;
  await Promise.all(Array.from({ length: MAX_TRIAL_ASSIGNMENTS_V2 - 1 }, async () => {
    const content = { ...first.assignment, id: randomUUID(), workEpisodeId: randomUUID() };
    const a = { ...content, fingerprint: learningArtifactFingerprint(content) };
    await writeFile(join(dir, `${a.workEpisodeId}.json`), JSON.stringify(a));
  }));
  // Capacity/dedupe are semantic facts, not a disk-speed benchmark. Keep the
  // scheduling clock fixed while reading 2048 files; deadline tests use real time.
  const at = Date.now();
  t.mock.method(Date, "now", () => at);
  await assert.rejects(store.assignIfAbsent(authority(), policy, open, Date.now), /capacity/);
  assert.equal((await store.assignIfAbsent(authority(first.assignment.workEpisodeId), policy, open, Date.now)).status, "existing");
});

for (const kind of ["approach", "modifier"] as const) test(`R2 one-shot advisory and exact ${kind} selector with fresh authority`, async (t) => {
  const root = await temp(t), h = hypothesis("check-first", kind); let history: readonly StrategyHypothesis[] = [h];
  const overlay = new OrdinaryTrialOverlay({ store: new FileTrialAssignmentStore({ projectsBaseDir: root }), reader: reader(() => history), policy });
  const b = binding(); let current: OrdinaryTrialBinding | null = b;
  await overlay.prepare(b, () => current);
  const text = overlay.render(current); assert.ok(text?.includes("UNTRUSTED / EXPERIMENTAL / ADVISORY")); assert.ok(text?.includes(h.id)); assert.ok(!text?.includes(h.expectedEffect));
  assert.equal(overlay.render(current), null);
  const selector = { strategyId: h.logicalId, revisionIdentity: h.id, revisionFingerprint: h.fingerprint };
  const selected = await overlay.resolve(selector, kind, () => current); assert.equal(selected?.revisionStatusAtRun, "trial");
  assert.deepEqual(selected?.semantics.principles, h.principles);
  for (const wrong of [{ ...selector, strategyId: "wrong-id" }, { ...selector, revisionFingerprint: `sha256:${"0".repeat(64)}` }]) await assert.rejects(overlay.resolve(wrong, kind, () => current));
  await assert.rejects(overlay.resolve(selector, kind === "approach" ? "modifier" : "approach", () => current));
  assert.equal(await overlay.resolve({ ...selector, revisionIdentity: randomUUID(), revisionFingerprint: `sha256:${"1".repeat(64)}` }, kind, () => current), null, "promoted resolver still gets unrelated exact revisions");
  history = []; await assert.rejects(overlay.resolve(selector, kind, () => current)); history = [h];
  current = { ...b, externalStateEpoch: 1 }; await assert.rejects(overlay.resolve(selector, kind, () => current));
  overlay.reset(); current = b; await overlay.prepare(b, () => current); assert.equal(overlay.render(current), null, "existing assignment never grants a new Run overlay");
});

for (const published of [false, true]) test(`R2 publication barrier: timeout ${published ? "after" : "before"} frontier cannot install late overlay`, async (t) => {
  const root = await temp(t), h = hypothesis(), reached = deferred(), release = deferred(), b = binding();
  const barrier = async () => { reached.resolve(); await release.promise; };
  const store = new FileTrialAssignmentStore({ projectsBaseDir: root, ...(published ? { afterPublish: barrier } : { beforePublish: barrier }) });
  const open = reader(() => [h]);
  const overlay = new OrdinaryTrialOverlay({ store, reader: open, policy: { ...policy, operationTimeoutMs: 50 } });
  const preparing = overlay.prepare(b, () => b);
  await reached.promise; await preparing; // Actual writer remains blocked while caller is already done.
  assert.equal(overlay.render(b), null);
  const competing = runBoundedOperation({ label: "competing writer", timeoutMs: 10, run: (signal) => new FileTrialAssignmentStore({ projectsBaseDir: root }).assignIfAbsent(authority(b.workEpisodeId, signal), policy, open, Date.now) });
  await assert.rejects(competing, /timed out/);
  release.resolve();
  // Wait for actual lock release without sleeps or releasing it on Promise.race.
  const replay = await new FileTrialAssignmentStore({ projectsBaseDir: root }).assignIfAbsent(authority(b.workEpisodeId), policy, open, Date.now);
  assert.equal(replay.status, published ? "existing" : "created");
  assert.equal(overlay.render(b), null);
  if (published && replay.status !== "none") assert.equal((await new FileTrialAssignmentStore({ projectsBaseDir: root }).readExact(replay.assignment)).id, replay.assignment.id);
});

test("R2 declaration refuses newly competing leaves, a closed parent and changed trusted base", async (t) => {
  const root = await temp(t), h = hypothesis(), b = binding(); let history: readonly StrategyHypothesis[] = [h];
  const strict = reader(() => history), store = new FileTrialAssignmentStore({ projectsBaseDir: root });
  const overlay = new OrdinaryTrialOverlay({ store, reader: strict, policy });
  await overlay.prepare(b, () => b); assert.ok(overlay.render(b));
  const selector = { strategyId: h.logicalId, revisionIdentity: h.id, revisionFingerprint: h.fingerprint };
  const { principles: _p, id: _id, fingerprint: _fp, ...oldSemantic } = h;
  const v1Semantic = { ...oldSemantic, schemaVersion: 1 as const, sources: [{ ...h.sources[0]!, recordId: `${randomUUID()}.json` }] };
  const competing = { ...v1Semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(v1Semantic) };
  history = [h, competing]; await assert.rejects(overlay.resolve(selector, "approach", () => b), /open\/current/);
  const child = rehash({ ...h, id: randomUUID(), lineage: "revise" as const, parent: hypothesisRef(h), principles: ["Revised verification rule"] });
  history = [h, child]; await assert.rejects(overlay.resolve(selector, "approach", () => b), /open\/current/);
  history = [h];
  // Reconstruct the same coherent trusted-base reader gate with an active base revision,
  // then change the base fingerprint after activation (not a cached projection).
  const base = `sha256:${"d".repeat(64)}`;
  const anchored = rehash({ ...h, id: randomUUID(), lineage: "revise" as const, parent: null, baseRevisionFingerprint: base });
  let currentBase = base;
  const baseId = randomUUID();
  const trustReader = new D2OpenHypothesisReader({ list: async () => [anchored] }, { readProjectId: async () => {
    const entries = [{ origin: "promoted-derived" as const, strategyId: anchored.logicalId, kind: anchored.kind,
      revisionIdentity: baseId, revisionFingerprint: currentBase }];
    return { projectId, fingerprintVersion: 1, entries, resolvedEntries: entries.map((manifest) => ({ manifest, semantics: { summary: anchored.summary, useWhen: anchored.useWhen, avoidWhen: anchored.avoidWhen, principles: anchored.principles } })), fingerprint: trustedPortfolioFingerprint(projectId, entries) };
  } });
  const next = { ...b, workEpisodeId: randomUUID() };
  const revisionOverlay = new OrdinaryTrialOverlay({ store, reader: trustReader, policy });
  await revisionOverlay.prepare(next, () => next); assert.ok(revisionOverlay.render(next));
  currentBase = `sha256:${"e".repeat(64)}`;
  await assert.rejects(revisionOverlay.resolve({ strategyId: anchored.logicalId, revisionIdentity: anchored.id, revisionFingerprint: anchored.fingerprint }, "approach", () => next), /open\/current/);
});

test("R2 concurrent cooldown blocks a second episode; new exact revision has its own count", async (t) => {
  const root = await temp(t), h = hypothesis(); let history: readonly StrategyHypothesis[] = [h];
  const open = reader(() => history), p = { ...policy, maxAssignmentsPerHypothesis: 1, cooldownMs: 1000 };
  const results = await Promise.all(Array.from({ length: 4 }, () => new FileTrialAssignmentStore({ projectsBaseDir: root }).assignIfAbsent(authority(), p, open, () => 1000)));
  assert.equal(results.filter((r) => r.status === "created").length, 1);
  const next = rehash({ ...h, id: randomUUID(), lineage: "revise" as const, parent: hypothesisRef(h), principles: ["Verify a revised bounded contract"] });
  history = [h, next];
  const revised = await new FileTrialAssignmentStore({ projectsBaseDir: root }).assignIfAbsent(authority(), p, open, () => 1001);
  assert.equal(revised.status, "created"); if (revised.status !== "none") assert.equal(revised.assignment.hypothesis.id, next.id);
});

test("R2 late candidate read, abort and invalidation never reactivate; selector checks again after await", async (t) => {
  const root = await temp(t), h = hypothesis(), b = binding(), reached = deferred(), release = deferred(); let block = true;
  const open = { readOpen: async () => { if (block) { reached.resolve(); await release.promise; } return [h]; } };
  const overlay = new OrdinaryTrialOverlay({ store: new FileTrialAssignmentStore({ projectsBaseDir: root }), reader: open, policy });
  const abort = new AbortController(); const p = overlay.prepare(b, () => b, abort.signal); await reached.promise; abort.abort(); await p; overlay.reset(); release.resolve(); block = false;
  await overlay.prepare(b, () => b); assert.ok(overlay.render(b));
  const secondReached = deferred(), secondRelease = deferred();
  open.readOpen = async () => { secondReached.resolve(); await secondRelease.promise; return [h]; };
  const selecting = overlay.resolve({ strategyId: h.logicalId, revisionIdentity: h.id, revisionFingerprint: h.fingerprint }, h.kind, () => b);
  await secondReached.promise; overlay.reset(); secondRelease.resolve(); await assert.rejects(selecting, /Stale/);
});
