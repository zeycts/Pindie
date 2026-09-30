import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { registerConfiguredPindieExtension } from "../src/extension.ts";
import { TrialOffers } from "../src/trial-offers.ts";
import { FileTrialOfferStore } from "../src/trial-offer-store.ts";
import { D2OpenHypothesisReader } from "../src/open-hypotheses.ts";
import { trialEligibilityObserver } from "../src/trial-eligibility-watch.ts";
import { FileRunExperienceReader, FileRunExperienceStore } from "../src/experience-store.ts";
import { FileRunExperienceMaintenance } from "../src/experience-lifecycle.ts";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { hypothesisFingerprint, type StrategyHypothesis } from "../src/learning-v1-contract.ts";
import { DEFAULT_TRIAL_OFFER_POLICY } from "../src/trial-offer-contract.ts";
import { createTrustedStrategyPortfolioForProjectId, trustedPortfolioFingerprint } from "../src/strategy-portfolio.ts";
import { createPromotedStrategyRevisionCatalog } from "../src/strategy-decisions.ts";
import { reduceState } from "../src/transitions.ts";
import { EMPTY_STATE } from "../src/state.ts";

async function fixture(options: { offerable?: boolean; blocked?: Promise<void>; active?: boolean; revision?: boolean; holdPreparation?: boolean; experienceFailure?: boolean; boundaryChange?: "lineage" | "trust"; stripContext?: boolean; publicationFailure?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pindie-t1-pi-")), agentDir = join(cwd, "agent"), projectsBaseDir = join(cwd, "projects"), globalBaseDir = join(cwd, "global");
  await mkdir(agentDir, { recursive: true });
  const projectId = getProjectId(cwd);
  let now = Date.now();
  let trust = createTrustedStrategyPortfolioForProjectId(projectId, createPromotedStrategyRevisionCatalog([]));
  const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: options.revision ? "direct-action" : "check-first", kind: "approach" as const,
    lineage: options.revision ? "revise" as const : "new" as const, parent: null,
    baseRevisionFingerprint: options.revision ? trust.entries.find((e) => e.strategyId === "direct-action")!.revisionFingerprint : null,
    summary: "Check the smallest affected surface first", useWhen: ["Local edits"], avoidWhen: [], expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed relevant tests"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const h = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  let open: readonly StrategyHypothesis[] = options.offerable === false ? [] : [h];
  const store = new FileTrialOfferStore({ projectsBaseDir });
  let failPublication!: () => void;
  if (options.publicationFailure) store.commitReserved = async () => {
    await new Promise<void>((resolve) => { failPublication = resolve; });
    throw new Error("Deterministic finalization failure after render");
  };
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
    { readProjectId: async () => trust }, trialEligibilityObserver(projectsBaseDir, globalBaseDir)), { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1000, cooldownMs: 0 }, () => now);
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
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 10 } }));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  let integration!: ReturnType<typeof registerConfiguredPindieExtension>;
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  const createNativeSession = async (withTrials = true) => {
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(pi) => {
        const registered = registerConfiguredPindieExtension(pi, { storageRoots: { projectsBaseDir, globalBaseDir },
          ...(withTrials ? { trialOffers: offers } : {}),
          ...(options.experienceFailure ? { experienceStore: { save: async () => { throw new Error("Experience fixture save failure"); } } } : {}),
          resolveProjectRoot: async () => cwd, now: () => now, subscriptionUsageProvider: { fetchUsage: async () => null } });
        if (withTrials) integration = registered;
        if (options.stripContext) pi.on("context_with_system", (event) => ({ messages: event.messages.filter((m) =>
          !(m.role === "user" && typeof m.content === "string" && m.content.includes("<PINDIE_EXPERIMENTAL_TRIAL>"))) }));
        if (options.boundaryChange) pi.on("tool_result", async (event) => { if (event.toolName === "pindie_task_start") await change(options.boundaryChange!); });
      }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" });
    sessions.push(session);
    await session.bindExtensions({});
    return session;
  };
  const session = await createNativeSession();
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
  return { session, createNativeSession, faux, offers, h, claims, integration, change, store, cwd, projectsBaseDir, globalBaseDir,
    failPublication: () => failPublication(),
    readExperiences: () => new FileRunExperienceReader({ baseDir: projectsBaseDir }).read(cwd),
    setNow: (value: number) => { now = value; }, releasePreparation, preparationReturned: () => preparationReturned,
    async close() { releasePreparation(); offers.dispose(); sessions.forEach((session) => session.dispose()); await offers.settled(); await rm(cwd, { recursive: true, force: true, maxRetries: 5 }); } };
}
const blocks = (ctx: unknown) => (JSON.stringify(ctx).match(/<PINDIE_EXPERIMENTAL_TRIAL>/g) ?? []).length;
test("T2 real Pi no assignment has identical context content and active tool surface to pre-T2 registration", async () => {
  const f = await fixture({ offerable: false });
  try {
    const baseline = await f.createNativeSession(false);
    const contexts: unknown[] = [];
    const response = (ctx: any) => {
      // Native message timestamps are incidental, not prompt/content bytes.
      contexts.push(ctx.messages.map(({ timestamp: _at, ...message }: any) => message));
      return fauxAssistantMessage("Ordinary response.");
    };
    f.faux.setResponses([response]);
    await baseline.prompt("Identical Human input.");
    const baselineNames = baseline.getActiveToolNames();
    baseline.dispose();
    const withTrials = await f.createNativeSession(true);
    f.faux.setResponses([response]);
    await withTrials.prompt("Identical Human input.");
    assert.deepEqual(contexts[1], contexts[0]);
    assert.deepEqual(withTrials.getActiveToolNames(), baselineNames);
    assert.ok(!JSON.stringify(contexts).includes("pindie_trial_select"));
    assert.ok(!JSON.stringify(withTrials.sessionManager.getBranch()).includes("PINDIE_EXPERIMENTAL_TRIAL"));
  } finally { await f.close(); }
});

