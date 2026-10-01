import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hypothesisFingerprint, validateStrategyHypothesis, isExecutableStrategyHypothesis, matchesLearningArtifactRef,
  type StrategyHypothesisV1, type StrategyHypothesisV2, type StrategyHypothesisSemantics } from "../src/learning-v1-contract.ts";
import { hypothesisRef } from "../src/discovery-hypotheses.ts";
import { hypothesisLeaves } from "../src/hypothesis-lineage.ts";
import { nonconflictingOpenHypotheses } from "../src/open-hypotheses.ts";
import { discoveryOpenEntry } from "../src/discovery-contract.ts";
import { createStrategyRevisionSelection } from "../src/policy.ts";
const projectId = "a".repeat(64), fp = `sha256:${"b".repeat(64)}`;
function v1(): StrategyHypothesisV1 {
  const semantics = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "check-first", kind: "approach" as const,
    lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check narrow evidence first", useWhen: ["Local change"], avoidWhen: [],
    expectedEffect: "Fewer regressions", failureSignals: ["More regressions"], trialHints: ["Search comparable Tasks"],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: fp }], discoveryPacketFingerprint: fp };
  return { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
}
function seal<T extends StrategyHypothesisSemantics>(semantics: T) {
  return { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
}
function v2(): StrategyHypothesisV2 {
  const { id: _id, fingerprint: _fp, ...semantics } = v1();
  return seal({ ...semantics, schemaVersion: 2, principles: ["Check the smallest relevant evidence before editing"] });
}
test("R1 v2 exact bounded principles, semantic identity and exact ref resolution", () => {
  const h = v2();
  assert.ok(validateStrategyHypothesis(h)); assert.ok(isExecutableStrategyHypothesis(h));
  const old = v1(); assert.ok(validateStrategyHypothesis(old)); assert.equal(isExecutableStrategyHypothesis(old), false);
  assert.ok(matchesLearningArtifactRef(hypothesisRef(old), old)); assert.ok(matchesLearningArtifactRef(hypothesisRef(h), h));
  assert.equal(matchesLearningArtifactRef({ ...hypothesisRef(h), fingerprint: fp }, h), false);
  const { principles: _principles, ...missing } = h;
  assert.equal(validateStrategyHypothesis(missing), false);
  for (const principles of [[], [""], [" "], ["x".repeat(257)], Array(9).fill("p")]) {
    const { id: _id, fingerprint: _fp, ...content } = h;
    assert.equal(validateStrategyHypothesis(seal({ ...content, principles })), false);
  }
  const { id: _id, fingerprint: _fp, ...content } = h;
  const changed = seal({ ...content, principles: ["A different rule"] });
  assert.notEqual(changed.fingerprint, h.fingerprint);
  assert.equal(seal({ ...content, discoveryPacketFingerprint: `sha256:${"c".repeat(64)}` }).fingerprint, h.fingerprint);
  assert.equal(validateStrategyHypothesis({ ...h, capability: "grant" }), false);
  assert.equal(discoveryOpenEntry(old).principles, null);
  assert.equal(discoveryOpenEntry(old).hypothesisSchemaVersion, 1);
  assert.deepEqual(discoveryOpenEntry(h).principles, h.principles);
  assert.equal(discoveryOpenEntry(h).hypothesisSchemaVersion, 2);
});
test("R1 pure executable compatibility with existing trial StrategyRevisionSelection, no activation", () => {
  const h = v2();
  const selection = createStrategyRevisionSelection({ strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id,
    revisionFingerprint: h.fingerprint, revisionStatusAtRun: "trial",
    semantics: { summary: h.summary, useWhen: h.useWhen, avoidWhen: h.avoidWhen, principles: h.principles } });
  assert.equal(selection.revisionStatusAtRun, "trial"); assert.deepEqual(selection.principles, h.principles);
  assert.ok(Object.isFrozen(selection));
});
test("R1 exact v1/v1/v2 chains project one leaf; forks remain competing; malformed lineage fails closed", () => {
  const a = v1();
  const { id: _a, fingerprint: _fp, ...content } = a;
  const b = seal({ ...content, lineage: "revise" as const, parent: hypothesisRef(a) });
  const { id: _b, fingerprint: _bfp, ...bContent } = b;
  const c = seal({ ...bContent, schemaVersion: 2 as const, parent: hypothesisRef(b), principles: ["Check facts first"] });
  assert.deepEqual(hypothesisLeaves([c, a, b], projectId), [c]);
  assert.deepEqual(hypothesisLeaves([a, b], projectId), [b]);
  const fork = seal({ ...bContent, parent: hypothesisRef(a), summary: "Competing direction" });
  assert.equal(hypothesisLeaves([a, b, fork], projectId).length, 2);
  assert.deepEqual(nonconflictingOpenHypotheses(hypothesisLeaves([a, b, fork], projectId)), []);
  assert.deepEqual(nonconflictingOpenHypotheses(hypothesisLeaves([a, v1()], projectId)), []);
  assert.throws(() => hypothesisLeaves([b], projectId), /Unresolved/);
  for (const change of [{ logicalId: "wrong" }, { kind: "modifier" as const }, { baseRevisionFingerprint: fp },
    { parent: { ...hypothesisRef(a), fingerprint: `sha256:${"c".repeat(64)}` } }]) {
    assert.throws(() => hypothesisLeaves([a, seal({ ...bContent, ...change })], projectId), /Unresolved/);
  }
  // A forged cyclic history cannot satisfy exact canonical fingerprints either; fail closed, never emit leaves.
  const x = { ...a, lineage: "revise" as const, parent: hypothesisRef(b) };
  assert.throws(() => hypothesisLeaves([x, b], projectId));
});
