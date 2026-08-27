# Pindie v0.2 — Behavior Specification

This document defines the current semantic and behavioral contract. It describes what Pindie means and guarantees now; implementation history belongs in Git history and tests.

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

Persistent State must not store runtime capabilities, active tools, Run authority, workflow phases, recent evidence refs, evidence generations, continuation fuses, or presentation state.

## 2. Ownership

```text
Reality → reconstructable facts
Harness → deterministic truth, legality, lifecycle, factual evidence, freshness
Model   → intent interpretation, planning, semantic choice, verification meaning/coverage
Human   → goals, taste, consequential judgment, approval
Pi      → concrete tools, sessions, Skills, native system prompt, low-level Agent Loop
```

Deterministic facts close deterministic branches. Genuine semantic ambiguity remains model-owned within the legal capability space.

For verification:

```text
Harness → what happened
Model   → what it proves
```

For continuation:

```text
Harness → whether asking a continuation question is currently meaningful
Model   → whether latest actual user intent still calls for consequential execution
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

`completionReady` means an unfinished Task with passed current verification, no blockers, no unresolved questions, and no Human Gate.

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

If Run authority is stale or unavailable, capabilities are exactly:

```text
observe.project
observe.git
```

Coherent capability states:

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

## 5. Tool Effects and live Gateway

Concrete tools map to required semantic capabilities and project-mutation effects:

```text
read / grep / find / ls → observe.project / none
pindie_git_observe      → observe.git / none
edit / write            → project.mutate / known
bash / unknown/custom   → project.mutate / ambiguous
semantic Pindie tool    → exact semantic capability / none
```

Unknown/custom tools are conservative. Generic shell input is never parsed into a read-only exception.

Authorization is exactly:

```text
allowed = capabilities.has(effect.requiredCapability)
```

Known observation tools keep the observation fast path. Consequential calls use authoritative refresh/coherence checks before capability authorization.

The Gateway remains defense in depth for races, stale already-generated calls, external-State changes, and same-Run semantic transitions that happened after a model saw an older Tool Surface.

## 6. Project Mutation Freshness

After authorization:

```text
projectMutation = none
→ no mutation observation

projectMutation = known
→ successful mutation invalidates prior verification

projectMutation = ambiguous
→ compare project Reality before and after execution
```

Denied calls create no mutation window. Failed ambiguous tools are still observed afterward because partial project mutation may have occurred.

When mutation is detected or cannot be determined safely, verification is invalidated and recent verification evidence is made stale.

## 7. Model-facing semantic tools and Tool Surface

Pindie exposes narrow semantic affordances:

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

Internal reducer events remain independent of Pi tool names.

For each actual Agent Run:

```text
Effective tools
=
Run Tool Baseline
∩
Tools whose required capability is present
```

The Run Tool Baseline is captured at `before_agent_start`, restored at `agent_settled`, and never persisted. Pindie never enables a baseline-absent tool. Unknown/custom baseline-active tools are visible only when `project.mutate` exists.

## 8. Knowledge Surface and prompt behavior

Pindie does not inject a global lifecycle-policy Core prompt or own a system-prompt override. Pi owns native system-prompt construction.

Pindie Runtime Context is hidden factual Knowledge Surface driven by `SemanticSnapshot`. It may show:

- coherent/stale/unavailable Run authority;
- Task and verification status;
- current Task contract/open loops;
- verification records;
- Human Gate details;
- factual unavailability reason.

It must not restate structural legality as lifecycle instructions.

Old Runtime Context messages are removed from model projection and exactly one fresh projection is appended.

## 9. Verification evidence

Durable `VerificationCheck` remains:

```text
name: string
status: passed | failed
covers: string[]
evidence: string
```

`pindie_verification_record` accepts model-owned semantic judgment plus current runtime evidence refs:

```text
check.name
check.status
check.covers
check.evidenceRefs[]
```

The model owns `name`, `status`, and `covers`. The Harness resolves current refs and constructs the durable factual `evidence` string before dispatching the unchanged `record_verification` event.

Runtime evidence refs:

```text
ev:<scope>:<sequence>
```

They are short, opaque, Pindie-owned, reusable within the current evidence scope, and never enter persisted State. Pi tool-call identity remains runtime-internal provenance and is not exposed through the handle.

Evidence-candidate rules:

- known observation results may become candidates during coherent unfinished work;
- known project mutations (`edit`/`write`) never become candidates;
- Pindie semantic tool results never become candidates;
- ambiguous project-effect results become candidates only after Project Mutation Freshness proves Reality unchanged;
- factual error results may still be candidates; `Outcome: error` does not imply semantic verification failure.

A runtime evidence generation prevents parallel/late results from crossing a changed verification basis. Calls remember generation-at-call; basis changes advance generation and clear candidates. Unknown/stale/fabricated refs are rejected at verification-record time.

Selected evidence is deterministically bounded and hashed before persistence. Existing legacy `evidence: string` State remains valid without migration.

## 10. Human Gate

A Human Gate is an explicit human-authority boundary.

```text
Gate opened during current Run
→ observation-only capability space

