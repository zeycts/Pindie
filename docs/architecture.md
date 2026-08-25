# Pindie Architecture v0.1

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Its core job is not to replace Pi's low-level agent runtime. It adds a persistent, verifiable development operating model above it.

The main architectural boundary is:

```text
Pindie decides what should happen next and what counts as done.
Pi executes model/tool interactions needed to make it happen.
```

## 2. Pi vs Pindie

### Pi owns

- model invocation
- tool-call execution
- tool results
- session runtime
- built-in tools such as read/edit/write/bash
- the underlying `LLM → Tool → Result → LLM` agent loop

### Pindie owns

- the development operating policy
- the semantic current-task State
- State transitions and hard invariants
- verification semantics
- Human Gate semantics
- the semantic contract for optional specialized Skills
- bundled Skill resources exposed to Pi

Pindie must not implement a second agent loop or a second Skill runtime.

### Status presentation ownership

Pi's built-in footer presents infrastructure and runtime information (project, branch, token/context use, model, and thinking). Pindie presents semantic current-work information through one extension status line beneath it. Pindie never replaces or customizes Pi's footer for this purpose.

The Pindie status line derives its compact segments from runtime-only Run timing, Run Cost, and Current Activity, semantic current-task State, directly available runtime alerts, and optional runtime-only account observations. It does not persist display fields or create independent status entries for each fact. Current Activity is a runtime-only observable Pi execution hint for compact presentation, not Pindie State and not a Core Loop phase.

Its left region is Pindie current-work information (Run timing, Run Cost, Current Activity, verification, and attention). Its right region is account/environment resource information. Run Cost is the incremental Pi-reported `usage.cost.total` for the same Agent Run as Run Timer, not Pi's cumulative session cost and not necessarily an amount charged to a subscription user's credit card. The on-demand `/efficiency` Inspector is separate from status presentation: it is runtime-only and read-only, derives reasoning, context, and session/cache facts from Pindie runtime state and Pi public APIs, reuses Run Cost, and owns no usage or cache State. ChatGPT subscription usage, when available from Pi's public resolved OpenAI Codex auth, is a best-effort runtime observation only: `◉ 52%` means 52% weekly allowance remains and `↻ 6d23h` is the time remaining until its weekly reset. The countdown is derived at render time from the runtime `resetsAt` timestamp: days render as `d+h`, hours as `h+m`, minutes as `m`, and less than one minute as `<1m`; expired timestamps omit the reset segment. `⟳ 1` means one manual full-reset credit is available; when complete eligible detail coverage makes it trustworthy, `⟳ 1 · 29d` also shows the nearest available credit expiry. The count comes authoritatively from the usage summary, while details are requested only for a positive count. A capped or incomplete detail list suppresses expiry rather than guessing. Manual reset credits are read-only runtime observations in v0.1: they are never persisted and Pindie has no consume action. Pindie selects the weekly window by its declared seven-day duration; the Codex backend may declare that duration as `limit_window_seconds`. The request uses Pi's runtime global fetch, which honors the standard proxy environment/configuration Pi establishes, but usage remains runtime-only and is never Pindie State or allowed to affect semantic/runtime correctness.

| Metric | Scope |
| --- | --- |
| Run Timer | one Agent Run elapsed time |
| Run Cost | one Agent Run Pi-reported model-equivalent cost |
| Current Activity | instantaneous observable active Run execution activity |
| Verification | current Task |
| Weekly Usage | ChatGPT account |

Semantic colors follow the active Pi theme:

```text
dim      → informational
text     → normal state
accent   → Current Activity
success  → successful state
warning  → attention / human intervention
error    → failure / runtime problem
```

## 3. Pindie Core Loop

The logical loop is:

```text
Observe
  ↓
Understand
  ↓
Decide
  ↓
Act
  ↓
Verify
  ↓
Update State
  ↓
Goal satisfied?
  ├─ No  → Observe
  └─ Yes → Done
```

