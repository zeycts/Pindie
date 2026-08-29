import { ChannelType, Client, GatewayIntentBits, Routes } from "discord.js";

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
  guildId?: string | null;
  channelId: string;
  author: { id: string; bot: boolean };
  content: string;
  channel: { isThread?: () => boolean };
};
type DiscordChannelData = {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  type: ChannelType;
  thread_metadata?: { archived?: boolean };
};
type DiscordMessageData = { id: string };
type DiscordRawRest = {
  get(route: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  post(route: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<unknown>;
  patch(route: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<unknown>;
};

export interface DiscordClientSeam {
  login(token: string): Promise<unknown>;
  destroy(): void;
  once(event: "ready", listener: () => void): unknown;
  on(event: "messageCreate" | "shardResume" | "error", listener: (...args: any[]) => void): unknown;
  rest: DiscordRawRest;
}

/** Endpoint-specific Discord REST seam. Every operation retains its caller's AbortSignal. */
export interface DiscordRestSeam {
  fetchChannel(channelId: string, signal: AbortSignal): Promise<DiscordChannelData | null>;
  createProjectChannel(guildId: string, name: string, signal: AbortSignal): Promise<DiscordChannelData>;
  createMessage(channelId: string, content: string, signal: AbortSignal): Promise<DiscordMessageData>;
  startThread(channelId: string, messageId: string, name: string, signal: AbortSignal): Promise<DiscordChannelData>;
  editChannel(channelId: string, body: { name?: string; archived?: boolean }, signal: AbortSignal): Promise<void>;
  editMessage(channelId: string, messageId: string, content: string, signal: AbortSignal): Promise<void>;
}

class DiscordJsRest implements DiscordRestSeam {
  private readonly rest: DiscordRawRest;
  constructor(rest: DiscordRawRest) { this.rest = rest; }
  async fetchChannel(channelId: string, signal: AbortSignal): Promise<DiscordChannelData> {
    return await this.rest.get(Routes.channel(channelId), { signal }) as DiscordChannelData;
  }
  async createProjectChannel(guildId: string, name: string, signal: AbortSignal): Promise<DiscordChannelData> {
    return await this.rest.post(Routes.guildChannels(guildId), { body: { name, type: ChannelType.GuildText }, signal }) as DiscordChannelData;
  }
  async createMessage(channelId: string, content: string, signal: AbortSignal): Promise<DiscordMessageData> {
    return await this.rest.post(Routes.channelMessages(channelId), { body: { content, allowed_mentions: { parse: [] } }, signal }) as DiscordMessageData;
  }
  async startThread(channelId: string, messageId: string, name: string, signal: AbortSignal): Promise<DiscordChannelData> {
    return await this.rest.post(Routes.threads(channelId, messageId), { body: { name, auto_archive_duration: 1440 }, signal }) as DiscordChannelData;
  }
  async editChannel(channelId: string, body: { name?: string; archived?: boolean }, signal: AbortSignal): Promise<void> {
    await this.rest.patch(Routes.channel(channelId), { body, signal });
  }
  async editMessage(channelId: string, messageId: string, content: string, signal: AbortSignal): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), { body: { content, allowed_mentions: { parse: [] } }, signal });
  }
}

