import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  FileQuotaResumePreferenceStore,
  PINDIE_QUOTA_RESUME_PREFERENCE_TYPE,
  QuotaResumeSelectorComponent,
  getBranchQuotaResumePreference,
  registerQuotaResumeIntegration,
  type QuotaResumePreferenceStore,
} from "../src/quota-resume.ts";
import { composePindieExtension } from "../src/composition.ts";

function customEntry(data: unknown, customType = PINDIE_QUOTA_RESUME_PREFERENCE_TYPE): SessionEntry {
  return {
    type: "custom",
    id: Math.random().toString(16).slice(2),
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  } as SessionEntry;
}

function theme(): { fg: (_color: string, text: string) => string; bold: (text: string) => string } {
  return { fg: (_color, text) => text, bold: (text) => text };
}

function keybindings(overrides: Record<string, string | string[]> = {}) {
  const defaults: Record<string, string | string[]> = {
    "tui.select.up": "up",
    "tui.select.down": "down",
    "tui.select.confirm": "enter",
    "tui.select.cancel": ["escape", "ctrl+c"],
    "app.models.save": "ctrl+s",
  };
  const resolved = { ...defaults, ...overrides };
  return {
    matches(data: string, binding: string): boolean {
      const keys = resolved[binding];
      return Array.isArray(keys) ? keys.includes(data) : keys === data;
    },
    getKeys(binding: string): string[] {
      const keys = resolved[binding];
      return keys === undefined ? [] : Array.isArray(keys) ? keys : [keys];
    },
  };
}

class TestPi {
  readonly commands = new Map<string, any>();
  readonly handlers = new Map<string, (...args: any[]) => unknown>();
  readonly appendedEntries: Array<{ customType: string; data: unknown }> = [];
  readonly sentMessages: unknown[] = [];
  readonly sentUserMessages: unknown[] = [];

  registerCommand(name: string, command: unknown): void {
    this.commands.set(name, command);
  }

  on(name: string, handler: (...args: any[]) => unknown): void {
    this.handlers.set(name, handler);
  }

  appendEntry(customType: string, data?: unknown): void {
    this.appendedEntries.push({ customType, data });
  }
}

class TestStore implements QuotaResumePreferenceStore {
  value: boolean;
  readonly calls: string[] = [];
  readonly saved: boolean[] = [];

  constructor(value = true) {
    this.value = value;
  }

  async loadDefault(): Promise<boolean> {
    this.calls.push("load");
    return this.value;
  }

  async saveDefault(enabled: boolean): Promise<void> {
    this.calls.push("save");
    this.saved.push(enabled);
    this.value = enabled;
  }
}

function commandContext(
  branch: SessionEntry[],
  action: (component: QuotaResumeSelectorComponent) => void,
  mode: "tui" | "print" = "tui",
) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    mode,
    notifications,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      custom: async (factory: any) => {
        let result: unknown;
        const component = factory(
          { requestRender: () => undefined },
          theme(),
          keybindings({ "app.models.save": "ctrl+x" }),
          (value: unknown) => { result = value; },
        ) as QuotaResumeSelectorComponent;
        action(component);
        return result;
      },
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => "session", getLeafId: () => "leaf" },
  };
}

