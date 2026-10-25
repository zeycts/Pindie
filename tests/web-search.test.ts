import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import { bundledSearchTools, registerBundledSearch, registerDirectPiSearch } from "../src/web-search.ts";
import { createPindieRuntimeFactory } from "../src/host.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";
import { registerConfiguredPindieExtension } from "../src/extension.ts";
import { getAuth } from "../src/vendor/pi-web-search/providers/auth.ts";

let configRoot: string;
const originalSearchConfig = process.env.PI_WEB_SEARCH_CONFIG;
before(async () => {
  configRoot = await mkdtemp(join(tmpdir(), "pindie-search-config-"));
  process.env.PI_WEB_SEARCH_CONFIG = join(configRoot, "web-search.json");
});
after(async () => {
  if (originalSearchConfig === undefined) delete process.env.PI_WEB_SEARCH_CONFIG;
  else process.env.PI_WEB_SEARCH_CONFIG = originalSearchConfig;
  await rm(configRoot, { recursive: true, force: true });
});

function sse(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const source = { title: "Official release", url: "https://example.com/release" };
function context(api: string, provider: string) {
  const model = { api, provider, id: "test-model", baseUrl: "https://provider.example/v1", maxTokens: 8192, reasoning: false };
  return { model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-only", headers: { "chatgpt-account-id": "test-account" } }) } } as any;
}

for (const [api, provider, events] of [
  ["openai-codex-responses", "openai-codex", [
    { type: "response.web_search_call.completed", item_id: "search-1" },
    { type: "response.output_text.delta", delta: "Release found." },
    { type: "response.completed", response: { output: [{ type: "web_search_call", id: "search-1", action: { type: "search", sources: [source] } }] } },
  ]],
  ["openai-responses", "openai", [
    { type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [source] } } },
    { type: "response.output_text.delta", delta: "Release found." },
  ]],
  ["google-generative-ai", "google", [{ candidates: [{ content: { parts: [{ text: "Release found." }] }, groundingMetadata: { webSearchQueries: ["release"], groundingChunks: [{ web: { title: source.title, uri: source.url } }] } }] }]],
  ["anthropic-messages", "anthropic", [
    { type: "content_block_start", content_block: { type: "web_search_tool_result", tool_use_id: "search-1", content: [source] } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Release found." } },
  ]],
] as const) test(`bundled ${provider} dispatch sends native search and returns factual sources`, async t => {
  let request: { url: string; body: any; signal: unknown } | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    request = { url: String(url), body: JSON.parse(init.body as string), signal: init.signal };
    return sse([...events]);
  });
  const signal = new AbortController().signal;
  const tool = bundledSearchTools({ getThinkingLevel: () => "medium" })[0];
  const result = await tool.execute("search-test", { query: "release" }, signal, undefined, context(api, provider));
  assert.equal(result.isError, false);
  assert.equal(result.details.nativeSearchUsed, true);
  assert.deepEqual(result.details.sources, [source]);
  assert.equal(request?.signal, signal);
  assert.match(JSON.stringify(request?.body), /web_search|google_search/);
  if (provider === "openai-codex") {
    assert.equal(request?.url, "https://provider.example/v1/codex/responses");
    assert.equal(request?.body.store, false);
    assert.equal(request?.body.tool_choice, "required");
  }
});

test("auth removes Pi null headers; unsupported model/errors do not silently fall back", async t => {
  const ctx = context("openai-responses", "openai");
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-only", headers: { removed: null, preserved: "yes" } });
  assert.deepEqual((await getAuth(ctx, ctx.model)).headers, { preserved: "yes" });
  const tool = bundledSearchTools({ getThinkingLevel: () => "off" })[0];
  t.mock.method(globalThis, "fetch", async () => { throw new Error("transport unavailable"); });
  assert.equal((await tool.execute("failure", { query: "release" }, undefined, undefined, ctx)).isError, true);
  ctx.model.api = "openai-completions";
  ctx.modelRegistry.getAvailable = () => [];
  const unsupported = await tool.execute("unsupported", { query: "release" }, undefined, undefined, ctx);
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.details.error, "unsupported_model");
});

