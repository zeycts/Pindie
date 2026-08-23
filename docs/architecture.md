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

Its left region is Pindie current-work information (Run timing, Run Cost, Current Activity, verification, and attention). Its right region is account/environment resource information. Run Cost is the incremental Pi-reported `usage.cost.total` for the same Agent Run as Run Timer, not Pi's cumulative session cost and not necessarily an amount charged to a subscription user's credit card. ChatGPT subscription usage, when available from Pi's public resolved OpenAI Codex auth, is a best-effort runtime observation only: `◉ 52%` means 52% weekly allowance remains and `↻ 6d23h` is the time remaining until its weekly reset. The countdown is derived at render time from the runtime `resetsAt` timestamp: days render as `d+h`, hours as `h+m`, minutes as `m`, and less than one minute as `<1m`; expired timestamps omit the reset segment. `⟳ 1` means one manual full-reset credit is available; when complete eligible detail coverage makes it trustworthy, `⟳ 1 · 29d` also shows the nearest available credit expiry. The count comes authoritatively from the usage summary, while details are requested only for a positive count. A capped or incomplete detail list suppresses expiry rather than guessing. Manual reset credits are read-only runtime observations in v0.1: they are never persisted and Pindie has no consume action. Pindie selects the weekly window by its declared seven-day duration; the Codex backend may declare that duration as `limit_window_seconds`. The request uses Pi's runtime global fetch, which honors the standard proxy environment/configuration Pi establishes, but usage remains runtime-only and is never Pindie State or allowed to affect semantic/runtime correctness.

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

Pi sessions provide interaction history; Git/files/environment provide reality. Pi Skill context provides reconstructable Skill information.

## 7. Core Extension

The implemented v0.1 Core Extension provides:

- State loading and persistence
- Core Policy + Current State injection
- deterministic State transitions
- verification invalidation on known project mutation
- Human Gate lifecycle
- runtime safety checks
- runtime-only Agent Run timing, cost, and observable Current Activity in the unified Pindie semantic status line (with timing also in completion output)
- one theme-aware Pindie status line for Current Activity, verification progress, and actionable Human Gate, blocker, and State-unavailable conditions
- custom tools `pindie_state` and `pindie_gate`

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

Tools never bypass `PindieRuntime`. The runtime persists a successful reducer result before publishing it as current in-memory State.

The implemented Pi lifecycle path is:

```text
session_start
  → canonical project resolver
  → Runtime.load

before_agent_start
  → start runtime-only Run timer, Run Cost, and Current Activity (thinking)
  → snapshot pre-existing Human Gate / completed-task identity
  → append one Core Policy + Current State block
  → derive and publish one Pindie semantic status line

tool_execution_start / tool_execution_end
  → update runtime-only Current Activity from public tool execution lifecycle
  → immediately refresh the one Pindie semantic status line

tool_call
  → enforce unavailable-State, Human Gate, terminal-task, and same-run guards

tool_result
  → successful edit/write
  → Runtime.dispatch(invalidate_verification)
  → refresh the derived Pindie status line

agent_settled
  → finalize runtime-only Run timer and clear Current Activity
  → consistency validation only; never auto-complete

session_shutdown
  → clear runtime-only Run timer, Run Cost, Current Activity, and Pindie status presentation
  → unload transient Runtime context
```

Successful Pindie State and Human Gate tool transitions also refresh the status line after persistence. Tool execution start/end events refresh Current Activity immediately. Run timer ticks remain the only periodic trigger; they re-read current runtime State and do not persist timing or presentation.

The Agent-run snapshot is extension-local and resets at each `before_agent_start`. It records only object identity for a gate or completed task that already existed at the run boundary; it is neither persisted State nor a second state machine. This lets a later run consume persisted consequential State while preventing a gate opened, or task completed, during the current run from being immediately consumed by sibling or follow-up tool calls.

Generic `bash` results are not treated as known project mutation in v0.1. The Extension does not parse shell commands or implement a second Agent Loop.

## 8. Persistence target

Primary Pindie State should be project-scoped and independent of a single Pi session:

```text
canonical project root
        ↓ SHA-256
~/.pindie/projects/<project-id>/state.json
```

The Core Extension resolves the canonical project root (the canonical Git root when available, otherwise canonical cwd). `FileStateStore` assumes the provided project root is already canonical and only hashes it to derive the project ID.

Pi session history may retain snapshots, but it is not the authoritative current-work State.

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

Pindie owns only the Skill semantic contract: a Skill is an optional specialized procedure, subordinate to runtime and safety constraints, latest user intent, observed project reality, Core invariants, the current Task Contract, Verification, and Human Gates. A Skill cannot bypass guards, change completed-task rules, silently expand scope, or treat stale State as more authoritative than reality. Skill-guided calls use the ordinary Pi tool path and existing Pindie guards.

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
