/** Presentation-only diagnostics; never changes persisted Session messages. */
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
    .replace(/([?&](?:key|auth)=)[^\s&#"'<>]*/giu, "$1[REDACTED]")
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
