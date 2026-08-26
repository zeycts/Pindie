# Pindie v0.2 — Behavior Specification

This document defines the approved v0.2 semantic and behavioral contract. Target semantics here are authoritative; existing source/tests are the runtime baseline until a milestone explicitly cuts that responsibility over.

## 1. Persistent-State invariants

These remain reducer/State responsibilities:

1. `state.task` is `null` or one current Task; there is no task queue.
2. Completed Task is terminal for ordinary semantic transitions.
3. Stale verification has no current checks.
4. Verification coverage references current criterion IDs only.
5. Criterion IDs are unique within a Task.
6. Verification check names are unique within current verification.
7. At most one Human Gate is open.
8. Completed Task implies current verification status `passed`.
9. Every Task has at least one success criterion.

Persistent-State validation must not duplicate runtime-only capability or Run-boundary rules.

## 2. Ownership rules

```text
Reality → reconstructable facts
Harness → deterministic truth, legality, lifecycle, freshness
Model   → intent interpretation, planning, semantic choice, coverage judgment
Human   → goals, taste, consequential judgment, approval
```

- **Deterministic closure:** if authoritative facts uniquely determine legality, Harness closes the branch.
- **Semantic freedom:** choices requiring interpretation remain model-owned within the legal capability space.

Pindie must not convert semantic ambiguity into a persisted workflow phase/controller state.

## 3. Derived statuses

Task status:

```text
no task                → idle
completed              → done
human gate open        → waiting_human
blockers present       → blocked
otherwise              → active
```

Verification status:

```text
verification.stale                     → stale
checks.length === 0                    → pending
any current check failed               → failed
all criteria covered by passing checks → passed
otherwise                              → pending
```

These statuses are derived, never persisted separately.

## 4. Semantic Run Facts

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

Run Facts describe what happened, not conclusions such as `canReplaceTask` or `gateResolvable`. They are runtime-only.

### M2 Run context

M2 may retain only the minimum history that cannot be reconstructed from current State:

```text
Task reference at Run start
Gate reference at Run start
external-State epoch at Run start
whether successful task.start/task.replace introduced the current Task during this Run
```

Run-start references are coherent-run immutable-State change detectors only. They are not durable semantic identity and must not cause a Task ID to be added to persistent State.

### Task relation derivation

For a coherent Run:

```text
current task == null
→ none

task was introduced by successful start/replace during this Run
→ introduced_during_run

current task is the run-start Task object
→ preexisting_untouched

otherwise
→ preexisting_changed
```

A no-op reducer transition that returns the same State/Task object does not turn an untouched Task into changed. A real immutable State change does.

### Completion relation derivation

```text
no Task or unfinished Task
→ not_completed

Task was already completed at Run start and current completed Task is that Task
→ completed_before_run

otherwise current Task completed
→ completed_during_run
```

### Gate relation derivation

```text
no current Gate
→ none

current Gate is the run-start Gate
→ existed_before_run

otherwise
→ opened_during_run
```

A resolved old Gate followed by a new, textually identical Gate is still `opened_during_run`.

### Authority/coherence

- no authoritative State → unavailable;
- State exists but no valid current Run context or external epoch changed → stale;
- otherwise → coherent.

If authoritative refresh discovers external State change during a Run, the Runtime adopts that State and the Run becomes stale.

## 5. Semantic Snapshot

`SemanticSnapshot` is derived from valid `PindieState + SemanticRunFacts`. It contains authority, Task/verification status, Run relations, blocker/question presence, and completion readiness without copying Task content.

```text
completionReady =
  unfinished Task
  AND verification passed
  AND no blockers
  AND no unresolved questions
  AND no Human Gate
```

Impossible State/RunFacts combinations fail closed rather than being guessed or normalized.

## 6. Capability vocabulary

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

## 7. Authority dominance

If authority is `unavailable` or `stale`, capabilities are exactly:

```text
observe.project
observe.git
```

This dominates all other rules.

## 8. Coherent capability matrix

### Idle

```text
observe.project
observe.git
task.start
```

### Done — completed before current Run

```text
observe.project
observe.git
task.start
```

### Done — completed during current Run

```text
observe.project
observe.git
```

### Active

Base:

```text
observe.project
observe.git
project.mutate
task.refine
task.progress
verification.record
gate.open
```

