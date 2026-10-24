# ChatGPT ↔ Control phase 1 — implementation and blockers

This is a **partial phase-1 delivery**, not deployment or ChatGPT acceptance.
The [v0.2 workspace contract](pindie-control-v0.2.md) and
[v0.1 authority/safety contract](pindie-control-v0.1.md) remain authoritative.

## Schema audit (2026-10-24)

- Local main, origin/main and remote main were `9ce578cb739856e35019dca6df3b226238b315a9`.
- A separate read-only MCP client connected to the running loopback service at
  `http://127.0.0.1:8765/mcp` and called **only `tools/list`**. It reported 13 tools;
  `pindie_input.inputSchema.properties` contained `lease`, `text`, `timing`,
  **`sessionName`**. Only `lease` and `text` were required.
- Therefore the reported ChatGPT schema omission is not reproduced in either the
  current repository or the running loopback service. No production change is
  needed to restore this field there. HTTP transport regression coverage now
  verifies the exported field, constraints, optionality and closed schema, in
  addition to existing in-memory schema and argument-forwarding tests.
- The current agent cannot inspect the ChatGPT App/plugin binding, tunnel's
  connected endpoint, or connector schema cache. Which external layer differs
  remains **unverified**. The next external action is to compare that binding's
  actual discovered `tools/list` with the loopback result using supported platform
  facilities. No platform refresh API is assumed, and this PR does not claim the
  field is effective in ChatGPT. No App/plugin was modified or published.

## Read-only model discovery (implemented)

`pindie_observe({ "view": "models" })` returns:

```json
{
  "source": "pi_available_registry_snapshot",
  "models": [
    {
      "provider": "exact-provider-id",
      "modelId": "exact-model-id",
      "name": "catalog display name",
      "reasoning": true,
      "input": ["text"],
      "contextWindow": 123,
      "maxTokens": 45
    }
  ]
}
```

The illustrative limits above are not model recommendations. Entries come only
from the active Session's existing Pi `ModelRegistry.getAvailable()` snapshot,
independent of scoped picker choices. They are sorted by provider/model ID and
projected through an explicit allowlist. Metadata is catalog-declared, not
empirically verified. `reasoning` is not a supported thinking-level range.
Prices, credential material, headers, endpoints and guessed thinking levels are
not returned. An empty registry returns an empty list.

This does not refresh the registry, resolve credentials, probe a provider, invoke
a model, mutate configuration, select a model, or persist anything. Registry
availability is **not** a claim about current credentials, network health, quota
or successful execution. Do not use `pindie_configure` as a discovery probe.

Without an active project, the models view returns the existing structured
`no_active_project` error without opening a Host. With no arguments (or
`view: "snapshot"`), observation retains its existing result and behavior. Tool
count remains **13**, with unchanged annotations and all old input fields.
The bundled monitor's strict schema verifier accepts both the old empty observe
schema and the exact new optional view; it still sends `{}` and exposes no model
query port. Older monitor binaries with the old exact-empty-schema check will
reject the new service schema and need the matching update at a separately
authorized rollout. No generic unknown-schema acceptance was added.

No new defaults or model policy are introduced. GPT-primary / DeepSeek-backup
policy remains in the external ChatGPT Operator Skill v0.4, not Pi defaults.

## Strict independent-task dispatch (blocked, not exposed)

No `requireIdle` field is advertised or partially implemented in this PR.
The requested condition is stronger than an observe-then-input precheck: lease,
idle, settled, empty queue, no Human Gate and no quota wait must remain valid at
the actual dispatch boundary. Existing ordinary input behavior is unchanged.

Audited pinned Pi 1.4.0 public declarations and implementation:

- `AgentSession.prompt()` awaits extension input handlers and may await auth
  checking after Control has called it.
- It can also defer a prompt received during `agent_settled` emission.
- `PromptOptions.preflightResult` reports `handled`/`queued`/`started`; it is a
  notification, **not an authorization predicate**.
- `started` is emitted inside `_startRun`, after `_isAgentRunActive = true`,
  awaited `_prepareRun`/`before_agent_start` and consumption of pending next-turn
  messages. It is too late to reject safely. Throwing there is not a supported
  cancellation mechanism and can leave native bookkeeping inconsistent.
- Omitting `streamingBehavior` prevents silent native steer/followUp when the
  streaming check observes busy, but does not atomically enforce settlement,
  queue, Gate, quota or binding identity after all asynchronous preflight work.

Thus a new Control precheck, mutex around external callers, or input-handler
check alone cannot establish the promised atomic condition against native
continuation, recovery, extension work and Session lifecycle races. Do not use
post-acceptance abort/queue clearing as rollback: that could affect other work.

A safe implementation needs a Pi-owned cancellable dispatch guard after
asynchronous preprocessing and before any acceptance/queue/run side effect,
including deferred actions, with defined rejection bookkeeping. That public seam
is absent in the pinned SDK. Modifying dependency internals, introducing a second
loop, or upgrading Pi is outside this phase's narrow Control implementation.
Stop this part pending an explicitly approved compatible native seam; then add
strict rejection/success/compatibility and boundary-race tests before exposing
`requireIdle`. This document is not authorization to start a later phase.

## Delivery boundaries

Repository model discovery and schema regressions require review and separately
authorized deployment. Production was only read, never reconfigured/restarted.
ChatGPT connector/App/plugin synchronization and end-to-end schema acceptance
remain external work. Strict dispatch remains blocked as above. No merge,
deployment, resource cleanup or later-phase work is included.
