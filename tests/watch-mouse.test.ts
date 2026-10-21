import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { WatchComponent } from "../src/watch-component.ts";
import type { PindieControlMonitorState } from "../src/control-monitor.ts";

const state: PindieControlMonitorState = {
  connection: "connected", project: "remote", message: null, epoch: 1,
  snapshot: { lease: "lease", revision: 1, session: { id: "remote-session", displayIdentity: "not a name" },
    runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: true },
    semantic: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", verificationProgress: null, humanGate: null },
    executionConfig: { model: null, thinkingLevel: "high" } },
  timeline: { sessionId: "remote-session", revision: 1, hasMoreBefore: false,
    timeline: Array.from({ length: 4 }, (_, i) => ({ type: "runtime", id: `e${i}`, category: "generic", title: `event-${i}`,
      detail: "wrapped 中文 content ".repeat(30), defaultDisplayMode: "compact" })) },
};

function fixture() {
  let time = 1_000, width = 80, height = 28;
  const c = new WatchComponent({ fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text } as Theme, () => height, () => {}, () => {}, undefined, () => time);
  c.apply(state);
  const render = () => c.render(width);
  const row = (id: number) => {
    const y = render().findIndex((line) => line.includes(`event-${id}`));
    assert.ok(y >= 4, `event-${id} must be visible`);
    return y;
  };
  const event = (type: TuiMouseEvent["type"], y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
    type, button: "left", x: 3, y, screenX: 3, screenY: y + 1, width, height: height - 2,
    shift: false, alt: false, ctrl: false, ...extra,
  });
  const click = (y: number, extra: Partial<TuiMouseEvent> = {}) => {
    c.handleMouse(event("press", y, extra));
    c.handleMouse(event("release", y, extra));
    return c.handleMouse(event("click", y, { clickCount: 2, ...extra })); // Deliberately untrusted native count.
  };
  render();
  return { c, render, row, click, event, advance: (ms: number) => { time += ms; }, resize: (w: number, h = height) => { width = w; height = h; } };
}

test("completed same-row left-click pairs toggle repeatedly, never a single click; Enter retains identical expansion semantics", () => {
  const f = fixture();
  for (const expanded of [true, false, true, false]) {
    const y = f.row(1);
    f.click(y);
    assert.equal(f.c.view.expanded.has("e1"), !expanded);
    f.advance(300);
    f.click(y);
    assert.equal(f.c.view.expanded.has("e1"), expanded);
    assert.equal(f.c.view.selected, "e1");
    assert.equal(f.c.view.live, false);
    f.render();
  }
  f.c.handleInput("\r"); assert.ok(f.c.view.expanded.has("e1"));
  f.c.handleInput("\r"); assert.equal(f.c.view.expanded.has("e1"), false);
});

test("different rows, timeout, motion/drag, modifiers, non-left buttons and unmatched click events cannot form a double-click", () => {
  for (const interrupt of ["other-row", "timeout", "move", "drag", "right", "middle", "shift", "unmatched"] as const) {
    const f = fixture(); const y = f.row(1);
    f.click(y);
    if (interrupt === "other-row") f.click(f.row(2));
    else if (interrupt === "timeout") f.advance(401);
    else if (interrupt === "right" || interrupt === "middle") f.click(y, { button: interrupt });
    else if (interrupt === "shift") f.click(y, { shift: true });
    else if (interrupt === "unmatched") f.c.handleMouse(f.event("click", y));
    else f.c.handleMouse(f.event(interrupt, y));
    f.click(y);
    assert.equal(f.c.view.expanded.size, 0, interrupt);
  }
  const f = fixture(); const y = f.row(1);
  f.c.handleMouse(f.event("press", y));
  f.c.handleMouse(f.event("drag", y, { x: 4 }));
  f.c.handleMouse(f.event("release", y));
  f.c.handleMouse(f.event("click", y));
  f.click(y);
  assert.equal(f.c.view.expanded.size, 0);
});

