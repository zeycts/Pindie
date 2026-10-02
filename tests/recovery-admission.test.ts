import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, learningFingerprint } from "../src/learning-v1-contract.ts";
import { transitionEvaluationRun } from "../src/evaluation-run.ts";
import { heartbeatExecutionLease } from "../src/evaluation-execution-lease.ts";
import { createRecoveryAdmissionBinding, recoveryAdmissionSnapshot, validateRecoveryAdmission, validateRecoveryAdmissionBinding, type RecoveryAdmissionV1 } from "../src/recovery-admission.ts";
import { createRecoveryAdmissionCoordinator, FileRecoveryAdmissionStore } from "../src/recovery-admission-store.ts";
import { admissionFixture, projectId, hash, clone, fixture, amount, confirmedAt, admittedAt } from "./recovery-fixture.ts";

function rebind(a: RecoveryAdmissionV1, patch: object): RecoveryAdmissionV1 {
  const { logicalEvaluationKey: _, opportunityKey: __, ...input } = a.binding;
  const binding = createRecoveryAdmissionBinding({ ...input, ...patch });
  return { ...a, binding, reconciliation: { ...a.reconciliation, opportunityKey: binding.opportunityKey,
    cessation: { ...a.reconciliation.cessation, confirmationRef: binding.confirmationRef }, runtime: { ...a.reconciliation.runtime, executionContractFingerprint: binding.executionContractFingerprint } },
    resources: { ...a.resources, opportunityKey: binding.opportunityKey } };
}
function register(f: Awaited<ReturnType<typeof admissionFixture>>, a: RecoveryAdmissionV1, overrides = {}) {
  return createRecoveryAdmissionCoordinator({ ...f.admissionOptions, controller: a.controller, policy: a.policy,
    reconciliation: { inspect: async () => a.reconciliation }, resources: { inspect: async () => a.resources }, ...overrides });
}
async function files(path: string) { try { return (await readdir(path)).filter(n => n !== "writer.lock"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } }

test("C7-A publishes canonical immutable admission, exact lookup and identical acknowledgment replay", async t => {
  const f = await admissionFixture(t);
  assert.ok(validateRecoveryAdmission(f.admission));
  const committed = await f.admissionCoordinator.admit(f.admission);
  assert.deepEqual(committed, recoveryAdmissionSnapshot(f.admission));
  assert.ok(Object.isFrozen(committed.admission.resources.reservation));
  assert.deepEqual(await new FileRecoveryAdmissionStore(f.options).get(committed.ref), committed);
  assert.deepEqual(await createRecoveryAdmissionCoordinator(f.admissionOptions).admit(clone(f.admission)), committed);
  assert.equal((await files(f.admissionDir)).length, 1);
  const bytes = await readFile(join(f.admissionDir, (await files(f.admissionDir))[0]), "utf8");
  assert.equal(bytes, canonicalJson({ schemaVersion: 1, admission: f.admission, fingerprint: committed.ref.fingerprint }));
  for (const patch of [{ fingerprint: hash }, { opportunityKey: hash }, { generation: 2 }, { extra: true }])
    await assert.rejects(f.admissions.get({ ...committed.ref, ...patch }));
  // A replay acknowledges existing metadata, without issuing a fresh resource reservation or execution permission.
  assert.deepEqual(await register(f, f.admission, { reconciliation: { inspect: async () => { throw new Error("no new reconciliation"); } } }).admit(f.admission), committed);
});

test("C7-A deterministic identity ignores field order and changes with each immutable source fact", async t => {
  const f = await admissionFixture(t), b = f.admission.binding;
  assert.ok(validateRecoveryAdmissionBinding(b));
  assert.deepEqual(rebind(f.admission, {}).binding, b);
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.ok(validateRecoveryAdmissionBinding(reordered));
  for (const patch of [{ confirmationRef: { ...b.confirmationRef, fingerprint: hash } },
    { evaluator: { ...b.evaluator, version: "2" } }, { executionContractFingerprint: learningFingerprint("different contract") },
    { packetRef: { ...b.packetRef, fingerprint: hash }, packetFingerprint: hash }]) {
    assert.notEqual(rebind(f.admission, patch).binding.opportunityKey, b.opportunityKey);
  }
  assert.equal(recoveryAdmissionSnapshot({ ...f.admission, controller: { ...f.admission.controller, incarnation: "other" } }).ref.opportunityKey, b.opportunityKey);
  assert.equal(validateRecoveryAdmissionBinding({ ...b, opportunityKey: hash }), false);
});

test("C7-A strict nested schemas reject unknown fields, oversized strings, invalid integers and timestamps", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ extra: true }, { newAttemptSpec: { runId: randomUUID() } }, { admittedAt: "invalid" },
    { controller: { ...f.admission.controller, id: "x".repeat(129) } },
    { resources: { ...f.admission.resources, capacity: { ...f.admission.resources.capacity, extra: true } } },
    { resources: { ...f.admission.resources, reservation: amount(Number.MAX_SAFE_INTEGER + 1) } },
    { reconciliation: { ...f.admission.reconciliation, cessation: { ...f.admission.reconciliation.cessation, claimId: "not-a-claim" } } }]) {
    assert.equal(validateRecoveryAdmission({ ...f.admission, ...patch }), false);
    await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, ...patch } as RecoveryAdmissionV1));
  }
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A competing admission decisions conflict even with independent coordinators", async t => {
  const f = await admissionFixture(t), changed = { ...f.admission, controller: { ...f.admission.controller, incarnation: "competitor" } };
  const settled = await Promise.allSettled([f.admissionCoordinator.admit(f.admission), register(f, changed).admit(changed)]);
  assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(settled.filter(r => r.status === "rejected").length, 1);
  assert.match((settled.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message, /Conflicting/);
  assert.equal((await files(f.admissionDir)).length, 1);
  const g = await admissionFixture(t);
  const same = await Promise.all([g.admissionCoordinator.admit(g.admission), createRecoveryAdmissionCoordinator(g.admissionOptions).admit(clone(g.admission))]);
  assert.deepEqual(same[0], same[1]);
});

