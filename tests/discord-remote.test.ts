import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelType } from "discord.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";

import { DiscordGatewayClient, type GatewaySocketFactory } from "../src/discord-gateway.ts";
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
  on(event: "ready" | "messageCreate" | "shardResume" | "error", listener: (...args: any[]) => void) { this.add(event, listener); }
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
  assert.deepEqual(discordRemoteConfig({ PINDIE_DISCORD_PROXY: "http://proxy.local:8080" }), { enabled: false });
  const partial = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: "secret" });
  assert.equal(partial.enabled, false); assert.doesNotMatch(JSON.stringify(partial), /secret/);
  const enabled = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: config.token, PINDIE_DISCORD_USER_ID: config.userId, PINDIE_DISCORD_GUILD_ID: config.guildId });
  assert.equal(enabled.enabled, true); assert.doesNotMatch(JSON.stringify({ warning: enabled.enabled ? undefined : enabled.warning }), /super-secret-token/);
});

test("Gateway proxy resolution prefers explicit configuration, falls back to HTTPS_PROXY, and stays direct without one", () => {
  const discord = { PINDIE_DISCORD_TOKEN: config.token, PINDIE_DISCORD_USER_ID: config.userId, PINDIE_DISCORD_GUILD_ID: config.guildId };
  const explicit = discordRemoteConfig({ ...discord, PINDIE_DISCORD_PROXY: "http://explicit:1", HTTPS_PROXY: "http://upper:2", https_proxy: "http://lower:3" });
  assert.equal(explicit.enabled && explicit.config.proxyUrl, "http://explicit:1");
  const fallback = discordRemoteConfig({ ...discord, HTTPS_PROXY: "http://upper:2", https_proxy: "http://lower:3" });
  assert.equal(fallback.enabled && fallback.config.proxyUrl, "http://upper:2");
  const lower = discordRemoteConfig({ ...discord, https_proxy: "http://lower:3" });
  assert.equal(lower.enabled && lower.config.proxyUrl, "http://lower:3");
  const direct = discordRemoteConfig(discord);
  assert.equal(direct.enabled && direct.config.proxyUrl, undefined);
});

test("Discord construction configures REST and Gateway proxy agents while direct mode configures neither", async () => {
  const constructed: Array<Record<string, unknown>> = [];
  const restAgents: unknown[] = [];
  const discoveryAgents: unknown[] = [];
  const restCloseCalls: number[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  const createSocket: GatewaySocketFactory = (_url, options) => {
    constructed.push(options as Record<string, unknown>);
    return { readyState: 1, send: () => undefined, close: () => undefined, terminate: () => undefined, on: (event: string, listener: (...args: any[]) => void) => { handlers.set(event, listener); return undefined as any; } };
  };
  const connect = async (proxyUrl?: string) => {
    const client = new DiscordGatewayClient({ proxyUrl, createSocket });
    client.on("error", () => undefined);
    restAgents.push(client.rest.options.agent);
    let closed = 0;
    if (client.rest.options.agent instanceof ProxyAgent) client.rest.options.agent.close = async () => { closed++; };
    Object.assign(client.rest, { get: async () => { discoveryAgents.push(client.rest.options.agent); return { url: "wss://gateway.discord.gg" }; } });
    const login = client.login("token");
    await new Promise((resolve) => setImmediate(resolve));
    handlers.get("message")?.(Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } })));
    handlers.get("message")?.(Buffer.from(JSON.stringify({ op: 0, t: "READY", d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } })));
    await login; client.destroy(); restCloseCalls.push(closed); handlers.clear();
  };
  await connect("http://user:password@proxy.local:8080");
  await connect();
  assert.ok(constructed[0]?.agent instanceof HttpsProxyAgent);
  assert.ok(restAgents[0] instanceof ProxyAgent);
  assert.equal(discoveryAgents[0], restAgents[0]);
  assert.equal(constructed[1]?.agent, undefined);
  assert.equal(restAgents[1], null);
  assert.equal(discoveryAgents[1], null);
  assert.deepEqual(restCloseCalls, [1, 0]);
});

