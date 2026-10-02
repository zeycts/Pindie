import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, learningFingerprint } from "../src/learning-v1-contract.ts";
import { createExecutionLease, heartbeatExecutionLease } from "../src/evaluation-execution-lease.ts";
import { transitionEvaluationRun, type EvaluationRunV1 } from "../src/evaluation-run.ts";
import { assessExecutionLeaseFreshness, assessExecutionLeaseWithClock, validateExecutionLeaseClockSample, validateExecutionLeaseStalePolicy,
  type ExecutionLeaseClockSampleV1, type ExecutionLeaseStalePolicyV1 } from "../src/evaluation-execution-lease-assessment.ts";

const at = "2026-10-02T00:00:00.000Z";
const created: EvaluationRunV1 = { schemaVersion: 1, runId: "11111111-1111-4111-8111-111111111111",
  packetRef: { schemaVersion: 1, family: "evaluation-packet", scope: { kind: "project", projectId: "a".repeat(64) },
    id: "22222222-2222-4222-8222-222222222222", fingerprint: `sha256:${"b".repeat(64)}` },
  packetFingerprint: `sha256:${"b".repeat(64)}`, evaluator: { name: "fixture", version: "1" }, status: "created", createdAt: at };
const running = transitionEvaluationRun(created, "running", at);
const lease = createExecutionLease(running, "worker-1");
const policy: ExecutionLeaseStalePolicyV1 = { schemaVersion: 1, staleAfterMs: 1000, maxClockUncertaintyMs: 100 };
function sample(age: number, uncertaintyMs = 0): ExecutionLeaseClockSampleV1 {
  return { schemaVersion: 1, observedAt: new Date(Date.parse(at) + age).toISOString(), comparison: { kind: "bounded", uncertaintyMs } };
}

test("C4 freshness threshold is strict and uncertainty conservatively delays candidacy", () => {
  for (const [age, uncertainty, state, minimumAge] of [
    [0, 0, "ACTIVE", 0], [999, 0, "ACTIVE", 999], [1000, 0, "ACTIVE", 1000], [1001, 0, "STALE_CANDIDATE", 1001],
    [1001, 100, "ACTIVE", 901], [1100, 100, "ACTIVE", 1000], [1101, 100, "STALE_CANDIDATE", 1001],
  ] as const) {
    const result = assessExecutionLeaseFreshness(lease, policy, sample(age, uncertainty));
    assert.equal(result.state, state); assert.equal(result.minimumAgeMs, minimumAge);
    assert.equal(result.reason, state === "ACTIVE" ? "within-threshold" : "beyond-threshold");
    assert.equal(result.leaseFingerprint, learningFingerprint(lease));
  }
});

test("C4 same input clock and policy serialize deterministically without reading system time", () => {
  const clock = { now: () => sample(1001) };
  const first = assessExecutionLeaseWithClock(lease, policy, clock), second = assessExecutionLeaseWithClock(lease, policy, clock);
  assert.deepEqual(first, second); assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first, assessExecutionLeaseFreshness(lease, policy, sample(1001)));
  const reordered = { maxClockUncertaintyMs: 100, staleAfterMs: 1000, schemaVersion: 1 };
  assert.equal(canonicalJson(first), canonicalJson(assessExecutionLeaseFreshness(lease, reordered, sample(1001))));
});

test("C4 clock uncertainty and future metadata fail closed without clamping timestamps", () => {
  assert.equal(assessExecutionLeaseFreshness(lease, policy, sample(-1)).reason, "future-heartbeat");
  const tolerated = assessExecutionLeaseFreshness(lease, policy, sample(-100, 100));
  assert.equal(tolerated.state, "ACTIVE"); assert.equal(tolerated.minimumAgeMs, -200);
  assert.equal(assessExecutionLeaseFreshness(lease, policy, sample(-101, 100)).reason, "future-heartbeat");
  assert.equal(assessExecutionLeaseFreshness(lease, policy, sample(100000, 101)).reason, "unsupported-clock-uncertainty");
  const untrusted = { schemaVersion: 1, observedAt: sample(100000).observedAt, comparison: { kind: "untrusted" } };
  assert.equal(assessExecutionLeaseFreshness(lease, policy, untrusted).state, "UNKNOWN");
  assert.equal(assessExecutionLeaseFreshness(lease, policy, untrusted).reason, "untrusted-clock");
});

test("C4 malformed policy and clock values reject unknown fields and unsupported versions", () => {
  for (const p of [null, [], {}, { ...policy, schemaVersion: 2 }, { ...policy, staleAfterMs: 0 }, { ...policy, staleAfterMs: -1 },
    { ...policy, staleAfterMs: 0.5 }, { ...policy, staleAfterMs: NaN }, { ...policy, staleAfterMs: Infinity },
    { ...policy, maxClockUncertaintyMs: -1 }, { ...policy, maxClockUncertaintyMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...policy, retry: () => {} }]) {
    assert.equal(validateExecutionLeaseStalePolicy(p), false);
    const result = assessExecutionLeaseFreshness(lease, p, sample(100000));
    assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "invalid-policy");
  }
  assert.ok(validateExecutionLeaseStalePolicy({ ...policy, maxClockUncertaintyMs: 0 }));
  for (const c of [null, [], {}, { ...sample(0), schemaVersion: 2 }, { ...sample(0), observedAt: "invalid" },
    { ...sample(0), observedAt: "2026-10-02T00:00:00Z" }, { ...sample(0), evaluate: () => {} },
    { ...sample(0), comparison: { kind: "bounded" } }, { ...sample(0), comparison: { kind: "bounded", uncertaintyMs: -1 } },
    { ...sample(0), comparison: { kind: "bounded", uncertaintyMs: 0.5 } },
    { ...sample(0), comparison: { kind: "untrusted", uncertaintyMs: 0 } }]) {
    assert.equal(validateExecutionLeaseClockSample(c), false);
    const result = assessExecutionLeaseFreshness(lease, policy, c);
    assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "invalid-clock");
  }
});

