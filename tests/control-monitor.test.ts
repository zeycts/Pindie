import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { MonitorControlError, type PindieControlMonitorPort, type MonitorSnapshot, type TimelineResult } from "../src/control-monitor-client.ts";
import { PindieControlMonitor, type PindieControlMonitorState, type PindieControlMonitorViewPort } from "../src/control-monitor.ts";
import { PindieControlMonitorView } from "../src/control-monitor-view.ts";

const snap = (revision: number, idle: boolean, gate: MonitorSnapshot["semantic"]["humanGate"] = null): MonitorSnapshot => ({
  lease: "lease-1", revision, session: { id: "session-1", displayIdentity: "Learning Loop" },
  runtime: { idle, pendingMessageCount: 0, automaticWorkSettled: idle },
  semantic: { taskStatus: "active", verificationStatus: "pending", verificationProgress: { covered: 1, total: 3 }, humanGate: gate },
  executionConfig: { model: { modelId: "gpt-test" }, thinkingLevel: "high" },
});
const timeline: TimelineResult = { sessionId: "session-1", revision: 1, hasMoreBefore: true, timeline: [{
  type: "runtime", id: "runtime-1", category: "generic", title: "visible runtime event", detail: "read-only", defaultDisplayMode: "preview",
}] };
class TestView implements PindieControlMonitorViewPort {
  readonly states: PindieControlMonitorState[] = []; started = false; stopped = false;
  start(): void { this.started = true; }
  apply(state: PindieControlMonitorState): void { this.states.push(state); }
  stop(): void { this.stopped = true; }
}
class FakeClient implements PindieControlMonitorPort {
  observations: Array<Awaited<ReturnType<PindieControlMonitorPort["observe"]>>> = [];
  timelineResults: TimelineResult[] = [];
  waits: Array<Awaited<ReturnType<PindieControlMonitorPort["wait"]>> | Error> = [];
  timelineError: Error | null = null; observeError: Error | null = null;
  waitRequests: unknown[] = []; timelineReads: number[] = []; closed = false; private pendingReject?: (error: Error) => void;
  async observe() { if (this.observeError) throw this.observeError; return this.observations.shift()!; }
  async readTimeline(limit = 50) { this.timelineReads.push(limit); if (this.timelineError) throw this.timelineError; return this.timelineResults.shift() ?? timeline; }
  async wait(request: Parameters<PindieControlMonitorPort["wait"]>[0]) {
    this.waitRequests.push(request);
    const next = this.waits.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return new Promise<Awaited<ReturnType<PindieControlMonitorPort["wait"]>>>((_, reject) => { this.pendingReject = reject; });
  }
  async close() { this.closed = true; this.pendingReject?.(new Error("closed")); }
}
const active = (control: MonitorSnapshot) => ({ state: "active_project" as const, activeProject: "Modeloom", control });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function cancellableSleep(calls: number[]) {
  return (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    calls.push(ms);
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("stopped")); };
    signal.addEventListener("abort", abort, { once: true });
    setImmediate(() => { signal.removeEventListener("abort", abort); resolve(); });
  });
}

test("monitor attaches, samples only while running, handles Gate without a wait busy loop, and stops read-only", async () => {
  const client = new FakeClient();
  client.observations.push(active(snap(1, false)));
  client.waits.push(
    { reason: "changed", snapshot: snap(2, false) },
    { reason: "timeout", snapshot: snap(2, false) },
    { reason: "timeout", snapshot: snap(2, true) },
    { reason: "human_gate", snapshot: snap(3, false, { kind: "approval", question: "Proceed?" }) },
  );
  client.observations.push(active(snap(3, false, { kind: "approval", question: "Proceed?" })));
  const view = new TestView(); const sleeps: number[] = [];
  const monitor = new PindieControlMonitor(view, { createClient: async () => client, sleep: cancellableSleep(sleeps) });
  void monitor.start();
  for (let i = 0; i < 10 && view.states.at(-1)?.message?.includes("HUMAN GATE") !== true; i++) await turn();
  await monitor.stop();
  assert.equal(view.started, true);
  assert.deepEqual(client.timelineReads, [50, 50, 50, 50]); // attach, change, running timeout, Gate; idle timeout is free
  assert.deepEqual(client.waitRequests.slice(0, 4).map((r) => [r.timeoutSeconds, r.afterRevision]), [[2, 1], [2, 2], [2, 2], [30, 2]]);
  assert.match(view.states.at(-1)!.message!, /read-only/);
  assert.equal(sleeps.includes(1_000), true);
  assert.equal(client.closed, true);
  assert.equal(view.stopped, true);
});

