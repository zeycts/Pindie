import { stripVTControlCharacters } from "node:util";
import { boundedGraphemeText } from "./bounded-text.ts";
import type { PindieControlMonitorState } from "./control-monitor.ts";
import type { UiTimelineBlock } from "./ui-projection.ts";
import { formatBlock } from "./timeline-text.ts";
import { groupWatchActivity, watchBlockFailed, type WatchFeedItem, type WatchEventItem, type WatchFeedId } from "./watch-activity-grouping.ts";

/** Remote strings are data, never terminal instructions (including bidi controls). */
export function watchText(text: string): string {
  return stripVTControlCharacters(text.slice(0, 16_384)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "").replace(/[\r\n\t]/gu, " ");
}
export interface WatchRow { readonly id: WatchFeedId; readonly offset: number }

/** Ephemeral view state only. No independent Task/Session/status truth or storage. */
export class WatchViewModel {
  state: PindieControlMonitorState = { connection: "connecting", project: null, snapshot: null, timeline: null, message: null };
  blocks: readonly UiTimelineBlock[] = [];
  feed: readonly WatchFeedItem[] = [];
  selected: WatchFeedId | null = null;
  /** Exactly the selectable/painted headers; details share their owner's ID. */
  displayed(): WatchFeedItem[] {
    return this.feed.flatMap((item) => item.kind === "group" && this.expanded.has(item.id) ? [item, ...item.children] : [item]);
  }
  readonly expanded = new Set<WatchFeedId>();
  live = true;
  anchor: WatchRow | null = null;
  private binding: string | null = null;
  private lastConnectionError: string | null = null;

