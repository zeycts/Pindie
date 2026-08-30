import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteCompanion, type RemoteSessionPresentation, type RemoteStatusFacts, type RemoteSurface } from "../src/remote-companion.ts";
import { RemoteRoutingStore } from "../src/remote-routing.ts";
import { ExecutionAggregator, mirrorEntry, splitTimelineEvent } from "../src/session-mirror.ts";

class Surface implements RemoteSurface {
  projects = 0; sessions = 0; sent: string[] = []; titles: string[] = []; presentations: RemoteSessionPresentation[] = []; fail = false; replace = false; replaceChannel = false; unique = false; uniqueChannel = false;
  async ensureProject(id: string, _name: string, existing: string | null) { if (this.fail) throw new Error("offline"); this.projects++; return { channelId: this.replaceChannel ? "channel-replacement" : (existing ?? (this.uniqueChannel ? `channel-${id}` : "channel")), replaced: this.replaceChannel }; }
  async ensureSession(_channel: string, id: string, title: string) { if (this.fail) throw new Error("offline"); this.sessions++; this.titles.push(title); return { threadId: this.replace ? "replacement" : (this.unique ? `thread-${id}` : "thread"), anchorMessageId: "anchor", headerMessageId: "header", replaced: this.replace }; }
  async send(_thread: string, event: { text: string }) { if (this.fail) throw new Error("offline"); this.sent.push(event.text); }
  async updateSessionPresentation(_session: unknown, presentation: RemoteSessionPresentation) { if (this.fail) throw new Error("offline"); this.presentations.push(structuredClone(presentation)); }
}
const activeStatus = (overrides: Partial<RemoteStatusFacts> = {}): RemoteStatusFacts => ({ taskGoal: "Task", taskStatus: "active", activity: null, verificationStatus: "pending", elapsedMs: null, semanticAuthority: "coherent", localUiPrompt: false, ...overrides });
function ctx(idle = true) { const stops: string[] = []; return { ctx: { isIdle: () => idle, abort: () => stops.push("stop") } as any, stops }; }
async function fixture(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), "pindie-remote-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
let routingSequence = 0;
const isolatedRouting = () => new RemoteRoutingStore({ baseDir: join(tmpdir(), `pindie-remote-test-${process.pid}-${++routingSequence}`) });

test("routing is lazy, cursor based, and retries a failed delivery", async (t) => {
  const dir = await fixture(t); const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: dir }) });
  await remote.bind("/project", "guild", "session", ctx().ctx, { taskGoal: "Task title", status: activeStatus({ taskGoal: "Task title" }) }); await remote.catchUp([]);
  assert.equal(surface.sessions, 0);
  surface.fail = true;
  await assert.doesNotReject(remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }]));
  surface.fail = false; await remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }, { id: "a", message: { role: "assistant", content: "answer" } }]);
  assert.deepEqual(surface.sent, ["YOU\nhello", "answer"]); assert.equal(surface.titles[0], "hello");
  await remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }, { id: "a", message: { role: "assistant", content: "answer" } }, { id: "b", message: { role: "assistant", content: "later" } }]);
  assert.deepEqual(surface.sent, ["YOU\nhello", "answer", "later"]);
});

test("renaming keeps anchor/header presentation coherent without changing Session identity", async (t) => {
  const surface = new Surface();
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const remote = new RemoteCompanion(surface, { routing: store });
  await remote.bind("/rename", "guild", "session", ctx().ctx, { status: activeStatus() }); await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]); const before = await store.load("/rename"); await remote.rename("Renamed");
  assert.equal(surface.presentations.at(-1)?.title, "Renamed"); assert.equal(surface.presentations.at(-1)?.status.taskGoal, "Task"); assert.equal((await store.load("/rename"))?.sessions.session.threadId, before?.sessions.session.threadId);
});

