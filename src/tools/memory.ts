import { basename } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createProjectMemoryCapture,
  type ProjectMemoryCaptureOutcome,
  type ProjectMemorySink,
  type ProjectMemoryType,
} from "../project-memory.ts";
import type { PindieState } from "../state.ts";

const MEMORY_TYPES: readonly ProjectMemoryType[] = [
  "decision",
  "milestone",
  "discovery",
  "insight",
];

const MemoryCaptureParameters = Type.Object(
  {
    type: StringEnum(MEMORY_TYPES, {
      description: "Semantic category of the durable Work Memory state.",
    }),
    memory: Type.String({
      minLength: 1,
      description: "Durable conclusion or state, not an activity log.",
    }),
    summary: Type.String({
      minLength: 1,
      description: "Concise explanation of the durable state.",
    }),
    whyItMatters: Type.String({
      minLength: 1,
      description: "Why this information will matter when returning to the project.",
    }),
    consequence: Type.Optional(Type.String({
      minLength: 1,
      description: "An optional consequence that has already become stable.",
    })),
    supersedes: Type.Optional(Type.String({
      minLength: 1,
      description: "Exact title of an existing Active Memory that this replaces, if any.",
    })),
  },
  { additionalProperties: false },
);

const MAX_TASK_GOAL_LENGTH = 160;
const MAX_FAILURE_DETAIL_LENGTH = 240;
const CAPTURE_RETRY_MESSAGE = "Continue the primary work; do not retry automatically.";

export interface PindieMemoryToolOptions {
  readonly sink: ProjectMemorySink;
  /** Canonical project root supplied by the Harness at execution time. */
  readonly getProjectRoot: () => string | null;
  /** Current authoritative State supplied by the Harness at execution time. */
  readonly getState: () => PindieState | null;
  /** Harness clock seam; the default uses the local machine clock. */
  readonly now?: () => Date;
}

function result(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: undefined,
  };
}

function success(outcome: ProjectMemoryCaptureOutcome) {
  return result(`Work Memory: ${outcome}.`);
}

function boundedText(value: string, maxLength = MAX_FAILURE_DETAIL_LENGTH): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function failure(reason: string): ReturnType<typeof result> {
  return result(`Work Memory capture failed: ${reason}\n${CAPTURE_RETRY_MESSAGE}`);
}

function failureWithBoundedDetail(
  prefix: string,
  detail: unknown,
  fallback: string,
): ReturnType<typeof result> {
  const bounded = typeof detail === "string" ? boundedText(detail) : "";
  return failure(bounded === "" ? fallback : `${prefix}: ${bounded}`);
}

function deriveScope(projectRoot: string | null): string | null {
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") return null;
  try {
    const scope = basename(projectRoot.trim()).trim();
    return scope === "" ? null : scope;
  } catch {
    return null;
  }
}

function formatLocalDate(date: Date): string | null {
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return null;

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function boundedTaskGoal(state: PindieState | null): string | null {
  const goal = state?.task?.goal;
  if (typeof goal !== "string" || goal.trim() === "") return null;
  const normalized = goal.trim().replace(/\s+/g, " ");
  return normalized.length <= MAX_TASK_GOAL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TASK_GOAL_LENGTH - 1)}…`;
}

function evidence(scope: string, state: PindieState | null): string {
  const taskGoal = boundedTaskGoal(state);
  return taskGoal === null
    ? `Pindie · project=${scope}`
    : `Pindie · project=${scope} · task=${taskGoal}`;
}

export function createPindieMemoryCaptureTool(
  options: PindieMemoryToolOptions,
) {
  return defineTool({
    name: "pindie_memory_capture",
    label: "Capture Work Memory",
    description: "Capture one durable Work Memory state. Provide semantic meaning only; Pindie supplies factual project provenance.",
    parameters: MemoryCaptureParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      let scope: string | null;
      try {
        scope = deriveScope(options.getProjectRoot());
      } catch {
        scope = null;
      }
      if (scope === null) {
        return failure("project Scope is unavailable.");
      }

      let state: PindieState | null;
      try {
        state = options.getState();
      } catch {
        return failure("authoritative State is unavailable.");
      }

      let date: string | null;
      try {
        date = formatLocalDate((options.now ?? (() => new Date()))());
      } catch {
        date = null;
      }
      if (date === null) {
        return failure("Harness Date is unavailable.");
      }

      let capture;
      try {
        capture = createProjectMemoryCapture(
          {
            type: params.type,
            memory: params.memory,
            summary: params.summary,
            whyItMatters: params.whyItMatters,
            ...(params.consequence === undefined ? {} : { consequence: params.consequence }),
            ...(params.supersedes === undefined ? {} : { supersedes: params.supersedes }),
          },
          {
            scope,
            source: "Pindie",
            date,
            evidence: evidence(scope, state),
          },
        );
      } catch (error) {
        return failureWithBoundedDetail(
          "invalid capture input",
          error instanceof Error ? error.message : undefined,
          "the semantic fields are invalid.",
        );
      }

      let captured;
      try {
        captured = await options.sink.capture(capture);
      } catch {
        return failure("external Work Memory sink failed.");
      }
      if (!captured.ok) {
        return failureWithBoundedDetail(
          "the Work Memory sink rejected the capture",
          captured.error,
          "the Work Memory sink rejected the capture.",
        );
      }

      return success(captured.outcome);
    },
  });
}
