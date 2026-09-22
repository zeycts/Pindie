import { basename } from "node:path";

import {
  copyToClipboard,
  type TerminalInputHandler,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  SelectList,
  Text,
  TuiAltScreen,
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type Terminal,
  type TUI,
  VStack,
} from "@earendil-works/pi-tui";

import {
  contextualHintActions,
  isPindieActionAvailable,
  paletteActions,
  resolveActionForInput,
  shouldConsumePindieInput,
  type PindieActionAvailability,
  type PindieActionDefinition,
  type PindieActionId,
  type PindieInteractionState,
  type PindieOverlayKind,
} from "./actions.ts";
import {
  commandText,
  toolPath,
} from "../ui-timeline.ts";
import type { PindieExtensionUIViewPort } from "./extension-ui.ts";
import type {
  PindieUiProjection,
  UiAttentionProjection,
  UiDisplayMode,
  UiMessageBlock,
  UiObservationItem,
  UiObservationWorkBlock,
  UiRuntimeBlock,
  UiSemanticBlock,
  UiTimelineBlock,
  UiToolWorkBlock,
  UiWorkBlock,
} from "../ui-projection.ts";

export interface PindieTuiViewPort extends PindieExtensionUIViewPort {
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
  readonly onAttentionResponse?: (text: string) => void;
  readonly onAbort?: () => void;
  readonly onExit?: () => void;
  readonly copyText?: (text: string) => Promise<void>;
}

export interface PindieTuiInteractionSnapshot {
  readonly focusMode: "composer" | "timeline" | "attention";
  readonly selectedBlockId: string | null;
  readonly foldOverrides: ReadonlyMap<string, UiDisplayMode>;
  readonly activeOverlay: PindieOverlayKind | null;
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

function firstMeaningfulLine(value: string): string {
  const line = value
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0) ?? "";
  if (line.length <= 120) return line;
  return `${line.slice(0, 119)}…`;
}

function compactPreview(value: string): string {
  const preview = firstMeaningfulLine(value);
  if (preview.length === 0) return "(empty)";
  const meaningfulLines = value.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return meaningfulLines.length > 1 && !preview.endsWith("…") ? `${preview}…` : preview;
}

function formatBlockWithMode(block: UiTimelineBlock, displayMode: UiDisplayMode): string {
  switch (block.type) {
    case "message":
      return formatMessageBlock(block, displayMode);
    case "work":
      return formatWorkBlock(block, displayMode);
    case "semantic":
      return formatSemanticBlock(block, displayMode);
    case "runtime":
      return formatRuntimeBlock(block, displayMode);
  }
}

/** Format a block using the supplied effective density without mutating it. */
export function formatBlock(
  block: UiTimelineBlock,
  displayMode = block.defaultDisplayMode,
): string {
  return formatBlockWithMode(block, displayMode);
}