test("Session title priority belongs to name and prompt before an active Task fallback", async (t) => {
  const surface = new Surface(); const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const named = new RemoteCompanion(surface, { routing: store });
  await named.bind("/project", "guild", "abcdef123", ctx().ctx, { sessionName: "Named", taskGoal: "Task" });
  await named.catchUp([{ id: "u", message: { role: "user", content: "Prompt title" } }]); assert.equal(surface.titles[0], "Named");
  const current = new RemoteCompanion(surface, { routing: store }); await current.bind("/current", "guild", "abcdef123", ctx().ctx, { taskGoal: "Old completed Task", status: activeStatus({ taskGoal: "Old completed Task", taskStatus: "done" }) }); await current.catchUp([{ id: "u", message: { role: "user", content: "Current prompt" } }]); assert.equal(surface.titles.at(-1), "Current prompt");
  const prompt = new RemoteCompanion(surface, { routing: store }); await prompt.bind("/prompt", "guild", "abcdef123", ctx().ctx); await prompt.catchUp([{ id: "u", message: { role: "user", content: "Prompt title\nrest" } }]); assert.equal(surface.titles.at(-1), "Prompt title");
  const task = new RemoteCompanion(surface, { routing: store }); await task.bind("/task", "guild", "abcdef123", ctx().ctx, { taskGoal: "Active Task", status: activeStatus({ taskGoal: "Active Task" }) }); await task.milestone("access", "ACCESS"); assert.equal(surface.titles.at(-1), "Active Task");
  const completed = new RemoteCompanion(surface, { routing: store }); await completed.bind("/completed", "guild", "abcdef123", ctx().ctx, { taskGoal: "Completed Task", status: activeStatus({ taskGoal: "Completed Task", taskStatus: "done" }) }); await completed.milestone("access", "ACCESS"); assert.equal(surface.titles.at(-1), "Session abcdef12");
  const fallback = new RemoteCompanion(surface, { routing: store }); await fallback.bind("/fallback", "guild", "abcdef123", ctx().ctx); await fallback.milestone("access", "ACCESS"); assert.equal(surface.titles.at(-1), "Session abcdef12");
});

test("fully mirrored resume reconciles presentation without changing cursor or thread", async (t) => {
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const initialSurface = new Surface(); initialSurface.unique = true;
  const initial = new RemoteCompanion(initialSurface, { routing: store });
  const entries = [{ id: "u", message: { role: "user" as const, content: "Original prompt" } }];
  await initial.bind("/resume", "guild", "session", ctx().ctx); await initial.catchUp(entries);
  const before = await store.load("/resume");
  const resumedSurface = new Surface(); resumedSurface.unique = true;
  const resumed = new RemoteCompanion(resumedSurface, { routing: store });
  await resumed.bind("/resume", "guild", "session", ctx().ctx, { sessionName: "Resumed Name", status: activeStatus({ activity: "idle" }) });
  await resumed.catchUp(entries);
  const after = await store.load("/resume");
  assert.equal(resumedSurface.sessions, 1); assert.equal(resumedSurface.presentations.at(-1)?.title, "Resumed Name");
  assert.equal(after?.sessions.session.threadId, before?.sessions.session.threadId);
  assert.equal(after?.sessions.session.lastMirroredEntryId, "u");
  assert.deepEqual(resumedSurface.sent, []);
});

test("catch-up and live projection are serialized in entry order", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); await remote.bind("/order", "guild", "session", ctx().ctx);
  await Promise.all([remote.catchUp([{ id: "one", message: { role: "user", content: "one" } }]), remote.project({ id: "two", message: { role: "assistant", content: "two" } })]);
  assert.deepEqual(surface.sent, ["YOU\none", "two"]);
});

