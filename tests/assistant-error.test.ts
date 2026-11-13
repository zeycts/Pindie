import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_ERROR_LIMIT, sanitizeAssistantError } from "../src/assistant-error.ts";

test("diagnostics redact credentials before bounding and strip terminal controls", () => {
  for (const input of [
    "HTTP 401 Authorization: Bearer private-token",
    'HTTP 401 {"api_key":"private-token"}',
    "HTTP 401 x-api-key: private-token",
    "HTTP 401 https://example.test/?access_token=private-token&retry=1",
    "HTTP 401 token='private-token'",
    "HTTP 401 Cookie: first=private-token; second=private-token",
    "HTTP 401 https://user:private-token@example.test/path",
    "HTTP 401 https://example.test/?client_secret=private-token&signature=private-token",
    'HTTP 401 {"Authorization":"Bearer private-token"}',
    `HTTP 401 ${"x".repeat(1990)} token=${"private-token".repeat(500)}`,
  ]) {
    const safe = sanitizeAssistantError(input);
    assert.ok(!safe.includes("private-token"), safe);
    assert.ok(safe.length <= ASSISTANT_ERROR_LIMIT);
    assert.match(safe, /HTTP 401/u);
  }
  assert.equal(sanitizeAssistantError("\x1b[31m429 quota exhausted\x1b[0m\x00"), "429 quota exhausted");
  assert.equal(sanitizeAssistantError("network timeout; retry later"), "network timeout; retry later");
  assert.match(sanitizeAssistantError(undefined), /no diagnostic/u);
  assert.match(sanitizeAssistantError(" "), /no diagnostic/u);
});

test("bare key/auth query parameters and provider headers redact only credential values", () => {
  for (const credential of [
    "https://example.test/?key=private-value&retry=2",
    "https://example.test/?retry=2&AUTH=private%2Fvalue#details",
    "https://example.test/?auth=private-value&key=another-private-value&retry=2",
    "x-goog-api-key: private-value",
    '"X-Goog-Api-Key": "private-value"',
    "x-api-key: private-value",
  ]) {
    const safe = sanitizeAssistantError(`HTTP 401 auth failed; ${credential}; 429 quota exhausted; network timeout`);
    assert.doesNotMatch(safe, /private(?:-|%2F)value/u);
    assert.match(safe, /\[REDACTED\]/u);
    assert.match(safe, /HTTP 401 auth failed/u);
    assert.match(safe, /429 quota exhausted; network timeout/u);
    if (credential.includes("retry=2")) assert.match(safe, /retry=2/u);
  }
  const useful = "HTTP 401 auth: invalid; key: missing; 429 quota exhausted; network timeout; request_id=abcdef123456";
  assert.equal(sanitizeAssistantError(useful), useful);
});

test("key/auth query redaction consumes entire unquoted, quoted and angle-wrapped values", () => {
  for (const name of ["key", "auth", "KEY", "AUTH"]) {
    for (const [open, close] of [["", ""], ['"', '"'], ["'", "'"], ["<", ">"]]) {
      for (const queryPrefix of ["?", "?region=test&"]) {
        const prefix = `HTTP 401 auth failed https://example.test/${queryPrefix}${name}=`;
        const suffix = "&retry=2&mode=safe#details 429 quota exhausted; network timeout";
        assert.equal(sanitizeAssistantError(`${prefix}${open}private-value${close}${suffix}`),
          `${prefix}[REDACTED]${suffix}`);
        // The complete credential must be removed before applying the limit.
        const bounded = sanitizeAssistantError(`${"x".repeat(1900)} ${prefix}${open}${"private-value".repeat(100)}${close}${suffix}`);
        assert.ok(bounded.length <= ASSISTANT_ERROR_LIMIT);
        assert.ok(!bounded.includes("private-value"));
        assert.match(bounded, /\[REDACTED\]&retry=2/u);
      }
      if (open) {
        assert.equal(sanitizeAssistantError(`https://example.test/?${name}=${open}private value${close}&retry=2 network timeout`),
          `https://example.test/?${name}=[REDACTED]&retry=2 network timeout`);
      }
    }
  }
  assert.equal(sanitizeAssistantError("auth: invalid; key: missing"), "auth: invalid; key: missing");
});

