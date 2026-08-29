import assert from "node:assert/strict";
import test from "node:test";

import { ChannelType } from "discord.js";

import { DiscordRemote, discordRemoteConfig, type DiscordClientSeam } from "../src/discord-remote.ts";
import type { RemoteSessionPresentation } from "../src/remote-companion.ts";

const config = { token: "super-secret-token", userId: "123456789012345678", guildId: "987654321098765432" };
const status = { taskGoal: null, taskStatus: "idle" as const, activity: null, verificationStatus: null, elapsedMs: null, semanticAuthority: "coherent" as const, localUiPrompt: false };
const presentation = (title = "Session"): RemoteSessionPresentation => ({ project: "project", sessionId: "session", title, status });
const signal = () => new AbortController().signal;

class FakeClient implements DiscordClientSeam {
  readonly handlers = new Map<string, Array<(...args: any[]) => void>>();
  readonly sent: Array<{ channel: string; content: string; mentions: unknown }> = [];
  readonly edits: string[] = [];
  readonly channelsById = new Map<string, any>();
  readonly guild: any;
  loginCalls = 0; destroyed = 0; next = 0;
  constructor() {
    this.guild = { id: config.guildId, channels: {
      fetch: async (id: string) => this.channelsById.get(id) ?? null,
      create: async (options: any) => this.text(`project-${++this.next}`, options.name),
    } };
  }
  guilds = { fetch: async (id: string) => { if (id !== config.guildId) throw new Error("wrong guild"); return this.guild; } };
  channels = { fetch: async (id: string) => this.channelsById.get(id) ?? null };
  async login(_token: string) { this.loginCalls++; }
  destroy() { this.destroyed++; }
  once(event: "ready", listener: () => void) { this.add(event, listener); }
  on(event: "messageCreate" | "shardResume" | "error", listener: (...args: any[]) => void) { this.add(event, listener); }
  emit(event: string, ...args: any[]) { for (const listener of this.handlers.get(event) ?? []) listener(...args); }
  text(id: string, name = "project") {
    const channel: any = { id, guildId: config.guildId, type: ChannelType.GuildText, name };
    channel.send = async (value: any) => {
      this.sent.push({ channel: id, content: value.content, mentions: value.allowedMentions });
      const anchor = { id: `anchor-${++this.next}`, startThread: async (options: any) => this.thread(`thread-${++this.next}`, id, options.name) };
      return anchor;
    };
    this.channelsById.set(id, channel); return channel;
  }
  thread(id: string, parentId: string, name = "thread") {
    const thread: any = { id, guildId: config.guildId, parentId, type: ChannelType.PublicThread, name, archived: false };
    thread.send = async (value: any) => { this.sent.push({ channel: id, content: value.content, mentions: value.allowedMentions }); return { id: `header-${++this.next}` }; };
    thread.setName = async (value: string) => { thread.name = value; this.edits.push(`name:${value}`); };
    thread.setArchived = async (value: boolean) => { thread.archived = value; this.edits.push(`archived:${value}`); };
    thread.messages = { fetch: async (_messageId: string) => ({ edit: async (value: any) => { this.edits.push(value.content); assert.deepEqual(value.allowedMentions, { parse: [] }); } }) };
    this.channelsById.set(id, thread); return thread;
  }
  private add(event: string, listener: (...args: any[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]); }
}

test("Discord configuration is disabled unless complete and never exposes its token", () => {
  assert.deepEqual(discordRemoteConfig({}), { enabled: false });
  const partial = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: "secret" });
  assert.equal(partial.enabled, false); assert.doesNotMatch(JSON.stringify(partial), /secret/);
  const enabled = discordRemoteConfig({ PINDIE_DISCORD_TOKEN: config.token, PINDIE_DISCORD_USER_ID: config.userId, PINDIE_DISCORD_GUILD_ID: config.guildId });
  assert.equal(enabled.enabled, true); assert.doesNotMatch(JSON.stringify({ warning: enabled.enabled ? undefined : enabled.warning }), /super-secret-token/);
});

test("Discord project/session creation uses a text channel, anchor, public thread, header, and no mentions", async () => {
  const client = new FakeClient(); const remote = new DiscordRemote(config, { createClient: () => client }); await remote.start(async () => "sent");
  const project = await remote.ensureProject("project", "project", null, signal());
  const session = await remote.ensureSession(project.channelId, "session", "My Session", null, signal());
  assert.equal(client.channelsById.get(project.channelId).type, ChannelType.GuildText);
  assert.equal(client.channelsById.get(session.threadId).type, ChannelType.PublicThread);
  assert.equal(session.anchorMessageId.startsWith("anchor-"), true); assert.equal(session.headerMessageId?.startsWith("header-"), true);
  assert.ok(client.sent.every((message) => JSON.stringify(message.mentions) === JSON.stringify({ parse: [] })));
});

