import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialOffers, type TrialOfferAuthority } from "../src/trial-offers.ts";
import { FileTrialOfferStore, MAX_RETAINED_TRIAL_OFFER_DECISIONS, validateTrialOfferReservation } from "../src/trial-offer-store.ts";
import { DEFAULT_TRIAL_OFFER_POLICY } from "../src/trial-offer-contract.ts";
import { getProjectId, FileGlobalWriterLock } from "../src/store.ts";
import { hypothesisFingerprint, learningArtifactFingerprint, type StrategyHypothesis } from "../src/learning-v1-contract.ts";

async function fixture(t: TestContext, options: { maxOffers?: number; barrier?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pindie-t1-ready-")), projectId = getProjectId(root), now = 1_800_000_000_000;
  const authority: TrialOfferAuthority = { projectId, workEpisodeId: randomUUID(), hostId: randomUUID(), sessionId: "real-session", authorityGeneration: 1 };
  const { workEpisodeId: _id, ...base } = authority;
  const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "check-first", kind: "approach" as const,
    lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check narrow facts first", useWhen: ["Local changes"], avoidWhen: [],
    expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed relevant checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const h: StrategyHypothesis = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  const store = new FileTrialOfferStore({ projectsBaseDir: root, onBeforeCommit: options.barrier });
  const policy = { ...DEFAULT_TRIAL_OFFER_POLICY, cooldownMs: 0, operationTimeoutMs: 1000, maxOffersPerHypothesis: options.maxOffers ?? 3 };
  const offers = new TrialOffers(store, { readOpen: async () => [h] }, policy, () => now);
  const instances = [offers];
  t.after(async () => { instances.forEach((i) => i.dispose()); await Promise.all(instances.map((i) => i.settled())); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, projectId, now, authority, base, h, store, offers, policy, instances };
}

test("T1 preflight publishes only a scheduling hold, then synchronously claims one real episode without disk readiness", async (t) => {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => { release = r; }), reached = new Promise<void>((r) => { entered = r; });
  let block = false;
  const f = await fixture(t, { barrier: async () => { if (block) { entered(); await barrier; } } });
  t.after(release);
  await f.offers.prepare(f.base, () => true);
  assert.equal(await f.store.find(f.projectId, f.authority.workEpisodeId), null);
  const slots = await readdir(join(f.root, f.projectId, "learning-v1", "trial-offers", "reservations"));
  assert.equal(slots.length, 1);
  block = true;
  const ready = f.offers.claim(f.authority);
  assert.ok(ready && !(ready instanceof Promise));
  assert.match(ready.content, /UNTRUSTED \/ EXPERIMENTAL \/ ADVISORY/);
  assert.equal(ready.commit.assignment?.workEpisodeId, f.authority.workEpisodeId);
  await reached; // Observation AFTER the synchronous claim, not a presentation-path wait.
  const { readFile } = await import("node:fs/promises");
  await assert.rejects(readFile(join(f.root, f.projectId, "learning-v1", "trial-offers", `${f.authority.workEpisodeId}.json`)), { code: "ENOENT" });
  release(); await f.offers.settled();
  assert.deepEqual(await f.store.find(f.projectId, f.authority.workEpisodeId), ready.commit);
  await f.offers.prepare(f.base, () => true);
  assert.equal(f.offers.claim(f.authority), null); // Even a refill cannot offer twice to the same episode.
});

test("T1 readiness at durable publication does not await unlock or re-publish a consumed hold", async (t) => {
  const f = await fixture(t);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((r) => { release = r; }), frontier = new Promise<void>((r) => { reached = r; });
  const writer = new FileGlobalWriterLock({ baseDir: f.root });
  let block = true;
  const store = new FileTrialOfferStore({ projectsBaseDir: f.root, lock: {
    withLock: (operation) => writer.withLock(async () => { const value = await operation(); if (block) { reached(); await held; } return value; }),
  } });
  const offers = new TrialOffers(store, { readOpen: async () => [f.h] }, f.policy, () => f.now);
  f.instances.push(offers);
  const preparation = offers.prepare(f.base, () => true);
  await frontier;
  try {
    const ready = offers.claim(f.authority); assert.ok(ready);
    block = false; release(); await preparation; await offers.settled();
    assert.deepEqual(await store.find(f.projectId, f.authority.workEpisodeId), ready.commit);
    assert.equal(offers.claim({ ...f.authority, workEpisodeId: randomUUID() }), null);
  } finally { block = false; release(); }
});

test("T1 preparation completing after an unready claim never retro-offers to that episode", async (t) => {
  const f = await fixture(t);
  const preparation = f.offers.prepare(f.base, () => true);
  assert.equal(f.offers.claim(f.authority), null);
  await preparation; await f.offers.settled();
  assert.equal(f.offers.claim(f.authority), null);
  assert.equal((await f.store.find(f.projectId, f.authority.workEpisodeId))?.receipt.outcome, "no-offer");
  assert.ok(f.offers.claim({ ...f.authority, workEpisodeId: randomUUID() }));
});

test("T1 concurrent preflight holds deterministically fence max-offer capacity across Hosts", async (t) => {
  const f = await fixture(t, { maxOffers: 1 });
  const other = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), { readOpen: async () => [f.h] }, f.policy, () => f.now);
  f.instances.push(other);
  const otherBase = { ...f.base, hostId: randomUUID() };
  await Promise.all([f.offers.prepare(f.base, () => true), other.prepare(otherBase, () => true)]);
  const claims = [f.offers.claim(f.authority), other.claim({ ...otherBase, workEpisodeId: randomUUID() })];
  assert.equal(claims.filter(Boolean).length, 1);
  await Promise.all(f.instances.map((i) => i.settled()));
  await f.offers.prepare(f.base, () => true);
  assert.equal(f.offers.claim({ ...f.authority, workEpisodeId: randomUUID() }), null);
});

