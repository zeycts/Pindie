import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PINDIE_RUNTIME_CONTEXT_TYPE,
} from "../src/context.ts";
import {
  registerPindieExtension,
  type PindieExtensionOptions,
} from "../src/extension.ts";
import {
  EMPTY_STATE,
  getVerificationStatus,
  type PindieState,
} from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";

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
): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    hasPendingMessages: () => hasPendingMessages,
    sessionManager: { getEntries: () => sessionEntries },
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

function createHarness(
  entries: Array<[string, PindieState]> = [],
  resolvedRoots: Record<string, string> = {},
  options: Omit<PindieExtensionOptions, "store" | "resolveProjectRoot"> = {},
) {
  const api = new CapturedExtensionAPI();
  const store = new ExtensionTestStore(entries);
  const integration = registerPindieExtension(
    api as unknown as ExtensionAPI,
    {
      subscriptionUsageProvider: { fetchUsage: async () => null },
      ...options,
      store,
      resolveProjectRoot: async (cwd) => resolvedRoots[cwd] ?? cwd,
    },
  );
  api.bindRuntime();

  return { api, store, integration };
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
  await api.handler("session_start")({ type: "session_start", reason: "startup" }, context("/repo"));
  await api.handler("before_agent_start")({ type: "before_agent_start", systemPrompt: "", prompt: "", systemPromptOptions: {} }, context("/repo"));
  assert.deepEqual(api.appliedThinkingLevels, ["medium"]);
  await api.commands.get("reasoning").handler("manual", context("/repo"));
  assert.deepEqual(api.appliedThinkingLevels, ["medium"]);
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
  await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context(cwd, sessionEntries),
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

test("F03 the Extension registers narrow Pindie tools and no input hook", () => {
  const { api } = createHarness();

  assert.deepEqual([...api.tools.keys()].sort(), [
    "pindie_gate_open",
    "pindie_gate_resolve",
    "pindie_git_observe",
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
    "context",
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

test("AC01-AC15 active executable tasks queue one hidden Pi-native follow-up per Agent Run", async () => {
  const state = activeState();
  state.task!.openLoops.questions = ["Should the release note mention this?"];
  const harness = createHarness([["/repo", state]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const stateBefore = structuredClone(harness.integration.runtime.state);
  const reasoningBefore = harness.integration.reasoning.snapshot;

  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));

  assert.equal(harness.api.sentMessages.length, 1);
  assert.deepEqual((harness.api.sentMessages[0] as {
    message: { customType: string; display: boolean };
    options: unknown;
  }).options, { deliverAs: "followUp" });
  const continuationMessage = (harness.api.sentMessages[0] as {
    message: { customType: string; content: string; display: boolean };
  }).message;
  assert.equal(continuationMessage.customType, "pindie-active-task-continuation");
  assert.equal(continuationMessage.display, false);
  const continuationContent = continuationMessage.content;
  assert.match(continuationContent, /consequential execution of this current Task/i);
  assert.match(continuationContent, /different Task.*pindie_task_replace/i);
  assert.match(continuationContent, /stop, pause, return control, or only inspect, explain, or discuss/i);
  assert.ok(
    continuationContent.indexOf("First re-evaluate") <
      continuationContent.indexOf("Otherwise continue this current Task now."),
  );
  assert.deepEqual(harness.integration.runtime.state, stateBefore);
  assert.deepEqual(harness.integration.reasoning.snapshot, reasoningBefore);
  assert.deepEqual(harness.store.saves, []);
  assert.equal(harness.integration.runTimer.active, true);
  assert.equal(harness.integration.runCost.snapshot([] as any)?.active, true);

  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 1);

  await beginAgentRun(harness);
  await harness.api.handler("agent_end")(agentEnd(), context("/repo"));
  assert.equal(harness.api.sentMessages.length, 2);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.equal(harness.integration.runTimer.active, false);
  assert.equal(harness.integration.runCost.snapshot([] as any)?.active, false);
  assert.equal(harness.integration.runActivity.activity, null);
});

test("AC04-AC13 continuation eligibility suppresses every ineligible agent end", async () => {
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

test("AR20-AR35 reasoning integration preserves auto authority and manual relinquishes it", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  assert.ok(harness.api.handlers.has("turn_end"));
  assert.ok(harness.api.handlers.has("thinking_level_select"));
  assert.ok(harness.api.commands.has("reasoning"));
  await startSession(harness, "/repo");
  assert.equal(harness.integration.reasoning.snapshot.mode, "auto");
  await beginAgentRun(harness);
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "medium");
  const originalState = structuredClone(harness.integration.runtime.state);
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("bash", true)] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "high");
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
  assert.equal(harness.integration.reasoning.snapshot.mode, "auto");
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

test("P01/P07 before_agent_start returns no Pindie systemPrompt override or Core block", async () => {
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
  ) as { systemPrompt?: string } | undefined;

  assert.equal(result?.systemPrompt, undefined);
});

test("P04 Context lifecycle projects one fresh coherent Snapshot-driven Runtime Context", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  const originalMessages = [
    { role: "user", content: "Continue", timestamp: 1 },
    {
      role: "custom",
      customType: PINDIE_RUNTIME_CONTEXT_TYPE,
      content: "stale projection",
      display: false,
      timestamp: 0,
    },
    { role: "assistant", content: [{ type: "text", text: "Observed." }], timestamp: 2 },
  ];
  const semanticState = structuredClone(harness.integration.runtime.state);
  const first = await harness.api.handler("context")(
    { type: "context", messages: originalMessages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };

  assert.deepEqual(originalMessages[0], { role: "user", content: "Continue", timestamp: 1 });
  assert.deepEqual(first.messages.slice(0, 2), [originalMessages[0], originalMessages[2]]);
  assert.equal(first.messages.filter((message) => message.customType === PINDIE_RUNTIME_CONTEXT_TYPE).length, 1);
  assert.equal(first.messages.at(-1)?.customType, PINDIE_RUNTIME_CONTEXT_TYPE);
  assert.match(String(first.messages.at(-1)?.content), /Agent Run authority: coherent/);
  assert.match(String(first.messages.at(-1)?.content), /Task status: active/);
  assert.match(String(first.messages.at(-1)?.content), /Verification status: passed/);
  assert.deepEqual(harness.integration.runtime.state, semanticState);
  assert.deepEqual(harness.store.saves, []);

  const repeated = await harness.api.handler("context")(
    { type: "context", messages: first.messages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  assert.equal(repeated.messages.filter((message) => message.customType === PINDIE_RUNTIME_CONTEXT_TYPE).length, 1);

  await harness.api.tool("pindie_task_refine").execute("refine", {
    goal: "Refined runtime goal",
  });
  const afterStateMutation = await harness.api.handler("context")(
    { type: "context", messages: repeated.messages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  assert.match(String(afterStateMutation.messages.at(-1)?.content), /Goal:\nRefined runtime goal/);

  const { ref: contextEvidenceRef } = await captureObservationEvidence(
    harness,
    "context-evidence",
  );
  await harness.api.tool("pindie_verification_record").execute("verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [contextEvidenceRef],
    },
  });
  await beginAgentRun(harness);
  assert.equal(await callGuard(harness, toolCall("edit")), undefined);
  await harness.api.handler("tool_result")(toolResult("edit"), context("/repo"));
  const afterEdit = await harness.api.handler("context")(
    { type: "context", messages: afterStateMutation.messages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  assert.match(String(afterEdit.messages.at(-1)?.content), /Verification status: stale/);
});

test("P06 unavailable Runtime Context remains factual and consistent with fail-closed guards", async () => {
  const harness = createHarness();
  harness.store.loadErrors.set("/repo", new Error("invalid persisted State"));
  await startSession(harness, "/repo");

  const projected = await harness.api.handler("context")(
    { type: "context", messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };

  const content = String(projected.messages.at(-1)?.content);
  assert.match(content, /Agent Run authority: unavailable/);
  assert.match(content, /Could not load Pindie State for '\/repo': invalid persisted State/);
  assert.doesNotMatch(content, /Do not make consequential|Restore|Reload|call (?:a|the|pindie_)/i);
  assert.doesNotMatch(harness.integration.stateUnavailableReason ?? "", /Restore|Reload/);
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is unavailable.*project\.mutate/i);
});

test("unavailable before_agent_start also returns no systemPrompt override", async () => {
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
  ) as { systemPrompt?: string } | undefined;

  assert.equal(result?.systemPrompt, undefined);
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
  assert.match(statuses.at(-1)?.text ?? "", /◉ 52%/);

  currentTime += 5 * 60_000;
  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );

  assert.equal(calls, 2);
  assert.match(statuses.at(-1)?.text ?? "", /◉ 52%/);
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

  assert.match(statuses.at(-1)?.text ?? "", /◉ 68% • ↻ 6d23h • ⟳ 1 · 29d$/);
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
  assert.match(statuses.at(-1)?.text ?? "", /◉ 52%/);
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
  assert.match(statuses.at(-1)?.text ?? "", /last 0s • \$0.31 • auto • active • verify 0\/1/);
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
  assert.match(statuses.at(-1)?.text ?? "", /⏱ 0s • \$0.000 • auto • thinking • active • verify 0\/1/);

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
  assert.match(statuses.at(-1)?.text ?? "", /\$0.000 • auto • thinking • active • verify 0\/1/);

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
    text: "⏱ 0s • $0.000 • auto • thinking • active • verify 0/1",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "last 0s • $0.000 • auto • active • verify 0/1",
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
    text: "⏱ 0s • $0.000 • auto • thinking • active • ✓ 1/1",
  });

  await harness.api.tool("pindie_gate_open").execute("gate", {
    kind: "approval",
    question: "Approve release?",
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "⏱ 0s • $0.000 • auto • thinking • ✓ 1/1 • ⚠ gate: approval",
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
  })), /missing capability 'task\.replace'.*Task status: done/i);
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

test("TBE-E01-E20 idle State admits only observation and start_task while preserving existing guard ordering", async () => {
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
  for (const [name, input] of [
    ["edit", {}], ["write", {}], ["bash", { command: "git status" }], ["future_mutating_tool", {}],
    ["pindie_task_replace", {}],
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
    /task\.replace.*Task status: done/i,
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

test("G09-G11 blocked Tasks deny edit, write, bash, and ambiguous calls without mutation observation", async () => {
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
    assertBlocked(
      await callGuard(harness, toolCall(name, {}, `blocked-${name}`)),
      /missing capability 'project\.mutate'.*Task status: blocked/i,
    );
  }
  assert.equal(captures, 0);
  assert.deepEqual(harness.store.saves, []);
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

test("F01 before_agent_start captures and narrows the ordered Run Tool Baseline", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["edit", "read", "pindie_task_start", "bash"]);
  const callsBeforeRun = harness.api.setActiveToolsCalls.length;

  await beginAgentRun(harness);

  assert.deepEqual(harness.api.getActiveTools(), ["read", "pindie_task_start"]);
  assert.equal(harness.api.setActiveToolsCalls.length, callsBeforeRun + 1);
  assert.equal(harness.api.getActiveTools().includes("write"), false);
});

test("F02 before_agent_start never enables tools absent from the Pi/user baseline", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "pindie_task_refine"]);

  await beginAgentRun(harness);

  assert.deepEqual(harness.api.getActiveTools(), ["read", "pindie_task_refine"]);
  assert.equal(harness.api.getActiveTools().includes("edit"), false);
  assert.equal(harness.api.getActiveTools().includes("write"), false);
  assert.equal(harness.api.getActiveTools().includes("bash"), false);
});

test("M3 T03/T04 successful start expands active tools without same-Run replace", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  harness.api.setActiveTools([
    "read", "edit", "pindie_task_start", "pindie_task_replace",
    "pindie_task_refine", "pindie_task_progress", "pindie_verification_record",
    "pindie_gate_open",
  ]);
  await beginAgentRun(harness);

  await harness.api.tool("pindie_task_start").execute("start", {
    goal: "Task A",
    successCriteria: ["Works"],
  });

  assert.deepEqual(harness.api.getActiveTools(), [
    "read", "edit", "pindie_task_refine", "pindie_task_progress",
    "pindie_verification_record", "pindie_gate_open",
  ]);
});

test("M3 T05/T06 a pre-existing untouched Task exposes replace and successful refine removes it", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "edit", "pindie_task_replace", "pindie_task_refine"]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_task_replace", "pindie_task_refine"]);

  await harness.api.tool("pindie_task_refine").execute("refine", { goal: "Refined" });
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_task_refine"]);
});