test("missing and partial global quota preferences default ON", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-quota-preferences-"));
  try {
    const store = new FileQuotaResumePreferenceStore({ baseDir });
    assert.equal(await store.loadDefault(), true);
    await writeFile(join(baseDir, "preferences.json"), JSON.stringify({ unrelated: "kept" }));
    assert.equal(await store.loadDefault(), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("global quota preferences round-trip and preserve unrelated fields", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-quota-preferences-"));
  try {
    const path = join(baseDir, "preferences.json");
    await writeFile(path, JSON.stringify({ unrelated: { value: 7 }, other: false, quotaFallback: true }));
    const store = new FileQuotaResumePreferenceStore({ baseDir });
    await store.saveDefault(false);
    assert.equal(await store.loadDefault(), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      unrelated: { value: 7 },
      other: false,
      quotaFallback: true,
      quotaAutoResume: false,
    });
    await store.saveDefault(true);
    assert.equal(await store.loadDefault(), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("global quota preference persistence is atomic and cleans a failed temporary write", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-quota-preferences-"));
  try {
    const path = join(baseDir, "preferences.json");
    await writeFile(path, JSON.stringify({ quotaAutoResume: true }));
    const store = new FileQuotaResumePreferenceStore({
      baseDir,
      onBeforeRename: async () => { throw new Error("rename barrier"); },
    });
    await assert.rejects(store.saveDefault(false), /rename barrier/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { quotaAutoResume: true });
    assert.deepEqual(await readdir(baseDir), ["preferences.json"]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("malformed existing global quota configuration fails closed", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-quota-preferences-"));
  try {
    const path = join(baseDir, "preferences.json");
    await writeFile(path, "not json");
    const store = new FileQuotaResumePreferenceStore({ baseDir });
    assert.equal(await store.loadDefault(), false);
    await assert.rejects(store.saveDefault(true), /Could not update quota resume preferences/);
    assert.equal(await readFile(path, "utf8"), "not json");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("branch preference resolution uses the latest valid current-branch entry and ignores invalid entries", () => {
  assert.equal(getBranchQuotaResumePreference([], false), false);
  assert.equal(getBranchQuotaResumePreference([
    customEntry({ enabled: true }),
    customEntry({ enabled: "invalid" }),
    customEntry({ enabled: false }),
  ], true), false);
  assert.equal(getBranchQuotaResumePreference([
    customEntry({ enabled: false }),
    customEntry({ nope: true }),
    customEntry({ enabled: true }),
  ], false), true);
  assert.equal(getBranchQuotaResumePreference([
    customEntry({ enabled: true }, "other-entry"),
  ], false), false);
});

test("quota selector has independent Session and Global markers and wraps navigation", () => {
  const selected: unknown[] = [];
  let cancelled = 0;
  const component = new QuotaResumeSelectorComponent(
    { requestRender: () => undefined },
    theme(),
    keybindings(),
    true,
    false,
    (result) => selected.push(result),
    () => { cancelled += 1; },
  );
  const initial = component.render(100).join("\n");
  assert.match(initial, /→ ✓ on/);
  assert.match(initial, /    off/);
  assert.match(initial, /off · default/);
  assert.doesNotMatch(initial, /on · default/);

  component.handleInput("up");
  const wrapped = component.render(100).join("\n");
  assert.match(wrapped, /  ✓ on/);
  assert.match(wrapped, /→   off · default/);
  component.handleInput("down");
  component.handleInput("enter");
  assert.deepEqual(selected, [{ kind: "session", enabled: true }]);
  component.handleInput("escape");
  assert.equal(cancelled, 1);
});

test("quota selector honors configured app.models.save instead of raw Ctrl+S", () => {
  const selected: unknown[] = [];
  const component = new QuotaResumeSelectorComponent(
    { requestRender: () => undefined },
    theme(),
    keybindings({ "app.models.save": "ctrl+x" }),
    false,
    true,
    (result) => selected.push(result),
    () => undefined,
  );
  assert.match(component.render(100).join("\n"), /Ctrl\+X Save/);
  component.handleInput("ctrl+s");
  assert.deepEqual(selected, []);
  component.handleInput("ctrl+x");
  assert.deepEqual(selected, [{ kind: "default", enabled: false }]);
});

test("quota command Enter changes Session only, save changes Global plus Session, and cancel changes neither", async () => {
  const pi = new TestPi();
  const store = new TestStore(false);
  const integration = registerQuotaResumeIntegration(pi as unknown as ExtensionAPI, store);
  const branch: SessionEntry[] = [];
  await integration.restoreSession({ sessionManager: { getBranch: () => branch } } as any);

  const enterContext = commandContext(branch, (component) => {
    component.handleInput("up");
    component.handleInput("enter");
  });
  await pi.commands.get("quota-resume").handler("", enterContext);
  assert.equal(store.saved.length, 0);
  assert.equal(integration.quotaAutoResumeEnabled, true);
  assert.equal(integration.quotaAutoResumeDefault, false);
  assert.equal(pi.appendedEntries.length, 1);

  const saveContext = commandContext(branch, (component) => {
    component.handleInput("down");
    component.handleInput("ctrl+x");
  });
  await pi.commands.get("quota-resume").handler("", saveContext);
  assert.deepEqual(store.saved, [false]);
  assert.equal(integration.quotaAutoResumeEnabled, false);
  assert.equal(integration.quotaAutoResumeDefault, false);
  assert.equal(pi.appendedEntries.length, 2);

  const beforeCancel = structuredClone({ saved: store.saved, entries: pi.appendedEntries, enabled: integration.quotaAutoResumeEnabled });
  const cancelContext = commandContext(branch, (component) => component.handleInput("escape"));
  await pi.commands.get("quota-resume").handler("", cancelContext);
  assert.deepEqual({ saved: store.saved, entries: pi.appendedEntries, enabled: integration.quotaAutoResumeEnabled }, beforeCancel);

  const argsContext = commandContext(branch, () => undefined);
  await pi.commands.get("quota-resume").handler("on", argsContext);
  assert.equal(argsContext.notifications[0]?.message, "Usage: /quota-resume");

  const nonTuiContext = commandContext(branch, () => undefined, "print");
  await pi.commands.get("quota-resume").handler("", nonTuiContext);
  assert.match(nonTuiContext.notifications[0]?.message ?? "", /requires TUI mode/);
  assert.deepEqual(pi.sentMessages, []);
  assert.deepEqual(pi.sentUserMessages, []);
});

test("session_start reloads Global before current branch and session_tree rederives branch-local value", async () => {
  const pi = new TestPi();
  const store = new TestStore(true);
  const integration = registerQuotaResumeIntegration(pi as unknown as ExtensionAPI, store);
  let branch: SessionEntry[] = [customEntry({ enabled: false })];
  const order: string[] = [];
  const context = { sessionManager: {
    getBranch: () => { order.push("branch"); return branch; },
  } };
  const originalLoad = store.loadDefault.bind(store);
  store.loadDefault = async () => { order.push("load"); return originalLoad(); };
  await integration.restoreSession(context as any);
  assert.deepEqual(order, ["load", "branch"]);
  assert.equal(integration.quotaAutoResumeEnabled, false);

  store.value = false;
  branch = [customEntry({ enabled: true })];
  await integration.restoreSession(context as any);
  assert.equal(integration.quotaAutoResumeDefault, false);
  assert.equal(integration.quotaAutoResumeEnabled, true);

  branch = [];
  await integration.restoreBranch(context as any);
  assert.equal(integration.quotaAutoResumeEnabled, false);
});

test("failed global save keeps resume Session/default and runtime callback unchanged", async () => {
  const pi = new TestPi();
  const store = new TestStore(false);
  let changed = 0;
  const integration = registerQuotaResumeIntegration(pi as unknown as ExtensionAPI, store, {
    onPreferenceChanged: () => { changed++; },
  });
  const ctx = commandContext([], (menu) => { menu.handleInput("up"); menu.handleInput("ctrl+x"); });
  await integration.restoreSession(ctx as unknown as ExtensionContext);
  store.saveDefault = async () => { throw new Error("synthetic save failure"); };
  await pi.commands.get("quota-resume").handler("", ctx);
  assert.deepEqual(pi.appendedEntries, []);
  assert.equal(integration.quotaAutoResumeEnabled, false);
  assert.equal(integration.quotaAutoResumeDefault, false);
  assert.equal(changed, 0);
  assert.match(ctx.notifications.at(-1)!.message, /synthetic save failure/);
});

test("quota resume rejects stale Session, branch leaf and lifecycle dialogs before either write", async () => {
  for (const boundary of ["session", "leaf", "restoreSession", "restoreBranch", "shutdown", "priorCommand"] as const) {
    for (const key of ["enter", "ctrl+x"]) {
      const pi = new TestPi();
      const store = new TestStore(false);
      let changed = 0;
      const integration = registerQuotaResumeIntegration(pi as unknown as ExtensionAPI, store, {
        onPreferenceChanged: () => { changed++; },
      });
      let sessionId = "session", leafId = "leaf";
      const ctx = commandContext([], () => undefined);
      ctx.sessionManager.getSessionId = () => sessionId;
      ctx.sessionManager.getLeafId = () => leafId;
      await integration.restoreSession(ctx as any);
      ctx.ui.custom = async () => {
        if (boundary === "session") sessionId = "replacement";
        if (boundary === "leaf") leafId = "other";
        if (boundary === "restoreSession") await integration.restoreSession(ctx as any);
        if (boundary === "restoreBranch") await integration.restoreBranch(ctx as any);
        if (boundary === "shutdown") integration.invalidateSession();
        if (boundary === "priorCommand") {
          await pi.commands.get("quota-resume").handler("", commandContext([], (menu) => menu.handleInput("enter")));
          pi.appendedEntries.length = 0; changed = 0;
        }
        return { kind: key === "enter" ? "session" : "default", enabled: true };
      };
      await pi.commands.get("quota-resume").handler("", ctx);
      assert.deepEqual(store.saved, [], `${boundary}/${key}`);
      assert.deepEqual(pi.appendedEntries, [], `${boundary}/${key}`);
      assert.equal(integration.quotaAutoResumeEnabled, false);
      assert.equal(changed, 0);
      assert.match(ctx.notifications.at(-1)?.message ?? "", /Session\/branch changed/);
    }
  }
});

test("quota resume successful asynchronous global save stands but stale Session append/callback is rejected", async () => {
  for (const boundary of ["session", "leaf", "shutdown"] as const) {
    const pi = new TestPi(), store = new TestStore(false);
    let changed = 0;
    const integration = registerQuotaResumeIntegration(pi as unknown as ExtensionAPI, store, {
      onPreferenceChanged: () => { changed++; },
    });
    const ctx = commandContext([], (menu) => { menu.handleInput("up"); menu.handleInput("ctrl+x"); });
    await integration.restoreSession(ctx as any);
    store.saveDefault = async (enabled) => {
      store.saved.push(enabled); store.value = enabled;
      if (boundary === "session") ctx.sessionManager.getSessionId = () => "replacement";
      if (boundary === "leaf") ctx.sessionManager.getLeafId = () => "other";
      if (boundary === "shutdown") integration.invalidateSession();
    };
    await pi.commands.get("quota-resume").handler("", ctx);
    assert.deepEqual(store.saved, [true]);
    assert.equal(integration.quotaAutoResumeDefault, true);
    assert.equal(integration.quotaAutoResumeEnabled, false);
    assert.deepEqual(pi.appendedEntries, []);
    assert.equal(changed, 0);
    assert.match(ctx.notifications.at(-1)?.message ?? "", /changed while saving/);
  }
});

test("composition creates the quota preference store under the existing global root", () => {
  const composition = composePindieExtension({
    storageRoots: {
      projectsBaseDir: "/tmp/projects",
      globalBaseDir: "/tmp/global",
      remoteRoutingBaseDir: "/tmp/remote",
    },
  });
  const store = composition.extensionOptions.quotaResumePreferenceStore as FileQuotaResumePreferenceStore;
  assert.equal(store.storageBaseDir, "/tmp/global");
  assert.equal(store.preferencesPath(), "/tmp/global/preferences.json");
});
