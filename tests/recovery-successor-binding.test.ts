import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { admissionFixture } from "./recovery-fixture.ts";
import { canonicalJson, learningFingerprint } from "../src/learning-v1-contract.ts";
import { evaluationRunRef, validateEvaluationRun, validateEvaluationRunRef, validateEvaluationRunV1, validateEvaluationRunV2, transitionEvaluationRun, isEvaluationRunTransition } from "../src/evaluation-run.ts";
import { FileEvaluationRunStore, createRecoverySuccessorMaterializer } from "../src/evaluation-run-store.ts";
import { recoveryAdmissionSnapshot } from "../src/recovery-admission.ts";
import { createRecoverySuccessorBinding, recoverySuccessorCreatedRun, validateRecoverySuccessorBinding, recoverySuccessorBindingSnapshot } from "../src/recovery-successor-binding.ts";
import { FileRecoverySuccessorBindingStore, selectRecoverySuccessorBinding } from "../src/recovery-successor-binding-store.ts";
import { recoveryCapacityReservations } from "../src/recovery-capacity.ts";
import { heartbeatExecutionLease } from "../src/evaluation-execution-lease.ts";

const selectedAt = "2026-01-01T00:03:00.000Z", later = "2026-01-01T00:04:00.000Z";
const clone = <T>(v: T): T => JSON.parse(canonicalJson(v));
type Fixture = Awaited<ReturnType<typeof admissionFixture>>;
const bindingDir = (f: Fixture) => join(f.root, f.admission.binding.projectId, "learning-v1", "recovery-successor-bindings-v1");
const runDir = (f: Fixture) => join(f.root, f.admission.binding.projectId, "learning-v1", "evaluation-runs-v1");
async function files(path: string) { try { return (await readdir(path)).filter(n => n !== "writer.lock").sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } }
async function committed(t: Parameters<typeof admissionFixture>[0]) {
  const f = await admissionFixture(t), admission = await f.admissionCoordinator.admit(f.admission);
  return { ...f, admissionRef: admission.ref };
}
function register(f: Fixture, overrides = {}) {
  return createRecoverySuccessorMaterializer({ ...f.admissionOptions,
    reconciliation: { inspect: async () => ({ ...f.admission.reconciliation, observedAt: selectedAt }) },
    resources: { inspect: async () => ({ ...f.admission.resources, observedAt: selectedAt }) }, now: () => selectedAt, ...overrides });
}

test("C7-B strict v2 lifecycle and complete ref fingerprint preserve immutable lineage and v1 strictness", async t => {
  const f = await committed(t), binding = createRecoverySuccessorBinding(f.admission, randomUUID(), selectedAt), created = recoverySuccessorCreatedRun(binding);
  assert.ok(validateEvaluationRunV1(f.created)); assert.ok(validateEvaluationRunV2(created)); assert.equal(validateEvaluationRunV1(created), false); assert.equal(validateEvaluationRunV2(f.created), false); assert.ok(validateRecoverySuccessorBinding(binding));
  const running = transitionEvaluationRun(created, "running", selectedAt), completed = transitionEvaluationRun(running, "completed", later);
  const failed = transitionEvaluationRun(running, "failed", later, { code: "STOP", message: "Stopped" });
  for (const r of [running, completed, failed]) { assert.ok(validateEvaluationRun(r)); assert.deepEqual(r.recovery, created.recovery); }
  assert.ok(isEvaluationRunTransition(created, running)); assert.ok(isEvaluationRunTransition(running, failed));
  const ref = evaluationRunRef(created);
  assert.ok(validateEvaluationRunRef(ref)); assert.equal(ref.schemaVersion, 1); assert.equal(ref.fingerprint, learningFingerprint(created));
  for (const patch of [{ schemaVersion: 1 }, { extra: true }, { recoveryGeneration: 2 }, { logicalEvaluationKey: learningFingerprint("other") },
    { recovery: { ...created.recovery, extra: true } }, { recovery: { ...created.recovery, parentRunningRef: { ...created.recovery.parentRunningRef, runId: randomUUID() } } },
    { evaluator: { ...created.evaluator, extra: true } }, { packetFingerprint: learningFingerprint("other") }]) assert.equal(validateEvaluationRun({ ...created, ...patch }), false);
  const changed = { ...running, recovery: { ...running.recovery, admissionRef: { ...running.recovery.admissionRef, fingerprint: learningFingerprint("other") } } };
  assert.ok(validateEvaluationRun(changed)); assert.equal(isEvaluationRunTransition(created, changed), false);
  assert.notEqual(evaluationRunRef(changed).fingerprint, evaluationRunRef(running).fingerprint);
  assert.equal(validateEvaluationRun({ ...f.created, recovery: created.recovery }), false);
});

