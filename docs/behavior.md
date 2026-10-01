# Pindie v0.3 — Behavior Specification

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
Pindie Host
  → Pindie process lifecycle
  → active AgentSessionRuntime ownership/replacement
Pindie Harness / semantic layer
  → deterministic truth, legality, State, factual evidence/freshness
Model
  → intent interpretation, planning, semantic choice, verification meaning/coverage
Human
  → goals, taste, consequential judgment, approval
Pi
  → active AgentSession implementation, low-level Agent Loop, concrete tools,
    Skills, model/provider plumbing, compaction, retries, message delivery, InteractiveMode
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
policy.declare
policy.adapt

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
policy.declare
```

`policy.adapt` is a separate non-mutating control effect. It is admitted only for the Candidate tool during a live explicit `/adapt <strategy-id>` Run; it is not part of ordinary semantic Task capability sets.

Coherent capability states:

```text
idle
→ observe.project, observe.git, policy.declare, task.start

done / completed_before_run
→ observe.project, observe.git, policy.declare, task.start

done / completed_during_run
→ observe.project, observe.git, policy.declare

active
→ observe.project, observe.git, policy.declare, project.mutate,
  task.refine, task.progress, verification.record, gate.open
→ + task.replace iff preexisting_untouched
→ + task.complete iff completionReady

blocked
→ observe.project, observe.git, policy.declare, project.mutate,
  task.refine, task.progress, verification.record, gate.open
→ + task.replace iff preexisting_untouched
→ no task.complete

waiting_human / opened_during_run
→ observe.project, observe.git, policy.declare

