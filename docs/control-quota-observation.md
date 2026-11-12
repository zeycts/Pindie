# S3 P1 stage 2: subscription quota observation boundary

Baseline: `b94e31a` (merged PR #320). This stage does not add a provider usage
API, credentials store, background poller or second recovery loop.

## Audited sources and actual observation

- `subscription-usage.ts` resolves Pi auth for **`openai-codex` only**, extracts
  its ChatGPT account claim in memory and reads the existing
  `chatgpt.com/backend-api/wham/usage` source. This is an existing backend
  integration, not a newly promised public/stable usage API. Optional reset-credit
  details do not establish remaining subscription quota.
- 5h and weekly windows are selected by declared duration (300 ± 5 minutes,
  10,080 ± 60 minutes), never array order. `reset_at` seconds become epoch ms.
  The generic cached snapshot does not retain active account/model provenance or
  last-request failure state. A configured custom provider can also supply it.
- Normal monitor attempts are throttled for five minutes; recovery forces one
  refresh. A failed refresh returns null but retains the old presentation cache.
  Presentation-disabled/headless operation does not perform normal display
  refreshes. Replacement resets the monitor generation. Merely observing Control
  must not initiate any of these refreshes.
- Pinned Pi 1.5.0 `providers/openai.js` exposes `openai` OAuth “Sign in with
  ChatGPT” and uses `openai-responses`; this is distinct from legacy
  `openai-codex` / `openai-codex-responses`. A provider name alone cannot tell
  whether API-key or subscription credentials are selected. Do not transfer the
  legacy WHAM windows to this provider or assume all GPT models share them.
- Read-only production sample **2026-11-12 16:00:05 UTC**: active model
  `openai/gpt-6.1-sol`, present in Pi's registry, no current quota wait.
  `observe(view:efficiency)` explicitly disclaimed quota; `view:models` returned
  registry metadata only. No credential was inspected/refreshed and no usage
  request was attempted. This sample does **not** establish auth mode, remaining
  quota, a healthy subscription or the cause of a historical quota failure.

## Minimal fail-closed Control view

`pindie_observe({view:"quota"})` retains the 13 tools, strict optional schema and
ordinary snapshot shape. Non-default views require an active project. The view
is read-only, needs no lease, and never fetches usage or resolves credentials.

- `observedAt`: this Control read time, epoch milliseconds.
- `activeModel`: current provider/model identity, not health/auth certification.
- `subscription.status`: always `unknown` in this implementation;
  `source`, `fetchedAt`, `fiveHour`, `weekly` are null. Reason is either
  `no_supported_source_for_active_provider` or
  `active_account_provenance_unverified` (legacy Codex). No 100%-remaining default.
- `monitor`: existing monitor identity, legacy provider `openai-codex`, account
  applicability `unverified`, cached `fetchedAt` and a **cache-age-only** freshness:
  `fresh` at 0–60,000 ms inclusive; `stale` above it; `unavailable` without a
  finite timestamp; `unknown` for future/invalid time. This uses the recovery
  facts' existing 60 s age bound, not a new guarantee that cached usage is current.
  It exposes no percentages, account IDs, reset-credit identities or raw payloads.
  It does not certify the last refresh succeeded; age and applicability differ.
- `recovery`: Session-scoped observed incident phase, scheduled `resumeAt` and
  optional anchor. `waiting`, `wake_started`, `cancelled`, `invalidated`,
  `wake_failed` are lifecycle facts, not quota measurements. An expired scheduled
  time is not proof access has recovered. Foreign-Session events are omitted.

This is intentionally a visibility-of-unknown improvement, **not** a live quota
meter. A fresh legacy snapshot, a fallback model, a complete Run or absence of
`quotaWaiting` must never upgrade active subscription quota to healthy/exhausted.
Old production servers may reject the optional view until separately deployed.

## Evidence-backed recovery fix

Previously `deriveResumeAt` reused UI `getRemainingPercent`, which rounds:
99.6% used → 0% displayed remaining. Red tests reproduced both a false recovery
plan and a later, incorrect recovery date when a near-exhausted 5h window was
combined with an actually exhausted weekly window. Policy now requires **finite
raw usedPercent ≥ 100**, not display rounding. UI formatting is unchanged.

Existing planning still requires a latest terminal **legacy Codex** quota-signature
error plus fresh supported 5h **and** weekly facts, at least one exhausted window,
and valid future reset times. Recovery time is the latest genuinely exhausted
window reset plus 30 s grace, not the error's retry prose. Ordinary model/network
errors, stale/future facts, missing windows/reset dates and unavailable refresh
fail closed. Reset credits do not change this derivation. The same facts feed
Fallback and Resume without a second refresh; this fix does not authorize
`openai` automatic recovery or alter Host leases/Task state.

## Tests, remaining gaps and safe operation

- New deterministic fixture tests reproduce the rounding bug and confirm the
  correct window/date. Existing subscription/incident/supervisor tests cover
  duration order, fresh/stale/future/unknown usage, failed refresh retention,
  error classification, latest anchor, cancel, backup failure/source restoration,
  resume and stale callbacks. These are injected facts, not real quota incidents.
- New projection tests cover cache-age boundaries, unknown for OpenAI/Codex and
  backup models, all recovery phases, foreign Session rejection and getters
  proving no percentages/credit payload/auth access. The existing real HTTP →
  Host → pinned Pi fixture checks the new view, no-project/strict schema errors,
  unchanged revision/authority, no provider calls and the unchanged 13 tools.
- **Accepted input** means a delivery receipt, not available quota or execution
  success. **Exhausted** needs applicable authoritative usage and/or a real
  provider failure with its proper scope; this view cannot certify it.
  **Recovering** means an observed attempt/incident, not guaranteed restored
  quota. Cancelling recovery does not replenish anything. Task/verification and
  wait timeout retain their existing independent meanings.
- On a suspected quota failure, inspect dispatch state, sanitized error and
  recovery phase. Do not resend an accepted/uncertain input; reconcile via
  observe/wait/timeline. Stale lease requires observing the current binding, not
  replaying old work. A normal model error alone is not an exhausted window.

### Manual acceptance after separately approved deployment

1. Check server version/available optional view; use ordinary observe if the old
   server rejects `quota`. Confirm project/Session/model before interpreting it.
2. The human may inspect the matching signed-in account's usage in the provider's
   official UI (Pi points OpenAI sign-in users to `https://chatgpt.com/settings/usage`).
   Record only necessary window/reset/time facts and provider/account applicability;
   do not paste credentials, account identifiers or private raw responses.
3. A future positive Control source needs verified account/provider applicability,
   an authorized supported read interface and timestamp/failure provenance. Review
   that contract separately before exposing remaining percentages or enabling
   `openai` recovery. This stage neither invents such an API nor assumes WHAM is it.
4. Use isolated fixtures for exhaustion/cancel/fallback acceptance. Do not drain
   real quota, refresh production auth or switch/restart the occupied production
   Session to test. Manual UI evidence must not be relabelled automated E2E.