test("C7-B exact materialization and independent replay select only one canonical binding/run", async t => {
  const f = await committed(t), materializer = register(f);
  const results = await Promise.all([materializer.materialize(f.admissionRef), register(f).materialize(clone(f.admissionRef))]);
  assert.deepEqual(results[0], results[1]); const { successor, run, runRef } = results[0];
  assert.equal(run.schemaVersion, 2); assert.equal(run.status, "created"); assert.equal(run.runId, successor.binding.successorRunId);
  assert.deepEqual(run.recovery.admissionRef, f.admissionRef); assert.ok(Object.isFrozen(run.recovery.admissionRef));
  const store = new FileRecoverySuccessorBindingStore(f.options);
  assert.deepEqual(await store.get(successor.ref), successor); assert.deepEqual(await store.find(f.admissionRef), successor);
  assert.deepEqual(await f.runs.get(runRef), run); assert.deepEqual(await f.runs.get(evaluationRunRef(f.created)), f.created);
  assert.equal((await files(bindingDir(f))).length, 1); assert.equal((await files(runDir(f))).length, 3);
  assert.equal(await readFile(join(bindingDir(f), (await files(bindingDir(f)))[0]), "utf8"), canonicalJson({ schemaVersion: 1, binding: successor.binding, fingerprint: successor.ref.fingerprint }));
  await assert.rejects(materializer.materialize(f.admissionRef, randomUUID()), /Conflicting successor/);
  assert.deepEqual(await materializer.materialize(f.admissionRef, run.runId), results[0]);
  for (const name of ["publish", "claimExecution", "execute", "publishTerminal", "createLease", "admit", "confirm"])
    assert.equal(name in materializer, false);
});

test("C7-B binding selection rejects competing IDs and exact lookups fail closed", async t => {
  const f = await committed(t), ref = f.admissionRef, one = randomUUID(), two = randomUUID();
  const settled = await Promise.allSettled([register(f).materialize(ref, one), register(f).materialize(ref, two)]);
  assert.equal(settled.filter(r => r.status === "fulfilled").length, 1); assert.equal(settled.filter(r => r.status === "rejected").length, 1);
  const winner = (settled.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof register>["materialize"]>>>).value;
  const store = new FileRecoverySuccessorBindingStore(f.options);
  for (const patch of [{ extra: true }, { fingerprint: learningFingerprint("wrong") }, { family: "evaluation-run" }]) await assert.rejects(store.get({ ...winner.successor.ref, ...patch } as never));
  assert.equal((await files(bindingDir(f))).length, 1);
});

