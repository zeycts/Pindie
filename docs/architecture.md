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
- optional specialized development skills

Pindie must not implement a second agent loop.

### Status presentation ownership

Pi's built-in footer presents infrastructure and runtime information (project, branch, token/context use, model, and thinking). Pindie presents semantic current-work information through one extension status line beneath it. Pindie never replaces or customizes Pi's footer for this purpose.

The Pindie status line derives its compact segments from runtime-only Run timing, semantic current-task State, directly available runtime alerts, and optional runtime-only account observations. It does not persist display fields or create independent status entries for each fact.

Its left region is Pindie current-work information (Run timing, verification, and attention). Its right region is account/environment resource information. ChatGPT subscription usage, when available from Pi's public resolved OpenAI Codex auth, is a best-effort runtime observation only: `w52%` means 52% weekly allowance remains and `↻18:29` is its local `HH:mm` reset time. Pindie selects the weekly window by its declared seven-day duration; the Codex backend may declare that duration as `limit_window_seconds`. The request uses Pi's runtime global fetch, which honors the standard proxy environment/configuration Pi establishes, but usage remains runtime-only and is never Pindie State or allowed to affect semantic/runtime correctness.

Semantic colors follow the active Pi theme:

```text
dim      → informational
text     → normal state
accent   → current activity (reserved for future Run Phase)
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

The six stages are semantic phases, not six mandatory model calls and not persisted workflow states.

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

Pi sessions provide interaction history; Git/files/environment provide reality.

## 7. Core Extension

The implemented v0.1 Core Extension provides:

- State loading and persistence
- Core Policy + Current State injection
- deterministic State transitions
- verification invalidation on known project mutation
- Human Gate lifecycle
- runtime safety checks
- runtime-only Agent Run timing in the unified Pindie semantic status line and completion output
- one theme-aware Pindie status line for verification progress and actionable Human Gate, blocker, and State-unavailable conditions
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
  → start runtime-only Run timer
  → derive and publish one Pindie semantic status line
  → snapshot pre-existing Human Gate / completed-task identity
  → append one Core Policy + Current State block

tool_call
  → enforce unavailable-State, Human Gate, terminal-task, and same-run guards

tool_result
  → successful edit/write
  → Runtime.dispatch(invalidate_verification)
  → refresh the derived Pindie status line

agent_settled
  → finalize runtime-only Run timer
  → consistency validation only; never auto-complete

session_shutdown
  → clear runtime-only Run timer and Pindie status presentation
  → unload transient Runtime context
```

Successful Pindie State and Human Gate tool transitions also refresh the status line after persistence. Run timer ticks are the only periodic trigger; they re-read current runtime State and do not persist timing or presentation.

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

## 9. Skills target

v0.1 may eventually include only three optional specialized skills:

- `plan` — complex/multi-system work
- `review` — systematic implementation review
- `ship` — delivery workflow

Observe, Understand, Decide, Act, Verify, and Update State are not six Skills. They are the semantics of the Core Loop.

## 10. Implementation sequence

Implemented Core v0.1 sequence:

1. State Model
2. State Machine / Reducer
3. State Store
4. Pindie custom tools
5. Pi Core Extension wiring

Current phase:

6. Real-world dogfooding of the existing Pindie Core

Specialized Skills are not assumed to be the immediate next implementation step. They should only be added later if repeated real usage shows that a specialized procedure is needed.

Each slice should remain testable without prematurely implementing later layers.
