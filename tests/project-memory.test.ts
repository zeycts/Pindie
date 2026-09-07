import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createProjectMemoryCapture,
  type ProjectMemoryFacts,
  type ProjectMemorySemanticInput,
} from "../src/project-memory.ts";

function semanticInput(
  overrides: Partial<ProjectMemorySemanticInput> = {},
): ProjectMemorySemanticInput {
  return {
    type: "decision",
    memory: "Use a narrow project-memory port.",
    summary: "Work Memory has a transport-independent domain boundary.",
    whyItMatters: "Future adapters do not need to change Pindie State.",
    ...overrides,
  };
}

function facts(overrides: Partial<ProjectMemoryFacts> = {}): ProjectMemoryFacts {
  return {
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05T10:00:00.000Z",
    evidence: "Task Work Memory v0.1 Slice A",
    ...overrides,
  };
}

test("semantic input and Harness facts create an Active project memory capture", () => {
  assert.deepEqual(createProjectMemoryCapture(semanticInput(), facts()), {
    type: "decision",
    memory: "Use a narrow project-memory port.",
    summary: "Work Memory has a transport-independent domain boundary.",
    whyItMatters: "Future adapters do not need to change Pindie State.",
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05T10:00:00.000Z",
    status: "Active",
    evidence: "Task Work Memory v0.1 Slice A",
  });
});

test("Harness facts cannot be supplied or overridden by semantic input", () => {
  const modelInput = {
    ...semanticInput(),
    scope: "model-supplied-scope",
    source: "Model",
    date: "model-supplied-date",
    status: "Superseded",
    evidence: "model-supplied-evidence",
  } as ProjectMemorySemanticInput;

  const capture = createProjectMemoryCapture(modelInput, facts());
  assert.equal(capture.scope, "Pindie");
  assert.equal(capture.source, "Pindie");
  assert.equal(capture.date, "2026-09-05T10:00:00.000Z");
  assert.equal(capture.status, "Active");
  assert.equal(capture.evidence, "Task Work Memory v0.1 Slice A");
});

test("capture normalizes semantic text and Harness factual strings", () => {
  const capture = createProjectMemoryCapture(
    semanticInput({
      memory: "  Durable conclusion  ",
      summary: "  Short summary  ",
      whyItMatters: "  Expensive to reconstruct  ",
      consequence: "  Keep adapters outside the domain  ",
      supersedes: "  Previous memory title  ",
    }),
    facts({
      scope: "  Pindie  ",
      date: "  2026-09-05  ",
      evidence: "  Architecture section 14  ",
    }),
  );

  assert.deepEqual(capture, {
    type: "decision",
    memory: "Durable conclusion",
    summary: "Short summary",
    whyItMatters: "Expensive to reconstruct",
    consequence: "Keep adapters outside the domain",
    supersedes: "Previous memory title",
    scope: "Pindie",
    source: "Pindie",
    date: "2026-09-05",
    status: "Active",
    evidence: "Architecture section 14",
  });
});

test("capture rejects empty required semantic content and illegal types", () => {
  for (const [field, value] of [
    ["memory", ""],
    ["summary", "  "],
    ["whyItMatters", "\n\t"],
  ] as const) {
    assert.throws(
      () => createProjectMemoryCapture(semanticInput({ [field]: value }), facts()),
      new RegExp(field),
    );
  }

  assert.throws(
    () => createProjectMemoryCapture(semanticInput({ type: "note" as never }), facts()),
    /type must be/,
  );
});

test("capture rejects empty or invalid Harness factual fields", () => {
  for (const [field, value] of [
    ["scope", ""],
    ["date", "  "],
    ["evidence", "\n"],
  ] as const) {
    assert.throws(
      () => createProjectMemoryCapture(semanticInput(), facts({ [field]: value })),
      new RegExp(field),
    );
  }

  assert.throws(
    () => createProjectMemoryCapture(semanticInput(), facts({ source: "Model" as never })),
    /source must be/,
  );
});

test("optional semantic fields are preserved when meaningful and omitted when absent", () => {
  const omitted = createProjectMemoryCapture(semanticInput(), facts());
  assert.equal("consequence" in omitted, false);
  assert.equal("supersedes" in omitted, false);

  const preserved = createProjectMemoryCapture(
    semanticInput({ consequence: "Stable consequence", supersedes: "Old title" }),
    facts(),
  );
  assert.equal(preserved.consequence, "Stable consequence");
  assert.equal(preserved.supersedes, "Old title");

  for (const field of ["consequence", "supersedes"] as const) {
    assert.throws(
      () => createProjectMemoryCapture(semanticInput({ [field]: "  " }), facts()),
      new RegExp(field),
    );
  }
});

test("project-memory domain boundary has no transport, filesystem, or PindieState dependency", async () => {
  const source = await readFile(new URL("../src/project-memory.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(?:Notion|PindieState|node:fs|fs\/promises)\b/);
});
