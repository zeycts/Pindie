import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, ToolExecutionComponent, initTheme, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { createWatchCommand } from "../src/watch-command.ts";
import { WatchComponent } from "../src/watch-component.ts";
import { projectToolResult } from "../src/ui-timeline.ts";
import type { PindieControlMonitorOptions, PindieControlMonitorState } from "../src/control-monitor.ts";
import type { MonitorSnapshot, PindieControlMonitorPort } from "../src/control-monitor-client.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const snapshot: MonitorSnapshot = {
  lease: "remote-lease", revision: 1, session: { id: "remote-id", displayIdentity: "远端会话" },
  runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: true },
  semantic: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", verificationProgress: null, humanGate: null },
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

function fixture(options: PindieControlMonitorOptions = {}, fullscreen = false) {
  initTheme("dark", false);
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  let statusScopes = 0;
  const control = createWatchCommand({ registerCommand: (name: string, command: any) => commands.set(name, command) } as ExtensionAPI, options, () => {
    statusScopes++;
    let released = false;
    return () => { if (!released) { released = true; statusScopes--; } };
  });
  const terminal = new FakeTerminal();
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
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
  return { control, commands, terminal, tui, editor, editorContainer, mode, ctx, notices, session, draft: () => draft, statusScopes: () => statusScopes };
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

for (const exit of ["q", "\u001b", "\u0003", "shutdown", "dispose", "session-swap"]) {
  test(`actual pinned custom overlay exits by ${JSON.stringify(exit)}, restores LOCAL editor focus, closes only observer; can reopen`, async () => {
    const client = clientOptions(); const f = fixture(client.options);
    f.control.sessionStart(f.ctx);
    const handler = f.commands.get("watch")!.handler;
    const pending = handler("", f.ctx);
    await turn();
    assert.equal(f.tui.hasOverlay(), true);
    assert.equal(f.statusScopes(), 1);
    assert.equal(f.tui.isOverlayFocused(), true);
    assert.equal(f.editorContainer.children[0], f.editor);
    assert.equal(f.mode.session, f.session);
    assert.equal(f.draft(), "LOCAL draft 中文");
    await handler("", f.ctx);
    assert.match(f.notices.at(-1)!, /already open/);
    assert.equal(client.facts().connects, 1);
    const component = f.tui.getFocusedComponent() as WatchComponent;
    assert.match(component.render(80).join("\n"), /Remote Session: remote-i/);
    if (exit === "session-swap") f.control.sessionStart({ ...f.ctx });
    else if (exit === "shutdown") await f.control.shutdown();
    else if (exit === "dispose") component.dispose();
    else component.handleInput(exit);
    await pending;
    assert.equal(f.statusScopes(), 0);
    assert.equal(f.tui.hasOverlay(), false);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.draft(), "LOCAL draft 中文");
    assert.equal(f.mode.session, f.session);
    assert.deepEqual(client.facts(), { connects: 1, closes: 1, calls: 3, aborted: true });
    assert.equal(f.terminal.starts, 0); // custom UI never starts a terminal/listener
    const second = handler("", f.ctx); await turn(); await f.control.shutdown(); await second;
    assert.equal(client.facts().closes, 2);
    assert.equal(f.statusScopes(), 0);
  });
}

test("parallel Pi overlay prevents monitor creation; custom rejection and pre-mount shutdown leave no resources", async () => {
  const client = clientOptions(); const f = fixture(client.options); f.control.sessionStart(f.ctx);
  const other = f.tui.showOverlay({ render: () => ["other"], invalidate() {} });
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.equal(client.facts().connects, 0);
  assert.match(f.notices.at(-1)!, /Close the current Pi overlay/);
  assert.equal(f.statusScopes(), 0);
  other.hide();
  const pending = f.commands.get("watch")!.handler("", f.ctx);
  await f.control.shutdown(); await pending; await turn();
  assert.equal(f.tui.hasOverlay(), false);
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  assert.equal(client.facts().connects, 0);
  await f.commands.get("watch")!.handler("", { ...f.ctx, ui: { ...f.ctx.ui, custom: async () => { throw new Error("UI failed"); } } });
  assert.match(f.notices.at(-1)!, /UI failed/);
  assert.equal(f.statusScopes(), 0);
});

