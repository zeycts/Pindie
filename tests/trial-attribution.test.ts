import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrialOffers } from "../src/trial-offers.ts";
import { FileTrialOfferStore } from "../src/trial-offer-store.ts";
import { DEFAULT_TRIAL_OFFER_POLICY } from "../src/trial-offer-contract.ts";
import { hypothesisFingerprint, type StrategyHypothesis } from "../src/learning-v1-contract.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { RunIntegration } from "../src/run-integration.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { classifyToolEffect } from "../src/execution-semantics.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pindie-t2-holder-")), projectId = getProjectId(root);
  let now = 1_800_000_000_000;
  const authority = { projectId, workEpisodeId: randomUUID(), sessionId: "session", hostId: randomUUID(), authorityGeneration: 1 };
  const semantics = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "check-first", kind: "approach" as const,
    lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check narrow facts", useWhen: ["Local work"], avoidWhen: [],
    expectedEffect: "Fewer errors", failureSignals: ["Missed checks"], trialHints: [], sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }],
    discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const hypothesis: StrategyHypothesis = { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
  const offers = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir: root }), { readOpen: async () => [hypothesis] },
    { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1000 }, () => now);
  t.after(async () => { offers.dispose(); await offers.settled(); await rm(root, { recursive: true, force: true }); });
  const { workEpisodeId: _id, ...base } = authority;
  await offers.prepare(base, () => true);
  const claim = offers.claim(authority)!;
  assert.ok(claim);
  const run = new RunIntegration(new PindieRuntime(new FileStateStore({ baseDir: root })));
  run.beginAgentRunFacts();
  const holder = run.trialAttribution, tracker = run.experience;
  const binding = { sessionId: authority.sessionId, agentRunGeneration: 1, occurrenceEpoch: 1 };
  const resolve = () => offers.resolvePublished(claim);
  const declare = (decision: "select" | "decline", isCurrent = () => true) => holder.declare(claim.commit.assignment!.id, decision, resolve, isCurrent, () => tracker.execution, () => now);
  const settle = (isCurrent = () => true) => holder.settle(binding, resolve, isCurrent);
  return { run, holder, claim, tracker, binding, authority, resolve, declare, settle, now: () => now, setNow: (value: number) => { now = value; } };
}

test("offered but never rendered records nothing; restart cannot reconstruct selection", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.declare("select"), false);
  assert.equal(await f.settle(), null);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  assert.equal(await f.declare("select"), true);
  f.holder.reset();
  assert.equal(await f.declare("select"), false);
  assert.equal(await f.settle(), null);
});

test("one exact rendering; none, decline and duplicate declarations remain factual", async (t) => {
  const f = await fixture(t);
  assert.equal(f.holder.render(f.claim, f.binding, f.now(), 2), true);
  assert.equal(f.holder.render(f.claim, f.binding, f.now() + 1, 3), true);
  assert.equal((await f.settle())?.rendered.order, 2);
  assert.equal((await f.settle())?.declaration, "none");
  assert.equal(await f.declare("decline"), true);
  assert.equal(await f.declare("decline"), true);
  assert.equal(await f.declare("select"), false);
  f.holder.recordAuthorizedCall("work", classifyToolEffect("edit"));
  const facts = await f.settle();
  assert.equal(facts?.declaration, "decline");
  assert.equal(facts?.postSelection.toolCalls, 0);
  assert.ok(!JSON.stringify(facts).includes('"used"'));
});

