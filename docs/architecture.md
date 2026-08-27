# Pindie Architecture v0.2

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Pi remains the low-level agent harness. Pindie adds a small semantic operating layer above it.

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie → truth, legality, capability, lifecycle, factual evidence freshness
Pi     → LLM execution, tool registry/execution, sessions, low-level agent loop
```

Pindie should eliminate meaningless choices, not meaningful choices.

## 2. Non-goals

Pindie v0.2 does not add a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, verification-log database, second Skill runtime, universal shell parser, or second source of project truth.

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

M0–M4 are implemented: semantic truth drives live authorization, model-visible Tool Surface, and factual Runtime Context; Pi owns its native system prompt without a duplicated Pindie Core Policy.

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

Task/verification statuses are derived. Capabilities, active tools, Run authority, presentation, reasoning state, continuation fuses, Git fingerprints, recent evidence refs, evidence generations, and workflow phases are never persisted.

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

## 7. Knowledge Surface / prompt ownership — implemented M4

Pindie no longer owns a global lifecycle-policy system prompt. Pi owns its native system-prompt construction.

Runtime Context remains a hidden factual Knowledge Surface driven by the same `SemanticSnapshot` used by capabilities. It may report authority, Task/verification status, current Task details, verification records, Human Gate, and factual unavailable reason; it must not duplicate structural legality as procedural instructions.

The projection is:

```text
PindieState + SemanticRunFacts
        ↓
SemanticSnapshot
        ├→ Capabilities → Tool Surface / Gateway
        └→ Knowledge Surface + current State details
```

Natural-language policy is a last resort, not a source of deterministic correctness.

## 8. Verification v0.2 — M5 target

M5 fixes evidence ownership while deliberately preserving the durable Verification State shape.

### 8.1 Ownership boundary

```text
Actual Pi tool execution
        ↓
Harness observes factual result
        ↓
Recent factual Evidence Candidate
        ↓
Model semantic judgment
  - check name
  - passed | failed meaning
  - success-criterion coverage
        ↓
Harness resolves selected evidence refs
        ↓
Existing durable VerificationCheck
        ↓
Reducer / State
```

Harness owns `what happened`. Model owns `what it proves`.

A tool result being an error does not imply semantic verification failure: an error may correctly demonstrate rejection behavior. Therefore Pindie must not derive `VerificationCheck.status` from Pi `isError`.

### 8.2 Durable schema remains compatible

M5 does **not** redesign persisted `PindieState.verification`.

Durable checks remain conceptually:

```text
VerificationCheck
├── name
├── status: passed | failed
├── covers: criterion ids[]
└── evidence: string
```

The difference is provenance: new `evidence` strings are generated deterministically by the Harness from selected current evidence refs instead of being free-written by the model.

Existing verification records are grandfathered. There is no State migration, schema version, forced stale-on-load behavior, or persisted evidence-ref format.

### 8.3 Recent Evidence Registry

M5 introduces a runtime-only Recent Evidence Registry scoped to the current actual Agent Run.

A candidate has a deterministic temporary ref, preferably:

```text
ev:<toolCallId>
```

The ref must never be persisted. A model may use it only through the current `pindie_verification_record` call, where the Harness resolves it to factual data.

Unrecorded candidates are discarded at Agent settlement/session shutdown and do not become a permanent tool-result log.

### 8.4 Evidence eligibility

Evidence candidates are observations of Reality, not arbitrary Pindie semantic transitions.

Eligible while a coherent unfinished current Task exists:

```text
observe.project
observe.git
```

Ambiguous project-effect tools such as `bash` or unknown custom tools may become evidence only after M2 Project Mutation Freshness proves project reality unchanged for that execution window.

Known project mutations (`edit`/`write`) are not evidence candidates. Pindie Task/Gate/verification semantic tools are not evidence candidates.

Failed tool results may still be factual evidence if otherwise eligible.

### 8.5 Evidence freshness generation

Clearing a registry alone is insufficient because parallel/late tool results can complete after the verification basis changes.

M5 therefore uses a runtime-only evidence generation/freshness token:

```text
Authorized Tool Call
→ remember generation-at-call

Verification basis changes
→ advance generation
→ clear current candidates

Tool Result arrives
→ candidate eligible only if call generation === current generation
```

This prevents a result that began against old Reality/Task semantics from becoming current evidence after a mutation or Task-boundary change.

Generation/freshness is runtime-only and never enters `PindieState`.

Advance it when the verification basis changes, including at least:

```text
new actual Agent Run
successful task.start / task.replace
successful task.refine
known project mutation
detected or unknown ambiguous project mutation
external authority discontinuity / State unavailable
```

Do not advance merely for observation, Task progress, Gate open/resolve, or verification record.

### 8.6 Mutation-before-evidence ordering

For ambiguous project-effect tools:

```text
tool_result
→ existing M2 mutation observation first
→ mutation detected/unknown?
   ├ yes → invalidate verification + advance evidence generation; no candidate
   └ no  → candidate may be captured if all other eligibility conditions hold
```

The result of an ambiguous tool that changed project reality is not current verification evidence; the model should perform a fresh verification action afterward.

### 8.7 Bounded factual materialization

Pindie must not automatically persist raw tool-result logs.

Recent candidates may retain enough runtime data to support deterministic materialization, but only refs explicitly selected by `pindie_verification_record` become durable evidence.

Harness materialization must be bounded and deterministic, using concise factual metadata/excerpts plus digests for longer/non-text data. The model does not write or summarize the durable evidence string.

The first implementation should keep this intentionally small rather than create a general evidence database.

## 9. Human authority

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets human input among those choices.

## 10. Continuation, activity, reasoning, skills

Continuation remains subordinate to latest user intent and is redesigned only in M6.

Activity, timer, cost, status, and adaptive reasoning remain runtime-only systems. Pi remains the sole Skill runtime.

## 11. Architectural invariants

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
12. Verification factual evidence/provenance/freshness belongs to Harness; verification meaning/coverage belongs to the model.
13. Runtime evidence refs/generations are temporary and never persisted.
14. Durable Verification State remains compact; Pindie is not a tool-result log database.
15. Pi owns the low-level Agent Loop, Skill runtime, concrete tool registry, and native system-prompt construction.

## 12. Migration plan

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — implemented
M4 Policy Reduction                 — implemented
M5 Verification v0.2                — next
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M5 changes evidence authority/provenance and freshness, not the persisted verification schema or reducer event vocabulary.