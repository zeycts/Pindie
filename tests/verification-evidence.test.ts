import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAX_INPUT_EXCERPT_CHARS,
  MAX_RESULT_EXCERPT_CHARS,
  advanceEvidenceGeneration,
  captureEvidenceCandidate,
  createVerificationEvidenceScope,
  materializeVerificationEvidence,
  resolveEvidenceRefs,
} from "../src/verification-evidence.ts";

function capture(
  toolCallId = "toolu_01AbCd",
  overrides: Partial<Parameters<typeof captureEvidenceCandidate>[1]> = {},
) {
  const scope = createVerificationEvidenceScope();
  const candidate = captureEvidenceCandidate(scope, {
    toolCallId,
    toolName: "read",
    input: { path: "src/index.ts" },
    content: [{ type: "text", text: "export const ready = true;" }],
    isError: false,
    ...overrides,
  });
  return { scope, candidate };
}

test("E01 evidence refs are short Pindie-owned opaque handles", () => {
  const toolCallId =
    "call_FccSunaPr01Ht5kd0YVx8WoB|fc_07cbfcb752e64889016a9021_more-provider-data";
  const { candidate } = capture(toolCallId);
  assert.match(candidate.ref, /^ev:[A-Za-z0-9_-]+:\d+$/);
  assert.ok(candidate.ref.length < 32);
  assert.doesNotMatch(candidate.ref, /call_FccSuna|fc_07cb|\|/);
  assert.equal(candidate.toolCallId, toolCallId);
});

test("E02 a fresh evidence scope starts empty", () => {
  const scope = createVerificationEvidenceScope();
  assert.equal(scope.generation, 0);
  assert.equal(scope.candidates.size, 0);
  assert.equal(scope.issuedRefs.size, 0);
});

test("E03 capturing a candidate makes its ref resolvable", () => {
  const { scope, candidate } = capture();
  assert.deepEqual(resolveEvidenceRefs(scope, [candidate.ref]), [candidate]);
});

test("E04 generation advance increments once and clears current candidates", () => {
  const { scope } = capture();
  advanceEvidenceGeneration(scope);
  assert.equal(scope.generation, 1);
  assert.equal(scope.candidates.size, 0);
});

test("E05 generation advance makes a prior ref explicitly stale", () => {
  const { scope, candidate } = capture();
  advanceEvidenceGeneration(scope);
  assert.throws(
    () => resolveEvidenceRefs(scope, [candidate.ref]),
    /Stale Pindie evidence reference: ev:.*\nThe referenced evidence is no longer valid for the current project state\.\nRun the relevant verification again\./,
  );
});

test("E06 resolving a candidate repeatedly does not consume it", () => {
  const { scope, candidate } = capture();
  assert.equal(resolveEvidenceRefs(scope, [candidate.ref])[0], candidate);
  assert.equal(resolveEvidenceRefs(scope, [candidate.ref])[0], candidate);
  assert.equal(scope.candidates.size, 1);
});

test("E07 unknown evidence refs reject", () => {
  const scope = createVerificationEvidenceScope();
  assert.throws(
    () => resolveEvidenceRefs(scope, [`ev:${scope.namespace}:99`]),
    /Unknown Pindie evidence reference:/,
  );
});

test("E07b multiple candidates in one scope receive distinct handles", () => {
  const scope = createVerificationEvidenceScope();
  const first = captureEvidenceCandidate(scope, {
    toolCallId: "same-provider-id",
    toolName: "read",
    input: {},
    content: [],
    isError: false,
  });
  const second = captureEvidenceCandidate(scope, {
    toolCallId: "same-provider-id",
    toolName: "read",
    input: {},
    content: [],
    isError: false,
  });
  assert.notEqual(first.ref, second.ref);
});

test("E07c invalidated handles are never rebound to newer evidence", () => {
  const { scope, candidate: first } = capture("first-provider-id");
  advanceEvidenceGeneration(scope);
  const second = captureEvidenceCandidate(scope, {
    toolCallId: "second-provider-id",
    toolName: "read",
    input: {},
    content: [],
    isError: false,
  });
  assert.notEqual(first.ref, second.ref);
  assert.throws(
    () => resolveEvidenceRefs(scope, [first.ref]),
    /Stale Pindie evidence reference:/,
  );
  assert.equal(resolveEvidenceRefs(scope, [second.ref])[0], second);
});

test("E08 duplicate evidence refs reject", () => {
  const { scope, candidate } = capture();
  assert.throws(
    () => resolveEvidenceRefs(scope, [candidate.ref, candidate.ref]),
    /must be unique/,
  );
});

test("E09 zero evidence refs reject", () => {
  assert.throws(
    () => resolveEvidenceRefs(createVerificationEvidenceScope(), []),
    /at least one evidence reference/,
  );
});

