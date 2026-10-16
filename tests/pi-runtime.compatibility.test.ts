import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type AgentBeforeSettleEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, fauxProvider, getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { PINDIE_CONTINUATION_PROBE_MESSAGE, PINDIE_CONTINUATION_PROBE_TYPE } from "../src/continuation.ts";
import { Type } from "typebox";
import { PINDIE_QUOTA_FALLBACK_MESSAGE, PINDIE_QUOTA_FALLBACK_TYPE } from "../src/quota-fallback-supervisor.ts";
import { createLearningSessionRunner } from "../src/learning-session-runner.ts";
import {
  PINDIE_QUOTA_RESUME_MESSAGE,
  PINDIE_QUOTA_RESUME_TYPE,
} from "../src/quota-resume-supervisor.ts";

interface RealPiHarness {
  readonly session: AgentSession;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly root: string;
}

type BeforeAgentStartHook = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => BeforeAgentStartEventResult | undefined | Promise<BeforeAgentStartEventResult | undefined>;

async function createRealPiHarness(
  beforeAgentStart?: BeforeAgentStartHook,
  customTools: ToolDefinition[] = [],
  onSettled?: (pi: ExtensionAPI) => void,
  beforeSettle?: () => AgentBeforeSettleEventResult | undefined,
): Promise<RealPiHarness> {
  const root = await mkdtemp(join(tmpdir(), "pindie-pi-compatibility-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  const faux = fauxProvider({ provider: `faux-${Date.now()}-${Math.random()}` });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const extensionFactories: InlineExtension[] = beforeAgentStart || onSettled || beforeSettle
    ? [
        (pi) => {
          if (beforeAgentStart) pi.on("before_agent_start", (event, ctx) => beforeAgentStart(event, ctx, pi));
          if (onSettled) pi.on("agent_settled", () => onSettled(pi));
          if (beforeSettle) pi.on("agent_before_settle", beforeSettle);
        },
      ]
    : [];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: customTools.length > 0 ? "builtin" : "all",
    customTools,
  });
  await session.bindExtensions({});

  return { session, faux, root };
}

async function disposeHarness(harness: RealPiHarness): Promise<void> {
  harness.session.dispose();
  await rm(harness.root, { recursive: true, force: true });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function providerSystemPrompt(context: { messages?: readonly unknown[] } | undefined): string | undefined {
  const systemMessage = context?.messages?.find((message) =>
    typeof message === "object" && message !== null &&
    (message as { role?: unknown }).role === "system",
  );
  if (typeof systemMessage !== "object" || systemMessage === null) return undefined;
  return getSystemMessageText(systemMessage as SystemMessage);
}

test("Pi 1.3.0 SDK defaults do not load new CLI extensions", async () => {
  const harness = await createRealPiHarness(undefined, [compatibilityTool]);
  try {
    assert.deepEqual(harness.session.getAllTools().map((tool) => tool.name),
      ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "compatibility-tool"]);
    assert.deepEqual(harness.session.getActiveToolNames(), ["compatibility-tool"]);
    assert.equal(harness.session.resourceLoader.getExtensions().extensions.length, 0);
    assert.equal(harness.session.extensionRunner.getRegisteredCommands().length, 0);
  } finally { await disposeHarness(harness); }
});

test("Pi 1.3.0 custom preflight explicit selectedTools edit wins over live loadout", async () => {
  let context: unknown;
  const harness = await createRealPiHarness((event, _ctx, pi) => {
    pi.setActiveTools(["compatibility-tool"]);
    event.systemPromptOptions.selectedTools = [];
    return undefined;
  }, [compatibilityTool]);
  try {
    harness.faux.setResponses([(value) => { context = value; return fauxAssistantMessage("done"); }]);
    await harness.session.sendCustomMessage({ customType: "runtime-trigger", content: "start", display: false }, { triggerTurn: true });
    assert.deepEqual(harness.session.getActiveToolNames(), []);
    assert.doesNotMatch(JSON.stringify(context), /compatibility-tool/);
  } finally { await disposeHarness(harness); }
});

