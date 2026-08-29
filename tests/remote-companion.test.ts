import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteCompanion, type RemoteSurface } from "../src/remote-companion.ts";
import { RemoteRoutingStore } from "../src/remote-routing.ts";
import { ExecutionAggregator, mirrorEntry, splitTimelineEvent } from "../src/session-mirror.ts";

class Surface implements RemoteSurface {
  projects = 0; sessions = 0; sent: string[] = []; titles: string[] = []; fail = false; replace = false; replaceChannel = false; unique = false; uniqueChannel = false;
  async ensureProject(id: string, _name: string, existing: string | null) { this.projects++; return { channelId: this.replaceChannel ? "channel-replacement" : (existing ?? (this.uniqueChannel ? `channel-${id}` : "channel")), replaced: this.replaceChannel }; }
  async ensureSession(_channel: string, id: string, title: string) { this.sessions++; this.titles.push(title); return { threadId: this.replace ? "replacement" : (this.unique ? `thread-${id}` : "thread"), anchorMessageId: "anchor", headerMessageId: "header", replaced: this.replace }; }
  async send(_thread: string, event: { text: string }) { if (this.fail) throw new Error("offline"); this.sent.push(event.text); }
}
function ctx(idle = true) { const stops: string[] = []; return { ctx: { isIdle: () => idle, abort: () => stops.push("stop") } as any, stops }; }
async function fixture(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), "pindie-remote-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("routing is lazy, cursor based, and retries a failed delivery", async (t) => {
  const dir = await fixture(t); const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: dir }) });
  await remote.bind("/project", "guild", "session", ctx().ctx, { taskGoal: "Task title" }); await remote.catchUp([]);
  assert.equal(surface.sessions, 0);
  surface.fail = true;
  await assert.rejects(remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }]));
  surface.fail = false; await remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }, { id: "a", message: { role: "assistant", content: "answer" } }]);
  assert.deepEqual(surface.sent, ["YOU\nhello", "answer"]); assert.equal(surface.titles[0], "Task title");
  await remote.catchUp([{ id: "u", message: { role: "user", content: "hello" } }, { id: "a", message: { role: "assistant", content: "answer" } }, { id: "b", message: { role: "assistant", content: "later" } }]);
  assert.deepEqual(surface.sent, ["YOU\nhello", "answer", "later"]);
});

test("renaming updates presentation without changing Session routing identity", async (t) => {
  const renamed: string[] = []; const surface = new Surface(); surface.renameSession = async (_thread: string, title: string) => renamed.push(title);
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const remote = new RemoteCompanion(surface, { routing: store });
  await remote.bind("/rename", "guild", "session", ctx().ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]); const before = await store.load("/rename"); await remote.rename("Renamed");
  assert.deepEqual(renamed, ["Renamed"]); assert.equal((await store.load("/rename"))?.sessions.session.threadId, before?.sessions.session.threadId);
});

test("Session title priority is name, then task, then first prompt, then short id", async (t) => {
  const surface = new Surface(); const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const named = new RemoteCompanion(surface, { routing: store });
  await named.bind("/project", "guild", "abcdef123", ctx().ctx, { sessionName: "Named", taskGoal: "Task" });
  await named.catchUp([{ id: "u", message: { role: "user", content: "Prompt title" } }]); assert.equal(surface.titles[0], "Named");
  const task = new RemoteCompanion(surface, { routing: store }); await task.bind("/task", "guild", "abcdef123", ctx().ctx, { taskGoal: "Task" }); await task.catchUp([{ id: "u", message: { role: "user", content: "Prompt" } }]); assert.equal(surface.titles.at(-1), "Task");
  const prompt = new RemoteCompanion(surface, { routing: store }); await prompt.bind("/prompt", "guild", "abcdef123", ctx().ctx); await prompt.catchUp([{ id: "u", message: { role: "user", content: "Prompt title\nrest" } }]); assert.equal(surface.titles.at(-1), "Prompt title");
  const fallback = new RemoteCompanion(surface, { routing: store }); await fallback.bind("/fallback", "guild", "abcdef123", ctx().ctx); await fallback.milestone("access", "ACCESS"); assert.equal(surface.titles.at(-1), "Session abcdef12");
});

test("catch-up and live projection are serialized in entry order", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); await remote.bind("/order", "guild", "session", ctx().ctx);
  await Promise.all([remote.catchUp([{ id: "one", message: { role: "user", content: "one" } }]), remote.project({ id: "two", message: { role: "assistant", content: "two" } })]);
  assert.deepEqual(surface.sent, ["YOU\none", "two"]);
});

test("Pi input provenance handles identical TUI and remote text without text matching", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); const busy = ctx(false);
  await remote.bind("/project", "guild", "session", busy.ctx); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }]);
  remote.observeInput("interactive");
  await remote.input("thread", "same", { sendUserMessage: () => remote.observeInput("extension", "steer") });
  await remote.input("thread", "!after same", { sendUserMessage: () => remote.observeInput("extension", "followUp") });
  await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }, { id: "one", message: { role: "user", content: "same" } }, { id: "two", message: { role: "user", content: "same" } }, { id: "three", message: { role: "user", content: "same" } }]);
  assert.deepEqual(surface.sent.slice(-3), ["YOU · TUI\nsame", "YOU · DISCORD · STEER\nsame", "YOU · DISCORD · FOLLOW-UP\nsame"]);
});

