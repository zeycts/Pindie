import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  PINDIE_CORE_START,
  PINDIE_RUNTIME_CONTEXT_TYPE,
} from "../src/context.ts";
import {
  registerPindieExtension,
  type PindieExtensionOptions,
} from "../src/extension.ts";
import { EMPTY_STATE, type PindieState } from "../src/state.ts";
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
  thinkingLevel = "medium";
  private runtimeBound = false;

  on(eventName: string, handler: CapturedHandler): void {
    assert.equal(this.handlers.has(eventName), false);
    this.handlers.set(eventName, handler);
  }

  registerTool(tool: { name: string }): void {
    this.tools.set(tool.name, tool);
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
): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId,
    toolName,
    input: {},
    content: [],
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
): Promise<string> {
  const result = await harness.api.handler("before_agent_start")(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context(cwd, sessionEntries),
  ) as { systemPrompt: string };

  return result.systemPrompt;
}

async function callGuard(
  harness: ReturnType<typeof createHarness>,
  event: Record<string, unknown>,
): Promise<any> {
  return harness.api.handler("tool_call")(event, context("/repo"));
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

test("the Extension registers exactly three Pindie tools and required hooks", () => {
  const { api } = createHarness();

  assert.deepEqual([...api.tools.keys()].sort(), ["pindie_gate", "pindie_git_observe", "pindie_state"]);
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
  assert.match(continuationContent, /different Task.*replace_task/i);
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

test("T41-T43 before_agent_start preserves Pi prompt and injects one current Core block", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  const handler = harness.api.handler("before_agent_start");
  const first = await handler(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: "Pi system prompt",
      systemPromptOptions: {},
    },
    context("/repo"),
  ) as { systemPrompt: string };
  const second = await handler(
    {
      type: "before_agent_start",
      prompt: "Continue",
      systemPrompt: first.systemPrompt,
      systemPromptOptions: {},
    },
    context("/repo"),
  ) as { systemPrompt: string };

  assert.match(second.systemPrompt, /^Pi system prompt/);
  assert.match(second.systemPrompt, /Pindie Core Policy/);
  assert.doesNotMatch(second.systemPrompt, /Pindie Current State|Task status:|Wire Pi extension/);
  assert.equal(second.systemPrompt.split(PINDIE_CORE_START).length - 1, 1);
});

test("CP15-CP24 Context lifecycle projects fresh ephemeral Runtime Context", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
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
  assert.match(String(first.messages.at(-1)?.content), /Verification status: passed/);
  assert.deepEqual(harness.integration.runtime.state, semanticState);
  assert.deepEqual(harness.store.saves, []);

  const repeated = await harness.api.handler("context")(
    { type: "context", messages: first.messages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  assert.equal(repeated.messages.filter((message) => message.customType === PINDIE_RUNTIME_CONTEXT_TYPE).length, 1);

  await harness.api.tool("pindie_state").execute("refine", {
    action: "refine_task",
    goal: "Refined runtime goal",
  });
  const afterStateMutation = await harness.api.handler("context")(
    { type: "context", messages: repeated.messages },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };
  assert.match(String(afterStateMutation.messages.at(-1)?.content), /Goal:\nRefined runtime goal/);

  await harness.api.tool("pindie_state").execute("verify", {
    action: "record_verification",
    check: { name: "tests", status: "passed", covers: ["c1"], evidence: "passed" },
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

test("unavailable Runtime Context remains consistent with fail-closed guards", async () => {
  const harness = createHarness();
  harness.store.loadErrors.set("/repo", new Error("invalid persisted State"));
  await startSession(harness, "/repo");

  const projected = await harness.api.handler("context")(
    { type: "context", messages: [{ role: "user", content: "Continue", timestamp: 1 }] },
    context("/repo"),
  ) as { messages: Array<Record<string, unknown>> };

  assert.match(String(projected.messages.at(-1)?.content), /State: unavailable/);
  assert.match(String(projected.messages.at(-1)?.content), /invalid persisted State/);
  assertBlocked(await callGuard(harness, toolCall("edit")), /authority is unavailable.*project\.mutate/i);
});

test("load failure injects explicit unavailable Runtime Context", async () => {
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
  ) as { systemPrompt: string };

  assert.doesNotMatch(result.systemPrompt, /Pindie State is unavailable|invalid persisted State|"task": null/);
  assert.match(result.systemPrompt, new RegExp(PINDIE_CORE_START));
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
  for (const name of ["read", "grep", "find", "ls", "pindie_git_observe", "pindie_state", "pindie_gate", "edit", "write"]) {
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
      toolCall("pindie_state", { action: "refine_task", goal: "Refined" }),
    ),
    undefined,
  );
  assert.equal(
    await callGuard(harness, toolCall("pindie_gate", { action: "resolve" })),
    undefined,
  );
});

test("H08 Human Gate blocks other pindie_state actions", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "set_open_loops" }),
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

test("H10 completed task allows pindie_state start_task", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "start_task" }),
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
    ["pindie_state", { action: "start_task" }], ["custom", {}],
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

  await harness.api.tool("pindie_state").execute("verify", {
    action: "record_verification",
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidence: "passed",
    },
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "⏱ 0s • $0.000 • auto • thinking • active • ✓ 1/1",
  });

  await harness.api.tool("pindie_gate").execute("gate", {
    action: "open",
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
  await harness.api.tool("pindie_state").execute("start", {
    action: "start_task",
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

  await harness.api.tool("pindie_state").execute("verify", {
    action: "record_verification",
    check: { name: "status", status: "passed", covers: ["c1"], evidence: "passed" },
  });
  assert.match(status(), /active • ✓ 1\/1/);
  assert.doesNotMatch(status(), /done/);

  await harness.api.tool("pindie_state").execute("complete", {
    action: "complete_task",
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

  const verification = await harness.api.tool("pindie_state").execute("verify", {
    action: "record_verification",
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidence: "passed",
    },
  });
  const gate = await harness.api.tool("pindie_gate").execute("gate", {
    action: "open",
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

  const result = await harness.api.tool("pindie_state").execute("complete", {
    action: "complete_task",
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
      toolCall("pindie_state", { action: "start_task" }),
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
  const replacement = { action: "replace_task", goal: "Task B", successCriteria: ["Task B works"] };

  for (const initial of [activeState(), { task: { ...activeState().task!, openLoops: { blockers: ["Blocked"], questions: [], nextIntent: null } } }, gatedState()]) {
    const harness = createHarness([["/repo", initial]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    assert.equal(await callGuard(harness, toolCall("pindie_state", replacement)), undefined);
    await harness.api.tool("pindie_state").execute("replace", replacement);
    assert.equal(harness.integration.runtime.state.task?.goal, "Task B");
    assert.equal(harness.integration.runtime.state.task?.humanGate, null);
    assert.equal(await callGuard(harness, toolCall("edit")), undefined);
    assertBlocked(await callGuard(harness, toolCall("pindie_state", {
      action: "replace_task", goal: "Task C", successCriteria: ["Task C works"],
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
    ["pindie_state", { action: "refine_task" }],
    ["pindie_gate", { action: "open" }], ["unknown", {}],
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
  assert.equal(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Works"],
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
  await created.api.tool("pindie_state").execute("start", {
    action: "start_task", goal: "Task A", successCriteria: ["Task A works"],
  });
  assertBlocked(await callGuard(created, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'/i);

  for (const mutate of [
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_state").execute("refine", { action: "refine_task", goal: "Refined A" }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_state").execute("loops", { action: "set_open_loops", blockers: [], questions: ["Question"] }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_gate").execute("gate", { action: "open", kind: "input", question: "Input?" }),
    async (harness: ReturnType<typeof createHarness>) => {
      assert.equal(await callGuard(harness, toolCall("edit")), undefined);
      await harness.api.handler("tool_result")(toolResult("edit"), context("/repo"));
    },
  ]) {
    const harness = createHarness([["/repo", activeState()]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    await mutate(harness);
    assertBlocked(await callGuard(harness, toolCall("pindie_state", {
      action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
    })), /missing capability 'task\.replace'/i);
  }
});

test("TB25 resolving a run-start Human Gate also consumes replacement eligibility", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.tool("pindie_gate").execute("resolve", { action: "resolve" });
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'/i);
});

test("TB26-TB27 completed Task start boundaries do not make a same-run Task replaceable", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
  })), /missing capability 'task\.replace'.*Task status: done/i);
  assert.equal(await callGuard(harness, toolCall("pindie_state", {
    action: "start_task", goal: "Task B", successCriteria: ["Task B works"],
  })), undefined);
  await harness.api.tool("pindie_state").execute("start", {
    action: "start_task", goal: "Task B", successCriteria: ["Task B works"],
  });
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task C", successCriteria: ["Task C works"],
  })), /missing capability 'task\.replace'/i);
});

test("RG01 a gate opened during the run blocks same-run refinement", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate").execute("open", {
    action: "open",
    kind: "decision",
    question: "Which release strategy should we use?",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "refine_task", goal: "Refined" }),
    ),
    /missing capability 'task\.refine'.*waiting_human/i,
  );
});

test("RG02 a gate opened during the run blocks same-run resolution", async () => {
  const harness = createHarness([["/repo", activeState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate").execute("open", {
    action: "open",
    kind: "decision",
    question: "Which release strategy should we use?",
  });

  assertBlocked(
    await callGuard(harness, toolCall("pindie_gate", { action: "resolve" })),
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
      toolCall("pindie_state", { action: "refine_task", goal: "Refined" }),
    ),
    undefined,
  );
});

test("RG04 a gate present at run start permits gate resolution", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  assert.equal(
    await callGuard(harness, toolCall("pindie_gate", { action: "resolve" })),
    undefined,
  );
});

test("RG05 resolving Gate A then opening Gate B does not consume Gate B in the same run", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_gate").execute("resolve-a", {
    action: "resolve",
  });
  await harness.api.tool("pindie_gate").execute("open-b", {
    action: "open",
    kind: "approval",
    question: "Approve the release?",
  });

  assertBlocked(
    await callGuard(harness, toolCall("pindie_gate", { action: "resolve" })),
    /missing capability 'gate\.resolve'.*waiting_human/i,
  );
  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "refine_task", goal: "Approved" }),
    ),
    /missing capability 'task\.refine'.*waiting_human/i,
  );
});