test("T1 restart never restores an unbound preparation or manufactures an existing-episode assignment", async (t) => {
  const f = await fixture(t, { maxOffers: 1 });
  await f.offers.prepare(f.base, () => true);
  const reload = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), { readOpen: async () => [f.h] }, f.policy, () => f.now);
  f.instances.push(reload);
  await reload.prepare({ ...f.base, hostId: randomUUID() }, () => true);
  assert.equal(reload.claim(f.authority), null);
  await reload.settled();
  assert.equal((await f.store.find(f.projectId, f.authority.workEpisodeId))?.assignment, null);
});

test("T1 known unused holds are released on invalidation without charging a fabricated offer", async (t) => {
  const f = await fixture(t, { maxOffers: 1 });
  await f.offers.prepare(f.base, () => true);
  f.offers.dispose(); await f.offers.settled();
  const reload = new TrialOffers(f.store, { readOpen: async () => [f.h] }, f.policy, () => f.now);
  f.instances.push(reload);
  const base = { ...f.base, hostId: randomUUID() };
  await reload.prepare(base, () => true);
  assert.ok(reload.claim({ ...base, workEpisodeId: randomUUID() }));
});

test("T1 a live hold fences cooldown and the actual offer timestamp starts the committed cooldown", async (t) => {
  const f = await fixture(t);
  let now = f.now;
  const policy = { ...f.policy, cooldownMs: 100, leaseMs: 10_000, operationTimeoutMs: 1000 };
  const first = new TrialOffers(f.store, { readOpen: async () => [f.h] }, policy, () => now);
  const second = new TrialOffers(f.store, { readOpen: async () => [f.h] }, policy, () => now);
  f.instances.push(first, second);
  await first.prepare(f.base, () => true);
  now += 500; // Preparation timestamp is NOT the time this real Task was offered.
  const other = { ...f.base, hostId: randomUUID() };
  await second.prepare(other, () => true);
  assert.equal(second.claim({ ...other, workEpisodeId: randomUUID() }), null);
  const ready = first.claim(f.authority); assert.ok(ready);
  assert.equal(ready.commit.receipt.createdAt, now);
  await first.settled();
  await second.prepare(other, () => true);
  assert.equal(second.claim({ ...other, workEpisodeId: randomUUID() }), null);
  now += 1100; // Expired null-readiness is refreshed at a normal preflight opportunity, with no timer.
  await second.prepare(other, () => true);
  assert.ok(second.claim({ ...other, workEpisodeId: randomUUID() }));
});

test("T1 stale eligibility before reserve publication fails closed; a fresh Run cannot reopen the episode", async (t) => {
  let current = true;
  const f = await fixture(t, { barrier: async () => { current = false; } });
  await f.offers.prepare(f.base, () => current);
  assert.equal(f.offers.claim(f.authority), null);
  current = true;
  await f.offers.prepare(f.base, () => current);
  assert.equal(f.offers.claim(f.authority), null);
});

test("T1 finalization is intent-fenced when Human/eligibility authority is invalidated at atomic publication", async (t) => {
  let invalidate = false;
  const f = await fixture(t, { barrier: async () => { if (invalidate) f.offers.invalidateEligibility(); } });
  await f.offers.prepare(f.base, () => true);
  invalidate = true;
  const ready = f.offers.claim(f.authority); assert.ok(ready);
  await f.offers.settled();
  assert.equal(f.offers.isEligibilityCurrent(ready.epoch), false);
  assert.equal((await f.store.find(f.projectId, f.authority.workEpisodeId))?.receipt.reason, "interrupted");
  assert.equal(f.offers.claim(f.authority), null);
});