test("C4 missing or invalid lease is unknown rather than expired or confirmed", () => {
  for (const l of [null, undefined, {}, { ...lease, ownerId: "" }, { ...lease, heartbeatAt: "invalid" }, { ...lease, state: "STALE_CONFIRMED" }]) {
    const result = assessExecutionLeaseFreshness(l, policy, sample(100000));
    assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "invalid-lease");
    assert.equal(result.lease, null); assert.equal(result.leaseFingerprint, null);
  }
});
test("C4 detachment revalidates metadata that changes during property reads", () => {
  let clockReads = 0, policyReads = 0, ownerReads = 0;
  const changingClock = { ...sample(1000), comparison: { kind: "bounded", get uncertaintyMs() { return clockReads++ === 0 ? 0 : -1; } } };
  const changingPolicy = { ...policy, get staleAfterMs() { return policyReads++ < 2 ? 1000 : 0; } };
  const changingLease = { ...lease, get ownerId() { return ownerReads++ < 3 ? "worker-1" : ""; } };
  const badClock = assessExecutionLeaseFreshness(lease, policy, changingClock);
  assert.equal(badClock.reason, "invalid-clock"); assert.equal(badClock.clock, null);
  const badPolicy = assessExecutionLeaseFreshness(lease, changingPolicy, sample(1001));
  assert.equal(badPolicy.reason, "invalid-policy"); assert.equal(badPolicy.policy, null);
  const badLease = assessExecutionLeaseFreshness(changingLease, policy, sample(1001));
  assert.equal(badLease.reason, "invalid-lease"); assert.equal(badLease.lease, null);
});

test("C4 unsafe date arithmetic cannot declare a stale candidate", () => {
  const old = { ...lease, acquiredAt: "-271821-04-20T00:00:00.000Z", heartbeatAt: "-271821-04-20T00:00:00.000Z" };
  const result = assessExecutionLeaseFreshness(old, policy, { ...sample(0), observedAt: "+275760-09-13T00:00:00.000Z" });
  assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "unsafe-age");
});

test("C4 heartbeat advancement is reassessed from metadata without sticky stale state", () => {
  assert.equal(assessExecutionLeaseFreshness(lease, policy, sample(1001)).state, "STALE_CANDIDATE");
  const fresh = heartbeatExecutionLease(lease, sample(1001).observedAt);
  assert.equal(assessExecutionLeaseFreshness(fresh, policy, sample(1001)).state, "ACTIVE");
  assert.equal(fresh.ownerId, lease.ownerId); assert.equal(fresh.acquiredAt, lease.acquiredAt);
});

test("C4 injected clock samples once, does not sample invalid inputs, and contains clock errors", () => {
  let calls = 0;
  const clock = { now: () => { calls++; return sample(1001); } };
  assert.equal(assessExecutionLeaseWithClock(lease, policy, clock).state, "STALE_CANDIDATE"); assert.equal(calls, 1);
  assessExecutionLeaseWithClock(null, policy, clock); assessExecutionLeaseWithClock(lease, {}, clock); assert.equal(calls, 1);
  const result = assessExecutionLeaseWithClock(lease, policy, { now: () => { throw new Error("private clock error"); } });
  assert.equal(result.state, "UNKNOWN"); assert.equal(result.reason, "invalid-clock");
  assert.equal(canonicalJson(result).includes("private clock error"), false);
});

test("C4 assessment is detached, frozen and cannot modify lease/run identity or lifecycle", () => {
  const inputLease = { ...lease }, inputPolicy = { ...policy }, inputClock = sample(1001);
  const before = canonicalJson({ running, lease: inputLease, policy: inputPolicy, clock: inputClock });
  const result = assessExecutionLeaseFreshness(inputLease, inputPolicy, inputClock);
  assert.equal(canonicalJson({ running, lease: inputLease, policy: inputPolicy, clock: inputClock }), before);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.lease)); assert.ok(Object.isFrozen(result.policy));
  assert.ok(Object.isFrozen(result.clock?.comparison));
  assert.equal(Object.isFrozen(inputPolicy), false); assert.notEqual(result.lease, inputLease);
  inputLease.ownerId = "changed"; inputPolicy.staleAfterMs = 1;
  assert.equal(result.lease?.ownerId, "worker-1"); assert.equal(result.policy?.staleAfterMs, 1000);
  const mutableLease = { ...lease }, mutablePolicy = { ...policy };
  const adapted = assessExecutionLeaseWithClock(mutableLease, mutablePolicy, { now: () => {
    mutableLease.ownerId = "changed"; mutablePolicy.staleAfterMs = 100000; return sample(1001);
  } });
  assert.equal(adapted.state, "STALE_CANDIDATE"); assert.equal(adapted.lease?.ownerId, "worker-1");
  for (const field of ["publishTerminal", "claimExecution", "recover", "revoke", "evaluate", "retry", "cancel", "trust", "decision"]) assert.equal(field in result, false);
  for (const age of [1001, 1000000]) assert.equal(assessExecutionLeaseFreshness(lease, policy, sample(age)).state, "STALE_CANDIDATE");
  assert.equal(running.status, "running"); assert.equal(lease.ownerId, "worker-1");
});
