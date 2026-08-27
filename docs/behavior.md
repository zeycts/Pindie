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

Persistent State must not store runtime capabilities, active tools, Run authority, workflow phases, recent evidence refs, evidence generations, or continuation fuses.

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

For continuation specifically:

```text
Harness → whether a semantic continuation decision is currently meaningful
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

## 7. Narrow semantic tools and Tool Surface — implemented M3

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

## 9. Verification v0.2 — implemented M5

Durable `VerificationCheck` remains:

```text
name: string
status: passed | failed
covers: string[]
evidence: string
```

New verification evidence is Harness-materialized from current actual tool-result refs; old persisted evidence strings remain valid without migration.

`pindie_verification_record` accepts:

```text
check.name
check.status
check.covers
check.evidenceRefs[]
```

The model owns `name`, `status`, and `covers`. The Harness resolves current refs, rejects unknown/stale refs, and constructs the durable `evidence` string before dispatching the unchanged `record_verification` event.

Recent evidence refs use actual tool-call identity (`ev:<toolCallId>`), are reusable only within the current evidence scope, and never enter persisted State. Eligible factual results require coherent unfinished work. Known mutations and Pindie semantic tools are not evidence candidates. Ambiguous project-effect results become evidence only after Project Mutation Freshness proves Reality unchanged.

A runtime evidence generation prevents parallel/late results from crossing a changed verification basis. Mutation/unknown comparison runs before ambiguous evidence capture. Failed results may still be factual evidence; the Harness records `Outcome: error` and does not infer semantic verification failure.

Only explicitly selected refs are deterministically materialized into bounded durable factual evidence. Recent candidates are discarded at Agent settlement/session shutdown.

## 10. Human Gate

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets the human reply among those choices.

## 11. M6 Continuation Simplification

M6 removes duplicated lifecycle policy from Active Task Continuation while preserving the one genuinely semantic continuation decision.

### 11.1 Deterministic eligibility

Continuation eligibility must be a pure decision over the current `SemanticSnapshot` plus minimal public Pi runtime facts.

Conceptually:

```text
snapshot
probeAlreadyAttempted
hasPendingMessages
stoppedNormally
        ↓
