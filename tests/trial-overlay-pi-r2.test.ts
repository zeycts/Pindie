import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerConfiguredPindieExtension, type PindieExtensionOptions } from "../src/extension.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { legacyHypothesis, legacyPublication } from "./legacy-learning-payload.ts";

// Deliberately inject old JS fields without restoring them to the public API.
// Composition must still discard them without activation or getter access.
type LegacyInjections = Partial<PindieExtensionOptions> & Record<string, unknown>;

const hasAdvisory = (ctx: unknown) => JSON.stringify(ctx).includes("<PINDIE_EXPERIMENTAL_TRIAL>");
const task = (goal = "Human work") => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal, successCriteria: ["done"] }), { stopReason: "toolUse" });
const progress = () => fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" });
async function fixture(t: any, kind: "approach" | "modifier" = "approach", options: LegacyInjections = {}, deleteAdvisory = false) {
  const cwd = await mkdtemp(join(tmpdir(), "r2-native-pi-")), agentDir = join(cwd, "agent"), projectsBaseDir = join(cwd, "projects"), globalBaseDir = join(cwd, "global"), projectId = getProjectId(cwd);
  await mkdir(agentDir);
  const h = legacyHypothesis(projectId, kind);
  const publish = async () => {
    const dir = join(projectsBaseDir, projectId, "learning-v1", "hypotheses"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${h.discoveryPacketFingerprint.slice(7)}.json`), JSON.stringify(legacyPublication(h)));
  };
  const faux = fauxProvider({ provider: `r2-${randomUUID()}` });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const diagnostics: unknown[] = [];
  let integration!: ReturnType<typeof registerConfiguredPindieExtension>;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    extensionFactories: [(pi) => {
      integration = registerConfiguredPindieExtension(pi, { storageRoots: { projectsBaseDir, globalBaseDir }, featureSelection: { selfImprovement: true, crossProjectLearning: false }, resolveProjectRoot: async () => cwd,
        subscriptionUsageProvider: { fetchUsage: async () => null }, ...{ trialAssignmentPolicy: { cooldownMs: 0, operationTimeoutMs: 1000 }, trialDiagnostic: (d: unknown) => diagnostics.push(d) }, ...options });
      if (deleteAdvisory) pi.on("context_with_system", (event) => ({ messages: event.messages.filter((m) => !hasAdvisory(m)) }));
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
  const extensionErrors: unknown[] = [];
  await session.bindExtensions({ onError: (e) => { extensionErrors.push(e); } });
  t.after(() => assert.deepEqual(extensionErrors, []));
  let liveSession = session;
  const reopen = async () => {
    await liveSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); liveSession.dispose();
    await loader.reload();
    const next = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
    liveSession = next.session;
    await liveSession.bindExtensions({ onError: (e) => { extensionErrors.push(e); } });
    return liveSession;
  };
  t.after(async () => { try { await liveSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { liveSession.dispose(); await rm(cwd, { recursive: true, force: true, maxRetries: 5 }); } });
  const selector = { strategyId: h.logicalId, revisionIdentity: h.id, revisionFingerprint: h.fingerprint };
  const select = () => fauxAssistantMessage(fauxToolCall("pindie_policy_set", kind === "approach" ? { approach: selector } : { approach: "direct-action", modifiers: [selector] }), { stopReason: "toolUse" });
  const experiences = async () => {
    try { return await readdir(join(projectsBaseDir, projectId, "experience")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  };
  const assignments = async () => { try { return (await readdir(join(projectsBaseDir, projectId, "learning-v1", "trial-assignments-v2"))).filter((v) => v.endsWith(".json")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } };
  const evidence = async () => {
    const dir = join(projectsBaseDir, projectId, "learning-v1", "trial-evidence-v2");
    let names: string[];
    try { names = await readdir(dir); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    return Promise.all(names.sort().map(async (name) => ({ name, bytes: await readFile(join(dir, name), "utf8") })));
  };
  return { session, faux, publish, h, select, experiences, assignments, evidence, diagnostics, integration, cwd, projectsBaseDir, reopen };
}

for (const failure of ["save", "no-ref", "source", "evidence"] as const) test(`native Pi retired ${failure} dependency cannot alter Task truth or fabricate evidence`, async (t) => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let retiredCalls = 0;
  const options: LegacyInjections = failure === "evidence" ? {} : failure === "source" ? {
    experienceStore: { save: async () => { retiredCalls += 1; throw new Error("retired source callback must not execute"); } },
  } : { experienceStore: { save: async () => { retiredCalls += 1; if (failure === "save") throw new Error("Injected save failure"); } } };
  f = await fixture(t, "approach", options);
  await f.publish();
  if (failure === "evidence") {
    const dir = join(f.projectsBaseDir, getProjectId(f.cwd), "learning-v1", "trial-evidence-v2");
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${randomUUID()}.json`), "null");
  }
  const historicalEvidence = await f.evidence();
  f.faux.setResponses([task(), f.select(), progress(), fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start real work.");
  assert.deepEqual(f.integration.runtime.state.task!.openLoops.blockers, ["Human dependency"]);
  assert.equal((await f.assignments()).length, 0);
  assert.deepEqual(await f.experiences(), []);
  assert.equal("policySnapshot" in f.integration, false);
  assert.deepEqual(await f.evidence(), historicalEvidence, "even corrupt historical bytes stay untouched; no retired reader executes");
  assert.equal(retiredCalls, 0, "retired callback is never invoked, even best-effort");
});

