import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composeConfiguredPindieExtension, composePindieExtension } from "../src/composition.ts";
import { FileWorkMemoryPreferenceStore, registerWorkMemoryPreferenceCommand } from "../src/work-memory-preference.ts";
import { FileDiscordRemotePreferenceStore } from "../src/remote-preference.ts";
import { FileQuotaFallbackPreferenceStore } from "../src/quota-fallback.ts";
import { FileQuotaResumePreferenceStore } from "../src/quota-resume.ts";
import { deriveCapabilities, deriveSemanticSnapshot } from "../src/semantics.ts";
import type { SettingsMenu } from "../src/settings-menu.ts";
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const sink = { async capture() { throw new Error("No Notion calls allowed"); } };

async function temporary(run: (root: string, store: FileWorkMemoryPreferenceStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pindie-memory-toggle-"));
  try { await run(root, new FileWorkMemoryPreferenceStore(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("legacy/preference/env/override/injected sink matrix; explicit true is intent, never availability", async () => {
  await temporary(async (root, store) => {
    for (const preference of [undefined, false, true]) {
      if (preference === undefined) await writeFile(store.preferencesPath(), "{}");
      else await store.saveDefault(preference);
      for (const flag of [undefined, "false", "true"]) for (const override of [undefined, false, true]) for (const injected of [false, true]) {
        const options = { storageRoots: { globalBaseDir: root }, featureSelection: { workMemory: override },
          ...(injected ? { projectMemorySink: sink } : {}) };
        const env = { PINDIE_WORK_MEMORY_ENABLED: flag };
        const expected = preference !== false && flag !== "false" && override !== false && injected;
        for (const composition of [composeConfiguredPindieExtension(options, env), composePindieExtension(options, { env })]) {
          assert.equal(composition.featureSelection.workMemory, expected, JSON.stringify({ preference, flag, override, injected }));
          assert.equal(composition.extensionOptions.projectMemorySink, expected ? sink : undefined);
        }
      }
    }
  });
});

test("hard OFF precedes throwing credential and sink getters; no optional imports", async () => {
  await temporary(async (root, store) => {
    const script = `
      const Module = require('node:module'), original = Module._load;
      Module._load = function(request, ...args) {
        if (['@notionhq/client', './notion-project-memory.ts'].includes(request)) throw Error('Forbidden import: '+request);
        return original.call(this, request, ...args);
      };
      import(${JSON.stringify(new URL("../src/composition.ts", import.meta.url).href)}).then(({composeConfiguredPindieExtension}) => {
        const env = {PINDIE_WORK_MEMORY_ENABLED: process.argv[1]};
        for (const key of ['PINDIE_NOTION_TOKEN','PINDIE_WORK_MEMORY_DATA_SOURCE_ID']) Object.defineProperty(env,key,{get(){throw Error('Credential read')}});
        const input = {storageRoots:{globalBaseDir:${JSON.stringify(root)}}, featureSelection:{workMemory:true}};
        Object.defineProperty(input,'projectMemorySink',{enumerable:true,get(){throw Error('Sink read')}});
        const c=composeConfiguredPindieExtension(input,env);
        if(c.featureSelection.workMemory || c.extensionOptions.projectMemorySink) throw Error('Enabled');
        console.log('NO_LOAD_OR_GETTERS');
      }).catch(e=>{console.error(e);process.exitCode=1});`;
    for (const [preference, env] of [[false, "true"], [true, "false"]] as const) {
      await store.saveDefault(preference);
      const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "-e", script, env]);
      assert.match(result.stdout, /NO_LOAD_OR_GETTERS/);
    }
  });
});

test("complete legacy/ON credentials construct only fake SDK; incomplete config fails closed", async () => {
  await temporary(async (root, store) => {
    const script = `
      const assert=require('node:assert/strict'), Module=require('node:module'), original=Module._load;
      let clients=0,sinks=0;
      Module._load=function(request,...args){
        if(request==='@notionhq/client')return {Client:class {constructor(){clients++}}};
        if(request==='./notion-project-memory.ts')return {NotionProjectMemorySink:class{constructor(){sinks++}}};
        return original.call(this,request,...args);
      };
      import(${JSON.stringify(new URL("../src/composition.ts", import.meta.url).href)}).then(({composeConfiguredPindieExtension})=>{
        for(const env of [{PINDIE_NOTION_TOKEN:'fake',PINDIE_WORK_MEMORY_DATA_SOURCE_ID:'fake'}, {PINDIE_NOTION_TOKEN:'fake'}, {}]){
          const c=composeConfiguredPindieExtension({storageRoots:{globalBaseDir:${JSON.stringify(root)}}},env);
          assert.equal(c.featureSelection.workMemory,!!env.PINDIE_WORK_MEMORY_DATA_SOURCE_ID);
          assert.equal(c.workMemoryConfiguration,c.featureSelection.workMemory?'configured':'unconfigured');
        }
        assert.equal(clients,1);assert.equal(sinks,1);console.log('FAKE_CONFIG_MATRIX');
      }).catch(e=>{console.error(e);process.exitCode=1});`;
    for (const pref of [undefined, true]) {
      if (pref !== undefined) await store.saveDefault(pref);
      const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "-e", script]);
      assert.match(result.stdout, /FAKE_CONFIG_MATRIX/);
    }
  });
});

test("missing preference does not write; invalid/unreadable documents fail closed and cannot be overwritten", async () => {
  await temporary(async (root, store) => {
    assert.equal(store.loadDefault(), undefined);
    assert.deepEqual(await readdir(root), []);
    for (const bytes of ["broken", "null", "[]", '{"workMemory":"on"}', '{"workMemory":null}', '{"workMemory":1}']) {
      await writeFile(store.preferencesPath(), bytes);
      assert.throws(() => store.loadDefault());
      const env = {};
      Object.defineProperty(env, "PINDIE_NOTION_TOKEN", { get() { assert.fail("invalid prefs read credentials"); } });
      assert.equal(composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root }, projectMemorySink: sink }, env).featureSelection.workMemory, false);
      await assert.rejects(store.saveDefault(true));
      assert.equal(await readFile(store.preferencesPath(), "utf8"), bytes);
      assert.deepEqual(await readdir(root), ["preferences.json"]);
    }
    await rm(store.preferencesPath()); await mkdir(store.preferencesPath());
    assert.throws(() => store.loadDefault());
    assert.equal(composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root } }, {}).featureSelection.workMemory, false);
    await assert.rejects(store.saveDefault(true));
    assert.deepEqual(await readdir(root), ["preferences.json"]);
  });
});

