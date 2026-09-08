import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";

import {
  type ProjectMemoryCapture,
  type ProjectMemoryCaptureResult,
  type ProjectMemorySemanticInput,
  type ProjectMemorySink,
} from "../src/project-memory.ts";
import type { PindieState } from "../src/state.ts";
import { createPindieMemoryCaptureTool } from "../src/tools/memory.ts";

class FakeMemorySink implements ProjectMemorySink {
  readonly captures: ProjectMemoryCapture[] = [];
  result: ProjectMemoryCaptureResult = { ok: true, outcome: "created" };
  thrown: unknown = null;

  async capture(memory: ProjectMemoryCapture): Promise<ProjectMemoryCaptureResult> {
    this.captures.push(memory);
    if (this.thrown !== null) throw this.thrown;
    return this.result;
  }
}

function taskState(goal: string | null, completed = false): PindieState {
  return {
    task: goal === null
      ? null
      : {
          goal,
          constraints: [],
          successCriteria: [{ id: "c1", description: "Capture works" }],
          openLoops: { blockers: [], questions: [], nextIntent: null },
          verification: { stale: false, checks: [] },
          humanGate: null,
          completed,
        },
  };
}

function semanticParams(
  overrides: Partial<ProjectMemorySemanticInput> = {},
): ProjectMemorySemanticInput {
  return {
    type: "decision",
    memory: "Keep Work Memory behind a narrow sink.",
    summary: "The capture boundary is transport-independent.",
    whyItMatters: "Future persistence changes do not affect semantic callers.",
    ...overrides,
  };
}

