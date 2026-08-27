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

Persistent State must not store runtime capabilities, active tools, Run authority, workflow phases, recent evidence refs, or evidence generations.

## 2. Ownership

```text
Reality → reconstructable facts
Harness → deterministic truth, legality, lifecycle, factual evidence, freshness
Model   → intent interpretation, planning, semantic choice, verification meaning/coverage
Human   → goals, taste, consequential judgment, approval
Pi      → concrete tool registry/execution, native system prompt, low-level Agent Loop
```

Deterministic facts close deterministic branches; genuine semantic ambiguity remains model-owned within the legal capability space.

For verification specifically:

```text
Harness → what happened
Model   → what it proves
```

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

## 7. Narrow semantic tools and Tool Surface — implemented

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

## 8. Policy/Knowledge Surface — implemented M4

Pindie no longer injects a global Core Policy or returns a Pindie-owned system-prompt override. Pi owns native system-prompt construction.

Runtime Context is factual Knowledge Surface driven by `SemanticSnapshot`. It may show coherent/stale/unavailable authority, Task/verification status, current Task contents, verification records, Human Gate, and factual unavailable reason. It must not restate structural legality as lifecycle instructions.

## 9. M5 Verification v0.2 ownership

M5 changes evidence authority without changing durable State schema or reducer vocabulary.

Durable `VerificationCheck` remains:

```text
name: string
status: passed | failed
covers: string[]
evidence: string
```

Existing records remain valid. No State migration or schema version is introduced.

### 9.1 Model-facing verification input

`pindie_verification_record` must stop accepting free-form durable `evidence: string` from the model.

Target semantic input is conceptually:

```text
check.name
check.status
check.covers
evidenceRefs[]
```

The model owns `name`, `status`, and `covers`.

The Harness owns validation/resolution of `evidenceRefs` and constructs the durable `evidence` string before dispatching the existing `record_verification` event.

Unknown/stale refs reject the operation and leave State unchanged.

### 9.2 Recent Evidence Registry

Evidence refs are current-Agent-Run runtime handles, preferably `ev:<toolCallId>`.

They are:

- derived from actual Pi tool results;
- never persisted;
- reusable within the current evidence scope;
- discarded at `agent_settled` and session shutdown;
- reset for the next actual Agent Run.

A verification record does not consume the underlying candidate; one factual result may legitimately support multiple checks/criteria.

### 9.3 Evidence candidate eligibility

Evidence is captured only while current semantic authority is coherent and there is a current unfinished Task.

Eligible:

```text
observe.project
observe.git
```

Known project mutations (`edit`/`write`) are not candidates.

Pindie semantic State/Gate/verification tools are not candidates.

Ambiguous project-effect tools (`bash`, unknown/custom) are candidates only if existing M2 Project Mutation Freshness proves that project Reality did not change. If mutation is detected or the before/after comparison is unknown, no evidence ref is exposed for that result.

`event.isError === true` does not by itself make a result ineligible. The Harness records the error fact; the model decides whether that fact proves a passed or failed semantic check.

### 9.4 Evidence generation/freshness

M5 must handle parallel/late results. Clearing the registry alone is insufficient.

Maintain a runtime-only evidence generation token.

At authorization, every tool call that may later participate in evidence bookkeeping records its current generation.

A result can become current evidence only when:

```text
callGeneration === currentGeneration
```

after mutation bookkeeping for that result has finished.

Advance the generation and clear current candidates when the verification basis changes.

Required generation advances:

```text
new actual Agent Run
successful task.start
successful task.replace
successful task.refine
successful known project mutation
detected/unknown ambiguous project mutation
external authority discontinuity / markUnavailable
```

Do not advance merely for:

```text
observation
task.progress
gate.open
gate.resolve
verification.record
```

A successful no-op refinement may conservatively advance evidence generation; M5 does not need extra identity machinery solely to optimize this case.

### 9.5 Mutation-before-evidence ordering

Ambiguous results obey:

```text
tool_result
→ finish M2 mutation observation
→ if mutation/unknown: invalidate verification, advance evidence generation, no candidate
→ if unchanged: candidate may be captured if all other conditions hold
```

