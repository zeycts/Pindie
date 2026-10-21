import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { WatchComponent } from "../src/watch-component.ts";
import { WatchViewModel, watchText } from "../src/watch-view-model.ts";
import { watchEventId, watchGroupId } from "../src/watch-activity-grouping.ts";
import { watchEventTone } from "../src/watch-event-style.ts";
import type { UiTimelineBlock, UiWorkBlock } from "../src/ui-projection.ts";
import type { PindieControlMonitorState } from "../src/control-monitor.ts";

const work = (id: string): UiWorkBlock => ({ type: "work", kind: "command", id, toolCallId: id, toolName: "bash", lifecycle: "complete", title: `tool-${id}`, input: { command: "echo bounded" }, result: { isError: false, summary: "bounded", details: null, textContent: "bounded" }, defaultDisplayMode: "compact" });
const done = { type: "semantic", id: "done", category: "completion", lifecycle: "complete", summary: "old result", verificationStatus: "passed", checks: [], error: null, defaultDisplayMode: "compact" } as const;
const verify = { type: "semantic", id: "verify", category: "verification", lifecycle: "complete", verificationStatus: "failed", coveredCriteria: [], totalCriteria: 1, checks: [], pendingCheck: null, error: null, defaultDisplayMode: "compact" } as const;
const runtime = { type: "runtime", id: "runtime", category: "generic", title: "settled", defaultDisplayMode: "compact" } as const;
function state(timeline: readonly UiTimelineBlock[]): PindieControlMonitorState {
  return { connection: "connected", project: "remote", message: null,
    snapshot: { lease: "lease", revision: 1, session: { id: "session", displayIdentity: "not a name" }, runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: true }, semantic: { authority: "stale", taskStatus: "done", verificationStatus: "passed", verificationProgress: null, humanGate: null }, executionConfig: { model: null, thinkingLevel: "high" } },
    timeline: { sessionId: "session", revision: 1, hasMoreBefore: true, timeline } };
}
const plain = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;

test("overview: stale done/settled stays unconfirmed; latest terminal failure wins, not last green", () => {
  const vm = new WatchViewModel();
  // Synthetic 22-block reproduction, not a private/raw production-history read.
  const tail = [...Array.from({ length: 20 }, (_, i) => work(String(i))), done, runtime];
  vm.apply(state(tail));
  assert.equal(vm.blocks.length, 22);
  assert.match(vm.header(240).join("\n"), /Task state stale · current outcome unconfirmed/);
  assert.match(vm.header(240).join("\n"), /Runtime: settled/);
  assert.match(vm.header(240).at(-1)!, /Last recorded outcome \(history\).*visible tail only.*old result/);
  assert.equal(vm.historicalOutcome(), done);
  vm.apply(state([...tail, verify, work("success")])); assert.equal(vm.historicalOutcome(), verify);
  assert.match(vm.header(240).at(-1)!, /FAILURE.*Verification/);
  assert.equal(watchEventTone(vm.historicalOutcome()!), "error");
  const failure = { ...work("failure"), lifecycle: "failed" as const };
  vm.apply(state([...tail, verify, failure])); assert.equal(vm.historicalOutcome(), failure);
  assert.match(vm.header(240).at(-1)!, /FAILURE/);
  const semanticFailure = { ...done, id: "bad", lifecycle: "failed" as const, error: "rejected" };
  vm.apply(state([done, semanticFailure])); assert.equal(vm.historicalOutcome(), semanticFailure);
  for (const s of [state([runtime]), { ...state([done]), connection: "disconnected" as const }, { ...state([done]), timeline: { ...state([done]).timeline!, sessionId: "wrong" } }, state([done, ...Array.from({ length: 50 }, (_, i) => work(String(i)))])]) {
    vm.apply(s); assert.equal(vm.historicalOutcome(), null);
    assert.match(vm.header(240).at(-1)!, /No recorded outcome in visible history/);
  }
});

