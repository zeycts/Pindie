import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createCoreIntegration,
} from "../src/core-integration.ts";
import { renderCurrentPindieActionEligibility } from "../src/context.ts";
import {
  PindieSemanticMutationPendingError,
  PindieStateMutationUncertainError,
} from "../src/runtime.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
} from "../src/liveness.ts";
import { EMPTY_STATE, getVerificationStatus, type PindieState } from "../src/state.ts";
import type {
  PindieStateStore,
  TaskContinuityStore,
} from "../src/store.ts";

class MemoryStateStore implements PindieStateStore {
  state: PindieState = structuredClone(EMPTY_STATE);

  async load(_projectRoot: string): Promise<PindieState> {
    return structuredClone(this.state);
  }

  async save(_projectRoot: string, state: PindieState): Promise<void> {
    this.state = structuredClone(state);
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class DeferredCoreSaveStore extends MemoryStateStore {
  readonly saveStarted: Promise<void>;
  readonly saveFinished: Promise<void>;
  private resolveSaveStarted!: () => void;
  private resolveSaveFinished!: () => void;
  private resolvePending!: () => void;
  private readonly pending: Promise<void>;

  constructor() {
    super();
    this.saveStarted = new Promise((resolve) => { this.resolveSaveStarted = resolve; });
    this.saveFinished = new Promise((resolve) => { this.resolveSaveFinished = resolve; });
    this.pending = new Promise((resolve) => { this.resolvePending = resolve; });
  }

  releaseSave(): void {
    this.resolvePending();
  }

  async save(_projectRoot: string, state: PindieState): Promise<void> {
    this.state = structuredClone(state);
    this.resolveSaveStarted();
    try {
      await this.pending;
    } finally {
      this.resolveSaveFinished();
    }
  }
}

class DeferredCoreLoadStore extends MemoryStateStore {
  private nextLoad: {
    readonly pending: Promise<void>;
    readonly started: Promise<void>;
    readonly release: () => void;
    readonly markStarted: () => void;
  } | null = null;

  pauseNextLoad(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.nextLoad = { pending, started, release, markStarted };
    return { started, release };
  }

  override async load(projectRoot: string): Promise<PindieState> {
    const nextLoad = this.nextLoad;
    this.nextLoad = null;
    if (nextLoad !== null) {
      nextLoad.markStarted();
      await nextLoad.pending;
    }
    return super.load(projectRoot);
  }
}

const continuityStore: TaskContinuityStore = {
  async save(): Promise<void> {},
};

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function coreContext(): ExtensionContext {
  return {
    hasUI: false,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "core-session",
    },
  } as unknown as ExtensionContext;
}

function coreApi(tools: Map<string, any>): ExtensionAPI {
  return {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
}

test("Core-only assembly owns Task, Gateway and verification/Gate without retired Policy",  async () => {
  const store = new MemoryStateStore();
  const core = createCoreIntegration({
    store,
    continuityStore,
    taskHandoffEnabled: false,
  });
  const tools = new Map<string, any>();
  const ctx = coreContext();

  await core.runtime.load("/core-only");
  core.beginAgentRunFacts(ctx);
  core.registerTools(coreApi(tools));

  assert.equal(core.authorizeTool("edit").decision?.allowed, false);
  assert.equal(tools.has("pindie_strategy_candidate_create"), false);
  assert.equal(tools.has("pindie_memory_capture"), false);

  assert.equal(tools.has("pindie_policy_set"), false);
  assert.equal(core.authorizeTool("pindie_policy_set").decision?.allowed, false);
  assert.equal("policySnapshot" in core.run, false);

  await tools.get("pindie_task_start").execute("start", {
    goal: "Exercise the Core boundary",
    successCriteria: ["Core tools remain authoritative"],
  });
  assert.equal(core.authorizeTool("pindie_task_progress").decision?.allowed, true);

  await tools.get("pindie_gate_open").execute("open", {
    kind: "approval",
    question: "May the Core test continue?",
  });
  assert.equal(core.runtime.state.task?.humanGate?.kind, "approval");
  await tools.get("pindie_gate_resolve").execute("resolve", {});
  assert.equal(core.runtime.state.task?.humanGate, null);

  const effect = core.classifyToolEffect("read");
  const observation = {
    toolCallId: "core-read",
    toolName: "read",
    input: { path: "." },
    content: [{ type: "text", text: "Core observation" }],
    isError: false,
  } as any;
  core.execution.recordAuthorizedObservation(observation, effect);
  core.run.recordAuthorizedCall(observation.toolCallId, effect);
  core.run.recordSuccessfulCapability("task.start");
  const evidence = core.execution.captureEvidenceIfEligible(
    core.execution.takeAuthorizedExecution(observation.toolCallId)!,
    observation,
    core.run.authoritativeState,
    core.run.semanticRunFacts,
  );
  const evidenceRef = evidence?.content
    .flatMap((part: { type: string; text?: string }) => part.type === "text" && part.text ? [part.text] : [])
    .join(" ")
    .match(/Pindie evidence ref: ([^\]]+)/)?.[1];
  assert.ok(evidenceRef);

  await tools.get("pindie_verification_record").execute("verify", {
    check: {
      name: "core-boundary",
      status: "passed",
      covers: [core.runtime.state.task!.successCriteria[0]!.id],
      evidenceRefs: [evidenceRef],
    },
  });
  assert.equal(getVerificationStatus(core.runtime.state.task!), "passed");
});

test("rendered Task eligibility agrees with Core Gateway for the same authoritative snapshot", async () => {
  const actions = [
    ["task start", "pindie_task_start"],
    ["task replace", "pindie_task_replace"],
    ["task refine", "pindie_task_refine"],
    ["task progress", "pindie_task_progress"],
    ["verification record", "pindie_verification_record"],
    ["task complete", "pindie_task_complete"],
  ] as const;
  const baseTask = (): NonNullable<PindieState["task"]> => ({
    goal: "Audit Task eligibility",
    constraints: [],
    successCriteria: [{ id: "c1", description: "Verified" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  });
  const readyTask = (): NonNullable<PindieState["task"]> => ({
    ...baseTask(),
    verification: { stale: false, checks: [{
      name: "check", status: "passed", covers: ["c1"], evidence: "Observed result",
    }] },
  });
  const cases: Array<{
    name: string;
    state: PindieState;
    allowed: readonly (typeof actions)[number][0][];
    duringRun?: "start" | "open_gate" | "complete";
  }> = [
    { name: "idle", state: { task: null }, allowed: ["task start"] },
    { name: "active preexisting", state: { task: baseTask() }, allowed: ["task replace", "task refine", "task progress", "verification record"] },
    { name: "active introduced", state: { task: null }, duringRun: "start", allowed: ["task refine", "task progress", "verification record"] },
    { name: "blocked preexisting", state: { task: { ...baseTask(), openLoops: { blockers: ["blocked"], questions: [], nextIntent: null } } }, allowed: ["task replace", "task refine", "task progress", "verification record"] },
    { name: "waiting_human preexisting", state: { task: { ...baseTask(), humanGate: { kind: "approval", question: "Proceed?" } } }, allowed: ["task replace", "task refine"] },
    { name: "waiting_human opened during run", state: { task: baseTask() }, duringRun: "open_gate", allowed: [] },
    { name: "active completion-ready", state: { task: readyTask() }, allowed: ["task replace", "task refine", "task progress", "verification record", "task complete"] },
    { name: "done before run", state: { task: { ...readyTask(), completed: true } }, allowed: ["task start"] },
    { name: "done during run", state: { task: readyTask() }, duringRun: "complete", allowed: [] },
  ];

  for (const entry of cases) {
    const store = new MemoryStateStore();
    store.state = entry.state;
    const core = createCoreIntegration({ store, continuityStore, taskHandoffEnabled: false });
    await core.runtime.load(`/eligibility-${entry.name}`);
    core.beginAgentRunFacts(coreContext());
    if (entry.duringRun === "start") {
      assert.equal((await core.runtime.dispatch({ type: "start_task", goal: "New work", constraints: [], successCriteria: ["Verified"] })).ok, true);
      core.run.recordSuccessfulCapability("task.start");
    } else if (entry.duringRun === "open_gate") {
      assert.equal((await core.runtime.dispatch({ type: "open_human_gate", gate: { kind: "approval", question: "Proceed?" } })).ok, true);
    } else if (entry.duringRun === "complete") {
      assert.equal((await core.runtime.dispatch({ type: "complete_task" })).ok, true);
    }
    const derived = core.run.deriveSnapshot();
    assert.equal(derived.ok, true, entry.name);
    if (!derived.ok) continue;
    const rendered = renderCurrentPindieActionEligibility(derived.snapshot);
    for (const [label, toolName] of actions) {
      const authorization = core.authorizeTool(toolName);
      assert.deepEqual(authorization.snapshot, derived.snapshot, `${entry.name}: ${label} snapshot`);
      const expected = entry.allowed.includes(label);
      assert.equal(authorization.decision?.allowed, expected, `${entry.name}: ${label} Gateway`);
      assert.ok(rendered.split("\n").includes(`- ${label}: ${expected ? "allowed" : "not eligible"}`), `${entry.name}: ${label} rendered`);
    }
  }
});

test("Core Task tools fail closed and mark authority unavailable on uncertain mutation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new DeferredCoreSaveStore();
  const core = createCoreIntegration({
    store,
    continuityStore,
    taskHandoffEnabled: false,
  });
  const tools = new Map<string, any>();
  await core.runtime.load("/core-only");
  core.registerTools(coreApi(tools));

  const execution = tools.get("pindie_task_start").execute("start", {
    goal: "Bound semantic State mutation",
    successCriteria: ["Authority fails closed when persistence is uncertain"],
  });
  await store.saveStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  await assert.rejects(
    execution,
    (error: unknown) => {
      assert.ok(error instanceof PindieStateMutationUncertainError);
      assert.match(error.message, /outcome is currently uncertain/i);
      assert.match(error.message, /semantic authority is unavailable/i);
      return true;
    },
  );
  assert.equal(core.runtime.projectRoot, null);
  assert.match(core.run.stateUnavailableReason ?? "", /outcome is currently uncertain/i);
  await assert.rejects(
    core.runtime.load("/core-only"),
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );

  store.releaseSave();
  await store.saveFinished;
  await new Promise((resolve) => setImmediate(resolve));
  await core.runtime.load("/core-only");
  assert.equal(core.runtime.state.task?.goal, "Bound semantic State mutation");
});

test("Core settlement bounds a final authority refresh and releases the exact Run latch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new DeferredCoreLoadStore();
  const core = createCoreIntegration({
    store,
    continuityStore,
    taskHandoffEnabled: false,
  });
  const ctx = coreContext();
  await core.runtime.load("/core-only");
  core.beginAgentRunFacts(ctx);
  const refresh = store.pauseNextLoad();
  const settlement = core.settleAgentRun(ctx, []);
  await refresh.started;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  const result = await settlement;
  assert.equal(result.status, "settled");
  assert.equal(result.facts?.snapshot, null);
  assert.equal(core.run.hasActiveAgentRun, false);

  core.beginAgentRunFacts(ctx);
  assert.equal(core.run.hasActiveAgentRun, true);
  refresh.release();
  await nextTurn();
  assert.equal(core.run.hasActiveAgentRun, true);
});

test("Core settlement observer timeout cannot leave bookkeeping latched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new MemoryStateStore();
  const core = createCoreIntegration({
    store,
    continuityStore,
    taskHandoffEnabled: false,
  });
  const ctx = coreContext();
  await core.runtime.load("/core-only");
  core.beginAgentRunFacts(ctx);
  let markObserverStarted!: () => void;
  let releaseObserver!: () => void;
  const observerStarted = new Promise<void>((resolve) => { markObserverStarted = resolve; });
  const observerPending = new Promise<void>((resolve) => { releaseObserver = resolve; });
  const settlement = core.settleAgentRun(ctx, [], {
    observe: async (_facts, _signal) => {
      markObserverStarted();
      await observerPending;
    },
  });
  await observerStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  const result = await settlement;
  assert.equal(result.status, "settled");
  assert.equal(core.run.hasActiveAgentRun, false);
  core.beginAgentRunFacts(ctx);
  assert.equal(core.run.hasActiveAgentRun, true);
  releaseObserver();
  await nextTurn();
  assert.equal(core.run.hasActiveAgentRun, true);
});

