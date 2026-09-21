import { isPindieContinuationProbeMessage } from "./continuation.ts";

export type PromptOrigin = "tui" | "discord" | "discord-steer" | "discord-follow-up" | "neutral";
export interface MirrorEntry { id: string; type?: string; message?: { role?: string; content?: unknown; display?: boolean; customType?: string; stopReason?: string }; }
/** `origin` and `attention` are runtime-only transport presentation context, never transcript state. */
export interface TimelineEvent {
  entryId: string;
  kind: "user" | "assistant" | "execution" | "milestone";
  text: string;
  origin?: PromptOrigin;
  /** Harness-owned signal that this event should actively reclaim the configured user's attention. */
  attention?: boolean;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text!).join("\n");
}

/** Stateless filtering of authoritative Pi entries.  Delivery ordering belongs to RemoteCompanion. */
export function mirrorEntry(entry: MirrorEntry, origin: PromptOrigin = "neutral"): TimelineEvent | null {
  const message = entry.message;
  if (!message || !entry.id || message.display === false || message.stopReason === "aborted" || isPindieContinuationProbeMessage(message as any)) return null;
  const body = text(message.content).trim();
  if (!body) return null;
  if (message.role === "user") {
    const label = origin === "tui" ? "YOU · TUI" : origin === "discord" ? "YOU · DISCORD" : origin === "discord-steer" ? "YOU · DISCORD · STEER" : origin === "discord-follow-up" ? "YOU · DISCORD · FOLLOW-UP" : "YOU";
    return { entryId: entry.id, kind: "user", text: `${label}\n${body}`, origin };
  }
  if (message.role === "assistant") return { entryId: entry.id, kind: "assistant", text: body };
  return null;
}

/** Splits presentation-sized text without changing its order or content. */
export function splitTimelineEvent(event: TimelineEvent, limit = 1_900): TimelineEvent[] {
  if (event.text.length <= limit) return [event];
  const chunks: TimelineEvent[] = []; let remaining = event.text;
  const push = (text: string): void => {
    chunks.push({
      ...event,
      text,
      ...(event.attention === true ? { attention: chunks.length === 0 } : {}),
    });
  };
  while (remaining.length > limit) {
    const boundary = Math.max(remaining.lastIndexOf("\n", limit), remaining.lastIndexOf(" ", limit), limit);
    push(remaining.slice(0, boundary)); remaining = remaining.slice(boundary);
  }
  push(remaining); return chunks;
}

export class ExecutionAggregator {
  private readonly counts = new Map<string, number>();
  private lastCommand: string | null = null;
  record(toolName: string, input?: Record<string, unknown>, isError = false): void {
    this.counts.set(toolName, (this.counts.get(toolName) ?? 0) + 1);
    if (toolName === "bash" && typeof input?.command === "string") this.lastCommand = `${input.command}${isError ? " ✗" : " ✓"}`;
  }
  flush(entryId: string): TimelineEvent | null {
    if (!this.counts.size) return null;
    const lines = [...this.counts].map(([name, count]) => `${name} ×${count}`);
    if (this.lastCommand) lines.push(`bash · ${this.lastCommand}`);
    this.counts.clear(); this.lastCommand = null;
    return { entryId, kind: "execution", text: `EXECUTION\n${lines.join("\n")}` };
  }
}
