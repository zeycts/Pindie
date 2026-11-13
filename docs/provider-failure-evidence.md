# Provider Failure Evidence — P1

Control adds optional `failure` to `latestAssistant`, a dispatch's `output`, and bounded timeline assistant blocks. It is **runtime-only message evidence**, not subscription usage or a recovery decision. No tool is added and `observe(view: "quota")` is unchanged. Raw Control HTTP/MCP responses carry these fields; the existing `control:watch` monitor parser intentionally does not consume/display them in P1.

## Source and lifetime

Control captures the actual native assistant `message_end` object's provider/model and sanitized diagnostic. It publishes evidence only after the owning native Run settles with a final assistant error, no abort, and no pending native prompt promise. Intermediate Pi retries, earlier complete/error blocks superseded in that Run, pending output, and delivery uncertainty are not promoted into final provider failure. Dispatch output includes evidence only in state `error`, never `no_result`, `waiting` or `cancelled`.

The local `observedAt` is the time Control observed that terminal message, **not provider/server time**, message request-start time, or a quota reset time. Repeated reads retain the same value. Snapshot evidence must belong to the latest observed Run and match the currently observed model; an observed model transfer invalidates its current applicability even if the model is later selected again. Historical timeline evidence retains its original provider/model. Session rebind clears all evidence, including same-ID replacement: history alone cannot establish final-Run ownership. Retention follows Control's existing bounded runtime Run ledger (not a new history/database).

## Evidence fields

- `category`: `subscription_limit | rate_limit | billing_or_quota | authentication | permission | network_or_upstream | unknown`.
- `provider`, `model`: bounded identifiers from the actual error message; missing/invalid/URI-like identities suppress evidence entirely; the currently selected model is never substituted for a missing identity.
- `observedAt`: finite local observation timestamp.
- `evidenceKind: "assistant_error_message"`, `confidence: "unverified"`.
- `condition: "message_signature" | "unclassified"`.
- `code`: allowlisted diagnostic signature or `null`; **not an authenticated response code**.

For `openai`, exact bounded signatures `subscription_sharing_usage_limit_exceeded` and `subscription_sharing_workplace_individual_usage_limit_exceeded` indicate subscription-limit **message evidence**. The latter is a workspace-admin limit, not a timer-based personal quota reset. `insufficient_quota` is classified separately as billing/quota message evidence, not ChatGPT 5h/weekly exhaustion. `rate_limit_exceeded` is rate-limit evidence, not subscription exhaustion. Narrow Pi-normalized OpenAI 401/403 prefixes and transport/upstream signatures can be distinguished, but remain unverified message signatures. Loose prose such as “quota”, “timeout”, “permission” remains `unknown`.

There is no `httpStatus`, actual request `authMode`, account identity, remaining percentage, quota window or reset time in this projection. Pi 1.5.0's `isUsingOAuth/isUsingSubscription` describe cached configuration, not request authentication success. Its response hook is not guaranteed to run for HTTP request rejection, and a successful HTTP response may subsequently contain a failed stream. P1 does not capture headers, raw bodies, credentials or arbitrary provider codes. Existing `errorMessage` uses `sanitizeAssistantError`; its common-format redaction is defensive, not a universal secret detector. No diagnostic is copied into `failure`.

## Policy and verification boundary

No automatic retry/fallback/resume policy, persisted Task/Verification semantics, legacy usage-monitor account applicability or tool dispatch behavior changes. In particular Codex recovery stays Codex-only, and subscription usage remains unknown/null without verified active-account provenance. A message signature must never authorize paid fallback or claim recovered access.

Regression coverage includes the pinned native Pi loop over a real local HTTP MCP transport with an isolated faux provider (including a faux `openai` identity). This verifies propagation, not real OpenAI HTTP/auth/error contracts. No paid provider or real quota-failure experiment is needed. Independent review should focus on conservative signature classification, final-Run gating, rebind/model invalidation and privacy. Live provider behavior remains unverified.
