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

const QUOTA_ERROR_SIGNATURES = [
  /\b(?:the[\s_]+)?usage[\s_]+limit(?:[\s_]+has[\s_]+been)?[\s_]+reached\b/iu,
  /\b(?:Go|Free)UsageLimitError\b/iu,
  /\binsufficient_quota\b/iu,
  /\bhit[\s_]+your[\s_]+ChatGPT[\s_]+usage[\s_]+limit\b/iu,
] as const;

function isCodexSubscriptionQuotaError(errorMessage: string): boolean {
  return QUOTA_ERROR_SIGNATURES.some((signature) => signature.test(errorMessage));
}

export interface CodexQuotaIncident {
  anchorEntryId: string;
  provider: "openai-codex";
  modelId: string;
  errorMessage: string;
}

export interface CodexQuotaRecoveryFacts {
  readonly sessionId: string;
  readonly anchorEntryId: string;
  readonly provider: "openai-codex";
  readonly modelId: string;
  readonly detectedAt: number;
  /** Reset of all exhausted supported windows, including the existing grace period. */
  readonly recoveryAt: number;
}

export interface QuotaResumePlan {
  sessionId: string;
  anchorEntryId: string;
  provider: "openai-codex";
  modelId: string;
  detectedAt: number;
  resumeAt: number;
}

export interface BuildCodexQuotaRecoveryFactsOptions {
  ctx: ExtensionContext;
  branch: readonly SessionEntry[];
  monitor: SubscriptionUsageMonitor;
  now: () => number;
}

export interface BuildQuotaResumePlanOptions extends BuildCodexQuotaRecoveryFactsOptions {
  enabled: boolean;
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

  return findCodexQuotaIncidentAtAnchor(branch, latestMessageEntry.id);
}

/** Validates the exact source evidence on the current branch, even after backup messages. */
export function findCodexQuotaIncidentAtAnchor(
  branch: readonly SessionEntry[], anchorEntryId: string,
): CodexQuotaIncident | null {
  const entry = branch.find((candidate) => candidate.id === anchorEntryId);
  if (entry?.type !== "message") return null;
  const message = entry.message;
  if (
    message.role !== "assistant" ||
    message.provider !== "openai-codex" ||
    message.stopReason !== "error" ||
    typeof message.errorMessage !== "string" ||
    !isCodexSubscriptionQuotaError(message.errorMessage) ||
    typeof message.model !== "string" || message.model.trim() === ""
  ) {
    return null;
  }

  return {
    anchorEntryId: entry.id,
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

export async function buildCodexQuotaRecoveryFacts({
  ctx, branch, monitor, now,
}: BuildCodexQuotaRecoveryFactsOptions): Promise<CodexQuotaRecoveryFacts | null> {
  const incident = detectCodexQuotaIncident(branch);
  if (incident === null) return null;

  let snapshot: SubscriptionUsageSnapshot | null;
  try {
    snapshot = await monitor.refresh(ctx, { force: true });
  } catch {
    return null;
  }

  const detectedAt = now();
  const recoveryAt = deriveResumeAt(snapshot, detectedAt);
  if (recoveryAt === null) return null;

  return {
    sessionId: ctx.sessionManager.getSessionId(),
    anchorEntryId: incident.anchorEntryId,
    provider: incident.provider,
    modelId: incident.modelId,
    detectedAt,
    recoveryAt,
  };
}

export function quotaResumePlanFromRecoveryFacts(facts: CodexQuotaRecoveryFacts): QuotaResumePlan {
  return {
    sessionId: facts.sessionId,
    anchorEntryId: facts.anchorEntryId,
    provider: facts.provider,
    modelId: facts.modelId,
    detectedAt: facts.detectedAt,
    resumeAt: facts.recoveryAt,
  };
}

export async function buildQuotaResumePlan(options: BuildQuotaResumePlanOptions): Promise<QuotaResumePlan | null> {
  if (!options.enabled) return null;
  const facts = await buildCodexQuotaRecoveryFacts(options);
  return facts === null ? null : quotaResumePlanFromRecoveryFacts(facts);
}
