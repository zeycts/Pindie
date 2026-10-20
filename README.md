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
  ├─ Knowledge Surface → LLM ← Pi tool baseline
  └─ Execution Authorization ─────┐
                   LLM choice ─────┤
                                  ↓
                         Execution Gateway
          ↓
       Reducer
          ↓
          Pi
          ↓
       Reality
```

The current semantic layer is deliberately small. Pindie does not add a second Agent Loop, workflow engine, task queue, planner framework, or separate Skill runtime.

**AL / Self-Improvement / Cross-Project Learning are retired.** Phase 1 disconnects their production imports, scheduler, stores, commands/tools, Policy/advisory and Experience paths. Old environment flags and embedding overrides cannot reactivate them. Historical user data stays untouched; dead implementation/design documents are removed and recoverable from Git history. Development improvement uses models, Harness, native Skills/workflows and human review/tests.

## What Pindie adds

- one durable current Task with explicit success criteria, open loops, verification, and Human Gate;
- pure `SemanticRunFacts → SemanticSnapshot → Capabilities` derivation;
- capability-driven execution authorization for the current Pi/user tool baseline (tool visibility alone is not authorization);
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
pindie_task_handoff (when Host rollover is enabled)
pindie_verification_record
pindie_task_complete
pindie_gate_open
pindie_gate_resolve
pindie_git_observe
pindie_memory_capture (when Work Memory is configured)
```

## Documentation

- [Architecture](docs/architecture.md) and [behavior](docs/behavior.md) — Stable Mode, Core/Host/Pi ownership, composition, Browser Reality and Work Memory.
- [Control](docs/pindie-control-v0.2.md) / [runtime safety](docs/pindie-control-v0.1.md) — workspace selection, MCP and active Host control.
- [Long Task runtime](docs/long-task-runtime.md), [Quota Fallback](docs/quota-fallback-v0.1.md), [Remote Companion](docs/remote-companion.md).
- [Pi compatibility](docs/pi-1.3.0-compatibility.md) and [TUI](docs/pindie-tui-v0.1.md).
- [Development execution](skills/development-execution/SKILL.md) and [Git workflow](skills/git-workflow/SKILL.md) — native Skills, not a second runtime.
- [Agent instructions](AGENTS.md).

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

For private local MCP control, start the workspace service without an active Host:

```bash
PINDIE_WORKSPACE_ROOT=/home/dev/projects pnpm control:mcp
```

For an existing single-project user systemd service, set the workspace root instead of the old project root (the Tunnel URL does not change):

```text
PINDIE_PROJECT_ROOT=/home/dev/projects/Pindie
→
PINDIE_WORKSPACE_ROOT=/home/dev/projects
```

It serves 13 `pindie_*` tools (10 project-scoped Control tools for observation, input, human response, safe stopping, session management, configuration, timeline, and waiting; plus three workspace tools for listing, opening, and creating projects) over Streamable HTTP at `http://127.0.0.1:8765/mcp` (override the port with `PINDIE_CONTROL_PORT`). List direct-child projects and explicitly open one before using project-scoped tools. Point OpenAI Secure MCP Tunnel at that local URL using `--mcp-server-url`, not `--mcp-command`; restarting the tunnel does not stop the Host. Only explicit project switching or process shutdown disposes the active Host. The service binds loopback only and validates Host/Origin headers; it does not open a public listener.

Optional Work Memory uses Notion when both environment variables are configured:

```text
PINDIE_NOTION_TOKEN
PINDIE_WORK_MEMORY_DATA_SOURCE_ID
```

Both must be configured to enable Work Memory.

### Browser Reality

Browser Reality is default-on and headless by default on WSL and native Linux.
Startup registers selected official Chrome DevTools MCP declarations as
`browser_*` Pi tools without launching Chrome or a bridge. The first browser
action lazily starts a dedicated browser/profile, reused across Host Sessions:

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
shutdown. `browser_status` inspects resource phase without startup;
`browser_release` explicitly discards browser state when no browser calls are
in flight. The next action starts fresh. After 15 minutes without activity,
automatic release requires a settled Session, no queued work, Human Gate,
quota wait, or pending UI interaction. Unknown authority prevents release.

Browser Reality is runtime-only: disabling it leaves normal Pindie startup and
semantic State unchanged. Startup/bridge failures do not disable ordinary work.
Graceful exits await Host cleanup; emergency terminal failure, crash, SIGKILL,
or machine loss cannot guarantee it. Unconfirmed cleanup retains the profile
and blocks automatic replacement. On Windows, a real Job handle is retained in
the browser root; losing that handle/name is **not** evidence that descendants
exited. Release requires an exact zero-active Job acknowledgment, otherwise the
profile is retained (even if the browser may already have exited).
No startup janitor kills old browsers or deletes old profiles; inspect and stop
only resources you can independently identify before manually removing stale profiles. See
[Browser lifecycle details](docs/architecture.md#browser-reality-v02).