const selectionNames = (ctx: unknown) => (getCurrentSystemMessage((ctx as { messages: any[] }).messages)?.toolsAdded ?? [])
  .filter((tool) => tool.name === "pindie_trial_select").map((tool) => tool.name);
const trialFacts = (f: Awaited<ReturnType<typeof fixture>>) => {
  const run = f.integration.core.run;
  return run.trialAttribution.settle({ sessionId: f.session.sessionManager.getSessionId(),
    agentRunGeneration: run.activeAgentRunGeneration!, occurrenceEpoch: f.integration.runtime.taskOccurrenceEpoch },
    (claim) => f.offers.resolvePublished(claim), () => true);
};

for (const decision of ["select", "decline"] as const) test(`T2 real production Pi pulse records ${decision}, duplicate and conflicting declaration without work tax`, async () => {
  const f = await fixture();
  try {
    let id = "";
    f.faux.setResponses([
      (ctx) => {
        assert.deepEqual(selectionNames(ctx), []);
        return fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" });
      },
      (ctx) => {
        assert.deepEqual(selectionNames(ctx), ["pindie_trial_select"]);
        assert.equal(blocks(ctx), 1);
        id = f.claims[0]!.commit.assignment!.id;
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: id, decision }), { stopReason: "toolUse" });
      },
      async () => {
        const facts = await trialFacts(f); assert.equal(facts?.declaration, decision);
        assert.equal(facts?.postSelection.toolCalls, 0);
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: id, decision }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: id, decision: decision === "select" ? "decline" : "select" }), { stopReason: "toolUse" }),
      async () => {
        assert.equal((await trialFacts(f))?.declaration, decision);
        return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" });
      },
      async (ctx) => {
        assert.deepEqual(selectionNames(ctx), ["pindie_trial_select"]);
        const facts = await trialFacts(f); assert.ok(facts);
        assert.equal(facts.postSelection.toolCalls, decision === "select" ? 1 : 0);
        assert.equal(facts.postSelection.consequentialCalls, decision === "select" ? 1 : 0);
        assert.equal(facts.postSelection.toolErrors, 0, "recorder conflicts are not ordinary work errors");
        return fauxAssistantMessage("Waiting for Human input.");
      },
    ]);
    await f.session.prompt("Do the real Task.");
    const saved = await f.readExperiences();
    assert.equal(saved.invalid, 0); assert.equal(saved.unsupportedSchema, 0);
    assert.equal(saved.records.length, 1);
    const experience = saved.records[0]!.experience;
    assert.equal(experience.schemaVersion, 7);
    if (experience.schemaVersion !== 7) assert.fail("Rendered Run must persist conservative v7");
    assert.equal(experience.trialAttempt.delivery, "unknown");
    assert.equal(experience.trialAttempt.declaration, decision);
    assert.equal(experience.trialAttempt.assignmentProposal.id, id);
    assert.equal(experience.trialAttempt.postSelection.toolCalls, decision === "select" ? 1 : 0);
    const results = f.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select");
    assert.deepEqual(results.map((m) => m.role === "toolResult" && Boolean(m.isError)), [false, false, true]);
    assert.ok(!f.session.getActiveToolNames().includes("pindie_trial_select"));
    assert.ok(!JSON.stringify(f.session.messages.filter((m) => m.role === "system")).includes("pindie_trial_select"));
    f.faux.setResponses([(ctx) => {
      assert.deepEqual(selectionNames(ctx), []); assert.equal(blocks(ctx), 0);
      return fauxAssistantMessage("Next Run without exposure.");
    }]);
    await f.session.prompt("Reassess this Task.");
  } finally { await f.close(); }
});

