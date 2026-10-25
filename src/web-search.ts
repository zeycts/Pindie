import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { webSearch, WebSearchSchema } from "./vendor/pi-web-search/web_search.ts";
import { urlContext, UrlContextSchema } from "./vendor/pi-web-search/url_context.ts";

/** Provider transports are an attributed upstream snapshot, not a managed Pi package. */
export function bundledSearchTools(pi: Pick<ExtensionAPI, "getThinkingLevel">): ToolDefinition<any>[] {
  const search: ToolDefinition<typeof WebSearchSchema> = {
    name: "web_search",
    label: "Web Search",
    description: "Search the web with the selected supported provider and return sources. Optionally analyze up to 20 URLs. Uses current Pi credentials; does not silently switch providers.",
    parameters: WebSearchSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (id, params, signal, onUpdate, ctx) => {
      const result = await webSearch(id, params, signal ?? new AbortController().signal, onUpdate, ctx, pi.getThinkingLevel());
      return { ...result, isError: Boolean(result.details?.error) };
    },
  };
  const context: ToolDefinition<typeof UrlContextSchema> = {
    name: "url_context",
    label: "URL Context",
    description: "Analyze up to 20 public URLs with Gemini or Ollama Cloud. Other providers should use web_search instead.",
    parameters: UrlContextSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: async (id, params, signal, onUpdate, ctx) => {
      const result = await urlContext(id, params, signal ?? new AbortController().signal, onUpdate, ctx);
      return { ...result, isError: Boolean(result.details?.error) };
    },
  };
  return [search, context];
}

/** Host: register during load so native tool selection/restoration stays Pi-owned. */
export function registerBundledSearch(pi: ExtensionAPI): void {
  for (const tool of bundledSearchTools(pi)) pi.registerTool(tool);
}

/** Direct Pi entry: runtime inspection is unavailable during extension loading.
 * Register missing tools at session_start, without replacing installed extensions.
 * Host uses a separate replaceable factory instead, including across reload/replacement.
 */
export function registerDirectPiSearch(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const existing = new Set(pi.getAllTools().map(tool => tool.name));
    for (const tool of bundledSearchTools(pi)) {
      if (!existing.has(tool.name)) pi.registerTool(tool);
    }
  });
}
