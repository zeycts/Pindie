# Pindie v0.2 — Behavior Specification

This document defines the approved v0.2 semantic and behavioral contract. Target semantics here are authoritative; source/tests are the implemented baseline unless the current milestone explicitly changes them.

## 1. Persistent-State invariants

1. `state.task` is `null` or one current Task; there is no task queue.
2. Completed Task is terminal for ordinary semantic transitions.
3. Stale verification has no current checks.
4. Verification coverage references current criterion IDs only.
5. Criterion IDs are unique within a Task.
6. Verification check names are unique within current verification.
7. At most one Human Gate is open.
8. Completed Task implies current verification status `passed`.
9. Every Task has at least one success criterion.

Persistent State must not store runtime capabilities, active tools, Run authority, or workflow phases.

## 2. Ownership

```text
Reality → reconstructable facts
Harness → deterministic truth, legality, lifecycle, freshness
Model   → intent interpretation, planning, semantic choice, coverage judgment
Human   → goals, taste, consequential judgment, approval
Pi      → concrete tool registry/execution and low-level Agent Loop
```

Deterministic facts close deterministic branches; genuine semantic ambiguity remains model-owned within the legal capability space.

## 3. Derived semantic truth

Task status:

```text
no task          → idle
completed        → done
human gate open  → waiting_human
blockers present → blocked
otherwise        → active
```

Verification status:

```text
verification.stale                     → stale
checks.length === 0                    → pending
any current check failed               → failed
all criteria covered by passing checks → passed
otherwise                              → pending
```

Run relations are runtime-only:

```text
TaskRunRelation       none | preexisting_untouched | preexisting_changed | introduced_during_run
CompletionRunRelation not_completed | completed_before_run | completed_during_run
GateRunRelation       none | existed_before_run | opened_during_run
```

`completionReady` means unfinished Task + passed current verification + no blockers + no unresolved questions + no Human Gate.

## 4. Capability vocabulary and matrix

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

If authority is stale or unavailable, capabilities are exactly `observe.project` and `observe.git`.

Coherent states:

```text
idle
→ observe.project, observe.git, task.start

done / completed_before_run
→ observe.project, observe.git, task.start

done / completed_during_run
→ observe.project, observe.git

active
→ observe.project, observe.git, project.mutate,
  task.refine, task.progress, verification.record, gate.open
→ + task.replace iff preexisting_untouched
→ + task.complete iff completionReady

blocked
→ observe.project, observe.git,
  task.refine, task.progress, verification.record, gate.open
→ + task.replace iff preexisting_untouched
→ no project.mutate, no task.complete

waiting_human / opened_during_run
→ observe.project, observe.git

waiting_human / existed_before_run
→ observe.project, observe.git, task.refine, gate.resolve
→ + task.replace iff preexisting_untouched
```

Questions may coexist with useful work but prevent completion. A Task-level blocker means consequential project mutation is not currently safe/effective.

## 5. Live Gateway behavior

M2 is implemented. Concrete Tool Effects are classified and non-observation calls are authorized through current capabilities after authoritative State refresh/coherence checks.

Current shared effects include:

```text
read / grep / find / ls → observe.project / none
pindie_git_observe      → observe.git / none
edit / write            → project.mutate / known
bash / unknown/custom   → project.mutate / ambiguous
semantic Pindie tool    → its exact semantic capability / none
```

Unknown/custom tools are conservative. Generic shell input is never parsed into a read-only exception.

Authorization is exactly:

```text
allowed = capabilities.has(effect.requiredCapability)
```

The Gateway remains live after M3 as a defense-in-depth backstop for races, stale already-generated calls, malformed calls, and external-State changes.

## 6. Project Mutation Freshness

After authorization:

```text
projectMutation = none
→ no mutation observation

projectMutation = known
→ successful mutation invalidates prior verification

projectMutation = ambiguous
→ before/after Reality fingerprint observation
```

Denied calls create no mutation window. Failed ambiguous tools are still observed afterward because partial project mutation may have occurred.

## 7. M3 narrow model-facing semantic tools

M3 removes the broad model-facing action enums and exposes narrow tools aligned one-to-one with semantic capabilities:

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

The legacy model-facing `pindie_state` and `pindie_gate` tools are removed from registration in M3. Internal reducer events remain unchanged.

All semantic mutation tools remain sequential so same-batch semantic changes are visible before later sequential calls are prepared/executed.

M3 does not redesign current verification record fields. `pindie_verification_record` continues to accept the current check semantics until M5.

Tool descriptions explain only the operation's meaning and input contract. They must not repeat lifecycle legality such as when the operation is allowed; visibility and the Gateway own that.

## 8. M3 Tool Surface projection

For each actual Agent Run, Pindie captures a runtime-only **Run Tool Baseline** at `before_agent_start` before applying semantic restriction.

```text
Effective tools
=
Run Tool Baseline
∩
Tools whose required capability is currently present
```

Behavioral rules:

1. Pindie may remove tools from the baseline but never add a tool absent from it.
2. Baseline order is preserved.
3. Unknown/custom baseline-active tools require `project.mutate`; they disappear when that capability is absent.
4. The baseline is runtime-only and never enters `PindieState`.
5. The baseline is created only for an actual Agent Run, not speculatively from `input`.
6. Pindie restores the exact baseline when the high-level Agent Run settles.
7. The next actual Run captures a fresh baseline, so Pi/user changes made while idle become authoritative for that Run.
8. Pindie does not create or persist a second user tool preference store.