test("Human Gate resolution returns to event-driven waiting after one bounded observation", async () => {
  const client = new FakeClient();
  client.observations.push(active(snap(3, false, { kind: "decision", question: "Choose?" })), active(snap(4, true)));
  const view = new TestView(); const sleeps: number[] = [];
  const monitor = new PindieControlMonitor(view, { createClient: async () => client, sleep: cancellableSleep(sleeps) });
  void monitor.start();
  for (let i = 0; i < 20 && client.waitRequests.length === 0; i++) await turn();
  await monitor.stop();
  assert.deepEqual(client.timelineReads, [50, 50]);
  assert.equal(client.waitRequests.length, 1);
  assert.equal((client.waitRequests[0] as { timeoutSeconds: number }).timeoutSeconds, 30);
  assert.ok(sleeps.includes(1_000));
});

test("binding_changed reattaches a replacement project/session with a fresh lease", async () => {
  const client = new FakeClient();
  const first = { ...snap(2, true), lease: "old-lease" };
  const next = { ...snap(1, true), lease: "new-lease", session: { id: "session-2", displayIdentity: "New Session" } };
  client.observations.push(active(first), active(next));
  client.timelineResults.push(timeline, { ...timeline, sessionId: "session-2" });
  client.waits.push({ reason: "binding_changed", snapshot: null });
  const view = new TestView(); const monitor = new PindieControlMonitor(view, { createClient: async () => client });
  void monitor.start();
  for (let i = 0; i < 20 && client.waitRequests.length < 2; i++) await turn();
  await monitor.stop();
  assert.equal((client.waitRequests[0] as { lease: string }).lease, "old-lease");
  assert.equal((client.waitRequests[1] as { lease: string }).lease, "new-lease");
  assert.deepEqual(client.timelineReads, [50, 50]);
  assert.equal(view.states.at(-1)?.snapshot?.session.id, "session-2");
});

for (const replacement of ["project", "session"] as const) {
  test(`stale wait before registration reattaches replacement ${replacement} without reconnect`, async () => {
    const client = new FakeClient();
    const old = { ...snap(2, true), lease: "lease-A" };
    const next = { ...snap(1, true), lease: "lease-B", session: { id: "session-B", displayIdentity: "New" } };
    client.observations.push(active(old), replacement === "project" ? { ...active(next), activeProject: "Other" } : active(next));
    client.timelineResults.push(timeline, { ...timeline, sessionId: "session-B" });
    client.waits.push(new MonitorControlError("stale_control_lease", "Observe again"));
    const view = new TestView(); let connections = 0;
    const monitor = new PindieControlMonitor(view, { createClient: async () => { connections++; return client; } });
    void monitor.start();
    for (let i = 0; i < 30 && client.waitRequests.length < 2; i++) await turn();
    await monitor.stop();
    assert.equal(connections, 1);
    assert.deepEqual(client.waitRequests.slice(0, 2).map((r) => (r as { lease: string }).lease), ["lease-A", "lease-B"]);
    assert.equal(view.states.at(-1)?.snapshot?.session.id, "session-B");
    assert.equal(view.states.some((s) => s.connection === "incompatible"), false);
    assert.ok((view.states.at(-1)?.epoch ?? 0) > (view.states.find((s) => s.snapshot?.lease === "lease-A")?.epoch ?? 0));
  });
}

test("no_active_project from wait clears binding and enters bounded no-active observation", async () => {
  const client = new FakeClient(); client.observations.push(active(snap(1, true)), { state: "no_active_project", activeProject: null });
  client.waits.push(new MonitorControlError("no_active_project", "No project"));
  const view = new TestView(); const sleeps: number[] = []; let connections = 0;
  const monitor = new PindieControlMonitor(view, { createClient: async () => { connections++; return client; }, sleep: cancellableSleep(sleeps) });
  void monitor.start();
  for (let i = 0; i < 30 && view.states.filter((s) => s.connection === "waiting").length < 2; i++) await turn();
  await monitor.stop();
  assert.equal(connections, 1);
  assert.equal(view.states.filter((s) => s.connection === "waiting" && s.snapshot === null && s.timeline === null).length, 2);
  assert.equal(view.states.some((s) => s.connection === "incompatible"), false);
  assert.ok(sleeps.includes(1_000));
});

test("no_active_project during timeline read discards active epoch and waits for fresh observation", async () => {
  const client = new FakeClient(); client.observations.push(active(snap(1, true)), { state: "no_active_project", activeProject: null });
  client.timelineError = new MonitorControlError("no_active_project", "No project");
  const view = new TestView(); const sleeps: number[] = []; let connections = 0;
  const monitor = new PindieControlMonitor(view, { createClient: async () => { connections++; return client; }, sleep: cancellableSleep(sleeps) });
  void monitor.start();
  for (let i = 0; i < 30 && !view.states.some((s) => s.connection === "waiting" && s.project === null); i++) await turn();
  await monitor.stop();
  assert.equal(connections, 1);
  assert.ok(view.states.some((s) => s.connection === "waiting" && s.snapshot === null && s.timeline === null));
  assert.equal(view.states.some((s) => s.connection === "incompatible"), false);
  assert.ok(sleeps.includes(1_000));
});