export interface DiscordRemoteOptions {
  createClient?: () => DiscordClientSeam;
  createRest?: (client: DiscordClientSeam) => DiscordRestSeam;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type Input = (threadId: string, text: string) => Promise<RemoteInputResult>;
export type RemoteInputResult = "sent" | "steer" | "follow-up" | "failed" | "historical" | "local-ui" | "stopped" | "idle" | "status";
type PresentationContent = { name: string; anchor: string; header: string };
type PendingPresentation = {
  session: Pick<RemoteSessionRouting, "threadId" | "anchorMessageId" | "headerMessageId">;
  content: PresentationContent;
  generation: number;
  signal: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
};

const isDiscordOrigin = (origin: TimelineEvent["origin"]): boolean => origin === "discord" || origin === "discord-steer" || origin === "discord-follow-up";
const isMissing = (error: unknown): boolean => !!error && typeof error === "object" && (((error as { code?: unknown }).code === 10003) || ((error as { status?: unknown }).status === 404));
const abortIfNeeded = (signal: AbortSignal): void => { if (signal.aborted) throw new DOMException("Remote binding aborted", "AbortError"); };
const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").slice(0, 90) || "project";
const presentationContent = (value: RemoteSessionPresentation): PresentationContent => {
  const state = value.status; const task = state.taskGoal ?? "No active Task";
  return {
    name: safeName(value.title),
    anchor: `PINDIE SESSION · ${value.title}\nTask · ${task}\nStatus · ${state.taskStatus}`.slice(0, 1_900),
    header: `PINDIE SESSION\n${value.title}\nProject · ${value.project}\nSession · ${value.sessionId}\nTask · ${state.taskStatus} · ${task}${state.activity ? `\nActivity · ${state.activity}` : ""}${state.verificationStatus ? `\nVerification · ${state.verificationStatus}` : ""}${state.elapsedMs !== null ? `\nElapsed · ${Math.floor(state.elapsedMs / 1_000)}s` : ""}${state.localUiPrompt ? "\nWAITING FOR LOCAL UI" : ""}`.slice(0, 1_900),
  };
};

/** Concrete Discord projection only. It owns neither Pi input semantics nor remote routing state. */
export class DiscordRemote implements RemoteSurface {
  readonly config: DiscordRemoteConfig;
  private client: DiscordClientSeam | null = null;
  private rest: DiscordRestSeam | null = null;
  private generation = 0;
  private lifecycleAbort = new AbortController();
  private onInput: Input | null = null;
  private onReady: (() => void) | null = null;
  private readonly pending = new Map<string, PendingPresentation>();
  private readonly deliveredPresentation = new Map<string, Partial<PresentationContent>>();
  private readonly setTimer: NonNullable<DiscordRemoteOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<DiscordRemoteOptions["clearTimer"]>;
  private readonly createClient: NonNullable<DiscordRemoteOptions["createClient"]>;
  private readonly createRest: NonNullable<DiscordRemoteOptions["createRest"]>;

