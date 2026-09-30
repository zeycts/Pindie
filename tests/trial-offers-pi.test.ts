import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerConfiguredPindieExtension } from "../src/extension.ts";
import { TrialOffers } from "../src/trial-offers.ts";
import { FileTrialOfferStore } from "../src/trial-offer-store.ts";
import { getProjectId } from "../src/store.ts";
import { hypothesisFingerprint } from "../src/learning-v1-contract.ts";

test("T1 real Pi never waits for a slow offer or injects it after first context; tools/calls/transcript unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-t1-pi-"));
  try {
    const results: { calls: number; tools: string[]; contexts: string[] }[] = [];
    for (const offerable of [false, true]) {
      const cwd = join(root, offerable ? "offered" : "ordinary"), agentDir = join(cwd, "agent"), projectsBaseDir = join(cwd, "projects"), globalBaseDir = join(cwd, "global");
      await mkdir(agentDir, { recursive: true });
      const projectId = getProjectId(cwd);
      const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "check-first", kind: "approach" as const,
        lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check the smallest affected surface first", useWhen: ["Local edits"], avoidWhen: [],
        expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed relevant tests"], trialHints: [],
        sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
      const hypothesis = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
      let releaseOffer!: () => void;
      const blockedOffer = new Promise<void>((resolve) => { releaseOffer = resolve; });
      const offers = new TrialOffers(new FileTrialOfferStore({ projectsBaseDir }), { readOpen: async () => {
        if (offerable) await blockedOffer;
        return offerable ? [hypothesis] : [];
      } });
      let observerWork: Promise<void> | undefined;
      const faux = fauxProvider({ provider: `trial-t1-${randomUUID()}` });
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
        extensionFactories: [(pi) => {
          const integration = registerConfiguredPindieExtension(pi, { storageRoots: { projectsBaseDir, globalBaseDir }, trialOffers: offers,
            resolveProjectRoot: async () => cwd, subscriptionUsageProvider: { fetchUsage: async () => null } });
          const notify = integration.runtime.onWorkEpisodeOpened!;
          integration.runtime.onWorkEpisodeOpened = (...args) => { observerWork = notify(...args); return observerWork; };
        }] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
      try {
        await session.bindExtensions({});
        const contexts: string[] = [];
        faux.setResponses([
          (ctx) => { contexts.push(JSON.stringify(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Human Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
          (ctx) => { releaseOffer(); contexts.push(JSON.stringify(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
          (ctx) => { contexts.push(JSON.stringify(ctx)); return fauxAssistantMessage("Blocked on the Human dependency."); },
        ]);
        await session.prompt("Do the real Human Task and record its dependency.");
        await observerWork;
        assert.equal(faux.state.callCount, 3);
        assert.equal(contexts[0]!.includes("PINDIE_EXPERIMENTAL_TRIAL"), false);
        for (const context of contexts.slice(1)) {
          assert.equal((context.match(/<PINDIE_EXPERIMENTAL_TRIAL>/g) ?? []).length, 0);
        }
        assert.equal(JSON.stringify(session.sessionManager.getBranch()).includes("PINDIE_EXPERIMENTAL_TRIAL"), false);
        results.push({ calls: faux.state.callCount, tools: session.getActiveToolNames(), contexts });
      } finally { releaseOffer(); await observerWork; session.dispose(); }
    }
    assert.equal(results[0]!.calls, results[1]!.calls);
    assert.deepEqual(results[0]!.tools, results[1]!.tools);
  } finally { await rm(root, { recursive: true, force: true }); }
});
