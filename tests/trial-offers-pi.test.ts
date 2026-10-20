import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerConfiguredPindieExtension } from "../src/extension.ts";
import { legacyTrialFixture } from "./fixtures/trial-v1.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { FileRunExperienceReader } from "../src/experience-store.ts";
import { hypothesisFingerprint, learningFingerprint } from "../src/learning-v1-contract.ts";

async function artifactBytes(dir: string): Promise<Record<string, string>> {
  let names: string[];
  try { names = await readdir(dir, { recursive: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const files: Record<string, string> = {};
  for (const name of names.sort()) {
    try { files[name] = (await readFile(join(dir, name))).toString("base64"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error; }
  }
  return files;
}

for (const legacyHistory of [false, true]) test(`native Pi ordinary work leaves historical Learning inert with an open v1 hypothesis (${legacyHistory ? "existing" : "no"} Trial history)`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pindie-r0-pi-"));
  const agentDir = join(cwd, "agent"), projectsBaseDir = join(cwd, "projects"), globalBaseDir = join(cwd, "global");
  const projectId = getProjectId(cwd), learningDir = join(projectsBaseDir, projectId, "learning-v1");
  const trialDir = join(learningDir, "trial-offers");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "check-first", kind: "approach" as const,
      lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
      summary: "Check the smallest affected surface first", useWhen: ["Local edits"], avoidWhen: [], expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed relevant tests"], trialHints: [],
      sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
    const h = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
    const ref = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope: h.scope, id: h.id, fingerprint: h.fingerprint };
    // Persist exact historical bytes without constructing retired readers.
    const content = { schemaVersion: 2, packetFingerprint: h.discoveryPacketFingerprint, outcome: "published", refs: [ref], newHypotheses: [h],
      modelIdentity: { provider: "faux", modelId: "discovery", thinkingLevel: "off" } };
    const hypothesisDir = join(learningDir, "hypotheses");
    await mkdir(hypothesisDir, { recursive: true });
    await writeFile(join(hypothesisDir, `${h.discoveryPacketFingerprint.slice(7)}.json`), JSON.stringify({ ...content, fingerprint: learningFingerprint(content) }));
    const historyPath = join(hypothesisDir, `${h.discoveryPacketFingerprint.slice(7)}.json`);
    assert.deepEqual(JSON.parse(await readFile(historyPath, "utf8")).newHypotheses, [h]);
    if (legacyHistory) {
      const frozen = legacyTrialFixture(projectId, ref);
      await mkdir(trialDir, { recursive: true });
      await writeFile(join(trialDir, `${frozen.commit.assignment.workEpisodeId}.json`), JSON.stringify(frozen.commit));
      await writeFile(join(trialDir, `${frozen.commit.assignment.workEpisodeId}.pending.json`), JSON.stringify(frozen.pending));
    }
    const before = await artifactBytes(trialDir);
    const allLearningBefore = await artifactBytes(learningDir);
    assert.equal(Object.keys(before).length > 0, legacyHistory);
    const faux = fauxProvider({ provider: `trial-r0-${randomUUID()}` });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(pi) => { registerConfiguredPindieExtension(pi, { storageRoots: { projectsBaseDir, globalBaseDir },
        featureSelection: { selfImprovement: true, crossProjectLearning: false },
        resolveProjectRoot: async () => cwd, subscriptionUsageProvider: { fetchUsage: async () => null } }); }] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" }));
    await session.bindExtensions({});
    const assertOrdinaryContext = (ctx: unknown) => assert.ok(!JSON.stringify(ctx).includes("<PINDIE_EXPERIMENTAL_TRIAL>"));
    faux.setResponses([
      (ctx) => { assertOrdinaryContext(ctx); return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Ordinary Human Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
      (ctx) => { assertOrdinaryContext(ctx); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { assertOrdinaryContext(ctx); return fauxAssistantMessage("Blocked on the Human dependency."); },
    ]);
    await session.prompt("Start ordinary work and record its dependency.");
    assert.equal(faux.state.callCount, 3);
    const state = await new FileStateStore({ baseDir: projectsBaseDir }).load(cwd);
    assert.equal(state.task?.goal, "Ordinary Human Task");
    assert.deepEqual(state.task?.openLoops.blockers, ["Human dependency"]);
    await assert.rejects(readFile(join(projectsBaseDir, projectId, "work-episode.json")), { code: "ENOENT" });
    const experience = await new FileRunExperienceReader({ baseDir: projectsBaseDir }).read(cwd);
    assert.equal(experience.records.length, 0);
    faux.setResponses([(ctx) => { assertOrdinaryContext(ctx); return fauxAssistantMessage("Continuing ordinary work."); }]);
    await session.prompt("Continue this Task.");
    assert.deepEqual(await artifactBytes(trialDir), before, "no new assignment, receipt, hold or mutation of historical bytes");
    assert.deepEqual(await artifactBytes(learningDir), allLearningBefore, "all historical Learning bytes are untouched");
    assert.deepEqual(JSON.parse(await readFile(historyPath, "utf8")).newHypotheses, [h], "historical hypotheses remain untouched without a reader");
    assert.ok(!JSON.stringify(session.sessionManager.getBranch()).includes("PINDIE_EXPERIMENTAL_TRIAL"));
  } finally {
    try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally { session?.dispose(); await rm(cwd, { recursive: true, force: true, maxRetries: 5 }); }
  }
});