test("M3 T07/T08 completion readiness exposes complete and known mutation invalidation removes it", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "edit", "pindie_verification_record", "pindie_task_complete"]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_verification_record"]);

  const { ref: readinessEvidenceRef } = await captureObservationEvidence(
    harness,
    "readiness-evidence",
  );
  await harness.api.tool("pindie_verification_record").execute("verify", {
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: [readinessEvidenceRef],
    },
  });
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_verification_record", "pindie_task_complete"]);

  assert.equal(await callGuard(harness, toolCall("edit", {}, "edit-ready")), undefined);
  await harness.api.handler("tool_result")(toolResult("edit", false, "edit-ready"), context("/repo"));
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_verification_record"]);
});

test("M3 T08 observed ambiguous mutation invalidation also removes complete", async () => {
  const fingerprints = [
    { kind: "known" as const, digest: "before" },
    { kind: "known" as const, digest: "after" },
  ];
  const harness = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => fingerprints.shift()!,
  });
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "bash", "pindie_task_complete"]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "bash", "pindie_task_complete"]);

  assert.equal(await callGuard(harness, toolCall("bash", {}, "bash-ready")), undefined);
  await harness.api.handler("tool_result")(toolResult("bash", false, "bash-ready"), context("/repo"));
  assert.deepEqual(harness.api.getActiveTools(), ["read", "bash"]);
});

