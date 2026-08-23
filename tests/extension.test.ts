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
): Record<string, unknown> {
  return { type: "tool_call", toolCallId: `call-${toolName}`, toolName, input };
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
): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId: `call-${toolName}`,
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
  await api.commands.get("reasoning").handler("high", context("/repo"));
  assert.equal(api.appliedThinkingLevels.at(-1), "high");
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
  harness.integration.reasoning.setFixed("max");
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
  assert.match(notices.at(-1)?.message ?? "", /Reasoning: fixed · requested max · effective high/);
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

test("the Extension registers the two existing Pindie tools and required hooks", () => {
  const { api } = createHarness();

  assert.deepEqual([...api.tools.keys()].sort(), ["pindie_gate", "pindie_state"]);
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

test("AR20-AR35 reasoning integration follows public Pi lifecycle without State persistence", async () => {
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
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("edit")] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "medium");
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("edit")] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "low");
  const countBeforeTerminal = harness.api.appliedThinkingLevels.length;
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [] }, context("/repo"));
  assert.equal(harness.api.appliedThinkingLevels.length, countBeforeTerminal);
  const command = harness.api.commands.get("reasoning");
  const notices: string[] = [];
  const commandContext = { ...context("/repo"), ui: { notify: (message: string) => notices.push(message) } };
  await command.handler("status", commandContext);
  assert.match(notices.at(-1) ?? "", /auto; requested low; effective low/);
  await command.handler("high", commandContext);
  assert.deepEqual(harness.integration.reasoning.snapshot, { mode: "fixed", requestedLevel: "high", effectiveLevel: "high" });
  await harness.api.handler("turn_end")({ type: "turn_end", toolResults: [toolResult("edit")] }, context("/repo"));
  assert.equal(harness.integration.reasoning.snapshot.requestedLevel, "high");
  await command.handler("invalid", commandContext);
  assert.equal(harness.integration.reasoning.snapshot.requestedLevel, "high");
  await command.handler("auto", context("/repo"));
  assert.equal(harness.integration.reasoning.snapshot.mode, "auto");
  assert.equal(harness.api.appliedThinkingLevels.at(-1), "medium");
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
  assertBlocked(await callGuard(harness, toolCall("edit")), /State is unavailable/i);

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
  assertBlocked(await callGuard(harness, toolCall("edit")), /State is unavailable/i);
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

test("T48 bash does not blindly invalidate verification", async () => {
  const harness = createHarness([["/repo", verifiedState()]]);
  await startSession(harness, "/repo");

  await harness.api.handler("tool_result")(
    toolResult("bash"),
    context("/repo"),
  );

  assert.equal(harness.integration.runtime.state.task?.verification.stale, false);
  assert.deepEqual(harness.store.saves, []);
});

test("H01-H04 Human Gate blocks edit, write, bash, and unknown tools", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["edit", "write", "bash", "deploy_custom"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /Human Gate is open/i);
  }
});

test("H05 Human Gate allows read-only observation tools", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["read", "grep", "find", "ls"]) {
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
    /Human Gate is open/i,
  );
});

test("H09 completed task blocks edit, write, and bash", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);

  for (const name of ["edit", "write", "bash"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /completed and terminal/i);
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

  for (const name of ["edit", "write", "bash", "pindie_state", "custom"]) {
    assertBlocked(await callGuard(harness, toolCall(name)), /State is unavailable/i);
  }
  assert.equal(await callGuard(harness, toolCall("read")), undefined);
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
  assert.match(statuses.at(-1)?.text ?? "", /last 0s • \$0.31 • auto • verify 0\/1/);
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
  assert.match(statuses.at(-1)?.text ?? "", /⏱ 0s • \$0.000 • auto • thinking • verify 0\/1/);

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
  assert.match(statuses.at(-1)?.text ?? "", /\$0.000 • auto • thinking • verify 0\/1/);

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
    text: "⏱ 0s • $0.000 • auto • thinking • verify 0/1",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "last 0s • $0.000 • auto • verify 0/1",
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
    text: "⏱ 0s • $0.000 • auto • thinking • ✓ 1/1",
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
  assertBlocked(await callGuard(harness, toolCall("edit")), /completed and terminal/i);
  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "start_task" }),
    ),
    /completed during this Agent run/i,
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
    })), /only replace the unfinished Task that existed at the start/i);
  }
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
  })), /only replace the unfinished Task that existed at the start/i);

  for (const mutate of [
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_state").execute("refine", { action: "refine_task", goal: "Refined A" }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_state").execute("loops", { action: "set_open_loops", blockers: [], questions: ["Question"] }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.tool("pindie_gate").execute("gate", { action: "open", kind: "input", question: "Input?" }),
    async (harness: ReturnType<typeof createHarness>) => harness.api.handler("tool_result")(toolResult("edit"), context("/repo")),
  ]) {
    const harness = createHarness([["/repo", activeState()]]);
    await startSession(harness, "/repo");
    await beginAgentRun(harness);
    await mutate(harness);
    assertBlocked(await callGuard(harness, toolCall("pindie_state", {
      action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
    })), /only replace the unfinished Task that existed at the start/i);
  }
});

test("TB25 resolving a run-start Human Gate also consumes replacement eligibility", async () => {
  const harness = createHarness([["/repo", gatedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  await harness.api.tool("pindie_gate").execute("resolve", { action: "resolve" });
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
  })), /only replace the unfinished Task that existed at the start/i);
});

test("TB26-TB27 completed Task start boundaries do not make a same-run Task replaceable", async () => {
  const harness = createHarness([["/repo", completedState()]]);
  await startSession(harness, "/repo");
  await beginAgentRun(harness);
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task B", successCriteria: ["Task B works"],
  })), /completed and terminal/i);
  assert.equal(await callGuard(harness, toolCall("pindie_state", {
    action: "start_task", goal: "Task B", successCriteria: ["Task B works"],
  })), undefined);
  await harness.api.tool("pindie_state").execute("start", {
    action: "start_task", goal: "Task B", successCriteria: ["Task B works"],
  });
  assertBlocked(await callGuard(harness, toolCall("pindie_state", {
    action: "replace_task", goal: "Task C", successCriteria: ["Task C works"],
  })), /only replace the unfinished Task that existed at the start/i);
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
    /opened during the current Agent run/i,
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
    /opened during the current Agent run/i,
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
    /opened during the current Agent run/i,
  );
  assertBlocked(
    await callGuard(
      harness,
      toolCall("pindie_state", { action: "refine_task", goal: "Approved" }),
    ),
    /opened during the current Agent run/i,
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
    /completed during this Agent run/i,
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
    assertBlocked(await callGuard(harness, toolCall(name)), /completed and terminal/i);
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
    /completed during this Agent run/i,
  );
});