test("explicit search config is honored; invalid config fails without fallback", async () => {
  const ctx = context("openai-responses", "openai");
  ctx.modelRegistry.find = () => undefined;
  ctx.modelRegistry.getAvailable = () => [];
  const tool = bundledSearchTools({ getThinkingLevel: () => "off" })[0];
  const configPath = join(configRoot, "web-search.json");
  try {
    await writeFile(configPath, JSON.stringify({ provider: "not-configured", model: "missing" }));
    const missing = await tool.execute("configured", { query: "release" }, undefined, undefined, ctx);
    assert.equal(missing.isError, true);
    assert.equal(missing.details.error, "configured_model_not_found");
    await writeFile(configPath, "not JSON");
    const invalid = await tool.execute("invalid", { query: "release" }, undefined, undefined, ctx);
    assert.equal(invalid.isError, true);
    assert.equal(invalid.details.error, "invalid_config");
  } finally { await rm(configPath, { force: true }); }
});

for (const direct of [false, true]) for (const external of [false, true]) for (const disabled of [false, true]) test(`native loader clean/coexistence direct=${direct} external=${external} disabled=${disabled}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-search-test-"));
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  let session;
  try {
    await mkdir(cwd); await mkdir(agentDir);
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({});
    const marker = "external-provider";
    if (external) {
      await mkdir(join(agentDir, "extensions"));
      await writeFile(join(agentDir, "extensions", "existing.ts"), `export default pi => { for (const name of ['web_search', 'url_context']) pi.registerTool({ name, label: '${marker}', description: '${marker}', parameters: {type:'object',properties:{}}, execute: async () => ({ content: [], details: {} }) }); };`);
    }
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: direct ? [(pi) => { registerDirectPiSearch(pi); registerConfiguredPindieExtension(pi, {
        storageRoots: { projectsBaseDir: join(root, "state"), globalBaseDir: join(root, "global"), remoteRoutingBaseDir: join(root, "routing") },
        featureSelection: { remote: false, workMemory: false, presentation: false, bundledSkills: false },
      }, {}); }] : [{ name: "pindie-web-search", replaceable: true, factory: registerBundledSearch }] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), ...(disabled ? { noTools: "all" as const } : {}) }));
    await session.bindExtensions({});
    const tools = session.getAllTools().filter(tool => ["web_search", "url_context"].includes(tool.name));
    // Native noTools:'all' removes definitions from the configured inventory too.
    assert.equal(tools.length, disabled ? 0 : 2);
    assert.equal(session.getActiveToolNames().includes("web_search"), !disabled);
    if (external) assert.ok(tools.every(tool => tool.description === marker));
    // Disabling the tool is not undone by repeated session_start notifications.
    session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "web_search"));
    await session.extensionRunner.emit({ type: "session_start" });
    assert.ok(!session.getActiveToolNames().includes("web_search"));
  } finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("actual Host factory loads bundled tools across fresh Session constructions without packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-search-host-"));
  try {
    const agentDir = join(root, "agent"); await mkdir(agentDir);
    const factory = createPindieRuntimeFactory({}, new TaskMetricsTracker(), {
      env: {}, featureSelection: { remote: false, workMemory: false, presentation: false, bundledSkills: false },
      storageRoots: { projectsBaseDir: join(root, "state"), globalBaseDir: join(root, "global"), remoteRoutingBaseDir: join(root, "routing") },
    });
    for (const name of ["project-a", "project-b"]) {
      const cwd = join(root, name); await mkdir(cwd);
      const result = await factory({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
      try {
        assert.deepEqual(result.extensionsResult.errors, []);
        assert.ok(result.session.getActiveToolNames().includes("web_search"));
        assert.ok(result.services.resourceLoader.getExtensions().extensions.some(e => e.path.includes("pindie-web-search")));
      } finally { result.session.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
