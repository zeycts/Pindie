import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelType } from "discord.js";

import { DiscordRemote, discordRemoteConfig, type DiscordClientSeam, type DiscordRestSeam } from "../src/discord-remote.ts";
import { RemoteCompanion, type RemoteSessionPresentation } from "../src/remote-companion.ts";
import { RemoteRoutingStore } from "../src/remote-routing.ts";

const config = { token: "super-secret-token", userId: "123456789012345678", guildId: "987654321098765432" };
const status = { taskGoal: null, taskStatus: "idle" as const, activity: null, verificationStatus: null, elapsedMs: null, semanticAuthority: "coherent" as const, localUiPrompt: false };
const presentation = (title = "Session", overrides: Partial<RemoteSessionPresentation["status"]> = {}): RemoteSessionPresentation => ({ project: "project", sessionId: "session", title, status: { ...status, ...overrides } });
const signal = () => new AbortController().signal;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext) { const dir = await mkdtemp(join(tmpdir(), "pindie-discord-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

class FakeClient implements DiscordClientSeam {
  readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  readonly rest = { get: async () => ({}), post: async () => ({}), patch: async () => ({}) };
  loginCalls = 0; destroyed = 0;
  async login(_token: string) { this.loginCalls++; }
  destroy() { this.destroyed++; }
  once(event: "ready", listener: () => void) { this.add(event, listener); }
  on(event: "messageCreate" | "shardResume" | "error", listener: (...args: any[]) => void) { this.add(event, listener); }
  emit(event: string, ...args: any[]) { for (const listener of this.handlers.get(event) ?? []) listener(...args); }
  private add(event: string, listener: (...args: any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]); }
}

type RestCall = { kind: string; channelId?: string; messageId?: string; content?: string; body?: unknown; signal: AbortSignal };
class FakeRest implements DiscordRestSeam {
  readonly channels = new Map<string, any>();
  readonly calls: RestCall[] = [];
  next = 0;
  async fetchChannel(channelId: string, requestSignal: AbortSignal) { this.calls.push({ kind: "fetch", channelId, signal: requestSignal }); return this.channels.get(channelId) ?? null; }
  async createProjectChannel(_guildId: string, name: string, requestSignal: AbortSignal) { const channel = { id: `channel-${++this.next}`, guild_id: config.guildId, type: ChannelType.GuildText, name }; this.channels.set(channel.id, channel); this.calls.push({ kind: "create-project", channelId: channel.id, signal: requestSignal }); return channel; }
  async createMessage(channelId: string, content: string, requestSignal: AbortSignal) { const message = { id: `message-${++this.next}` }; this.calls.push({ kind: "create-message", channelId, messageId: message.id, content, signal: requestSignal }); return message; }
  async startThread(channelId: string, messageId: string, name: string, requestSignal: AbortSignal) { const thread = { id: `thread-${++this.next}`, guild_id: config.guildId, parent_id: channelId, type: ChannelType.PublicThread, thread_metadata: { archived: false }, name }; this.channels.set(thread.id, thread); this.calls.push({ kind: "start-thread", channelId, messageId, content: name, signal: requestSignal }); return thread; }
  async editChannel(channelId: string, body: { name?: string; archived?: boolean }, requestSignal: AbortSignal) { this.calls.push({ kind: "edit-channel", channelId, body, signal: requestSignal }); }
  async editMessage(channelId: string, messageId: string, content: string, requestSignal: AbortSignal) { this.calls.push({ kind: "edit-message", channelId, messageId, content, signal: requestSignal }); }
  text(id = "channel") { const channel = { id, guild_id: config.guildId, type: ChannelType.GuildText }; this.channels.set(id, channel); return channel; }
  thread(id = "thread", parentId = "channel", archived = false) { const thread = { id, guild_id: config.guildId, parent_id: parentId, type: ChannelType.PublicThread, thread_metadata: { archived } }; this.channels.set(id, thread); return thread; }
}

const setup = async (rest = new FakeRest(), options: Record<string, unknown> = {}) => {
  const client = new FakeClient();
  const remote = new DiscordRemote(config, { createClient: () => client, createRest: () => rest, ...options });
  await remote.start(async () => "sent");
  return { client, remote, rest };
};

test("Discord configuration is disabled unless complete and never exposes its token", () => {
  assert.deepEqual(discordRemoteConfig({}), { enabled: false });
  const partial = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: "secret" });
  assert.equal(partial.enabled, false); assert.doesNotMatch(JSON.stringify(partial), /secret/);
  const enabled = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: config.token, PINDIE_DISCORD_USER_ID: config.userId, PINDIE_DISCORD_GUILD_ID: config.guildId });
  assert.equal(enabled.enabled, true); assert.doesNotMatch(JSON.stringify({ warning: enabled.enabled ? undefined : enabled.warning }), /super-secret-token/);
});

