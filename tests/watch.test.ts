import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, initTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { createWatchCommand } from "../src/watch-command.ts";
import { WatchComponent } from "../src/watch-component.ts";
import type { PindieControlMonitorOptions, PindieControlMonitorState } from "../src/control-monitor.ts";
import type { MonitorSnapshot, PindieControlMonitorPort } from "../src/control-monitor-client.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot: MonitorSnapshot = {
  lease: "remote-lease", revision: 1, session: { id: "remote-id", displayIdentity: "远端会话" },
  runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: true },
  semantic: { taskStatus: "active", verificationStatus: "pending", verificationProgress: null, humanGate: null },
  executionConfig: { model: null, thinkingLevel: "high" },
};
const state: PindieControlMonitorState = {
  connection: "connected", project: "远端项目", snapshot, message: null, epoch: 1,
  timeline: { sessionId: "remote-id", revision: 1, hasMoreBefore: true, timeline: Array.from({ length: 50 }, (_, i) => ({
    type: "runtime", id: `r${i}`, category: "generic", title: `事件-${i}`, detail: "中文 👨‍👩‍👧‍👦 é", defaultDisplayMode: "preview",
  })) },
};
const theme = { fg: (_color: string, text: string) => text } as Theme;

class FakeTerminal implements Terminal {
  writes: string[] = []; columns = 80; rows = 20; starts = 0; stops = 0;
  private input?: (data: string) => void;
  kittyProtocolActive = false;
  start(input: (data: string) => void) { this.starts++; this.input = input; }
  stop() { this.stops++; }
  drainInput() { return Promise.resolve(); }
  write(data: string) { this.writes.push(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  emit(data: string) { this.input?.(data); }
}

function fixture(options: PindieControlMonitorOptions = {}) {
  initTheme("dark", false);
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const control = createWatchCommand({ registerCommand: (name: string, command: any) => commands.set(name, command) } as ExtensionAPI, options);
  const terminal = new FakeTerminal();
  const tui = new TuiMainScreen(terminal);
  let draft = "LOCAL draft 中文";
  const localHistory = Object.freeze(["LOCAL history"]);
  const session = Object.freeze({ id: "local-id", history: localHistory });
  const editor = { getText: () => draft, setText: (text: string) => { draft = text; }, render: () => [draft], invalidate() {} };
  const editorContainer = new Container(); editorContainer.addChild(editor);
  tui.addChild(editorContainer); tui.setFocus(editor);
  // Actual pinned custom UI implementation, inert native Session/terminal fixture.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), { editor, editorContainer, ui: tui, runtimeHost: { session } });
  const notices: string[] = [];
  const ctx = {
    hasUI: true, mode: "tui", sessionManager: new Proxy({}, { get() { throw new Error("Watch must not inspect local Session"); } }),
    ui: { custom: mode.showExtensionCustom.bind(mode), notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  return { control, commands, terminal, tui, editor, editorContainer, mode, ctx, notices, session, draft: () => draft };
}
function clientOptions() {
  let connects = 0, closes = 0, calls = 0;
  let signal: AbortSignal | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  const port: PindieControlMonitorPort = {
    async observe() { calls++; return { state: "active_project", activeProject: "remote-project", control: snapshot }; },
    async readTimeline() { calls++; return state.timeline!; },
    async wait() { calls++; return new Promise((_, reject) => { rejectWait = reject; }); },
    async close() { closes++; rejectWait?.(new Error("closed")); },
  };
  return {
    options: { createClient: async (abort: AbortSignal) => { connects++; signal = abort; return port; } },
    facts: () => ({ connects, closes, calls, aborted: signal?.aborted }),
  };
}

test("/watch registers only on native UI startup; no resources at registration, reentrant startup or in headless/RPC", async () => {
  const client = clientOptions(); const f = fixture(client.options);
  assert.equal(f.commands.size, 0);
  for (const mode of ["print", "json", "rpc", "tui"]) f.control.sessionStart({ ...f.ctx, mode, hasUI: mode === "rpc" } as ExtensionCommandContext);
  assert.equal(f.commands.size, 0);
  f.control.sessionStart(f.ctx); f.control.sessionStart(f.ctx);
  assert.deepEqual([...f.commands.keys()], ["watch"]);
  assert.equal(client.facts().connects, 0);
  await f.commands.get("watch")!.handler("", { ...f.ctx, hasUI: false });
  await f.commands.get("watch")!.handler("", { ...f.ctx, mode: "rpc" });
  await f.commands.get("watch")!.handler("extra", f.ctx);
  assert.match(f.notices.at(-1)!, /Usage/);
  assert.equal(client.facts().connects, 0);
});

for (const exit of ["q", "\u001b", "\u0003", "shutdown", "dispose"]) {
  test(`actual pinned custom overlay exits by ${JSON.stringify(exit)}, restores LOCAL editor focus, closes only observer; can reopen`, async () => {
    const client = clientOptions(); const f = fixture(client.options);
    f.control.sessionStart(f.ctx);
    const handler = f.commands.get("watch")!.handler;
    const pending = handler("", f.ctx);
    await turn();
    assert.equal(f.tui.hasOverlay(), true);
    assert.equal(f.tui.isOverlayFocused(), true);
    assert.equal(f.editorContainer.children[0], f.editor);
    assert.equal(f.mode.session, f.session);
    assert.equal(f.draft(), "LOCAL draft 中文");
    await handler("", f.ctx);
    assert.match(f.notices.at(-1)!, /already open/);
    assert.equal(client.facts().connects, 1);
    const component = f.tui.getFocusedComponent() as WatchComponent;
    assert.match(component.render(80).join("\n"), /Remote Session: 远端会话/);
    if (exit === "shutdown") await f.control.shutdown();
    else if (exit === "dispose") component.dispose();
    else component.handleInput(exit);
    await pending;
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.draft(), "LOCAL draft 中文");
    assert.equal(f.mode.session, f.session);
    assert.deepEqual(client.facts(), { connects: 1, closes: 1, calls: 3, aborted: true });
    assert.equal(f.terminal.starts, 0); // custom UI never starts a terminal/listener
    const second = handler("", f.ctx); await turn(); await f.control.shutdown(); await second;
    assert.equal(client.facts().closes, 2);
  });
}

test("parallel Pi overlay prevents monitor creation; custom rejection and pre-mount shutdown leave no resources", async () => {
  const client = clientOptions(); const f = fixture(client.options); f.control.sessionStart(f.ctx);
  const other = f.tui.showOverlay({ render: () => ["other"], invalidate() {} });
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.equal(client.facts().connects, 0);
  assert.match(f.notices.at(-1)!, /Close the current Pi overlay/);
  other.hide();
  const pending = f.commands.get("watch")!.handler("", f.ctx);
  await f.control.shutdown(); await pending; await turn();
  assert.equal(f.tui.hasOverlay(), false);
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  assert.equal(client.facts().connects, 0);
  await f.commands.get("watch")!.handler("", { ...f.ctx, ui: { ...f.ctx.ui, custom: async () => { throw new Error("UI failed"); } } });
  assert.match(f.notices.at(-1)!, /UI failed/);
});

test("closing Watch does not dismiss or steal focus from a later Pi dialog", async () => {
  const client = clientOptions(); const f = fixture(client.options); f.control.sessionStart(f.ctx);
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  const dialog = { render: () => ["Pi dialog"], invalidate() {} };
  const handle = f.tui.showOverlay(dialog);
  await f.control.shutdown(); await pending;
  assert.equal(f.tui.hasOverlay(), true);
  assert.equal(f.tui.getFocusedComponent(), dialog);
  handle.hide();
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  assert.equal(client.facts().closes, 1);
});

test("exit while connecting aborts and closes a late client before re-entry", async () => {
  let release!: (port: PindieControlMonitorPort) => void;
  let signal!: AbortSignal;
  let closes = 0;
  const f = fixture({ createClient: (abort) => { signal = abort; return new Promise((resolve) => { release = resolve; }); } });
  f.control.sessionStart(f.ctx);
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  (f.tui.getFocusedComponent() as WatchComponent).handleInput("q");
  assert.equal(signal.aborted, true);
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.match(f.notices.at(-1)!, /already open or closing/);
  release({ async close() { closes++; }, async observe() { throw new Error("must not observe after close"); }, async readTimeline() { throw new Error("unexpected"); }, async wait() { throw new Error("unexpected"); } });
  await pending;
  assert.equal(closes, 1);
  assert.equal(f.tui.hasOverlay(), false);
});

test("bounded viewport, Chinese/emoji widths, scroll preservation across rapid updates, live tail, epoch reset and resize", () => {
  let rows = 16, renders = 0, exits = 0;
  const c = new WatchComponent(theme, () => rows, () => { renders++; }, () => { exits++; });
  c.apply(state);
  const render = (width = 70) => c.render(width).join("\n");
  assert.match(render(), /事件-49/);
  c.handleInput("\u001b[5~");
  assert.doesNotMatch(render(), /事件-49/);
  const before = render();
  for (let i = 0; i < 100; i++) c.apply({ ...state, snapshot: { ...snapshot, revision: i } });
  assert.equal(render(), before);
  assert.match(render(), /SCROLLED/);
  c.handleInput("G"); assert.match(render(), /事件-49/);
  c.handleInput("k"); c.apply({ ...state, epoch: 2 }); assert.match(render(), /事件-49/);
  for (const width of [1, 2, 12, 40, 80]) for (const height of [1, 3, 10, 24, 80]) {
    rows = height;
    const lines = c.render(width);
    assert.ok(lines.length <= Math.max(1, height - 2));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  c.handleInput("/stop"); assert.equal(exits, 0);
  c.stop(); const count = renders; c.apply(state); c.handleInput("q");
  assert.equal(renders, count); assert.equal(exits, 0);
});

test("disconnected and Human Gate remain visible and escapable with no mutation path", async () => {
  let aborted = false;
  const f = fixture({ createClient: async () => { throw new Error("offline"); }, sleep: (_ms, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }, { once: true });
  }) });
  f.control.sessionStart(f.ctx);
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  const c = f.tui.getFocusedComponent() as WatchComponent;
  assert.match(c.render(80).join("\n"), /DISCONNECTED/);
  c.apply({ ...state, snapshot: { ...snapshot, semantic: { ...snapshot.semantic, humanGate: { kind: "approval", question: "允许发布？" } } } });
  const text = c.render(80).join("\n");
  assert.match(text, /HUMAN GATE.*允许发布/); assert.match(text, /not local chat/);
  c.handleInput("\u001b"); await pending; assert.equal(aborted, true);
});

test("isolated fake-terminal smoke uses one native TUI listener and no alternate screen", async () => {
  const client = clientOptions(); const f = fixture(client.options); f.control.sessionStart(f.ctx);
  f.tui.start();
  try {
    const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
    // Force the actual pinned renderer in this inert test terminal.
    f.tui.requestRender(true); await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(f.terminal.writes.join(""), /Remote read-only/);
    f.terminal.emit("k"); f.terminal.emit("G"); f.terminal.emit("q"); await pending;
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.terminal.starts, 1);
    assert.doesNotMatch(f.terminal.writes.join(""), /\u001b\[\?1049h/);
  } finally { await f.control.shutdown(); f.tui.stop(); }
  assert.equal(f.terminal.stops, 1);
});
