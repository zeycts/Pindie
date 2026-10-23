import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, TuiMainScreen, truncateToWidth, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { projectToolResult, type UiToolWorkBlock } from "../src/ui-timeline.ts";
import { watchNativeComponents } from "../src/watch-native-presentation.ts";
import { watchReadInput } from "../src/watch-presentation-data.ts";

const tui = new TuiMainScreen({ columns: 80, rows: 24 } as Terminal); // never started
// Component invalidation must not schedule terminal I/O in this presentation-only fixture.
let renderRequests = 0;
tui.requestRender = () => { renderRequests++; };
const result = (text: string, name = "bash") => projectToolResult({ content: [{ type: "text", text }] }, false, name)!;
function bash(text = "one\ntwo"): UiToolWorkBlock {
  return { type: "work", kind: "command", id: "b", toolCallId: "b", toolName: "bash", lifecycle: "complete", title: "Command", input: { command: "printf 'one\\ntwo'", secret: "DO NOT RENDER" }, result: result(text), defaultDisplayMode: "compact" };
}
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

// Exercise capability changes in both directions without depending on SSH/terminal env.
// Keep OSC 8 intact: assert the exact URL, visible label and closing boundary, not
// a generic ANSI-stripped snapshot that could hide a broken or unsafe renderer.
for (const [index, hyperlinks] of [false, true, false].entries()) {
test(`actual exported ToolExecutionComponent read/bash expanded render snapshots; no filesystem/process access (${index}: hyperlinks=${hyperlinks})`, (t) => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks });
  initTheme("dark", false);
  const accessed: string[] = [];
  const deny = (name: string) => () => { accessed.push(name); throw new Error(`Forbidden: ${name}`); };
  for (const key of ["readFileSync", "openSync", "statSync", "accessSync", "writeFileSync"] as const) t.mock.method(fs, key, deny(key));
  for (const key of ["readFile", "open", "stat", "access", "writeFile"] as const) t.mock.method(fsp, key, deny(key));
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) t.mock.method(childProcess, key, deny(key));
  syncBuiltinESMExports();
  try {
    renderRequests = 0;
    const b = watchNativeComponents(bash(), tui)!;
    assert.ok(b[0] instanceof ToolExecutionComponent);
    assert.deepEqual(plain(b[0]!.render(50)), ["", "", " $ printf 'one\\ntwo'", "", " one", " two", ""]);
    const read = { type: "work", kind: "observation", id: "observe:r", lifecycle: "complete", title: "Read", defaultDisplayMode: "compact", items: [
      { toolCallId: "r", toolName: "read", label: "Reading x.txt", input: { path: "remote-only-no-such-file.txt", offset: 2, limit: 3, secret: "DO NOT RENDER" }, lifecycle: "complete", result: result("alpha\nbeta", "read") },
    ] } as const;
    const r = watchNativeComponents(read, tui)!;
    assert.ok(r[0] instanceof ToolExecutionComponent);
    const path = "remote-only-no-such-file.txt";
    const label = hyperlinks ? `\x1b]8;;file:///${path}\x1b\\${path}\x1b]8;;\x1b\\` : path;
    assert.deepEqual(plain(r[0]!.render(60)), ["", "", ` read ${label}:2-4`, "", " alpha", " beta", ""]);
    assert.equal(renderRequests, 0); // no self-scheduling render loop or remote elapsed clock
    for (const component of [...b, ...r]) {
      component.invalidate();
      for (const width of [1, 2, 12, 80]) assert.ok(component.render(width).every((line) => visibleWidth(truncateToWidth(line, width)) <= width));
    }
    assert.deepEqual(accessed, []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); setCapabilities(capabilities); }
});
}

test("only provenance-marked bounded content reaches native results; summaries, details, secrets and invalid args fall back", () => {
  initTheme("dark", false);
  for (const input of [null, {}, { command: 4 }, { command: "" }, { command: "x".repeat(4_001) }, { command: "echo\x1b]52;secret" }]) {
    assert.equal(watchNativeComponents({ ...bash(), input }, tui), null);
  }
  for (const patch of [
    { result: { isError: false, summary: "not content", details: null } },
    { result: { ...result("real"), textContent: "invented" } },
    { result: { ...result("real"), isError: true } },
    { result: result("\x1b]52;secret") },
    { lifecycle: "running" as const },
    { toolName: "edit", input: { path: "/private", edits: [{ oldText: "a", newText: "b" }] } },
    { toolName: "write" },
  ]) assert.equal(watchNativeComponents({ ...bash(), ...patch }, tui), null);
  const rendered = watchNativeComponents(bash(), tui)!.flatMap((c) => c.render(80)).join("\n");
  assert.doesNotMatch(rendered, /DO NOT RENDER|Elapsed|Took/);
  assert.equal(watchReadInput({ path: "a", offset: -1 }), null);
  assert.equal(watchReadInput({ path: "a", limit: "2" }), null);
  assert.equal(watchReadInput({ path: "\x1bsecret" }), null);
  assert.deepEqual(watchReadInput({ path: "a", offset: 2, limit: 4, secret: "hidden" }), { path: "a", offset: 2, limit: 4 });
});

test("projection adds no output beyond existing summary; caps, details-only and merged-output provenance", () => {
  const read = result("x".repeat(10_000), "read");
  assert.equal(read.textContent, read.summary); assert.equal(read.textContent!.length, 4_000);
  const command = result(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(command.textContent, command.summary); assert.equal(command.textContent!.split("\n").length, 25);
  const merged = projectToolResult({ content: [{ type: "text", text: "visible" }], details: { stderr: "other" } }, false, "bash")!;
  assert.equal(merged.textContent, undefined);
  const detailsOnly = projectToolResult({ details: { output: "not original content" } }, false, "read")!;
  assert.equal(detailsOnly.textContent, undefined);
  assert.equal(result("text", "edit").textContent, undefined);
  assert.ok(watchNativeComponents(bash("x".repeat(10_000)), tui)!.flatMap((c) => c.render(80)).length < 100);
});
