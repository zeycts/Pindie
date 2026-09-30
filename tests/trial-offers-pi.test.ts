import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { registerConfiguredPindieExtension } from "../src/extension.ts";
import { TrialOffers } from "../src/trial-offers.ts";
import { FileTrialOfferStore } from "../src/trial-offer-store.ts";
import { D2OpenHypothesisReader } from "../src/open-hypotheses.ts";
import { trialEligibilityObserver } from "../src/trial-eligibility-watch.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { hypothesisFingerprint, type StrategyHypothesis } from "../src/learning-v1-contract.ts";
import { DEFAULT_TRIAL_OFFER_POLICY } from "../src/trial-offer-contract.ts";
import { createTrustedStrategyPortfolioForProjectId, trustedPortfolioFingerprint } from "../src/strategy-portfolio.ts";
import { createPromotedStrategyRevisionCatalog } from "../src/strategy-decisions.ts";
import { reduceState } from "../src/transitions.ts";
import { EMPTY_STATE } from "../src/state.ts";

async function fixture(options: { offerable?: boolean; blocked?: Promise<void>; active?: boolean; revision?: boolean; holdPreparation?: boolean; boundaryChange?: "lineage" | "trust" } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pindie-t1-pi-")), agentDir = join(cwd, "agent"), projectsBaseDir = join(cwd, "projects"), globalBaseDir = join(cwd, "global");
  await mkdir(agentDir, { recursive: true });
  const projectId = getProjectId(cwd);
  let trust = createTrustedStrategyPortfolioForProjectId(projectId, createPromotedStrategyRevisionCatalog([]));
  const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: options.revision ? "direct-action" : "check-first", kind: "approach" as const,
    lineage: options.revision ? "revise" as const : "new" as const, parent: null,
    baseRevisionFingerprint: options.revision ? trust.entries.find((e) => e.strategyId === "direct-action")!.revisionFingerprint : null,
    summary: "Check the smallest affected surface first", useWhen: ["Local edits"], avoidWhen: [], expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed relevant tests"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const h = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  let open: readonly StrategyHypothesis[] = options.offerable === false ? [] : [h];
  const store = new FileTrialOfferStore({ projectsBaseDir });
  let published!: () => void, failed!: (error: unknown) => void, releasePreparation!: () => void;
  const publication = new Promise<void>((resolve, reject) => { published = resolve; failed = reject; });
  void publication.catch(() => undefined);
  const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
  let preparationReturned = false;
  const reserve = store.reserve.bind(store);
  store.reserve = async (projectId, now, select, signal, isCurrent, onReserved) => {
    try {
      const reservation = await reserve(projectId, now, select, signal, isCurrent, (r) => {
        onReserved?.(r); // TrialOffers caches readiness at this exact durable publication event.
        published();
      });
      if (!reservation) failed(new Error("Positive fixture did not publish a scheduling hold"));
      if (options.holdPreparation) await preparationGate;
      preparationReturned = true;
      return reservation;
    } catch (error) { failed(error); throw error; }
  };
  const claims: ReturnType<TrialOffers["claim"]>[] = [];
  const offers = new TrialOffers(store, new D2OpenHypothesisReader({ list: async () => { await options.blocked; return open; } },
    { readProjectId: async () => trust }, trialEligibilityObserver(projectsBaseDir, globalBaseDir)), { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1000, cooldownMs: 0 });
  const claim = offers.claim.bind(offers);
  offers.claim = (...args) => { const ready = claim(...args); claims.push(ready); return ready; };
  if (options.active) {
    const result = reduceState(EMPTY_STATE, { type: "start_task", goal: "Preexisting real Task", constraints: [], successCriteria: ["done"] });
    assert.ok(result.ok); await new FileStateStore({ baseDir: projectsBaseDir }).save(cwd, result.state);
  }
  // Positive fixtures model a hold published BEFORE the model issues its Task tool.
  // Synchronize that prerequisite on publication, not token rate, elapsed time or
  // offers.settled(). The native Task dispatch and immediate continuation never wait.
  // Slow/empty fixtures deliberately do not synchronize and must remain nonblocking.
  const faux = fauxProvider({ provider: `trial-t1-${randomUUID()}` });
  const setResponses = faux.setResponses.bind(faux);
  faux.setResponses = (responses) => setResponses(responses.map((response, index) =>
    index === 0 && !options.blocked && options.offerable !== false ? async (...args) => {
      await publication;
      return typeof response === "function" ? response(...args) : response;
    } : response));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider); await modelRuntime.refresh({ allowNetwork: false });
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    extensionFactories: [(pi) => { registerConfiguredPindieExtension(pi, { storageRoots: { projectsBaseDir, globalBaseDir }, trialOffers: offers,
      resolveProjectRoot: async () => cwd, subscriptionUsageProvider: { fetchUsage: async () => null } });
      if (options.boundaryChange) pi.on("tool_result", async (event) => { if (event.toolName === "pindie_task_start") await change(options.boundaryChange!); });
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
  await session.bindExtensions({});
  const change = async (kind: "lineage" | "trust") => {
    if (kind === "lineage") open = [h, { ...h, id: randomUUID(), summary: "Competing open revision", fingerprint: hypothesisFingerprint({ ...semantic, summary: "Competing open revision" }) }];
    else {
      const entries = trust.entries.filter((e) => e.strategyId !== "direct-action");
      trust = { ...trust, entries, resolvedEntries: trust.resolvedEntries.filter((e) => e.manifest.strategyId !== "direct-action"), fingerprint: trustedPortfolioFingerprint(projectId, entries) };
    }
    // A real storage change delivers invalidation before the next continuation; no offer-settlement wait.
    const dir = join(projectsBaseDir, projectId, "learning-v1", "hypotheses");
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${"a".repeat(64)}.json.${randomUUID()}.tmp`), "changed eligibility\n");
  };
  return { session, faux, offers, h, claims, change, releasePreparation, preparationReturned: () => preparationReturned,
    async close() { releasePreparation(); offers.dispose(); session.dispose(); await offers.settled(); await rm(cwd, { recursive: true, force: true, maxRetries: 5 }); } };
}
const blocks = (ctx: unknown) => (JSON.stringify(ctx).match(/<PINDIE_EXPERIMENTAL_TRIAL>/g) ?? []).length;

test("T1 ten real Pi start/replace continuations reach the advisory without waiting for offer settlement", async () => {
  for (let i = 0; i < 10; i++) {
    const f = await fixture({ active: i % 2 === 1, holdPreparation: true });
    try {
      const seen: number[] = [];
      f.faux.setResponses([
        (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage(fauxToolCall(i % 2 ? "pindie_task_replace" : "pindie_task_start", { goal: "Real Human Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
        (ctx) => {
          seen.push(blocks(ctx));
          assert.equal(f.preparationReturned(), false, "continuation must reach published readiness before preflight returns");
          assert.ok(f.claims[0], "the Task must synchronously claim the published hold");
          f.releasePreparation();
          return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" });
        },
        (ctx) => { assert.equal(blocks(ctx), 1); return fauxAssistantMessage("Blocked on the Human dependency."); },
      ]);
      await f.session.prompt("Start or replace the real Human Task.");
      assert.deepEqual(seen, [0, 1], `iteration ${i}: native immediate continuation lost readiness`);
      assert.equal(f.faux.state.callCount, 3);
      assert.equal(JSON.stringify(f.session.sessionManager.getBranch()).includes("PINDIE_EXPERIMENTAL_TRIAL"), false);
    } finally { await f.close(); }
  }
});

test("T1 real Pi slow preflight never delays Task work or retro-injects after the first context", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const f = await fixture({ blocked });
  try {
    const seen: number[] = [];
    f.faux.setResponses([
      (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Human Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
      (ctx) => { release(); seen.push(blocks(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage("Blocked on the Human dependency."); },
    ]);
    await f.session.prompt("Do the real Task and record its dependency.");
    assert.deepEqual(seen, [0, 0, 0]); assert.equal(f.faux.state.callCount, 3);
    f.faux.setResponses([(ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("Continuing the same occurrence."); }]);
    await f.session.prompt("Continue this Task.");
  } finally { release(); await f.close(); }
});

test("T1 ready assignment is synchronously invalidated by native abort and a new Human Run", async () => {
  const f = await fixture();
  try {
    let entered!: () => void; const reached = new Promise<void>((r) => { entered = r; });
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Human Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      (ctx) => { assert.equal(blocks(ctx), 1); entered(); return fauxAssistantMessage("Working."); },
    ]);
    const work = f.session.prompt("Start the Task."); await reached; await f.session.abort(); await work;
    f.faux.setResponses([(ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("Reassessing after Human preemption."); }]);
    await f.session.prompt("Stop the previous attempt; reassess the Task.");
  } finally { await f.close(); }
});

for (const kind of ["lineage", "trust"] as const) test(`T1 real Pi cached advisory fails closed on current ${kind} invalidation`, async () => {
  const f = await fixture({ revision: kind === "trust" });
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      async (ctx) => { assert.equal(blocks(ctx), 1); await f.change(kind); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("Continuing without stale advice."); },
    ]);
    await f.session.prompt("Do the real Task.");
    f.faux.setResponses([(ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("No revival."); }]);
    await f.session.prompt("Continue the existing Task.");
  } finally { await f.close(); }
});

for (const kind of ["lineage", "trust"] as const) test(`T1 real Pi invalidates an already-claimed ${kind} snapshot BEFORE the first continuation`, async () => {
  const f = await fixture({ revision: kind === "trust", boundaryChange: kind });
  try {
    const seen: number[] = [];
    f.faux.setResponses([
      (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
      (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { seen.push(blocks(ctx)); return fauxAssistantMessage("No stale hypothesis was injected."); },
    ]);
    await f.session.prompt("Do the real Task.");
    assert.ok(f.claims[0], "regression must invalidate actual ready advice, not pass vacuously with no preparation");
    assert.deepEqual(seen, [0, 0, 0]);
  } finally { await f.close(); }
});

test("T1 real Pi Human steering removes a ready lease within the SAME Run", async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      async (ctx) => { assert.equal(blocks(ctx), 1); await f.session.steer("Stop using the previous experimental advice.");
        return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("Continuing under the new Human instruction."); },
    ]);
    await f.session.prompt("Do the real Task.");
    assert.equal(f.faux.state.callCount, 3);
  } finally { await f.close(); }
});

test("T1 no open hypothesis keeps native Pi contexts and tools free of experimental additions", async () => {
  const f = await fixture({ offerable: false });
  try {
    const tools = f.session.getActiveToolNames();
    f.faux.setResponses([
      (ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Ordinary Task", successCriteria: ["done"] }), { stopReason: "toolUse" }); },
      (ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }); },
      (ctx) => { assert.equal(blocks(ctx), 0); return fauxAssistantMessage("Ordinary work."); },
    ]);
    await f.session.prompt("Start ordinary work.");
    assert.equal(f.faux.state.callCount, 3);
    assert.deepEqual(f.session.getActiveToolNames().filter((n) => n.includes("trial")), tools.filter((n) => n.includes("trial")));
    assert.equal(JSON.stringify(f.session.sessionManager.getBranch()).includes("PINDIE_EXPERIMENTAL_TRIAL"), false);
  } finally { await f.close(); }
});
