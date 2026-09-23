/** Renderer-independent Work Timeline vocabulary and presentation helpers. */

export type UiDisplayMode = "compact" | "preview" | "full";

/** JSON-shaped values copied into the projection instead of retaining Pi objects. */
export type UiPlainValue =
  | null
  | boolean
  | number
  | string
  | readonly UiPlainValue[]
  | { readonly [key: string]: UiPlainValue };

export interface UiToolResultProjection {
  readonly isError: boolean;
  readonly summary: string;
  readonly details: UiPlainValue | null;
}

export type UiWorkLifecycle = "running" | "complete" | "failed";

export interface UiObservationItem {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: UiPlainValue | null;
  /** A safe, human-facing path/query/action description. */
  readonly label: string;
  readonly lifecycle: UiWorkLifecycle;
  readonly result: UiToolResultProjection | null;
}

export interface UiObservationWorkBlock {
  readonly type: "work";
  readonly kind: "observation";
  readonly id: string;
  readonly lifecycle: UiWorkLifecycle;
  readonly title: string;
  readonly items: readonly UiObservationItem[];
  readonly defaultDisplayMode: UiDisplayMode;
}

export type UiToolWorkKind = "edit" | "command" | "external" | "generic";

export interface UiToolWorkBlock {
  readonly type: "work";
  readonly kind: UiToolWorkKind;
  /** Tool execution identity; this is never an array index. */
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly lifecycle: UiWorkLifecycle;
  readonly title: string;
  readonly input: UiPlainValue | null;
  readonly result: UiToolResultProjection | null;
  readonly defaultDisplayMode: UiDisplayMode;
}

export type UiWorkBlock = UiObservationWorkBlock | UiToolWorkBlock;

export type UiToolPresentationKind =
  | "observation"
  | "edit"
  | "command"
  | "semantic"
  | "external"
  | "generic";

const observationTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "url_context",
  "pindie_git_observe",
]);

const semanticTools = new Set([
  "pindie_task_start",
  "pindie_task_replace",
  "pindie_task_refine",
  "pindie_task_progress",
  "pindie_task_handoff",
  "pindie_verification_record",
  "pindie_task_complete",
  "pindie_gate_open",
  "pindie_gate_resolve",
]);

const externalTools = new Set([
  "pindie_memory_capture",
  "pindie_policy_set",
  "pindie_strategy_candidate_create",
  "pindie_strategy_derivation_candidate_create",
  "pindie_strategy_synthesis_candidate_create",
]);

/**
 * Presentation-only classification. This deliberately does not share the
 * execution authorization classifier: visual category is not tool legality.
 */
export function classifyToolPresentation(toolName: string): UiToolPresentationKind {
  if (observationTools.has(toolName)) return "observation";
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "bash") return "command";
  if (semanticTools.has(toolName)) return "semantic";
  if (
    externalTools.has(toolName) ||
    toolName.startsWith("browser") ||
    toolName.startsWith("computer") ||
    toolName.startsWith("playwright")
  ) return "external";
  return "generic";
}

export function isSemanticPresentationTool(toolName: string): boolean {
  return classifyToolPresentation(toolName) === "semantic";
}

const MAX_PLAIN_DEPTH = 5;
const MAX_PLAIN_ITEMS = 64;
const MAX_RESULT_SUMMARY_LENGTH = 4_000;
const MAX_COMMAND_OUTPUT_LENGTH = 3_000;
const MAX_COMMAND_OUTPUT_LINES = 25;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: string, limit = MAX_RESULT_SUMMARY_LENGTH): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function boundedTail(value: string, limit: number, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  const tail = lines.slice(-maxLines).join("\n");
  if (tail.length <= limit) return tail;
  return `…${tail.slice(-(limit - 1))}`;
}

export function toPlainValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): UiPlainValue {
  if (value === null) return null;
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return null;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_PLAIN_DEPTH) return "[truncated]";

  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PLAIN_ITEMS)
      .map((item) => toPlainValue(item, nextSeen, depth + 1));
  }

  const output: Record<string, UiPlainValue> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_PLAIN_ITEMS)) {
    output[key] = toPlainValue(child, nextSeen, depth + 1);
  }
  return output;
}

/** Extract only visible text content; thinking and tool calls are excluded. */
export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  const singlePart = record(content);
  if (singlePart?.type === "text" && typeof singlePart.text === "string") {
    return singlePart.text;
  }
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const source = record(part);
      return source?.type === "text" && typeof source.text === "string"
        ? [source.text]
        : [];
    })
    .join("\n");
}