test("Gateway discovery and subsequent Discord operations share the configured REST dispatcher", async () => {
  const proxyUrl = "http://user:password@proxy.local:8080";
  const handlers = new Map<string, (...args: any[]) => void>();
  const createSocket: GatewaySocketFactory = () => ({
    readyState: 1, send: () => undefined, close: () => undefined, terminate: () => undefined,
    on: (event: string, listener: (...args: any[]) => void) => { handlers.set(event, listener); return undefined as any; },
  });
  const client = new DiscordGatewayClient({ proxyUrl, createSocket });
  const dispatcher = client.rest.options.agent;
  const calls: Array<{ method: string; route: string; dispatcher: unknown; rest: unknown }> = [];
  let next = 0;
  Object.assign(client.rest, {
    get: async function (this: unknown, route: string) { calls.push({ method: "get", route, dispatcher: client.rest.options.agent, rest: this }); return route.includes("gateway") ? { url: "wss://gateway.discord.gg" } : route.endsWith("/thread") ? { id: "thread", guild_id: config.guildId, parent_id: "channel", type: ChannelType.PublicThread } : { id: "channel", guild_id: config.guildId, type: ChannelType.GuildText }; },
    post: async function (this: unknown, route: string) { calls.push({ method: "post", route, dispatcher: client.rest.options.agent, rest: this }); return route.includes("threads") ? { id: "thread", guild_id: config.guildId, parent_id: "channel", type: ChannelType.PublicThread } : { id: `message-${++next}` }; },
    patch: async function (this: unknown, route: string) { calls.push({ method: "patch", route, dispatcher: client.rest.options.agent, rest: this }); return {}; },
  });
  const remote = new DiscordRemote({ ...config, proxyUrl }, { createClient: () => client, setTimer: () => 1 as any, clearTimer: () => undefined });
  const started = remote.start(async () => "sent");
  await new Promise((resolve) => setImmediate(resolve));
  handlers.get("message")?.(Buffer.from(JSON.stringify({ op: 0, t: "READY", d: { session_id: "session", resume_gateway_url: "wss://gateway.discord.gg" } })));
  await started;
  const controller = new AbortController();
  const session = await remote.ensureSession("channel", "session", "Title", null, controller.signal);
  await remote.send(session.threadId, { entryId: "a", kind: "assistant", text: "answer" }, controller.signal);
  await remote.updateSessionPresentation(session, presentation("Renamed"), controller.signal); await remote.flushPresentation(session.threadId);
  assert.ok(dispatcher instanceof ProxyAgent);
  assert.ok(calls.some((call) => call.route.includes("gateway")));
  assert.ok(calls.some((call) => call.method === "post"));
  assert.ok(calls.some((call) => call.method === "patch"));
  assert.ok(calls.every((call) => call.dispatcher === dispatcher && call.rest === client.rest));
  remote.stop();
});

test("proxy credentials are never included in configuration or transport diagnostics", async () => {
  const secret = "proxy-password"; const warnings: string[] = [];
  const invalid = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: config.token, PINDIE_DISCORD_USER_ID: config.userId, PINDIE_DISCORD_GUILD_ID: config.guildId, PINDIE_DISCORD_PROXY: `http://user:${secret}@[` });
  assert.equal(invalid.enabled, false); assert.doesNotMatch(JSON.stringify(invalid), new RegExp(secret));
  const proxyUrl = `http://user:${secret}@proxy.local:8080`;
  const client = new DiscordGatewayClient({ proxyUrl }); Object.assign(client.rest, { get: async () => { throw new Error(proxyUrl); } });
  const remote = new DiscordRemote({ ...config, proxyUrl }, { createClient: () => client, warn: (message) => warnings.push(message) });
  await assert.rejects(remote.start(async () => "sent"));
  assert.deepEqual(warnings, ["Pindie Discord Remote connection failed."]);
  assert.doesNotMatch(warnings.join("\n"), new RegExp(secret));
  remote.stop();
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
  const companion = new RemoteCompanion(remote, { routing: store });
  await companion.bind("/race", config.guildId, "A"); const stale = companion.catchUp([{ id: "a", message: { role: "user", content: "A prompt" } }]); await entered.promise;
  await companion.bind("/race", config.guildId, "B"); assert.equal(oldSignal?.aborted, true); release.resolve(); await stale;
  assert.equal(rest.calls.some((call) => call.kind === "start-thread" && call.content === "A prompt"), false);
  await companion.catchUp([{ id: "b", message: { role: "user", content: "B prompt" } }]); assert.ok(rest.calls.some((call) => call.kind === "start-thread" && call.content === "B prompt"));
});