test("C7-A wrong confirmation, nonrevoked authority and changed exact bindings reject", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ confirmationRef: f.origin.ref }, { confirmationRef: { ...f.revoked.ref, fingerprint: hash } },
    { evaluator: { name: "another", version: "1" } }, { evaluator: { ...f.admission.binding.evaluator, version: "2" } },
    { packetRef: { ...f.admission.binding.packetRef, fingerprint: hash }, packetFingerprint: hash }]) {
    const a = rebind(f.admission, patch);
    await assert.rejects(register(f, a).admit(a));
  }
  await assert.rejects(register(f, f.admission, { packets: { get: async () => fixture().packet } }).admit(f.admission), /Packet/);
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, originAuthorityRef: { ...f.origin.ref, fingerprint: hash } }));
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, reconciliation: { ...f.admission.reconciliation,
    cessation: { ...f.admission.reconciliation.cessation, claimId: randomUUID() } } }), /provenance/);
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A requires separate current authorization and rechecks revocation at publication", async t => {
  const f = await admissionFixture(t);
  assert.throws(() => createRecoveryAdmissionCoordinator({ ...f.admissionOptions, projectsBaseDir: join(f.root, "wrong") }));
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, controller: { ...f.admission.controller, id: "forged" } }), /Unauthorized/);
  await assert.rejects(register(f, f.admission, { isAuthorized: () => false }).admit(f.admission), /Unauthorized/);
  let allowed = true;
  await assert.rejects(register(f, f.admission, { isAuthorized: () => allowed, beforePublish: async () => { allowed = false; } }).admit(f.admission), /Unauthorized/);
  const revocationPath = join(f.authorityDir, `${f.revoked.ref.runId}.${f.revoked.ref.fingerprint.slice(7)}.json`);
  await assert.rejects(register(f, f.admission, { beforePublish: async () => { await rm(revocationPath); } }).admit(f.admission));
  assert.deepEqual(await files(f.admissionDir), []);
  assert.equal("admit" in f.coordinator, false);
  for (const name of ["confirm", "claimExecution", "execute", "retry", "publish", "publishTerminal", "promote", "setPolicy", "saveExperience"])
    assert.equal(name in f.admissionCoordinator, false);
  assert.equal("admit" in f.admissions, false);
});

