# Pindie Architecture v0.2

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Pi remains the low-level agent harness. Pindie adds a minimal semantic operating layer that keeps current work durable, verifiable, and aligned with user authority.

The v0.2 architectural boundary is:

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie → truth, legality, capability, lifecycle, evidence freshness
Pi     → LLM execution, tools, sessions, low-level agent loop
```

Pindie should eliminate meaningless choices, not meaningful choices.

If a conclusion follows uniquely from authoritative facts, Pindie should close that branch deterministically. If a decision genuinely requires interpreting user intent or project meaning, the model should choose within the legal semantic space. Consequential human judgment remains human-owned.

## 2. Non-goals

Pindie v0.2 does not add:

- a second agent loop
- a workflow engine or persisted phase machine
- a task queue
- a planner framework
- a memory database
- a second Skill runtime
- a universal shell parser
- a second source of project truth

Observe / Understand / Decide / Act / Verify / Update State remain useful semantic descriptions of work, not persisted controller states.

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

The center of v0.2 is not a new controller. It is a small set of pure semantic derivations:

```text
PindieState + RunFacts
        ↓
deriveSemanticSnapshot()
        ↓
deriveCapabilities()
```

These derivations do not call the model, execute tools, persist data, or create another state machine.

## 4. Persistent State

The existing minimal State model remains the durable semantic source of current work:

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

Task status remains derived:

```text
no task                → idle
completed              → done
human gate open        → waiting_human
blockers present       → blocked
otherwise              → active
```

Verification status remains derived from current verification facts.

Capabilities, active tools, Run authority, presentation, reasoning state, tool visibility, continuation fuses, Git fingerprints, and workflow phases are never persisted in `PindieState`.

Reality remains authoritative for reconstructable facts such as files, Git state, package versions, tool output, and current environment state.

## 5. Reducer and Runtime

The existing reducer remains the authority for hard State invariants. It accepts semantic `PindieEvent`s and rejects transitions that would create invalid State.

The reducer must remain independent of Pi tool names and Agent UI concerns.

The existing Runtime remains responsible for:

- project-scoped State loading and persistence
- authoritative disk refresh
- short project-scoped locking
- external-State conflict detection
- reducer dispatch
- atomic save-before-publish behavior

Capability architecture does not replace reducer validation or Runtime concurrency checks. Capability projection shapes the normal Agent action space; Runtime and reducer remain execution-time/data-integrity backstops.

A useful relationship is:

```text
Agent-run capabilities ⊆ State-machine legal transitions
```

Run-boundary authority may make a transition unavailable even when the reducer would accept that transition from State alone.

## 6. Run Facts

Some semantic authority depends on what happened during the current user-driven Agent Run. These facts are runtime-only and must not enter persistent State.

The v0.2 semantic layer models facts such as:

```text
State available or unavailable
Run coherent or stale
current Task existed before the Run, changed during it, or was introduced during it
completed Task existed before the Run or completed during it
Human Gate existed before the Run or opened during it
```

Run Facts describe events and relationships, not policy conclusions such as `canReplaceTask` or `gateResolvable`.

The existing run-start Task/Gate/completion identities and external-State epoch are implementation inputs that can later be adapted into these semantic facts.

## 7. Semantic Snapshot

`SemanticSnapshot` is a pure derived view of `PindieState + RunFacts`.

It contains derived semantics such as:

- semantic authority: unavailable / stale / coherent
- Task status
- verification status
- Task/Run relationship
- completion/Run relationship
- Gate/Run relationship
- blocker/question presence
- completion readiness

It does not duplicate Task content such as goal, constraints, criteria, evidence text, or Gate question.

`completionReady` is derived from current facts:

```text
unfinished Task
AND verification passed
AND no blockers
AND no unresolved questions
AND no Human Gate
```

## 8. Capability Model

Capabilities express the currently legal meaningful action space. They are semantic concepts, not Pi tool names.

Initial v0.2 vocabulary:

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

Capabilities are derived only from `SemanticSnapshot` and are never persisted.

Examples:

```text
idle
→ observe.project, observe.git, task.start

done + completed before current Run
→ observe.project, observe.git, task.start

done + completed during current Run
→ observation only

active
→ observe + mutate + refine + progress + verify + gate.open
  plus replace when the untouched Task pre-existed the Run
  plus complete when completionReady

waiting_human + Gate opened during current Run
→ observation only