test("a Chinese Session-local prompt remains the Unicode Discord thread name", async (t) => {
  const rest = new FakeRest(); const { remote } = await setup(rest);
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) });
  const companion = new RemoteCompanion(remote, { routing: store });
  await companion.bind("/unicode", config.guildId, "session");
  await companion.catchUp([{ id: "u", message: { role: "user", content: "修复代理连接问题\n保留后续内容" } }]);
  assert.ok(rest.calls.some((call) => call.kind === "start-thread" && call.content === "修复代理连接问题"));
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

test("a fully caught-up mapped Session rename PATCHes the same thread, Anchor, and Header", async (t) => {
  const rest = new FakeRest(); const { remote } = await setup(rest, { setTimer: () => 1 as any, clearTimer: () => undefined });
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const companion = new RemoteCompanion(remote, { routing: store });
  const entries = [{ id: "u", message: { role: "user" as const, content: "Original prompt" } }];
  await companion.bind("/live-name", config.guildId, "session", { status: { ...status, taskGoal: "Task", taskStatus: "active" } });
  await companion.catchUp(entries);
  const binding = (await store.load("/live-name"))?.sessions.session; assert.ok(binding);
  await remote.flushPresentation(binding.threadId); rest.calls.length = 0;
  await companion.rename("Discord Remote Test 2"); await remote.flushPresentation(binding.threadId);
  const after = (await store.load("/live-name"))?.sessions.session;
  assert.equal(after?.threadId, binding.threadId); assert.equal(after?.lastMirroredEntryId, "u");
  assert.ok(rest.calls.some((call) => call.kind === "edit-channel" && call.channelId === binding.threadId && (call.body as any).name === "Discord Remote Test 2"));
  assert.ok(rest.calls.some((call) => call.kind === "edit-message" && call.messageId === binding.anchorMessageId && call.content?.includes("Discord Remote Test 2")));
  assert.ok(rest.calls.some((call) => call.kind === "edit-message" && call.messageId === binding.headerMessageId && call.content?.includes("Discord Remote Test 2")));
  assert.equal(rest.calls.some((call) => call.kind === "start-thread"), false);
});

