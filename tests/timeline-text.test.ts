import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { boundedGraphemeText } from "../src/bounded-text.ts";
import { formatBlock } from "../src/timeline-text.ts";
import type { UiTimelineBlock } from "../src/ui-projection.ts";

test("shared bounded text preserves Unicode graphemes, width and row budgets", () => {
  const text = "中文👩🏽‍💻é".repeat(80);
  for (const width of [1, 2, 3, 8, 20, 80]) {
    const lines = boundedGraphemeText(text, width, 320, 4);
    assert.ok(lines.length <= 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.at(-1)!.endsWith("…"));
    assert.doesNotMatch(lines.join(""), /(?<!e)\u0301/u);
  }
  assert.deepEqual(boundedGraphemeText("👩🏽‍💻é中文", 20, 20, 2), ["👩🏽‍💻é中文"]);
  assert.deepEqual(boundedGraphemeText("a\r\nb\rc\td", 20, 20, 4), ["a", "b", "c   d"]);
  assert.deepEqual(boundedGraphemeText("é👩🏽‍💻中文", 20, 2, 4), ["é…"]);
  assert.deepEqual(boundedGraphemeText("text", 0, 10, 2), [""]);
});

test("shared timeline formatting retains message density and runtime details without mutation", () => {
  const message: UiTimelineBlock = Object.freeze({ type: "message", id: "m", source: "live", role: "user", delivery: "follow-up", text: "first line\nsecond line", lifecycle: "complete", defaultDisplayMode: "compact" });
  assert.equal(formatBlock(message), "● user·follow-up · first line…");
  assert.equal(formatBlock(message, "full"), "● user · follow-up\nfirst line\nsecond line");
  const runtime: UiTimelineBlock = { type: "runtime", id: "r", category: "quota", title: "Waiting", detail: "quota", defaultDisplayMode: "preview" };
  assert.equal(formatBlock(runtime), "· Waiting\nquota");
  assert.equal(formatBlock(runtime, "compact"), "· Waiting");
});

test("shared work formatting retains bounded command tails and observation failures", () => {
  const command: UiTimelineBlock = { type: "work", kind: "command", id: "cmd", toolCallId: "cmd", toolName: "bash", lifecycle: "complete", title: "Run tests", input: { command: "pnpm test" }, result: { isError: false, summary: "first\nsecond\nthird", details: null }, defaultDisplayMode: "preview" };
  assert.equal(formatBlock(command), "✓ Run tests\n  pnpm test\n  second\n  third");
  assert.equal(formatBlock(command, "compact"), "✓ Run tests");
  assert.match(formatBlock(command, "full"), /first/);
  const observations: UiTimelineBlock = { type: "work", kind: "observation", id: "obs", lifecycle: "failed", title: "Inspect", defaultDisplayMode: "preview", items: [{ toolCallId: "read", toolName: "read", input: null, label: "Reading file", lifecycle: "failed", result: { isError: true, summary: "missing file", details: null } }] };
  assert.equal(formatBlock(observations), "✕ Inspect\n  Read 1 file\n  Reading file\n  missing file");
  assert.equal(formatBlock(observations, "compact"), "✕ Inspect\n  Read 1 file");
  assert.equal(formatBlock(observations, "full"), "✕ Inspect\n  ✕ Reading file\n    missing file");
});

test("shared semantic timeline formatting retains Task, Verification, Gate and Completion", () => {
  const base = { type: "semantic", id: "s", lifecycle: "complete", defaultDisplayMode: "preview", error: null } as const;
  const task: UiTimelineBlock = { ...base, category: "task", action: "progress", goal: "Ship", taskStatus: "blocked", blockers: ["approval"], questions: ["When?"], nextIntent: "Review", successCriterionCount: 1, handoff: null };
  assert.equal(formatBlock(task), "◇ Task · blocked\n  Ship\n\nBlocked\n  approval\n\nQuestion\n  When?\n\n  Next: Review");
  const check = { name: "monitor", status: "failed", covers: ["c1"], evidence: "failure detail" } as const;
  const verification: UiTimelineBlock = { ...base, category: "verification", verificationStatus: "failed", coveredCriteria: [], totalCriteria: 1, checks: [check], pendingCheck: null };
  assert.equal(formatBlock(verification), "● Verification · 1 failed · 0/1\n  ✕ monitor\n    failure detail");
  const gate: UiTimelineBlock = { ...base, category: "human-gate", gateKind: "approval", question: "Proceed?", options: ["Yes", "No"], state: "open" };
  assert.equal(formatBlock(gate), "◆ Decision required\n  Proceed?\n\n  Yes\n  No");
  assert.equal(formatBlock({ ...gate, state: "resolved" }), "✓ Decision resolved\n  Proceed?");
  const completion: UiTimelineBlock = { ...base, category: "completion", summary: "Done", verificationStatus: "passed", checks: [{ ...check, status: "passed" }] };
  assert.equal(formatBlock(completion), "✓ Completed\n  Done\n\nVerification\n  ✓ monitor");
});