test("C7-B direct v2 publication and execution reject, even with valid admission/binding", async t => {
  const f = await committed(t), binding = createRecoverySuccessorBinding(f.admission, randomUUID(), selectedAt), unbound = recoverySuccessorCreatedRun(binding);
  await assert.rejects(f.runs.publish(unbound), /materialization/); await assert.rejects(f.runs.claimExecution(unbound, later), /disabled/);
  await selectRecoverySuccessorBinding(f.root, binding, { revalidate: async () => {} });
  await assert.rejects(f.runs.publish({ ...f.created, runId: binding.successorRunId }), /Selected recovery target/);
  for (const patch of [{ runId: randomUUID() }, { recoveryGeneration: 2 }, { packetFingerprint: learningFingerprint("bad") },
    { evaluator: { name: "foreign", version: "2" } }, { recovery: { ...unbound.recovery, admissionRef: { ...f.admissionRef, fingerprint: learningFingerprint("foreign") } } }])
    await assert.rejects(f.runs.publish({ ...unbound, ...patch } as never));
  const m = await register(f).materialize(f.admissionRef);
  await assert.rejects(f.runs.publish(m.run), /materialization/); await assert.rejects(f.runs.claimExecution(m.run, later), /disabled/);
  await assert.rejects(f.runs.publish(transitionEvaluationRun(m.run, "running", later)), /materialization/);
  const recoveredRunning = transitionEvaluationRun(m.run, "running", later);
  const { createExecutionLease } = await import("../src/evaluation-execution-lease.ts");
  const { prepareEvaluationInput } = await import("../src/evaluator-contract.ts");
  const { createExecutionRunner } = await import("../src/evaluation-execution-runner.ts");
  assert.throws(() => createExecutionLease(recoveredRunning as never, "forged-owner"));
  assert.throws(() => prepareEvaluationInput(f.packet, recoveredRunning as never));
  let invocations = 0;
  const runner = createExecutionRunner({ runs: f.runs, packets: { get: async () => f.packet },
    evaluator: { schemaVersion: 1, identity: m.run.evaluator, evaluate: async () => { invocations++; throw new Error("must not execute"); } }, now: () => later });
  await assert.rejects(runner.execute(m.run as never)); assert.equal(invocations, 0);
  assert.equal((await files(runDir(f))).length, 3);
});

test("C7-B foreign admissions, changed sources and current authorization fail closed", async t => {
  const f = await committed(t);
  for (const patch of [{ fingerprint: learningFingerprint("foreign") }, { projectId: "b".repeat(64) }, { generation: 2 }, { opportunityKey: learningFingerprint("other") }])
    await assert.rejects(register(f).materialize({ ...f.admissionRef, ...patch }));
  await assert.rejects(register(f, { isAuthorized: () => false }).materialize(f.admissionRef), /Unauthorized/);
  assert.throws(() => register(f, { projectsBaseDir: join(f.root, "foreign") }));
  const wrongPacketRuns = new FileEvaluationRunStore({ ...f.options, packets: { get: async () => ({ ...f.packet, fingerprint: learningFingerprint("wrong") }) } });
  await assert.rejects(register(f, { runs: wrongPacketRuns }).materialize(f.admissionRef), /Packet/);
  for (const patch of [{ state: "COMMITTED_OUTPUT_EXISTS" }, { cessation: { ...f.admission.reconciliation.cessation, claimId: randomUUID() } },
    { runtime: { ...f.admission.reconciliation.runtime, executionContractFingerprint: learningFingerprint("changed") } }])
    await assert.rejects(register(f, { reconciliation: { inspect: async () => ({ ...f.admission.reconciliation, observedAt: selectedAt, ...patch }) } }).materialize(f.admissionRef), /reconciliation/);
  let allowed = true;
  await assert.rejects(register(f, { isAuthorized: () => allowed, beforeBindingPublish: async () => { allowed = false; } }).materialize(f.admissionRef), /Unauthorized/);
  assert.equal((await files(bindingDir(f))).length, 0);
});

test("C7-B existing generation/reservation is not double charged; stricter current resources/policy block", async t => {
  const f = await committed(t), resource = { ...f.admission.resources, observedAt: selectedAt, capacity: { runSlots: 1, authoritySlots: 1, leaseSlots: 1 } };
  const exactPolicy = { ...f.admission.policy, maxRecoveryAdmissions: 1,
    perEvaluation: { tokens: 110, costMicros: 110, durationMs: 110 }, global: { tokens: 110, costMicros: 110, durationMs: 110 } };
  for (const policy of [{ ...exactPolicy, maxRecoveryAdmissions: 0 }, { ...exactPolicy, retryableEvaluators: [] },
    { ...exactPolicy, global: { tokens: 109, costMicros: 109, durationMs: 109 } }])
    await assert.rejects(register(f, { policy }).materialize(f.admissionRef));
  for (const field of ["runSlots", "authoritySlots", "leaseSlots"])
    await assert.rejects(register(f, { resources: { inspect: async () => ({ ...resource, capacity: { ...resource.capacity, [field]: 0 } }) } }).materialize(f.admissionRef), /capacity/);
  const m = await register(f, { policy: exactPolicy, resources: { inspect: async () => resource } }).materialize(f.admissionRef);
  assert.equal(m.run.status, "created");
  assert.deepEqual(await recoveryCapacityReservations(f.root, f.admission.binding.projectId), { runSlots: 0, authoritySlots: 1, leaseSlots: 1 });
  assert.deepEqual(await register(f, { policy: exactPolicy, resources: { inspect: async () => ({ ...resource, capacity: { ...resource.capacity, runSlots: 0 } }) } }).materialize(f.admissionRef), m);
  assert.deepEqual(await f.admissions.get(f.admissionRef), recoveryAdmissionSnapshot(f.admission));
});