Observe / Understand / Decide / Act / Verify / Update State are semantic phases, not six mandatory model calls and not persisted workflow states. They are distinct from Current Activity, which is a runtime-only presentation hint derived from observable Pi lifecycle and tool execution events; it does not report or infer a semantic Core Loop phase.

### Observe
Gather relevant evidence from the user, project, Git, environment, and tool results.

### Understand
Form the current problem model: problem, constraints, and success criteria.

### Decide
Choose the smallest safe next action. Planning is optional and only one possible decision outcome.

### Act
Change project reality through Pi and tools.

### Verify
Collect evidence against explicit success criteria. A change is not complete merely because code was written.

### Update State
Persist only semantic current-work information that cannot be reliably reconstructed from reality.

## 4. Core principles

1. **Reality > State.** Latest user intent and observed project reality override stale persisted State.
2. **Observe before consequential action.** Resume after interruption through fresh observation.
3. **Smallest safe next action.** Avoid large speculative execution plans when a smaller verifiable step exists.
4. **Verification is mandatory.** Completion requires current evidence against success criteria.
5. **State stays minimal.** Reconstructable information belongs to Git/files/environment, not Pindie State.
6. **Human judgment is explicit.** Product taste, consequential architecture choices, and destructive actions may require a Human Gate.
7. **One current task.** v0.1 deliberately excludes task queues and orchestration.
8. **Task boundaries reconcile intent.** Before consequential project action, reconcile latest actual user intent with the current Task after any needed read-only observation: continue when it belongs to that Task, refine when its Contract changes, replace an unfinished Task through `replace_task` when it clearly requests a different Task, and use a Human Gate for consequential ambiguity. Observation, discussion, pause, or return-control intent alone does not authorize consequential continuation.
9. **Active work continues.** An active Task continues only while the latest user intent calls for consequential execution of this current Task and a safe executable next action remains; response, turn, and low-level agent-loop boundaries are not Task boundaries. The hidden continuation follow-up is a probe subordinate to latest user intent, not unconditional authorization to resume persisted State. Persisted `nextIntent` records continuation context, not permission to yield or override later user intent because more implementation, replanning, or verification iterations are required.
10. **Task-backed execution.** Read-only observation requires no Task. Consequential project action requires available, coherent State and one current Task; `pindie_state(start_task)` is the legal transition from idle into Task-backed execution, before existing Task-boundary, Human Gate, and completion guards apply.

## 5. State model

Pindie State is the agent's minimal persistent working memory, not a project database and not a conversation history.

```text
PindieState
└── task | null
    ├── goal
    ├── constraints
    ├── successCriteria
    ├── openLoops
    ├── verification
    ├── humanGate
    └── completed
```

The durable Task Contract is `goal + constraints + successCriteria`: goal is the intended outcome, constraints are task-wide execution boundaries, and success criteria are final observable completion outcomes. `openLoops.nextIntent` carries continuation intent for unfinished work.

Task status is derived from facts rather than stored directly:

```text
no task                         → idle
completed                       → done
human gate open                 → waiting_human
one or more blockers            → blocked
otherwise                       → active
```

Verification status is also derived:

```text
stale                           → stale
no checks                       → pending
any current failed check        → failed
all criteria covered by passes  → passed
otherwise                       → pending
```

## 6. What State does not store

Do not persist these in Pindie State when they can be re-observed:

- current branch
- git diff
- changed files
- package versions
- source file contents
- raw tool-call history
- complete build/test logs
- loop phase such as `deciding` or `testing`
- Skill selection, lifecycle, or Skill-local workflow progress
- request-time model Runtime Context or any prompt-cache metadata

Pi sessions provide interaction history; Git/files/environment provide reality. Pi Skill context provides reconstructable Skill information.

## 7. Core Extension

The implemented v0.1 Core Extension provides:

