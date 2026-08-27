import { createHash, randomBytes } from "node:crypto";

export const MAX_EVIDENCE_REFS_PER_CHECK = 4;
export const MAX_INPUT_EXCERPT_CHARS = 1024;
export const MAX_RESULT_EXCERPT_CHARS = 4096;

export interface VerificationEvidenceCandidate {
  readonly ref: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly content: unknown;
  readonly isError: boolean;
}

export interface VerificationEvidenceScope {
  generation: number;
  nextSequence: number;
  readonly namespace: string;
  readonly candidates: Map<string, VerificationEvidenceCandidate>;
  readonly issuedRefs: Set<string>;
}

export interface CaptureVerificationEvidenceInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly content: unknown;
  readonly isError: boolean;
}

export type VerificationEvidenceResolver = (refs: readonly string[]) => string;

export function createVerificationEvidenceScope(): VerificationEvidenceScope {
  return {
    generation: 0,
    nextSequence: 1,
    namespace: randomBytes(12).toString("base64url"),
    candidates: new Map(),
    issuedRefs: new Set(),
  };
}

export function advanceEvidenceGeneration(
  scope: VerificationEvidenceScope,
): void {
  scope.generation += 1;
  scope.candidates.clear();
}

export function captureEvidenceCandidate(
  scope: VerificationEvidenceScope,
  input: CaptureVerificationEvidenceInput,
): VerificationEvidenceCandidate {
  const ref = `ev:${scope.namespace}:${scope.nextSequence}`;
  scope.nextSequence += 1;
  const candidate: VerificationEvidenceCandidate = {
    ref,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: input.input,
    content: input.content,
    isError: input.isError,
  };
  scope.candidates.set(candidate.ref, candidate);
  scope.issuedRefs.add(candidate.ref);
  return candidate;
}

function assertEvidenceRefs(refs: readonly string[]): void {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error("Pindie verification requires at least one evidence reference.");
  }
  if (refs.length > MAX_EVIDENCE_REFS_PER_CHECK) {
    throw new Error(
      `Pindie verification accepts at most ${MAX_EVIDENCE_REFS_PER_CHECK} evidence references.`,
    );
  }
  if (refs.some((ref) => typeof ref !== "string")) {
    throw new Error("Pindie evidence references must be strings.");
  }
  if (new Set(refs).size !== refs.length) {
    throw new Error("Pindie evidence references must be unique.");
  }
}

export function resolveEvidenceRefs(
  scope: VerificationEvidenceScope,
  refs: readonly string[],
): VerificationEvidenceCandidate[] {
  assertEvidenceRefs(refs);
  const candidates: VerificationEvidenceCandidate[] = [];
  for (const ref of refs) {
    const candidate = scope.candidates.get(ref);
    if (!candidate) {
      if (scope.issuedRefs.has(ref)) {
        throw new Error(
          `Stale Pindie evidence reference: ${ref}.\n` +
            "The referenced evidence is no longer valid for the current project state.\n" +
            "Run the relevant verification again.",
        );
      }
      throw new Error(`Unknown Pindie evidence reference: ${ref}`);
    }
    candidates.push(candidate);
  }
  return candidates;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeNumber(value: number): string {
  if (Number.isNaN(value)) return '"[NaN]"';
  if (value === Infinity) return '"[Infinity]"';
  if (value === -Infinity) return '"[-Infinity]"';
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function normalizeValue(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return normalizeNumber(value);
    case "boolean":
      return String(value);
    case "undefined":
      return '"[undefined]"';
    case "bigint":
      return JSON.stringify(`[bigint:${value.toString()}]`);
    case "symbol":
      return JSON.stringify(`[symbol:${value.description ?? ""}]`);
    case "function":
      return JSON.stringify(`[function:${value.name || "anonymous"}]`);
    case "object":
      break;
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return JSON.stringify(
      `[binary:${value.constructor.name};bytes=${bytes.length};sha256=${createHash("sha256").update(bytes).digest("hex")}]`,
    );
  }
  if (value instanceof ArrayBuffer) {
    const bytes = Buffer.from(value);
    return JSON.stringify(
      `[binary:ArrayBuffer;bytes=${bytes.length};sha256=${createHash("sha256").update(bytes).digest("hex")}]`,
    );
  }
  if (ancestors.has(value)) return '"[circular]"';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => normalizeValue(item, ancestors)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${normalizeValue(record[key], ancestors)}`);
    const tag = Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null
      ? []
      : [`"[type]":${JSON.stringify(value.constructor?.name ?? "Object")}`];
    return `{${[...tag, ...entries].join(",")}}`;
  } catch {
    return JSON.stringify(`[unsupported:${value.constructor?.name ?? "Object"}]`);
  } finally {
    ancestors.delete(value);
  }
}

function resultExcerptValue(content: unknown): string {
  if (!Array.isArray(content)) return normalizeValue(content);
  return content.map((block) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }

    const normalized = normalizeValue(block);
    const type = typeof block === "object" && block !== null &&
        typeof (block as { type?: unknown }).type === "string"
      ? (block as { type: string }).type
      : "unknown";
    return `[non-text content: type=${type}; SHA-256=${sha256(normalized)}]`;
  }).join("\n");
}

function boundedExcerpt(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n[truncated]`;
}

export function materializeVerificationEvidence(
  candidates: readonly VerificationEvidenceCandidate[],
): string {
  return candidates.map((candidate) => {
    const normalizedInput = normalizeValue(candidate.input);
    const normalizedResult = normalizeValue(candidate.content);
    const resultExcerpt = resultExcerptValue(candidate.content);
    return [
      `Tool: ${candidate.toolName}`,
      `Outcome: ${candidate.isError ? "error" : "success"}`,
      "Input:",
      boundedExcerpt(normalizedInput, MAX_INPUT_EXCERPT_CHARS),
      `Input SHA-256: ${sha256(normalizedInput)}`,
      "Result:",
      boundedExcerpt(resultExcerpt, MAX_RESULT_EXCERPT_CHARS),
      `Result SHA-256: ${sha256(normalizedResult)}`,
    ].join("\n");
  }).join("\n\n---\n\n");
}

export function resolveAndMaterializeEvidence(
  scope: VerificationEvidenceScope,
  refs: readonly string[],
): string {
  return materializeVerificationEvidence(resolveEvidenceRefs(scope, refs));
}