test("Pi input provenance handles identical TUI and remote text without text matching", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); const busy = ctx(false);
  await remote.bind("/project", "guild", "session", busy.ctx); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }]);
  remote.observeInput("interactive");
  await remote.input("thread", "same", { sendUserMessage: () => remote.observeInput("extension", "steer") });
  await remote.input("thread", "!after same", { sendUserMessage: () => remote.observeInput("extension", "followUp") });
  await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }, { id: "one", message: { role: "user", content: "same" } }, { id: "two", message: { role: "user", content: "same" } }, { id: "three", message: { role: "user", content: "same" } }]);
  assert.deepEqual(surface.sent.slice(-3), ["YOU · TUI\nsame", "YOU · DISCORD · STEER\nsame", "YOU · DISCORD · FOLLOW-UP\nsame"]);
});

test("Discord-origin projection may be a successful no-op while its M1 cursor still advances", async (t) => {
  const delivered: string[] = [];
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }),
    send: async (_thread, event) => { if (event.origin !== "discord") delivered.push(event.text); },
    updateSessionPresentation: async () => undefined,
  };
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const remote = new RemoteCompanion(surface, { routing: store });
  await remote.bind("/discord-no-duplicate", "guild", "session", ctx().ctx);
  await remote.catchUp([{ id: "seed", message: { role: "user", content: "tui" } }]);
  await remote.input("thread", "remote", { sendUserMessage: () => remote.observeInput("extension") });
  await remote.catchUp([{ id: "seed", message: { role: "user", content: "tui" } }, { id: "discord", message: { role: "user", content: "remote" } }]);
  assert.deepEqual(delivered, ["YOU\ntui"]);
  assert.equal((await store.load("/discord-no-duplicate"))?.sessions.session.lastMirroredEntryId, "discord");
});

test("active controls use Pi native modes and historical threads cannot control", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); const active = ctx(false); const calls: unknown[] = [];
  await remote.bind("/project", "guild", "session", active.ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "start" } }]);
  assert.equal(await remote.input("old", "no", { sendUserMessage: () => undefined }), "historical");
  await remote.status(activeStatus({ activity: "editing", elapsedMs: 1_250 }));
  const presentationsBeforeStatus = surface.presentations.length;
  assert.equal(await remote.input("thread", "!status", { sendUserMessage: () => assert.fail("status must be read-only") }), "status");
  assert.equal(surface.presentations.length, presentationsBeforeStatus + 1);
  assert.deepEqual(surface.presentations.at(-1)?.status, activeStatus({ activity: "editing", elapsedMs: 1_250 }));
  await remote.input("thread", "go", { sendUserMessage: (_text, options) => calls.push(options) });
  await remote.input("thread", "!after later", { sendUserMessage: (_text, options) => calls.push(options) });
  assert.deepEqual(calls, [{ deliverAs: "steer" }, { deliverAs: "followUp" }]);
  assert.equal(await remote.input("thread", "!stop", { sendUserMessage: () => undefined }), "stopped"); assert.deepEqual(active.stops, ["stop"]);
});

test("every transport and routing failure is contained and later work can retry", async (t) => {
  const surface = new Surface();
  const failingRouting = {
    load: async () => { throw new Error("routing offline"); },
    save: async () => { throw new Error("routing offline"); },
    projectName: () => "project",
  } as unknown as RemoteRoutingStore;
  const failedBind = new RemoteCompanion(surface, { routing: failingRouting });
  await assert.doesNotReject(failedBind.bind("/project", "guild", "session", ctx().ctx));
  assert.equal(failedBind.activeSessionId, null);

  const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) });
  await remote.bind("/project", "guild", "session", ctx().ctx, { status: activeStatus() });
  surface.fail = true;
  await assert.doesNotReject(remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }]));
  await assert.doesNotReject(remote.milestone("blocked", "TASK BLOCKED"));
  await assert.doesNotReject(remote.status(activeStatus({ taskStatus: "done" })));
  await assert.doesNotReject(remote.rename("Still coherent"));
  await assert.doesNotReject(remote.settleCompletion());
  await assert.doesNotReject(remote.input("thread", "hello", { sendUserMessage: async () => { throw new Error("Pi unavailable"); } }));
  surface.fail = false;
  await remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }]);
  await remote.settleCompletion();
  assert.ok(surface.sent.includes("YOU\nhello"));
  assert.ok(surface.sent.includes("TASK COMPLETED"));
});

