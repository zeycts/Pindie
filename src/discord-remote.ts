import { ChannelType, Client, GatewayIntentBits } from "discord.js";

import type { RemoteSessionPresentation, RemoteSurface } from "./remote-companion.ts";
import type { RemoteSessionRouting } from "./remote-routing.ts";
import type { TimelineEvent } from "./session-mirror.ts";

export interface DiscordRemoteConfig {
  token: string;
  userId: string;
  guildId: string;
}

export type DiscordRemoteConfigResult =
  | { enabled: true; config: DiscordRemoteConfig }
  | { enabled: false; warning?: string };

/** Environment-only configuration. The token deliberately never appears in a result or warning. */
export function discordRemoteConfig(env: Record<string, string | undefined> = process.env): DiscordRemoteConfigResult {
  const token = env.PINDIE_DISCORD_TOKEN?.trim();
  const userId = env.PINDIE_DISCORD_USER_ID?.trim();
  const guildId = env.PINDIE_DISCORD_GUILD_ID?.trim();
  if (!token && !userId && !guildId) return { enabled: false };
  if (!token || !userId || !guildId || !/^\d{17,20}$/.test(userId) || !/^\d{17,20}$/.test(guildId)) {
    return { enabled: false, warning: "Pindie Discord Remote is disabled: configuration is incomplete or invalid." };
  }
  return { enabled: true, config: { token, userId, guildId } };
}

type DiscordMessage = {
  id: string;
  guildId?: string | null;
  channelId: string;
  author: { id: string; bot: boolean };
  content: string;
  channel: { isThread?: () => boolean; send(options: { content: string; allowedMentions: { parse: [] } }): Promise<unknown> };
};
type DiscordChannel = {
  id: string;
  guildId?: string;
  parentId?: string | null;
  type: ChannelType;
  archived?: boolean | null;
  send?(options: { content: string; allowedMentions: { parse: [] } }): Promise<{ id: string; startThread(options: { name: string; type: ChannelType; autoArchiveDuration: 1440 }): Promise<DiscordChannel> }>;
  setArchived?(archived: boolean): Promise<unknown>;
  setName?(name: string): Promise<unknown>;
  messages?: { fetch(id: string): Promise<{ edit(options: { content: string; allowedMentions: { parse: [] } }): Promise<unknown> }> };
};
type DiscordGuild = {
  id: string;
  channels: {
    fetch(id: string): Promise<DiscordChannel | null>;
    create(options: { name: string; type: ChannelType }): Promise<DiscordChannel>;
  };
};
export interface DiscordClientSeam {
  login(token: string): Promise<unknown>;
  destroy(): void;
  once(event: "ready", listener: () => void): unknown;
  on(event: "messageCreate" | "shardResume" | "error", listener: (...args: any[]) => void): unknown;
  guilds: { fetch(id: string): Promise<DiscordGuild> };
  channels: { fetch(id: string): Promise<DiscordChannel | null> };
}

export interface DiscordRemoteOptions {
  createClient?: () => DiscordClientSeam;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type Input = (threadId: string, text: string) => Promise<RemoteInputResult>;
export type RemoteInputResult = "sent" | "steer" | "follow-up" | "failed" | "historical" | "local-ui" | "stopped" | "idle" | "status";
type PendingPresentation = { session: Pick<RemoteSessionRouting, "threadId" | "anchorMessageId" | "headerMessageId">; value: RemoteSessionPresentation; key: string; timer?: ReturnType<typeof setTimeout> };

const noMentions = { parse: [] as [] };
const isDiscordOrigin = (origin: TimelineEvent["origin"]): boolean => origin === "discord" || origin === "discord-steer" || origin === "discord-follow-up";
const isMissing = (error: unknown): boolean => !!error && typeof error === "object" && (((error as { code?: unknown }).code === 10003) || ((error as { status?: unknown }).status === 404));
const abortIfNeeded = (signal: AbortSignal): void => { if (signal.aborted) throw new DOMException("Remote binding aborted", "AbortError"); };
const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").slice(0, 90) || "project";
const header = (value: RemoteSessionPresentation): string => {
  const state = value.status;
  return `PINDIE SESSION\n${value.title}\nProject · ${value.project}\nTask · ${state.taskStatus}${state.taskGoal ? ` · ${state.taskGoal}` : ""}${state.activity ? `\nActivity · ${state.activity}` : ""}${state.localUiPrompt ? "\nWAITING FOR LOCAL UI" : ""}`.slice(0, 1_900);
};

/** Concrete Discord projection only. It owns neither Pi input semantics nor remote routing state. */
export class DiscordRemote implements RemoteSurface {
  readonly config: DiscordRemoteConfig;
  private client: DiscordClientSeam | null = null;
  private generation = 0;
  private onInput: Input | null = null;
  private onReady: (() => void) | null = null;
  private readonly pending = new Map<string, PendingPresentation>();
  private readonly sentPresentation = new Map<string, string>();
  private readonly setTimer: NonNullable<DiscordRemoteOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<DiscordRemoteOptions["clearTimer"]>;
  private readonly createClient: NonNullable<DiscordRemoteOptions["createClient"]>;

