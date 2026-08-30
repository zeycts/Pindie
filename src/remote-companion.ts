import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RemoteRoutingStore, type DiscordProjectRoutingV1, type RemoteSessionRouting } from "./remote-routing.ts";
import { ExecutionAggregator, mirrorEntry, splitTimelineEvent, type MirrorEntry, type PromptOrigin, type TimelineEvent } from "./session-mirror.ts";

export interface RemoteStatusFacts {
  taskGoal: string | null;
  taskStatus: "idle" | "active" | "blocked" | "waiting_human" | "done";
  activity: string | null;
  verificationStatus: "pending" | "passed" | "failed" | "stale" | null;
  elapsedMs: number | null;
  semanticAuthority: "coherent" | "stale" | "unavailable";
  localUiPrompt: boolean;
}
export interface RemoteSessionPresentation {
  project: string;
  sessionId: string;
  title: string;
  status: RemoteStatusFacts;
}
export interface RemoteSurface {
  ensureProject(projectId: string, name: string, existingChannelId: string | null, signal: AbortSignal): Promise<{ channelId: string; replaced?: boolean }>;
  ensureSession(channelId: string, sessionId: string, title: string, existing: RemoteSessionRouting | null, signal: AbortSignal): Promise<Omit<RemoteSessionRouting, "lastMirroredEntryId"> & { replaced?: boolean }>;
  send(threadId: string, event: TimelineEvent, signal: AbortSignal): Promise<void>;
  /** One transport-independent seam for editing the existing anchor/header in place. */
  updateSessionPresentation(session: Pick<RemoteSessionRouting, "threadId" | "anchorMessageId" | "headerMessageId">, presentation: RemoteSessionPresentation, signal: AbortSignal): Promise<void>;
}
export interface RemotePi { sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void | Promise<void>; }
export interface RemoteCompanionOptions { routing?: RemoteRoutingStore; }

type Binding = {
  projectRoot: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  ctx: ExtensionContext;
  generation: number;
  routing: DiscordProjectRoutingV1;
  sessionName?: string;
  sessionPrompt?: string;
  taskGoal?: string;
  status: RemoteStatusFacts;
  taskCompleted: boolean;
  completionPending: boolean;
  getStatus?: () => RemoteStatusFacts;
  abortController: AbortController;
};

const EMPTY_STATUS: RemoteStatusFacts = {
  taskGoal: null,
  taskStatus: "idle",
  activity: null,
  verificationStatus: null,
  elapsedMs: null,
  semanticAuthority: "coherent",
  localUiPrompt: false,
};

function firstPrompt(entries: MirrorEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n")
        : "";
    if (text.trim()) return text;
  }
  return undefined;
}
function titleFor(binding: Pick<Binding, "sessionId" | "sessionName" | "sessionPrompt" | "taskGoal" | "status">): string {
  const activeTaskGoal = ["active", "blocked", "waiting_human"].includes(binding.status.taskStatus) ? binding.taskGoal?.trim() : undefined;
  const value = binding.sessionName?.trim() || binding.sessionPrompt?.split(/\r?\n/, 1)[0]?.trim() || activeTaskGoal || `Session ${binding.sessionId.slice(0, 8)}`;
  return value.slice(0, 100);
}

/** Session-scoped Remote projection/control coordinator. It owns no transcript or Pi queue. */
export class RemoteCompanion {
  private readonly routing: RemoteRoutingStore;
  private readonly surface: RemoteSurface;
  private binding: Binding | null = null;
  private generation = 0;
  /** Origins observed from Pi's public input event, in native input order. */
  private readonly origins: PromptOrigin[] = [];
  private dispatchingOrigin: PromptOrigin | null = null;
  private chain = Promise.resolve();
  private readonly execution = new ExecutionAggregator();
  private readonly toolInputs = new Map<string, { name: string; input?: Record<string, unknown> }>();
  private readonly milestones = new Set<string>();
  constructor(surface: RemoteSurface, options: RemoteCompanionOptions = {}) { this.surface = surface; this.routing = options.routing ?? new RemoteRoutingStore(); }

  async bind(projectRoot: string, guildId: string, sessionId: string, ctx: ExtensionContext, presentation: { sessionName?: string; taskGoal?: string; status?: RemoteStatusFacts; getStatus?: () => RemoteStatusFacts } = {}): Promise<void> {
    const generation = ++this.generation;
    this.binding?.abortController.abort();
    this.binding = null;
    this.origins.length = 0;
    this.milestones.clear();
    this.toolInputs.clear();
    try {
      const projectId = (await import("./store.ts")).getProjectId(projectRoot);
      const existing = await this.routing.load(projectRoot);
      const routing = existing && existing.guildId === guildId ? existing : { version: 1 as const, guildId, channelId: "", sessions: {} };
      let status = presentation.status ?? EMPTY_STATUS;
      try { status = presentation.getStatus?.() ?? status; } catch { /* best-effort projection */ }
      this.binding = {
        projectRoot,
        projectId,
        projectName: this.routing.projectName(projectRoot),
        sessionId,
        ctx,
        generation,
        routing,
        ...presentation,
        status,
        taskCompleted: status.taskStatus === "done",
        completionPending: false,
        abortController: new AbortController(),
      };
    } catch {
      // Remote routing is optional I/O. A failed bind leaves no stale live context.
    }
  }
  shutdown(ctx: ExtensionContext): boolean {
    if (this.binding?.ctx !== ctx) return false;
    this.binding.abortController.abort(); this.binding = null; this.origins.length = 0; this.milestones.clear(); this.toolInputs.clear();
    return true;
  }
  setLocalUiPrompt(active: boolean): void {
    const binding = this.binding;
    if (!binding) return;
    binding.status = { ...binding.status, localUiPrompt: active };
  }
  get activeSessionId(): string | null { return this.binding?.sessionId ?? null; }
  /** External transports may accept input only from an already mapped Session thread. */
  isMappedThread(threadId: string): boolean {
    const binding = this.binding;
    return !!binding && Object.values(binding.routing.sessions).some((session) => session.threadId === threadId);
  }

