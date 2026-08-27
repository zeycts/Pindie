import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SubscriptionUsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface ResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt?: number;
  expiresAt?: number;
}

export interface ResetCreditsSnapshot {
  availableCount: number;
  credits?: ResetCredit[];
}

export interface SubscriptionUsageSnapshot {
  windows: SubscriptionUsageWindow[];
  resetCredits?: ResetCreditsSnapshot;
  fetchedAt: number;
}

export interface SubscriptionUsageProvider {
  fetchUsage(ctx: ExtensionContext): Promise<SubscriptionUsageSnapshot | null>;
}

export type SubscriptionUsageFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface SubscriptionUsageProviderOptions {
  fetch?: SubscriptionUsageFetch;
}

const FIVE_HOUR_MINUTES = 5 * 60;
const WEEKLY_MINUTES = 7 * 24 * 60;
const WINDOW_TOLERANCE_MINUTES = 60;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function windowFrom(value: unknown): SubscriptionUsageWindow | null {
  const source = object(value);
  if (!source) return null;
  const usedPercent = number(source.used_percent ?? source.usedPercent);
  const explicitWindowMinutes = number(source.window_minutes ?? source.windowMinutes);
  const limitWindowSeconds = number(
    source.limit_window_seconds ?? source.limitWindowSeconds,
  );
  const windowMinutes = explicitWindowMinutes ?? (
    limitWindowSeconds === undefined ? undefined : limitWindowSeconds / 60
  );
  if (usedPercent === undefined || windowMinutes === undefined) return null;
  const resetSeconds = number(
    source.reset_at ?? source.resetAt ?? source.resets_at ?? source.resetsAt,
  );
  return {
    usedPercent,
    windowMinutes,
    ...(resetSeconds === undefined ? {} : { resetsAt: resetSeconds * 1_000 }),
  };
}

/** Extracts only duration-identified usage windows from Codex rate-limit groups. */
function usageWindowsFrom(value: unknown): SubscriptionUsageWindow[] {
  const seen = new WeakSet<object>();
  const windows: SubscriptionUsageWindow[] = [];

  const visit = (candidate: unknown): void => {
    const source = object(candidate);
    if (!source || seen.has(source)) return;
    seen.add(source);
    const parsed = windowFrom(source);
    if (parsed) windows.push(parsed);
    for (const child of Object.values(source)) visit(child);
  };

  visit(value);
  return windows;
}

function resetCreditsSummaryFrom(value: Record<string, unknown>): ResetCreditsSnapshot | undefined {
  const container = object(value.rate_limit_reset_credits ?? value.rateLimitResetCredits);
  if (!container) return undefined;
  const availableCount = nonNegativeInteger(container.available_count ?? container.availableCount);
  return availableCount === undefined ? undefined : { availableCount };
}

/** Parses only the public facts needed from the Codex usage response. */
export function parseSubscriptionUsage(
  payload: unknown,
  fetchedAt = Date.now(),
): SubscriptionUsageSnapshot | null {
  const source = object(payload);
  if (!source) return null;
  const rateLimits =
    source.rate_limits ?? source.rateLimits ?? source.rate_limit ?? source.rateLimit ?? source;
  const windows = usageWindowsFrom(rateLimits);
  const resetCredits = resetCreditsSummaryFrom(source);
  return windows.length > 0 || resetCredits
    ? { windows, ...(resetCredits ? { resetCredits } : {}), fetchedAt }
    : null;
}

/** Parses the small, relevant subset of reset-credit detail records. */
export function parseResetCreditDetails(payload: unknown): ResetCredit[] | undefined {
  const source = object(payload);
  if (!source || !Array.isArray(source.credits)) return undefined;
  return source.credits.flatMap((value): ResetCredit[] => {
    const credit = object(value);
    if (!credit) return [];
    const id = credit.id;
    const resetType = credit.reset_type ?? credit.resetType;
    const status = credit.status;
    if (typeof id !== "string" || typeof resetType !== "string" || typeof status !== "string") {
      return [];
    }
    const grantedAt = timestamp(credit.granted_at ?? credit.grantedAt);
    const expiresAt = timestamp(credit.expires_at ?? credit.expiresAt);
    return [{
      id,
      resetType,
      status,
      ...(grantedAt === undefined ? {} : { grantedAt }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }];
  });
}

function selectWindowByDuration(
  snapshot: SubscriptionUsageSnapshot | null,
  durationMinutes: number,
): SubscriptionUsageWindow | null {
  return snapshot?.windows.find((window) =>
    window.windowMinutes !== undefined &&
    Math.abs(window.windowMinutes - durationMinutes) <= WINDOW_TOLERANCE_MINUTES,
  ) ?? null;
}

/** Selects a five-hour window by its declared duration, never array position. */
export function selectFiveHourWindow(
  snapshot: SubscriptionUsageSnapshot | null,
): SubscriptionUsageWindow | null {
  return selectWindowByDuration(snapshot, FIVE_HOUR_MINUTES);
}

/** Selects a weekly window by its declared duration, never array position. */
export function selectWeeklyWindow(
  snapshot: SubscriptionUsageSnapshot | null,
): SubscriptionUsageWindow | null {
  return selectWindowByDuration(snapshot, WEEKLY_MINUTES);
}

export function getRemainingPercent(usedPercent: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 - usedPercent)));
}