waiting_human / existed_before_run
→ observe.project, observe.git, policy.declare, task.refine, gate.resolve
→ + task.replace iff preexisting_untouched
```

Questions may coexist with useful work but prevent completion. A Task-level blocker means the Task cannot currently be completed or proceed along its intended path, but a coherent Agent Run may still mutate the project to attempt recovery.

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

The Gateway remains defense in depth for races, stale already-generated calls, external-State changes, and same-Run semantic transitions. Candidate creation uses the separate non-mutating `policy.adapt` effect and still requires a live explicit `/adapt <strategy-id>` adaptation lease.

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

**Migration note:** Autonomous Learning v1 Slice 1 removed single-Run admission; Foundation F1 now keeps WorkEpisode identity outside State and stores factual schema-v5 Experience when coherently bound (v4 remains readable). A separate durable LearningJob ledger and F2 Host-owned idle/preemptible isolated Pi execution foundation exist, and D1 now performs non-LLM project-local discovery eligibility, freezes bounded packets and enqueues deduped jobs after committed Experience/startup/safe idle. D2 uses an isolated no-tool Pi model Run with an explicit frozen learning model identity independent of the Human Session and of any automatic startup fallback, persisting that exact provenance in terminal receipts/commits and reusing it on recovery, for bounded new-triggered project-discovery packets with reusable assessed Experience context; it accepts `none`, semantic `covered` against exact frozen open hypotheses, or bounded proposals, requires at least one new source for newly published cognition, protects unresolved hypothesis source Experience from pruning, and publishes bounded immutable untrusted hypotheses and exact terminal receipts, and recovers committed output without another model call. R0 has frozen legacy T1 automatic execution: production no longer prepares reservations/holds, claims T1 offers, creates T1 assignments/receipts, starts eligibility watchers, or runs T1 Session/Run fencing. R2 removes those obsolete execution modules while retaining frozen v1 readers. WorkEpisode identity/ledger, Local Discovery D1/D2, factual Run Experience v5 and legacy SI/CPL remain active; ordinary Task truth is unchanged; R2 optionally renders a one-shot experimental advisory only after a committed v2 assignment. Existing schema-v1 Trial artifacts are historical only and are not read by production Trial execution, modified, migrated or deleted. There is not yet a complete applied-Trial evidence/evaluation pipeline. R1 Executable Hypothesis v2 is complete. Old v1 hypotheses stay immutable/readable/non-executable with unchanged fingerprints and no automatic principle filling. All fresh Discovery uses packet v4 / selection v4 and mints only v2, with model-authored bounded principles included in semantic fingerprints; packet provenance is excluded. V4 comparisons explicitly distinguish v1 (principles=null) from v2; covered can assess new evidence only against an exact open v2 ref. Normal Discovery with new evidence may revise an exact v1 leaf into v2, preserving logical ID, kind and trusted base. Strict shared lineage projection exposes only leaves, fails closed on malformed/orphan/cyclic history and competing leaves, and limits open leaves to 64 without deleting parents. Experience protection retains full historical source provenance. Old v3 committed output recovers without model rerun, including receipt completion; uncommitted v3 jobs terminate stale. R2 TrialAssignment v2 + ordinary-work overlay is implemented. R3 TrialEvidence v2, Evaluation and autonomous trust remain pending.

R2 waits only for bounded local assignment I/O, never learning cognition. A coherent preexisting Task can receive an advisory on its first request after ordinary SI preparation; one authorized successful same-Run `task_start` can receive it on immediate continuation after State/WorkEpisode commit. Failed/null/ambiguous/stale/external-epoch/packet Runs skip it. Same-Run replacement never triggers placement and invalidates any old lease; the replacement may qualify next Run. Refine and context requests never schedule.

The advisory is UNTRUSTED / EXPERIMENTAL / ADVISORY, optional and transient, naming the exact role and selector. It does not enter the native Session branch. Rendering is consumed once even when a downstream transform removes it, but the exact selector stays available in the same valid ordinary Run. Explicit `pindie_policy_set` selection revalidates immutable assignment, executable open hypothesis, current lineage/trusted base and Session/Run/episode epochs, then records `trial` status with normal Policy declaration chronology. Seeds/promoted/manual SI/CPL selectors still use their established paths. No declaration means no selection; neither assignment, rendering nor selection is TrialEvidence or proof of causal use.

Committed episode assignments are not redelivered on later Runs, Sessions or restart, including ignored/crashed/unconfirmed offers. Timeouts/errors leave Human Task/tool results intact; a late commit remains in v2 attempt history but cannot revive an overlay. Unassigned episodes may retry next legal Run. SI disabled constructs/accesses no R2 store or request transform; CPL disabled still supports local R2. Assignment capacity/corruption fails closed for learning without deleting scheduling history. Exact hypothesis-v2 trial Experience uses the bounded ordinary recent window; full R3 evidence/retention gates are not present. Production latency/frequency/selection dogfood has not been measured.

## 7. Model-facing semantic tools and Tool Surface

Pindie exposes narrow semantic affordances:

```text
pindie_policy_set          → policy.declare
pindie_strategy_candidate_create → policy.adapt
pindie_strategy_derivation_candidate_create → policy.derive
pindie_strategy_synthesis_candidate_create → policy.derive
pindie_memory_capture      → memory.capture (configured Work Memory)
pindie_task_start          → task.start
pindie_task_replace        → task.replace
pindie_task_refine         → task.refine
pindie_task_progress       → task.progress
pindie_task_handoff        → task.progress (enabled Host rollover)
pindie_verification_record → verification.record
pindie_task_complete       → task.complete
pindie_gate_open           → gate.open
pindie_gate_resolve        → gate.resolve
pindie_git_observe         → observe.git
```

Internal reducer events remain independent of Pi tool names.

Task lifecycle:

- `task.start` establishes a new Task when idle (no current Task) or after a completed Task.
- `task.replace` supersedes a different unfinished current Task; a completed Task is terminal and is never replaced.
- A follow-up question, inspecting an old result, or discussing a completed Task does not by itself require starting a new durable Task.
- If the Gateway denies `task.replace` because there is no unfinished Task, its factual denial guides the model toward the legal `pindie_task_start` recovery action; it does not execute that action automatically.

For each actual Agent Run:

Pi's active Tool Surface remains unchanged as Pindie semantic State changes. Tool visibility is not authorization. The Execution Gateway derives current capabilities and authorizes each concrete tool call at preflight; unknown/custom tools remain conservative project mutations.

## 8. Knowledge Surface and prompt behavior

Pindie appends a deterministic System Contract to Pi's already-chained system prompt from `before_agent_start` and returns a hidden `pindie-run-baseline` custom message containing the authoritative Run-start facts.

The Run Baseline is hidden factual Knowledge Surface driven by `SemanticSnapshot`. It may show:

- coherent/stale/unavailable Run authority;
- Task and verification status;
- current Task contract/open loops;
- verification records;
- Human Gate details;
- factual unavailability reason.

It also includes the current action-eligibility affordance derived from the same capabilities used by the Gateway. This tells the model which Pindie actions are currently eligible while preserving the Gateway as final authority; the block is refreshed only in the Run Baseline and at causal State transitions that change capabilities.

It must not restate structural legality as lifecycle instructions.

Prior history is never filtered, reordered, or rewritten. State-changing semantic tool results and mutation invalidation updates append current facts at their causal location; continuation probes remain in history until normal Pi compaction. Successful Pi compaction appends one hidden Pindie State Checkpoint with exact current State, Run authority, eligibility, and any current Run-scoped Policy Snapshot. Failed or aborted compaction does not emit one.

Run Baseline and State Checkpoint contain the full Task and verification projection, including materialized evidence. Normal semantic results append only the causal delta needed for that transition, so verification evidence is not duplicated in every later Task, progress, verification, or Gate result.

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
→ observation + policy declaration capability space

Gate existed before current user-driven Run
→ observation + policy declaration + gate.resolve + any other legal Task-boundary choices
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

If eligible, Pindie marks the continuation attempt and returns exactly one hidden `custom_message` draft with `continue: true` at Pi's `agent_before_settle` boundary. Pi performs the next provider request in the same Agent Run, without another `before_agent_start`.

The probe identifies itself as runtime-generated metadata, not user intent and not a new request. It asks only whether the latest actual user intent still calls for consequential execution. It does not teach Task/Gate/blocker/verification/completion procedures.

The one-probe fuse is runtime-only. A fresh user-driven `before_agent_start` resets it; the boundary continuation does not.

Pi owns retry, compaction, follow-up delivery, and final `agent_settled`. Pindie does not access or infer private retry state and does not create a second loop.

Continuation context hygiene:

- historical Pindie continuation probes remain in model/session history;
- Pindie does not filter or reorder prior probes;
- normal Pi compaction handles history growth;
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

## 14. Quota Recovery

A terminal Codex quota error requires one fresh subscription usage confirmation
of an exhausted supported window. Recovery tries **Fallback → Quota Auto Resume
→ ordinary stopped semantics** in order; one incident commits at most one
automatic successor. Both paths preserve the same Session and Task. Reset
credits are never automatically consumed.

### Quota Fallback

`/quota-fallback` opts into the fixed pay-as-you-go DeepSeek V4.1 Flash backup
(`deepseek/deepseek-flash`); the default is **OFF**. Enter saves only the current
Session's branch-local preference; the configured save binding (Ctrl+S by
default) saves the Global default and appends the choice to the current Session.
Turning ON requires Pi to find the exact model with provider authentication
before either preference changes. Turning OFF requires no auth and does not
interrupt an already committed fallback. API keys remain Pi-owned.

When authorized and available, fallback changes the current Session model and
starts one hidden continuation immediately. Pi clamps the preserved thinking
level for the backup. Ordinary input continues on DeepSeek without cancelling
the lease; explicit model selection takes ownership and prevents automatic
restore. Branch changes and Session replacement cancel the lease. Reaching the
quota recovery time (reset plus grace) never interrupts active work: the Host
restores Codex at safe idle, reapplies the source thinking level, and sends no
new Agent turn. If the backup Run ends with a provider error before recovery,
the Host can restore Codex and hand the original quota anchor to Resume. A
process restart loses the runtime-only lease; Pindie does not infer a source
model or auto-restore from transcript history. Pi InteractiveMode shows the
actual active model; successful switch/restore are quiet.

### Quota Auto Resume

`/quota-resume` defaults **ON**. Enter changes the current Session; the save
binding changes both Global default and current Session. If fallback is OFF or
cannot commit, Resume waits on a Host-owned runtime-only lease after fresh
quota confirmation. Presentation shows `waiting · quota` only for that real
lease. Human input, model selection, branch changes, and Session lifecycle
changes cancel waiting; process exit loses it. At wake, Pi receives a hidden
custom resume with `triggerTurn: true`, starting a fresh Agent Run in the same
Session. The hidden message is runtime metadata, not user intent.

## 15. Global behavioral invariants

1. Pindie keeps one durable current Task, not a queue or workflow graph.
2. Deterministic legality comes from semantic derivation, not model memory of rules.
3. Model-visible action space and Gateway authorization derive from the same capability truth.
4. The model retains semantic interpretation and choice inside that legal space.
5. Human judgment is explicit where required.
6. Verification factual provenance/freshness belongs to Harness; meaning/coverage belongs to Model.
7. Runtime evidence refs, generations, Run relations, and continuation fuses are ephemeral.
8. Reducer invariants remain valid even if the outer Gateway layer fails.
9. Historical runtime metadata remains append-only until normal Pi compaction; it does not rewrite prior model history.
10. Pi remains the sole low-level Agent Loop and Skill runtime.
11. Strategy Revision Candidates are inactive hypotheses; only explicit `/adapt <strategy-id>` may create one, and it never becomes active Policy in SI v0.5.
