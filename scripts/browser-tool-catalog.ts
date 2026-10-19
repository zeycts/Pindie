import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { DevToolsClient } from "@amaster.ai/pi-browser-use";
import {
  browserClientConfig,
  installedBrowserToolVersions,
  readBrowserToolCatalog,
  selectBrowserToolDeclarations,
  type BrowserToolCatalog,
} from "../src/browser-tool-catalog.ts";

// Explicit maintenance command only, never part of Host or Session startup.
// listTools is metadata-only: no browser is launched and no tool is executed.
// The existing-session URL is deliberately not a running browser endpoint.
if (process.argv.length > 3 || !["--check", "--write"].includes(process.argv[2] ?? "--check")) {
  throw new Error("Usage: node --experimental-strip-types scripts/browser-tool-catalog.ts [--check|--write]");
}
const client = new DevToolsClient(browserClientConfig("http://127.0.0.1:1"));
try {
  const tools = selectBrowserToolDeclarations(await client.listAllTools(AbortSignal.timeout(15_000)));
  const catalog: BrowserToolCatalog = { schemaVersion: 1, ...installedBrowserToolVersions(), tools };
  if (process.argv[2] === "--write") {
    await writeFile(new URL("../src/browser-tool-catalog.json", import.meta.url), `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(`Wrote ${tools.length} published tool declarations; review before committing.`);
  } else {
    assert.deepEqual(catalog, readBrowserToolCatalog());
    console.log(`PASS: ${tools.length} catalog declarations exactly match pinned browser-use/DevTools listTools.`);
  }
} finally {
  await client.close();
}