test("Discord REST receives AbortSignal, disables mentions, and starts a message thread with real options", async () => {
  const calls: Array<{ method: string; route: string; options: any }> = []; let next = 0;
  const raw = {
    get: async (route: string, options: any) => { calls.push({ method: "get", route, options }); return route === "/channels/thread" ? { id: "thread", guild_id: config.guildId, parent_id: "channel", type: ChannelType.PublicThread } : { id: "channel", guild_id: config.guildId, type: ChannelType.GuildText }; },
    post: async (route: string, options: any) => { calls.push({ method: "post", route, options }); if (route.includes("/threads")) return { id: "thread", guild_id: config.guildId, parent_id: "channel", type: ChannelType.PublicThread }; if (route.includes("/guilds/")) return { id: "channel", guild_id: config.guildId, type: ChannelType.GuildText }; return { id: `message-${++next}` }; },
    patch: async (route: string, options: any) => { calls.push({ method: "patch", route, options }); return {}; },
  };
  const client = new FakeClient(); Object.assign(client.rest, raw);
  const remote = new DiscordRemote(config, { createClient: () => client, setTimer: () => 1 as any, clearTimer: () => undefined }); await remote.start(async () => "sent");
  const controller = new AbortController(); const project = await remote.ensureProject("p", "project", null, controller.signal); const session = await remote.ensureSession(project.channelId, "s", "Title", null, controller.signal);
  await remote.send(session.threadId, { entryId: "a", kind: "assistant", text: "answer" }, controller.signal);
  await remote.updateSessionPresentation(session, presentation(), controller.signal); await remote.flushPresentation(session.threadId);
  assert.ok(calls.length > 0 && calls.every((call) => call.options.signal === controller.signal));
  const messageWrites = calls.filter((call) => call.route.includes("/messages") && !call.route.endsWith("/threads"));
  assert.ok(messageWrites.length > 0); for (const call of messageWrites) assert.deepEqual(call.options.body.allowed_mentions, { parse: [] });
  const thread = calls.find((call) => call.route.endsWith("/threads")); assert.ok(thread); assert.equal("type" in thread.options.body, false); assert.equal(thread.options.body.auto_archive_duration, 1440);
});

test("channel/session creation, reuse, unarchive, and confirmed stale replacement stay endpoint-scoped", async () => {
  const { remote, rest } = await setup(); const project = await remote.ensureProject("project", "project", null, signal()); const created = await remote.ensureSession(project.channelId, "session", "My Session", null, signal());
  assert.ok(created.anchorMessageId.startsWith("message-")); assert.ok(created.headerMessageId?.startsWith("message-")); assert.ok(rest.calls.some((call) => call.kind === "start-thread"));
  rest.thread(created.threadId, project.channelId, true); await remote.ensureSession(project.channelId, "session", "My Session", { ...created, lastMirroredEntryId: null }, signal()); assert.ok(rest.calls.some((call) => call.kind === "edit-channel" && (call.body as any).archived === false));
  rest.channels.delete(project.channelId); const replacement = await remote.ensureProject("project", "project", project.channelId, signal()); assert.equal(replacement.replaced, true);
});

test("a replaced M1 Session aborts its in-flight Anchor request and cannot continue stale thread mutation", async (t) => {
  const rest = new FakeRest(); rest.text("channel"); const entered = deferred(); const release = deferred(); let oldSignal: AbortSignal | null = null;
  const originalCreate = rest.createMessage.bind(rest);
  rest.createMessage = async (channelId, content, requestSignal) => {
    if (content.includes("A prompt")) { oldSignal = requestSignal; entered.resolve(); await release.promise; if (requestSignal.aborted) throw new DOMException("aborted", "AbortError"); }
    return originalCreate(channelId, content, requestSignal);
  };
  const { remote } = await setup(rest); const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); await store.save("/race", { version: 1, guildId: config.guildId, channelId: "channel", sessions: {} });
  const companion = new RemoteCompanion(remote, { routing: store }); const contextA = { isIdle: () => true, abort: () => undefined } as any; const contextB = { isIdle: () => true, abort: () => undefined } as any;
  await companion.bind("/race", config.guildId, "A", contextA); const stale = companion.catchUp([{ id: "a", message: { role: "user", content: "A prompt" } }]); await entered.promise;
  await companion.bind("/race", config.guildId, "B", contextB); assert.equal(oldSignal?.aborted, true); release.resolve(); await stale;
  assert.equal(rest.calls.some((call) => call.kind === "start-thread" && call.content === "A-prompt"), false);
  await companion.catchUp([{ id: "b", message: { role: "user", content: "B prompt" } }]); assert.ok(rest.calls.some((call) => call.kind === "start-thread" && call.content === "B-prompt"));
});