  async catchUp(entries: MirrorEntry[]): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    await this.serial(async () => {
      if (this.binding !== binding) return;
      binding.sessionPrompt ??= firstPrompt(entries);
      const known = binding.routing.sessions[binding.sessionId];
      const cursor = known?.lastMirroredEntryId ?? null;
      const cursorIndex = cursor === null ? -1 : entries.findIndex((entry) => entry.id === cursor);
      const unseen = entries.slice(cursor === null ? 0 : Math.max(0, cursorIndex + 1));
      if (!known && !unseen.some((entry) => mirrorEntry(entry) !== null)) return;
      const session = await this.ensure(binding);
      if (!unseen.some((entry) => mirrorEntry(entry) !== null) && session.lastMirroredEntryId !== null) return;
      const delivery = cursor !== null && session.lastMirroredEntryId === null ? entries : unseen;
      for (const entry of delivery) await this.deliver(binding, session, entry);
    });
  }
  async project(entry: MirrorEntry): Promise<void> {
    if (mirrorEntry(entry) === null) return;
    const binding = this.binding;
    if (!binding) return;
    await this.serial(async () => { if (this.binding === binding) await this.deliver(binding, await this.ensure(binding), entry); });
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
  async flushExecution(entryId: string): Promise<void> {
    const event = this.execution.flush(entryId); const binding = this.binding;
    if (event && binding) await this.serial(async () => { if (this.binding === binding) await this.surface.send((await this.ensure(binding)).threadId, event, binding.abortController.signal); });
  }
  async status(status: RemoteStatusFacts): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    this.applyStatus(binding, status);
    const session = binding.routing.sessions[binding.sessionId];
    if (session) await this.serial(async () => { if (this.binding === binding) await this.updatePresentation(binding, session); });
  }
  async rename(title: string): Promise<void> {
    const binding = this.binding;
    if (!binding) return;
    binding.sessionName = title;
    const session = binding.routing.sessions[binding.sessionId];
    if (session) await this.serial(async () => { if (this.binding === binding) await this.updatePresentation(binding, session); });
  }
  async input(threadId: string, text: string, pi: RemotePi): Promise<"sent" | "steer" | "follow-up" | "failed" | "historical" | "local-ui" | "stopped" | "idle" | "status"> {
    const b = this.binding; if (!b) return "historical"; const session = b.routing.sessions[b.sessionId];
    if (!session || session.threadId !== threadId) {
      const historical = Object.entries(b.routing.sessions).find(([, candidate]) => candidate.threadId === threadId);
      if (!historical) return "historical";
      const [historicalSessionId, historicalRouting] = historical;
      if (text === "!status") {
        await this.serial(async () => {
          this.requireCurrent(b);
          await this.surface.send(historicalRouting.threadId, {
            entryId: `remote:historical-status:${historicalSessionId}`,
            kind: "milestone",
            text: `HISTORICAL SESSION\nSession ID · ${historicalSessionId}\nThread ID · ${historicalRouting.threadId}\nRead-only · Resume from the local TUI for live status.`,
          }, b.abortController.signal);
          this.requireCurrent(b);
        });
        return "status";
      }
      await this.serial(async () => {
        this.requireCurrent(b);
        await this.surface.send(historicalRouting.threadId, { entryId: "remote:historical", kind: "milestone", text: "This Session is read-only. Resume it from the local TUI first." }, b.abortController.signal);
        this.requireCurrent(b);
      });
      return "historical";
    }
    if (text === "!stop") { if (b.ctx.isIdle()) return "idle"; b.ctx.abort(); return "stopped"; }
    if (text === "!status") {
      this.refreshStatus(b);
      await this.serial(async () => { if (this.binding === b) await this.updatePresentation(b, session); });
      return "status";
    }
    if (b.status.localUiPrompt) return "local-ui";
    const after = text.startsWith("!after "); const content = after ? text.slice(7).trim() : text;
    if (!content) return "sent";
    const origin: PromptOrigin = !b.ctx.isIdle() ? (after ? "discord-follow-up" : "discord-steer") : "discord";
    this.dispatchingOrigin = origin;
    try {
      await pi.sendUserMessage(content, b.ctx.isIdle() ? undefined : { deliverAs: after ? "followUp" : "steer" });
    } catch {
      return "failed";
    } finally {
      this.dispatchingOrigin = null;
    }
    return origin === "discord-steer" ? "steer" : origin === "discord-follow-up" ? "follow-up" : "sent";
  }
  async milestone(key: string, text: string): Promise<void> {
    const binding = this.binding;
    if (!binding || this.milestones.has(key)) return;
    await this.serial(async () => {
      if (this.binding !== binding || this.milestones.has(key)) return;
      const session = await this.ensure(binding);
      await this.surface.send(session.threadId, { entryId: `remote:${key}`, kind: "milestone", text }, binding.abortController.signal);
      this.requireCurrent(binding);
      this.milestones.add(key);
    });
  }
  async settleCompletion(): Promise<void> {
    const binding = this.binding;
    if (!binding?.completionPending) return;
    await this.serial(async () => {
      if (this.binding !== binding || !binding.completionPending) return;
      const session = await this.ensure(binding);
      await this.surface.send(session.threadId, { entryId: "remote:completion:settled", kind: "milestone", text: "TASK COMPLETED" }, binding.abortController.signal);
      this.requireCurrent(binding);
      binding.completionPending = false;
    });
  }
  humanGate(question: string, options: readonly string[] = []): TimelineEvent {
    const key = `${question}\0${options.join("\0")}`;
    return { entryId: `gate:${key}`, kind: "milestone", text: `HUMAN GATE\n${question}${options.length ? `\n${options.join(" · ")}` : ""}` };
  }

  private async ensure(b: Binding): Promise<RemoteSessionRouting> {
    this.requireCurrent(b);
    this.refreshStatus(b);
    const channel = await this.surface.ensureProject(b.projectId, b.projectName, b.routing.channelId || null, b.abortController.signal);
    this.requireCurrent(b);
    if (channel.replaced || channel.channelId !== b.routing.channelId) { b.routing.channelId = channel.channelId; if (channel.replaced) b.routing.sessions = {}; }
    const existing = b.routing.sessions[b.sessionId] ?? null;
    const created = await this.surface.ensureSession(b.routing.channelId, b.sessionId, titleFor(b), existing, b.abortController.signal);
    this.requireCurrent(b);
    let session: RemoteSessionRouting;
    if (!existing || created.replaced || created.threadId !== existing.threadId || created.anchorMessageId !== existing.anchorMessageId || created.headerMessageId !== existing.headerMessageId) {
      session = { threadId: created.threadId, anchorMessageId: created.anchorMessageId, headerMessageId: created.headerMessageId, lastMirroredEntryId: null };
      b.routing.sessions[b.sessionId] = session;
    } else session = existing;
    await this.routing.save(b.projectRoot, b.routing);
    this.requireCurrent(b);
    await this.updatePresentation(b, session);
    this.requireCurrent(b);
    return session;
  }
  private applyStatus(binding: Binding, status: RemoteStatusFacts): void {
    const wasCompleted = binding.taskCompleted;
    binding.status = { ...status, localUiPrompt: binding.status.localUiPrompt };
    binding.taskGoal = status.taskGoal ?? undefined;
    binding.taskCompleted = status.taskStatus === "done";
    if (!wasCompleted && binding.taskCompleted) binding.completionPending = true;
  }
  private refreshStatus(binding: Binding): void {
    try {
      const status = binding.getStatus?.();
      if (status) this.applyStatus(binding, status);
    } catch {
      // Status projection is optional presentation and never semantic authority.
    }
  }
  private async updatePresentation(b: Binding, session: RemoteSessionRouting): Promise<void> {
    this.requireCurrent(b);
    await this.surface.updateSessionPresentation(session, {
      project: b.projectName,
      sessionId: b.sessionId,
      title: titleFor(b),
      status: b.status,
    }, b.abortController.signal);
    this.requireCurrent(b);
  }
  private async deliver(b: Binding, session: RemoteSessionRouting, entry: MirrorEntry): Promise<void> {
    this.requireCurrent(b);
    const origin = entry.message?.role === "user" ? this.origins.shift() : undefined;
    const event = mirrorEntry(entry, origin); if (!event || entry.id === session.lastMirroredEntryId) return;
    for (const part of splitTimelineEvent(event)) {
      this.requireCurrent(b);
      await this.surface.send(session.threadId, part, b.abortController.signal);
      this.requireCurrent(b);
    }
    session.lastMirroredEntryId = entry.id;
    await this.routing.save(b.projectRoot, b.routing);
    this.requireCurrent(b);
  }
  private requireCurrent(binding: Binding): void {
    if (this.binding !== binding || this.binding.generation !== binding.generation) {
      throw new Error("Remote Session binding was replaced.");
    }
  }
  /** Every Remote/routing/transport failure is contained here; the chain still retries later work. */
  private serial(operation: () => Promise<void>): Promise<void> {
    const attempted = this.chain.then(operation);
    this.chain = attempted.catch(() => undefined);
    return this.chain;
  }
}
