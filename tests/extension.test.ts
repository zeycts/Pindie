import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  registerPindieExtension,
  type PindieExtensionOptions,
} from "../src/extension.ts";
import { createPolicySnapshot, type PolicySnapshot } from "../src/policy.ts";
import { RemoteCompanion, type RemoteSurface } from "../src/remote-companion.ts";
import {
  EMPTY_STATE,
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
} from "../src/state.ts";
import {
  assembleRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import type {
  RunExperienceReadResult,
  RunExperienceReader,
  RunExperienceStore,
} from "../src/experience-store.ts";
import type { PindieStateStore } from "../src/store.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";

type CapturedHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => unknown;

class CapturedExtensionAPI {
  readonly handlers = new Map<string, CapturedHandler>();
  readonly tools = new Map<string, any>();
  readonly commands = new Map<string, any>();
  readonly appliedThinkingLevels: string[] = [];
  readonly sentMessages: unknown[] = [];
  readonly sentUserMessages: unknown[] = [];
  readonly appendedEntries: unknown[] = [];
  readonly setActiveToolsCalls: string[][] = [];
  thinkingLevel = "medium";
  private runtimeBound = false;
  private readonly configuredToolNames = new Set([
    "read", "grep", "find", "ls", "edit", "write", "bash", "custom_tool",
  ]);
  private activeToolNames = [...this.configuredToolNames];

  on(eventName: string, handler: CapturedHandler): void {
    assert.equal(this.handlers.has(eventName), false);
    this.handlers.set(eventName, handler);
  }

  registerTool(tool: { name: string }): void {
    this.tools.set(tool.name, tool);
    this.configuredToolNames.add(tool.name);
    this.activeToolNames.push(tool.name);
  }

  registerCommand(name: string, command: any): void {
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

  appendEntry(entry: unknown): void { this.appendedEntries.push(entry); }

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

  async save(projectRoot: string, experience: RunExperience): Promise<void> {
    if (this.saveError) throw this.saveError;
    this.records.push({ projectRoot, experience });
  }
}

class ExtensionTestExperienceReader implements RunExperienceReader {
  result: RunExperienceReadResult = {
    records: [],
    loadedSchemaV3: 0,
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

class ExtensionTestStore implements PindieStateStore {
  readonly states = new Map<string, PindieState>();
  readonly loadErrors = new Map<string, Error>();
  readonly loads: string[] = [];
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  saveError: Error | null = null;

  constructor(entries: Array<[string, PindieState]> = []) {
    for (const [root, state] of entries) this.states.set(root, state);
  }

  async load(projectRoot: string): Promise<PindieState> {
    this.loads.push(projectRoot);
    const error = this.loadErrors.get(projectRoot);
    if (error) throw error;
    return this.states.get(projectRoot) ?? EMPTY_STATE;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    this.saves.push({ projectRoot, state });
    if (this.saveError) throw this.saveError;
    this.states.set(projectRoot, state);
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
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

function context(
  cwd: string,
  sessionEntries: unknown[] = [],
  hasPendingMessages = false,
  sessionId = "remote-session",
  getEntries: () => unknown[] = () => sessionEntries,
): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    hasPendingMessages: () => hasPendingMessages,
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
  options: Omit<PindieExtensionOptions, "store" | "resolveProjectRoot"> = {},
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
      resolveProjectRoot: async (cwd) => resolvedRoots[cwd] ?? cwd,
    },
  );
  api.bindRuntime();

  return { api, store, experienceStore, experienceReader, integration };
}

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
  assert.match(notices.at(-1)?.message ?? "", /Loaded schema-v3 records: 0/);
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
    loadedSchemaV3: 3,
    unsupportedSchema: 1,
    invalid: 1,
  };
  await harness.api.commands.get("experience").handler("", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /Loaded schema-v3 records: 3/);
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

test("Remote-disabled baseline registers no Remote lifecycle hooks", () => {
  const { api } = createHarness();

  assert.deepEqual([...api.tools.keys()].sort(), [
    "pindie_gate_open",
    "pindie_gate_resolve",
    "pindie_git_observe",
    "pindie_policy_set",
    "pindie_strategy_candidate_create",
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
    "agent_end",
    "agent_settled",
    "before_agent_start",
    "session_compact",
    "session_compact_failed",
    "session_shutdown",
    "session_start",
    "thinking_level_select",
    "tool_call",
    "tool_execution_end",
    "tool_execution_start",
    "tool_result",
    "turn_end",
  ]);
  assert.equal(api.handlers.has("input"), false);
});

test("Remote-enabled wiring observes public input without altering Pindie tools", async () => {
  const sent: string[] = [];
  const surface: RemoteSurface = { ensureProject: async () => ({ channelId: "channel" }), ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }), send: async (_thread, event) => { sent.push(event.text); }, updateSessionPresentation: async () => undefined };
  const { api } = createHarness([], {}, { remoteCompanion: { companion: new RemoteCompanion(surface), guildId: "guild" } });
  assert.ok(api.handlers.has("input")); assert.ok(api.handlers.has("message_end")); assert.equal(api.tools.size, 11);
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, context("/repo", [{ id: "u", message: { role: "user", content: "hello" } }]));
  assert.ok(Array.isArray(sent));
});

