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
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

interface RealPiHarness {
  readonly session: AgentSession;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly root: string;
}

async function createRealPiHarness(
  beforeAgentStart?: () => void,
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
          pi.on("before_agent_start", () => {
            beforeAgentStart();
          });
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
    noTools: "all",
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

test("Pi 0.84.4 compatibility: idle custom trigger runs before_agent_start preflight", async () => {
  let beforeAgentStartCalls = 0;
  const harness = await createRealPiHarness(() => {
    beforeAgentStartCalls += 1;
  });

  try {
    harness.faux.setResponses([fauxAssistantMessage("done")]);
    await harness.session.createReplacedSessionContext().sendMessage(
      { customType: "runtime-trigger", content: "wake up", display: false },
      { triggerTurn: true },
    );

    // The unpatched 0.84.4 package produced 0 here: its native
    // sendCustomMessage() entered _runAgentPrompt() directly. This real Pi
    // characterization is why the old fake ReplacedSessionContext tests were
    // insufficient; those fakes never exercised the native AgentSession path.
    assert.equal(beforeAgentStartCalls, 1);
  } finally {
    await disposeHarness(harness);
  }
});

test("characterizes Pi 0.84.4: custom trigger Promise covers the full Agent Run", async () => {
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
