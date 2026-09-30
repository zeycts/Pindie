import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// API characterization only. No production T2 surface or attribution is installed here.
const NAME = "trial-selection-api-probe";
async function fixture(install: (pi: ExtensionAPI) => void = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "pindie-t2-api-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const faux = fauxProvider({ provider: `t2-api-${randomUUID()}` });
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  let api!: ExtensionAPI;
  let executions = 0;
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: SettingsManager.create(root, agentDir),
    noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
    extensionFactories: [(pi) => {
      api = pi;
      pi.registerTool({ name: NAME, label: NAME, description: "API probe only", exposure: "model-only", defaultActive: false,
        parameters: Type.Object({}), execute: async () => {
          executions++;
          return { content: [{ type: "text", text: "declared" }], details: undefined };
        } });
      pi.registerTool({ name: "open-episode-api-probe", label: "Open", description: "API probe for an ordinary Task tool boundary",
        parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "opened" }], details: undefined }) });
      install(pi);
    }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model: faux.getModel(), resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
  await session.bindExtensions({});
  return { session, faux, api, executions: () => executions,
    async close() { session.dispose(); await rm(root, { recursive: true, force: true }); } };
}

function names(context: unknown): string[] {
  return (getCurrentSystemMessage((context as { messages: any[] }).messages)?.toolsAdded ?? []).map((tool) => tool.name);
}

function exposeRequestTool(messages: any[], pi: ExtensionAPI) {
  const definition = pi.getAllTools().find((tool) => tool.name === NAME)!;
  // A request-only system delta can declare a tool without appending a Session entry.
  return [...messages, { role: "system", content: "", timestamp: 0,
    toolsAdded: [{ name: NAME, description: definition.description, parameters: definition.parameters }] }];
}

test("Pi 0.99.1 inactive model-only registration is absent from provider context and active names", async () => {
  const f = await fixture();
  try {
    assert.ok(f.session.getAllTools().some((tool) => tool.name === NAME));
    assert.ok(!f.session.getActiveToolNames().includes(NAME));
    f.faux.setResponses([(context) => {
      assert.ok(!names(context).includes(NAME));
      assert.ok(!JSON.stringify(context).includes(NAME));
      return fauxAssistantMessage("ordinary work");
    }]);
    await f.session.prompt("ordinary work");
    assert.ok(!JSON.stringify(f.session.sessionManager.getBranch()).includes(NAME));
    assert.equal(f.executions(), 0);
  } finally { await f.close(); }
});

test("Pi 0.99.1 context-time activation alone misses the current request declaration and executable snapshot", async () => {
  const f = await fixture((pi) => pi.on("context_with_system", () => {
    pi.setActiveTools([...pi.getActiveTools(), NAME]);
  }));
  try {
    f.faux.setResponses([
      (context) => {
        assert.ok(f.session.getActiveToolNames().includes(NAME));
        assert.ok(!names(context).includes(NAME));
        return fauxAssistantMessage(fauxToolCall(NAME, {}), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("probe context-time activation");
    assert.equal(f.executions(), 0, "the current executable tools were snapshotted before context_with_system");
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === NAME && m.isError));
  } finally { await f.close(); }
});

test("Pi 0.99.1 request-local tool declaration does not repair late context-time executable activation", async () => {
  const f = await fixture((pi) => pi.on("context_with_system", (event) => {
    pi.setActiveTools([...pi.getActiveTools(), NAME]);
    return { messages: exposeRequestTool(event.messages, pi) };
  }));
  try {
    f.faux.setResponses([
      (context) => {
        assert.ok(names(context).includes(NAME));
        return fauxAssistantMessage(fauxToolCall(NAME, {}), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("probe request-only declaration");
    assert.equal(f.executions(), 0);
    assert.ok(f.session.messages.some((m) => m.role === "toolResult" && m.toolName === NAME && m.isError));
  } finally { await f.close(); }
});

test("Pi 0.99.1 turn-start loadout pulse plus request-local declaration is executable without durable tool entries", async () => {
  let ready = false;
  let exposed = false;
  const f = await fixture((pi) => {
    pi.on("tool_result", (event) => { if (event.toolName === "open-episode-api-probe") ready = true; });
    // Native next-turn preparation snapshots/declaration happen before turn_start;
    // native prepareRequest refreshes executable tools AFTER turn_start. Keep the
    // loadout inactive again before the next native preparation can persist it.
    pi.on("turn_start", () => { if (ready) pi.setActiveTools([...pi.getActiveTools(), NAME]); });
    pi.on("turn_end", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== NAME)));
    pi.on("context_with_system", (event) => {
      if (!ready) return;
      exposed = true;
      return { messages: [...exposeRequestTool(event.messages, pi),
        { role: "user", content: "UNTRUSTED API probe advisory", timestamp: 0 }] };
    });
    pi.on("agent_settled", () => { ready = false; exposed = false; });
  });
  try {
    f.faux.setResponses([
      (context) => {
        assert.ok(!names(context).includes(NAME));
        assert.equal(exposed, false);
        return fauxAssistantMessage(fauxToolCall("open-episode-api-probe", {}), { stopReason: "toolUse" });
      },
      (context) => {
        assert.equal(exposed, true);
        assert.ok(names(context).includes(NAME));
        assert.ok(f.session.getActiveToolNames().includes(NAME));
        return fauxAssistantMessage(fauxToolCall(NAME, {}), { stopReason: "toolUse" });
      },
      (context) => {
        assert.ok(names(context).includes(NAME));
        return fauxAssistantMessage("done");
      },
    ]);
    await f.session.prompt("probe native request-only transient tool");
    assert.equal(f.executions(), 1);
    assert.ok(!f.session.getActiveToolNames().includes(NAME));
    const stored = f.session.messages.filter((m) => m.role === "system");
    assert.ok(!JSON.stringify(stored).includes(NAME), "no durable declaration/removal delta may carry the transient tool");
    assert.ok(!JSON.stringify(f.session.sessionManager.getBranch()).includes("UNTRUSTED API probe advisory"));
    f.faux.setResponses([(context) => {
      assert.ok(!names(context).includes(NAME));
      return fauxAssistantMessage("ordinary next Run");
    }]);
    await f.session.prompt("ordinary next Run");
  } finally { await f.close(); }
});

test("Pi 0.99.1 offered readiness invalidated at context can omit the pulse with no provider/durable declaration", async () => {
  let ready = false;
  let staged = false;
  const f = await fixture((pi) => {
    pi.on("tool_result", (event) => { if (event.toolName === "open-episode-api-probe") ready = true; });
    pi.on("turn_start", () => {
      if (ready) { staged = true; pi.setActiveTools([...pi.getActiveTools(), NAME]); }
    });
    pi.on("context_with_system", () => {
      // Simulate losing exact authority between executable preparation and exposure.
      ready = false;
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== NAME));
    });
    pi.on("turn_end", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== NAME)));
  });
  try {
    f.faux.setResponses([
      (context) => {
        assert.ok(!names(context).includes(NAME));
        return fauxAssistantMessage(fauxToolCall("open-episode-api-probe", {}), { stopReason: "toolUse" });
      },
      (context) => {
        assert.equal(staged, true, "must exercise an actual prepared executable loadout");
        assert.ok(!names(context).includes(NAME));
        assert.ok(!f.session.getActiveToolNames().includes(NAME));
        assert.ok(!JSON.stringify(context).includes(NAME));
        return fauxAssistantMessage("ordinary work without an advisory");
      },
    ]);
    await f.session.prompt("probe losing exposure authority");
    assert.equal(f.executions(), 0);
    assert.ok(!JSON.stringify(f.session.sessionManager.getBranch()).includes(NAME));
  } finally { await f.close(); }
});