for (const state of ["COMMITTED_OUTPUT_EXISTS", "COMMITTED_RESULT_EXISTS", "TERMINAL_EXISTS", "PUBLICATION_AMBIGUOUS", "EXTERNAL_EXECUTION_UNKNOWN", "HISTORY_UNKNOWN"] as const) {
  test(`C7-A reconciliation fails closed: ${state}`, async t => {
    const f = await admissionFixture(t), report = { ...f.admission.reconciliation, state };
    await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => report } }).admit(f.admission), /reconciliation/);
    assert.equal(validateRecoveryAdmission({ ...f.admission, reconciliation: report }), false);
  });
}

test("C7-A cessation, isolation, closed publication and inspector freshness are required", async t => {
  const f = await admissionFixture(t), r = f.admission.reconciliation;
  for (const patch of [{ publication: "unknown" }, { effects: "unknown" }, { ambiguities: "unknown" }, { rootBinding: "unknown" },
    { cessation: { ...r.cessation, coverage: "unknown" } }, { cessation: { ...r.cessation, status: "unknown" } },
    { runtime: { ...r.runtime, isolation: "unknown" } }, { runtime: { ...r.runtime, readiness: "unavailable" } },
    { publicationManifestFingerprint: learningFingerprint("changed") }]) {
    await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => ({ ...r, ...patch }) } }).admit(f.admission));
  }
  await assert.rejects(register(f, f.admission, { now: () => confirmedAt }).admit(f.admission), /clock/);
  let inspections = 0;
  await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => ++inspections === 1 ? r : { ...r, state: "PUBLICATION_AMBIGUOUS" } } }).admit(f.admission));
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A policy generation, evaluator allowlist, budget and capacity limits fail closed", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ maxRecoveryAdmissions: 0 }, { retryableEvaluators: [] }, { perAdmission: amount(50) }, { perEvaluation: amount(50) }, { global: amount(50) }]) {
    const p = { ...f.admission.policy, ...patch }, a = { ...f.admission, policy: p, policyFingerprint: learningFingerprint(p) };
    await assert.rejects(register(f, a).admit(a));
  }
  const prev = recoveryAdmissionSnapshot(f.admission).ref;
  const childId = randomUUID();
  const next = rebind(f.admission, { generation: 2, previousAdmissionRef: prev, oldRunningRef: { ...f.admission.binding.oldRunningRef, runId: childId },
    confirmationRef: { ...f.revoked.ref, runId: childId } });
  await assert.rejects(register(f, { ...next, originAuthorityRef: { ...next.originAuthorityRef, runId: childId } }).admit({ ...next, originAuthorityRef: { ...next.originAuthorityRef, runId: childId } }), /generation/);
  for (const patch of [{ capacity: { runSlots: 0, authoritySlots: 1, leaseSlots: 1 } }, { evaluationBaseUsage: amount(0) }, { reservation: amount(201) }]) {
    const a = { ...f.admission, resources: { ...f.admission.resources, ...patch } };
    await assert.rejects(register(f, a).admit(a));
  }
});

test("C7-A counts immutable reservations across roots and rejects aggregate budget exhaustion", async t => {
  const f = await admissionFixture(t), g = await admissionFixture(t, f.root);
  const p = { ...f.admission.policy, global: amount(150) };
  const a = { ...f.admission, policy: p, policyFingerprint: learningFingerprint(p) };
  const b = { ...g.admission, policy: p, policyFingerprint: learningFingerprint(p) };
  await register(f, a).admit(a);
  await assert.rejects(register(g, b).admit(b), /budget/);
  assert.equal((await files(f.admissionDir)).length, 1);
});