function accountIdFromAccessToken(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(),
    ) as { [CODEX_ACCOUNT_CLAIM]?: { chatgpt_account_id?: unknown } };
    const accountId = json[CODEX_ACCOUNT_CLAIM]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

/** Formats a future reset timestamp as a compact, floor-based countdown. */
export function formatResetCountdown(
  resetsAt: number,
  now = Date.now(),
): string | null {
  if (!Number.isFinite(resetsAt) || !Number.isFinite(now) || resetsAt <= now) {
    return null;
  }

  const remainingMs = resetsAt - now;
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (remainingMs >= dayMs) return `${Math.floor(remainingMs / dayMs)}d+`;
  if (remainingMs >= hourMs) return `${Math.floor(remainingMs / hourMs)}h+`;
  if (remainingMs >= minuteMs) return `${Math.floor(remainingMs / minuteMs)}m`;
  return "<1m";
}

/** Formats a credit expiry with day-only precision for multi-day windows. */
export function formatCreditExpiryCountdown(
  expiresAt: number,
  now = Date.now(),
): string | null {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) return null;
  const remainingMs = expiresAt - now;
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (remainingMs >= dayMs) return `${Math.floor(remainingMs / dayMs)}d`;
  if (remainingMs >= hourMs) return `${Math.floor(remainingMs / hourMs)}h`;
  if (remainingMs >= minuteMs) return `${Math.floor(remainingMs / minuteMs)}m`;
  return "<1m";
}

/**
 * Returns the earliest future expiry only when enough usable detail rows cover
 * the authoritative summary count; capped/incomplete detail lists show count only.
 */
export function selectEarliestResetCreditExpiry(
  resetCredits: ResetCreditsSnapshot | undefined,
  now = Date.now(),
): number | undefined {
  if (!resetCredits?.credits) return undefined;
  const usable = resetCredits.credits.filter((credit) =>
    credit.status === "available" && credit.resetType === "codex_rate_limits",
  );
  if (usable.length < resetCredits.availableCount) return undefined;
  const expiries = usable
    .map((credit) => credit.expiresAt)
    .filter((expiresAt): expiresAt is number => expiresAt !== undefined && expiresAt > now);
  return expiries.length > 0 ? Math.min(...expiries) : undefined;
}

function requestInit(apiKey: string, accountId: string): RequestInit {
  return {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "ChatGPT-Account-Id": accountId,
      originator: "pi",
    },
    signal: AbortSignal.timeout(10_000),
  };
}

/** Uses Pi's public resolved provider auth; credentials stay in memory only. */
export function createChatGptSubscriptionUsageProvider(
  options: SubscriptionUsageProviderOptions = {},
): SubscriptionUsageProvider {
  const fetchUsage = options.fetch ?? globalThis.fetch;

  return {
    async fetchUsage(ctx) {
      const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
      const apiKey = auth?.auth.apiKey;
      const accountId = apiKey ? accountIdFromAccessToken(apiKey) : null;
      if (!apiKey || !accountId) return null;

      const response = await fetchUsage(CODEX_USAGE_URL, requestInit(apiKey, accountId));
      if (!response.ok) return null;
      const snapshot = parseSubscriptionUsage(await response.json());
      if (!snapshot || (snapshot.resetCredits?.availableCount ?? 0) <= 0) return snapshot;

      try {
        const details = await fetchUsage(CODEX_RESET_CREDITS_URL, requestInit(apiKey, accountId));
        if (!details.ok) return snapshot;
        const credits = parseResetCreditDetails(await details.json());
        return credits === undefined
          ? snapshot
          : { ...snapshot, resetCredits: { ...snapshot.resetCredits!, credits } };
      } catch {
        return snapshot;
      }
    },
  };
}

/** Pi configures its public global fetch with standard proxy environment support. */
export const chatGptSubscriptionUsageProvider = createChatGptSubscriptionUsageProvider();
