import { MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS } from "./quota-resume-incident.ts";
import { quotaResumePhase, type QuotaResumeWaitingStatus } from "./quota-resume-control.ts";

/** Read-only boundary, not a new usage monitor or a recovery-policy input. */
export function projectControlQuota(input: {
  sessionId: string;
  model: { provider: string; modelId: string } | null;
  monitorFetchedAt: number | null;
  recoveryEvent: QuotaResumeWaitingStatus | null;
}, observedAt = Date.now()) {
  const fetchedAt = Number.isFinite(input.monitorFetchedAt) ? input.monitorFetchedAt : null;
  const age = fetchedAt === null ? null : observedAt - fetchedAt;
  const freshness = age === null ? "unavailable" : !Number.isFinite(age) || age < 0 ? "unknown"
    : age <= MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS ? "fresh" : "stale";
  const event = input.recoveryEvent?.sessionId === input.sessionId ? input.recoveryEvent : null;
  return {
    sessionId: input.sessionId,
    observedAt,
    activeModel: input.model === null ? null : { provider: input.model.provider, modelId: input.model.modelId },
    subscription: {
      status: "unknown" as const,
      reason: input.model?.provider === "openai-codex"
        ? "active_account_provenance_unverified" : "no_supported_source_for_active_provider",
      source: null,
      fetchedAt: null,
      fiveHour: null,
      weekly: null,
    },
    monitor: {
      source: "existing_subscription_usage_monitor" as const,
      provider: "openai-codex" as const,
      accountApplicability: "unverified" as const,
      fetchedAt,
      freshness,
      maxAgeMs: MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS,
    },
    recovery: event === null ? null : {
      phase: quotaResumePhase(event),
      resumeAt: event.resumeAt,
      ...(event.anchorEntryId === undefined ? {} : { anchorEntryId: event.anchorEntryId }),
    },
    limitations: [
      "No verified subscription source for the active account. Unknown is not healthy, exhausted or 100% remaining.",
      "Legacy Codex monitor cache age is not active-account applicability; no usage percentages or reset dates are transferred to the active model.",
      "observedAt is this read time; monitor.fetchedAt is the cached monitor fetch time, not a new fetch. No provider/auth refresh, credential inspection or quota probe.",
      "Recovery is an observed Session incident phase, not remaining quota. resumeAt is a scheduled attempt (including grace), not proof of restored access; cancellation does not prove recovery.",
      "Input acceptance, dispatch execution, Task/verification and subscription quota are separate. Efficiency tokens and model registry membership cannot establish remaining quota.",
    ],
  };
}