test("Pi 1.3.0 fallback hidden trigger gets one fresh preflight and settlement", async () => {
  const triggerTypes: string[] = [];
  let settlements = 0;
  const harness = await createRealPiHarness((event) => {
    assert.equal(event.messageType, "custom");
    if (event.messageType === "custom") {
      triggerTypes.push(event.message.customType);
      assert.equal(event.message.content, PINDIE_QUOTA_FALLBACK_MESSAGE);
    }
    assert.equal("prompt" in event, false);
    return undefined;
  }, [], () => { settlements++; });
  try {
    harness.faux.setResponses([fauxAssistantMessage("resumed")]);
    await harness.session.sendCustomMessage({ customType: PINDIE_QUOTA_FALLBACK_TYPE, content: PINDIE_QUOTA_FALLBACK_MESSAGE, display: false }, { triggerTurn: true });
    assert.deepEqual(triggerTypes, [PINDIE_QUOTA_FALLBACK_TYPE]);
    assert.equal(settlements, 1);
    const triggers = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === PINDIE_QUOTA_FALLBACK_TYPE);
    assert.equal(triggers.length, 1);
    assert.equal((triggers[0] as { display: boolean }).display, false);
  } finally { await disposeHarness(harness); }
});

test("Pi 1.3.0 isolated learning startup executes with no tools/resources in a fresh Session", async () => {
  const harness = await createRealPiHarness();
  const sessions: AgentSession[] = [];
  try {
    harness.faux.setResponses([fauxAssistantMessage("learning one"), fauxAssistantMessage("learning two")]);
    const model = harness.faux.getModel();
    const runner = createLearningSessionRunner({ cwd: harness.root, model,
      policy: { provider: model.provider, modelId: model.id, thinkingLevel: "low" },
      createSession: (options) => createAgentSession({ ...options, modelRuntime: harness.session.modelRuntime }),
      onCreated: (session) => {
        sessions.push(session);
        assert.deepEqual(session.getAllTools(), []);
        assert.equal(session.resourceLoader.getExtensions().extensions.length, 0);
        assert.deepEqual(session.extensionRunner.getRegisteredCommands(), []);
        assert.deepEqual(session.resourceLoader.getSkills().skills, []);
        assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
        assert.deepEqual(session.resourceLoader.getThemes().themes, []);
        assert.deepEqual(session.messages, []);
      },
    });
    assert.equal((await runner.run("bounded one", new AbortController().signal)).text, "learning one");
    assert.equal((await runner.run("bounded two", new AbortController().signal)).text, "learning two");
    assert.notEqual(sessions[0]?.sessionManager, sessions[1]?.sessionManager);
    assert.deepEqual(harness.session.messages, []);
  } finally { await disposeHarness(harness); }
});

const compatibilityTool: ToolDefinition = {
  name: "compatibility-tool",
  label: "Compatibility tool",
  description: "A harmless tool used to verify Pi's active tool loadout.",
  promptSnippet: "compatibility-tool",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: "compatibility tool" }],
  }),
};

// Behavioral patch-retirement contract: these invariants must pass against
// pristine published Pi, without the historical downstream custom-trigger patch.
test("Pi 1.3.0 native: idle custom trigger runs before_agent_start preflight and applies its result", async () => {
  let beforeAgentStartCalls = 0;
  let providerContext: { messages?: readonly unknown[] } | undefined;
  const harness = await createRealPiHarness(() => {
    beforeAgentStartCalls += 1;
    return {
      systemPrompt: "downstream compatibility system prompt",
      message: {
        customType: "compatibility-injected",
        content: [{ type: "text", text: "injected custom message" }],
        display: false,
      },
    };
  });

  try {
    harness.faux.setResponses([(context) => {
      providerContext = context;
      return fauxAssistantMessage("done");
    }]);
    await harness.session.sendCustomMessage(
      { customType: "runtime-trigger", content: "wake up", display: false },
      { triggerTurn: true },
    );

    // Native custom preflight must apply both the prompt and injected message.
    assert.equal(beforeAgentStartCalls, 1);
    assert.equal(providerSystemPrompt(providerContext), "downstream compatibility system prompt");
    assert.ok(providerContext?.messages?.some((message) => {
      if (typeof message !== "object" || message === null) return false;
      const candidate = message as { content?: unknown };
      return Array.isArray(candidate.content)
        && candidate.content.some((part) =>
          typeof part === "object"
          && part !== null
          && "text" in part
          && part.text === "injected custom message",
        );
    }));
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0 custom system-prompt override does not replace the base for a successor Run", async () => {
  let preflights = 0;
  const contexts: { messages?: readonly unknown[] }[] = [];
  const harness = await createRealPiHarness(() => ++preflights === 1
    ? { systemPrompt: "one-run override" } : undefined);
  try {
    const basePrompt = harness.session.systemPrompt;
    harness.faux.setResponses([
      (context) => { contexts.push(context); return fauxAssistantMessage("first"); },
      (context) => { contexts.push(context); return fauxAssistantMessage("second"); },
    ]);
    for (const content of ["first", "second"]) {
      await harness.session.sendCustomMessage({ customType: "runtime-trigger", content, display: false }, { triggerTurn: true });
    }
    assert.equal(preflights, 2);
    assert.equal(providerSystemPrompt(contexts[0]), "one-run override");
    assert.equal(providerSystemPrompt(contexts[1]), basePrompt);
    const triggers = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "runtime-trigger");
    assert.equal(triggers.length, 2);
    assert.equal(harness.session.messages.some((message) => message.role === "user"), false);
  } finally { await disposeHarness(harness); }
});