Add `task.replace` only for `preexisting_untouched`.

Add `task.complete` only when `completionReady === true`.

### Blocked

A Task-level blocker means no safe effective consequential project progress is currently available until external reality changes.

Base:

```text
observe.project
observe.git
task.refine
task.progress
verification.record
gate.open
```

Add `task.replace` only for `preexisting_untouched`.

Do not expose `project.mutate` or `task.complete`.

### Waiting Human — Gate opened during current Run

```text
observe.project
observe.git
```

### Waiting Human — Gate existed before current Run

```text
observe.project
observe.git
task.refine
gate.resolve
```

Add `task.replace` only for `preexisting_untouched`.

The model chooses among legal Task-boundary/Gate actions according to latest human input; Harness does not syntax-classify refine vs replace.

## 9. Tool Effect Model

M1 defines the shared concrete execution classification:

```text
read / grep / find / ls
→ observe.project / mutation none

pindie_git_observe
→ observe.git / mutation none

edit / write
→ project.mutate / mutation known

bash / unknown/custom
→ project.mutate / mutation ambiguous

pindie_state(start_task)          → task.start / none
pindie_state(replace_task)        → task.replace / none
pindie_state(refine_task)         → task.refine / none
pindie_state(set_open_loops)      → task.progress / none
pindie_state(record_verification) → verification.record / none
pindie_state(complete_task)       → task.complete / none
pindie_gate(open)                 → gate.open / none
pindie_gate(resolve)              → gate.resolve / none
```

Unknown/custom tools always classify conservatively; they are never silently unclassified or treated as observation. Generic bash command text is not parsed for read-only exceptions.

Known semantic tool with missing/invalid action is malformed semantic input, not an unknown tool.

Authorization is exactly capability membership:

```text
allowed = capabilities.has(effect.requiredCapability)
```

Authorization must not reimplement Task, Gate, blocker, verification, completion, or Run-boundary rules.

## 10. M2 live Gateway behavior

M2 is the first intentional runtime semantic cutover.

### Observation fast path

Known observation effects requiring `observe.project` or `observe.git` remain directly allowed without project-State refresh because M0 grants those capabilities under coherent, stale, and unavailable authority.

This fast path applies only to explicitly classified observation tools; unknown tools remain consequential.

### Non-observation authorization path

For every non-observation call:

```text
1. classify Tool Effect
2. if current external epoch already differs from Run-start epoch, treat Run as stale
3. otherwise refresh authoritative project State
4. if refresh adopts external change, treat Run as stale
5. if refresh fails, mark State unavailable
6. derive current SemanticRunFacts
7. derive SemanticSnapshot
8. derive Capabilities
9. authorize effect.requiredCapability
10. only if allowed, establish mutation observation when required
11. execute
```

Semantic Gateway rejection is grounded in current authority/Snapshot and missing capability. Integration messages may explain facts but must not recreate a second natural-language lifecycle policy.

### Structured malformed calls

M1 classification failures for malformed `pindie_state`/`pindie_gate` calls remain failures; model-facing tool schema/execution validation remains a separate backstop. M2 must not reinterpret malformed semantic action as generic project mutation.

## 11. M2 Run-history updates

Run origin history changes only after successful execution/result.

```text
successful task.start or task.replace
→ mark current Task as introduced during this Run
```

Do not mark introduction during tool authorization because reducer/Runtime execution can still fail.

Other semantic changes need no explicit event log. If they materially change Pindie State, Runtime immutable publication changes the current Task/Gate object and the relation becomes `preexisting_changed` / `opened_during_run` as appropriate.

Internal `invalidate_verification` likewise participates through ordinary immutable State publication; no special semantic-event history is needed.

## 12. Project Mutation Freshness after M2

The M1 Tool Effect classification becomes the shared taxonomy for authorization and mutation freshness.

After authorization:

```text
projectMutation = none
→ no project-mutation observation

projectMutation = known
→ successful known mutation invalidates verification

projectMutation = ambiguous
→ capture/compare project fingerprint before/after execution
```

A denied call must not open/add to a mutation window.

Ambiguous tools are observed after both successful and failed execution because a failed shell/custom tool may have partially mutated project reality.

Known edit/write invalidation behavior remains unchanged in effect; only the taxonomy source is unified.

