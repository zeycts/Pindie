# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie carries one development task from intent to verified completion while keeping consequential human judgment explicit. Pindie Host owns the process and active Pi runtime lifecycle; Pi remains the low-level Agent Harness and Pindie adds a small semantic operating layer above it.

## Ownership

```text
Human       → goals, taste, consequential judgment, approval
Model       → interpretation, planning, semantic choice, verification meaning/coverage
Pindie Host → process lifecycle, active AgentSessionRuntime ownership/replacement
Pindie      → durable semantic State, legality, capability, factual evidence/freshness
Pi          → active AgentSession implementation, LLM execution, tools, Skills, low-level Agent Loop
```

> Eliminate meaningless choices, preserve meaningful choices.

## Architecture

```text
Reality
  ↓
Persistent State + Run Facts
  ↓
Semantic Snapshot
  ↓
Capabilities
  ├─ Knowledge Surface
  ├─ Tool Surface
  └─ Execution Authorization
          ↓
         LLM
          ↓
   Execution Gateway
          ↓
       Reducer
          ↓
          Pi
          ↓
       Reality
```

The semantic layer is deliberately small. Pindie does not add a second Agent Loop, workflow engine, task queue, planner framework, or separate Skill runtime.

## What Pindie adds

- one durable current Task with explicit success criteria, open loops, verification, and Human Gate;
- pure `SemanticRunFacts → SemanticSnapshot → Capabilities` derivation;
- capability-driven model Tool Surface over the current Pi/user tool baseline;
- an execution Gateway that re-authorizes consequential calls against fresh authority;
- factual Snapshot-aligned Runtime Context instead of a global lifecycle-policy prompt;
- Project Mutation Freshness for keeping verification current with project Reality;
- Harness-owned verification evidence provenance/freshness while the model owns semantic pass/fail and criterion coverage;
- a one-shot continuation probe that asks only whether latest actual user intent still calls for consequential execution;
- runtime-only activity, timer, cost, status presentation, adaptive reasoning, and `/efficiency`;
- process-local Codex subscription quota auto-resume, default-on via `/quota-resume`, and opt-in same-Session DeepSeek backup via `/quota-fallback` (default OFF);
- a bundled `git-workflow` Skill implemented through Pi's native Skill runtime.

Model-facing Pindie semantic tools are narrow affordances:

```text
pindie_task_start
pindie_task_replace
pindie_task_refine
pindie_task_progress
pindie_verification_record
pindie_task_complete
pindie_gate_open
pindie_gate_resolve
pindie_git_observe
pindie_policy_set
```

## Documentation

- `docs/architecture.md` — current architecture and ownership boundaries.
- `docs/behavior.md` — current semantic and behavioral contract.
- `docs/self-improvement.md` — Self-Improvement strategy and Run Experience contract.
- `AGENTS.md` — repository instructions for agents working on Pindie.

Git history and tests are the record of the v0.2 migration; stable docs describe the system as it exists now.

## Development

Requires Node.js 22.19+.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run check
```

Launch the Host-owned interactive Pindie using the Pi version pinned by this repository:

```bash
pnpm pindie
```

The legacy direct-extension path remains available as a temporary diagnostic fallback:

```bash
pi -e ./src/extension.ts
```

The package scripts are package-manager agnostic; pnpm is the recommended package manager for Pindie.

Optional Work Memory uses Notion when both environment variables are configured:

```text
PINDIE_NOTION_TOKEN
PINDIE_WORK_MEMORY_DATA_SOURCE_ID
```

Both must be configured to enable Work Memory.

### Browser Reality

Browser Reality is default-on and headless by default on WSL and native Linux.
A normal Pindie startup starts a dedicated browser profile without a visible
browser window and exposes selected official Chrome DevTools MCP tools as
`browser_*` Pi tools:

```bash
pnpm pindie
```

For rare debugging that requires a visible dedicated Chrome, use the headful
override:

```bash
PINDIE_BROWSER_HEADLESS=false pnpm pindie
```

Explicitly opt out when Browser Reality is not wanted:

```bash
PINDIE_BROWSER_ENABLED=false pnpm pindie
```

On WSL, this path requires mirrored networking and uses dedicated Windows Chrome
at `C:\Program Files\Google\Chrome\Application\chrome.exe`, with an isolated
runtime profile under `%LOCALAPPDATA%\Pindie\Dev Browser`. On native Linux, a
supported Chrome/Chromium executable must be installed; Pindie resolves
`google-chrome-stable`, `google-chrome`, `chromium`, then `chromium-browser` from
`PATH`, and stores isolated runtime profiles under
`$XDG_CACHE_HOME/pindie/dev-browser` (or `~/.cache/pindie/dev-browser`). In both
cases the DevTools endpoint is loopback-only, normal shutdown stops only that
Host's browser, and owned runtime profiles are removed. Optional advanced
overrides are:

```text
PINDIE_BROWSER_HEADLESS
PINDIE_BROWSER_URL
PINDIE_BROWSER_EXECUTABLE
PINDIE_BROWSER_PROFILE_DIR
```

`PINDIE_BROWSER_EXECUTABLE` explicitly overrides host executable discovery.
`PINDIE_BROWSER_URL` must remain an HTTP loopback URL with an explicit port.
When explicitly set, Pindie conservatively refuses an endpoint that is already
running rather than attaching to an unknown browser. An explicit
`PINDIE_BROWSER_PROFILE_DIR` remains developer-managed and is not removed on
shutdown. Browser Reality is runtime-only: disabling it leaves normal Pindie
startup and semantic State unchanged, while startup/bridge failures are
reported without disabling the rest of Pindie.