test("Pi 0.99.1 earlier tool-result activation is executable in the immediate continuation", async () => {
  const f = await fixture((pi) => pi.on("tool_result", (event) => {
    if (event.toolName === "open-episode-api-probe") pi.setActiveTools([...pi.getActiveTools(), NAME]);
  }));
  try {
    f.faux.setResponses([
      (context) => {
        assert.ok(!names(context).includes(NAME));
        return fauxAssistantMessage(fauxToolCall("open-episode-api-probe", {}), { stopReason: "toolUse" });
      },
      (context) => {
        assert.ok(names(context).includes(NAME));
        return fauxAssistantMessage(fauxToolCall(NAME, {}), { stopReason: "toolUse" });
      },
      () => fauxAssistantMessage("done"),
    ]);
    await f.session.prompt("probe immediate native continuation");
    assert.equal(f.executions(), 1);
    f.api.setActiveTools(f.api.getActiveTools().filter((name) => name !== NAME));
    assert.ok(!f.session.getActiveToolNames().includes(NAME));
    f.faux.setResponses([(context) => {
      assert.ok(!names(context).includes(NAME));
      return fauxAssistantMessage("later ordinary Run");
    }]);
    await f.session.prompt("later ordinary work");
  } finally { await f.close(); }
});

test("Pi 0.99.1 public before-provider-request observation is not final: later handler replaces messages/tools", async () => {
  let observed: unknown, replacement: unknown;
  const f = await fixture((pi) => {
    pi.on("context_with_system", (event) => ({ messages: [...exposeRequestTool(event.messages, pi),
      { role: "user", content: "UNTRUSTED API probe advisory", timestamp: 0 }] }));
    pi.on("before_provider_request", (event) => { observed = structuredClone(event.payload); });
    pi.on("before_provider_request", () => {
      replacement = { messages: [{ role: "user", content: "replacement without advisory" }], tools: [] };
      return replacement;
    });
  });
  try {
    f.faux.setResponses([async (context, options, model) => {
      // Faux's response callback is the test provider implementation. Invoke the
      // public provider onPayload contract, then inspect the effective payload.
      const final = await options.onPayload?.({ messages: context.messages, tools: names(context) }, model);
      assert.ok(JSON.stringify(observed).includes("UNTRUSTED API probe advisory"));
      assert.ok(JSON.stringify(observed).includes(NAME));
      assert.deepEqual(final, replacement);
      assert.ok(!JSON.stringify(final).includes("UNTRUSTED API probe advisory"));
      assert.ok(!JSON.stringify(final).includes(NAME));
      return fauxAssistantMessage("Response does not prove which advisory was delivered.");
    }]);
    await f.session.prompt("probe supported payload transform ordering");
    assert.ok(observed);
  } finally { await f.close(); }
});