waiting_human + Gate existed before current Run
→ observe + gate.resolve + legal Task-boundary operations
```

A Task-level blocker means the current Task has no safe effective consequential progress available until external reality changes. Target v0.2 therefore removes `project.mutate` while blocked. Questions may remain unresolved while useful work continues, but they prevent completion.

## 9. Knowledge Surface

The model-facing Runtime Context should describe the current semantic world, not duplicate lifecycle rules.

It may include:

- Task status
- verification status
- goal
- constraints
- success criteria
- blockers
- questions
- next intent
- current verification records
- Human Gate

It should not need to teach deterministic rules such as “done tasks cannot refine” or “pending verification cannot complete” once those rules are represented by capabilities.

Core Policy should remain small and stable: respect latest user intent and reality, work toward the Task Contract, choose the smallest safe useful action, avoid silent scope expansion, ground completion in evidence, and defer consequential human judgment.

## 10. Tool Surface and Tool Effects

Model-visible tools are an affordance layer over semantic capabilities.

Tool names must not define Pindie semantics. Instead, tools are classified by semantic effect, for example:

```text
read / grep / find / ls   → observe.project
pindie_git_observe        → observe.git
edit / write              → project.mutate
bash / unknown tool       → consequential/unknown effect requiring project.mutate
Pindie semantic tool      → its explicit semantic capability
```

Unknown tools remain fail-safe/consequential until explicitly classified otherwise.

The target model-facing API should not expose one broad `pindie_state` enum whose actions have incompatible lifecycles. Internal reducer events may remain unchanged, while model-facing affordances become narrow tools such as Task start/refine/replace/progress, verification, Gate open/resolve, and completion.

Tool visibility and execution authorization must be two projections of the same capability model.

## 11. Execution Gateway

Dynamic tool visibility improves the normal Agent action space but cannot replace execution-time authorization. State may change after a tool call is generated, and one model output may contain multiple calls whose legality changes after an earlier call executes.

Every consequential execution therefore remains subject to fresh authority checks:

```text
tool call
  ↓
refresh authoritative facts
  ↓
derive fresh Snapshot
  ↓
derive Capabilities
  ↓
classify required effect/capability
  ↓
allow or block
```

The Gateway handles runtime legality. The reducer handles State integrity.

A normal unchanged world should satisfy:

```text
model-visible(T) ⇔ semantically legal(T)
```

Guard rejection should mainly represent races, stale calls, integration bugs, or other exceptional conditions rather than ordinary Agent navigation.

## 12. Human Gate

A Human Gate is an explicit authority boundary.

When a Gate opens, consequential model authority stops and control returns to the human. A Gate opened during the current Run is not resolvable in that same Run. If the Gate already existed when a new user-driven Run begins, the model may interpret the new user input and choose among currently legal actions such as resolve, refine, or replace.

Human Gate State remains durable because it must survive session boundaries. Gate lifecycle capability is runtime-derived.

## 13. Verification

State invariants and completion coverage remain mandatory.

The v0.2 target further separates two kinds of ownership:

```text
Harness → factual evidence from observed tool/runtime reality
Model   → semantic judgment about which success criteria that evidence covers
```

Raw logs and full execution history remain reconstructable reality and should not be copied into State. Durable verification should keep the minimum semantic proof needed for the Task.

Verification evidence ownership is a later migration milestone; the Semantic Foundation and capability layers must not prematurely redesign the current persisted verification schema.

## 14. Continuation

Automatic continuation remains subordinate to latest user intent.

Harness-owned deterministic eligibility includes facts such as unfinished Task, no Gate, no blocker, coherent State, normal stop, no pending Pi message, and continuation fuse availability.

The remaining question — whether the latest user intent still authorizes consequential execution of the current Task — is semantic and remains model-owned.

The v0.2 target replaces the current large hidden continuation policy with deterministic eligibility plus a thin semantic intent probe. Pindie still uses Pi's own follow-up/continuation machinery and never creates another Agent Loop.

## 15. Observation, mutation freshness, activity, reasoning, and Skills

Project Mutation Freshness remains a good architectural pattern: observe Reality before/after ambiguous consequential tools and invalidate verification from observed change rather than model self-report. Its implementation may move closer to the execution/effect layer without changing its core mechanism.

Current Activity remains runtime-only presentation derived from Pi lifecycle/tool execution and is a reference pattern for deterministic observation-driven behavior.

Adaptive reasoning remains runtime-only and is not part of semantic correctness. It should stay independent during the v0.2 core migration and be optimized later.

Pi continues to own Skill discovery and Skill runtime. Pindie Skills are optional procedures. As capability enforcement improves, bundled Skills should stop repeating Core legality rules and become procedure-focused.

## 16. Architectural invariants

v0.2 preserves these design invariants:

1. **Reality determines reconstructable facts.**
2. **State stores minimal durable semantic facts.**
3. **Run Facts store no durable data.**
4. **Semantic Snapshot is derived, never persisted.**
5. **Capabilities are derived, never persisted.**
6. **Knowledge Surface and Capability Surface describe the same semantic world.**
7. **Tool visibility and Gateway legality derive from the same capabilities.**
8. **Reducer knows semantic events, not Pi tools.**
9. **Harness closes deterministic branches; the model retains genuine semantic choices.**
10. **Human authority is explicit for consequential judgment.**
11. **Pi remains the only low-level agent loop and Skill runtime.**

## 17. Migration plan

The repository is migrating incrementally from the implemented v0.1 runtime to this v0.2 target. Target docs are authoritative even while implementation temporarily lags them.

```text
M0 Semantic Foundation
M1 Capability Gateway
M2 Model Tool Surface
M3 Policy Reduction
M4 Gate & Blocked Alignment
M5 Completion Alignment
M6 Verification v0.2
M7 Continuation Simplification
M8 Skill / Docs Prune
M9 Extension Composition
```

### M0 boundary

M0 adds only pure semantic derivation and focused tests. It must not change current runtime behavior, tools, guards, State schema, reducer, persistence, Core Policy, or extension lifecycle.

This deliberate migration seam allows the target semantic truth to be tested independently before any existing consumer begins using it.

Until a later milestone explicitly consumes v0.2 semantics, existing v0.1 source and integration tests remain the runtime regression baseline. They are not the target architectural authority.