test("normal custom completion and post-factory exceptions always release Watch status", async () => {
  for (const fail of [false, true]) {
    const f = fixture(); f.control.sessionStart(f.ctx);
    await f.commands.get("watch")!.handler("", { ...f.ctx, ui: { ...f.ctx.ui, custom: async (factory: any) => {
      factory(f.tui, theme, {}, () => {});
      assert.equal(f.statusScopes(), 1);
      if (fail) throw new Error("after factory");
    } } });
    assert.equal(f.statusScopes(), 0);
    if (fail) assert.match(f.notices.at(-1)!, /after factory/);
    await f.control.shutdown();
  }
});

test("monitor termination restores status and permits reentry", async () => {
  const f = fixture({ createClient: async () => { throw new Error("offline"); }, sleep: async () => { throw new Error("monitor failed"); } });
  f.control.sessionStart(f.ctx);
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.equal(f.statusScopes(), 0);
  assert.equal(f.tui.hasOverlay(), false);
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.equal(f.statusScopes(), 0);
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
  assert.equal(f.statusScopes(), 0); // restore before asynchronous client cleanup
  await f.commands.get("watch")!.handler("", f.ctx);
  assert.match(f.notices.at(-1)!, /already open or closing/);
  release({ async close() { closes++; }, async observe() { throw new Error("must not observe after close"); }, async readTimeline() { throw new Error("unexpected"); }, async wait() { throw new Error("unexpected"); } });
  await pending;
  assert.equal(closes, 1);
  assert.equal(f.tui.hasOverlay(), false);
  assert.equal(f.statusScopes(), 0);
});

