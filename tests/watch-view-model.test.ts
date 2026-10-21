import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WatchViewModel, watchText } from "../src/watch-view-model.ts";
import type { PindieControlMonitorState } from "../src/control-monitor.ts";

const state: PindieControlMonitorState = {
  connection: "connected", project: "remote", message: null, epoch: 1,
  snapshot: { lease: "lease", revision: 1, session: { id: "12345678-remote", displayIdentity: "RAW PROMPT MUST NOT BE A TITLE" },
    runtime: { idle: true, pendingMessageCount: 0, automaticWorkSettled: false },
    semantic: { authority: "coherent", taskStatus: "active", verificationStatus: "stale", verificationProgress: { covered: 1, total: 3 }, humanGate: null },
    executionConfig: { model: { modelId: "remote-model" }, thinkingLevel: "high" } },
  timeline: { sessionId: "12345678-remote", revision: 1, hasMoreBefore: true, timeline: Array.from({ length: 60 }, (_, i) => ({
    type: "runtime", id: `e${i}`, category: "generic", title: `event ${i}`, detail: "data", defaultDisplayMode: "full",
  })) },
};

test("facts-only status: separate Task, verification coverage, unsettled idle, model and safe Session identity", () => {
  const vm = new WatchViewModel(); vm.apply(state);
  const header = vm.header().join("\n");
  assert.match(header, /Task: active.*Verify: stale 1\/3/);
  assert.match(header, /Runtime: idle · automatic work unsettled/);
  assert.doesNotMatch(header, /done|RAW PROMPT/);
  assert.match(header, /12345678/); assert.match(header, /remote-model/);
  assert.equal(vm.blocks.length, 50); assert.equal(vm.blocks[0]!.id, "e10");
  assert.equal(vm.expanded.size, 0);
  for (const authority of [undefined, "stale", "unavailable", "presentation-unavailable"] as const) {
    vm.apply({ ...state, snapshot: { ...state.snapshot!, semantic: { ...state.snapshot!.semantic, authority } } });
    assert.match(vm.header().join("\n"), /Task unavailable \(stale\) · Verify unavailable \(stale\)/);
    assert.doesNotMatch(vm.header().join("\n"), /\?\/\?|Task: done/);
  }
});

test("coherent goals are bounded safe titles; runtime never supplies Task truth; absent names use only short ID", () => {
  const vm = new WatchViewModel();
  const unsafe = "\x1b[31m标题\x1b[0m\n\t\u202e\u2066\u200f\x07" + "👨‍👩‍👧‍👦".repeat(100);
  const snapshot = { ...state.snapshot!, semantic: { ...state.snapshot!.semantic, taskGoal: unsafe, taskStatus: "done", verificationStatus: "passed" } };
  vm.apply({ ...state, project: unsafe, snapshot });
  const header = vm.header(160).join("\n");
  assert.match(header, /Task: done · Verify: passed 1\/3 · 标题/);
  assert.match(header, /Remote Session: 12345678/);
  assert.doesNotMatch(header, /RAW PROMPT|\x1b|\u202e|\u2066|\u200f|\x07|\?\/\?/);
  for (const width of [1, 2, 8, 24, 40, 80]) {
    const lines = vm.header(width);
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  for (const [runtime, expected] of [
    [{ idle: false, pendingMessageCount: 0, automaticWorkSettled: false }, "running"],
    [{ idle: true, pendingMessageCount: 1, automaticWorkSettled: false }, "pending"],
    [{ idle: true, pendingMessageCount: 0, automaticWorkSettled: true }, "settled"],
  ] as const) {
    vm.apply({ ...state, snapshot: { ...snapshot, runtime, semantic: { ...snapshot.semantic, authority: "stale", taskGoal: "DO NOT SHOW" } } });
    const text = vm.header().join("\n");
    assert.match(text, new RegExp(`Runtime: ${expected}`));
    assert.match(text, /Task unavailable \(stale\)/);
    assert.doesNotMatch(text, /Task: done|DO NOT SHOW|\?\/\?/);
  }
  vm.apply({ ...state, snapshot: { ...snapshot, semantic: { ...snapshot.semantic, taskGoal: undefined, verificationProgress: null } } });
  assert.match(vm.header().join("\n"), /Task: done · Verify: passed/);
  assert.doesNotMatch(vm.header().join("\n"), /\?\/\?|undefined|标题/);
});

test("selection/expansion by ID survive refresh and reconnect epoch; bounded eviction and Session reset", () => {
  const vm = new WatchViewModel(); vm.apply(state);
  vm.navigate(-2); vm.toggle(); vm.anchor = { id: "e44", offset: 2 };
  assert.equal(vm.selected, "e57");
  vm.apply({ ...state, epoch: 9 });
  assert.equal(vm.selected, "e57"); assert.ok(vm.expanded.has("e57"));
  assert.deepEqual(vm.anchor, { id: "e44", offset: 2 }); assert.equal(vm.live, false);
  vm.toggle(); assert.equal(vm.expanded.size, 0);
  vm.navigate(-1000); assert.equal(vm.selected, "e10");
  vm.navigate(1000); assert.equal(vm.selected, "e59");
  vm.follow(); assert.equal(vm.live, true);
  vm.toggle(); vm.apply({ ...state, timeline: { ...state.timeline!, timeline: [] } });
  assert.equal(vm.expanded.size, 0); assert.equal(vm.selected, null);
  vm.apply(state); vm.navigate(-1); vm.toggle();
  vm.apply({ ...state, snapshot: { ...state.snapshot!, session: { id: "new-session", displayIdentity: "private" } } });
  assert.equal(vm.blocks.length, 0); assert.equal(vm.selected, null); assert.equal(vm.anchor, null);
  assert.equal(vm.expanded.size, 0); assert.equal(vm.live, true);
  assert.match(vm.alerts().join("\n"), /mismatch/);
});

test("Gate/error remain sticky through disconnect/retry; stale metadata is explicitly unknown", () => {
  const vm = new WatchViewModel();
  const gated = { ...state, snapshot: { ...state.snapshot!, semantic: { ...state.snapshot!.semantic, humanGate: { kind: "approval" as const, question: "Deploy?" } } } };
  vm.apply(gated);
  for (const connection of ["disconnected", "connecting", "incompatible"] as const) {
    vm.apply({ ...gated, connection, message: "connection error" });
    assert.match(vm.alerts().join("\n"), /HUMAN GATE \(last observed\).*Deploy\?/);
    assert.match(vm.alerts().join("\n"), /connection error/);
    assert.match(vm.header().join("\n"), /Task unavailable \(stale\).*Verify unavailable \(stale\)/);
    assert.match(vm.header().join("\n"), /Runtime: unavailable/);
    assert.doesNotMatch(vm.header().join("\n"), /remote-model/);
  }
  vm.apply({ ...gated, connection: "connecting", message: null });
  assert.match(vm.alerts().join("\n"), /Last connection error: connection error/);
  vm.apply(state); assert.equal(vm.alerts().length, 0);
  vm.apply({ ...state, connection: "waiting", snapshot: null, timeline: null });
  assert.match(vm.header().join("\n"), /Session: unavail/);
  assert.equal(watchText("a\x1b[2J\x07\u202eb\ntext"), "ab text");
});