test("T1 monitor failure disables future readiness rather than silently using an unwatched snapshot", async (t) => {
  const f = await fixture(t);
  let notify!: (unavailable?: boolean) => void;
  const offers = new TrialOffers(f.store, { readOpen: async () => [f.h], observe: async (_id, invalidate) => { notify = invalidate; return () => {}; } }, f.policy, () => f.now);
  f.instances.push(offers);
  await offers.prepare(f.base, () => true);
  notify(true);
  await offers.prepare(f.base, () => true);
  assert.equal(offers.claim(f.authority), null);
});

test("T1 restart preflight repeatedly reclaims expired holds beyond retained capacity without dropping a live Host hold", async (t) => {
  const f = await fixture(t, { maxOffers: 1 });
  await f.offers.prepare(f.base, () => true);
  const directory = join(f.root, f.projectId, "learning-v1", "trial-offers", "reservations");
  const name = (await readdir(directory))[0]!;
  const live = JSON.parse(await readFile(join(directory, name), "utf8"));
  assert.ok(validateTrialOfferReservation(live));
  // Simulate abandoned Hosts, including more files than the former raw scan bound.
  for (const count of [MAX_RETAINED_TRIAL_OFFER_DECISIONS * 2 + 1, MAX_RETAINED_TRIAL_OFFER_DECISIONS + 1]) {
    await Promise.all(Array.from({ length: count }, async () => {
      const content = { ...live, id: randomUUID(), createdAt: f.now - 2, expiresAt: f.now - 1 };
      await writeFile(join(directory, `${content.id}.json`), JSON.stringify({ ...content, fingerprint: learningArtifactFingerprint(content) }));
    }));
    // Fresh store = restart; no original Host cache is needed for reconciliation.
    const reload = new FileTrialOfferStore({ projectsBaseDir: f.root });
    let selected = false;
    await reload.reserve(f.projectId, f.now, async (history, held) => {
      selected = true;
      assert.equal(history.length, 0);
      assert.deepEqual(held, [live]);
      return null;
    }, new AbortController().signal, () => true);
    assert.equal(selected, true);
    assert.deepEqual(await readdir(directory), [name]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, name), "utf8")), live);
  }
  // The surviving live hold still fences max-offer capacity across Hosts.
  const other = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: f.root }), { readOpen: async () => [f.h] }, f.policy, () => f.now);
  f.instances.push(other);
  const base = { ...f.base, hostId: randomUUID() };
  await other.prepare(base, () => true);
  assert.equal(other.claim({ ...base, workEpisodeId: randomUUID() }), null);
  assert.ok(f.offers.claim(f.authority));
});

test("T1 expiry boundary recovers crash hold capacity and cannot finalize the expired reservation", async (t) => {
  const f = await fixture(t, { maxOffers: 1 });
  await f.offers.prepare(f.base, () => true);
  const ready = f.offers.claim(f.authority); assert.ok(ready);
  await f.offers.settled();
  const directory = join(f.root, f.projectId, "learning-v1", "trial-offers", "reservations");
  const live = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
  // An unbound crash hold has no episode decision to preserve.
  const content = { ...live, id: randomUUID() };
  const abandoned = { ...content, fingerprint: learningArtifactFingerprint(content) };
  await writeFile(join(directory, `${abandoned.id}.json`), JSON.stringify(abandoned));
  const reload = new FileTrialOfferStore({ projectsBaseDir: f.root });
  await reload.reserve(f.projectId, live.expiresAt - 1, async (_history, held) => {
    assert.deepEqual(held, [abandoned]); return null;
  }, new AbortController().signal, () => true);
  await reload.reserve(f.projectId, live.expiresAt, async (history, held) => {
    assert.equal(history.length, 1); assert.equal(held.length, 0); return null;
  }, new AbortController().signal, () => true);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(await reload.find(f.projectId, f.authority.workEpisodeId), ready.commit);
  assert.deepEqual(await reload.commitReserved(ready.commit, new AbortController().signal), ready.commit);
  // A late claimant cannot resurrect the removed hold; its intent becomes no-offer.
  const authority = { ...f.authority, workEpisodeId: randomUUID() };
  const assignmentContent = { ...ready.commit.assignment!, id: abandoned.id, workEpisodeId: authority.workEpisodeId };
  const assignment = { ...assignmentContent, fingerprint: learningArtifactFingerprint(assignmentContent) };
  const { fingerprintOfferReceipt } = await import("../src/trial-offer-store.ts");
  const receipt = fingerprintOfferReceipt({ ...ready.commit.receipt, workEpisodeId: authority.workEpisodeId,
    assignment: { ...ready.commit.receipt.assignment!, id: assignment.id, fingerprint: assignment.fingerprint } });
  await assert.rejects(reload.commitReserved({ schemaVersion: 1, receipt, assignment }, new AbortController().signal), /scheduling hold/);
  assert.equal((await reload.find(f.projectId, authority.workEpisodeId))?.receipt.reason, "interrupted");
  assert.deepEqual(await reload.find(f.projectId, f.authority.workEpisodeId), ready.commit);
  const restarted = new TrialOffers(reload, { readOpen: async () => [f.h] }, { ...f.policy, maxOffersPerHypothesis: 2 }, () => live.expiresAt);
  f.instances.push(restarted);
  const base = { ...f.base, hostId: randomUUID() };
  await restarted.prepare(base, () => true);
  assert.ok(restarted.claim({ ...base, workEpisodeId: randomUUID() }));
});

