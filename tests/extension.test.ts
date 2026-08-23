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

  on(eventName: string, handler: CapturedHandler): void {
    assert.equal(this.handlers.has(eventName), false);
    this.handlers.set(eventName, handler);
  }

  registerTool(tool: { name: string }): void {
    this.tools.set(tool.name, tool);
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
): Record<string, unknown> {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getEntries: () => sessionEntries },
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

  return { api, store, integration };
}

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

test("the Extension registers the two existing Pindie tools and required hooks", () => {
  const { api } = createHarness();

  assert.deepEqual([...api.tools.keys()].sort(), ["pindie_gate", "pindie_state"]);
  assert.deepEqual([...api.handlers.keys()].sort(), [
    "agent_settled",
    "before_agent_start",
    "context",
    "session_shutdown",
    "session_start",
    "tool_call",
    "tool_execution_end",
    "tool_execution_start",
    "tool_result",
  ]);
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
  assert.match(statuses.at(-1)?.text ?? "", /last 0s • \$0.31 • verify 0\/1/);
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
  assert.match(statuses.at(-1)?.text ?? "", /⏱ 0s • \$0.000 • thinking • verify 0\/1/);

  await harness.api.handler("session_shutdown")(
    { type: "session_shutdown", reason: "new" },
    uiContext,
  );
  assert.equal(harness.integration.runCost.snapshot(entries as any), null);
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
  assert.match(statuses.at(-1)?.text ?? "", /\$0.000 • thinking • verify 0\/1/);

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
    text: "⏱ 0s • $0.000 • thinking • verify 0/1",
  });

  await harness.api.handler("agent_settled")(
    { type: "agent_settled" },
    uiContext,
  );
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "last 0s • $0.000 • verify 0/1",
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
    text: "⏱ 0s • $0.000 • thinking • ✓ 1/1",
  });

  await harness.api.tool("pindie_gate").execute("gate", {
    action: "open",
    kind: "approval",
    question: "Approve release?",
  });
  assert.deepEqual(statuses.at(-1), {
    id: "pindie-status",
    text: "⏱ 0s • $0.000 • thinking • ✓ 1/1 • ⚠ gate: approval",
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