test("RC01 a task completed during the run blocks same-run replacement", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_state").execute("complete", {
    action: "complete_task",
    summary: "Completed the verified task.",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "start_task" }),
    ),
    /missing capability 'task\.start'.*Task status: done/i,
  );
});

test("RC02 a task completed during the run blocks same-run mutation", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_state").execute("complete", {
    action: "complete_task",
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
      toolCall("pindie_state", { action: "start_task" }),
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

  assert.equal(await callGuard(harness, toolCall("pindie_state", { action: "start_task" })), undefined);
  for (const [name, input] of [
    ["edit", {}], ["write", {}], ["bash", { command: "git status" }], ["future_mutating_tool", {}],
    ...["replace_task", "refine_task", "set_open_loops", "record_verification", "complete_task"].map((action) => ["pindie_state", { action }]),
    ...["open", "resolve"].map((action) => ["pindie_gate", { action }]),
  ] as Array<[string, Record<string, unknown>]>) {
    assertBlocked(await callGuard(harness, toolCall(name, input)), /missing capability.*Task status: idle/i);
  }

  await harness.api.tool("pindie_state").execute("start", {
    action: "start_task", goal: "Task A", successCriteria: ["Task A works"],
  });
  assert.equal(harness.integration.runtime.state.task?.goal, "Task A");
  for (const name of ["edit", "write", "bash", "future_mutating_tool"]) {
    assert.equal(await callGuard(harness, toolCall(name)), undefined);
  }
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
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
  assertBlocked(await callGuard(staleIdle, toolCall("pindie_state", { action: "start_task" })), /authority is stale.*task\.start/i);

  const unavailable = createHarness();
  unavailable.store.loadErrors.set("/repo", new Error("State cannot be loaded"));
  await startSession(unavailable, "/repo");
  assertBlocked(await callGuard(unavailable, toolCall("pindie_state", { action: "start_task" })), /authority is unavailable.*task\.start/i);
});

