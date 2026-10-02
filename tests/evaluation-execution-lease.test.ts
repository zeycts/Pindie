import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, learningFingerprint } from "../src/learning-v1-contract.ts";
import { transitionEvaluationRun, type EvaluationRunV1 } from "../src/evaluation-run.ts";
import { createExecutionLease, heartbeatExecutionLease, isExecutionLeaseHeartbeat, validateExecutionLease } from "../src/evaluation-execution-lease.ts";

const acquiredAt = "2026-10-02T00:00:00.000Z", later = "2026-10-02T00:01:00.000Z";
const created: EvaluationRunV1 = {
  schemaVersion: 1, runId: "11111111-1111-4111-8111-111111111111",
  packetRef: { schemaVersion: 1, family: "evaluation-packet", scope: { kind: "project", projectId: "a".repeat(64) },
    id: "22222222-2222-4222-8222-222222222222", fingerprint: `sha256:${"b".repeat(64)}` },
  packetFingerprint: `sha256:${"b".repeat(64)}`, evaluator: { name: "fixture", version: "1" }, status: "created", createdAt: acquiredAt,
};
const running = transitionEvaluationRun(created, "running", acquiredAt);
const fixture = () => createExecutionLease(running, "worker-1");

test("lease creation binds running attempt and acquisition time without changing lifecycle", () => {
  const before = canonicalJson(running), lease = fixture();
  assert.ok(validateExecutionLease(lease));
  assert.deepEqual(lease, { schemaVersion: 1, runId: running.runId, ownerId: "worker-1", acquiredAt, heartbeatAt: acquiredAt });
  assert.ok(Object.isFrozen(lease));
  assert.equal(canonicalJson(running), before);
  for (const run of [created, transitionEvaluationRun(running, "completed", later), transitionEvaluationRun(running, "failed", later, { code: "FAIL", message: "Failure" })]) {
    assert.throws(() => createExecutionLease(run, "worker-1"));
  }
});

test("lease validation rejects missing, unknown, malformed and nonmonotonic metadata", () => {
  const lease = fixture();
  for (const key of Object.keys(lease)) {
    const missing = { ...lease } as Record<string, unknown>; delete missing[key];
    assert.equal(validateExecutionLease(missing), false, key);
  }
  for (const patch of [
    { schemaVersion: 2 }, { runId: "invalid" }, { ownerId: "" }, { ownerId: "   " }, { ownerId: "x".repeat(129) },
    { ownerId: 1 }, { acquiredAt: "invalid" }, { heartbeatAt: "invalid" }, { heartbeatAt: "2026-10-02T00:00:00Z" },
    { heartbeatAt: "2026-10-01T23:59:59.999Z" }, { acquiredAt: later }, { expiresAt: later },
  ]) assert.equal(validateExecutionLease({ ...lease, ...patch }), false, JSON.stringify(patch));
  for (const value of [null, [], "lease", 1]) assert.equal(validateExecutionLease(value), false);
  for (const owner of ["", " ", "x".repeat(129)]) assert.throws(() => createExecutionLease(running, owner));
});

test("heartbeats preserve exact ownership identity and immutable prior snapshots", () => {
  const lease = fixture(), before = canonicalJson(lease), next = heartbeatExecutionLease(lease, later);
  assert.ok(isExecutionLeaseHeartbeat(lease, next));
  assert.equal(next.ownerId, lease.ownerId); assert.equal(next.acquiredAt, lease.acquiredAt); assert.equal(next.runId, lease.runId);
  assert.equal(next.heartbeatAt, later); assert.ok(Object.isFrozen(next)); assert.notEqual(next, lease);
  assert.equal(canonicalJson(lease), before);
  assert.deepEqual(heartbeatExecutionLease(next, later), next);
  assert.throws(() => heartbeatExecutionLease(next, acquiredAt));
  assert.throws(() => heartbeatExecutionLease(next, "invalid"));
  for (const patch of [{ ownerId: "worker-2" }, { runId: created.packetRef.id }, { acquiredAt: later }, { schemaVersion: 2 }]) {
    assert.equal(isExecutionLeaseHeartbeat(lease, { ...next, ...patch } as typeof next), false);
  }
  assert.throws(() => heartbeatExecutionLease({ ...lease, ownerId: "" }, later));
});

test("lease snapshots use deterministic canonical serialization and fingerprints", () => {
  const lease = fixture();
  const reordered = { heartbeatAt: acquiredAt, ownerId: "worker-1", schemaVersion: 1, acquiredAt, runId: running.runId };
  assert.ok(validateExecutionLease(reordered));
  assert.equal(canonicalJson(lease), canonicalJson(reordered));
  assert.equal(learningFingerprint(lease), learningFingerprint(reordered));
  assert.deepEqual(JSON.parse(canonicalJson(lease)), lease);
  assert.notEqual(learningFingerprint(lease), learningFingerprint(heartbeatExecutionLease(lease, later)));
});

test("lease surface exposes no execution or semantic mutation capabilities", () => {
  const lease = fixture();
  for (const key of ["strategy", "trust", "decision", "publishTerminal", "evaluate", "claimExecution", "retry", "cancel"]) {
    assert.equal(key in lease, false);
    assert.equal(validateExecutionLease({ ...lease, [key]: () => {} }), false);
  }
  assert.throws(() => { (lease as { ownerId: string }).ownerId = "worker-2"; }, TypeError);
});
