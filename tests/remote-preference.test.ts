import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Pinned native implementation: Pi exports the manager type, not its constructor.
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import type { SettingsMenu } from "../src/settings-menu.ts";
import { composeConfiguredPindieExtension } from "../src/composition.ts";
import { FileQuotaFallbackPreferenceStore } from "../src/quota-fallback.ts";
import { FileQuotaResumePreferenceStore } from "../src/quota-resume.ts";
import { FileDiscordRemotePreferenceStore, registerDiscordRemotePreferenceCommand } from "../src/remote-preference.ts";

const credentials = { PINDIE_DISCORD_TOKEN: "synthetic-token", PINDIE_DISCORD_USER_ID: "123456789012345678", PINDIE_DISCORD_GUILD_ID: "987654321098765432" };

test("Discord Remote startup preference defaults ON, parses booleans and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-remote-preference-"));
  try {
    const store = new FileDiscordRemotePreferenceStore(root);
    assert.equal(store.loadDefault(), true);
    for (const [text, expected] of [
      ["{}", true], ['{"quotaFallback":true}', true], ['{"discordRemote":true}', true],
      ['{"discordRemote":false}', false], ['{"discordRemote":"false"}', false],
      ['{"discordRemote":null}', false], ["null", false], ["[]", false], ["broken", false],
    ] as const) {
      await writeFile(store.preferencesPath(), text);
      assert.equal(store.loadDefault(), expected, text);
      const composition = composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, credentials);
      assert.equal(composition.featureSelection.remote, expected, text);
      assert.equal(composition.remoteRoutingStore !== null, expected, text);
    }
    await rm(store.preferencesPath());
    await mkdir(store.preferencesPath());
    const composition = composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, credentials);
    assert.equal(composition.featureSelection.remote, false);
    assert.match(composition.warnings.join(), /preferences could not be read/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("shared preferences preserve quota and unrelated fields in both directions; failed saves preserve bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-remote-save-"));
  try {
    const store = new FileDiscordRemotePreferenceStore(root);
    await writeFile(store.preferencesPath(), JSON.stringify({ quotaFallback: true, quotaAutoResume: false, other: { keep: 1 } }));
    await store.saveDefault(false);
    await new FileQuotaFallbackPreferenceStore({ baseDir: root }).saveDefault(false);
    await new FileQuotaResumePreferenceStore({ baseDir: root }).saveDefault(true);
    assert.deepEqual(JSON.parse(await readFile(store.preferencesPath(), "utf8")), {
      quotaFallback: false, quotaAutoResume: true, other: { keep: 1 }, discordRemote: false,
    });
    for (const text of ["broken", "[]", '{"discordRemote":"off"}']) {
      await writeFile(store.preferencesPath(), text);
      await assert.rejects(store.saveDefault(false));
      assert.equal(await readFile(store.preferencesPath(), "utf8"), text);
    }
    assert.deepEqual(await readdir(root), ["preferences.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("saved OFF gates credentials, environment and injected adapters without routing or credential reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-remote-gate-"));
  try {
    await new FileDiscordRemotePreferenceStore(root).saveDefault(false);
    const env = { PINDIE_REMOTE_ENABLED: "true" };
    Object.defineProperty(env, "PINDIE_DISCORD_TOKEN", { get() { throw new Error("credential read while disabled"); } });
    const remoteCompanion = {} as NonNullable<Parameters<typeof composeConfiguredPindieExtension>[0]>["remoteCompanion"];
    const composition = composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root }, featureSelection: { remote: true }, remoteCompanion }, env);
    assert.equal(composition.featureSelection.remote, false);
    assert.equal(composition.extensionOptions.remoteCompanion, undefined);
    assert.equal(composition.remoteRoutingStore, null);
    assert.deepEqual(composition.warnings, []);
    await new FileDiscordRemotePreferenceStore(root).saveDefault(true);
    assert.equal(composition.featureSelection.remote, false); // existing composition is not hot-toggled
    assert.equal(composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, credentials).featureSelection.remote, true);
    assert.equal(composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, { ...credentials, PINDIE_REMOTE_ENABLED: "false" }).featureSelection.remote, false);
    assert.equal(composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, {}).featureSelection.remote, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Discord Remote settings command saves only global preference, cancels safely and never changes current Host", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-remote-command-"));
  try {
    const store = new FileDiscordRemotePreferenceStore(root);
    let handler!: (args: string, ctx: any) => Promise<void>;
    registerDiscordRemotePreferenceCommand({ registerCommand(name, command) {
      assert.equal(name, "discord-remote"); handler = command.handler;
    } } as ExtensionAPI, store, true);
    let input = ["\u001b[B", "\r"];
    const notices: string[] = [];
    const screens: string[] = [];
    const keybindings = new KeybindingsManager({ "app.models.save": ["ctrl+x", "alt+s"] });
    const ctx = { mode: "tui", ui: {
      custom: async (factory: any) => {
        let result: boolean | null | undefined;
        const menu = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, keybindings, (value: boolean | null) => { result = value; }) as SettingsMenu<boolean>;
        screens.push(menu.render(180).join("\n"));
        for (const key of input) menu.handleInput(key);
        return result;
      }, notify: (message: string) => notices.push(message),
    } };
    await handler("", ctx);
    assert.equal(store.loadDefault(), false);
    assert.match(notices.at(-1)!, /Current Host unchanged; restart\/recreate/);
    assert.doesNotMatch(screens[0]!, /Host:|Saved:|Restart required/);
    assert.match(screens[0]!, /→ ✓ on · default/);
    assert.match(screens[0]!, /next Host/);
    assert.match(screens[0]!, /Enter Save/);
    assert.match(screens[0]!, /Ctrl\+X\/Alt\+S Save/);
    assert.doesNotMatch(screens[0]!, /apply to current Session/);
    for (const cancel of ["\u001b", "\u0003"]) {
      input = ["\u001b[A", cancel];
      const before = await readFile(store.preferencesPath(), "utf8");
      await handler("", ctx);
      assert.equal(await readFile(store.preferencesPath(), "utf8"), before);
    }
    assert.match(screens[1]!, /Host: on · Saved: off · Restart required/);
    assert.match(screens[1]!, /  ✓ on/);
    assert.match(screens[1]!, /→   off · default/);
    await handler("invalid", ctx);
    assert.match(notices.at(-1)!, /Usage/);
    input = ["\u001b[A", "\u0018"];
    await handler("", { ...ctx, mode: "print" });
    assert.equal(store.loadDefault(), false);
    await handler("", ctx);
    assert.equal(store.loadDefault(), true);
    input = ["\u001b[B", "\u0013"]; // raw Ctrl+S is no longer bound
    await handler("", ctx);
    assert.equal(store.loadDefault(), true);
    input = ["\u001b[B", "\u001bs"]; // second configured save binding
    await handler("", ctx);
    assert.equal(store.loadDefault(), false);
    input = ["\r"];
    await writeFile(store.preferencesPath(), "broken");
    await handler("", ctx);
    assert.match(notices.at(-1)!, /Existing configuration was preserved/);
    assert.equal(await readFile(store.preferencesPath(), "utf8"), "broken");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Discord menu renders all Host/saved combinations without hot activation or width overflow", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  for (const host of [true, false]) for (const saved of [true, false]) {
    const store = new FileDiscordRemotePreferenceStore("unused-render-only");
    store.loadDefault = () => saved;
    store.saveDefault = async () => { assert.fail("render/cancel must not save"); };
    let handler!: (args: string, ctx: any) => Promise<void>;
    registerDiscordRemotePreferenceCommand({ registerCommand(_name, command) { handler = command.handler; } } as ExtensionAPI, store, host);
    await handler("", { mode: "tui", ui: {
      custom: async (factory: any) => {
        const menu = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, new KeybindingsManager({ "app.models.save": [] }), () => {}) as SettingsMenu<boolean>;
        const lines = menu.render(200);
        const screen = lines.join("\n");
        assert.equal(lines.length, host === saved ? 8 : 9);
        assert.match(screen, new RegExp(`✓ ${host ? "on" : "off"}`));
        assert.match(screen, new RegExp(`→ .*${saved ? "on" : "off"} · default`));
        if (host === saved) assert.doesNotMatch(screen, /Host:|Saved:|Restart required/);
        else assert.match(screen, new RegExp(`Host: ${host ? "on" : "off"} · Saved: ${saved ? "on" : "off"} · Restart required`));
        assert.doesNotMatch(screen, /Ctrl\+S/);
        for (const width of [1, 2, 8, 16, 40, 80, 120]) {
          for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width);
        }
        return null;
      }, notify() {},
    } });
  }
});

test("saved OFF does not load Discord adapters or transports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-remote-no-load-"));
  try {
    await new FileDiscordRemotePreferenceStore(root).saveDefault(false);
    const script = `
      const Module = require('node:module');
      const original = Module._load;
      Module._load = function(request, ...args) {
        if (['./discord-remote.ts', './remote-companion.ts', 'discord.js', 'ws', 'https-proxy-agent', 'undici'].includes(request)) throw Error('Unexpected adapter load: ' + request);
        return original.call(this, request, ...args);
      };
      import(${JSON.stringify(new URL("../src/composition.ts", import.meta.url).href)}).then(({composeConfiguredPindieExtension}) => {
        const c = composeConfiguredPindieExtension({storageRoots: {globalBaseDir: ${JSON.stringify(root)}}}, ${JSON.stringify(credentials)});
        if (c.featureSelection.remote || c.remoteRoutingStore || c.extensionOptions.remoteCompanion) throw Error('Remote composed');
        console.log('NO_DISCORD_ADAPTER_OR_TRANSPORT');
      }).catch(e => {console.error(e); process.exitCode = 1});
    `;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "-e", script]);
    assert.match(result.stdout, /NO_DISCORD_ADAPTER_OR_TRANSPORT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
