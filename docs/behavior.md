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
Pi      → concrete tool registry/execution, native system prompt, low-level Agent Loop
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

## 5. Live Gateway and Tool Effects

Concrete Tool Effects are classified and non-observation calls are authorized through current capabilities after authoritative State refresh/coherence checks.

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

The Gateway remains defense in depth for races, stale already-generated calls, and external-State changes.

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

## 7. M3 narrow semantic tools and Tool Surface — implemented

Model-facing semantic tools:

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

The legacy broad `pindie_state` and `pindie_gate` model-facing tools are retired. Internal reducer events remain unchanged.

For each actual Agent Run:

```text
Effective tools
=
Run Tool Baseline
∩
Tools whose required capability is present
```

The Run Tool Baseline is captured at `before_agent_start`, restored at `agent_settled`, and never persisted. Pindie never enables a baseline-absent tool. Unknown/custom baseline-active tools require `project.mutate`.

## 8. M4 global policy removal

M4 removes Pindie's global Core Policy/system-prompt override.

Required behavior:

```text
before_agent_start
→ establish authoritative Run facts
→ apply capability-driven Tool Surface
→ do not return a Pindie-owned systemPrompt replacement
```

Pindie must not retain or recreate a global lifecycle policy through:

- `PINDIE_CORE_POLICY`;
- `<PINDIE_CORE>` blocks;
- hidden custom messages;
- Runtime Context instructions;
- duplicated lifecycle rules in tool descriptions;
- procedural Gateway denial text;
- private reconstruction of Pi's system prompt.

Pi's native system-prompt construction remains authoritative and may naturally track active-tool changes made through its public API.

Natural-language policy is a last resort. Rules already enforced by State/Snapshot/Capabilities/Tool Surface/Gateway/Reducer must not be repeated globally for the model to remember.

## 9. M4 Runtime Context / Knowledge Surface

Runtime Context remains hidden model context but becomes a factual Knowledge Surface.

The context must identify itself as runtime metadata, not user intent or a new request.

### Coherent authority

A coherent context may render:

```text
Pindie Runtime Context

Runtime metadata only; not user intent or a new request.

Agent Run authority: coherent
Task status: active
Verification status: pending

Goal:
...

Constraints:
...

Success criteria:
...

Blockers:
...

Questions:
...

Next intent:
...

Verification checks:
...

Human gate:
...
```

Optional sections are omitted when empty.

### Stale authority

If current State is available but the current Agent Run is incoherent/stale, Runtime Context must explicitly render:

```text
Agent Run authority: stale
```

It may still show the current authoritative Task facts, but must not imply that consequential authority remains coherent.

Do not add procedural text such as "begin a new Run", "call X", or "do not mutate" to the Runtime Context.

### Unavailable authority

If authoritative Pindie State is unavailable, Runtime Context renders only factual unavailability information, conceptually:

```text
Pindie Runtime Context

Runtime metadata only; not user intent or a new request.

Agent Run authority: unavailable
Reason: ...
```

It must not append lifecycle instructions such as "Do not make consequential project changes" because Tool Surface and Gateway already close those branches.

### Shared semantic truth

Runtime Context authority/task/verification status must consume `SemanticSnapshot` rather than independently recomputing those statuses from State.

The same semantic world therefore drives:

```text
SemanticSnapshot
├→ Capabilities → Tool Surface / Gateway
└→ Runtime Context status facts
```

Current State still supplies the detailed Task Contract, open loops, verification records, and Human Gate contents.

## 10. Tool descriptions and Gateway text

Narrow tool descriptions explain operation meaning and input fields. They must not become lifecycle policy manuals.

Gateway denials should remain concise factual diagnostics centered on current authority/status and missing capability. They must not teach a replacement workflow.

Operation-specific exceptional recovery text may remain when it describes an actual conflict, lock, persistence failure, or result-specific next safety step. M4 does not mechanically delete every instruction-like sentence.

## 11. Human Gate

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets the human reply among those choices.

M4 does not change Gate semantics.

## 12. Continuation boundary

M6 owns continuation simplification.

M4 must preserve current continuation eligibility and hidden follow-up behavior except for the smallest literal rename required by M3 narrow tool names, for example replacing a stale reference to `replace_task` with `pindie_task_replace`.

Do not rewrite continuation into a new policy system in M4.

## 13. M4 acceptance examples

P01 — Core removal

```text
before_agent_start
→ no Pindie systemPrompt override
```

P02 — no hidden policy relocation

```text
no PINDIE_CORE block
no replacement custom policy message
```

P03 — coherent Knowledge Surface

```text
SemanticSnapshot.authority = coherent
→ Runtime Context says authority coherent
→ task/verification status exactly match Snapshot
```

P04 — stale Knowledge Surface

```text
SemanticSnapshot.authority = stale
→ Runtime Context says authority stale
→ no procedural stale-run instruction
```

P05 — unavailable Knowledge Surface

```text
SemanticSnapshot.authority = unavailable
→ Runtime Context says authority unavailable + reason
→ no mutation prohibition prose
```

P06 — tool/prompt convergence

```text
before_agent_start applies M3 Tool Surface
→ Pindie does not pin a separate systemPrompt override
→ M2 Gateway remains unchanged
```

P07 — structural legality unchanged

```text
M0 capability matrix
M1 Tool Effects
M2 Gateway
M3 Tool Surface
Reducer backstops
→ unchanged
```

## 14. Non-goals for M4

M4 must not:

- change M0 capability semantics;
- weaken M2 Gateway authorization;
- change M3 Tool Surface projection or Run baseline lifecycle;
- redesign verification evidence ownership;
- redesign Human Gate semantics;
- redesign continuation;
- redesign Skills;
- parse or reconstruct Pi's system prompt;
- import private Pi internals;
- move global policy into a custom message;
- create a second Knowledge Surface or semantic truth.

## 15. Migration status

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

M4's acceptance target is deletion and convergence: deterministic correctness remains structural, Pi owns its native system prompt, and Pindie Runtime Context reports facts from the same Semantic Snapshot that drives capabilities.