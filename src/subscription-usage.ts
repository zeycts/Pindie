import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SubscriptionUsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface SubscriptionUsageSnapshot {
  windows: SubscriptionUsageWindow[];
  fetchedAt: number;
}

export interface SubscriptionUsageProvider {
  fetchUsage(ctx: ExtensionContext): Promise<SubscriptionUsageSnapshot | null>;
}

const WEEKLY_MINUTES = 7 * 24 * 60;
const WEEKLY_TOLERANCE_MINUTES = 60;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function windowFrom(value: unknown): SubscriptionUsageWindow | null {
  const source = object(value);
  if (!source) return null;
  const usedPercent = number(source.used_percent ?? source.usedPercent);
  if (usedPercent === undefined) return null;
  const windowMinutes = number(source.window_minutes ?? source.windowMinutes);
  const resetSeconds = number(source.resets_at ?? source.resetsAt);
  return {
    usedPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetSeconds === undefined ? {} : { resetsAt: resetSeconds * 1_000 }),
  };
}

/** Parses only the public facts needed from the Codex usage response. */
export function parseSubscriptionUsage(
  payload: unknown,
  fetchedAt = Date.now(),
): SubscriptionUsageSnapshot | null {
  const source = object(payload);
  if (!source) return null;
  const rateLimits = object(
    source.rate_limits ?? source.rateLimits ?? source.rate_limit ?? source,
  );
  if (!rateLimits) return null;
  const values = Array.isArray(rateLimits.windows)
    ? rateLimits.windows
    : Object.values(rateLimits);
  const windows = values.flatMap((value) => {
    const parsed = windowFrom(value);
    return parsed ? [parsed] : [];
  });
  return windows.length > 0 ? { windows, fetchedAt } : null;
}

/** Selects a weekly window by its declared duration, never array position. */
export function selectWeeklyWindow(
  snapshot: SubscriptionUsageSnapshot | null,
): SubscriptionUsageWindow | null {
  return snapshot?.windows.find((window) =>
    window.windowMinutes !== undefined &&
    Math.abs(window.windowMinutes - WEEKLY_MINUTES) <= WEEKLY_TOLERANCE_MINUTES,
  ) ?? null;
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

export function formatResetTime(
  resetsAt: number,
  format: (date: Date) => string = (date) =>
    new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date),
): string {
  return format(new Date(resetsAt));
}

/** Uses Pi's public resolved provider auth; credentials stay in memory only. */
export const chatGptSubscriptionUsageProvider: SubscriptionUsageProvider = {
  async fetchUsage(ctx) {
    const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
    const apiKey = auth?.auth.apiKey;
    const accountId = apiKey ? accountIdFromAccessToken(apiKey) : null;
    if (!apiKey || !accountId) return null;

    const response = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "chatgpt-account-id": accountId,
        originator: "pi",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return parseSubscriptionUsage(await response.json());
  },
};