## 13. Reducer and Runtime backstops

M2 replaces semantic Guard policy, not data-integrity/runtime safety.

Preserve:

- authoritative State refresh;
- external-State adoption/epoch tracking;
- project-scoped locking;
- State conflict handling;
- reducer transition validation;
- atomic persistence/publication;
- model-facing tool parameter/schema validation;
- mutation observation/freshness;
- State unavailable handling.

Reducer completion/Gate/Task checks remain even when Gateway makes the same invalid transition unreachable during normal execution.

## 14. M2 intentional runtime changes

At cutover, these target semantics become live:

```text
idle + project mutation
→ denied

blocked + edit/write/bash/unknown consequential tool
→ denied

pending/stale/failed verification + complete_task
→ denied before reducer execution

completionReady + complete_task
→ allowed

Gate opened during same Run + resolve/refine/mutation/complete
→ denied by capability model

Gate existing before Run + resolve
→ allowed

preexisting untouched active Task + replace
→ allowed

Task introduced during Run + replace
→ denied

preexisting Task semantically changed during Run + replace
→ denied

Task completed before Run + start
→ allowed

Task completed during Run + start
→ denied until a new user-driven Run

stale/unavailable + observation
→ allowed

stale/unavailable + consequential action
→ denied
```

M2 must not add compatibility exceptions to preserve conflicting v0.1 behavior.

## 15. M2 and Tool Surface

M2 does not change model-visible tool availability. The broad legacy `pindie_state` and `pindie_gate` tools remain visible according to current Pi configuration, so M2 may temporarily still have `visibility > legality`.

M3 owns the correction:

```text
model-visible affordance ≈ live semantic legality
```

Do not implement dynamic active tools or split semantic tools in M2.

## 16. Knowledge / policy boundary

M2 does not prune Runtime Context or Core Policy. M4 owns policy reduction after M3 aligns visibility with legality.

Do not use M2 as an opportunity to rewrite tool descriptions, continuation policy, Skills, status presentation, or reasoning heuristics.

## 17. Continuation

Automatic continuation remains subordinate to latest user intent. M2 may reuse the unified Run coherence/epoch source rather than preserve duplicate stale-run bookkeeping, but it must not otherwise redesign continuation behavior.

## 18. M0 / M1 status

### M0 — Semantic Foundation

Implemented: pure State + Run Facts → Snapshot → Capabilities derivation and semantic matrix tests.

### M1 — Execution Semantics Foundation

Implemented: pure Tool Effect classification, conservative unknown-tool classification, structured malformed semantic-action failures, capability-membership authorization, and M0+M1 composition tests.

No live runtime consumer was added in M0/M1.

## 19. M2 implementation/test contract

M2 should add a small focused Run Facts module/context and modify live extension integration. Avoid controllers, managers, event logs, persisted IDs, or workflow state.

Pure Run Facts tests should cover at least:

- no Task;
- preexisting untouched Task;
- preexisting changed Task;
- Task introduced by start;
- Task introduced by replacement;
- completed before Run;
- completed during Run;
- Gate existed before Run;
- Gate opened during Run;
- resolve old Gate then open an identical new Gate;
- external epoch mismatch → stale;
- unavailable State;
- missing current Run context → stale;
- no-op State transition remains untouched;
- real immutable State transition becomes changed.

Integration tests should cover at least:

- idle edit denied; idle start allowed; start then edit same Run allowed;
- done-before-Run start allowed and replace denied;
- active untouched replace allowed; replace then second replace denied; refine then replace denied;
- blocked edit/write/bash denied;
- premature complete denied; completion-ready complete allowed;
- same-Run-opened Gate resolve denied; pre-existing Gate resolve allowed;
- stale/unavailable observation allowed; stale/unavailable mutation denied;
- blocked ambiguous call creates no mutation window;
- allowed ambiguous mutation still observes before/after Reality;
- successful edit/write invalidates verification;
- failed ambiguous tool that changed Reality still invalidates verification.

Tests should assert execution/State effects rather than depend primarily on exact long Guard prose.

## 20. Migration sequence

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

Do not create a parallel legacy/compatibility semantic system. M2 moves live semantic authorization directly onto M0/M1 truth while preserving unrelated Runtime behavior.