for (const invalidation of ["lineage", "steer", "expiry"] as const) test(`T2 production executable snapshots reject declarations after ${invalidation}`, async () => {
  const f = await fixture();
  try {
    let id = "";
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      async (ctx) => {
        assert.deepEqual(selectionNames(ctx), ["pindie_trial_select"]);
        id = f.claims[0]!.commit.assignment!.id;
        if (invalidation === "lineage") await f.change("lineage");
        if (invalidation === "steer") await f.session.steer("Withdraw the experiment.");
        if (invalidation === "expiry") f.setNow(f.claims[0]!.commit.assignment!.expiresAt);
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: id, decision: "select" }), { stopReason: "toolUse" });
      },
      (ctx) => {
        assert.deepEqual(selectionNames(ctx), []);
        assert.equal(blocks(ctx), 0);
        return fauxAssistantMessage("No stale declaration.");
      },
      () => fauxAssistantMessage("No stale declaration."),
    ]);
    await f.session.prompt("Start real work.");
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select" && m.isError), JSON.stringify(f.session.messages.filter((m) => m.role === "toolResult")));
    assert.ok(!f.session.getActiveToolNames().includes("pindie_trial_select"));
    const partial = (await f.readExperiences()).records[0]!.experience;
    if (partial.schemaVersion !== 7) assert.fail("Preempted/expired partial rendering disappeared");
    assert.equal(partial.trialAttempt.delivery, "unknown");
    assert.equal(partial.trialAttempt.declaration, "none");
    assert.equal(partial.trialAttempt.authorityCurrent, false);
  } finally { await f.close(); }
});

test("T2 Experience save failure cannot roll back committed ordinary Task progress or create a successful Trial record", async () => {
  const f = await fixture({ experienceFailure: true });
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Committed Human dependency"], questions: [] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Waiting for Human input."),
    ]);
    await f.session.prompt("Do real work.");
    assert.deepEqual(f.integration.core.run.authoritativeState?.task?.openLoops.blockers, ["Committed Human dependency"]);
    assert.equal((await f.readExperiences()).records.length, 0);
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select" && !m.isError));
  } finally { await f.close(); }
});

test("T2 native retry keeps one rendering and no durable transient tool declaration", async () => {
  const f = await fixture();
  try {
    let exposure: unknown;
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      async (ctx) => {
        assert.deepEqual(selectionNames(ctx), ["pindie_trial_select"]);
        exposure = (await trialFacts(f))!.rendered;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
      },
      async (ctx) => {
        assert.equal(blocks(ctx), 1);
        assert.deepEqual(selectionNames(ctx), ["pindie_trial_select"]);
        assert.deepEqual((await trialFacts(f))?.rendered, exposure);
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" });
      },
      async () => {
        assert.equal((await trialFacts(f))?.declaration, "select");
        return fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("Recovered; waiting for Human input."),
    ]);
    await f.session.prompt("Do real work.");
    assert.equal(f.faux.state.callCount, 5);
    assert.ok(!f.session.getActiveToolNames().includes("pindie_trial_select"));
    assert.ok(!JSON.stringify(f.session.messages.filter((m) => m.role === "system")).includes("pindie_trial_select"));
  } finally { await f.close(); }
});

