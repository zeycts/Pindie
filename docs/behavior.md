# Pindie v0.2 — Behavior Specification

This document defines the approved v0.2 semantic and behavioral contract. The repository is migrating incrementally from the implemented v0.1 runtime. During that migration, target semantics in this document are authoritative, while existing source and integration tests remain the regression baseline until a milestone explicitly changes them.

## 1. Hard persistent-State invariants

These remain reducer/State responsibilities.

### I1 — One current Task

`state.task` is either `null` or one `PindieTask`. Pindie has no task queue.

### I2 — Completed Task is terminal

A completed Task has no Human Gate, blockers, unresolved questions, or next intent, and current verification is passed. Ordinary semantic transitions cannot mutate a completed Task.

### I3 — Stale verification has no current checks

If `verification.stale === true`, `verification.checks` is empty.

### I4 — Verification references valid criteria

Every verification coverage ID references a current success criterion.

### I5 — Criterion IDs are unique

Success criterion IDs are unique within the current Task.

### I6 — Verification check names are unique

The current verification set contains at most one check for a given name.

### I7 — One Human Gate

At most one Human Gate is open.

### I8 — Done requires current passed verification

`task.completed === true` implies derived verification status is `passed`.

### I9 — Task Contract requires success criteria

Every Task contains at least one success criterion.

Persistent-State validation must not duplicate runtime-only capability or Run-boundary rules.

## 2. Ownership rules

Pindie behavior follows four ownership domains:

```text
Reality → reconstructable facts
Harness → deterministic truth, legality, lifecycle, freshness
Model   → intent interpretation, planning, semantic choice, coverage judgment
Human   → goals, taste, consequential judgment, approval
```

Two governing principles follow:

- **Deterministic closure:** if authoritative facts uniquely determine whether an action is meaningful/legal, the Harness closes that branch.
- **Semantic freedom:** choices that genuinely require interpretation remain model-owned within the legal capability space.

Pindie must not convert semantic ambiguity into a new persisted workflow phase or controller state.

## 3. Derived persistent statuses

### Task status

```text
state.task === null                → idle
task.completed                     → done
task.humanGate !== null            → waiting_human
task.openLoops.blockers.length > 0 → blocked
otherwise                          → active
```

### Verification status

```text
verification.stale                       → stale
checks.length === 0                      → pending
any current check failed                 → failed
all success criteria covered by passes   → passed
otherwise                                → pending
```

These statuses remain derived and are not persisted separately.

## 4. Run Facts

Some Agent-run legality depends on runtime-only history. v0.2 models those facts separately from persistent State.

The Semantic Foundation uses these relations:

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

Run Facts describe what happened. They must not encode policy conclusions such as `canReplaceTask`, `canStartTask`, or `gateResolvable`.

Run Facts are runtime-only and never enter `PindieState` or project persistence.

## 5. Semantic Snapshot

`SemanticSnapshot` is a pure derived view of valid `PindieState + RunFacts`.

It contains at least:

```text
authority: unavailable | stale | coherent
Task status
verification status | none when no Task
Task/Run relation
completion/Run relation
Gate/Run relation
hasBlockers
hasQuestions
completionReady
```

It must not duplicate goal, constraints, success criteria, verification evidence text, or Human Gate question.

### Completion readiness

```text
completionReady =
  current Task exists
  AND Task is unfinished
  AND verification is passed
  AND no blockers
  AND no unresolved questions
  AND no Human Gate
```

`completionReady` is the only normal semantic source of `task.complete` capability.

## 6. Semantic input consistency

Before deriving a Snapshot:

1. available State must pass existing `validateState()`;
2. State and Run Facts must describe a possible relationship;
3. impossible combinations fail closed rather than being guessed or normalized silently.

Examples of impossible relationships:

- State unavailable while a State object is supplied as authoritative;
- available State with no State object;
- no Task with any non-`none` Task/Gate relation;
- unfinished Task with `completed_before_run` or `completed_during_run`;
- completed Task with `not_completed`;
- no Human Gate with a non-`none` Gate relation;
- Human Gate present with `gateRelation === none`.