  apply(state: PindieControlMonitorState): boolean {
    // A reconnect epoch is not a new Session. A project/Session replacement is.
    const binding = state.snapshot ? `${state.project}\0${state.snapshot.session.id}` : null;
    const reset = binding !== this.binding;
    this.binding = binding;
    this.state = state;
    if (state.connection === "disconnected" || state.connection === "incompatible") this.lastConnectionError = state.message ?? state.connection;
    else if (state.connection !== "connecting") this.lastConnectionError = null;
    this.blocks = state.timeline?.sessionId === state.snapshot?.session.id ? state.timeline?.timeline.slice(-50) ?? [] : [];
    const previous = this.feed;
    this.feed = groupWatchActivity(this.blocks);
    if (reset) { this.expanded.clear(); this.anchor = null; this.live = true; }
    const events = (feed: readonly WatchFeedItem[]): WatchEventItem[] => feed.flatMap((item) => item.kind === "group" ? item.children : [item]);
    const ids = new Set([...this.feed.map((item) => item.id), ...events(this.feed).map((item) => item.id)]);
    // An expanded old group must not silently hide its surviving children on re-chunk/eviction.
    const visibleChildren = new Set(previous.flatMap((item) => item.kind === "group"
      ? this.expanded.has(item.id) ? item.children.map((child) => child.id) : []
      : this.expanded.has(item.id) || (!this.live && (item.id === this.selected || item.id === this.anchor?.id)) ? [item.id] : []));
    for (const item of this.feed) if (item.kind === "group" && item.children.some((child) => visibleChildren.has(child.id))) this.expanded.add(item.id);
    for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
    const normalize = (id: WatchFeedId | null): WatchFeedId | null => {
      if (!id) return null;
      const old = previous.find((item) => item.id === id);
      const candidates = old?.kind === "group" ? [id, ...old.children.map((child) => child.id)] : [id];
      for (const candidate of candidates) {
        for (const item of this.feed) {
          if (item.id === candidate) return candidate;
          if (item.kind === "group" && item.children.some((child) => child.id === candidate)) return this.expanded.has(item.id) ? candidate : item.id;
        }
      }
      return this.displayed()[0]?.id ?? null;
    };
    this.selected = this.live ? this.feed.at(-1)?.id ?? null : normalize(this.selected);
    if (!this.selected) this.selected = this.feed.at(-1)?.id ?? null;
    if (this.anchor) {
      const id = normalize(this.anchor.id);
      this.anchor = id ? { id, offset: id === this.anchor.id ? this.anchor.offset : 0 } : null;
    }
    return reset;
  }
  navigate(delta: number): void {
    const displayed = this.displayed();
    const index = displayed.findIndex((item) => item.id === this.selected);
    this.selected = displayed[Math.max(0, Math.min(displayed.length - 1, index + delta))]?.id ?? null;
    this.live = false;
  }
  toggle(): void {
    if (!this.selected) return;
    if (!this.expanded.delete(this.selected)) this.expanded.add(this.selected);
    this.live = false;
  }
  follow(): void { this.live = true; this.selected = this.feed.at(-1)?.id ?? null; this.anchor = null; }
  historicalOutcome(): UiTimelineBlock | null {
    if (this.state.connection !== "connected" || this.state.timeline?.sessionId !== this.state.snapshot?.session.id) return null;
    return [...this.blocks].reverse().find((block) => watchBlockFailed(block) ||
      (block.type === "semantic" && block.lifecycle === "complete" &&
        (block.category === "completion" || block.category === "verification"))) ?? null;
  }
  header(width = 120): string[] {
    const { state } = this;
    const snapshot = state.snapshot;
    const fresh = state.connection === "connected" && snapshot !== null;
    const matching = !state.timeline || state.timeline.sessionId === snapshot?.session.id;
    const semantic = fresh && matching && snapshot.semantic.authority === "coherent" ? snapshot.semantic : null;
    const progress = semantic?.verificationProgress;
    const runtime = fresh ? snapshot.runtime : null;
    // Never infer Task completion from idle. Settled is a separate runtime fact.
    const activity = runtime ? !runtime.idle ? "running" : runtime.pendingMessageCount > 0 ? "pending" : runtime.automaticWorkSettled ? "settled" : "idle · automatic work unsettled" : "unavailable";
    const text = (value: string, columns: number) => boundedGraphemeText(watchText(value.slice(0, 2_048)), columns, 240, 1)[0]!;
    const task = semantic
      ? `Task: ${semantic.taskStatus ?? "none"} · Verify: ${semantic.verificationStatus ?? "none"}${progress ? ` ${progress.covered}/${progress.total}` : ""}${semantic.taskGoal ? ` · ${text(semantic.taskGoal, 60)}` : ""}`
      : "Task state stale · current outcome unconfirmed";
    const outcome = this.historicalOutcome();
    const history = outcome ? `${watchBlockFailed(outcome) ? "FAILURE · " : ""}${text(formatBlock(outcome, "compact"), 100)}` : "No recorded outcome in visible history";
    return [
      `Watch · Remote read-only · ${state.connection.toUpperCase()} · Esc/q back`,
      // displayIdentity may be the first raw prompt; no separately exposed native name exists.
      `Remote Project: ${text(state.project ?? "unavailable", 24)} · Remote Session: ${text(snapshot?.session.id.slice(0, 8) ?? "unavailable", 16)}`,
      `Current status · ${task}`,
      `Runtime: ${activity} · Model: ${text(fresh ? snapshot.executionConfig.model?.modelId ?? "unavailable" : "unavailable", 40)} · thinking: ${fresh ? snapshot.executionConfig.thinkingLevel : "unavailable"}`,
      `Last recorded outcome (history) · visible tail only · ${history}`,
    ].map((line) => text(line, Math.max(1, width)));
  }
  alerts(): string[] {
    const gate = this.state.snapshot?.semantic.humanGate;
    return [
      ...(gate ? [`HUMAN GATE${this.state.connection === "connected" && this.state.snapshot?.semantic.authority === "coherent" ? "" : " (last observed)"} · ${gate.kind}: ${gate.question}`, "Respond via ChatGPT / Pindie Control, not local chat."] : []),
      ...(this.state.message ? [this.state.message] : this.lastConnectionError ? [`Last connection error: ${this.lastConnectionError}`] : []),
      ...(this.state.timeline && this.state.timeline.sessionId !== this.state.snapshot?.session.id ? ["Timeline Session mismatch · awaiting fresh data"] : []),
    ];
  }
}
