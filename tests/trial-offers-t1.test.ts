import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTrialOfferStore, fingerprintOfferReceipt, validateTrialOfferCommit, MAX_RETAINED_TRIAL_OFFER_DECISIONS } from "../src/trial-offer-store.ts";
import { TrialOffers, experimentalTrialContext, selectTrialHypothesis, validTrialAssignment, type TrialOfferAuthority } from "../src/trial-offers.ts";
import { DEFAULT_TRIAL_OFFER_POLICY, trialOfferPolicyFingerprint, trialOperationalId, validateTrialOfferPolicy, validateTrialOfferReceipt } from "../src/trial-offer-contract.ts";
import { hypothesisFingerprint, learningArtifactFingerprint, validateTrialAssignment, type StrategyHypothesis } from "../src/learning-v1-contract.ts";
import { D2OpenHypothesisReader, validateOpenHypotheses } from "../src/open-hypotheses.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { FileWorkEpisodeLedger } from "../src/work-episode.ts";
import { FileRunExperienceReader } from "../src/experience-store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { FileDiscoveryHypothesisStore } from "../src/discovery-hypotheses.ts";
const ROOT = "/repo/t1", projectId = getProjectId(ROOT), now = 1_800_000_000_000;
const authority = (): TrialOfferAuthority => ({ projectId, workEpisodeId: randomUUID(), sessionId: "real-session", hostId: randomUUID(), authorityGeneration: 1 });
function hypothesis(logicalId = "bounded-focus"): StrategyHypothesis {
  const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId, kind: "approach" as const,
    lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check the smallest relevant surface first.",
    useWhen: ["The change is local"], avoidWhen: ["Ownership changes"], expectedEffect: "Fewer unrelated changes",
    failureSignals: ["Relevant regressions go undetected"], trialHints: ["Compare diff scope"],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  return { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
}
async function setup(t: TestContext, open: StrategyHypothesis[] = []) {
  const root = await mkdtemp(join(tmpdir(), "pindie-t1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileTrialOfferStore({ projectsBaseDir: root });
  const reader = { readOpen: async () => open };
  const policy = { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1000 as number, cooldownMs: 0 };
  const offers = new TrialOffers(store, reader, policy, () => now);
  return { root, store, reader, offers, policy, dir: join(root, projectId, "learning-v1", "trial-offers") };
}
test("T1 strict Human policy and canonical identity; no authority or classifier fields", () => {
  assert.ok(validateTrialOfferPolicy(DEFAULT_TRIAL_OFFER_POLICY));
  for (const invalid of [{ ...DEFAULT_TRIAL_OFFER_POLICY, semanticMatcher: true }, { ...DEFAULT_TRIAL_OFFER_POLICY, version: 2 }, { ...DEFAULT_TRIAL_OFFER_POLICY, maxOffersPerHypothesis: 0 }, { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1001 }]) assert.equal(validateTrialOfferPolicy(invalid), false);
  assert.equal(trialOfferPolicyFingerprint(DEFAULT_TRIAL_OFFER_POLICY), trialOfferPolicyFingerprint({ ...DEFAULT_TRIAL_OFFER_POLICY }));
});
test("T1 empty open projection commits terminal no-offer; new cognition cannot retroactively offer", async (t) => {
  const open: StrategyHypothesis[] = [], f = await setup(t, open), a = authority();
  const first = await f.offers.opened(a, () => true);
  assert.equal(first?.receipt.outcome, "no-offer");
  assert.equal(first?.receipt.reason, "no-open-hypothesis");
  assert.equal(await f.offers.context(a), null);
  open.push(hypothesis());
  assert.deepEqual(await f.offers.opened(a, () => true), first);
  assert.equal(await f.offers.context(a), null);
});
test("T1 one hypothesis yields exact immutable assignment and ONE bounded advisory block", async (t) => {
  const h = hypothesis(), f = await setup(t, [h]), a = authority();
  const first = await f.offers.opened(a, () => true);
  assert.ok(first?.assignment && validateTrialOfferCommit(first));
  assert.ok(validateTrialOfferReceipt(first.receipt));
  assert.ok(validateTrialAssignment(first.assignment));
  assert.equal(first.assignment.status, "untrusted-advisory");
  const block = await f.offers.context(a);
  assert.ok(block);
  assert.equal(block.content.match(/<PINDIE_EXPERIMENTAL_TRIAL>/g)?.length, 1);
  assert.ok(block.content.length < 10_000);
  for (const field of [h.id, h.fingerprint, h.summary, h.expectedEffect, h.failureSignals[0]!, first.assignment.id]) assert.ok(block.content.includes(field));
  assert.match(block.content, /UNTRUSTED \/ EXPERIMENTAL \/ ADVISORY/);
  assert.doesNotMatch(block.content, /discoveryPacketFingerprint|sources|comparison/);
  assert.deepEqual(await f.store.find(projectId, a.workEpisodeId), first);
  for (const field of ["capabilities", "goal", "taskStatus", "trusted", "permissions"]) assert.equal(field in first.assignment, false);
});
test("T1 deterministic least-offered rotation, stable fingerprint tie-break and max ONE", async (t) => {
  const open = [hypothesis("focus-a"), hypothesis("focus-b")], f = await setup(t, open);
  const winner = [...open].sort((a, b) => a.fingerprint < b.fingerprint ? -1 : 1)[0]!;
  assert.equal(selectTrialHypothesis(open, [], f.policy, now)?.id, winner.id);
  assert.equal(selectTrialHypothesis([...open].reverse(), [], f.policy, now)?.id, winner.id);
  const first = (await f.offers.opened(authority(), () => true))!;
  const second = (await f.offers.opened(authority(), () => true))!;
  assert.notEqual(first.assignment?.hypothesis.id, second.assignment?.hypothesis.id);
  assert.equal(first.assignment?.hypothesis.id, winner.id);
});
test("T1 cooldown and per-hypothesis attempt limits count offers, not claimed use", async (t) => {
  const h = hypothesis(), f = await setup(t, [h]), first = (await f.offers.opened(authority(), () => true))!;
  assert.equal(selectTrialHypothesis([h], [first], { ...f.policy, cooldownMs: 100 }, now), null);
  assert.equal(selectTrialHypothesis([h], [first], { ...f.policy, maxOffersPerHypothesis: 1 }, now + 1000), null);
  assert.equal(selectTrialHypothesis([h], [first], f.policy, now)?.id, h.id);
});
test("T1 same episode across Runs/reload/policy changes recovers EXACT decision without minting", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  const first = await f.offers.opened(a, () => true);
  const reload = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), f.reader, { ...f.policy, maxOffersPerHypothesis: 1 }, () => now + 1);
  assert.deepEqual(await reload.opened(a, () => true), first);
  assert.deepEqual(await reload.context(a), await f.offers.context(a));
  assert.equal((await readdir(f.dir)).filter((n) => !n.includes("pending")).length, 1);
});
test("T1 assignment and receipt atomically co-commit; crash after commit replays without selection", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  const first = (await f.offers.opened(a, () => true))!;
  // The only durable publication file contains BOTH: assignment-before-receipt is unrepresentable.
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, `${a.workEpisodeId}.json`), "utf8")), first);
  const reload = new FileTrialOfferStore({ projectsBaseDir: f.root });
  let selections = 0;
  const pending = JSON.parse(await readFile(join(f.dir, `${a.workEpisodeId}.pending.json`), "utf8"));
  assert.deepEqual(await reload.decide(pending, async () => { selections++; throw new Error("must not select"); }, new AbortController().signal), first);
  assert.equal(selections, 0);
});
test("T1 crash after durable intent BEFORE commit recovers terminal no-offer; never selects again", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority(), fp = trialOfferPolicyFingerprint(f.policy);
  const pending = fingerprintOfferReceipt({ schemaVersion: 1, id: trialOperationalId(a), projectId, workEpisodeId: a.workEpisodeId,
    offerPolicyVersion: 1, offerPolicyFingerprint: fp, createdAt: now, outcome: "no-offer", reason: "interrupted", assignment: null });
  await assert.rejects(f.store.decide(pending, async () => { throw new Error("crash"); }, new AbortController().signal), /crash/);
  const reload = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), f.reader, f.policy, () => now);
  assert.equal(await reload.context(a), null);
  const recovered = await reload.opened(a, () => true);
  assert.equal(recovered?.receipt.reason, "interrupted");
  assert.equal(recovered?.assignment, null);
});
test("T1 uncommitted current/pre-v1 episode never receives a retroactive decision through context restore", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  assert.equal(await f.offers.context(a), null);
  assert.equal(await f.store.find(projectId, a.workEpisodeId), null);
});
test("T1 authority/expiry replacement invalidates presentation, never reassigns same episode", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority(), first = await f.offers.opened(a, () => true);
  for (const changed of [{ ...a, hostId: randomUUID() }, { ...a, sessionId: "replacement" }, { ...a, authorityGeneration: 2 }, { ...a, projectId: "c".repeat(64) }, { ...a, workEpisodeId: randomUUID() }]) {
    assert.equal(await f.offers.context(changed), null);
  }
  const changed = { ...a, sessionId: "replacement" };
  assert.deepEqual(await f.offers.opened(changed, () => true), first);
  assert.equal(await f.offers.context(changed), null);
  assert.ok(first?.assignment);
  assert.equal(validTrialAssignment(first.assignment, a, first.assignment.expiresAt), false);
  assert.equal(validTrialAssignment(first.assignment, a, first.assignment.createdAt - 1), false);
});
test("T1 malformed projection/history/policy/store isolates offering from Human Task", async (t) => {
  const h = hypothesis(), f = await setup(t, [h]), a = authority();
  const malformed = new TrialOffers(f.store, { readOpen: async () => [{ ...h, fingerprint: "bad" }] }, f.policy, () => now);
  assert.equal((await malformed.opened(a, () => true))?.receipt.reason, "unavailable");
  const badPolicy = new TrialOffers(f.store, f.reader, { ...f.policy, version: 2 } as never, () => now);
  assert.equal(await badPolicy.opened(authority(), () => true), null);
  await writeFile(join(f.dir, "garbage.json"), "{}");
  assert.equal(await f.offers.opened(authority(), () => true), null);
  await writeFile(join(f.dir, `${a.workEpisodeId}.json`), "null");
  assert.equal(await f.offers.context(a), null);
});
test("T1 strict validators reject trust/authority fields, fingerprint drift and conflicting episode publication", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority(), c = (await f.offers.opened(a, () => true))!;
  assert.deepEqual(await f.store.publish(c), c);
  const r = fingerprintOfferReceipt({ ...c.receipt, outcome: "no-offer", reason: "unavailable", assignment: null });
  await assert.rejects(f.store.publish({ schemaVersion: 1, receipt: r, assignment: null }), /Conflicting/);
  assert.ok(c.assignment);
  assert.equal(validateTrialAssignment({ ...c.assignment, permissions: ["write"] }), false);
  assert.equal(validateTrialAssignment({ ...c.assignment, status: "trusted" }), false);
  assert.equal(validateTrialAssignment({ ...c.assignment, createdAt: 0 }), false);
  assert.equal(validateTrialOfferReceipt({ ...c.receipt, reasoning: "hidden" }), false);
  assert.equal(validateTrialOfferCommit({ ...c, assignment: { ...c.assignment, workEpisodeId: randomUUID(), fingerprint: learningArtifactFingerprint({ ...c.assignment, workEpisodeId: randomUUID() }) } }), false);
});
test("T1 timeout/unavailable projection is bounded and cannot later inject or publish an offer", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const offers = new TrialOffers(f.store, { readOpen: async () => { await held; return [hypothesis()]; } }, { ...f.policy, operationTimeoutMs: 25 }, () => now);
  assert.equal(await offers.opened(a, () => true), null);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.store.find(projectId, a.workEpisodeId))?.receipt.reason, "interrupted");
  assert.equal(await offers.context(a), null);
});
test("T1 D2-only open reader fails closed on ambiguous lineage; no legacy candidate reinterpretation", async () => {
  const h = hypothesis();
  assert.throws(() => validateOpenHypotheses([h, h], projectId), /ambiguous/);
  const reader = new D2OpenHypothesisReader({ list: async () => [h] });
  assert.deepEqual(await reader.readOpen(projectId), [h]);
  const conflict = hypothesis(h.logicalId);
  assert.equal(selectTrialHypothesis([h, conflict], [], DEFAULT_TRIAL_OFFER_POLICY, now), null);
  const candidate = { candidateId: randomUUID(), proposal: h };
  await assert.rejects(new D2OpenHypothesisReader({ list: async () => [candidate] as never }).readOpen(projectId), /Malformed/);
});
test("T1 real WorkEpisode boundary: replacement rotates; refine/progress/reload do NOT re-offer; reconciled episode untouched", async (t) => {
  const f = await setup(t, [hypothesis()]), stateStore = new FileStateStore({ baseDir: f.root });
  const ledger = new FileWorkEpisodeLedger({ projectsBaseDir: f.root, stateStore, experienceReader: new FileRunExperienceReader({ baseDir: f.root }) });
  const runtime = new PindieRuntime(stateStore, ledger), a = authority();
  let boundaries = 0;
  const observers: Promise<unknown>[] = [];
  runtime.onWorkEpisodeOpened = async (_root, id) => {
    boundaries++;
    const offer = f.offers.opened({ ...a, workEpisodeId: id }, () => true);
    observers.push(offer);
    await offer;
  };
  await runtime.load(ROOT);
  const start = { type: "start_task" as const, goal: "Real Human Task", constraints: [], successCriteria: ["done"] };
  await runtime.dispatch(start);
  const first = (await ledger.current(ROOT, runtime.state))!;
  await runtime.dispatch({ type: "refine_task", goal: "Refined Human goal" });
  await runtime.dispatch({ type: "set_open_loops", blockers: [], questions: [], nextIntent: "Continue" });
  await runtime.load(ROOT);
  assert.equal(await ledger.current(ROOT, runtime.state), first);
  assert.equal(boundaries, 1);
  await runtime.dispatch({ ...start, type: "replace_task", goal: "Another real Task" });
  const second = (await ledger.current(ROOT, runtime.state))!;
  assert.notEqual(second, first);
  assert.equal(boundaries, 2);
  await Promise.all(observers); // Test observation only: dispatch already returned independently.
  assert.ok((await f.store.find(projectId, second))?.assignment);
  assert.equal(await f.offers.context({ ...a, workEpisodeId: first === second ? first : second }, await f.store.find(projectId, first)), null);
  assert.ok(await f.offers.context({ ...a, workEpisodeId: second }));
});
test("T1 produces only offer operational artifacts: no TrialEvidence/jobs/model/reflection", async (t) => {
  const f = await setup(t, [hypothesis()]);
  await f.offers.opened(authority(), () => true);
  assert.deepEqual(await readdir(join(f.root, projectId, "learning-v1")), ["trial-offers"]);
  const source = await readFile(new URL("../src/trial-offers.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createAgentSession|\.prompt\(|\.enqueue\(|learningDisposition|TrialEvidence/);
  assert.equal(MAX_RETAINED_TRIAL_OFFER_DECISIONS, 2048);
  assert.equal(experimentalTrialContext({} as never, hypothesis()), null);
});
test("T1 timeout during final filesystem publication cannot commit a late offer", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const frontier = new Promise<void>((r) => { reached = r; });
  const store = new FileTrialOfferStore({ projectsBaseDir: f.root, onBeforeCommit: async () => { reached(); await barrier; } });
  const offers = new TrialOffers(store, f.reader, { ...f.policy, operationTimeoutMs: 200 }, () => now);
  const operation = offers.opened(a, () => true);
  await Promise.race([frontier, operation.then(() => { throw new Error("Did not reach commit barrier"); })]);
  assert.equal(await operation, null);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await store.find(projectId, a.workEpisodeId))?.receipt.reason, "interrupted");
  assert.equal(await offers.context(a), null);
});
test("T1 exact Session/project authority is revalidated at the final immutable commit frontier", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  let current = true;
  const store = new FileTrialOfferStore({ projectsBaseDir: f.root, onBeforeCommit: async () => { current = false; } });
  const offers = new TrialOffers(store, f.reader, f.policy, () => now);
  assert.equal(await offers.opened(a, () => current), null);
  assert.equal((await store.find(projectId, a.workEpisodeId))?.receipt.reason, "interrupted");
  assert.equal(await offers.context(a), null);
});