test("M3 T09/T10 blocked State removes mutations and a same-Run Gate collapses to observation", async () => {
  const blocked = createHarness([["/repo", blockedState()]]);
  await startSession(blocked, "/repo");
  blocked.api.setActiveTools(["read", "edit", "write", "bash", "custom_tool", "pindie_task_refine"]);
  await beginAgentRun(blocked);
  assert.deepEqual(blocked.api.getActiveTools(), ["read", "pindie_task_refine"]);

  const gated = createHarness([["/repo", activeState()]]);
  await startSession(gated, "/repo");
  gated.api.setActiveTools(["read", "pindie_git_observe", "edit", "pindie_task_refine", "pindie_gate_open", "pindie_gate_resolve"]);
  await beginAgentRun(gated);
  await gated.api.tool("pindie_gate_open").execute("open", {
    kind: "approval",
    question: "Approve?",
  });
  assert.deepEqual(gated.api.getActiveTools(), ["read", "pindie_git_observe"]);
});

test("M3 T11/T12 a pre-existing Gate exposes resolve/refine/replace and resolve expands normal capabilities", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools([
    "read", "edit", "pindie_task_replace", "pindie_task_refine",
    "pindie_task_progress", "pindie_gate_resolve",
  ]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), [
    "read", "pindie_task_replace", "pindie_task_refine", "pindie_gate_resolve",
  ]);

  await harness.api.tool("pindie_gate_resolve").execute("resolve", {});
  assert.deepEqual(harness.api.getActiveTools(), [
    "read", "edit", "pindie_task_refine", "pindie_task_progress",
  ]);
});

