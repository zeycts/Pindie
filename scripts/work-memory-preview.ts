/** Isolated Pi 1.4.0 visual fixture. No real credentials, inference or external persistence. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  InteractiveMode, ModelRuntime, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { composeConfiguredPindieExtension } from "../src/composition.ts";
import { registerPindieComposition } from "../src/extension.ts";
import { FileWorkMemoryPreferenceStore } from "../src/work-memory-preference.ts";

assert.ok(process.argv.includes("--fixtures"), "Use --fixtures; this is not a production launcher.");
assert.equal(VERSION, "1.4.0");
const base = resolve(process.env.PINDIE_PREVIEW_ROOT ?? "/tmp/pindie-work-memory-preview");
assert.equal(resolve(process.env.HOME ?? ""), join(base, "home"), "Launch via isolated launch.sh");
assert.equal(resolve(process.env.PI_CODING_AGENT_DIR ?? ""), join(base, "agent"));
// Defense in depth: all socket/fetch traffic and optional real clients are forbidden in this process.
const require = createRequire(import.meta.url);
const net = require("node:net");
net.Socket.prototype.connect = () => { throw new Error("Preview: socket traffic forbidden"); };
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request: string, ...args: unknown[]) {
  if (["@notionhq/client", "discord.js", "./notion-project-memory.ts", "./discord-remote.ts"].includes(request)) {
    throw new Error(`Preview: forbidden adapter ${request}`);
  }
  return originalLoad.call(this, request, ...args);
};
globalThis.fetch = async () => { throw new Error("Preview: fetch forbidden"); };
syncBuiltinESMExports();
await mkdir(join(base, "runs"), { recursive: true });
const run = await mkdtemp(join(base, "runs", "run-"));
const cwd = join(run, "project"), agentDir = join(run, "agent"), globalBaseDir = join(run, "global");
await mkdir(cwd); await mkdir(agentDir);
await writeFile(join(agentDir, "auth.json"), "{}");
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", tuiMode: "fullscreen", checkForUpdates: false, quietStartup: true }));
const store = new FileWorkMemoryPreferenceStore(globalBaseDir);
await mkdir(globalBaseDir);
await writeFile(store.preferencesPath(), JSON.stringify({ discordRemote: false, quotaFallback: false, quotaAutoResume: false, fixture: "synthetic only" }));
const configured = !process.argv.includes("--unconfigured");
const composition = composeConfiguredPindieExtension({
  storageRoots: { globalBaseDir, projectsBaseDir: join(run, "state"), remoteRoutingBaseDir: join(run, "routing") },
  ...(configured ? { projectMemorySink: { async capture() { throw new Error("Preview sink: capture forbidden"); } } } : {}),
}, {});
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
const faux = fauxProvider({ provider: "pindie-preview-no-inference" });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.refresh({ allowNetwork: false });
const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
    resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(pi) => {
        registerPindieComposition(pi, composition);
        pi.on("input", (_event, ctx) => {
          ctx.ui.notify("Visual fixture only: model inference disabled. Use /work-memory or /quit.", "info");
          return { action: "handled" };
        });
        pi.on("before_agent_start", () => { throw new Error("Preview: inference forbidden"); });
        pi.on("before_provider_request", () => { throw new Error("Preview: provider forbidden"); });
      }],
    },
  });
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel() })), services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(run, "sessions")) });
assert.ok(runtime.session.extensionRunner.getRegisteredCommands().some((c) => c.name === "work-memory"));
assert.equal(runtime.session.getAllTools().some((t) => t.name === "pindie_memory_capture"), configured);
// Deliberate post-construction divergence; only this run's synthetic preferences are changed.
if (configured) await store.saveDefault(false);
await writeFile(join(base, "last-run.txt"), `${run}\n`);
const smoke = process.argv.includes("--smoke");
let input: (data: string) => void = () => {};
let output = "";
const noop = () => {};
const terminal: Terminal = { start(onInput) { input = onInput; }, stop: noop, drainInput: async () => {},
  write(data) { output += data; }, columns: 120, rows: 40, kittyProtocolActive: false,
  moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop,
  setTitle: noop, setProgress: noop, setProgramStatus: noop };
const mode = new InteractiveMode(runtime, { tuiMode: "fullscreen", initialThemeSetting: "dark", ...(smoke ? { terminal } : {}) });
if (smoke) {
  try {
    await mode.init();
    const before = JSON.stringify(runtime.session.sessionManager.getEntries());
    const pending = runtime.session.prompt("/work-memory");
    for (let i = 0; i < 100 && !output.includes("Capture durable project knowledge in Notion"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(output, /Work Memory \(Notion\)/);
    if (configured) assert.match(output, /Restart required/);
    else assert.match(output, /Notion not configured/);
    input("\u001b[A"); input("\u0013");
    await pending;
    assert.equal(store.loadDefault(), true);
    assert.equal(composition.featureSelection.workMemory, configured);
    assert.equal(JSON.stringify(runtime.session.sessionManager.getEntries()), before, "global save must not append Session entries");
    await writeFile(join(run, "smoke-ansi.txt"), output);
    console.log(`PASS Pi ${VERSION}: /work-memory registered, native custom dialog, Ctrl+S global-only save, Host unchanged; ${configured ? "mock configured sink" : "unconfigured"}. Run: ${run}`);
  } finally {
    mode.stop();
    await runtime.dispose();
  }
} else {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Use a new idle terminal for interactive preview; --smoke is non-interactive.");
  console.log(`Isolated Pi ${VERSION}; mock ${configured ? "configured (fake sink only)" : "unconfigured"}; inference/network forbidden. Run: ${run}`);
  await mode.run();
}