for (const frontier of ["before-binding", "after-binding", "after-run"] as const) {
  test(`C7-B lost acknowledgment at ${frontier} reconciles exact selected target`, async t => {
    const f = await committed(t), selectedId = randomUUID();
    const fail = async () => { throw new Error(frontier); };
    const runs = frontier === "after-run" ? new FileEvaluationRunStore({ ...f.options, packets: { get: async () => f.packet }, afterPublish: fail }) : f.runs;
    const overrides = { runs, ...(frontier === "before-binding" ? { beforeBindingPublish: fail } : frontier === "after-binding" ? { afterBindingPublish: fail } : {}) };
    await assert.rejects(register(f, overrides).materialize(f.admissionRef, selectedId), new RegExp(frontier));
    assert.equal((await files(bindingDir(f))).length, frontier === "before-binding" ? 0 : 1);
    assert.equal((await files(runDir(f))).length, frontier === "after-run" ? 3 : 2);
    const m = await register(f).materialize(f.admissionRef, frontier === "before-binding" ? selectedId : undefined);
    assert.equal(m.run.runId, selectedId); assert.deepEqual(await f.runs.get(m.runRef), m.run);
  });
}

for (const family of ["evaluation-results-v1", "evaluation-outputs-v1"]) {
  test(`C7-B ${family} after admission or binding blocks creation and preserves immutable selection`, async t => {
    const f = await committed(t), path = join(f.root, f.admission.binding.projectId, "learning-v1", family), selectedId = randomUUID();
    await assert.rejects(register(f, { afterBindingPublish: async () => { await mkdir(path); await writeFile(join(path, "unknown.json"), "{}"); } }).materialize(f.admissionRef, selectedId), /output surface/);
    await assert.rejects(register(f).materialize(f.admissionRef), /output surface/);
    assert.equal((await files(runDir(f))).length, 2); assert.equal((await files(bindingDir(f))).length, 1);
    assert.deepEqual(await f.admissions.get(f.admissionRef), recoveryAdmissionSnapshot(f.admission));
  });
}

test("C7-B materialization preserves old fences, source bytes and semantic namespaces; creates no ownership", async t => {
  const f = await committed(t), base = join(f.root, f.admission.binding.projectId, "learning-v1");
  const names = ["execution-authorities-v1", "execution-leases-v1", "recovery-admissions-v1", "strategies", "policy", "trust", "decisions", "experience"];
  const before = new Map<string, string>();
  for (const name of names) {
    const dir = join(base, name); await mkdir(dir, { recursive: true });
    if (!name.endsWith("-v1")) await writeFile(join(dir, "sentinel.json"), "unchanged");
    for (const n of await files(dir)) before.set(join(dir, n), await readFile(join(dir, n), "utf8"));
  }
  for (const n of await files(runDir(f))) before.set(join(runDir(f), n), await readFile(join(runDir(f), n), "utf8"));
  const m = await register(f).materialize(f.admissionRef);
  for (const [path, bytes] of before) assert.equal(await readFile(path, "utf8"), bytes);
  for (const name of names) assert.deepEqual(await files(join(base, name)), [...before.keys()].filter(k => k.startsWith(join(base, name) + "/")).map(k => k.split("/").at(-1)).sort());
  assert.deepEqual(await f.authorities.getCurrent(f.admission.binding.projectId, f.created.runId), f.revoked);
  await assert.rejects(f.authorities.getCurrent(f.admission.binding.projectId, m.run.runId));
  await assert.rejects(f.store.getCurrent(f.admission.binding.projectId, m.run.runId));
  await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", later)), /epoch/);
  await assert.rejects(f.runs.publish(f.claim.running), /epoch/);
  await assert.rejects(f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, later)), /epoch/);
});