test("M3 T13/T14 successful completion collapses to observation without task_start", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "edit", "pindie_task_start", "pindie_task_complete"]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_task_complete"]);

  await harness.api.tool("pindie_task_complete").execute("complete", { summary: "Done." });
  assert.deepEqual(harness.api.getActiveTools(), ["read"]);
});

test("M3 T15/T17 stale external State narrows the surface and Gateway denies a pre-generated call", async () => {
  const harness = createHarness([["/repo", activeState("Task A")]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "edit", "pindie_task_refine"]);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "edit", "pindie_task_refine"]);

  harness.store.states.set("/repo", activeState("External Task"));
  assertBlocked(await callGuard(harness, toolCall("edit", {}, "pre-generated")), /authority is stale.*project\.mutate/i);
  assert.deepEqual(harness.api.getActiveTools(), ["read"]);

  const projected = await harness.api.handler("context")(
    { type: "context", messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  const content = String(projected.messages.at(-1)?.content);
  assert.match(content, /Agent Run authority: stale/);
  assert.match(content, /Task status: active/);
  assert.match(content, /Verification status: pending/);
  assert.match(content, /Goal:\nExternal Task/);
  assert.doesNotMatch(content, /start a new Run|return control|do not mutate|call (?:a|the|pindie_)/i);
});