test("constructing a disabled Remote core performs no external work", () => {
  const surface = new Surface(); new RemoteCompanion(surface); assert.equal(surface.projects, 0); assert.equal(surface.sessions, 0); assert.deepEqual(surface.sent, []);
});

test("routing persistence is external-ID-only and atomic across reload", async (t) => {
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: store });
  await remote.bind("/persist", "guild", "session", ctx().ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "prompt" } }]);
  assert.deepEqual(await store.load("/persist"), { version: 1, guildId: "guild", channelId: "channel", sessions: { session: { threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header", lastMirroredEntryId: "u" } } });
});

test("deleted project channels discard child mappings and rebuild from Pi history", async (t) => {
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: store });
  await remote.bind("/project", "guild", "session", ctx().ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]);
  surface.replaceChannel = true; await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }, { id: "a", message: { role: "assistant", content: "two" } }]);
  assert.equal((await store.load("/project"))?.channelId, "channel-replacement"); assert.ok(surface.sent.includes("two"));
});

test("same-basename projects and resumed/new Sessions retain identity mappings", async (t) => {
  const dir = await fixture(t); const store = new RemoteRoutingStore({ baseDir: dir }); const surface = new Surface(); surface.unique = true; surface.uniqueChannel = true;
  const first = new RemoteCompanion(surface, { routing: store }); await first.bind("/one/app", "guild", "one", ctx().ctx); await first.catchUp([{ id: "a", message: { role: "user", content: "one" } }]);
  const resumed = new RemoteCompanion(surface, { routing: store }); await resumed.bind("/one/app", "guild", "one", ctx().ctx); await resumed.catchUp([{ id: "a", message: { role: "user", content: "one" } }]);
  await resumed.bind("/one/app", "guild", "two", ctx().ctx); await resumed.catchUp([{ id: "b", message: { role: "user", content: "two" } }]);
  const other = new RemoteCompanion(surface, { routing: store }); await other.bind("/two/app", "guild", "one", ctx().ctx); await other.catchUp([{ id: "c", message: { role: "user", content: "other" } }]);
  assert.equal((await store.load("/one/app"))?.sessions.one.threadId, "thread-one");
  assert.ok((await store.load("/one/app"))?.sessions.two); assert.notEqual(store.path("/one/app"), store.path("/two/app")); assert.notEqual((await store.load("/one/app"))?.channelId, (await store.load("/two/app"))?.channelId);
});

test("long timeline messages split in content order", () => {
  const text = `${"a".repeat(1_899)} b`; const parts = splitTimelineEvent({ entryId: "id", kind: "assistant", text }, 1_900);
  assert.equal(parts.map((part) => part.text).join(""), text);
});

test("unrelated extension input is neutral rather than guessed as Remote", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); await remote.bind("/neutral", "guild", "session", ctx().ctx); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }]);
  remote.observeInput("extension", "steer"); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }, { id: "u", message: { role: "user", content: "same" } }]);
  assert.equal(surface.sent.at(-1), "YOU\nsame");
});

test("execution lifecycle retains start arguments until the matching end", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); await remote.bind("/execution", "guild", "session", ctx().ctx);
  await remote.milestone("access", "ACCESS"); remote.recordToolStart("call", "bash", { command: "pnpm run check" }); remote.recordToolEnd("call", "bash"); await remote.flushExecution("end");
  assert.equal(surface.sent.at(-1), "EXECUTION\nbash ×1\nbash · pnpm run check ✓");
});

test("execution telemetry is aggregated and bounded", () => {
  const execution = new ExecutionAggregator(); execution.record("read"); execution.record("read"); execution.record("bash", { command: "pnpm run check" });
  assert.deepEqual(execution.flush("end"), { entryId: "end", kind: "execution", text: "EXECUTION\nread ×2\nbash ×1\nbash · pnpm run check ✓" }); assert.equal(execution.flush("end"), null);
});

