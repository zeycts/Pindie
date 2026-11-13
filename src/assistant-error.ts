/** Presentation-only diagnostics; never changes persisted Session messages. */
export interface ProviderFailureEvidence {
  readonly category: "subscription_limit" | "rate_limit" | "billing_or_quota" | "authentication" | "permission" | "network_or_upstream" | "unknown";
  readonly provider: string;
  readonly model: string;
  /** Local observation of the terminal message, not provider/server time. */
  readonly observedAt: number;
  readonly evidenceKind: "assistant_error_message";
  readonly confidence: "unverified";
  readonly condition: "message_signature" | "unclassified";
  /** Allowlisted message signature, NOT an authenticated response code. */
  readonly code: string | null;
}

/** No HTTP/auth/usage reads. The caller must gate publication on final Run settlement. */
export function projectProviderFailure(message: {
  readonly role?: unknown; readonly stopReason?: unknown; readonly provider?: unknown;
  readonly model?: unknown; readonly errorMessage?: unknown;
}, observedAt: number): ProviderFailureEvidence | undefined {
  if (message.role !== "assistant" || message.stopReason !== "error" || !Number.isFinite(observedAt)) return undefined;
  const identity = (value: unknown): string | null => typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/\-]{0,159}$/u.test(value) ? value : null;
  const provider = identity(message.provider), model = identity(message.model);
  if (provider === null || model === null) return undefined; // No reliable actual-message identity.
  // Classify only the sanitized bounded diagnostic; never copy arbitrary codes, bodies or URLs.
  const text = sanitizeAssistantError(message.errorMessage);
  const signature = (code: string): boolean => new RegExp(`(?<![\\w])${code}(?![\\w])`, "u").test(text);
  let category: ProviderFailureEvidence["category"] = "unknown";
  let code: string | null = null;
  if (provider === "openai") {
    code = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_workplace_individual_usage_limit_exceeded"].find(signature) ?? null;
    if (code !== null) category = "subscription_limit";
  }
  if (code === null) {
    if (signature("insufficient_quota")) { code = "insufficient_quota"; category = "billing_or_quota"; }
    else if (signature("rate_limit_exceeded")) { code = "rate_limit_exceeded"; category = "rate_limit"; }
    // Pi's normalized OpenAI error prefix is evidence of a message signature only.
    // Do not manufacture a numeric HTTP status or a verified credential failure.
    else if (provider === "openai" && /^OpenAI API error \(401\):/u.test(text)) category = "authentication";
    else if (provider === "openai" && /^OpenAI API error \(403\):/u.test(text)) category = "permission";
    else if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].some(signature) ||
      (provider === "openai" && /^OpenAI API error \(50[0234]\):/u.test(text))) category = "network_or_upstream";
  }
  return { category, provider, model, observedAt, evidenceKind: "assistant_error_message",
    confidence: "unverified", condition: category === "unknown" ? "unclassified" : "message_signature", code };
}

export const ASSISTANT_ERROR_LIMIT = 2_000;

export function sanitizeAssistantError(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  // Strip terminal escape/control sequences before matching credentials. Redact
  // before bounding so a credential crossing the output boundary cannot leak.
  const safe = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "")
    .replace(/\b((?:set-cookie|cookie|proxy-authorization|authorization)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[^\s"',;}]+/giu, "$1 [REDACTED]")
    // Bare key/auth names are sensitive only in query parameters, not prose
    // such as "auth: invalid" or "key: missing" that explains the failure.
    // Consume balanced wrappers before the unquoted form so a leading quote
    // cannot produce an empty match that leaves the credential behind.
    .replace(/([?&](?:key|auth)=)(?:"[^"\r\n]*"|'[^'\r\n]*'|<[^>\r\n]*>|[^\s&#"'<>]*)/giu, "$1[REDACTED]")
    .replace(/(["']?(?:authorization|proxy-authorization|x-goog-api-key|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|token|secret|password|signature|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;\n}]+)/giu, "$1[REDACTED]")
    .replace(/\b(?:sk|pk)-[a-z0-9_-]{12,}/giu, "[REDACTED]")
    // Recognizable provider prefixes, not arbitrary long identifiers. These
    // are defensive common-format rules, not exhaustive secret detection.
    .replace(/\bAIza[\w-]{35}(?![\w-])/gu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{22,})\b/gu, "[REDACTED]")
    .replace(/\b(?:xox[baprs]-|xapp-)[a-zA-Z0-9-]{10,}/gu, "[REDACTED]")
    .trim();
  return safe.length === 0 ? "Assistant request failed (no diagnostic available)."
    : safe.length > ASSISTANT_ERROR_LIMIT ? `${safe.slice(0, ASSISTANT_ERROR_LIMIT - 1)}…` : safe;
}
