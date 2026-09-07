export type ProjectMemoryType =
  | "decision"
  | "milestone"
  | "discovery"
  | "insight";

export interface ProjectMemorySemanticInput {
  readonly type: ProjectMemoryType;
  readonly memory: string;
  readonly summary: string;
  readonly whyItMatters: string;
  readonly consequence?: string;
  readonly supersedes?: string;
}

export interface ProjectMemoryFacts {
  readonly scope: string;
  readonly source: "Pindie";
  readonly date: string;
  readonly evidence: string;
}

export interface ProjectMemoryCapture extends ProjectMemorySemanticInput, ProjectMemoryFacts {
  readonly status: "Active";
}

export type ProjectMemoryCaptureOutcome =
  | "created"
  | "updated"
  | "duplicate"
  | "superseded";

export type ProjectMemoryCaptureResult =
  | {
      readonly ok: true;
      readonly outcome: ProjectMemoryCaptureOutcome;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface ProjectMemorySink {
  capture(memory: ProjectMemoryCapture): Promise<ProjectMemoryCaptureResult>;
}

const PROJECT_MEMORY_TYPES: readonly ProjectMemoryType[] = [
  "decision",
  "milestone",
  "discovery",
  "insight",
];

function normalizeRequired(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeOptional(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeRequired(value, field);
}

export function createProjectMemoryCapture(
  input: ProjectMemorySemanticInput,
  facts: ProjectMemoryFacts,
): ProjectMemoryCapture {
  if (!PROJECT_MEMORY_TYPES.includes(input.type)) {
    throw new Error("type must be decision, milestone, discovery, or insight.");
  }
  if (facts.source !== "Pindie") {
    throw new Error('source must be "Pindie".');
  }

  const consequence = normalizeOptional(input.consequence, "consequence");
  const supersedes = normalizeOptional(input.supersedes, "supersedes");

  return Object.freeze({
    type: input.type,
    memory: normalizeRequired(input.memory, "memory"),
    summary: normalizeRequired(input.summary, "summary"),
    whyItMatters: normalizeRequired(input.whyItMatters, "whyItMatters"),
    ...(consequence === undefined ? {} : { consequence }),
    ...(supersedes === undefined ? {} : { supersedes }),
    scope: normalizeRequired(facts.scope, "scope"),
    source: facts.source,
    date: normalizeRequired(facts.date, "date"),
    status: "Active",
    evidence: normalizeRequired(facts.evidence, "evidence"),
  });
}
