import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, TuiAltScreen, truncateToWidth, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { boundedGraphemeText } from "../src/bounded-text.ts";
import { WatchComponent } from "../src/watch-component.ts";
import { watchEventTitle, watchEventTone, watchPreviewTone } from "../src/watch-event-style.ts";
import { watchNativeComponents } from "../src/watch-native-presentation.ts";
import { watchText } from "../src/watch-view-model.ts";
import { formatBlock } from "../src/timeline-text.ts";
import { projectToolResult } from "../src/ui-timeline.ts";
import type { UiTimelineBlock } from "../src/ui-projection.ts";
import type { PindieControlMonitorState } from "../src/control-monitor.ts";

const plainTheme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;
const message = { type: "message", id: "message", source: "session", role: "user", text: "neutral body", lifecycle: "complete", defaultDisplayMode: "compact" } as const;
const work = { type: "work", id: "work", kind: "command", toolCallId: "work", toolName: "bash", title: "Command failed", lifecycle: "failed", input: { command: "echo neutral" }, result: projectToolResult({ content: [{ type: "text", text: "error detail" }] }, true, "bash"), defaultDisplayMode: "compact" } as const;
const task = { type: "semantic", id: "task", category: "task", lifecycle: "complete", defaultDisplayMode: "compact", action: "start", goal: "neutral goal", taskStatus: "active", blockers: [], questions: [], nextIntent: null, successCriterionCount: 3, handoff: null, error: null } as const;
const verification = { type: "semantic", id: "verify", category: "verification", lifecycle: "complete", defaultDisplayMode: "compact", verificationStatus: "passed", coveredCriteria: ["c1", "c2", "c3"], totalCriteria: 3, checks: [], pendingCheck: null, error: null } as const;
const completion = { type: "semantic", id: "done", category: "completion", lifecycle: "complete", defaultDisplayMode: "compact", summary: "neutral summary", verificationStatus: "passed", checks: [], error: null } as const;
const gate = { type: "semantic", id: "gate", category: "human-gate", lifecycle: "complete", defaultDisplayMode: "compact", gateKind: "approval", question: "neutral question", options: [], state: "open", error: null } as const;
const runtime = { type: "runtime", id: "runtime", category: "retry", title: "Command failed is historical", defaultDisplayMode: "compact" } as const;
const blocks: UiTimelineBlock[] = [message, { ...message, id: "assistant", role: "assistant" }, work, task, verification, completion, gate, runtime];
const state = (timeline: readonly UiTimelineBlock[]): PindieControlMonitorState => ({
  connection: "connected", project: "test", message: null,
  snapshot: { lease: "lease", revision: 1, session: { id: "session", displayIdentity: "test" }, runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: true }, semantic: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", verificationProgress: null, humanGate: null }, executionConfig: { model: null, thinkingLevel: "high" } },
  timeline: { sessionId: "session", revision: 1, hasMoreBefore: false, timeline },
});