- State loading and persistence
- stable Core Policy system-prompt injection plus ephemeral request-time Runtime Context projection
- deterministic State transitions
- verification invalidation on known project mutation and runtime-only Project Mutation Freshness probes for ambiguous consequential tools
- Human Gate lifecycle
- runtime safety checks
- runtime-only Agent Run timing, cost, observable Current Activity, and adaptive reasoning control in the unified Pindie semantic status line (with timing also in completion output)
- an on-demand read-only `/efficiency` Inspector derived from current Pi public session/context facts, runtime reasoning, and existing Run Cost without persistence or background collection
- one theme-aware Pindie status line for Current Activity, verification progress, and actionable Human Gate, blocker, and State-unavailable conditions
- custom tools `pindie_state`, `pindie_gate`, and `pindie_git_observe`

The model-facing State mutation path is:

```text
Tool
  ↓
PindieRuntime
  ↓
Reducer
  ↓
State Store
```

Tools never bypass `PindieRuntime`. The runtime persists a successful reducer result before publishing it as current in-memory State. Project disk State is authoritative across Runtime processes; Runtime memory is only a working snapshot. `before_agent_start` refreshes disk State before taking run-start Task/Gate/completion identity snapshots. Consequential `tool_call` preflight refreshes State and makes a Run read-only when an external change is discovered. Every semantic dispatch takes a short project-scoped filesystem lock, reloads and structurally compares authoritative State, then reduces, atomically saves, and publishes. A runtime-only external-State epoch marks a Run stale without persisting concurrency metadata. Stale Runs permit only the existing read-only observation tools and cannot queue active-task continuation. `invalidate_verification` is the sole internal event allowed to rebase onto changed authority; it can revoke a concurrent completed/passed Task to stale unfinished State after known project mutation. Pindie uses no State watchers, polling, revisions, database, CAS protocol, or second loop. The lock is a `state.lock` directory with token/PID ownership; valid confirmed-dead owners are reclaimed only after an exclusive in-lock reclaim claim rechecks the exact owner identity. Live or uncertain owners are never stolen, and missing/corrupt ownership metadata is fail-closed rather than age-reclaimed. The lock is never held across model calls, project tools, Gates, or verification commands.

The implemented Pi lifecycle path is:

```text
session_start
  → canonical project resolver
  → Runtime.load

before_agent_start
  → refresh authoritative project State before any run-start identity snapshots
  → reset extension-local active-Task continuation fuse
  → start runtime-only Run timer, Run Cost, and Current Activity (thinking)
  → request Auto Medium through Pi; Manual leaves Pi's thinking level unchanged
  → snapshot pre-existing unfinished-task, Human Gate, and completed-task identity
  → append one stable Core Policy block
  → derive and publish one Pindie semantic status line

context (before every LLM call)
  → preserve existing Pi/session messages while removing any prior synthetic Pindie Runtime Context message
  → read current authoritative Runtime State and append one fresh deterministic Runtime Context message
  → never persist Runtime Context or manage Pi prompt caching

tool_execution_start / tool_execution_end
  → update runtime-only Current Activity from public tool execution lifecycle
  → immediately refresh the one Pindie semantic status line

agent_end
  → Pindie decides whether active semantic work should continue
  → when the active Task is executable and the final assistant message stopped normally, queue one hidden Pi-native continuation probe that first re-evaluates latest user intent
  → the probe settles normally rather than resuming consequential Task work when that intent no longer calls for execution
  → Pi's existing follow-up queue and `agent.continue()` machinery execute that continuation; Pindie creates no second Agent Loop

tool_call
  → allow only existing read-only observation, including `pindie_git_observe`, without freshness preflight
  → otherwise enforce unavailable-State and stale-Run freshness / authoritative refresh
  → require a current Task, allowing only `pindie_state(start_task)` when idle
  → otherwise enforce existing Task-boundary, Human Gate, terminal-task, and same-run guards

turn_end (only turns with tool results)
  → runtime-only Auto reasoning chooses the next requested Low, Medium, or High from tool errors, current verification, current request, and successful built-in edit/write results
  → Pi clamps and reports the effective thinking level

thinking_level_select
  → synchronize only the runtime-only effective thinking level; never infer mode

tool_result
  → successful edit/write
  → Runtime.dispatch(invalidate_verification)
  → ambiguous consequential tool with runtime-only probe: compare BEFORE/AFTER Git-visible worktree fingerprint
  → unchanged preserves verification; changed or unknown dispatches invalidate_verification
  → refresh the derived Pindie status line

agent_settled
  → remains the final Agent Run settlement boundary after Pi retries, compaction, and queued follow-ups
  → ignore an obsolete stale ExtensionContext after Pi session replacement/reload
  → otherwise finalize runtime-only Run timer and clear Current Activity
  → consistency validation only; never auto-complete

session_shutdown
  → clear runtime-only Run timer, Run Cost, Current Activity, adaptive reasoning mode, and Pindie status presentation
  → unload transient Runtime context
```