test("T2 production replacement in a new Run cannot declare the prior Run assignment", async () => {
  const f = await fixture();
  try {
    let id = "";
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      async (ctx) => {
        assert.equal(blocks(ctx), 1);
        id = f.claims[0]!.commit.assignment!.id;
        assert.equal((await trialFacts(f))?.declaration, "none");
        return fauxAssistantMessage("First Run exposed without declaration.");
      },
    ]);
    await f.session.prompt("Start real work.");
    f.faux.setResponses([
      (ctx) => {
        assert.deepEqual(selectionNames(ctx), []);
        return fauxAssistantMessage(fauxToolCall("pindie_task_replace", { goal: "Different Task", successCriteria: ["different"] }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: id, decision: "select" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Old assignment rejected.")
    ]);
    await f.session.prompt("Replace the prior Task with different work.");
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select" && m.isError));
    assert.equal(f.integration.core.run.authoritativeState?.task?.goal, "Different Task");
    assert.ok(!f.session.getActiveToolNames().includes("pindie_trial_select"));
  } finally { await f.close(); }
});

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
      const saved = await f.readExperiences();
      assert.equal(saved.records.length, 1);
      const experience = saved.records[0]!.experience;
      // The aggregate remains v4/mixed for replacement, independently of the
      // exact assignment-specific partial record. Never fabricate episode counters.
      assert.equal(experience.schemaVersion, 7);
      if (experience.schemaVersion !== 7) assert.fail("Rendered attempt missing");
      assert.equal(experience.aggregateSchemaVersion, i % 2 ? 4 : 5);
      assert.equal(experience.workEpisodeId === null, Boolean(i % 2));
      assert.equal(experience.trialAttempt.declaration, "none");
      assert.equal(experience.trialAttempt.declaredAt, null);
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
    const saved = await f.readExperiences();
    assert.equal(saved.records.length, 1);
    assert.equal(saved.records[0]!.experience.schemaVersion, 5, "offered/unready but never exposed stays ordinary v5");
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
    assert.ok(!f.session.getActiveToolNames().includes("pindie_trial_select"));
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

test("T2 public downstream context removal cannot be persisted as actual exposure", async () => {
  const f = await fixture({ stripContext: true });
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      (ctx) => {
        assert.equal(blocks(ctx), 0, "later native context handler removed the rendered advisory");
        // Deliberately supply an identifier the fixture knows. The declaration may
        // record model intent, but cannot establish delivery/exposure/material use.
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("No material work."),
    ]);
    await f.session.prompt("Start real work.");
    const e = (await f.readExperiences()).records[0]!.experience;
    assert.equal(e.schemaVersion, 7);
    if (e.schemaVersion !== 7) assert.fail("Partial attempt missing");
    assert.equal(e.trialAttempt.delivery, "unknown");
    assert.equal(e.trialAttempt.declaration, "select");
    assert.equal(e.trialAttempt.postSelection.toolCalls, 0);
    assert.ok(!("trialAttribution" in e), "never write the legacy actual-exposure claim");
  } finally { await f.close(); }
});

test("T2 delivered-before-publication-failure retains an unconfirmed partial rendering without select authority", async () => {
  const f = await fixture({ publicationFailure: true });
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      (ctx) => {
        assert.equal(blocks(ctx), 1, "immediate continuation must not await pending finalization");
        f.failPublication();
        return fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("Ordinary work unaffected."),
    ]);
    await f.session.prompt("Start real work.");
    const e = (await f.readExperiences()).records[0]!.experience;
    assert.equal(e.schemaVersion, 7);
    if (e.schemaVersion !== 7) assert.fail("Partial rendering disappeared");
    assert.equal(e.trialAttempt.publication, "unconfirmed");
    assert.equal(e.trialAttempt.delivery, "unknown");
    assert.equal(e.trialAttempt.declaration, "none");
    assert.equal(e.trialAttempt.authorityCurrent, false);
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select" && m.isError));
    assert.equal(f.integration.runtime.state?.task?.goal, "Real Task");
  } finally { await f.close(); }
});