export interface UiToolCallProjection {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface UiToolResultMessageProjection {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: unknown;
  readonly details: unknown;
  readonly isError: boolean;
}

export function readToolCall(value: unknown): UiToolCallProjection | null {
  const source = record(value);
  if (
    source?.type !== "toolCall" ||
    typeof source.id !== "string" ||
    source.id.length === 0 ||
    typeof source.name !== "string" ||
    source.name.length === 0
  ) return null;
  return {
    id: source.id,
    name: source.name,
    arguments: source.arguments,
  };
}

export function readToolResultMessage(value: unknown): UiToolResultMessageProjection | null {
  const source = record(value);
  if (
    source?.role !== "toolResult" ||
    typeof source.toolCallId !== "string" ||
    source.toolCallId.length === 0 ||
    typeof source.toolName !== "string"
  ) return null;
  return {
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    content: source.content,
    details: source.details,
    isError: source.isError === true,
  };
}

function resultDetailText(details: unknown): string {
  const source = record(details);
  if (source !== null) {
    const preferred = ["stderr", "stdout", "output", "result", "message"]
      .map((key) => source[key])
      .filter((value): value is string => typeof value === "string");
    if (preferred.length > 0) return preferred.join("\n");
  }
  if (details === undefined || details === null) return "";
  try {
    return JSON.stringify(details) ?? "";
  } catch {
    return "";
  }
}

/** Project a Pi tool result without retaining unbounded output. */
export function projectToolResult(
  value: unknown,
  isError: boolean,
  toolName?: string,
): UiToolResultProjection | null {
  if (value === undefined || value === null) return null;
  const source = record(value);
  const contentText = visibleText(source?.content ?? value).trim();
  const rawDetails = source && "details" in source ? source.details : null;
  const details = rawDetails === null ? null : toPlainValue(rawDetails);
  let summary = contentText;
  if (!summary && rawDetails !== null) summary = resultDetailText(rawDetails).trim();
  if (toolName === "bash") {
    const detailText = resultDetailText(rawDetails).trim();
    summary = [contentText, detailText]
      .filter((part, index, parts) => part.length > 0 && (index === 0 || part !== parts[0]))
      .join("\n");
    summary = boundedTail(summary, MAX_COMMAND_OUTPUT_LENGTH, MAX_COMMAND_OUTPUT_LINES);
  } else {
    summary = boundedText(summary);
  }
  return {
    isError,
    summary,
    details,
  };
}

function plainRecord(value: UiPlainValue | null): Record<string, UiPlainValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, UiPlainValue>
    : null;
}

function firstString(
  input: UiPlainValue | null,
  keys: readonly string[],
): string | null {
  const source = plainRecord(input);
  if (source === null) return null;
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key].length > 0) return source[key];
  }
  return null;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function toolPath(input: UiPlainValue | null): string | null {
  return firstString(input, ["path", "file", "filePath", "file_path", "filename"]);
}

export function commandText(input: UiPlainValue | null): string | null {
  return firstString(input, ["command", "cmd"]);
}

function displayToolName(toolName: string): string {
  switch (toolName) {
    case "pindie_memory_capture":
      return "Work Memory capture";
    case "pindie_policy_set":
      return "Policy update";
    case "pindie_strategy_candidate_create":
    case "pindie_strategy_derivation_candidate_create":
    case "pindie_strategy_synthesis_candidate_create":
      return "Strategy work";
    default:
      return toolName.replaceAll("_", " ");
  }
}

function lifecycleMode(lifecycle: UiWorkLifecycle): UiDisplayMode {
  return lifecycle === "running"
    ? "preview"
    : lifecycle === "failed" ? "preview" : "compact";
}

export function toolTitle(
  kind: Exclude<UiToolPresentationKind, "observation" | "semantic">,
  toolName: string,
  input: UiPlainValue | null,
  lifecycle: UiWorkLifecycle,
): string {
  if (kind === "edit") {
    const path = toolPath(input) ?? "file";
    if (toolName === "write") {
      if (lifecycle === "running") return `Writing ${path}`;
      if (lifecycle === "complete") return `Wrote ${path}`;
      return `Write failed · ${path}`;
    }
    if (lifecycle === "running") return `Editing ${path}`;
    if (lifecycle === "complete") return `Edited ${path}`;
    return `Edit failed · ${path}`;
  }

  if (kind === "command") {
    const command = commandText(input);
    if (lifecycle === "running") return command === null ? "Running command" : "Running";
    if (lifecycle === "complete") return command === null ? "Command" : `Command · ${command}`;
    return command === null ? "Command failed" : `Command failed · ${command}`;
  }

  const name = displayToolName(toolName);
  return lifecycle === "failed" ? `${name} failed` : name;
}

