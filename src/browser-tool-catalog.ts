import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { BrowserUseConfig } from "@amaster.ai/pi-browser-use";

export const REQUIRED_BROWSER_TOOL_NAMES = Object.freeze([
  "list_pages", "select_page", "navigate_page", "take_snapshot", "take_screenshot",
  "click", "fill", "press_key", "evaluate_script", "list_console_messages",
  "get_console_message", "list_network_requests", "get_network_request",
] as const);

export interface BrowserToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface BrowserToolCatalog {
  readonly schemaVersion: 1;
  readonly browserUseVersion: string;
  readonly devtoolsVersion: string;
  readonly tools: readonly BrowserToolDeclaration[];
}

/** Same flags for catalog generation and actual browser-use execution. No auto-launch. */
export function browserClientConfig(browserUrl: string): BrowserUseConfig {
  return {
    sessionMode: "existing", browserUrl,
    categoryPerformance: false, categoryNetwork: true, categoryEmulation: true,
    categoryExtensions: false, experimentalVision: false, experimentalScreencast: false,
    experimentalMemory: false, experimentalPageIdRouting: true,
    usageStatistics: false, performanceCrux: false, redactNetworkHeaders: true,
    acceptInsecureCerts: false,
  };
}

export function installedBrowserToolVersions(): Pick<BrowserToolCatalog, "browserUseVersion" | "devtoolsVersion"> {
  const require = createRequire(import.meta.url);
  const browserUsePath = require.resolve("@amaster.ai/pi-browser-use/package.json");
  const browserRequire = createRequire(browserUsePath);
  return {
    browserUseVersion: (require(browserUsePath) as { version: string }).version,
    devtoolsVersion: (browserRequire("chrome-devtools-mcp/package.json") as { version: string }).version,
  };
}

export function selectBrowserToolDeclarations(tools: readonly BrowserToolDeclaration[]): BrowserToolDeclaration[] {
  return REQUIRED_BROWSER_TOOL_NAMES.map((name) => {
    const matches = tools.filter((tool) => tool.name === name);
    if (matches.length !== 1 || typeof matches[0]?.description !== "string" ||
        typeof matches[0]?.inputSchema !== "object" || matches[0].inputSchema === null) {
      throw new Error(`Browser tool catalog requires exactly one complete declaration for ${name}.`);
    }
    const tool = matches[0]!;
    return { name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) };
  });
}

/** Static published-tool snapshot; reading it never constructs an MCP client or Chrome. */
export function readBrowserToolCatalog(): BrowserToolCatalog {
  const value = JSON.parse(readFileSync(new URL("./browser-tool-catalog.json", import.meta.url), "utf8")) as BrowserToolCatalog;
  if (value.schemaVersion !== 1 || !Array.isArray(value.tools) ||
      !isDeepStrictEqual(value.tools, selectBrowserToolDeclarations(value.tools))) {
    throw new Error("Invalid Browser Reality tool catalog.");
  }
  return value;
}

export function browserToolCatalogCompatibility(catalog = readBrowserToolCatalog()): string | null {
  try {
    const installed = installedBrowserToolVersions();
    if (catalog.browserUseVersion !== installed.browserUseVersion || catalog.devtoolsVersion !== installed.devtoolsVersion) {
      return "Browser Reality tool catalog does not match installed browser-use/DevTools versions; regenerate and review the catalog before execution.";
    }
    return null;
  } catch {
    return "Browser Reality could not verify installed browser-use/DevTools versions.";
  }
}

/** Revalidate before first dispatch; a different capability/schema is never guessed. */
export function assertBrowserToolDeclarations(
  discovered: readonly BrowserToolDeclaration[],
  catalog = readBrowserToolCatalog(),
): void {
  const reason = browserToolCatalogCompatibility(catalog);
  if (reason) throw new Error(reason);
  if (!isDeepStrictEqual(selectBrowserToolDeclarations(discovered), catalog.tools)) {
    throw new Error("Browser Reality live DevTools declarations differ from the reviewed tool catalog.");
  }
}