test("SessionMirror filters hidden reasoning, tool results, continuation metadata, and aborted output", () => {
  assert.equal(mirrorEntry({ id: "thinking", message: { role: "assistant", content: [{ type: "thinking", text: "secret" }] } }), null);
  assert.equal(mirrorEntry({ id: "tool", message: { role: "toolResult", content: "raw" } }), null);
  assert.equal(mirrorEntry({ id: "aborted", message: { role: "assistant", content: "partial", stopReason: "aborted" } }), null);
  assert.deepEqual(mirrorEntry({ id: "visible", message: { role: "assistant", content: "answer" } }), { entryId: "visible", kind: "assistant", text: "answer" });
});

test("historical status exposes only routing metadata while ordinary input stays read-only", async (t) => {
  const surface = new Surface(); surface.unique = true; const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) }); await remote.bind("/history", "guild", "old", ctx().ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "old" } }]);
  await remote.bind("/history", "guild", "active", ctx().ctx, { status: activeStatus({ taskGoal: "ACTIVE SECRET", activity: "editing" }) }); await remote.catchUp([{ id: "v", message: { role: "user", content: "active" } }]);
  const presentationCount = surface.presentations.length;
  assert.equal(await remote.input("thread-old", "!status", { sendUserMessage: () => assert.fail("status must be read-only") }), "status");
  assert.equal(surface.presentations.length, presentationCount);
  assert.match(surface.sent.at(-1) ?? "", /HISTORICAL SESSION.*Session ID · old.*Thread ID · thread-old.*Read-only/s);
  assert.doesNotMatch(surface.sent.at(-1) ?? "", /ACTIVE SECRET|editing|Task status|activity/i);
  assert.equal(await remote.input("thread-old", "switch",  { sendUserMessage: () => assert.fail("must not switch") }), "historical");
  assert.equal(surface.sent.at(-1), "This Session is read-only. Resume it from the local TUI first.");
});

test("idle remote input is a normal Pi user message", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); const calls: unknown[] = [];
  await remote.bind("/idle", "guild", "session", ctx(true).ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "start" } }]);
  await remote.input("thread", "continue", { sendUserMessage: (_text, options) => calls.push(options) }); assert.deepEqual(calls, [undefined]);
});

test("local UI rejects ordinary input but permits stop, and stale bindings are inert", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); const first = ctx(false); const second = ctx(true);
  await remote.bind("/project", "guild", "one", first.ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]);
  remote.setLocalUiPrompt(true); assert.equal(await remote.input("thread", "no", { sendUserMessage: () => assert.fail("must not send") }), "local-ui");
  assert.equal(await remote.input("thread", "!status", { sendUserMessage: () => assert.fail("status must be read-only") }), "status");
  assert.equal(await remote.input("thread", "!stop", { sendUserMessage: () => undefined }), "stopped");
  await remote.bind("/project", "guild", "two", second.ctx); remote.shutdown(first.ctx);
  assert.equal(remote.activeSessionId, "two");
  remote.setLocalUiPrompt(true); remote.shutdown(second.ctx); await remote.bind("/project", "guild", "three", ctx(true).ctx); assert.equal(remote.activeSessionId, "three");
});

test("blocked and unavailable milestones deduplicate by their runtime fingerprint", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); await remote.bind("/milestones", "guild", "session", ctx().ctx);
  await remote.milestone("blocked:one", "TASK BLOCKED\none"); await remote.milestone("blocked:one", "TASK BLOCKED\none"); await remote.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE"); await remote.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
  assert.deepEqual(surface.sent, ["TASK BLOCKED\none", "PINDIE AUTHORITY UNAVAILABLE"]);
});