test("T2 replacement selection survives independently of a v4 mixed aggregate", async () => {
  const f = await fixture({ active: true });
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_replace", { goal: "Replacement Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      (ctx) => { assert.equal(blocks(ctx), 1); return fauxAssistantMessage(fauxToolCall("pindie_trial_select", {
        assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" }); },
      () => fauxAssistantMessage(fauxToolCall("pindie_task_progress", { blockers: ["Human dependency"], questions: [] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("Waiting for Human input."),
    ]);
    await f.session.prompt("Replace the Task.");
    const e = (await f.readExperiences()).records[0]!.experience;
    if (e.schemaVersion !== 7) assert.fail("Accepted replacement selection disappeared");
    assert.equal(e.aggregateSchemaVersion, 4);
    assert.equal(e.workEpisodeId, null);
    assert.equal(e.trialAttempt.assignmentProposal.workEpisodeId, f.claims[0]!.commit.assignment!.workEpisodeId);
    assert.equal(e.trialAttempt.declaration, "select");
    assert.equal(e.trialAttempt.counterScope, "run");
    assert.equal(e.trialAttempt.postSelection.toolCalls, 1);
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === "pindie_trial_select" && !m.isError));
  } finally { await f.close(); }
});

test("T2 real Pi selected record survives ordinary pruning; malformed offer support refuses pruning, not save", async () => {
  const f = await fixture();
  try {
    f.faux.setResponses([
      () => fauxAssistantMessage(fauxToolCall("pindie_task_start", { goal: "Real Task", successCriteria: ["done"] }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage(fauxToolCall("pindie_trial_select", { assignmentId: f.claims[0]!.commit.assignment!.id, decision: "select" }), { stopReason: "toolUse" }),
      () => fauxAssistantMessage("No material work."),
    ]);
    await f.session.prompt("Start real work.");
    const original = (await f.readExperiences()).records[0]!;
    const e = original.experience;
    if (e.schemaVersion !== 7) assert.fail("Partial attempt missing");
    const { trialAttempt: _attempt, aggregateSchemaVersion: _version, ...fields } = e;
    const ordinary = { ...fields, schemaVersion: 5 as const, workEpisodeId: e.trialAttempt.assignmentProposal.workEpisodeId };
    const store = new FileRunExperienceStore({ baseDir: f.projectsBaseDir });
    const a = e.trialAttempt;
    await store.save(f.cwd, { ...ordinary, schemaVersion: 6, trialAttribution: {
      assignment: a.assignmentProposal, exposure: a.rendered, declaration: a.declaration, declaredAt: a.declaredAt,
      declarationFrontier: a.declarationFrontier, postSelection: a.postSelection, authorityCurrent: a.authorityCurrent,
    } }); // Frozen legacy v6 must be protected too; never rewrite its audited bytes.
    for (let i = 0; i < 257; ++i) await store.save(f.cwd, { ...ordinary,
      recordedAt: new Date(Date.parse(e.recordedAt) + i + 1).toISOString() });
    const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir: f.projectsBaseDir, globalBaseDir: f.globalBaseDir });
    assert.equal(await maintenance.prune(f.cwd), 1, "only unprotected ordinary history is pruned");
    const retained = (await f.readExperiences()).records;
    assert.ok(retained.some((r) => r.recordId === original.recordId));
    assert.equal(retained.filter((r) => r.experience.schemaVersion === 6).length, 1);
    const path = join(f.projectsBaseDir, getProjectId(f.cwd), "learning-v1", "trial-offers", `${e.trialAttempt.assignmentProposal.workEpisodeId}.json`);
    await writeFile(path, "broken supporting artifact");
    await assert.rejects(maintenance.prune(f.cwd));
    const savingWithMaintenance = new FileRunExperienceStore({ baseDir: f.projectsBaseDir, onSaved: (root) => maintenance.prune(root).then(() => undefined) });
    await savingWithMaintenance.save(f.cwd, ordinary);
    assert.equal((await f.readExperiences()).records.length, 259, "maintenance failure leaves ordinary save committed");
  } finally { await f.close(); }
});