test("failed observation members are independent red failures, gates outrank history, remote strings sanitized", () => {
  const observation: UiWorkBlock = { type: "work", kind: "observation", id: "observation", title: "read files", lifecycle: "complete", defaultDisplayMode: "compact", items: [{ toolCallId: "r", toolName: "read", input: null, label: "file", lifecycle: "complete", result: { isError: true, summary: "bad", details: null } }] };
  const s = state([work("a"), observation, work("b"), done]);
  const gated = { ...s, snapshot: { ...s.snapshot!, semantic: { ...s.snapshot!.semantic, authority: "coherent", humanGate: { kind: "approval" as const, question: "\x1b[2J\u202eReview?" } } } };
  const colors: [string, string][] = [];
  const theme = { ...plain, fg: (token: string, text: string) => { colors.push([token, text]); return text; } } as Theme;
  const c = new WatchComponent(theme, () => 40, () => {}, () => {});
  c.apply(gated); const lines = c.render(240);
  assert.ok(lines.findIndex((line) => line.includes("HUMAN GATE")) < lines.findIndex((line) => line.includes("Last recorded outcome")));
  assert.doesNotMatch(lines.join("\n"), /[\x1b\u202e]/u);
  assert.ok(lines.some((line) => line.includes("✕ Failed")));
  assert.ok(colors.some(([token, text]) => token === "error" && text === "✕"));
  c.apply(state([done, observation])); assert.equal(c.view.historicalOutcome(), observation);
  const hostile = { ...done, summary: "\x1b[31m\u2066hostile\u202e" + "x".repeat(100_000) };
  c.apply(state([hostile])); c.handleInput("\r");
  assert.ok(c.render(80).every((line) => visibleWidth(line) <= 80));
  // Pi truncation may emit its own reset sequences; no remote style/bidi survives.
  assert.doesNotMatch(c.render(80).join("\n"), /\x1b\[31m|[\u2066\u202e]/u);
});

test("selection, child expansions and anchor normalize across append, splits, merges and 50-tail eviction", () => {
  const vm = new WatchViewModel(); const tools = Array.from({ length: 10 }, (_, i) => work(String(i)));
  vm.apply(state(tools)); vm.selected = watchGroupId("0"); vm.toggle(); vm.navigate(2); vm.toggle();
  assert.equal(vm.selected, watchEventId("1"));
  vm.anchor = { id: watchEventId("1"), offset: 3 };
  vm.apply(state([...tools, work("10")]));
  assert.equal(vm.selected, watchEventId("1")); assert.deepEqual(vm.anchor, { id: watchEventId("1"), offset: 3 });
  vm.apply(state([{ ...tools[0]!, lifecycle: "failed" } as UiWorkBlock, ...tools.slice(1)]));
  assert.equal(vm.selected, watchEventId("1")); assert.ok(vm.expanded.has(watchGroupId("1")));
  assert.ok(vm.expanded.has(watchEventId("1")));
  vm.apply(state(tools)); assert.equal(vm.selected, watchEventId("1"));
  vm.selected = watchGroupId("0"); vm.anchor = { id: watchGroupId("0"), offset: 0 };
  vm.apply(state(tools.slice(1)));
  assert.equal(vm.selected, watchEventId("1")); assert.deepEqual(vm.anchor, { id: watchEventId("1"), offset: 0 });
  vm.apply(state(Array.from({ length: 60 }, (_, i) => work(`new-${i}`))));
  assert.equal(vm.selected, watchGroupId("new-10")); assert.equal(vm.anchor?.id, watchGroupId("new-10")); assert.equal(vm.live, false);
});

test("a selected/expanded singleton stays visible when append or lifecycle changes create/split a group", () => {
  const vm = new WatchViewModel(); vm.apply(state([work("a")])); vm.toggle();
  vm.anchor = { id: watchEventId("a"), offset: 2 };
  vm.apply(state([work("a"), work("b")]));
  assert.equal(vm.selected, watchEventId("a")); assert.ok(vm.expanded.has(watchGroupId("a")));
  assert.ok(vm.expanded.has(watchEventId("a"))); assert.equal(vm.anchor?.offset, 2);
  vm.apply(state([{ ...work("a"), lifecycle: "running" }, work("b")]));
  assert.equal(vm.selected, watchEventId("a")); assert.equal(vm.feed[0]?.kind, "event");
  vm.apply(state([{ ...work("a"), lifecycle: "failed" }, work("b")]));
  assert.equal(vm.selected, watchEventId("a")); assert.equal(vm.feed[0]?.kind, "event");
  assert.equal(watchEventTone(vm.blocks[0]!), "error");
});

test("nested keyboard/mouse uses displayed group and child rows; collapsed group never renders native children", () => {
  initTheme("dark", false);
  const terminal = { columns: 100, rows: 40, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
  const tui = new TuiAltScreen(terminal);
  const c = new WatchComponent(plain, () => 40, () => {}, () => {}, tui, () => 1000);
  let creations = 0; const original = ToolExecutionComponent.prototype.updateResult;
  ToolExecutionComponent.prototype.updateResult = function (...args) { creations++; return original.apply(this, args); };
  const render = () => c.render(100);
  const click = (y: number) => {
    for (const type of ["press", "release", "click"] as const) c.handleMouse({ type, button: "left", x: 3, y, screenX: 3, screenY: y + 1, width: 100, height: 38, shift: false, alt: false, ctrl: false } satisfies TuiMouseEvent);
  };
  const double = (text: string) => { const y = render().findIndex((line) => line.includes(text)); assert.ok(y >= 5); click(y); click(y); };
  try {
    c.apply(state([work("a"), work("b")]));
    assert.equal(render().filter((line) => line.includes("tool-")).length, 0); assert.equal(creations, 0);
    double("2 tool operations"); render(); assert.equal(creations, 0);
    assert.equal(c.view.expanded.has(watchGroupId("a")), true);
    double("tool-a"); assert.equal(c.view.selected, watchEventId("a"));
    assert.match(render().join("\n"), /Native Pi/); assert.equal(creations, 1);
    render(); assert.equal(creations, 1);
    c.handleInput("j"); assert.equal(c.view.selected, watchEventId("b"));
    c.handleInput("\r"); render(); assert.equal(creations, 2);
    double("2 tool operations"); render(); assert.equal(creations, 2);
    assert.equal(c.view.displayed().length, 1);
    double("2 tool operations"); render(); assert.equal(creations, 4); // Hidden child cache was evicted.
    assert.equal(render().filter((line) => line.startsWith(">" )).length, 1);
    c.handleInput("G"); assert.equal(c.view.live, true);
  } finally { c.stop(); ToolExecutionComponent.prototype.updateResult = original; }
});

test("SCROLLED child-row anchor survives regroup and eviction without jumping to agent output", () => {
  const c = new WatchComponent(plain, () => 16, () => {}, () => {});
  const tools = Array.from({ length: 50 }, (_, i) => work(String(i)));
  c.apply(state(tools)); c.render(100);
  c.view.live = false; c.view.expanded.add(watchGroupId("0")); c.view.selected = watchEventId("3");
  c.render(100);
  c.handleMouse({ type: "wheel", button: "none", x: 3, y: 6, screenX: 3, screenY: 7, width: 100, height: 14, shift: false, alt: false, ctrl: false, wheelDelta: 4 }); c.render(100);
  const before = c.view.anchor; assert.equal(before?.id, watchEventId("3"));
  c.apply(state([...tools.slice(1), work("50")])); c.render(100);
  assert.deepEqual(c.view.anchor, before); assert.equal(c.view.selected, watchEventId("3"));
  c.apply(state([...tools.slice(4), ...Array.from({ length: 4 }, (_, i) => work(`new-${i}`))])); c.render(100);
  assert.equal(c.view.live, false); assert.equal(c.view.anchor?.id, c.view.displayed()[0]?.id);
  assert.ok(c.render(100).every((line) => watchText(line) === line));
});