test("Core settlement exposes real counters and authority epochs without Learning placeholders", async () => {
  const core = createCoreIntegration({ store: new MemoryStateStore(), continuityStore });
  const ctx = coreContext();
  await core.runtime.load("/core-settlement");
  core.beginAgentRun(ctx);
  const generation = core.run.activeAgentRunGeneration;
  assert.ok(generation !== null);

  for (const name of ["getOrdinaryRunEpisode", "getRunStartEpisode", "captureRunStartEpisode"]) {
    assert.equal(name in core, false, name);
  }
  for (const name of ["policySnapshot", "policyAttribution", "setPolicySnapshot", "clearPolicySnapshot",
    "recordSuccessfulPolicyDeclaration", "recordFailedPolicyDeclaration", "experience"]) {
    assert.equal(name in core.run, false, name);
  }

  assert.ok((await core.runtime.dispatch({ type: "start_task", goal: "Core facts", constraints: [], successCriteria: ["Persist"] })).ok);
  core.run.recordSuccessfulCapability("task.start");
  core.run.recordAuthorizedCall("read", core.classifyToolEffect("read"));
  assert.equal(core.run.recordToolResult("read", false), "execution");
  core.run.recordAuthorizedCall("edit", core.classifyToolEffect("edit"));
  assert.equal(core.run.recordToolResult("edit", true), "execution");
  core.run.recordDeniedCall(core.classifyToolEffect("write"));
  // Retired calls stay denied even with a Task that permits ordinary mutation.
  assert.equal(core.authorizeTool("edit").decision?.allowed, true);
  const retired = core.classifyToolEffect("pindie_policy_set");
  assert.equal(core.authorizeTool("pindie_policy_set").decision?.allowed, false);
  core.run.recordDeniedCall(retired);
  core.run.recordAuthorizedCall("stale-policy", retired);
  assert.equal(core.run.recordToolResult("stale-policy", true), null);

  const result = await core.settleAgentRun(ctx, []);
  assert.equal(result.status, "settled");
  const facts = result.facts!;
  assert.equal(facts.settlementGeneration, generation);
  assert.equal(facts.settlementOccurrenceEpoch, 1);
  assert.equal(facts.settlementExternalStateEpoch, 0);
  assert.equal(facts.task?.goal, "Core facts");
  assert.equal(facts.snapshot?.authority, "coherent");
  assert.equal(typeof facts.durationMs, "number");
  assert.deepEqual(facts.execution, { toolCalls: 2, observations: 1, consequentialCalls: 1,
    projectMutationEffectCalls: 1, verificationCalls: 0, toolErrors: 1, deniedCalls: 1 });
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.execution), true);
  assert.equal("policy" in facts, false);
  assert.equal("runStartEpisode" in facts, false);
  assert.equal(core.run.hasActiveAgentRun, false);
  assert.equal(core.run.executionCounters.toolCalls, 0);
  core.beginAgentRunFacts(ctx);
  assert.notEqual(core.run.activeAgentRunGeneration, generation);
  assert.equal(facts.execution.toolCalls, 2, "reset cannot mutate settled diagnostics");
});

test("Core-only authorization ignores caller-provided capability injection", async () => {
  const core = createCoreIntegration({
    store: new MemoryStateStore(),
    continuityStore,
    taskHandoffEnabled: false,
  });
  await core.runtime.load("/core-only");
  core.beginAgentRunFacts(coreContext());

  const result = Reflect.apply(core.authorizeTool, core, [
    "edit",
    ["project.mutate"],
  ]);

  assert.equal(result.capabilities.has("project.mutate"), false);
  assert.equal(result.decision?.allowed, false);
});

test("Core integration has no optional feature implementation imports", async () => {
  const source = await readFile(new URL("../src/core-integration.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /(?:self-improvement|strategy-adaptation|strategy-derivation|strategy-candidate|strategy-trial|strategy-portfolio|cross-project|work-episode|run-experience|discord|remote|notion|project-memory)/iu);
  assert.doesNotMatch(source, /from\s+["']\.\/policy\.ts["']/u);
  assert.doesNotMatch(source, /\b(?:event\s*bus|service\s*locator|dependency\s*registry|PindiePlugin)\b/iu);
});