test("atomic field saves preserve all quota, Remote and unknown data in both directions", async () => {
  await temporary(async (root, store) => {
    await writeFile(store.preferencesPath(), JSON.stringify({ quotaFallback: false, quotaAutoResume: true, discordRemote: false, unknown: { nested: [1, 2] } }));
    await store.saveDefault(true);
    await new FileQuotaFallbackPreferenceStore({ baseDir: root }).saveDefault(true);
    await new FileQuotaResumePreferenceStore({ baseDir: root }).saveDefault(false);
    await new FileDiscordRemotePreferenceStore(root).saveDefault(false);
    assert.deepEqual(JSON.parse(await readFile(store.preferencesPath(), "utf8")), {
      quotaFallback: true, quotaAutoResume: false, discordRemote: false, workMemory: true, unknown: { nested: [1, 2] },
    });
    assert.deepEqual(await readdir(root), ["preferences.json"]);
    const current = composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root }, projectMemorySink: sink }, {});
    await store.saveDefault(false);
    assert.equal(current.featureSelection.workMemory, true);
    assert.equal(current.featureSelection.remote, false);
    assert.equal(current.extensionOptions.projectMemorySink, sink);
    const next = composeConfiguredPindieExtension({ storageRoots: { globalBaseDir: root }, projectMemorySink: sink }, {});
    assert.equal(next.featureSelection.workMemory, false);
    assert.equal(next.featureSelection.remote, false);
  });
});

