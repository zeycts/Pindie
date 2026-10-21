import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, truncateToWidth, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { boundedGraphemeText } from "./bounded-text.ts";
import type { PindieControlMonitorState, PindieControlMonitorViewPort } from "./control-monitor.ts";
import { formatBlock } from "./timeline-text.ts";
import { watchNativeComponents } from "./watch-native-presentation.ts";
import { WatchViewModel, watchText, type WatchRow } from "./watch-view-model.ts";

/** Pi owns the overlay. The private ScrollView is position state, NOT a mounted layout
 * child: this adapter slices exactly once, so fullscreen cannot double-scroll it. */
export class WatchComponent implements Component, PindieControlMonitorViewPort {
  readonly view = new WatchViewModel();
  private stopped = false;
  private readonly scroll = new ScrollView({ render: (width) => this.timelineLines(width), invalidate() {} });
  private rowMap: WatchRow[] = [];
  private feedTop = 0;
  private feedHeight = 0;
  private revealSelection = false;
  private readonly nativeCache = new Map<string, { version: string; components: ReturnType<typeof watchNativeComponents> }>();
  private readonly theme: Theme;
  private readonly rows: () => number;
  private readonly requestRender: () => void;
  private readonly exit: () => void;
  private readonly tui?: TUI;
  constructor(theme: Theme, rows: () => number, requestRender: () => void, exit: () => void, tui?: TUI) {
    this.theme = theme; this.rows = rows; this.requestRender = requestRender; this.exit = exit; this.tui = tui;
  }
  start(): void {}
  stop(): void { this.stopped = true; this.nativeCache.clear(); }
  dispose(): void { this.stop(); this.exit(); }
  apply(state: PindieControlMonitorState): void {
    if (this.stopped) return;
    this.captureAnchor();
    if (this.view.apply(state)) { this.rowMap = []; this.nativeCache.clear(); }
    for (const id of this.nativeCache.keys()) if (!this.view.expanded.has(id)) this.nativeCache.delete(id);
    this.requestRender();
  }
  invalidate(): void { this.nativeCache.clear(); this.scroll.invalidate(); }
  private captureAnchor(): void {
    if (!this.view.live) this.view.anchor = this.rowMap[this.scroll.scrollTop] ?? this.view.anchor;
  }
  private timelineLines(width: number): string[] {
    this.rowMap = [];
    const lines: string[] = [];
    for (const block of this.view.blocks) {
      const expanded = this.view.expanded.has(block.id);
      // Collapsed titles use the verified compact formatter, not native setExpanded(false).
      const title = boundedGraphemeText(watchText(formatBlock(block, "compact")), Math.max(1, width - 2), 240, 1)[0]!;
      const eventLines = [`${block.id === this.view.selected ? ">" : " "}${expanded ? "−" : "+"}${title}`];
      if (expanded) {
        let cached = this.nativeCache.get(block.id);
        const version = JSON.stringify(block);
        if (!cached || cached.version !== version) {
          cached = { version, components: this.tui ? watchNativeComponents(block, this.tui) : null };
          this.nativeCache.set(block.id, cached);
        }
        if (cached.components) {
          const native = cached.components.flatMap((component) => component.render(width));
          eventLines.push("Native Pi · bounded projected text excerpt", ...native.slice(0, 160),
            ...(native.length > 160 ? ["[Watch row cap · remaining excerpt omitted]"] : []));
        } else {
          eventLines.push(`[${block.type === "work" ? "Fallback · " : ""}bounded preview · not complete logs]`,
            ...boundedGraphemeText(formatBlock(block, "preview").split("\n").map(watchText).join("\n"), width, 1_600, 12));
        }
      }
      for (let offset = 0; offset < eventLines.length; offset++) this.rowMap.push({ id: block.id, offset });
      lines.push(...eventLines);
    }
    return lines.length ? lines : ["Waiting for remote timeline…"];
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, this.rows() - 2);
    this.captureAnchor();
    const header = this.view.header();
    const alerts = this.view.alerts();
    const legend = `${this.view.live ? "LIVE" : "SCROLLED"} · ↑↓ j/k select · Enter toggle · PgUp/Dn · G/End live · q back${this.view.state.timeline?.hasMoreBefore ? " · older omitted" : ""}`;
    // Under severe height pressure alerts outrank metadata. Tiny terminals cannot
    // display all facts; retain connection/exit and the first alert before feed.
    const top = [header[0]!, ...alerts, ...header.slice(1)].slice(0, Math.max(1, height - 2));
    this.feedTop = top.length;
    this.feedHeight = Math.max(0, height - top.length - 1);
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, this.feedHeight, this.requestRender);
    if (this.view.live) this.scroll.scrollToEnd();
    else {
      const anchor = this.view.anchor;
      if (anchor) {
        const start = this.rowMap.findIndex((row) => row.id === anchor.id);
        if (start >= 0) {
          const count = this.rowMap.filter((row) => row.id === anchor.id).length;
          this.scroll.scrollTo(start + Math.min(anchor.offset, count - 1), { disableFollow: true });
        } else this.scroll.scrollTo(0, { disableFollow: true }); // bounded tail evicted the anchor
      }
      if (this.revealSelection) {
        const selected = this.rowMap.findIndex((row) => row.id === this.view.selected);
        if (selected >= 0 && (selected < this.scroll.scrollTop || selected >= this.scroll.scrollTop + this.feedHeight)) {
          this.scroll.scrollTo(selected < this.scroll.scrollTop ? selected : selected - this.feedHeight + 1, { disableFollow: true });
        }
      }
    }
    this.revealSelection = false;
    this.captureAnchor();
    const viewport = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.feedHeight);
    while (viewport.length < this.feedHeight) viewport.push("");
    return [...top.map(watchText), ...viewport, legend].slice(0, height).map((line, index) => {
      const fitted = truncateToWidth(line, width);
      return index === 0 ? this.theme.fg("accent", fitted) : fitted;
    });
  }
  private scrollBy(delta: number): void {
    this.view.live = false;
    this.scroll.scrollBy(delta);
    this.captureAnchor();
    this.requestRender();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.stopped || event.type !== "wheel") return undefined;
    const inside = !Number.isFinite(event.y) || (event.y >= this.feedTop && event.y < this.feedTop + this.feedHeight);
    if (inside && Number.isFinite(event.wheelDelta)) this.scrollBy(event.wheelDelta!);
    // Even header/footer wheels must suppress Pi's underlying transcript fallback.
    return { handled: true, render: inside };
  }
  handleInput(data: string): void {
    if (this.stopped) return;
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.exit(); return; }
    if (data === "j" || matchesKey(data, Key.down)) { this.view.navigate(1); this.revealSelection = true; }
    else if (data === "k" || matchesKey(data, Key.up)) { this.view.navigate(-1); this.revealSelection = true; }
    else if (matchesKey(data, Key.enter)) {
      this.view.toggle();
      if (this.view.selected && !this.view.expanded.has(this.view.selected)) this.nativeCache.delete(this.view.selected);
      this.revealSelection = true;
    }
    else if (matchesKey(data, Key.pageDown)) { this.scrollBy(Math.max(1, this.scroll.viewportHeight)); return; }
    else if (matchesKey(data, Key.pageUp)) { this.scrollBy(-Math.max(1, this.scroll.viewportHeight)); return; }
    else if (data === "G" || matchesKey(data, Key.end)) this.view.follow();
    else return;
    this.requestRender();
  }
}
