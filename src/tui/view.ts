import { basename } from "node:path";

import {
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  type Terminal,
  type TUI,
  VStack,
} from "@earendil-works/pi-tui";

import {
  commandText,
  toolPath,
} from "../ui-timeline.ts";
import type {
  PindieUiProjection,
  UiMessageBlock,
  UiObservationItem,
  UiObservationWorkBlock,
  UiRuntimeBlock,
  UiSemanticBlock,
  UiTimelineBlock,
  UiToolWorkBlock,
  UiWorkBlock,
} from "../ui-projection.ts";

export interface PindieTuiViewPort {
  start(): void;
  stop(): void;
  apply(projection: PindieUiProjection): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  clearEditor(): void;
  showNotice(message: string): void;
  requestRender(): void;
}

export interface PindieTuiViewOptions {
  readonly terminal?: Terminal;
  readonly startupNotices?: readonly string[];
  readonly onSubmit?: (text: string) => void;
  readonly onFollowUp?: (text: string) => void;
  readonly onAbort?: () => void;
  readonly onExit?: () => void;
}

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatBlock(block: UiTimelineBlock): string {
  switch (block.type) {
    case "message":
      return formatMessageBlock(block);
    case "work":
      return formatWorkBlock(block);
    case "semantic":
      return formatSemanticBlock(block);
    case "runtime":
      return formatRuntimeBlock(block);
  }
}

function formatMessageBlock(block: UiMessageBlock): string {
  const role = block.role === "user"
    ? `user${block.delivery === undefined ? "" : ` · ${block.delivery}`}`
    : block.role;
  return `${block.source === "live" ? "●" : "○"} ${role}\n${block.text}`;
}