test("only post-selection authorized call IDs contribute errors, including late results", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  const effect = classifyToolEffect("edit");
  f.tracker.recordAuthorizedCall("before", effect);
  f.holder.recordAuthorizedCall("before", effect);
  assert.equal(await f.declare("select"), true);
  f.holder.recordToolResult("before", true);
  f.holder.recordAuthorizedCall("after", effect);
  f.holder.recordAuthorizedCall("observation", classifyToolEffect("read"));
  f.holder.recordAuthorizedCall("verification", classifyToolEffect("pindie_verification_record"));
  f.holder.recordAuthorizedCall("policy", classifyToolEffect("pindie_policy_set"));
  f.holder.invalidate();
  f.holder.recordAuthorizedCall("too-late", effect);
  f.holder.recordToolResult("after", true);
  const facts = await f.settle();
  assert.equal(facts?.declarationFrontier?.toolCalls, 1);
  assert.deepEqual(facts?.postSelection, { toolCalls: 3, observations: 1, consequentialCalls: 2, projectMutationEffectCalls: 1,
    verificationCalls: 1, toolErrors: 1, deniedCalls: 0 });
  assert.equal(facts?.authorityCurrent, false);
  assert.equal(await f.declare("select"), false, "even duplicates require fresh authority");
});

test("awaited publication cannot cross preemption or a fresh Run", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  const declaration = f.holder.declare(f.claim.commit.assignment!.id, "select", async () => { await barrier; return f.resolve(); },
    () => true, () => f.tracker.execution, f.now);
  f.holder.invalidate();
  release();
  assert.equal(await declaration, false);
  assert.equal((await f.settle())?.declaration, "none");
  assert.equal(f.holder.render(f.claim, f.binding, f.now(), 1), false, "invalidated rendering cannot be restored");
  assert.equal(await f.holder.settle({ ...f.binding, agentRunGeneration: 2 }, f.resolve, () => true), null);
  const partial = await f.holder.settle({ ...f.binding, occurrenceEpoch: 2 }, f.resolve, () => false);
  assert.equal(partial?.rendered.occurrenceEpoch, 1, "replacement retains the original occurrence");
});

test("expiry, failed resolution, and fresh authority reject declarations", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  assert.equal(await f.declare("select", () => false), false);
  assert.equal(await f.holder.declare(f.claim.commit.assignment!.id, "select", async () => null, () => true, () => f.tracker.execution, f.now), false);
  f.setNow(f.claim.expiresAt);
  assert.equal(await f.declare("select"), false);
  assert.equal((await f.settle(() => false))?.authorityCurrent, false);
});

test("Run owns telemetry and clears rendering across authority reset and generation replacement", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  f.run.recordAuthorizedCall("before", classifyToolEffect("read"));
  assert.equal(await f.declare("select"), true);
  f.run.recordAuthorizedCall("after", classifyToolEffect("write"));
  f.run.recordToolResult("after", true);
  assert.equal((await f.settle())?.postSelection.toolErrors, 1);
  assert.equal(f.run.executionCounters.toolCalls, 2);
  f.run.markUnavailable("test authority loss");
  assert.equal(await f.declare("decline"), false);
  assert.equal((await f.settle())?.authorityCurrent, false);
  f.run.beginAgentRunFacts();
  assert.equal(await f.settle(), null);
  assert.equal(await f.declare("select"), false);
  assert.notEqual(f.run.activeAgentRunGeneration, f.binding.agentRunGeneration);
});

test("concurrent conflicting declarations cannot both commit", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  const results = await Promise.all([f.declare("select"), f.declare("decline")]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("failed publication preserves only an unconfirmed rendering; failed later lookup cannot erase accepted intent", async (t) => {
  const f = await fixture(t);
  f.holder.render(f.claim, f.binding, f.now(), 0);
  const unresolved = await f.holder.settle(f.binding, async () => null, () => true);
  assert.equal(unresolved?.publication, "unconfirmed");
  assert.equal(unresolved?.declaration, "none");
  assert.equal(unresolved?.delivery, "unknown");
  assert.equal(unresolved?.authorityCurrent, false);
  assert.equal(await f.declare("select"), true);
  const partial = await f.holder.settle(f.binding, async () => { throw new Error("support unavailable"); }, () => true);
  assert.equal(partial?.publication, "confirmed", "the accepted declaration already observed exact publication");
  assert.equal(partial?.declaration, "select");
  assert.equal(partial?.authorityCurrent, false);
  assert.equal(partial?.delivery, "unknown");
});