An ambiguous command that changes Reality must be followed by fresh verification; its own result does not prove the newly changed Reality.

### 9.6 Model-visible evidence refs

When an eligible current candidate is captured, append a concise factual marker to that tool result, for example:

```text
[Pindie evidence ref: ev:<toolCallId>]
```

Do not add lifecycle instructions around the ref.

No evidence marker is required for idle/task-free observation, stale/unavailable authority, ineligible tools, stale-generation results, or ambiguous results that mutated/possibly mutated Reality.

### 9.7 Durable evidence materialization

Selected evidence refs are materialized deterministically by Harness code.

The model must not write or summarize the durable evidence string.

Materialization should contain enough factual provenance to identify:

- tool name;
- success/error outcome;
- bounded deterministic input excerpt/representation;
- bounded deterministic result excerpt/representation;
- digest(s) where data is truncated or non-text.

Do not persist whole raw logs automatically.

Initial limits must be fixed, tested, and intentionally small. A reasonable target is at most 4 evidence refs per verification check, with bounded per-ref input/result text.

Only explicitly selected refs persist; unrelated Recent Evidence candidates remain runtime-only.

### 9.8 Legacy verification compatibility

Old persisted verification records are grandfathered.

M5 must not:

- invalidate all existing verification on load;
- add schema versioning solely for evidence provenance;
- migrate old `evidence` strings;
- reject a previously valid State merely because its evidence was recorded before M5.

Once existing verification is naturally invalidated by project/Task changes, subsequent newly recorded verification follows the M5 evidence-ref path.

## 10. M5 acceptance examples

V01 — observation evidence

```text
coherent unfinished Task
read succeeds
→ result receives current evidence ref
```

V02 — idle observation

```text
no current Task
read succeeds
→ no evidence ref
```

V03 — failed observation

```text
coherent unfinished Task
eligible observation returns error
→ factual error result may receive evidence ref
→ Harness does not infer semantic failed status
```

V04 — known mutation

```text
edit succeeds
→ verification invalidated
→ evidence generation advances
→ edit result gets no evidence ref
```

V05 — non-mutating bash

```text
bash runs test command
before/after fingerprint unchanged
→ result may receive evidence ref
```

V06 — mutating/unknown bash

```text
bash changes project or mutation cannot be proven absent
→ verification invalidated
→ generation advances
→ no evidence ref for that bash result
```

V07 — stale parallel result

```text
read begins at generation N
project mutation advances to N+1
old read result arrives
→ no current evidence candidate/ref
```

V08 — valid record

```text
model calls pindie_verification_record with current evidence refs
→ Harness resolves refs
→ durable bounded factual evidence string constructed
→ existing reducer receives normal VerificationCheck
```

V09 — fabricated/stale ref

```text
pindie_verification_record references unknown/stale ref
→ operation errors
→ State unchanged
```

V10 — semantic freedom

```text
error evidence + criterion "invalid input is rejected"
→ model may record status passed
→ Harness does not override semantic judgment
```

V11 — legacy State

```text
old valid evidence:string record loaded after M5
→ State remains valid without migration
```

## 11. Human Gate

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets the human reply among those choices.

M5 does not change Gate semantics.

## 12. Continuation boundary

M6 owns continuation simplification. M5 must not redesign continuation eligibility, follow-up prompts, or continuation fuses.

## 13. Non-goals for M5

M5 must not:

- change `PindieState`/`VerificationCheck` persisted shape;
- add State migration/versioning for evidence provenance;
- redesign `getVerificationStatus()` semantics;
- change reducer event vocabulary;
- infer verification `status` from Pi success/error;
- infer criterion coverage automatically;
- weaken M2 Project Mutation Freshness;
- change M0 capabilities or M3 Tool Surface legality;
- add a verification log database;
- persist Recent Evidence refs or generation tokens;
- redesign continuation, Skills, reasoning, or Human Gate behavior.

## 14. Migration status

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

M5 is complete when newly recorded durable evidence can only originate from current Harness-captured factual tool results, while the model retains semantic pass/fail and criterion-coverage judgment and old persisted verification remains compatible.