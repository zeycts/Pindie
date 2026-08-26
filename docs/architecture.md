# Pindie Architecture v0.2

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Pi remains the low-level agent harness. Pindie adds a minimal semantic operating layer that keeps current work durable, verifiable, and aligned with user authority.

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie → truth, legality, capability, lifecycle, evidence freshness
Pi     → LLM execution, tools, sessions, low-level agent loop
```

Pindie should eliminate meaningless choices, not meaningful choices. If a conclusion follows uniquely from authoritative facts, Pindie closes that branch deterministically. If a decision genuinely requires interpreting user intent or project meaning, the model chooses within the legal semantic space.

## 2. Non-goals

Pindie v0.2 does not add a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, second Skill runtime, universal shell parser, or second source of project truth.

Observe / Understand / Decide / Act / Verify / Update State remain useful descriptions of work, not controller states.

## 3. Target architecture

```text
                         Reality
                            │
                            ▼
                 Persistent State
                    + Run Facts
                            │
                            ▼
                 Semantic Snapshot
                            │
                            ▼
                    Capabilities
                 ┌──────────┼──────────┐
                 ▼          ▼          ▼
             Knowledge   Tool      Authorization
              Surface   Surface       Policy
                 │          │          │
                 └──────────┴────┬─────┘
                                 ▼
                                LLM
                                 │
                           semantic choice
                                 │
                                 ▼
                       Execution Gateway
                                 │
                              Reducer
                                 │
                                 ▼
                                Pi
                                 │
                                 ▼
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

M1 adds the concrete execution projection:

```text
Tool Call
   ↓
classifyToolEffect()
   ↓
required capability + mutation effect

Capabilities + Tool Effect
   ↓
authorizeToolEffect()
```

These layers do not call the model, persist capabilities, or create another state machine.

## 4. Persistent State, reducer, and Runtime

`PindieState` remains the minimal durable current-work model:

```text
PindieState
└── task | null
    ├── goal
    ├── constraints
    ├── successCriteria
    ├── openLoops
    │   ├── blockers
    │   ├── questions
    │   └── nextIntent
    ├── verification
    ├── humanGate
    └── completed
```

Task and verification statuses remain derived. Capabilities, active tools, Run authority, presentation, reasoning state, tool visibility, continuation fuses, Git fingerprints, and workflow phases are never persisted in `PindieState`.

The reducer remains the authority for hard State invariants and accepts semantic `PindieEvent`s rather than Pi tool names. Runtime remains responsible for project-scoped loading/persistence, authoritative refresh, short locking, external-State conflict detection, reducer dispatch, and save-before-publish behavior.

Capability architecture does not replace reducer or Runtime integrity checks. A useful relationship is:

```text
Agent-run capabilities ⊆ State-machine legal transitions
```

Run-boundary authority can make a reducer-valid transition unavailable to the current Agent Run.

## 5. Run Facts

Some legality depends on what happened during the current user-driven Agent Run. These facts are runtime-only and never enter persistent State.

The semantic layer uses:

```text
TaskRunRelation
- none
- preexisting_untouched
- preexisting_changed
- introduced_during_run

CompletionRunRelation
- not_completed
- completed_before_run
- completed_during_run

GateRunRelation
- none
- existed_before_run
- opened_during_run
```

Run Facts describe history/relationships, not policy conclusions such as `canReplaceTask` or `gateResolvable`.

### M2 runtime derivation

M2 uses a minimal Agent Run context rather than a second runtime state machine. Conceptually it keeps:

```text
run-start Task reference
run-start Human Gate reference
run-start external-State epoch
whether the current Task was introduced by successful task.start/task.replace during this Run
```

Run-start object identity is permitted only as a coherent-run immutable-State change detector. It is not persistent Task identity and does not justify adding a Task ID to `PindieState`.

This is valid because Runtime preserves object identity when a refresh finds deep-equal State and publishes new immutable State/Task objects only when State actually changes. Once the external-State epoch changes, the Run becomes stale and old identity is no longer used for authority.

For a coherent Run, Task relation is derived as:

```text
no current Task
→ none

current Task introduced by successful start/replace during this Run
→ introduced_during_run

current Task is exactly the run-start Task object
→ preexisting_untouched

otherwise
→ preexisting_changed
```

Completion relation is derived as:

```text
no Task or unfinished Task
→ not_completed

current completed Task was already completed at Run start and is still that Task
→ completed_before_run

otherwise completed
→ completed_during_run
```

Gate relation is derived as:

```text
no current Gate
→ none

current Gate is the Gate that existed at Run start
→ existed_before_run

otherwise
→ opened_during_run
```

This lets a resolved old Gate followed by a newly opened, textually identical Gate still count as `opened_during_run`.

The only explicit origin history required is whether a successful `task.start` or `task.replace` introduced the current Task during the Run. That fact must be recorded only after successful execution/result, never at authorization time.

## 6. Semantic Snapshot and capabilities

`SemanticSnapshot` is a pure derived view of valid `PindieState + SemanticRunFacts`. It contains authority (`unavailable | stale | coherent`), Task/verification status, Run relations, blocker/question presence, and completion readiness without duplicating Task content.

`completionReady` means:

```text
unfinished Task
AND verification passed
AND no blockers
AND no unresolved questions
AND no Human Gate
```

Initial capabilities remain:

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

Capabilities are derived only from the Snapshot and never persisted.

A Task-level blocker means no safe effective consequential project progress is currently available until external reality changes, so target v0.2 removes `project.mutate` while blocked. Questions can coexist with useful work but prevent completion.

## 7. Knowledge Surface

Runtime Context should describe the semantic world: Task status, verification status, Task Contract, open loops, current verification records, and Human Gate. It should not need to repeat deterministic lifecycle rules once capability and Tool Surface migration are complete.

