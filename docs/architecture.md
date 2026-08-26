# Pindie Architecture v0.2

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Pi remains the low-level agent harness. Pindie adds a small semantic operating layer above it.

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie → truth, legality, capability, lifecycle, evidence freshness
Pi     → LLM execution, tool registry/execution, sessions, low-level agent loop
```

Pindie should eliminate meaningless choices, not meaningful choices.

## 2. Non-goals

Pindie v0.2 does not add a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, second Skill runtime, universal shell parser, or second source of project truth.

## 3. Semantic architecture

```text
Reality
  ↓
Persistent State + runtime-only Run Facts
  ↓
Semantic Snapshot
  ↓
Capabilities
  ├───────────────┬──────────────────┐
  ↓               ↓                  ↓
Knowledge      Tool Surface      Authorization
Surface            │                  │
  │                └──────┬───────────┘
  │                       ↓
  └────────────────────── LLM
                          ↓
                    semantic choice
                          ↓
                  Execution Gateway
                          ↓
                       Reducer
                          ↓
                         Pi
                          ↓
                       Reality
```

The semantic center is deliberately small:

```text
PindieState + SemanticRunFacts
        ↓
deriveSemanticSnapshot()
        ↓
deriveCapabilities()
```

Concrete execution semantics are separate:

```text
Tool Call
  ↓
classifyToolEffect()
  ↓
required capability + project mutation effect

Capabilities + Tool Effect
  ↓
authorizeToolEffect()
```

M0–M2 implement these layers and make capability authorization the live runtime authority.

## 4. State, reducer, Runtime, and Run Facts

`PindieState` remains the minimal durable current-work model:

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

Task/verification statuses are derived. Capabilities, active tools, Run authority, presentation, reasoning state, continuation fuses, Git fingerprints, and workflow phases are never persisted.

The reducer remains the authority for hard State invariants and consumes semantic `PindieEvent`s, not Pi tool names. Runtime owns project-scoped load/save, authoritative refresh, locking, external-State conflict detection, reducer dispatch, and save-before-publish.

Run-boundary legality uses runtime-only relationships:

```text
TaskRunRelation       none | preexisting_untouched | preexisting_changed | introduced_during_run
CompletionRunRelation not_completed | completed_before_run | completed_during_run
GateRunRelation       none | existed_before_run | opened_during_run
```

M2 derives these from the current immutable Runtime State plus a minimal Run context: run-start Task/Gate references, run-start external-State epoch, and whether successful `task.start`/`task.replace` introduced the current Task. Object identity is only a coherent-Run change detector, never persistent semantic identity.

## 5. Capabilities

Initial capabilities are:

```text
observe.project
observe.git
project.mutate

task.start
task.refine
task.replace
task.progress
task.complete

verification.record

gate.open
gate.resolve
```

Capabilities are pure derived semantic authority and are never persisted.

Important consequences include:

```text
unavailable/stale authority → observation only
idle                       → observation + task.start
done before Run            → observation + task.start
done during Run            → observation only
blocked                    → no project.mutate, no task.complete
same-Run-opened Gate       → observation only
task.complete              → only when completionReady
```

`completionReady` requires an unfinished Task, passed current verification, no blockers, no unresolved questions, and no Human Gate.

## 6. Live Execution Gateway

M2 is implemented. Known observation tools remain a fast path. Every non-observation call follows the same authority chain:

```text
classify Tool Effect
→ refresh authoritative State / detect stale Run
→ derive SemanticRunFacts
→ derive SemanticSnapshot
→ derive Capabilities
→ authorize required capability
→ if allowed, establish mutation observation when required
→ execute
```

The Gateway does not reimplement Task/Gate/verification policy. Reducer and Runtime remain deeper integrity backstops.

Project Mutation Freshness consumes the same Tool Effect taxonomy:

```text
mutation none      → no project-mutation observation
mutation known     → successful mutation invalidates prior verification
mutation ambiguous → before/after Reality fingerprint observation
```

A denied call creates no mutation-observation side effects.

## 7. M3 Model Tool Surface

M3 aligns what the model can see with the already-live capability legality model.

### Narrow semantic tools

The broad model-facing `pindie_state(action=...)` and `pindie_gate(action=...)` interfaces are transitional APIs and should be replaced with narrow capability-shaped tools:

```text
pindie_task_start          → task.start
pindie_task_replace        → task.replace
pindie_task_refine         → task.refine
pindie_task_progress       → task.progress
pindie_verification_record → verification.record
pindie_task_complete       → task.complete
pindie_gate_open           → gate.open
pindie_gate_resolve        → gate.resolve
pindie_git_observe         → observe.git
```

These tools are adapters to the existing semantic `PindieEvent`s. Reducer events and persistent State do not change. M3 also does not redesign the verification record schema; that belongs to M5.

### Tool Surface projection

For every actual Agent Run:

```text
Run Tool Baseline
        ∩
Tools allowed by current capabilities
        ↓
