import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPindieHost } from "../src/host.ts";
import { getProjectId, FileStateStore } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { assembleRunExperience } from "../src/run-experience.ts";
import { FileRunExperienceStore, FileRunExperienceReader } from "../src/experience-store.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
import { FileDiscoveryReceiptStore } from "../src/discovery-receipts.ts";
import { FileDiscoveryPacketStore } from "../src/discovery-packets.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { buildProjectDiscoveryPacket, enqueueProjectDiscovery } from "../src/project-discovery.ts";
import { validateDiscoveryPacket, DEFAULT_PROJECT_DISCOVERY_POLICY } from "../src/discovery-contract.ts";
import { matchesLearningJobOutput } from "../src/learning-v1-contract.ts";

const ROOT = "/repo/discovery"; const id = getProjectId(ROOT);
async function setup(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "discovery-d1-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const projects = join(dir, "projects"), global = join(dir, "global");
  const runtime = new PindieRuntime(new FileStateStore({ baseDir: projects }));
  await runtime.load(ROOT);
  await runtime.dispatch({ type: "start_task", goal: "goal", constraints: [], successCriteria: ["done"] });
  const store = new FileRunExperienceStore({ baseDir: projects });
  const reader = new FileRunExperienceReader({ baseDir: projects });
  const portfolio = new FileProjectTrustedStrategyPortfolioReader({ projectsBaseDir: projects, globalBaseDir: global });
  const receipts = new FileDiscoveryReceiptStore({ projectsBaseDir: projects });
  const packets = new FileDiscoveryPacketStore(projects);
  const jobs = new FileLearningJobLedger({ globalBaseDir: global });
  const deps = { reader, portfolio, receipts, packets, jobs };
  const add = async (index: number, schema: 4 | 5 = 5, episode = randomUUID()) => {
    const record = assembleRunExperience({ task: runtime.state.task!, runStart: { taskStatus: "active", taskGoal: "goal" },
      snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false,
        hasQuestions: false, completionReady: false, taskRelation: "preexisting_untouched", completionRelation: "not_completed", gateRelation: "none" },
      policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
      execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: index % 2, deniedCalls: 0 },
      durationMs: 1, cost: 0, recordedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ...(schema === 5 ? { workEpisodeId: episode } : {}),
    });
    // Outcome diversity is factual and validated: active/pending vs active/failed verification.
    const experience = index % 2 ? { ...record, outcome: { ...record.outcome, verificationStatus: "failed" as const } } : record;
    await store.save(ROOT, experience);
    return experience;
  };
  return { dir, projects, global, deps, add, store };
}
test("D1 legacy v4-only evidence never triggers, v5 deterministic packet/job survives restart", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 137; i++) await f.add(i, 4);
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  for (let i = 0; i < 6; i++) await f.add(i);
  const packet = await buildProjectDiscoveryPacket(id, f.deps);
  assert.ok(packet && validateDiscoveryPacket(packet));
  const key = await enqueueProjectDiscovery(id, f.deps);
  assert.ok(key);
  assert.equal((await f.deps.jobs.read()).length, 1);
  const restarted = { ...f.deps, reader: new FileRunExperienceReader({ baseDir: f.projects }),
    receipts: new FileDiscoveryReceiptStore({ projectsBaseDir: f.projects }), packets: new FileDiscoveryPacketStore(f.projects),
    jobs: new FileLearningJobLedger({ globalBaseDir: f.global }) };
  assert.deepEqual(await buildProjectDiscoveryPacket(id, restarted), packet);
  assert.equal(await enqueueProjectDiscovery(id, restarted), key);
  assert.deepEqual(await restarted.packets.read(id, packet.fingerprint), packet);
  assert.equal((await restarted.jobs.read()).length, 1);
  await f.add(7);
  assert.notEqual(await enqueueProjectDiscovery(id, restarted), key);
  assert.equal((await restarted.jobs.read()).length, 2);
});
test("D1 duplicates, terminal receipt and cancellation without receipt", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) await f.add(i);
  const duplicate = await f.add(5, 5, "00000000-0000-4000-8000-000000000001");
  await f.store.save(ROOT, duplicate);
  const packet = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(packet.eligibleCounts.new, 6);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const claimed = (await f.deps.jobs.claim(key, "test", Date.now(), 1000, 0, 0))!;
  await f.deps.jobs.cancel(key, claimed.leaseToken, "retry-exhausted");
  assert.equal((await buildProjectDiscoveryPacket(id, f.deps))?.fingerprint, packet.fingerprint);
  assert.equal(await enqueueProjectDiscovery(id, f.deps), key);
  const receipt = await f.deps.receipts.publish(packet, "none", []);
  assert.deepEqual(await f.deps.receipts.publish(packet, "none", []), receipt);
  await assert.rejects(f.deps.receipts.publish(packet, "covered", []));
  const ref = { schemaVersion: 1 as const, family: "discovery-receipt" as const, scope: receipt.scope, id: receipt.id, fingerprint: receipt.fingerprint };
  assert.deepEqual(await f.deps.receipts.resolve(ref, key, packet.fingerprint), receipt);
  assert.equal(matchesLearningJobOutput({ ...claimed, state: "completed", leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminalReceiptRef: ref }, receipt), true);
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null);
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
});
test("D1 Host startup enqueue does not start a model or change the Human Session surface", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const cwd = join(f.dir, "project"), agentDir = join(f.dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const target = join(f.projects, getProjectId(cwd), "experience");
  await mkdir(target, { recursive: true });
  for (const name of await readdir(join(f.projects, id, "experience")))
    await copyFile(join(f.projects, id, "experience", name), join(target, name));
  const host = await createPindieHost({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd),
    storageRoots: { projectsBaseDir: f.projects, globalBaseDir: f.global },
    env: { PINDIE_BROWSER_ENABLED: "false" },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  try {
    const before = host.runtime.activeSession.getActiveToolNames();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(host.runtime.activeSession.getActiveToolNames(), before);
    assert.deepEqual(host.runtime.activeSession.messages, []);
    assert.equal((await f.deps.jobs.read()).length, 1);
    assert.equal((await f.deps.jobs.read())[0]?.state, "pending");
  } finally { await host.dispose(); }
});
test("D1 bounds and corrupted evidence/portfolio/receipt fail closed without blocking save",  async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 75; i++) await f.add(i);
  const packet = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(packet.sources.length, DEFAULT_PROJECT_DISCOVERY_POLICY.maxCorpus);
  assert.deepEqual(await buildProjectDiscoveryPacket(id, f.deps), packet);
  const path = join(f.projects, id, "experience");
  await writeFile(join(path, `${randomUUID()}.json`), "{broken");
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  await f.add(76); // normal Experience unaffected
  assert.equal((await f.deps.reader.readProjectId(id)).loadedRecords, 76);
  const corruptPortfolio = { ...f.deps, portfolio: { readProjectId: async () => ({ ...await f.deps.portfolio.readProjectId(id), fingerprint: "sha256:" + "0".repeat(64) }) } };
  assert.equal(await enqueueProjectDiscovery(id, corruptPortfolio), null);
  const receiptsPath = join(f.projects, id, "learning-v1", "discovery-receipts.json");
  await mkdir(join(f.projects, id, "learning-v1"), { recursive: true });
  await writeFile(receiptsPath, "{broken");
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  assert.equal((await f.deps.jobs.read()).length, 0);
});
