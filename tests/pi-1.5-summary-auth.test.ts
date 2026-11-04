import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, InMemoryCredentialStore, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPindieRuntimeFactory } from "../src/host.ts";

// Mirrors upstream suite/regressions/11520-sdk-summary-oauth-auth.test.ts,
// but uses Pindie's actual runtime factory and covers all three summary callers.
test("Pi 1.5 Host runtime summaries resolve synthetic stored OAuth without explicit-key overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-pi150-oauth-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("oauth-only-provider", async () => ({
    type: "oauth", access: "synthetic-oauth-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
  }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const model: Model<any> = {
    id: "oauth-model", name: "OAuth Model", api: "openai-completions", provider: "oauth-only-provider",
    baseUrl: "https://example.test/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const requests: SimpleStreamOptions[] = [];
  modelRuntime.registerProvider(model.provider, {
    name: "Synthetic OAuth Only", baseUrl: model.baseUrl, api: model.api, apiKey: "UNUSED_SYNTHETIC_ENV_KEY",
    oauth: {
      name: "Synthetic Subscription",
      login: async () => ({ access: "synthetic-oauth-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 }),
      refreshToken: async (credential) => credential, getApiKey: (credential) => credential.access,
    },
    models: [model],
    streamSimple: (requestModel, _context, options) => {
      requests.push(options ?? {});
      const stream = createAssistantMessageEventStream();
      stream.end({ ...fauxAssistantMessage("synthetic summary text"), api: requestModel.api, provider: requestModel.provider, model: requestModel.id });
      return stream;
    },
  });
  const authOverrides: Array<string | undefined> = [];
  const getAuth = modelRuntime.getAuth.bind(modelRuntime);
  modelRuntime.getAuth = (async (...args: Parameters<ModelRuntime["getAuth"]>) => {
    authOverrides.push(args[1]?.apiKey);
    return getAuth(...args);
  }) as ModelRuntime["getAuth"];
  const factory = createPindieRuntimeFactory({
    createAgentSessionServices: (options) => createAgentSessionServices({ ...options, modelRuntime,
      settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id,
        compaction: { enabled: false, keepRecentTokens: 16, reserveTokens: 32 } }),
      resourceLoaderOptions: { ...options.resourceLoaderOptions, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    }),
  }, undefined, { env: {}, featureSelection: { remote: false, workMemory: false, bundledSkills: false },
    storageRoots: { projectsBaseDir: join(root, "projects"), globalBaseDir: join(root, "global"), remoteRoutingBaseDir: join(root, "routing") } });
  const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root) });
  try {
    for (const operation of ["bug-report", "compaction", "branch"] as const) {
      if (operation !== "bug-report") await runtime.newSession();
      const session = runtime.session;
      assert.equal(session.model?.id, model.id, "explicit settings survive upstream default-model change");
      const manager = session.sessionManager;
      const targetId = manager.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
      manager.appendMessage({ ...fauxAssistantMessage("first reply ".repeat(500)), api: model.api, provider: model.provider, model: model.id });
      manager.appendMessage({ role: "user", content: "abandoned work", timestamp: Date.now() });
      manager.appendMessage({ ...fauxAssistantMessage("abandoned reply ".repeat(500)), api: model.api, provider: model.provider, model: model.id });
      requests.length = 0;
      authOverrides.length = 0;
      const summary = operation === "bug-report"
        ? await session.summarizeForBugReport({ signal: new AbortController().signal })
        : operation === "compaction"
          ? (await session.compact()).summary
          : (await session.navigateTree(targetId, { summarize: true })).summaryEntry?.summary;
      assert.match(summary ?? "", /synthetic summary text/, operation);
      assert.ok(requests.length > 0, operation);
      assert.ok(requests.every((request) => request.apiKey === "synthetic-oauth-access"), operation);
      assert.ok(authOverrides.length > 0, "normal runtime auth preparation must still run");
      assert.ok(authOverrides.every((apiKey) => apiKey === undefined), `${operation}: never pass stored OAuth back as an explicit API key`);
    }
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
