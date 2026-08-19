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

## 7. Core Extension target

The eventual v0.1 Core Extension will provide:

- State loading and persistence
- Core Policy + Current State injection
- deterministic State transitions
- verification invalidation on known project mutation
- Human Gate lifecycle
- runtime safety checks
- custom tools `pindie_state` and `pindie_gate`

The implemented model-facing State mutation path is:

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

Expected Pi hooks:

```text
session_start       → resolve project + load State
before_agent_start  → inject Core Policy + Current State
tool_call           → safety interception
tool_result         → detect known mutation / invalidate verification
agent_settled       → lightweight consistency check
session_shutdown    → flush / cleanup
```

## 8. Persistence target

Primary Pindie State should be project-scoped and independent of a single Pi session:

```text
canonical project root
        ↓ SHA-256
~/.pindie/projects/<project-id>/state.json
```

A later runtime layer resolves the canonical project root (the canonical Git root when available, otherwise canonical cwd). `FileStateStore` assumes the provided project root is already canonical and only hashes it to derive the project ID.

Pi session history may retain snapshots, but it is not the authoritative current-work State.

## 9. Skills target

v0.1 may eventually include only three optional specialized skills:

- `plan` — complex/multi-system work
- `review` — systematic implementation review
- `ship` — delivery workflow

Observe, Understand, Decide, Act, Verify, and Update State are not six Skills. They are the semantics of the Core Loop.

## 10. Implementation sequence

Approved implementation order:

1. State Model
2. State Machine / Reducer
3. State Store
4. Pindie custom tools
5. Pi Core Extension wiring
6. Skills + real-world dogfooding

Each slice should remain testable without prematurely implementing later layers.
