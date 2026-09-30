import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, AgentSessionRuntime, ContextUsage, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { QuotaFallbackSupervisor, PINDIE_QUOTA_FALLBACK_TYPE } from "../src/quota-fallback-supervisor.ts";

import {
  PINDIE_STATE_CHECKPOINT_TYPE,
  PINDIE_RUN_BASELINE_TYPE,
  isPindieStateCheckpointMessage,
  isPindieRunBaselineMessage,
} from "../src/context.ts";
import {
  PINDIE_CONTINUATION_PROBE_MESSAGE,
  PINDIE_CONTINUATION_PROBE_TYPE,
  isPindieContinuationProbeMessage,
} from "../src/continuation.ts";
import {
  registerConfiguredPindieExtension,
  registerPindieExtension,
  type PindieExtensionOptions,
} from "../src/extension.ts";
import { RunTimer, type RunTimerScheduler } from "../src/run-timer.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";
import { PINDIE_CONTEXT_LIFECYCLE_TYPE } from "../src/context-governor.ts";
import {
  installCommittedRolloverReceiver,
  type CommittedRolloverRequest,
} from "../src/long-task-control.ts";
import {
  installQuotaResumeReceiver,
  type QuotaResumeControlEvent,
} from "../src/quota-resume-control.ts";
import { installQuotaFallbackReceiver } from "../src/quota-fallback-control.ts";
import { PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE } from "../src/quota-fallback.ts";
import {
  PINDIE_QUOTA_RESUME_MESSAGE,
  PINDIE_QUOTA_RESUME_TYPE,
} from "../src/quota-resume-supervisor.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  createStrategyRevisionCandidate,
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import { getSeedStrategy, SEED_STRATEGIES } from "../src/strategies.ts";
import {
  createStrategyDerivationCandidate,
  strategyDerivationCandidateSemanticFingerprint,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import {
  createTrustedStrategyPortfolio,
  createTrustedStrategyPortfolioForProjectId,
} from "../src/strategy-portfolio.ts";
import { DiscordRemote, type DiscordClientSeam } from "../src/discord-remote.ts";
import { PINDIE_REMOTE_NOTICE_TYPE } from "../src/remote-notice.ts";
import { RemoteCompanion, type RemoteSurface } from "../src/remote-companion.ts";
import {
  EMPTY_STATE,
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
} from "../src/state.ts";
import type {
  ProjectMemoryCapture,
  ProjectMemoryCaptureResult,
  ProjectMemorySink,
} from "../src/project-memory.ts";
import { evaluateRunExperience } from "../src/experience-evaluation.ts";
import {
  assembleRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import { taskContractFingerprint } from "../src/task-continuity.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceReader,
  RunExperienceStore,
} from "../src/experience-store.ts";
import {
  createPromotedStrategyRevisionCatalog,
  createStrategyRevisionDecision,
  type StrategyRevisionDecision,
  type StrategyRevisionDecisionStore,
} from "../src/strategy-decisions.ts";
import {
  createPromotedDerivedStrategyCatalog,
  createStrategyDerivationDecision,
  type StrategyDerivationDecision,
  type StrategyDerivationDecisionReader,
} from "../src/strategy-derivation-decisions.ts";
import { getProjectId } from "../src/store.ts";
import type { PindieStateStore, TaskContinuityStore } from "../src/store.ts";
import { PINDIE_TOOL_LIVENESS_TIMEOUT_MS } from "../src/liveness.ts";
import type { TaskContinuityV1 } from "../src/task-continuity.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import {
  createStrategyTrustScopeCandidate,
  type StrategyTrustScopeCandidateStore,
} from "../src/strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  type StrategyTrustScopeDecisionStore,
  type StrategyTrustScopeDecisionV1,
} from "../src/strategy-trust-scope-decisions.ts";
import type { StrategyTrustScopeSourceResolver } from "../src/strategy-trust-scope-resolution.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
import {
  createStrategySynthesisCandidate,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  type StrategySynthesisCandidateStore,
  type StrategySynthesisCandidateV1,
} from "../src/strategy-synthesis-candidates.ts";
import { makeSynthesisTrialFixture } from "./synthesis-trial-fixture.ts";
import { synthesisTrialCommandValue } from "../src/strategy-synthesis-trial.ts";

type CapturedHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => unknown;

class CapturedExtensionAPI {
  readonly handlers = new Map<string, CapturedHandler>();
  readonly tools = new Map<string, any>();
  readonly commands = new Map<string, any>();
  readonly handlerRegistrations: string[] = [];
  readonly toolRegistrations: string[] = [];
  readonly commandRegistrations: string[] = [];
  readonly appliedThinkingLevels: string[] = [];
  readonly sentMessages: unknown[] = [];
  readonly sentUserMessages: unknown[] = [];
  readonly appendedEntries: unknown[] = [];
  readonly entryRenderers = new Map<string, unknown>();
  readonly setActiveToolsCalls: string[][] = [];
  thinkingLevel = "medium";
  private runtimeBound = false;
  private readonly configuredToolNames = new Set([
    "read", "grep", "find", "ls", "edit", "write", "bash", "custom_tool",
  ]);
  private activeToolNames = [...this.configuredToolNames];

  on(eventName: string, handler: CapturedHandler): void {
    this.handlerRegistrations.push(eventName);
    assert.equal(this.handlers.has(eventName), false);
    this.handlers.set(eventName, handler);
  }

  registerTool(tool: { name: string }): void {
    this.toolRegistrations.push(tool.name);
    this.tools.set(tool.name, tool);
    this.configuredToolNames.add(tool.name);
    this.activeToolNames.push(tool.name);
  }

  registerCommand(name: string, command: any): void {
    this.commandRegistrations.push(name);
    this.commands.set(name, command);
  }

  bindRuntime(): void { this.runtimeBound = true; }

  getThinkingLevel(): any {
    if (!this.runtimeBound) throw new Error("Extension runtime not initialized.");
    return this.thinkingLevel;
  }

  setThinkingLevel(level: string): void {
    if (!this.runtimeBound) throw new Error("Extension runtime not initialized.");
    this.appliedThinkingLevels.push(level);
    this.thinkingLevel = level;
  }

  sendMessage(message: unknown, options?: unknown): void {
    this.sentMessages.push({ message, options });
  }

  sendUserMessage(content: unknown, options?: unknown): void {
    this.sentUserMessages.push({ content, options });
  }

  registerEntryRenderer(customType: string, renderer: unknown): void {
    this.entryRenderers.set(customType, renderer);
  }

  appendEntry(customType: string, data?: unknown): void {
    this.appendedEntries.push({ customType, data });
  }

  getActiveTools(): string[] {
    if (!this.runtimeBound) throw new Error("Extension runtime not initialized.");
    return [...this.activeToolNames];
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.configuredToolNames].map((name) => ({ name }));
  }

  setActiveTools(names: string[]): void {
    if (!this.runtimeBound) throw new Error("Extension runtime not initialized.");
    this.activeToolNames = names.filter((name) => this.configuredToolNames.has(name));
    this.setActiveToolsCalls.push([...this.activeToolNames]);
  }

  handler(eventName: string): CapturedHandler {
    const handler = this.handlers.get(eventName);
    assert.ok(handler, `Expected '${eventName}' handler to be registered.`);
    return handler;
  }

  tool(name: string): any {
    const tool = this.tools.get(name);
    assert.ok(tool, `Expected '${name}' tool to be registered.`);
    return tool;
  }
}

class ExtensionTestExperienceStore implements RunExperienceStore {
  readonly records: Array<{ projectRoot: string; experience: RunExperience }> = [];
  saveError: Error | null = null;
  events: string[] | null = null;

  async save(projectRoot: string, experience: RunExperience): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.events?.push("experience");
    this.records.push({ projectRoot, experience });
  }
}

class ExtensionTestContinuityStore implements TaskContinuityStore {
  readonly records: Array<{ projectRoot: string; checkpoint: TaskContinuityV1 }> = [];
  saveError: Error | null = null;
  events: string[] | null = null;

  async save(projectRoot: string, checkpoint: TaskContinuityV1): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.events?.push("continuity");
    this.records.push({ projectRoot, checkpoint });
  }
}

class HangingExperienceStore implements RunExperienceStore {
  readonly records: Array<{ projectRoot: string; experience: RunExperience }> = [];
  readonly saveStarted: Promise<void>;
  readonly saveFinished: Promise<void>;
  private resolveSaveStarted!: () => void;
  private resolveSaveFinished!: () => void;
  private resolvePending!: () => void;
  private readonly pending: Promise<void>;

  constructor() {
    this.saveStarted = new Promise((resolve) => { this.resolveSaveStarted = resolve; });
    this.saveFinished = new Promise((resolve) => { this.resolveSaveFinished = resolve; });
    this.pending = new Promise((resolve) => { this.resolvePending = resolve; });
  }

  releaseSave(): void { this.resolvePending(); }

  async save(projectRoot: string, experience: RunExperience): Promise<void> {
    this.records.push({ projectRoot, experience });
    this.resolveSaveStarted();
    try {
      await this.pending;
    } finally {
      this.resolveSaveFinished();
    }
  }
}

class HangingContinuityStore implements TaskContinuityStore {
  readonly records: Array<{ projectRoot: string; checkpoint: TaskContinuityV1 }> = [];
  readonly saveStarted: Promise<void>;
  readonly saveFinished: Promise<void>;
  private resolveSaveStarted!: () => void;
  private resolveSaveFinished!: () => void;
  private resolvePending!: () => void;
  private readonly pending: Promise<void>;

  constructor() {
    this.saveStarted = new Promise((resolve) => { this.resolveSaveStarted = resolve; });
    this.saveFinished = new Promise((resolve) => { this.resolveSaveFinished = resolve; });
    this.pending = new Promise((resolve) => { this.resolvePending = resolve; });
  }

  releaseSave(): void { this.resolvePending(); }

  async save(projectRoot: string, checkpoint: TaskContinuityV1): Promise<void> {
    this.records.push({ projectRoot, checkpoint });
    this.resolveSaveStarted();
    try {
      await this.pending;
    } finally {
      this.resolveSaveFinished();
    }
  }
}

class ExtensionTestExperienceReader implements RunExperienceReader {
  result: RunExperienceReadResult = {
    records: [],
    loadedRecords: 0,
    unsupportedSchema: 0,
    invalid: 0,
  };
  readonly roots: string[] = [];
  error: Error | null = null;

  async read(projectRoot: string): Promise<RunExperienceReadResult> {
    this.roots.push(projectRoot);
    if (this.error) throw this.error;
    return this.result;
  }
}

class ExtensionTestMemorySink implements ProjectMemorySink {
  readonly captures: ProjectMemoryCapture[] = [];

  async capture(memory: ProjectMemoryCapture): Promise<ProjectMemoryCaptureResult> {
    this.captures.push(memory);
    return { ok: true, outcome: "created" };
  }
}

class ExtensionTestStore implements PindieStateStore {
  readonly states = new Map<string, PindieState>();
  readonly loadErrors = new Map<string, Error>();
  readonly loads: string[] = [];
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  saveError: Error | null = null;
  private nextLoadBarrier: {
    readonly markEntered: () => void;
    readonly pending: Promise<void>;
  } | null = null;
  private nextSaveBarrier: {
    readonly markEntered: () => void;
    readonly pending: Promise<void>;
    readonly markFinished: () => void;
  } | null = null;

  constructor(entries: Array<[string, PindieState]> = []) {
    for (const [root, state] of entries) this.states.set(root, state);
  }

  pauseNextLoad(): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.nextLoadBarrier = { markEntered, pending };
    return { entered, release };
  }

  async load(projectRoot: string, _signal?: AbortSignal): Promise<PindieState> {
    this.loads.push(projectRoot);
    const barrier = this.nextLoadBarrier;
    if (barrier !== null) {
      this.nextLoadBarrier = null;
      barrier.markEntered();
      await barrier.pending;
    }
    const error = this.loadErrors.get(projectRoot);
    if (error) throw error;
    return this.states.get(projectRoot) ?? EMPTY_STATE;
  }

  pauseNextSave(): {
    entered: Promise<void>;
    release: () => void;
    finished: Promise<void>;
  } {
    let markEntered!: () => void;
    let release!: () => void;
    let markFinished!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const finished = new Promise<void>((resolve) => { markFinished = resolve; });
    this.nextSaveBarrier = { markEntered, pending, markFinished };
    return { entered, release, finished };
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    this.saves.push({ projectRoot, state });
    if (this.saveError) throw this.saveError;
    this.states.set(projectRoot, state);
    const barrier = this.nextSaveBarrier;
    this.nextSaveBarrier = null;
    if (barrier === null) return;
    barrier.markEntered();
    try {
      await barrier.pending;
    } finally {
      barrier.markFinished();
    }
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class DeterministicRunClock {
  now = 0;
  readonly timer = new RunTimer({
    now: () => this.now,
    scheduler: {
      schedule: () => 0 as unknown as ReturnType<typeof setInterval>,
      cancel: () => undefined,
    } satisfies RunTimerScheduler,
  });
}

function activeState(goal = "Wire Pi extension"): PindieState {
  return {
    task: {
      goal,
      constraints: [],
      successCriteria: [{ id: "c1", description: "Extension works" }],
      openLoops: { blockers: [], questions: [], nextIntent: "Continue" },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  };
}

function trialCandidate(
  candidateId = "00000000-0000-4000-8000-000000000001",
  targetId = "architecture-first",
): StrategyRevisionCandidate {
  return createStrategyRevisionCandidate({
    target: getSeedStrategy(targetId)!,
    candidateId,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
      sourceRecordIds: ["record-one", "record-two"],
      hypothesis: "A narrower boundary check may reduce avoidable rework.",
    },
  });
}

function derivationTrialCandidate(
  candidateId = "00000000-0000-4000-8000-000000000006",
  basePortfolio = createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([]),
  ),
): StrategyDerivationCandidateV1 {
  return createStrategyDerivationCandidate({
    projectId: basePortfolio.projectId,
    basePortfolio,
    candidateId,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      strategyId: "boundary-first",
      kind: "approach",
      summary: "Name the smallest boundary before choosing a broader change.",
      useWhen: ["the requested change crosses a meaningful interface"],
      avoidWhen: ["the correction is already local and clear"],
      principles: ["make the boundary explicit", "verify the smallest coherent move"],
      sourceRecordIds: ["derive-one", "derive-two", "derive-three"],
      hypothesis: "Repeated trusted-policy Runs may expose a missing boundary-first abstraction.",
    },
  });
}

function derivedPromotionCandidate(
  candidateId: string,
  strategyId: string,
  basePortfolio = createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([]),
  ),
): StrategyDerivationCandidateV1 {
  return createStrategyDerivationCandidate({
    projectId: basePortfolio.projectId,
    basePortfolio,
    candidateId,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      strategyId,
      kind: "approach",
      summary: `Name the smallest boundary before choosing ${strategyId}.`,
      useWhen: ["the requested change crosses a meaningful interface"],
      avoidWhen: ["the correction is already local and clear"],
      principles: ["make the boundary explicit", "verify the smallest coherent move"],
      sourceRecordIds: ["derive-one", "derive-two", "derive-three"],
      hypothesis: `Repeated trusted-policy Runs may expose a missing ${strategyId} abstraction.`,
    },
  });
}

function derivationTrialPolicy(candidate: StrategyDerivationCandidateV1): PolicySnapshot {
  return createPolicySnapshotFromRevisions({
    approach: createStrategyRevisionSelection({
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
      revisionStatusAtRun: "trial",
      semantics: {
        summary: candidate.proposal.summary,
        useWhen: [...candidate.proposal.useWhen],
        avoidWhen: [...candidate.proposal.avoidWhen],
        principles: [...candidate.proposal.principles],
      },
    }),
  });
}

function derivationPromotionRecords(candidate: StrategyDerivationCandidateV1): Array<{
  readonly recordId: string;
  readonly experience: RunExperience;
}> {
  return [
    { recordId: "derive-one", experience: commandExperience("source one", createPolicySnapshot({ approach: "direct-action" })) },
    { recordId: "derive-two", experience: commandExperience("source one", createPolicySnapshot({ approach: "architecture-first" })) },
    { recordId: "derive-three", experience: commandExperience("source two", createPolicySnapshot({ approach: "explore-first" })) },
    { recordId: "trial-one", experience: commandExperience("trial one", derivationTrialPolicy(candidate)) },
    { recordId: "trial-two", experience: commandExperience("trial two", derivationTrialPolicy(candidate)) },
  ];
}

function candidatePolicy(
  candidate: StrategyRevisionCandidate,
  status: "trial" | "promoted" = "trial",
): PolicySnapshot {
  return createPolicySnapshotFromRevisions({
    approach: strategyRevisionSelectionFromCandidate(candidate, status),
  });
}

function testDecisionStore(
  initial: readonly StrategyRevisionDecision[] = [],
): StrategyRevisionDecisionStore & { readonly decisions: Map<string, StrategyRevisionDecision> } {
  const decisions = new Map(initial.map((decision) => [decision.candidateId, decision]));
  return {
    decisions,
    read: async (_root, candidateId) => decisions.get(candidateId) ?? null,
    readAll: async () => [...decisions.values()],
    save: async (_root, decision) => {
      if (decisions.has(decision.candidateId)) throw new Error("terminal Decision already exists");
      decisions.set(decision.candidateId, decision);
    },
  };
}

function testDerivationDecisionReader(
  initial: readonly StrategyDerivationDecision[] = [],
): StrategyDerivationDecisionReader & { readonly decisions: Map<string, StrategyDerivationDecision> } {
  const decisions = new Map(initial.map((decision) => [decision.candidateId, decision]));
  return {
    decisions,
    read: async (_root, candidateId) => decisions.get(candidateId) ?? null,
    readAll: async () => [...decisions.values()],
  };
}

function scopeTrialTestDependencies() {
  const sourcePortfolio = createTrustedStrategyPortfolio(
    "/source",
    createPromotedStrategyRevisionCatalog([]),
  );
  const sourceCandidate = derivationTrialCandidate(
    "33333333-0000-4000-8000-000000000071",
    sourcePortfolio,
  );
  const sourceDecision = createStrategyDerivationDecision({
    candidate: sourceCandidate,
    decision: "promoted",
    trialRecordIds: ["scope-source-trial-one", "scope-source-trial-two"],
    decidedAt: "2026-03-01T00:00:00.000Z",
  });
  const sourceSelection = createStrategyRevisionSelection({
    strategyId: sourceCandidate.proposal.strategyId,
    kind: sourceCandidate.proposal.kind,
    revisionIdentity: sourceCandidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(sourceCandidate),
    revisionStatusAtRun: "promoted",
    semantics: sourceCandidate.proposal,
  });
  const sourceCatalog = createPromotedDerivedStrategyCatalog([{
    candidate: sourceCandidate,
    decision: sourceDecision,
    selection: sourceSelection,
  }]);
  const scopeCandidate = createStrategyTrustScopeCandidate({
    candidateId: "44444444-0000-4000-8000-000000000072",
    sourceStrategy: {
      sourceProjectId: sourceCandidate.projectId,
      strategyId: sourceCandidate.proposal.strategyId,
      kind: sourceCandidate.proposal.kind,
      revisionIdentity: sourceCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(sourceCandidate),
    },
    createdAt: "2026-03-02T00:00:00.000Z",
  });
  const globalCandidates = [scopeCandidate];
  const globalCandidateStore: StrategyTrustScopeCandidateStore = {
    read: async (candidateId) => globalCandidates.find((candidate) => candidate.candidateId === candidateId) ?? null,
    readAll: async () => [...globalCandidates],
    save: async (candidate) => { globalCandidates.push(candidate); },
  };
  const globalDecisionStore: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async (sourceStrategy) => ({
      sourceStrategy,
      candidate: sourceCandidate,
      decision: sourceDecision,
      selection: sourceSelection,
      promotedDerivedCatalog: sourceCatalog,
    }),
  };
  return {
    scopeCandidate,
    globalCandidateStore,
    globalDecisionStore,
    sourceResolver,
    sourceCandidate,
    sourceDecision,
    sourceSelection,
    sourceCatalog,
  };
}

function emptyScopeAuthority() {
  const candidateStore: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const decisionStore: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async () => { throw new Error("the empty global authority has no source to resolve"); },
  };
  return { candidateStore, decisionStore, sourceResolver };
}

function promotedGlobalScopeDecision(
  scopeCandidate: ReturnType<typeof scopeTrialTestDependencies>["scopeCandidate"],
): StrategyTrustScopeDecisionV1 {
  return createStrategyTrustScopeDecision({
    candidate: scopeCandidate,
    decision: "promoted",
    trialRefs: [
      {
        projectId: getProjectId("/scope-target-a"),
        recordId: "11111111-1111-4111-8111-111111111111.json",
        recordFingerprint: `sha256:${"a".repeat(64)}`,
      },
      {
        projectId: getProjectId("/scope-target-b"),
        recordId: "22222222-2222-4222-8222-222222222222.json",
        recordFingerprint: `sha256:${"b".repeat(64)}`,
      },
    ],
    decidedAt: "2026-03-03T00:00:00.000Z",
  });
}

function trustedStrategyCommandArtifacts() {
  const promotedSeedCandidate = trialCandidate(
    "11111111-0000-4000-8000-000000000101",
    "architecture-first",
  );
  const promotedSeedDecision = createStrategyRevisionDecision({
    candidate: promotedSeedCandidate,
    decision: "promoted",
    trialRecordIds: ["seed-trial-one", "seed-trial-two"],
    decidedAt: "2026-02-01T00:00:00.000Z",
  });
  const promotedSeedCatalog = createPromotedStrategyRevisionCatalog([{
    candidate: promotedSeedCandidate,
    decision: promotedSeedDecision,
    selection: strategyRevisionSelectionFromCandidate(promotedSeedCandidate, "promoted"),
  }]);
  const basePortfolio = createTrustedStrategyPortfolio("/repo", promotedSeedCatalog);
  const promotedDerivedCandidate = createStrategyDerivationCandidate({
    projectId: basePortfolio.projectId,
    basePortfolio,
    candidateId: "22222222-0000-4000-8000-000000000102",
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      strategyId: "delivery-checkpoints",
      kind: "modifier",
      summary: "Make implementation and delivery progress explicit through bounded checkpoints.",
      useWhen: ["the task has several independent deliverables to close"],
      avoidWhen: ["the work is only exploratory discussion"],
      principles: ["separate implementation, verification, and delivery checks", "keep checkpoints bounded"],
      sourceRecordIds: ["derived-source-one", "derived-source-two", "derived-source-three"],
      hypothesis: "Repeated delivery work may benefit from explicit bounded checkpoints.",
    },
  });
  const promotedDerivedDecision = createStrategyDerivationDecision({
    candidate: promotedDerivedCandidate,
    decision: "promoted",
    trialRecordIds: ["derived-trial-one", "derived-trial-two"],
    decidedAt: "2026-02-02T00:00:00.000Z",
  });
  return {
    promotedSeedCandidate,
    promotedSeedDecision,
    promotedDerivedCandidate,
    promotedDerivedDecision,
  };
}

function commandExperience(goal: string, policy: PolicySnapshot | null = null): RunExperience {
  const coherentSnapshot: Extract<SemanticSnapshot, { authority: "coherent" }> = {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
  };
  const zero = {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  return assembleRunExperience({
    task: activeState(goal).task!,
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: coherentSnapshot,
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: policy === null ? null : zero,
      finalPolicyLastDeclaredAfter: policy === null ? null : zero,
    },
    execution: { ...zero, toolCalls: 1, observations: 1 },
    durationMs: 10,
    cost: 0.1,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
}

function completedBeforeCommandExperience(goal: string, policy: PolicySnapshot): RunExperience {
  const record = structuredClone(commandExperience(goal, policy)) as any;
  record.runStart.taskStatus = "done";
  record.outcome.taskStatus = "done";
  record.outcome.verificationStatus = "passed";
  record.outcome.completionRelation = "completed_before_run";
  return record;
}

function verifiedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      verification: {
        stale: false,
        checks: [
          {
            name: "tests",
            status: "passed",
            covers: ["c1"],
            evidence: "Extension tests passed.",
          },
        ],
      },
    },
  };
}

function blockedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      openLoops: { blockers: ["External dependency unavailable"], questions: [], nextIntent: null },
    },
  };
}

function staleVerificationState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      verification: { stale: true, checks: [] },
    },
  };
}

function failedVerificationState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      verification: {
        stale: false,
        checks: [{ name: "tests", status: "failed", covers: [], evidence: "failed" }],
      },
    },
  };
}

function gatedState(): PindieState {
  const state = activeState();
  return {
    task: {
      ...state.task!,
      humanGate: {
        kind: "decision",
        question: "Which release strategy should we use?",
        options: ["Canary", "Immediate"],
      },
    },
  };
}

function completedState(): PindieState {
  const state = verifiedState();
  return {
    task: {
      ...state.task!,
      openLoops: { blockers: [], questions: [], nextIntent: null },
      completed: true,
    },
  };
}

async function nextTurn(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function context(
  cwd: string,
  sessionEntries: unknown[] = [],
  hasPendingMessages = false,
  sessionId = "remote-session",
  getEntries: () => unknown[] = () => sessionEntries,
  contextUsage: ContextUsage | undefined = undefined,
): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    hasPendingMessages: () => hasPendingMessages,
    getContextUsage: () => contextUsage,
    sessionManager: { getEntries, getSessionId: () => sessionId, getSessionName: () => undefined },
    ui: { notify: () => undefined },
  };
}

function interactiveContext(
  cwd: string,
  statuses: Array<{ id: string; text: string | undefined }>,
  throwOnSetStatus = false,
  sessionEntries: unknown[] = [],
): Record<string, unknown> {
  return {
    cwd,
    hasUI: true,
    sessionManager: { getEntries: () => sessionEntries },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => undefined,
      setStatus: (id: string, text: string | undefined) => {
        if (throwOnSetStatus) throw new Error("Status renderer unavailable");
        statuses.push({ id, text });
      },
    },
  };
}

function withBranch(
  ctx: Record<string, unknown>,
  branch: unknown[],
): Record<string, unknown> {
  return {
    ...ctx,
    sessionManager: {
      ...(ctx.sessionManager as Record<string, unknown>),
      getBranch: () => branch,
    },
  };
}

function toolCall(
  toolName: string,
  input: Record<string, unknown> = {},
  toolCallId = `call-${toolName}`,
): Record<string, unknown> {
  return { type: "tool_call", toolCallId, toolName, input };
}

function toolExecution(
  type: "tool_execution_start" | "tool_execution_end",
  toolCallId: string,
  toolName: string,
): Record<string, unknown> {
  return { type, toolCallId, toolName, args: {}, result: undefined, isError: false };
}

function toolResult(
  toolName: string,
  isError = false,
  toolCallId = `call-${toolName}`,
  content: Array<Record<string, unknown>> = [],
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId,
    toolName,
    input,
    content,
    details: undefined,
    isError,
  };
}

function handoffInput(nextIntent = "Continue in the next Session"): Record<string, unknown> {
  return {
    progressSummary: "The implementation is coherent at the current work frontier.",
    decisions: ["Keep Task truth in PindieState."],
    nextIntent,
  };
}

function agentEnd(stopReason: "stop" | "aborted" | "error" | "length" = "stop"): Record<string, unknown> {
  return {
    type: "agent_end",
    messages: [{
      role: "assistant",
      content: [{ type: "text", text: "Observed the remaining implementation work; continuing is safe." }],
      stopReason,
      timestamp: 1,
    }],
  };
}

function beforeSettle(stopReason: "stop" | "aborted" | "error" | "length" = "stop", pendingMessages: unknown[] = []): Record<string, unknown> {
  return {
    type: "agent_before_settle",
    outcome: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed",
    entries: [],
    context: { contextMessages: agentEnd(stopReason).messages, pendingMessages },
  };
}

function continuationProbe(
  content: string,
  timestamp: number,
): Record<string, unknown> {
  return {
    role: "custom",
    customType: PINDIE_CONTINUATION_PROBE_TYPE,
    content,
    display: false,
    timestamp,
  };
}

function createHarness(
  entries: Array<[string, PindieState]> = [],
  resolvedRoots: Record<string, string> = {},
  options: Omit<PindieExtensionOptions, "store"> = {},
) {
  const api = new CapturedExtensionAPI();
  const store = new ExtensionTestStore(entries);
  const experienceStore = options.experienceStore ?? new ExtensionTestExperienceStore();
  const experienceReader = options.experienceReader ?? new ExtensionTestExperienceReader();
  const integration = registerPindieExtension(
    api as unknown as ExtensionAPI,
    {
      subscriptionUsageProvider: { fetchUsage: async () => null },
      ...options,
      store,
      experienceStore,
      experienceReader,
      resolveProjectRoot: options.resolveProjectRoot ?? (async (cwd) => resolvedRoots[cwd] ?? cwd),
    },
  );
  api.bindRuntime();

  return { api, store, experienceStore, experienceReader, integration };
}

async function t1ExtensionHarness(t: import("node:test").TestContext, offerable = true, preexisting = false) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { hypothesisFingerprint } = await import("../src/learning-v1-contract.ts");
  const { getProjectId } = await import("../src/store.ts");
  const { FileTrialOfferStore } = await import("../src/trial-offer-store.ts");
  const { TrialOffers } = await import("../src/trial-offers.ts");
  const dir = await mkdtemp(join(tmpdir(), "pindie-t1-extension-"));
  const cleanupReleases: Array<() => void> = [];
  const projectId = getProjectId("/repo");
  const semantic = { schemaVersion: 1 as const, scope: { kind: "project" as const, projectId }, logicalId: "experimental-focus", kind: "approach" as const,
    lineage: "new" as const, parent: null, baseRevisionFingerprint: null, summary: "Check narrow evidence first", useWhen: ["Local change"], avoidWhen: [],
    expectedEffect: "Fewer unrelated edits", failureSignals: ["Relevant checks missed"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const h = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  const offersStore = new FileTrialOfferStore({ projectsBaseDir: dir });
  const { DEFAULT_TRIAL_OFFER_POLICY } = await import("../src/trial-offer-contract.ts");
  // Readiness tests control the context boundary; do not conflate it with busy full-suite disk latency.
  const trialOffers = new TrialOffers(offersStore, { readOpen: async () => offerable ? [h] : [] }, { ...DEFAULT_TRIAL_OFFER_POLICY, operationTimeoutMs: 1000 });
  let episodeId: string | null = null;
  let boundaries = 0;
  const workEpisodes: import("../src/work-episode.ts").WorkEpisodeLedger = {
    current: async () => episodeId,
    reconcile: async (_root, state) => { if (state.task && !episodeId) episodeId = randomUUID(); return episodeId; },
    prepared: async () => undefined,
    committed: async (_root, _before, _after, event) => { if (event.type === "start_task" || event.type === "replace_task") { boundaries++; episodeId = randomUUID(); } return episodeId; },
  };
  const harness = createHarness(preexisting ? [["/repo", activeState()]] : [], {}, { workEpisodes, trialOffers });
  const observers: Promise<void>[] = [];
  const notify = harness.integration.runtime.onWorkEpisodeOpened!;
  harness.integration.runtime.onWorkEpisodeOpened = (root, id) => {
    const observer = notify(root, id);
    observers.push(observer);
    return observer;
  };
  const settleOffers = () => Promise.all(observers);
  t.after(async () => { cleanupReleases.forEach((release) => release()); await settleOffers(); await rm(dir, { recursive: true, force: true }); });
  const ctx = context("/repo");
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
  return { ...harness, ctx, h, trialOffers, offersStore, settleOffers, beforeCleanup: (release: () => void) => cleanupReleases.push(release), projectId, episodeId: () => episodeId!, boundaries: () => boundaries };
}

test("T1 no-offer regression: exact ordinary prompt/context bytes and tool surface; ZERO extra invocation/messages", async (t) => {
  const offered = await t1ExtensionHarness(t, false), ordinary = createHarness();
  await ordinary.api.handler("session_start")({ type: "session_start", reason: "startup" }, offered.ctx);
  const event = { type: "before_agent_start", systemPrompt: "Native prompt", prompt: "Real Human work", systemPromptOptions: {} };
  assert.deepEqual(await offered.api.handler("before_agent_start")(event, offered.ctx), await ordinary.api.handler("before_agent_start")(event, offered.ctx));
  const params = { goal: "Real Human goal", successCriteria: ["done"] };
  assert.deepEqual(await offered.api.tool("pindie_task_start").execute("start", params), await ordinary.api.tool("pindie_task_start").execute("start", params));
  const messages = [{ role: "system", content: "Native prompt" }, { role: "user", content: "Real Human work" }];
  const frozen = JSON.stringify(messages);
  assert.equal(await offered.api.handler("context_with_system")({ type: "context_with_system", messages }, offered.ctx), undefined);
  assert.equal(JSON.stringify(messages), frozen);
  await offered.settleOffers();
  assert.equal((await offered.offersStore.find(offered.projectId, offered.episodeId()))?.receipt.outcome, "no-offer");
  assert.deepEqual(offered.api.getActiveTools(), ordinary.api.getActiveTools());
  assert.deepEqual(offered.api.sentMessages, ordinary.api.sentMessages);
  assert.deepEqual(offered.api.sentUserMessages, []);
  assert.deepEqual(offered.api.appendedEntries, ordinary.api.appendedEntries);
});

test("T1 new Task gets one transient block BEFORE next Task-model policy selection; refine/rerun stable; no trust leakage", async (t) => {
  const f = await t1ExtensionHarness(t), before = { type: "before_agent_start", systemPrompt: "Native", prompt: "Real Human work", systemPromptOptions: {} };
  await f.api.handler("before_agent_start")(before, f.ctx);
  await f.api.tool("pindie_task_start").execute("start", { goal: "Real Human goal", successCriteria: ["done"] });
  // The Task tool already returned. The test controls when the first model opportunity occurs.
  await f.settleOffers();
  const c = await f.offersStore.find(f.projectId, f.episodeId());
  assert.ok(c?.assignment);
  const messages = [{ role: "system", content: "Native" }];
  const event = { type: "context_with_system", messages };
  const first = await f.api.handler("context_with_system")(event, f.ctx) as any;
  assert.equal(first.messages.length, 2);
  assert.strictEqual(first.messages[0], messages[0]);
  assert.match(first.messages[1].content, /UNTRUSTED \/ EXPERIMENTAL \/ ADVISORY/);
  assert.ok(first.messages[1].content.includes(c.assignment.id));
  assert.equal(messages.length, 1); // No persistent Human transcript mutation.
  await f.api.tool("pindie_task_refine").execute("refine", { goal: "Refined real goal" });
  assert.deepEqual(await f.api.handler("context_with_system")(event, f.ctx), first);
  await f.api.handler("before_agent_start")(before, f.ctx);
  assert.deepEqual(await f.api.handler("context_with_system")(event, f.ctx), first);
  assert.equal(f.boundaries(), 1);
  assert.ok(!JSON.stringify(f.integration.trustedStrategyPortfolio).includes(f.h.id));
  await assert.rejects(f.api.tool("pindie_policy_set").execute("untrusted", { approach: { strategyId: f.h.logicalId, revisionIdentity: f.h.id, revisionFingerprint: f.h.fingerprint } }, undefined, undefined, f.ctx), /Invalid|unknown|Unknown|unavailable|armed|Candidate/);
  assert.deepEqual(f.api.sentUserMessages, []);
});

test("T1 replacement invalidates old lease; session/project change removes presentation; reconciled Task never retro-offered", async (t) => {
  const f = await t1ExtensionHarness(t), before = { type: "before_agent_start", systemPrompt: "", prompt: "Work", systemPromptOptions: {} };
  await f.api.handler("before_agent_start")(before, f.ctx);
  await f.api.tool("pindie_task_start").execute("start", { goal: "First", successCriteria: ["done"] });
  const first = f.episodeId();
  await f.settleOffers();
  const currentRequest = { type: "context_with_system", messages: [{ role: "system", content: "Native" }] };
  assert.ok(await f.api.handler("context_with_system")(currentRequest, f.ctx));
  const firstCommit = await f.offersStore.find(f.projectId, first);
  await f.api.handler("session_start")({ type: "session_start", reason: "switch" }, f.ctx);
  await f.api.handler("before_agent_start")(before, f.ctx);
  assert.equal(await f.api.handler("context_with_system")(currentRequest, f.ctx), undefined);
  assert.deepEqual(await f.offersStore.find(f.projectId, first), firstCommit);
  await f.api.tool("pindie_task_replace").execute("replace", { goal: "Second", successCriteria: ["done"] });
  assert.notEqual(f.episodeId(), first);
  assert.equal(f.boundaries(), 2);
  const event = { type: "context_with_system", messages: [{ role: "system", content: "Native" }] };
  // Default cooldown suppresses the second offer rather than reusing the old lease.
  assert.equal(await f.api.handler("context_with_system")(event, f.ctx), undefined);
  await f.api.handler("session_start")({ type: "session_start", reason: "switch" }, f.ctx);
  await f.api.handler("before_agent_start")(before, f.ctx);
  assert.equal(await f.api.handler("context_with_system")(event, f.ctx), undefined);
  await f.api.handler("session_start")({ type: "session_start", reason: "switch" }, context("/other"));
  assert.equal(await f.api.handler("context_with_system")(event, context("/other")), undefined);
  const existing = await t1ExtensionHarness(t, true, true);
  await existing.api.handler("before_agent_start")(before, existing.ctx);
  assert.equal(await existing.api.handler("context_with_system")(event, existing.ctx), undefined);
  assert.equal(await existing.offersStore.find(existing.projectId, existing.episodeId()), null);
  assert.equal(existing.boundaries(), 0);
});

test("T1 hung offer store cannot delay Task start/replace or context; a lost window never injects later", async (t) => {
  const f = await t1ExtensionHarness(t);
  const before = { type: "before_agent_start", systemPrompt: "Native", prompt: "Work", systemPromptOptions: {} };
  await f.api.handler("before_agent_start")(before, f.ctx);
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  f.beforeCleanup(release);
  const opened = f.trialOffers.opened.bind(f.trialOffers);
  let selections = 0;
  f.trialOffers.opened = async (...args) => { selections++; await blocked; return opened(...args); };
  const completed = async (name: string, goal: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([f.api.tool(name).execute(name, { goal, successCriteria: ["done"] }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Task waited for hung offer")), 250); })]);
    } finally { clearTimeout(timer); }
  };
  await completed("pindie_task_start", "First");
  await completed("pindie_task_replace", "Second");
  const request = { type: "context_with_system", messages: [{ role: "system", content: "Native" }] };
  // Synchronous context callback: not even a blocking Promise to compensate for hung selection.
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  release();
  await f.settleOffers();
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  await f.api.tool("pindie_task_refine").execute("refine", { goal: "Refined" });
  await f.api.tool("pindie_task_progress").execute("progress", { blockers: [], questions: [] });
  await f.api.handler("before_agent_start")(before, f.ctx);
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  await f.api.handler("session_start")({ type: "session_start", reason: "reload" }, f.ctx);
  await f.api.handler("before_agent_start")(before, f.ctx);
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  assert.equal(selections, 2);
});

test("T1 delayed notification cannot open a presentation window after context already advanced", async (t) => {
  const f = await t1ExtensionHarness(t);
  await f.api.handler("before_agent_start")({ type: "before_agent_start", systemPrompt: "", prompt: "Work", systemPromptOptions: {} }, f.ctx);
  let release!: () => void, finished!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const done = new Promise<void>((resolve) => { finished = resolve; });
  f.beforeCleanup(release);
  const notify = f.integration.runtime.onWorkEpisodeOpened!;
  f.integration.runtime.onWorkEpisodeOpened = async (...args) => { await blocked; await notify(...args); finished(); };
  await f.api.tool("pindie_task_start").execute("start", { goal: "First", successCriteria: ["done"] });
  const request = { type: "context_with_system", messages: [] };
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  release(); await done;
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
  assert.equal(await f.offersStore.find(f.projectId, f.episodeId()), null);
});

test("T1 late advisory preparation cannot revive a window closed by policy selection", async (t) => {
  const f = await t1ExtensionHarness(t);
  await f.api.handler("before_agent_start")({ type: "before_agent_start", systemPrompt: "", prompt: "Work", systemPromptOptions: {} }, f.ctx);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  f.beforeCleanup(release);
  const prepare = f.trialOffers.context.bind(f.trialOffers);
  f.trialOffers.context = async (...args) => { await blocked; return prepare(...args); };
  await f.api.tool("pindie_task_start").execute("start", { goal: "First", successCriteria: ["done"] });
  await f.api.handler("tool_call")(toolCall("pindie_policy_set", { approach: "direct-action" }), f.ctx);
  release();
  await f.settleOffers();
  assert.equal(f.api.handler("context_with_system")({ type: "context_with_system", messages: [] }, f.ctx), undefined);
});

test("T1 ready-cache presentation performs no offer/ledger I/O and checks exact observed episode", async (t) => {
  const f = await t1ExtensionHarness(t);
  await f.api.handler("before_agent_start")({ type: "before_agent_start", systemPrompt: "", prompt: "Work", systemPromptOptions: {} }, f.ctx);
  await f.api.tool("pindie_task_start").execute("start", { goal: "Ready", successCriteria: ["done"] });
  await f.settleOffers();
  f.trialOffers.context = async () => { throw new Error("Context must not read Trial I/O"); };
  const request = { type: "context_with_system", messages: [{ role: "system", content: "Native" }] };
  assert.ok(f.api.handler("context_with_system")(request, f.ctx));
  f.integration.runtime.observeWorkEpisode("/repo", f.integration.runtime.state, "different-episode");
  assert.equal(f.api.handler("context_with_system")(request, f.ctx), undefined);
});

test("Extension registration does not call Pi runtime action methods before runtime binding", async () => {
  const api = new CapturedExtensionAPI();
  const store = new ExtensionTestStore([["/repo", activeState()]]);
  assert.doesNotThrow(() => registerPindieExtension(
    api as unknown as ExtensionAPI,
    { store, resolveProjectRoot: async (cwd) => cwd },
  ));
  assert.deepEqual(api.appliedThinkingLevels, []);
  api.bindRuntime();
  api.thinkingLevel = "high";
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, context("/repo"));
  await api.handler("before_agent_start")({ type: "before_agent_start", systemPrompt: "", prompt: "", systemPromptOptions: {} }, context("/repo"));
  assert.deepEqual(api.appliedThinkingLevels, []);
  await api.commands.get("reasoning").handler("manual", context("/repo"));
  assert.deepEqual(api.appliedThinkingLevels, []);
});

test("Work Memory registration is conditional on an injected ProjectMemorySink", () => {
  const withoutMemory = createHarness([["/repo", activeState()]]);
  assert.equal(withoutMemory.api.tools.has("pindie_memory_capture"), false);

  const withMemory = createHarness(
    [["/repo", activeState()]],
    {},
    { projectMemorySink: new ExtensionTestMemorySink() },
  );
  assert.equal(withMemory.api.tools.has("pindie_memory_capture"), true);
  assert.equal(withMemory.api.tools.size, withoutMemory.api.tools.size + 1);
  assert.equal(
    [...withMemory.api.tools.keys()].filter((name) => name === "pindie_memory_capture").length,
    1,
  );
});

test("Presentation can be disabled without removing Core settlement or SI commands", async () => {
  let usageCalls = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      featureSelection: { selfImprovement: true, presentation: false },
      subscriptionUsageProvider: {
        fetchUsage: async () => {
          usageCalls += 1;
          return null;
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = {
    ...context("/repo"),
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => undefined,
      setStatus: (id: string, text: string | undefined) => statuses.push({ id, text }),
    },
  };

  assert.equal(harness.integration.featureSelection.selfImprovement, true);
  assert.equal(harness.integration.featureSelection.presentation, false);
  assert.ok(harness.integration.trial);
  assert.ok(harness.integration.derivation);
  assert.equal(harness.integration.reasoning, null);
  assert.equal(harness.integration.runActivity, null);
  assert.equal(harness.api.commands.has("efficiency"), false);
  assert.equal(harness.api.commands.has("reasoning"), false);
  assert.equal(harness.api.commands.has("experience"), true);
  assert.equal(harness.api.commands.has("strategies"), true);
  assert.equal(harness.api.commands.has("trial-review"), true);
  assert.equal(harness.api.handlers.has("thinking_level_select"), false);
  assert.equal(harness.api.handlers.has("turn_end"), false);
  assert.equal(harness.api.handlers.has("tool_execution_start"), false);
  assert.equal(harness.api.handlers.has("tool_execution_end"), false);

  await harness.api.handler("session_start")(
    { type: "session_start", reason: "startup" },
    uiContext,
  );
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", systemPrompt: "", prompt: "Continue", systemPromptOptions: {} },
    uiContext,
  );
  assert.equal(harness.integration.runTimer.active, true);
  assert.equal(usageCalls, 0);
  assert.deepEqual(statuses, []);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);
  assert.equal(harness.integration.runTimer.active, false);
});

test("registered Candidate tool descriptions require explicit matching commands", () => {
  const harness = createHarness([["/repo", activeState("Candidate descriptions")]]);
  for (const [name, command] of [
    ["pindie_strategy_candidate_create", "/adapt"],
    ["pindie_strategy_derivation_candidate_create", "/derive"],
    ["pindie_strategy_synthesis_candidate_create", "/derive-global"],
  ]) {
    const description = harness.api.tool(name).description as string;
    assert.match(description, /live .*Run \(explicit/);
    assert.ok(description.includes(command));
    assert.match(description, /explicit \/adapt|explicit \/derive/);
    assert.match(description, /Candidate creation is optional/);
    assert.doesNotMatch(description, /only during explicitly entered/);
  }
  assert.match(harness.api.tool("pindie_strategy_candidate_create").description, /target Strategy is fixed by that live adaptation attempt/);
  assert.match(harness.api.tool("pindie_strategy_derivation_candidate_create").description, /does not establish novelty, usefulness, superiority, or causality/);
  assert.match(harness.api.tool("pindie_strategy_synthesis_candidate_create").description, /does not establish novelty, usefulness, superiority, or causality/);
});

test("shared Candidate decision descriptions and usage cover local, scope, and synthesis routes", async () => {
  const harness = createHarness([["/repo", activeState("Candidate command help")]]);
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  for (const commandName of ["promote", "reject"] as const) {
    const command = harness.api.commands.get(commandName);
    assert.match(command.description, /Strategy Candidate \(local, scope, or synthesis\)/);
    await command.handler("id extra", ctx);
    assert.deepEqual(notices.at(-1), {
      message: `Usage: /${commandName} <candidate-id> | /${commandName} scope:<candidate-id> | /${commandName} synthesis:<candidate-id>`,
      type: "warning",
    });
  }
  await harness.api.commands.get("trial-review").handler("id extra", ctx);
  assert.deepEqual(notices.at(-1), {
    message: "Usage: /trial-review <candidate-id> | /trial-review scope:<candidate-id> | /trial-review synthesis:<candidate-id>",
    type: "warning",
  });
});

test("Candidate commands reject embedded whitespace consistently before namespace dispatch", async () => {
  const harness = createHarness([["/repo", activeState("Malformed Candidate subjects")]]);
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const id = "11111111-1111-4111-8111-111111111111";
  for (const commandName of ["trial", "trial-review", "promote", "reject"] as const) {
    for (const subject of [`${id} extra`, `scope:${id} extra`, `synthesis:${id} extra`, "scope:  value", "synthesis:\tvalue"]) {
      await harness.api.commands.get(commandName).handler(subject, ctx);
      assert.deepEqual(notices.at(-1), {
        message: `Usage: /${commandName} <candidate-id> | /${commandName} scope:<candidate-id> | /${commandName} synthesis:<candidate-id>`,
        type: "warning",
      }, `${commandName} ${JSON.stringify(subject)}`);
    }
  }
});

test("Candidate decisions report canonical ID errors without mislabeling the subject as a Trial or review", async () => {
  const harness = createHarness([["/repo", activeState("Malformed Candidate decisions")]]);
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  for (const commandName of ["promote", "reject"] as const) {
    for (const namespace of ["scope", "synthesis"] as const) {
      await harness.api.commands.get(commandName).handler(`${namespace}:not-a-uuid`, ctx);
      assert.match(notices.at(-1)?.message ?? "", new RegExp(`${namespace === "scope" ? "Scope" : "Synthesis"} Candidate ID must be a canonical lowercase UUID-v4\\.`));
      assert.doesNotMatch(notices.at(-1)?.message ?? "", /Trial Candidate ID|review Candidate ID/);
    }
  }
});

test("Slice E SI off keeps Core tools and Seed Policy without reading SI stores", async () => {
  const reader = new ExtensionTestExperienceReader();
  const experienceStore = new ExtensionTestExperienceStore();
  const harness = createHarness(
    [["/repo", activeState("Core-only task")]],
    {},
    {
      featureSelection: { selfImprovement: false },
      experienceReader: reader,
      experienceStore,
    },
  );

  assert.equal(harness.integration.featureSelection.selfImprovement, false);
  assert.equal(harness.integration.featureSelection.crossProjectLearning, false);
  assert.equal(harness.integration.trial, null);
  assert.equal(harness.integration.derivation, null);
  assert.equal(harness.integration.trustedStrategyPortfolio, null);
  for (const command of [
    "experience", "strategies", "trust-transfer", "adapt", "derive",
    "trial", "trial-review", "promote", "reject",
  ]) {
    assert.equal(harness.api.commands.has(command), false, `SI command '${command}' must be absent`);
  }
  for (const tool of [
    "pindie_strategy_candidate_create",
    "pindie_strategy_derivation_candidate_create",
  ]) {
    assert.equal(harness.api.tools.has(tool), false, `SI tool '${tool}' must be absent`);
  }
  for (const tool of [
    "pindie_policy_set",
    "pindie_task_start",
    "pindie_gate_open",
    "pindie_verification_record",
    "pindie_git_observe",
  ]) {
    assert.equal(harness.api.tools.has(tool), true, `Core tool '${tool}' must remain available`);
  }

  await startSession(harness, "/repo");
  const before = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(before.systemPrompt, /<PINDIE_(?:PROMOTED_STRATEGIES|ADAPTATION_PACKET|DERIVATION_PACKET)>/);
  assert.deepEqual(reader.roots, []);

  await executeSemanticTool(harness, "pindie_policy_set", "seed-policy", {
    approach: "direct-action",
  });
  assert.equal(harness.integration.policySnapshot?.approach.strategyId, "direct-action");
  const learned = trialCandidate();
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute(
      "learned-policy",
      {
        approach: {
          strategyId: learned.target.strategyId,
          revisionIdentity: learned.candidateId,
          revisionFingerprint: strategyCandidateSemanticFingerprint(learned),
        },
      },
      undefined,
      undefined,
      context("/repo"),
    ),
    /Seed Strategy ID/,
  );

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.deepEqual(reader.roots, []);
  assert.deepEqual(experienceStore.records, []);
});

test("CPL-off keeps local presentation while retaining global trust-safety reads", async () => {
  let globalReads = 0;
  const globalCandidates: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => {
      globalReads += 1;
      throw new Error("injected global authority is unavailable");
    },
    save: async () => undefined,
  };
  const globalDecisions: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => {
      globalReads += 1;
      throw new Error("injected global authority is unavailable");
    },
    save: async () => undefined,
  };
  const revisionReader = { read: async () => null, readAll: async () => [] };
  const derivationReader = { read: async () => null, readAll: async () => [] };
  const decisions = testDecisionStore();
  const derivationDecisions = testDerivationDecisionReader();
  const harness = createHarness(
    [["/repo", activeState("SI-only task")]],
    {},
    {
      featureSelection: { selfImprovement: true, crossProjectLearning: false },
      strategyCandidateReader: revisionReader,
      strategyDecisionStore: decisions,
      strategyDecisionReader: decisions,
      strategyDerivationCandidateReader: derivationReader,
      strategyDerivationDecisionReader: derivationDecisions,
      strategyTrustScopeCandidateStore: globalCandidates,
      strategyTrustScopeDecisionStore: globalDecisions,
      strategyTrustScopeSourceResolver: { resolve: async () => { throw new Error("not reached"); } },
    },
  );

  assert.equal(harness.integration.featureSelection.selfImprovement, true);
  assert.equal(harness.integration.featureSelection.crossProjectLearning, false);
  for (const command of ["experience", "strategies", "adapt", "derive", "trial", "trial-review", "promote", "reject"]) {
    assert.equal(harness.api.commands.has(command), true, `SI command '${command}' must be present`);
  }
  for (const command of ["trust-transfer"]) {
    assert.equal(harness.api.commands.has(command), false, `CPL command '${command}' must be absent`);
  }

  await startSession(harness, "/repo");
  await harnessBeforeAgentStart(harness, "/repo");
  assert.ok(globalReads > 0);
  const readsAfterRunStart = globalReads;
  const strategyNotices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("strategies").handler("", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => strategyNotices.push({ message, type }) },
  });
  assert.equal(globalReads, readsAfterRunStart);
  assert.doesNotMatch(strategyNotices.at(-1)?.message ?? "", /user-global/i);

  const trialOptions = await harness.api.commands.get("trial").getArgumentCompletions("");
  assert.deepEqual(trialOptions, []);
  await executeSemanticTool(harness, "pindie_policy_set", "si-only-seed-policy", {
    approach: "direct-action",
  });
  assert.equal(harness.integration.policySnapshot?.approach.strategyId, "direct-action");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(globalReads, readsAfterRunStart);
});

test("configured extension composes Memory and Discord options in one registration", () => {
  const memory = {
    PINDIE_NOTION_TOKEN: "test-notion-token",
    PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "test-data-source",
  };
  const discord = {
    PINDIE_DISCORD_TOKEN: "test-discord-token",
    PINDIE_DISCORD_USER_ID: "12345678901234567",
    PINDIE_DISCORD_GUILD_ID: "98765432109876543",
  };
  const cases = [
    { env: {}, memoryEnabled: false },
    { env: memory, memoryEnabled: true },
    { env: discord, memoryEnabled: false },
    { env: { ...memory, ...discord }, memoryEnabled: true },
  ];

  for (const { env, memoryEnabled } of cases) {
    const api = new CapturedExtensionAPI();
    assert.doesNotThrow(() => registerConfiguredPindieExtension(
      api as unknown as ExtensionAPI,
      {},
      env,
    ));
    assert.equal(api.tools.has("pindie_memory_capture"), memoryEnabled);
    assert.equal(api.handlers.size > 0, true);
  }

  const explicitSink = new ExtensionTestMemorySink();
  const explicitApi = new CapturedExtensionAPI();
  assert.doesNotThrow(() => registerConfiguredPindieExtension(
    explicitApi as unknown as ExtensionAPI,
    { projectMemorySink: explicitSink },
    memory,
  ));
  assert.equal(explicitApi.tools.has("pindie_memory_capture"), true);
});

test("configured registration returns only the narrow presentation reader", () => {
  const api = new CapturedExtensionAPI();
  const integration = registerConfiguredPindieExtension(
    api as unknown as ExtensionAPI,
    {},
    {},
  );

  assert.equal(typeof integration.presentation.snapshot, "function");
  assert.equal("setQuotaResumeWaiting" in integration.presentation, false);
  assert.equal(integration.presentation.snapshot().projectRoot, null);
});

test("registered Work Memory capture uses the runtime root, authoritative State, and Harness clock", async () => {
  const sink = new ExtensionTestMemorySink();
  const captureDate = new Date(2026, 8, 5, 12, 0, 0);
  const harness = createHarness(
    [["/workspace/Pindie", activeState("Authoritative Task goal")]],
    { "/repo": "/workspace/Pindie" },
    { projectMemorySink: sink, now: () => captureDate.getTime() },
  );
  await startSession(harness, "/repo");
  const before = await harnessBeforeAgentStart(harness, "/repo");
  assert.equal((before.systemPrompt.match(/<PINDIE_WORK_MEMORY_CONTRACT>/g) ?? []).length, 1);

  const input = {
    type: "decision",
    memory: "Keep Work Memory outside Pindie State",
    summary: "External Work Memory remains behind a narrow sink.",
    whyItMatters: "Pindie State stays limited to current semantic work.",
  };
  assert.equal(
    await callGuard(harness, toolCall("pindie_memory_capture", input)),
    undefined,
  );
  const result = await harness.api.tool("pindie_memory_capture").execute("capture", input);
  assert.match(textOf(result), /^Work Memory: created\.$/);
  assert.deepEqual(sink.captures, [{
    ...input,
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05",
    status: "Active",
    evidence: "Pindie · project=Pindie · task=Authoritative Task goal",
  }]);
});

test("Work Memory policy is absent when no sink is configured", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const before = await harnessBeforeAgentStart(harness, "/repo");
  assert.doesNotMatch(before.systemPrompt, /<PINDIE_WORK_MEMORY_CONTRACT>/);
  assert.doesNotMatch(before.systemPrompt, /Task completion is not itself a Milestone/);
});

test("Slice F selected features keep one registration set and rebuild Core authority across reload and shutdown", async () => {
  let sessionBinds = 0;
  const sessionBindWaiters = new Map<string, Array<() => void>>();
  const waitForSessionBind = (sessionId: string): Promise<void> =>
    new Promise((resolve) => {
      const waiters = sessionBindWaiters.get(sessionId) ?? [];
      waiters.push(resolve);
      sessionBindWaiters.set(sessionId, waiters);
    });
  const remoteSurface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async (_channelId, sessionId) => {
      sessionBinds += 1;
      sessionBindWaiters.get(sessionId)?.shift()?.();
      return { threadId: `thread-${sessionId}`, anchorMessageId: "anchor", headerMessageId: null };
    },
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const remote = new RemoteCompanion(remoteSurface);
  const harness = createHarness(
    [["/repo", activeState("Final composition lifecycle")]],
    {},
    {
      featureSelection: {
        selfImprovement: true,
        crossProjectLearning: true,
        remote: true,
        workMemory: true,
        bundledSkills: true,
        presentation: true,
      },
      remoteCompanion: { companion: remote, guildId: "guild" },
      projectMemorySink: new ExtensionTestMemorySink(),
    },
  );
  const tools = [...harness.api.tools.keys()].sort();
  const commands = [...harness.api.commands.keys()].sort();
  const handlers = [...harness.api.handlers.keys()].sort();
  assert.equal(new Set(tools).size, tools.length);
  assert.equal(new Set(commands).size, commands.length);
  assert.equal(new Set(handlers).size, handlers.length);
  assert.equal(new Set(harness.api.toolRegistrations).size, harness.api.toolRegistrations.length);
  assert.equal(new Set(harness.api.commandRegistrations).size, harness.api.commandRegistrations.length);
  assert.equal(new Set(harness.api.handlerRegistrations).size, harness.api.handlerRegistrations.length);
  assert.equal(harness.api.tools.has("pindie_memory_capture"), true);
  assert.equal(harness.api.commands.has("trust-transfer"), true);
  assert.equal(harness.api.commands.has("efficiency"), true);
  assert.equal(harness.api.commands.has("reasoning"), true);
  assert.equal(harness.api.handlers.has("input"), true);
  assert.equal(harness.api.handlers.has("message_end"), true);

  const entries = [{ id: "u", message: { role: "user", content: "lifecycle" } }];
  const sessionStart = async (reason: string, sessionId: string): Promise<void> => {
    await harness.api.handler("session_start")(
      { type: "session_start", reason },
      context("/repo", entries, false, sessionId),
    );
  };
  const beforeAgentStart = async (sessionId: string): Promise<{ systemPrompt: string }> =>
    await harness.api.handler("before_agent_start")(
      {
        type: "before_agent_start",
        prompt: "Continue",
        systemPrompt: "Pi system prompt",
        systemPromptOptions: {},
      },
      context("/repo", entries, false, sessionId),
    ) as { systemPrompt: string };
  const sessionShutdown = async (reason: string, sessionId: string): Promise<void> => {
    await harness.api.handler("session_shutdown")(
      { type: "session_shutdown", reason },
      context("/repo", [], false, sessionId),
    );
  };

  const firstSessionBind = waitForSessionBind("session-a");
  await sessionStart("startup", "session-a");
  const first = await beforeAgentStart("session-a");
  await firstSessionBind;
  assert.equal((first.systemPrompt.match(/<PINDIE_WORK_MEMORY_CONTRACT>/g) ?? []).length, 1);
  assert.equal(remote.activeSessionId, "session-a");
  assert.equal(harness.integration.runtime.projectRoot, "/repo");
  assert.equal(harness.integration.runTimer.active, true);

  await sessionShutdown("reload", "session-a");
  assert.equal(remote.activeSessionId, null);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.equal(harness.integration.runTimer.active, false);
  assert.equal(harness.integration.runActivity?.activity, null);
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.derivation?.hasDerivation, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  assert.equal(harness.api.toolRegistrations.length, tools.length);
  assert.equal(harness.api.commandRegistrations.length, commands.length);
  assert.equal(harness.api.handlerRegistrations.length, handlers.length);

  const reloadSessionBind = waitForSessionBind("session-a");
  await sessionStart("reload", "session-a");
  const second = await beforeAgentStart("session-a");
  await reloadSessionBind;
  assert.equal((second.systemPrompt.match(/<PINDIE_WORK_MEMORY_CONTRACT>/g) ?? []).length, 1);
  assert.equal(remote.activeSessionId, "session-a");
  assert.equal(harness.integration.runtime.projectRoot, "/repo");

  await sessionShutdown("new", "session-a");
  const newSessionBind = waitForSessionBind("session-b");
  await sessionStart("new", "session-b");
  const third = await beforeAgentStart("session-b");
  await newSessionBind;
  assert.equal((third.systemPrompt.match(/<PINDIE_WORK_MEMORY_CONTRACT>/g) ?? []).length, 1);
  assert.equal(remote.activeSessionId, "session-b");
  assert.equal(harness.integration.runtime.projectRoot, "/repo");
  assert.equal(sessionBinds, 3);
  assert.deepEqual([...harness.api.tools.keys()].sort(), tools);
  assert.deepEqual([...harness.api.commands.keys()].sort(), commands);
  assert.deepEqual([...harness.api.handlers.keys()].sort(), handlers);

  await sessionShutdown("done", "session-b");
  assert.equal(remote.activeSessionId, null);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.derivation?.hasDerivation, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
});

async function startSession(
  harness: ReturnType<typeof createHarness>,
  cwd: string,
  reason = "startup",
  sessionEntries: unknown[] = [],
): Promise<void> {
  await harness.api.handler("session_start")(
    { type: "session_start", reason },
    context(cwd, sessionEntries),
  );
}

async function beginAgentRun(
  harness: ReturnType<typeof createHarness>,
  cwd = "/repo",
  sessionEntries: unknown[] = [],
): Promise<void> {
  await harnessBeforeAgentStart(harness, cwd, sessionEntries);
}

async function harnessBeforeAgentStart(
  harness: ReturnType<typeof createHarness>,
  cwd = "/repo",
  sessionEntries: unknown[] = [],
): Promise<{
  systemPrompt: string;
  message: { customType: string; content: string; display: boolean };
}> {
  return await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context(cwd, sessionEntries),
  ) as {
    systemPrompt: string;
    message: { customType: string; content: string; display: boolean };
  };
}

function contextUsage(percent: number | null, contextWindow = 100): ContextUsage {
  return {
    tokens: percent === null ? null : percent,
    contextWindow,
    percent,
  };
}

async function projectContext(
  harness: ReturnType<typeof createHarness>,
  percent: number | null,
  messages: unknown[] = [],
): Promise<unknown> {
  return harness.api.handler("context")(
    { type: "context", messages },
    context("/repo", [], false, "remote-session", undefined, contextUsage(percent)),
  );
}

function contextLifecycleMessages(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== "object" || result === null || !("messages" in result)) return [];
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter((message): message is Record<string, unknown> =>
    typeof message === "object" &&
    message !== null &&
    (message as { customType?: unknown }).customType === PINDIE_CONTEXT_LIFECYCLE_TYPE,
  );
}

async function callGuard(
  harness: ReturnType<typeof createHarness>,
  event: Record<string, unknown>,
): Promise<any> {
  return harness.api.handler("tool_call")(event, context("/repo"));
}

async function captureObservationEvidence(
  harness: ReturnType<typeof createHarness>,
  toolCallId = "evidence-read",
  options: {
    toolName?: string;
    input?: Record<string, unknown>;
    content?: Array<Record<string, unknown>>;
    isError?: boolean;
  } = {},
): Promise<{ ref: string; result: { content: Array<{ type: string; text?: string }> } }> {
  const toolName = options.toolName ?? "read";
  const input = options.input ?? { path: "src/index.ts" };
  assert.equal(
    await callGuard(harness, toolCall(toolName, input, toolCallId)),
    undefined,
  );
  const result = await harness.api.handler("tool_result")(
    toolResult(
      toolName,
      options.isError ?? false,
      toolCallId,
      options.content ?? [{ type: "text", text: "Observed current project reality." }],
      input,
    ),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  const marker = textOf(result).match(/\[Pindie evidence ref: (ev:[^\]]+)\]/);
  assert.ok(marker, `Expected a Pindie evidence marker for ${toolCallId}.`);
  return { ref: marker[1], result };
}

async function executeSemanticTool(
  harness: ReturnType<typeof createHarness>,
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
): Promise<{
  executionResult: { content: Array<Record<string, unknown>> };
  resultPatch: unknown;
}> {
  assert.equal(
    await callGuard(harness, toolCall(toolName, input, toolCallId)),
    undefined,
  );
  const executionResult = await harness.api.tool(toolName).execute(
    toolCallId,
    input,
    undefined,
    undefined,
    context("/repo"),
  ) as { content: Array<Record<string, unknown>> };
  const resultPatch = await harness.api.handler("tool_result")(
    toolResult(
      toolName,
      false,
      toolCallId,
      executionResult.content,
      input,
    ),
    context("/repo"),
  );
  return { executionResult, resultPatch };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function assertBlocked(result: any, reason: RegExp): void {
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", reason);
}

test("EI20-EI30 /efficiency is registered and reads runtime facts without mutation", async () => {
  const entries: unknown[] = [{
    type: "message",
    message: {
      role: "assistant",
      usage: { input: 1_200, output: 20, cacheRead: 203_000, cacheWrite: 0, cost: { total: 4.048 } },
    },
  }];
  const harness = createHarness([["/repo", activeState()]]);
  assert.ok(harness.api.commands.has("efficiency"));
  assert.deepEqual(harness.api.appliedThinkingLevels, []);
  await startSession(harness, "/repo", "startup", entries);
  harness.integration.reasoning.setManual();
  harness.integration.reasoning.synchronizeEffective("high");
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const reasoningBefore = harness.integration.reasoning.snapshot;
  const notices: Array<{ message: string; type: string }> = [];
  let entryReads = 0;
  let contextReads = 0;
  const commandContext = {
    ...context("/repo"),
    mode: "tui",
    sessionManager: { getEntries: () => { entryReads += 1; return entries; } },
    getContextUsage: () => {
      contextReads += 1;
      return { tokens: 204_000, contextWindow: 272_000, percent: 74.8 };
    },
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };

  await harness.api.commands.get("efficiency").handler("", commandContext);

  assert.equal(entryReads, 1);
  assert.equal(contextReads, 1);
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(notices.at(-1)?.message ?? "", /Reasoning: manual · requested medium · effective high/);
  assert.match(notices.at(-1)?.message ?? "", /Context: 204k \/ 272k · 74.8%/);
  assert.match(notices.at(-1)?.message ?? "", /CH 99.4%/);
  assert.deepEqual(harness.integration.reasoning.snapshot, reasoningBefore);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, []);
  assert.deepEqual(harness.api.appliedThinkingLevels, []);
  assert.deepEqual(harness.api.sentMessages, []);
  assert.deepEqual(harness.api.appendedEntries, []);

  await harness.api.commands.get("efficiency").handler("unexpected", commandContext);
  assert.deepEqual(notices.at(-1), { message: "Usage: /efficiency", type: "warning" });
  assert.equal(entryReads, 1);
  assert.equal(contextReads, 1);
  assert.deepEqual(harness.integration.reasoning.snapshot, reasoningBefore);
  assert.deepEqual(harness.store.saves, []);
});

test("SI v0.4 /experience renders empty and mixed evidence read-only", async () => {
  const reader = new ExtensionTestExperienceReader();
  const harness = createHarness([["/repo", activeState()]], {}, { experienceReader: reader });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const toolsBefore = harness.api.getActiveTools();
  const epochBefore = harness.integration.runtime.externalStateEpoch;

  assert.ok(harness.api.commands.has("experience"));
  await harness.api.commands.get("experience").handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Loaded current Experience records: 0/);
  assert.match(notices.at(-1)?.message ?? "", /Evaluated Runs: 0/);
  assert.match(notices.at(-1)?.message ?? "", /Attributable Runs: 0/);
  assert.match(notices.at(-1)?.message ?? "", /Non-attributable Runs: 0/);
  assert.match(notices.at(-1)?.message ?? "", /Comparable exact-goal cohorts: 0/);
  assert.equal(notices.at(-1)?.type, "info");
  assert.deepEqual(reader.roots, ["/repo"]);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.equal(harness.integration.runtime.externalStateEpoch, epochBefore);
  assert.equal(harness.integration.policySnapshot, null);
  assert.deepEqual(harness.api.getActiveTools(), toolsBefore);
  assert.deepEqual(harness.store.saves, []);

  reader.result = {
    records: [
      { recordId: "no-policy.json", experience: commandExperience("same goal") },
      {
        recordId: "explicit.json",
        experience: commandExperience(
          "same goal",
          createPolicySnapshot({ approach: "direct-action" }),
        ),
      },
      {
        recordId: "completed-before.json",
        experience: completedBeforeCommandExperience(
          "same goal",
          createPolicySnapshot({ approach: "direct-action" }),
        ),
      },
    ],
    loadedRecords: 3,
    unsupportedSchema: 1,
    invalid: 1,
  };
  await harness.api.commands.get("experience").handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Loaded current Experience records: 3/);
  assert.match(notices.at(-1)?.message ?? "", /Unsupported-schema records: 1/);
  assert.match(notices.at(-1)?.message ?? "", /Invalid\/unreadable records: 1/);
  assert.match(notices.at(-1)?.message ?? "", /Evaluated Runs: 3/);
  assert.match(notices.at(-1)?.message ?? "", /Attributable Runs: 2/);
  assert.match(notices.at(-1)?.message ?? "", /Non-attributable Runs: 1/);
  assert.match(notices.at(-1)?.message ?? "", /Explicit-Policy Runs: 2/);
  assert.match(notices.at(-1)?.message ?? "", /No-explicit-Policy Runs: 1/);
  assert.match(notices.at(-1)?.message ?? "", /Comparable exact-goal cohorts: 1/);
  assert.match(notices.at(-1)?.message ?? "", /no Strategy score, ranking, or causal claim/);
  assert.doesNotMatch(notices.at(-1)?.message ?? "", /completed-before\.json/);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.equal(harness.integration.runtime.externalStateEpoch, epochBefore);
  assert.equal(harness.integration.policySnapshot, null);
  assert.deepEqual(harness.api.getActiveTools(), toolsBefore);
  assert.deepEqual(harness.store.saves, []);

  await harness.api.commands.get("experience").handler("unexpected", commandContext);
  assert.deepEqual(notices.at(-1), { message: "Usage: /experience", type: "warning" });
  assert.deepEqual(reader.roots, ["/repo", "/repo"]);

  const noRootReader = new ExtensionTestExperienceReader();
  const noRoot = createHarness([], {}, { experienceReader: noRootReader });
  const noRootNotices: Array<{ message: string; type: string }> = [];
  await noRoot.api.commands.get("experience").handler("", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => noRootNotices.push({ message, type }) },
  });
  assert.deepEqual(noRootNotices.at(-1), {
    message: "Pindie could not show /experience: no current project root is loaded.",
    type: "warning",
  });
  assert.deepEqual(noRootReader.roots, []);
});

test("SI v0.7 /strategies lists the complete Seed portfolio and stays read-only", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("strategies");
  assert.ok(command);
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const savesBefore = structuredClone(harness.store.saves);
  const commandContext = {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };

  await command.handler("", commandContext);
  const report = notices.at(-1)?.message ?? "";
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(report, /^Trusted Strategy Portfolio/);
  assert.match(report, /Approaches/);
  assert.match(report, /Modifiers/);
  for (const strategy of SEED_STRATEGIES) assert.ok(report.includes(strategy.id));
  assert.match(report, /Trusted entries: 7/);
  assert.match(report, /Logical Strategy identities: 7/);
  assert.doesNotMatch(report, /sha256:/);
  assert.doesNotMatch(report, /sourceRecordIds|candidateId|trialRecordIds|hypothesis:/);

  const completions = await command.getArgumentCompletions("");
  assert.ok(completions);
  assert.deepEqual(
    completions!.map((option: any) => option.value),
    [...SEED_STRATEGIES].map((strategy) => strategy.id).sort(),
  );
  await command.handler("architecture-first", commandContext);
  const detail = notices.at(-1)?.message ?? "";
  assert.match(detail, /Trusted Strategy: architecture-first/);
  assert.match(detail, /Logical Strategy ID: architecture-first/);
  assert.match(detail, /Kind: approach/);
  assert.match(detail, /Origin: seed/);
  assert.match(detail, /Revision identity: seed/);
  assert.match(detail, /Revision status: seed/);
  assert.match(detail, /Use when:/);
  assert.match(detail, /Principles:/);

  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, savesBefore);
  assert.equal(harness.api.sentUserMessages.length, 0);
});

test("SI v0.7 /strategies groups trusted Seed revisions and Derived identities", async () => {
  const artifacts = trustedStrategyCommandArtifacts();
  const revisionCandidates = {
    read: async (_root: string, candidateId: string) =>
      candidateId === artifacts.promotedSeedCandidate.candidateId
        ? artifacts.promotedSeedCandidate
        : null,
  };
  const derivationCandidates = {
    read: async (_root: string, candidateId: string) =>
      candidateId === artifacts.promotedDerivedCandidate.candidateId
        ? artifacts.promotedDerivedCandidate
        : null,
  };
  const revisionDecisions = testDecisionStore([artifacts.promotedSeedDecision]);
  const derivationDecisions = testDerivationDecisionReader([artifacts.promotedDerivedDecision]);
  const candidateSaves: unknown[] = [];
  const derivationCandidateSaves: unknown[] = [];
  const harness = createHarness([["/repo", activeState()]], {}, {
    strategyCandidateReader: revisionCandidates,
    strategyCandidateStore: { save: async (_root, candidate) => { candidateSaves.push(candidate); } },
    strategyDecisionReader: revisionDecisions,
    strategyDecisionStore: revisionDecisions,
    strategyDerivationCandidateReader: derivationCandidates,
    strategyDerivationCandidateStore: {
      save: async (_root, candidate) => { derivationCandidateSaves.push(candidate); },
    },
    strategyDerivationDecisionReader: derivationDecisions,
  });
  await startSession(harness, "/repo");
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const savesBefore = structuredClone(harness.store.saves);
  const revisionDecisionsBefore = [...revisionDecisions.decisions.entries()];
  const derivationDecisionsBefore = [...derivationDecisions.decisions.entries()];
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("strategies");
  assert.ok(command);
  const commandContext = {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };

  await command.handler("", commandContext);
  const report = notices.at(-1)?.message ?? "";
  assert.equal(notices.at(-1)?.type, "info");
  assert.ok(report.indexOf("Approaches") < report.indexOf("Modifiers"));
  assert.ok(report.indexOf("architecture-first") < report.indexOf("Modifiers"));
  assert.ok(report.indexOf("delivery-checkpoints") > report.indexOf("Modifiers"));
  assert.match(report, /architecture-first · promoted 11111111/);
  assert.match(report, /promoted Seed revision/);
  assert.match(report, /delivery-checkpoints · promoted 22222222/);
  assert.match(report, /promoted Derived Strategy/);
  assert.match(report, /Trusted entries: 9/);
  assert.match(report, /Logical Strategy identities: 8/);
  assert.doesNotMatch(report, new RegExp(artifacts.promotedSeedCandidate.candidateId));
  assert.doesNotMatch(report, new RegExp(artifacts.promotedDerivedCandidate.candidateId));
  assert.doesNotMatch(report, /sha256:/);
  assert.doesNotMatch(report, /sourceRecordIds|candidateId|trialRecordIds|hypothesis:/);

  const completions = await command.getArgumentCompletions("");
  assert.ok(completions);
  const completionIds = completions!.map((option: any) => option.value);
  assert.equal(completionIds.length, new Set(completionIds).size);
  assert.equal(completionIds.length, 8);
  assert.ok(completionIds.includes("architecture-first"));
  assert.ok(completionIds.includes("delivery-checkpoints"));
  assert.deepEqual(
    await command.getArgumentCompletions("delivery"),
    [{ value: "delivery-checkpoints", label: "delivery-checkpoints" }],
  );

  await command.handler("architecture-first", commandContext);
  const architectureDetail = notices.at(-1)?.message ?? "";
  assert.match(architectureDetail, /Trusted Strategy: architecture-first/);
  assert.match(architectureDetail, /Trusted entries: 2/);
  assert.equal(
    (architectureDetail.match(/Logical Strategy ID: architecture-first/g) ?? []).length,
    2,
  );
  assert.match(architectureDetail, /Origin: seed/);
  assert.match(architectureDetail, /Origin: promoted Seed revision/);
  assert.ok(architectureDetail.includes(`Revision identity: ${artifacts.promotedSeedCandidate.candidateId}`));
  assert.ok(architectureDetail.includes(`Revision status: promoted`));
  assert.ok(architectureDetail.includes(
    `Revision fingerprint: ${strategyCandidateSemanticFingerprint(artifacts.promotedSeedCandidate)}`,
  ));
  assert.match(architectureDetail, /Use when:/);
  assert.match(architectureDetail, /Avoid when:/);
  assert.match(architectureDetail, /Principles:/);

  await command.handler("delivery-checkpoints", commandContext);
  const derivedDetail = notices.at(-1)?.message ?? "";
  assert.match(derivedDetail, /Trusted Strategy: delivery-checkpoints/);
  assert.match(derivedDetail, /Logical Strategy ID: delivery-checkpoints/);
  assert.match(derivedDetail, /Kind: modifier/);
  assert.match(derivedDetail, /Origin: promoted Derived Strategy/);
  assert.ok(derivedDetail.includes(`Revision identity: ${artifacts.promotedDerivedCandidate.candidateId}`));
  assert.ok(derivedDetail.includes(
    `Revision fingerprint: ${strategyDerivationCandidateSemanticFingerprint(artifacts.promotedDerivedCandidate)}`,
  ));
  assert.match(derivedDetail, /bounded checkpoints/);
  assert.match(derivedDetail, /Use when:/);
  assert.match(derivedDetail, /Avoid when:/);
  assert.match(derivedDetail, /Principles:/);

  await command.handler("not-trusted", commandContext);
  assert.equal(notices.at(-1)?.type, "warning");
  assert.match(notices.at(-1)?.message ?? "", /not a currently trusted logical Strategy ID/);

  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, savesBefore);
  assert.deepEqual([...revisionDecisions.decisions.entries()], revisionDecisionsBefore);
  assert.deepEqual([...derivationDecisions.decisions.entries()], derivationDecisionsBefore);
  assert.deepEqual(candidateSaves, []);
  assert.deepEqual(derivationCandidateSaves, []);
  assert.equal(harness.api.sentUserMessages.length, 0);
});

test("SI v0.7 /strategies preserves exact global and local trust deduplication", async () => {
  const artifacts = trustedStrategyCommandArtifacts();
  const sourceSelection = createStrategyRevisionSelection({
    strategyId: artifacts.promotedDerivedCandidate.proposal.strategyId,
    kind: artifacts.promotedDerivedCandidate.proposal.kind,
    revisionIdentity: artifacts.promotedDerivedCandidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(artifacts.promotedDerivedCandidate),
    revisionStatusAtRun: "promoted",
    semantics: artifacts.promotedDerivedCandidate.proposal,
  });
  const sourceCatalog = createPromotedDerivedStrategyCatalog([{
    candidate: artifacts.promotedDerivedCandidate,
    decision: artifacts.promotedDerivedDecision,
    selection: sourceSelection,
  }]);
  const scopeCandidate = createStrategyTrustScopeCandidate({
    candidateId: "66666666-0000-4000-8000-000000000106",
    sourceStrategy: {
      sourceProjectId: artifacts.promotedDerivedCandidate.projectId,
      strategyId: artifacts.promotedDerivedCandidate.proposal.strategyId,
      kind: artifacts.promotedDerivedCandidate.proposal.kind,
      revisionIdentity: artifacts.promotedDerivedCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(artifacts.promotedDerivedCandidate),
    },
    createdAt: "2026-03-05T00:00:00.000Z",
  });
  const globalDecision = promotedGlobalScopeDecision(scopeCandidate);
  const globalCandidateStore: StrategyTrustScopeCandidateStore = {
    read: async (candidateId) => candidateId === scopeCandidate.candidateId ? scopeCandidate : null,
    readAll: async () => [scopeCandidate],
    save: async () => undefined,
  };
  const globalDecisionStore: StrategyTrustScopeDecisionStore = {
    read: async (candidateId) => candidateId === globalDecision.candidateId ? globalDecision : null,
    readAll: async () => [globalDecision],
    save: async () => undefined,
  };
  const harness = createHarness([['/repo', activeState()]], {}, {
    strategyCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === artifacts.promotedSeedCandidate.candidateId
        ? artifacts.promotedSeedCandidate
        : null,
    },
    strategyDerivationCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === artifacts.promotedDerivedCandidate.candidateId
        ? artifacts.promotedDerivedCandidate
        : null,
    },
    strategyDecisionStore: testDecisionStore([artifacts.promotedSeedDecision]),
    strategyDecisionReader: testDecisionStore([artifacts.promotedSeedDecision]),
    strategyDerivationDecisionReader: testDerivationDecisionReader([artifacts.promotedDerivedDecision]),
    strategyTrustScopeCandidateStore: globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionStore,
    strategyTrustScopeSourceResolver: {
      resolve: async (sourceStrategy) => ({
        sourceStrategy,
        candidate: artifacts.promotedDerivedCandidate,
        decision: artifacts.promotedDerivedDecision,
        selection: sourceSelection,
        promotedDerivedCatalog: sourceCatalog,
      }),
    },
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("strategies");
  assert.ok(command);
  const notices: Array<{ message: string; type: string }> = [];
  await command.handler("delivery-checkpoints", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  const detail = notices.at(-1)?.message ?? "";
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(detail, /Trusted Strategy: delivery-checkpoints/);
  assert.match(detail, /Trust: user-global \+ project-local/);
  assert.doesNotMatch(detail, /Optional user-global layer: unavailable/);
});

test("SI v0.7 /strategies keeps a local portfolio when optional trust reconstruction fails", async () => {
  const failingDecisionReader = {
    read: async () => null,
    readAll: async () => { throw new Error("trust artifacts unavailable"); },
  };
  const harness = createHarness([["/repo", activeState()]], {}, {
    strategyDecisionReader: failingDecisionReader,
  });
  await startSession(harness, "/repo");
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const savesBefore = structuredClone(harness.store.saves);
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("strategies");
  assert.ok(command);

  const fallbackCompletions = await command.getArgumentCompletions("");
  assert.ok(fallbackCompletions);
  assert.deepEqual(
    fallbackCompletions!.map((option: any) => option.value),
    SEED_STRATEGIES.map((strategy) => strategy.id).sort(),
  );
  await command.handler("", {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(notices.at(-1)?.message ?? "", /Trusted Strategy Portfolio/);
  assert.match(notices.at(-1)?.message ?? "", /Optional user-global layer: unavailable/);
  assert.match(notices.at(-1)?.message ?? "", /trust artifacts unavailable/);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, savesBefore);

  const noRoot = createHarness();
  const noRootNotices: Array<{ message: string; type: string }> = [];
  await noRoot.api.commands.get("strategies").handler("", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => noRootNotices.push({ message, type }) },
  });
  assert.match(noRootNotices.at(-1)?.message ?? "", /no current project root.*no complete portfolio/i);
  assert.equal(await noRoot.api.commands.get("strategies").getArgumentCompletions(""), null);
});

test("SI v0.7 /strategies isolates a conflicting optional global revision", async () => {
  const localCandidate = derivationTrialCandidate(
    "55555555-0000-4000-8000-000000000105",
  );
  const localDecision = createStrategyDerivationDecision({
    candidate: localCandidate,
    decision: "promoted",
    trialRecordIds: ["local-trial-one", "local-trial-two"],
    decidedAt: "2026-03-04T00:00:00.000Z",
  });
  const localCandidateReader = {
    read: async (_root: string, candidateId: string) => candidateId === localCandidate.candidateId
      ? localCandidate
      : null,
  };
  const localDecisionReader = testDerivationDecisionReader([localDecision]);
  const global = scopeTrialTestDependencies();
  const globalDecision = promotedGlobalScopeDecision(global.scopeCandidate);
  const globalDecisionReader: StrategyTrustScopeDecisionStore = {
    read: async (candidateId) => candidateId === globalDecision.candidateId ? globalDecision : null,
    readAll: async () => [globalDecision],
    save: async () => undefined,
  };
  const harness = createHarness([['/repo', activeState()]], {}, {
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDerivationCandidateReader: localCandidateReader,
    strategyDerivationDecisionReader: localDecisionReader,
    strategyDecisionStore: testDecisionStore(),
    strategyTrustScopeCandidateStore: global.globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionReader,
    strategyTrustScopeSourceResolver: global.sourceResolver,
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("strategies");
  assert.ok(command);
  const completions = await command.getArgumentCompletions("boundary");
  assert.deepEqual(completions, [{ value: "boundary-first", label: "boundary-first" }]);
  const notices: Array<{ message: string; type: string }> = [];
  await command.handler("", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  const report = notices.at(-1)?.message ?? "";
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(report, /Trusted Strategy Portfolio/);
  assert.match(report, /boundary-first · promoted 55555555/);
  assert.doesNotMatch(report, /33333333/);
  assert.match(report, /Optional user-global layer: unavailable/);
  assert.match(report, /conflicting Derived logical Strategy identity/i);
  assert.match(report, /Project-local and immutable Seed Strategies remain available/);
});

test("SI v0.7 /strategies keeps local inspection when optional global artifacts are malformed", async () => {
  const artifacts = trustedStrategyCommandArtifacts();
  const revisionDecisions = testDecisionStore([artifacts.promotedSeedDecision]);
  const derivationDecisions = testDerivationDecisionReader([artifacts.promotedDerivedDecision]);
  const brokenGlobalCandidates: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => { throw new Error("malformed global Scope artifact"); },
    save: async () => undefined,
  };
  const emptyGlobalDecisions: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const harness = createHarness([['/repo', activeState()]], {}, {
    strategyCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === artifacts.promotedSeedCandidate.candidateId
        ? artifacts.promotedSeedCandidate
        : null,
    },
    strategyDerivationCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === artifacts.promotedDerivedCandidate.candidateId
        ? artifacts.promotedDerivedCandidate
        : null,
    },
    strategyDecisionStore: revisionDecisions,
    strategyDecisionReader: revisionDecisions,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyTrustScopeCandidateStore: brokenGlobalCandidates,
    strategyTrustScopeDecisionStore: emptyGlobalDecisions,
    strategyTrustScopeSourceResolver: { resolve: async () => { throw new Error("unavailable"); } },
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("strategies");
  assert.ok(command);
  assert.deepEqual(
    await command.getArgumentCompletions("delivery"),
    [{ value: "delivery-checkpoints", label: "delivery-checkpoints" }],
  );
  const notices: Array<{ message: string; type: string }> = [];
  await command.handler("delivery-checkpoints", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  const detail = notices.at(-1)?.message ?? "";
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(detail, /Trusted Strategy: delivery-checkpoints/);
  assert.match(detail, /promoted Derived Strategy/);
  assert.match(detail, /Optional user-global layer: unavailable/);
  assert.match(detail, /malformed global Scope artifact/);
});

test("SI v0.6 /trial-review renders read-only Candidate and Seed evidence", async () => {
  const selectedCandidate = trialCandidate();
  const reader = new ExtensionTestExperienceReader();
  const candidateReader = {
    roots: [] as string[],
    async read(projectRoot: string, candidateId: string) {
      this.roots.push(`${projectRoot}:${candidateId}`);
      return candidateId === selectedCandidate.candidateId ? selectedCandidate : null;
    },
  };
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    experienceReader: reader,
    strategyCandidateReader: candidateReader,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const command = harness.api.commands.get("trial-review");
  assert.ok(command);

  await command.handler(selectedCandidate.candidateId, {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });

  assert.deepEqual(candidateReader.roots, [`/repo:${selectedCandidate.candidateId}`]);
  assert.deepEqual(reader.roots, ["/repo"]);
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(notices.at(-1)?.message ?? "", /Candidate Trial Review/);
  assert.match(notices.at(-1)?.message ?? "", /Candidate Trial Evidence/);
  assert.match(notices.at(-1)?.message ?? "", /Seed Baseline Evidence/);
  assert.match(notices.at(-1)?.message ?? "", /Promotion Eligibility: not eligible/);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, []);

  await command.handler("not-a-candidate", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.match(notices.at(-1)?.message ?? "", /canonical lowercase UUID-v4/i);
});

test("SI v0.7 /trial-review dispatches Derivation Candidates with separate read-only evidence", async () => {
  const candidate = derivationTrialCandidate("00000000-0000-4000-8000-000000000031");
  const selection = {
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
    revisionStatusAtRun: "trial" as const,
    semantics: candidate.proposal,
  };
  const derivationPolicy = createPolicySnapshotFromRevisions({ approach: selection });
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "derive-one", experience: commandExperience("source one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "derive-two", experience: commandExperience("source one", createPolicySnapshot({ approach: "direct-action", modifiers: ["minimal-change"] })) },
      { recordId: "derive-three", experience: commandExperience("source two", createPolicySnapshot({ approach: "explore-first" })) },
      { recordId: "trial-one", experience: commandExperience("source one", derivationPolicy) },
    ],
    loadedRecords: 4,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const harness = createHarness([["/repo", activeState()]], {}, {
    experienceReader: reader,
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDerivationCandidateReader: {
      read: async (_root: string, id: string) => id === candidate.candidateId ? candidate : null,
      readAll: async () => [candidate],
    },
    strategyDecisionStore: testDecisionStore(),
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("trial-review");
  assert.ok(command);
  const options = await command.getArgumentCompletions("");
  assert.ok(options);
  assert.match(options!.find((option: any) => option.value === candidate.candidateId)?.label ?? "", /boundary-first.*derivation.*1 eligible trial/);
  await command.handler(candidate.candidateId, {
    ...context("/wrong-cwd"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(notices.at(-1)?.message ?? "", /Strategy Derivation Trial Review/);
  assert.match(notices.at(-1)?.message ?? "", /Derivation Source Evidence/);
  assert.match(notices.at(-1)?.message ?? "", /Candidate Trial Evidence/);
  assert.doesNotMatch(notices.at(-1)?.message ?? "", /Seed Baseline Evidence/);
  assert.match(notices.at(-1)?.message ?? "", /Eligible Trial Runs: 1 \/ 2 required/);
  assert.equal(harness.store.saves.length, 0);
});

test("SI v0.7 unified /trial-review fails closed on a cross-store UUID collision", async () => {
  const candidate = derivationTrialCandidate("00000000-0000-4000-8000-000000000032");
  const revision = trialCandidate(candidate.candidateId);
  const harness = createHarness([["/repo", activeState()]], {}, {
    strategyCandidateReader: { read: async () => revision, readAll: async () => [revision] },
    strategyDerivationCandidateReader: { read: async () => candidate, readAll: async () => [candidate] },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("trial-review").handler(candidate.candidateId, {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.match(notices.at(-1)?.message ?? "", /ambiguous|both Revision and Derivation/i);
  assert.equal(harness.store.saves.length, 0);
});

test("Host lifecycle wiring receives the native Session shutdown boundary", async () => {
  const boundaries: Array<{ sessionId: string; reason: string }> = [];
  const release = installCommittedRolloverReceiver(
    () => undefined,
    (boundary) => boundaries.push(boundary),
  );
  try {
    const harness = createHarness([ ["/repo", activeState("Lifecycle boundary")] ]);
    await harness.api.handler("session_shutdown")(
      { type: "session_shutdown", reason: "reload" },
      context("/repo", [], false, "reload-session"),
    );
    assert.deepEqual(boundaries, [{ sessionId: "reload-session", reason: "reload" }]);
  } finally {
    release();
  }
});

test("ordinary completion is learning-free and does not launch autonomous work after settlement", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  const prompt = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(prompt.systemPrompt, /Learning opportunities are optional/);
  assert.equal(harness.api.tools.has("pindie_learning_signal"), false);
  const completion = await harness.api.tool("pindie_task_complete").execute("complete", { summary: "Finished work" });
  assert.equal(completion.terminate, true);
  assert.equal(harness.integration.runtime.state.task?.completed, true);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.api.sentUserMessages.length, 0);
  assert.equal(harness.api.sentMessages.length, 0);
});

test("adaptation, derivation, global derivation and Trial completions stay terminal without disposition", async () => {
  const reader = new ExtensionTestExperienceReader();
  reader.result = { records: [
    { recordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json", experience: commandExperience("goal one", createPolicySnapshot({ approach: "direct-action" })) },
    { recordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json", experience: commandExperience("goal two", createPolicySnapshot({ approach: "explore-first" })) },
    { recordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json", experience: commandExperience("goal three", createPolicySnapshot({ approach: "direct-action" })) },
  ], loadedRecords: 3, unsupportedSchema: 0, invalid: 0 };
  const projectA = getProjectId("/global-source-a");
  const projectB = getProjectId("/global-source-b");
  for (const kind of ["adapt", "derive", "derive-global", "trial"] as const) {
    const candidate = trialCandidate();
    const harness = createHarness([["/repo", verifiedState()]], {}, {
      experienceReader: reader,
      strategyCandidateReader: { read: async () => candidate },
      crossProjectExperienceReader: {
        listProjectIds: async () => [projectA, projectB],
        readProjectId: async (id) => ({ records: id === projectA ? reader.result.records.slice(0, 2) : reader.result.records.slice(2), loadedRecords: id === projectA ? 2 : 1, unsupportedSchema: 0, invalid: 0 }),
      },
      crossProjectTrustReader: { readProjectId: async (id) => createTrustedStrategyPortfolioForProjectId(id, createPromotedStrategyRevisionCatalog([])) },
    });
    await startSession(harness, "/repo");
    await harness.api.commands.get(kind).handler(kind === "adapt" ? "direct-action" : kind === "trial" ? candidate.candidateId : "", {
      ...context("/repo"), isIdle: () => true, ui: { notify: () => undefined },
    });
    assert.equal(harness.api.sentUserMessages.length, kind === "trial" ? 0 : 1, `${kind} armed`);
    const prompt = await harnessBeforeAgentStart(harness);
    assert.doesNotMatch(prompt.systemPrompt, /Learning opportunities are optional/);
    assert.doesNotMatch(prompt.message.content, /Primary work is complete/);
    const completion = await harness.api.tool("pindie_task_complete").execute(`complete-${kind}`, { summary: "Finished work" });
    assert.doesNotMatch(completion.content[0]?.text ?? "", /Primary work is complete/, kind);
    assert.equal(completion.terminate, true, `${kind} completion remains terminal`);
  }
});

test("Remote-disabled baseline registers only core and quota lifecycle hooks", () => {
  const { api } = createHarness();

  assert.equal(api.entryRenderers.has(PINDIE_REMOTE_NOTICE_TYPE), true);
  assert.deepEqual([...api.tools.keys()].sort(), [
    "pindie_gate_open",
    "pindie_gate_resolve",
    "pindie_git_observe",
    "pindie_policy_set",
    "pindie_strategy_candidate_create",
    "pindie_strategy_derivation_candidate_create",
    "pindie_strategy_synthesis_candidate_create",
    "pindie_task_complete",
    "pindie_task_progress",
    "pindie_task_refine",
    "pindie_task_replace",
    "pindie_task_start",
    "pindie_verification_record",
  ]);
  assert.equal(api.tools.has("pindie_state"), false);
  assert.equal(api.tools.has("pindie_gate"), false);
  assert.deepEqual([...api.handlers.keys()].sort(), [
    "agent_before_settle",
    "agent_settled",
    "before_agent_start",
    "context",
    "input",
    "model_select",
    "session_compact",
    "session_compact_failed",
    "session_shutdown",
    "session_start",
    "session_tree",
    "thinking_level_select",
    "tool_call",
    "tool_execution_end",
    "tool_execution_start",
    "tool_result",
    "turn_end",
  ]);
  assert.equal(api.handlers.has("input"), true);
});

test("production Discord Remote warnings append one TUI-only transcript notice per outage", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const client = {
    rest: { get: async () => ({}), post: async () => ({}), patch: async () => ({}) },
    login: async () => undefined,
    destroy: () => undefined,
    on: (event: string, listener: (...args: any[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), listener]);
    },
    emit: (event: string, ...args: any[]) => {
      for (const listener of handlers.get(event) ?? []) listener(...args);
    },
  } as unknown as DiscordClientSeam;
  const discord = new DiscordRemote(
    { token: "token", userId: "user", guildId: "guild" },
    { createClient: () => client },
  );
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const harness = createHarness([], {}, {
    remoteCompanion: {
      companion: new RemoteCompanion(surface),
      guildId: "guild",
      discord,
    },
  });

  await discord.start(async () => "sent");
  for (let index = 0; index < 10; index += 1) client.emit("error");

  assert.equal(harness.api.appendedEntries.length, 1);
  assert.deepEqual(harness.api.appendedEntries[0], {
    customType: PINDIE_REMOTE_NOTICE_TYPE,
    data: { message: "Pindie Discord Remote disconnected. Retrying…" },
  });
  assert.ok(harness.api.entryRenderers.has(PINDIE_REMOTE_NOTICE_TYPE));
  assert.deepEqual(harness.api.sentMessages, []);
  assert.deepEqual(harness.api.sentUserMessages, []);

  client.emit("ready");
  client.emit("error");
  assert.equal(harness.api.appendedEntries.length, 2);
  discord.stop();
});

test("Remote-enabled wiring observes public input without altering Pindie tools", async () => {
  const sent: string[] = [];
  const surface: RemoteSurface = { ensureProject: async () => ({ channelId: "channel" }), ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }), send: async (_thread, event) => { sent.push(event.text); }, updateSessionPresentation: async () => undefined };
  const { api } = createHarness([], {}, { remoteCompanion: { companion: new RemoteCompanion(surface), guildId: "guild" } });
  assert.ok(api.handlers.has("input")); assert.ok(api.handlers.has("message_end")); assert.equal(api.tools.size, 13);
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, context("/repo", [{ id: "u", message: { role: "user", content: "hello" } }]));
  assert.ok(Array.isArray(sent));
});

test("running blocked stays quiet while Human Gate signals immediately without duplication", async () => {
  const events: Array<{ text: string; attention?: true }> = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push({ text: event.text, attention: event.attention }); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([["/repo", activeState("Semantic attention")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries = [{ id: "prompt", message: { role: "user", content: "Work on the Task" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.some((event) => event.text === "YOU\nWork on the Task"));
  await beginAgentRun(harness, "/repo", entries);
  assert.equal(events.some((event) => event.attention === true), false);

  await harness.api.tool("pindie_task_progress").execute("block", {
    blockers: ["External dependency unavailable"],
    questions: [],
    nextIntent: "Wait for the dependency",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.text.startsWith("TASK BLOCKED")).length, 0);
  assert.equal(events.some((event) => event.attention === true), false);

  await harness.api.tool("pindie_task_progress").execute("repeat-block", {
    blockers: ["External dependency unavailable"],
    questions: [],
    nextIntent: "Wait for the dependency",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.text.startsWith("TASK BLOCKED")).length, 0);

  await harness.api.tool("pindie_gate_open").execute("gate", {
    kind: "decision",
    question: "Which dependency fallback should we use?",
    options: ["Wait", "Fallback"],
  });
  await waitFor(() => events.some((event) => event.text.startsWith("HUMAN GATE")));
  assert.equal(events.filter((event) => event.text.startsWith("TASK BLOCKED")).length, 0);
  const gate = events.find((event) => event.text.startsWith("HUMAN GATE"));
  assert.equal(gate?.attention, true);
  assert.equal(events.filter((event) => event.attention === true).length, 1);
  assert.equal(events.find((event) => event.text.startsWith("VERIFICATION"))?.attention, undefined);
});

test("one authority incident is delivered once across immediate and settlement projection", async () => {
  const events: Array<{ text: string; attention?: true }> = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push({ text: event.text, attention: event.attention }); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const classifiedKeys: string[] = [];
  const deliverHumanSignal = companion.humanSignal.bind(companion);
  companion.humanSignal = async (signal, options = {}) => {
    classifiedKeys.push(signal.key);
    await deliverHumanSignal(signal, options);
  };
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries = [{ id: "prompt", message: { role: "user", content: "Mutate the project" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.some((event) => event.text === "YOU\nMutate the project"));
  await beginAgentRun(harness, "/repo", entries);
  assert.equal(await callGuard(harness, toolCall("edit", {}, "authority-incident")), undefined);

  const reason = "State mutation freshness unavailable";
  harness.store.saveError = new Error(reason);
  await assert.rejects(
    harness.api.handler("tool_result")(
      toolResult("edit", false, "authority-incident"),
      context("/repo", entries),
    ),
    new RegExp(reason, "i"),
  );
  const authorityEvents = () => events.filter((event) => event.text.startsWith("PINDIE AUTHORITY UNAVAILABLE"));
  await waitFor(() => authorityEvents().length === 1);
  assert.equal(classifiedKeys.length, 1);
  assert.equal(authorityEvents().length, 1);
  assert.equal(authorityEvents()[0]?.attention, true);
  assert.match(authorityEvents()[0]?.text ?? "", new RegExp(reason, "i"));

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => classifiedKeys.length === 2);
  assert.equal(classifiedKeys[1], classifiedKeys[0]);
  assert.equal(authorityEvents().length, 1);
});

test("Remote completion attention waits for settled catch-up and execution summary", async () => {
  const events: Array<{ text: string; attention?: true }> = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push({ text: event.text, attention: event.attention }); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Finish the Task" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.some((event) => event.text === "YOU\nFinish the Task"));
  await beginAgentRun(harness, "/repo", entries);

  const completion = await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "The finished result is ready.",
  });
  assert.equal(completion.terminate, true);
  await waitFor(() => events.some((event) => event.text.startsWith("VERIFICATION")));
  assert.equal(events.some((event) => event.text === "TASK COMPLETED"), false);

  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo", entries)), undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((event) => event.text === "TASK COMPLETED"), false);

  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "final-check", "bash"), context("/repo", entries));
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "final-check", "bash"), context("/repo", entries));
  entries.push({ id: "answer", message: { role: "assistant", content: "The finished result is ready." } });
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.some((event) => event.text.startsWith("TASK COMPLETED")));

  const answerIndex = events.findIndex((event) => event.text === "The finished result is ready.");
  const summaryIndex = events.findIndex((event) => event.text.startsWith("EXECUTION\n"));
  const completionIndex = events.findIndex((event) => event.text.startsWith("TASK COMPLETED"));
  assert.ok(answerIndex >= 0);
  assert.ok(summaryIndex > answerIndex);
  assert.ok(completionIndex > summaryIndex);
  assert.equal(events[completionIndex]?.attention, true);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.text.startsWith("TASK COMPLETED")).length, 1);
});

test("terminal completion reports the verified outcome without a later assistant message", async () => {
  const events: Array<{ text: string; attention?: true }> = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push({ text: event.text, attention: event.attention }); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Finish the Task" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.some((event) => event.text === "YOU\nFinish the Task"));
  await beginAgentRun(harness, "/repo", entries);
  const completion = await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "The finished result is ready.",
  });
  assert.equal(completion.terminate, true);
  // The terminal tool result is not a visible assistant message in Pi's Session.
  assert.equal(entries.length, 1);
  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "final-check", "bash"), context("/repo", entries));
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "final-check", "bash"), context("/repo", entries));
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.some((event) => event.text.startsWith("TASK COMPLETED")));
  const reports = events.filter((event) => event.text.startsWith("TASK COMPLETED"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.attention, true);
  assert.match(reports[0]?.text ?? "", /Summary:\nThe finished result is ready\./);
  assert.match(reports[0]?.text ?? "", /Verification:\n- tests: Extension tests passed\./);
  const executionIndex = events.findIndex((event) => event.text.startsWith("EXECUTION\n"));
  assert.ok(executionIndex >= 0 && executionIndex < events.indexOf(reports[0]!));
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  assert.equal(events.filter((event) => event.text.startsWith("TASK COMPLETED")).length, 1);
});

test("final active settlement emits one ordered STOPPED attention after catch-up and execution summary", async () => {
  const events: Array<{ text: string; attention?: true }> = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push({ text: event.text, attention: event.attention }); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([['/repo', activeState("Stop me")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Stop me" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.some((event) => event.text === "YOU\nStop me"));
  await beginAgentRun(harness, "/repo", entries);
  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "stop-check", "bash"), context("/repo", entries));
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "stop-check", "bash"), context("/repo", entries));
  entries.push({ id: "answer", message: { role: "assistant", content: "The work is still unfinished." } });
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle("aborted"), context("/repo", entries)), undefined);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.some((event) => event.text.startsWith("PINDIE STOPPED")));

  const answerIndex = events.findIndex((event) => event.text === "The work is still unfinished.");
  const summaryIndex = events.findIndex((event) => event.text.startsWith("EXECUTION\n"));
  const stoppedIndex = events.findIndex((event) => event.text.startsWith("PINDIE STOPPED"));
  assert.ok(answerIndex >= 0);
  assert.ok(summaryIndex > answerIndex);
  assert.ok(stoppedIndex > summaryIndex);
  assert.equal(events[stoppedIndex]?.attention, true);
  assert.match(events[stoppedIndex]?.text ?? "", /Task remains active/);
  assert.doesNotMatch(events[stoppedIndex]?.text ?? "", /completed|failed|blocked/i);
});

test("boundary continuation delays final settlement until its last pass", async () => {
  const events: string[] = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push(event.text); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([['/repo', activeState("Continue")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Continue" } }];
  await startSession(harness, "/repo", "startup", entries);
  await waitFor(() => events.includes("YOU\nContinue"));
  await beginAgentRun(harness, "/repo", entries);

  const first = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo", entries));
  assert.equal(first.continue, true);
  assert.equal(first.entries[0].customType, PINDIE_CONTINUATION_PROBE_TYPE);
  assert.deepEqual(harness.api.sentMessages, []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false);

  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo", entries)), undefined);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.some((text) => text.startsWith("PINDIE STOPPED")));
  assert.deepEqual(harness.api.sentMessages, []);
});

test("blocked, Human Gate, idle, and completed settlement states do not emit STOPPED", async () => {
  for (const [label, state] of [
    ["blocked", blockedState()],
    ["gate", gatedState()],
    ["idle", EMPTY_STATE],
    ["done", completedState()],
  ] as const) {
    const events: string[] = [];
    const surface: RemoteSurface = {
      ensureProject: async () => ({ channelId: "channel" }),
      ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
      send: async (_thread, event) => { events.push(event.text); },
      updateSessionPresentation: async () => undefined,
    };
    const routing = {
      load: async () => null,
      save: async () => undefined,
      projectName: () => "repo",
    } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
    const companion = new RemoteCompanion(surface, { routing });
    const harness = createHarness([['/repo', state]], {}, {
      remoteCompanion: { companion, guildId: "guild" },
    });
    const entries: unknown[] = [{ id: `prompt-${label}`, message: { role: "user", content: label } }];
    await startSession(harness, "/repo", "startup", entries);
    await beginAgentRun(harness, "/repo", entries);
    assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle("aborted"), context("/repo", entries)), undefined);
    await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false, label);
    if (label === "blocked") {
      assert.equal(events.filter((text) => text.startsWith("TASK BLOCKED")).length, 1);
      assert.match(events.find((text) => text.startsWith("TASK BLOCKED")) ?? "", /External dependency unavailable/);
    }
  }
});

test("repeated settlement is deduplicated while a distinct Agent Run can stop again", async () => {
  const events: string[] = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => { events.push(event.text); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([['/repo', activeState("Repeat stop")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Repeat stop" } }];
  await startSession(harness, "/repo", "startup", entries);
  await beginAgentRun(harness, "/repo", entries);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle("aborted"), context("/repo", entries)), undefined);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.filter((text) => text.startsWith("PINDIE STOPPED")).length === 1);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((text) => text.startsWith("PINDIE STOPPED")).length, 1);

  await beginAgentRun(harness, "/repo", entries);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle("aborted"), context("/repo", entries)), undefined);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await waitFor(() => events.filter((text) => text.startsWith("PINDIE STOPPED")).length === 2);
});

test("pending work and a newer Agent Run suppress an obsolete STOPPED settlement", async () => {
  const events: string[] = [];
  let pauseFinalOutput = false;
  let finalOutputEntered!: () => void;
  let releaseFinalOutput!: () => void;
  const finalOutputReady = new Promise<void>((resolve) => { finalOutputEntered = resolve; });
  const finalOutputRelease = new Promise<void>((resolve) => { releaseFinalOutput = resolve; });
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => {
      events.push(event.text);
      if (pauseFinalOutput && event.text === "final output") {
        finalOutputEntered();
        await finalOutputRelease;
      }
    },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([['/repo', activeState("Race")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Race" } }];
  await startSession(harness, "/repo", "startup", entries);
  await beginAgentRun(harness, "/repo", entries);
  entries.push({ id: "answer", message: { role: "assistant", content: "final output" } });
  pauseFinalOutput = true;
  const settlement = harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
  await finalOutputReady;
  await beginAgentRun(harness, "/repo", entries);
  releaseFinalOutput();
  await settlement;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false);

  const pendingContext = context("/repo", entries, true);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, pendingContext);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false);
});

test("a replaced Session cannot receive an obsolete STOPPED milestone", async () => {
  const events: string[] = [];
  let finalOutputEntered!: () => void;
  let releaseFinalOutput!: () => void;
  const finalOutputReady = new Promise<void>((resolve) => { finalOutputEntered = resolve; });
  const finalOutputRelease = new Promise<void>((resolve) => { releaseFinalOutput = resolve; });
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async (_channel, sessionId) => ({ threadId: `thread-${sessionId}`, anchorMessageId: "anchor", headerMessageId: null }),
    send: async (_thread, event) => {
      events.push(event.text);
      if (event.text === "old final output") {
        finalOutputEntered();
        await finalOutputRelease;
      }
    },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => null,
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([["/repo", activeState("Replacement")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const oldEntries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Replacement" } }];
  await startSession(harness, "/repo", "startup", oldEntries);
  await beginAgentRun(harness, "/repo", oldEntries);
  oldEntries.push({ id: "answer", message: { role: "assistant", content: "old final output" } });
  const settlement = harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", oldEntries));
  await finalOutputReady;

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo", oldEntries, false, "remote-session"),
  );
  await harness.api.handler("session_start")(
    { type: "session_start", reason: "new" },
    context("/repo", [], false, "new-session"),
  );
  releaseFinalOutput();
  await settlement;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false);
});

test("quota preference arbitration shares one forced refresh, orders fallback before Resume, and keeps default OFF", async () => {
  const now = 1_700_000_000_000;
  for (const [globalDefault, sessionOverride, resumeEnabled, accepted, expectedRequests, expectedSchedules] of [
    [false, null, true, true, 0, 1], [true, null, true, true, 1, 0],
    [true, null, true, false, 1, 1], [true, null, false, false, 1, 0],
    [false, null, false, false, 0, 0],
    [false, true, true, true, 1, 0], [true, false, true, true, 0, 1],
  ] as const) {
    const calls: string[] = [];
    let fetches = 0;
    const releaseFallback = installQuotaFallbackReceiver({
      request: async () => { calls.push("fallback"); return accepted; },
      canUseBackup: () => true,
      cancel: () => { calls.push("cancel-fallback"); },
      observeModelSelect: () => false,
      backupFailed: async () => null,
    });
    const releaseResume = installQuotaResumeReceiver((event) => {
      if (event.type === "schedule") { calls.push("resume"); return true; }
    });
    try {
      const branch = [
        ...(sessionOverride === null ? [] : [{ type: "custom", id: "preference", customType: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: sessionOverride } }]),
        { type: "message", id: "quota", message: {
          role: "assistant", content: [], provider: "openai-codex", model: "gpt-5-codex",
          stopReason: "error", errorMessage: "The usage limit has been reached", timestamp: now,
        } },
      ] as SessionEntry[];
      const ctx = withBranch(context("/repo", branch), branch);
      const harness = createHarness([["/repo", activeState()]], {}, {
        now: () => now, quotaFallbackPreferenceStore: { loadDefault: async () => globalDefault, saveDefault: async () => undefined },
        quotaResumePreferenceStore: { loadDefault: async () => resumeEnabled, saveDefault: async () => undefined },
        subscriptionUsageProvider: { fetchUsage: async () => {
          fetches++;
          return { fetchedAt: now, windows: [
            { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
            { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
          ] };
        } },
      });
      await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await waitFor(() => fetches > 0);
      const before = fetches;
      await harness.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
      await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
      if (expectedRequests || expectedSchedules) {
        await waitFor(() => calls.length === Number(expectedRequests) + Number(expectedSchedules));
      } else await nextTurn(); // Allow a forbidden asynchronous request to surface.
      assert.equal(fetches - before, expectedRequests || expectedSchedules ? 1 : 0);
      assert.deepEqual(calls.filter((call) => call === "fallback" || call === "resume"),
        [...(expectedRequests ? ["fallback"] : []), ...(expectedSchedules ? ["resume"] : [])]);
    } finally { releaseFallback(); releaseResume.release(); }
  }
});

test("Extension settlement drives installed real fallback supervisor: commit, unavailable, rollback, and backup failure", async () => {
  const now = 1_700_000_000_000;
  for (const mode of ["commit", "unavailable", "rollback", "backup-failure"] as const) {
    const branch = [{ type: "message", id: "quota", message: {
      role: "assistant", content: [], provider: "openai-codex", model: "gpt-5-codex",
      stopReason: "error", errorMessage: "The usage limit has been reached", timestamp: now,
    } }] as SessionEntry[];
    let model = { provider: "openai-codex", id: "gpt-5-codex" };
    let thinking: AgentSession["thinkingLevel"] = "medium";
    const switches: string[] = [], sends: unknown[] = [];
    const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
    const listeners = new Set<() => void>();
    const session = {
      sessionId: "remote-session",
      get model() { return model; },
      get thinkingLevel() { return thinking; },
      setThinkingLevel: (level: AgentSession["thinkingLevel"]) => { thinking = level; },
      isStreaming: false, isCompacting: false, pendingMessageCount: 0,
      sessionManager: { getBranch: () => branch },
      extensionRunner: { getModelRegistry: () => ({
        find: (provider: string, id: string) => ({ provider, id }),
        getAvailable: () => mode === "unavailable"
          ? [{ provider: "openai-codex", id: "gpt-5-codex" }]
          : [{ provider: "openai-codex", id: "gpt-5-codex" }, { provider: "deepseek", id: "deepseek-flash" }],
      }) },
      async setModel(target: { provider: string; id: string }) { switches.push(`${target.provider}/${target.id}`); model = target; },
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      sendCustomMessage(message: unknown, options: unknown) {
        sends.push({ message, options });
        if (mode === "rollback") throw new Error("Pi could not enqueue");
        return new Promise<void>(() => undefined); // Do not await the whole backup Run.
      },
    };
    const supervisor = new QuotaFallbackSupervisor(new PiRuntimeAdapter({ session } as unknown as AgentSessionRuntime), {
      now: () => now,
      schedule: (_delay, callback) => {
        const timer = { callback, cancelled: false }; timers.push(timer);
        return () => { timer.cancelled = true; };
      },
      logger: () => undefined,
    });
    const releaseFallback = installQuotaFallbackReceiver({
      request: (plan) => supervisor.request(plan),
      canUseBackup: (id) => supervisor.canUseBackup(id),
      cancel: (id) => supervisor.cancel(id),
      observeModelSelect: (event) => supervisor.observeModelSelection(event),
      backupFailed: (id) => supervisor.handleBackupFailure(id),
    });
    const resumePlans: unknown[] = [];
    const releaseResume = installQuotaResumeReceiver((event) => {
      if (event.type === "schedule") { resumePlans.push(event.plan); return true; }
    });
    try {
      const ctx = withBranch(context("/repo", branch), branch);
      const h = createHarness([["/repo", activeState()]], {}, {
        now: () => now,
        quotaFallbackPreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
        quotaResumePreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
        subscriptionUsageProvider: { fetchUsage: async () => ({ fetchedAt: now, windows: [
          { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
          { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
        ] }) },
      });
      await h.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await h.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
      await h.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
      await waitFor(() => sends.length > 0 || resumePlans.length > 0);
      if (mode === "commit" || mode === "backup-failure") {
        assert.deepEqual(switches, ["deepseek/deepseek-flash"], mode);
        assert.equal((sends[0] as { message: { customType: string } }).message.customType, PINDIE_QUOTA_FALLBACK_TYPE);
        assert.equal(resumePlans.length, 0, mode);
        assert.equal(listeners.size, 1, mode);
      } else {
        assert.equal(resumePlans.length, 1, mode);
        assert.deepEqual(switches, mode === "rollback" ? ["deepseek/deepseek-flash", "openai-codex/gpt-5-codex"] : [], mode);
        assert.equal(listeners.size, 0, mode);
        assert.equal(timers.every((timer) => timer.cancelled), true, mode);
      }
      if (mode === "backup-failure") {
        branch.push({ type: "message", id: "backup", message: {
          role: "assistant", content: [], provider: "deepseek", model: "deepseek-flash",
          stopReason: "error", errorMessage: "provider failed", timestamp: now,
        } } as SessionEntry);
        await h.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
        await h.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
        await waitFor(() => resumePlans.length === 1);
        assert.deepEqual(switches, ["deepseek/deepseek-flash", "openai-codex/gpt-5-codex"]);
        assert.equal((resumePlans[0] as { anchorEntryId: string }).anchorEntryId, "quota");
        assert.equal(listeners.size, 0);
      }
    } finally { supervisor.dispose(); releaseFallback(); releaseResume.release(); }
  }
});

test("Extension restores branch-local fallback opt-in and disabling future fallback does not cancel active lease", async () => {
  const calls: string[] = [];
  const release = installQuotaFallbackReceiver({
    request: () => false, canUseBackup: () => { calls.push("preflight"); return true; },
    cancel: () => { calls.push("cancel-lease"); }, observeModelSelect: () => false, backupFailed: async () => null,
  });
  try {
    let branch: SessionEntry[] = [{ type: "custom", id: "on", customType: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: true } } as SessionEntry];
    let selection = false;
    const ctx = { ...context("/repo", branch), mode: "tui", sessionManager: {
      getEntries: () => branch, getBranch: () => branch, getSessionId: () => "remote-session", getSessionName: () => undefined,
    }, ui: {
      notify: () => undefined,
      custom: async (_factory: unknown) => ({ kind: "session", enabled: selection }),
    } };
    const h = createHarness([["/repo", activeState()]], {}, {
      quotaFallbackPreferenceStore: { loadDefault: async () => false, saveDefault: async () => undefined },
    });
    await h.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
    assert.equal(h.integration.quotaFallbackEnabled, true);
    await h.api.commands.get("quota-fallback").handler("", ctx);
    assert.equal(h.integration.quotaFallbackEnabled, false);
    assert.deepEqual(calls, []); // OFF neither preflights nor cancels the committed lease.
    assert.deepEqual(h.api.appendedEntries.at(-1), { customType: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: false } });
    selection = true;
    await h.api.commands.get("quota-fallback").handler("", ctx);
    assert.deepEqual(calls, ["preflight"]);
    assert.equal(h.integration.quotaFallbackEnabled, true);
    branch = [];
    await h.api.handler("session_tree")({ type: "session_tree" }, ctx);
    assert.deepEqual(calls, ["preflight", "cancel-lease"]);
    assert.equal(h.integration.quotaFallbackEnabled, false);
  } finally { release(); }
});

test("fallback ownership distinguishes model_select; input preserves lease but tree cancels", async () => {
  const calls: string[] = [];
  let owned = true;
  const releaseFallback = installQuotaFallbackReceiver({
    request: () => false, canUseBackup: () => true, cancel: () => { calls.push("fallback-cancel"); },
    observeModelSelect: () => { calls.push("model-select"); return owned; }, backupFailed: async () => null,
  });
  const releaseResume = installQuotaResumeReceiver((event) => { if (event.type === "cancel") calls.push("resume-cancel"); });
  try {
    const branch: SessionEntry[] = [];
    const ctx = withBranch(context("/repo", branch), branch);
    const h = createHarness([["/repo", activeState()]]);
    await h.api.handler("model_select")({ type: "model_select", model: { provider: "deepseek", id: "deepseek-flash" }, source: "set" }, ctx);
    assert.deepEqual(calls, ["model-select"]);
    owned = false;
    await h.api.handler("model_select")({ type: "model_select", model: { provider: "openai-codex", id: "gpt-5-codex" }, source: "set" }, ctx);
    assert.deepEqual(calls, ["model-select", "model-select", "resume-cancel"]);
    await h.api.handler("input")({ type: "input", source: "interactive", streamingBehavior: "steer" }, ctx);
    assert.equal(calls.filter((call) => call === "fallback-cancel").length, 0);
    await h.api.handler("session_tree")({ type: "session_tree" }, ctx);
    assert.equal(calls.filter((call) => call === "fallback-cancel").length, 1);
  } finally { releaseFallback(); releaseResume.release(); }
});

test("model_select during fallback request preserves planning only for supervisor-owned mutations", async () => {
  const now = 1_700_000_000_000;
  for (const owned of [true, false]) {
    const calls: string[] = [];
    let onModelSelect!: (event: unknown, ctx: unknown) => unknown;
    const releaseFallback = installQuotaFallbackReceiver({
      canUseBackup: () => true,
      request: async () => {
        calls.push("fallback");
        await onModelSelect({ type: "model_select", model: { provider: "deepseek", id: "deepseek-flash" }, source: "set" }, ctx);
        return false;
      },
      cancel: () => undefined, observeModelSelect: () => owned, backupFailed: async () => null,
    });
    const releaseResume = installQuotaResumeReceiver((event) => { if (event.type === "schedule") { calls.push("resume"); return true; } });
    const branch = [{ type: "message", id: "quota", message: {
      role: "assistant", provider: "openai-codex", model: "gpt-5-codex", stopReason: "error", errorMessage: "The usage limit has been reached",
    } }] as SessionEntry[];
    const ctx = withBranch(context("/repo", branch), branch);
    try {
      const h = createHarness([["/repo", activeState()]], {}, {
        now: () => now, quotaFallbackPreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
        quotaResumePreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
        subscriptionUsageProvider: { fetchUsage: async () => ({ fetchedAt: now, windows: [
          { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
          { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
        ] }) },
      });
      onModelSelect = h.api.handler("model_select");
      await h.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await h.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
      await h.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
      await waitFor(() => calls.length === (owned ? 2 : 1));
      assert.deepEqual(calls, owned ? ["fallback", "resume"] : ["fallback"]);
    } finally { releaseFallback(); releaseResume.release(); }
  }
});

test("backup provider settlement restores source through Host and schedules anchored Resume only before recovery", async () => {
  const now = 1_700_000_000_000;
  for (const enabled of [true, false]) {
    const calls: string[] = [];
    const releaseFallback = installQuotaFallbackReceiver({
      request: () => false, canUseBackup: () => true, cancel: () => undefined, observeModelSelect: () => true,
      backupFailed: async () => { calls.push("restore"); return {
        sessionId: "remote-session", anchorEntryId: "quota", provider: "openai-codex",
        modelId: "gpt-5-codex", detectedAt: now, restoreAt: now + 60_000,
      }; },
    });
    const releaseResume = installQuotaResumeReceiver((event) => {
      if (event.type === "schedule") { calls.push(`resume:${event.plan.anchorEntryId}`); return true; }
    });
    try {
      const branch = [{ type: "message", id: "quota", message: {
        role: "assistant", provider: "openai-codex", model: "gpt-5-codex", stopReason: "error", errorMessage: "The usage limit has been reached",
      } }, { type: "message", id: "backup", message: {
        role: "assistant", provider: "deepseek", model: "deepseek-flash", stopReason: "error", errorMessage: "provider unavailable",
      } }] as SessionEntry[];
      const ctx = withBranch(context("/repo", branch), branch);
      const h = createHarness([["/repo", activeState()]], {}, {
        now: () => now, quotaResumePreferenceStore: { loadDefault: async () => enabled, saveDefault: async () => undefined },
      });
      await h.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await h.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
      await h.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
      await waitFor(() => calls.length === (enabled ? 2 : 1));
      assert.deepEqual(calls, enabled ? ["restore", "resume:quota"] : ["restore"]);
    } finally { releaseFallback(); releaseResume.release(); }
  }
});

test("Remote suppresses STOPPED when fallback commits without starting another Run", async () => {
  const now = 1_700_000_000_000;
  const messages: string[] = []; const calls: string[] = [];
  const releaseFallback = installQuotaFallbackReceiver({
    request: async () => { calls.push("fallback"); return true; }, canUseBackup: () => true, cancel: () => undefined,
    observeModelSelect: () => false, backupFailed: async () => null,
  });
  const releaseResume = installQuotaResumeReceiver((event) => { if (event.type === "schedule") calls.push("resume"); return true; });
  try {
    const surface: RemoteSurface = {
      ensureProject: async () => ({ channelId: "channel" }),
      ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
      send: async (_thread, event) => { messages.push(event.text); },
      updateSessionPresentation: async () => undefined,
    };
    const routing = { load: async () => null, save: async () => undefined, projectName: () => "repo" } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
    const companion = new RemoteCompanion(surface, { routing });
    const branch = [{ type: "message", id: "quota", message: {
      role: "assistant", content: [], provider: "openai-codex", model: "gpt-5-codex", stopReason: "error",
      errorMessage: "The usage limit has been reached", timestamp: now,
    } }] as SessionEntry[];
    const ctx = withBranch(context("/repo", branch), branch);
    const h = createHarness([["/repo", activeState()]], {}, {
      now: () => now, quotaFallbackPreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
      remoteCompanion: { companion, guildId: "guild" },
      quotaResumePreferenceStore: { loadDefault: async () => true, saveDefault: async () => undefined },
      subscriptionUsageProvider: { fetchUsage: async () => ({ fetchedAt: now, windows: [
        { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
        { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
      ] }) },
    });
    await h.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
    await h.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} }, ctx);
    await h.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
    await waitFor(() => calls.includes("fallback"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(calls, ["fallback"]);
    assert.equal(messages.some((text) => /PINDIE STOPPED|TASK BLOCKED|Could not continue autonomously/.test(text)), false);
  } finally { releaseFallback(); releaseResume.release(); }
});

test("accepted Quota Auto Resume suppresses STOPPED while failed scheduling does not", async () => {
  const now = 1_700_000_000_000;
  const quotaEntry = {
    type: "message",
    id: "quota",
    parentId: "prompt",
    timestamp: new Date(now).toISOString(),
    message: {
      role: "assistant",
      content: [],
      provider: "openai-codex",
      model: "gpt-5-codex",
      usage: {},
      stopReason: "error",
      errorMessage: "The usage limit has been reached",
      timestamp: now,
    },
  } as SessionEntry;
  const branch = [
    { type: "message", id: "prompt", parentId: null, timestamp: new Date(now - 1).toISOString(), message: { role: "user", content: "Continue after quota" } },
    quotaEntry,
  ] as SessionEntry[];

  for (const accepted of [true, false]) {
    const events: string[] = [];
    const schedules: QuotaResumeControlEvent[] = [];
    const release = installQuotaResumeReceiver((event) => {
      schedules.push(event);
      return event.type === "schedule" ? accepted : undefined;
    });
    try {
      const surface: RemoteSurface = {
        ensureProject: async () => ({ channelId: "channel" }),
        ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
        send: async (_thread, event) => { events.push(event.text); },
        updateSessionPresentation: async () => undefined,
      };
      const routing = {
        load: async () => null,
        save: async () => undefined,
        projectName: () => "repo",
      } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
      const companion = new RemoteCompanion(surface, { routing });
      const harness = createHarness([["/repo", activeState("Quota stop")]], {}, {
        now: () => now,
        quotaResumePreferenceStore: {
          loadDefault: async () => true,
          saveDefault: async () => undefined,
        },
        subscriptionUsageProvider: {
          fetchUsage: async () => ({
            fetchedAt: now,
            windows: [
              { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
              { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
            ],
          }),
        },
        remoteCompanion: { companion, guildId: "guild" },
      });
      const ctx = {
        ...context("/repo", branch),
        sessionManager: {
          getEntries: () => branch,
          getBranch: () => branch,
          getSessionId: () => "remote-session",
          getSessionName: () => undefined,
        },
      };
      await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
      await waitFor(() => events.includes("YOU\nContinue after quota"));
      await harness.api.handler("before_agent_start")(
        { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
        ctx,
      );
      await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
      await waitFor(() => schedules.some((event) => event.type === "schedule"));
      if (accepted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false, JSON.stringify({ accepted, events, schedules }));
      } else {
        await waitFor(() => events.some((text) => text.startsWith("PINDIE STOPPED")));
      }
    } finally {
      release.release();
    }
  }
});

test("committed Long Task rollover suppresses STOPPED, while a rejected handoff leaves it eligible", async () => {
  for (const accepted of [true, false]) {
    const events: string[] = [];
    let published = 0;
    const release = installCommittedRolloverReceiver(() => {
      published += 1;
      return accepted;
    });
    try {
      const surface: RemoteSurface = {
        ensureProject: async () => ({ channelId: "channel" }),
        ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
        send: async (_thread, event) => { events.push(event.text); },
        updateSessionPresentation: async () => undefined,
      };
      const routing = {
        load: async () => null,
        save: async () => undefined,
        projectName: () => "repo",
      } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
      const companion = new RemoteCompanion(surface, { routing });
      const harness = createHarness([["/repo", activeState("Rollover")]], {}, {
        remoteCompanion: { companion, guildId: "guild" },
        enableTaskHandoff: true,
      });
      const entries: unknown[] = [{ id: "prompt", message: { role: "user", content: "Rollover" } }];
      await startSession(harness, "/repo", "startup", entries);
      await waitFor(() => events.includes("YOU\nRollover"));
      await beginAgentRun(harness, "/repo", entries);
      const input = handoffInput("Continue after rollover");
      assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, `rollover-${accepted}`)), undefined);
      await harness.api.tool("pindie_task_handoff").execute(`rollover-${accepted}`, input);
      await harness.api.handler("tool_result")(
        toolResult("pindie_task_handoff", false, `rollover-${accepted}`),
        context("/repo", entries),
      );
      const boundary = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo", entries));
      assert.equal(boundary, undefined);
      await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries));
      assert.equal(published, 1);
      if (accepted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(events.some((text) => text.startsWith("PINDIE STOPPED")), false, JSON.stringify({ accepted, events, published }));
      } else {
        await waitFor(() => events.some((text) => text.startsWith("PINDIE STOPPED")));
      }
    } finally {
      release();
    }
  }
});

test("Pi session_info_changed projects presentation rename for the mapped active Session", async () => {
  const titles: string[] = [];
  let markPresentationReady!: () => void;
  const presentationReady = new Promise<void>((resolve) => { markPresentationReady = resolve; });
  let markRenameReady!: () => void;
  const renameReady = new Promise<void>((resolve) => { markRenameReady = resolve; });
  let presentationUpdates = 0;
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async () => undefined,
    updateSessionPresentation: async (_session, presentation) => {
      titles.push(presentation.title);
      presentationUpdates += 1;
      if (presentationUpdates === 1) markPresentationReady();
      if (presentationUpdates === 2) markRenameReady();
    },
  };
  const companion = new RemoteCompanion(surface);
  const { api } = createHarness([], {}, { remoteCompanion: { companion, guildId: "guild" } });
  const ui = context("/repo", [{ id: "u", message: { role: "user", content: "Original prompt" } }]);
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, ui);
  await presentationReady;
  const before = titles.length;
  const handlerResult = api.handler("session_info_changed")({ type: "session_info_changed", name: "Discord Remote Test 2" }, ui);
  assert.equal(handlerResult, undefined);
  await renameReady;
  assert.equal(companion.activeSessionId, "remote-session");
  assert.equal(titles.length, before + 1);
  assert.equal(titles.at(-1), "Discord Remote Test 2");
});

test("detached Remote session rename cannot hold the Pi lifecycle handler open", async () => {
  let markPresentationReady!: () => void;
  const presentationReady = new Promise<void>((resolve) => { markPresentationReady = resolve; });
  let markRenameEntered!: () => void;
  const renameEntered = new Promise<void>((resolve) => { markRenameEntered = resolve; });
  const neverSettles = new Promise<void>(() => undefined);
  let presentationUpdates = 0;
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async () => undefined,
    updateSessionPresentation: async () => {
      presentationUpdates += 1;
      if (presentationUpdates === 1) {
        markPresentationReady();
        return;
      }
      markRenameEntered();
      await neverSettles;
    },
  };
  const companion = new RemoteCompanion(surface);
  const { api } = createHarness([], {}, { remoteCompanion: { companion, guildId: "guild" } });
  const ui = context("/repo", [{ id: "u", message: { role: "user", content: "Original prompt" } }]);
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, ui);
  await presentationReady;
  assert.equal(companion.activeSessionId, "remote-session");
  const handlerResult = api.handler("session_info_changed")({ type: "session_info_changed", name: "Never Settles" }, ui);
  assert.equal(handlerResult, undefined);
  await renameEntered;
});

test("detached Remote session rename contains a rejection", async () => {
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const companion = new RemoteCompanion(surface);
  const { api } = createHarness([], {}, { remoteCompanion: { companion, guildId: "guild" } });
  const ui = context("/repo", []);
  companion.rename = async () => { throw new Error("Remote unavailable"); };
  assert.equal(api.handler("session_info_changed")({ type: "session_info_changed", name: "Rejected" }, ui), undefined);
});

test("Discord startup is deferred from session_start and current-session shutdown cleans it up", async () => {
  const surface: RemoteSurface = { ensureProject: async () => ({ channelId: "channel" }), ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }), send: async () => undefined, updateSessionPresentation: async () => undefined };
  let started = 0; let stopped = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const startReady = new Promise<void>((resolve) => { markStarted = resolve; });
  const discord = {
    start: () => { started++; markStarted(); return pending; },
    stop: () => { stopped++; },
  } as unknown as import("../src/discord-remote.ts").DiscordRemote;
  const harness = createHarness([], {}, { remoteCompanion: { companion: new RemoteCompanion(surface), guildId: "guild", discord } });
  const ui = context("/repo", []);
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ui);
  await startReady;
  assert.equal(started, 1);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "done" }, ui);
  assert.equal(stopped, 1);
  release();
});

test("detached Remote bootstrap cannot hold startup and stale binds cannot claim a newer Session", async () => {
  let markLoadEntered!: () => void;
  let releaseLoad!: () => void;
  const loadEntered = new Promise<void>((resolve) => { markLoadEntered = resolve; });
  const loadPending = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const routing = {
    load: async () => {
      markLoadEntered();
      await loadPending;
      return null;
    },
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([["/repo", activeState("detached Remote")]], {}, {
    remoteCompanion: { companion, guildId: "guild" },
  });
  const oldContext = context("/repo", [], false, "old-session");
  const newContext = context("/repo", [], false, "new-session");

  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, oldContext);
  await loadEntered;
  assert.equal(harness.integration.runtime.projectRoot, "/repo");
  assert.equal(companion.activeSessionId, null);

  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "new" }, oldContext);
  await harness.api.handler("session_start")({ type: "session_start", reason: "new" }, newContext);
  assert.equal(companion.activeSessionId, null);

  releaseLoad();
  await waitFor(() => companion.activeSessionId === "new-session");
});

test("stale Discord READY after same-session reload never reads the old ExtensionContext", async () => {
  const mirrored: string[] = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async (_channel, sessionId) => ({ threadId: `thread-${sessionId}`, anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async (_thread, event) => { mirrored.push(event.text); },
    updateSessionPresentation: async () => undefined,
  };
  const routing = {
    load: async () => ({ version: 1 as const, guildId: "guild", channelId: "channel", sessions: {} }),
    save: async () => undefined,
    projectName: () => "repo",
  } as unknown as import("../src/remote-routing.ts").RemoteRoutingStore;
  const starts: Array<{ ready: () => void; input: (threadId: string, text: string) => Promise<unknown> }> = [];
  let stopped = 0;
  const discord = {
    start: (input: (threadId: string, text: string) => Promise<unknown>, ready: () => void) => {
      starts.push({ input, ready });
      return Promise.resolve();
    },
    stop: () => { stopped++; },
  } as unknown as import("../src/discord-remote.ts").DiscordRemote;
  const companion = new RemoteCompanion(surface, { routing });
  const harness = createHarness([[
    "/repo",
    activeState("Remote reload"),
  ]], {}, { remoteCompanion: { companion, guildId: "guild", discord } });
  let staleReads = 0;
  const staleContext = context(
    "/repo",
    [],
    false,
    "same-session",
    () => {
      staleReads++;
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  );
  const currentEntries = [{ id: "current", message: { role: "user", content: "current prompt" } }];
  const currentContext = context("/repo", currentEntries, false, "same-session");
  const shutdownContext = context("/repo", [], false, "same-session");

  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, staleContext);
  await waitFor(() => starts.length === 1);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "reload" }, shutdownContext);
  await harness.api.handler("session_start")({ type: "session_start", reason: "reload" }, currentContext);
  await waitFor(() => starts.length === 2);

  assert.doesNotThrow(() => starts[0]!.ready());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleReads, 0);
  assert.deepEqual(mirrored, []);
  assert.equal(companion.activeSessionId, "same-session");
  assert.equal(stopped, 1);

  starts[1]!.ready();
  await waitFor(() => mirrored.length === 1);
  assert.deepEqual(mirrored, ["YOU\ncurrent prompt"]);
});

test("late Discord input after session shutdown is inert and never touches the old context", async () => {
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const starts: Array<{ input: (threadId: string, text: string) => Promise<unknown> }> = [];
  let markStarted!: () => void;
  const startReady = new Promise<void>((resolve) => { markStarted = resolve; });
  const discord = {
    start: (input: (threadId: string, text: string) => Promise<unknown>) => {
      starts.push({ input });
      markStarted();
      return Promise.resolve();
    },
    stop: () => undefined,
  } as unknown as import("../src/discord-remote.ts").DiscordRemote;
  const companion = new RemoteCompanion(surface);
  const harness = createHarness([["/repo", activeState()]], {}, { remoteCompanion: { companion, guildId: "guild", discord } });
  let staleReads = 0;
  const oldContext = context("/repo", [], false, "old-session", () => {
    staleReads++;
    throw new Error("This extension ctx is stale after session replacement or reload.");
  });
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, oldContext);
  await startReady;
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "new" }, oldContext);

  assert.equal(await starts[0]!.input("thread", "!stop"), "failed");
  assert.equal(staleReads, 0);
});

test("Remote transport failure cannot disrupt startup, semantic milestones, verification, or Agent settlement", async () => {
  const surface: RemoteSurface = {
    ensureProject: async () => { throw new Error("offline"); },
    ensureSession: async () => { throw new Error("offline"); },
    send: async () => { throw new Error("offline"); },
    updateSessionPresentation: async () => { throw new Error("offline"); },
  };
  const companion = new RemoteCompanion(surface);
  const harness = createHarness([["/repo", activeState()]], {}, { remoteCompanion: { companion, guildId: "guild" } });
  const entries = [{ id: "u", message: { role: "user", content: "hello" } }];
  await assert.doesNotReject(startSession(harness, "/repo", "startup", entries));
  await assert.doesNotReject(beginAgentRun(harness, "/repo", entries));
  const { ref } = await captureObservationEvidence(harness, "remote-failure-evidence");
  await assert.doesNotReject(harness.api.tool("pindie_verification_record").execute("verify", { check: { name: "tests", status: "passed", covers: ["c1"], evidenceRefs: [ref] } }));
  assert.equal(harness.integration.runtime.state.task?.verification.checks[0]?.status, "passed");
  await assert.doesNotReject(harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries)));
  assert.equal(harness.integration.stateUnavailableReason, null);
});

test("E01-E02/E08-E10 active Tasks append one hidden boundary probe per Run", async () => {
  const state = activeState();
  state.task!.openLoops.questions = ["Should the release note mention this?"];
  const harness = createHarness([["/repo", state]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const { ref: evidenceRef } = await captureObservationEvidence(
    harness,
    "continuation-evidence",
  );
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const reasoningBefore = harness.integration.reasoning.snapshot;
  const activeToolsBefore = harness.api.getActiveTools();

  assert.equal(harness.api.handlers.has("agent_end"), false);
  const firstBoundary = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"));

  assert.deepEqual(harness.api.sentMessages, []);
  assert.equal(firstBoundary.continue, true);
  const continuationMessage = firstBoundary.entries[0];
  assert.equal(continuationMessage.type, "custom_message");
  assert.equal(continuationMessage.customType, PINDIE_CONTINUATION_PROBE_TYPE);
  assert.equal(continuationMessage.display, false);
  assert.equal(continuationMessage.content, PINDIE_CONTINUATION_PROBE_MESSAGE);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.integration.reasoning.snapshot, reasoningBefore);
  assert.deepEqual(harness.api.getActiveTools(), activeToolsBefore);
  assert.deepEqual(harness.store.saves, []);
  assert.equal(harness.integration.runTimer.active, true);
  assert.equal(harness.integration.runCost.snapshot([] as any)?.active, true);

  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);

  await harness.api.tool("pindie_verification_record").execute("verify-after-probe", {
    check: {
      name: "continuation evidence remains live",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [evidenceRef],
    },
  });
  assert.match(
    harness.integration.runtime.state.task?.verification.checks[0]?.evidence ?? "",
    /Tool: read/,
  );

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  assert.equal(harness.integration.runTimer.active, false);
  assert.equal(harness.integration.runCost.snapshot([] as any)?.active, false);
  assert.equal(harness.integration.runActivity.activity, null);

  await beginAgentRun(harness);
  assert.equal((await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"))).continue, true);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("continuation boundary preserves prior drafts in order and appends the probe only once", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const priorDrafts = [
    { type: "custom", customType: "earlier-boundary-data", data: { id: 1 } },
    { type: "custom_message", customType: "earlier-boundary-message", content: "keep me", display: false },
  ];
  const event = { ...beforeSettle(), entries: priorDrafts };
  const first = await harness.api.handler("agent_before_settle")(event, context("/repo"));
  assert.equal(first.continue, true);
  assert.deepEqual(first.entries, [
    ...priorDrafts,
    { type: "custom_message", customType: PINDIE_CONTINUATION_PROBE_TYPE,
      content: PINDIE_CONTINUATION_PROBE_MESSAGE, display: false },
  ]);
  assert.deepEqual(event.entries, priorDrafts);
  assert.equal(await harness.api.handler("agent_before_settle")(
    { ...event, entries: first.entries }, context("/repo"),
  ), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
});

test("E03-E05/E07 semantic, authority, stop, and queue facts suppress ineligible probes", async () => {
  const cases: Array<{
    name: string;
    state: PindieState | undefined;
    stopReason?: "aborted" | "error" | "length";
    pending?: boolean;
    previewOnlyPending?: boolean;
  }> = [
    { name: "no current Task", state: EMPTY_STATE },
    { name: "completed Task", state: completedState() },
    { name: "Human Gate", state: gatedState() },
    { name: "blockers", state: { task: { ...activeState().task!, openLoops: { blockers: ["Awaiting service"], questions: [], nextIntent: null } } } },
    { name: "unavailable State", state: undefined },
    { name: "aborted stop", state: activeState(), stopReason: "aborted" },
    { name: "error stop", state: activeState(), stopReason: "error" },
    { name: "length stop", state: activeState(), stopReason: "length" },
    { name: "existing pending Pi message", state: activeState(), pending: true },
    { name: "pending boundary preview", state: activeState(), previewOnlyPending: true },
  ];

  for (const scenario of cases) {
    const harness = createHarness(scenario.state === undefined ? [] : [["/repo", scenario.state]]);
    if (scenario.state === undefined) {
      harness.store.loadErrors.set("/repo", new Error("State unavailable"));
    }
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const result = await harness.api.handler("agent_before_settle")(
      beforeSettle(scenario.stopReason ?? "stop", scenario.pending || scenario.previewOnlyPending ? [{ role: "user", content: "queued" }] : []),
      context("/repo", [], scenario.pending),
    );
    assert.equal(result, undefined, scenario.name);
    assert.deepEqual(harness.api.sentMessages, [], scenario.name);
  }
});

test("AR20-AR35 reasoning defaults to manual and explicit auto controls Pi", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  assert.ok(harness.api.handlers.has("turn_end"));
  assert.ok(harness.api.handlers.has("thinking_level_select"));
  assert.ok(harness.api.commands.has("reasoning"));
  await startSession(harness, "/repo");
  assert.equal(harness.integration.reasoning.snapshot.mode, "manual");
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.appliedThinkingLevels, []);
  const originalState = structuredClone(harness.integration.runtime.state);
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("bash", true)] }, context("/repo"));
  assert.deepEqual(harness.api.appliedThinkingLevels, []);
  const command = harness.api.commands.get("reasoning");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = { ...context("/repo"), ui: { notify: (message: string, type: string) => notices.push({ message, type }) } };
  assert.deepEqual(command.getArgumentCompletions(""), [{ value: "auto", label: "auto" }, { value: "manual", label: "manual" }]);
  const selectorOptions: string[][] = [];
  await command.handler("", {
    ...commandContext,
    mode: "tui",
    ui: {
      notify: (message: string, type: string) => notices.push({ message, type }),
      select: async (_title: string, options: string[]) => {
        selectorOptions.push(options);
        return null;
      },
    },
  });
  assert.deepEqual(selectorOptions, [["auto", "manual"]]);
  await command.handler("manual", commandContext);
  assert.equal(harness.integration.reasoning.snapshot.mode, "manual");
  const manualCount = harness.api.appliedThinkingLevels.length;
  await beginAgentRun(harness);
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("edit")] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.length, manualCount);
  await command.handler("high", commandContext);
  assert.deepEqual(notices.at(-1), { message: "Usage: /reasoning [auto|manual]", type: "warning" });
  await command.handler("status", commandContext);
  assert.deepEqual(notices.at(-1), { message: "Usage: /reasoning [auto|manual]", type: "warning" });
  await command.handler("auto", commandContext);
  assert.equal(harness.integration.reasoning.snapshot.mode, "auto");
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "medium");
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("edit")] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "low");
  harness.api.thinkingLevel = "low";
  await harness.api.handler("thinking_level_select")({ type: "thinking_level_select", level: "low", previousLevel: "medium" }, context("/repo"));
  assert.equal(harness.integration.reasoning.snapshot.effectiveLevel, "low");
  assert.equal(harness.integration.reasoning.snapshot.mode, "auto");
  assert.deepEqual(harness.integration.runtime.state, originalState);
  assert.deepEqual(harness.store.saves, []);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown" }, context("/repo"));
  await startSession(harness, "/repo", "new");
  assert.equal(harness.integration.reasoning.snapshot.mode, "manual");
});

test("AR36 startup, reload, and new session starts reset reasoning to Manual", async () => {
  for (const reason of ["startup", "reload", "new"]) {
    const harness = createHarness([["/repo", activeState()]]);
    harness.api.thinkingLevel = "high";
    harness.integration.reasoning.setAuto();
    await startSession(harness, "/repo", reason);
    assert.deepEqual(harness.integration.reasoning.snapshot, {
      mode: "manual",
      requestedLevel: "medium",
      effectiveLevel: "high",
    }, reason);
    assert.deepEqual(harness.api.appliedThinkingLevels, [], reason);
  }
});

test("T37 session_start resolves and loads project State", async () => {
  const state = activeState();
  const harness = createHarness([["/canonical/repo", state]], {
    "/working/repo": "/canonical/repo",
  });

  await startSession(harness, "/working/repo");

  assert.equal(harness.integration.runtime.projectRoot, "/canonical/repo");
  assert.equal(harness.integration.runtime.state, state);
  assert.deepEqual(harness.store.loads, ["/canonical/repo"]);
});

test("Slice A bounds project-root resolution and never loads State after a root hang", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markStarted!: () => void;
  let release!: (root: string) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pending = new Promise<string>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const harness = createHarness([], {}, {
    resolveProjectRoot: async (_cwd, innerSignal) => {
      signal = innerSignal;
      markStarted();
      return pending;
    },
  });

  const startup = startSession(harness, "/working/repo");
  await started;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await startup;

  assert.equal(signal?.aborted, true);
  assert.deepEqual(harness.store.loads, []);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.match(harness.integration.stateUnavailableReason ?? "", /project root resolution.*timed out/i);

  release("/late/repo");
  await nextTurn();
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.deepEqual(harness.store.loads, []);
});

test("Slice A bounds initial State load and rejects its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness([["/repo", activeState("late State")]]);
  const pending = harness.store.pauseNextLoad();
  const startup = startSession(harness, "/repo");
  await pending.entered;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await startup;

  assert.deepEqual(harness.store.loads, ["/repo"]);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.deepEqual(harness.integration.runtime.state, EMPTY_STATE);
  assert.match(harness.integration.stateUnavailableReason ?? "", /State load.*timed out/i);

  pending.release();
  await nextTurn();
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.deepEqual(harness.integration.runtime.state, EMPTY_STATE);
});

test("Slice A bounds authoritative pre-Run refresh without hanging the Run start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness([["/repo", activeState("bounded refresh")]], {}, {
    featureSelection: { selfImprovement: false },
  });
  await startSession(harness, "/repo");
  const pending = harness.store.pauseNextLoad();
  const beforeRun = harnessBeforeAgentStart(harness);
  await pending.entered;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  const baseline = await beforeRun;
  assert.match(baseline.message.content, /Agent Run authority: unavailable/);
  assert.match(harness.integration.stateUnavailableReason ?? "", /pre-Run authoritative State refresh.*timed out/i);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.equal(harness.integration.runTimer.active, true);

  pending.release();
  await nextTurn();
  assert.equal(harness.integration.runtime.projectRoot, null);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice A times out Self-Improvement preparation and clears only its failed generation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "adapt-one", experience: commandExperience("adapt one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "adapt-two", experience: commandExperience("adapt two", createPolicySnapshot({ approach: "direct-action" })) },
    ],
    loadedRecords: 2,
    unsupportedSchema: 0,
    invalid: 0,
  };
  let markTrustRead!: () => void;
  let releaseTrustRead!: () => void;
  let pauseTrustRead = true;
  const trustReadEntered = new Promise<void>((resolve) => { markTrustRead = resolve; });
  const trustReadPaused = new Promise<void>((resolve) => { releaseTrustRead = resolve; });
  const strategyDecisionReader = {
    read: async () => null,
    readAll: async () => {
      if (pauseTrustRead) {
        pauseTrustRead = false;
        markTrustRead();
        await trustReadPaused;
      }
      return [];
    },
  };
  const harness = createHarness([["/repo", activeState("timed-out SI")]], {}, {
    experienceReader: reader,
    strategyDecisionReader,
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("adapt").handler("direct-action", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  const beforeRun = harnessBeforeAgentStart(harness);
  await trustReadEntered;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await assert.rejects(beforeRun, /Self-Improvement Run preparation.*timed out/i);

  assert.equal(harness.integration.core.run.hasActiveAgentRun, false);
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.derivation?.hasDerivation, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  assert.equal(harness.integration.trustedStrategyPortfolio, null);

  releaseTrustRead();
  await nextTurn();
  assert.equal(harness.integration.core.run.hasActiveAgentRun, false);
  const ordinary = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(ordinary.systemPrompt, /<PINDIE_ADAPTATION_PACKET>/);
  assert.equal(harness.integration.core.run.hasActiveAgentRun, true);
});

test("Slice A rejects late trust publication from an older preparation generation", async () => {
  const promoted = trialCandidate("00000000-0000-4000-8000-000000000081");
  const decision = createStrategyRevisionDecision({
    candidate: promoted,
    decision: "promoted",
    trialRecordIds: ["late-trust-one", "late-trust-two"],
    decidedAt: "2026-01-02T00:00:00.000Z",
  });
  let markFirstRead!: () => void;
  let releaseFirstRead!: () => void;
  let firstRead = true;
  const firstReadEntered = new Promise<void>((resolve) => { markFirstRead = resolve; });
  const firstReadPaused = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  const strategyDecisionReader = {
    read: async () => null,
    readAll: async () => {
      if (firstRead) {
        firstRead = false;
        markFirstRead();
        await firstReadPaused;
        return [];
      }
      return [decision];
    },
  };
  const strategyCandidateReader = {
    read: async (_root: string, candidateId: string) => candidateId === promoted.candidateId ? promoted : null,
    readAll: async () => [promoted],
  };
  const harness = createHarness([["/repo", activeState("late trust")]], {}, {
    featureSelection: { crossProjectLearning: false },
    strategyDecisionReader,
    strategyCandidateReader,
  });
  await startSession(harness, "/repo");

  const staleRun = harnessBeforeAgentStart(harness);
  await firstReadEntered;
  const currentRun = await harnessBeforeAgentStart(harness);
  const currentPortfolio = harness.integration.trustedStrategyPortfolio;
  assert.ok(currentPortfolio);
  assert.ok(harness.integration.promotedStrategyRevisionCatalog.entries.length > 0);

  releaseFirstRead();
  await assert.rejects(staleRun, /preparation became stale/i);
  assert.strictEqual(harness.integration.trustedStrategyPortfolio, currentPortfolio);
  assert.ok(harness.integration.promotedStrategyRevisionCatalog.entries.length > 0);
  assert.equal(harness.integration.core.run.hasActiveAgentRun, true);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("ordinary Self-Improvement preparation tolerates a context without a Session getter", async () => {
  const harness = createHarness([["/repo", activeState("ordinary context")]]);
  const ordinaryContext = {
    cwd: "/repo",
    hasUI: false,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
    ui: { notify: () => undefined },
  };
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ordinaryContext);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", systemPrompt: "", prompt: "Continue", systemPromptOptions: {} },
    ordinaryContext,
  );
  assert.equal(harness.integration.core.run.hasActiveAgentRun, true);
});

test("T38 session replacement reloads the same project task", async () => {
  const state = activeState("Persistent task");
  const harness = createHarness([["/repo", state]]);
  await startSession(harness, "/repo");

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo"),
  );
  assert.equal(harness.integration.runtime.projectRoot, null);
  await startSession(harness, "/repo", "new");

  assert.equal(harness.integration.runtime.state.task?.goal, "Persistent task");
  assert.deepEqual(harness.store.loads, ["/repo", "/repo"]);
});

test("T39 different project roots load independent State", async () => {
  const harness = createHarness([
    ["/repo-a", activeState("Project A")],
    ["/repo-b", activeState("Project B")],
  ]);

  await startSession(harness, "/repo-a");
  assert.equal(harness.integration.runtime.state.task?.goal, "Project A");
  await startSession(harness, "/repo-b");

  assert.equal(harness.integration.runtime.projectRoot, "/repo-b");
  assert.equal(harness.integration.runtime.state.task?.goal, "Project B");
});

test("T40 subdirectories resolving to one Git root share State", async () => {
  const harness = createHarness([["/repo", activeState("Shared task")]], {
    "/repo/packages/app": "/repo",
    "/repo/packages/api": "/repo",
  });

  await startSession(harness, "/repo/packages/app");
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo/packages/app"),
  );
  await startSession(harness, "/repo/packages/api", "new");

  assert.equal(harness.integration.runtime.state.task?.goal, "Shared task");
  assert.deepEqual(harness.store.loads, ["/repo", "/repo"]);
});

test("failed State load is fail-closed and a later session reload recovers", async () => {
  const harness = createHarness([
    ["/repo-a", activeState("Project A")],
    ["/repo-b", activeState("Project B")],
  ]);
  await startSession(harness, "/repo-a");
  harness.store.loadErrors.set("/repo-b", new Error("corrupt State file"));

  await startSession(harness, "/repo-b");

  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.match(
    harness.integration.stateUnavailableReason ?? "",
    /corrupt State file/,
  );
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is unavailable.*project\.mutate/i);

  harness.store.loadErrors.delete("/repo-b");
  await startSession(harness, "/repo-b", "reload");

  assert.equal(harness.integration.stateUnavailableReason, null);
  assert.equal(harness.integration.runtime.projectRoot, "/repo-b");
  assert.equal(harness.integration.runtime.state.task?.goal, "Project B");
});

test("P01/P07 before_agent_start appends the stable contract and returns a Run Baseline", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const handler = harness.api.handler("before_agent_start");
  const result = await handler(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context("/repo"),
  ) as { systemPrompt?: string; message?: Record<string, unknown> } | undefined;

  assert.match(result?.systemPrompt ?? "", /^Pi system prompt\n\n<PINDIE_SYSTEM_CONTRACT>/);
  assert.equal((result?.systemPrompt?.match(/<PINDIE_SYSTEM_CONTRACT>/g) ?? []).length, 1);
  assert.equal(result?.message?.customType, PINDIE_RUN_BASELINE_TYPE);
  assert.equal(result?.message?.display, false);
  assert.ok(isPindieRunBaselineMessage({ role: "custom", ...result?.message }));
  assert.match(String(result?.message?.content), /Agent Run authority: coherent/);
  assert.match(String(result?.message?.content), /Goal:\nWire Pi extension/);
  assert.match(String(result?.message?.content), /Current Pindie Action Eligibility:/);
});

test("successful compaction appends exactly one hidden current State Checkpoint", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await executeSemanticTool(harness, "pindie_task_refine", "compact-refine", {
    goal: "Compacted authoritative goal",
    constraints: ["Keep the exact semantic State"],
  });
  await executeSemanticTool(harness, "pindie_policy_set", "compact-policy", {
    approach: "architecture-first",
    modifiers: ["minimal-change"],
  });

  await harness.api.handler("session_compact")(
    {
      type: "session_compact",
      compactionEntry: { id: "compaction-1" },
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    },
    context("/repo"),
  );
  assert.equal(harness.api.sentMessages.length, 1);
  const sent = harness.api.sentMessages[0] as {
    message: { customType: string; content: string; display: boolean };
    options?: { triggerTurn?: boolean };
  };
  assert.equal(sent.options?.triggerTurn, false);
  assert.equal(sent.message.customType, PINDIE_STATE_CHECKPOINT_TYPE);
  assert.equal(sent.message.display, false);
  assert.ok(isPindieStateCheckpointMessage({ role: "custom", ...sent.message }));
  assert.equal(harness.integration.contextGovernor.snapshot.successfulCompactions, 1);
  assert.equal(harness.integration.contextGovernor.snapshot.pressureCompactions, 0);
  assert.equal(harness.integration.contextGovernor.snapshot.pressure, "normal");
  for (const expected of [
    "Compacted authoritative goal",
    "Constraints:\n- Keep the exact semantic State",
    "Verification status: stale",
    "Current Pindie Action Eligibility:",
    "Current Policy Snapshot:\n- Approach: architecture-first",
    "  - minimal-change (modifier)",
  ]) assert.match(sent.message.content, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await harness.api.handler("session_compact")(
    {
      type: "session_compact",
      compactionEntry: { id: "compaction-1" },
      fromExtension: false,
      reason: "manual",
      willRetry: false,
    },
    context("/repo"),
  );
  assert.equal(harness.api.sentMessages.length, 1);
});

test("overflow compaction queues a checkpoint before retry without an extra checkpoint turn", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.handler("session_compact")(
    {
      type: "session_compact",
      compactionEntry: { id: "overflow-1" },
      fromExtension: false,
      reason: "overflow",
      willRetry: true,
    },
    context("/repo"),
  );
  assert.equal(harness.api.sentMessages.length, 1);
  const sent = harness.api.sentMessages[0] as { options?: { triggerTurn?: boolean } };
  assert.equal(sent.options, undefined);
  assert.doesNotMatch(
    (harness.api.sentMessages[0] as { message: { content: string } }).message.content,
    /Current Policy Snapshot/,
  );
});

test("failed or aborted compaction emits no State Checkpoint", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.handler("session_compact_failed")(
    {
      type: "session_compact_failed",
      reason: "manual",
      aborted: true,
      willRetry: false,
      fromExtension: false,
    },
    context("/repo"),
  );
  await harness.api.handler("session_compact_failed")(
    {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: false,
      willRetry: true,
      fromExtension: false,
      errorMessage: "Compaction provider failed.",
    },
    context("/repo"),
  );
  assert.equal(harness.api.sentMessages.length, 0);
  assert.equal(harness.integration.contextGovernor.snapshot.successfulCompactions, 0);
  assert.equal(harness.integration.contextGovernor.snapshot.pressureCompactions, 0);
});

test("P04 before_agent_start captures coherent authoritative facts once per Run", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  const result = await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context("/repo"),
  ) as { message: { content: string } };

  assert.match(result.message.content, /Agent Run authority: coherent/);
  assert.match(result.message.content, /Task status: active/);
  assert.match(result.message.content, /Verification status: passed/);
  assert.match(result.message.content, /Goal:\nWire Pi extension/);
  assert.equal(harness.store.saves.length, 0);
  assert.equal(harness.api.handlers.has("context"), true);
});

test("Context Governor projects no message at normal pressure and one bounded message at elevated/high pressure", async () => {
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const normal = await projectContext(harness, 10, [{ role: "user", content: "work" }]);
  assert.equal(normal, undefined);

  const elevated = await projectContext(harness, 70, [{ role: "user", content: "work" }]);
  const elevatedMessages = contextLifecycleMessages(elevated);
  assert.equal(elevatedMessages.length, 1);
  assert.equal(elevatedMessages[0]?.display, false);
  assert.match(String(elevatedMessages[0]?.content), /elevated/);
  assert.match(String(elevatedMessages[0]?.content), /not new user intent/i);

  const high = await projectContext(harness, 88, [{ role: "user", content: "work" }]);
  const highMessages = contextLifecycleMessages(high);
  assert.equal(highMessages.length, 1);
  assert.match(String(highMessages[0]?.content), /high/);
  assert.match(String(highMessages[0]?.content), /pindie_task_handoff/);
});

test("active Context Governor guidance is re-projected without transcript persistence or accumulation", async () => {
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const firstInput = [{ role: "user", content: "work" }];
  const first = await projectContext(harness, 75, firstInput);
  const secondInput = [{ role: "user", content: "work" }];
  const second = await projectContext(harness, 75, secondInput);
  const reprojected = await projectContext(
    harness,
    75,
    (first as { messages: unknown[] }).messages,
  );

  assert.equal(firstInput.length, 1);
  assert.equal(secondInput.length, 1);
  assert.equal(contextLifecycleMessages(first).length, 1);
  assert.equal(contextLifecycleMessages(second).length, 1);
  assert.equal(contextLifecycleMessages(reprojected).length, 1);
  assert.equal((first as { messages: unknown[] }).messages.length, 2);
  assert.equal((second as { messages: unknown[] }).messages.length, 2);
  assert.equal((reprojected as { messages: unknown[] }).messages.length, 2);
  assert.deepEqual(harness.api.sentMessages, []);
  assert.deepEqual(harness.api.appendedEntries, []);
});

test("Context Governor observes pressure but gates handoff guidance on current semantic authority", async () => {
  const cases: Array<{
    name: string;
    state: PindieState | undefined;
    loadError?: Error;
  }> = [
    { name: "no active Task", state: EMPTY_STATE },
    { name: "Human Gate", state: gatedState() },
    { name: "blocker", state: blockedState() },
    { name: "unavailable authority", state: undefined, loadError: new Error("State unavailable") },
  ];

  for (const scenario of cases) {
    const harness = createHarness(
      scenario.state === undefined ? [] : [["/repo", scenario.state]],
      {},
      { enableTaskHandoff: true },
    );
    if (scenario.loadError) harness.store.loadErrors.set("/repo", scenario.loadError);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);

    assert.equal(await projectContext(harness, 90), undefined, scenario.name);
    assert.equal(harness.integration.contextGovernor.snapshot.pressure, "high", scenario.name);
  }

  const stale = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
  });
  await startSession(stale, "/repo");
  await beginAgentRun(stale);
  stale.store.states.set("/repo", activeState("Externally changed Task"));
  await stale.integration.runtime.refresh();
  assert.equal(await projectContext(stale, 90), undefined);
  assert.equal(stale.integration.contextGovernor.snapshot.pressure, "high");
});

test("Context Governor suppresses guidance after a valid pending handoff and during adaptation", async () => {
  const pending = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
  });
  await startSession(pending, "/repo");
  await beginAgentRun(pending);
  const input = handoffInput();
  assert.equal(await callGuard(pending, toolCall("pindie_task_handoff", input, "pending-context-handoff")), undefined);
  await pending.api.tool("pindie_task_handoff").execute("pending-context-handoff", input);
  await pending.api.handler("tool_result")(
    toolResult("pindie_task_handoff", false, "pending-context-handoff"),
    context("/repo"),
  );
  assert.equal(await projectContext(pending, 90), undefined);

  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "adapt-one.json", experience: commandExperience("adapt one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "adapt-two.json", experience: commandExperience("adapt two", createPolicySnapshot({ approach: "direct-action" })) },
    ],
    loadedRecords: 2,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const adaptation = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
    experienceReader: reader,
  });
  await startSession(adaptation, "/repo");
  await adaptation.api.commands.get("adapt").handler("direct-action", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(adaptation);
  assert.equal(await projectContext(adaptation, 90), undefined);
});

test("Context Governor resets at Session lifecycle boundaries", async () => {
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    enableTaskHandoff: true,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await projectContext(harness, 90);
  assert.equal(harness.integration.contextGovernor.snapshot.pressure, "high");

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/repo"),
  );
  assert.deepEqual(harness.integration.contextGovernor.snapshot, {
    pressure: "normal",
    contextPercent: null,
    contextWindow: null,
    successfulCompactions: 0,
    pressureCompactions: 0,
    postCompactionBaselinePercent: null,
  });
  await startSession(harness, "/repo", "reload");
  await beginAgentRun(harness);
  assert.equal(await projectContext(harness, 10), undefined);
});

test("SI04 stable contract and Run Baseline preserve authority information across Run states", async () => {
  const coherent = createHarness([["/repo", activeState()]]);
  await startSession(coherent, "/repo");
  const coherentResult = await harnessBeforeAgentStart(coherent);
  assert.match(coherentResult.message.content, /Agent Run authority: coherent/);
  assert.match(coherentResult.systemPrompt, /Execution Gateway is authoritative/);

  const unavailable = createHarness();
  unavailable.store.loadErrors.set("/repo", new Error("State unavailable"));
  await startSession(unavailable, "/repo");
  const unavailableResult = await harnessBeforeAgentStart(unavailable);
  assert.match(unavailableResult.message.content, /Agent Run authority: unavailable/);
  assert.match(unavailableResult.message.content, /State unavailable/);
  assert.deepEqual(unavailable.store.saves, []);
});

test("SI v0.2 Policy Snapshot is optional, transcript-visible, replaceable, and Run-scoped", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(harness.integration.policySnapshot, null);
  const first = await executeSemanticTool(
    harness,
    "pindie_policy_set",
    "policy-first",
    {
      approach: "architecture-first",
      modifiers: ["minimal-change", "verify-as-you-go"],
    },
  );
  assert.equal(first.resultPatch, undefined);
  assert.equal(harness.integration.policySnapshot?.approach.id, "architecture-first");
  assert.deepEqual(
    harness.integration.policySnapshot?.modifiers.map((strategy) => strategy.id),
    ["minimal-change", "verify-as-you-go"],
  );
  assert.match(textOf(first.executionResult), /Current Policy Snapshot declared/);
  assert.match(textOf(first.executionResult), /Approach: architecture-first/);
  assert.match(textOf(first.executionResult), /Modifiers: minimal-change, verify-as-you-go/);

  const replacement = await executeSemanticTool(
    harness,
    "pindie_policy_set",
    "policy-replacement",
    { approach: "explore-first" },
  );
  assert.equal(harness.integration.policySnapshot?.approach.id, "explore-first");
  assert.deepEqual(harness.integration.policySnapshot?.modifiers, []);
  assert.match(textOf(replacement.executionResult), /Approach: explore-first/);

  await beginAgentRun(harness);
  assert.equal(harness.integration.policySnapshot, null);
});

test("failed Policy declaration restores the previous Snapshot after one Core mutation", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await executeSemanticTool(harness, "pindie_policy_set", "policy-first", {
    approach: "architecture-first",
  });
  assert.equal(harness.integration.policySnapshot?.approach.id, "architecture-first");

  const failedCallId = "policy-failed-replacement";
  const input = { approach: "explore-first" };
  assert.equal(
    await callGuard(harness, toolCall("pindie_policy_set", input, failedCallId)),
    undefined,
  );
  const executionResult = await harness.api.tool("pindie_policy_set").execute(
    failedCallId,
    input,
    undefined,
    undefined,
    context("/repo"),
  ) as { content: Array<Record<string, unknown>> };
  await harness.api.handler("tool_result")(
    toolResult(
      "pindie_policy_set",
      true,
      failedCallId,
      executionResult.content,
      input,
    ),
    context("/repo"),
  );

  assert.equal(harness.integration.policySnapshot?.approach.id, "architecture-first");
});

test("SI v0.2 policy declaration stays outside Evaluation and PindieState persistence", async () => {
  let fingerprintCaptures = 0;
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => {
      fingerprintCaptures += 1;
      return { kind: "known", digest: "unchanged" };
    },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const stateBefore = structuredClone(harness.integration.runtime.state);
  const toolsBefore = harness.api.getActiveTools();
  const epochBefore = harness.integration.runtime.externalStateEpoch;
  const result = await executeSemanticTool(
    harness,
    "pindie_policy_set",
    "policy-isolated",
    { approach: "direct-action", modifiers: ["verify-as-you-go"] },
  );

  assert.equal(result.resultPatch, undefined);
  assert.doesNotMatch(textOf(result.executionResult), /Pindie evidence ref/);
  assert.equal(fingerprintCaptures, 0);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.api.getActiveTools(), toolsBefore);
  assert.equal(harness.integration.runtime.externalStateEpoch, epochBefore);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
  assert.deepEqual(harness.store.saves, []);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.integration.runtime.state, "policySnapshot"), false);

  await harness.api.tool("pindie_task_refine").execute("refine-after-policy", {
    goal: "Persist a semantic change after policy declaration",
  });
  const saved = harness.store.saves.at(-1)?.state;
  assert.ok(saved);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "policySnapshot"), false);
  assert.doesNotMatch(JSON.stringify(saved), /direct-action|verify-as-you-go/);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/repo"),
  );
  assert.equal(harness.integration.policySnapshot, null);
  await startSession(harness, "/repo", "reload");
  assert.equal(harness.integration.policySnapshot, null);
});

test("H01 Pindie leaves historical continuation probes in transcript order", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const messages = [
    { role: "user", content: "Continue", timestamp: 1 },
    continuationProbe("old probe one", 2),
    { role: "assistant", content: [], stopReason: "stop", timestamp: 3 },
    continuationProbe("old probe two", 4),
  ];
  assert.deepEqual(messages, [messages[0], messages[1], messages[2], messages[3]]);
});

test("H02-H04 continuation remains one-shot and append-only", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const first = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"));
  assert.equal(first.continue, true);
  assert.equal(first.entries.length, 1);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
});

test("H05 a fresh user Run does not rewrite prior continuation probes", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"));
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  await beginAgentRun(harness);
});

test("P06 unavailable Run Baseline remains factual and consistent with fail-closed guards", async () => {
  const harness = createHarness();
  harness.store.loadErrors.set("/repo", new Error("invalid persisted State"));
  await startSession(harness, "/repo");
  const result = await harnessBeforeAgentStart(harness);
  const content = result.message.content;
  assert.match(content, /Agent Run authority: unavailable/);
  assert.match(content, /Could not load Pindie State for '\/repo': invalid persisted State/);
  assert.doesNotMatch(harness.integration.stateUnavailableReason ?? "", /Restore|Reload/);
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is unavailable.*project\.mutate/i);
});

test("unavailable before_agent_start still appends the stable contract and baseline", async () => {
  const harness = createHarness();
  harness.store.loadErrors.set("/repo", new Error("invalid persisted State"));
  await startSession(harness, "/repo");

  const result = await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context("/repo"),
  ) as { systemPrompt?: string; message?: { customType?: string; content?: string; display?: boolean } } | undefined;

  assert.match(result?.systemPrompt ?? "", /<PINDIE_SYSTEM_CONTRACT>/);
  assert.equal(result?.message?.customType, PINDIE_RUN_BASELINE_TYPE);
  assert.equal(result?.message?.display, false);
  assert.match(result?.message?.content ?? "", /Agent Run authority: unavailable/);
});

test("T44 successful edit invalidates verification and persists it", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);

  await harness.api.handler("tool_result")(
    toolResult("edit"),
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  assert.equal(harness.store.states.get("/repo")?.task?.verification.stale, true);
  assert.equal(harness.store.saves.length, 1);
});

test("T45 successful write invalidates verification and persists it", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("write")), undefined);

  await harness.api.handler("tool_result")(
    toolResult("write"),
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  assert.equal(harness.store.states.get("/repo")?.task?.verification.stale, true);
  assert.equal(harness.store.saves.length, 1);
});

test("Slice B ambiguous tool_call settles after a baseline fingerprint deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markCaptureStarted!: () => void;
  let releaseCapture!: () => void;
  const captureStarted = new Promise<void>((resolve) => { markCaptureStarted = resolve; });
  const capture = new Promise<{ kind: "known"; digest: string }>((resolve) => {
    releaseCapture = () => resolve({ kind: "known", digest: "late-baseline" });
  });
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => {
      markCaptureStarted();
      return capture;
    },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const call = callGuard(harness, toolCall("bash", { command: "mutate" }, "baseline-liveness"));
  await captureStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  assert.equal(await call, undefined);

  const result = await harness.api.handler("tool_result")(
    toolResult(
      "bash",
      false,
      "baseline-liveness",
      [{ type: "text", text: "external tool output" }],
      { command: "mutate" },
    ),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.equal(result.content[0]?.text, "external tool output");
  assert.match(textOf(result), /Project mutation changed authoritative verification state/);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);

  releaseCapture();
  await nextTurn();
});

test("Slice B ambiguous tool_result settles after an after-fingerprint deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let captureCount = 0;
  let markSettlementStarted!: () => void;
  let releaseSettlement!: () => void;
  const settlementStarted = new Promise<void>((resolve) => { markSettlementStarted = resolve; });
  const settlement = new Promise<{ kind: "known"; digest: string }>((resolve) => {
    releaseSettlement = () => resolve({ kind: "known", digest: "baseline" });
  });
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => {
      captureCount += 1;
      if (captureCount === 1) return { kind: "known", digest: "baseline" };
      markSettlementStarted();
      return settlement;
    },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("bash", { command: "mutate" }, "settlement-liveness")), undefined);

  const resultPromise = harness.api.handler("tool_result")(
    toolResult(
      "bash",
      false,
      "settlement-liveness",
      [{ type: "text", text: "external tool output" }],
      { command: "mutate" },
    ),
    context("/repo"),
  );
  await settlementStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  const result = await resultPromise as { content: Array<{ type: string; text?: string }> };
  assert.equal(result.content[0]?.text, "external tool output");
  assert.match(textOf(result), /Project mutation changed authoritative verification state/);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  assert.equal(harness.integration.stateUnavailableReason, null);

  releaseSettlement();
  await nextTurn();
});

test("Slice B uncertain verification invalidation preserves tool output and fences late State publication", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("edit", {}, "uncertain-invalidation")), undefined);
  const save = harness.store.pauseNextSave();

  const resultPromise = harness.api.handler("tool_result")(
    toolResult(
      "edit",
      false,
      "uncertain-invalidation",
      [{ type: "text", text: "external tool output" }],
    ),
    context("/repo"),
  );
  await save.entered;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  const result = await resultPromise as { content: Array<{ type: string; text?: string }> };

  assert.equal(result.content[0]?.text, "external tool output");
  assert.match(
    textOf(result),
    /could not establish verification freshness after this project mutation; semantic authority is unavailable for this Run/i,
  );
  assert.doesNotMatch(textOf(result), /Current Pindie Action Eligibility:/);
  assert.match(harness.integration.stateUnavailableReason ?? "", /semantic authority is unavailable/i);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.equal(harness.integration.core.run.authoritativeState, null);
  await assert.rejects(
    harness.integration.runtime.load("/repo"),
    /semantic State mutation is still pending/i,
  );

  save.release();
  await save.finished;
  await nextTurn();
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.equal(harness.integration.runtime.state.task, null);
  assert.equal(harness.integration.core.run.authoritativeState, null);
});

test("verification invalidation commits when status presentation throws", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, true);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);

  await harness.api.handler("tool_result")(toolResult("edit"), uiContext);

  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  assert.equal(harness.store.states.get("/repo")?.task?.verification.stale, true);
  assert.equal(harness.integration.stateUnavailableReason, null);
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
});

test("runtime failure remains authoritative when status presentation throws", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, true);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  harness.store.saveError = new Error("disk unavailable");
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);

  await assert.rejects(
    harness.api.handler("tool_result")(toolResult("edit"), uiContext),
    /disk unavailable/,
  );

  assert.match(
    harness.integration.stateUnavailableReason ?? "",
    /could not persist verification invalidation.*disk unavailable/i,
  );
  assert.equal(harness.integration.runtime.projectRoot, null);
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
});

test("T46 failed edit does not invalidate verification", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");

  await harness.api.handler("tool_result")(
    toolResult("edit", true),
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
  assert.deepEqual(harness.store.saves, []);
});

test("T47 read does not invalidate verification", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");

  await harness.api.handler("tool_result")(
    toolResult("read"),
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
  assert.deepEqual(harness.store.saves, []);
});

test("PMF-E01-E18 probes admitted ambiguous tools by toolCallId and preserves only known unchanged reality", async () => {
  const fingerprints = [
    { kind: "known" as const, digest: "A" }, { kind: "known" as const, digest: "A" },
    { kind: "known" as const, digest: "B0" }, { kind: "known" as const, digest: "B1" },
  ];
  let captures = 0;
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => { captures += 1; return fingerprints.shift() ?? { kind: "unknown", reason: "missing" }; },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  // Safe observation, semantic tools, and known edit/write paths never probe.
  for (const name of [
    "read", "grep", "find", "ls", "pindie_git_observe",
    "pindie_task_refine", "pindie_gate_open", "edit", "write",
  ]) {
    await callGuard(harness, toolCall(name));
  }
  assert.equal(captures, 0);
  await callGuard(harness, toolCall("bash", {}, "unchanged"));
  assert.equal(captures, 1);
  await harness.api.handler("tool_result")(toolResult("bash", false, "unchanged"), context("/repo"));
  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
  assert.equal(harness.store.saves.length, 0);
  await callGuard(harness, toolCall("future_mutating_tool", {}, "changed"));
  await harness.api.handler("tool_result")(toolResult("future_mutating_tool", true, "changed"), context("/repo"));
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  assert.deepEqual(harness.integration.runtime.state.task?.verification.checks, []);
  assert.equal(harness.store.saves.length, 1);
  // The consumed duplicate and unmatched result are no-ops.
  await harness.api.handler("tool_result")(toolResult("future_mutating_tool", true, "changed"), context("/repo"));
  await harness.api.handler("tool_result")(toolResult("bash", false, "unmatched"), context("/repo"));
  assert.equal(harness.store.saves.length, 1);
});

test("PMF-E25-E29 overlapping ambiguous tools share one baseline until every result settles", async () => {
  const fingerprints = ["S0", "S0", "S0", "S1", "S2", "S2"];
  let captures = 0;
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => {
      captures += 1;
      return { kind: "known", digest: fingerprints.shift() ?? "missing" };
    },
  });
  await startSession(harness, "/repo"); await beginAgentRun(harness);
  await callGuard(harness, toolCall("bash", {}, "A"));
  await callGuard(harness, toolCall("bash", {}, "B"));
  assert.equal(captures, 1, "B must not capture A's in-flight/polluted reality");
  // A restores the shared baseline; B remains pending, so C must still join it.
  await harness.api.handler("tool_result")(toolResult("bash", false, "A"), context("/repo"));
  await callGuard(harness, toolCall("future_mutating_tool", {}, "C"));
  assert.equal(captures, 2, "only A result captured AFTER; C joined the active window");
  await harness.api.handler("tool_result")(toolResult("bash", false, "B"), context("/repo"));
  await harness.api.handler("tool_result")(toolResult("future_mutating_tool", false, "C"), context("/repo"));
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true, "C's S1 must compare with shared S0");
  // After all pending IDs settle, D starts a new window and captures a new baseline.
  await callGuard(harness, toolCall("bash", {}, "D"));
  assert.equal(captures, 5);
  await harness.api.handler("tool_result")(toolResult("bash", false, "D"), context("/repo"));

  const unknown = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => { captures += 1; return { kind: "unknown", reason: "non-git" }; },
  });
  await startSession(unknown, "/repo"); await beginAgentRun(unknown);
  await callGuard(unknown, toolCall("bash", {}, "U1"));
  await callGuard(unknown, toolCall("bash", {}, "U2"));
  const unknownCaptures = captures;
  await unknown.api.handler("tool_result")(toolResult("bash", false, "U2"), context("/repo"));
  await unknown.api.handler("tool_result")(toolResult("bash", false, "U1"), context("/repo"));
  assert.equal(captures, unknownCaptures, "unknown baseline skips AFTER captures");
  assert.equal(unknown.integration.stateUnavailableReason, null);
  assert.equal(unknown.integration.runtime.state.task?.verification.stale, true);
});

test("PMF-E01 blocked bash creates no probe and unknown before allows then invalidates", async () => {
  let captures = 0;
  const gated = createHarness([["/repo", gatedState()]], {}, { captureProjectFingerprint: async () => { captures += 1; return { kind: "unknown", reason: "non-git" }; } });
  await startSession(gated, "/repo"); await beginAgentRun(gated);
  assertBlocked(await callGuard(gated, toolCall("bash")), /project\.mutate.*waiting_human/i);
  assert.equal(captures, 0);
  const harness = createHarness([["/repo", verifiedState()]], {}, { captureProjectFingerprint: async () => { captures += 1; return { kind: "unknown", reason: "non-git" }; } });
  await startSession(harness, "/repo"); await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("bash")), undefined);
  await harness.api.handler("tool_result")(toolResult("bash", true), context("/repo"));
  assert.equal(harness.integration.stateUnavailableReason, null);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
});

test("H01-H04 Human Gate blocks edit, write, bash, and unknown tools", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["edit", "write", "bash", "deploy_custom"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /project\.mutate.*waiting_human/i);
  }
});

test("H05 Human Gate allows read-only observation tools", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["read", "grep", "find", "ls", "pindie_git_observe"]) {
    assert.equal(await callGuard(harness, toolCall(name)), undefined);
  }
});

test("H06-H07 Human Gate allows task refinement and gate resolution", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(
      harness,
      toolCall("pindie_task_refine", { goal: "Refined" }),
    ),
    undefined,
  );
  assert.equal(
    await callGuard(harness, toolCall("pindie_gate_resolve")),
    undefined,
  );
});

test("H08 Human Gate blocks other narrow semantic actions", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_progress"),
    ),
    /task\.progress.*waiting_human/i,
  );
});

test("SO-E02 completed task allows Git observation while bash remains blocked", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("pindie_git_observe", { action: "status" })), undefined);
  assertBlocked(await callGuard(harness, toolCall("bash")), /project\.mutate.*Task status: done/i);
});

test("H09 completed task blocks edit, write, and bash", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["edit", "write", "bash"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /project\.mutate.*Task status: done/i);
  }
});

test("H10 completed task allows pindie_task_start", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(
      harness,
      toolCall("pindie_task_start"),
    ),
    undefined,
  );
});

test("consequential tool admission bounds authoritative State refresh and fails closed", async (t) => {
  const harness = createHarness([["/repo", activeState("Bounded refresh")]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const pending = harness.store.pauseNextLoad();

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const admission = callGuard(harness, toolCall("edit", {}, "hung-refresh-edit"));
  await pending.entered;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  const result = await admission;
  assertBlocked(result, /authoritative State refresh timed out; semantic authority is unavailable for this Run/i);
  assert.match(harness.integration.stateUnavailableReason ?? "", /timed out/i);
  assert.equal(harness.integration.runtime.projectRoot, null);
  assert.deepEqual(harness.integration.runtime.state, EMPTY_STATE);

  pending.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.integration.runtime.state, EMPTY_STATE);
});

test("H11 unavailable Pindie State blocks consequential tools", async () => {
  const harness = createHarness();
  harness.store.loadErrors.set("/repo", new Error("State cannot be loaded"));
  await startSession(harness, "/repo");

  for (const [name, input] of [
    ["edit", {}], ["write", {}], ["bash", {}],
    ["pindie_task_start", {}], ["custom", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    assertBlocked(await callGuard(harness, toolCall(name, input)), /authority is unavailable.*missing capability/i);
  }
  assert.equal(await callGuard(harness, toolCall("read")), undefined);
  const loadsBeforeObserve = harness.store.loads.length;
  assert.equal(await callGuard(harness, toolCall("pindie_git_observe", { action: "status" })), undefined);
  assert.equal(harness.store.loads.length, loadsBeforeObserve);
});

test("Extension mirrors only current-Session Host waiting status and releases observation on shutdown", async () => {
  const hostLease = installQuotaResumeReceiver(() => undefined);
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  try {
    const harness = createHarness([["/repo", activeState()]]);
    const base = context("/repo", [], false, "session");
    const ctx = {
      ...base,
      hasUI: true,
      ui: {
        theme: { fg: (_tone: string, text: string) => text },
        setStatus: (_id: string, text: string | undefined) => statuses.push(text),
        notify: (message: string, type?: string) => notifications.push({ message, type }),
      },
    };
    await harness.api.handler("session_start")(
      { type: "session_start", reason: "startup" },
      ctx,
    );

    hostLease.publishWaitingStatus({ sessionId: "other", resumeAt: 100 });
    assert.doesNotMatch(statuses.at(-1) ?? "", /waiting · quota/);
    assert.deepEqual(notifications, []);

    hostLease.publishWaitingStatus({ sessionId: "session", resumeAt: 200 });
    hostLease.publishWaitingStatus({ sessionId: "session", resumeAt: 200 });
    assert.match(statuses.at(-1) ?? "", /waiting · quota/);
    assert.equal((statuses.at(-1) ?? "").includes("active • waiting · quota"), false);
    assert.deepEqual(notifications, [{
      message: "Codex quota reached. Auto-resume scheduled after the current reset.",
      type: "info",
    }]);

    await harness.api.handler("session_shutdown")(
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
    const statusCount = statuses.length;
    hostLease.publishWaitingStatus({ sessionId: "session", resumeAt: 300 });
    assert.equal(statuses.length, statusCount);
    assert.equal(notifications.length, 1);
  } finally {
    hostLease.release();
  }
});

async function assertPendingQuotaPlanningCancelledBy(
  boundary: "input" | "session_shutdown",
): Promise<void> {
  const now = 1_700_000_000_000;
  const branch = [{
    type: "message",
    id: "pending-quota-plan",
    parentId: null,
    timestamp: new Date(now).toISOString(),
    message: {
      role: "assistant",
      content: [],
      provider: "openai-codex",
      model: "gpt-5-codex",
      usage: {},
      stopReason: "error",
      errorMessage: "The usage limit has been reached",
      timestamp: now,
    },
  } as SessionEntry];
  const events: QuotaResumeControlEvent[] = [];
  const releaseReceiver = installQuotaResumeReceiver((event) => events.push(event));
  let fetches = 0;
  let markPlanningEntered!: () => void;
  let releasePlanning!: () => void;
  const planningEntered = new Promise<void>((resolve) => { markPlanningEntered = resolve; });
  const planningRelease = new Promise<void>((resolve) => { releasePlanning = resolve; });

  try {
    const harness = createHarness(
      [["/repo", activeState()]],
      {},
      {
        now: () => now,
        quotaResumePreferenceStore: {
          loadDefault: async () => true,
          saveDefault: async () => undefined,
        },
        subscriptionUsageProvider: {
          async fetchUsage() {
            fetches += 1;
            if (fetches === 1) return null;
            markPlanningEntered();
            await planningRelease;
            return {
              fetchedAt: now,
              windows: [
                { usedPercent: 100, windowMinutes: 300, resetsAt: now + 60_000 },
                { usedPercent: 50, windowMinutes: 10_080, resetsAt: now + 600_000 },
              ],
            };
          },
        },
      },
    );
    const ctx = {
      ...context("/repo", branch),
      sessionManager: {
        getEntries: () => branch,
        getBranch: () => branch,
        getSessionId: () => "same-session",
        getSessionName: () => undefined,
      },
    };
    await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
    await waitFor(() => fetches === 1);
    await harness.api.handler("before_agent_start")(
      { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
      ctx,
    );
    await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
    await planningEntered;

    if (boundary === "input") {
      await harness.api.handler("input")(
        { type: "input", source: "interactive", streamingBehavior: "steer" },
        ctx,
      );
    } else {
      await harness.api.handler("session_shutdown")(
        { type: "session_shutdown", reason: "reload" },
        ctx,
      );
    }
    assert.equal(events.filter((event) => event.type === "cancel").length, 1);

    releasePlanning();
    await nextTurn();
    assert.equal(events.filter((event) => event.type === "schedule").length, 0);
  } finally {
    releasePlanning();
    releaseReceiver.release();
  }
}

test("user input invalidates pending quota planning before it can re-arm", async () => {
  await assertPendingQuotaPlanningCancelledBy("input");
});

test("same-Session reload shutdown invalidates pending quota planning before it can re-arm", async () => {
  await assertPendingQuotaPlanningCancelledBy("session_shutdown");
});

test("ordinary before_agent_start does not force-refresh subscription usage", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          return null;
        },
      },
    },
  );
  const ctx = withBranch(context("/repo"), []);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  assert.equal(fetches, 0);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
});

test("the latest quota-resume custom branch message force-refreshes usage", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          return {
            fetchedAt: 2,
            windows: [{ usedPercent: 20, windowMinutes: 300 }],
          };
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const branch = [{
    type: "message",
    message: { role: "custom", customType: PINDIE_QUOTA_RESUME_TYPE },
  }];
  const ctx = withBranch(interactiveContext("/repo", statuses), branch);

  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "not the marker", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  await waitFor(() => statuses.at(-1)?.text?.includes("5h 80%") === true);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
  assert.equal(fetches, 1);
  assert.match(statuses.at(-1)?.text ?? "", /5h 80%/);
});

test("Pi 0.86.1 quota custom-trigger preflight starts usage refresh without blocking Run preparation", async () => {
  let markFetchStarted!: () => void;
  let releaseFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  const fetchRelease = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          markFetchStarted();
          await fetchRelease;
          return { fetchedAt: 2, windows: [{ usedPercent: 20, windowMinutes: 300 }] };
        },
      },
    },
  );
  const before = Promise.resolve(harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: PINDIE_QUOTA_RESUME_MESSAGE,
      systemPrompt: "",
      systemPromptOptions: {},
    },
    withBranch(context("/repo"), []),
  ));
  await fetchStarted;
  const preparation = await Promise.race([
    before.then(() => "prepared"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);
  assert.equal(preparation, "prepared");

  releaseFetch();
  await before;
  await nextTurn();
  const ctx = withBranch(context("/repo"), []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
});

test("historical quota-resume messages that are not latest do not force-refresh usage", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          return null;
        },
      },
    },
  );
  const branch = [
    { type: "message", message: { role: "custom", customType: PINDIE_QUOTA_RESUME_TYPE } },
    { type: "message", message: { role: "assistant", content: [] } },
  ];

  const ctx = withBranch(context("/repo"), branch);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
    ctx,
  );
  assert.equal(fetches, 0);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
});

test("failed quota-resume usage refresh is detached, fail-soft, and does not retry or mutate State", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          if (fetches === 1) {
            return { fetchedAt: 1, windows: [{ usedPercent: 100, windowMinutes: 300 }] };
          }
          throw new Error("usage unavailable");
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const ctx = withBranch(interactiveContext("/repo", statuses), []);
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ctx);
  await waitFor(() => fetches === 1);
  const stateBefore = structuredClone(harness.integration.runtime.state);

  await assert.doesNotReject(Promise.resolve(harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: PINDIE_QUOTA_RESUME_MESSAGE,
      systemPrompt: "",
      systemPromptOptions: {},
    },
    ctx,
  )));
  await waitFor(() => statuses.at(-1)?.text?.includes("5h 0%") === true);

  assert.equal(fetches, 2);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.match(statuses.at(-1)?.text ?? "", /5h 0%/);
  await nextTurn();
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, ctx);
  assert.equal(fetches, 2);
});

test("subscription usage is runtime-only, cached, and does not affect State on fetch failure", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      now: () => 1_000_000,
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          throw new Error("usage network unavailable");
        },
      },
    },
  );
  await startSession(harness, "/repo");
  await waitFor(() => fetches === 1);
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );

  // Normal attempts, including failures, retain the pre-Slice-B five-minute throttle.
  assert.equal(fetches, 1);
  assert.equal(harness.integration.stateUnavailableReason, null);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
});

test("failed usage refresh retains the previous runtime-only snapshot", async () => {
  let calls = 0;
  let currentTime = 1_000_000;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      now: () => currentTime,
      subscriptionUsageProvider: {
        async fetchUsage() {
          calls += 1;
          if (calls === 1) {
            return {
              fetchedAt: currentTime,
              windows: [{ usedPercent: 48, windowMinutes: 10_080, resetsAt: 1_700_100_000_000 }],
            };
          }
          throw new Error("proxy request failed");
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);

  await startSession(harness, "/repo");
  await waitFor(() => calls === 1);
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /wk 52%/);

  currentTime += 5 * 60_000;
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );

  assert.equal(calls, 2);
  assert.match(statuses.at(-1)?.text ?? "", /wk 52%/);
});

test("complete reset-credit observation renders through the single existing status key", async () => {
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      now: () => 1_700_000_000_000,
      subscriptionUsageProvider: {
        async fetchUsage() {
          return {
            fetchedAt: 1,
            windows: [{ usedPercent: 32, windowMinutes: 10_080, resetsAt: 1_700_604_740_000 }],
            resetCredits: {
              availableCount: 1,
              credits: [{
                id: "credit-for-test",
                resetType: "codex_rate_limits",
                status: "available",
                expiresAt: 1_702_505_600_000,
              }],
            },
          };
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await harness.api.handler("session_start")(
    { type: "session_start", reason: "startup" },
    uiContext,
  );
  await waitFor(() => /wk 68% • ↻ 6d\+ • ⟳ 1$/.test(statuses.at(-1)?.text ?? ""));

  assert.match(statuses.at(-1)?.text ?? "", /wk 68% • ↻ 6d\+ • ⟳ 1$/);
  assert.deepEqual([...new Set(statuses.map(({ id }) => id))], ["pindie-status"]);
});

test("RunTimer status ticks render cached usage without fetching again", async () => {
  let fetches = 0;
  const harness = createHarness(
    [["/repo", activeState()]],
    {},
    {
      subscriptionUsageProvider: {
        async fetchUsage() {
          fetches += 1;
          return {
            fetchedAt: 1,
            windows: [{ usedPercent: 48, windowMinutes: 10_080, resetsAt: 1_700_100_000_000 }],
          };
        },
      },
    },
  );
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);

  await startSession(harness, "/repo");
  await new Promise((resolve) => setImmediate(resolve));
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  assert.equal(fetches, 1);
  assert.match(statuses.at(-1)?.text ?? "", /wk 52%/);
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
});

test("Run Cost measures public session usage from the Run baseline and resets per session", async () => {
  const entries: unknown[] = [{
    type: "message",
    message: { role: "assistant", usage: { cost: { total: 4.8 } } },
  }];
  const harness = createHarness([["/repo", activeState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, false, entries);

  await startSession(harness, "/repo", "startup", entries);
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /\$0.000/);

  entries.push({
    type: "message",
    message: { role: "toolResult", usage: { cost: { total: 0.31 } } },
  });
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /task 0s • \$0.31 • manual • active • verify 0\/1/);
  assert.deepEqual(harness.integration.runCost.snapshot(entries as any), {
    cost: 0.31,
    active: false,
  });

  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Next",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /task 0s • \$0.31 • manual • thinking • active • verify 0\/1/);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    uiContext,
  );
  assert.equal(harness.integration.runCost.snapshot(entries as any), null);
});

test("no-Task Run status uses Run time/cost and suppresses a completed Task's done verification", async () => {
  const clock = new DeterministicRunClock();
  const entries: unknown[] = [];
  const harness = createHarness([["/repo", completedState()]], {}, {
    runTimer: clock.timer,
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, false, entries);

  await startSession(harness, "/repo", "startup", entries);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "/derive", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  clock.now = 42_000;
  entries.push({
    type: "message",
    message: { role: "assistant", usage: { cost: { total: 0.006 } } },
  });
  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read", "read"),
    uiContext,
  );

  const status = statuses.at(-1)?.text ?? "";
  assert.match(status, /^run 42s • \$0\.006 • manual • reading$/);
  assert.doesNotMatch(status, /\bdone\b|✓|verify|\blast\b/);
  assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, false);
});

test("Task status uses only Task-owned mid-Run consumption and replacement resets its epoch", async () => {
  const clock = new DeterministicRunClock();
  const entries: unknown[] = [];
  const harness = createHarness([], {}, { runTimer: clock.timer });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, false, entries);

  await startSession(harness, "/repo", "startup", entries);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Prepare", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  clock.now = 5_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.03 } } } });
  await harness.api.tool("pindie_task_start").execute("start", {
    goal: "Task A",
    successCriteria: ["A works"],
  });
  clock.now = 12_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.05 } } } });
  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read-a", "read"),
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /^task 7s • \$0\.05/);

  await harness.api.tool("pindie_task_replace").execute("replace", {
    goal: "Task B",
    successCriteria: ["B works"],
  });
  clock.now = 15_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.04 } } } });
  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read-b", "read"),
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /^task 3s • \$0\.04/);
});

test("Task refinement preserves metrics and completion output freezes cumulative Task consumption", async () => {
  const clock = new DeterministicRunClock();
  const entries: unknown[] = [];
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    runTimer: clock.timer,
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, false, entries);

  await startSession(harness, "/repo", "startup", entries);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Finish", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  clock.now = 5_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.08 } } } });
  await harness.api.tool("pindie_task_refine").execute("refine", {
    constraints: ["Remain focused"],
  });
  const { ref } = await captureObservationEvidence(harness, "refined-task-read");
  await harness.api.tool("pindie_verification_record").execute("verify-refined", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [ref],
    },
  });
  clock.now = 8_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.06 } } } });
  const result = await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Finished the Task.",
  });

  assert.match(textOf(result), /Duration: 8s/);
  assert.match(textOf(result), /Cost: \$0\.14/);
  assert.match(statuses.at(-1)?.text ?? "", /^task 8s • \$0\.14 • manual • thinking • done • ✓ 1\/1/);
  clock.now = 20_000;
  entries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } });
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.match(statuses.at(-1)?.text ?? "", /^task 8s • \$0\.14 • manual • done • ✓ 1\/1/);
});

test("shared Host Task metrics survive automatic replacement while Run trackers restart", async () => {
  const taskMetrics = new TaskMetricsTracker();
  const firstClock = new DeterministicRunClock();
  const firstEntries: unknown[] = [];
  const first = createHarness([["/repo", activeState("Long Task")]], {}, {
    runTimer: firstClock.timer,
    taskMetrics,
  });
  await startSession(first, "/repo", "startup", firstEntries);
  await beginAgentRun(first, "/repo", firstEntries);
  firstClock.now = 12_000;
  firstEntries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.11 } } } });
  await captureObservationEvidence(first, "first-run-read");
  await first.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo", firstEntries),
  );
  const binding = taskContractFingerprint(first.integration.runtime.state.task!);
  assert.equal(taskMetrics.prepareAutomaticRollover("session-a", binding), true);
  await first.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo", firstEntries),
  );
  assert.equal(first.integration.runTimer.durationMs, null);
  assert.equal(first.integration.runCost.snapshot(firstEntries as any), null);

  const secondClock = new DeterministicRunClock();
  const secondEntries: unknown[] = [];
  const second = createHarness([["/repo", activeState("Long Task")]], {}, {
    runTimer: secondClock.timer,
    taskMetrics,
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, false, secondEntries);
  await second.api.handler("session_start")(
    { type: "session_start", reason: "new" },
    context("/repo", secondEntries, false, "session-b"),
  );
  await second.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Resume", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  secondClock.now = 17_000;
  secondEntries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.21 } } } });
  await second.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "second-read", "read"),
    uiContext,
  );

  assert.equal(second.integration.runTimer.durationMs, 17_000);
  assert.deepEqual(second.integration.runCost.snapshot(secondEntries as any), { cost: 0.21, active: true });
  assert.match(statuses.at(-1)?.text ?? "", /^task 29s • \$0\.32/);

  const { ref: secondRunRef } = await captureObservationEvidence(
    second,
    "second-run-observation",
  );
  await second.api.tool("pindie_verification_record").execute("verify-long-task", {
    check: {
      name: "long-task-check",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [secondRunRef],
    },
  });
  const completion = await second.api.tool("pindie_task_complete").execute(
    "complete-long-task",
    { summary: "Completed across automatic Session rollover." },
  );
  assert.match(textOf(completion), /Duration: 29s/);
  assert.match(textOf(completion), /Cost: \$0\.32/);
  await second.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo", secondEntries),
  );
  const firstExperience = first.experienceStore.records[0]!.experience;
  const secondExperience = second.experienceStore.records[0]!.experience;
  assert.deepEqual(firstExperience.metrics, { durationMs: 12_000, cost: 0.11 });
  assert.deepEqual(secondExperience.metrics, { durationMs: 17_000, cost: 0.21 });
});

test("automatic rollover keeps one independent schema-v4 Experience per Run", async () => {
  const experienceStore = new ExtensionTestExperienceStore();
  const continuityStore = new ExtensionTestContinuityStore();
  const taskMetrics = new TaskMetricsTracker();
  const promotedCandidate = trialCandidate("00000000-0000-4000-8000-000000000031");
  const promotedDecision = createStrategyRevisionDecision({
    candidate: promotedCandidate,
    decision: "promoted",
    trialRecordIds: [],
    decidedAt: "2026-09-04T00:00:00.000Z",
  });
  const decisions = testDecisionStore([promotedDecision]);
  const candidateReader = {
    read: async (_root: string, candidateId: string) =>
      candidateId === promotedCandidate.candidateId ? promotedCandidate : null,
    readAll: async () => [promotedCandidate],
  };
  const sharedOptions = {
    enableTaskHandoff: true,
    experienceStore,
    continuityStore,
    taskMetrics,
    strategyCandidateReader: candidateReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  };
  const firstClock = new DeterministicRunClock();
  const firstEntries: unknown[] = [];
  const first = createHarness([ ["/repo", activeState("Long Task accounting")] ], {}, {
    ...sharedOptions,
    runTimer: firstClock.timer,
  });

  await startSession(first, "/repo", "startup", firstEntries);
  await beginAgentRun(first, "/repo", firstEntries);
  await executeSemanticTool(first, "pindie_policy_set", "run-a-policy", {
    approach: "architecture-first",
  });
  firstClock.now = 12_000;
  firstEntries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.11 } } } });
  await captureObservationEvidence(first, "run-a-observation");
  await executeSemanticTool(first, "pindie_task_handoff", "run-a-handoff", handoffInput());
  await first.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", firstEntries));

  assert.equal(experienceStore.records.length, 1);
  assert.equal(continuityStore.records.length, 1);
  const firstExperience = experienceStore.records[0]!.experience;
  const firstBeforeContinuation = structuredClone(firstExperience);
  assert.equal(firstExperience.policy.finalSnapshot?.approach.revisionStatusAtRun, "seed");
  assert.equal(firstExperience.policy.finalPolicyDeclarationCount, 1);
  assert.equal(firstExperience.metrics.durationMs, 12_000);
  assert.equal(firstExperience.metrics.cost, 0.11);
  const firstEvaluation = evaluateRunExperience({ recordId: "run-a.json", experience: firstExperience });
  assert.equal(firstEvaluation.attributionEligible, true);
  assert.equal(firstEvaluation.policy.finalPolicyExposureCalls, firstExperience.execution.toolCalls);

  // A duplicate settlement notification cannot create a second record.
  await first.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", firstEntries));
  assert.equal(experienceStore.records.length, 1);

  const binding = taskContractFingerprint(first.integration.runtime.state.task!);
  assert.equal(taskMetrics.prepareAutomaticRollover("remote-session", binding), true);
  taskMetrics.cancelAutomaticRollover();
  // A cancelled replacement has no fresh Run to settle and cannot add a record.
  assert.equal(experienceStore.records.length, 1);
  assert.equal(taskMetrics.prepareAutomaticRollover("remote-session", binding), true);
  await first.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo", firstEntries),
  );

  const secondClock = new DeterministicRunClock();
  const secondEntries: unknown[] = [];
  const second = createHarness([ ["/repo", activeState("Long Task accounting")] ], {}, {
    ...sharedOptions,
    runTimer: secondClock.timer,
  });
  await second.api.handler("session_start")(
    { type: "session_start", reason: "new" },
    context("/repo", secondEntries, false, "session-b"),
  );
  assert.equal(taskMetrics.currentRunBelongsToTask, false);

  // The Host's hidden resume starts a fresh Run, but the runtime message alone
  // has no execution and therefore cannot fabricate another Experience record.
  await second.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "<PINDIE_LONG_TASK_RESUME>not user intent</PINDIE_LONG_TASK_RESUME>", systemPrompt: "", systemPromptOptions: {} },
    context("/repo", secondEntries, false, "session-b"),
  );
  await second.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo", secondEntries, false, "session-b"),
  );
  assert.equal(experienceStore.records.length, 1);

  await second.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Continue the actual Task work.", systemPrompt: "", systemPromptOptions: {} },
    context("/repo", secondEntries, false, "session-b"),
  );
  const promotedSelector = {
    strategyId: promotedCandidate.target.strategyId,
    revisionIdentity: promotedCandidate.candidateId,
    revisionFingerprint: strategyCandidateSemanticFingerprint(promotedCandidate),
  };
  await executeSemanticTool(second, "pindie_policy_set", "run-b-policy", {
    approach: promotedSelector,
  });
  secondClock.now = 17_000;
  secondEntries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.21 } } } });
  const secondObservation = await captureObservationEvidence(second, "run-b-observation");
  await executeSemanticTool(second, "pindie_verification_record", "run-b-verification", {
    check: {
      name: "continuation accounting",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [secondObservation.ref],
    },
  });
  const completion = await executeSemanticTool(second, "pindie_task_complete", "run-b-complete", {
    summary: "Completed in the continuation Run.",
  });
  assert.match(textOf(completion.executionResult), /Duration: 29s/);
  assert.match(textOf(completion.executionResult), /Cost: \$0\.32/);
  assert.deepEqual(taskMetrics.snapshot({ durationMs: 99_000, cost: 9 }), {
    durationMs: 29_000,
    cost: 0.32,
  });
  await second.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo", secondEntries, false, "session-b"),
  );

  assert.equal(experienceStore.records.length, 2);
  assert.deepEqual(firstExperience, firstBeforeContinuation);
  const secondExperience = experienceStore.records[1]!.experience;
  assert.deepEqual(secondExperience.metrics, { durationMs: 17_000, cost: 0.21 });
  assert.equal(secondExperience.policy.finalSnapshot?.approach.revisionIdentity, promotedCandidate.candidateId);
  assert.equal(secondExperience.policy.finalSnapshot?.approach.revisionStatusAtRun, "promoted");
  assert.equal(secondExperience.policy.finalPolicyDeclarationCount, 1);
  assert.equal(secondExperience.policy.finalPolicyLastDeclaredAfter?.toolCalls, 0);
  const secondEvaluation = evaluateRunExperience({ recordId: "run-b.json", experience: secondExperience });
  assert.equal(secondEvaluation.attributionEligible, true);
  assert.equal(secondEvaluation.policy.finalPolicyExposureCalls, secondExperience.execution.toolCalls);
  assert.equal(secondExperience.outcome.completionRelation, "completed_during_run");
  assert.equal(firstExperience.outcome.taskStatus, "active");
});

test("Trial attribution ends at the outgoing Run and is not inherited by a fresh Session", async () => {
  const candidate = trialCandidate("00000000-0000-4000-8000-000000000032");
  const experienceStore = new ExtensionTestExperienceStore();
  const taskMetrics = new TaskMetricsTracker();
  const candidateReader = {
    read: async (_root: string, candidateId: string) =>
      candidateId === candidate.candidateId ? candidate : null,
  };
  const firstClock = new DeterministicRunClock();
  const firstEntries: unknown[] = [];
  const first = createHarness([ ["/repo", activeState("Trial rollover accounting")] ], {}, {
    experienceStore,
    taskMetrics,
    strategyCandidateReader: candidateReader,
    runTimer: firstClock.timer,
  });
  await startSession(first, "/repo", "startup", firstEntries);
  await first.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(first, "/repo", firstEntries);
  assert.equal(first.integration.trial.hasActiveTrial, true);
  assert.equal(taskMetrics.currentRunBelongsToTask, false);
  const trialSelection = first.integration.trial.activeTrial!.revisionSelection;
  await executeSemanticTool(first, "pindie_policy_set", "trial-policy", {
    approach: {
      strategyId: trialSelection.strategyId,
      revisionIdentity: trialSelection.revisionIdentity,
      revisionFingerprint: trialSelection.revisionFingerprint,
    },
  });
  firstClock.now = 12_000;
  firstEntries.push({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.11 } } } });
  await captureObservationEvidence(first, "trial-observation");
  await first.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", firstEntries));

  assert.equal(first.integration.trial.hasTrial, false);
  assert.equal(experienceStore.records.length, 1);
  const trialExperience = experienceStore.records[0]!.experience;
  assert.equal(trialExperience.policy.finalSnapshot?.approach.revisionStatusAtRun, "trial");
  assert.equal(taskMetrics.prepareAutomaticRollover("remote-session", taskContractFingerprint(first.integration.runtime.state.task!)), false);
  const trialBeforeReplacement = structuredClone(trialExperience);
  await first.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo", firstEntries),
  );

  const secondClock = new DeterministicRunClock();
  const secondEntries: unknown[] = [];
  const second = createHarness([ ["/repo", activeState("Trial rollover accounting")] ], {}, {
    experienceStore,
    taskMetrics,
    strategyCandidateReader: candidateReader,
    runTimer: secondClock.timer,
  });
  await second.api.handler("session_start")(
    { type: "session_start", reason: "new" },
    context("/repo", secondEntries, false, "session-b"),
  );
  assert.equal(second.integration.trial.hasTrial, false);
  await second.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Fresh automatic Session Run", systemPrompt: "", systemPromptOptions: {} },
    context("/repo", secondEntries, false, "session-b"),
  );
  assert.equal(taskMetrics.currentRunBelongsToTask, true);
  await assert.rejects(
    second.api.tool("pindie_policy_set").execute(
      "inherited-trial-policy",
      {
        approach: {
          strategyId: trialSelection.strategyId,
          revisionIdentity: trialSelection.revisionIdentity,
          revisionFingerprint: trialSelection.revisionFingerprint,
        },
      },
      undefined,
      undefined,
      context("/repo", secondEntries, false, "session-b"),
    ),
    /without an active Candidate Trial/i,
  );
  await captureObservationEvidence(second, "fresh-session-observation");
  await second.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo", secondEntries, false, "session-b"),
  );

  assert.equal(experienceStore.records.length, 2);
  assert.deepEqual(trialExperience, trialBeforeReplacement);
  assert.equal(experienceStore.records[1]!.experience.policy.finalSnapshot, null);
  assert.equal(second.integration.trial.hasTrial, false);
});

test("agent_settled ignores only an obsolete stale ExtensionContext after replacement", async () => {
  const oldHarness = createHarness([["/old", activeState("Old session")]]);
  const newHarness = createHarness([["/new", activeState("Current session")]]);
  const oldEntries: unknown[] = [{
    type: "message",
    message: { role: "assistant", usage: { cost: { total: 1 } } },
  }];
  const currentEntries: unknown[] = [{
    type: "message",
    message: { role: "assistant", usage: { cost: { total: 3 } } },
  }];

  await startSession(oldHarness, "/old", "startup", oldEntries);
  await beginAgentRun(oldHarness, "/old", oldEntries);
  await oldHarness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/old", oldEntries),
  );
  await startSession(newHarness, "/new", "reload", currentEntries);
  await beginAgentRun(newHarness, "/new", currentEntries);

  const staleContext = {
    get sessionManager(): never {
      throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().");
    },
  };
  await assert.doesNotReject(async () => oldHarness.api.handler("agent_settled")(
    { type: "agent_settled" },
    staleContext,
  ));

  assert.equal(oldHarness.integration.runActivity.activity, null);
  assert.equal(oldHarness.integration.runTimer.durationMs, null);
  assert.equal(oldHarness.integration.runCost.snapshot(oldEntries as any), null);
  assert.equal(newHarness.integration.runActivity.activity, "thinking");
  assert.equal(newHarness.integration.runTimer.active, true);
  assert.deepEqual(newHarness.integration.runCost.snapshot(currentEntries as any), {
    cost: 0,
    active: true,
  });
});

test("agent_settled rethrows errors other than Pi's stale ExtensionContext error", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const failure = new Error("session entries failed");

  await assert.rejects(
    async () => harness.api.handler("agent_settled")(
      { type: "agent_settled" },
      { sessionManager: { getEntries: () => { throw failure; } } },
    ),
    failure,
  );
});

test("Current Activity refreshes status from public tool execution lifecycle and clears on settlement", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.equal(harness.integration.runActivity.activity, "thinking");
  assert.match(statuses.at(-1)?.text ?? "", /\$0.000 • manual • thinking • active • verify 0\/1/);

  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read-a", "read"),
    uiContext,
  );
  assert.equal(harness.integration.runActivity.activity, "reading");
  assert.match(statuses.at(-1)?.text ?? "", /• reading •/);

  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "edit-b", "edit"),
    uiContext,
  );
  assert.equal(harness.integration.runActivity.activity, "working");
  assert.match(statuses.at(-1)?.text ?? "", /• working •/);

  await harness.api.handler("tool_execution_end")(
    toolExecution("tool_execution_end", "edit-b", "edit"),
    uiContext,
  );
  assert.equal(harness.integration.runActivity.activity, "reading");

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.equal(harness.integration.runActivity.activity, null);
  assert.doesNotMatch(statuses.at(-1)?.text ?? "", /thinking|reading|editing|running|updating|working/);
});

test("RA-E01 and RA-E02 final activity schedules one expiry refresh back to thinking", async () => {
  let time = 0;
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const harness = createHarness([['/repo', activeState()]], {}, {
    now: () => time,
    scheduleActivityRefresh: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearActivityRefresh: (timer) => {
      (timer as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read", "read"), uiContext,
  );
  await harness.api.handler("tool_execution_end")(
    toolExecution("tool_execution_end", "read", "read"), uiContext,
  );

  assert.equal(harness.integration.runActivity.activity, "reading");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 250);
  assert.match(statuses.at(-1)?.text ?? "", /reading/);

  time += 250;
  timers[0].callback();
  assert.equal(harness.integration.runActivity.activity, "thinking");
  assert.match(statuses.at(-1)?.text ?? "", /thinking/);
  assert.deepEqual(harness.store.saves, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);
});

test("RA-E03 a new real tool supersedes an obsolete linger callback", async () => {
  let time = 0;
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const harness = createHarness([['/repo', activeState()]], {}, {
    now: () => time,
    scheduleActivityRefresh: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearActivityRefresh: (timer) => {
      (timer as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} }, uiContext);
  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "read", "read"), uiContext);
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "read", "read"), uiContext);
  const oldTimer = timers[0];

  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "edit", "edit"), uiContext);
  assert.equal(oldTimer.cancelled, true);
  assert.equal(harness.integration.runActivity.activity, "editing");
  time += 250;
  oldTimer.callback();
  assert.equal(harness.integration.runActivity.activity, "editing");
  assert.match(statuses.at(-1)?.text ?? "", /editing/);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "done" }, uiContext);
});

test("RA-E04 settlement cancels linger presentation", async () => {
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const harness = createHarness([['/repo', activeState()]], {}, {
    scheduleActivityRefresh: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearActivityRefresh: (timer) => { (timer as unknown as { cancelled: boolean }).cancelled = true; },
  });
  const uiContext = interactiveContext("/repo", []);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} }, uiContext);
  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "read", "read"), uiContext);
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "read", "read"), uiContext);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);

  assert.equal(timers[0].cancelled, true);
  assert.equal(harness.integration.runActivity.activity, null);
});

test("RA-E05 session replacement prevents an old linger callback from changing new presentation", async () => {
  let time = 0;
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const harness = createHarness([['/repo', activeState()]], {}, {
    now: () => time,
    scheduleActivityRefresh: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearActivityRefresh: (timer) => { (timer as unknown as { cancelled: boolean }).cancelled = true; },
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} }, uiContext);
  await harness.api.handler("tool_execution_start")(toolExecution("tool_execution_start", "read", "read"), uiContext);
  await harness.api.handler("tool_execution_end")(toolExecution("tool_execution_end", "read", "read"), uiContext);
  const oldTimer = timers[0];

  await harness.api.handler("session_start")({ type: "session_start", reason: "replacement" }, uiContext);
  await harness.api.handler("before_agent_start")({ type: "before_agent_start", prompt: "", systemPrompt: "", systemPromptOptions: {} }, uiContext);
  assert.equal(oldTimer.cancelled, true);
  time += 250;
  oldTimer.callback();
  assert.equal(harness.integration.runActivity.activity, "thinking");
  assert.match(statuses.at(-1)?.text ?? "", /thinking/);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "done" }, uiContext);
});

test("unified Pindie status publishes active and final timing, then clears on shutdown", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);

  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "task 0s • $0.000 • manual • thinking • active • verify 0/1",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "task 0s • $0.000 • manual • active • verify 0/1",
  });

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), { id: "pindie-status", text: undefined });
  assert.deepEqual([...new Set(statuses.map(({ id }) => id))], ["pindie-status"]);
});

test("semantic State transitions refresh the one Pindie status entry", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );

  const { ref: statusEvidenceRef } = await captureObservationEvidence(
    harness,
    "status-evidence",
  );
  await harness.api.tool("pindie_verification_record").execute("verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [statusEvidenceRef],
    },
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "task 0s • $0.000 • manual • thinking • active • ✓ 1/1",
  });

  await harness.api.tool("pindie_gate_open").execute("gate", {
    kind: "approval",
    question: "Approve release?",
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "task 0s • $0.000 • manual • thinking • ✓ 1/1 • ⚠ gate: approval",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
});

test("SIR-E01 through SIR-E06 status follows the real idle-to-done lifecycle", async () => {
  let time = 0;
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  const harness = createHarness([], {}, {
    now: () => time,
    scheduleActivityRefresh: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearActivityRefresh: (timer) => {
      (timer as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  const status = () => statuses.at(-1)?.text ?? "";

  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, uiContext);
  assert.match(status(), /idle/);
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Start", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  await harness.api.tool("pindie_task_start").execute("start", {
    goal: "Freeze status integration",
    successCriteria: ["Status lifecycle is covered"],
  });
  assert.match(status(), /active • verify 0\/1/);

  await harness.api.handler("tool_execution_start")(
    toolExecution("tool_execution_start", "read", "read"), uiContext,
  );
  assert.match(status(), /reading • active • verify 0\/1/);
  await harness.api.handler("tool_execution_end")(
    toolExecution("tool_execution_end", "read", "read"), uiContext,
  );
  assert.match(status(), /reading • active • verify 0\/1/);
  time += 250;
  timers[0].callback();
  assert.match(status(), /thinking • active • verify 0\/1/);

  const { ref: lifecycleEvidenceRef } = await captureObservationEvidence(
    harness,
    "lifecycle-evidence",
  );
  await harness.api.tool("pindie_verification_record").execute("verify", {
    check: {
      name: "status",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [lifecycleEvidenceRef],
    },
  });
  assert.match(status(), /active • ✓ 1\/1/);
  assert.doesNotMatch(status(), /done/);

  await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Status lifecycle covered.",
  });
  assert.match(status(), /done • ✓ 1\/1/);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);
  assert.match(status(), /done • ✓ 1\/1/);
  assert.doesNotMatch(status(), /thinking|reading|editing|running|updating|working/);
});

test("State and Gate commits survive a status presentation failure", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses, true);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    uiContext,
  );

  const { ref: presentationEvidenceRef } = await captureObservationEvidence(
    harness,
    "presentation-evidence",
  );
  const verification = await harness.api.tool("pindie_verification_record").execute("verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [presentationEvidenceRef],
    },
  });
  const gate = await harness.api.tool("pindie_gate_open").execute("gate", {
    kind: "approval",
    question: "Approve release?",
  });

  assert.match(textOf(verification), /Verification check 'tests' recorded/);
  assert.equal(gate.terminate, true);
  assert.equal(harness.integration.runtime.state.task?.verification.checks[0]?.name, "tests");
  assert.equal(harness.integration.runtime.state.task?.humanGate?.kind, "approval");
  assert.equal(harness.store.states.get("/repo")?.task?.verification.checks[0]?.name, "tests");
  assert.equal(harness.store.states.get("/repo")?.task?.humanGate?.kind, "approval");
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
});

test("T49 agent_settled never auto-completes a verified task", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.completed, false);
  assert.deepEqual(harness.store.saves, []);
});

test("T50 terminal completion blocks mutation", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const result = await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Completed the verified task.",
  });

  assert.equal(result.terminate, true);
  assert.match(textOf(result), /Duration: 0s/);
  assert.match(textOf(result), /Cost: \$0\.000/);
  assert.equal(harness.integration.runTimer.active, true);
  assert.equal(harness.integration.runtime.state.task?.completed, true);
  assert.equal(harness.store.states.get("/repo")?.task?.completed, true);
  assertBlocked(await callGuard(harness, toolCall("edit")), /project\.mutate.*Task status: done/i);
  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_start"),
    ),
    /task\.start.*Task status: done/i,
  );

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  assert.equal(harness.integration.runTimer.active, false);
  assert.notEqual(harness.integration.runTimer.durationMs, null);
});

test("TB18-TB28 replacement is limited to the untouched unfinished Task at Agent Run start", async () => {
  const replacement = { goal: "Task B", successCriteria: ["Task B works"] };

  for (const initial of [activeState(), { task: { ...activeState().task!, openLoops: { blockers: ["Blocked"], questions: [], nextIntent: null } } }, gatedState()]) {
    const harness = createHarness([["/repo", initial]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    assert.equal(await callGuard(harness, toolCall("pindie_task_replace", replacement)), undefined);
    await harness.api.tool("pindie_task_replace").execute("replace", replacement);
    assert.equal(harness.integration.runtime.state.task?.goal, "Task B");
    assert.equal(harness.integration.runtime.state.task?.humanGate, null);
    assert.equal(await callGuard(harness, toolCall("edit")), undefined);
    assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
      goal: "Task C", successCriteria: ["Task C works"],
    })), /missing capability 'task\.replace'/i);
  }
});

test("SSA-E01 through SSA-E03 stale presentation follows active Run coherence only", async () => {
  const initial = activeState("Task A");
  const harness = createHarness([["/repo", initial]]);
  const statuses: Array<{ id: string; text: string | undefined }> = [];
  const uiContext = interactiveContext("/repo", statuses);
  await startSession(harness, "/repo");
  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Continue", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  const external = activeState("Task B");
  harness.store.states.set("/repo", external);

  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is stale.*project\.mutate/i);
  assert.match(statuses.at(-1)?.text ?? "", /active • verify 0\/1 • ⚠ stale run/);
  assert.deepEqual(harness.integration.runtime.state, external);
  assert.deepEqual(harness.store.saves, []);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);
  assert.doesNotMatch(statuses.at(-1)?.text ?? "", /⚠ stale run/);

  await harness.api.handler("before_agent_start")(
    { type: "before_agent_start", prompt: "Next", systemPrompt: "", systemPromptOptions: {} },
    uiContext,
  );
  assert.doesNotMatch(statuses.at(-1)?.text ?? "", /⚠ stale run/);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, uiContext);
});

test("PSC-A01-A07 run-start refresh snapshots authority and stale Runs are read-only until next user Run", async () => {
  const initial = activeState("Task A");
  const harness = createHarness([["/repo", initial]]);
  await startSession(harness, "/repo");
  // Session cache is A; disk authority changes before the new Run starts.
  harness.store.states.set("/repo", activeState("Task B"));
  await beginAgentRun(harness);
  assert.equal(harness.integration.runtime.state.task?.goal, "Task B");
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);
  // Change authority during this Run. The first consequential preflight adopts it
  // and blocks; every retry remains blocked even though refresh is now equal.
  harness.store.states.set("/repo", activeState("Task C"));
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is stale.*project\.mutate/i);
  assert.equal(harness.integration.runtime.state.task?.goal, "Task C");
  for (const [name, input] of [
    ["write", {}], ["bash", {}],
    ["pindie_task_refine", {}],
    ["pindie_gate_open", {}], ["unknown", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    assertBlocked(await callGuard(harness, toolCall(name, input)), /authority is stale.*missing capability/i);
  }
  for (const name of ["read", "grep", "find", "ls", "pindie_git_observe"]) {
    assert.equal(await callGuard(harness, toolCall(name, name === "pindie_git_observe" ? { action: "status" } : {})), undefined);
  }
  const stateBeforeObserve = structuredClone(harness.integration.runtime.state);
  const epochBeforeObserve = harness.integration.runtime.externalStateEpoch;
  assert.equal(await callGuard(harness, toolCall("pindie_git_observe", { action: "diff" })), undefined);
  assert.deepEqual(harness.integration.runtime.state, stateBeforeObserve);
  assert.equal(harness.integration.runtime.externalStateEpoch, epochBeforeObserve);
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is stale.*project\.mutate/i);
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);
});

test("PSC-A08-A09 stale Run suppresses continuation and equal refresh preserves replacement identity", async () => {
  const harness = createHarness([["/repo", activeState("Task A")]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  harness.store.states.set("/repo", structuredClone(harness.integration.runtime.state));
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);
  assert.equal(await callGuard(harness, toolCall("pindie_task_replace", {
    goal: "Task B", successCriteria: ["Works"],
  })), undefined);
  harness.store.states.set("/repo", activeState("External"));
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is stale.*project\.mutate/i);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
});

test("TB21-TB25 same-run task creation or semantic mutation consumes replacement eligibility", async () => {
  const created = createHarness();
  await startSession(created, "/repo");
  await beginAgentRun(created);
  await created.api.tool("pindie_task_start").execute("start", {
    goal: "Task A", successCriteria: ["Task A works"],
  });
  assertBlocked(await callGuard(created, toolCall("pindie_task_replace", {
    goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'/i);

  for (const mutate of [
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_task_refine").execute("refine", { goal: "Refined A" }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_task_progress").execute("loops", { blockers: [], questions: ["Question"] }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_gate_open").execute("gate", { kind: "input", question: "Input?" }),
    async (harness: ReturnType<typeof createHarness>) => {
      assert.equal(await callGuard(harness, toolCall("edit")), undefined);
      await harness.api.handler("tool_result")(toolResult("edit"), context("/repo"));
    },
  ]) {
    const harness = createHarness([["/repo", activeState()]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    await mutate(harness);
    assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
      goal: "Task B", successCriteria: ["Task B works"],
    })), /missing capability 'task\.replace'/i);
  }
});

test("TB25 resolving a run-start Human Gate also consumes replacement eligibility", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.tool("pindie_gate_resolve").execute("resolve", {});
  assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
    goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'/i);
});

test("TB26-TB27 completed Task start boundaries do not make a same-run Task replaceable", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
    goal: "Task B", successCriteria: ["Task B works"],
  })), /completed Task is terminal.*pindie_task_start.*Task status: done/i);
  assert.equal(await callGuard(harness, toolCall("pindie_task_start", {
    goal: "Task B", successCriteria: ["Task B works"],
  })), undefined);
  await harness.api.tool("pindie_task_start").execute("start", {
    goal: "Task B", successCriteria: ["Task B works"],
  });
  assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
    goal: "Task C", successCriteria: ["Task C works"],
  })), /missing capability 'task\.replace'/i);
});

test("RG01 a gate opened during the run blocks same-run refinement", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate_open").execute("open", {
    kind: "decision",
    question: "Which release strategy should we use?",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_refine", { goal: "Refined" }),
    ),
    /missing capability 'task\.refine'.*waiting_human/i,
  );
});

test("RG02 a gate opened during the run blocks same-run resolution", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate_open").execute("open", {
    kind: "decision",
    question: "Which release strategy should we use?",
  });

  assertBlocked(
    await callGuard(harness, toolCall("pindie_gate_resolve")),
    /missing capability 'gate\.resolve'.*waiting_human/i,
  );
});

test("RG03 a gate present at run start permits task refinement", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(
      harness,
      toolCall("pindie_task_refine", { goal: "Refined" }),
    ),
    undefined,
  );
});

test("RG04 a gate present at run start permits gate resolution", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(harness, toolCall("pindie_gate_resolve")),
    undefined,
  );
});

test("RG05 resolving Gate A then opening Gate B does not consume Gate B in the same run", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate_resolve").execute("resolve-a", {});
  await harness.api.tool("pindie_gate_open").execute("open-b", {
    kind: "approval",
    question: "Approve the release?",
  });

  assertBlocked(
    await callGuard(harness, toolCall("pindie_gate_resolve")),
    /missing capability 'gate\.resolve'.*waiting_human/i,
  );
  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_refine", { goal: "Approved" }),
    ),
    /missing capability 'task\.refine'.*waiting_human/i,
  );
});

test("RC01 a task completed during the run blocks same-run replacement", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Completed the verified task.",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_start"),
    ),
    /missing capability 'task\.start'.*Task status: done/i,
  );
});

test("RC02 a task completed during the run blocks same-run mutation", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Completed the verified task.",
  });

  for (const name of ["edit", "write", "bash"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /project\.mutate.*Task status: done/i);
  }
});

test("RC03 a completed task present at run start permits one replacement", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(
      harness,
      toolCall("pindie_task_start"),
    ),
    undefined,
  );
});

test("TBE-E01-E20 idle State preserves observation and start_task guard ordering", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const loadsBeforeObservation = harness.store.loads.length;
  for (const name of ["read", "grep", "find", "ls", "pindie_git_observe"]) {
    assert.equal(await callGuard(harness, toolCall(name, name === "pindie_git_observe" ? { action: "status" } : {})), undefined);
  }
  assert.equal(harness.store.loads.length, loadsBeforeObservation);
  assert.equal(harness.integration.runtime.state.task, null);
  assert.deepEqual(harness.store.saves, []);

  assert.equal(await callGuard(harness, toolCall("pindie_task_start")), undefined);
  assertBlocked(
    await callGuard(harness, toolCall("pindie_task_replace")),
    /no unfinished Task to replace.*pindie_task_start.*Task status: idle/i,
  );
  for (const [name, input] of [
    ["edit", {}], ["write", {}], ["bash", { command: "git status" }], ["future_mutating_tool", {}],
    ["pindie_task_refine", {}],
    ["pindie_task_progress", {}],
    ["pindie_verification_record", {}],
    ["pindie_task_complete", {}],
    ["pindie_gate_open", {}],
    ["pindie_gate_resolve", {}],
  ] as Array<[string, Record<string, unknown>]>) {
    assertBlocked(await callGuard(harness, toolCall(name, input)), /missing capability.*Task status: idle/i);
  }

  await harness.api.tool("pindie_task_start").execute("start", {
    goal: "Task A", successCriteria: ["Task A works"],
  });
  assert.equal(harness.integration.runtime.state.task?.goal, "Task A");
  for (const name of ["edit", "write", "bash", "future_mutating_tool"]) {
    assert.equal(await callGuard(harness, toolCall(name)), undefined);
  }
  assertBlocked(await callGuard(harness, toolCall("pindie_task_replace", {
    goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'/i);
  assert.equal((await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"))).continue, true);
  assert.deepEqual(harness.api.sentMessages, []);
});

test("Task replace denial gives actionable start recovery only for idle or completed Tasks", async () => {
  const cases = [
    ["idle", EMPTY_STATE, /no unfinished Task to replace.*pindie_task_start.*Task status: idle/i],
    ["completed", completedState(), /completed Task is terminal.*pindie_task_start.*Task status: done/i],
  ] as const;

  for (const [name, state, expected] of cases) {
    const harness = createHarness([["/repo", state]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const stateBefore = structuredClone(harness.integration.runtime.state);
    const denied = await callGuard(harness, toolCall("pindie_task_replace"));

    assertBlocked(denied, expected);
    assert.doesNotMatch(denied.reason, /missing capability 'task\.replace'/i);
    assert.deepEqual(harness.integration.runtime.state, stateBefore, name);
    assert.deepEqual(harness.store.saves, [], name);
  }

  const project = createHarness([["/repo", completedState()]]);
  await startSession(project, "/repo");
  await beginAgentRun(project);
  const projectDenied = await callGuard(project, toolCall("edit"));
  assertBlocked(projectDenied, /missing capability 'project\.mutate'.*Task status: done/i);
  assert.doesNotMatch(projectDenied.reason, /pindie_task_start/i);

  const verification = createHarness([["/repo", gatedState()]]);
  await startSession(verification, "/repo");
  await beginAgentRun(verification);
  const verificationDenied = await callGuard(
    verification,
    toolCall("pindie_verification_record"),
  );
  assertBlocked(verificationDenied, /missing capability 'verification\.record'.*waiting_human/i);
  assert.doesNotMatch(verificationDenied.reason, /pindie_task_start/i);
});

test("OC-E01-OC-E08 guards preserve direct observation and report factual capability denials", async () => {
  for (const [name, state] of [["idle", EMPTY_STATE], ["completed", completedState()]] as const) {
    const harness = createHarness([["/repo", state]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const stateBefore = structuredClone(harness.integration.runtime.state);

    for (const toolName of ["read", "grep", "find", "ls", "pindie_git_observe"]) {
      assert.equal(await callGuard(harness, toolCall(
        toolName,
        toolName === "pindie_git_observe" ? { action: "status" } : {},
      )), undefined, `${name}: ${toolName}`);
    }
    for (const command of ["find .", "git status", "cat package.json"]) {
      const result = await callGuard(harness, toolCall("bash", { command }, `${name}-${command}`));
      assertBlocked(result, /missing capability 'project\.mutate'/i);
      assert.match(result.reason, new RegExp(`Task status: ${name === "idle" ? "idle" : "done"}`, "i"));
      assert.doesNotMatch(result.reason, /pindie_state\(|unrestricted bash/i);
    }
    assert.deepEqual(harness.integration.runtime.state, stateBefore);
    assert.deepEqual(harness.store.saves, []);
  }

  const unknown = createHarness();
  await startSession(unknown, "/repo");
  await beginAgentRun(unknown);
  assertBlocked(await callGuard(unknown, toolCall("future_consequential_tool")), /project\.mutate.*Task status: idle/i);
});

test("TBE-E12-E14 coherence and State unavailability outrank idle task admission", async () => {
  const changed = createHarness();
  await startSession(changed, "/repo");
  await beginAgentRun(changed);
  changed.store.states.set("/repo", activeState("Task B"));
  assertBlocked(await callGuard(changed, toolCall("edit")), /authority is stale.*project\.mutate/i);
  assert.equal(changed.integration.runtime.state.task?.goal, "Task B");

  const staleIdle = createHarness([["/repo", activeState()]]);
  await startSession(staleIdle, "/repo");
  await beginAgentRun(staleIdle);
  staleIdle.store.states.set("/repo", EMPTY_STATE);
  assertBlocked(await callGuard(staleIdle, toolCall("pindie_task_start")), /authority is stale.*task\.start/i);

  const unavailable = createHarness();
  unavailable.store.loadErrors.set("/repo", new Error("State cannot be loaded"));
  await startSession(unavailable, "/repo");
  assertBlocked(await callGuard(unavailable, toolCall("pindie_task_start")), /authority is unavailable.*task\.start/i);
});

test("RC04 replacing Task A then completing Task B does not permit Task C in the same run", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_task_start").execute("start-b", {
    goal: "Task B",
    successCriteria: ["Task B works"],
  });
  const { ref: replacementEvidenceRef } = await captureObservationEvidence(
    harness,
    "replacement-evidence",
  );
  await harness.api.tool("pindie_verification_record").execute("verify-b", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [replacementEvidenceRef],
    },
  });
  await harness.api.tool("pindie_task_complete").execute("complete-b", {
    summary: "Completed Task B.",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_start"),
    ),
    /missing capability 'task\.start'.*Task status: done/i,
  );
});

test("G01-G08 M2 Task admission and replacement follow Run-derived capabilities", async () => {
  const idle = createHarness();
  await startSession(idle, "/repo");
  await beginAgentRun(idle);
  assertBlocked(await callGuard(idle, toolCall("edit")), /project\.mutate.*Task status: idle/i);

  const startInput = { goal: "Task A", successCriteria: ["Task A works"] };
  assert.equal(await callGuard(idle, toolCall("pindie_task_start", startInput, "start-a")), undefined);
  await idle.api.tool("pindie_task_start").execute("start-a", startInput);
  await idle.api.handler("tool_result")(toolResult("pindie_task_start", false, "start-a"), context("/repo"));
  assert.equal(await callGuard(idle, toolCall("edit")), undefined);

  const done = createHarness([["/repo", completedState()]]);
  await startSession(done, "/repo");
  await beginAgentRun(done);
  assert.equal(await callGuard(done, toolCall("pindie_task_start")), undefined);
  assertBlocked(
    await callGuard(done, toolCall("pindie_task_replace")),
    /completed Task is terminal.*pindie_task_start.*Task status: done/i,
  );

  const replace = createHarness([["/repo", activeState("Task A")]]);
  await startSession(replace, "/repo");
  await beginAgentRun(replace);
  const replacement = { goal: "Task B", successCriteria: ["Task B works"] };
  assert.equal(await callGuard(replace, toolCall("pindie_task_replace", replacement, "replace-b")), undefined);
  await replace.api.tool("pindie_task_replace").execute("replace-b", replacement);
  await replace.api.handler("tool_result")(toolResult("pindie_task_replace", false, "replace-b"), context("/repo"));
  assertBlocked(
    await callGuard(replace, toolCall("pindie_task_replace", { ...replacement, goal: "Task C" }, "replace-c")),
    /missing capability 'task\.replace'/i,
  );

  const failedReplace = createHarness([["/repo", activeState("Task A")]]);
  await startSession(failedReplace, "/repo");
  await beginAgentRun(failedReplace);
  assert.equal(
    await callGuard(failedReplace, toolCall("pindie_task_replace", replacement, "replace-failed")),
    undefined,
  );
  await failedReplace.api.handler("tool_result")(
    toolResult("pindie_task_replace", true, "replace-failed"),
    context("/repo"),
  );
  assert.equal(
    await callGuard(failedReplace, toolCall("pindie_task_replace", replacement, "replace-retry")),
    undefined,
  );

  const refined = createHarness([["/repo", activeState("Task A")]]);
  await startSession(refined, "/repo");
  await beginAgentRun(refined);
  const refine = { goal: "Refined Task A" };
  assert.equal(await callGuard(refined, toolCall("pindie_task_refine", refine, "refine-a")), undefined);
  await refined.api.tool("pindie_task_refine").execute("refine-a", refine);
  assertBlocked(
    await callGuard(refined, toolCall("pindie_task_replace", replacement, "replace-after-refine")),
    /missing capability 'task\.replace'/i,
  );
});

test("G09-G11 blocked Tasks retain edit, write, bash, and ambiguous mutation calls", async () => {
  let captures = 0;
  const harness = createHarness([["/repo", blockedState()]], {}, {
    captureProjectFingerprint: async () => {
      captures += 1;
      return { kind: "known", digest: "unchanged" };
    },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["edit", "write", "bash", "custom_mutator"]) {
    assert.equal(
      await callGuard(harness, toolCall(name, {}, `blocked-${name}`)),
      undefined,
    );
  }
  assert.equal(captures, 1);
  assert.deepEqual(harness.store.saves, []);
});

test("Blocked Task recovery retains baseline mutation tools but denies completion", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools([
    "read",
    "edit",
    "write",
    "bash",
    "pindie_task_progress",
    "pindie_task_complete",
  ]);
  await beginAgentRun(harness);

  const baselineMutationSurface = ["read", "edit", "write", "bash", "pindie_task_progress", "pindie_task_complete"];
  assert.deepEqual(harness.api.getActiveTools(), baselineMutationSurface);

  await executeSemanticTool(harness, "pindie_task_progress", "record-blocker", {
    blockers: ["Tests currently fail"],
    questions: [],
    nextIntent: "Fix the failing tests and rerun verification.",
  });

  assert.equal(getTaskStatus(harness.integration.runtime.state), "blocked");
  assert.deepEqual(harness.api.getActiveTools(), baselineMutationSurface);
  assert.equal(await callGuard(harness, toolCall("edit", {}, "recovery-edit")), undefined);
  await harness.api.handler("tool_result")(
    toolResult("edit", false, "recovery-edit"),
    context("/repo"),
  );

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_task_complete", { summary: "Complete" }, "blocked-complete"),
    ),
    /missing capability 'task\.complete'.*Task status: blocked/i,
  );
  assert.equal(harness.api.getActiveTools().includes("pindie_task_complete"), true);
});

test("G12-G15 completion is authorized only when the M0 Snapshot is completion-ready", async () => {
  for (const [name, state, verification] of [
    ["pending", activeState(), "pending"],
    ["stale", staleVerificationState(), "stale"],
    ["failed", failedVerificationState(), "failed"],
  ] as const) {
    const harness = createHarness([["/repo", state]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const before = harness.integration.runtime.state;
    assertBlocked(
      await callGuard(harness, toolCall("pindie_task_complete", {}, `complete-${name}`)),
      new RegExp(`missing capability 'task\\.complete'.*Verification: ${verification}`, "i"),
    );
    assert.equal(harness.integration.runtime.state, before);
    assert.deepEqual(harness.store.saves, []);
  }

  const ready = createHarness([["/repo", verifiedState()]]);
  await startSession(ready, "/repo");
  await beginAgentRun(ready);
  const input = { summary: "Verified and complete." };
  assert.equal(await callGuard(ready, toolCall("pindie_task_complete", input, "complete-ready")), undefined);
  await ready.api.tool("pindie_task_complete").execute("complete-ready", input);
  assert.equal(ready.integration.runtime.state.task?.completed, true);
});

test("narrow semantic State and Gate tools never enter Project Mutation Freshness", async () => {
  let captures = 0;
  const harness = createHarness([["/repo", activeState()]], {}, {
    captureProjectFingerprint: async () => {
      captures += 1;
      return { kind: "known", digest: "unchanged" };
    },
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(harness, toolCall("pindie_task_refine", { goal: "Refined" }, "semantic-state")),
    undefined,
  );
  assert.equal(
    await callGuard(harness, toolCall("pindie_gate_open", {
      kind: "input",
      question: "Input?",
    }, "semantic-gate")),
    undefined,
  );
  assert.equal(captures, 0);
});

test("F01 Pindie never mutates Pi's active Tool Surface during semantic transitions", async () => {
  const fingerprints = [
    { kind: "known" as const, digest: "before" },
    { kind: "known" as const, digest: "after" },
  ];
  const harness = createHarness([], {}, {
    captureProjectFingerprint: async () => fingerprints.shift()!,
  });
  await startSession(harness, "/repo");
  const baseline = [
    "read", "edit", "write", "bash", "custom_tool",
    "pindie_task_start", "pindie_task_refine", "pindie_task_progress",
    "pindie_verification_record",
    "pindie_task_complete",
  ];
  harness.api.setActiveTools(baseline);
  const callsBeforeRun = harness.api.setActiveToolsCalls.length;
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), baseline);

  await executeSemanticTool(harness, "pindie_task_start", "surface-start", {
    goal: "Surface stability",
    successCriteria: ["Current tools remain visible"],
  });
  assert.deepEqual(harness.api.getActiveTools(), baseline);

  assert.equal(await callGuard(harness, toolCall("edit", {}, "surface-edit")), undefined);
  const mutationResult = await harness.api.handler("tool_result")(
    toolResult("edit", false, "surface-edit", [{ type: "text", text: "changed" }]),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.match(textOf(mutationResult), /Verification status: stale/);

  const evidence = await captureObservationEvidence(harness, "surface-read");
  await executeSemanticTool(harness, "pindie_verification_record", "surface-verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [evidence.ref],
    },
  });
  assert.equal(await callGuard(harness, toolCall("pindie_task_complete", {
    summary: "Surface stability verified.",
  }, "surface-complete")), undefined);
  assert.deepEqual(harness.api.getActiveTools(), baseline);
  assert.equal(harness.api.setActiveToolsCalls.length, callsBeforeRun);
});

test("F03 semantic State results expose changed eligibility without repeating unchanged affordances", async () => {
  const idle = createHarness();
  await startSession(idle, "/repo");
  await beginAgentRun(idle);
  const started = await executeSemanticTool(idle, "pindie_task_start", "eligibility-start", {
    goal: "Eligibility projection",
    successCriteria: ["Current actions are visible"],
  });
  assert.match(textOf(started.resultPatch as { content: Array<{ type: string; text?: string }> }), /Current Pindie Action Eligibility:/);
  assert.match(textOf(started.resultPatch as { content: Array<{ type: string; text?: string }> }), /- project mutation: allowed/);

  const unchanged = await executeSemanticTool(idle, "pindie_task_refine", "eligibility-refine", {
    goal: "Eligibility projection refined",
  });
  assert.equal(unchanged.resultPatch, undefined);

  const gate = createHarness([["/repo", activeState()]]);
  await startSession(gate, "/repo");
  await beginAgentRun(gate);
  const opened = await executeSemanticTool(gate, "pindie_gate_open", "eligibility-gate", {
    kind: "approval",
    question: "Approve the next action?",
  });
  assert.match(textOf(opened.resultPatch as { content: Array<{ type: string; text?: string }> }), /Current Pindie Action Eligibility:/);
  assert.match(textOf(opened.resultPatch as { content: Array<{ type: string; text?: string }> }), /- project mutation: not eligible/);
});

test("F02 visible unauthorized tools are blocked by the Gateway without execution", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const baseline = ["read", "edit", "pindie_task_complete"];
  harness.api.setActiveTools(baseline);
  await beginAgentRun(harness);

  assert.deepEqual(harness.api.getActiveTools(), baseline);
  assertBlocked(
    await callGuard(harness, toolCall("pindie_task_complete", { summary: "Not ready" })),
    /missing capability 'task\.complete'.*Verification: stale|Verification: pending/i,
  );
  assert.deepEqual(harness.store.saves, []);
});

test("M5 I01-I02/I07/I14/I20 captures factual observations and records Harness evidence end to end", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const longToolCallId =
    "call_FccSunaPr01Ht5kd0YVx8WoB|fc_07cbfcb752e64889016a9021_more-provider-data";
  const successful = await captureObservationEvidence(harness, longToolCallId, {
    input: { path: "src/extension.ts" },
    content: [{ type: "text", text: "current source" }],
  });
  assert.match(successful.ref, /^ev:[A-Za-z0-9_-]+:\d+$/);
  assert.doesNotMatch(successful.ref, /call_FccSuna|fc_07cb|\|/);
  assert.match(textOf(successful.result), /current source/);
  assert.match(textOf(successful.result), /\[Pindie evidence ref: ev:[A-Za-z0-9_-]+:\d+\]/);
  assert.doesNotMatch(textOf(successful.result), /call_FccSuna|fc_07cb|\|/);

  const failed = await captureObservationEvidence(harness, "read-error", {
    isError: true,
    content: [{ type: "text", text: "ENOENT" }],
  });
  assert.notEqual(failed.ref, successful.ref);

  const git = await captureObservationEvidence(harness, "git-observe", {
    toolName: "pindie_git_observe",
    input: { action: "status" },
    content: [{ type: "text", text: "clean" }],
  });
  assert.notEqual(git.ref, failed.ref);

  const verification = await executeSemanticTool(
    harness,
    "pindie_verification_record",
    "verification-record",
    {
      check: {
        name: "source inspection",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: [successful.ref, failed.ref, git.ref],
      },
    },
  );
  assert.match(
    textOf(verification.resultPatch as { content: Array<{ type: string; text?: string }> }),
    /Current Pindie Action Eligibility:[\s\S]*- task complete: allowed/,
  );
  const stored = harness.integration.runtime.state.task?.verification.checks[0];
  assert.equal(stored?.status, "passed");
  assert.deepEqual(stored?.covers, ["c1"]);
  assert.match(stored?.evidence ?? "", /Tool: read\nOutcome: success/);
  assert.match(stored?.evidence ?? "", /Tool: read\nOutcome: error/);
  assert.match(stored?.evidence ?? "", /Tool: pindie_git_observe/);
  assert.doesNotMatch(stored?.evidence ?? "", /ev:|call_FccSuna|fc_07cb|generation/i);
  assert.equal(getVerificationStatus(harness.integration.runtime.state.task!), "passed");

  await harness.api.tool("pindie_verification_record").execute("reuse", {
    check: {
      name: "reused observation",
      status: "passed",
      covers: [],
      evidenceRefs: [successful.ref],
    },
  });
  assert.equal(harness.integration.runtime.state.task?.verification.checks.length, 2);

  const beforeFabricated = structuredClone(harness.integration.runtime.state);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("fabricated", {
      check: {
        name: "fabricated",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: ["ev:not-real"],
      },
    }),
    /Unknown Pindie evidence reference: ev:not-real/,
  );
  assert.deepEqual(harness.integration.runtime.state, beforeFabricated);
});

test("M5 I03-I06 observations outside coherent unfinished work receive no marker", async () => {
  const idle = createHarness();
  await startSession(idle, "/repo");
  await beginAgentRun(idle);
  assert.equal(await callGuard(idle, toolCall("read", {}, "idle-read")), undefined);
  assert.equal(
    await idle.api.handler("tool_result")(toolResult("read", false, "idle-read"), context("/repo")),
    undefined,
  );

  const completed = createHarness([["/repo", completedState()]]);
  await startSession(completed, "/repo");
  await beginAgentRun(completed);
  assert.equal(await callGuard(completed, toolCall("read", {}, "done-read")), undefined);
  assert.equal(
    await completed.api.handler("tool_result")(toolResult("read", false, "done-read"), context("/repo")),
    undefined,
  );

  const stale = createHarness([["/repo", activeState("Original")]]);
  await startSession(stale, "/repo");
  await beginAgentRun(stale);
  stale.store.states.set("/repo", activeState("Externally replaced"));
  assertBlocked(await callGuard(stale, toolCall("edit", {}, "detect-stale")), /authority is stale/);
  assert.equal(await callGuard(stale, toolCall("read", {}, "stale-read")), undefined);
  assert.equal(
    await stale.api.handler("tool_result")(toolResult("read", false, "stale-read"), context("/repo")),
    undefined,
  );

  const unavailable = createHarness();
  unavailable.store.loadErrors.set("/repo", new Error("unavailable"));
  await startSession(unavailable, "/repo");
  await beginAgentRun(unavailable);
  assert.equal(await callGuard(unavailable, toolCall("read", {}, "unavailable-read")), undefined);
  assert.equal(
    await unavailable.api.handler("tool_result")(
      toolResult("read", false, "unavailable-read"),
      context("/repo"),
    ),
    undefined,
  );
});

test("M5 I08-I09 known mutations never become evidence and only successful mutations invalidate", async () => {
  const successful = createHarness([["/repo", verifiedState()]]);
  await startSession(successful, "/repo");
  await beginAgentRun(successful);
  const prior = await captureObservationEvidence(successful, "before-edit");
  assert.equal(await callGuard(successful, toolCall("edit", {}, "edit-success")), undefined);
  const successfulResult = await successful.api.handler("tool_result")(
    toolResult("edit", false, "edit-success", [{ type: "text", text: "edited" }]),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.equal(successfulResult.content[0]?.text, "edited");
  assert.match(textOf(successfulResult), /Verification status: stale/);
  assert.match(textOf(successfulResult), /Fresh factual verification is required/);
  assert.equal(successful.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    successful.api.tool("pindie_verification_record").execute("old-ref", {
      check: { name: "old", status: "passed", covers: ["c1"], evidenceRefs: [prior.ref] },
    }),
    /Stale Pindie evidence reference/,
  );

  const failed = createHarness([["/repo", verifiedState()]]);
  await startSession(failed, "/repo");
  await beginAgentRun(failed);
  const stillCurrent = await captureObservationEvidence(failed, "before-failed-edit");
  assert.equal(await callGuard(failed, toolCall("edit", {}, "edit-failed")), undefined);
  assert.equal(
    await failed.api.handler("tool_result")(
      toolResult("edit", true, "edit-failed", [{ type: "text", text: "rejected" }]),
      context("/repo"),
    ),
    undefined,
  );
  assert.equal(failed.integration.runtime.state.task?.verification.stale, false);
  await failed.api.tool("pindie_verification_record").execute("still-current", {
    check: {
      name: "still current",
      status: "passed",
      covers: [],
      evidenceRefs: [stillCurrent.ref],
    },
  });
});

test("M5 mutation invalidation reports only material verification changes", async () => {
  const pending = createHarness([[
    "/repo",
    activeState(),
  ]]);
  await startSession(pending, "/repo");
  await beginAgentRun(pending);
  assert.equal(await callGuard(pending, toolCall("edit", {}, "pending-edit")), undefined);
  const pendingResult = await pending.api.handler("tool_result")(
    toolResult("edit", false, "pending-edit", [{ type: "text", text: "edited" }]),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.match(textOf(pendingResult), /Verification freshness was invalidated before any current checks were recorded/);
  assert.match(textOf(pendingResult), /Verification status: stale/);

  const alreadyStale = createHarness([["/repo", staleVerificationState()]]);
  await startSession(alreadyStale, "/repo");
  await beginAgentRun(alreadyStale);
  const before = await captureObservationEvidence(alreadyStale, "before-stale-edit");
  assert.equal(await callGuard(alreadyStale, toolCall("edit", {}, "stale-edit")), undefined);
  const result = await alreadyStale.api.handler("tool_result")(
    toolResult("edit", false, "stale-edit", [{ type: "text", text: "edited again" }]),
    context("/repo"),
  );
  assert.equal(result, undefined);
  assert.equal(alreadyStale.integration.runtime.state.task?.verification.stale, true);
  assert.deepEqual(alreadyStale.store.saves, []);

  const after = await captureObservationEvidence(alreadyStale, "after-stale-edit");
  assert.notEqual(after.ref, before.ref);
  await assert.rejects(
    alreadyStale.api.tool("pindie_verification_record").execute("stale-generation", {
      check: {
        name: "old generation",
        status: "passed",
        covers: [],
        evidenceRefs: [before.ref],
      },
    }),
    /Stale Pindie evidence reference/,
  );
  await alreadyStale.api.tool("pindie_verification_record").execute("new-generation", {
    check: {
      name: "new generation",
      status: "passed",
      covers: [],
      evidenceRefs: [after.ref],
    },
  });
  assert.equal(alreadyStale.integration.runtime.state.task?.verification.stale, false);
});

test("M5 I10-I13 ambiguous mutation observation completes before evidence capture", async () => {
  const unchanged = createHarness([["/repo", activeState()]], {}, {
    captureProjectFingerprint: async () => ({ kind: "known", digest: "same" }),
  });
  await startSession(unchanged, "/repo");
  await beginAgentRun(unchanged);
  const bash = await captureObservationEvidence(unchanged, "bash-unchanged", {
    toolName: "bash",
    input: { command: "pnpm test" },
    content: [{ type: "text", text: "tests passed" }],
  });
  assert.match(bash.ref, /^ev:[A-Za-z0-9_-]+:\d+$/);
  const bashError = await captureObservationEvidence(unchanged, "bash-error-unchanged", {
    toolName: "bash",
    input: { command: "invalid-config" },
    content: [{ type: "text", text: "configuration rejected" }],
    isError: true,
  });
  await unchanged.api.tool("pindie_verification_record").execute("error-passes", {
    check: {
      name: "invalid config rejected",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [bashError.ref],
    },
  });
  assert.equal(unchanged.integration.runtime.state.task?.verification.checks[0]?.status, "passed");
  assert.match(
    unchanged.integration.runtime.state.task?.verification.checks[0]?.evidence ?? "",
    /Outcome: error/,
  );

  const changedFingerprints = [
    { kind: "known" as const, digest: "before" },
    { kind: "known" as const, digest: "after" },
  ];
  const changed = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => changedFingerprints.shift()!,
  });
  await startSession(changed, "/repo");
  await beginAgentRun(changed);
  const changedPrior = await captureObservationEvidence(changed, "before-bash-change");
  assert.equal(await callGuard(changed, toolCall("bash", {}, "bash-changed")), undefined);
  const changedResult = await changed.api.handler("tool_result")(
    toolResult("bash", false, "bash-changed", [{ type: "text", text: "mutated" }]),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.equal(changedResult.content[0]?.text, "mutated");
  assert.match(textOf(changedResult), /Project mutation changed authoritative verification state/);
  assert.match(textOf(changedResult), /Verification status: stale/);
  assert.equal(changed.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    changed.api.tool("pindie_verification_record").execute("stale", {
      check: { name: "stale", status: "passed", covers: [], evidenceRefs: [changedPrior.ref] },
    }),
    /Stale Pindie evidence reference/,
  );

  const unknown = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => ({ kind: "unknown", reason: "cannot inspect" }),
  });
  await startSession(unknown, "/repo");
  await beginAgentRun(unknown);
  const unknownPrior = await captureObservationEvidence(unknown, "before-unknown-bash");
  assert.equal(await callGuard(unknown, toolCall("bash", {}, "bash-unknown")), undefined);
  const unknownResult = await unknown.api.handler("tool_result")(
    toolResult("bash", true, "bash-unknown"),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.match(textOf(unknownResult), /Project mutation changed authoritative verification state/);
  assert.equal(unknown.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    unknown.api.tool("pindie_verification_record").execute("stale", {
      check: { name: "stale", status: "passed", covers: [], evidenceRefs: [unknownPrior.ref] },
    }),
    /Stale Pindie evidence reference/,
  );
});

test("M5 I15-I17 successful Task start, replace, and refine invalidate older call generations", async () => {
  const start = createHarness();
  await startSession(start, "/repo");
  await beginAgentRun(start);
  assert.equal(await callGuard(start, toolCall("read", {}, "read-before-start")), undefined);
  await executeSemanticTool(start, "pindie_task_start", "task-start", {
    goal: "New task",
    successCriteria: ["Works"],
  });
  assert.equal(
    await start.api.handler("tool_result")(
      toolResult("read", false, "read-before-start"),
      context("/repo"),
    ),
    undefined,
  );

  const replace = createHarness([["/repo", activeState("Task A")]]);
  await startSession(replace, "/repo");
  await beginAgentRun(replace);
  const beforeReplace = await captureObservationEvidence(
    replace,
    "read-before-replace",
  );
  await executeSemanticTool(replace, "pindie_task_replace", "task-replace", {
    goal: "Task B",
    successCriteria: ["Task B works"],
  });
  await assert.rejects(
    replace.api.tool("pindie_verification_record").execute("after-replace", {
      check: {
        name: "old Task evidence",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: [beforeReplace.ref],
      },
    }),
    /Stale Pindie evidence reference/,
  );

  const refine = createHarness([["/repo", activeState()]]);
  await startSession(refine, "/repo");
  await beginAgentRun(refine);
  const beforeRefine = await captureObservationEvidence(
    refine,
    "read-before-refine",
  );
  await executeSemanticTool(refine, "pindie_task_refine", "task-refine", {
    goal: "Refined task",
  });
  await assert.rejects(
    refine.api.tool("pindie_verification_record").execute("after-refine", {
      check: {
        name: "pre-refinement evidence",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: [beforeRefine.ref],
      },
    }),
    /Stale Pindie evidence reference/,
  );
});

test("M5 I18-I20 progress, Gate operations, and verification recording retain current candidates", async () => {
  const progress = createHarness([["/repo", activeState()]]);
  await startSession(progress, "/repo");
  await beginAgentRun(progress);
  const progressRef = await captureObservationEvidence(progress, "before-progress");
  await executeSemanticTool(progress, "pindie_task_progress", "task-progress", {
    blockers: [], questions: [], nextIntent: "Continue",
  });
  await progress.api.tool("pindie_verification_record").execute("after-progress", {
    check: { name: "progress", status: "passed", covers: ["c1"], evidenceRefs: [progressRef.ref] },
  });
  await progress.api.tool("pindie_verification_record").execute("reuse-progress", {
    check: { name: "progress reused", status: "passed", covers: [], evidenceRefs: [progressRef.ref] },
  });

  const opened = createHarness([["/repo", activeState()]]);
  await startSession(opened, "/repo");
  await beginAgentRun(opened);
  const openRef = await captureObservationEvidence(opened, "before-gate-open");
  await executeSemanticTool(opened, "pindie_gate_open", "gate-open", {
    kind: "approval", question: "Approve?",
  });
  await opened.api.tool("pindie_verification_record").execute("after-open", {
    check: { name: "open retained", status: "passed", covers: [], evidenceRefs: [openRef.ref] },
  });

  const resolved = createHarness([["/repo", gatedState()]]);
  await startSession(resolved, "/repo");
  await beginAgentRun(resolved);
  const resolveRef = await captureObservationEvidence(resolved, "before-gate-resolve");
  await executeSemanticTool(resolved, "pindie_gate_resolve", "gate-resolve", {});
  await resolved.api.tool("pindie_verification_record").execute("after-resolve", {
    check: { name: "resolve retained", status: "passed", covers: ["c1"], evidenceRefs: [resolveRef.ref] },
  });
});

test("M5 I21-I23 parallel observation results cannot outlive a project mutation generation", async () => {
  const late = createHarness([["/repo", activeState()]]);
  await startSession(late, "/repo");
  await beginAgentRun(late);
  assert.equal(await callGuard(late, toolCall("read", {}, "late-read")), undefined);
  assert.equal(await callGuard(late, toolCall("edit", {}, "edit-first")), undefined);
  await late.api.handler("tool_result")(toolResult("edit", false, "edit-first"), context("/repo"));
  assert.equal(
    await late.api.handler("tool_result")(toolResult("read", false, "late-read"), context("/repo")),
    undefined,
  );

  const inverse = createHarness([["/repo", activeState()]]);
  await startSession(inverse, "/repo");
  await beginAgentRun(inverse);
  const visibleFirst = await captureObservationEvidence(inverse, "visible-before-edit");
  assert.equal(await callGuard(inverse, toolCall("edit", {}, "later-edit")), undefined);
  await inverse.api.handler("tool_result")(toolResult("edit", false, "later-edit"), context("/repo"));
  await assert.rejects(
    inverse.api.tool("pindie_verification_record").execute("stale-visible", {
      check: { name: "stale", status: "passed", covers: ["c1"], evidenceRefs: [visibleFirst.ref] },
    }),
    /Stale Pindie evidence reference/,
  );

  const current = createHarness([["/repo", activeState()]]);
  await startSession(current, "/repo");
  await beginAgentRun(current);
  const first = await captureObservationEvidence(current, "current-read");
  const second = await captureObservationEvidence(current, "current-grep", {
    toolName: "grep",
    input: { pattern: "verification" },
  });
  await current.api.tool("pindie_verification_record").execute("both", {
    check: {
      name: "two observations",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [first.ref, second.ref],
    },
  });
  assert.match(
    current.integration.runtime.state.task?.verification.checks[0]?.evidence ?? "",
    /Tool: read[\s\S]*Tool: grep/,
  );
});

test("M5 I24 a mutating ambiguous result prevents a pending old-generation ambiguous result from becoming evidence", async () => {
  const fingerprints = [
    { kind: "known" as const, digest: "S0" },
    { kind: "known" as const, digest: "S1" },
    { kind: "known" as const, digest: "S1" },
  ];
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => fingerprints.shift()!,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("bash", {}, "ambiguous-a")), undefined);
  assert.equal(await callGuard(harness, toolCall("custom_tool", {}, "ambiguous-b")), undefined);
  const firstMutationResult = await harness.api.handler("tool_result")(
    toolResult("bash", false, "ambiguous-a"),
    context("/repo"),
  ) as { content: Array<{ type: string; text?: string }> };
  assert.match(textOf(firstMutationResult), /Project mutation changed authoritative verification state/);
  const betweenResults = await captureObservationEvidence(
    harness,
    "between-ambiguous-results",
  );
  const secondMutationResult = await harness.api.handler("tool_result")(
    toolResult("custom_tool", false, "ambiguous-b"),
    context("/repo"),
  );
  assert.equal(secondMutationResult, undefined);
  assert.equal(harness.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("between-stale", {
      check: {
        name: "between results",
        status: "passed",
        covers: ["c1"],
        evidenceRefs: [betweenResults.ref],
      },
    }),
    /Stale Pindie evidence reference/,
  );
});

test("M5 I25-I28 Agent settlement, next Run, and session shutdown discard Recent Evidence", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const firstRun = await captureObservationEvidence(harness, "first-run-ref");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("after-settle", {
      check: { name: "settled", status: "passed", covers: ["c1"], evidenceRefs: [firstRun.ref] },
    }),
    /Unknown Pindie evidence reference/,
  );

  await beginAgentRun(harness);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("next-run-old", {
      check: { name: "old run", status: "passed", covers: ["c1"], evidenceRefs: [firstRun.ref] },
    }),
    /Unknown Pindie evidence reference/,
  );
  const secondRun = await captureObservationEvidence(harness, "second-run-ref");
  assert.match(secondRun.ref, /^ev:[A-Za-z0-9_-]+:\d+$/);
  assert.notEqual(secondRun.ref, firstRun.ref);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "done" },
    context("/repo"),
  );
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("after-shutdown", {
      check: { name: "shutdown", status: "passed", covers: ["c1"], evidenceRefs: [secondRun.ref] },
    }),
    /Unknown Pindie evidence reference/,
  );

  await startSession(harness, "/repo", "reload");
  await beginAgentRun(harness);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("fresh-run-empty", {
      check: { name: "fresh", status: "passed", covers: ["c1"], evidenceRefs: [secondRun.ref] },
    }),
    /Unknown Pindie evidence reference/,
  );
});

test("M5 external State unavailability clears refs collected under prior semantic authority", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const prior = await captureObservationEvidence(harness, "before-unavailable");
  harness.store.loadErrors.set("/repo", new Error("State disappeared"));
  assertBlocked(await callGuard(harness, toolCall("edit", {}, "mark-unavailable")), /authority is unavailable/);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("prior-authority", {
      check: { name: "prior", status: "passed", covers: ["c1"], evidenceRefs: [prior.ref] },
    }),
    /Unknown Pindie evidence reference/,
  );
});

test("SI v0.6 writes revision-aware schema-v4 Run Experience while preserving v0.3 facts", async () => {
  const harness = createHarness([["/repo", activeState("Experience task")]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await captureObservationEvidence(harness, "experience-read");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.experienceStore.records.length, 1);
  const record = harness.experienceStore.records[0]!.experience;
  assert.equal(record.schemaVersion, 4);
  assert.deepEqual(record.runStart, {
    taskStatus: "active",
    taskGoal: "Experience task",
  });
  assert.equal(record.task.goal, "Experience task");
  assert.equal(record.task.taskRelation, "preexisting_untouched");
  assert.equal("statusAtStart" in record.task, false);
  assert.deepEqual(record.policy, {
    finalSnapshot: null,
    declarationCount: 0,
    finalPolicyDeclarationCount: 0,
    finalPolicyFirstDeclaredAfter: null,
    finalPolicyLastDeclaredAfter: null,
  });
  assert.deepEqual(record.execution, {
    toolCalls: 1,
    observations: 1,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  });
  assert.deepEqual(record.outcome, {
    taskStatus: "active",
    verificationStatus: "pending",
    completionRelation: "not_completed",
    hasBlockers: false,
    hasQuestions: false,
    humanGateOpen: false,
  });
  assert.equal(typeof record.metrics.durationMs, "number");
  assert.equal(typeof record.metrics.cost, "number");
  assert.equal(harness.store.saves.length, 0);
  assert.equal(JSON.stringify(record).includes("evidence"), false);
});

test("SI v0.6 preserves idle introduction and Policy declaration positions", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await executeSemanticTool(harness, "pindie_task_start", "experience-start", {
    goal: "Introduced task",
    successCriteria: ["It is recorded"],
  });
  const first = await captureObservationEvidence(harness, "position-before-policy");
  await executeSemanticTool(harness, "pindie_policy_set", "policy-first", {
    approach: "architecture-first",
    modifiers: ["minimal-change"],
  });
  await captureObservationEvidence(harness, "position-after-policy", {
    isError: true,
    content: [{ type: "text", text: "An observation failed." }],
  });
  await executeSemanticTool(harness, "pindie_policy_set", "policy-final", {
    approach: "direct-action",
  });
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(first.ref.startsWith("ev:"), true);
  const record = harness.experienceStore.records[0]!.experience;
  assert.equal(record.schemaVersion, 4);
  assert.deepEqual(record.runStart, { taskStatus: "idle", taskGoal: null });
  assert.equal(record.task.goal, "Introduced task");
  assert.equal(record.task.taskRelation, "introduced_during_run");
  assert.equal("statusAtStart" in record.task, false);
  assert.equal(record.policy.finalSnapshot?.approach.id, "direct-action");
  assert.equal(record.policy.declarationCount, 2);
  assert.equal(record.policy.finalPolicyDeclarationCount, 1);
  assert.deepEqual(record.policy.finalPolicyFirstDeclaredAfter, {
    toolCalls: 3,
    observations: 2,
    consequentialCalls: 1,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 1,
    deniedCalls: 0,
  });
  assert.deepEqual(record.policy.finalPolicyLastDeclaredAfter, {
    toolCalls: 3,
    observations: 2,
    consequentialCalls: 1,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 1,
    deniedCalls: 0,
  });
  assert.equal(record.execution.toolCalls, 3);
  assert.equal(record.execution.observations, 2);
  assert.equal(record.execution.consequentialCalls, 1);
  assert.equal(record.execution.projectMutationEffectCalls, 0);
  assert.equal("projectMutationCalls" in record.execution, false);
  assert.equal("projectMutationCalls" in (record.policy.finalPolicyFirstDeclaredAfter ?? {}), false);
  assert.equal("projectMutationCalls" in (record.policy.finalPolicyLastDeclaredAfter ?? {}), false);
  assert.equal(record.execution.toolErrors, 1);
});

test("SI v0.6 keeps completed run-start Task A distinct from introduced settlement Task B", async () => {
  const completedTaskA = completedState();
  const taskA: PindieState = {
    task: { ...completedTaskA.task!, goal: "Task A" },
  };
  const harness = createHarness([["/repo", taskA]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await executeSemanticTool(harness, "pindie_task_start", "task-b-start", {
    goal: "Task B",
    successCriteria: ["Task B is recorded"],
  });
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.experienceStore.records.length, 1);
  const record = harness.experienceStore.records[0]!.experience;
  assert.equal(record.schemaVersion, 4);
  assert.deepEqual(record.runStart, { taskStatus: "done", taskGoal: "Task A" });
  assert.deepEqual(record.task, {
    goal: "Task B",
    taskRelation: "introduced_during_run",
  });
  assert.equal("statusAtStart" in record.task, false);
});

test("SI v0.3 eligibility excludes no-Task, policy-only, stale, unavailable, and denied-only Runs", async () => {
  const noTask = createHarness();
  await startSession(noTask, "/repo");
  await beginAgentRun(noTask);
  assert.equal(await callGuard(noTask, toolCall("read", {}, "no-task-read")), undefined);
  assert.equal(
    await noTask.api.handler("tool_result")(toolResult("read", false, "no-task-read"), context("/repo")),
    undefined,
  );
  await noTask.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(noTask.experienceStore.records.length, 0);

  const policyOnly = createHarness([["/repo", activeState()]]);
  await startSession(policyOnly, "/repo");
  await beginAgentRun(policyOnly);
  await executeSemanticTool(policyOnly, "pindie_policy_set", "policy-only", { approach: "direct-action" });
  await policyOnly.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(policyOnly.experienceStore.records.length, 0);

  const stale = createHarness([["/repo", activeState()]]);
  await startSession(stale, "/repo");
  await beginAgentRun(stale);
  await captureObservationEvidence(stale, "stale-read");
  stale.store.states.set("/repo", activeState("External task"));
  await stale.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(stale.experienceStore.records.length, 0);

  const unavailable = createHarness();
  unavailable.store.loadErrors.set("/repo", new Error("unavailable"));
  await startSession(unavailable, "/repo");
  await beginAgentRun(unavailable);
  assert.equal(await callGuard(unavailable, toolCall("read", {}, "unavailable-read")), undefined);
  assert.equal(
    await unavailable.api.handler("tool_result")(toolResult("read", false, "unavailable-read"), context("/repo")),
    undefined,
  );
  await unavailable.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(unavailable.experienceStore.records.length, 0);

  const denied = createHarness([["/repo", activeState()]]);
  await startSession(denied, "/repo");
  await beginAgentRun(denied);
  assertBlocked(await callGuard(denied, toolCall("pindie_task_complete", {}, "denied-only")), /missing capability/);
  await denied.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(denied.experienceStore.records.length, 0);

  const deniedAfterObservation = createHarness([["/repo", activeState()]]);
  await startSession(deniedAfterObservation, "/repo");
  await beginAgentRun(deniedAfterObservation);
  await captureObservationEvidence(deniedAfterObservation, "denied-after-read");
  assertBlocked(
    await callGuard(deniedAfterObservation, toolCall("pindie_task_complete", {}, "denied-after-read")),
    /missing capability/,
  );
  await deniedAfterObservation.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(deniedAfterObservation.experienceStore.records.length, 1);
  assert.equal(deniedAfterObservation.experienceStore.records[0]!.experience.execution.deniedCalls, 1);
  assert.equal(deniedAfterObservation.experienceStore.records[0]!.experience.execution.toolCalls, 1);
});

test("SI v0.3 counters reset and persistence failure cannot affect semantic authority", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await captureObservationEvidence(harness, "first-run");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  await beginAgentRun(harness);
  await captureObservationEvidence(harness, "second-run");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(harness.experienceStore.records.length, 2);
  assert.equal(harness.experienceStore.records[0]!.experience.execution.toolCalls, 1);
  assert.equal(harness.experienceStore.records[1]!.experience.execution.toolCalls, 1);

  const failed = createHarness([["/repo", activeState()]]);
  await startSession(failed, "/repo");
  await beginAgentRun(failed);
  const stateBefore = structuredClone(failed.integration.runtime.state);
  await captureObservationEvidence(failed, "persistence-failure");
  failed.experienceStore.saveError = new Error("experience disk unavailable");
  await assert.doesNotReject(
    failed.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo")),
  );
  assert.deepEqual(failed.integration.runtime.state, stateBefore);
  assert.equal(failed.integration.stateUnavailableReason, null);
  assert.equal(failed.integration.runTimer.active, false);
  assert.equal(failed.integration.runCost.snapshot([] as any)?.active, false);
});

test("SI v0.3 obsolete stale settlement writes no Experience", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await captureObservationEvidence(harness, "stale-settlement");
  const staleContext = {
    sessionManager: {
      getEntries: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    },
  };
  await assert.doesNotReject(
    harness.api.handler("agent_settled")({ type: "agent_settled" }, staleContext),
  );
  assert.equal(harness.experienceStore.records.length, 0);
  assert.equal(harness.integration.runTimer.active, true);
});

test("SI v0.5 /adapt is explicit, Run-bound, and Candidate creation stays inactive", async () => {
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "one.json", experience: commandExperience("adapt one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "two.json", experience: commandExperience("adapt two", createPolicySnapshot({ approach: "direct-action" })) },
    ],
    unsupportedSchema: 0,
    invalid: 0,
  };
  const saved: any[] = [];
  const harness = createHarness([["/repo", activeState()]], {}, {
    experienceReader: reader,
    strategyCandidateStore: { save: async (_root, candidate) => { saved.push(candidate); } },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("adapt");
  assert.ok(command);
  assert.equal(command.getArgumentCompletions("direct")[0].value, "direct-action");
  assert.equal(command.getArgumentCompletions("").length, 7);

  await command.handler("direct-action", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(harness.api.sentUserMessages.length, 1);
  assert.match(notices.at(-1)?.message ?? "", /adaptation Run started/);
  await command.handler("direct-action", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.match(notices.at(-1)?.message ?? "", /another adaptation attempt is already active/i);
  assert.equal(harness.api.sentUserMessages.length, 1);

  const adaptationBaseline = await harnessBeforeAgentStart(harness);
  assert.match(adaptationBaseline.systemPrompt, /<PINDIE_ADAPTATION_PACKET>/);
  assert.match(adaptationBaseline.systemPrompt, /this is not a project implementation Task/i);
  assert.match(adaptationBaseline.systemPrompt, /co-occurring Strategies are confounders/i);
  assert.doesNotMatch(adaptationBaseline.message.content, /<PINDIE_ADAPTATION_PACKET>/);

  const stateBefore = structuredClone(harness.integration.runtime.state);
  for (const toolName of ["read", "grep", "find", "ls", "web_search", "url_context", "pindie_git_observe"]) {
    assert.equal(
      await callGuard(harness, toolCall(toolName, {}, `adapt-observation-${toolName}`)),
      undefined,
      toolName,
    );
  }
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_synthesis_candidate_create", {}, "adapt-synthesis")),
    /adaptation Run is read-only/,
  );
  assertBlocked(
    await callGuard(harness, toolCall("edit", { path: "src/index.ts", oldText: "x", newText: "y" }, "adapt-edit")),
    /adaptation Run is read-only/,
  );
  const candidateInput = {
    summary: "Prefer a smaller verified change after a focused check.",
    useWhen: ["the relevant boundary is narrow and observable"],
    avoidWhen: ["the likely fix remains unclear"],
    principles: ["make one bounded change", "verify before expanding scope"],
    sourceRecordIds: ["one.json", "two.json"],
    hypothesis: "Repeated attributable Runs suggest that a narrower first move may reduce rework.",
  };
  await executeSemanticTool(harness, "pindie_strategy_candidate_create", "candidate", candidateInput);
  assert.equal(saved.length, 1);
  assertBlocked(
    await callGuard(harness, toolCall("edit", { path: "src/index.ts", oldText: "x", newText: "y" }, "adapt-edit-after-candidate")),
    /adaptation Run is read-only/,
  );
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.equal(harness.integration.policySnapshot, null);
  assert.equal(harness.experienceStore.records.length, 0);
  await captureObservationEvidence(harness, "adaptation-observation");
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  await beginAgentRun(harness);
  assert.doesNotMatch(
    (await harnessBeforeAgentStart(harness)).systemPrompt,
    /<PINDIE_ADAPTATION_PACKET>/,
  );
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_candidate_create", candidateInput, "ordinary-candidate")),
    /requires a live Seed-targeted adaptation lease \(explicit \/adapt <strategy-id>\)/i,
  );
});

test("SI v0.5 /adapt rejects unknown, busy, missing-root, and insufficient evidence without a model turn", async () => {
  const reader = new ExtensionTestExperienceReader();
  const harness = createHarness([], {}, { experienceReader: reader });
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  await startSession(harness, "/repo");
  await harness.api.commands.get("adapt").handler("direct-action extra", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Usage: \/adapt <strategy-id>/i);
  assert.equal(harness.api.sentUserMessages.length, 0);

  await harness.api.commands.get("adapt").handler("unknown", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /not a valid Seed Strategy/i);
  assert.equal(harness.api.sentUserMessages.length, 0);

  await harness.api.commands.get("adapt").handler("direct-action", {
    ...commandContext,
    isIdle: () => false,
  });
  assert.match(notices.at(-1)?.message ?? "", /Agent is busy/i);
  assert.equal(harness.api.sentUserMessages.length, 0);

  const noRoot = createHarness([], {}, { experienceReader: reader });
  const noRootNotices: Array<{ message: string; type: string }> = [];
  await noRoot.api.commands.get("adapt").handler("direct-action", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => noRootNotices.push({ message, type }) },
  });
  assert.match(noRootNotices.at(-1)?.message ?? "", /no current project root/i);
  assert.equal(noRoot.api.sentUserMessages.length, 0);

  reader.result = {
    records: [{ recordId: "only.json", experience: commandExperience("only", createPolicySnapshot({ approach: "direct-action" })) }],
    loadedRecords: 1,
    unsupportedSchema: 0,
    invalid: 0,
  };
  await harness.api.commands.get("adapt").handler("direct-action", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /only 1 eligible attributable Run/i);
  assert.equal(harness.api.sentUserMessages.length, 0);
});

test("SI v0.7 /derive is explicit, bounded, read-only, and consumes one Candidate lease", async () => {
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "derive-one", experience: commandExperience("derive goal one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "derive-two", experience: commandExperience("derive goal two", createPolicySnapshot({ approach: "explore-first" })) },
      { recordId: "derive-three", experience: commandExperience("derive goal one", createPolicySnapshot({ approach: "direct-action", modifiers: ["minimal-change"] })) },
    ],
    loadedRecords: 3,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const saved: any[] = [];
  const harness = createHarness([["/repo", activeState("Derivation task")]], {}, {
    experienceReader: reader,
    strategyDerivationCandidateStore: { save: async (_root, candidate) => { saved.push(candidate); } },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const command = harness.api.commands.get("derive");
  assert.ok(command);
  await command.handler("unexpected", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Usage: \/derive/);
  assert.equal(harness.api.sentUserMessages.length, 0);

  await command.handler("", commandContext);
  assert.equal(harness.api.sentUserMessages.length, 1);
  assert.equal(harness.integration.derivation.hasPendingDerivation, true);
  assert.match(notices.at(-1)?.message ?? "", /derivation Run started/i);

  const baseline = await harnessBeforeAgentStart(harness);
  assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, false);
  assert.match(baseline.systemPrompt, /<PINDIE_DERIVATION_PACKET>/);
  assert.match(baseline.systemPrompt, /3 distinct source records|Minimum gate satisfied/i);
  assert.doesNotMatch(baseline.message.content, /<PINDIE_DERIVATION_PACKET>/);
  assert.equal(harness.integration.derivation.hasActiveDerivation, true);

  const stateBefore = structuredClone(harness.integration.runtime.state);
  for (const toolName of ["read", "grep", "find", "ls", "web_search", "url_context", "pindie_git_observe"]) {
    assert.equal(
      await callGuard(harness, toolCall(toolName, {}, `derive-observation-${toolName}`)),
      undefined,
      toolName,
    );
  }
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_synthesis_candidate_create", {}, "derive-synthesis")),
    /Derivation Run is read-only/i,
  );
  assertBlocked(
    await callGuard(harness, toolCall("edit", {}, "derive-edit")),
    /Derivation Run is read-only/i,
  );
  const candidateInput = {
    strategyId: "boundary-first",
    kind: "approach",
    summary: "Name the smallest boundary before choosing a broader change.",
    useWhen: ["the requested change crosses a meaningful interface"],
    avoidWhen: ["the correction is already local and clear"],
    principles: ["make the boundary explicit", "verify the smallest coherent move"],
    sourceRecordIds: ["derive-one", "derive-two", "derive-three"],
    hypothesis: "Repeated trusted-policy Runs may expose a missing boundary-first abstraction.",
  };
  await executeSemanticTool(harness, "pindie_strategy_derivation_candidate_create", "derive-candidate", candidateInput);
  assert.equal(saved.length, 1);
  assert.equal(harness.integration.derivation.hasDerivation, false);
  assertBlocked(
    await callGuard(harness, toolCall("edit", {}, "derive-edit-after")),
    /Derivation Run is read-only/i,
  );
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.equal(harness.experienceStore.records.length, 0);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  await beginAgentRun(harness);
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_derivation_candidate_create", candidateInput, "ordinary-derive")),
    /Derivation or Synthesis Candidate creation requires a live matching lease \(explicit \/derive or \/derive-global Run\)/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.7 /derive, /adapt, and /trial leases remain mutually exclusive", async () => {
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "derive-one", experience: commandExperience("one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "derive-two", experience: commandExperience("two", createPolicySnapshot({ approach: "explore-first" })) },
      { recordId: "derive-three", experience: commandExperience("one", createPolicySnapshot({ approach: "direct-action", modifiers: ["minimal-change"] })) },
    ],
    loadedRecords: 3,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const candidate = trialCandidate();
  const harness = createHarness([["/repo", activeState()]], {}, {
    experienceReader: reader,
    strategyCandidateReader: { read: async () => candidate },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  await harness.api.commands.get("derive").handler("", commandContext);
  await harness.api.commands.get("adapt").handler("direct-action", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Derivation attempt|derive.*pending or active/i);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown" }, context("/repo"));

  const adapt = createHarness([["/repo", activeState()]], {}, { experienceReader: reader });
  await startSession(adapt, "/repo");
  await adapt.api.commands.get("adapt").handler("direct-action", commandContext);
  await adapt.api.commands.get("derive").handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /adaptation attempt|adapt.*pending or active/i);
});

test("SI v0.6 Slice B /trial arms the next real Run without manufacturing user intent", async () => {
  const candidate = trialCandidate();
  const readerCalls: Array<{ root: string; id: string }> = [];
  const harness = createHarness([["/repo", activeState("Trial task")]], {}, {
    strategyCandidateReader: {
      read: async (root, id) => {
        readerCalls.push({ root, id });
        return id === candidate.candidateId ? candidate : null;
      },
    },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const command = harness.api.commands.get("trial");
  assert.ok(command);

  await command.handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });

  assert.deepEqual(readerCalls, [{ root: "/repo", id: candidate.candidateId }]);
  assert.deepEqual(harness.api.sentUserMessages, []);
  assert.equal(harness.integration.trial.hasPendingTrial, true);
  assert.equal(harness.integration.trial.hasActiveTrial, false);
  assert.match(notices.at(-1)?.message ?? "", /Trial armed for the next Agent Run/i);

  const runStart = await harnessBeforeAgentStart(harness);
  assert.equal((runStart.systemPrompt.match(/<PINDIE_TRIAL_PACKET>/g) ?? []).length, 1);
  assert.equal((runStart.systemPrompt.match(/<\/PINDIE_TRIAL_PACKET>/g) ?? []).length, 1);
  assert.doesNotMatch(runStart.message.content, /<PINDIE_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial.hasActiveTrial, true);
  assert.equal(typeof harness.integration.trial.activeTrial?.agentRunGeneration, "number");
  assert.match(runStart.message.content, /<PINDIE_RUN_BASELINE>/);

  const activeSelection = harness.integration.trial.activeTrial!.revisionSelection;
  const selector = {
    strategyId: activeSelection.strategyId,
    revisionIdentity: activeSelection.revisionIdentity,
    revisionFingerprint: activeSelection.revisionFingerprint,
  };
  await executeSemanticTool(harness, "pindie_policy_set", "trial-policy", {
    approach: selector,
    modifiers: ["minimal-change"],
  });
  await captureObservationEvidence(harness, "trial-observation");
  const boundary = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"));
  assert.equal(boundary.continue, true);
  assert.equal(boundary.entries[0].customType, PINDIE_CONTINUATION_PROBE_TYPE);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.integration.trial.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 1);
  const record = harness.experienceStore.records[0]!.experience;
  const finalApproach = record.policy.finalSnapshot?.approach;
  assert.equal(finalApproach?.revisionIdentity, candidate.candidateId);
  assert.equal(finalApproach?.revisionFingerprint, strategyCandidateSemanticFingerprint(candidate));
  assert.equal(finalApproach?.revisionStatusAtRun, "trial");
  assert.deepEqual(finalApproach?.semantics, {
    summary: candidate.proposal.summary,
    useWhen: candidate.proposal.useWhen,
    avoidWhen: candidate.proposal.avoidWhen,
    principles: candidate.proposal.principles,
  });
  assert.equal(JSON.stringify(record).includes("trialActive"), false);
  assert.equal(JSON.stringify(record).includes("candidateId"), false);

  await beginAgentRun(harness);
  assert.doesNotMatch(
    (await harnessBeforeAgentStart(harness)).systemPrompt,
    /<PINDIE_TRIAL_PACKET>/,
  );
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute(
      "after-trial",
      { approach: selector },
      undefined,
      undefined,
      context("/repo"),
    ),
    /without an active Candidate Trial/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.7 /trial completions unify valid Revision and Derivation Candidates by exact ID", async () => {
  const revision = trialCandidate("00000000-0000-4000-8000-000000000011");
  const derivation = derivationTrialCandidate("00000000-0000-4000-8000-000000000012");
  const revisions = new Map([[revision.candidateId, revision]]);
  const derivations = new Map([[derivation.candidateId, derivation]]);
  const revisionReader = {
    readAll: async () => [...revisions.values()],
    read: async (_root: string, candidateId: string) => revisions.get(candidateId) ?? null,
  };
  const derivationReader = {
    readAll: async () => [...derivations.values()],
    read: async (_root: string, candidateId: string) => derivations.get(candidateId) ?? null,
  };
  const decisions = testDecisionStore();
  const reader = new ExtensionTestExperienceReader();
  const emptyScope = emptyScopeAuthority();
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    experienceReader: reader,
    strategyCandidateReader: revisionReader,
    strategyDerivationCandidateReader: derivationReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyTrustScopeCandidateStore: emptyScope.candidateStore,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
  });
  await startSession(harness, "/repo");

  const command = harness.api.commands.get("trial");
  assert.ok(command);
  const options = await command.getArgumentCompletions("");
  assert.ok(options);
  assert.deepEqual(new Set(options!.map((option: any) => option.value)), new Set([
    revision.candidateId,
    derivation.candidateId,
  ]));
  assert.match(options!.find((option: any) => option.value === revision.candidateId)!.label, /architecture-first · Use a bounded architectural check/);
  assert.match(options!.find((option: any) => option.value === derivation.candidateId)!.label, /boundary-first.*derivation/);
  assert.deepEqual(
    await command.getArgumentCompletions(derivation.candidateId),
    [options!.find((option: any) => option.value === derivation.candidateId)],
  );
  assert.deepEqual(harness.integration.runtime.state, activeState());
  assert.deepEqual(harness.store.saves, []);
});

test("SI v0.7 Derivation /trial binds one exact Run, creates no packet attribution alone, and records schema-v4 trial identity", async () => {
  const candidate = derivationTrialCandidate();
  const derivationReader = {
    readAll: async () => [candidate],
    read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
  };
  const revisionReader = {
    readAll: async () => [],
    read: async () => null,
  };
  const decisions = testDecisionStore();
  const harness = createHarness([ ["/repo", activeState("Derivation Trial task")] ], {}, {
    experienceReader: new ExtensionTestExperienceReader(),
    strategyCandidateReader: revisionReader,
    strategyDerivationCandidateReader: derivationReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("trial");
  assert.ok(command);
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  };

  await command.handler(candidate.candidateId, commandContext);
  assert.equal(harness.integration.trial.hasPendingDerivationTrial, true);
  assert.equal(harness.api.sentUserMessages.length, 0);
  const firstRun = await harnessBeforeAgentStart(harness);
  assert.match(firstRun.systemPrompt, /<PINDIE_DERIVATION_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial.hasActiveDerivationTrial, true);
  assert.equal(harness.integration.policySnapshot, null);
  await captureObservationEvidence(harness, "derivation-trial-without-policy");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.integration.trial.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 1);
  assert.equal(harness.experienceStore.records[0]!.experience.schemaVersion, 4);
  assert.equal(harness.experienceStore.records[0]!.experience.policy.finalSnapshot, null);

  // A second explicit command is required for a second Candidate Trial.
  await command.handler(candidate.candidateId, commandContext);
  const secondRun = await harnessBeforeAgentStart(harness);
  assert.match(secondRun.systemPrompt, /<PINDIE_DERIVATION_TRIAL_PACKET>/);
  const activeSelection = harness.integration.trial.activeDerivationTrial!.revisionSelection;
  const selector = {
    strategyId: activeSelection.strategyId,
    revisionIdentity: activeSelection.revisionIdentity,
    revisionFingerprint: activeSelection.revisionFingerprint,
  };
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute(
      "wrong-derived-role",
      { approach: "direct-action", modifiers: [selector] },
      undefined,
      undefined,
      context("/repo"),
    ),
    /wrong.*modifier|role/i,
  );
  await executeSemanticTool(harness, "pindie_policy_set", "derived-trial-policy", {
    approach: selector,
    modifiers: ["minimal-change"],
  });
  await captureObservationEvidence(harness, "derivation-trial-observation");
  const boundary = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo"));
  assert.equal(boundary.continue, true);
  assert.equal(boundary.entries[0].customType, PINDIE_CONTINUATION_PROBE_TYPE);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.integration.trial.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 2);
  const trialRecord = harness.experienceStore.records[1]!.experience;
  const finalApproach = trialRecord.policy.finalSnapshot?.approach;
  assert.equal(finalApproach?.strategyId, candidate.proposal.strategyId);
  assert.equal(finalApproach?.revisionIdentity, candidate.candidateId);
  assert.equal(finalApproach?.revisionFingerprint, strategyDerivationCandidateSemanticFingerprint(candidate));
  assert.equal(finalApproach?.revisionStatusAtRun, "trial");
  assert.deepEqual(finalApproach?.semantics, {
    summary: candidate.proposal.summary,
    useWhen: candidate.proposal.useWhen,
    avoidWhen: candidate.proposal.avoidWhen,
    principles: candidate.proposal.principles,
  });
  assert.equal(trialRecord.execution.toolCalls, 1);
  assert.equal(trialRecord.policy.finalPolicyDeclarationCount, 1);
  assert.equal(JSON.stringify(trialRecord).includes("candidateId"), false);
  assert.equal(JSON.stringify(trialRecord).includes("trialActive"), false);

  await beginAgentRun(harness);
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute(
      "after-derived-trial",
      { approach: selector },
      undefined,
      undefined,
      context("/repo"),
    ),
    /without an active Candidate Trial/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.7 Derivation /trial fails closed for stale Candidate bindings and cross-store UUID collisions", async () => {
  const candidate = derivationTrialCandidate("00000000-0000-4000-8000-000000000013");
  let currentCandidate: StrategyDerivationCandidateV1 = candidate;
  const staleReader = {
    readAll: async () => [currentCandidate],
    read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? currentCandidate : null,
  };
  const revisionReader = { readAll: async () => [], read: async () => null };
  const decisions = testDecisionStore();
  const staleHarness = createHarness([ ["/repo", activeState()] ], {}, {
    strategyCandidateReader: revisionReader,
    strategyDerivationCandidateReader: staleReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  });
  await startSession(staleHarness, "/repo");
  const staleNotices: Array<{ message: string; type: string }> = [];
  const staleContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => staleNotices.push({ message, type }) },
  };
  await staleHarness.api.commands.get("trial").handler(candidate.candidateId, staleContext);
  currentCandidate = {
    ...candidate,
    proposal: {
      ...candidate.proposal,
      summary: "The immutable proposal changed after arming.",
    },
  };
  await assert.rejects(
    harnessBeforeAgentStart(staleHarness),
    /stale|changed|immutable Candidate/i,
  );
  assert.equal(staleHarness.integration.trial.hasTrial, false);
  assert.equal(staleHarness.experienceStore.records.length, 0);

  const collisionId = "00000000-0000-4000-8000-000000000014";
  const revision = trialCandidate(collisionId);
  const derivation = derivationTrialCandidate(collisionId);
  const collisionHarness = createHarness([ ["/repo", activeState()] ], {}, {
    strategyCandidateReader: {
      readAll: async () => [revision],
      read: async (_root: string, candidateId: string) => candidateId === collisionId ? revision : null,
    },
    strategyDerivationCandidateReader: {
      readAll: async () => [derivation],
      read: async (_root: string, candidateId: string) => candidateId === collisionId ? derivation : null,
    },
    strategyDecisionStore: testDecisionStore(),
  });
  await startSession(collisionHarness, "/repo");
  assert.equal(await collisionHarness.api.commands.get("trial").getArgumentCompletions(""), null);
  const collisionNotices: Array<{ message: string; type: string }> = [];
  await collisionHarness.api.commands.get("trial").handler("", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => collisionNotices.push({ message, type }) },
  });
  assert.match(collisionNotices.at(-1)?.message ?? "", /No Candidate selected|choose one/i);
  assert.equal(collisionHarness.integration.trial.hasTrial, false);
});

test("SI v0.7 Derivation /trial rejects a changed trusted-portfolio base before Run binding", async () => {
  const promotedCandidate = trialCandidate("00000000-0000-4000-8000-000000000021");
  const promotedDecision = createStrategyRevisionDecision({
    candidate: promotedCandidate,
    decision: "promoted",
    trialRecordIds: [],
    decidedAt: "2026-02-01T00:00:00.000Z",
  });
  const basePortfolio = createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([{
      candidate: promotedCandidate,
      decision: promotedDecision,
      selection: strategyRevisionSelectionFromCandidate(promotedCandidate, "promoted"),
    }]),
  );
  const candidate = derivationTrialCandidate(
    "00000000-0000-4000-8000-000000000022",
    basePortfolio,
  );
  const decisions = testDecisionStore([promotedDecision]);
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    strategyCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === promotedCandidate.candidateId ? promotedCandidate : null,
      readAll: async () => [promotedCandidate],
    },
    strategyDerivationCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
      readAll: async () => [candidate],
    },
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  assert.equal(harness.integration.trial.hasPendingDerivationTrial, true);

  decisions.decisions.clear();
  await assert.rejects(
    harnessBeforeAgentStart(harness),
    /stale|trusted portfolio|binding/i,
  );
  assert.equal(harness.integration.trial.hasTrial, false);
});

test("SI v0.7 Derivation Trial lease clears across Session replacement and fresh Runs", async () => {
  const candidate = derivationTrialCandidate("00000000-0000-4000-8000-000000000023");
  const harness = createHarness([ ["/repo", activeState()] ], {}, {
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDerivationCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
      readAll: async () => [candidate],
    },
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(harness);
  assert.equal(harness.integration.trial.hasActiveDerivationTrial, true);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo"),
  );
  await startSession(harness, "/repo", "new");
  assert.equal(harness.integration.trial.hasTrial, false);
  const fresh = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(fresh.systemPrompt, /<PINDIE_DERIVATION_TRIAL_PACKET>/);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.6 /trial refuses malformed, unavailable, busy, missing, and invalid Candidates", async () => {
  const valid = trialCandidate();
  const reader = {
    calls: 0,
    async read(_root: string, id: string) {
      this.calls += 1;
      return id === valid.candidateId ? valid : null;
    },
  };
  const harness = createHarness([["/repo", activeState()]], {}, {
    strategyCandidateReader: reader,
  });
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("trial");

  await command.handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /No Candidate selected\. Use command completion/i);
  await command.handler("not-a-uuid", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /canonical lowercase UUID-v4/i);
  assert.equal(reader.calls, 0);
  await command.handler(`${valid.candidateId} extra`, commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Usage: \/trial <candidate-id>/);
  assert.match(notices.at(-1)?.message ?? "", /\/trial scope:<candidate-id>/);
  assert.match(notices.at(-1)?.message ?? "", /\/trial synthesis:<candidate-id>/);

  await command.handler(valid.candidateId, { ...commandContext, isIdle: () => false });
  assert.match(notices.at(-1)?.message ?? "", /Agent is busy/i);

  await command.handler("00000000-0000-4000-8000-000000000002", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /not found/i);
  assert.equal(harness.integration.trial.hasTrial, false);

  const malformed = createHarness([["/repo", activeState()]], {}, {
    strategyCandidateReader: { read: async () => ({ schemaVersion: 1 } as any) },
  });
  const malformedNotices: Array<{ message: string; type: string }> = [];
  await startSession(malformed, "/repo");
  await malformed.api.commands.get("trial").handler(valid.candidateId, {
    ...commandContext,
    ui: { notify: (message: string, type: string) => malformedNotices.push({ message, type }) },
  });
  assert.match(malformedNotices.at(-1)?.message ?? "", /invalid Candidate/i);
  assert.equal(malformed.integration.trial.hasTrial, false);

  const noRoot = createHarness([], {}, { strategyCandidateReader: reader });
  const noRootNotices: Array<{ message: string; type: string }> = [];
  await noRoot.api.commands.get("trial").handler(valid.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => noRootNotices.push({ message, type }) },
  });
  assert.match(noRootNotices.at(-1)?.message ?? "", /no current project root/i);
  assert.equal(noRoot.api.sentUserMessages.length, 0);
});

test("SI v0.6 Candidate lifecycle completions are semantic, filtered, and read-only", async () => {
  const eligible = trialCandidate("00000000-0000-4000-8000-000000000001", "architecture-first");
  const oneTrial = trialCandidate("00000000-0000-4000-8000-000000000002", "direct-action");
  const noSeed = trialCandidate("00000000-0000-4000-8000-000000000003", "explore-first");
  const rejected = trialCandidate("00000000-0000-4000-8000-000000000004", "hypothesis-driven");
  const promoted = trialCandidate("00000000-0000-4000-8000-000000000005", "reproduce-first");
  const candidates = [eligible, oneTrial, noSeed, rejected, promoted];
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const candidateReader = {
    readAll: async () => [...candidatesById.values()],
    read: async (_root: string, candidateId: string) => candidatesById.get(candidateId) ?? null,
  };
  const decisions = testDecisionStore([
    createStrategyRevisionDecision({
      candidate: rejected,
      decision: "rejected",
      trialRecordIds: [],
      decidedAt: "2026-02-01T00:00:00.000Z",
    }),
    createStrategyRevisionDecision({
      candidate: promoted,
      decision: "promoted",
      trialRecordIds: [],
      decidedAt: "2026-02-01T00:00:00.000Z",
    }),
  ]);
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "eligible-one", experience: commandExperience("eligible one", candidatePolicy(eligible)) },
      { recordId: "eligible-two", experience: commandExperience("eligible two", candidatePolicy(eligible)) },
      { recordId: "eligible-seed", experience: commandExperience("eligible seed", createPolicySnapshot({ approach: "architecture-first" })) },
      { recordId: "one-trial", experience: commandExperience("one trial", candidatePolicy(oneTrial)) },
      { recordId: "one-seed", experience: commandExperience("one seed", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "no-seed-one", experience: commandExperience("no seed one", candidatePolicy(noSeed)) },
      { recordId: "no-seed-two", experience: commandExperience("no seed two", candidatePolicy(noSeed)) },
    ],
    loadedRecords: 7,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const emptyScope = emptyScopeAuthority();
  const harness = createHarness([["/repo", activeState("Candidate completion task")]], {}, {
    experienceReader: reader,
    strategyCandidateReader: candidateReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyTrustScopeCandidateStore: emptyScope.candidateStore,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
  });
  await startSession(harness, "/repo");
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const savesBefore = structuredClone(harness.store.saves);
  const decisionsBefore = [...decisions.decisions.entries()];

  const complete = async (name: string) => await harness.api.commands.get(name).getArgumentCompletions("");
  const trialOptions = await complete("trial");
  const reviewOptions = await complete("trial-review");
  const promoteOptions = await complete("promote");
  const rejectOptions = await complete("reject");

  assert.ok(trialOptions);
  assert.deepEqual(new Set(trialOptions!.map((option: any) => option.value)), new Set([
    eligible.candidateId,
    oneTrial.candidateId,
    noSeed.candidateId,
  ]));
  assert.equal(trialOptions!.some((option: any) => option.value === rejected.candidateId), false);
  assert.equal(trialOptions!.some((option: any) => option.value === promoted.candidateId), false);
  assert.match(trialOptions!.find((option: any) => option.value === eligible.candidateId)!.label, /architecture-first · Use a bounded architectural check/);
  assert.equal(trialOptions!.find((option: any) => option.value === eligible.candidateId)!.label.includes(eligible.candidateId), false);

  assert.ok(reviewOptions);
  assert.equal(reviewOptions!.length, candidates.length);
  assert.match(reviewOptions![0]!.label, /2 eligible trials/);
  assert.match(reviewOptions!.find((option: any) => option.value === oneTrial.candidateId)!.label, /1 eligible trial(?!s)/);
  assert.match(reviewOptions!.find((option: any) => option.value === eligible.candidateId)!.label, /promotion eligible/);

  assert.deepEqual(promoteOptions, [{
    value: eligible.candidateId,
    label: "architecture-first · Use a bounded architectural check before changing code. · promotion eligible",
  }]);
  assert.deepEqual(new Set(rejectOptions!.map((option: any) => option.value)), new Set([
    eligible.candidateId,
    oneTrial.candidateId,
    noSeed.candidateId,
  ]));
  assert.equal(rejectOptions!.some((option: any) => option.value === rejected.candidateId), false);
  assert.equal(rejectOptions!.some((option: any) => option.value === promoted.candidateId), false);
  for (const options of [trialOptions!, reviewOptions!, promoteOptions!, rejectOptions!]) {
    for (const option of options) {
      assert.equal(option.value.length, 36);
      assert.equal(option.label.length <= 160, true);
    }
  }
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, savesBefore);
  assert.deepEqual([...decisions.decisions.entries()], decisionsBefore);
});

test("SI v0.6 stale Candidate completions remain subject to fresh command authority", async () => {
  const candidate = trialCandidate();
  const candidates = new Map([[candidate.candidateId, candidate]]);
  const candidateReader = {
    readAll: async () => [...candidates.values()],
    read: async (_root: string, candidateId: string) => candidates.get(candidateId) ?? null,
  };
  const decisions = testDecisionStore();
  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "trial-one", experience: commandExperience("stale one", candidatePolicy(candidate)) },
      { recordId: "trial-two", experience: commandExperience("stale two", candidatePolicy(candidate)) },
      { recordId: "seed", experience: commandExperience("stale seed", createPolicySnapshot({ approach: "architecture-first" })) },
    ],
    loadedRecords: 3,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const harness = createHarness([["/repo", activeState()]], {}, {
    experienceReader: reader,
    strategyCandidateReader: candidateReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  });
  await startSession(harness, "/repo");
  const options = await harness.api.commands.get("promote").getArgumentCompletions("");
  assert.deepEqual(options?.map((option: any) => option.value), [candidate.candidateId]);

  await decisions.save("/repo", createStrategyRevisionDecision({
    candidate,
    decision: "rejected",
    trialRecordIds: ["trial-one", "trial-two"],
    decidedAt: "2026-02-01T00:00:00.000Z",
  }));
  const notices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("promote").handler(options![0]!.value, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });

  assert.match(notices.at(-1)?.message ?? "", /terminal Decision already exists/i);
  assert.equal(decisions.decisions.get(candidate.candidateId)?.decision, "rejected");
});

test("SI v0.6 Trial and Adaptation slow paths are mutually exclusive", async () => {
  const candidate = trialCandidate();
  const candidateReader = { read: async () => candidate };
  const trialFirst = createHarness([["/repo", activeState()]], {}, { strategyCandidateReader: candidateReader });
  await startSession(trialFirst, "/repo");
  const trialNotices: Array<{ message: string; type: string }> = [];
  const trialContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => trialNotices.push({ message, type }) },
  };
  await trialFirst.api.commands.get("trial").handler(candidate.candidateId, trialContext);
  await trialFirst.api.commands.get("adapt").handler("direct-action", {
    ...trialContext,
    ui: trialContext.ui,
  });
  assert.match(trialNotices.at(-1)?.message ?? "", /Candidate Trial.*pending or active/i);
  assert.equal(trialFirst.api.sentUserMessages.length, 0);

  const reader = new ExtensionTestExperienceReader();
  reader.result = {
    records: [
      { recordId: "adapt-one.json", experience: commandExperience("one", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "adapt-two.json", experience: commandExperience("two", createPolicySnapshot({ approach: "direct-action" })) },
    ],
    loadedRecords: 2,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const adaptFirst = createHarness([["/repo", activeState()]], {}, {
    experienceReader: reader,
    strategyCandidateReader: candidateReader,
  });
  await startSession(adaptFirst, "/repo");
  const adaptNotices: Array<{ message: string; type: string }> = [];
  const adaptContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => adaptNotices.push({ message, type }) },
  };
  await adaptFirst.api.commands.get("adapt").handler("direct-action", adaptContext);
  assert.equal(adaptFirst.api.sentUserMessages.length, 1);
  await adaptFirst.api.commands.get("trial").handler(candidate.candidateId, adaptContext);
  assert.match(adaptNotices.at(-1)?.message ?? "", /adaptation attempt.*pending or active/i);
  assert.equal(adaptFirst.integration.trial.hasTrial, false);
});

test("SI v0.6 Trial leases clear across Session replacement and fresh Runs", async () => {
  const candidate = trialCandidate();
  const harness = createHarness([["/repo", activeState()]], {}, {
    strategyCandidateReader: { read: async () => candidate },
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(harness);
  assert.equal(harness.integration.trial.hasActiveTrial, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/repo"),
  );
  await startSession(harness, "/repo", "new");
  assert.equal(harness.integration.trial.hasTrial, false);
  const fresh = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(fresh.systemPrompt, /<PINDIE_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial.hasTrial, false);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice A handoff is dormant by default and enabled only through the internal staging seam", () => {
  assert.equal(createHarness([ ["/repo", activeState()] ]).api.tools.has("pindie_task_handoff"), false);
  assert.equal(
    createHarness([["/repo", activeState()]], {}, { enableTaskHandoff: true }).api.tools.has("pindie_task_handoff"),
    true,
  );

  const release = installCommittedRolloverReceiver(() => undefined);
  try {
    assert.equal(createHarness([["/repo", activeState()]]).api.tools.has("pindie_task_handoff"), true);
  } finally {
    release();
  }
});

test("Host-owned handoff publishes the exact committed checkpoint after Experience and continuity", async () => {
  const events: string[] = [];
  let published: unknown;
  const release = installCommittedRolloverReceiver((request) => {
    events.push("publish");
    published = request;
  });
  try {
    const experienceStore = new ExtensionTestExperienceStore();
    experienceStore.events = events;
    const continuityStore = new ExtensionTestContinuityStore();
    continuityStore.events = events;
    const harness = createHarness([["/repo", activeState()]], {}, {
      experienceStore,
      continuityStore,
      now: () => Date.parse("2026-09-04T01:02:03.000Z"),
    });
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const input = handoffInput();
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "host-owned-handoff")), undefined);
    await harness.api.tool("pindie_task_handoff").execute("host-owned-handoff", input);
    await harness.api.handler("tool_result")(
      toolResult("pindie_task_handoff", false, "host-owned-handoff"),
      context("/repo"),
    );
    await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

    assert.deepEqual(events, ["experience", "continuity", "publish"]);
    const committedCheckpoint = continuityStore.records[0]!.checkpoint;
    assert.equal((published as { sourceSessionId: string }).sourceSessionId, committedCheckpoint.sourceSessionId);
    assert.equal((published as { checkpoint: unknown }).checkpoint, committedCheckpoint);
  } finally {
    release();
  }
});

test("continuity save failure publishes no committed rollover request", async () => {
  let published = false;
  const release = installCommittedRolloverReceiver(() => { published = true; });
  try {
    const continuityStore = new ExtensionTestContinuityStore();
    continuityStore.saveError = new Error("continuity disk unavailable");
    const harness = createHarness([["/repo", activeState()]], {}, { continuityStore });
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const input = handoffInput();
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "failed-save")), undefined);
    await harness.api.tool("pindie_task_handoff").execute("failed-save", input);
    await harness.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "failed-save"), context("/repo"));
    await assert.doesNotReject(harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo")));

    assert.equal(published, false);
    assert.equal(continuityStore.records.length, 0);
    assert.equal(harness.integration.runtime.state.task?.openLoops.nextIntent, input.nextIntent);
  } finally {
    release();
  }
});

test("Host publication failure leaves the committed checkpoint and Task State valid", async () => {
  const release = installCommittedRolloverReceiver(() => {
    throw new Error("Host control unavailable");
  });
  try {
    const continuityStore = new ExtensionTestContinuityStore();
    const harness = createHarness([["/repo", activeState()]], {}, { continuityStore });
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const input = handoffInput();
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "publish-failure")), undefined);
    await harness.api.tool("pindie_task_handoff").execute("publish-failure", input);
    await harness.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "publish-failure"), context("/repo"));
    await assert.doesNotReject(harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo")));

    assert.equal(continuityStore.records.length, 1);
    assert.equal(harness.integration.runtime.state.task?.completed, false);
    assert.equal(harness.integration.runtime.state.task?.openLoops.nextIntent, input.nextIntent);
  } finally {
    release();
  }
});

test("Slice A handoff stages Task progress and commits continuity only after Experience settlement", async () => {
  const events: string[] = [];
  const experienceStore = new ExtensionTestExperienceStore();
  experienceStore.events = events;
  const continuityStore = new ExtensionTestContinuityStore();
  continuityStore.events = events;
  const harness = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    experienceStore,
    continuityStore,
    now: () => Date.parse("2026-09-03T01:02:03.000Z"),
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const before = structuredClone(harness.integration.runtime.state);
  const input = handoffInput();
  assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "handoff-a")), undefined);
  const toolResultValue = await harness.api.tool("pindie_task_handoff").execute("handoff-a", input);
  assert.equal(toolResultValue.terminate, true);
  assert.match(toolResultValue.content[0].text, /remains unfinished/i);
  assert.match(toolResultValue.content[0].text, /Handoff staged/i);
  assert.equal(continuityStore.records.length, 0);
  assert.equal(harness.integration.runtime.state.task?.openLoops.nextIntent, input.nextIntent);
  assert.deepEqual(harness.integration.runtime.state.task?.openLoops.blockers, before.task?.openLoops.blockers);
  assert.deepEqual(harness.integration.runtime.state.task?.openLoops.questions, before.task?.openLoops.questions);

  await harness.api.handler("tool_result")(
    toolResult("pindie_task_handoff", false, "handoff-a"),
    context("/repo"),
  );
  assert.equal(continuityStore.records.length, 0);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.deepEqual(events, ["experience", "continuity"]);
  assert.equal(experienceStore.records.length, 1);
  assert.equal(experienceStore.records[0]!.experience.execution.toolCalls, 1);
  assert.equal(experienceStore.records[0]!.experience.execution.consequentialCalls, 1);
  assert.equal(experienceStore.records[0]!.experience.execution.projectMutationEffectCalls, 0);
  assert.equal(experienceStore.records[0]!.experience.execution.deniedCalls, 0);
  assert.equal(continuityStore.records.length, 1);
  const checkpoint = continuityStore.records[0]!.checkpoint;
  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.sourceSessionId, "remote-session");
  assert.equal(checkpoint.createdAt, "2026-09-03T01:02:03.000Z");
  assert.equal(checkpoint.taskFingerprint, taskContractFingerprint(harness.integration.runtime.state.task!));
  assert.match(checkpoint.checkpointId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("handoff admission rejects in-flight work without semantic denial telemetry", async () => {
  const experienceStore = new ExtensionTestExperienceStore();
  const harness = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    experienceStore,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(await callGuard(harness, toolCall("read", {}, "read-before-handoff")), undefined);
  const denied = await callGuard(harness, toolCall("pindie_task_handoff", handoffInput(), "handoff-after-read"));
  assert.equal(denied.block, true);
  assert.match(denied.reason, /another authorized tool call is still in flight/i);

  await harness.api.handler("tool_result")(
    toolResult("read", false, "read-before-handoff"),
    context("/repo"),
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(experienceStore.records[0]!.experience.execution.deniedCalls, 0);
  assert.equal(experienceStore.records[0]!.experience.execution.projectMutationEffectCalls, 0);
});

test("handoff reserves the terminal frontier before async State preflight", async () => {
  const experienceStore = new ExtensionTestExperienceStore();
  const continuityStore = new ExtensionTestContinuityStore();
  const harness = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    experienceStore,
    continuityStore,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const refreshBarrier = harness.store.pauseNextLoad();
  const handoff = callGuard(
    harness,
    toolCall("pindie_task_handoff", handoffInput(), "handoff-async-preflight"),
  );
  await refreshBarrier.entered;

  const laterCall = await callGuard(
    harness,
    toolCall("read", {}, "read-during-handoff-preflight"),
  );
  assert.equal(laterCall.block, true);
  assert.match(laterCall.reason, /terminal work frontier/i);

  refreshBarrier.release();
  assert.equal(await handoff, undefined);
  const executionResult = await harness.api.tool("pindie_task_handoff").execute(
    "handoff-async-preflight",
    handoffInput(),
  );
  assert.equal(executionResult.terminate, true);
  await harness.api.handler("tool_result")(
    toolResult("pindie_task_handoff", false, "handoff-async-preflight"),
    context("/repo"),
  );
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  assert.equal(experienceStore.records[0]!.experience.execution.deniedCalls, 0);
});

test("handoff requires coherent active Task authority", async () => {
  for (const state of [EMPTY_STATE, blockedState(), gatedState(), completedState()]) {
    const harness = createHarness([["/repo", state]], {}, { enableTaskHandoff: true });
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const denied = await callGuard(harness, toolCall("pindie_task_handoff", handoffInput()));
    assert.equal(denied.block, true);
    assert.match(denied.reason, /coherent|active|capability/i);
  }
});

test("handoff admission arms a terminal latch before later observation or project calls", async () => {
  const experienceStore = new ExtensionTestExperienceStore();
  const harness = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    experienceStore,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", handoffInput(), "handoff-first")), undefined);
  const observation = await callGuard(harness, toolCall("read", {}, "read-after-handoff"));
  const project = await callGuard(harness, toolCall("edit", {}, "edit-after-handoff"));
  assert.equal(observation.block, true);
  assert.equal(project.block, true);
  assert.match(observation.reason, /terminal work frontier/i);
  assert.match(project.reason, /terminal work frontier/i);

  await harness.api.handler("tool_result")(
    toolResult("pindie_task_handoff", true, "handoff-first"),
    context("/repo"),
  );
  assert.equal(await callGuard(harness, toolCall("edit", {}, "edit-after-failed-handoff")), undefined);
  await harness.api.handler("tool_result")(
    toolResult("edit", true, "edit-after-failed-handoff"),
    context("/repo"),
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(experienceStore.records[0]!.experience.execution.deniedCalls, 0);
});

test("stale Session, Run, Task, and pending-message settlement guards never commit a checkpoint", async () => {
  const staleSessionStore = new ExtensionTestContinuityStore();
  const staleSession = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    continuityStore: staleSessionStore,
  });
  await startSession(staleSession, "/repo");
  await beginAgentRun(staleSession);
  assert.equal(await callGuard(staleSession, toolCall("pindie_task_handoff", handoffInput(), "stale-session-handoff")), undefined);
  await staleSession.api.tool("pindie_task_handoff").execute("stale-session-handoff", handoffInput());
  await staleSession.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "stale-session-handoff"), context("/repo"));
  await staleSession.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", [], false, "different-session"));
  assert.equal(staleSessionStore.records.length, 0);

  const staleRunStore = new ExtensionTestContinuityStore();
  const staleRun = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    continuityStore: staleRunStore,
  });
  await startSession(staleRun, "/repo");
  await beginAgentRun(staleRun);
  assert.equal(await callGuard(staleRun, toolCall("pindie_task_handoff", handoffInput(), "stale-run-handoff")), undefined);
  await staleRun.api.tool("pindie_task_handoff").execute("stale-run-handoff", handoffInput());
  await staleRun.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "stale-run-handoff"), context("/repo"));
  await beginAgentRun(staleRun);
  await staleRun.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(staleRunStore.records.length, 0);

  const mismatchStore = new ExtensionTestContinuityStore();
  const mismatch = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    continuityStore: mismatchStore,
  });
  await startSession(mismatch, "/repo");
  await beginAgentRun(mismatch);
  assert.equal(await callGuard(mismatch, toolCall("pindie_task_handoff", handoffInput(), "mismatch-handoff")), undefined);
  await mismatch.api.tool("pindie_task_handoff").execute("mismatch-handoff", handoffInput());
  await mismatch.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "mismatch-handoff"), context("/repo"));
  mismatch.store.states.set("/repo", activeState("A different Task"));
  await mismatch.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(mismatchStore.records.length, 0);

  const pendingMessageStore = new ExtensionTestContinuityStore();
  const pendingMessage = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    continuityStore: pendingMessageStore,
  });
  await startSession(pendingMessage, "/repo");
  await beginAgentRun(pendingMessage);
  assert.equal(await callGuard(pendingMessage, toolCall("pindie_task_handoff", handoffInput(), "pending-message-handoff")), undefined);
  await pendingMessage.api.tool("pindie_task_handoff").execute("pending-message-handoff", handoffInput());
  await pendingMessage.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "pending-message-handoff"), context("/repo"));
  await pendingMessage.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", [], true));
  assert.equal(pendingMessageStore.records.length, 0);
});

test("continuity persistence failure clears only handoff runtime state and leaves Task truth valid", async () => {
  const continuityStore = new ExtensionTestContinuityStore();
  continuityStore.saveError = new Error("continuity disk unavailable");
  const harness = createHarness([["/repo", activeState()]], {}, {
    enableTaskHandoff: true,
    continuityStore,
  });
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const input = handoffInput("Continue after failed checkpoint");
  assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "failed-persistence-handoff")), undefined);
  await harness.api.tool("pindie_task_handoff").execute("failed-persistence-handoff", input);
  await harness.api.handler("tool_result")(toolResult("pindie_task_handoff", false, "failed-persistence-handoff"), context("/repo"));
  await assert.doesNotReject(harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo")));
  assert.equal(continuityStore.records.length, 0);
  assert.equal(harness.integration.runtime.state.task?.openLoops.nextIntent, input.nextIntent);
  assert.equal(harness.store.states.get("/repo")?.task?.openLoops.nextIntent, input.nextIntent);
  assert.equal(harness.integration.stateUnavailableReason, null);
});

test("Slice C observer timeout settles the Run and late Experience cannot clear a newer Trial", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const candidate = trialCandidate();
  const experienceStore = new HangingExperienceStore();
  const harness = createHarness([["/repo", activeState("observer liveness")]], {}, {
    experienceStore,
    strategyCandidateReader: { read: async () => candidate },
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(harness);
  assert.equal(harness.integration.trial.hasActiveTrial, true);
  await captureObservationEvidence(harness, "observer-liveness");

  const oldSettlement = harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  await experienceStore.saveStarted;
  assert.equal(harness.integration.trial.hasTrial, false, "SI cleanup must precede Experience persistence");

  await harness.api.commands.get("trial").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(harness);
  assert.equal(harness.integration.trial.hasActiveTrial, true);

  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await oldSettlement;
  assert.equal(harness.integration.core.run.hasActiveAgentRun, true);

  experienceStore.releaseSave();
  await experienceStore.saveFinished;
  await nextTurn();
  assert.equal(harness.integration.trial.hasActiveTrial, true);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice C continuity timeout clears the old handoff and suppresses late Host rollover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let published = 0;
  const releasePublisher = installCommittedRolloverReceiver(() => { published += 1; });
  try {
    const continuityStore = new HangingContinuityStore();
    const harness = createHarness([["/repo", activeState("continuity liveness")]], {}, {
      enableTaskHandoff: true,
      continuityStore,
    });
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    const input = handoffInput("Continue after bounded continuity");
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "continuity-liveness")), undefined);
    await harness.api.tool("pindie_task_handoff").execute("continuity-liveness", input);
    await harness.api.handler("tool_result")(
      toolResult("pindie_task_handoff", false, "continuity-liveness"),
      context("/repo"),
    );

    const oldSettlement = harness.api.handler("agent_settled")(
      { type: "agent_settled" },
      context("/repo"),
    );
    await continuityStore.saveStarted;
    t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
    await oldSettlement;
    assert.equal(published, 0);
    assert.equal(harness.integration.core.handoff.pendingHandoff, null);
    assert.equal(harness.integration.core.run.hasActiveAgentRun, false);

    await beginAgentRun(harness);
    const nextInput = handoffInput("Keep the newer handoff");
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", nextInput, "new-continuity-handoff")), undefined);
    await harness.api.tool("pindie_task_handoff").execute("new-continuity-handoff", nextInput);
    await harness.api.handler("tool_result")(
      toolResult("pindie_task_handoff", false, "new-continuity-handoff"),
      context("/repo"),
    );
    assert.equal(harness.integration.core.handoff.pendingHandoff?.sourceSessionId, "remote-session");

    continuityStore.releaseSave();
    await continuityStore.saveFinished;
    await nextTurn();
    assert.equal(published, 0);
    assert.equal(harness.integration.core.handoff.pendingHandoff?.progressSummary, nextInput.progressSummary);
    harness.integration.core.handoff.clear();
    await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  } finally {
    releasePublisher();
  }
});

test("SI v0.6 /promote creates one immutable Decision and normal Runs explicitly attribute promoted Policy", async () => {
  const promotedCandidate = trialCandidate();
  const competingCandidate = trialCandidate("00000000-0000-4000-8000-000000000002");
  const rejectedCandidate = trialCandidate("00000000-0000-4000-8000-000000000003", "direct-action");
  const candidates = new Map([
    [promotedCandidate.candidateId, promotedCandidate],
    [competingCandidate.candidateId, competingCandidate],
    [rejectedCandidate.candidateId, rejectedCandidate],
  ]);
  const candidateReader = {
    read: async (_root: string, candidateId: string) => candidates.get(candidateId) ?? null,
  };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: [
      { recordId: "trial-one", experience: commandExperience("shared goal", candidatePolicy(promotedCandidate)) },
      { recordId: "trial-two", experience: commandExperience("shared goal", candidatePolicy(promotedCandidate)) },
      { recordId: "competing-one", experience: commandExperience("competing goal", candidatePolicy(competingCandidate)) },
      { recordId: "competing-two", experience: commandExperience("competing goal", candidatePolicy(competingCandidate)) },
      { recordId: "seed", experience: commandExperience("shared goal", createPolicySnapshot({ approach: "architecture-first" })) },
      { recordId: "direct-seed", experience: commandExperience("direct goal", createPolicySnapshot({ approach: "direct-action" })) },
    ],
    loadedRecords: 6,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const decisions = testDecisionStore();
  const harness = createHarness([["/repo", activeState("Promotion task")]], {}, {
    experienceReader,
    strategyCandidateReader: candidateReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    now: () => Date.parse("2026-02-01T00:00:00.000Z"),
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const stateBefore = structuredClone(harness.integration.runtime.state);

  await harness.api.commands.get("promote").handler(promotedCandidate.candidateId, commandContext);
  assert.equal(decisions.decisions.size, 1);
  const promotedDecision = decisions.decisions.get(promotedCandidate.candidateId)!;
  assert.equal(promotedDecision.decision, "promoted");
  assert.deepEqual(promotedDecision.evidence.trialRecordIds, ["trial-one", "trial-two"]);
  assert.match(notices.at(-1)?.message ?? "", /promoted.*explicit normal Policy selection/i);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, []);

  await harness.api.commands.get("promote").handler(promotedCandidate.candidateId, commandContext);
  assert.match(notices.at(-1)?.message ?? "", /terminal Decision|duplicate|conflicting/i);
  await harness.api.commands.get("promote").handler(competingCandidate.candidateId, commandContext);
  assert.match(notices.at(-1)?.message ?? "", /already has one promoted/i);
  assert.equal(decisions.decisions.size, 1);

  const normalBaseline = await harnessBeforeAgentStart(harness);
  assert.match(normalBaseline.systemPrompt, /<PINDIE_PROMOTED_STRATEGIES>/);
  assert.match(normalBaseline.systemPrompt, new RegExp(promotedCandidate.candidateId));
  assert.match(normalBaseline.systemPrompt, /Revision status: promoted/);
  assert.doesNotMatch(normalBaseline.systemPrompt, new RegExp(competingCandidate.candidateId));
  const selector = {
    strategyId: promotedCandidate.target.strategyId,
    revisionIdentity: promotedCandidate.candidateId,
    revisionFingerprint: strategyCandidateSemanticFingerprint(promotedCandidate),
  };
  await executeSemanticTool(harness, "pindie_policy_set", "promoted-policy", { approach: selector });
  assert.equal(harness.integration.policySnapshot?.approach.revisionIdentity, promotedCandidate.candidateId);
  assert.equal(harness.integration.policySnapshot?.approach.revisionStatusAtRun, "promoted");
  await captureObservationEvidence(harness, "promoted-observation");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  const promotedExperience = (harness.experienceStore as ExtensionTestExperienceStore).records.at(-1)?.experience;
  assert.equal(promotedExperience?.schemaVersion, 4);
  assert.equal(promotedExperience?.policy.finalSnapshot?.approach.revisionIdentity, promotedCandidate.candidateId);
  assert.equal(promotedExperience?.policy.finalSnapshot?.approach.revisionStatusAtRun, "promoted");

  await beginAgentRun(harness);
  await executeSemanticTool(harness, "pindie_policy_set", "seed-policy-after-promotion", { approach: "architecture-first" });
  assert.equal(harness.integration.policySnapshot?.approach.revisionIdentity, "seed");
  assert.equal(harness.integration.policySnapshot?.approach.revisionStatusAtRun, "seed");
  await captureObservationEvidence(harness, "seed-observation-after-promotion");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.7 CPL-off local Derived promotion uses the shared writer lock for final strict revalidation and write", async () => {
  const candidate = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000201",
    "boundary-first",
  );
  const records = derivationPromotionRecords(candidate);
  let lockDepth = 0;
  let lockCalls = 0;
  let candidateReadsInsideLock = 0;
  let decisionReadsInsideLock = 0;
  let globalReadsInsideLock = 0;
  let decisionWritesInsideLock = 0;
  const derivationCandidates = {
    read: async (_root: string, candidateId: string) => {
      if (lockDepth > 0) candidateReadsInsideLock += 1;
      return candidateId === candidate.candidateId ? candidate : null;
    },
    readAll: async () => [candidate],
  };
  const derivationDecisionMap = new Map<string, StrategyDerivationDecision>();
  const derivationDecisions = {
    read: async (_root: string, candidateId: string) => {
      if (lockDepth > 0) decisionReadsInsideLock += 1;
      return derivationDecisionMap.get(candidateId) ?? null;
    },
    readAll: async () => [...derivationDecisionMap.values()],
    save: async (_root: string, decision: StrategyDerivationDecision) => {
      if (lockDepth > 0) decisionWritesInsideLock += 1;
      if (derivationDecisionMap.has(decision.candidateId)) throw new Error("terminal Decision already exists");
      derivationDecisionMap.set(decision.candidateId, decision);
    },
  };
  const emptyScope: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => {
      if (lockDepth > 0) globalReadsInsideLock += 1;
      return [];
    },
    save: async () => undefined,
  };
  const emptyScopeDecisions: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const writerLock = {
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      lockDepth += 1;
      try {
        return await operation();
      } finally {
        lockDepth -= 1;
      }
    },
  };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records,
    loadedRecords: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const harness = createHarness([["/repo", activeState("Derived promotion")]], {}, {
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    experienceReader,
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDecisionStore: testDecisionStore(),
    strategyDecisionReader: testDecisionStore(),
    strategyDerivationCandidateReader: derivationCandidates,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyDerivationDecisionStore: derivationDecisions,
    strategyTrustScopeCandidateStore: emptyScope,
    strategyTrustScopeDecisionStore: emptyScopeDecisions,
    strategyTrustScopeSourceResolver: { resolve: async () => { throw new Error("not reached"); } },
    strategyTrustScopeWriterLock: writerLock,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("promote").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });

  assert.equal(lockCalls, 1);
  assert.equal(candidateReadsInsideLock > 0, true);
  assert.equal(decisionReadsInsideLock > 0, true);
  assert.equal(globalReadsInsideLock > 0, true);
  assert.equal(decisionWritesInsideLock, 1);
  assert.equal(derivationDecisionMap.get(candidate.candidateId)?.decision, "promoted");
  assert.match(notices.at(-1)?.message ?? "", /promoted.*explicit normal Policy selection/i);
});

test("SI v0.7 CPL-off local Derived promotion fails when a valid global revision owns the logical ID", async () => {
  const scope = scopeTrialTestDependencies();
  const globalDecision = promotedGlobalScopeDecision(scope.scopeCandidate);
  const localCandidate = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000202",
    "boundary-first",
  );
  const localDecisions = new Map<string, StrategyDerivationDecision>();
  const localDecisionStore = {
    read: async (_root: string, candidateId: string) => localDecisions.get(candidateId) ?? null,
    readAll: async () => [...localDecisions.values()],
    save: async (_root: string, decision: StrategyDerivationDecision) => {
      localDecisions.set(decision.candidateId, decision);
    },
  };
  const globalDecisionStore: StrategyTrustScopeDecisionStore = {
    read: async (candidateId) => candidateId === globalDecision.candidateId ? globalDecision : null,
    readAll: async () => [globalDecision],
    save: async () => { throw new Error("global Decision is immutable in this test"); },
  };
  const localCandidates = {
    read: async (_root: string, candidateId: string) =>
      candidateId === localCandidate.candidateId ? localCandidate : null,
    readAll: async () => [localCandidate],
  };
  const emptyRevisionReader = { read: async () => null, readAll: async () => [] };
  const harness = createHarness([["/repo", activeState("Global conflict")]], {}, {
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    experienceReader: Object.assign(new ExtensionTestExperienceReader(), {
      result: {
        records: derivationPromotionRecords(localCandidate),
        loadedRecords: 5,
        unsupportedSchema: 0,
        invalid: 0,
      },
    }),
    strategyCandidateReader: emptyRevisionReader,
    strategyDecisionStore: testDecisionStore(),
    strategyDecisionReader: testDecisionStore(),
    strategyDerivationCandidateReader: localCandidates,
    strategyDerivationDecisionReader: localDecisionStore,
    strategyDerivationDecisionStore: localDecisionStore,
    strategyTrustScopeCandidateStore: scope.globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionStore,
    strategyTrustScopeSourceResolver: scope.sourceResolver,
    strategyTrustScopeWriterLock: { withLock: async <T>(operation: () => Promise<T>) => operation() },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("promote").handler(localCandidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });

  assert.equal(localDecisions.size, 0);
  assert.deepEqual(await globalDecisionStore.readAll(), [globalDecision]);
  assert.match(notices.at(-1)?.message ?? "", /Promotion Eligibility|trusted portfolio|already trusted|binding/i);
});

test("SI v0.7 CPL-off malformed global authority is presentation-isolated but blocks local Derived promotion", async () => {
  const localCandidate = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000203",
    "malformed-global-check",
  );
  const localDecisions = new Map<string, StrategyDerivationDecision>();
  const localDecisionStore = {
    read: async (_root: string, candidateId: string) => localDecisions.get(candidateId) ?? null,
    readAll: async () => [...localDecisions.values()],
    save: async (_root: string, decision: StrategyDerivationDecision) => {
      localDecisions.set(decision.candidateId, decision);
    },
  };
  const malformedGlobal: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => { throw new Error("malformed global Scope authority"); },
    save: async () => undefined,
  };
  const emptyGlobalDecisions: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const candidateReader = {
    read: async (_root: string, candidateId: string) =>
      candidateId === localCandidate.candidateId ? localCandidate : null,
    readAll: async () => [],
  };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: derivationPromotionRecords(localCandidate),
    loadedRecords: 5,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const harness = createHarness([["/repo", activeState("Malformed global authority")]], {}, {
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    experienceReader,
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDecisionStore: testDecisionStore(),
    strategyDecisionReader: testDecisionStore(),
    strategyDerivationCandidateReader: candidateReader,
    strategyDerivationDecisionReader: localDecisionStore,
    strategyDerivationDecisionStore: localDecisionStore,
    strategyTrustScopeCandidateStore: malformedGlobal,
    strategyTrustScopeDecisionStore: emptyGlobalDecisions,
    strategyTrustScopeSourceResolver: { resolve: async () => { throw new Error("global source unavailable"); } },
  });
  await startSession(harness, "/repo");
  const strategyNotices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("strategies").handler("", {
    ...context("/repo"),
    ui: { notify: (message: string, type: string) => strategyNotices.push({ message, type }) },
  });
  assert.doesNotMatch(strategyNotices.at(-1)?.message ?? "", /Optional user-global layer: unavailable/);
  assert.doesNotMatch(strategyNotices.at(-1)?.message ?? "", /user-global/);
  assert.match(strategyNotices.at(-1)?.message ?? "", /Trusted Strategy Portfolio/);

  const promotionNotices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("promote").handler(localCandidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => promotionNotices.push({ message, type }) },
  });
  assert.equal(localDecisions.size, 0);
  assert.match(promotionNotices.at(-1)?.message ?? "", /trusted Strategy portfolio could not be validated|no trust transition/i);
});

test("SI v0.7 CPL-off unrelated local Derived promotion remains valid with coherent global authority", async () => {
  const candidate = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000205",
    "unrelated-local",
  );
  const localDecisions = new Map<string, StrategyDerivationDecision>();
  const localDecisionStore = {
    read: async (_root: string, candidateId: string) => localDecisions.get(candidateId) ?? null,
    readAll: async () => [...localDecisions.values()],
    save: async (_root: string, decision: StrategyDerivationDecision) => {
      if (localDecisions.has(decision.candidateId)) throw new Error("terminal Decision already exists");
      localDecisions.set(decision.candidateId, decision);
    },
  };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: derivationPromotionRecords(candidate),
    loadedRecords: 5,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const emptyScope = emptyScopeAuthority();
  const harness = createHarness([["/repo", activeState("Unrelated local promotion")]], {}, {
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    experienceReader,
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDecisionStore: testDecisionStore(),
    strategyDecisionReader: testDecisionStore(),
    strategyDerivationCandidateReader: {
      read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
      readAll: async () => [candidate],
    },
    strategyDerivationDecisionReader: localDecisionStore,
    strategyDerivationDecisionStore: localDecisionStore,
    strategyTrustScopeCandidateStore: emptyScope.candidateStore,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
    strategyTrustScopeWriterLock: { withLock: async <T>(operation: () => Promise<T>) => operation() },
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  await harness.api.commands.get("promote").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(localDecisions.get(candidate.candidateId)?.decision, "promoted");
  assert.match(notices.at(-1)?.message ?? "", /promoted.*explicit normal Policy selection/i);
});

test("SI v0.7 shared writer lock serializes local and global same-ID trust transitions", async () => {
  const scope = scopeTrialTestDependencies();
  const localCandidate = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000204",
    "boundary-first",
  );
  const localDecisions = new Map<string, StrategyDerivationDecision>();
  const localDecisionStore = {
    read: async (_root: string, candidateId: string) => localDecisions.get(candidateId) ?? null,
    readAll: async () => [...localDecisions.values()],
    save: async (_root: string, decision: StrategyDerivationDecision) => {
      if (localDecisions.has(decision.candidateId)) throw new Error("terminal Decision already exists");
      localDecisions.set(decision.candidateId, decision);
    },
  };
  const globalDecisions = new Map<string, StrategyTrustScopeDecisionV1>();
  let markGlobalSaveEntered!: () => void;
  let releaseGlobalSave!: () => void;
  const globalSaveEntered = new Promise<void>((resolve) => { markGlobalSaveEntered = resolve; });
  const globalSaveRelease = new Promise<void>((resolve) => { releaseGlobalSave = resolve; });
  let pauseGlobalSave = true;
  const globalDecisionStore: StrategyTrustScopeDecisionStore = {
    read: async (candidateId) => globalDecisions.get(candidateId) ?? null,
    readAll: async () => [...globalDecisions.values()],
    save: async (decision) => {
      if (pauseGlobalSave) {
        pauseGlobalSave = false;
        markGlobalSaveEntered();
        await globalSaveRelease;
      }
      if (globalDecisions.has(decision.candidateId)) throw new Error("terminal Scope Decision already exists");
      globalDecisions.set(decision.candidateId, decision);
    },
  };
  const localCandidateReader = {
    read: async (_root: string, candidateId: string) =>
      candidateId === localCandidate.candidateId ? localCandidate : null,
    readAll: async () => [localCandidate],
  };
  const emptyRevisionReader = { read: async () => null, readAll: async () => [] };
  const sourceTrialPolicy = derivationTrialPolicy(scope.sourceCandidate);
  const sourceProjectId = scope.sourceCandidate.projectId;
  const localProjectId = getProjectId("/repo");
  const targetAProjectId = getProjectId("/scope-target-a");
  const targetBProjectId = getProjectId("/scope-target-b");
  const targetRecords = new Map<string, readonly { readonly recordId: string; readonly experience: RunExperience }[]>([
    [targetAProjectId, [{
      recordId: "11111111-1111-4111-8111-111111111111.json",
      experience: commandExperience("scope target a", sourceTrialPolicy),
    }]],
    [targetBProjectId, [{
      recordId: "22222222-2222-4222-8222-222222222222.json",
      experience: commandExperience("scope target b", sourceTrialPolicy),
    }]],
  ]);
  const projectIds = [sourceProjectId, localProjectId, targetAProjectId, targetBProjectId];
  const crossProjectExperienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => projectIds,
    readProjectId: async (projectId) => {
      const records = targetRecords.get(projectId) ?? [];
      return {
        records,
        loadedRecords: records.length,
        unsupportedSchema: 0,
        invalid: 0,
      };
    },
  };
  const projectTrustReader = {
    readProjectId: async (projectId: string) => ({
      projectId,
      promotedDerived: [...localDecisions.values()]
        .filter((decision) => decision.decision === "promoted" && decision.projectId === projectId)
        .map((decision) => ({
          strategyId: decision.strategy.strategyId,
          kind: decision.strategy.kind,
          revisionIdentity: decision.candidateId,
          revisionFingerprint: decision.candidateFingerprint,
        })),
    }),
  };
  let lockCalls = 0;
  let markSecondLockRequested!: () => void;
  const secondLockRequested = new Promise<void>((resolve) => { markSecondLockRequested = resolve; });
  let lockTail = Promise.resolve();
  const sharedWriterLock = {
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      if (lockCalls === 2) markSecondLockRequested();
      const prior = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: derivationPromotionRecords(localCandidate),
    loadedRecords: 5,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const harness = createHarness([["/repo", activeState("Serialized trust transitions")]], {}, {
    experienceReader,
    crossProjectExperienceReader,
    scopeProjectTrustReader: projectTrustReader,
    strategyCandidateReader: emptyRevisionReader,
    strategyDecisionStore: testDecisionStore(),
    strategyDecisionReader: testDecisionStore(),
    strategyDerivationCandidateReader: localCandidateReader,
    strategyDerivationDecisionReader: localDecisionStore,
    strategyDerivationDecisionStore: localDecisionStore,
    strategyTrustScopeCandidateStore: scope.globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionStore,
    strategyTrustScopeSourceResolver: scope.sourceResolver,
    strategyTrustScopeWriterLock: sharedWriterLock,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const promote = harness.api.commands.get("promote");
  const globalPromotion = promote.handler(`scope:${scope.scopeCandidate.candidateId}`, commandContext);
  await globalSaveEntered;

  const localPromotion = promote.handler(localCandidate.candidateId, commandContext);
  await secondLockRequested;
  assert.equal(localDecisions.size, 0);

  releaseGlobalSave();
  await globalPromotion;
  await localPromotion;

  assert.equal(lockCalls, 2);
  assert.equal(globalDecisions.get(scope.scopeCandidate.candidateId)?.decision, "promoted");
  assert.equal(localDecisions.size, 0);
  assert.equal([...globalDecisions.values()].length + localDecisions.size, 1);
  assert.match(notices.at(-1)?.message ?? "", /Derived trust revalidation|no trust transition/i);
});

test("SI v0.6 /promote enforces the exact gate while /reject remains explicit and unavailable in normal Policy", async () => {
  const candidate = trialCandidate();
  const candidateReader = { read: async () => candidate };
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: [{ recordId: "one-trial", experience: commandExperience("one goal", candidatePolicy(candidate)) }],
    loadedRecords: 1,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const decisions = testDecisionStore();
  const harness = createHarness([["/repo", activeState("Rejection task")]], {}, {
    experienceReader,
    strategyCandidateReader: candidateReader,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const stateBefore = structuredClone(harness.integration.runtime.state);

  await harness.api.commands.get("promote").handler(candidate.candidateId, commandContext);
  assert.equal(decisions.decisions.size, 0);
  assert.match(notices.at(-1)?.message ?? "", /exact Promotion Eligibility gate|at least 2|Seed baseline/i);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);

  await harness.api.commands.get("reject").handler(candidate.candidateId, commandContext);
  assert.equal(decisions.decisions.get(candidate.candidateId)?.decision, "rejected");
  assert.deepEqual(decisions.decisions.get(candidate.candidateId)?.evidence.trialRecordIds, ["one-trial"]);
  assert.match(notices.at(-1)?.message ?? "", /rejected.*historical hypothesis|preserves/i);
  assert.deepEqual(harness.store.saves, []);

  const baseline = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(baseline.systemPrompt, new RegExp(candidate.candidateId));
  const selector = {
    strategyId: candidate.target.strategyId,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyCandidateSemanticFingerprint(candidate),
  };
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute("rejected-selector", { approach: selector }, undefined, undefined, context("/repo")),
    /without an active Candidate Trial|unavailable|promoted/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("SI v0.6 trust read/write failures fall back to Seeds and never alter Task authority", async () => {
  const candidate = trialCandidate();
  const experienceReader = new ExtensionTestExperienceReader();
  experienceReader.result = {
    records: [{ recordId: "trial-one", experience: commandExperience("one goal", candidatePolicy(candidate)) }],
    loadedRecords: 1,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const brokenReader: StrategyRevisionDecisionStore = {
    read: async () => null,
    readAll: async () => { throw new Error("trust disk unavailable"); },
    save: async () => { throw new Error("trust disk unavailable"); },
  };
  const harness = createHarness([["/repo", activeState("Trust isolation")]], {}, {
    experienceReader,
    strategyCandidateReader: { read: async () => candidate },
    strategyDecisionStore: brokenReader,
    strategyDecisionReader: brokenReader,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const stateBefore = structuredClone(harness.integration.runtime.state);
  await harness.api.commands.get("reject").handler(candidate.candidateId, {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.match(notices.at(-1)?.message ?? "", /trust Decision storage|no trust transition/i);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, []);
  const baseline = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(baseline.systemPrompt, /<PINDIE_PROMOTED_STRATEGIES>/);
  assert.equal(harness.integration.stateUnavailableReason, null);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice A /trust-transfer is meaning-first, source-bound, and does not start a Run or mutate local State", async () => {
  const artifacts = trustedStrategyCommandArtifacts();
  const revisionReader = { read: async () => null, readAll: async () => [] };
  const derivationReader = {
    read: async (_root: string, id: string) => id === artifacts.promotedDerivedCandidate.candidateId
      ? artifacts.promotedDerivedCandidate
      : null,
    readAll: async () => [artifacts.promotedDerivedCandidate],
  };
  const revisionDecisions = testDecisionStore();
  const derivationDecisions = testDerivationDecisionReader([artifacts.promotedDerivedDecision]);
  const globalCandidates: any[] = [];
  const globalCandidateStore = {
    read: async (_id: string) => null,
    readAll: async () => globalCandidates,
    save: async (candidate: any) => { globalCandidates.push(candidate); },
  };
  const globalDecisionStore = { read: async () => null, readAll: async () => [] };
  let lockCalls = 0;
  const sourceResolver = {
    resolve: async (source: any) => ({
      sourceStrategy: source,
      candidate: artifacts.promotedDerivedCandidate,
      decision: artifacts.promotedDerivedDecision,
      selection: {} as any,
      promotedDerivedCatalog: {} as any,
    }),
  };
  const harness = createHarness([["/repo", activeState("Trust transfer")]], {}, {
    strategyCandidateReader: revisionReader,
    strategyDerivationCandidateReader: derivationReader,
    strategyDecisionStore: revisionDecisions,
    strategyDecisionReader: revisionDecisions,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyTrustScopeCandidateStore: globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionStore,
    strategyTrustScopeSourceResolver: sourceResolver,
    strategyTrustScopeWriterLock: { withLock: async (operation: any) => { lockCalls += 1; return operation(); } },
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("trust-transfer");
  assert.ok(command);
  const options = await command.getArgumentCompletions("");
  assert.equal(options?.length, 1);
  assert.equal(options?.[0]?.value, "delivery-checkpoints");
  assert.match(options?.[0]?.label ?? "", /modifier.*promoted.*project-local trusted Derived Strategy/i);
  assert.doesNotMatch(options?.[0]?.label ?? "", new RegExp(artifacts.promotedDerivedCandidate.candidateId));

  const notices: Array<{ message: string; type: string }> = [];
  const stateBefore = structuredClone(harness.integration.runtime.state);
  await command.handler("delivery-checkpoints", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(globalCandidates.length, 1);
  assert.equal(lockCalls, 1);
  assert.equal(harness.api.sentUserMessages.length, 0);
  assert.equal(harness.experienceStore.records.length, 0);
  assert.deepEqual(harness.store.saves, []);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.equal(harness.integration.policySnapshot, null);
  assert.match(notices.at(-1)?.message ?? "", /delivery-checkpoints.*modifier.*revision.*22222222.*project-local trusted Derived Strategy.*user-global trust/i);
});

test("Scope Trial global projection failure preserves project-local Trial completion", async () => {
  const candidate = trialCandidate("00000000-0000-4000-8000-000000000061");
  const revisions = {
    read: async (_root: string, candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
    readAll: async () => [candidate],
  };
  const emptyDerivations = { read: async () => null, readAll: async () => [] };
  const decisions = testDecisionStore();
  const brokenScopeCandidates: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => { throw new Error("global Scope namespace unavailable"); },
    save: async () => undefined,
  };
  const brokenScopeDecisions: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => { throw new Error("global Scope namespace unavailable"); },
    save: async () => undefined,
  };
  const harness = createHarness([["/target", activeState("Scope completion isolation")]], {}, {
    strategyCandidateReader: revisions,
    strategyDerivationCandidateReader: emptyDerivations,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyDerivationDecisionReader: testDerivationDecisionReader(),
    strategyTrustScopeCandidateStore: brokenScopeCandidates,
    strategyTrustScopeDecisionStore: brokenScopeDecisions,
    strategyTrustScopeSourceResolver: {
      resolve: async () => { throw new Error("unavailable"); },
    },
  });
  await startSession(harness, "/target");

  const options = await harness.api.commands.get("trial").getArgumentCompletions("");
  assert.ok(options);
  assert.equal(options!.some((option: any) => option.value === candidate.candidateId), true);
  assert.equal(options!.some((option: any) => String(option.value).startsWith("scope:")), false);
});

test("Slice B Scope Trial dispatches through the shared lease and preserves source revision attribution", async () => {
  const sourcePortfolio = createTrustedStrategyPortfolio(
    "/source",
    createPromotedStrategyRevisionCatalog([]),
  );
  const sourceCandidate = derivationTrialCandidate(
    "33333333-0000-4000-8000-000000000051",
    sourcePortfolio,
  );
  const sourceDecision = createStrategyDerivationDecision({
    candidate: sourceCandidate,
    decision: "promoted",
    trialRecordIds: ["source-trial-one", "source-trial-two"],
    decidedAt: "2026-03-01T00:00:00.000Z",
  });
  const sourceSelection = createStrategyRevisionSelection({
    strategyId: sourceCandidate.proposal.strategyId,
    kind: sourceCandidate.proposal.kind,
    revisionIdentity: sourceCandidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(sourceCandidate),
    revisionStatusAtRun: "promoted",
    semantics: sourceCandidate.proposal,
  });
  const sourceCatalog = createPromotedDerivedStrategyCatalog([{
    candidate: sourceCandidate,
    decision: sourceDecision,
    selection: sourceSelection,
  }]);
  const scopeCandidate = createStrategyTrustScopeCandidate({
    candidateId: "44444444-0000-4000-8000-000000000052",
    sourceStrategy: {
      sourceProjectId: sourceCandidate.projectId,
      strategyId: sourceCandidate.proposal.strategyId,
      kind: sourceCandidate.proposal.kind,
      revisionIdentity: sourceCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(sourceCandidate),
    },
    createdAt: "2026-03-02T00:00:00.000Z",
  });
  const globalCandidates = [scopeCandidate];
  const globalCandidateStore: StrategyTrustScopeCandidateStore = {
    read: async (candidateId) => globalCandidates.find((candidate) => candidate.candidateId === candidateId) ?? null,
    readAll: async () => [...globalCandidates],
    save: async (candidate) => { globalCandidates.push(candidate); },
  };
  const globalDecisionStore: StrategyTrustScopeDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async (sourceStrategy) => ({
      sourceStrategy,
      candidate: sourceCandidate,
      decision: sourceDecision,
      selection: sourceSelection,
      promotedDerivedCatalog: sourceCatalog,
    }),
  };
  const emptyRevisionReader = { read: async () => null, readAll: async () => [] };
  const emptyDerivationReader = { read: async () => null, readAll: async () => [] };
  const harness = createHarness([["/target", activeState("Scope Trial task")]], {}, {
    strategyCandidateReader: emptyRevisionReader,
    strategyDerivationCandidateReader: emptyDerivationReader,
    strategyDecisionStore: testDecisionStore(),
    strategyTrustScopeCandidateStore: globalCandidateStore,
    strategyTrustScopeDecisionStore: globalDecisionStore,
    strategyTrustScopeSourceResolver: sourceResolver,
  });
  await startSession(harness, "/target");

  const command = harness.api.commands.get("trial");
  const options = await command.getArgumentCompletions("");
  const scopeValue = `scope:${scopeCandidate.candidateId}`;
  assert.equal(options?.some((option: any) => option.value === scopeValue), true);
  assert.match(options?.find((option: any) => option.value === scopeValue)?.label ?? "", /boundary-first.*source.*promoted.*Scope Trial/i);

  const notices: Array<{ message: string; type: string }> = [];
  await command.handler(scopeValue, {
    ...context("/target"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(harness.integration.trial.hasPendingScopeTrial, true);
  assert.equal(harness.api.sentUserMessages.length, 0);
  assert.match(notices.at(-1)?.message ?? "", /Scope Trial armed/i);

  const runStart = await harnessBeforeAgentStart(harness);
  assert.match(runStart.systemPrompt, /<PINDIE_SCOPE_TRIAL_PACKET>/);
  assert.match(runStart.systemPrompt, /current trust scope: project/i);
  assert.match(runStart.systemPrompt, /proposed trust scope: user-global/i);
  assert.doesNotMatch(runStart.systemPrompt, /sourceRecordIds|source-trial-one/);
  assert.equal(harness.integration.trial.hasActiveScopeTrial, true);
  const selection = harness.integration.trial.activeScopeTrial!.revisionSelection;
  assert.equal(selection.revisionStatusAtRun, "trial");
  await executeSemanticTool(harness, "pindie_policy_set", "scope-trial-policy", {
    approach: {
      strategyId: selection.strategyId,
      revisionIdentity: selection.revisionIdentity,
      revisionFingerprint: selection.revisionFingerprint,
    },
  });
  await captureObservationEvidence(harness, "scope-trial-observation");
  const boundary = await harness.api.handler("agent_before_settle")(beforeSettle(), context("/target"));
  assert.equal(boundary.continue, true);
  assert.deepEqual(boundary.entries, [{
    type: "custom_message", customType: PINDIE_CONTINUATION_PROBE_TYPE,
    content: PINDIE_CONTINUATION_PROBE_MESSAGE, display: false,
  }]);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/target"));

  assert.equal(harness.integration.trial.hasTrial, false);
  const record = (harness.experienceStore as ExtensionTestExperienceStore).records[0]!.experience;
  const final = record.policy.finalSnapshot!.approach;
  assert.equal(final.strategyId, sourceCandidate.proposal.strategyId);
  assert.equal(final.revisionIdentity, sourceCandidate.candidateId);
  assert.equal(final.revisionFingerprint, strategyDerivationCandidateSemanticFingerprint(sourceCandidate));
  assert.equal(final.revisionStatusAtRun, "trial");
  assert.deepEqual(final.semantics, {
    summary: sourceCandidate.proposal.summary,
    useWhen: sourceCandidate.proposal.useWhen,
    avoidWhen: sourceCandidate.proposal.avoidWhen,
    principles: sourceCandidate.proposal.principles,
  });
  assert.doesNotMatch(JSON.stringify(record), /scopeCandidate|sourceProjectId|trustScope/);

  const subsequentRun = await harnessBeforeAgentStart(harness, "/target");
  assert.doesNotMatch(subsequentRun.systemPrompt, /<PINDIE_SCOPE_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial.hasActiveScopeTrial, false);
  await assert.rejects(
    harness.api.tool("pindie_policy_set").execute(
      "scope-after-settlement",
      { approach: {
        strategyId: selection.strategyId,
        revisionIdentity: selection.revisionIdentity,
        revisionFingerprint: selection.revisionFingerprint,
      } },
      undefined,
      undefined,
      context("/target"),
    ),
    /without an active Candidate Trial/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/target"));

  await command.handler(scopeValue, {
    ...context("/target"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await beginAgentRun(harness, "/target");
  assert.equal(harness.integration.trial.hasActiveScopeTrial, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    context("/target"),
  );
  await startSession(harness, "/target", "new");
  assert.equal(harness.integration.trial.hasTrial, false);
  const postReplacementRun = await harnessBeforeAgentStart(harness, "/target");
  assert.doesNotMatch(postReplacementRun.systemPrompt, /<PINDIE_SCOPE_TRIAL_PACKET>/);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/target"));
});

test("Slice C /trial-review scope is completion-driven, fresh, bounded, and read-only", async () => {
  const dependencies = scopeTrialTestDependencies();
  const source = await dependencies.sourceResolver.resolve(
    dependencies.scopeCandidate.sourceStrategy,
  );
  const trialSelection = createStrategyRevisionSelection({
    strategyId: source.candidate.proposal.strategyId,
    kind: source.candidate.proposal.kind,
    revisionIdentity: source.candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(source.candidate),
    revisionStatusAtRun: "trial",
    semantics: source.candidate.proposal,
  });
  const policy = createPolicySnapshotFromRevisions({
    approach: trialSelection,
  });
  const targetRecord = (recordId: string) => ({
    recordId,
    experience: commandExperience("Scope review evidence", policy),
  });
  const sourceId = source.candidate.projectId;
  const targetAId = getProjectId("/target-a");
  const targetBId = getProjectId("/target-b");
  const crossProjectExperienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => [sourceId, targetAId, targetBId],
    readProjectId: async (projectId) => {
      const records = projectId === targetAId
        ? [targetRecord("11111111-1111-4111-8111-111111111111.json")]
        : projectId === targetBId
          ? [targetRecord("22222222-2222-4222-8222-222222222222.json")]
          : [];
      return { records, loadedRecords: records.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const scopeProjectTrustReader = {
    readProjectId: async (projectId: string) => ({ projectId, promotedDerived: [] }),
  };
  const harness = createHarness([["/target", activeState("Scope review")]], {}, {
    strategyCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDerivationCandidateReader: { read: async () => null, readAll: async () => [] },
    strategyDecisionStore: testDecisionStore(),
    strategyTrustScopeCandidateStore: dependencies.globalCandidateStore,
    strategyTrustScopeDecisionStore: dependencies.globalDecisionStore,
    strategyTrustScopeSourceResolver: dependencies.sourceResolver,
    crossProjectExperienceReader,
    scopeProjectTrustReader,
  });
  await startSession(harness, "/target");
  const command = harness.api.commands.get("trial-review");
  assert.ok(command);
  const options = await command.getArgumentCompletions("scope:");
  assert.equal(options?.length, 1);
  assert.equal(options?.[0]?.value, `scope:${dependencies.scopeCandidate.candidateId}`);
  const notices: Array<{ message: string; type: string }> = [];
  const stateBefore = structuredClone(harness.integration.runtime.state);
  await command.handler(`scope:${dependencies.scopeCandidate.candidateId}`, {
    ...context("/target"),
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  });
  assert.equal(notices.at(-1)?.type, "info");
  assert.match(notices.at(-1)?.message ?? "", /Strategy Trust Transfer Review/);
  assert.match(notices.at(-1)?.message ?? "", /Distinct eligible target projects: 2/);
  assert.match(notices.at(-1)?.message ?? "", /Promotion Eligibility: eligible for Human review/);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.store.saves, []);
  assert.equal(harness.experienceStore.records.length, 0);
});

test("Scope Trial handoff commits normally and automatic rollover does not inherit it", async () => {
  let published: CommittedRolloverRequest | null = null;
  const release = installCommittedRolloverReceiver((request) => {
    published = request;
  });
  try {
    const dependencies = scopeTrialTestDependencies();
    const experienceStore = new ExtensionTestExperienceStore();
    const continuityStore = new ExtensionTestContinuityStore();
    const harness = createHarness([["/target", activeState("Scope rollover task")]], {}, {
      experienceStore,
      continuityStore,
      strategyCandidateReader: { read: async () => null, readAll: async () => [] },
      strategyDerivationCandidateReader: { read: async () => null, readAll: async () => [] },
      strategyDecisionStore: testDecisionStore(),
      strategyTrustScopeCandidateStore: dependencies.globalCandidateStore,
      strategyTrustScopeDecisionStore: dependencies.globalDecisionStore,
      strategyTrustScopeSourceResolver: dependencies.sourceResolver,
    });
    await startSession(harness, "/target");

    const scopeValue = `scope:${dependencies.scopeCandidate.candidateId}`;
    await harness.api.commands.get("trial").handler(scopeValue, {
      ...context("/target"),
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    const firstRun = await harnessBeforeAgentStart(harness, "/target");
    assert.match(firstRun.systemPrompt, /<PINDIE_SCOPE_TRIAL_PACKET>/);
    const selection = harness.integration.trial.activeScopeTrial!.revisionSelection;

    const input = handoffInput("Continue this Scope Trial Task after rollover");
    assert.equal(await callGuard(harness, toolCall("pindie_task_handoff", input, "scope-rollover-handoff")), undefined);
    const handoffResult = await harness.api.tool("pindie_task_handoff").execute(
      "scope-rollover-handoff",
      input,
    );
    assert.equal(handoffResult.terminate, true);
    await harness.api.handler("tool_result")(
      toolResult("pindie_task_handoff", false, "scope-rollover-handoff"),
      context("/target"),
    );
    assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/target")), undefined);
    assert.deepEqual(harness.api.sentMessages, []);
    await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/target"));

    assert.equal(harness.integration.trial.hasTrial, false);
    assert.ok(published);
    assert.equal(published.sourceSessionId, "remote-session");
    assert.equal(continuityStore.records.length, 1);
    assert.equal(published.checkpoint, continuityStore.records[0]!.checkpoint);

    const secondEntries: unknown[] = [];
    await harness.api.handler("session_shutdown")(
      { type: "session_shutdown", reason: "new" },
      context("/target", [], false, "remote-session"),
    );
    await harness.api.handler("session_start")(
      { type: "session_start", reason: "new" },
      context("/target", secondEntries, false, "session-b"),
    );
    const automaticRun = await harness.api.handler("before_agent_start")(
      {
        type: "before_agent_start",
        prompt: "<PINDIE_LONG_TASK_RESUME>Continue the unfinished Task.</PINDIE_LONG_TASK_RESUME>",
        systemPrompt: "",
        systemPromptOptions: {},
      },
      context("/target", secondEntries, false, "session-b"),
    ) as { systemPrompt: string };
    assert.doesNotMatch(automaticRun.systemPrompt, /<PINDIE_SCOPE_TRIAL_PACKET>/);
    assert.equal(harness.integration.trial.hasTrial, false);
    await assert.rejects(
      harness.api.tool("pindie_policy_set").execute(
        "inherited-scope-policy",
        { approach: {
          strategyId: selection.strategyId,
          revisionIdentity: selection.revisionIdentity,
          revisionFingerprint: selection.revisionFingerprint,
        } },
        undefined,
        undefined,
        context("/target", secondEntries, false, "session-b"),
      ),
      /without an active Candidate Trial/i,
    );
    await harness.api.handler("agent_settled")(
      { type: "agent_settled" },
      context("/target", secondEntries, false, "session-b"),
    );
  } finally {
    release();
  }
});

test("Slice B /derive-global admits once, binds one packet-only Run, and settles without Task Experience or continuation", async () => {
  const projectA = getProjectId("/global-synthesis-a");
  const projectB = getProjectId("/global-synthesis-b");
  const records = new Map<string, readonly { recordId: string; experience: RunExperience }[]>([
    [projectA, [
      { recordId: "11111111-1111-4111-8111-111111111111.json", experience: commandExperience("global goal alpha", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "22222222-2222-4222-8222-222222222222.json", experience: commandExperience("global goal beta", createPolicySnapshot({ approach: "explore-first" })) },
    ]],
    [projectB, [
      { recordId: "33333333-3333-4333-8333-333333333333.json", experience: commandExperience("global goal gamma", createPolicySnapshot({ approach: "direct-action" })) },
    ]],
  ]);
  let listCalls = 0;
  let markListed!: () => void;
  let releaseList!: () => void;
  const listed = new Promise<void>((resolve) => { markListed = resolve; });
  const listRelease = new Promise<void>((resolve) => { releaseList = resolve; });
  const crossProjectExperienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => {
      listCalls += 1;
      markListed();
      await listRelease;
      return [projectA, projectB];
    },
    readProjectId: async (projectId) => {
      const projectRecords = records.get(projectId) ?? [];
      return { records: projectRecords, loadedRecords: projectRecords.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader = {
    readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
      projectId,
      createPromotedStrategyRevisionCatalog([]),
    ),
  };
  const candidates: StrategySynthesisCandidateV1[] = [];
  const strategySynthesisCandidateStore: StrategySynthesisCandidateStore = {
    read: async (candidateId) => candidates.find((candidate) => candidate.candidateId === candidateId) ?? null,
    readAll: async () => [...candidates],
    save: async (candidate) => { candidates.push(candidate); },
  };
  const harness = createHarness([["/repo", activeState("Global synthesis task")]], {}, {
    crossProjectExperienceReader,
    crossProjectTrustReader,
    strategySynthesisCandidateStore,
  });
  await startSession(harness, "/repo");
  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  const command = harness.api.commands.get("derive-global");
  assert.ok(command);
  const first = command.handler("", commandContext);
  await listed;
  assert.equal(listCalls, 1);
  await command.handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /another \/derive-global attempt is already pending or active/i);
  assert.equal(listCalls, 1);
  releaseList();
  await first;
  assert.equal(harness.api.sentUserMessages.length, 1);
  assert.equal(harness.integration.globalDerivation?.hasPending, true);

  const stateBefore = structuredClone(harness.integration.runtime.state);
  const runStart = await harnessBeforeAgentStart(harness);
  assert.match(runStart.systemPrompt, /<PINDIE_CROSS_PROJECT_SYNTHESIS_PACKET>/);
  assert.match(runStart.systemPrompt, /<PINDIE_GLOBAL_DERIVATION_RUN>/);
  assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, false);
  assert.equal(harness.integration.globalDerivation?.hasActive, true);
  const input = {
    strategyId: "global-boundary",
    kind: "approach",
    summary: "Compare bounded project evidence before choosing a reusable abstraction.",
    useWhen: ["related work spans multiple project namespaces"],
    avoidWhen: ["one local correction already explains the problem"],
    principles: ["keep comparisons factual", "verify the smallest coherent hypothesis"],
    evidenceHandles: ["E1", "E2", "E3"],
    hypothesis: "Distributed trusted-policy evidence may expose a reusable boundary.",
  };
  const globalToolSurface = [
    ["pindie_strategy_synthesis_candidate_create", true],
    ["read", false],
    ["grep", false],
    ["find", false],
    ["ls", false],
    ["web_search", false],
    ["url_context", false],
    ["pindie_git_observe", false],
    ["bash", false],
    ["edit", false],
    ["write", false],
    ["custom_tool", false],
    ["pindie_policy_set", false],
    ["pindie_memory_capture", false],
    ["pindie_strategy_candidate_create", false],
    ["pindie_strategy_derivation_candidate_create", false],
    ["pindie_task_start", false],
    ["pindie_task_replace", false],
    ["pindie_task_refine", false],
    ["pindie_task_progress", false],
    ["pindie_task_complete", false],
    ["pindie_task_handoff", false],
    ["pindie_gate_open", false],
    ["pindie_gate_resolve", false],
    ["pindie_verification_record", false],
    ["unknown_tool", false],
  ] as const;
  for (const [toolName, allowed] of globalToolSurface) {
    if (allowed) {
      await executeSemanticTool(harness, toolName, "global-allowed-synthesis", input);
      continue;
    }
    assertBlocked(
      await callGuard(harness, toolCall(toolName, {}, `global-block-${toolName}`)),
      /Global Derivation Run is packet-only/,
    );
  }
  assert.equal(candidates.length, 1);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  await assert.rejects(
    harness.api.tool("pindie_strategy_synthesis_candidate_create").execute("global-duplicate", input, undefined, undefined, context("/repo")),
    /already published or is publishing/i,
  );
  assert.equal(candidates.length, 1);
  assert.equal(await harness.api.handler("agent_before_settle")(beforeSettle(), context("/repo")), undefined);
  assert.deepEqual(harness.api.sentMessages, []);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 0);

  const ordinaryRun = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(ordinaryRun.systemPrompt, /<PINDIE_GLOBAL_DERIVATION_RUN>/);
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_synthesis_candidate_create", input, "global-after-settlement")),
    /Derivation or Synthesis Candidate creation requires a live matching lease \(explicit \/derive or \/derive-global Run\).*use \/derive or \/derive-global as appropriate/i,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice C Synthesis Trial uses one normal Task Run, attributes only exact selection, and settles cleanly", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000041");
  const candidates = new Map([[candidate.candidateId, candidate]]);
  const synthesisStore: StrategySynthesisCandidateStore = {
    read: async (candidateId) => candidates.get(candidateId) ?? null,
    readAll: async () => [...candidates.values()],
    save: async (value) => { candidates.set(value.candidateId, value); },
  };
  const localCandidates = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const localDerivationCandidates = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const decisions = testDecisionStore();
  const derivationDecisions = testDerivationDecisionReader();
  const emptyScope = emptyScopeAuthority();
  const crossProjectExperienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => [],
    readProjectId: async () => ({ records: [], loadedRecords: 0, unsupportedSchema: 0, invalid: 0 }),
  };
  const crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader = {
    readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
      projectId,
      createPromotedStrategyRevisionCatalog([]),
    ),
  };
  const harness = createHarness([["/repo", activeState("Synthesis Trial task")]], {}, {
    crossProjectExperienceReader,
    crossProjectTrustReader,
    strategySynthesisCandidateStore: synthesisStore,
    strategyCandidateStore: localCandidates,
    strategyCandidateReader: localCandidates,
    strategyDerivationCandidateStore: localDerivationCandidates,
    strategyDerivationCandidateReader: localDerivationCandidates,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyDerivationDecisionStore: derivationDecisions,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyTrustScopeCandidateStore: emptyScope.candidateStore,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("trial");
  assert.ok(command);
  const subject = synthesisTrialCommandValue(candidate.candidateId);
  const completion = await command.getArgumentCompletions("");
  assert.ok(completion?.some((option: { value: string }) => option.value === subject));

  const notices: Array<{ message: string; type: string }> = [];
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  };
  await command.handler(subject, commandContext);
  assert.equal(harness.integration.trial?.hasPendingSynthesisTrial, true);
  assert.equal(harness.api.sentUserMessages.length, 0);

  const firstRun = await harnessBeforeAgentStart(harness);
  assert.match(firstRun.systemPrompt, /<PINDIE_SYNTHESIS_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial?.hasActiveSynthesisTrial, true);
  // Synthesis Trial is a normal project Run, not the read-only local Trial path.
  assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, true);
  assert.equal(await callGuard(harness, toolCall("read", { path: "src/index.ts" }, "synthesis-read")), undefined);
  assert.equal(await callGuard(harness, toolCall("edit", { path: "src/index.ts" }, "synthesis-edit")), undefined);

  await captureObservationEvidence(harness, "synthesis-no-selection");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 1);
  assert.equal(harness.experienceStore.records[0]!.experience.policy.finalSnapshot, null);
  assert.equal(JSON.stringify(harness.experienceStore.records[0]!.experience).includes("candidateId"), false);

  // A second explicit command is required; merely receiving the packet made no attribution.
  await command.handler(subject, commandContext);
  const secondRun = await harnessBeforeAgentStart(harness);
  assert.match(secondRun.systemPrompt, /<PINDIE_SYNTHESIS_TRIAL_PACKET>/);
  const active = harness.integration.trial!.activeSynthesisTrial!;
  const selector = {
    strategyId: active.revisionSelection.strategyId,
    revisionIdentity: active.revisionSelection.revisionIdentity,
    revisionFingerprint: active.revisionSelection.revisionFingerprint,
  };
  await executeSemanticTool(harness, "pindie_policy_set", "synthesis-policy", {
    approach: selector,
    modifiers: ["minimal-change"],
  });
  const evidence = await captureObservationEvidence(harness, "synthesis-selected");
  await executeSemanticTool(harness, "pindie_verification_record", "synthesis-verification", {
    check: { name: "synthesis check", status: "passed", covers: ["c1"], evidenceRefs: [evidence.ref] },
  });
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 2);
  const selected = harness.experienceStore.records[1]!.experience;
  const finalApproach = selected.policy.finalSnapshot?.approach;
  assert.equal(finalApproach?.strategyId, candidate.proposal.strategyId);
  assert.equal(finalApproach?.revisionIdentity, candidate.candidateId);
  assert.equal(finalApproach?.revisionFingerprint, strategySynthesisCandidateSemanticFingerprint(candidate));
  assert.equal(finalApproach?.revisionStatusAtRun, "trial");
  assert.deepEqual(finalApproach?.semantics, {
    summary: candidate.proposal.summary,
    useWhen: candidate.proposal.useWhen,
    avoidWhen: candidate.proposal.avoidWhen,
    principles: candidate.proposal.principles,
  });
  assert.equal(selected.outcome.verificationStatus, "passed");
  const selectedEvaluation = evaluateRunExperience({
    recordId: "synthesis-selected.json",
    experience: selected,
  });
  assert.ok(selectedEvaluation.policy.finalPolicyExposureCalls !== null);
  assert.ok(selectedEvaluation.policy.finalPolicyExposureCalls > 0);
  assert.ok(selectedEvaluation.policy.finalPolicyExposureRatio !== null);
  assert.ok(selectedEvaluation.policy.finalPolicyExposureRatio > 0);
  assert.equal(JSON.stringify(selected).includes("candidateId"), false);
  assert.equal(notices.at(-1)?.type, "info");

  await beginAgentRun(harness);
  assert.doesNotMatch(
    (await harnessBeforeAgentStart(harness)).systemPrompt,
    /<PINDIE_SYNTHESIS_TRIAL_PACKET>/,
  );
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice C active Synthesis Trial still resolves an ordinary exact trusted selector", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000045");
  const artifacts = trustedStrategyCommandArtifacts();
  const localCandidatesById = new Map([[artifacts.promotedSeedCandidate.candidateId, artifacts.promotedSeedCandidate]]);
  const localCandidates = {
    read: async (_projectRoot: string, candidateId: string) => localCandidatesById.get(candidateId) ?? null,
    readAll: async (_projectRoot: string) => [...localCandidatesById.values()],
    save: async (_projectRoot: string, value: StrategyRevisionCandidate) => { localCandidatesById.set(value.candidateId, value); },
  };
  const localDerivationCandidates = { read: async () => null, readAll: async () => [], save: async () => undefined };
  const decisions = testDecisionStore([artifacts.promotedSeedDecision]);
  const derivationDecisions = testDerivationDecisionReader();
  const emptyScope = emptyScopeAuthority();
  const harness = createHarness([["/repo", activeState("ordinary trusted selector during Synthesis Trial")]], {}, {
    crossProjectExperienceReader: {
      listProjectIds: async () => [],
      readProjectId: async () => ({ records: [], loadedRecords: 0, unsupportedSchema: 0, invalid: 0 }),
    },
    crossProjectTrustReader: {
      readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
        projectId,
        createPromotedStrategyRevisionCatalog([]),
      ),
    },
    strategySynthesisCandidateStore: {
      read: async (candidateId) => candidateId === candidate.candidateId ? candidate : null,
      readAll: async () => [candidate],
      save: async () => undefined,
    },
    strategyCandidateStore: localCandidates,
    strategyCandidateReader: localCandidates,
    strategyDerivationCandidateStore: localDerivationCandidates,
    strategyDerivationCandidateReader: localDerivationCandidates,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyDerivationDecisionStore: derivationDecisions,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyTrustScopeCandidateStore: emptyScope.candidateStore,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
  });
  await startSession(harness, "/repo");
  const command = harness.api.commands.get("trial");
  await command.handler(synthesisTrialCommandValue(candidate.candidateId), {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  const beforeRun = await harnessBeforeAgentStart(harness);
  assert.match(beforeRun.systemPrompt, /<PINDIE_SYNTHESIS_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial?.hasActiveSynthesisTrial, true);

  const trusted = strategyRevisionSelectionFromCandidate(artifacts.promotedSeedCandidate, "promoted");
  await executeSemanticTool(harness, "pindie_policy_set", "ordinary-trusted-policy", {
    approach: {
      strategyId: trusted.strategyId,
      revisionIdentity: trusted.revisionIdentity,
      revisionFingerprint: trusted.revisionFingerprint,
    },
  });
  assert.equal(harness.integration.policySnapshot?.approach.strategyId, trusted.strategyId);
  assert.equal(harness.integration.policySnapshot?.approach.revisionIdentity, trusted.revisionIdentity);
  assert.equal(harness.integration.policySnapshot?.approach.revisionStatusAtRun, "promoted");
  await captureObservationEvidence(harness, "ordinary-trusted-observation");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.experienceStore.records.length, 1);
  assert.equal(
    harness.experienceStore.records[0]?.experience.policy.finalSnapshot?.approach.revisionIdentity,
    trusted.revisionIdentity,
  );
});

test("Slice C Synthesis Trial fails closed for stale Candidate and target authority before Run binding", async () => {
  const original = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000042");
  const semanticChanged = await makeSynthesisTrialFixture(original.candidate.candidateId, {
    summary: "The immutable Synthesis Candidate changed after arming.",
  });
  const hypothesisChanged = createStrategySynthesisCandidate({
    proposal: {
      ...original.candidate.proposal,
      hypothesis: "The same semantic proposal now carries different historical provenance.",
    },
    sourceRefs: original.candidate.evidence.sourceRefs,
    derivationReceipt: original.candidate.derivationReceipt,
    candidateId: original.candidate.candidateId,
    createdAt: original.candidate.createdAt,
  });
  assert.equal(
    strategySynthesisCandidateSemanticFingerprint(hypothesisChanged),
    strategySynthesisCandidateSemanticFingerprint(original.candidate),
  );
  assert.notEqual(
    strategySynthesisCandidateArtifactFingerprint(hypothesisChanged),
    strategySynthesisCandidateArtifactFingerprint(original.candidate),
  );
  const targetConflict = derivedPromotionCandidate(
    "00000000-0000-4000-8000-000000000043",
    original.candidate.proposal.strategyId,
  );
  const targetConflictDecision = createStrategyDerivationDecision({
    candidate: targetConflict,
    decision: "promoted",
    trialRecordIds: ["target-trial-one", "target-trial-two"],
    decidedAt: "2026-02-03T00:00:00.000Z",
  });
  const cases: readonly {
    name: string;
    candidate: unknown;
    targetConflict?: boolean;
    reason: RegExp;
  }[] = [
    {
      name: "semantic Candidate change",
      candidate: semanticChanged.candidate,
      reason: /stale|changed|Candidate/i,
    },
    {
      name: "Candidate disappearance",
      candidate: null,
      reason: /not found|stale|invalid|Candidate/i,
    },
    {
      name: "malformed Candidate",
      candidate: { schemaVersion: 1 },
      reason: /invalid|stale|Candidate/i,
    },
    {
      name: "provenance-only Candidate change",
      candidate: hypothesisChanged,
      reason: /stale|changed|Candidate/i,
    },
    {
      name: "new target trusted logical ID",
      candidate: original.candidate,
      targetConflict: true,
      reason: /trusted|logical|stale|invalid/i,
    },
  ];

  for (const scenario of cases) {
    let current: unknown = original.candidate;
    const synthesisStore: StrategySynthesisCandidateStore = {
      read: async (candidateId) => candidateId === original.candidate.candidateId
        ? current as StrategySynthesisCandidateV1 | null
        : null,
      readAll: async () => current === null
        ? []
        : [current as StrategySynthesisCandidateV1],
      save: async () => undefined,
    };
    const localCandidates = { read: async () => null, readAll: async () => [], save: async () => undefined };
    const localDerivationCandidates = new Map<string, StrategyDerivationCandidateV1>();
    const derivationCandidateReader = {
      read: async (_projectRoot: string, candidateId: string) => localDerivationCandidates.get(candidateId) ?? null,
      readAll: async (_projectRoot: string) => [...localDerivationCandidates.values()],
      save: async (_projectRoot: string, candidate: StrategyDerivationCandidateV1) => {
        localDerivationCandidates.set(candidate.candidateId, candidate);
      },
    };
    const decisions = testDecisionStore();
    const derivationDecisions = testDerivationDecisionReader();
    const emptyScope = emptyScopeAuthority();
    const harness = createHarness([["/repo", activeState(`stale Synthesis Trial: ${scenario.name}`)]], {}, {
      crossProjectExperienceReader: {
        listProjectIds: async () => [],
        readProjectId: async () => ({ records: [], loadedRecords: 0, unsupportedSchema: 0, invalid: 0 }),
      },
      crossProjectTrustReader: {
        readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
          projectId,
          createPromotedStrategyRevisionCatalog([]),
        ),
      },
      strategySynthesisCandidateStore: synthesisStore,
      strategyCandidateStore: localCandidates,
      strategyCandidateReader: localCandidates,
      strategyDerivationCandidateStore: derivationCandidateReader,
      strategyDerivationCandidateReader: derivationCandidateReader,
      strategyDecisionStore: decisions,
      strategyDecisionReader: decisions,
      strategyDerivationDecisionStore: derivationDecisions,
      strategyDerivationDecisionReader: derivationDecisions,
      strategyTrustScopeCandidateStore: emptyScope.candidateStore,
      strategyTrustScopeDecisionStore: emptyScope.decisionStore,
      strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
    });
    await startSession(harness, "/repo");
    await harness.api.commands.get("trial").handler(synthesisTrialCommandValue(original.candidate.candidateId), {
      ...context("/repo"),
      isIdle: () => true,
      ui: { notify: () => undefined },
    });
    assert.equal(harness.integration.trial?.hasPendingSynthesisTrial, true, scenario.name);
    current = scenario.candidate;
    if (scenario.targetConflict) {
      localDerivationCandidates.set(targetConflict.candidateId, targetConflict);
      derivationDecisions.decisions.set(targetConflictDecision.candidateId, targetConflictDecision);
    }
    await assert.rejects(
      harnessBeforeAgentStart(harness),
      scenario.reason,
      scenario.name,
    );
    assert.equal(harness.integration.trial?.hasTrial, false, scenario.name);
    assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, false, scenario.name);
    assert.equal(harness.experienceStore.records.length, 0, scenario.name);
    assert.equal(harness.api.sentUserMessages.length, 0, scenario.name);
    await harness.api.handler("session_shutdown")(
      { type: "session_shutdown", reason: "stale-test-cleanup" },
      context("/repo"),
    );
  }
});

test("Slice C Synthesis Trial fails closed when Session reset clears binding during pre-Run validation", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000044");
  const synthesisStore: StrategySynthesisCandidateStore = {
    read: async (candidateId) => candidateId === candidate.candidateId ? candidate : null,
    readAll: async () => [candidate],
    save: async () => undefined,
  };
  const localCandidates = { read: async () => null, readAll: async () => [], save: async () => undefined };
  const localDerivationCandidates = { read: async () => null, readAll: async () => [], save: async () => undefined };
  const decisions = testDecisionStore();
  const derivationDecisions = testDerivationDecisionReader();
  const emptyScope = emptyScopeAuthority();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let pauseValidation = false;
  const deferredScopeCandidates: StrategyTrustScopeCandidateStore = {
    read: async () => null,
    readAll: async () => {
      if (pauseValidation) {
        markEntered();
        await paused;
      }
      return [];
    },
    save: async () => undefined,
  };
  const harness = createHarness([["/repo", activeState("Synthesis Trial bind race")]], {}, {
    crossProjectExperienceReader: {
      listProjectIds: async () => [],
      readProjectId: async () => ({ records: [], loadedRecords: 0, unsupportedSchema: 0, invalid: 0 }),
    },
    crossProjectTrustReader: {
      readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
        projectId,
        createPromotedStrategyRevisionCatalog([]),
      ),
    },
    strategySynthesisCandidateStore: synthesisStore,
    strategyCandidateStore: localCandidates,
    strategyCandidateReader: localCandidates,
    strategyDerivationCandidateStore: localDerivationCandidates,
    strategyDerivationCandidateReader: localDerivationCandidates,
    strategyDecisionStore: decisions,
    strategyDecisionReader: decisions,
    strategyDerivationDecisionStore: derivationDecisions,
    strategyDerivationDecisionReader: derivationDecisions,
    strategyTrustScopeCandidateStore: deferredScopeCandidates,
    strategyTrustScopeDecisionStore: emptyScope.decisionStore,
    strategyTrustScopeSourceResolver: emptyScope.sourceResolver,
  });
  await startSession(harness, "/repo");
  await harness.api.commands.get("trial").handler(synthesisTrialCommandValue(candidate.candidateId), {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  assert.equal(harness.integration.trial?.hasPendingSynthesisTrial, true);

  pauseValidation = true;
  const beforeRun = harnessBeforeAgentStart(harness);
  await entered;
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/repo"),
  );
  assert.equal(harness.integration.trial?.hasTrial, false);
  release();

  await assert.rejects(
    beforeRun,
    /pending Synthesis Trial could not bind to the current Session\/generation|preparation became stale/i,
  );
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.core.run.hasActiveAgentRun, false);
  assert.equal(harness.integration.taskMetrics.currentRunBelongsToTask, false);
  assert.equal(harness.experienceStore.records.length, 0);
  assert.equal(harness.api.sentUserMessages.length, 0);
});

test("Slice E clears pending and active Global Derivation and Synthesis Trial leases across reload and shutdown", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-00000000004a");
  const projectA = getProjectId("/slice-e-global-a");
  const projectB = getProjectId("/slice-e-global-b");
  const records = new Map<string, readonly { recordId: string; experience: RunExperience }[]>([
    [projectA, [
      { recordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json", experience: commandExperience("slice e global alpha", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json", experience: commandExperience("slice e global beta", createPolicySnapshot({ approach: "explore-first" })) },
    ]],
    [projectB, [
      { recordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json", experience: commandExperience("slice e global gamma", createPolicySnapshot({ approach: "direct-action" })) },
    ]],
  ]);
  let pauseFirstScan = true;
  let markScanEntered!: () => void;
  let releaseScan!: () => void;
  const scanEntered = new Promise<void>((resolve) => { markScanEntered = resolve; });
  const scanPaused = new Promise<void>((resolve) => { releaseScan = resolve; });
  const crossProjectExperienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => {
      if (pauseFirstScan) {
        pauseFirstScan = false;
        markScanEntered();
        await scanPaused;
      }
      return [projectA, projectB];
    },
    readProjectId: async (projectId) => {
      const projectRecords = records.get(projectId) ?? [];
      return { records: projectRecords, loadedRecords: projectRecords.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader = {
    readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
      projectId,
      createPromotedStrategyRevisionCatalog([]),
    ),
  };
  const candidates = new Map([[candidate.candidateId, candidate]]);
  const synthesisStore: StrategySynthesisCandidateStore = {
    read: async (candidateId) => candidates.get(candidateId) ?? null,
    readAll: async () => [...candidates.values()],
    save: async (value) => { candidates.set(value.candidateId, value); },
  };
  const synthesisDecisionStore = {
    read: async () => null,
    readAll: async () => [],
    save: async () => undefined,
  };
  const harness = createHarness([["/repo", activeState("Slice E lifecycle")]], {}, {
    crossProjectExperienceReader,
    crossProjectTrustReader,
    strategySynthesisCandidateStore: synthesisStore,
    strategySynthesisDecisionStore: synthesisDecisionStore,
  });
  const commandContext = {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  };
  await startSession(harness, "/repo");
  const deriveGlobal = harness.api.commands.get("derive-global");
  assert.ok(deriveGlobal);

  const pendingGlobal = deriveGlobal.handler("", commandContext);
  await scanEntered;
  assert.equal(harness.integration.globalDerivation?.hasPending, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/repo"),
  );
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  assert.equal(harness.integration.trial?.hasTrial, false);
  releaseScan();
  await pendingGlobal;
  assert.equal(harness.api.sentUserMessages.length, 0);

  await startSession(harness, "/repo", "reload");
  await deriveGlobal.handler("", commandContext);
  assert.equal(harness.integration.globalDerivation?.hasPending, true);
  const globalRun = await harnessBeforeAgentStart(harness);
  assert.match(globalRun.systemPrompt, /<PINDIE_GLOBAL_DERIVATION_RUN>/);
  assert.equal(harness.integration.globalDerivation?.hasActive, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload-active-global" },
    context("/repo"),
  );
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  assert.equal(harness.integration.trial?.hasTrial, false);

  await startSession(harness, "/repo", "reload-synthesis");
  const trial = harness.api.commands.get("trial");
  assert.ok(trial);
  const subject = synthesisTrialCommandValue(candidate.candidateId);
  await trial.handler(subject, commandContext);
  assert.equal(harness.integration.trial?.hasPendingSynthesisTrial, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload-pending-synthesis" },
    context("/repo"),
  );
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);

  await startSession(harness, "/repo", "reload-synthesis-active");
  await trial.handler(subject, commandContext);
  const synthesisRun = await harnessBeforeAgentStart(harness);
  assert.match(synthesisRun.systemPrompt, /<PINDIE_SYNTHESIS_TRIAL_PACKET>/);
  assert.equal(harness.integration.trial?.hasActiveSynthesisTrial, true);
  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "shutdown-active-synthesis" },
    context("/repo"),
  );
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);

  await startSession(harness, "/repo", "fresh");
  const ordinaryRun = await harnessBeforeAgentStart(harness);
  assert.doesNotMatch(ordinaryRun.systemPrompt, /<PINDIE_(?:GLOBAL_DERIVATION_RUN|SYNTHESIS_TRIAL_PACKET)>/);
  assert.equal(harness.integration.trial?.hasTrial, false);
  assert.equal(harness.integration.globalDerivation?.hasAttempt, false);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("Slice B /derive-global preparation, launch, and Session failures clear reservation without starting a Run", async () => {
  const projectA = getProjectId("/global-failure-a");
  const projectB = getProjectId("/global-failure-b");
  const validRecords = new Map<string, readonly { recordId: string; experience: RunExperience }[]>([
    [projectA, [
      { recordId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json", experience: commandExperience("failure goal alpha", createPolicySnapshot({ approach: "direct-action" })) },
      { recordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json", experience: commandExperience("failure goal beta", createPolicySnapshot({ approach: "explore-first" })) },
    ]],
    [projectB, [
      { recordId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json", experience: commandExperience("failure goal gamma", createPolicySnapshot({ approach: "direct-action" })) },
    ]],
  ]);
  const makeReader = (records: ReadonlyMap<string, readonly { recordId: string; experience: RunExperience }[]>, pause = false): RunExperienceProjectReader => {
    let entered = false;
    return {
      listProjectIds: async () => [projectA, projectB],
      readProjectId: async (projectId) => {
        if (pause && !entered) {
          entered = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        const projectRecords = records.get(projectId) ?? [];
        return { records: projectRecords, loadedRecords: projectRecords.length, unsupportedSchema: 0, invalid: 0 };
      },
    };
  };
  const trust: ProjectTrustedStrategyPortfolioReader = {
    readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(projectId, createPromotedStrategyRevisionCatalog([])),
  };
  const candidates: StrategySynthesisCandidateV1[] = [];
  const store: StrategySynthesisCandidateStore = {
    read: async () => null,
    readAll: async () => [],
    save: async (candidate) => { candidates.push(candidate); },
  };
  const empty = new Map<string, readonly { recordId: string; experience: RunExperience }[]>();
  const insufficient = createHarness([["/repo", activeState("insufficient")]], {}, {
    crossProjectExperienceReader: makeReader(empty),
    crossProjectTrustReader: trust,
    strategySynthesisCandidateStore: store,
  });
  await startSession(insufficient, "/repo");
  const insufficientNotices: string[] = [];
  await insufficient.api.commands.get("derive-global").handler("", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: (message: string) => insufficientNotices.push(message) },
  });
  assert.match(insufficientNotices.at(-1) ?? "", /insufficient.*no Agent Run was started/i);
  assert.equal(insufficient.integration.globalDerivation?.hasAttempt, false);
  assert.equal(insufficient.api.sentUserMessages.length, 0);

  const launch = createHarness([["/repo", activeState("launch failure")]], {}, {
    crossProjectExperienceReader: makeReader(validRecords),
    crossProjectTrustReader: trust,
    strategySynthesisCandidateStore: store,
  });
  await startSession(launch, "/repo");
  (launch.api as any).sendUserMessage = () => { throw new Error("native launch failed"); };
  await launch.api.commands.get("derive-global").handler("", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  assert.equal(launch.integration.globalDerivation?.hasAttempt, false);
  assert.equal(launch.api.sentUserMessages.length, 0);

  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const sessionReader: RunExperienceProjectReader = {
    listProjectIds: async () => {
      markEntered();
      await paused;
      return [projectA, projectB];
    },
    readProjectId: async (projectId) => {
      const projectRecords = validRecords.get(projectId) ?? [];
      return { records: projectRecords, loadedRecords: projectRecords.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const session = createHarness([["/repo", activeState("Session failure")]], {}, {
    crossProjectExperienceReader: sessionReader,
    crossProjectTrustReader: trust,
    strategySynthesisCandidateStore: store,
  });
  await startSession(session, "/repo");
  const pending = session.api.commands.get("derive-global").handler("", {
    ...context("/repo"),
    isIdle: () => true,
    ui: { notify: () => undefined },
  });
  await entered;
  await session.api.handler("session_shutdown")({ type: "session_shutdown", reason: "reload" }, context("/repo"));
  release();
  await pending;
  assert.equal(session.integration.globalDerivation?.hasAttempt, false);
  assert.equal(session.api.sentUserMessages.length, 0);
  assert.equal(session.experienceStore.records.length, 0);
});
