import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { FileQuotaResumePreferenceStore } from "../src/quota-resume.ts";
import { FileDiscordRemotePreferenceStore } from "../src/remote-preference.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_FALLBACK_CONFIG as defaults, availableFallbackModels, parseFallbackConfig, supportsFallbackConfig, type QuotaFallbackConfig } from "../src/quota-fallback-config.ts";
import { FileQuotaFallbackPreferenceStore, getBranchQuotaFallbackConfig, PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE as entryType, QuotaFallbackConfigSelectorComponent, registerQuotaFallbackIntegration } from "../src/quota-fallback.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const config: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-chat" }, thinking: "high" };
const models = [
  { ...defaults.model, name: "Catalog Flash", thinkingLevels: ["off", "high", "max"] as const },
  { ...config.model, name: "Fixture Chat", thinkingLevels: ["off", "high"] as const },
];
const entry = (data: unknown): SessionEntry => ({ type: "custom", customType: entryType, data }) as SessionEntry;

test("Phase2 global fields round-trip atomically preserving all unrelated preferences; legacy and damaged data fail closed", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-phase2-store-"));
  const path = join(baseDir, "preferences.json");
  try {
    const store = new FileQuotaFallbackPreferenceStore({ baseDir });
    assert.deepEqual(await store.loadConfig(), defaults);
    await writeFile(path, JSON.stringify({ quotaFallback: true, discordRemote: false, quotaAutoResume: false, future: { keep: 1 } }));
    assert.deepEqual(await store.loadConfig(), { ...defaults, enabled: true });
    await store.saveConfig(config);
    assert.deepEqual(await store.loadConfig(), config);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(persisted, { quotaFallback: true, quotaFallbackModel: config.model, quotaFallbackThinking: "high", discordRemote: false, quotaAutoResume: false, future: { keep: 1 } });
    await store.saveConfig({ ...config, enabled: false });
    assert.deepEqual(await store.loadConfig(), { ...config, enabled: false });
    await new FileQuotaResumePreferenceStore({ baseDir }).saveDefault(true);
    await new FileDiscordRemotePreferenceStore(baseDir).saveDefault(true);
    assert.deepEqual(await store.loadConfig(), { ...config, enabled: false });
    const shared = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual([shared.quotaAutoResume, shared.discordRemote, shared.future], [true, true, { keep: 1 }]);
    const bytes = await readFile(path, "utf8");
    const failing = new FileQuotaFallbackPreferenceStore({ baseDir, onBeforeRename: async () => { throw Error("save barrier"); } });
    await assert.rejects(failing.saveConfig({ ...config, thinking: "off" }), /save barrier/);
    assert.equal(await readFile(path, "utf8"), bytes);
    for (const bad of [null, "highh", 7]) {
      await writeFile(path, JSON.stringify({ quotaFallback: true, quotaFallbackThinking: bad }));
      const loaded = await store.loadConfig();
      assert.equal(loaded.enabled, false);
      assert.equal(getBranchQuotaFallbackConfig([entry({ enabled: true })], loaded).enabled, false);
    }
    for (const model of [{ provider: "openai-codex", modelId: "x" }, {}, "deepseek/unknown"]) {
      await writeFile(path, JSON.stringify({ quotaFallback: true, quotaFallbackModel: model }));
      assert.equal((await store.loadConfig()).enabled, false);
    }
    await writeFile(path, "corrupt");
    assert.equal(getBranchQuotaFallbackConfig([entry({ enabled: true })], await store.loadConfig()).enabled, false);
    await assert.rejects(store.saveConfig(config));
    assert.equal(await readFile(path, "utf8"), "corrupt");
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("Phase2 branch/session precedence: full triple wins, legacy inherits global not abandoned branch, OFF retains target", () => {
  const global = { ...config, enabled: false };
  assert.deepEqual(getBranchQuotaFallbackConfig([], global), global);
  assert.deepEqual(getBranchQuotaFallbackConfig([entry({ enabled: true })], global), config);
  const full = { ...defaults, enabled: true };
  assert.deepEqual(getBranchQuotaFallbackConfig([entry(full)], global), full);
  assert.deepEqual(getBranchQuotaFallbackConfig([entry(full), entry({ enabled: false })], global), global);
  assert.deepEqual(getBranchQuotaFallbackConfig([entry({ ...config, enabled: false })], defaults), global);
  assert.equal(getBranchQuotaFallbackConfig([entry(config), entry({ enabled: true, thinking: "bogus" })], defaults).enabled, false);
  assert.equal(parseFallbackConfig({ ...config, model: { provider: "openai-codex", modelId: "x" } }).enabled, false);
});

test("Phase2 candidates require available + explicitly configured auth + text chat, exclude Codex and virtual routers", () => {
  const base = { provider: "fixture-paid", id: "fixture-chat", name: "From metadata", input: ["text"], reasoning: true };
  const registry = {
    getAvailable: () => [base, { ...base, provider: "openai-codex" }, { ...base, provider: "no-auth" }, { ...base, provider: "stale-status" }, { ...base, id: "image-only", input: ["image"] }, { ...base, id: "router", api: "pi-virtual" }],
    hasConfiguredAuth: (m: typeof base) => m.provider !== "no-auth",
    getProviderAuthStatus: (p: string) => ({ configured: p !== "stale-status" }),
  } as unknown as ModelRegistry;
  const choices = availableFallbackModels(registry);
  assert.equal(choices.length, 1); assert.equal(choices[0]!.name, "From metadata");
  assert.equal(supportsFallbackConfig(config, choices), true);
  assert.equal(supportsFallbackConfig({ ...config, model: { ...config.model, modelId: "absent" } }, choices), false);
  assert.equal(supportsFallbackConfig({ ...config, thinking: "xhigh" }, choices), false);
});

test("Phase2 draft subselectors choose cross-provider/model/thinking explicitly; cancel writes nothing; native multi/remapped/unbound keys and widths", () => {
  const results: unknown[] = [];
  let cancels = 0;
  const keys = new KeybindingsManager({ "tui.select.up": "alt+k", "tui.select.down": "alt+j", "tui.select.confirm": "alt+enter", "app.models.save": ["ctrl+x", "alt+s"], "tui.select.cancel": ["ctrl+q", "alt+c"] });
  const menu = new QuotaFallbackConfigSelectorComponent({ requestRender() {} }, theme, keys, defaults, defaults, models, (r) => results.push(r), () => { cancels++; });
  const down = "\u001bj", enter = "\u001b\r";
  menu.handleInput(down); menu.handleInput(enter); // Model
  assert.match(menu.render(150).join("\n"), /Catalog Flash.*default/);
  assert.match(menu.render(150).join("\n"), /backup, may be paid/);
  menu.handleInput(down); menu.handleInput(enter); // choose fixture provider, draft only
  menu.handleInput(down); menu.handleInput(down); menu.handleInput(enter); // Thinking
  menu.handleInput(down); menu.handleInput(down); menu.handleInput(enter); // high
  assert.deepEqual(results, []);
  assert.match(menu.render(150).join("\n"), /Model: Fixture Chat/);
  assert.match(menu.render(150).join("\n"), /Thinking: high/);
  for (const width of [1, 2, 8, 16, 40, 80, 150]) {
    menu.invalidate(); for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  menu.handleInput("\u0013"); assert.deepEqual(results, []); // raw Ctrl+S is remapped
  menu.handleInput("\u0018");
  assert.deepEqual(results, [{ kind: "default", config: { ...config, enabled: false } }]);
  menu.handleInput("\u0011"); assert.equal(cancels, 1);
  const unbound = new QuotaFallbackConfigSelectorComponent({ requestRender() {} }, theme, new KeybindingsManager({ "app.models.save": [] }), defaults, defaults, [], () => assert.fail(), () => {});
  assert.doesNotMatch(unbound.render(150).join("\n"), /Ctrl\+S|Save default/);
  unbound.handleInput("\u0013");
});

function commandHarness() {
  let command: any; let branch: SessionEntry[] = []; let sessionId = "s1"; let leaf = "leaf1";
  let selection: unknown = null; let global = defaults; let available = true; let onUi: (() => Promise<void>) | undefined;
  const notices: string[] = [], saved: QuotaFallbackConfig[] = [], preflights: unknown[] = [], appended: unknown[] = [];
  const pi = { registerCommand: (_: string, c: unknown) => { command = c; }, appendEntry: (_: string, data: unknown) => { appended.push(data); branch.push(entry(data)); } } as unknown as ExtensionAPI;
  const store = { loadDefault: async () => global.enabled, loadConfig: async () => global, saveDefault: async () => assert.fail(), saveConfig: async (c: QuotaFallbackConfig) => { saved.push(c); global = c; } };
  const registry = { getAvailable: () => available ? models.map((m) => ({ provider: m.provider, id: m.modelId, name: m.name, input: ["text"], reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null } })) : [], hasConfiguredAuth: () => available, getProviderAuthStatus: () => ({ configured: available }) };
  const ctx: any = { mode: "tui", modelRegistry: registry, sessionManager: { getSessionId: () => sessionId, getLeafId: () => leaf, getBranch: () => branch }, ui: { notify: (s: string) => notices.push(s), custom: async () => { await onUi?.(); return selection; } } };
  const integration = registerQuotaFallbackIntegration(pi, store, { canEnable: (s, c) => { preflights.push([s, c]); return available; } });
  return { integration, store, notices, saved, appended, preflights, ctx,
    restore: () => integration.restoreSession(ctx), branchRestore: () => integration.restoreBranch(ctx),
    run: (c: QuotaFallbackConfig, kind = "session") => { selection = { config: c, kind }; return command.handler("", ctx); },
    setBranch: (b: SessionEntry[]) => { branch = b; }, setSession: (s: string) => { sessionId = s; }, setLeaf: (s: string) => { leaf = s; },
    setAvailable: (a: boolean) => { available = a; }, duringUi: (fn: () => Promise<void>) => { onUi = fn; },
  };
}

test("Phase2 command Enter/Save stores full triple; OFF/on reuse; session/branch restoration and unavailable/unsupported targets preserve prior config", async () => {
  const h = commandHarness(); await h.restore();
  await h.run(config); assert.deepEqual(h.appended, [config]); assert.deepEqual(h.saved, []);
  await h.run({ ...config, enabled: false }, "default");
  assert.deepEqual(h.saved, [{ ...config, enabled: false }]);
  assert.deepEqual(h.integration.quotaFallbackConfig, { ...config, enabled: false });
  await h.run(config); assert.deepEqual(h.integration.quotaFallbackConfig, config);
  const before = h.appended.length;
  await h.run({ ...config, thinking: "medium" });
  await h.run({ ...config, model: { ...config.model, modelId: "absent" } });
  h.setAvailable(false); await h.run(config, "default");
  assert.equal(h.appended.length, before); assert.equal(h.saved.length, 1); assert.equal(h.notices.length, 3);
  await h.run({ ...config, enabled: false }); // disabling unchanged target needs no auth
  assert.deepEqual(h.integration.quotaFallbackConfig, { ...config, enabled: false });
  h.setBranch([entry({ ...defaults, enabled: true })]); await h.branchRestore();
  assert.deepEqual(h.integration.quotaFallbackConfig, { ...defaults, enabled: true });
  h.setSession("s2"); h.setBranch([]); await h.restore();
  assert.deepEqual(h.integration.quotaFallbackConfig, { ...config, enabled: false });
});

test("Phase2 save error and session/branch replacement during open menu never apply stale draft", async () => {
  const h = commandHarness(); await h.restore();
  h.store.saveConfig = async () => { throw Error("write denied"); };
  await h.run(config, "default"); assert.deepEqual(h.appended, []); assert.deepEqual(h.integration.quotaFallbackConfig, defaults);
  assert.match(h.notices.at(-1)!, /write denied/);
  h.duringUi(async () => { h.setSession("s2"); await h.restore(); });
  await h.run(config); assert.deepEqual(h.appended, []);
  h.duringUi(async () => { h.setLeaf("other"); });
  await h.run(config); assert.deepEqual(h.appended, []);
  h.duringUi(async () => { h.integration.invalidateSession(); }); // old context retains the same IDs after shutdown
  await h.run({ ...defaults, enabled: false }); assert.deepEqual(h.appended, []);
  const duringSave = commandHarness(); await duringSave.restore();
  duringSave.store.saveConfig = async (c) => { duringSave.saved.push(c); duringSave.integration.invalidateSession(); };
  await duringSave.run(config, "default"); assert.deepEqual(duringSave.saved, [config]); assert.deepEqual(duringSave.appended, []);
  assert.match(duringSave.notices.at(-1)!, /changed while saving/);
});

test("Pi 1.4.0 real catalog/registry/session APIs: metadata levels, auth snapshot, exact model/thinking transcript without network or paid inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-phase2-native-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("Network forbidden in Phase2 native API audit"); };
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"); await mkdir(cwd); await mkdir(agentDir);
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false, allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    const flash = registry.find("deepseek", "deepseek-flash"); assert.ok(flash); assert.ok(flash.name);
    assert.deepEqual(getSupportedThinkingLevels(flash), ["off", "low", "high", "max"]);
    await runtime.setRuntimeApiKey("deepseek", "synthetic-test-key-not-a-credential");
    assert.equal(registry.hasConfiguredAuth(flash), true); assert.equal(registry.getProviderAuthStatus("deepseek").configured, true);
    const choices = availableFallbackModels(registry); assert.ok(choices.some((c) => c.name === flash.name));
    assert.equal(supportsFallbackConfig({ ...defaults, enabled: true, thinking: "medium" }, choices), false);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: flash, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd), noTools: "all" }));
    await session.setModel(flash); session.setThinkingLevel("medium");
    assert.equal(session.thinkingLevel, "high"); // source mode delegates clamping to Pi
    session.setThinkingLevel("max"); assert.equal(session.thinkingLevel, "max");
    assert.deepEqual(session.getAvailableThinkingLevels(), getSupportedThinkingLevels(flash));
    assert.ok(session.sessionManager.getBranch().some((e) => e.type === "model_change" && e.provider === flash.provider && e.modelId === flash.id));
    assert.deepEqual(settingsManager.getDefaultModel(), undefined);
  } finally { session?.dispose(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