test("Pi 1.3.0 native: idle custom trigger preserves the live active tool loadout", async () => {
  let providerContext: { messages?: readonly unknown[] } | undefined;
  const harness = await createRealPiHarness((_event, _ctx, pi) => {
    pi.setActiveTools(["compatibility-tool"]);
  }, [compatibilityTool]);

  try {
    harness.session.setActiveToolsByName([]);
    harness.faux.setResponses([(context) => {
      providerContext = context;
      return fauxAssistantMessage("done");
    }]);
    await harness.session.sendCustomMessage(
      { customType: "runtime-trigger", content: "wake up", display: false },
      { triggerTurn: true },
    );

    assert.deepEqual(harness.session.getActiveToolNames(), ["compatibility-tool"]);
    const providerSystemMessage = providerContext?.messages?.find((message) =>
      typeof message === "object" && message !== null &&
      (message as { role?: unknown }).role === "system",
    );
    assert.match(JSON.stringify(providerSystemMessage), /compatibility-tool/);
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0 settled custom successor runs preflight with the current tool loadout", async () => {
  const prompts: string[] = [];
  const providerContexts: { messages?: readonly unknown[] }[] = [];
  let settlements = 0;
  const harness = await createRealPiHarness(
    (event, _ctx, pi) => {
      assert.equal(event.messageType, "custom");
      if (event.messageType === "custom") prompts.push(event.message.content as string);
      if (prompts.length === 2) pi.setActiveTools(["compatibility-tool"]);
      return undefined;
    },
    [compatibilityTool],
    (pi) => {
      if (++settlements === 1) {
        void pi.sendMessage(
          { customType: "settled-successor", content: "continue after settled", display: false },
          { triggerTurn: true },
        );
      }
    },
  );
  try {
    harness.session.setActiveToolsByName([]);
    harness.faux.setResponses([
      (context) => { providerContexts.push(context); return fauxAssistantMessage("first"); },
      (context) => { providerContexts.push(context); return fauxAssistantMessage("second"); },
    ]);
    await harness.session.sendCustomMessage(
      { customType: "runtime-trigger", content: "start", display: false },
      { triggerTurn: true },
    );
    await harness.session.waitForIdle();
    assert.deepEqual(prompts, ["start", "continue after settled"]);
    assert.equal(settlements, 2);
    assert.equal(providerContexts.length, 2);
    assert.match(JSON.stringify(providerContexts[1]), /compatibility-tool/);
    assert.deepEqual(harness.session.getActiveToolNames(), ["compatibility-tool"]);
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0 boundary probe continues once within the same Run and settles after the final pass", async () => {
  let preflights = 0;
  let boundaries = 0;
  let settlements = 0;
  const contexts: { messages?: readonly unknown[] }[] = [];
  const harness = await createRealPiHarness(
    () => { preflights++; return undefined; },
    [],
    () => { settlements++; },
    () => {
      if (++boundaries !== 1) return undefined;
      return {
        entries: [{ type: "custom_message", customType: PINDIE_CONTINUATION_PROBE_TYPE,
          content: PINDIE_CONTINUATION_PROBE_MESSAGE, display: false }],
        continue: true,
      };
    },
  );
  try {
    harness.faux.setResponses([
      (context) => { contexts.push(context); assert.equal(settlements, 0); return fauxAssistantMessage("first"); },
      (context) => { contexts.push(context); assert.equal(settlements, 0); return fauxAssistantMessage("second"); },
    ]);
    await harness.session.sendCustomMessage(
      { customType: "runtime-trigger", content: "start", display: false },
      { triggerTurn: true },
    );
    assert.equal(preflights, 1);
    assert.equal(boundaries, 2);
    assert.equal(settlements, 1);
    assert.equal(contexts.length, 2);
    assert.match(JSON.stringify(contexts[1]), /Pindie continuation probe/);
    assert.equal(harness.session.sessionManager.getBranch().filter((entry) =>
      entry.type === "custom_message" && entry.customType === PINDIE_CONTINUATION_PROBE_TYPE,
    ).length, 1);
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0 quota trigger: preflight exposes the typed hidden message before branch append", async () => {
  let preflightMessage: { customType: string; content: unknown; display: boolean; role: string } | undefined;
  let preflightBranch: readonly unknown[] | undefined;
  const harness = await createRealPiHarness((event, ctx) => {
    assert.equal(event.messageType, "custom");
    assert.equal("prompt" in event, false);
    if (event.messageType === "custom") preflightMessage = event.message;
    preflightBranch = ctx.sessionManager.getBranch();
    return undefined;
  });

  try {
    harness.faux.setResponses([fauxAssistantMessage("done")]);
    await harness.session.sendCustomMessage(
      { customType: PINDIE_QUOTA_RESUME_TYPE, content: PINDIE_QUOTA_RESUME_MESSAGE, display: false },
      { triggerTurn: true },
    );

    assert.equal(preflightMessage?.role, "custom");
    assert.equal(preflightMessage?.customType, PINDIE_QUOTA_RESUME_TYPE);
    assert.equal(preflightMessage?.content, PINDIE_QUOTA_RESUME_MESSAGE);
    assert.equal(preflightMessage?.display, false);
    assert.equal(preflightBranch?.some((entry) =>
      typeof entry === "object" && entry !== null &&
      "customType" in entry && entry.customType === PINDIE_QUOTA_RESUME_TYPE,
    ), false);
    const latest = harness.session.sessionManager.getBranch().at(-2);
    assert.equal(latest?.type, "custom_message");
    assert.equal((latest as { customType?: string } | undefined)?.customType, PINDIE_QUOTA_RESUME_TYPE);
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0: custom trigger Promise covers the full Agent Run", async () => {
  let resolveResponse: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;
  const responseSettled = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    resolveResponse = resolve;
  });
  const harness = await createRealPiHarness();

  try {
    harness.faux.setResponses([async () => responseSettled]);
    let sendSettled = false;
    let agentSettled = false;
    const unsubscribe = harness.session.subscribe((event) => {
      if (event.type === "agent_settled") agentSettled = true;
    });
    const sendPromise = harness.session
      .createReplacedSessionContext()
      .sendMessage(
        { customType: "runtime-trigger", content: "wake up", display: false },
        { triggerTurn: true },
      )
      .finally(() => {
        sendSettled = true;
      });

    await nextTurn();
    assert.equal(harness.session.isStreaming, true);
    assert.equal(agentSettled, false);
    assert.equal(sendSettled, false);

    resolveResponse?.(fauxAssistantMessage("done"));
    await sendPromise;
    unsubscribe();
    assert.equal(agentSettled, true);
    assert.equal(sendSettled, true);
  } finally {
    await disposeHarness(harness);
  }
});

test("Pi 1.3.0 resume preserves recorded active tools; explicit and +/- selections stay authoritative", async () => {
  const harness = await createRealPiHarness(undefined, [compatibilityTool]);
  try {
    harness.faux.setResponses([fauxAssistantMessage("record tools")]);
    await harness.session.prompt("record current tools");
    for (const [tools, expected] of [
      [undefined, ["compatibility-tool"]],
      [["+read", "-compatibility-tool"], ["read"]],
      [["write"], ["write"]],
    ] as const) {
      const { session } = await createAgentSession({
        cwd: join(harness.root, "project"), agentDir: join(harness.root, "agent"),
        modelRuntime: harness.session.modelRuntime, model: harness.faux.getModel(),
        resourceLoader: harness.session.resourceLoader, sessionManager: harness.session.sessionManager,
        customTools: [compatibilityTool], tools: tools ? [...tools] : undefined,
      });
      try {
        assert.deepEqual(session.getActiveToolNames(), expected);
        assert.equal(session.getAllTools().some((tool) => /^(codemode|tool_search|mcp__)/.test(tool.name)), false);
      } finally { session.dispose(); }
    }
  } finally { await disposeHarness(harness); }
});

test("Pi 1.3.0 custom prompt override and injected context survive a tool round trip", async () => {
  let preflights = 0;
  const contexts: { messages?: readonly unknown[] }[] = [];
  const harness = await createRealPiHarness(() => {
    preflights++;
    return { systemPrompt: "fixed one-run tool prompt", message: {
      customType: "injected-before-tool", content: "injected before tool", display: false,
    } };
  }, [compatibilityTool]);
  try {
    harness.faux.setResponses([
      (context) => { contexts.push(context); return fauxAssistantMessage(fauxToolCall("compatibility-tool", {}), { stopReason: "toolUse" }); },
      (context) => { contexts.push(context); return fauxAssistantMessage("done"); },
    ]);
    await harness.session.sendCustomMessage({ customType: "trigger", content: "start", display: false }, { triggerTurn: true });
    assert.equal(preflights, 1);
    assert.equal(contexts.length, 2);
    for (const context of contexts) {
      assert.equal(providerSystemPrompt(context), "fixed one-run tool prompt");
      assert.match(JSON.stringify(context), /injected before tool/);
    }
    assert.ok(harness.session.messages.some((message) => message.role === "toolResult"));
  } finally { await disposeHarness(harness); }
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const kind of ["user", "custom"] as const) {
  test(`Pi 1.3.0 ${kind} preflight is busy, queues once and delivers nextTurn messages`, { timeout: 10_000 }, async () => {
    const entered = barrier();
    const resume = barrier();
    let preflights = 0;
    let settlements = 0;
    const contexts: unknown[] = [];
    const harness = await createRealPiHarness(async (event, ctx, pi) => {
      preflights++;
      assert.equal(event.messageType, kind);
      assert.equal(ctx.isIdle(), false);
      if (kind === "user" && event.messageType === "user") assert.equal(event.prompt, "user start");
      if (event.messageType === "custom") assert.equal("prompt" in event, false);
      await assert.rejects(harness.session.sendUserMessage("must specify delivery"), /deliverAs|streaming/i);
      await pi.sendMessage({ customType: "during-preflight", content: "queued during preflight", display: false }, { triggerTurn: true });
      entered.release();
      await resume.promise;
      return undefined;
    }, [], () => { settlements++; });
    try {
      harness.faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("queued done"); },
      ]);
      await harness.session.sendCustomMessage({ customType: "pending-next-turn", content: "pending next turn", display: false }, { deliverAs: "nextTurn" });
      const run = kind === "custom"
        ? harness.session.sendCustomMessage({ customType: "trigger", content: "custom start", display: false }, { triggerTurn: true })
        : harness.session.prompt("user start");
      await entered.promise;
      assert.equal(harness.session.isIdle, false);
      assert.equal(harness.session.isStreaming, true);
      resume.release();
      await run;
      assert.equal(preflights, 1);
      assert.equal(settlements, 1);
      assert.equal(harness.session.pendingMessageCount, 0);
      const branch = harness.session.sessionManager.getBranch();
      for (const customType of ["pending-next-turn", "during-preflight"]) {
        assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === customType).length, 1);
      }
      assert.match(JSON.stringify(contexts[0]), /pending next turn/);
      assert.match(JSON.stringify(contexts), /queued during preflight/);
      assert.doesNotMatch(JSON.stringify(contexts), /must specify delivery/);
    } finally { resume.release(); await disposeHarness(harness); }
  });

  test(`Pi 1.3.0 abort during ${kind} preflight settles aborted without provider execution`, { timeout: 10_000 }, async () => {
    const entered = barrier();
    const resume = barrier();
    const harness = await createRealPiHarness(async () => {
      entered.release();
      await resume.promise;
      return undefined;
    });
    let calls = 0;
    const settlements: boolean[] = [];
    const unsubscribe = harness.session.subscribe((event) => {
      if (event.type === "agent_settled") settlements.push(event.aborted);
    });
    try {
      harness.faux.setResponses([() => { calls++; return fauxAssistantMessage("unexpected"); }]);
      const run = kind === "custom"
        ? harness.session.sendCustomMessage({ customType: "trigger", content: "start", display: false }, { triggerTurn: true })
        : harness.session.prompt("start");
      await entered.promise;
      assert.equal(harness.session.isIdle, false);
      const aborted = harness.session.abort();
      resume.release();
      await Promise.all([run, aborted]);
      assert.equal(calls, 0);
      assert.deepEqual(settlements, [true]);
      assert.equal(harness.session.isIdle, true);
    } finally { resume.release(); unsubscribe(); await disposeHarness(harness); }
  });
}
