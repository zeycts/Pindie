import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { UiTimelineBlock } from "./ui-projection.ts";

/** Presentation only: classify projection facts, never prompt/command text. */
export function watchEventTone(block: UiTimelineBlock): ThemeColor {
  switch (block.type) {
    case "message":
      return block.lifecycle === "error" ? "error" : block.role === "custom" ? "muted" : "accent";
    case "runtime": return "dim"; // Historical runtime notices are not current alarms.
    case "work":
      return block.lifecycle === "failed" ? "error" : block.lifecycle === "running" ? "accent" : "success";
    case "semantic":
      if (block.lifecycle === "failed" || block.error !== null) return "error";
      if (block.lifecycle === "running") return "accent";
      switch (block.category) {
        case "task": return block.taskStatus === "blocked" || block.taskStatus === "waiting_human" ? "warning" : "accent";
        case "human-gate": return block.state === "open" ? "warning" : "success";
        case "completion": return "success";
        case "verification":
          return block.verificationStatus === "passed" ? "success" : block.verificationStatus === "failed" ? "error" : block.verificationStatus === "stale" ? "warning" : "accent";
      }
  }
}

/** Input is already sanitized and width/grapheme-bounded. Only the formatter's
 * structural prefix is emphasized; remote body text can never choose a style. */
export function watchEventTitle(theme: Theme, block: UiTimelineBlock, title: string, expanded: boolean, selected: boolean): string {
  const separator = title.indexOf(" · ");
  const prefixLength = block.type === "message" || (block.type === "semantic" && block.category !== "verification")
    ? separator < 0 ? title.length : separator
    : block.type === "semantic" ? title.length : Math.min(1, title.length);
  const prefix = theme.fg(watchEventTone(block), title.slice(0, prefixLength));
  const label = (block.type === "semantic" ? theme.bold(prefix) : prefix) + title.slice(prefixLength);
  const marker = selected ? theme.bold(theme.fg("accent", ">")) : " ";
  const row = marker + theme.fg("dim", expanded ? "−" : "+") + label;
  return selected ? theme.bg("selectedBg", row) : row;
}

/** Raw output/details recede, but genuine diagnostics retain normal contrast.
 * Native ToolExecutionComponent output never passes through this helper. */
export function watchPreviewTone(block: UiTimelineBlock): ThemeColor {
  if (block.type === "message") return "text";
  if (block.type === "work" && block.lifecycle === "failed") return "text";
  if (block.type === "semantic" && (block.lifecycle === "failed" || block.error !== null ||
    ((block.category === "verification" || block.category === "completion") && block.checks.some((check) => check.status === "failed")))) return "text";
  return "muted";
}