test("Human Gate deduplication commits only after successful delivery", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() });
  await remote.bind("/gate", "guild", "session", ctx().ctx);
  const key = "gate:Choose\0A\0B";
  const event = remote.humanGate("Choose", ["A", "B"]);
  surface.fail = true;
  await remote.milestone(key, event.text);
  surface.fail = false;
  const retry = remote.humanGate("Choose", ["A", "B"]);
  await remote.milestone(key, retry.text);
  await remote.milestone(key, retry.text);
  assert.equal(surface.sent.filter((text) => text === "HUMAN GATE\nChoose\nA · B").length, 1);
});

test("session replacement stops an in-flight old binding before stale Session projection", async (t) => {
  const paused = deferred(); const entered = deferred();
  const ensuredProjects: string[] = []; const ensuredSessions: string[] = []; const sentThreads: string[] = []; const presentedSessions: string[] = [];
  let pauseFirstProject = true;
  const surface: RemoteSurface = {
    ensureProject: async (_projectId, _name, _existing, signal) => {
      if (pauseFirstProject) { pauseFirstProject = false; entered.resolve(); await paused.promise; }
      if (signal.aborted) throw new Error("stale binding");
      ensuredProjects.push("project");
      return { channelId: "channel" };
    },
    ensureSession: async (_channel, sessionId) => { ensuredSessions.push(sessionId); return { threadId: `thread-${sessionId}`, anchorMessageId: `anchor-${sessionId}`, headerMessageId: `header-${sessionId}` }; },
    send: async (threadId) => { sentThreads.push(threadId); },
    updateSessionPresentation: async (_routing, presentation) => { presentedSessions.push(presentation.sessionId); },
  };
  const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) });
  await remote.bind("/race", "guild", "A", ctx().ctx);
  const stale = remote.catchUp([{ id: "a", message: { role: "user", content: "from A" } }]);
  await entered.promise;
  await remote.bind("/race", "guild", "B", ctx().ctx);
  paused.resolve();
  await stale;
  assert.deepEqual(ensuredProjects, []);
  assert.deepEqual(ensuredSessions, []);
  assert.deepEqual(sentThreads, []);
  assert.deepEqual(presentedSessions, []);

  await remote.catchUp([{ id: "b", message: { role: "user", content: "from B" } }]);
  assert.deepEqual(ensuredProjects, ["project"]);
  assert.deepEqual(ensuredSessions, ["B"]);
  assert.deepEqual(sentThreads, ["thread-B"]);
  assert.deepEqual(presentedSessions, ["B"]);
});

test("completion is transition-driven, settled once, and resumed completion is not replayed", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: isolatedRouting() }); await remote.bind("/complete", "guild", "session", ctx().ctx, { status: activeStatus() });
  await remote.status(activeStatus({ taskStatus: "done", verificationStatus: "passed" }));
  assert.deepEqual(surface.sent, []);
  await remote.settleCompletion(); await remote.settleCompletion();
  assert.deepEqual(surface.sent, ["TASK COMPLETED"]);

  const resumedSurface = new Surface(); const resumed = new RemoteCompanion(resumedSurface, { routing: isolatedRouting() });
  await resumed.bind("/resumed", "guild", "session", ctx().ctx, { status: activeStatus({ taskStatus: "done", verificationStatus: "passed" }) });
  await resumed.settleCompletion();
  assert.deepEqual(resumedSurface.sent, []);
});

test("milestones deduplicate and stale threads reset cursor", async (t) => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) }); await remote.bind("/project", "guild", "session", ctx().ctx);
  surface.fail = true; await assert.doesNotReject(remote.milestone("gate", "HUMAN GATE")); surface.fail = false;
  await remote.milestone("gate", "HUMAN GATE"); await remote.milestone("gate", "HUMAN GATE"); assert.equal(surface.sent.filter((text) => text === "HUMAN GATE").length, 1);
  await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]); surface.replace = true;
  await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }, { id: "v", message: { role: "assistant", content: "two" } }]);
  assert.ok(surface.sent.includes("two"));
});