test("queued presentation retains its binding signal and performs no edits after abort", async () => {
  const rest = new FakeRest(); rest.thread(); const timers: Array<() => void> = []; const { remote } = await setup(rest, { setTimer: (callback: () => void) => { timers.push(callback); return 1 as any; }, clearTimer: () => undefined });
  const controller = new AbortController(); await remote.updateSessionPresentation({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }, presentation("Old"), controller.signal); controller.abort(); timers.shift()?.(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rest.calls.some((call) => call.kind.startsWith("edit-")), false);
});

test("Anchor and Header edits coalesce, update stable IDs, and no-op refreshes do not edit again", async () => {
  const rest = new FakeRest(); rest.text(); const timers: Array<() => void> = []; const { remote } = await setup(rest, { setTimer: (callback: () => void) => { timers.push(callback); return timers.length as any; }, clearTimer: () => undefined });
  const session = await remote.ensureSession("channel", "session", "Initial", null, signal()); const controller = new AbortController();
  await remote.updateSessionPresentation(session, presentation("Initial"), controller.signal); await remote.flushPresentation(session.threadId);
  await remote.updateSessionPresentation(session, presentation("Draft"), controller.signal); await remote.updateSessionPresentation(session, presentation("Renamed"), controller.signal); await remote.flushPresentation(session.threadId);
  await remote.updateSessionPresentation(session, presentation("Renamed", { taskGoal: "Ship it", taskStatus: "active" }), controller.signal); await remote.flushPresentation(session.threadId);
  await remote.updateSessionPresentation(session, presentation("Renamed", { taskGoal: "Ship it", taskStatus: "done" }), controller.signal); await remote.flushPresentation(session.threadId);
  const anchorEdits = rest.calls.filter((call) => call.kind === "edit-message" && call.messageId === session.anchorMessageId); assert.equal(anchorEdits.length, 4); assert.ok(anchorEdits.every((call) => call.channelId === "channel")); assert.match(anchorEdits[1]?.content ?? "", /Renamed/); assert.match(anchorEdits[2]?.content ?? "", /Ship it.*active/s); assert.match(anchorEdits[3]?.content ?? "", /Ship it.*done/s);
  assert.equal(rest.calls.filter((call) => call.kind === "edit-message" && call.messageId === session.headerMessageId).length, 4); assert.equal(rest.calls.filter((call) => call.kind === "start-thread").length, 1);
  const editsBefore = rest.calls.filter((call) => call.kind.startsWith("edit-")).length; await remote.updateSessionPresentation(session, presentation("Renamed", { taskGoal: "Ship it", taskStatus: "done" }), controller.signal); await remote.flushPresentation(session.threadId); assert.equal(rest.calls.filter((call) => call.kind.startsWith("edit-")).length, editsBefore);
});

test("Discord-origin prompts are not reposted while neutral and assistant events remain visible", async () => {
  const rest = new FakeRest(); rest.thread(); const { remote } = await setup(rest);
  await remote.send("thread", { entryId: "d", kind: "user", text: "YOU · DISCORD\nhello", origin: "discord" }, signal()); await remote.send("thread", { entryId: "u", kind: "user", text: "YOU\nhello", origin: "neutral" }, signal()); await remote.send("thread", { entryId: "a", kind: "assistant", text: "answer" }, signal());
  assert.deepEqual(rest.calls.filter((call) => call.kind === "create-message").map((call) => call.content), ["YOU\nhello", "answer"]);
});

test("authorized mapped input ignores bots, wrong routing, and whitespace-only content", async () => {
  const client = new FakeClient(); const rest = new FakeRest(); const seen: string[] = []; const remote = new DiscordRemote(config, { createClient: () => client, createRest: () => rest }); await remote.start(async (thread, text) => { seen.push(`${thread}:${text}`); return "sent"; }, () => undefined, (threadId) => threadId === "thread");
  const channel = { isThread: () => true }; client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: config.userId, bot: false }, content: "go", channel }); client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: config.userId, bot: false }, content: "   \n", channel }); client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: config.userId, bot: true }, content: "no", channel }); client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: "111111111111111111", bot: false }, content: "no", channel }); client.emit("messageCreate", { guildId: "other", channelId: "thread", author: { id: config.userId, bot: false }, content: "no", channel }); client.emit("messageCreate", { guildId: config.guildId, channelId: "unmapped", author: { id: config.userId, bot: false }, content: "no", channel });
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(seen, ["thread:go"]);
});

test("startup is dormant until start, reconnect catches up, and shutdown cleans resources", async () => {
  const client = new FakeClient(); const rest = new FakeRest(); let ready = 0; const remote = new DiscordRemote(config, { createClient: () => client, createRest: () => rest }); assert.equal(client.loginCalls, 0);
  await remote.start(async () => "sent", () => { ready++; }); assert.equal(client.loginCalls, 1); client.emit("ready"); client.emit("shardResume"); assert.equal(ready, 2); remote.stop(); assert.equal(client.destroyed, 1);
});
