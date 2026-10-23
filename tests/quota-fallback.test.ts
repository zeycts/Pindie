import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  FileQuotaFallbackPreferenceStore, PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE,
  QUOTA_FALLBACK_UNAVAILABLE_MESSAGE, QuotaFallbackSelectorComponent,
  getBranchQuotaFallbackPreference, registerQuotaFallbackIntegration,
} from "../src/quota-fallback.ts";
import { FileQuotaResumePreferenceStore } from "../src/quota-resume.ts";
import { composePindieExtension } from "../src/composition.ts";

const entry = (data: unknown, customType = PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE) => ({ type: "custom", customType, data }) as SessionEntry;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function bindings(save = "ctrl+x") {
  const keys: Record<string, string> = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.confirm": "enter", "app.models.save": save, "tui.select.cancel": "escape" };
  return { matches: (data: string, binding: string) => data === keys[binding], getKeys: (binding: string) => [keys[binding] ?? ""] };
}

test("global default is OFF for missing, absent, invalid and malformed values", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-fallback-"));
  try {
    const path = join(baseDir, "preferences.json");
    const store = new FileQuotaFallbackPreferenceStore({ baseDir });
    assert.equal(await store.loadDefault(), false);
    for (const [text, expected] of [
      ['{"quotaAutoResume":true}', false], ['{"quotaFallback":true}', true],
      ['{"quotaFallback":false}', false], ['{"quotaFallback":"true"}', false],
      ['{"quotaFallback":1}', false], ["not-json", false], ["[]", false],
    ] as const) {
      await writeFile(path, text);
      assert.equal(await store.loadDefault(), expected, text);
    }
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("both writers preserve the other's boolean and unrelated fields in the same atomic file", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-fallback-"));
  try {
    const path = join(baseDir, "preferences.json");
    await writeFile(path, JSON.stringify({ quotaAutoResume: false, other: "keep" }));
    const fallback = new FileQuotaFallbackPreferenceStore({ baseDir });
    await fallback.saveDefault(true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { quotaAutoResume: false, other: "keep", quotaFallback: true });
    await new FileQuotaResumePreferenceStore({ baseDir }).saveDefault(true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { quotaAutoResume: true, other: "keep", quotaFallback: true });
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("fallback writer does not damage the existing file on failed rename or corrupt JSON", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-fallback-"));
  try {
    const path = join(baseDir, "preferences.json");
    await writeFile(path, '{"quotaAutoResume":false}');
    const store = new FileQuotaFallbackPreferenceStore({ baseDir, onBeforeRename: async () => { throw new Error("rename barrier"); } });
    await assert.rejects(store.saveDefault(true), /rename barrier/);
    assert.equal(await readFile(path, "utf8"), '{"quotaAutoResume":false}');
    assert.deepEqual(await readdir(baseDir), ["preferences.json"]);
    await writeFile(path, "broken");
    assert.equal(await store.loadDefault(), false);
    await assert.rejects(store.saveDefault(true), /Could not update quota fallback/);
    assert.equal(await readFile(path, "utf8"), "broken");
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test("branch transcript's latest valid fallback entry wins over global; other entries ignored", () => {
  assert.equal(getBranchQuotaFallbackPreference([], false), false);
  assert.equal(getBranchQuotaFallbackPreference([entry({ enabled: true })], false), true);
  assert.equal(getBranchQuotaFallbackPreference([entry({ enabled: false })], true), false);
  assert.equal(getBranchQuotaFallbackPreference([entry({ enabled: true }), entry({ enabled: "no" }), entry({ enabled: false }), entry({ enabled: true }, "other")], false), false);
});

test("selector renders paid fixed backup and markers; wraps and honors configured save key", () => {
  const selected: unknown[] = []; let cancelled = 0; let renders = 0;
  const selector = new QuotaFallbackSelectorComponent(
    { requestRender: () => { renders++; } }, theme, bindings(), true, false,
    (result) => selected.push(result), () => { cancelled++; },
  );
  const initial = selector.render(100).join("\n");
  assert.match(initial, /DeepSeek Flash/);
  assert.match(initial, /Paid/);
  assert.match(initial, /→ ✓ on/);
  assert.match(initial, /off · default/);
  assert.match(initial, /Ctrl\+X Save default \+ Session/);
  selector.handleInput("up");
  assert.match(selector.render(100).join("\n"), /→   off · default/);
  selector.handleInput("down");
  selector.handleInput("enter");
  selector.handleInput("ctrl+s");
  selector.handleInput("ctrl+x");
  selector.handleInput("escape");
  assert.deepEqual(selected, [{ kind: "session", enabled: true }, { kind: "default", enabled: true }]);
  assert.equal(cancelled, 1); assert.equal(renders, 2);
});

function commandHarness(defaultValue = false, available = true) {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const appended: Array<{ type: string; data: unknown }> = [];
  const saved: boolean[] = []; const preflights: string[] = [];
  let branch: SessionEntry[] = [];
  const pi = { registerCommand: (name: string, command: any) => commands.set(name, command), appendEntry: (type: string, data: unknown) => { appended.push({ type, data }); branch.push(entry(data, type)); } } as unknown as ExtensionAPI;
  const store = { loadDefault: async () => defaultValue, saveDefault: async (enabled: boolean) => { saved.push(enabled); } };
  const integration = registerQuotaFallbackIntegration(pi, store, {
    canEnable: (sessionId) => { preflights.push(sessionId); return available; },
  });
  const notices: Array<{ message: string; type: string }> = [];
  const ctx = (input: string | null, mode = "tui") => ({
    mode, sessionManager: { getBranch: () => branch, getSessionId: () => "session" },
    ui: { notify: (message: string, type: string) => notices.push({ message, type }), custom: async (factory: any) => {
      let result: unknown;
      const selector = factory({ requestRender: () => undefined }, theme, bindings(), (value: unknown) => { result = value; }) as QuotaFallbackSelectorComponent;
      if (input) for (const key of input.split(",")) selector.handleInput(key);
      return result;
    } },
  });
  return { commands, appended, saved, preflights, notices, integration, ctx, store,
    setBranch: (value: SessionEntry[]) => { branch = value; },
    restoreSession: async () => integration.restoreSession(ctx(null) as any),
    restoreBranch: async () => integration.restoreBranch(ctx(null) as any),
    command: async (input: string | null, args = "", mode = "tui") => commands.get("quota-fallback")!.handler(args, ctx(input, mode)),
  };
}

test("Session Enter ON preflights first, changes only transcript; Global save applies current Session", async () => {
  const h = commandHarness(); await h.restoreSession();
  assert.equal(h.integration.quotaFallbackEnabled, false);
  await h.command("up,enter");
  assert.deepEqual(h.preflights, ["session"]);
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.appended, [{ type: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: true } }]);
  assert.equal(h.integration.quotaFallbackEnabled, true);
  assert.equal(h.integration.quotaFallbackDefault, false);
  // A saved ON preference also starts selected on.
  const on = commandHarness(true); await on.restoreSession();
  await on.command("enter");
  assert.deepEqual(on.preflights, ["session"]);
  assert.deepEqual(on.saved, []);
  assert.deepEqual(on.appended, [{ type: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: true } }]);
  assert.equal(on.integration.quotaFallbackEnabled, true);
  await on.command("ctrl+x");
  assert.deepEqual(on.saved, [true]);
  assert.deepEqual(on.appended.at(-1)?.data, { enabled: true });
  assert.equal(on.integration.quotaFallbackDefault, true);
});

test("saving Global ON also appends current Session ON over a historical OFF entry", async () => {
  const h = commandHarness(true);
  h.setBranch([entry({ enabled: false })]); await h.restoreSession();
  assert.equal(h.integration.quotaFallbackEnabled, false);
  await h.command("up,ctrl+x");
  assert.deepEqual(h.preflights, ["session"]);
  assert.deepEqual(h.saved, [true]);
  assert.deepEqual(h.appended, [{ type: PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, data: { enabled: true } }]);
  assert.equal(h.integration.quotaFallbackEnabled, true);
});

test("ON unavailable rejects Session and Global mutations; OFF succeeds without auth", async () => {
  const on = commandHarness(true, false); await on.restoreSession();
  await on.command("enter"); await on.command("ctrl+x");
  assert.deepEqual(on.preflights, ["session", "session"]);
  assert.deepEqual([on.saved, on.appended], [[], []]);
  assert.equal(on.integration.quotaFallbackEnabled, true); // saved preference survives later auth loss
  assert.deepEqual(on.notices.map((notice) => notice.message), [QUOTA_FALLBACK_UNAVAILABLE_MESSAGE, QUOTA_FALLBACK_UNAVAILABLE_MESSAGE]);
  const off = commandHarness(false, false); await off.restoreSession();
  await off.command("enter"); await off.command("ctrl+x");
  assert.deepEqual(off.preflights, []);
  assert.deepEqual(off.saved, [false]);
  assert.deepEqual(off.appended.map(({ data }) => data), [{ enabled: false }, { enabled: false }]);
});

test("cancel, args, non-TUI do not mutate; branch restore drops an absent Session override", async () => {
  const h = commandHarness(false); h.setBranch([entry({ enabled: true })]); await h.restoreSession();
  assert.equal(h.integration.quotaFallbackEnabled, true);
  await h.command("escape"); await h.command(null, "on"); await h.command(null, "", "print");
  assert.deepEqual([h.saved, h.appended, h.preflights], [[], [], []]);
  assert.deepEqual(h.notices.map(({ message }) => message), ["Usage: /quota-fallback", "The /quota-fallback command requires TUI mode."]);
  h.setBranch([]); await h.restoreBranch();
  assert.equal(h.integration.quotaFallbackEnabled, false);
});

test("failed global save keeps fallback Session/default unchanged after ON preflight", async () => {
  const h = commandHarness();
  await h.restoreSession();
  h.store.saveDefault = async () => { throw new Error("synthetic save failure"); };
  await h.command("up,ctrl+x");
  assert.deepEqual(h.preflights, ["session"]);
  assert.deepEqual(h.appended, []);
  assert.equal(h.integration.quotaFallbackEnabled, false);
  assert.equal(h.integration.quotaFallbackDefault, false);
  assert.match(h.notices.at(-1)!.message, /synthetic save failure/);
});

test("production composition shares existing global preferences path", () => {
  const options = composePindieExtension({ storageRoots: { projectsBaseDir: "/tmp/projects", globalBaseDir: "/tmp/global", remoteRoutingBaseDir: "/tmp/remote" } }).extensionOptions;
  const fallback = options.quotaFallbackPreferenceStore as FileQuotaFallbackPreferenceStore;
  assert.equal(fallback.storageBaseDir, "/tmp/global");
  assert.equal(fallback.preferencesPath(), (options.quotaResumePreferenceStore as FileQuotaResumePreferenceStore).preferencesPath());
});