  constructor(config: DiscordRemoteConfig, options: DiscordRemoteOptions = {}) {
    this.config = config;
    this.createClient = options.createClient ?? (() => new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] }) as unknown as DiscordClientSeam);
    this.createRest = options.createRest ?? ((client) => new DiscordJsRest(client.rest));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Starts only after a native Session binds. It is intentionally never awaited by extension startup. */
  async start(input: Input, ready: () => void = () => undefined, acceptsThread: (threadId: string) => boolean = () => true): Promise<void> {
    this.stop();
    const generation = ++this.generation; const client = this.createClient();
    this.lifecycleAbort = new AbortController();
    this.client = client; this.rest = this.createRest(client); this.onInput = input; this.onReady = ready;
    client.once("ready", () => { if (this.current(generation, client)) this.onReady?.(); });
    client.on("shardResume", () => { if (this.current(generation, client)) this.onReady?.(); });
    client.on("messageCreate", (message: DiscordMessage) => { void this.receive(generation, message, acceptsThread); });
    client.on("error", () => undefined);
    await client.login(this.config.token);
  }

  stop(): void {
    ++this.generation; this.lifecycleAbort.abort();
    for (const pending of this.pending.values()) if (pending.timer) this.clearTimer(pending.timer);
    this.pending.clear(); this.deliveredPresentation.clear(); this.onInput = null; this.onReady = null; this.rest = null;
    const client = this.client; this.client = null;
    try { client?.destroy(); } catch { /* optional transport cleanup */ }
  }

  async ensureProject(_projectId: string, name: string, existingChannelId: string | null, signal: AbortSignal): Promise<{ channelId: string; replaced?: boolean }> {
    const rest = this.requireRest(signal);
    if (existingChannelId) {
      try {
        const channel = await rest.fetchChannel(existingChannelId, signal); abortIfNeeded(signal);
        if (channel?.guild_id === this.config.guildId && channel.type === ChannelType.GuildText) return { channelId: channel.id };
        if (channel) return this.createProject(rest, name, true, signal);
      } catch (error) { if (!isMissing(error)) throw error; }
      return this.createProject(rest, name, true, signal);
    }
    return this.createProject(rest, name, false, signal);
  }

  async ensureSession(channelId: string, _sessionId: string, title: string, existing: RemoteSessionRouting | null, signal: AbortSignal): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }> {
    const rest = this.requireRest(signal);
    if (existing) {
      try {
        const thread = await rest.fetchChannel(existing.threadId, signal); abortIfNeeded(signal);
        if (thread?.guild_id === this.config.guildId && thread.parent_id === channelId && thread.type === ChannelType.PublicThread) {
          if (thread.thread_metadata?.archived) await rest.editChannel(thread.id, { archived: false }, signal);
          abortIfNeeded(signal);
          if (existing.headerMessageId === null) {
            const created = await rest.createMessage(thread.id, `PINDIE SESSION\n${title}`.slice(0, 1_900), signal); abortIfNeeded(signal);
            return { threadId: existing.threadId, anchorMessageId: existing.anchorMessageId, headerMessageId: created.id };
          }
          return { threadId: existing.threadId, anchorMessageId: existing.anchorMessageId, headerMessageId: existing.headerMessageId };
        }
        if (thread) return this.createSession(rest, channelId, title, true, signal);
      } catch (error) { if (!isMissing(error)) throw error; }
      return this.createSession(rest, channelId, title, true, signal);
    }
    return this.createSession(rest, channelId, title, false, signal);
  }

  async send(threadId: string, event: TimelineEvent, signal: AbortSignal): Promise<void> {
    if (event.kind === "user" && isDiscordOrigin(event.origin)) return;
    const rest = this.requireRest(signal); const thread = await rest.fetchChannel(threadId, signal); abortIfNeeded(signal);
    if (!thread || thread.guild_id !== this.config.guildId || thread.type !== ChannelType.PublicThread) throw new Error("Discord Session thread is unavailable.");
    await rest.createMessage(threadId, event.text, signal); abortIfNeeded(signal);
  }

  async updateSessionPresentation(session: Pick<RemoteSessionRouting, "threadId" | "anchorMessageId" | "headerMessageId">, presentation: RemoteSessionPresentation, signal: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const generation = this.generation; const content = presentationContent(presentation);
    const previous = this.deliveredPresentation.get(session.threadId);
    if (previous?.name === content.name && previous.anchor === content.anchor && previous.header === content.header) return;
    const pending = this.pending.get(session.threadId);
    if (pending && pending.generation === generation && pending.signal === signal && !signal.aborted) {
      pending.content = content; pending.session = session; return;
    }
    if (pending?.timer) this.clearTimer(pending.timer);
    const next: PendingPresentation = { session, content, generation, signal };
    next.timer = this.setTimer(() => { void this.flushPresentation(session.threadId); }, 200);
    this.pending.set(session.threadId, next);
  }

  async flushPresentation(threadId: string): Promise<void> {
    const pending = this.pending.get(threadId); if (!pending) return;
    this.pending.delete(threadId); if (pending.timer) this.clearTimer(pending.timer);
    if (pending.signal.aborted || pending.generation !== this.generation) return;
    const rest = this.rest; if (!rest) return;
    const delivered = { ...(this.deliveredPresentation.get(threadId) ?? {}) };
    try {
      const thread = await rest.fetchChannel(threadId, pending.signal); this.requirePendingCurrent(pending);
      if (!thread || thread.guild_id !== this.config.guildId || thread.type !== ChannelType.PublicThread || !thread.parent_id) return;
      if (delivered.name !== pending.content.name) {
        await rest.editChannel(threadId, { name: pending.content.name }, pending.signal); this.requirePendingCurrent(pending);
        delivered.name = pending.content.name; this.deliveredPresentation.set(threadId, { ...delivered });
      }
      if (delivered.anchor !== pending.content.anchor) {
        await rest.editMessage(thread.parent_id, pending.session.anchorMessageId, pending.content.anchor, pending.signal); this.requirePendingCurrent(pending);
        delivered.anchor = pending.content.anchor; this.deliveredPresentation.set(threadId, { ...delivered });
      }
      if (pending.session.headerMessageId && delivered.header !== pending.content.header) {
        await rest.editMessage(threadId, pending.session.headerMessageId, pending.content.header, pending.signal); this.requirePendingCurrent(pending);
        delivered.header = pending.content.header; this.deliveredPresentation.set(threadId, { ...delivered });
      }
    } catch {
      // Presentation edits are best effort; a later status update/reconnect retries them.
    }
  }

  private async receive(generation: number, message: DiscordMessage, acceptsThread: (threadId: string) => boolean): Promise<void> {
    if (generation !== this.generation || !this.onInput || message.guildId !== this.config.guildId || message.author.bot || message.author.id !== this.config.userId || message.channel.isThread?.() !== true || !acceptsThread(message.channelId) || !message.content.trim()) return;
    const outcome = await this.onInput(message.channelId, message.content).catch((): RemoteInputResult => "failed");
    const feedback = outcome === "steer" ? "Steering the active run." : outcome === "follow-up" ? "Queued after the active run." : outcome === "stopped" ? "Stopped." : outcome === "idle" ? "No active run." : outcome === "local-ui" ? "Waiting for local UI." : outcome === "failed" ? "Could not deliver to Pi." : outcome === "historical" ? "This Session is read-only." : null;
    const rest = this.rest;
    if (feedback && generation === this.generation && rest) await rest.createMessage(message.channelId, feedback, this.lifecycleAbort.signal).catch(() => undefined);
  }
  private requireRest(signal: AbortSignal): DiscordRestSeam { abortIfNeeded(signal); if (!this.rest) throw new Error("Discord Remote is not connected."); return this.rest; }
  private async createProject(rest: DiscordRestSeam, name: string, replaced: boolean, signal: AbortSignal): Promise<{ channelId: string; replaced?: boolean }> {
    const channel = await rest.createProjectChannel(this.config.guildId, safeName(name), signal); abortIfNeeded(signal);
    return { channelId: channel.id, replaced: replaced || undefined };
  }
  private async createSession(rest: DiscordRestSeam, channelId: string, title: string, replaced: boolean, signal: AbortSignal): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }> {
    const channel = await rest.fetchChannel(channelId, signal); abortIfNeeded(signal);
    if (!channel || channel.guild_id !== this.config.guildId || channel.type !== ChannelType.GuildText) throw new Error("Discord Project channel is unavailable.");
    const anchor = await rest.createMessage(channelId, `PINDIE SESSION · ${title}`.slice(0, 1_900), signal); abortIfNeeded(signal);
    const thread = await rest.startThread(channelId, anchor.id, safeName(title), signal); abortIfNeeded(signal);
    const head = await rest.createMessage(thread.id, `PINDIE SESSION\n${title}`.slice(0, 1_900), signal); abortIfNeeded(signal);
    return { threadId: thread.id, anchorMessageId: anchor.id, headerMessageId: head.id, replaced: replaced || undefined };
  }
  private requirePendingCurrent(pending: PendingPresentation): void {
    abortIfNeeded(pending.signal);
    if (pending.generation !== this.generation) throw new DOMException("Discord generation replaced", "AbortError");
  }
  private current(generation: number, client: DiscordClientSeam): boolean { return generation === this.generation && this.client === client; }
}
