import { createBashToolDefinition, createReadToolDefinition, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { UiTimelineBlock } from "./ui-projection.ts";
import type { UiToolResultProjection } from "./ui-timeline.ts";
import { watchReadInput } from "./watch-presentation-data.ts";

// Public factories construct definitions but do not execute them. Retain ONLY presentation callbacks.
// Never obtain edit renderers: renderCall can asynchronously read the observer's filesystem.
const presentationCwd = "/"; // Neutral path formatting base, never the local or remote project cwd.
function renderers(name: "read" | "bash"): ToolRenderers {
  const definition = name === "read" ? createReadToolDefinition(presentationCwd) : createBashToolDefinition(presentationCwd);
  // Public ToolRenderers erases parameter schemas to unknown. The adapter below validates
  // the matching concrete read/bash shape before invoking this presentation-only boundary.
  return { renderCall: definition.renderCall, renderResult: definition.renderResult } as ToolRenderers;
}
const native = { read: renderers("read"), bash: renderers("bash") };
const unsafeControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function resultText(result: UiToolResultProjection | null): string | null {
  if (!result || typeof result.isError !== "boolean" || typeof result.textContent !== "string" ||
    result.textContent.length === 0 || result.textContent.length > 4_000 || result.textContent !== result.summary || unsafeControls.test(result.textContent)) return null;
  return result.textContent;
}

/** Convert genuine bounded text excerpts, not summaries/details, to native presentation DTOs.
 * No AgentSession, execute callback, local cwd, image, duration, or raw details reach a component.
 * Completed events only: do not start native local elapsed-time clocks for remote work.
 */
export function watchNativeComponents(block: UiTimelineBlock, tui: TUI): ToolExecutionComponent[] | null {
  if (block.type !== "work") return null;
  const items = block.kind === "observation" ? block.items : [block];
  if (items.length === 0 || items.length > 8) return null;
  const rows: { name: "read" | "bash"; id: string; args: object; text: string; isError: boolean }[] = [];
  for (const item of items) {
    const name = item.toolName;
    if ((name !== "read" && name !== "bash") || typeof item.toolCallId !== "string" || !item.toolCallId || item.toolCallId.length > 512 ||
      (item.lifecycle !== "complete" && item.lifecycle !== "failed")) return null;
    const text = resultText(item.result);
    if (text === null || item.result!.isError !== (item.lifecycle === "failed")) return null;
    let args: object | null = null;
    if (name === "read") args = watchReadInput(item.input);
    else if (item.input && typeof item.input === "object" && !Array.isArray(item.input)) {
      const command = (item.input as Record<string, unknown>).command;
      if (typeof command === "string" && command.length > 0 && command.length <= 4_000 && !unsafeControls.test(command)) args = { command };
    }
    if (!args) return null;
    rows.push({ name, id: item.toolCallId, args, text, isError: item.result!.isError });
  }
  return rows.map((row) => {
    const component = new ToolExecutionComponent(row.name, row.id, row.args, { showImages: false }, native[row.name], tui, presentationCwd);
    // Deliberately never markExecutionStarted(): there was no execution in this observer.
    // read/bash presentation does not consult argsComplete. Avoid setArgsComplete(),
    // which would schedule another TUI render while this bounded view is rendering.
    component.updateResult({ content: [{ type: "text", text: row.text }], isError: row.isError });
    component.setExpanded(true);
    return component;
  });
}