for (const corruption of ["binding-json", "binding-digest", "binding-sibling", "admission", "run", "run-lineage", "selected-v1"]) {
  test(`C7-B corruption/conflict fails closed: ${corruption}`, async t => {
    const f = await committed(t), m = await register(f).materialize(f.admissionRef);
    const bindingPath = join(bindingDir(f), (await files(bindingDir(f)))[0]);
    if (corruption === "binding-json") await writeFile(bindingPath, "{");
    if (corruption === "binding-digest") { const v = JSON.parse(await readFile(bindingPath, "utf8")); v.fingerprint = learningFingerprint("wrong"); await writeFile(bindingPath, canonicalJson(v)); }
    if (corruption === "binding-sibling") {
      const b = { ...m.successor.binding, successorRunId: randomUUID() }, s = recoverySuccessorBindingSnapshot(b);
      await writeFile(join(bindingDir(f), `${learningFingerprint("sibling").slice(7)}.json`), canonicalJson({ schemaVersion: 1, binding: b, fingerprint: s.ref.fingerprint }));
    }
    if (corruption === "admission") await writeFile(join(f.admissionDir, (await files(f.admissionDir))[0]), "{}");
    if (corruption === "run") await writeFile(join(runDir(f), `${m.run.runId}.created.json`), "{");
    if (corruption === "run-lineage" || corruption === "selected-v1") {
      const run = corruption === "selected-v1" ? { ...f.created, runId: m.run.runId } : { ...m.run, recovery: { ...m.run.recovery, rootCreatedRef: { ...m.run.recovery.rootCreatedRef, fingerprint: learningFingerprint("wrong") } } };
      await writeFile(join(runDir(f), `${m.run.runId}.created.json`), canonicalJson({ schemaVersion: 1, run, fingerprint: learningFingerprint(run) }));
    }
    await assert.rejects(register(f).materialize(f.admissionRef));
    assert.equal((await files(bindingDir(f))).length, corruption === "binding-sibling" ? 2 : 1);
  });
}

const exec = promisify(execFile);
async function child(f: Fixture, target?: string, mode = "normal") {
  const script = `
    import { FileEvaluationRunStore, createRecoverySuccessorMaterializer } from './src/evaluation-run-store.ts';
    import { FileExecutionLeaseStore } from './src/evaluation-execution-lease-store.ts';
    import { recoveryAdmissionSnapshot } from './src/recovery-admission.ts';
    const a = JSON.parse(process.env.ADMISSION), packet = JSON.parse(process.env.PACKET), root = process.env.ROOT;
    const at = '${selectedAt}', mode = process.env.MODE;
    const runs = new FileEvaluationRunStore({ projectsBaseDir: root, packets: { get: async () => packet },
      afterPublish: mode === 'run' ? async () => process.exit(0) : undefined });
    const materializer = createRecoverySuccessorMaterializer({ projectsBaseDir: root, controller: a.controller, policy: a.policy, runs,
      leases: new FileExecutionLeaseStore({ projectsBaseDir: root }),
      reconciliation: { inspect: async () => ({ ...a.reconciliation, observedAt: at }) },
      resources: { inspect: async () => ({ ...a.resources, observedAt: at }) }, now: () => at, isAuthorized: () => true,
      beforeBindingPublish: mode === 'pre' ? async () => process.exit(0) : undefined,
      afterBindingPublish: mode === 'binding' ? async () => process.exit(0) : undefined });
    try { const s = await materializer.materialize(recoveryAdmissionSnapshot(a).ref, process.env.TARGET || undefined); console.log(JSON.stringify({ ok: true, result: s })); }
    catch(e) { console.log(JSON.stringify({ ok: false, message: e.message })); }
  `;
  return exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: process.cwd(),
    env: { ...process.env, ROOT: f.root, ADMISSION: JSON.stringify(f.admission), PACKET: JSON.stringify(f.packet), TARGET: target ?? "", MODE: mode } });
}
test("C7-B separate-process unproposed races converge and competing proposals conflict", async t => {
  const f = await committed(t);
  const same = (await Promise.all([child(f), child(f)])).map(r => { assert.ok(r.stdout.trim(), `Empty child output: ${r.stderr}`); return JSON.parse(r.stdout); });
  assert.ok(same.every(r => r.ok)); assert.deepEqual(same[0].result, same[1].result);
  const g = await committed(t), competing = (await Promise.all([child(g, randomUUID()), child(g, randomUUID())])).map(r => { assert.ok(r.stdout.trim(), `Empty child output: ${r.stderr}`); return JSON.parse(r.stdout); });
  assert.equal(competing.filter(r => r.ok).length, 1); assert.match(competing.find(r => !r.ok).message, /Conflicting successor/);
  assert.equal((await files(bindingDir(g))).length, 1); assert.equal((await files(runDir(g))).length, 3);
});
for (const mode of ["pre", "binding", "run"]) {
  test(`C7-B process death at ${mode} frontier restarts with exact immutable target`, async t => {
    const f = await committed(t), target = randomUUID(); await child(f, target, mode);
    assert.equal((await files(bindingDir(f))).length, mode === "pre" ? 0 : 1);
    assert.equal((await files(runDir(f))).length, mode === "run" ? 3 : 2);
    const result = await register(f).materialize(f.admissionRef, mode === "pre" ? target : undefined);
    assert.equal(result.run.runId, target); assert.deepEqual(await f.runs.get(result.runRef), result.run);
  });
}

