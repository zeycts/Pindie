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