// Obtain the active built-in theme through Pi's public custom UI callback, not private imports.
async function nativeTheme(name: string) {
  initTheme(name, false);
  const terminal = { columns: 80, rows: 30, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
  const tui = new TuiAltScreen(terminal);
  const editor = { getText: () => "local", setText() {}, render: () => ["local"], invalidate() {} };
  const editorContainer = new Container(); editorContainer.addChild(editor);
  const mode = Object.assign(Object.create(InteractiveMode.prototype), { ui: tui, editor, editorContainer });
  const theme = await mode.showExtensionCustom((_tui: unknown, theme: Theme, _keys: unknown, done: (value: Theme) => void) => {
    queueMicrotask(() => done(theme));
    return { render: () => [], invalidate() {} };
  });
  return { theme: theme as Theme, tui };
}

test("typed roles/lifecycles/semantic categories choose restrained tokens, not payload keywords", () => {
  assert.deepEqual(blocks.map(watchEventTone), ["accent", "accent", "error", "accent", "success", "success", "warning", "dim"]);
  for (const role of ["user", "assistant", "custom"] as const) {
    assert.equal(watchEventTone({ ...message, role, text: "FAILED ✓ Completed", lifecycle: "error" }), "error");
    assert.equal(watchEventTone({ ...message, role, text: "FAILED ✓ Completed" }), role === "custom" ? "muted" : "accent");
  }
  for (const lifecycle of ["running", "complete", "failed"] as const) {
    assert.equal(watchEventTone({ ...work, lifecycle, title: "arbitrary remote command" }), { running: "accent", complete: "success", failed: "error" }[lifecycle]);
    for (const block of [task, verification, completion, gate]) {
      if (lifecycle !== "complete") assert.equal(watchEventTone({ ...block, lifecycle }), lifecycle === "failed" ? "error" : "accent");
      assert.equal(watchEventTone({ ...block, error: "stale evidence ref" }), "error");
    }
  }
  assert.equal(watchEventTone({ ...task, taskStatus: "blocked" }), "warning");
  assert.equal(watchEventTone({ ...task, taskStatus: "waiting_human" }), "warning");
  assert.equal(watchEventTone({ ...gate, state: "resolved" }), "success");
  for (const verificationStatus of ["pending", "stale", "failed", "passed"] as const) {
    assert.equal(watchEventTone({ ...verification, verificationStatus }), { pending: "accent", stale: "warning", failed: "error", passed: "success" }[verificationStatus]);
  }
});

test("only structural prefixes get event color; selectedBg and bold marker identify exactly one row", () => {
  const colors: [string, string][] = [], backgrounds: string[] = [], bold: string[] = [];
  const theme = { fg(token: string, text: string) { colors.push([token, text]); return text; }, bg(token: string, text: string) { backgrounds.push(token); return text; }, bold(text: string) { bold.push(text); return text; } } as Theme;
  for (const block of blocks) {
    const title = formatBlock(block, "compact").split("\n")[0]!;
    const line = watchEventTitle(theme, block, title, false, block.id === "work");
    assert.equal(line, `${block.id === "work" ? ">" : " "}+${title}`);
  }
  assert.deepEqual(backgrounds, ["selectedBg"]);
  assert.equal(bold.filter((text) => text === ">").length, 1);
  assert.ok(colors.some(([token, text]) => token === "error" && text === "✕"));
  assert.ok(colors.some(([token, text]) => token === "success" && text === "✓ Verification · 3/3"));
  assert.ok(colors.some(([token, text]) => token === "success" && text === "✓ Completed"));
  assert.ok(colors.every(([, text]) => !text.includes("neutral") && !text.includes("Command failed")));
});

test("preview notices/details recede while failed work and typed diagnostics keep normal contrast", () => {
  assert.equal(watchPreviewTone(message), "text");
  assert.equal(watchPreviewTone({ ...work, lifecycle: "complete" }), "muted");
  assert.equal(watchPreviewTone(work), "text");
  assert.equal(watchPreviewTone(verification), "muted");
  assert.equal(watchPreviewTone({ ...verification, error: "stale evidence ref" }), "text");
  assert.equal(watchPreviewTone({ ...verification, checks: [{ name: "failure", status: "failed", covers: [], evidence: "detail" }] }), "text");
});

for (const name of ["dark", "light", "system"]) test(`actual Pi ${name} theme preserves sanitized geometry, markers and neutral bodies at narrow Unicode widths`, async () => {
  const { theme } = await nativeTheme(name);
  const unsafe = "\x1b[31m伪造\x1b[0m\x1b]8;;https://invalid\x07link\x1b]8;;\x07\u202e\u2066 👨‍👩‍👧‍👦 é " + "long ".repeat(100);
  const events: UiTimelineBlock[] = [...blocks, { ...message, id: "unsafe", text: unsafe }, { ...work, id: "unsafe-work", title: unsafe }];
  for (const width of [1, 2, 3, 8, 20, 80, 160]) {
    const color = new WatchComponent(theme, () => 100, () => {}, () => {});
    const plain = new WatchComponent(plainTheme, () => 100, () => {}, () => {});
    color.apply(state(events)); plain.apply(state(events));
    assert.deepEqual(color.render(width).map(watchText), plain.render(width).map(watchText));
    for (const block of events) {
      const title = watchText(boundedGraphemeText(watchText(formatBlock(block, "compact")), Math.max(1, width - 2), 240, 1)[0]!);
      const row = watchEventTitle(theme, block, title, false, true);
      assert.equal(watchText(row), `>+${title}`);
      assert.ok(visibleWidth(truncateToWidth(row, width)) <= width);
      assert.doesNotMatch(watchText(row), /[\x1b\u202e\u2066]/u);
    }
    color.handleInput("k"); plain.handleInput("k");
    color.handleInput("\r"); plain.handleInput("\r");
    assert.deepEqual(color.render(width).map(watchText), plain.render(width).map(watchText));
    assert.ok(color.render(width).every((line) => visibleWidth(line) <= width));
  }
  const plain = new WatchComponent(plainTheme, () => 100, () => {}, () => {});
  plain.apply(state(blocks));
  const rows = plain.render(120);
  assert.equal(rows.filter((line) => line.startsWith(">+")).length, 1);
  assert.ok(rows.some((line) => line.includes("✕ Command failed")));
  assert.ok(rows.some((line) => line.includes("✓ Verification · 3/3")));
  assert.ok(rows.some((line) => line.includes("✓ Completed")));
});

test("actual Pi native read/bash cards remain byte-identical, not wrapped in event styles", async () => {
  const { theme, tui } = await nativeTheme("dark");
  for (const toolName of ["read", "bash"] as const) {
    const block: UiTimelineBlock = { ...work, lifecycle: "complete", title: "operation", toolName, input: toolName === "read" ? { path: "/remote/example.ts" } : { command: "echo remote" }, result: projectToolResult({ content: [{ type: "text", text: "native unique output" }] }, false, toolName) };
    const c = new WatchComponent(theme, () => 100, () => {}, () => {}, tui);
    c.apply(state([block])); c.handleInput("\r");
    const lines = c.render(80);
    const notice = lines.findIndex((line) => watchText(line).includes("Native Pi ·"));
    assert.ok(notice >= 0);
    const native = watchNativeComponents(block, tui)!.flatMap((component) => component.render(80)).map((line) => truncateToWidth(line, 80));
    assert.deepEqual(lines.slice(notice + 1, notice + 1 + native.length), native);
  }
});

test("sticky warnings remain snapshot-driven and historical failures do not change live header truth", async () => {
  const { theme } = await nativeTheme("light");
  const c = new WatchComponent(theme, () => 50, () => {}, () => {});
  const disconnected = { ...state([work, completion]), connection: "disconnected" as const, message: "offline" };
  c.apply({ ...disconnected, snapshot: { ...disconnected.snapshot!, semantic: { ...disconnected.snapshot!.semantic, humanGate: { kind: "approval", question: "Review?" } } } });
  const lines = c.render(120).map(watchText);
  assert.ok(lines.some((line) => line.includes("Task unavailable (stale)")));
  assert.ok(lines.some((line) => line.includes("HUMAN GATE (last observed)")));
  assert.ok(lines.some((line) => line.includes("✕ Command failed")));
  c.apply(state([work, completion]));
  const fresh = c.render(120).map(watchText).join("\n");
  assert.match(fresh, /Task: active · Verify: pending/);
  assert.doesNotMatch(fresh, /HUMAN GATE|offline|stale/);
});