test("C7-B binding contract/persistence reject changed lineage, packets, evaluators and target specifications", async t => {
  const f = await committed(t), b = createRecoverySuccessorBinding(f.admission, randomUUID(), selectedAt);
  for (const patch of [{ extra: true }, { schemaVersion: 2 }, { selectedAt: "invalid" }, { successorRunId: f.created.runId },
    { evaluator: { ...b.evaluator, extra: true } }, { rootCreatedRef: { ...b.rootCreatedRef, extra: true } }, { admissionRef: { ...b.admissionRef, extra: true } }])
    assert.equal(validateRecoverySuccessorBinding({ ...b, ...patch }), false);
  for (const patch of [{ parentRunningRef: { ...b.parentRunningRef, fingerprint: learningFingerprint("wrong-parent") } },
    { rootCreatedRef: { ...b.rootCreatedRef, fingerprint: learningFingerprint("wrong-root") } },
    { recoveryGeneration: 2 }, { executionContractFingerprint: learningFingerprint("wrong-contract") },
    { evaluator: { name: "other", version: "2" } }, { packetRef: { ...b.packetRef, fingerprint: learningFingerprint("wrong-packet") }, packetFingerprint: learningFingerprint("wrong-packet") }])
    await assert.rejects(selectRecoverySuccessorBinding(f.root, { ...b, ...patch }, { revalidate: async () => {} }));
  const first = await selectRecoverySuccessorBinding(f.root, b, { revalidate: async () => {} });
  assert.deepEqual(await selectRecoverySuccessorBinding(f.root, clone(b), { revalidate: async () => {} }), first);
  for (const patch of [{ selectedAt: later }, { successorRunId: randomUUID() }])
    await assert.rejects(selectRecoverySuccessorBinding(f.root, { ...b, ...patch }, { revalidate: async () => {} }), /Conflicting/);
  assert.equal((await files(bindingDir(f))).length, 1); assert.equal((await files(runDir(f))).length, 2);
});