Gate existed before current user-driven Run
→ observation + gate.resolve + any other legal Task-boundary choices
```

The model interprets the human reply among currently legal semantic actions. Gate lifecycle legality is structural and must not be reimplemented as a prompt tutorial or Skill rule.

## 11. Continuation

Pindie may ask one semantic continuation question only after deterministic eligibility is satisfied.

Pure eligibility is exactly:

```text
snapshot.authority === coherent
snapshot.taskStatus === active
probeAlreadyAttempted === false
hasPendingMessages === false
stoppedNormally === true
```

`stoppedNormally` means the final assistant message has `stopReason === "stop"`.

Continuation code must not independently test `task.completed`, Human Gate, blockers, questions, verification status, `nextIntent`, or private Pi retry state. `taskStatus === active` is the semantic source for deterministic Task eligibility. Questions may coexist with active work and therefore do not suppress the probe by themselves.

If eligible, Pindie queues exactly one hidden custom message through Pi:

```text
sendMessage(..., { deliverAs: "followUp" })
```

The probe identifies itself as runtime-generated metadata, not user intent and not a new request. It asks only whether the latest actual user intent still calls for consequential execution. It does not teach Task/Gate/blocker/verification/completion procedures.

The one-probe fuse is runtime-only. A fresh `before_agent_start` resets it; follow-up turns within the same high-level Run do not.

Pi owns retry, compaction, follow-up delivery, and final `agent_settled`. Pindie does not access or infer private retry state and does not create a second loop.

Continuation context hygiene:

- on a fresh user-driven Run, all historical Pindie continuation probes are filtered from model context;
- during the active continuation follow-up, only the latest/current probe remains model-visible;
- the current probe retains its original chronological position;
- session history need not be rewritten or migrated.

## 12. Skill behavior

Pi is the only Skill runtime.

A bundled Pindie Skill may describe a reusable procedure, but it must not own or duplicate semantic correctness. In particular, Skills must not redefine:

- Task admission/replacement/refinement legality;
- capability or Tool Surface rules;
- Human Gate lifecycle;
- verification evidence authority/freshness;
- Task completion legality.

Those constraints remain Harness-owned.

## 13. Runtime-only supporting systems

Activity, Run Timer, Run Cost, status presentation, subscription usage observation, and adaptive reasoning are runtime-only. They must not become persisted semantic State or independent correctness authorities.

Run Activity reflects actual Pi tool lifecycle. Presentation reads authoritative/derived runtime state; it does not define it.

## 14. Global behavioral invariants

1. Pindie keeps one durable current Task, not a queue or workflow graph.
2. Deterministic legality comes from semantic derivation, not model memory of rules.
3. Model-visible action space and Gateway authorization derive from the same capability truth.
4. The model retains semantic interpretation and choice inside that legal space.
5. Human judgment is explicit where required.
6. Verification factual provenance/freshness belongs to Harness; meaning/coverage belongs to Model.
7. Runtime evidence refs, generations, active-tool baselines, Run relations, and continuation fuses are ephemeral.
8. Reducer invariants remain valid even if outer Tool Surface/Gateway layers fail.
9. Historical runtime metadata must not accumulate into persistent model policy.
10. Pi remains the sole low-level Agent Loop and Skill runtime.
