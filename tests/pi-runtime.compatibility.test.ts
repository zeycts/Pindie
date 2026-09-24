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
  type BeforeAgentStartEventResult,
  type AgentBeforeSettleEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PINDIE_CONTINUATION_PROBE_MESSAGE, PINDIE_CONTINUATION_PROBE_TYPE } from "../src/continuation.ts";
import { Type } from "typebox";
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
  event: { prompt: string },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) => BeforeAgentStartEventResult | undefined;

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
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
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
  const content = (systemMessage as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

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

// Temporary downstream compatibility contract for the idle custom-triggered
// turn path. Remove the downstream patch once native Pi covers this preflight.
test("Pi 0.87.1 compatibility: idle custom trigger runs before_agent_start preflight and applies its result", async () => {
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

    // Without the downstream patch, the native idle path enters
    // _runAgentPrompt() directly and skips this hook and its result.
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

test("Pi 0.87.1 compatibility: idle custom trigger preserves the live active tool loadout", async () => {
  let providerContext: { messages?: readonly unknown[] } | undefined;
  const harness = await createRealPiHarness((_event, _ctx, pi) => {
    pi.setActiveTools(["compatibility-tool"]);
  }, [compatibilityTool]);

  try {
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

test("Pi 0.87.1 settled custom successor runs preflight with the current tool loadout", async () => {
  const prompts: string[] = [];
  const providerContexts: { messages?: readonly unknown[] }[] = [];
  let settlements = 0;
  const harness = await createRealPiHarness(
    (event, _ctx, pi) => {
      prompts.push(event.prompt);
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

test("Pi 0.87.1 boundary probe continues once within the same Run and settles after the final pass", async () => {
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

test("characterizes Pi 0.87.1 quota trigger: preflight exposes the hidden content before branch append", async () => {
  let preflightPrompt: string | undefined;
  let preflightBranch: readonly unknown[] | undefined;
  const harness = await createRealPiHarness((event, ctx) => {
    preflightPrompt = event.prompt;
    preflightBranch = ctx.sessionManager.getBranch();
    return undefined;
  });

  try {
    harness.faux.setResponses([fauxAssistantMessage("done")]);
    await harness.session.sendCustomMessage(
      { customType: PINDIE_QUOTA_RESUME_TYPE, content: PINDIE_QUOTA_RESUME_MESSAGE, display: false },
      { triggerTurn: true },
    );

    assert.equal(preflightPrompt, PINDIE_QUOTA_RESUME_MESSAGE);
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

test("characterizes Pi 0.87.1: custom trigger Promise covers the full Agent Run", async () => {
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
