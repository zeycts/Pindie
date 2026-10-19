import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserToolDeclarations,
  browserClientConfig,
  browserToolCatalogCompatibility,
  installedBrowserToolVersions,
  readBrowserToolCatalog,
  REQUIRED_BROWSER_TOOL_NAMES,
  selectBrowserToolDeclarations,
} from "../src/browser-tool-catalog.ts";

test("reviewed browser catalog binds the exact installed package versions and original 13 tools", () => {
  const catalog = readBrowserToolCatalog();
  assert.deepEqual(installedBrowserToolVersions(), { browserUseVersion: "0.1.15", devtoolsVersion: "1.9.0" });
  assert.equal(browserToolCatalogCompatibility(catalog), null);
  assert.deepEqual(catalog.tools.map((tool) => tool.name), REQUIRED_BROWSER_TOOL_NAMES);
  assert.equal(catalog.tools.length, 13);
  for (const tool of catalog.tools) {
    assert.ok(tool.description?.length);
    assert.equal(tool.inputSchema.type, "object");
  }
  assertBrowserToolDeclarations(catalog.tools);
});

test("declaration ordering and unrelated upstream tools do not alter the selected surface", () => {
  const catalog = readBrowserToolCatalog();
  const discovered = [{ name: "unrelated", inputSchema: {} }, ...[...catalog.tools].reverse()];
  assert.deepEqual(selectBrowserToolDeclarations(discovered), catalog.tools);
  assertBrowserToolDeclarations(discovered);
});

test("missing, duplicate, description and JSON-schema drift fail closed", () => {
  const catalog = readBrowserToolCatalog();
  assert.throws(() => assertBrowserToolDeclarations(catalog.tools.slice(1)), /exactly one complete declaration/);
  assert.throws(() => assertBrowserToolDeclarations([...catalog.tools, catalog.tools[0]!]), /exactly one complete declaration/);
  for (const field of ["description", "inputSchema"] as const) {
    const changed = structuredClone(catalog.tools);
    if (field === "description") changed[0] = { ...changed[0]!, description: "different upstream semantics" };
    else changed[0] = { ...changed[0]!, inputSchema: { type: "object", properties: { changed: { type: "boolean" } } } };
    assert.throws(() => assertBrowserToolDeclarations(changed), /differ from the reviewed tool catalog/);
  }
});

test("a different installed-package binding cannot silently authorize the catalog", () => {
  const catalog = readBrowserToolCatalog();
  for (const versions of [{ browserUseVersion: "0.0.0" }, { devtoolsVersion: "0.0.0" }]) {
    const mismatched = { ...catalog, ...versions };
    assert.match(browserToolCatalogCompatibility(mismatched) ?? "", /does not match installed/);
    assert.throws(() => assertBrowserToolDeclarations(catalog.tools, mismatched), /does not match installed/);
  }
});

test("catalog reads and selected declarations are detached; existing-session config never requests launch", () => {
  const first = readBrowserToolCatalog();
  const selected = selectBrowserToolDeclarations(first.tools);
  selected[0]!.inputSchema.changed = true;
  assert.notDeepEqual(selected, readBrowserToolCatalog().tools);
  assert.deepEqual(readBrowserToolCatalog(), first);
  const config = browserClientConfig("http://127.0.0.1:1");
  assert.equal(config.sessionMode, "existing");
  assert.equal(config.usageStatistics, false);
  assert.equal(config.experimentalPageIdRouting, true);
});
