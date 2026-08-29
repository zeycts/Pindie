import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteRoutingStore, type DiscordProjectRoutingV1, type RemoteSessionRouting } from "./remote-routing.ts";
import { ExecutionAggregator, mirrorEntry, splitTimelineEvent, type MirrorEntry, type PromptOrigin, type TimelineEvent } from "./session-mirror.ts";

export interface RemoteSurface {
  ensureProject(projectId: string, name: string, existingChannelId: string | null): Promise<{ channelId: string; replaced?: boolean }>;
  ensureSession(channelId: string, sessionId: string, title: string, existing: RemoteSessionRouting | null): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }>;
  send(threadId: string, event: TimelineEvent): Promise<void>;
  renameSession?(threadId: string, title: string): Promise<void>;
}
export interface RemotePi { sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void | Promise<void>; }
export interface RemoteCompanionOptions { routing?: RemoteRoutingStore; }

function firstPrompt(entries: MirrorEntry[]): string | undefined {
  return entries.find((entry) => entry.message?.role === "user")?.message?.content instanceof Array
    ? undefined
    : entries.find((entry) => entry.message?.role === "user")?.message?.content as string | undefined;
}
function titleFor(binding: { sessionId: string; sessionName?: string; taskGoal?: string }, prompt?: string): string {
  const value = binding.sessionName?.trim() || binding.taskGoal?.trim() || prompt?.split(/\r?\n/, 1)[0]?.trim() || `Session ${binding.sessionId.slice(0, 8)}`;
  return value.slice(0, 100);
}

/** Session-scoped Remote projection/control coordinator. It owns no transcript or Pi queue. */
export class RemoteCompanion {
  private readonly routing: RemoteRoutingStore;
  private readonly surface: RemoteSurface;
  private binding: { projectRoot: string; projectId: string; sessionId: string; ctx: ExtensionContext; generation: number; routing: DiscordProjectRoutingV1; sessionName?: string; taskGoal?: string } | null = null;
  /** Origins observed from Pi's public input event, in native input order. */
  private readonly origins: PromptOrigin[] = [];
  private dispatchingOrigin: PromptOrigin | null = null;
  private localUiPrompt = false;
  private chain = Promise.resolve();
  private readonly execution = new ExecutionAggregator();
  private readonly toolInputs = new Map<string, { name: string; input?: Record<string, unknown> }>();
  private readonly milestones = new Set<string>();
  private gates = new Set<string>();
  constructor(surface: RemoteSurface, options: RemoteCompanionOptions = {}) { this.surface = surface; this.routing = options.routing ?? new RemoteRoutingStore(); }

  async bind(projectRoot: string, guildId: string, sessionId: string, ctx: ExtensionContext, presentation: { sessionName?: string; taskGoal?: string } = {}): Promise<void> {
    const projectId = (await import("./store.ts")).getProjectId(projectRoot);
    const existing = await this.routing.load(projectRoot);
    const routing = existing && existing.guildId === guildId ? existing : { version: 1 as const, guildId, channelId: "", sessions: {} };
    this.localUiPrompt = false;
    this.origins.length = 0;
    this.gates.clear();
    this.milestones.clear();
    this.toolInputs.clear();
    this.binding = { projectRoot, projectId, sessionId, ctx, generation: (this.binding?.generation ?? 0) + 1, routing, ...presentation };
  }
  shutdown(ctx: ExtensionContext): void { if (this.binding?.ctx === ctx) { this.binding = null; this.localUiPrompt = false; this.origins.length = 0; this.gates.clear(); this.milestones.clear(); this.toolInputs.clear(); } }
  setLocalUiPrompt(active: boolean): void { this.localUiPrompt = active; }
  get activeSessionId(): string | null { return this.binding?.sessionId ?? null; }

