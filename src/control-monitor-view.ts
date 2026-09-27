import { Container, Key, matchesKey, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { formatBlock } from "./tui/view.ts";
import { boundedGraphemeText } from "./tui/bounded-text.ts";
import type { PindieControlMonitorState, PindieControlMonitorViewPort } from "./control-monitor.ts";

class MonitorBlockText implements Component {
  private readonly text: string;
  constructor(block: Parameters<typeof formatBlock>[0]) { this.text = formatBlock(block); }
  render(width: number): string[] { return boundedGraphemeText(this.text, Math.max(1, width - 2), 1_600, 12).map((line) => ` ${line} `); }
  invalidate(): void {}
}

class MutableText implements Component {
  private text: string;
  constructor(text = "") { this.text = text; }
  set(text: string): void { this.text = text; }
  render(width: number): string[] { return new Text(this.text, 0, 0).render(width); }
  invalidate(): void {}
}

export interface PindieControlMonitorViewOptions { readonly terminal?: Terminal; readonly onExit: () => void }

/** Dedicated read-only terminal window: header, projected timeline, and status only. */
export class PindieControlMonitorView implements PindieControlMonitorViewPort {
  private readonly tui: TUI;
  private readonly header = new MutableText("Pindie Monitor");
  private readonly blocks = new Container();
  private readonly scroll: ScrollView;
  private readonly footer = new MutableText("CONNECTING · q quit · j/k scroll · G follow live");
  private readonly onExit: () => void;
  private readonly removeInput: () => void;
  private started = false;
  private state: PindieControlMonitorState | null = null;
  private epoch = "";

  constructor(options: PindieControlMonitorViewOptions) {
    this.onExit = options.onExit;
    this.scroll = new ScrollView(this.blocks, { follow: "end", primary: true, overscroll: "contain" });
    const tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal());
    this.tui = tui;
    tui.setLayoutRoot(new VStack([
      { component: this.header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      { component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.footer, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
    ]));
    this.removeInput = tui.addInputListener((data) => this.handleInput(data));
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    this.tui.start();
    this.tui.requestRender(true);
  }
  apply(state: PindieControlMonitorState): void {
    const nextEpoch = state.epoch === undefined ? `${state.project ?? ""}\0${state.snapshot?.session.id ?? ""}` : String(state.epoch);
    const reset = nextEpoch !== this.epoch;
    this.epoch = nextEpoch;
    this.state = state;
    const model = state.snapshot?.executionConfig.model?.modelId ?? "model unavailable";
    const thinking = state.snapshot?.executionConfig.thinkingLevel ?? "";
    this.header.set(`Pindie Monitor · ${state.project ?? "No active project"}    ${state.connection.toUpperCase()}${state.timeline?.hasMoreBefore ? " · Older timeline blocks omitted" : ""}\nSession · ${state.snapshot?.session.displayIdentity ?? "—"}\n${model}${thinking ? ` · ${thinking}` : ""}`);
    this.blocks.clear();
    if (state.timeline) {
      for (const block of state.timeline.timeline) this.blocks.addChild(new MonitorBlockText(block));
    } else if (state.message) this.blocks.addChild(new Text(state.message, 1, 0));
    const snapshot = state.snapshot;
    const gate = snapshot?.semantic.humanGate;
    const status = snapshot
      ? `${snapshot.runtime.idle ? "IDLE" : "RUNNING"} · Task ${snapshot.semantic.taskStatus ?? "unavailable"} · Verify ${snapshot.semantic.verificationProgress ? `${snapshot.semantic.verificationProgress.covered}/${snapshot.semantic.verificationProgress.total}` : snapshot.semantic.verificationStatus ?? "—"}\nrev ${snapshot.revision} · pending ${snapshot.runtime.pendingMessageCount} · automaticWorkSettled ${snapshot.runtime.automaticWorkSettled}`
      : state.connection.toUpperCase();
    this.footer.set(gate
      ? `HUMAN GATE · ${gate.kind.toUpperCase()}\n${gate.question}\nRespond from ChatGPT / Pindie Control. This monitor is read-only.\n${status}\nq quit · j/k scroll · G follow live`
      : `${state.message ?? status}\nq quit · j/k / arrows scroll · PageUp/PageDown · End/G follow live`);
    if (reset) this.scroll.scrollToEnd();
    this.requestRender();
  }
  stop(): void {
    this.removeInput();
    if (!this.started) return;
    this.started = false;
    this.tui.stop();
  }
  private requestRender(): void { if (this.started) this.tui.requestRender(); }
  private handleInput(data: string): { consume?: boolean } | undefined {
    if (data === "q" || data === "\u0003" || matchesKey(data, Key.ctrl("c"))) { this.onExit(); return { consume: true }; }
    if (data === "j" || matchesKey(data, Key.down)) this.scroll.scrollBy(1);
    else if (data === "k" || matchesKey(data, Key.up)) this.scroll.scrollBy(-1);
    else if (matchesKey(data, Key.pageDown)) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, Key.pageUp)) this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
    else if (data === "G" || matchesKey(data, Key.end)) this.scroll.scrollToEnd();
    else return undefined;
    this.requestRender();
    return { consume: true };
  }
  /** Test seam exposing only read-only presentation state. */
  getRenderedState(): PindieControlMonitorState | null { return this.state; }
  /** Test seam for the public ScrollView behavior. */
  getScrollView(): ScrollView { return this.scroll; }
}