test("C7-B clock/controller/policy changes reuse the selected target and pre-run gates remain fresh", async t => {
  const f = await committed(t), first = await register(f).materialize(f.admissionRef);
  const second = await register(f, { controller: { ...f.admission.controller, incarnation: "new-controller" },
    policy: { ...f.admission.policy, maxRecoveryAdmissions: 2 }, now: () => later,
    reconciliation: { inspect: async () => ({ ...f.admission.reconciliation, observedAt: later }) },
    resources: { inspect: async () => ({ ...f.admission.resources, observedAt: later }) } }).materialize(f.admissionRef);
  assert.deepEqual(second, first);
  const g = await committed(t); let allowed = true;
  const runs = new FileEvaluationRunStore({ ...g.options, packets: { get: async () => g.packet }, beforePublish: async () => { allowed = false; } });
  await assert.rejects(register(g, { runs, isAuthorized: () => allowed }).materialize(g.admissionRef), /Unauthorized/);
  assert.equal((await files(bindingDir(g))).length, 1); assert.equal((await files(runDir(g))).length, 2);
  const selected = await new FileRecoverySuccessorBindingStore(g.options).find(g.admissionRef);
  assert.equal((await register(g).materialize(g.admissionRef)).run.runId, selected!.binding.successorRunId);
});

test("C7-B ordinary creation cannot take the run slot reserved for an admitted target", async t => {
  const f = await committed(t);
  const { MAX_EVALUATION_RUNS_V1 } = await import("../src/evaluation-run-store.ts");
  // Leave exactly the admission's one run slot. All unrelated records are valid immutable v1 roots.
  for (let i = 1; i < MAX_EVALUATION_RUNS_V1 - 1; i++) {
    const run = { ...f.created, runId: randomUUID() };
    await writeFile(join(runDir(f), `${run.runId}.created.json`), canonicalJson({ schemaVersion: 1, run, fingerprint: learningFingerprint(run) }));
  }
  await assert.rejects(f.runs.publish({ ...f.created, runId: randomUUID() }), /capacity\/reservations/);
  const materialized = await register(f).materialize(f.admissionRef);
  assert.equal(materialized.run.status, "created"); assert.equal((await files(runDir(f))).filter(n => n.endsWith(".created.json")).length, MAX_EVALUATION_RUNS_V1);
});

test("C7-B ordinary execution cannot consume reserved authority capacity or publish running first", async t => {
  const f = await committed(t), created = { ...f.created, runId: randomUUID() };
  await f.runs.publish(created);
  const { MAX_EXECUTION_AUTHORITIES_V1 } = await import("../src/evaluation-execution-authority-store.ts");
  const { executionAuthoritySnapshot } = await import("../src/evaluation-stale-confirmation.ts");
  assert.equal(f.origin.record.kind, "owned");
  for (let i = 1; i < MAX_EXECUTION_AUTHORITIES_V1 - 1; i++) {
    const runId = randomUUID(), s = executionAuthoritySnapshot({ ...f.origin.record, runningRef: { ...f.origin.record.runningRef, runId } } as never);
    await writeFile(join(f.authorityDir, `${runId}.${s.ref.fingerprint.slice(7)}.json`), canonicalJson({ schemaVersion: 1, record: s.record, fingerprint: s.ref.fingerprint }));
  }
  await assert.rejects(f.runs.claimExecution(created, selectedAt), /capacity\/reservations/);
  assert.equal((await f.runs.getCurrent(f.admission.binding.projectId, created.runId)).status, "created");
  await assert.rejects(f.authorities.getCurrent(f.admission.binding.projectId, created.runId), /Missing/);
});

test("C7-B ordinary lease publication cannot consume the admitted target's reserved lease slot", async t => {
  const f = await committed(t), created = { ...f.created, runId: randomUUID() };
  await f.runs.publish(created); const claim = await f.runs.claimExecution(created, selectedAt);
  const { MAX_EXECUTION_LEASE_SNAPSHOTS_V1 } = await import("../src/evaluation-execution-lease-store.ts");
  const { ref: _, ...origin } = f.lease;
  for (let i = 1; i < MAX_EXECUTION_LEASE_SNAPSHOTS_V1 - 1; i++) {
    const runId = randomUUID(), content = { ...origin, lease: { ...origin.lease, runId }, runningRef: { ...origin.runningRef, runId } }, fingerprint = learningFingerprint(content);
    await writeFile(join(f.dir, `${runId}.${fingerprint.slice(7)}.json`), canonicalJson({ ...content, fingerprint }));
  }
  await assert.rejects(f.store.createLease(claim, "unrelated-worker"), /capacity/);
  await assert.rejects(f.store.getCurrent(f.admission.binding.projectId, created.runId), /Missing/);
});