function workMarker(lifecycle: UiWorkBlock["lifecycle"]): string {
  return lifecycle === "running" ? "●" : lifecycle === "failed" ? "✕" : "✓";
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function plural(count: number, singular: string, pluralName = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralName}`;
}

function observationSummary(block: UiObservationWorkBlock): string {
  const counts = new Map<string, number>();
  for (const item of block.items) {
    counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
  }
  const parts: string[] = [];
  const read = counts.get("read") ?? 0;
  const grep = (counts.get("grep") ?? 0) + (counts.get("web_search") ?? 0) +
    (counts.get("url_context") ?? 0);
  const find = counts.get("find") ?? 0;
  const ls = counts.get("ls") ?? 0;
  const git = counts.get("pindie_git_observe") ?? 0;
  if (read > 0) parts.push(`Read ${plural(read, "file")}`);
  if (grep > 0) parts.push(`Searched ${plural(grep, "pattern")}`);
  if (find > 0) parts.push(`Found ${plural(find, "pattern")}`);
  if (ls > 0) parts.push(`Listed ${plural(ls, "directory", "directories")}`);
  if (git > 0) parts.push(`Checked ${plural(git, "Git action")}`);
  return parts.join(" · ") || plural(block.items.length, "observation");
}

function formatObservationItem(item: UiObservationItem): string {
  const marker = item.lifecycle === "failed" ? "✕" : item.lifecycle === "complete" ? "✓" : "●";
  const detail = item.result?.summary.trim();
  return `${marker} ${item.label}${detail ? `\n${indent(detail)}` : ""}`;
}

function formatObservationBlock(block: UiObservationWorkBlock): string {
  const marker = workMarker(block.lifecycle);
  if (block.defaultDisplayMode === "compact") {
    return `${marker} ${block.title}\n${indent(observationSummary(block))}`;
  }
  if (block.defaultDisplayMode === "preview") {
    const items = block.items.map((item) => {
      const summary = item.result?.summary.trim();
      return summary === undefined || summary.length === 0
        ? item.label
        : `${item.label}\n${indent(summary)}`;
    });
    return `${marker} ${block.title}\n${items.map(indent).join("\n")}`;
  }
  return `${marker} ${block.title}\n${block.items.map(formatObservationItem).map(indent).join("\n")}`;
}

function formatInputPreview(block: UiToolWorkBlock): string | null {
  if (block.kind === "command") return commandText(block.input);
  if (block.kind === "edit") return toolPath(block.input);
  if (block.input === null) return null;
  try {
    const value = JSON.stringify(block.input);
    return value === undefined ? null : value.length > 400 ? `${value.slice(0, 399)}…` : value;
  } catch {
    return null;
  }
}

function formatToolWorkBlock(block: UiToolWorkBlock): string {
  const primary = `${workMarker(block.lifecycle)} ${block.title}`;
  if (block.defaultDisplayMode === "compact") return primary;

  const lines = [primary];
  const input = formatInputPreview(block);
  if (input !== null && !(block.kind === "command" && block.title.includes(input))) {
    lines.push(indent(input));
  }
  const summary = block.result?.summary.trim();
  if (summary !== undefined && summary.length > 0) lines.push(indent(summary));
  return lines.join("\n");
}

function formatWorkBlock(block: UiWorkBlock): string {
  return block.kind === "observation"
    ? formatObservationBlock(block)
    : formatToolWorkBlock(block);
}

function formatSemanticBlock(block: UiSemanticBlock): string {
  return `◇ ${block.title}${block.detail ? `\n${block.detail}` : ""}`;
}

function formatRuntimeBlock(block: UiRuntimeBlock): string {
  return `· ${block.title}${block.detail ? `\n${block.detail}` : ""}`;
}

function projectLabel(projectRoot: string | null): string {
  if (projectRoot === null || projectRoot.length === 0) return "project unavailable";
  return basename(projectRoot) || projectRoot;
}

function formatHeader(projection: PindieUiProjection): string {
  const { header } = projection;
  const model = header.model === null
    ? "model unavailable"
    : `${header.model.provider}/${header.model.modelId}`;
  const task = header.taskStatus ?? "no task";
  return [
    `Pindie · ${projectLabel(header.projectRoot)} · ${header.displayIdentity}`,
    `${model} · ${header.thinkingLevel} · task ${task} · authority ${header.semanticAuthority}`,
  ].join("\n");
}

function formatStatus(projection: PindieUiProjection): string {
  const { status } = projection;
  const parts = [status.isIdle ? "idle" : status.isCompacting ? "compacting" : "running"];
  if (status.activity !== null) parts.push(status.activity);
  if (status.consumption !== null) {
    parts.push(formatDuration(status.consumption.durationMs));
    parts.push(`$${status.consumption.cost.toFixed(2)}`);
  }
  if (status.verificationProgress !== null) {
    parts.push(`verify ${status.verificationProgress.covered}/${status.verificationProgress.total}`);
  }
  if (status.quotaResumeWaiting !== null) parts.push("waiting · quota");
  if (status.pendingMessageCount > 0) parts.push(`queued ${status.pendingMessageCount}`);
  if (status.presentationAvailability === "unavailable" ||
      status.semanticAuthority === "unavailable" ||
      status.semanticAuthority === "presentation-unavailable") {
    parts.push("semantic unavailable");
  }
  return `Status · ${parts.join(" · ")}`;
}

function formatAttention(projection: PindieUiProjection): string | null {
  const attention = projection.attention;
  if (attention === null) return null;
  if (attention.kind === "human-gate") return `Decision required: ${attention.question}`;
  return `Semantic authority unavailable: ${attention.reason}`;
}

/**
 * Small Pindie-owned view over public pi-tui primitives.
 *
 * This class only renders the supplied projection and reports gestures. It has
 * no runtime, Session, semantic State, or queue ownership.
 */
export class PindieTuiView implements PindieTuiViewPort {
  private readonly tui: TUI;
  private readonly header: Text;
  private readonly timeline: Container;
  private readonly composer: VStack;
  private readonly editor: Editor;
  private readonly status: Text;
  private readonly startupNotices: readonly string[];
  private readonly onSubmit?: (text: string) => void;
  private readonly onFollowUp?: (text: string) => void;
  private readonly onAbort?: () => void;
  private readonly onExit?: () => void;
  private attention: string | null = null;
  private notice: string | null = null;
  private started = false;
  private removeInputListener: (() => void) | null = null;

  constructor(options: PindieTuiViewOptions = {}) {
    const terminal = options.terminal ?? new ProcessTerminal();
    const tui = new TuiAltScreen(terminal);
    this.tui = tui;
    this.header = new Text("Pindie", 1, 0);
    this.timeline = new Container();
    const timelineScroll = new ScrollView(this.timeline, {
      follow: "end",
      primary: true,
      overscroll: "chain",
    });
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.composer = new VStack([
      new Text("Composer", 1, 0),
      this.editor,
    ]);
    this.status = new Text("Status · idle", 1, 0);
    const layout = new VStack([
      { component: this.header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      { component: timelineScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.composer, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      { component: this.status, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
    ]);
    tui.setLayoutRoot(layout);

    this.startupNotices = [...(options.startupNotices ?? [])];
    this.onSubmit = options.onSubmit;
    this.onFollowUp = options.onFollowUp;
    this.onAbort = options.onAbort;
    this.onExit = options.onExit;
    this.editor.onSubmit = (text) => this.onSubmit?.(text);
    this.removeInputListener = tui.addInputListener((data) => {
      // These are deliberately temporary Slice D shell bindings. Slice F's
      // Action Registry will replace this isolated direct-key path.
      if (matchesKey(data, Key.alt("u"))) {
        this.onFollowUp?.(this.editor.getExpandedText());
        return { consume: true };
      }
      if (matchesKey(data, Key.escape)) {
        // Escape is always consumed so it cannot exit the application or fall
        // through to a renderer scroll/search action. The controller decides
        // whether an active native Run exists.
        this.onAbort?.();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        if (this.editor.getExpandedText().length === 0) this.onExit?.();
        return { consume: true };
      }
      return undefined;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tui.setFocus(this.editor);
    this.tui.start();
    // The first normal frame may be throttled behind the TUI render interval;
    // force the initial projection onto the terminal before accepting input.
    this.tui.requestRender(true);
  }

  stop(): void {
    this.removeInputListener?.();
    this.removeInputListener = null;
    if (!this.started) return;
    this.started = false;
    this.tui.stop();
  }

  apply(projection: PindieUiProjection): void {
    this.header.setText(formatHeader(projection));
    this.status.setText(formatStatus(projection));

    this.timeline.clear();
    this.timeline.addChild(new Text("Timeline", 1, 0));
    for (const notice of this.startupNotices) {
      this.timeline.addChild(new Text(`Notice · ${notice}`, 1, 0));
    }
    for (const block of projection.timeline) {
      this.timeline.addChild(new Text(formatBlock(block), 1, 0));
      this.timeline.addChild(new Text("", 0, 0));
    }

    this.attention = formatAttention(projection);
    this.renderComposer();
    this.requestRender();
  }

  getEditorText(): string {
    return this.editor.getExpandedText();
  }

  setEditorText(text: string): void {
    this.editor.setText(text);
    this.requestRender();
  }

  clearEditor(): void {
    this.setEditorText("");
  }

  showNotice(message: string): void {
    this.notice = message;
    this.renderComposer();
    this.requestRender();
  }

  private renderComposer(): void {
    this.composer.clear();
    this.composer.addChild(new Text("Composer", 1, 0));
    if (this.attention !== null) this.composer.addChild(new Text(this.attention, 1, 0));
    if (this.notice !== null) this.composer.addChild(new Text(`Notice · ${this.notice}`, 1, 0));
    this.composer.addChild(this.editor);
  }

  requestRender(): void {
    if (this.started) this.tui.requestRender();
  }
}