test("Pi session_info_changed awaits presentation rename for the mapped active Session", async () => {
  const titles: string[] = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async () => undefined,
    updateSessionPresentation: async (_session, presentation) => { titles.push(presentation.title); },
  };
  const companion = new RemoteCompanion(surface);
  const { api } = createHarness([], {}, { remoteCompanion: { companion, guildId: "guild" } });
  const ui = context("/repo", [{ id: "u", message: { role: "user", content: "Original prompt" } }]);
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, ui);
  const before = titles.length;
  await api.handler("session_info_changed")({ type: "session_info_changed", name: "Discord Remote Test 2" }, ui);
  assert.equal(companion.activeSessionId, "remote-session");
  assert.equal(titles.length, before + 1);
  assert.equal(titles.at(-1), "Discord Remote Test 2");
});

test("Discord startup is deferred from session_start and current-session shutdown cleans it up", async () => {
  const surface: RemoteSurface = { ensureProject: async () => ({ channelId: "channel" }), ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }), send: async () => undefined, updateSessionPresentation: async () => undefined };
  let started = 0; let stopped = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const discord = {
    start: () => { started++; return pending; },
    stop: () => { stopped++; },
  } as unknown as import("../src/discord-remote.ts").DiscordRemote;
  const harness = createHarness([], {}, { remoteCompanion: { companion: new RemoteCompanion(surface), guildId: "guild", discord } });
  const ui = context("/repo", []);
  await harness.api.handler("session_start")({ type: "session_start", reason: "startup" }, ui);
  assert.equal(started, 1);
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "done" }, ui);
  assert.equal(stopped, 1);
  release();
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
  await harness.api.handler("session_shutdown")({ type: "session_shutdown", reason: "reload" }, shutdownContext);
  await harness.api.handler("session_start")({ type: "session_start", reason: "reload" }, currentContext);
  assert.equal(starts.length, 2);

  assert.doesNotThrow(() => starts[0]!.ready());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staleReads, 0);
  assert.deepEqual(mirrored, []);
  assert.equal(companion.activeSessionId, "same-session");
  assert.equal(stopped, 1);

  starts[1]!.ready();
  await new Promise((resolve) => setImmediate(resolve));
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
  const discord = {
    start: (input: (threadId: string, text: string) => Promise<unknown>) => {
      starts.push({ input });
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
  assert.doesNotThrow(() => harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo", entries)));
  assert.equal(harness.integration.stateUnavailableReason, null);
});

test("E01-E02/E08-E10 active Tasks queue one read-only hidden follow-up per Run", async () => {
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

  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));

  assert.equal(harness.api.sentMessages.length, 1);
  assert.deepEqual((harness.api.sentMessages[0] as {
    message: { customType: string; display: boolean };
    options: unknown;
  }).options, { deliverAs: "followUp" });
  const continuationMessage = (harness.api.sentMessages[0] as {
    message: { customType: string; content: string; display: boolean };
  }).message;
  assert.equal(continuationMessage.customType, PINDIE_CONTINUATION_PROBE_TYPE);
  assert.equal(continuationMessage.display, false);
  assert.equal(continuationMessage.content, PINDIE_CONTINUATION_PROBE_MESSAGE);
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.integration.reasoning.snapshot, reasoningBefore);
  assert.deepEqual(harness.api.getActiveTools(), activeToolsBefore);
  assert.deepEqual(harness.store.saves, []);
  assert.equal(harness.integration.runTimer.active, true);
  assert.equal(harness.integration.runCost.snapshot([] as any)?.active, true);

  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 1);

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
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 2);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
});