test("M3 T16 unavailable State narrows an active Run to baseline observations", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  harness.api.setActiveTools(["read", "pindie_git_observe", "edit", "pindie_task_refine"]);
  await beginAgentRun(harness);
  harness.store.loadErrors.set("/repo", new Error("State unavailable"));

  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is unavailable.*project\.mutate/i);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "pindie_git_observe"]);
});

test("F04 settlement restores the exact baseline and the next Run captures fresh idle configuration", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  const firstBaseline = ["edit", "read", "pindie_task_start", "bash"];
  harness.api.setActiveTools(firstBaseline);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "pindie_task_start"]);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.deepEqual(harness.api.getActiveTools(), firstBaseline);

  const secondBaseline = ["pindie_task_start", "write", "read"];
  harness.api.setActiveTools(secondBaseline);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["pindie_task_start", "read"]);
  await harness.api.handler("agent_settled")({ type: "agent_settled" }, context("/repo"));
  assert.deepEqual(harness.api.getActiveTools(), secondBaseline);
});

test("F05 session shutdown restores a baseline captured by an actually started Run", async () => {
  const harness = createHarness();
  await startSession(harness, "/repo");
  const baseline = ["bash", "read", "pindie_task_start", "edit"];
  harness.api.setActiveTools(baseline);
  await beginAgentRun(harness);
  assert.deepEqual(harness.api.getActiveTools(), ["read", "pindie_task_start"]);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "reload" },
    context("/repo"),
  );
  assert.deepEqual(harness.api.getActiveTools(), baseline);
});

test("M3 T21 unknown/custom baseline tools appear only while project.mutate exists", async () => {
  const active = createHarness([["/repo", activeState()]]);
  await startSession(active, "/repo");
  active.api.setActiveTools(["read", "custom_tool"]);
  await beginAgentRun(active);
  assert.deepEqual(active.api.getActiveTools(), ["read", "custom_tool"]);

  const idle = createHarness();
  await startSession(idle, "/repo");
  idle.api.setActiveTools(["read", "custom_tool"]);
  await beginAgentRun(idle);
  assert.deepEqual(idle.api.getActiveTools(), ["read"]);
});