  constructor(config: DiscordRemoteConfig, options: DiscordRemoteOptions = {}) {
    this.config = config;
    this.createClient = options.createClient ?? (() => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] }) as unknown as DiscordClientSeam);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Starts only after a native Session binds. It is intentionally never awaited by extension startup. */
  async start(input: Input, ready: () => void = () => undefined, acceptsThread: (threadId: string) => boolean = () => true): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const client = this.createClient();
    this.client = client; this.onInput = input; this.onReady = ready;
    client.once("ready", () => { if (this.current(generation, client)) { this.onReady?.(); } });
    client.on("shardResume", () => { if (this.current(generation, client)) this.onReady?.(); });
    client.on("messageCreate", (message: DiscordMessage) => { void this.receive(generation, message, acceptsThread); });
    client.on("error", () => undefined);
    await client.login(this.config.token);
    if (!this.current(generation, client)) return;
  }

  stop(): void {
    ++this.generation;
    for (const pending of this.pending.values()) if (pending.timer) this.clearTimer(pending.timer);
    this.pending.clear(); this.sentPresentation.clear(); this.onInput = null; this.onReady = null;
    const client = this.client; this.client = null;
    try { client?.destroy(); } catch { /* optional transport cleanup */ }
  }

  async ensureProject(_projectId: string, name: string, existingChannelId: string | null, signal: AbortSignal): Promise<{ channelId: string; replaced?: boolean }> {
    const guild = await this.guild(signal);
    if (existingChannelId) {
      try {
        const channel = await guild.channels.fetch(existingChannelId); abortIfNeeded(signal);
        if (channel?.guildId === this.config.guildId && channel.type === ChannelType.GuildText) return { channelId: channel.id };
        if (channel) return this.createProject(guild, name, true, signal);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return this.createProject(guild, name, true, signal);
    }
    return this.createProject(guild, name, false, signal);
  }

  async ensureSession(channelId: string, _sessionId: string, title: string, existing: RemoteSessionRouting | null, signal: AbortSignal): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }> {
    const client = this.requireClient(signal);
    if (existing) {
      try {
        const thread = await client.channels.fetch(existing.threadId); abortIfNeeded(signal);
        if (thread?.guildId === this.config.guildId && thread.parentId === channelId && thread.type === ChannelType.PublicThread) {
          if (thread.archived) await thread.setArchived?.(false);
          abortIfNeeded(signal);
          if (existing.headerMessageId === null) {
            const created = await thread.send?.({ content: `PINDIE SESSION\n${title}`.slice(0, 1_900), allowedMentions: noMentions });
            abortIfNeeded(signal);
            if (!created) throw new Error("Discord Session header is unavailable.");
            return { threadId: existing.threadId, anchorMessageId: existing.anchorMessageId, headerMessageId: created.id };
          }
          return { threadId: existing.threadId, anchorMessageId: existing.anchorMessageId, headerMessageId: existing.headerMessageId };
        }
        if (thread) return this.createSession(channelId, title, true, signal);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return this.createSession(channelId, title, true, signal);
    }
    return this.createSession(channelId, title, false, signal);
  }

  async send(threadId: string, event: TimelineEvent, signal: AbortSignal): Promise<void> {
    // The authorized Discord prompt is already the visible user timeline entry.
    if (event.kind === "user" && isDiscordOrigin(event.origin)) return;
    const client = this.requireClient(signal); const thread = await client.channels.fetch(threadId); abortIfNeeded(signal);
    if (!thread || thread.guildId !== this.config.guildId || thread.type !== ChannelType.PublicThread || !thread.send) throw new Error("Discord Session thread is unavailable.");
    await thread.send({ content: event.text, allowedMentions: noMentions }); abortIfNeeded(signal);
  }

  async updateSessionPresentation(session: Pick<RemoteSessionRouting, "threadId" | "anchorMessageId" | "headerMessageId">, presentation: RemoteSessionPresentation, signal: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const key = header(presentation); const previous = this.sentPresentation.get(session.threadId);
    if (previous === key) return;
    const pending = this.pending.get(session.threadId);
    if (pending) { pending.value = presentation; pending.key = key; return; }
    const next: PendingPresentation = { session, value: presentation, key };
    next.timer = this.setTimer(() => { void this.flushPresentation(session.threadId); }, 200);
    this.pending.set(session.threadId, next);
  }

  async flushPresentation(threadId: string): Promise<void> {
    const pending = this.pending.get(threadId); if (!pending) return;
    this.pending.delete(threadId); if (pending.timer) this.clearTimer(pending.timer);
    if (this.sentPresentation.get(threadId) === pending.key) return;
    const client = this.client; if (!client) return;
    try {
      const thread = await client.channels.fetch(threadId);
      if (!thread || thread.guildId !== this.config.guildId || thread.type !== ChannelType.PublicThread) return;
      await thread.setName?.(safeName(pending.value.title));
      if (pending.session.headerMessageId) {
        const message = await thread.messages?.fetch(pending.session.headerMessageId);
        await message?.edit({ content: pending.key, allowedMentions: noMentions });
      }
      this.sentPresentation.set(threadId, pending.key);
    } catch {
      // Presentation edits are best effort; a later status update/reconnect retries them.
    }
  }

  private async receive(generation: number, message: DiscordMessage, acceptsThread: (threadId: string) => boolean): Promise<void> {
    if (generation !== this.generation || !this.onInput || message.guildId !== this.config.guildId || message.author.bot || message.author.id !== this.config.userId || message.channel.isThread?.() !== true || !acceptsThread(message.channelId)) return;
    const outcome = await this.onInput(message.channelId, message.content).catch((): RemoteInputResult => "failed");
    const feedback = outcome === "steer" ? "Steering the active run." : outcome === "follow-up" ? "Queued after the active run." : outcome === "stopped" ? "Stopped." : outcome === "idle" ? "No active run." : outcome === "local-ui" ? "Waiting for local UI." : outcome === "failed" ? "Could not deliver to Pi." : outcome === "historical" ? "This Session is read-only." : null;
    if (feedback && generation === this.generation) await message.channel.send({ content: feedback, allowedMentions: noMentions }).catch(() => undefined);
  }
  private async guild(signal: AbortSignal): Promise<DiscordGuild> { const client = this.requireClient(signal); const guild = await client.guilds.fetch(this.config.guildId); abortIfNeeded(signal); return guild; }
  private requireClient(signal: AbortSignal): DiscordClientSeam { abortIfNeeded(signal); if (!this.client) throw new Error("Discord Remote is not connected."); return this.client; }
  private async createProject(guild: DiscordGuild, name: string, replaced: boolean, signal: AbortSignal): Promise<{ channelId: string; replaced?: boolean }> { const channel = await guild.channels.create({ name: safeName(name), type: ChannelType.GuildText }); abortIfNeeded(signal); return { channelId: channel.id, replaced: replaced || undefined }; }
  private async createSession(channelId: string, title: string, replaced: boolean, signal: AbortSignal): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }> {
    const client = this.requireClient(signal); const channel = await client.channels.fetch(channelId); abortIfNeeded(signal);
    if (!channel || channel.guildId !== this.config.guildId || channel.type !== ChannelType.GuildText || !channel.send) throw new Error("Discord Project channel is unavailable.");
    const anchor = await channel.send({ content: `PINDIE SESSION · ${title}`.slice(0, 1_900), allowedMentions: noMentions }); abortIfNeeded(signal);
    const thread = await anchor.startThread({ name: safeName(title), type: ChannelType.PublicThread, autoArchiveDuration: 1440 }); abortIfNeeded(signal);
    const head = await thread.send!({ content: `PINDIE SESSION\n${title}`.slice(0, 1_900), allowedMentions: noMentions }); abortIfNeeded(signal);
    return { threadId: thread.id, anchorMessageId: anchor.id, headerMessageId: head.id, replaced: replaced || undefined };
  }
  private current(generation: number, client: DiscordClientSeam): boolean { return generation === this.generation && this.client === client; }
}