test("header, footer, blank rows, rightmost/scrollbar boundary, outside viewport and unsafe coordinates never toggle or join pairs", () => {
  for (const extra of [
    { y: 0 }, { y: 25 }, { y: 20 }, { y: -1 }, { y: 28 }, { x: 79 }, { x: -1 }, { x: 80 },
    { x: NaN }, { y: 4.5 }, { screenY: NaN }, { screenY: -1 }, { screenX: -1 }, { width: 79 }, { height: 25 },
  ]) {
    const f = fixture(); const y = f.row(1);
    f.click(y); f.click(y, extra); f.click(y);
    assert.equal(f.c.view.expanded.size, 0, JSON.stringify(extra));
  }
});

test("wheel (including header), keyboard scrolling, resize, async updates and Session/epoch replacement invalidate pending clicks and unpainted hit maps", () => {
  for (const interrupt of ["wheel", "header-wheel", "keyboard", "resize", "update", "replacement", "invalidate"] as const) {
    const f = fixture(); const y = f.row(1); f.click(y);
    if (interrupt === "wheel" || interrupt === "header-wheel") f.c.handleMouse(f.event("wheel", interrupt === "wheel" ? y : 0, { button: "none", wheelDelta: -1 }));
    else if (interrupt === "keyboard") f.c.handleInput("\u001b[5~");
    else if (interrupt === "resize") f.resize(79);
    else if (interrupt === "invalidate") f.c.invalidate();
    else f.c.apply(interrupt === "update" ? { ...state, snapshot: { ...state.snapshot!, revision: 2 } } : {
      ...state, epoch: 2, snapshot: { ...state.snapshot!, session: { id: "replacement", displayIdentity: "new" } },
      timeline: { ...state.timeline!, sessionId: "replacement" },
    });
    if (interrupt !== "header-wheel" && interrupt !== "resize") {
      f.click(y); // No render since update: old pixels cannot supply a fresh hit.
      assert.equal(f.c.view.expanded.size, 0);
    }
    f.render(); f.click(f.row(1));
    assert.equal(f.c.view.expanded.size, 0, interrupt);
  }
});

test("row movement or async update between press and release cannot reuse a stale card hit", () => {
  for (const move of [false, true]) {
    const f = fixture(); const y = f.row(1);
    f.click(y);
    f.c.handleMouse(f.event("press", y));
    f.c.apply({ ...state, epoch: 2, timeline: { ...state.timeline!, timeline: move ? [...state.timeline!.timeline].reverse() : state.timeline!.timeline } });
    f.render();
    f.c.handleMouse(f.event("release", y));
    f.c.handleMouse(f.event("click", y));
    assert.equal(f.c.view.expanded.size, 0);
    f.click(f.row(1)); assert.equal(f.c.view.expanded.size, 0);
  }
});

test("expanded wrapped content hits its owning event and event-local row, not the next card; narrow terminals fail closed at boundaries", () => {
  const f = fixture();
  f.click(f.row(1)); f.click(f.row(1));
  assert.ok(f.c.view.expanded.has("e1"));
  f.resize(24); const lines = f.render();
  const body = lines.findIndex((line) => line.includes("wrapped"));
  assert.ok(body > 4);
  f.click(body); f.click(body + 1); // Same card, different wrapped row is not a pair.
  assert.ok(f.c.view.expanded.has("e1"));
  f.advance(401); f.click(body + 1); f.click(body + 1);
  assert.equal(f.c.view.expanded.has("e1"), false);
  assert.equal(f.c.view.selected, "e1");
  f.resize(1); f.render(); f.click(4, { x: 0, screenX: 0 }); f.click(4, { x: 0, screenX: 0 });
  assert.equal(f.c.view.expanded.size, 0);
  f.resize(2); f.render(); f.click(4, { x: 0, screenX: 0 }); f.click(4, { x: 0, screenX: 0 });
  assert.ok(f.c.view.expanded.has("e0"));
});