test("active controls use Pi native modes and historical threads cannot control", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); const active = ctx(false); const calls: unknown[] = [];
  await remote.bind("/project", "guild", "session", active.ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "start" } }]);
  assert.equal(await remote.input("old", "no", { sendUserMessage: () => undefined }), "historical");
  assert.equal(await remote.input("thread", "!status", { sendUserMessage: () => assert.fail("status must be read-only") }), "status");
  await remote.input("thread", "go", { sendUserMessage: (_text, options) => calls.push(options) });
  await remote.input("thread", "!after later", { sendUserMessage: (_text, options) => calls.push(options) });
  assert.deepEqual(calls, [{ deliverAs: "steer" }, { deliverAs: "followUp" }]);
  assert.equal(await remote.input("thread", "!stop", { sendUserMessage: () => undefined }), "stopped"); assert.deepEqual(active.stops, ["stop"]);
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
  const surface = new Surface(); const remote = new RemoteCompanion(surface); await remote.bind("/neutral", "guild", "session", ctx().ctx); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }]);
  remote.observeInput("extension", "steer"); await remote.catchUp([{ id: "seed", message: { role: "user", content: "seed" } }, { id: "u", message: { role: "user", content: "same" } }]);
  assert.equal(surface.sent.at(-1), "YOU\nsame");
});

test("execution lifecycle retains start arguments until the matching end", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); await remote.bind("/execution", "guild", "session", ctx().ctx);
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

test("historical mapped threads receive only a read-only explanation", async (t) => {
  const surface = new Surface(); surface.unique = true; const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) }); await remote.bind("/history", "guild", "old", ctx().ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "old" } }]);
  await remote.bind("/history", "guild", "active", ctx().ctx); await remote.catchUp([{ id: "v", message: { role: "user", content: "active" } }]);
  assert.equal(await remote.input("thread-old", "switch",  { sendUserMessage: () => assert.fail("must not switch") }), "historical");
  assert.equal(surface.sent.at(-1), "This Session is read-only. Resume it from the local TUI first.");
});

test("idle remote input is a normal Pi user message", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); const calls: unknown[] = [];
  await remote.bind("/idle", "guild", "session", ctx(true).ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "start" } }]);
  await remote.input("thread", "continue", { sendUserMessage: (_text, options) => calls.push(options) }); assert.deepEqual(calls, [undefined]);
});

test("local UI rejects ordinary input but permits stop, and stale bindings are inert", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); const first = ctx(false); const second = ctx(true);
  await remote.bind("/project", "guild", "one", first.ctx); await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]);
  remote.setLocalUiPrompt(true); assert.equal(await remote.input("thread", "no", { sendUserMessage: () => assert.fail("must not send") }), "local-ui");
  assert.equal(await remote.input("thread", "!status", { sendUserMessage: () => assert.fail("status must be read-only") }), "status");
  assert.equal(await remote.input("thread", "!stop", { sendUserMessage: () => undefined }), "stopped");
  await remote.bind("/project", "guild", "two", second.ctx); remote.shutdown(first.ctx);
  assert.equal(remote.activeSessionId, "two");
  remote.setLocalUiPrompt(true); remote.shutdown(second.ctx); await remote.bind("/project", "guild", "three", ctx(true).ctx); assert.equal(remote.activeSessionId, "three");
});

test("blocked and unavailable milestones deduplicate by their runtime fingerprint", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); await remote.bind("/milestones", "guild", "session", ctx().ctx);
  await remote.milestone("blocked:one", "TASK BLOCKED\none"); await remote.milestone("blocked:one", "TASK BLOCKED\none"); await remote.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE"); await remote.milestone("authority:unavailable", "PINDIE AUTHORITY UNAVAILABLE");
  assert.deepEqual(surface.sent, ["TASK BLOCKED\none", "PINDIE AUTHORITY UNAVAILABLE"]);
});

test("Human Gate fingerprints deduplicate materially identical prompts", () => {
  const remote = new RemoteCompanion(new Surface());
  assert.ok(remote.humanGate("Choose", ["A", "B"])); assert.equal(remote.humanGate("Choose", ["A", "B"]), null); assert.ok(remote.humanGate("Choose", ["B", "A"]));
});

test("completion milestone remains pending until the caller emits settled completion", async () => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface); await remote.bind("/complete", "guild", "session", ctx().ctx);
  await remote.milestone("completion:pending", "TASK COMPLETION PENDING");
  assert.deepEqual(surface.sent, ["TASK COMPLETION PENDING"]);
  await remote.milestone("completion:settled", "TASK COMPLETED");
  assert.deepEqual(surface.sent, ["TASK COMPLETION PENDING", "TASK COMPLETED"]);
});

test("milestones deduplicate and stale threads reset cursor", async (t) => {
  const surface = new Surface(); const remote = new RemoteCompanion(surface, { routing: new RemoteRoutingStore({ baseDir: await fixture(t) }) }); await remote.bind("/project", "guild", "session", ctx().ctx);
  surface.fail = true; await assert.rejects(remote.milestone("gate", "HUMAN GATE")); surface.fail = false;
  await remote.milestone("gate", "HUMAN GATE"); await remote.milestone("gate", "HUMAN GATE"); assert.equal(surface.sent.filter((text) => text === "HUMAN GATE").length, 1);
  await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }]); surface.replace = true;
  await remote.catchUp([{ id: "u", message: { role: "user", content: "one" } }, { id: "v", message: { role: "assistant", content: "two" } }]);
  assert.ok(surface.sent.includes("two"));
});