test("M5 I01-I02/I07/I14/I20 captures factual observations and records Harness evidence end to end", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  const successful = await captureObservationEvidence(harness, "read-success", {
    input: { path: "src/extension.ts" },
    content: [{ type: "text", text: "current source" }],
  });
  assert.equal(successful.ref, "ev:read-success");
  assert.match(textOf(successful.result), /current source/);
  assert.match(textOf(successful.result), /\[Pindie evidence ref: ev:read-success\]/);

  const failed = await captureObservationEvidence(harness, "read-error", {
    isError: true,
    content: [{ type: "text", text: "ENOENT" }],
  });
  assert.equal(failed.ref, "ev:read-error");

  const git = await captureObservationEvidence(harness, "git-observe", {
    toolName: "pindie_git_observe",
    input: { action: "status" },
    content: [{ type: "text", text: "clean" }],
  });
  assert.equal(git.ref, "ev:git-observe");

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
  assert.equal(verification.resultPatch, undefined);
  const stored = harness.integration.runtime.state.task?.verification.checks[0];
  assert.equal(stored?.status, "passed");
  assert.deepEqual(stored?.covers, ["c1"]);
  assert.match(stored?.evidence ?? "", /Tool: read\nOutcome: success/);
  assert.match(stored?.evidence ?? "", /Tool: read\nOutcome: error/);
  assert.match(stored?.evidence ?? "", /Tool: pindie_git_observe/);
  assert.doesNotMatch(stored?.evidence ?? "", /ev:|read-success|generation/i);
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
    /Unknown or stale Pindie evidence reference: ev:not-real/,
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
  assert.equal(
    await successful.api.handler("tool_result")(
      toolResult("edit", false, "edit-success", [{ type: "text", text: "edited" }]),
      context("/repo"),
    ),
    undefined,
  );
  assert.equal(successful.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    successful.api.tool("pindie_verification_record").execute("old-ref", {
      check: { name: "old", status: "passed", covers: ["c1"], evidenceRefs: [prior.ref] },
    }),
    /Unknown or stale/,
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
  assert.equal(bash.ref, "ev:bash-unchanged");
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
  assert.equal(
    await changed.api.handler("tool_result")(
      toolResult("bash", false, "bash-changed", [{ type: "text", text: "mutated" }]),
      context("/repo"),
    ),
    undefined,
  );
  assert.equal(changed.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    changed.api.tool("pindie_verification_record").execute("stale", {
      check: { name: "stale", status: "passed", covers: [], evidenceRefs: [changedPrior.ref] },
    }),
    /Unknown or stale/,
  );

  const unknown = createHarness([["/repo", verifiedState()]], {}, {
    captureProjectFingerprint: async () => ({ kind: "unknown", reason: "cannot inspect" }),
  });
  await startSession(unknown, "/repo");
  await beginAgentRun(unknown);
  const unknownPrior = await captureObservationEvidence(unknown, "before-unknown-bash");
  assert.equal(await callGuard(unknown, toolCall("bash", {}, "bash-unknown")), undefined);
  assert.equal(
    await unknown.api.handler("tool_result")(toolResult("bash", true, "bash-unknown"), context("/repo")),
    undefined,
  );
  assert.equal(unknown.integration.runtime.state.task?.verification.stale, true);
  await assert.rejects(
    unknown.api.tool("pindie_verification_record").execute("stale", {
      check: { name: "stale", status: "passed", covers: [], evidenceRefs: [unknownPrior.ref] },
    }),
    /Unknown or stale/,
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
    /Unknown or stale/,
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
    /Unknown or stale/,
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
    /Unknown or stale/,
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
  assert.equal(
    await harness.api.handler("tool_result")(
      toolResult("bash", false, "ambiguous-a"),
      context("/repo"),
    ),
    undefined,
  );
  const betweenResults = await captureObservationEvidence(
    harness,
    "between-ambiguous-results",
  );
  assert.equal(
    await harness.api.handler("tool_result")(
      toolResult("custom_tool", false, "ambiguous-b"),
      context("/repo"),
    ),
    undefined,
  );
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
    /Unknown or stale/,
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
    /Unknown or stale/,
  );

  await beginAgentRun(harness);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("next-run-old", {
      check: { name: "old run", status: "passed", covers: ["c1"], evidenceRefs: [firstRun.ref] },
    }),
    /Unknown or stale/,
  );
  const secondRun = await captureObservationEvidence(harness, "second-run-ref");
  assert.equal(secondRun.ref, "ev:second-run-ref");

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "done" },
    context("/repo"),
  );
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("after-shutdown", {
      check: { name: "shutdown", status: "passed", covers: ["c1"], evidenceRefs: [secondRun.ref] },
    }),
    /Unknown or stale/,
  );

  await startSession(harness, "/repo", "reload");
  await beginAgentRun(harness);
  await assert.rejects(
    harness.api.tool("pindie_verification_record").execute("fresh-run-empty", {
      check: { name: "fresh", status: "passed", covers: ["c1"], evidenceRefs: [secondRun.ref] },
    }),
    /Unknown or stale/,
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
    /Unknown or stale/,
  );
});