Effective Tool Surface
```

The **Run Tool Baseline** is the Pi/user active-tool set captured at the authoritative `before_agent_start` boundary before Pindie applies semantic restriction. Pindie may narrow that set but must never enable a tool absent from the baseline.

For a baseline-active tool `T` in an unchanged semantic world:

```text
visible(T)
⇔
current capabilities contain T's required capability
```

Unknown/custom tools retain the conservative M1 effect `project.mutate / ambiguous`; therefore they are visible only when `project.mutate` is available and only if they were already baseline-active.

### Pi v0.84.3 active-tool contract

Pindie is pinned to Pi v0.84.3. Its public API provides:

```text
pi.getActiveTools() → current active names
pi.getAllTools()    → configured tool metadata
pi.setActiveTools(names)
```

`setActiveTools` is replacement-style, ignores unknown names, rebuilds Pi's base system prompt, and changes the active tool set for the next agent turn. Pi v0.84.3 exposes no composable active-tool overlay and no active-tool-change event.

M3 therefore owns a simple Run-scoped overlay contract:

1. At `before_agent_start`, refresh authoritative Pindie State and establish the actual Run Facts boundary.
2. Capture the current Pi/user active tools as the Run Tool Baseline before Pindie restricts them.
3. Derive the effective set by filtering that baseline through current capabilities.
4. Reapply from the same baseline whenever semantic capabilities change during the Run.
5. Restore the exact baseline when the Run settles.
6. Capture a fresh baseline for the next actual Agent Run.

Do not maintain a second persistent active-tool configuration. Do not restore/enable tools that were absent from the captured baseline.

Concurrent changes to active tools by another extension during an already-running Agent Run cannot be perfectly composed with Pi v0.84.3 because no overlay/change-event API exists. M3 documents that limitation rather than adding heuristic synchronization or another state machine.

### Why `input` is not the baseline boundary

Pi v0.84.3 emits the extension `input` event before model/auth preflight. That input may be handled or rejected without `before_agent_start`, without an Agent Run, and without `agent_settled`.

Therefore Pindie must **not** capture-and-restrict the active Tool Surface from `input`. Doing so could leave Pi idle with a narrowed active set and cause a later input to capture that restricted set as a false baseline.

`before_agent_start` is the single authority boundary for both:

```text
actual Agent Run Facts
Run Tool Baseline
```

This deliberately favors lifecycle correctness over speculative pre-Run prompt-text synchronization.

### Refresh points

The effective Tool Surface must be recomputed when capability truth can change, including:

```text
initial before_agent_start Run admission
successful semantic Task/Gate/verification transitions
project mutation that invalidates verification
external State change that makes the Run stale
State becoming unavailable
Task completion
```

The M2 Gateway remains authoritative for races, stale pre-generated calls, and any temporary visibility mismatch.

## 8. Pi system-prompt integration boundary

Pi v0.84.3 rebuilds its base system prompt when active tools change. However, Pindie's current `before_agent_start` Core Policy injection returns a system-prompt override for the high-level Agent Run. The hook receives a prompt value that was prepared before Pindie's handler narrows the tools, and the returned override remains active during subsequent turns of the same Run.

Therefore M3 guarantees the actual tool schemas/action space, not perfect synchronization of every selected-tool text fragment in the existing prompt override. `setActiveTools()` during `before_agent_start` still changes the actual tools before model execution; mid-Run surface changes likewise update actual schemas for later turns. The M2 Gateway remains correct for stale/pre-generated calls.

M3 must not parse/rebuild Pi's private prompt, import private Pi internals, or add compensating lifecycle prose. It also must not pre-restrict tools at `input` merely to improve prompt text.

M4 owns Policy Reduction and restructuring/removal of the Core Policy override so prompt text and dynamic Tool Surface can fully converge.

## 9. Knowledge Surface and Human authority

Runtime Context describes the semantic world: Task status, verification status, Task Contract, open loops, verification records, and Human Gate. It should not become a second lifecycle rule system.

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets the human input among those choices.

## 10. Verification, continuation, activity, reasoning, skills

M3 does not redesign verification evidence. M5 later separates Harness-owned factual evidence from model-owned semantic coverage judgment.

Continuation remains subordinate to latest user intent and is redesigned only in M6. Activity, timer, cost, status, and adaptive reasoning remain runtime-only systems. Pi remains the sole Skill runtime.

## 11. Architectural invariants

1. Reality determines reconstructable facts.
2. State stores only durable semantic current-work facts.
3. Run Facts are runtime-only and minimal.
4. Snapshot and capabilities are derived, never persisted.
5. Tool visibility and Gateway legality derive from the same capabilities.
6. Effective tools are a subset of the captured Pi/user Run baseline.
7. Run Tool Baseline is captured only for an actual Agent Run at `before_agent_start`, never speculatively at `input`.
8. Tool Effect classification is shared execution semantics, not a second policy system.
9. Reducer knows semantic events, not Pi tools.
10. Harness closes deterministic branches; model retains genuine semantic choices.
11. Human authority is explicit for consequential judgment.
12. Gateway remains a defense-in-depth backstop after Tool Surface alignment.
13. Pi remains the only low-level agent loop and Skill runtime.

## 12. Migration plan

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — next
M4 Policy Reduction
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M3 changes model-facing semantic tools and dynamic visibility, but does not change M0 capability truth, reducer semantics, persisted State, Verification v0.2 ownership, continuation, Skills, or Core Policy content. M4 follows immediately to remove policy text and the remaining system-prompt override mismatch made visible by dynamic tools.