test("E03-E05/E07 semantic, authority, stop, and queue facts suppress ineligible probes", async () => {
  const cases: Array<{
    name: string;
    state: PindieState | undefined;
    stopReason?: "aborted" | "error" | "length";
    pending?: boolean;
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
  ];

  for (const scenario of cases) {
    const harness = createHarness(scenario.state === undefined ? [] : [["/repo", scenario.state]]);
    if (scenario.state === undefined) {
      harness.store.loadErrors.set("/repo", new Error("State unavailable"));
    }
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    await harness.api.handler("agent_end")(
      agentEnd(scenario.stopReason ?? "stop"),
      context("/repo", [], scenario.pending),
    );
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
  assert.equal(harness.api.handlers.has("context"), false);
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
  assert.equal(harness.api.handlers.has("context"), false);
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
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 1);
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 1);
});

test("H05 a fresh user Run does not rewrite prior continuation probes", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );
  await beginAgentRun(harness);
  assert.equal(harness.api.handlers.has("context"), false);
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
  await new Promise((resolve) => setImmediate(resolve));
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    context("/repo"),
  );

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
  await new Promise((resolve) => setImmediate(resolve));

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
  assert.match(statuses.at(-1)?.text ?? "", /last 0s • \$0.31 • manual • active • verify 0\/1/);
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
  assert.match(statuses.at(-1)?.text ?? "", /⏱ 0s • \$0.000 • manual • thinking • active • verify 0\/1/);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    uiContext,
  );
  assert.equal(harness.integration.runCost.snapshot(entries as any), null);
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
    text: "⏱ 0s • $0.000 • manual • thinking • active • verify 0/1",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "last 0s • $0.000 • manual • active • verify 0/1",
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
    text: "⏱ 0s • $0.000 • manual • thinking • active • ✓ 1/1",
  });

  await harness.api.tool("pindie_gate_open").execute("gate", {
    kind: "approval",
    question: "Approve release?",
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "⏱ 0s • $0.000 • manual • thinking • ✓ 1/1 • ⚠ gate: approval",
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

test("T50 integrated completion terminates and terminal guard blocks mutation", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const result = await harness.api.tool("pindie_task_complete").execute("complete", {
    summary: "Completed the verified task.",
  });

  assert.equal(result.terminate, true);
  assert.match(textOf(result), /Duration: 0s/);
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
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
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
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 1);
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

test("SI v0.3 eligible Run Experience captures task facts, outcome, and settled metrics", async () => {
  const harness = createHarness([["/repo", activeState("Experience task")]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await captureObservationEvidence(harness, "experience-read");
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));

  assert.equal(harness.experienceStore.records.length, 1);
  const record = harness.experienceStore.records[0]!.experience;
  assert.equal(record.schemaVersion, 3);
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

test("SI v0.3 preserves idle introduction and Policy declaration positions", async () => {
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
  assert.equal(record.schemaVersion, 3);
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

test("SI v0.3 keeps completed run-start Task A distinct from introduced settlement Task B", async () => {
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
  assert.equal(record.schemaVersion, 3);
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
    loadedSchemaV3: 2,
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
  const followUpsBeforeAdaptationEnd = harness.api.sentMessages.length;
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, followUpsBeforeAdaptationEnd);

  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  await beginAgentRun(harness);
  assert.doesNotMatch(
    (await harnessBeforeAgentStart(harness)).systemPrompt,
    /<PINDIE_ADAPTATION_PACKET>/,
  );
  assertBlocked(
    await callGuard(harness, toolCall("pindie_strategy_candidate_create", candidateInput, "ordinary-candidate")),
    /explicit adaptation|\/adapt <strategy-id>/i,
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
    loadedSchemaV3: 1,
    unsupportedSchema: 0,
    invalid: 0,
  };
  await harness.api.commands.get("adapt").handler("direct-action", commandContext);
  assert.match(notices.at(-1)?.message ?? "", /only 1 eligible attributable Run/i);
  assert.equal(harness.api.sentUserMessages.length, 0);
});