test("T1 expired hold cleanup preserves exact offered/no-offer decisions, committed cooldown and max-offer accounting", async (t) => {
  const f = await fixture(t);
  let now = f.now;
  const policy = { ...f.policy, leaseMs: 1000, cooldownMs: 10_000, maxOffersPerHypothesis: 1 };
  const first = new TrialOffers(f.store, { readOpen: async () => [f.h] }, policy, () => now);
  f.instances.push(first);
  await first.prepare(f.base, () => true);
  const ready = first.claim(f.authority); assert.ok(ready);
  await first.settled();
  const noAuthority = { ...f.authority, workEpisodeId: randomUUID() };
  await first.prepare(f.base, () => true);
  assert.equal(first.claim(noAuthority), null);
  await first.settled();
  const no = await f.store.find(f.projectId, noAuthority.workEpisodeId); assert.ok(no);
  const directory = join(f.root, f.projectId, "learning-v1", "trial-offers");
  const decisions = await Promise.all([f.authority.workEpisodeId, noAuthority.workEpisodeId].flatMap((id) => [".json", ".pending.json"].map(async (suffix) => {
    const path = join(directory, `${id}${suffix}`); return { path, bytes: await readFile(path, "utf8") };
  })));
  const reloadStore = new FileTrialOfferStore({ projectsBaseDir: f.root });
  // Use a larger offer limit to isolate committed cooldown after hold expiry.
  const reload = new TrialOffers(reloadStore, { readOpen: async () => [f.h] }, { ...policy, maxOffersPerHypothesis: 2 }, () => now);
  f.instances.push(reload);
  now += policy.leaseMs;
  const base = { ...f.base, hostId: randomUUID() };
  await reload.prepare(base, () => true);
  assert.equal(reload.claim({ ...base, workEpisodeId: randomUUID() }), null);
  assert.deepEqual(await readdir(join(directory, "reservations")), []);
  await reload.settled();
  for (const { path, bytes } of decisions) assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await reloadStore.find(f.projectId, f.authority.workEpisodeId), ready.commit);
  assert.deepEqual(await reloadStore.find(f.projectId, noAuthority.workEpisodeId), no);
  assert.equal(first.claim(f.authority), null); // Cleanup never resets the runtime episode fuse.
  // Once cooldown ends, the original policy's max-offer count still excludes it.
  now = f.now + policy.cooldownMs;
  const limited = new TrialOffers(reloadStore, { readOpen: async () => [f.h] }, policy, () => now);
  f.instances.push(limited);
  await limited.prepare(base, () => true);
  assert.equal(limited.claim({ ...base, workEpisodeId: randomUUID() }), null);
  await reload.prepare(base, () => true);
  assert.ok(reload.claim({ ...base, workEpisodeId: randomUUID() }));
});

test("T1 malformed/capacity scheduling history fails closed without evicting durable dedupe or selecting", async (t) => {
  const f = await fixture(t);
  await f.offers.prepare(f.base, () => true);
  const directory = join(f.root, f.projectId, "learning-v1", "trial-offers", "reservations");
  const { readFile } = await import("node:fs/promises");
  const original = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), "utf8"));
  assert.ok(validateTrialOfferReservation(original));
  assert.equal(validateTrialOfferReservation({ ...original, workEpisodeId: randomUUID() }), false);
  await Promise.all(Array.from({ length: MAX_RETAINED_TRIAL_OFFER_DECISIONS - 1 }, async () => {
    const content = { ...original, id: randomUUID() };
    await writeFile(join(directory, `${content.id}.json`), JSON.stringify({ ...content, fingerprint: learningArtifactFingerprint(content) }));
  }));
  let selected = false;
  await assert.rejects(f.store.reserve(f.projectId, f.now, async () => { selected = true; return original; }, new AbortController().signal, () => true), /capacity/);
  assert.equal(selected, false);
  assert.equal((await readdir(directory)).length, MAX_RETAINED_TRIAL_OFFER_DECISIONS);
  await writeFile(join(directory, "malformed.json"), "{}");
  f.offers.invalidateEligibility();
  await f.offers.prepare(f.base, () => true);
  assert.equal(f.offers.claim(f.authority), null);
});