test("presentation failures emit only a safe local diagnostic category", async () => {
  const secret = "proxy-password"; const warnings: string[] = []; const rest = new FakeRest(); rest.thread();
  rest.editChannel = async () => { throw new Error(`http://user:${secret}@proxy`); };
  const { remote } = await setup(rest, { warn: (message: string) => warnings.push(message), setTimer: () => 1 as any, clearTimer: () => undefined });
  await remote.updateSessionPresentation({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header" }, presentation("Rename"), signal());
  await remote.flushPresentation("thread");
  assert.deepEqual(warnings, ["Pindie Discord Remote presentation update failed."]);
  assert.doesNotMatch(warnings.join("\n"), new RegExp(secret));
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

test("READY reconciliation persists across invalid-session re-identification and reuses routing and cursor", async (t) => {
  type Socket = ReturnType<GatewaySocketFactory> & { handlers: Map<string, (...args: any[]) => void>; sent: any[] };
  const sockets: Socket[] = []; const timers: Array<{ callback: () => void; delay: number }> = [];
  const createSocket: GatewaySocketFactory = () => {
    const handlers = new Map<string, (...args: any[]) => void>(); const sent: any[] = [];
    const socket: Socket = {
      handlers, sent, readyState: 1, send: (data) => { sent.push(JSON.parse(String(data))); }, terminate: () => undefined,
      close: () => { handlers.get("close")?.(); },
      on: (event: string, listener: (...args: any[]) => void) => { handlers.set(event, listener); return socket as any; },
    };
    sockets.push(socket); return socket;
  };
  const client = new DiscordGatewayClient({ createSocket, setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length as any; }, clearTimer: () => undefined });
  Object.assign(client.rest, { get: async () => ({ url: "wss://gateway.discord.gg" }) });
  const rest = new FakeRest(); const remote = new DiscordRemote(config, { createClient: () => client, createRest: () => rest });
  const store = new RemoteRoutingStore({ baseDir: await fixture(t) }); const companion = new RemoteCompanion(remote, { routing: store });
  await companion.bind("/reconnect", config.guildId, "persisted-session");
  let entries = [{ id: "u", message: { role: "user" as const, content: "initial" } }];
  let reconciliations = 0; const catchUps: Array<Promise<void>> = [];
  const started = remote.start(async () => "sent", () => { reconciliations++; catchUps.push(companion.catchUp(entries)); });
  await new Promise((resolve) => setImmediate(resolve));
  const dispatch = (socket: Socket, payload: unknown) => socket.handlers.get("message")?.(Buffer.from(JSON.stringify(payload)));
  dispatch(sockets[0]!, { op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(sockets[0]!.sent.at(-1)?.op, 2);
  dispatch(sockets[0]!, { op: 0, t: "READY", d: { session_id: "gateway-one", resume_gateway_url: "wss://resume.discord.gg" } });
  await started; await catchUps.at(-1);
  const initial = (await store.load("/reconnect"))?.sessions["persisted-session"]; assert.ok(initial); assert.equal(initial.lastMirroredEntryId, "u"); assert.equal(reconciliations, 1);

  entries = [...entries, { id: "a", message: { role: "assistant" as const, content: "resumed" } }];
  dispatch(sockets[0]!, { op: 0, t: "RESUMED" }); await catchUps.at(-1);
  const resumed = (await store.load("/reconnect"))?.sessions["persisted-session"];
  assert.equal(reconciliations, 2); assert.equal(resumed?.threadId, initial.threadId); assert.equal(resumed?.lastMirroredEntryId, "a");

  entries = [...entries, { id: "b", message: { role: "assistant" as const, content: "reidentified" } }];
  dispatch(sockets[0]!, { op: 9, d: false });
  const reconnect = timers.find((timer) => timer.delay === 1_000); assert.ok(reconnect); reconnect.callback();
  dispatch(sockets[1]!, { op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(sockets[1]!.sent.at(-1)?.op, 2);
  dispatch(sockets[1]!, { op: 0, t: "READY", d: { session_id: "gateway-two", resume_gateway_url: "wss://resume-two.discord.gg" } });
  await catchUps.at(-1);
  const reidentified = (await store.load("/reconnect"))?.sessions["persisted-session"];
  assert.equal(reconciliations, 3); assert.equal(reidentified?.threadId, initial.threadId); assert.equal(reidentified?.anchorMessageId, initial.anchorMessageId); assert.equal(reidentified?.headerMessageId, initial.headerMessageId); assert.equal(reidentified?.lastMirroredEntryId, "b");
  assert.equal(rest.calls.filter((call) => call.kind === "start-thread").length, 1);
  remote.stop();
});

test("READY from a stale DiscordRemote generation is ignored", async () => {
  const stale = new FakeClient(); const current = new FakeClient(); const clients = [stale, current]; let ready = 0;
  const remote = new DiscordRemote(config, { createClient: () => clients.shift()!, createRest: () => new FakeRest() });
  await remote.start(async () => "sent", () => { ready++; });
  stale.emit("ready");
  await remote.start(async () => "sent", () => { ready++; });
  stale.emit("ready"); stale.emit("shardResume"); current.emit("ready"); current.emit("shardResume");
  assert.equal(ready, 3); assert.equal(stale.destroyed, 1);
  remote.stop(); assert.equal(current.destroyed, 1);
});