  async catchUp(entries: MirrorEntry[]): Promise<void> {
    const binding = this.requireBinding();
    await this.serial(async () => {
      if (this.binding !== binding) return;
      const b = binding;
      const known = b.routing.sessions[b.sessionId];
      const cursor = known?.lastMirroredEntryId ?? null;
      const start = cursor === null ? 0 : entries.findIndex((entry) => entry.id === cursor) + 1;
      const unseen = entries.slice(Math.max(0, start));
      // Empty Sessions and hidden-only history have no meaningful remote event,
      // so they must not allocate a channel/thread merely by binding.
      if (!unseen.some((entry) => mirrorEntry(entry) !== null)) return;
      const session = await this.ensure(b, firstPrompt(unseen));
      // A replacement thread has no remote history: rebuild from authoritative
      // Pi entries rather than continuing at the old external cursor.
      const delivery = cursor !== null && session.lastMirroredEntryId === null ? entries : unseen;
      for (const entry of delivery) await this.deliver(b, session, entry);
    });
  }
  async project(entry: MirrorEntry): Promise<void> {
    if (mirrorEntry(entry) === null) return;
    const binding = this.requireBinding();
    await this.serial(async () => { if (this.binding !== binding) return; await this.deliver(binding, await this.ensure(binding), entry); });
  }
  /** Records Pi-native input provenance; extension labels only while this core is dispatching. */
  observeInput(source: "interactive" | "rpc" | "extension", streamingBehavior?: "steer" | "followUp"): void {
    if (source === "interactive") { this.origins.push("tui"); return; }
    if (source !== "extension" || this.dispatchingOrigin === null) { this.origins.push("neutral"); return; }
    const expected = this.dispatchingOrigin;
    const valid = (expected === "discord" && streamingBehavior === undefined) ||
      (expected === "discord-steer" && streamingBehavior === "steer") ||
      (expected === "discord-follow-up" && streamingBehavior === "followUp");
    this.origins.push(valid ? expected : "neutral");
  }
  recordToolStart(id: string, name: string, input?: Record<string, unknown>): void { this.toolInputs.set(id, { name, input }); }
  recordToolEnd(id: string, name: string, isError = false): void {
    const observed = this.toolInputs.get(id); this.toolInputs.delete(id);
    this.execution.record(name, observed?.input, isError);
  }
  recordTool(name: string, input?: Record<string, unknown>, isError = false): void { this.execution.record(name, input, isError); }
  async flushExecution(entryId: string): Promise<void> { const event = this.execution.flush(entryId); const binding = this.binding; if (event && binding) await this.serial(async () => { if (this.binding !== binding) return; const session = await this.ensure(binding); await this.surface.send(session.threadId, event); }); }
  async rename(title: string): Promise<void> { const binding = this.requireBinding(); await this.serial(async () => { if (this.binding !== binding) return; const session = await this.ensure(binding); await this.surface.renameSession?.(session.threadId, title); }); }
  async input(threadId: string, text: string, pi: RemotePi): Promise<"sent" | "historical" | "local-ui" | "stopped" | "idle" | "status"> {
    const b = this.binding; if (!b) return "historical"; const session = b.routing.sessions[b.sessionId];
    if (!session || session.threadId !== threadId) {
      const historical = Object.values(b.routing.sessions).find((candidate) => candidate.threadId === threadId);
      if (historical) await this.surface.send(historical.threadId, { entryId: "remote:historical", kind: "milestone", text: "This Session is read-only. Resume it from the local TUI first." });
      return "historical";
    }
    if (text === "!stop") { if (b.ctx.isIdle()) return "idle"; b.ctx.abort(); return "stopped"; }
    if (text === "!status") return "status";
    if (this.localUiPrompt) return "local-ui";
    const after = text.startsWith("!after "); const content = after ? text.slice(7).trim() : text;
    if (!content) return "sent";
    const origin: PromptOrigin = !b.ctx.isIdle() ? (after ? "discord-follow-up" : "discord-steer") : "discord";
    this.dispatchingOrigin = origin;
    try {
      await pi.sendUserMessage(content, b.ctx.isIdle() ? undefined : { deliverAs: after ? "followUp" : "steer" });
    } finally {
      this.dispatchingOrigin = null;
    }
    return "sent";
  }
  async milestone(key: string, text: string): Promise<void> {
    const binding = this.binding;
    if (!binding || this.milestones.has(key)) return;
    await this.serial(async () => {
      if (this.binding !== binding || this.milestones.has(key)) return;
      const session = await this.ensure(binding);
      await this.surface.send(session.threadId, { entryId: `remote:${key}`, kind: "milestone", text });
      this.milestones.add(key);
    });
  }
  humanGate(question: string, options: readonly string[] = []): TimelineEvent | null { const key = `${question}\0${options.join("\0")}`; if (this.gates.has(key)) return null; this.gates.add(key); return { entryId: `gate:${key}`, kind: "milestone", text: `HUMAN GATE\n${question}${options.length ? `\n${options.join(" · ")}` : ""}` }; }

  private async ensure(b: NonNullable<RemoteCompanion["binding"]>, prompt?: string): Promise<RemoteSessionRouting> {
    const channel = await this.surface.ensureProject(b.projectId, this.routing.projectName(b.projectRoot), b.routing.channelId || null);
    if (channel.replaced || channel.channelId !== b.routing.channelId) { b.routing.channelId = channel.channelId; if (channel.replaced) b.routing.sessions = {}; }
    const existing = b.routing.sessions[b.sessionId] ?? null;
    const created = await this.surface.ensureSession(b.routing.channelId, b.sessionId, titleFor(b, prompt), existing);
    let session: RemoteSessionRouting;
    if (!existing || created.replaced || created.threadId !== existing.threadId) {
      session = { threadId: created.threadId, anchorMessageId: created.anchorMessageId, headerMessageId: created.headerMessageId, lastMirroredEntryId: null };
      b.routing.sessions[b.sessionId] = session;
    } else session = existing;
    await this.routing.save(b.projectRoot, b.routing); return session;
  }
  private async deliver(b: NonNullable<RemoteCompanion["binding"]>, session: RemoteSessionRouting, entry: MirrorEntry): Promise<void> {
    const origin = entry.message?.role === "user" ? this.origins.shift() : undefined;
    const event = mirrorEntry(entry, origin); if (!event || entry.id === session.lastMirroredEntryId) return;
    for (const part of splitTimelineEvent(event)) await this.surface.send(session.threadId, part);
    session.lastMirroredEntryId = entry.id; await this.routing.save(b.projectRoot, b.routing);
  }
  private serial(operation: () => Promise<void>): Promise<void> { const next = this.chain.then(operation); this.chain = next.catch(() => undefined); return next; }
  private requireBinding() { if (!this.binding) throw new Error("Remote Companion has no live Session binding."); return this.binding; }
}
