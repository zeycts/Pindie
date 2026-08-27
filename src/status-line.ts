import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { RunActivity } from "./run-activity.ts";
import { formatRunCost, type RunCost } from "./run-cost.ts";
import { formatDuration, type RunTiming } from "./run-timer.ts";
import {
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
  type PindieTask,
} from "./state.ts";
import {
  formatCreditExpiryCountdown,
  formatResetCountdown,
  getRemainingPercent,
  selectEarliestResetCreditExpiry,
  selectFiveHourWindow,
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
  reasoningMode?: "auto" | "manual" | null;
  activity?: RunActivity | null;
  state: PindieState | null;
  stateUnavailableReason: string | null;
  /** Runtime-only presentation fact for an active Agent Run. */
  runStale?: boolean;
  subscriptionUsage?: SubscriptionUsageSnapshot | null;
}

export interface PindieStatusLayout {
  left: StatusSegment[];
  /** Full account-usage presentation. */
  right: StatusSegment[];
  /** Removes ordinary resets and credit expiry. */
  compactRight?: StatusSegment[];
  /** Preserves actionable resets before reset-credit information. */
  attentionRight?: StatusSegment[];
  /** Preserves the independently known quota percentages only. */
  minimumRight?: StatusSegment[];
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

function taskLifecycleSegment(state: PindieState): StatusSegment | null {
  switch (getTaskStatus(state)) {
    case "idle":
      return { text: "idle", tone: "dim" };
    case "active":
      return { text: "active", tone: "text" };
    case "done":
      return { text: "done", tone: "success" };
    case "blocked":
    case "waiting_human":
      return null;
  }
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

  if (snapshot.reasoningMode) {
    segments.push({ text: snapshot.reasoningMode, tone: "dim" });
  }

  if (snapshot.activity) {
    segments.push({ text: snapshot.activity, tone: "accent" });
  }

  const state = snapshot.state;
  const task = state?.task;
  if (state && snapshot.stateUnavailableReason === null) {
    const lifecycle = taskLifecycleSegment(state);
    if (lifecycle) segments.push(lifecycle);
  }
  if (task) segments.push(verificationSegment(task));

  if (snapshot.stateUnavailableReason !== null) {
    segments.push({ text: "⚠ state unavailable", tone: "error" });
  } else if (task?.humanGate) {
    segments.push({ text: `⚠ gate: ${task.humanGate.kind}`, tone: "warning" });
  } else if (snapshot.runStale) {
    segments.push({ text: "⚠ stale run", tone: "warning" });
  } else if (task && task.openLoops.blockers.length > 0) {
    segments.push({ text: "⚠ blocked", tone: "warning" });
  }

  return segments;
}

interface QuotaPresentation {
  quota: StatusSegment;
  reset: StatusSegment | null;
  actionable: boolean;
}

function sameSegments(
  first: readonly StatusSegment[],
  second: readonly StatusSegment[],
): boolean {
  return first.length === second.length && first.every((segment, index) =>
    segment.text === second[index]?.text && segment.tone === second[index]?.tone,
  );
}

function quotaTone(remaining: number): StatusTone {
  if (remaining <= 5) return "error";
  if (remaining <= 10) return "warning";
  return "dim";
}

function quotaPresentation(
  label: "5h" | "wk",
  window: ReturnType<typeof selectFiveHourWindow>,
  now: number,
): QuotaPresentation | null {
  if (!window) return null;
  const remaining = getRemainingPercent(window.usedPercent);
  const resetCountdown = window.resetsAt === undefined
    ? null
    : formatResetCountdown(window.resetsAt, now);
  return {
    quota: { text: `${label} ${remaining}%`, tone: quotaTone(remaining) },
    reset: resetCountdown === null ? null : { text: `↻ ${resetCountdown}`, tone: "dim" },
    actionable: remaining <= 10,
  };
}

export function deriveStatusLayout(
  snapshot: PindieStatusSnapshot,
  now = Date.now(),
): PindieStatusLayout {
  const usage = snapshot.subscriptionUsage ?? null;
  const fiveHour = quotaPresentation("5h", selectFiveHourWindow(usage), now);
  const weekly = quotaPresentation("wk", selectWeeklyWindow(usage), now);
  const quotas = [fiveHour, weekly].filter((quota): quota is QuotaPresentation => quota !== null);
  const resetCredits = usage?.resetCredits;
  const creditExpiry = selectEarliestResetCreditExpiry(resetCredits, now);
  const creditCountdown = creditExpiry === undefined || creditExpiry - now > 5 * 24 * 60 * 60 * 1_000
    ? null
    : formatCreditExpiryCountdown(creditExpiry, now);
  const creditCount = resetCredits?.availableCount ?? 0;
  const creditSegment = creditCount > 0
    ? { text: `⟳ ${creditCount}${creditCountdown === null ? "" : ` · ${creditCountdown}`}`, tone: "dim" as const }
    : null;
  const compactCreditSegment = creditCount > 0
    ? { text: `⟳ ${creditCount}`, tone: "dim" as const }
    : null;

  const right = [
    ...quotas.flatMap((quota) => [quota.quota, ...(quota.reset ? [quota.reset] : [])]),
    ...(creditSegment ? [creditSegment] : []),
  ];
  const compactRight = [
    ...quotas.flatMap((quota) => [quota.quota, ...(quota.actionable && quota.reset ? [quota.reset] : [])]),
    ...(compactCreditSegment ? [compactCreditSegment] : []),
  ];
  const attentionRight = quotas.some((quota) => quota.actionable && quota.reset)
    ? quotas.flatMap((quota) => [quota.quota, ...(quota.actionable && quota.reset ? [quota.reset] : [])])
    : undefined;
  const minimumRight = quotas.map((quota) => quota.quota);

  return {
    left: deriveStatusSegments(snapshot),
    right,
    ...(!sameSegments(compactRight, right) ? { compactRight } : {}),
    ...(attentionRight ? { attentionRight } : {}),
    ...(minimumRight.length > 0 && minimumRight.length !== compactRight.length ? { minimumRight } : {}),
  };
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
  const rightVariants = [
    layout.right,
    ...(layout.compactRight ? [layout.compactRight] : []),
    ...(layout.attentionRight ? [layout.attentionRight] : []),
    ...(layout.minimumRight ? [layout.minimumRight] : []),
  ].filter((variant, index, variants) =>
    variants.findIndex((other) => other === variant) === index,
  );
  const renderedVariants = rightVariants.map((variant) => renderStatusSegments(theme, variant));
  const fullRight = renderedVariants[0] ?? "";
  let right = fullRight;
  if (width && width > 0) {
    const fitting = renderedVariants.find((candidate) =>
      visibleWidth(left) + 2 + visibleWidth(candidate) <= width,
    );
    if (fitting) {
      right = fitting;
    } else {
      const actionable = layout.attentionRight
        ? renderStatusSegments(theme, layout.attentionRight)
        : undefined;
      right = actionable && visibleWidth(actionable) <= width
        ? actionable
        : renderedVariants.find((candidate) => visibleWidth(candidate) <= width) ?? fullRight;
    }
  }
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