Core Policy remains small and stable: respect latest user intent and reality, work toward the Task Contract, choose the smallest safe useful action, avoid silent scope expansion, ground completion in evidence, and defer consequential human judgment.

## 8. Tool Effects

Tool names do not define Pindie semantics. The Tool Effect Model translates a concrete call into required semantic authority plus project mutation effect:

```text
read / grep / find / ls   → observe.project; mutation none
pindie_git_observe        → observe.git; mutation none
edit / write              → project.mutate; mutation known
bash / unknown tool       → project.mutate; mutation ambiguous
Pindie semantic action    → its explicit semantic capability; mutation none
```

Unknown tools remain fail-safe/consequential until explicitly classified otherwise. Generic shell input is not parsed to manufacture read-only exceptions.

Tool visibility and execution authorization ultimately project from the same capability model.

## 9. M2 Execution Gateway lifecycle

M2 is the first live semantic cutover. Known observation capabilities remain a fast path because M0 grants `observe.project` and `observe.git` under coherent, stale, and unavailable authority.

For every non-observation call, the live order is:

```text
classify Tool Effect
  ↓
known run epoch mismatch?
  ├─ yes → stale authority
  └─ no
       ↓
refresh authoritative project State
       ↓
refresh detected external change?
  ├─ yes → stale authority
  └─ no
       ↓
derive current SemanticRunFacts
       ↓
derive SemanticSnapshot
       ↓
derive Capabilities
       ↓
authorize required capability
       ├─ denied → structured/factual Gateway rejection
       └─ allowed
            ↓
       establish mutation observation if effect requires it
            ↓
          execute
```

If refresh fails, State authority becomes unavailable and only observation remains legal.

Authorization is deliberately thin: after classification, semantic allow/deny is capability membership. Task status, blocker, Gate, verification, completion, and Task-boundary rules remain in semantic derivation rather than being repeated in Gateway code.

M2 intentionally makes the complete target capability model live. It does not preserve conflicting v0.1 semantics through compatibility capabilities.

Gateway rejection messages should report facts such as stale/unavailable authority and the missing capability. They should not teach a second lifecycle policy or prescribe a replacement sequence of tool calls.

## 10. Mutation Freshness shares Tool Effect classification

Project Mutation Freshness remains observation-driven, but M2 removes its independent tool-name taxonomy.

After successful authorization:

```text
projectMutation = ambiguous
→ establish before/after project fingerprint observation

projectMutation = known
→ successful known mutation invalidates prior verification

projectMutation = none
→ no project mutation observation
```

A blocked ambiguous call must never create a mutation window. Ambiguous tools still compare Reality after execution even if the tool reports an error, because partial mutation may have occurred.

`tool_result` may reclassify the concrete call through the same M1 Tool Effect model. Successful `task.start`/`task.replace` results also update the minimal Run origin history. Other semantic changes need no event log: immutable Runtime State identity reflects real State changes.

## 11. Human Gate

A Human Gate is an explicit authority boundary. A Gate opened during the current Run yields observation-only semantic authority until new human input starts a later Run. A Gate that already existed before the new Run may expose `gate.resolve` and legal Task-boundary operations. The model interprets the latest human input among those legal choices.

## 12. Verification

State invariants and completion coverage remain mandatory. M2 changes authorization timing, not the persisted verification schema. `task.complete` is live-authorized only when `completionReady` produces the capability; reducer checks remain as backstop.

Verification v0.2 later separates Harness-owned factual execution evidence from model-owned semantic criterion-coverage judgment.

## 13. Continuation, Activity, Reasoning, Skills

Automatic continuation remains subordinate to latest user intent. M2 may reuse the unified Run coherence fact where appropriate, but it does not redesign continuation.

Current Activity, Run Timer, Run Cost, status presentation, and adaptive reasoning remain runtime-only systems. Pi continues to own Skill discovery/runtime. These systems should not become semantic correctness sources.

## 14. Architectural invariants

1. Reality determines reconstructable facts.
2. State stores minimal durable semantic facts.
3. Run Facts are runtime-only and minimal.
4. Semantic Snapshot is derived, never persisted.
5. Capabilities are derived, never persisted.
6. Knowledge Surface and Capability Surface describe the same semantic world.
7. Tool visibility and Gateway legality ultimately derive from the same capabilities.
8. Tool Effect classification is shared execution semantics, not a second policy system.
9. Reducer knows semantic events, not Pi tools.
10. Harness closes deterministic branches; the model retains genuine semantic choices.
11. Human authority is explicit for consequential judgment.
12. Pi remains the only low-level agent loop and Skill runtime.
13. Run-local object identity is a change detector only, never durable semantic identity.
14. A blocked call produces no mutation-observation side effects.

## 15. Migration plan

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — next
M3 Model Tool Surface
M4 Policy Reduction
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

### M2 boundary

M2 may add a small pure/runtime-only Run Facts adapter/context and modify the live extension integration/tests. It may remove semantic Guard branches superseded by M0/M1 and make mutation freshness consume M1 classification.

M2 must preserve reducer validation, Runtime persistence/locking/conflict behavior, authoritative refresh, model-facing tool schema validation, current Tool Surface, Core Policy, persisted verification schema, Skill/runtime ownership, and unrelated presentation/reasoning behavior.

M2 intentionally changes live semantics where v0.1 conflicts with the approved capability truth:

```text
blocked Task + project mutation      → denied
incomplete verification + complete   → denied at Gateway
same-Run-opened Gate consequential action → denied
completed-during-Run + task.start    → denied until new user Run
stale/unavailable + consequence      → denied
```

M3 then aligns model-visible affordances with the already-live legality model. M4 removes redundant policy text after visibility and legality are aligned.