test("monitor reconnects with bounded exponential backoff and fresh attach", async () => {
  const client = new FakeClient(); client.observations.push(active(snap(1, true)));
  const view = new TestView(); const sleeps: number[] = []; let attempts = 0;
  const monitor = new PindieControlMonitor(view, {
    createClient: async () => { attempts++; if (attempts < 3) throw new Error("connection refused"); return client; },
    sleep: cancellableSleep(sleeps),
  });
  void monitor.start();
  for (let i = 0; i < 20 && client.waitRequests.length === 0; i++) await turn();
  await monitor.stop();
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps.slice(0, 2), [250, 500]);
  assert.ok(view.states.some((state) => state.connection === "disconnected"));
  assert.equal(client.timelineReads[0], 50);
  assert.equal(client.closed, true);
});

test("reconnect backoff resets only after stable Control attach", async () => {
  const view = new TestView(); const sleeps: number[] = []; const clients: FakeClient[] = [];
  const monitor = new PindieControlMonitor(view, {
    createClient: async () => {
      const client = new FakeClient(); clients.push(client);
      client.observations.push(active(snap(1, true)));
      if (clients.length <= 5) {
        if (clients.length % 2) client.observeError = new Error("observe unavailable");
        else client.timelineError = new Error("timeline unavailable");
      } else if (clients.length === 6) client.waits.push(new Error("transport disconnected"));
      return client;
    },
    sleep: cancellableSleep(sleeps),
  });
  void monitor.start();
  for (let i = 0; i < 100 && clients.length < 7; i++) await turn();
  await monitor.stop();
  assert.equal(clients.length, 7);
  assert.deepEqual(sleeps.slice(0, 6), [250, 500, 1_000, 2_000, 5_000, 250]);
  assert.equal(clients[6]!.waitRequests.length, 1);
  assert.equal(view.states.some((s) => s.connection === "incompatible"), false);
});

test("monitor polls no-active workspace at one-second cadence and attaches when activated", async () => {
  const client = new FakeClient();
  client.observations.push({ state: "no_active_project", activeProject: null }, active(snap(1, true)));
  client.waits.push({ reason: "timeout", snapshot: snap(1, true) });
  const view = new TestView(); const sleeps: number[] = [];
  const monitor = new PindieControlMonitor(view, { createClient: async () => client, sleep: cancellableSleep(sleeps) });
  void monitor.start();
  for (let i = 0; i < 10 && client.waitRequests.length === 0; i++) await turn();
  await monitor.stop();
  assert.ok(view.states.some((s) => s.message?.includes("No active project")));
  assert.deepEqual(sleeps, [1_000]);
  assert.ok(client.waitRequests.length >= 1);
  assert.equal((client.waitRequests[0] as { timeoutSeconds: number }).timeoutSeconds, 30);
  assert.equal(client.timelineReads.length, 1);
});

class FakeTerminal implements Terminal {
  writes: string[] = []; columns = 70; rows = 8; started = false; private input?: (data: string) => void;
  get kittyProtocolActive() { return false; }
  start(onInput: (data: string) => void) { this.started = true; this.input = onInput; }
  stop() { this.started = false; }
  drainInput() { return Promise.resolve(); }
  write(data: string) { this.writes.push(data); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  emit(data: string) { this.input?.(data); }
}

test("monitor view renders canonical blocks, omitted history, gate read-only notice and local-only navigation/exit", async () => {
  const terminal = new FakeTerminal(); let exits = 0;
  const view = new PindieControlMonitorView({ terminal, onExit: () => { exits++; } });
  const blocks = Array.from({ length: 30 }, (_, i) => ({ type: "runtime" as const, id: `r${i}`, category: "generic" as const, title: `runtime-${i}`, defaultDisplayMode: "preview" as const }));
  const gated = snap(8, false, { kind: "approval", question: "Approve release?" });
  view.apply({ connection: "connected", project: "Modeloom", snapshot: gated, timeline: { ...timeline, timeline: blocks }, message: null });
  view.start(); await turn(); view.getScrollView().scrollToStart();
  const before = view.getScrollView().scrollTop;
  view.apply({ connection: "connected", project: "Modeloom", snapshot: { ...gated, revision: 9 }, timeline: { ...timeline, revision: 9, timeline: blocks }, message: null });
  await turn();
  assert.match(terminal.writes.join(""), /Pindie Monitor/);
  assert.match(terminal.writes.join(""), /Older timeline blocks omitted/);
  assert.match(terminal.writes.join(""), /HUMAN GATE/);
  assert.match(terminal.writes.join(""), /This monitor is read-only/);
  assert.equal(view.getScrollView().scrollTop, before);
  terminal.emit("G"); assert.equal(view.getScrollView().isFollowingEnd, true);
  view.apply({ connection: "connected", project: "Pindie", snapshot: snap(1, true), timeline: { ...timeline, timeline: blocks }, message: null, epoch: 2 });
  await turn(); assert.equal(view.getScrollView().isFollowingEnd, true);
  terminal.emit("\r"); assert.equal(exits, 0);
  terminal.emit("\u0003"); assert.equal(exits, 1);
  terminal.emit("q"); assert.equal(exits, 2);
  view.stop(); assert.equal(terminal.started, false);
});