test("Discord reuses valid mappings, unarchives threads, and replaces confirmed stale objects only", async () => {
  const client = new FakeClient(); const remote = new DiscordRemote(config, { createClient: () => client }); await remote.start(async () => "sent");
  const channel = client.text("channel"); const thread = client.thread("thread", channel.id); thread.archived = true;
  assert.deepEqual(await remote.ensureProject("p", "project", "channel", signal()), { channelId: "channel" });
  assert.equal((await remote.ensureSession("channel", "s", "title", { threadId: "thread", anchorMessageId: "anchor", headerMessageId: "header", lastMirroredEntryId: null }, signal())).threadId, "thread");
  assert.ok(client.edits.includes("archived:false"));
  client.channelsById.delete("channel"); const replacement = await remote.ensureProject("p", "project", "channel", signal()); assert.equal(replacement.replaced, true);
});

test("Discord-origin user events advance delivery without reposting while neutral and assistant events send", async () => {
  const client = new FakeClient(); const remote = new DiscordRemote(config, { createClient: () => client }); await remote.start(async () => "sent"); const thread = client.thread("thread", "parent");
  await remote.send(thread.id, { entryId: "d", kind: "user", text: "YOU · DISCORD\nhello", origin: "discord" }, signal());
  await remote.send(thread.id, { entryId: "u", kind: "user", text: "YOU\nhello", origin: "neutral" }, signal());
  await remote.send(thread.id, { entryId: "a", kind: "assistant", text: "answer" }, signal());
  assert.deepEqual(client.sent.map((message) => message.content), ["YOU\nhello", "answer"]);
});

test("only the configured human in a mapped configured-guild thread can input and failure feedback is concise", async () => {
  const client = new FakeClient(); const seen: string[] = []; const remote = new DiscordRemote(config, { createClient: () => client }); await remote.start(async (thread, text) => { seen.push(`${thread}:${text}`); return "failed"; }, () => undefined, (threadId) => threadId === "thread");
  const channel: any = { isThread: () => true, send: async (value: any) => { client.sent.push({ channel: "thread", content: value.content, mentions: value.allowedMentions }); } };
  client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: config.userId, bot: false }, content: "go", channel });
  client.emit("messageCreate", { guildId: config.guildId, channelId: "thread", author: { id: "other", bot: false }, content: "no", channel });
  client.emit("messageCreate", { guildId: "other", channelId: "thread", author: { id: config.userId, bot: false }, content: "no", channel });
  client.emit("messageCreate", { guildId: config.guildId, channelId: "unmapped", author: { id: config.userId, bot: false }, content: "no", channel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["thread:go"]); assert.equal(client.sent.at(-1)?.content, "Could not deliver to Pi.");
});

test("header updates coalesce and shutdown aborts pending presentation and client resources", async () => {
  const client = new FakeClient(); const timers: Array<() => void> = []; const remote = new DiscordRemote(config, { createClient: () => client, setTimer: (callback) => { timers.push(callback); return 1 as any; }, clearTimer: () => undefined }); await remote.start(async () => "sent");
  const thread = client.thread("thread", "parent");
  await remote.updateSessionPresentation({ threadId: thread.id, anchorMessageId: "anchor", headerMessageId: "header" }, presentation("one"), signal());
  await remote.updateSessionPresentation({ threadId: thread.id, anchorMessageId: "anchor", headerMessageId: "header" }, presentation("two"), signal());
  timers.shift()?.(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.edits.filter((value) => value.startsWith("name:")).length, 1); assert.match(client.edits.join("\n"), /two/);
  remote.stop(); assert.equal(client.destroyed, 1);
});

test("startup is dormant until start, reconnect invokes catch-up callback, and abort prevents REST work", async () => {
  const client = new FakeClient(); let ready = 0; const remote = new DiscordRemote(config, { createClient: () => client }); assert.equal(client.loginCalls, 0);
  await remote.start(async () => "sent", () => { ready++; }); assert.equal(client.loginCalls, 1); client.emit("ready"); client.emit("shardResume"); assert.equal(ready, 2);
  const controller = new AbortController(); controller.abort(); await assert.rejects(remote.ensureProject("p", "p", null, controller.signal));
});
