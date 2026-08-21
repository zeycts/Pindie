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

export type SubscriptionUsageFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface SubscriptionUsageProviderOptions {
  fetch?: SubscriptionUsageFetch;
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

  if (remainingMs >= dayMs) {
    const days = Math.floor(remainingMs / dayMs);
    const hours = Math.floor((remainingMs % dayMs) / hourMs);
    return `${days}d${hours}h`;
  }
  if (remainingMs >= hourMs) {
    const hours = Math.floor(remainingMs / hourMs);
    const minutes = Math.floor((remainingMs % hourMs) / minuteMs);
    return `${hours}h${minutes}m`;
  }
  if (remainingMs >= minuteMs) return `${Math.floor(remainingMs / minuteMs)}m`;
  return "<1m";
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

      const response = await fetchUsage(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "ChatGPT-Account-Id": accountId,
          originator: "pi",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return parseSubscriptionUsage(await response.json());
    },
  };
}

/** Pi configures its public global fetch with standard proxy environment support. */
export const chatGptSubscriptionUsageProvider = createChatGptSubscriptionUsageProvider();