test("T1 two concurrent writers recover one assignment, even with different frozen authority/policy", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  const other = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), f.reader, { ...f.policy, maxOffersPerHypothesis: 1 }, () => now + 1);
  const [first, second] = await Promise.all([f.offers.opened(a, () => true), other.opened({ ...a, hostId: randomUUID() }, () => true)]);
  assert.ok(first?.assignment);
  assert.deepEqual(first, second);
  assert.equal((await readdir(f.dir)).filter((n) => !n.includes("pending")).length, 1);
});
test("T1 disabled/malformed Human policy omits existing advisory; lifecycle closure needs no hypothesis rewrite", async (t) => {
  const open = [hypothesis()], f = await setup(t, open), a = authority();
  const first = await f.offers.opened(a, () => true);
  assert.ok(await f.offers.context(a));
  assert.equal(await new TrialOffers(f.store, f.reader, { ...f.policy, enabled: false }).context(a), null);
  assert.equal(await new TrialOffers(f.store, f.reader, { ...f.policy, version: 2 } as never).context(a), null);
  open.length = 0; // Future lifecycle projection closes an immutable historical hypothesis.
  assert.equal(await f.offers.context(a), null);
  assert.deepEqual(await f.store.find(projectId, a.workEpisodeId), first);
});
test("T1 assignment/intent corruption and stale authority are presentation-isolated", async (t) => {
  const f = await setup(t, [hypothesis()]), a = authority();
  const first = (await f.offers.opened(a, () => true))!;
  assert.equal((await f.offers.opened(authority(), () => false))?.receipt.reason, "unavailable");
  await writeFile(join(f.dir, `${a.workEpisodeId}.json`), JSON.stringify({ ...first, assignment: { ...first.assignment, status: "trusted" } }));
  assert.equal(await f.offers.context(a), null);
  await writeFile(join(f.dir, `${a.workEpisodeId}.json`), JSON.stringify(first));
  await writeFile(join(f.dir, `${a.workEpisodeId}.pending.json`), "{}");
  assert.equal(await f.offers.context(a), null);
});
test("T1 open projection enforces current exact trusted-base facts and competing lineage integrity", async () => {
  const { createTrustedStrategyPortfolioForProjectId } = await import("../src/strategy-portfolio.ts");
  const { createPromotedStrategyRevisionCatalog } = await import("../src/strategy-decisions.ts");
  const trust = createTrustedStrategyPortfolioForProjectId(projectId, createPromotedStrategyRevisionCatalog([]));
  const h = hypothesis("direct-action"); // Explicit collision with a current trusted Seed.
  assert.deepEqual(await new D2OpenHypothesisReader({ list: async () => [h] }, { readProjectId: async () => trust }).readOpen(projectId), []);
  await assert.rejects(new D2OpenHypothesisReader({ list: async () => [hypothesis()] }, { readProjectId: async () => ({ ...trust, fingerprint: "bad" }) }).readOpen(projectId), /Incoherent/);
  const semantic = { ...h, lineage: "revise" as const, parent: null, baseRevisionFingerprint: `sha256:${"f".repeat(64)}` };
  const revision = { ...semantic, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(semantic)) };
  assert.deepEqual(await new D2OpenHypothesisReader({ list: async () => [revision] }, { readProjectId: async () => trust }).readOpen(projectId), []);
  const parent = hypothesis(), child = { ...parent, id: randomUUID(), lineage: "revise" as const, parent: { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope: parent.scope, id: parent.id, fingerprint: parent.fingerprint } };
  const childSemantic = (({ id: _id, fingerprint: _fp, ...rest }) => rest)(child);
  const validChild = { ...child, fingerprint: hypothesisFingerprint(childSemantic) };
  await assert.rejects(new D2OpenHypothesisReader({ list: async () => [validChild] }).readOpen(projectId), /Unresolved/);
  const both = await new D2OpenHypothesisReader({ list: async () => [parent, validChild] }).readOpen(projectId);
  assert.equal(selectTrialHypothesis(both, [], DEFAULT_TRIAL_OFFER_POLICY, now), null);
});

test("T1 actual malformed D2 store fails closed without interpreting partial history", async (t) => {
  const f = await setup(t), store = new FileDiscoveryHypothesisStore({ projectsBaseDir: f.root });
  const { mkdir } = await import("node:fs/promises");
  const dir = join(f.root, projectId, "learning-v1", "hypotheses");
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${"a".repeat(64)}.json`), "{}");
  const offers = new TrialOffers(f.store, new D2OpenHypothesisReader(store), f.policy, () => now);
  assert.equal((await offers.opened(authority(), () => true))?.receipt.reason, "unavailable");
});
