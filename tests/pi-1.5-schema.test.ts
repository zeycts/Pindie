import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { PindieRuntime } from "../src/runtime.ts";
import * as task from "../src/tools/task.ts";
import { createPindieGateOpenTool, createPindieGateResolveTool } from "../src/tools/gate.ts";
import { createPindieGitObserveTool } from "../src/tools/git-observe.ts";
import { createPindieMemoryCaptureTool } from "../src/tools/memory.ts";
import { bundledSearchTools } from "../src/web-search.ts";
import { registerBrowserRealityExtension } from "../src/browser-reality.ts";

// Construct schemas only: no State, external sink, provider or browser execution.
const runtime = {} as PindieRuntime;
const browserTools: ToolDefinition[] = [];
registerBrowserRealityExtension({
  registerTool: (tool: ToolDefinition) => browserTools.push(tool), on: () => () => {},
} as unknown as ExtensionAPI, { manager: {} as Parameters<typeof registerBrowserRealityExtension>[1]["manager"] });
const tools: Pick<ToolDefinition, "name" | "description" | "parameters">[] = [
  task.createPindieTaskStartTool(runtime), task.createPindieTaskReplaceTool(runtime),
  task.createPindieTaskRefineTool(runtime), task.createPindieTaskProgressTool(runtime),
  task.createPindieTaskHandoffTool(runtime, { onHandoffStaged() {} }),
  task.createPindieVerificationRecordTool(runtime, { resolveEvidence: () => "fixture" }),
  task.createPindieTaskCompleteTool(runtime), createPindieGateOpenTool(runtime),
  createPindieGateResolveTool(runtime), createPindieGitObserveTool(),
  createPindieMemoryCaptureTool({ sink: { capture: async () => "created" }, getProjectRoot: () => null, getState: () => null }),
  ...bundledSearchTools({ getThinkingLevel: () => "off" }),
  ...browserTools,
];
const valid: Record<string, Record<string, unknown>> = {
  pindie_task_start: { goal: "upgrade", successCriteria: ["passes"] },
  pindie_task_replace: { goal: "upgrade", successCriteria: ["passes"] },
  pindie_task_refine: { goal: "upgrade" }, pindie_task_progress: { blockers: [], questions: [] },
  pindie_task_handoff: { progressSummary: "audit", decisions: [], nextIntent: null },
  pindie_verification_record: { check: { name: "test", status: "passed", covers: ["c1"], evidenceRefs: ["ev:fixture:1"] } },
  pindie_task_complete: { summary: "done" }, pindie_gate_open: { kind: "approval", question: "Proceed?" },
  pindie_gate_resolve: {}, pindie_git_observe: { action: "log", limit: 5 },
  pindie_memory_capture: { type: "decision", memory: "Keep models", summary: "No change", whyItMatters: "Preserves intent" },
  web_search: { query: "Pi" }, url_context: { query: "Pi", urls: ["https://example.com"] },
  browser_list_pages: {}, browser_select_page: { pageId: 1 }, browser_navigate_page: { pageId: 1 },
  browser_take_snapshot: { pageId: 1 }, browser_take_screenshot: { pageId: 1 },
  browser_click: { pageId: 1, uid: "a" }, browser_fill: { pageId: 1, uid: "a", value: "text" },
  browser_press_key: { pageId: 1, key: "Enter" }, browser_evaluate_script: { pageId: 1, function: "() => 1" },
  browser_list_console_messages: { pageId: 1 }, browser_get_console_message: { pageId: 1, msgid: 1 },
  browser_list_network_requests: { pageId: 1 }, browser_get_network_request: { pageId: 1 },
  browser_release: {}, browser_status: {},
};
function parse(name: string, args: Record<string, unknown>) {
  const tool = tools.find((tool) => tool.name === name)!;
  return validateToolArguments(tool, { type: "toolCall", id: "fixture", name, arguments: args });
}

test("Pi 1.5 validates every Pindie tool JSON Schema, including TypeBox enums and plain browser schemas", () => {
  assert.equal(tools.length, 28);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(valid).sort());
  for (const tool of tools) {
    const input = valid[tool.name]!;
    assert.doesNotThrow(() => parse(tool.name, input), tool.name);
    // Native TypeBox consumers must also retain the enum kind, not just JSON validation.
    if (tool.name.startsWith("pindie_")) assert.equal(Value.Check(tool.parameters, input), true, tool.name);
  }
});

test("TypeBox rejects invalid strings in all four Type.Unsafe-wrapped enums", () => {
  for (const [name, input] of [
    ["pindie_gate_open", { ...valid.pindie_gate_open, kind: "other" }],
    ["pindie_git_observe", { ...valid.pindie_git_observe, action: "other" }],
    ["pindie_memory_capture", { ...valid.pindie_memory_capture, type: "other" }],
    ["pindie_verification_record", { check: { ...valid.pindie_verification_record!.check as object, status: "other" } }],
  ] as const) {
    const tool = tools.find((tool) => tool.name === name)!;
    assert.equal(Value.Check(tool.parameters, valid[name]!), true, `${name}: valid control`);
    assert.equal(Value.Check(tool.parameters, input), false, `${name}: invalid enum string`);
  }
});

test("Pi 1.5 enforces enum, object, collection and scalar bounds before execution", () => {
  for (const [name, args] of [
    ["pindie_gate_open", { kind: "other", question: "?" }],
    ["pindie_git_observe", { action: "other" }],
    ["pindie_git_observe", { action: "log", limit: 51 }],
    ["pindie_task_start", { goal: "x", successCriteria: [] }],
    ["pindie_task_refine", {}],
    ["pindie_memory_capture", { ...valid.pindie_memory_capture, type: "other" }],
    ["pindie_memory_capture", { ...valid.pindie_memory_capture, scope: "invented" }],
    ["pindie_verification_record", { check: { ...valid.pindie_verification_record!.check as object, status: "other" } }],
    ["pindie_verification_record", { check: { ...valid.pindie_verification_record!.check as object, evidenceRefs: ["same", "same"] } }],
    ["url_context", { query: "x", urls: [] }],
    ["web_search", { query: "x", urls: Array(21).fill("https://example.com") }],
    ["browser_take_screenshot", { pageId: 1, quality: 101 }],
    ["browser_list_network_requests", { pageId: 1, pageSize: 0 }],
  ] as const) assert.throws(() => parse(name, args), /Validation failed/, name);
  assert.throws(() => parse("pindie_gate_open", {}), /kind: missing/);
});

test("Pi 1.5 coercion is consistent for TypeBox and raw browser schemas without mutating transcript arguments", () => {
  const input = { action: "log", limit: "5", paths: null };
  assert.deepEqual(parse("pindie_git_observe", input), { action: "log", limit: 5 });
  assert.deepEqual(input, { action: "log", limit: "5", paths: null });
  assert.deepEqual(parse("browser_select_page", { pageId: "2", bringToFront: "true" }), { pageId: 2, bringToFront: true });
  assert.deepEqual(parse("browser_evaluate_script", { pageId: 1, function: "() => 1", args: "a" }), { pageId: 1, function: "() => 1", args: ["a"] });
  assert.deepEqual(parse("web_search", { query: "x", urls: "https://example.com" }), { query: "x", urls: ["https://example.com"] });
});
