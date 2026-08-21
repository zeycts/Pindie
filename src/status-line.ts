import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatDuration, type RunTiming } from "./run-timer.ts";
import {
  getVerificationStatus,
  type PindieState,
  type PindieTask,
} from "./state.ts";

export type StatusTone =
  | "dim"
  | "text"
  | "accent"
  | "success"
  | "warning"
  | "error";

export interface StatusSegment {
  text: string;
  tone: StatusTone;
}

export interface VerificationProgress {
  covered: number;
  total: number;
}

export interface PindieStatusSnapshot {
  timing: RunTiming | null;
  state: PindieState | null;
  stateUnavailableReason: string | null;
}

/** Counts distinct success criteria covered by current passing checks. */
export function getVerificationProgress(task: PindieTask): VerificationProgress {
  const coveredCriteria = new Set(
    task.verification.checks
      .filter((check) => check.status === "passed")
      .flatMap((check) => check.covers),
  );

  return {
    covered: task.successCriteria.filter((criterion) =>
      coveredCriteria.has(criterion.id),
    ).length,
    total: task.successCriteria.length,
  };
}

function verificationSegment(task: PindieTask): StatusSegment {
  const status = getVerificationStatus(task);
  const progress = getVerificationProgress(task);

  switch (status) {
    case "stale":
      return { text: "verify stale", tone: "warning" };
    case "failed":
      return {
        text: `verify failed ${progress.covered}/${progress.total}`,
        tone: "error",
      };
    case "passed":
      return { text: `✓ ${progress.covered}/${progress.total}`, tone: "success" };
    case "pending":
      return {
        text: `verify ${progress.covered}/${progress.total}`,
        tone: "text",
      };
  }
}

/**
 * Derives compact Pindie current-work status without any terminal styling.
 * Runtime unavailability is the most actionable attention condition; otherwise
 * the established Human Gate-over-blocker precedence is preserved.
 */
export function deriveStatusSegments(
  snapshot: PindieStatusSnapshot,
): StatusSegment[] {
  const segments: StatusSegment[] = [];

  if (snapshot.timing) {
    const prefix = snapshot.timing.active ? "⏱" : "last";
    segments.push({
      text: `${prefix} ${formatDuration(snapshot.timing.durationMs)}`,
      tone: "dim",
    });
  }

  const task = snapshot.state?.task;
  if (task) segments.push(verificationSegment(task));

  if (snapshot.stateUnavailableReason !== null) {
    segments.push({ text: "⚠ state unavailable", tone: "error" });
  } else if (task?.humanGate) {
    segments.push({ text: `⚠ gate: ${task.humanGate.kind}`, tone: "warning" });
  } else if (task && task.openLoops.blockers.length > 0) {
    segments.push({ text: "⚠ blocked", tone: "warning" });
  }

  return segments;
}

/** Renders semantic status segments with the active Pi theme. */
export function renderStatusSegments(
  theme: Pick<Theme, "fg">,
  segments: readonly StatusSegment[],
): string {
  return segments
    .map((segment) => theme.fg(segment.tone, segment.text))
    .join(theme.fg("dim", " • "));
}
