import type { PindieControlMonitorState } from "./control-monitor.ts";
import type { UiTimelineBlock } from "./ui-projection.ts";

/** Remote strings are data, never terminal instructions (including bidi controls). */
export function watchText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "").replace(/[\r\n\t]/gu, " ");
}
export interface WatchRow { readonly id: string; readonly offset: number }

/** Ephemeral view state only. No independent Task/Session/status truth or storage. */
export class WatchViewModel {
  state: PindieControlMonitorState = { connection: "connecting", project: null, snapshot: null, timeline: null, message: null };
  blocks: readonly UiTimelineBlock[] = [];
  selected: string | null = null;
  readonly expanded = new Set<string>();
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
    const ids = new Set(this.blocks.map((block) => block.id));
    if (reset) { this.expanded.clear(); this.anchor = null; this.live = true; }
    for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
    if (this.live || !this.selected || !ids.has(this.selected)) this.selected = this.blocks.at(-1)?.id ?? null;
    return reset;
  }
  navigate(delta: number): void {
    const index = this.blocks.findIndex((block) => block.id === this.selected);
    this.selected = this.blocks[Math.max(0, Math.min(this.blocks.length - 1, index + delta))]?.id ?? null;
    this.live = false;
  }
  toggle(): void {
    if (!this.selected) return;
    if (!this.expanded.delete(this.selected)) this.expanded.add(this.selected);
    this.live = false;
  }
  follow(): void { this.live = true; this.selected = this.blocks.at(-1)?.id ?? null; this.anchor = null; }
  header(): string[] {
    const { state } = this;
    const snapshot = state.snapshot;
    const fresh = state.connection === "connected" && snapshot !== null;
    const semantic = fresh && snapshot.semantic.authority === "coherent" ? snapshot.semantic : null;
    const progress = semantic?.verificationProgress;
    const runtime = fresh ? snapshot.runtime : null;
    // Never infer Task completion from idle. Settled is a separate runtime fact.
    const activity = runtime ? !runtime.idle ? "running" : runtime.pendingMessageCount > 0 ? "pending" : runtime.automaticWorkSettled ? "settled" : "idle · automatic work unsettled" : "unknown";
    return [
      `Watch · Remote read-only · ${state.connection.toUpperCase()} · Esc/q back`,
      `Remote Project: ${state.project ?? "unknown"} · Remote Session: ${snapshot?.session.id.slice(0, 8) ?? "unknown"}`,
      `Task: ${semantic?.taskStatus ?? "unknown"} · Verify: ${semantic?.verificationStatus ?? "unknown"} ${progress ? `${progress.covered}/${progress.total}` : "?/?"} · ${activity}`,
      `Model: ${fresh ? snapshot.executionConfig.model?.modelId ?? "unknown" : "unknown"} · thinking: ${fresh ? snapshot.executionConfig.thinkingLevel : "unknown"}`,
    ];
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