test("C7-A known output/result surface blocks admission rather than salvaging", async t => {
  for (const namespace of ["evaluation-results-v1", "evaluation-outputs-v1"]) {
    const f = await admissionFixture(t), path = join(f.root, projectId, "learning-v1", namespace);
    await mkdir(path); await writeFile(join(path, "unresolved.json"), "{}");
    await assert.rejects(f.admissionCoordinator.admit(f.admission), /output surface/);
    assert.deepEqual(await files(f.admissionDir), []);
  }
});

for (const corruption of ["json", "canonical", "digest", "version", "binding", "unknown", "oversize", "filename", "missing-authority"]) {
  test(`C7-A corrupt/incomplete history fails closed: ${corruption}`, async t => {
    const f = await admissionFixture(t), committed = await f.admissionCoordinator.admit(f.admission);
    const path = join(f.admissionDir, (await files(f.admissionDir))[0]);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (corruption === "digest") value.fingerprint = hash;
    if (corruption === "version") value.schemaVersion = 2;
    if (corruption === "binding") value.admission.binding.opportunityKey = hash;
    if (corruption === "unknown") value.admission.extra = true;
    if (corruption === "filename") await writeFile(join(f.admissionDir, "unexpected.json"), "{}");
    else if (corruption === "missing-authority") await rm(join(f.authorityDir, `${f.origin.ref.runId}.${f.origin.ref.fingerprint.slice(7)}.json`));
    else await writeFile(path, corruption === "json" ? "{" : corruption === "oversize" ? " ".repeat(17000) : corruption === "canonical" ? JSON.stringify(value, null, 2) : canonicalJson(value));
    if (corruption === "missing-authority") assert.deepEqual(await f.admissions.get(committed.ref), committed); // history read is not execution authority
    else await assert.rejects(f.admissions.get(committed.ref));
    await assert.rejects(f.admissionCoordinator.admit(f.admission));
    assert.equal((await f.runs.getCurrent(projectId, f.created.runId)).status, "running");
  });
}

test("C7-A failures before publication and after durable link reconcile without duplicate permission", async t => {
  const f = await admissionFixture(t);
  await assert.rejects(register(f, f.admission, { beforePublish: async () => { throw new Error("before-link"); } }).admit(f.admission), /before-link/);
  assert.deepEqual(await files(f.admissionDir), []);
  await assert.rejects(register(f, f.admission, { afterPublish: async () => { throw new Error("lost-ack"); } }).admit(f.admission), /lost-ack/);
  const exact = recoveryAdmissionSnapshot(f.admission);
  assert.deepEqual(await f.admissions.get(exact.ref), exact);
  assert.deepEqual(await f.admissionCoordinator.admit(f.admission), exact);
  assert.equal((await files(f.admissionDir)).length, 1);
});

test("C7-A admission preserves old fencing, all source history and semantic namespaces; creates no successor", async t => {
  const f = await admissionFixture(t), learning = join(f.root, projectId, "learning-v1");
  const protectedDirs = ["evaluation-runs-v1", "execution-authorities-v1", "execution-leases-v1", "strategies", "policy", "trust", "decisions", "experience"];
  const snapshots = new Map<string, string>();
  for (const name of protectedDirs) {
    const path = join(learning, name); await mkdir(path, { recursive: true });
    if (!name.endsWith("-v1")) await writeFile(join(path, "sentinel.json"), "unchanged");
    for (const n of await files(path)) snapshots.set(join(path, n), await readFile(join(path, n), "utf8"));
  }
  await f.admissionCoordinator.admit(f.admission);
  for (const name of protectedDirs) {
    const path = join(learning, name);
    assert.deepEqual((await files(path)).sort(), [...snapshots.keys()].filter(k => k.startsWith(path + "/")).map(k => k.slice(path.length + 1)).sort());
  }
  for (const [path, bytes] of snapshots) assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.revoked);
  await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", admittedAt)), /epoch/);
  await assert.rejects(f.runs.publish(f.claim.running), /epoch/);
  await assert.rejects(f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, admittedAt)), /epoch/);
  await assert.rejects(f.runs.claimExecution(f.created, admittedAt));
  assert.equal((await files(join(learning, "evaluation-runs-v1"))).length, 2);
});