test("bounded viewport, Chinese/emoji widths, scroll preservation across rapid updates, live tail, reconnect epoch preservation and resize", () => {
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
  c.handleInput("\u001b[5~"); const scrolled = render();
  c.apply({ ...state, epoch: 2 }); assert.equal(render(), scrolled);
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

test("native cards inside actual Pi overlay preserve navigation, Gate, resize and local focus; unsupported data is explicit fallback", async () => {
  const client = clientOptions(); const f = fixture(client.options); f.control.sessionStart(f.ctx);
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  const c = f.tui.getFocusedComponent() as WatchComponent;
  const command = { type: "work", kind: "command", id: "native", toolCallId: "native", toolName: "bash", lifecycle: "complete", title: "Command", input: { command: "echo remote" },
    result: projectToolResult({ content: [{ type: "text", text: Array.from({ length: 25 }, (_, i) => `remote output ${i}`).join("\n") }] }, false, "bash"), defaultDisplayMode: "compact" } as const;
  c.apply({ ...state, timeline: { ...state.timeline!, timeline: [command] } });
  c.handleInput("G");
  assert.doesNotMatch(c.render(80).join("\n"), /remote output 24/);
  c.handleInput("\r"); c.render(80); c.handleInput("G");
  assert.match(c.render(80).join("\n"), /remote output 24/);
  c.handleInput("\u001b[5~"); c.handleInput("\u001b[5~"); c.handleInput("\u001b[5~");
  assert.match(c.render(80).join("\n"), /Native Pi.*bounded projected text/);
  for (const width of [1, 2, 12, 80]) assert.ok(c.render(width).every((line) => visibleWidth(line) <= width));
  c.apply({ ...state, timeline: { ...state.timeline!, timeline: [{ ...command, toolName: "edit" }] }, snapshot: { ...snapshot, semantic: { ...snapshot.semantic, humanGate: { kind: "approval", question: "Review?" } } } });
  c.handleInput("G");
  const fallback = c.render(100).join("\n");
  assert.match(fallback, /Fallback/); assert.match(fallback, /HUMAN GATE.*Review/);
  c.handleInput("q"); await pending;
  assert.equal(f.tui.getFocusedComponent(), f.editor); assert.equal(f.draft(), "LOCAL draft 中文");
  assert.equal(client.facts().closes, 1); assert.equal(f.terminal.starts, 0);
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

// Design gate: actual public fullscreen overlay dispatch, no real terminal or Pi internals patched.
test("pinned fullscreen overlay receives normalized wheel and suppresses underlying fallback", async () => {
  const f = fixture({}, true);
  const events: import("@earendil-works/pi-tui").TuiMouseEvent[] = [];
  const overlay = {
    render: () => Array.from({ length: 18 }, () => "mouse gate"), invalidate() {},
    handleMouse(event: import("@earendil-works/pi-tui").TuiMouseEvent) {
      events.push(event); return { handled: true, render: false };
    },
  };
  f.tui.start();
  const handle = f.tui.showOverlay(overlay, { width: "100%", anchor: "top-left" });
  try {
    f.tui.renderNow(true);
    f.terminal.emit("\x1b[<64;5;6M"); f.terminal.emit("\x1b[<65;5;6M");
    assert.equal(events.length, 2);
    assert.ok(events[0]!.wheelDelta! < 0); assert.ok(events[1]!.wheelDelta! > 0);
    assert.equal(events[0]!.y, 5); assert.equal(events[0]!.x, 4);
    assert.match(f.terminal.writes.join(""), /\x1b\[\?1006h/);
  } finally { handle.hide(); f.tui.stop(); }
  assert.match(f.terminal.writes.join(""), /\x1b\[\?1006l/);
  assert.equal(f.terminal.starts, 1); assert.equal(f.terminal.stops, 1);
});


test("actual fullscreen SGR press/release/click targets Watch-local rows; double-click toggles without native input or boundary toggles", async () => {
  const client = clientOptions(); const f = fixture(client.options, true); f.control.sessionStart(f.ctx);
  f.tui.start();
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  const c = f.tui.getFocusedComponent() as WatchComponent;
  c.apply({ ...state, timeline: { ...state.timeline!, timeline: state.timeline!.timeline.slice(0, 3) } });
  const received: import("@earendil-works/pi-tui").TuiMouseEvent[] = [];
  const mouse = c.handleMouse.bind(c);
  c.handleMouse = (event) => { received.push(event); return mouse(event); };
  const paint = () => { f.tui.renderNow(); return c.render(80); };
  const click = (y: number, x = 3, button = 0) => {
    // Centered overlay is 18 rows in a 20-row terminal: one-row screen offset.
    f.terminal.emit(`\x1b[<${button};${x + 1};${y + 2}M`);
    f.terminal.emit(`\x1b[<${button};${x + 1};${y + 2}m`);
  };
  try {
    f.tui.renderNow(true);
    for (const expanded of [true, false, true, false]) {
      const y = paint().findIndex((line) => line.includes("事件-1"));
      assert.ok(y >= 4);
      click(y); assert.equal(c.view.expanded.has("r1"), !expanded);
      click(y); assert.equal(c.view.expanded.has("r1"), expanded);
      paint();
    }
    assert.ok(received.some((event) => event.type === "click" && event.clickCount === 2));
    assert.ok(received.some((event) => event.type === "release" && event.button === "left"));
    assert.ok(received.every((event) => event.screenY === event.y + 1 && event.width === 80 && event.height === 18));
    for (const [y, x, button] of [[0, 3, 0], [17, 3, 0], [5, 79, 0], [5, 3, 2]]) {
      click(y!, x!, button!); click(y!, x!, button!);
      assert.equal(c.view.expanded.size, 0);
    }
    const y = paint().findIndex((line) => line.includes("事件-1"));
    click(y); click(y + 1); assert.equal(c.view.expanded.size, 0);
    c.apply({ ...state, timeline: { ...state.timeline!, timeline: [{
      type: "work", kind: "command", id: "native-mouse", toolCallId: "native-mouse", toolName: "bash", lifecycle: "complete", title: "Command",
      input: { command: "echo projected" }, defaultDisplayMode: "compact",
      result: projectToolResult({ content: [{ type: "text", text: "unique projected native body" }] }, false, "bash"),
    }] } });
    const titleRow = paint().findIndex((line) => line.startsWith(">+") || line.startsWith(" +"));
    click(titleRow); click(titleRow);
    assert.ok(c.view.expanded.has("native-mouse"));
    const bodyRow = paint().findIndex((line) => line.includes("unique projected native body"));
    assert.ok(bodyRow > titleRow);
    click(bodyRow); click(bodyRow);
    assert.equal(c.view.expanded.has("native-mouse"), false);
    assert.equal(c.view.selected, "native-mouse");
    assert.equal(c.view.live, false);
    assert.equal(client.facts().calls, 3); // Input remains entirely presentation-only.
    c.handleInput("q"); await pending;
    assert.equal(f.draft(), "LOCAL draft 中文");
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(client.facts().closes, 1);
  } finally { await f.control.shutdown(); await pending; f.tui.stop(); }
});

test("real fullscreen Watch wheel scrolls only feed once; ID anchoring, updates, expansion and editor restoration", async () => {
  const client = clientOptions(); const f = fixture(client.options, true); f.control.sessionStart(f.ctx);
  f.tui.start();
  const pending = f.commands.get("watch")!.handler("", f.ctx); await turn();
  const c = f.tui.getFocusedComponent() as WatchComponent;
  const wheels: import("@earendil-works/pi-tui").TuiMouseEvent[] = [];
  const mouse = c.handleMouse.bind(c);
  c.handleMouse = (event) => { wheels.push(event); return mouse(event); };
  try {
    c.apply(state); f.tui.renderNow(true);
    assert.equal(c.view.live, true);
    assert.ok(c.render(80).filter((line) => /事件-/.test(line)).length >= 8);
    // Overlay is centered with one terminal row above it. Header local y=0.
    f.terminal.emit("\x1b[<64;5;2M");
    assert.equal(c.view.live, true); assert.equal(wheels.at(-1)!.y, 0);
    // Feed local y=8. Real SGR decode -> public handler -> private viewport.
    f.terminal.emit("\x1b[<64;5;10M");
    assert.equal(c.view.live, false);
    const delta = wheels.at(-1)!.wheelDelta!;
    c.render(80);
    assert.equal(c.view.anchor?.id, `r${37 + delta}`); // exactly one scroll, no parent ScrollView
    const anchor = { ...c.view.anchor! };
    f.tui.renderNow(true);
    f.terminal.emit("\x1b[<65;5;19M"); // footer
    c.render(80); assert.deepEqual(c.view.anchor, anchor);
    const text = c.render(80).join("\n");
    const block = { ...state.timeline!.timeline.at(-1)!, id: "new", title: "new event" };
    c.apply({ ...state, epoch: 5, timeline: { ...state.timeline!, timeline: [...state.timeline!.timeline.slice(1), block] } });
    assert.equal(c.render(80).join("\n"), text);
    assert.deepEqual(c.view.anchor, anchor);
    f.terminal.emit("k"); c.render(80);
    const selected = c.view.selected;
    f.terminal.emit("\r"); c.render(80); assert.ok(c.view.expanded.has(selected!));
    c.apply({ ...c.view.state, snapshot: { ...snapshot, revision: 99 } }); c.render(80);
    assert.equal(c.view.selected, selected); assert.ok(c.view.expanded.has(selected!));
    f.terminal.emit("\r"); c.render(80); assert.equal(c.view.expanded.has(selected!), false);
    f.terminal.emit("G"); c.render(80); assert.equal(c.view.live, true);
    f.tui.renderNow(true); f.terminal.emit("\x1b[<64;5;10M"); c.render(80);
    const up = c.view.anchor!.id;
    f.terminal.emit("\x1b[<65;5;10M"); c.render(80); assert.notEqual(c.view.anchor!.id, up);
    f.terminal.rows = 12; f.terminal.columns = 20; f.tui.renderNow(true);
    assert.ok(c.render(20).every((line) => visibleWidth(line) <= 20));
    f.terminal.emit("q"); await pending;
    assert.equal(f.tui.getFocusedComponent(), f.editor); assert.equal(f.draft(), "LOCAL draft 中文");
    assert.equal(f.terminal.starts, 1); assert.equal(client.facts().closes, 1);
  } finally { await f.control.shutdown(); await pending; f.tui.stop(); }
  assert.equal(f.terminal.stops, 1);
});


test("native expansion is lazy, memoized by bounded content and cleared on collapse/invalidation", () => {
  initTheme("dark", false);
  const terminal = new FakeTerminal(); const tui = new TuiAltScreen(terminal);
  const c = new WatchComponent(theme, () => 24, () => {}, () => {}, tui);
  const block = { type: "work", kind: "command", id: "native-cache", toolCallId: "native-cache", toolName: "bash", lifecycle: "complete", title: "Command", input: { command: "echo remote" },
    result: projectToolResult({ content: [{ type: "text", text: "bounded remote output" }] }, false, "bash"), defaultDisplayMode: "compact" } as const;
  const update = (event = block) => c.apply({ ...state, timeline: { ...state.timeline!, timeline: [event] } });
  let creations = 0;
  const updateResult = ToolExecutionComponent.prototype.updateResult;
  ToolExecutionComponent.prototype.updateResult = function (...args) { creations++; return updateResult.apply(this, args); };
  try {
    update(); c.render(80); c.render(20); assert.equal(creations, 0);
    c.handleInput("\r"); c.render(80); assert.equal(creations, 1);
    update(); c.render(80); c.render(20); assert.equal(creations, 1);
    update({ ...block, title: "changed content" }); c.render(80); assert.equal(creations, 2);
    c.invalidate(); c.render(80); assert.equal(creations, 3);
    c.handleInput("\r"); c.render(80); assert.equal(creations, 3);
    c.handleInput("\r"); c.render(80); assert.equal(creations, 4);
    c.apply({ ...state, timeline: { ...state.timeline!, timeline: [{ ...block, toolName: "edit" }] } });
    assert.match(c.render(80).join("\n"), /Fallback/); assert.equal(creations, 4);
    c.stop(); assert.equal(terminal.starts, 0);
  } finally { ToolExecutionComponent.prototype.updateResult = updateResult; }
});


test("SCROLLED preserves event-local row through changed preceding content, resize and bounded-tail eviction", () => {
  initTheme("dark", false);
  const tui = new TuiAltScreen(new FakeTerminal());
  const c = new WatchComponent(theme, () => 20, () => {}, () => {}, tui);
  const block = { type: "work", kind: "command", id: "anchor", toolCallId: "anchor", toolName: "bash", lifecycle: "complete", title: "Command", input: { command: "echo remote" },
    result: projectToolResult({ content: [{ type: "text", text: Array.from({ length: 25 }, (_, i) => `output ${i}`).join("\n") }] }, false, "bash"), defaultDisplayMode: "compact" } as const;
  c.apply({ ...state, timeline: { ...state.timeline!, timeline: [block] } }); c.render(80);
  c.handleInput("\r"); c.render(80); c.handleInput("\x1b[6~"); c.render(80);
  const anchor = { ...c.view.anchor! }; assert.equal(anchor.id, "anchor"); assert.ok(anchor.offset > 0);
  const before = c.render(80).slice(4, -1);
  c.apply({ ...state, timeline: { ...state.timeline!, timeline: [...state.timeline!.timeline.slice(0, 40), block] } });
  assert.deepEqual(c.render(80).slice(4, -1), before); assert.deepEqual(c.view.anchor, anchor);
  c.render(60); assert.deepEqual(c.view.anchor, anchor);
  c.apply(state); c.render(80);
  assert.equal(c.view.live, false); assert.equal(c.view.anchor!.id, "r0");
  c.stop();
});
