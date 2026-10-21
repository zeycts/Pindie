import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { boundedGraphemeText } from "./bounded-text.ts";
import type { PindieControlMonitorState, PindieControlMonitorViewPort } from "./control-monitor.ts";
import { formatBlock } from "./timeline-text.ts";

/** A Pi-owned overlay component: no terminal, input listener, Session or protocol ownership. */
export class WatchComponent implements Component, PindieControlMonitorViewPort {
  private state: PindieControlMonitorState = { connection: "connecting", project: null, snapshot: null, timeline: null, message: null };
  private epoch: number | undefined;
  private stopped = false;
  private readonly scroll = new ScrollView({ render: (width) => this.timelineLines(width), invalidate() {} }, { follow: "end" });
  private readonly theme: Theme;
  private readonly rows: () => number;
  private readonly requestRender: () => void;
  private readonly exit: () => void;
  constructor(theme: Theme, rows: () => number, requestRender: () => void, exit: () => void) {
    this.theme = theme;
    this.rows = rows;
    this.requestRender = requestRender;
    this.exit = exit;
  }
  start(): void {}
  stop(): void { this.stopped = true; }
  dispose(): void { this.stop(); this.exit(); }
  apply(state: PindieControlMonitorState): void {
    if (this.stopped) return;
    if (state.epoch !== this.epoch) this.scroll.scrollToEnd();
    this.epoch = state.epoch;
    this.state = state;
    this.requestRender();
  }
  invalidate(): void { this.scroll.invalidate(); }
  private timelineLines(width: number): string[] {
    const blocks = this.state.timeline?.timeline.slice(-50) ?? [];
    return blocks.length
      ? blocks.flatMap((block) => boundedGraphemeText(formatBlock(block), width, 1_600, 12))
      : boundedGraphemeText(this.state.message ?? "Waiting for remote Control…", width, 400, 4);
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, Math.min(30, this.rows() - 2));
    const { state, theme } = this;
    const header = [
      theme.fg("accent", "Watch · Remote read-only · Esc/q back to LOCAL Pi chat"),
      `Remote Project: ${state.project ?? "—"} · ${state.connection.toUpperCase()}`,
      `Remote Session: ${state.snapshot?.session.displayIdentity ?? "—"} (${state.snapshot?.session.id ?? "—"})`,
    ];
    const gate = state.snapshot?.semantic.humanGate;
    const footer = [
      ...(gate ? [`HUMAN GATE · ${gate.kind}: ${gate.question}`, "Respond via ChatGPT / Pindie Control, not local chat."] : []),
      ...(state.message ? [state.message.replace(/\n/gu, " · ")] : []),
      `${state.timeline?.hasMoreBefore ? "Older blocks omitted · " : ""}${this.scroll.isFollowingEnd ? "LIVE" : "SCROLLED"} · j/k ↑↓ · PgUp/PgDn · G/End live`,
    ];
    // Keep exit/connection visible even in tiny terminals. All metadata is one bounded row.
    const top = header.slice(0, Math.max(1, height - 1));
    const bottom = footer.slice(0, Math.max(0, height - top.length - 1));
    const available = Math.max(0, height - top.length - bottom.length);
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, available, this.requestRender);
    const viewport = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + available);
    while (viewport.length < available) viewport.push("");
    return [...top, ...viewport, ...bottom].slice(0, height).map((line) => truncateToWidth(line.replace(/[\r\n]/gu, " "), width));
  }
  handleInput(data: string): void {
    if (this.stopped) return;
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.exit(); return; }
    if (data === "j" || matchesKey(data, Key.down)) this.scroll.scrollBy(1);
    else if (data === "k" || matchesKey(data, Key.up)) this.scroll.scrollBy(-1);
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (data === "G" || matchesKey(data, Key.end)) this.scroll.scrollToEnd();
    else return; // Never forward input to the local editor or remote Control.
    this.requestRender();
  }
}
