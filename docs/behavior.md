# Pindie v0.3 — Behavior Specification

This document defines the current semantic and behavioral contract: what Pindie means and guarantees now.

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

Core capabilities are `observe.project`, `observe.git`, `project.mutate`, `task.start/refine/replace/progress/complete`, `verification.record`, and `gate.open/resolve`. Optional Memory adds its existing capture capability only when selected.

Stale/unavailable Run authority permits observation only. Coherent states:

```text
idle / done before Run → observation + task.start
done during Run        → observation only
active / blocked       → observation + project.mutate + task.refine/progress
                         + verification.record + gate.open
                       → + task.replace iff preexisting_untouched
active                 → + task.complete iff completionReady
blocked                → no task.complete
waiting_human / opened_during_run → observation only
waiting_human / existed_before_run → observation + task.refine + gate.resolve
                                   + task.replace iff preexisting_untouched
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

The Gateway remains defense in depth for races, stale already-generated calls, external-State changes, and same-Run semantic transitions. Unsupported semantic calls remain denied even when present in a captured tool baseline.

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

Prior history is never filtered, reordered, or rewritten. State-changing semantic tool results and mutation invalidation updates append current facts at their causal location; continuation probes remain in history until normal Pi compaction. Successful Pi compaction appends one hidden Pindie State Checkpoint with exact current State, Run authority, eligibility. Failed or aborted compaction does not emit one.

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
→ observation capability space

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

Activity, Run Timer, Run Cost, status presentation, and subscription usage observation are runtime-only. They must not become persisted semantic State or independent correctness authorities. Automatic thinking-level selection and `/reasoning` auto/manual toggling are retired. Use Pi's native explicit model/thinking controls or Control's safe-idle configure operation; Pi's native model/thinking display and `/efficiency` report the effective level. Pindie's own status strip does not duplicate or reserve space for that level. Quota resume and opt-in fallback's temporary model recovery and source thinking restore are unchanged.

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
11. Reserved unsupported Pindie semantic tool names are denied because their required capabilities are unavailable. Other unrecognized/custom tool calls are treated as ambiguous project mutations and require current `project.mutate` authorization.