const exec = promisify(execFile);
async function child(f: Awaited<ReturnType<typeof admissionFixture>>, a: RecoveryAdmissionV1, mode = "normal") {
  const script = `
    import { FileEvaluationRunStore } from './src/evaluation-run-store.ts';
    import { FileExecutionLeaseStore } from './src/evaluation-execution-lease-store.ts';
    import { createRecoveryAdmissionCoordinator } from './src/recovery-admission-store.ts';
    const a = JSON.parse(process.env.ADMISSION), packet = JSON.parse(process.env.PACKET), root = process.env.ROOT;
    const coordinator = createRecoveryAdmissionCoordinator({ projectsBaseDir: root, controller: a.controller, policy: a.policy,
      runs: new FileEvaluationRunStore({ projectsBaseDir: root, packets: { get: async () => packet } }),
      leases: new FileExecutionLeaseStore({ projectsBaseDir: root }), packets: { get: async () => packet },
      reconciliation: { inspect: async () => a.reconciliation }, resources: { inspect: async () => a.resources }, now: () => a.admittedAt, isAuthorized: () => true,
      ${mode === "pre" ? "beforePublish: async () => process.exit(0)," : mode === "post" ? "afterPublish: async () => process.exit(0)," : ""}
    });
    try { const s = await coordinator.admit(a); console.log(JSON.stringify({ ok: true, ref: s.ref })); }
    catch(e) { console.log(JSON.stringify({ ok: false, message: e.message })); }
  `;
  return exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: process.cwd(), env: { ...process.env, ROOT: f.root, ADMISSION: JSON.stringify(a), PACKET: JSON.stringify(f.packet) } });
}
test("C7-A separate-process identical and conflicting writers share one logical slot", async t => {
  const f = await admissionFixture(t);
  const identical = await Promise.all([child(f, f.admission), child(f, clone(f.admission))]);
  const results = identical.map(r => JSON.parse(r.stdout));
  assert.ok(results.every(r => r.ok)); assert.deepEqual(results[0].ref, results[1].ref);
  const g = await admissionFixture(t), competing = { ...g.admission, controller: { ...g.admission.controller, incarnation: "process-two" } };
  const different = (await Promise.all([child(g, g.admission), child(g, competing)])).map(r => JSON.parse(r.stdout));
  assert.equal(different.filter(r => r.ok).length, 1); assert.match(different.find(r => !r.ok).message, /Conflicting/);
  assert.equal((await files(g.admissionDir)).length, 1);
});
for (const mode of ["pre", "post"]) {
  test(`C7-A process death ${mode}-publication reclaims runtime locks and converges`, async t => {
    const f = await admissionFixture(t); await child(f, f.admission, mode);
    assert.equal((await files(f.admissionDir)).length, mode === "pre" ? 0 : 1);
    const s = await f.admissionCoordinator.admit(f.admission);
    assert.deepEqual(await f.admissions.get(s.ref), s); assert.equal((await files(f.admissionDir)).length, 1);
  });
}

test("C7-A detaches caller records and registration values before asynchronous publication", async t => {
  const f = await admissionFixture(t), input = clone(f.admission), configuredController = clone(input.controller), configuredPolicy = clone(input.policy);
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { reached = r; });
  const coordinator = register(f, input, { controller: configuredController, policy: configuredPolicy, reconciliation: f.admissionOptions.reconciliation, resources: f.admissionOptions.resources,
    beforePublish: async () => { reached(); await paused; } });
  const pending = coordinator.admit(input); await ready;
  (input.controller as { id: string }).id = "changed";
  (input.resources.reservation as { tokens: number }).tokens = 0;
  (configuredController as { id: string }).id = "changed-registration";
  (configuredPolicy as { maxRecoveryAdmissions: number }).maxRecoveryAdmissions = 0;
  release();
  assert.deepEqual(await pending, recoveryAdmissionSnapshot(f.admission));
});