For every baseline-active recognized tool `T` in an unchanged semantic world:

```text
visible(T)
⇔
capabilities.has(requiredCapability(T))
```

The M2 Gateway must agree with the same capability truth.

## 9. Pi v0.84.3 overlay and lifecycle constraint

The pinned Pi v0.84.3 API exposes `getActiveTools()`, `getAllTools()`, and replacement-style `setActiveTools(names)`. It exposes no composable overlay primitive and no active-tool-change event.

Therefore M3 does not promise perfect composition with another extension that mutates active tools during the same already-running Agent Run. Pindie owns its Run-scoped semantic narrowing and restores the captured baseline at settlement. Do not add polling, heuristic diff-merging, or a second configuration state machine to pretend this limitation does not exist.

Pi v0.84.3 also emits extension `input` before model/auth preflight. That input may be handled or rejected without an Agent Run and therefore without `before_agent_start`/`agent_settled`.

Required rule:

```text
input
→ must NOT capture-and-restrict the Run Tool Baseline

before_agent_start
→ authoritative Run Facts boundary
→ authoritative Run Tool Baseline boundary
→ initial capability-driven Tool Surface application
```

This prevents a failed/handled input from leaving Pi idle with a semantically narrowed active-tool set or causing a later Run to capture a false narrowed baseline.

## 10. Initial and mid-Run Tool Surface refresh

At `before_agent_start`:

1. capture the current Pi/user active tools as the fresh Run Tool Baseline;
2. refresh authoritative Pindie State using the existing M2 safety path;
3. establish actual Run Facts;
4. derive Snapshot + Capabilities;
5. derive and apply the effective Tool Surface from the captured baseline.

Do not create a prospective next-Run semantic context from `input`.

Within the Run, recompute the effective surface after any event that can change capabilities, including:

```text
successful task start/replace/refine/progress
verification record
Gate open/resolve
Task completion
project mutation causing verification invalidation
external State change causing stale authority
State becoming unavailable
```

A Tool Surface update affects the actual tool schemas available on the next agent turn. Gateway authorization remains the final authority for any call produced against stale visibility.

## 11. Core Policy / Pi system-prompt limitation during M3

Pindie's current Core Policy is injected from `before_agent_start` as a system-prompt override for the high-level Run. Pi v0.84.3 rebuilds its base system prompt when active tools change, but the `before_agent_start` hook receives a prompt input that was prepared before Pindie's handler narrows tools, and the returned override can keep old selected-tool text during the Run.

M3 must not solve this by:

- pre-restricting tools from `input`;
- importing private Pi internals;
- parsing/rebuilding Pi's default system prompt;
- adding compensating natural-language rules.

Required M3 behavior:

- make the actual tool schemas/action space correct before model execution by applying the initial surface in `before_agent_start`;
- keep actual dynamic tool schemas and the M2 Gateway correct throughout the Run;
- accept/document temporary prompt-text lag under the existing Core override.

M4 owns Policy Reduction and removal/restructuring of that override so prompt text and dynamic Tool Surface fully converge.

## 12. Key M3 examples

Assuming the relevant tools were baseline-active:

```text
idle
→ observation + pindie_task_start
→ no edit/write/bash/replace/refine/complete

successful pindie_task_start
→ project mutation/refine/progress/verification/gate-open tools can appear next turn
→ pindie_task_replace remains absent for same-Run-introduced Task

blocked
→ observation + legal Task semantic tools
→ edit/write/bash/custom consequential tools absent
→ complete absent

completionReady active Task
→ pindie_task_complete visible

successful project mutation invalidates verification
→ pindie_task_complete disappears if readiness is lost

Gate opened during this Run
→ observation only

Gate existing before a fresh Run
→ gate resolve/refine and eligible replacement become visible

Task completed during Run
→ observation only; pindie_task_start remains absent until the next Run

stale/unavailable authority
→ observation only
```

## 13. Surface restoration and races

When the Agent Run settles, restore the exact captured Run baseline and discard the Run Tool Surface context. Session shutdown/replacement must not leak a restricted surface into a later session.

If authority becomes stale/unavailable during a Run, shrink the next-turn surface to observation-only where possible. An already-generated consequential call may still reach the M2 Gateway and must be denied there.

Tool Surface is an affordance projection; Gateway is execution-time authorization. Neither replaces the other.

## 14. Non-goals for M3

M3 must not:

- change M0 capability semantics;
- weaken M2 Gateway authorization;
- add persisted active tools or capability State;
- redesign verification evidence ownership;
- rewrite Core Policy content;
- redesign continuation;
- redesign Skills;
- create a generic plugin/tool policy framework;
- parse shell commands;
- import private Pi prompt-building internals;
- mutate active tools from `input` to speculate about a future Run.

## 15. Migration status

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

M3's acceptance target is simple: in a stable semantic world, a baseline-active tool is model-visible exactly when its required Pindie capability exists, while the M2 Gateway continues to enforce the same truth at execution time.