test("native Pi replacement preserves Task identity boundaries without Trial placement", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([task(), progress(), fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start real work.");
  await f.publish();
  const replace = () => fauxAssistantMessage(fauxToolCall("pindie_task_replace", { goal: "Replacement work", successCriteria: ["done"] }), { stopReason: "toolUse" });
  f.faux.setResponses([(ctx) => { assert.equal(hasAdvisory(ctx), false); return replace(); }, progress(), fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Replace it with a different task.");
  assert.equal(f.integration.runtime.state.task?.goal, "Replacement work");
  assert.deepEqual(await f.assignments(), []);
  assert.deepEqual(await f.experiences(), []);
  assert.deepEqual(await f.evidence(), []);
  f.faux.setResponses([(ctx) => { assert.equal(hasAdvisory(ctx), false); return progress(); }, fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Continue replacement.");
  assert.equal(f.integration.runtime.state.task?.goal, "Replacement work");
  assert.deepEqual(await f.assignments(), []);
});

test("native Pi failed task_start leaves authority usable for the next valid Task", async (t) => {
  const f = await fixture(t); await f.publish();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Invalid definition", successCriteria: [] }), { stopReason: "toolUse" }),
    (ctx) => { assert.equal(f.integration.runtime.state.task, null); assert.equal(hasAdvisory(ctx), false); return task(); },
    (ctx) => { assert.equal(hasAdvisory(ctx), false); return progress(); }, fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start work.");
  assert.equal(f.integration.runtime.state.task?.goal, "Human work");
  assert.deepEqual(await f.assignments(), []);
});

test("R2 native Pi SI disabled never accesses assignment/hypothesis seams", async (t) => {
  const fail = async (): Promise<never> => { throw new Error("R2 must be absent"); };
  const f = await fixture(t, "approach", { featureSelection: { selfImprovement: false, crossProjectLearning: false },
    trialAssignmentStore: { assignIfAbsent: fail, readExact: fail }, trialHypothesisReader: { readOpen: fail } });
  await f.publish(); f.faux.setResponses([task(), (ctx) => { assert.equal(hasAdvisory(ctx), false); return progress(); }, fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start work."); assert.equal((await f.assignments()).length, 0); assert.deepEqual(f.diagnostics, []);
});

test("R2 native Pi null/ambiguous episode never schedules", async (t) => {
  const f = await fixture(t, "approach", { workEpisodes: { reconcile: async () => null, prepared: async () => {}, committed: async () => null, current: async () => null } });
  await f.publish(); f.faux.setResponses([task(), (ctx) => { assert.equal(hasAdvisory(ctx), false); return progress(); }, fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start real work."); assert.equal((await f.assignments()).length, 0);
});

test("native Pi external State epoch remains authoritative while retired Policy stays unavailable", async (t) => {
  const f = await fixture(t); await f.publish();
  f.faux.setResponses([task(), async (ctx) => {
    assert.equal(hasAdvisory(ctx), false);
    const state = structuredClone(f.integration.runtime.state); state.task!.goal = "External replacement";
    await new FileStateStore({ baseDir: f.projectsBaseDir }).save(f.cwd, state);
    await f.integration.core.run.refreshAuthoritativeState();
    return f.select();
  }, (ctx) => { assert.equal(hasAdvisory(ctx), false); return progress(); }, fauxAssistantMessage("Blocked.")]);
  await f.session.prompt("Start real work."); assert.equal((await f.assignments()).length, 0);
  assert.equal(f.integration.runtime.state.task?.goal, "External replacement");
  const policyResult = f.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pindie_policy_set");
  assert.ok(policyResult && policyResult.type === "message" && policyResult.message.role === "toolResult" && policyResult.message.isError);
  assert.deepEqual(await f.experiences(), [], "no Experience files, not a vacuous Policy projection");
  assert.deepEqual(await f.evidence(), []);
});