function createTool(
  sink: FakeMemorySink,
  options: {
    readonly projectRoot?: string | null;
    readonly state?: PindieState | null;
    readonly now?: () => Date;
  } = {},
) {
  return createPindieMemoryCaptureTool({
    sink,
    getProjectRoot: () => options.projectRoot === undefined
      ? "/home/zey/dev/Pindie"
      : options.projectRoot,
    getState: () => options.state === undefined ? taskState(null) : options.state,
    now: options.now,
  });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

test("memory tool has a strict semantic-only schema and sequential execution", () => {
  const tool = createTool(new FakeMemorySink());
  const schema = tool.parameters as any;
  const propertyNames = Object.keys(schema.properties).sort();

  assert.equal(tool.name, "pindie_memory_capture");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(propertyNames, [
    "consequence",
    "memory",
    "summary",
    "supersedes",
    "type",
    "whyItMatters",
  ]);
  assert.deepEqual(schema.required, ["type", "memory", "summary", "whyItMatters"]);
  assert.deepEqual(schema.properties.type.enum, ["decision", "milestone", "discovery", "insight"]);
  for (const field of ["memory", "summary", "whyItMatters", "consequence", "supersedes"]) {
    assert.equal(schema.properties[field].minLength, 1, field);
  }

  const valid = semanticParams();
  assert.equal(Value.Check(schema, valid), true);
  assert.equal(Value.Check(schema, { ...valid, scope: "Model scope" }), false);
  assert.equal(Value.Check(schema, { ...valid, source: "Model" }), false);
  assert.equal(Value.Check(schema, { ...valid, date: "2026-09-05" }), false);
  assert.equal(Value.Check(schema, { ...valid, status: "Superseded" }), false);
  assert.equal(Value.Check(schema, { ...valid, evidence: "Model evidence" }), false);
  assert.equal(Value.Check(schema, { ...valid, projectRoot: "/tmp/project" }), false);
  assert.equal(Value.Check(schema, { ...valid, task: "Model task" }), false);
});

test("all four semantic memory types are accepted and reach the sink", async () => {
  const sink = new FakeMemorySink();
  const tool = createTool(sink);

  for (const type of ["decision", "milestone", "discovery", "insight"] as const) {
    const result = await tool.execute("capture", semanticParams({ type }));
    assert.equal(textOf(result), "Work Memory: created.");
  }

  assert.deepEqual(sink.captures.map((capture) => capture.type), [
    "decision",
    "milestone",
    "discovery",
    "insight",
  ]);
});

test("Harness assembles Scope, Source, local Date, Status, and no-Task Evidence", async () => {
  const sink = new FakeMemorySink();
  const clock = new Date(2026, 8, 5, 0, 30, 0);
  const tool = createTool(sink, {
    now: () => clock,
    state: taskState(null),
  });

  await tool.execute("capture", semanticParams({
    consequence: "Adapters remain outside the domain.",
    supersedes: "An earlier transport-specific decision",
  }));

  assert.deepEqual(sink.captures[0], {
    type: "decision",
    memory: "Keep Work Memory behind a narrow sink.",
    summary: "The capture boundary is transport-independent.",
    whyItMatters: "Future persistence changes do not affect semantic callers.",
    consequence: "Adapters remain outside the domain.",
    supersedes: "An earlier transport-specific decision",
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05",
    status: "Active",
    evidence: "Pindie · project=Pindie",
  });
});

test("null authoritative State fails closed before the sink is called", async () => {
  const sink = new FakeMemorySink();
  const result = await createTool(sink, { state: null }).execute(
    "capture",
    semanticParams(),
  );

  assert.match(textOf(result), /Work Memory capture failed: authoritative State is unavailable\./);
  assert.equal(sink.captures.length, 0);
});

test("a throwing authoritative State getter remains bounded and non-blocking", async () => {
  const sink = new FakeMemorySink();
  const tool = createPindieMemoryCaptureTool({
    sink,
    getProjectRoot: () => "/home/zey/dev/Pindie",
    getState: () => {
      throw new Error("secret State details");
    },
    now: () => new Date(2026, 8, 5),
  });

  const result = await tool.execute("capture", semanticParams());
  const text = textOf(result);
  assert.match(text, /Work Memory capture failed: authoritative State is unavailable\./);
  assert.doesNotMatch(text, /secret State details/);
  assert.match(text, /Continue the primary work; do not retry automatically\./);
  assert.equal(sink.captures.length, 0);
});

test("Harness Evidence includes the current Task goal and remains bounded", async () => {
  const sink = new FakeMemorySink();
  const goal = "Return to the project and preserve the settled architectural direction.";
  const tool = createTool(sink, { state: taskState(goal) });
  await tool.execute("capture", semanticParams());

  assert.equal(
    sink.captures[0]?.evidence,
    `Pindie · project=Pindie · task=${goal}`,
  );

  const longSink = new FakeMemorySink();
  const longGoal = "long goal ".repeat(100);
  await createTool(longSink, { state: taskState(longGoal) }).execute(
    "capture",
    semanticParams(),
  );
  const longEvidence = longSink.captures[0]?.evidence ?? "";
  assert.equal(longEvidence.startsWith("Pindie · project=Pindie · task="), true);
  assert.equal(longEvidence.length <= "Pindie · project=Pindie · task=".length + 160, true);
  assert.match(longEvidence, /…$/);
});

test("completed Task is excluded from Harness Evidence", async () => {
  const sink = new FakeMemorySink();
  const tool = createTool(sink, {
    state: taskState("Completed task goal", true),
  });

  await tool.execute("capture", semanticParams());

  assert.equal(sink.captures[0]?.evidence, "Pindie · project=Pindie");
});

test("model parameters cannot override Harness facts", async () => {
  const sink = new FakeMemorySink();
  const tool = createTool(sink, {
    projectRoot: "/home/zey/dev/Pindie",
    state: taskState("Authoritative task goal"),
    now: () => new Date(2026, 8, 5),
  });
  const maliciousParams = {
    ...semanticParams(),
    scope: "Model scope",
    source: "Model",
    date: "1900-01-01",
    status: "Superseded",
    evidence: "Model evidence",
    projectRoot: "/tmp/other-project",
    task: "Model task",
  } as any;

  const result = await tool.execute("capture", maliciousParams);
  assert.equal(textOf(result), "Work Memory: created.");
  assert.equal(sink.captures.length, 1);
  assert.deepEqual(
    (({ scope, source, date, status, evidence }: ProjectMemoryCapture) => ({
      scope,
      source,
      date,
      status,
      evidence,
    }))(sink.captures[0]!),
    {
      scope: "Pindie",
      source: "Pindie",
      date: "2026-09-05",
      status: "Active",
      evidence: "Pindie · project=Pindie · task=Authoritative task goal",
    },
  );
});

test("sink outcomes map to concise success results", async () => {
  for (const outcome of ["created", "updated", "duplicate", "superseded"] as const) {
    const sink = new FakeMemorySink();
    sink.result = { ok: true, outcome };
    const result = await createTool(sink).execute("capture", semanticParams());
    assert.equal(textOf(result), `Work Memory: ${outcome}.`);
  }
});

test("sink failures are bounded and non-blocking", async () => {
  const sink = new FakeMemorySink();
  const rawFailure = "sink failure ".repeat(100);
  sink.result = { ok: false, error: rawFailure };

  const result = await createTool(sink).execute("capture", semanticParams());
  const text = textOf(result);
  assert.match(text, /^Work Memory capture failed:/);
  assert.match(text, /Continue the primary work; do not retry automatically\.$/);
  assert.equal(text.length < 600, true);
  assert.equal(text.includes(rawFailure), false);
});

test("unexpected sink throws become generic non-leaking failures", async () => {
  const sink = new FakeMemorySink();
  const secret = "secret-token=do-not-leak";
  sink.thrown = new Error(secret);

  const result = await createTool(sink).execute("capture", semanticParams());
  const text = textOf(result);
  assert.match(text, /Work Memory capture failed: external Work Memory sink failed\./);
  assert.doesNotMatch(text, new RegExp(secret));
  assert.match(text, /Continue the primary work; do not retry automatically\./);
});

test("unavailable project root fails before the sink is called", async () => {
  const sink = new FakeMemorySink();
  const result = await createTool(sink, { projectRoot: null }).execute(
    "capture",
    semanticParams(),
  );

  assert.match(textOf(result), /Work Memory capture failed: project Scope is unavailable\./);
  assert.equal(sink.captures.length, 0);
});

test("invalid Harness clock and factual assembly failures remain bounded", async () => {
  const invalidClockSink = new FakeMemorySink();
  const invalidClock = await createTool(invalidClockSink, {
    now: () => new Date(Number.NaN),
  }).execute("capture", semanticParams());
  assert.match(textOf(invalidClock), /Work Memory capture failed: Harness Date is unavailable\./);
  assert.equal(invalidClockSink.captures.length, 0);

  const invalidInputSink = new FakeMemorySink();
  const invalidInput = await createTool(invalidInputSink).execute(
    "capture",
    { ...semanticParams(), memory: "   " } as any,
  );
  assert.match(textOf(invalidInput), /Work Memory capture failed: invalid capture input/);
  assert.equal(invalidInputSink.captures.length, 0);
});

test("the tool has no Notion, filesystem, or runtime-infrastructure dependency", async () => {
  const source = await readFile(new URL("../src/tools/memory.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /@notionhq\/client|notion-project-memory|PINDIE_NOTION_TOKEN|dataSourceId/);
  assert.doesNotMatch(source, /node:fs|fs\/promises|ExtensionAPI|setTimeout|queue/);
});
