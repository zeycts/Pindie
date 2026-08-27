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

Concrete execution semantics remain separate:

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

M0–M3 are implemented: semantic truth drives both live execution authorization and model-visible Tool Surface.

## 4. Durable State and Run Facts

`PindieState` stores one durable current Task or `null`:

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

Object identity is only a coherent-Run immutable-State change detector, never persistent semantic identity.

## 5. Capabilities and live execution

Capability vocabulary:

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

Capabilities are pure derived authority and are never persisted.

Important consequences:

```text
unavailable/stale authority → observation only
idle                       → observation + task.start
done before Run            → observation + task.start
done during Run            → observation only
blocked                    → no project.mutate, no task.complete
same-Run-opened Gate       → observation only
task.complete              → only when completionReady
```

The live Gateway authorizes every non-observation call through current capabilities after authoritative refresh/coherence checks. Reducer and Runtime remain deeper integrity backstops.

Project Mutation Freshness uses the same Tool Effect taxonomy:

```text
mutation none      → no project-mutation observation
mutation known     → successful mutation invalidates prior verification
mutation ambiguous → before/after Reality fingerprint observation
```

## 6. Model Tool Surface — implemented M3

Model-facing semantic tools are narrow capability-shaped adapters:

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

Internal reducer events remain unchanged.

For each actual Agent Run:

```text
Run Tool Baseline
        ∩
Tools allowed by current capabilities
        ↓
Effective Tool Surface
```

The Run Tool Baseline is the Pi/user active set captured at the authoritative `before_agent_start` boundary before Pindie applies restriction. Pindie may narrow it but never enable a tool absent from the baseline. The exact baseline is restored when the Run settles and a fresh one is captured for the next Run.

The M2 Gateway remains authoritative for races, stale pre-generated calls, and temporary visibility mismatch.

## 7. M4 Policy Reduction and Knowledge Surface

M4 removes the remaining global Pindie natural-language policy layer.

### No Pindie-owned global lifecycle prompt

The current `PINDIE_CORE_POLICY`/Core-block injection is transitional and must be deleted in M4.

Pindie must not replace it with:

- a hidden custom message;
- Runtime Context instructions;
- duplicated tool-description legality;
- long Gateway guidance;
- a private reconstruction of Pi's system prompt.

Natural-language policy is a last resort, not a source of deterministic correctness. If State, Snapshot, Capabilities, Tool Surface, Gateway, or Reducer already determine a rule, that rule must not be repeated as a global prompt instruction.

### Pi owns the system prompt

M3 changes active tools through Pi's public `setActiveTools()` API. Pi v0.84.3 rebuilds its base system prompt when the active tool set changes.

The remaining mismatch exists because Pindie's current `before_agent_start` handler returns a Pindie-modified `systemPrompt`, causing Pi to retain a run-level override. M4 removes that override. After M4:

```text
before_agent_start
→ establish Run facts
→ apply capability-driven Tool Surface
→ do not return a Pindie systemPrompt replacement
→ Pi uses its current native base prompt
```

This lets Pi's prompt text track the actual active tool set without Pindie parsing or rebuilding Pi internals.

Do not move the Core Policy into a `CustomMessage`: Pi converts extension custom messages to LLM-compatible user-role messages, so using one as global policy would blur the latest-user-intent boundary.

### Runtime Context is factual Knowledge Surface

The Pindie Runtime Context remains a hidden context message, but its role is factual projection only.

It may contain:

```text
Agent Run authority: coherent | stale | unavailable
Task status
Verification status
Goal
Constraints
Success criteria
Blockers
Questions
Next intent
Verification records
Human Gate
Unavailable-State reason
```

It must not contain procedural lifecycle instructions or restate actions already enforced by capabilities.

Runtime Context should consume the same `SemanticSnapshot` used by capability derivation for authority/task/verification status rather than independently calling separate status derivation helpers.

The projection therefore becomes:

```text
PindieState + SemanticRunFacts
        ↓
SemanticSnapshot
        ├→ Capabilities → Tool Surface / Gateway
        └→ Knowledge Surface + current State details
```

This ensures stale/unavailable authority is visible in context and prevents Knowledge Surface from describing a different semantic world than Tool Surface.

## 8. Human authority

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets human input among those choices.

## 9. Verification, continuation, activity, reasoning, skills

M4 does not redesign verification evidence. M5 later separates Harness-owned factual evidence from model-owned semantic coverage judgment.

Continuation remains subordinate to latest user intent and is redesigned only in M6. M4 may only update a stale literal tool name in the existing continuation probe if required by the M3 narrow-tool rename.

Activity, timer, cost, status, and adaptive reasoning remain runtime-only systems. Pi remains the sole Skill runtime.

## 10. Architectural invariants

1. Reality determines reconstructable facts.
2. State stores only durable semantic current-work facts.
3. Run Facts are runtime-only and minimal.
4. Snapshot and capabilities are derived, never persisted.
5. Knowledge Surface, Tool Surface, and Gateway legality derive from one semantic world.
6. Effective tools are a subset of the captured Pi/user Run baseline.
7. Reducer knows semantic events, not Pi tools.
8. Harness closes deterministic branches; model retains genuine semantic choices.
9. Human authority is explicit for consequential judgment.
10. Gateway remains defense in depth after Tool Surface alignment.
11. Global natural-language policy must not duplicate deterministic Harness authority.
12. Pi owns the low-level Agent Loop, Skill runtime, concrete tool registry, and native system-prompt construction.

## 11. Migration plan

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — implemented
M4 Policy Reduction                 — next
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M4 is intentionally deletion-heavy: remove the global Core Policy/system-prompt override, make Runtime Context factual and Snapshot-aligned, and leave M0–M3 runtime authority unchanged.