# Control efficiency — Phase 3

## Read only, on demand

Use `pindie_observe({view: "efficiency"})` after selecting a project, ideally
before work and after `pindie_wait(until: "settled")`. No lease is needed; no
active project returns `no_active_project`. Use ordinary `observe({})` for
lease/Task/Gate authority; efficiency is telemetry, not verification or dispatch
authority. The surface remains 13 tools. No model/provider/auth operation,
Session file read, new observer subscription, sampler or metrics store is added.
Runtime reads are synchronous and scoped to the active binding; Session changes
resolve against the new native Session, never a cached path.

| Field | Source / unit / scope |
| --- | --- |
| `sessionUsage` | input/output/cacheRead/cacheWrite tokens from the active Session's already-loaded **all entries**, including other branches and compacted history, assistant/tool usage, compaction/branch-summary usage and Pi 1.4 standalone `usage` entries |
| `latestRequest` | latest persisted assistant on the **active branch**, same four token counters; not the in-flight streaming request |
| `latestCacheHitPercent` | `100 * cacheRead / (input + cacheRead + cacheWrite)`, latest request only; null for missing/invalid counters or zero denominator |
| `context` | native `AgentSession.getContextUsage()` estimate: tokens, windowTokens, percent; may be null after compaction until a new response |
| `duration` | optional existing Presentation consumption from Core RunTimer / Host TaskMetricsTracker, milliseconds and explicit `task` or `run_current_or_latest` scope |
| `cost` | null: native usage cost is not independently verified billed dollars |
| `observedAt`, `sources`, `units`, `freshness`, `limitations`, `durationSource` | read time and interpretation, not a provider measurement timestamp |

No absent/invalid counter is coerced to zero. A total is null per counter when a
contributing record lacks that counter; no recorded usage returns null. Optional
tool/summary usage absent entirely contributes nothing, not an inferred charge.
Recorded zero remains zero; reporting completeness cannot be established from
these records. The numeric projection reads no message content. Pi itself may
inspect projected context in memory to estimate context tokens; no prompt,
content, native paths or credential data is returned.

Session usage is not Task usage: manually switching Session resets this scope;
automatic rollover does not merge Session tokens. Durations are **active Run
time, not wall-clock Task time**, use only the scope returned, and can be null
when the existing reader has no measurement. Task time can span authorized
automatic rollover, freezes at completion, and is process-local (restart/manual
Session replacement loses it). There is no new timer or persisted accumulator.
`run_current_or_latest` intentionally does not claim whether a measurement is
currently running. Presentation disabled/unavailable must not manufacture time
or disable Core measurement; unavailable observation is null.

### Cost and coverage limits

`src/efficiency.ts`'s existing local `/efficiency` report and
`src/run-cost.ts` display native model-equivalent costs; those presentation
semantics are unchanged. This new public view deliberately does **not** label
those estimates as actual billing or synthesize prices. **Codex subscription
quota is not API dollar cost**. No quota/credential refresh is performed. This
view excludes ChatGPT-side tokens/billing, retries, completion-rate counters,
current-run token attribution and MCP network/payload counters. It is not an
automatic routing, billing or savings policy.

## Comparing the same task

1. Fix repository commit, task/acceptance criteria, model/thinking level, tool
   surface and starting context. Record whether caches are cold/warm. Do not
   clear or switch the user's Session just to improve numbers.
2. Capture before/after efficiency only at meaningful boundaries. Subtract
   Session counters **only within the same Session**; keep rollover segments
   separate. Record null as unknown, not zero. Use final measurements after
   settlement; a streaming sample excludes unfinished usage.
3. Record wall time separately, plus the returned duration scope. Keep a small
   manual trial table: accepted/completed/verified outcome, native/provider
   retries actually observed, human interventions, Control input/observe/wait/
   timeline call counts, cache condition, tokens and time. Do not infer retries
   from assistant-message count or completion from an assistant claim.
4. For interaction overhead, measure client-side monotonic call duration and
   encoded response bytes separately for snapshot, efficiency, wait and timeline.
   Bytes are **not tokens**. A bounded wait includes intentional waiting, not
   necessarily server computation; repeated calls also consume external ChatGPT
   context whose usage is unavailable here. Prefer wait over hot observe loops,
   bounded timeline only when needed, efficiency before/after instead of polling.
5. Repeat matched trials, count completion/verification rate with its denominator,
   and compare distributions (median/range), not one successful anecdote. Include
   retries and failed trials. Without repeated samples establish a baseline only;
   **no demonstrated token or monetary savings**. Actual paid API charges require
   an independently authorized billing source; never derive them from quota.

## Actual read-only production baseline (not feature deployment)

At **2026-10-24T14:55:03.243Z**, one loopback MCP client connected to the existing
production service, called `listTools` once and default `pindie_observe({})`
once, then closed. It did not dispatch work, open/switch a project or Session,
read timeline/content, refresh auth/quota, or restart anything.

- Production repository: clean `main = origin/main = remote main = dd2d22f46fc429966003a5b344107ecb72d67c03`;
  PR #309 merged; no open PR at preflight.
- 13 tools; actual loopback observe schema supported `snapshot | models`.
- Active Session ID: `01a16e64-0ec4-7772-99f8-97a1d94f5a84`;
  running/streaming, pending messages 0, automatic work not settled.
- Task active, verification stale; `openai-codex/gpt-6.1-sol`, thinking medium.
- Client-observed default observe latency: **22.26 ms** (connect/listTools excluded).
  UTF-8 serialized structured-content size: **1605 bytes**; content was not printed.

This is one real **transport/snapshot baseline**, not an efficiency or savings
trial. Latency includes local client/transport/server overhead and normal
snapshot projection. No token, duration, billing, retry/completion-rate or
ChatGPT-side usage sample was available through the deployed public schema.
The new efficiency view is tested with isolated fixtures, **not claimed live in
production**. No unsupported efficiency call was sent to production; obtain a
real efficiency sample only after separately approved deployment. Unit-test
usage is synthetic and must not be reported as real consumption.

The external Plugin v1.0.6 / Operator Skill v0.5 are untouched. The current
ChatGPT connection's cached MCP schema (`view`/`sessionName` unavailable) is an
independent external blocker, not fixed by repository changes or this local
loopback observation. Reconnection/schema synchronization requires separate
external action; no App/Tunnel change or synchronization success is claimed.
Strict `requireIdle` remains blocked and unchanged. Delivery is Draft PR only,
not merge, deployment, restart, Pi upgrade, default-model or production-config
change.
