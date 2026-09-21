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
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
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
  const extensionFactories: InlineExtension[] = beforeAgentStart
    ? [
        (pi) => {
          pi.on("before_agent_start", (event, ctx) => beforeAgentStart(event, ctx, pi));
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
// turn path. It protects behavior Pindie needs until earendil-works/pi#8262
// lands in a pinned Pi release. When it does: remove the downstream patch, then
// keep/adapt this contract test against Pi's native behavior.
test("Pi 0.86.1 compatibility: idle custom trigger runs before_agent_start preflight and applies its result", async () => {
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

    // Without the downstream 0.86.1 patch, the native idle path enters
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

test("Pi 0.86.1 compatibility: idle custom trigger preserves the live active tool loadout", async () => {
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

test("characterizes Pi 0.86.1 quota trigger: preflight exposes the hidden content before branch append", async () => {
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

test("characterizes Pi 0.86.1: custom trigger Promise covers the full Agent Run", async () => {
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