test("real Host uses supplied env on both paths and freezes Work Memory (not Discord) across Session replacement", async () => {
  await temporary(async (root, store) => {
    const script = `
      const assert=require('node:assert/strict'), Module=require('node:module'), original=Module._load;
      Module._load=function(request,...args){
        if(request==='@notionhq/client')return {Client:class {}};
        if(request==='./notion-project-memory.ts')return {NotionProjectMemorySink:class {async capture(){throw Error('No API')}}};
        return original.call(this,request,...args);
      };
      (async()=>{
        const {createPindieHost}=await import(${JSON.stringify(new URL("../src/host.ts", import.meta.url).href)});
        const {ModelRuntime,createAgentSessionServices}=await import('@earendil-works/pi-coding-agent');
        const {mkdir,writeFile}=require('node:fs/promises');
        const root=${JSON.stringify(root)};
        await mkdir(root+'/project');await mkdir(root+'/agent');
        const modelRuntime=await ModelRuntime.create({authPath:root+'/agent/auth.json',modelsPath:null,refreshOnCreate:false});
        const options={cwd:root+'/project',agentDir:root+'/agent',storageRoots:{globalBaseDir:root,projectsBaseDir:root+'/state',remoteRoutingBaseDir:root+'/routing'},
          env:{PINDIE_BROWSER_ENABLED:'false',PINDIE_NOTION_TOKEN:'fake',PINDIE_WORK_MEMORY_DATA_SOURCE_ID:'fake'},
          dependencies:{createAgentSessionServices: o=>createAgentSessionServices({...o,modelRuntime}),createInteractiveMode:()=>({run:async()=>{}})}};
        await writeFile(root+'/preferences.json',JSON.stringify({discordRemote:false}));
        let host=await createPindieHost(options);
        const enabled=()=>host.runtime.activeSession.getAllTools().some(t=>t.name==='pindie_memory_capture');
        assert.equal(enabled(),true,'Host must not forward pre-resolved false or process.env');
        await writeFile(root+'/preferences.json',JSON.stringify({workMemory:false,discordRemote:false}));
        await host.runtime.replaceWithFreshSession();
        assert.equal(enabled(),true,'Session replacement must not hot-stop memory');
        await host.dispose();
        host=await createPindieHost(options);assert.equal(enabled(),false,'next Host applies saved OFF');
        await writeFile(root+'/preferences.json',JSON.stringify({workMemory:true,discordRemote:false}));
        await host.runtime.replaceWithFreshSession();assert.equal(enabled(),false,'no hot-start');await host.dispose();
        host=await createPindieHost({...options,featureSelection:{workMemory:true},env:{...options.env,PINDIE_WORK_MEMORY_ENABLED:'false'}});
        assert.equal(enabled(),false,'explicit env false vetoes override');await host.dispose();
        console.log('HOST_ENV_SESSION_FREEZE');
      })().catch(e=>{console.error(e);process.exitCode=1});`;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "-e", script]);
    assert.match(result.stdout, /HOST_ENV_SESSION_FREEZE/);
  });
});

test("real isolated Pi 1.4.0 native preview smoke saves via Ctrl+S without Session or Host mutation", async () => {
  for (const unconfigured of [false, true]) await temporary(async (root) => {
    const env = { PATH: process.env.PATH, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_AGENT_DIR: join(root, "agent"), PINDIE_PREVIEW_ROOT: root,
      XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), TERM: "xterm-256color" };
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types",
      new URL("../scripts/work-memory-preview.ts", import.meta.url).pathname, "--fixtures", "--smoke", ...(unconfigured ? ["--unconfigured"] : [])], { env });
    assert.match(result.stdout, /PASS Pi 1.4.0: \/work-memory registered, native custom dialog, Ctrl\+S global-only save, Host unchanged/);
  });
});

test("rename failure leaves original preference bytes intact and removes its owned temporary file", async () => {
  await temporary(async (root, store) => {
    const bytes = '{"workMemory":false,"unknown":{"keep":true}}\n';
    await writeFile(store.preferencesPath(), bytes);
    const script = `
      const fs=require('node:fs/promises');fs.rename=async()=>{throw Error('synthetic rename failure')};require('node:module').syncBuiltinESMExports();
      import(${JSON.stringify(new URL("../src/work-memory-preference.ts", import.meta.url).href)}).then(async({FileWorkMemoryPreferenceStore})=>{
        try{await new FileWorkMemoryPreferenceStore(${JSON.stringify(root)}).saveDefault(true);throw Error('unexpected success')}
        catch(e){if(e.message!=='synthetic rename failure')throw e;console.log('RENAME_FAILED_SAFELY')}
      }).catch(e=>{console.error(e);process.exitCode=1});`;
    const result = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "-e", script]);
    assert.match(result.stdout, /RENAME_FAILED_SAFELY/);
    assert.equal(await readFile(store.preferencesPath(), "utf8"), bytes);
    assert.deepEqual(await readdir(root), ["preferences.json"]);
  });
});