test("E10 more than four evidence refs reject", () => {
  assert.throws(
    () => resolveEvidenceRefs(createVerificationEvidenceScope(), ["ev:1", "ev:2", "ev:3", "ev:4", "ev:5"]),
    /at most 4 evidence references/,
  );
});

test("E11 materialization includes the exact tool name", () => {
  const { candidate } = capture("bash-1", { toolName: "bash" });
  assert.match(materializeVerificationEvidence([candidate]), /^Tool: bash$/m);
});

test("E12 materialization records factual success outcome", () => {
  const { candidate } = capture();
  assert.match(materializeVerificationEvidence([candidate]), /^Outcome: success$/m);
});

test("E13 materialization records factual error outcome", () => {
  const { candidate } = capture("read-error", { isError: true });
  assert.match(materializeVerificationEvidence([candidate]), /^Outcome: error$/m);
});

test("E14 materialization includes a bounded stable input representation", () => {
  const { candidate } = capture("input", { input: { z: 2, a: 1 } });
  const evidence = materializeVerificationEvidence([candidate]);
  assert.match(evidence, /Input:\n\{"a":1,"z":2\}\nInput SHA-256:/);
});

test("E15 materialization includes bounded text result content", () => {
  const { candidate } = capture("result", {
    content: [{ type: "text", text: "TypeScript passed." }],
  });
  assert.match(
    materializeVerificationEvidence([candidate]),
    /Result:\nTypeScript passed\.\nResult SHA-256:/,
  );
});

test("E16 input beyond 1024 chars is truncated while retaining the full digest", () => {
  const input = "i".repeat(MAX_INPUT_EXCERPT_CHARS + 100);
  const { candidate } = capture("long-input", { input });
  const normalized = JSON.stringify(input);
  const digest = createHash("sha256").update(normalized).digest("hex");
  const evidence = materializeVerificationEvidence([candidate]);
  assert.match(evidence, /\[truncated\]/);
  assert.match(evidence, new RegExp(`Input SHA-256: ${digest}`));
  assert.equal(evidence.includes("i".repeat(MAX_INPUT_EXCERPT_CHARS + 1)), false);
});

test("E17 result beyond 4096 chars is truncated while retaining the full digest", () => {
  const text = "r".repeat(MAX_RESULT_EXCERPT_CHARS + 100);
  const content = [{ type: "text", text }];
  const { candidate } = capture("long-result", { content });
  const normalized = `[{\"text\":${JSON.stringify(text)},\"type\":\"text\"}]`;
  const digest = createHash("sha256").update(normalized).digest("hex");
  const evidence = materializeVerificationEvidence([candidate]);
  assert.match(evidence, /\[truncated\]/);
  assert.match(evidence, new RegExp(`Result SHA-256: ${digest}`));
  assert.equal(evidence.includes("r".repeat(MAX_RESULT_EXCERPT_CHARS + 1)), false);
});

test("E18 materialization preserves the supplied ref resolution order", () => {
  const scope = createVerificationEvidenceScope();
  const first = captureEvidenceCandidate(scope, {
    toolCallId: "first", toolName: "read", input: {}, content: [], isError: false,
  });
  const second = captureEvidenceCandidate(scope, {
    toolCallId: "second", toolName: "bash", input: {}, content: [], isError: false,
  });
  const evidence = materializeVerificationEvidence(
    resolveEvidenceRefs(scope, [second.ref, first.ref]),
  );
  assert.ok(evidence.indexOf("Tool: bash") < evidence.indexOf("Tool: read"));
});

test("E19 durable materialization omits the runtime evidence ref and toolCallId", () => {
  const { candidate } = capture("toolu_secret_identity");
  const evidence = materializeVerificationEvidence([candidate]);
  assert.equal(evidence.includes(candidate.ref), false);
  assert.doesNotMatch(evidence, /toolu_secret_identity/);
});

test("E20 durable materialization omits evidence generation metadata", () => {
  const { candidate } = capture();
  assert.doesNotMatch(materializeVerificationEvidence([candidate]), /generation/i);
});

test("E21 non-text image-like content persists a digest, never raw base64", () => {
  const rawBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const { candidate } = capture("image", {
    content: [{ type: "image", mimeType: "image/png", data: rawBase64 }],
  });
  const evidence = materializeVerificationEvidence([candidate]);
  assert.doesNotMatch(evidence, new RegExp(rawBase64));
  assert.match(evidence, /\[non-text content: type=image; SHA-256=[a-f0-9]{64}\]/);
});

test("E22 identical factual candidates materialize deterministically", () => {
  const { candidate } = capture();
  assert.equal(
    materializeVerificationEvidence([candidate]),
    materializeVerificationEvidence([{ ...candidate }]),
  );
});
