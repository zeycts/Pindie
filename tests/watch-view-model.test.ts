import assert from "node:assert/strict";
import test from "node:test";
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
  assert.match(header, /Task: active.*Verify: stale 1\/3.*idle · automatic work unsettled/);
  assert.doesNotMatch(header, /done|RAW PROMPT/);
  assert.match(header, /12345678/); assert.match(header, /remote-model/);
  assert.equal(vm.blocks.length, 50); assert.equal(vm.blocks[0]!.id, "e10");
  assert.equal(vm.expanded.size, 0);
  for (const authority of [undefined, "stale", "unavailable", "presentation-unavailable"] as const) {
    vm.apply({ ...state, snapshot: { ...state.snapshot!, semantic: { ...state.snapshot!.semantic, authority } } });
    assert.match(vm.header().join("\n"), /Task: unknown · Verify: unknown \?\/\?/);
  }
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
    assert.match(vm.header().join("\n"), /Task: unknown.*Verify: unknown.*unknown/);
    assert.doesNotMatch(vm.header().join("\n"), /remote-model/);
  }
  vm.apply({ ...gated, connection: "connecting", message: null });
  assert.match(vm.alerts().join("\n"), /Last connection error: connection error/);
  vm.apply(state); assert.equal(vm.alerts().length, 0);
  vm.apply({ ...state, connection: "waiting", snapshot: null, timeline: null });
  assert.match(vm.header().join("\n"), /Session: unknown/);
  assert.equal(watchText("a\x1b[2J\x07\u202eb\ntext"), "a[2Jb text");
});