test("menu displays every Host/saved combination, legacy-effective defaults and narrow widths without writes", async () => {
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  for (const host of [false, true]) for (const saved of [undefined, false, true]) {
    const store = new FileWorkMemoryPreferenceStore("unused-render-only");
    store.loadDefault = () => saved;
    store.saveDefault = async () => { assert.fail("render/cancel must not save"); };
    let handler!: (args: string, ctx: any) => Promise<void>;
    registerWorkMemoryPreferenceCommand({ registerCommand(_name, command) { handler = command.handler; } } as ExtensionAPI, store, host, "unchecked");
    await handler("", { mode: "tui", ui: { custom: async (factory: any) => {
      const menu = factory({ requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s }, new KeybindingsManager({ "app.models.save": [] }), () => {}) as SettingsMenu<boolean>;
      const screen = menu.render(180).join("\n");
      assert.match(screen, new RegExp(`✓ ${host ? "on" : "off"}`));
      assert.match(screen, new RegExp(`→ .*${(saved ?? host) ? "on" : "off"} · default`));
      assert.equal(screen.includes("Restart required"), host !== (saved ?? host));
      assert.doesNotMatch(screen, /Ctrl\+S|Notion not configured/);
      for (const width of [1, 2, 8, 16, 40, 80, 120]) for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width);
      return null;
    }, notify() {} } });
  }
});

test("memory.capture is derived only from coherent, assembled runtime facts", () => {
  for (const available of [undefined, false, true]) for (const coherent of [false, true]) {
    const result = deriveSemanticSnapshot({ task: null }, { stateAvailable: true, runCoherent: coherent as true,
      taskRelation: "none", completionRelation: "not_completed", gateRelation: "none", memoryCaptureAvailable: available });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(deriveCapabilities(result.snapshot).has("memory.capture"), coherent && available === true);
  }
});

test("SettingsMenu Enter/Ctrl+S/custom bindings save global only; cancel/headless/invalid writes nothing", async () => {
  await temporary(async (root, store) => {
    let handler!: (args: string, ctx: any) => Promise<void>;
    registerWorkMemoryPreferenceCommand({ registerCommand(name, command) {
      assert.equal(name, "work-memory"); handler = command.handler;
    } } as ExtensionAPI, store, false, "unconfigured");
    let keys = ["\u001b"];
    let bindings = new KeybindingsManager();
    const screens: string[] = [], notices: string[] = [];
    const ctx = { mode: "tui", ui: {
      custom: async (factory: any) => {
        let result: boolean | null | undefined;
        const menu = factory({ requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s }, bindings,
          (value: boolean | null) => { result = value; }) as SettingsMenu<boolean>;
        screens.push(menu.render(180).join("\n"));
        for (const key of keys) menu.handleInput(key);
        return result;
      }, notify: (s: string) => notices.push(s),
    } };
    await handler("", ctx);
    assert.deepEqual(await readdir(root), []);
    assert.match(screens[0]!, /Work Memory \(Notion\)/);
    assert.match(screens[0]!, /Capture durable project knowledge in Notion/);
    assert.match(screens[0]!, /Notion not configured/);
    assert.match(screens[0]!, /→ ✓ off · default/);
    keys = ["\u001b[A", "\r"]; await handler("", ctx);
    assert.equal(store.loadDefault(), true);
    assert.match(notices.at(-1)!, /Current Host unchanged/);
    keys = ["\u001b[B", "\u0013"]; await handler("", ctx);
    assert.equal(store.loadDefault(), false);
    assert.match(screens.at(-1)!, /Host: off · Saved: on · Restart required/);
    bindings = new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+q", "app.models.save": ["ctrl+x", "alt+s"] });
    keys = ["\u001b[A", "\r", "\u0013", "\u0011"]; await handler("", ctx);
    assert.equal(store.loadDefault(), false);
    assert.match(screens.at(-1)!, /Ctrl\+Y Save/);
    assert.match(screens.at(-1)!, /Ctrl\+X\/Alt\+S Save/);
    for (const key of ["\u0019", "\u0018", "\u001bs"]) {
      keys = ["\u001b[A", key]; await handler("", ctx); assert.equal(store.loadDefault(), true);
      await store.saveDefault(false);
    }
    const before = await readFile(store.preferencesPath(), "utf8");
    await handler("", { ...ctx, mode: "rpc" });
    assert.match(notices.at(-1)!, /global preferences.json/);
    await handler("bad", ctx);
    assert.match(notices.at(-1)!, /Usage/);
    assert.equal(await readFile(store.preferencesPath(), "utf8"), before);
    await writeFile(store.preferencesPath(), "broken");
    await handler("", ctx);
    assert.match(notices.at(-1)!, /preserved/);
    assert.equal(await readFile(store.preferencesPath(), "utf8"), "broken");
  });
});