test("RC04 replacing Task A then completing Task B does not permit Task C in the same run", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  await harness.api.tool("pindie_state").execute("start-b", {
    action: "start_task",
    goal: "Task B",
    successCriteria: ["Task B works"],
  });
  await harness.api.tool("pindie_state").execute("verify-b", {
    action: "record_verification",
    check: {
      name: "tests",
      status: "passed",
      covers: ["c1"],
      evidence: "Task B tests passed.",
    },
  });
  await harness.api.tool("pindie_state").execute("complete-b", {
    action: "complete_task",
    summary: "Completed Task B.",
  });

  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "start_task" }),
    ),
    /missing capability 'task\.start'.*Task status: done/i,
  );
});

test("G01-G08 M2 Task admission and replacement follow Run-derived capabilities", async () => {
  const idle = createHarness();
  await startSession(idle, "/repo");
  await beginAgentRun(idle);
  assertBlocked(await callGuard(idle, toolCall("edit")), /project\.mutate.*Task status: idle/i);

  const startInput = { action: "start_task", goal: "Task A", successCriteria: ["Task A works"] };
  assert.equal(await callGuard(idle, toolCall("pindie_state", startInput, "start-a")), undefined);
  await idle.api.tool("pindie_state").execute("start-a", startInput);
  await idle.api.handler("tool_result")(toolResult("pindie_state", false, "start-a"), context("/repo"));
  assert.equal(await callGuard(idle, toolCall("edit")), undefined);

  const done = createHarness([["/repo", completedState()]]);
  await startSession(done, "/repo");
  await beginAgentRun(done);
  assert.equal(await callGuard(done, toolCall("pindie_state", { action: "start_task" })), undefined);
  assertBlocked(
    await callGuard(done, toolCall("pindie_state", { action: "replace_task" })),
    /task\.replace.*Task status: done/i,
  );

  const replace = createHarness([["/repo", activeState("Task A")]]);
  await startSession(replace, "/repo");
  await beginAgentRun(replace);
  const replacement = { action: "replace_task", goal: "Task B", successCriteria: ["Task B works"] };
  assert.equal(await callGuard(replace, toolCall("pindie_state", replacement, "replace-b")), undefined);
  await replace.api.tool("pindie_state").execute("replace-b", replacement);
  await replace.api.handler("tool_result")(toolResult("pindie_state", false, "replace-b"), context("/repo"));
  assertBlocked(
    await callGuard(replace, toolCall("pindie_state", { ...replacement, goal: "Task C" }, "replace-c")),
    /missing capability 'task\.replace'/i,
  );

  const failedReplace = createHarness([["/repo", activeState("Task A")]]);
  await startSession(failedReplace, "/repo");
  await beginAgentRun(failedReplace);
  assert.equal(
    await callGuard(failedReplace, toolCall("pindie_state", replacement, "replace-failed")),
    undefined,
  );
  await failedReplace.api.handler("tool_result")(
    toolResult("pindie_state", true, "replace-failed"),
    context("/repo"),
  );
  assert.equal(
    await callGuard(failedReplace, toolCall("pindie_state", replacement, "replace-retry")),
    undefined,
  );

  const refined = createHarness([["/repo", activeState("Task A")]]);
  await startSession(refined, "/repo");
  await beginAgentRun(refined);
  const refine = { action: "refine_task", goal: "Refined Task A" };
  assert.equal(await callGuard(refined, toolCall("pindie_state", refine, "refine-a")), undefined);
  await refined.api.tool("pindie_state").execute("refine-a", refine);
  assertBlocked(
    await callGuard(refined, toolCall("pindie_state", replacement, "replace-after-refine")),
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
      await callGuard(harness, toolCall("pindie_state", { action: "complete_task" }, `complete-${name}`)),
      new RegExp(`missing capability 'task\\.complete'.*Verification: ${verification}`, "i"),
    );
    assert.equal(harness.integration.runtime.state, before);
    assert.deepEqual(harness.store.saves, []);
  }

  const ready = createHarness([["/repo", verifiedState()]]);
  await startSession(ready, "/repo");
  await beginAgentRun(ready);
  const input = { action: "complete_task", summary: "Verified and complete." };
  assert.equal(await callGuard(ready, toolCall("pindie_state", input, "complete-ready")), undefined);
  await ready.api.tool("pindie_state").execute("complete-ready", input);
  assert.equal(ready.integration.runtime.state.task?.completed, true);
});

test("M07 and malformed semantic calls never enter Project Mutation Freshness", async () => {
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
    await callGuard(harness, toolCall("pindie_state", { action: "refine_task" }, "semantic-state")),
    undefined,
  );
  assert.equal(
    await callGuard(harness, toolCall("pindie_gate", { action: "open" }, "semantic-gate")),
    undefined,
  );
  assertBlocked(
    await callGuard(harness, toolCall("pindie_state", {}, "malformed-state")),
    /invalid semantic action/i,
  );
  assertBlocked(
    await callGuard(harness, toolCall("pindie_gate", { action: "unknown" }, "malformed-gate")),
    /invalid semantic action/i,
  );
  assert.equal(captures, 0);
});
