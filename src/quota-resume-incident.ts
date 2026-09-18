import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  getRemainingPercent,
  selectFiveHourWindow,
  selectWeeklyWindow,
  SubscriptionUsageMonitor,
  type SubscriptionUsageSnapshot,
} from "./subscription-usage.ts";

export const QUOTA_RESET_GRACE_MS = 30_000;
export const MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS = 60_000;

const QUOTA_ERROR_SIGNATURE = /\b(?:the[\s_]+)?usage[\s_]+limit(?:[\s_]+has[\s_]+been)?[\s_]+reached\b|\b(?:Go|Free)UsageLimitError\b|\binsufficient_quota\b/iu;

export interface CodexQuotaIncident {
  anchorEntryId: string;
  provider: "openai-codex";
  modelId: string;
  errorMessage: string;
}

export interface QuotaResumePlan {
  sessionId: string;
  anchorEntryId: string;
  provider: "openai-codex";
  modelId: string;
  detectedAt: number;
  resumeAt: number;
}

export interface BuildQuotaResumePlanOptions {
  ctx: ExtensionContext;
  branch: readonly SessionEntry[];
  monitor: SubscriptionUsageMonitor;
  enabled: boolean;
  now: () => number;
}

/**
 * Finds a quota candidate only at the current branch's latest conversation
 * message. Metadata entries are deliberately ignored.
 */
export function detectCodexQuotaIncident(
  branch: readonly SessionEntry[],
): CodexQuotaIncident | null {
  const latestMessageEntry = [...branch].reverse().find((entry) => entry.type === "message");
  if (!latestMessageEntry || latestMessageEntry.type !== "message") return null;

  const message = latestMessageEntry.message;
  if (
    message.role !== "assistant" ||
    message.provider !== "openai-codex" ||
    message.stopReason !== "error" ||
    typeof message.errorMessage !== "string" ||
    !QUOTA_ERROR_SIGNATURE.test(message.errorMessage) ||
    typeof message.model !== "string"
  ) {
    return null;
  }

  return {
    anchorEntryId: latestMessageEntry.id,
    provider: "openai-codex",
    modelId: message.model,
    errorMessage: message.errorMessage,
  };
}

function isFreshUsageSnapshot(
  snapshot: SubscriptionUsageSnapshot,
  now: number,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(snapshot.fetchedAt)) return false;
  const age = now - snapshot.fetchedAt;
  return age >= 0 && age <= MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS;
}

function deriveResumeAt(
  snapshot: SubscriptionUsageSnapshot | null,
  now: number,
): number | null {
  if (snapshot === null || !isFreshUsageSnapshot(snapshot, now)) return null;

  const fiveHour = selectFiveHourWindow(snapshot);
  const weekly = selectWeeklyWindow(snapshot);
  if (fiveHour === null || weekly === null) return null;

  const exhausted = [fiveHour, weekly].filter((window) =>
    getRemainingPercent(window.usedPercent) === 0,
  );
  if (exhausted.length === 0) return null;

  const resetsAt: number[] = [];
  for (const window of exhausted) {
    if (
      window.resetsAt === undefined ||
      !Number.isFinite(window.resetsAt) ||
      window.resetsAt <= now
    ) {
      return null;
    }
    resetsAt.push(window.resetsAt);
  }

  const resumeAt = Math.max(...resetsAt) + QUOTA_RESET_GRACE_MS;
  return Number.isFinite(resumeAt) ? resumeAt : null;
}

export async function buildQuotaResumePlan({
  ctx,
  branch,
  monitor,
  enabled,
  now,
}: BuildQuotaResumePlanOptions): Promise<QuotaResumePlan | null> {
  if (!enabled) return null;

  const incident = detectCodexQuotaIncident(branch);
  if (incident === null) return null;

  let snapshot: SubscriptionUsageSnapshot | null;
  try {
    snapshot = await monitor.refresh(ctx, { force: true });
  } catch {
    return null;
  }

  const detectedAt = now();
  const resumeAt = deriveResumeAt(snapshot, detectedAt);
  if (resumeAt === null) return null;

  return {
    sessionId: ctx.sessionManager.getSessionId(),
    anchorEntryId: incident.anchorEntryId,
    provider: incident.provider,
    modelId: incident.modelId,
    detectedAt,
    resumeAt,
  };
}