Semantic validation must not reimplement reducer/State invariants already enforced by `validateState()`.

## 7. Capability vocabulary

Initial v0.2 capabilities are:

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

Capabilities are semantic, not Pi tool names, and are never persisted.

## 8. Authority dominance

If semantic authority is `unavailable` or `stale`, capabilities are exactly:

```text
observe.project
observe.git
```

No mutation, Task transition, verification action, or Gate action is available.

This rule dominates all other capability rules.

## 9. Capability matrix

For coherent authority:

### Idle

```text
observe.project
observe.git
task.start
```

### Done — Task completed before current user-driven Run

```text
observe.project
observe.git
task.start
```

### Done — Task completed during current Run

```text
observe.project
observe.git
```

A new Task requires a new user-driven authority boundary.

### Active

Base capabilities:

```text
observe.project
observe.git
project.mutate
task.refine
task.progress
verification.record
gate.open
```

Add `task.replace` only when:

```text
taskRelation === preexisting_untouched
```

Add `task.complete` only when:

```text
completionReady === true
```

### Blocked

A Task-level blocker means no safe effective consequential project progress is currently available until external reality changes.

Base target capabilities:

```text
observe.project
observe.git
task.refine
task.progress
verification.record
gate.open
```

Add `task.replace` only for `preexisting_untouched`.

Do not expose:

```text
project.mutate
task.complete
```

This is a v0.2 target semantic. Existing v0.1 runtime mutation behavior remains unchanged until the approved Gate & Blocked Alignment milestone consumes this capability model.

### Waiting Human — Gate opened during current Run

```text
observe.project
observe.git
```

The model has transferred consequential authority to the human and cannot resolve the Gate in the same Run.

### Waiting Human — Gate existed before current Run

```text
observe.project
observe.git
task.refine
gate.resolve
```

Add `task.replace` only for `preexisting_untouched`.

The model interprets the latest human input and chooses among these legal semantic actions.

## 10. Task boundaries

The Harness determines which Task-boundary operations are legal. The model determines which legal operation matches latest user intent.

Examples:

```text
same current Task, no material Contract change → continue
same Task, Contract changed                 → refine
clearly different requested Task            → replace when capability exists
no current unfinished Task                  → start when capability exists
```

Pindie must not build a deterministic intent classifier that decides refine vs replace from syntax alone.

A Task introduced during the current Run is not replaceable in that Run. A pre-existing Task that has already been semantically changed during the Run is not replaceable in that Run.

## 11. Human Gate

Human Gate State is durable; Gate authority is runtime-derived.

- `gate.open` is available only when current semantics permit opening a consequential human decision boundary.
- Opening a Gate transfers consequential authority to the human and terminates the current execution path.
- A Gate opened during the current Run is not resolvable during that Run.
- A Gate that existed before a new user-driven Run may expose `gate.resolve`.
- A new human response may semantically imply resolve, refine, or replace; the model chooses among capabilities available in that Run.

The Harness must not let the model manufacture its own human approval by open→resolve within one Run.

## 12. Verification

Until Verification v0.2 is implemented, the current persisted verification schema remains the runtime baseline.

The target ownership is:

```text
Harness → factual execution/observation evidence
Model   → semantic judgment about criterion coverage
```

Full tool logs, raw stdout/stderr history, and reconstructable execution history are not persistent Pindie State.

Completion remains impossible unless current verification fully covers all success criteria with passing evidence and all completion blockers are cleared.

## 13. Project mutation and freshness

Known project mutation invalidates prior verification.

Ambiguous consequential tools continue to rely on observed project reality rather than model self-report. Project Mutation Freshness remains runtime-only and may compare Git-visible worktree reality before/after execution.

Generic `bash` is never made read-only through command-text parsing. Unknown tools fail safe until explicitly classified by the Tool Effect Model.

## 14. Tool Surface and Gateway consistency

v0.2 introduces two projections from the same capability model:

```text
Capabilities → model-visible Tool Surface
Capabilities → execution authorization
```

For an unchanged coherent world, a Pindie-owned semantic action should satisfy:

```text
visible(action) ⇔ semantically legal(action)
```

A normal semantic mismatch that repeatedly produces “visible tool → Guard rejection” is an architecture defect, not a desirable navigation mechanism.

Execution-time authorization remains necessary for stale pre-generated calls, tool batching, races, external State change, integration bugs, and unknown/custom effects.

The reducer remains the final State-integrity authority after authorization.

## 15. Knowledge / Capability coherence

Runtime Context and capabilities must describe the same world.

Examples:

- `Task status: done` must not coexist with model-visible refine/replace of that completed Task.
- `Verification: pending` must not coexist with `task.complete` capability.
- a Gate opened during the current Run must not coexist with `gate.resolve`.
- unavailable or stale semantic authority exposes observation only.

Knowledge Surface should describe facts. Deterministic legality should live in capability projection rather than repeated natural-language warnings.

## 16. Continuation

Automatic continuation has two layers.

Harness-owned deterministic eligibility checks facts such as:

- current unfinished Task;
- coherent available State;
- no Human Gate;
- no blocker;
- normal model stop;
- no pending Pi message;
- continuation fuse unused.

The model-owned semantic question is only whether latest actual user intent still authorizes consequential execution of the current Task.

The target continuation probe should be thin and must not re-teach the entire Core Policy, Task-boundary system, Gate lifecycle, or verification rules.

Pi remains responsible for actual follow-up execution and the low-level Agent Loop.

## 17. Skills, Activity, Reasoning, Status

- Pi owns Skill discovery and Skill runtime.
- Skills are procedures and cannot override Core semantic legality.
- Current Activity is runtime-only observation derived from actual Pi/tool lifecycle.
- Run Timer and Run Cost are runtime-only presentation.
- Adaptive reasoning is runtime-only optimization and does not determine semantic correctness.
- Status is a projection of authoritative State/runtime facts and stores no independent semantic truth.

These systems are not part of M0 semantic migration unless an approved later milestone explicitly changes them.

## 18. M0 — Semantic Foundation contract

M0 creates the target semantic model without changing current runtime behavior.

Allowed production scope:

```text
CREATE src/semantics.ts
CREATE tests/semantics.test.ts
```

M0 must not modify:

```text
PindieState schema
Reducer/transitions
Runtime persistence/concurrency
existing model-facing tools
Core Policy / Runtime Context
current tool_call guards
Pi lifecycle wiring
Skills
reasoning/activity/status systems
existing runtime behavior
```

`src/semantics.ts` should depend on State semantics only. It must not import Pi Extension APIs, `extension.ts`, tool events, reasoning controllers, or runtime UI code.

M0 tests construct Run Facts directly and verify pure derivation. No production caller is required in M0; the unused semantic layer is an intentional migration seam.

Required M0 test coverage includes:

- unavailable authority → observation only;
- stale authority → observation only;
- idle → start + observation;
- done before Run → start + observation;
- done during Run → observation only;
- active pre-existing untouched Task → replace available;
- active introduced/changed Task → replace unavailable;
- pending verification → complete unavailable;
- completionReady → complete available;
- blocker/question/Gate effects on completion;
- blocked target capabilities;
- Gate existed-before-Run vs opened-during-Run;
- impossible State/RunFacts relationships fail closed;
- exact capability-set comparison, so accidental extra capabilities fail tests.

Run `pnpm run check` after implementation. Existing tests must remain green.

## 19. Migration compatibility

The target v0.2 semantic model may intentionally disagree with current v0.1 Tool visibility or Guard navigation before later milestones consume it. That is expected.

Do not “fix” M0 semantics to mirror legacy visibility merely because current `pindie_state`, `pindie_gate`, or Guard code still exposes actions that v0.2 considers semantically unavailable.

Conversely, do not change those runtime consumers early. Each migration milestone should move one responsibility onto the new semantic source while preserving unrelated behavior.