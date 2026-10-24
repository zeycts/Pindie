import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import { deriveControlTokenUsage, getLatestCacheHitRate } from "./efficiency.ts";

function metric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Fixed numeric allowlist; never returns Session entries, content or native cost estimates. */
export function projectControlEfficiency(input: {
  sessionId: string;
  entries: readonly SessionEntry[];
  branch: readonly SessionEntry[];
  context: ContextUsage | undefined;
}) {
  let latest: SessionEntry | undefined;
  for (let index = input.branch.length - 1; index >= 0; index--) {
    const entry = input.branch[index]!;
    if (entry.type === "message" && entry.message.role === "assistant") { latest = entry; break; }
  }
  const latestRequest = latest ? deriveControlTokenUsage([latest]) : null;
  const completePromptUsage = latestRequest !== null && latestRequest.input !== null &&
    latestRequest.cacheRead !== null && latestRequest.cacheWrite !== null &&
    Number.isFinite(latestRequest.input + latestRequest.cacheRead + latestRequest.cacheWrite);
  return {
    sessionId: input.sessionId,
    observedAt: new Date().toISOString(),
    sessionUsage: deriveControlTokenUsage(input.entries),
    latestRequest,
    latestCacheHitPercent: completePromptUsage
      ? getLatestCacheHitRate({ input: latestRequest.input!, output: 0,
        cacheRead: latestRequest.cacheRead!, cacheWrite: latestRequest.cacheWrite! }) : null,
    context: input.context === undefined ? null : {
      tokens: metric(input.context.tokens),
      windowTokens: metric(input.context.contextWindow),
      percent: metric(input.context.percent),
    },
    cost: null,
    sources: {
      sessionUsage: "Pi SessionManager.getEntries: all in-memory entries of active Session, including other branches, compaction, branch-summary, tool and usage records",
      latestRequest: "Pi SessionManager.getBranch: latest persisted assistant usage on active branch",
      latestCacheHitPercent: "100 * cacheRead / (input + cacheRead + cacheWrite), latest request only",
      context: "Pi AgentSession.getContextUsage: native context estimate, not provider live count",
    },
    units: { usage: "tokens", context: "tokens / percent", latestCacheHitPercent: "percent", duration: "milliseconds" },
    freshness: "On-demand in-memory read; usage excludes unfinished streaming response. observedAt is read time, not provider measurement time.",
    limitations: [
      "Missing or invalid counters are null; totals describe recorded usage, not proof that every provider reported usage.",
      "No provider, credential or quota refresh; no historical Session files opened or scanned.",
      "Cost unavailable: native usage.cost may be catalog/model-equivalent, not actual billed dollars. Codex subscription quota is not API cost.",
      "No current-run token attribution, retry/completion-rate counter, ChatGPT-side usage, MCP payload/latency counter or cross-Session token total.",
    ],
  };
}