export function observationLabel(
  toolName: string,
  input: UiPlainValue | null,
): string {
  switch (toolName) {
    case "read": {
      const path = toolPath(input);
      return path === null ? "Reading files" : `Reading ${path}`;
    }
    case "grep": {
      const pattern = firstString(input, ["pattern", "query"]);
      const path = toolPath(input);
      const subject = pattern === null ? "patterns" : quote(pattern);
      return path === null ? `Searching ${subject}` : `Searching ${subject} in ${path}`;
    }
    case "find": {
      const pattern = firstString(input, ["pattern", "query", "name"]);
      const path = toolPath(input);
      const subject = pattern === null ? "files" : quote(pattern);
      return path === null ? `Finding ${subject}` : `Finding ${subject} in ${path}`;
    }
    case "ls": {
      const path = toolPath(input);
      return path === null ? "Listing project" : `Listing ${path}`;
    }
    case "web_search": {
      const query = firstString(input, ["query", "q"]);
      return query === null ? "Searching the web" : `Searching ${quote(query)}`;
    }
    case "url_context": {
      const url = firstString(input, ["url", "URL", "uri"]);
      return url === null ? "Reading URL context" : `Reading ${url}`;
    }
    case "pindie_git_observe": {
      const action = firstString(input, ["action"]);
      return action === null ? "Checking Git" : `Checking Git ${action}`;
    }
    default:
      return `Using ${toolName}`;
  }
}

export function createObservationItem(
  call: UiToolCallProjection,
  lifecycle: UiWorkLifecycle,
  result: UiToolResultProjection | null,
): UiObservationItem {
  const input = toPlainValue(call.arguments);
  return {
    toolCallId: call.id,
    toolName: call.name,
    input,
    label: observationLabel(call.name, input),
    lifecycle,
    result,
  };
}

export function observationLifecycle(
  items: readonly UiObservationItem[],
): UiWorkLifecycle {
  if (items.some((item) => item.lifecycle === "failed")) return "failed";
  return items.every((item) => item.lifecycle === "complete") ? "complete" : "running";
}

export function observationDisplayMode(
  lifecycle: UiWorkLifecycle,
): UiDisplayMode {
  return lifecycle === "complete" ? "compact" : "preview";
}

export function observationTitle(lifecycle: UiWorkLifecycle): string {
  return lifecycle === "running"
    ? "Inspecting project"
    : lifecycle === "complete" ? "Inspected project" : "Project inspection";
}

export function createObservationBlock(
  firstToolCallId: string,
  items: readonly UiObservationItem[],
): UiObservationWorkBlock {
  const lifecycle = observationLifecycle(items);
  return {
    type: "work",
    kind: "observation",
    id: `observe:${firstToolCallId}`,
    lifecycle,
    title: observationTitle(lifecycle),
    items,
    defaultDisplayMode: observationDisplayMode(lifecycle),
  };
}

export function createToolWorkBlock(
  call: UiToolCallProjection,
  lifecycle: UiWorkLifecycle,
  result: UiToolResultProjection | null,
): UiToolWorkBlock | null {
  const presentation = classifyToolPresentation(call.name);
  if (
    presentation === "observation" ||
    presentation === "semantic"
  ) return null;
  const kind: UiToolWorkKind = presentation;
  const input = toPlainValue(call.arguments);
  return {
    type: "work",
    kind,
    id: call.id,
    toolCallId: call.id,
    toolName: call.name,
    lifecycle,
    title: toolTitle(kind, call.name, input, lifecycle),
    input,
    result,
    defaultDisplayMode: lifecycleMode(lifecycle),
  };
}

export function refreshToolWorkBlock(
  block: UiToolWorkBlock,
  toolName: string,
  input: UiPlainValue | null,
  lifecycle: UiWorkLifecycle,
  result: UiToolResultProjection | null,
): UiToolWorkBlock {
  const kind = classifyToolPresentation(toolName);
  const nextKind: UiToolWorkKind = kind === "observation" || kind === "semantic"
    ? block.kind
    : kind;
  return {
    ...block,
    kind: nextKind,
    toolName,
    lifecycle,
    title: toolTitle(nextKind, toolName, input, lifecycle),
    input,
    result,
    defaultDisplayMode: lifecycleMode(lifecycle),
  };
}