function formatMessageBlock(
  block: UiMessageBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const role = block.role === "user"
    ? `user${block.delivery === undefined ? "" : ` · ${block.delivery}`}`
    : block.role;
  const marker = block.source === "live" ? "●" : "○";
  if (displayMode === "compact") {
    return `${marker} ${role} · ${compactPreview(block.text)}`;
  }
  return `${marker} ${role}\n${block.text}`;
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

function formatObservationBlock(
  block: UiObservationWorkBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const marker = workMarker(block.lifecycle);
  if (displayMode === "compact") {
    return `${marker} ${block.title}\n${indent(observationSummary(block))}`;
  }
  if (displayMode === "preview") {
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

function formatToolWorkBlock(
  block: UiToolWorkBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const primary = `${workMarker(block.lifecycle)} ${block.title}`;
  if (displayMode === "compact") return primary;

  const lines = [primary];
  const input = formatInputPreview(block);
  if (input !== null && !(block.kind === "command" && block.title.includes(input))) {
    lines.push(indent(input));
  }
  const summary = block.result?.summary.trim();
  if (summary !== undefined && summary.length > 0) lines.push(indent(summary));
  return lines.join("\n");
}

function formatWorkBlock(
  block: UiWorkBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  return block.kind === "observation"
    ? formatObservationBlock(block, displayMode)
    : formatToolWorkBlock(block, displayMode);
}

function semanticMarker(block: UiSemanticBlock): string {
  if (block.lifecycle === "running") return "●";
  if (block.lifecycle === "failed") return "✕";
  switch (block.category) {
    case "task": return "◇";
    case "verification":
      return block.verificationStatus === "passed" ? "✓" : "●";
    case "human-gate":
      return block.state === "open" ? "◆" : "✓";
    case "completion": return "✓";
  }
}

function taskHeading(block: Extract<UiSemanticBlock, { category: "task" }>): string {
  if (block.lifecycle === "running") return "Updating Task";
  if (block.lifecycle === "failed") return "Task update failed";
  if (block.handoff !== null) return "Task handoff staged";
  if (block.taskStatus === "blocked") return "Task · blocked";
  if (block.taskStatus === "waiting_human") return "Task · waiting for human";
  return "Task";
}

function formatTaskSemanticBlock(
  block: Extract<UiSemanticBlock, { category: "task" }>,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  if (displayMode === "compact") {
    const status = block.taskStatus === "blocked" ? "blocked · " : "";
    return `${semanticMarker(block)} ${status}Task · ${compactPreview(block.goal ?? "Task")}`;
  }

  const lines = [`${semanticMarker(block)} ${taskHeading(block)}`];
  if (block.goal !== null) lines.push(indent(block.goal));
  if (block.blockers.length > 0) {
    lines.push("", "Blocked", ...block.blockers.map(indent));
  }
  if (block.questions.length > 0) {
    lines.push("", "Question", ...block.questions.map(indent));
  }
  if (block.handoff !== null) {
    lines.push("", indent(block.handoff.progressSummary));
    if (block.handoff.nextIntent !== null) {
      lines.push(indent(`Next: ${block.handoff.nextIntent}`));
    }
  } else if (block.nextIntent !== null && block.lifecycle !== "failed") {
    lines.push("", indent(`Next: ${block.nextIntent}`));
  }
  if (block.error !== null) lines.push("", indent(block.error));
  return lines.join("\n");
}

function verificationHeading(
  block: Extract<UiSemanticBlock, { category: "verification" }>,
): string {
  const progress = block.totalCriteria === null
    ? ""
    : ` · ${block.coveredCriteria.length}/${block.totalCriteria}`;
  const failed = block.checks.filter((check) => check.status === "failed").length;
  const failureSuffix = failed > 0 ? ` · ${failed} failed` : "";
  return `Verification${failureSuffix}${progress}`;
}

function formatVerificationSemanticBlock(
  block: Extract<UiSemanticBlock, { category: "verification" }>,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const lines = [`${semanticMarker(block)} ${verificationHeading(block)}`];
  if (displayMode === "compact") return lines[0]!;
  const checks = displayMode === "preview" && block.pendingCheck !== null
    ? [block.pendingCheck]
    : block.checks;
  for (const check of checks) {
    const marker = check.status === "failed" ? "✕" : "✓";
    lines.push(indent(`${marker} ${check.name}`));
    if (check.status === "failed" && check.evidence.length > 0) {
      lines.push(indent(indent(check.evidence)));
    }
  }
  if (block.error !== null) lines.push("", indent(block.error));
  return lines.join("\n");
}

function formatHumanGateSemanticBlock(
  block: Extract<UiSemanticBlock, { category: "human-gate" }>,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const heading = block.lifecycle === "running"
    ? "Opening decision"
    : block.lifecycle === "failed"
      ? "Decision failed"
      : block.state === "resolved" ? "Decision resolved" : "Decision required";
  if (displayMode === "compact") {
    return `${semanticMarker(block)} ${heading} · ${compactPreview(block.question ?? "")}`;
  }
  const lines = [`${semanticMarker(block)} ${heading}`];
  if (block.question !== null) lines.push(indent(block.question));
  if (block.options.length > 0 && block.state === "open") {
    lines.push("", ...block.options.map(indent));
  }
  if (block.error !== null) lines.push("", indent(block.error));
  return lines.join("\n");
}

function formatCompletionSemanticBlock(
  block: Extract<UiSemanticBlock, { category: "completion" }>,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  const heading = block.lifecycle === "running"
    ? "Completing Task"
    : block.lifecycle === "failed" ? "Completion failed" : "Completed";
  if (displayMode === "compact") {
    return `${semanticMarker(block)} ${heading} · ${compactPreview(block.summary)}`;
  }
  const lines = [`${semanticMarker(block)} ${heading}`, indent(block.summary)];
  if (block.checks.length > 0) {
    lines.push("", "Verification");
    for (const check of block.checks) {
      const marker = check.status === "failed" ? "✕" : "✓";
      lines.push(indent(`${marker} ${check.name}`));
    }
  }
  if (block.error !== null) lines.push("", indent(block.error));
  return lines.join("\n");
}

function formatSemanticBlock(
  block: UiSemanticBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  switch (block.category) {
    case "task": return formatTaskSemanticBlock(block, displayMode);
    case "verification": return formatVerificationSemanticBlock(block, displayMode);
    case "human-gate": return formatHumanGateSemanticBlock(block, displayMode);
    case "completion": return formatCompletionSemanticBlock(block, displayMode);
  }
}

function formatRuntimeBlock(
  block: UiRuntimeBlock,
  displayMode: UiDisplayMode = block.defaultDisplayMode,
): string {
  return displayMode === "compact"
    ? `· ${block.title}`
    : `· ${block.title}${block.detail ? `\n${block.detail}` : ""}`;
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

function formatStatus(
  projection: PindieUiProjection,
  hints: readonly PindieActionDefinition[],
): string {
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
  const hintText = hints.map((action) => {
    const key = action.keys[0]?.label ?? "";
    return key.length === 0 ? action.label : `${key} ${action.label}`;
  });
  return hintText.length === 0
    ? `Status · ${parts.join(" · ")}`
    : `Status · ${parts.join(" · ")}\nHints · ${hintText.join(" · ")}`;
}

function attentionIdentity(attention: UiAttentionProjection | null): string | null {
  if (attention === null) return null;
  return attention.kind === "authority-unavailable"
    ? `authority-unavailable\u0000${attention.reason}`
    : [attention.kind, attention.gateKind, attention.question, ...(attention.options ?? [])].join("\u0000");
}

function gateOptions(attention: UiAttentionProjection | null): readonly string[] {
  if (attention?.kind !== "human-gate") return [];
  if (attention.options !== undefined && attention.options.length > 0) return attention.options;
  return attention.gateKind === "approval" ? ["Approve", "Reject"] : [];
}

function blockTitle(block: UiTimelineBlock): string {
  switch (block.type) {
    case "message": return block.role;
    case "work": return block.kind;
    case "semantic": return block.category;
    case "runtime": return block.category;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BASE_TERMINAL_TITLE = "Pindie";

/**
 * Overlay content is rendered outside the main pi-tui layout tree. This small
 * public-API adapter gives a ScrollView the bounded viewport it would receive
 * in the main layout, then returns only the visible slice.
 */
class BlockViewerOverlay implements Component {
  private readonly title: Text;
  private readonly maxHeight: number;
  private readonly scroll: ScrollView;
  private readonly requestRender: () => void;

  constructor(
    title: string,
    scroll: ScrollView,
    maxHeight: number,
    requestRender: () => void,
  ) {
    this.title = new Text(title, 1, 0);
    this.maxHeight = Math.max(2, maxHeight);
    this.scroll = scroll;
    this.requestRender = requestRender;
  }

  render(width: number): string[] {
    const titleLines = this.title.render(width);
    const contentLines = this.scroll.render(width);
    const viewportHeight = Math.max(
      1,
      Math.min(contentLines.length, this.maxHeight - titleLines.length),
    );
    this.scroll.updateLayout(contentLines.length, viewportHeight, this.requestRender);
    return [
      ...titleLines,
      ...contentLines.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewportHeight),
    ];
  }

  invalidate(): void {
    this.title.invalidate();
    this.scroll.invalidate();
  }
}

class ExtensionSelectOverlay extends VStack {
  private readonly title: string;
  private readonly description: string | undefined;
  private readonly options: readonly string[];
  private readonly select: (value: string) => void;
  private readonly cancel: () => void;
  private selectedIndex = 0;

  constructor(title: string, options: readonly string[], select: (value: string) => void, cancel: () => void, description?: string) {
    super();
    this.title = title;
    this.description = description;
    this.options = options;
    this.select = select;
    this.cancel = cancel;
    this.rebuild();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
    else if (matchesKey(data, Key.enter) || data === "\n") {
      const value = this.options[this.selectedIndex];
      if (value !== undefined) this.select(value);
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    this.addChild(new Text(this.title, 1, 0));
    if (this.description !== undefined) this.addChild(new Text(this.description, 1, 0));
    this.addChild(new Text(this.options.map((option, index) => `${index === this.selectedIndex ? "›" : " "} ${option}`).join("\n"), 1, 0));
    this.addChild(new Text("↑↓/jk navigate · Enter select · Esc cancel", 1, 0));
  }
}

class ExtensionInputOverlay extends VStack implements Focusable {
  private readonly input: Input;
  private readonly cancel: () => void;
  private _focused = false;

  constructor(title: string, placeholder: string | undefined, submit: (value: string) => void, cancel: () => void) {
    const input = new Input({ placeholder });
    input.onSubmit = submit;
    super([new Text(title, 1, 0), input, new Text("Enter submit · Esc cancel", 1, 0)]);
    this.input = input;
    this.cancel = cancel;
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.cancel();
    else this.input.handleInput(data);
  }
}

class ExtensionEditorOverlay extends VStack implements Focusable {
  private readonly editor: Editor;
  private readonly cancel: () => void;
  private _focused = false;

  constructor(tui: TUI, title: string, prefill: string | undefined, submit: (value: string) => void, cancel: () => void) {
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    editor.setText(prefill ?? "");
    editor.onSubmit = submit;
    super([
      new Text(title, 1, 0),
      editor,
      new Text("Enter submit · Shift+Enter newline · Esc cancel", 1, 0),
    ]);
    this.editor = editor;
    this.cancel = cancel;
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.cancel();
    else this.editor.handleInput(data);
  }
}

interface BlockLineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Small Pindie-owned view over public pi-tui primitives.
 *
 * The projection remains authoritative for facts. Focus, selection, scrolling,
 * fold overrides, draft, and overlays are ephemeral UI-local interaction state.
 */
export class PindieTuiView implements PindieTuiViewPort {
  private readonly tui: TUI;
  private readonly header: Text;
  private readonly timelineContent: Container;
  private readonly timelineScroll: ScrollView;
  private readonly inputRegion: VStack;
  private readonly editor: Editor;
  private readonly attentionEditor: Editor;
  private readonly status: Text;
  private readonly startupNotices: readonly string[];
  private readonly onSubmit?: (text: string) => void;
  private readonly onFollowUp?: (text: string) => void;
  private readonly onAttentionResponse?: (text: string) => void;
  private readonly onAbort?: () => void;
  private readonly onExit?: () => void;
  private readonly copyText: (text: string) => Promise<void>;
  private notice: string | null = null;
  private started = false;
  private removeInputListener: (() => void) | null = null;
  private projection: PindieUiProjection | null = null;
  private currentSessionId: string | null = null;
  private focusMode: "composer" | "timeline" | "attention" = "composer";
  private selectedBlockId: string | null = null;
  private attentionSelectedIndex = 0;
  private attentionResponseDraft = "";
  private attentionIdentity: string | null = null;
  private readonly foldOverrides = new Map<string, UiDisplayMode>();
  private activeOverlay: PindieOverlayKind | null = null;
  private overlayHandle: OverlayHandle | null = null;
  private readonly blockLineRanges = new Map<string, BlockLineRange>();
  private palettePanel: VStack | null = null;
  private paletteInput: Input | null = null;
  private paletteList: SelectList | null = null;
  private paletteQuery = "";
  private viewerBlockId: string | null = null;
  private viewerContent: Container | null = null;
  private viewerScroll: ScrollView | null = null;
  private extensionDialogComponent: (Component & { dispose?(): void }) | null = null;
  private extensionDialogCancel: (() => void) | null = null;
  private readonly extensionTerminalHandlers = new Set<TerminalInputHandler>();
  private readonly extensionStatuses = new Map<string, string>();
  private workingMessage: string | undefined;
  private workingVisible = true;
  private workingIndicator: WorkingIndicatorOptions | undefined;
  private hiddenThinkingLabel: string | undefined;

  constructor(options: PindieTuiViewOptions = {}) {
    const terminal = options.terminal ?? new ProcessTerminal();
    const tui = new TuiAltScreen(terminal);
    this.tui = tui;
    this.header = new Text("Pindie", 1, 0);
    this.timelineContent = new Container();
    this.timelineScroll = new ScrollView(this.timelineContent, {
      follow: "end",
      primary: true,
      overscroll: "chain",
    });
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.attentionEditor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.inputRegion = new VStack([
      new Text("Composer", 1, 0),
      this.editor,
    ]);
    this.status = new Text("Status · idle", 1, 0);
    const layout = new VStack([
      { component: this.header, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      { component: this.timelineScroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: this.inputRegion, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
      { component: this.status, basis: "auto", grow: 0, shrink: 0, minSize: 1 },
    ]);
    tui.setLayoutRoot(layout);

    this.startupNotices = [...(options.startupNotices ?? [])];
    this.onSubmit = options.onSubmit;
    this.onFollowUp = options.onFollowUp;
    this.onAttentionResponse = options.onAttentionResponse;
    this.onAbort = options.onAbort;
    this.onExit = options.onExit;
    this.copyText = options.copyText ?? copyToClipboard;
    this.editor.onSubmit = (text) => this.onSubmit?.(text);
    this.removeInputListener = tui.addInputListener((data) => this.handleInput(data));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.restoreLogicalFocus();
    this.tui.start();
    // The first normal frame may be throttled behind the TUI render interval;
    // force the initial projection onto the terminal before accepting input.
    this.tui.requestRender(true);
  }

  stop(): void {
    this.removeInputListener?.();
    this.removeInputListener = null;
    this.closeOverlay();
    if (!this.started) return;
    this.started = false;
    this.tui.stop();
  }

  apply(projection: PindieUiProjection): void {
    const sessionChanged = this.currentSessionId !== null &&
      this.currentSessionId !== projection.header.sessionId;
    const previousProjection = this.projection;
    const previousAttention = previousProjection?.attention ?? null;
    const nextAttentionIdentity = attentionIdentity(projection.attention);
    const attentionChanged = this.attentionIdentity !== nextAttentionIdentity;
    if (sessionChanged) {
      this.closeOverlay();
      this.selectedBlockId = null;
      this.foldOverrides.clear();
      this.resetAttentionMechanics();
    } else if (attentionChanged) {
      this.resetAttentionMechanics();
    }

    const humanGateAppeared = previousAttention?.kind !== "human-gate" &&
      projection.attention?.kind === "human-gate";
    if (sessionChanged) this.closeOverlay();
    else if (humanGateAppeared) this.closeLowerPriorityOverlay();
    if (sessionChanged) {
      this.focusMode = projection.attention === null ? "composer" : "attention";
    } else if (projection.attention !== null && (attentionChanged || this.focusMode === "composer")) {
      this.focusMode = "attention";
    } else if (projection.attention === null && previousAttention !== null) {
      this.focusMode = "composer";
    }

    const nextIds = new Set(projection.timeline.map((block) => block.id));
    if (this.selectedBlockId !== null && !nextIds.has(this.selectedBlockId)) {
      const previousIndex = previousProjection?.timeline.findIndex((block) =>
        block.id === this.selectedBlockId) ?? -1;
      const replacementIndex = previousIndex < 0
        ? projection.timeline.length - 1
        : Math.min(previousIndex, projection.timeline.length - 1);
      this.selectedBlockId = projection.timeline[replacementIndex]?.id ?? null;
    }
    for (const id of this.foldOverrides.keys()) {
      if (!nextIds.has(id)) this.foldOverrides.delete(id);
    }
    if (this.focusMode === "timeline" && this.selectedBlockId === null) {
      this.selectedBlockId = projection.timeline.at(-1)?.id ?? null;
    }

    this.currentSessionId = projection.header.sessionId;
    this.projection = projection;
    this.attentionIdentity = nextAttentionIdentity;
    this.header.setText(formatHeader(projection));
    this.renderTimeline();
    this.renderComposer();
    this.refreshOpenOverlay();
    this.renderStatus();
    this.restoreLogicalFocus();
    this.requestRender();
  }

  getEditorText(): string {
    return this.editor.getExpandedText();
  }

  setEditorText(text: string): void {
    this.editor.setText(text);
    this.renderStatus();
    this.requestRender();
  }

  clearEditor(): void {
    this.setEditorText("");
  }

  pasteToComposer(text: string): void {
    this.editor.handleInput(`\u001b[200~${text}\u001b[201~`);
    this.renderStatus();
    this.requestRender();
  }

  showNotice(message: string): void {
    this.notice = message;
    this.renderComposer();
    this.requestRender();
  }

  showExtensionNotice(message: string, type: "info" | "warning" | "error" = "info"): void {
    const label = type === "warning" ? "Warning" : type === "error" ? "Error" : "Info";
    this.showNotice(`${label} · ${message}`);
  }

  setTerminalTitle(title: string): void {
    this.tui.terminal.setTitle(title);
  }

  restoreBaseTerminalTitle(): void {
    this.tui.terminal.setTitle(BASE_TERMINAL_TITLE);
  }

  addExtensionTerminalInputHandler(handler: TerminalInputHandler): () => void {
    this.extensionTerminalHandlers.add(handler);
    return () => this.extensionTerminalHandlers.delete(handler);
  }

  setExtensionStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.extensionStatuses.delete(key);
    else this.extensionStatuses.set(key, text);
    this.renderStatus();
    this.requestRender();
  }

  setExtensionWorkingMessage(message?: string): void {
    this.workingMessage = message;
    this.renderStatus();
    this.requestRender();
  }

  setExtensionWorkingVisible(visible: boolean): void {
    this.workingVisible = visible;
    this.renderStatus();
    this.requestRender();
  }

  setExtensionWorkingIndicator(options?: WorkingIndicatorOptions): void {
    this.workingIndicator = options;
    this.renderStatus();
    this.requestRender();
  }

  setExtensionHiddenThinkingLabel(label?: string): void {
    this.hiddenThinkingLabel = label;
    this.renderStatus();
    this.requestRender();
  }

  clearExtensionSessionState(): void {
    this.cancelExtensionDialog();
    this.extensionTerminalHandlers.clear();
    this.extensionStatuses.clear();
    this.workingMessage = undefined;
    this.workingVisible = true;
    this.workingIndicator = undefined;
    this.hiddenThinkingLabel = undefined;
    this.restoreBaseTerminalTitle();
    this.renderStatus();
    this.requestRender();
  }

  selectExtension(title: string, options: readonly string[]): Promise<string | undefined> {
    return this.openExtensionDialog<string | undefined>((complete) => new ExtensionSelectOverlay(
      title,
      options,
      (value) => complete(value),
      () => complete(undefined),
    ), undefined);
  }

  confirmExtension(title: string, message: string): Promise<boolean> {
    return this.openExtensionDialog((complete) => new ExtensionSelectOverlay(
      title,
      ["Confirm", "Cancel"],
      (value) => complete(value === "Confirm"),
      () => complete(false),
      message,
    ), false);
  }

  inputExtension(title: string, placeholder?: string): Promise<string | undefined> {
    return this.openExtensionDialog<string | undefined>((complete) => new ExtensionInputOverlay(
      title,
      placeholder,
      (value) => complete(value),
      () => complete(undefined),
    ), undefined);
  }

  editorExtension(title: string, prefill?: string): Promise<string | undefined> {
    return this.openExtensionDialog<string | undefined>((complete) => new ExtensionEditorOverlay(
      this.tui,
      title,
      prefill,
      (value) => complete(value),
      () => complete(undefined),
    ), undefined);
  }

  cancelExtensionDialog(): void {
    this.extensionDialogCancel?.();
  }

  getInteractionState(): PindieTuiInteractionSnapshot {
    return {
      focusMode: this.focusMode,
      selectedBlockId: this.selectedBlockId,
      foldOverrides: new Map(this.foldOverrides),
      activeOverlay: this.activeOverlay,
    };
  }

  requestRender(): void {
    if (this.started) this.tui.requestRender();
  }

  private interactionState(): PindieInteractionState {
    return {
      focusMode: this.focusMode,
      activeOverlay: this.activeOverlay,
    };
  }

  private actionAvailability(): PindieActionAvailability {
    return {
      // This is intentionally derived from the native Projection fact rather
      // than a local "running" flag.
      runActive: this.projection?.status.isIdle === false,
      composerEmpty: this.editor.getExpandedText().length === 0,
      hasSelectedBlock: this.selectedBlock() !== null,
      activeOverlay: this.activeOverlay,
      attentionHasOptions: gateOptions(this.projection?.attention ?? null).length > 0,
      attentionCanSubmit: this.canSubmitAttention(),
    };
  }

  private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.activeOverlay === "extension-dialog") {
      this.extensionDialogComponent?.handleInput?.(data);
      this.requestRender();
      return { consume: true };
    }

    const action = resolveActionForInput(
      this.actionAvailability(),
      this.interactionState(),
      data,
    );
    if (action !== null) {
      this.dispatchAction(action);
      return { consume: true };
    }

    // The overlay owns every input not consumed by its registry actions. This
    // prevents a palette/viewer key from leaking into the Composer or
    // Timeline underneath it.
    if (this.activeOverlay === "command-palette") {
      this.handlePaletteInput(data);
      return { consume: true };
    }
    if (this.activeOverlay === "block-viewer") return { consume: true };

    // Registry ownership decides whether an unavailable binding still consumes
    // input. Reserved actions fail closed, while inapplicable option navigation
    // returns j/k/Up/Down to the free-form Pi Editor.
    if (shouldConsumePindieInput(
      this.actionAvailability(),
      this.interactionState(),
      data,
    )) return { consume: true };

    let forwarded = data;
    if (this.focusMode === "composer") {
      for (const handler of [...this.extensionTerminalHandlers]) {
        const result = handler(forwarded);
        if (result?.data !== undefined) forwarded = result.data;
        if (result?.consume === true) return { consume: true };
      }
    }

    if (forwarded !== data) {
      this.editor.handleInput(forwarded);
      this.renderStatus();
      this.requestRender();
      return { consume: true };
    }

    if (this.focusMode === "composer" || this.focusMode === "attention") {
      // Pi Editor owns text mutation, including multiline, paste, and IME.
      queueMicrotask(() => {
        if (this.focusMode === "attention") {
          this.attentionResponseDraft = this.attentionEditor.getExpandedText();
        }
        this.renderStatus();
        this.requestRender();
      });
    }
    return undefined;
  }

  private dispatchAction(action: PindieActionId): void {
    if (!isPindieActionAvailable(action, this.actionAvailability())) return;

    switch (action) {
      case "palette.open":
        this.openCommandPalette();
        return;
      case "timeline.toggle":
        if (this.focusMode === "timeline") this.returnToPrimarySurface();
        else this.enterTimeline();
        return;
      case "composer.follow-up":
        this.onFollowUp?.(this.editor.getExpandedText());
        return;
      case "run.abort":
        this.onAbort?.();
        return;
      case "app.exit":
        this.onExit?.();
        return;
      case "timeline.next":
        this.moveSelection(1);
        return;
      case "timeline.previous":
        this.moveSelection(-1);
        return;
      case "timeline.collapse":
        this.setSelectedFold("compact");
        return;
      case "timeline.expand":
        this.setSelectedFold("full");
        return;
      case "timeline.toggle-fold":
        this.setSelectedFold(this.effectiveDisplayMode(this.selectedBlock()!) === "full"
          ? "compact"
          : "full");
        return;
      case "timeline.inspect":
        this.openBlockViewer();
        return;
      case "timeline.copy":
        void this.copySelectedBlock();
        return;
      case "timeline.back":
        this.returnToPrimarySurface();
        return;
      case "attention.next":
        this.moveAttentionSelection(1);
        return;
      case "attention.previous":
        this.moveAttentionSelection(-1);
        return;
      case "attention.submit":
        this.submitAttentionResponse();
        return;
      case "attention.escape":
        this.showNotice("Decision remains open. Alt+H inspects Timeline.");
        return;
      case "overlay.close":
        this.closeOverlay();
        return;
      case "overlay.next":
        this.viewerScroll?.scrollBy(1);
        this.requestRender();
        return;
      case "overlay.previous":
        this.viewerScroll?.scrollBy(-1);
        this.requestRender();
        return;
    }
  }

  private enterTimeline(): void {
    this.focusMode = "timeline";
    this.selectedBlockId = this.projection?.timeline.at(-1)?.id ?? null;
    this.tui.setFocus(null);
    this.timelineScroll.scrollToEnd();
    this.renderTimeline();
    this.renderStatus();
    this.ensureSelectedBlockVisible();
    this.requestRender();
  }

  private returnToPrimarySurface(): void {
    this.focusMode = this.projection?.attention === null ? "composer" : "attention";
    this.restoreLogicalFocus();
    this.timelineScroll.scrollToEnd();
    this.renderTimeline();
    this.renderComposer();
    this.renderStatus();
    this.requestRender();
  }

  private selectedBlock(): UiTimelineBlock | null {
    if (this.projection === null || this.selectedBlockId === null) return null;
    return this.projection.timeline.find((block) => block.id === this.selectedBlockId) ?? null;
  }

  private moveSelection(delta: number): void {
    const timeline = this.projection?.timeline ?? [];
    if (timeline.length === 0) return;
    const currentIndex = this.selectedBlockId === null
      ? timeline.length - 1
      : timeline.findIndex((block) => block.id === this.selectedBlockId);
    const nextIndex = Math.max(
      0,
      Math.min(timeline.length - 1, (currentIndex < 0 ? timeline.length - 1 : currentIndex) + delta),
    );
    this.selectedBlockId = timeline[nextIndex]?.id ?? null;
    this.renderTimeline();
    this.ensureSelectedBlockVisible();
    this.renderStatus();
    this.requestRender();
  }

  private setSelectedFold(displayMode: UiDisplayMode): void {
    const block = this.selectedBlock();
    if (block === null) return;
    this.foldOverrides.set(block.id, displayMode);
    this.renderTimeline();
    this.ensureSelectedBlockVisible();
    this.requestRender();
  }

  private effectiveDisplayMode(block: UiTimelineBlock): UiDisplayMode {
    return this.foldOverrides.get(block.id) ?? block.defaultDisplayMode;
  }

  private renderTimeline(): void {
    this.timelineContent.clear();
    this.blockLineRanges.clear();
    this.timelineContent.addChild(new Text("Timeline", 1, 0));
    let lineCursor = 1;
    for (const notice of this.startupNotices) {
      const component = new Text(`Notice · ${notice}`, 1, 0);
      this.timelineContent.addChild(component);
      lineCursor += Math.max(1, component.render(Math.max(1, this.tui.terminal.columns)).length);
    }

    for (const block of this.projection?.timeline ?? []) {
      const selected = this.focusMode === "timeline" && block.id === this.selectedBlockId;
      const text = formatBlock(block, this.effectiveDisplayMode(block));
      const renderedText = selected ? `› ${text}` : text;
      const component = new Text(renderedText, 1, 0);
      this.timelineContent.addChild(component);
      const lineCount = Math.max(1, component.render(Math.max(1, this.tui.terminal.columns)).length);
      this.blockLineRanges.set(block.id, {
        start: lineCursor,
        end: lineCursor + lineCount - 1,
      });
      lineCursor += lineCount;
      this.timelineContent.addChild(new Text("", 0, 0));
      lineCursor += 1;
    }
  }

  private ensureSelectedBlockVisible(): void {
    const range = this.selectedBlockId === null
      ? undefined
      : this.blockLineRanges.get(this.selectedBlockId);
    if (range === undefined) return;
    const viewportHeight = this.timelineScroll.viewportHeight;
    const scrollTop = this.timelineScroll.scrollTop;
    if (range.start < scrollTop) {
      this.timelineScroll.scrollTo(range.start, { disableFollow: true });
      return;
    }
    if (viewportHeight > 0 && range.end >= scrollTop + viewportHeight) {
      this.timelineScroll.scrollTo(
        range.end - viewportHeight + 1,
        { disableFollow: true },
      );
    }
  }

  private renderComposer(): void {
    this.inputRegion.clear();
    const attention = this.projection?.attention ?? null;
    if (attention === null) {
      this.inputRegion.addChild(new Text("Composer", 1, 0));
      if (this.notice !== null) this.inputRegion.addChild(new Text(`Notice · ${this.notice}`, 1, 0));
      this.inputRegion.addChild(this.editor);
      return;
    }

    this.inputRegion.addChild(new Text("Attention", 1, 0));
    if (attention.kind === "authority-unavailable") {
      this.inputRegion.addChild(new Text(`Semantic authority unavailable\n${attention.reason}`, 1, 0));
    } else {
      const heading = attention.gateKind === "approval" ? "Approval required" :
        attention.gateKind === "input" ? "Input required" : "Decision required";
      this.inputRegion.addChild(new Text(`${heading}\n${attention.question}`, 1, 0));
      const options = gateOptions(attention);
      if (options.length > 0) {
        const rendered = options.map((option, index) =>
          `${index === this.attentionSelectedIndex ? "›" : " "} ${option}`).join("\n");
        this.inputRegion.addChild(new Text(rendered, 1, 0));
      } else {
        this.inputRegion.addChild(this.attentionEditor);
      }
    }
    if (this.notice !== null) this.inputRegion.addChild(new Text(`Notice · ${this.notice}`, 1, 0));
  }

  private renderStatus(): void {
    if (this.projection === null) {
      this.status.setText("Status · idle");
      return;
    }
    const native = formatStatus(
      this.projection,
      contextualHintActions(this.actionAvailability(), this.interactionState()),
    );
    const additions: string[] = [];
    if (this.workingVisible && this.projection.status.isIdle === false) {
      const frames = this.workingIndicator?.frames;
      if (frames === undefined || frames.length > 0) {
        additions.push(`${frames?.[0] ?? "●"} ${this.workingMessage ?? "Working"}`);
      }
    }
    const statuses = [...this.extensionStatuses.values()].slice(0, 3);
    if (statuses.length > 0) additions.push(`Extensions · ${statuses.join(" · ")}`);
    if (this.hiddenThinkingLabel !== undefined) additions.push(`Thinking · ${this.hiddenThinkingLabel}`);
    this.status.setText(additions.length === 0 ? native : `${native}\n${additions.join(" · ")}`);
  }

  private openCommandPalette(): void {
    if (this.activeOverlay !== null) return;
    this.activeOverlay = "command-palette";
    this.paletteQuery = "";
    this.palettePanel = new VStack();
    this.rebuildPalettePanel();
    this.overlayHandle = this.tui.showOverlay(this.palettePanel, {
      width: "80%",
      maxHeight: "80%",
      anchor: "center",
      margin: 1,
    });
    this.requestRender();
  }

  private rebuildPalettePanel(): void {
    const panel = this.palettePanel;
    if (panel === null) return;
    const actions = this.projection === null
      ? []
      : paletteActions(
        { ...this.actionAvailability(), activeOverlay: null },
        { focusMode: this.focusMode, activeOverlay: null },
      );
    const items: SelectItem[] = actions.map((action) => ({
      // SelectList's public filter is a case-insensitive prefix filter over
      // value. Put the human-facing label first while retaining the exact
      // Action ID between NUL separators for execution.
      value: `${action.label}\u0000${action.id}\u0000${action.description}`,
      label: action.label,
      description: action.description,
    }));
    const input = new Input({ prompt: "Search: " });
    input.setValue(this.paletteQuery);
    const list = new SelectList(
      items,
      Math.max(1, Math.min(8, items.length || 1)),
      editorTheme.selectList,
    );
    list.setFilter(this.paletteQuery);
    input.onSubmit = () => this.executePaletteSelection();
    list.onSelect = (item) => this.executePaletteSelection(item);
    panel.clear();
    panel.addChild(new Text("Command Palette", 1, 0));
    panel.addChild(input);
    panel.addChild(list, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
    this.paletteInput = input;
    this.paletteList = list;
  }

  private handlePaletteInput(data: string): void {
    const input = this.paletteInput;
    const list = this.paletteList;
    if (input === null || list === null) return;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
      list.handleInput(data);
    } else {
      input.handleInput(data);
      this.paletteQuery = input.getValue();
      list.setFilter(this.paletteQuery);
    }
    this.requestRender();
  }

  private executePaletteSelection(item?: SelectItem): void {
    const selected = item ?? this.paletteList?.getSelectedItem() ?? null;
    if (selected === null) return;
    const actionId = selected.value.split("\u0000")[1];
    if (actionId === undefined) return;
    const action = actionId as PindieActionId;
    this.closeOverlay();
    // Palette execution deliberately uses the same dispatcher as a keyboard
    // resolution; there is no second command switch.
    this.dispatchAction(action);
  }

  private openBlockViewer(): void {
    const block = this.selectedBlock();
    if (block === null || this.activeOverlay !== null) return;
    const content = new Container();
    content.addChild(new Text(formatBlock(block, "full"), 1, 0));
    const scroll = new ScrollView(content, {
      follow: "none",
      primary: true,
      overscroll: "contain",
    });
    const panel = new BlockViewerOverlay(
      `Block · ${blockTitle(block)}`,
      scroll,
      Math.floor(this.tui.terminal.rows * 0.8),
      () => this.requestRender(),
    );
    this.viewerBlockId = block.id;
    this.viewerContent = content;
    this.viewerScroll = scroll;
    this.activeOverlay = "block-viewer";
    this.overlayHandle = this.tui.showOverlay(panel, {
      width: "80%",
      maxHeight: "80%",
      anchor: "center",
      margin: 1,
    });
    this.requestRender();
  }

  private refreshOpenOverlay(): void {
    if (this.activeOverlay === "command-palette") {
      this.rebuildPalettePanel();
      return;
    }
    if (this.activeOverlay !== "block-viewer") return;
    const block = this.viewerBlockId === null
      ? null
      : this.projection?.timeline.find((candidate) => candidate.id === this.viewerBlockId) ?? null;
    if (block === null) {
      this.closeOverlay();
      return;
    }
    this.viewerContent?.clear();
    this.viewerContent?.addChild(new Text(formatBlock(block, "full"), 1, 0));
  }

  private openExtensionDialog<T>(
    create: (complete: (value: T) => void) => Component & { dispose?(): void },
    cancelValue: T,
  ): Promise<T> {
    this.closeLowerPriorityOverlay();
    if (this.activeOverlay !== null) return Promise.resolve(cancelValue);
    return new Promise<T>((resolve) => {
      let settled = false;
      const complete = (value: T) => {
        if (settled) return;
        settled = true;
        const component = this.extensionDialogComponent;
        this.extensionDialogCancel = null;
        this.extensionDialogComponent = null;
        component?.dispose?.();
        this.closeOverlay();
        resolve(value);
      };
      const component = create(complete);
      this.extensionDialogComponent = component;
      this.extensionDialogCancel = () => complete(cancelValue);
      this.activeOverlay = "extension-dialog";
      this.overlayHandle = this.tui.showOverlay(component, {
        width: "80%",
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      });
      this.tui.setFocus(component);
      this.requestRender();
    });
  }

  private closeLowerPriorityOverlay(): void {
    if (this.activeOverlay === "command-palette" || this.activeOverlay === "block-viewer") {
      this.closeOverlay();
    }
  }

  private closeOverlay(): void {
    if (this.activeOverlay === "extension-dialog" && this.extensionDialogCancel !== null) {
      this.extensionDialogCancel();
      return;
    }
    const handle = this.overlayHandle;
    this.overlayHandle = null;
    this.activeOverlay = null;
    this.palettePanel = null;
    this.paletteInput = null;
    this.paletteList = null;
    this.viewerBlockId = null;
    this.viewerContent = null;
    this.viewerScroll = null;
    handle?.hide();
    this.restoreLogicalFocus();
    this.renderStatus();
    this.requestRender();
  }

  private restoreLogicalFocus(): void {
    if (this.activeOverlay === "extension-dialog" && this.extensionDialogComponent !== null) {
      this.tui.setFocus(this.extensionDialogComponent);
      return;
    }
    const attention = this.projection?.attention ?? null;
    const freeFormGate = this.focusMode === "attention" &&
      attention?.kind === "human-gate" && gateOptions(attention).length === 0;
    this.tui.setFocus(this.focusMode === "composer"
      ? this.editor
      : freeFormGate ? this.attentionEditor : null);
  }

  private resetAttentionMechanics(): void {
    this.notice = null;
    this.attentionSelectedIndex = 0;
    this.attentionResponseDraft = "";
    this.attentionEditor.setText("");
  }

  private canSubmitAttention(): boolean {
    const attention = this.projection?.attention ?? null;
    if (attention?.kind !== "human-gate") return false;
    return gateOptions(attention).length > 0 || this.attentionEditor.getExpandedText().trim().length > 0;
  }

  private moveAttentionSelection(delta: number): void {
    const options = gateOptions(this.projection?.attention ?? null);
    if (options.length === 0) return;
    this.attentionSelectedIndex = Math.max(0, Math.min(options.length - 1, this.attentionSelectedIndex + delta));
    this.renderComposer();
    this.requestRender();
  }

  private submitAttentionResponse(): void {
    const attention = this.projection?.attention ?? null;
    if (attention?.kind !== "human-gate") return;
    const options = gateOptions(attention);
    const response = options.length > 0
      ? options[this.attentionSelectedIndex] ?? ""
      : this.attentionEditor.getExpandedText().trim();
    if (response.length === 0) return;
    this.attentionResponseDraft = this.attentionEditor.getExpandedText();
    this.onAttentionResponse?.(response);
    // Keep free-form intent until authoritative Projection changes the Gate.
    if (options.length === 0) this.attentionEditor.setText(this.attentionResponseDraft);
    this.requestRender();
  }

  private async copySelectedBlock(): Promise<void> {
    const block = this.selectedBlock();
    if (block === null) return;
    try {
      await this.copyText(formatBlock(block, "full"));
      this.showNotice("Copied Block.");
    } catch (error) {
      this.showNotice(`Copy failed: ${errorMessage(error)}`);
    }
  }
}
