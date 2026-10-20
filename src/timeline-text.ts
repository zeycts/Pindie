import { commandText, toolPath } from "./ui-timeline.ts";
import type {
  UiDisplayMode, UiMessageBlock, UiObservationItem, UiObservationWorkBlock,
  UiRuntimeBlock, UiSemanticBlock, UiTimelineBlock, UiToolWorkBlock, UiWorkBlock,
} from "./ui-projection.ts";

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
    const first = block.text.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "(empty)";
    const compactRole = block.role === "user" && block.delivery !== undefined
      ? `user·${block.delivery}` : role;
    return `${marker} ${compactRole} · ${first}${block.text.trim() !== first ? "…" : ""}`;
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
    const latestFirst = [...block.items].reverse();
    const current = latestFirst.find((item) => item.lifecycle === "running") ??
      latestFirst.find((item) => item.lifecycle === "failed") ?? latestFirst[0];
    const operation = current === undefined ? "" : current.label;
    const failure = current?.lifecycle === "failed" ? current.result?.summary.trim() : null;
    return `${marker} ${block.title}\n${indent(observationSummary(block))}${operation ? `\n${indent(operation)}` : ""}${failure ? `\n${indent(failure)}` : ""}`;
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
  if (summary !== undefined && summary.length > 0) {
    const output = block.kind === "command" && displayMode === "preview"
      ? summary.split("\n").slice(-2).join("\n")
      : summary;
    lines.push(indent(output));
  }
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