test("common bare Google, GitHub and Slack token formats are redacted without erasing failure context", () => {
  const tokens = [
    `AIza${"A".repeat(35)}`, `AIza${"A".repeat(34)}-`, `AIza${"A".repeat(34)}_`,
    ...["ghp", "gho", "ghu", "ghs", "ghr"].map((prefix) => `${prefix}_${"a1".repeat(18)}`),
    `github_pat_${"a1_".repeat(27)}`,
    `xoxb-123456789012-123456789012-${"a".repeat(24)}`,
    `xoxp-123456789012-123456789012-123456789012-${"a".repeat(32)}`,
    `xapp-1-A1234567890-1234567890123-${"a".repeat(32)}`,
  ];
  for (const token of tokens) {
    assert.equal(sanitizeAssistantError(`HTTP 403 auth denied (${token}); 429 quota exhausted; network timeout`),
      "HTTP 403 auth denied ([REDACTED]); 429 quota exhausted; network timeout");
    // Token starts inside the display budget but ends beyond it: redact first.
    const bounded = sanitizeAssistantError(`${"x".repeat(1980)} ${token} network timeout`);
    assert.ok(bounded.length <= ASSISTANT_ERROR_LIMIT);
    assert.ok(!bounded.includes(token.slice(0, 10)));
  }
  const ordinary = "Google auth failed; GitHub quota exhausted; Slack network timeout; AIza-short ghp-short xoxb-short";
  assert.equal(sanitizeAssistantError(ordinary), ordinary);
});

test("failure signatures remain unverified, bounded and separate from HTTP/auth/quota truth", async () => {
  const { projectProviderFailure } = await import("../src/assistant-error.ts");
  const message = { role: "assistant", stopReason: "error", provider: "openai", model: "actual-model" };
  const result = projectProviderFailure({ ...message, errorMessage: "subscription_sharing_usage_limit_exceeded" }, 100)!;
  assert.deepEqual(result, { category: "subscription_limit", provider: "openai", model: "actual-model", observedAt: 100,
    evidenceKind: "assistant_error_message", confidence: "unverified", condition: "message_signature", code: "subscription_sharing_usage_limit_exceeded" });
  for (const stopReason of ["pending", "stop", "aborted", "length", "toolUse"]) {
    assert.equal(projectProviderFailure({ ...message, stopReason }, 100), undefined);
  }
  assert.equal(projectProviderFailure({ ...message, role: "user" }, 100), undefined);
  assert.equal(projectProviderFailure(message, NaN), undefined);
  for (const text of ["quota exhausted", "timeout", "401 permission", "rate_limit_exceeded_suffix", "prefix_subscription_sharing_usage_limit_exceeded",
    "token=subscription_sharing_usage_limit_exceeded", "sk-subscription_sharing_usage_limit_exceeded"]) {
    assert.equal(projectProviderFailure({ ...message, errorMessage: text }, 100)?.category, "unknown", text);
  }
  assert.equal(projectProviderFailure({ ...message, provider: "openai-codex", errorMessage: "subscription_sharing_usage_limit_exceeded" }, 100)?.category, "unknown");
  const unsafe = projectProviderFailure({ ...message, provider: "https://private.invalid/auth", model: "token=private", errorMessage: "{raw: secret} Authorization: private" }, 100);
  assert.equal(unsafe, undefined, "missing or unsafe actual-message identity fails closed");
  assert.ok(!("httpStatus" in result) && !("authMode" in result) && !("fiveHour" in result) && !("resumeAt" in result));
});