shouldProbeContinuation
```

A continuation probe is eligible exactly when:

```text
snapshot.authority === coherent
snapshot.taskStatus === active
probeAlreadyAttempted === false
hasPendingMessages === false
stoppedNormally === true
```

`stoppedNormally` means the final assistant message has `stopReason === "stop"`.

Do not independently test `task.completed`, `task.humanGate`, or blockers in continuation eligibility; `taskStatus === active` already closes those branches.

Unresolved questions do not automatically suppress continuation because questions may coexist with useful active work.

### 11.2 Pi lifecycle boundary

Pinned Pi 0.84.3 has two distinct event surfaces that must not be confused:

- the public extension `AgentEndEvent` exposes only `type` and `messages`;
- Pi's internal `AgentSessionEvent` enriches its own session listeners with `willRetry`, but extension handlers do not receive that field.

M6 must use only the public extension contract. Therefore it must not:

- read or cast `event.willRetry` in an extension `agent_end` handler;
- access private Pi internals;
- reimplement Pi's retry classifier from message/error text;
- upgrade or patch Pi solely to expose retry intent.

Pi's turn-level auto-retry path handles retryable error responses. M6 already requires the final assistant response to have `stopReason === "stop"`, so those retryable abnormal outcomes are excluded by the public normal-stop condition.

Existing pending Pi messages still suppress Pindie's probe through `ctx.hasPendingMessages()`, because a queued message may carry newer user intent and should take precedence.

For a successful normal stop, Pi may perform non-retrying auto-compaction before draining a queued follow-up. Pindie leaves that lifecycle entirely to Pi.

`agent_settled` remains the boundary for final Run settlement/presentation cleanup.

### 11.3 Thin semantic intent probe

Once deterministic eligibility passes, the remaining question is:

> Does the latest actual user intent still call for consequential execution now?

The probe must explicitly identify itself as runtime-generated Pindie metadata, **not user intent and not a new request**.

It should ask the model to re-evaluate latest actual user intent and either:

- act within the currently visible/legal semantic action space when consequential execution is still called for; or
- return control without further consequential action when it is not.

The probe must not enumerate or teach lifecycle actions such as:

- when to replace/refine a Task;
- when to open/resolve a Human Gate;
- when to record a blocker;
- when/how to re-observe;
- how to verify/complete;
- why `nextIntent` is or is not permission to yield.

Those constraints already belong to Runtime Context, Tool Surface, Gateway, verification machinery, and reducer invariants.

### 11.4 One-probe fuse

Pindie sends at most one continuation probe per high-level user-driven Agent Run.

Use the existing runtime-only fuse. A fresh `before_agent_start` resets it. A continuation follow-up inside the same high-level Run must not reset it.

A second `agent_end` from the probe/follow-up must not queue another probe.

Do not add counters, recursion, direct model calls, or a persistent continuation state.

### 11.5 Delivery

Preserve the Pi-native mechanism:

```text
pi.sendMessage(
  hidden Pindie continuation custom message,
  { deliverAs: "followUp" }
)
```

Do not switch to `sendUserMessage`, steering, background automation, or a second Agent Loop.

The probe is hidden from normal UI but model-visible for the actual continuation follow-up.

### 11.6 Probe context hygiene

Pi custom messages participate in LLM context. Old Pindie continuation probes must not remain effective as historical pseudo-user instructions.

Context projection must:

- retain only the current/latest Pindie continuation probe while the current one-shot continuation follow-up is active;
- remove all prior Pindie continuation probes from model context on a fresh user-driven Run;
- continue appending exactly one fresh factual Runtime Context projection.

Filtering probes from model context does not require deleting session entries or adding migration logic.

### 11.7 M6 acceptance examples

C01 — active coherent normal stop

```text
active Task
coherent authority
stopReason = stop
no pending messages
probe not attempted
→ exactly one hidden followUp probe
```

C02 — active Task with unresolved questions

```text
Task status remains active
→ questions alone do not suppress the probe
```

C03 — semantic ineligibility

```text
idle | done | blocked | waiting_human | stale | unavailable
→ no probe
```

C04 — pending-message precedence

```text
active coherent Task
ctx.hasPendingMessages() = true
→ no probe
```

C05 — abnormal stop / retry-class outcome

```text
stopReason = aborted | error | length
→ no probe
```

No separate public `willRetry` condition exists in M6 because Pi 0.84.3 does not expose that field to extension `agent_end` handlers.

C06 — one-shot fuse

```text
first eligible agent_end → one probe
later agent_end in same high-level Run → no second probe
fresh user-driven Run → fuse reset
```

C07 — probe semantics

```text
probe text explicitly says it is not user intent/new request
probe asks only whether latest actual user intent still calls for consequential execution
probe contains no specific lifecycle-tool tutorial
```

C08 — context hygiene

```text
current continuation follow-up → only current/latest probe is model-visible
next fresh user Run → historical Pindie continuation probes filtered out
```

C09 — no semantic mutation

```text
eligibility check / probe injection
→ no Pindie State save
→ no reasoning-mode mutation
→ no verification/evidence mutation
```

## 12. Non-goals for M6

M6 must not:

- change `PindieState` or reducer events;
- change M0 capability semantics;
- change M2 Gateway legality;
- change M3 Tool Surface/baseline semantics;
- change M5 verification evidence ownership/freshness;
- infer latest user intent deterministically from Task state or `nextIntent`;
- access or duplicate private Pi retry internals;
- create a second Agent Loop, continuation FSM, task queue, or planner;
- add repeated/recursive continuation probes;
- redesign reasoning, Skills, Human Gate, activity, timer, cost, or status behavior;
- reintroduce global natural-language policy.

## 13. Migration status

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — implemented
M4 Policy Reduction                 — implemented
M5 Verification v0.2                — implemented
M6 Continuation Simplification      — next
M7 Skill / Docs Prune
M8 Extension Composition
```

M6 is complete when deterministic continuation eligibility comes from the current SemanticSnapshot + public Pi runtime facts, the model sees only one thin latest-user-intent probe when semantic judgment is genuinely needed, and historical probes no longer accumulate as model policy.