Successful Pindie State and Human Gate tool transitions also refresh the status line after persistence. Tool execution start/end events refresh Current Activity immediately. Run timer ticks remain the only periodic trigger; they re-read current runtime State and do not persist timing or presentation.

The Agent-run snapshot is extension-local and resets at each `before_agent_start`. It records only object identity for an unfinished replaceable Task, gate, or completed task that already existed at the run boundary plus a one-shot active-Task continuation fuse; it is neither persisted State nor a second state machine. `replace_task` may replace only that untouched run-start unfinished Task, once: a Task started, replaced, or semantically mutated during the Run is not replaceable. This permits abandoning a pre-existing Gate with a clearly different Task while preventing a Gate opened during the Run from being bypassed. The fuse permits at most one hidden Pi-native follow-up for one user-driven Agent Run and is not reset by that follow-up.

`pindie_git_observe` provides exactly eight fixed semantic read-only Git actions (`status`, `branch`, `root`, `diff`, `diff_cached`, `diff_check`, `log`, and `remote`). It invokes fixed `git` argv directly without a shell, disables prompts, optional locks, lazy fetch, fsmonitor, external diff/textconv, and pager behavior, and cannot mutate Pindie State. It is read-only for guards; generic `bash` remains consequential and is never parsed for Git exceptions.

Project Mutation Freshness keeps one runtime-only overlapping mutation window for admitted ambiguous consequential tools (`bash` and unknown/custom consequential tools). Only after State/coherence, Task, replace, Gate, and completion guards pass, its first call captures a BEFORE Git-visible worktree fingerprint and later overlapping calls join that same baseline by `toolCallId`; results consume their IDs and compare current reality with the shared baseline until the final pending result closes the window. Known unchanged content preserves current verification, while changed or unknown freshness dispatches the existing `invalidate_verification`. Successful edit/write retain direct invalidation; failed edit/write, Safe Observation, and Pindie State/Gate tools do not probe. Fingerprints are not persisted or model-facing, and generic shell commands are never parsed.

Execution Hygiene is a Core execution invariant. `pi-smoke` is narrow tooling for repeated Pindie dogfood verification, not State, Runtime, Skill lifecycle, bash parsing, or a second Agent Loop.

Adaptive reasoning is runtime-only and never enters `PindieState`, the State Store, project files, or Pi session entries. Its controller requests a level with Pi's public `setThinkingLevel()` then reads the effective level from public `getThinkingLevel()`; Pi remains authoritative for model support and clamping. Auto starts each Agent Run at Medium and only requests Low, Medium, or High. Manual mode, selected through `/reasoning`, leaves thinking-level control to Pi's native `/thinking` interface. The controller does not route models, infer Core Loop phases, classify with an LLM, or retain history.

## 8. Persistence target

Primary Pindie State should be project-scoped and independent of a single Pi session:

```text
canonical project root
        ↓ SHA-256
~/.pindie/projects/<project-id>/state.json
```

The Core Extension resolves the canonical project root (the canonical Git root when available, otherwise canonical cwd). `FileStateStore` assumes the provided project root is already canonical and only hashes it to derive the project ID.

Pi session history may retain snapshots, but it is not the authoritative current-work State. Pindie Core Policy is stable system-prompt content; dynamic semantic State is instead projected as one ephemeral custom Runtime Context message immediately before each LLM call. That projection is deterministic, includes the derived statuses and populated Task Contract/open-loop/verification/Human Gate semantics, and is not saved to a Pi session or Pindie State. Pi alone owns prompt cache behavior.

## 9. Skill Integration v0.1

```text
Pindie
├── Core Policy
├── State / Verification / Human Gate
├── Skill semantic contract
└── bundled Skills
    └── git-workflow
          │
          ▼
Pi Skill Runtime
├── discovery
├── validation
├── Skill index
├── progressive disclosure
├── Skill loading
├── explicit invocation
└── source/trust handling
```

Skills specialize the Pindie Core Loop. Skills do not replace the Pindie Core Loop. Pindie does not implement a second Skill runtime.

Pi owns Skill discovery and directory scanning, metadata parsing and validation, index construction, progressive disclosure, loading `SKILL.md`, explicit `/skill:<name>` invocation, source resolution, collisions, project trust, and Skill reload/runtime mechanics. Pindie exposes bundled resources through `pi.skills: ["./skills"]`; it does not scan, load, select, validate, resolve, or invoke Skills itself.

Pindie owns only the Skill semantic contract: a Skill is an optional specialized procedure, subordinate to runtime and safety constraints, latest user intent, observed project reality, Core invariants, the current Task Contract, Verification, and Human Gates. Core Task establishment and reconciliation precede consequential Git action; git-workflow's Git inspection requirement does not outrank that Core boundary. A Skill cannot bypass guards, change completed-task rules, silently expand scope, or treat stale State as more authoritative than reality. Skill-guided calls use the ordinary Pi tool path and existing Pindie guards.

Skills have no Pindie lifecycle or persistent State. Pindie does not infer an active Skill from reading `SKILL.md`, add Skill status presentation, or create Skill-specific verification logic. Reading is observational; existing successful `edit` and `write` invalidation remains authoritative. Skill configuration failures remain Pi resource/configuration failures and never make Pindie State unavailable.

Pindie creates no parallel Skill locations or source/trust policy. `git-workflow` is the first bundled Skill: a narrow procedure for safe branch → commit → push → PR delivery of one code-changing task. A specialized Skill is added only after dogfooding demonstrates a stable, narrow, reusable procedure; no catalog is preselected. Observe, Understand, Decide, Act, Verify, and Update State are Core Loop semantics, not Skills.

### Skill authoring

- Use Pi-compatible `SKILL.md`.
- Add a Skill only after repeated dogfooding reveals a stable, narrow, reusable procedure.
- Skills specialize the Pindie Core Loop; they do not reproduce or replace it.
- Skills remain subordinate to current user intent, observed project reality, the Task Contract, Verification, Human Gates, and Pindie hard invariants.
- Skill-local workflow progress is not persistent Pindie State.
- Optional `references/`, `scripts/`, and other supporting resources should be loaded only when needed.
- A Skill description should clearly state what it does and when to use it.

## 10. Implementation sequence

Implemented Core v0.1 sequence:

1. State Model
2. State Machine / Reducer
3. State Store
4. Pindie custom tools
5. Pi Core Extension wiring

Current phase:

6. Real-world dogfooding of the existing Pindie Core and its first bundled `git-workflow` Skill

`git-workflow` was added after repeated dogfooding established a stable, narrow delivery procedure. Further Skills remain unplanned until the same evidence exists.

Each slice should remain testable without prematurely implementing later layers.
