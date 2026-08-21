import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { formatRunCost, type RunCost } from "./run-cost.ts";
import { formatDuration, type RunTiming } from "./run-timer.ts";
import {
  getVerificationStatus,
  type PindieState,
  type PindieTask,
} from "./state.ts";
import {
  formatResetCountdown,
  getRemainingPercent,
  selectWeeklyWindow,
  type SubscriptionUsageSnapshot,
} from "./subscription-usage.ts";

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
  runCost?: RunCost | null;
  state: PindieState | null;
  stateUnavailableReason: string | null;
  subscriptionUsage?: SubscriptionUsageSnapshot | null;
}

export interface PindieStatusLayout {
  left: StatusSegment[];
  right: StatusSegment[];
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

  if (snapshot.runCost) {
    segments.push({ text: formatRunCost(snapshot.runCost.cost), tone: "dim" });
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

export function deriveStatusLayout(
  snapshot: PindieStatusSnapshot,
  now = Date.now(),
): PindieStatusLayout {
  const weekly = selectWeeklyWindow(snapshot.subscriptionUsage ?? null);
  const resetCountdown = weekly?.resetsAt === undefined
    ? null
    : formatResetCountdown(weekly.resetsAt, now);
  const right = weekly
    ? [
        { text: `w${getRemainingPercent(weekly.usedPercent)}%`, tone: "dim" as const },
        ...(resetCountdown === null
          ? []
          : [{ text: `↻${resetCountdown}`, tone: "dim" as const }]),
      ]
    : [];
  return { left: deriveStatusSegments(snapshot), right };
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

function isCritical(segments: readonly StatusSegment[]): boolean {
  return segments.some((segment) =>
    segment.tone === "warning" || segment.tone === "error",
  );
}

/** Composes one single-line status using ANSI-aware widths and NBSP padding. */
export function renderStatusLayout(
  theme: Pick<Theme, "fg">,
  layout: PindieStatusLayout,
  width?: number,
): string | undefined {
  const left = renderStatusSegments(theme, layout.left);
  const right = renderStatusSegments(theme, layout.right);
  if (!left && !right) return undefined;
  if (!right) return left;
  if (!left) {
    return width && width > 0
      ? "\u00a0".repeat(Math.max(0, width - visibleWidth(right))) + truncateToWidth(right, width)
      : right;
  }
  if (!width || width <= 0) return `${left}${theme.fg("dim", " • ")}${right}`;

  const minimumGap = 2;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + minimumGap + rightWidth <= width) {
    return left + "\u00a0".repeat(width - leftWidth - rightWidth) + right;
  }
  if (isCritical(layout.left)) return truncateToWidth(left, width);
  if (rightWidth >= width) return truncateToWidth(right, width);

  const availableLeft = width - rightWidth - minimumGap;
  if (availableLeft <= 0) return truncateToWidth(right, width);
  return truncateToWidth(left, availableLeft) + "\u00a0".repeat(minimumGap) + right;
}
