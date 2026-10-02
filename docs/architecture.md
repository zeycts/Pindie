# Pindie Architecture v0.3

## 1. Purpose and ownership

Pindie is a personal Agent Operating System for indie development. Pi is its current low-level execution runtime, not the owner of Pindie's process or active-session lifecycle. Pindie Host owns that lifecycle; the existing semantic integration remains extension-hosted without changing existing semantic behavior.

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie Host → process lifecycle, active AgentSessionRuntime ownership/replacement
Pindie      → durable semantic truth, legality, capability, factual evidence/freshness
Pi          → active AgentSession implementation, LLM execution, concrete tools, Skills,
              low-level Agent Loop, model/provider plumbing, compaction, InteractiveMode
```

Pindie should eliminate meaningless choices, not meaningful choices.

Pindie does not add a second Agent Loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, verification-log database, universal shell parser, or second Skill runtime.

## 2. Semantic center

```text
Reality
  ↓
Persistent State + runtime-only Run Facts
  ↓
Semantic Snapshot
  ↓
Capabilities
  ├─────────────────────────┐
  ↓                         ↓
Knowledge              Authorization
Surface                     │
  ↓                         │
 LLM ← Pi tool baseline      │
  ↓                         │
semantic choice             │
  └──────────┬──────────────┘
             ↓
      Execution Gateway
                          ↓
                       Reducer
                          ↓
                         Pi
                          ↓
                       Reality
```

The semantic source of truth is deliberately small:

```text
PindieState + SemanticRunFacts
        ↓
deriveSemanticSnapshot()
        ↓
deriveCapabilities()
```

Concrete tool semantics remain separate:

```text
Tool Call
  ↓
classifyToolEffect()
  ↓
required capability + project mutation effect

Capabilities + Tool Effect
  ↓
authorizeToolEffect()
```

Harness code closes deterministic branches. The model chooses among the remaining semantically meaningful actions.

## 3. Durable State and runtime facts

`PindieState` stores one durable current Task or `null`:

```text
PindieState
└── task | null
    ├── goal
    ├── constraints
    ├── successCriteria
    ├── openLoops
    ├── verification
    ├── humanGate
    └── completed
```

Task/verification statuses are derived. Capabilities, active tools, Run authority, presentation state, reasoning state, continuation fuses, Git fingerprints, recent evidence refs, evidence generations, and workflow phases are never persisted.

The reducer owns hard State invariants and consumes semantic `PindieEvent`s, not Pi tool names. Runtime owns project-scoped load/save, authoritative refresh, locking, external-State conflict detection, reducer dispatch, and save-before-publish.

Run-boundary legality uses runtime-only relationships:

```text
TaskRunRelation       none | preexisting_untouched | preexisting_changed | introduced_during_run
CompletionRunRelation not_completed | completed_before_run | completed_during_run
GateRunRelation       none | existed_before_run | opened_during_run
```

Run-start object identity is only a coherent-Run immutable-State change detector. It is never persistent Task identity.

**Migration note:** Autonomous Learning v1 Slice 1 removed single-Run admission. Foundation F1 adds a project-local operational WorkEpisode binding outside State, schema-v5 Experience attribution (v4 remains readable), and a separate bounded user-global LearningJob ledger. F2 adds Host-owned fenced idle scheduling, durable conservative budgets, Human preemption and an isolated Pi learning Session factory with no tools or discovered resources. Local Discovery D1 now enqueues project-discovery from persisted eligible v5 Experience at startup, after committed Experience, and on safe idle; strict bounded project-local packets and terminal receipts live under each project's `learning-v1/` directory. D2 registers one project-discovery handler for isolated no-tool model JSON responses (`none`, semantic `covered` against exact frozen open hypotheses, or bounded proposals), exact packet v4 / selection v4 comparison with trusted revisions and current open hypothesis leaves, new-triggered Experience plus bounded reusable assessed context, immutable project-local hypothesis batches and receipt recovery; the isolated learning model identity is an explicit frozen policy rather than the mutable Human Session model or an automatic startup fallback, with exact model provenance persisted in terminal receipts/commits and reused on recovery, Experience maintenance protects exact source records required by the full immutable v1/v2 hypothesis history and refuses pruning on a malformed hypothesis store without failing the committed save, and the open-hypothesis catalog is bounded separately from immutable commit history. R0 has frozen legacy T1 automatic execution: production no longer prepares reservations/holds, claims T1 offers, creates T1 assignments/receipts, starts eligibility watchers, or runs T1 Session/Run fencing. R2 removes the obsolete reservation/watcher/preflight implementation; frozen v1 contract and history readers remain. WorkEpisode identity/ledger, Local Discovery D1/D2, factual Run Experience v5 and legacy SI/CPL remain active; ordinary Task truth remains unchanged. R2 can add one optional experimental advisory only after a committed v2 assignment. Existing schema-v1 Trial artifacts are historical only and are not read by production Trial execution, modified, migrated or deleted. There is not yet a complete applied-Trial evidence/evaluation pipeline. R1 Executable Hypothesis v2 is complete: v1 remains immutable/readable/non-executable with unchanged semantic fingerprints; v2 adds bounded model-authored principles included in semantic identity, while packet provenance remains excluded. Discovery v4 distinguishes v1 (principles=null) and v2 in its frozen comparison and permits covered only against exact open v2. A v1 leaf may acquire a v2 revise child only through normal Discovery with new evidence. Shared strict exact-parent lineage projection closes historical parents, retains competing leaves fail closed, and caps open leaves rather than history. Old v3 committed output (including missing receipt) recovers without another model call; uncommitted v3 is stale. The commit wrapper remains schema 2 and Experience protection reads full history. R2 TrialAssignment v2 + ordinary-work overlay is implemented; R3 immutable TrialEvidence v2 and retention are implemented; Evaluation and autonomous trust remain pending.

R2 assembles only under SI-enabled extension composition (both standalone extension and Host), independently of CPL, using resolved storageRoots. `trial-assignment-v2.ts` owns strict immutable episode-keyed v2 history under `learning-v1/trial-assignments-v2/`, with a filesystem project assignment writer lock across history→current open/trust projection→fairness selection→unique publication. Only committed v2 assignments count (exact hypothesis attempts, cooldown, count/oldest/fingerprint/id fairness); history is capped at 2048 records of <=16KiB each, with no pruning or legacy history accounting. No candidate creates no durable record.

Placement occurs after SI preparation excludes all packet leases: before the first request of a preexisting coherent episode, or in awaited authorized successful `task.start` tool-result after State/ledger commit for one introduced occurrence. Read-only Core binding accessors and captured admission/occurrence/external epochs fence placement. `task.replace` gets no same-Run placement; whole-Run F1 attribution remains unchanged.

`ordinary-trial-overlay.ts` holds a runtime-only native Session/Run/episode/epoch lease and one-shot rendering flag. The synchronous `context_with_system` transform adds bounded UNTRUSTED/EXPERIMENTAL/ADVISORY guidance without transcript writes or request-time I/O; consuming rendering does not expire selection. Assembly composes its exact fresh resolver with SI/CPL/promoted resolution; invalid owned identities cannot fall back. Valid v2 hypothesis semantics mechanically become an exact `trial` Policy revision through existing `pindie_policy_set`, preserving ordinary declaration telemetry and v5 Experience. Exact hypothesis-v2 trial records enter the ordinary recent Experience retention window, not legacy manual Trial retirement; R3 protects exact unmaterialized support until immutable evidence exists.

A single `runBoundedOperation` deadline covers scheduling and activation validation (default 100ms, policy cap 1000ms). Cooperative abort/authority checks fence publication; filesystem locks remain held until actual I/O ends after caller timeout. A native unique-link commit may have won before cancellation: that assignment remains scheduling history, but unconfirmed late completion never installs an overlay. Fresh selector reads are separately bounded and recheck runtime binding afterward. Diagnostics are bounded runtime callbacks/warnings, not a database. There is no provider-delivery observer or production dogfood claim.

R3 freezes the active exact R2 assignment before clearing its runtime lease at settlement. The existing SI observer saves ordinary Experience first, then uses its exact committed ref in a narrow callback. `trial-evidence-v2.ts` requires coherent v5 WorkEpisode attribution, exact final `trial` Policy in the assigned role and positive post-last-declaration ordinary execution. Assembly re-resolves immutable assignment/hypothesis/source and fences abort/generation at publication. `FileRunExperienceStore.save()` returns the exact committed ref/fingerprint; legacy void-returning custom sinks cannot create evidence. No rendering/provider observation is required and no causal use is asserted.

Immutable v2 records live in `learning-v1/trial-evidence-v2/`, separate from frozen v1, with schema-1 ref envelopes, source-UUID identity, canonical content digest and filesystem-locked unique-link publication (4096 records, <=16KiB each). They copy only exact links, episode/time, selected role/revision, post-declaration counters, factual outcome/verification/errors/cost and comparison refs—not goals, transcripts, reasoning, eligibility or verdicts. Exact retries return the same record; conflicts/corruption/stale authority fail closed without altering Human work. Maintenance validates full histories before deletion, protects unmaterialized exact trial support and live comparisons, and permits an exact materialized raw source to expire from the unchanged ordinary window. Missing/changed bindings refuse pruning; frozen v1 and unresolved hypothesis sources retain their existing protection. A crash before publication leaves protected raw support rather than inferring a new placement. [R4-A Evaluation foundation](autonomous-learning-r4-a.md) adds pure strict EvaluationPacket v1 / EvaluationResult v1 contracts and binding validators only. Dedicated exact refs cannot enter frozen trust/job contracts; immutable TrialEvidence v2 snapshots are the sole factual analysis inputs, with raw source/comparison refs treated as provenance only. No live Experience read, artifact store, model handler, scheduler hook or Trust/Decision/Policy write is added. [R4-B](autonomous-learning-r4-b.md) adds a standalone read-only packet builder over immutable exact hypothesis/evidence readers, with identity eligibility, deterministic included-first bounds, content-derived packet identity and deep-frozen validated snapshots. [R4-C1](autonomous-learning-r4-c1.md) adds a standalone immutable packet store in `learning-v1/evaluation-packets-v1/`, preserving exact packet identity/digest inside a strict timestamp envelope, source-revalidated namespace-locked unique publication, fail-closed frozen lookup and lifecycle metadata. [R4-C2](autonomous-learning-r4-c2.md) adds a standalone EvaluationRun v1 record/store in `learning-v1/evaluation-runs-v1/`: exact packet binding, immutable per-state snapshots and fail-closed lifecycle projection under the existing namespace writer lock. It has only an exact packet read capability and writes no semantic/runtime stores. [R4-C3-A](autonomous-learning-r4-c3-a.md) adds pure versioned Evaluator/context/output contracts, exact binding validators and detached deeply frozen input preparation; context exposes no mutation capabilities and output contains only observations/diagnostics and execution identity/metadata, not verdicts or scores. This contract boundary is not a sandbox for arbitrary implementations. [R4-C3-B1](autonomous-learning-r4-c3-b1.md) adds standalone registered evaluator invocation with exact packet/output validation, frozen capability-free inputs and in-memory running/terminal outcomes through existing lifecycle helpers. It publishes no artifacts and adds no real evaluator, production wiring or retention/deletion. Durable orchestration, runtime sandboxing, production Evaluation execution/trust and dogfood remain pending.

## 4. Capabilities and execution authority

Capability vocabulary:

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

Ordinary Task/verification/Gate capabilities are pure derived authority and are never persisted. Candidate creation uses runtime-only `policy.adapt` or `policy.derive` control authority bound to the corresponding explicit legacy SI/CPL Run; it is not persisted as Task State.

Important capability consequences:

```text
policy.declare            → always available; non-mutating
unavailable/stale authority → observation + policy declaration
idle                       → observation + policy declaration + task.start
done before Run            → observation + policy declaration + task.start
done during Run            → observation + policy declaration
blocked                   → no project.mutate, no task.complete
same-Run-opened Gate      → observation + policy declaration
task.complete             → only when completionReady
```

The live Gateway authorizes every non-observation call through current capabilities after authoritative refresh/coherence checks. Reducer and Runtime remain deeper integrity backstops.

## 5. Tool Effects and Project Mutation Freshness

Concrete Tool Effects connect Pi tools to semantic authority:

```text
read / grep / find / ls → observe.project / mutation none
pindie_git_observe      → observe.git / mutation none
edit / write            → project.mutate / mutation known
bash / unknown/custom   → project.mutate / mutation ambiguous
semantic Pindie tool    → exact semantic capability / mutation none
strategy Candidate tools → policy.adapt or policy.derive / mutation none (matching Run lease only)
Work Memory tool        → memory.capture / mutation none
```

Unknown/custom tools are conservative. Generic shell commands are not parsed into read-only exceptions.

Project Mutation Freshness uses the same effect taxonomy:

```text
mutation none      → no project-mutation observation
mutation known     → successful mutation invalidates prior verification
mutation ambiguous → compare project Reality before/after execution
```

Denied calls create no mutation observation. Failed ambiguous tools are still observed afterward because partial mutation may have occurred.

## 6. Model Tool Surface and Gateway

Model-facing Pindie semantic tools are narrow capability-shaped adapters:

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

Internal reducer events remain tool-agnostic.

Pi owns the active model Tool Surface. Pindie does not narrow, expand, capture, or restore that surface as semantic State changes. A currently unauthorized tool may remain visible to the model; visibility is not authorization.

The Gateway remains authoritative for every consequential call, including races, stale pre-generated calls, and calls generated before a same-Run semantic change. It derives current capabilities from the current semantic Snapshot and blocks or allows the concrete effect at execution time. Candidate creation is a separate non-project-mutating `policy.adapt` or `policy.derive` control effect and requires the matching live Run lease.

## 7. Knowledge Surface and prompt ownership

Pindie appends a deterministic static System Contract to Pi's already-chained system prompt in `before_agent_start`. The contract contains runtime authority, Gateway, Task, verification, Human Gate, append-only update, policy, and Seed Strategy semantics; it does not contain the current Policy Snapshot.

The same `SemanticSnapshot` used by capabilities produces a hidden Run Baseline message at Agent Run start. It may report:

- coherent/stale/unavailable Run authority;
- Task and verification status;
- current Task contract and open loops;
- current verification records;
- Human Gate details;
- factual unavailability reason.

The same projection includes a compact Current Pindie Action Eligibility block. It is derived directly from the current capabilities and is an affordance for the model, not authorization; the Gateway still makes the final call-boundary decision. It appears in the Run Baseline and in causal semantic State results when the capability set changes.

Pi compaction is an intentional request reset boundary. After a successful `session_compact`, Pindie appends one hidden State Checkpoint containing the exact current authoritative State, Run authority, eligibility, and any current Run-scoped Policy Snapshot. Overflow recovery queues that checkpoint before its retry when Pi exposes that continuation; failed or aborted compaction emits no checkpoint. Pindie does not depend on Pi's generic compaction summary to preserve semantic State and does not create an extra model turn solely for the checkpoint.

It must not restate structural legality as procedural lifecycle instructions. Later semantic tool results and runtime updates carry current state at their causal location.

The full Task projection is reserved for Run Baseline and post-compaction State Checkpoint synchronization boundaries. Ordinary semantic results use focused causal projections: Task Contract changes, open-loop changes, verification check metadata plus aggregate coverage, or Human Gate changes. They do not copy unrelated materialized verification evidence already present in the transcript.

```text
PindieState + SemanticRunFacts
        ↓
SemanticSnapshot
        ├→ Capabilities → Execution Gateway
        └→ Run Baseline + causal State updates
```

Natural-language policy is a last resort, not a source of deterministic correctness.

## 8. Verification evidence ownership

Durable verification keeps the compact State shape:

```text
VerificationCheck
├── name
├── status: passed | failed
├── covers: criterion ids[]
└── evidence: string
```

Evidence provenance/freshness is Harness-owned while semantic interpretation remains model-owned:

```text
Actual Pi tool execution
        ↓
Harness observes factual result
        ↓
Recent factual Evidence Candidate
        ↓
Model selects current evidence refs
and judges status + criterion coverage
        ↓
Harness materializes bounded factual evidence
        ↓
Existing VerificationCheck
        ↓
Reducer / State
```

Runtime evidence refs are short Pindie-owned opaque handles (`ev:<scope>:<sequence>`), exist only within the current evidence scope, and are never persisted. Pi tool-call identity remains runtime-internal candidate provenance. Selected evidence is deterministically bounded and hashed before being materialized into the existing durable `evidence` string.

A runtime-only evidence generation prevents late/parallel results from crossing a changed verification basis. Project Mutation Freshness runs before evidence capture for ambiguous tools; mutating or unknown ambiguous results therefore cannot become current evidence.

Existing legacy `evidence: string` State remains valid without migration.

## 9. Human authority

A Human Gate is an explicit authority boundary.

A Gate opened during the current Run produces observation-only capability space until new human input. A Gate that existed before the current user-driven Run may expose `gate.resolve` and any other legal Task-boundary choices. The model interprets the human reply within that legal space.

Human Gate lifecycle legality is encoded structurally; tool descriptions and global prompts do not duplicate it.

## 10. Continuation

Continuation intentionally retains one model-owned semantic judgment after deterministic branches are closed.

Deterministic eligibility is:

```text
snapshot.authority == coherent
snapshot.taskStatus == active
probe not already attempted
no pending Pi messages
final assistant stopReason == stop
```

`taskStatus == active` already closes idle, completed, blocked, and waiting-human branches. Continuation code does not independently re-read those Task fields.

When eligible, Pindie appends at most one hidden Pi-native boundary probe asking only whether the latest actual user intent still calls for consequential execution. The probe explicitly identifies itself as runtime-generated metadata, not user intent and not a new request.

The model may then choose any currently visible/legal action or return control. Tool Surface and Gateway own legality; the probe does not teach lifecycle rules or tool sequences.

Delivery stays inside Pi's native lifecycle:

```text
agent_before_settle
→ deterministic eligibility
→ one hidden custom_message boundary draft at most + continue: true
→ Pi performs one next provider request in the same Agent Run
→ agent_settled after automatic work is exhausted
```

Pindie uses only Pi's public extension contract. It does not infer private retry state, call the model directly, recurse, or create another loop.

Historical continuation probes remain in session/model history. Pindie does not filter or reorder them; normal Pi compaction handles history growth.

## 11. Runtime-only presentation, reasoning, and external projection

Activity, Run Timer, Run Cost, status presentation, subscription usage observation, and adaptive reasoning are runtime-only systems. They may present or tune execution but are not semantic State.

Run Activity follows actual Pi tool lifecycle rather than model-authored status. Status presentation consumes authoritative/derived runtime facts rather than becoming an independent source of truth.

Run Timer and Run Cost remain one-Run telemetry for Experience, evaluation, and diagnostics. For Task-owned execution, a process-local Host-owned Task metrics accumulator presents cumulative active Run time and model-equivalent cost across legitimate automatic Session rollover; no-Task execution presents only current/latest Run consumption. Task metrics are not persisted and restart from zero after a process restart.

Remote Companion is an optional external projection/control surface over the same live Pi Session and existing Pindie facts. It must not create another Agent, Session, message queue, or semantic truth. The canonical Project maps to a Discord channel for navigation, and the native Pi Session ID maps to a Discord thread for readable Session history and remote input. Discord is a replica/control surface; Pi Session history remains conversation truth and `PindieState` remains semantic truth.

The only durable Remote data is external routing/delivery metadata (for example Project→channel, Pi Session→thread, and a delivery cursor) stored outside `PindieState`. Remote input uses Pi-native user-message, steer, follow-up, and current-context abort boundaries. Historical Discord threads never implicitly switch the active local Pi Session. See `docs/remote-companion.md` for the authoritative Remote Companion contract.

## 12. Skills

Pi is the only Skill runtime. Pindie may bundle procedural Skills, but a Skill must not become another semantic authority layer.

A Skill may describe a reusable procedure such as Git delivery. It must not duplicate Task admission, capability legality, verification authority, Human Gate lifecycle, or completion rules already enforced by the Harness.

## 13. Runtime Independence v0.1 — implemented ownership inversion

Runtime Independence v0.1 changes who owns Pindie's process and active Agent Session lifecycle without changing Task, State, semantic authority, Gateway, Verification, Policy, Experience, Self-Improvement, Remote, or ordinary user-visible behavior.

The current relationship is:

```text
Pindie Host
        ↓
Pi Runtime Adapter + InteractiveMode
        ↓
Pi AgentSessionRuntime
        ↓
Pindie extension
        ↓
Pindie semantic/runtime modules
```

The implemented v0.1 topology is:

```text
Pindie Host
    │
    ├── Pi Runtime Adapter
    │       ↓
    │   Pi AgentSessionRuntime
    │       ├── active AgentSession
    │       ├── low-level Agent Loop
    │       └── tools / Skills / compaction
    │
    └── Pi InteractiveMode
            └── uses and rebinds to the same AgentSessionRuntime

Existing Pindie extension + semantic modules
remain loaded by the Pi runtime as the semantic integration
```

The ownership inversion is deliberately narrow:

```text
Before: Pi starts Pindie.
After:  Pindie starts and owns a Pi runtime.
```

It is ownership independence, not implementation independence. Pindie continues to reuse Pi for model/provider plumbing, tool execution, Skills, active AgentSession mechanics, compaction, streaming, and TUI primitives rather than rebuilding a coding-agent harness.

### Pindie Host ownership

With v0.1 complete, the Host is the stable top-level process/runtime owner. It owns only lifecycle concerns required above any individual Pi Session:

```text
Pindie Host
├── process startup / shutdown
├── canonical working directory / project runtime bootstrap
├── one active Pi AgentSessionRuntime
├── active-session replacement authority
└── stable access to the Pi Runtime Adapter
```

The Host does not own semantic problem solving. It does not plan Tasks, select work phases, judge Verification, synthesize Policy, or run a second LLM loop.

`PindieState` remains semantic authority. A Host failure must not reinterpret durable Task truth.

### Pi Runtime Adapter

Pindie-owned code must not spread Pi session/runtime lifecycle calls across domain modules. Runtime Independence v0.1 introduces one thin boundary whose conceptual primitives are no larger than the real needs demonstrated by Pi's public SDK:

```text
create / bootstrap active runtime
get active session
prompt / steer / follow-up through the active session
observe active-session events and context usage
replace with a fresh session
shutdown / dispose
```

Exact names should follow the implementation that best fits Pi 0.84.4. The abstraction must not invent speculative multi-backend features, generic orchestration APIs, provider abstractions, or a universal Agent interface.

Pi's public `createAgentSessionRuntime()` / `AgentSessionRuntime` is the natural implementation boundary because it already owns active-session replacement and recreates cwd-bound runtime state. Pi's public `InteractiveMode` takes that runtime and handles TUI rebinding around session replacement, so Pindie can reuse the existing interactive product rather than rewrite it.

### Existing extension integration

Runtime Independence v0.1 does not require moving the existing semantic implementation out of `src/extension.ts`. The ownership inversion is implemented while semantic integration remains extension-hosted.

The current integration shape is:

```text
Pindie Host
    ↓
Pi Runtime Adapter + InteractiveMode
    ↓
Pi AgentSessionRuntime loads existing Pindie extension
    ↓
existing State / Gateway / Policy / Experience behavior
```

This keeps the Host/runtime ownership boundary above the already-tested extension integration. Later code ownership may move only when a concrete capability demonstrates that the extension boundary is the wrong home.

Therefore file/folder reorganization is not a v0.1 success criterion.

### Compatibility result

Runtime Independence v0.1 is successful when starting Pindie directly produces effectively the same current interactive product while Pindie, rather than an external Pi CLI process, owns the active `AgentSessionRuntime`.

The current user path is:

```text
pindie
  ↓
Pindie Host
  ├── creates/owns Pi AgentSessionRuntime through the adapter
  └── launches Pi InteractiveMode with that same runtime
          ↓
existing Pindie extension behavior
```

Existing Pi/Pindie semantics remain intact: project State loading, model/tool execution, system-contract injection, Run Experience, Self-Improvement, `/reload` behavior where applicable, compaction checkpoints, Remote projection, and shutdown correctness must not silently diverge.

### Implementation slices

Runtime Independence v0.1 is one architecture milestone implemented as small reviewable slices.

```text
Slice A — Host Bootstrap
Pindie entrypoint
→ create Pi runtime programmatically
→ load existing Pindie resources/extension
→ launch Pi InteractiveMode with that runtime
→ prove Pindie can start the same interactive product

Slice B — Runtime Ownership
Host owns the active AgentSessionRuntime
→ isolate the thin Pi Runtime Adapter
→ expose only demonstrated lifecycle primitives
→ prove Pindie can replace/dispose the active Session programmatically

Slice C — Compatibility Closure
exercise existing Pindie behavior through the Host-owned runtime
→ close lifecycle/reload/Remote/shutdown regressions
→ update current behavior docs only after the new ownership is real
```

Each slice must be independently reviewable. A slice must not opportunistically implement Long Task Runtime, automatic context rollover, new memory, multi-agent scheduling, model routing, or SI v0.6.

### What v0.1 unlocks

Runtime Independence v0.1 established the missing ownership primitive:

```text
Pindie can own and replace the active Agent Session
```

Long Task Runtime v0.1 now uses that boundary as a Pindie-owned lifecycle
scheduler rather than extension callback choreography. Its implemented,
dogfooded, compatibility-closed, and frozen contract is documented in
[`docs/long-task-runtime.md`](./long-task-runtime.md). Self-Improvement can
likewise create purpose-specific Agent executions later without pretending
every execution must be initiated by an externally owned Session.

### Quota Recovery v0.1

On a confirmed terminal Codex subscription quota incident, the Extension derives
one fresh `CodexQuotaRecoveryFacts` snapshot (the recovery time includes reset
grace) and arbitrates **Fallback → Quota Auto Resume → stopped**. The Human
opts into paid fallback with `/quota-fallback` (OFF by default). Fallback changes
the same Session's backend to Pi's fixed `deepseek/deepseek-flash` and starts one
hidden continuation immediately; Resume keeps Codex and starts a fresh Run only
after reset. A committed fallback never also schedules Resume. Neither changes
the Task, transcript ownership, or Pindie semantic State.

The Host owns a process-local `QuotaFallbackSupervisor` lease, switch/restore
timer and model-mutation guard; Pi owns the model catalog, authentication,
`setModel`, thinking-level clamping and Agent Loop. Source thinking is reapplied
through Pi. Restore waits for safe idle and sends no new turn. External model
selection or Session/branch replacement drops ownership; ordinary input does
not. A terminal DeepSeek provider error can restore Codex and enter Resume using
the exact historical Codex quota anchor, without another usage refresh or a
third provider. Pi 0.86.1 materializes provider/Run exceptions as terminal
assistant errors and emits `agent_settled` after draining pending messages, so
no second failure bus is needed. Process exit loses the fallback lease; no
source model is inferred on restart. Pi InteractiveMode already shows the actual
active model; successful switch and restore remain quiet.

Quota Auto Resume crosses a subscription-availability boundary without changing
semantic State or Session identity:

```text
Extension incident planning
→ process-local control bridge
→ Host-owned QuotaResumeSupervisor waiting lease/timer
→ Pi sendCustomMessage(..., { triggerTurn: true })
→ same Session, fresh later Agent Run
```

The Extension identifies a terminal `openai-codex` quota candidate and confirms
a fresh exhausted subscription window. The Host/Supervisor alone owns the real
waiting lease and timer, and publishes a runtime-only waiting status back to
Presentation. That status is never `PindieState`, Experience, TaskContinuity,
or durable Session semantic state. Pi owns the resumed Agent Run. Human input,
model or branch changes, and Session lifecycle boundaries cancel the pending
lease; process exit loses it. Reset credits are never automatically consumed.

The three continuation mechanisms have distinct boundaries:

- **Continuation Probe:** normal stop → semantic follow-up inside Pi's current
  lifecycle.
- **Long Task Runtime:** Session/context lifetime boundary → fresh Session.
- **Quota Fallback:** authorized temporary backend change → same Session,
  immediate fresh Agent Run.
- **Quota Auto Resume:** subscription availability boundary → same Session,
  later fresh Agent Run.

### Browser Reality v0.1.3

Browser Reality is a default-on, headless-by-default external development
surface, not semantic State. `PINDIE_BROWSER_HEADLESS=false` is the minimal
headful debugging override. Each Host owns only the dedicated
`Pindie Dev Browser` process it starts, with a loopback-only endpoint and
isolated runtime profile; Hosts do not share or attach to an existing browser.
A small platform boundary preserves the existing WSL lifecycle through Windows
Chrome and PowerShell, while native Linux launches a local Chrome/Chromium
process (normally headless). Linux requires a supported Chrome/Chromium
executable, discovered from `PATH` or explicitly selected with
`PINDIE_BROWSER_EXECUTABLE`. A small Pi extension adapter exposes selected
official Chrome DevTools MCP tools through Pi's concrete Tool Surface. Pindie's
existing unknown/custom Tool Effect classification and Execution Gateway remain
the execution authority.

```text
Dedicated Windows Chrome (WSL) or local Chrome/Chromium (Linux)
        ↓ loopback-only official Chrome DevTools MCP
Pi browser_* concrete tools
        ↓ existing Pindie Gateway
Model
```

Browser availability, page selection, DOM snapshots, screenshots, Console and
Network observations are never written to `PindieState`. Bridge/session cleanup
follows Pi extension lifecycle; owned Chrome and runtime-profile cleanup follows
Host lifecycle. Disabled or unavailable Browser Reality does not alter Task
truth or prevent ordinary Pindie startup.

## 14. Work Memory v0.1 — approved architecture

Work Memory is an external durable work-memory projection shared with other AI work surfaces. It preserves only high-value durable state changes that would otherwise be costly to reconstruct later. It is not `PindieState`, Task continuity, Run Experience, Session history, a second memory database, or another workflow engine.

The v0.1 ownership boundary is:

```text
Model   → decides whether a durable semantic change is worth preserving
          and supplies its semantic meaning
Harness → supplies factual project/source/time/provenance metadata,
          validates the narrow action, and keeps capture non-critical
Notion  → stores the external Work Memory record for later retrieval/review
```

This follows the existing rule: Harness owns facts; model owns meaning.

### Capture path

Pindie exposes exactly one model-facing semantic action:

```text
normal project work
        ↓
model recognizes a durable state change
        ↓
pindie_memory_capture
        ↓
ProjectMemorySink
        ↓
NotionProjectMemorySink
        ↓
external Work Memory database
```

The model supplies only semantic fields:

```text
type: decision | milestone | discovery | insight
memory
summary
whyItMatters
consequence? 
supersedes?
```

The Harness supplies factual fields and must not ask the model to fabricate them:

```text
Scope    ← canonical project root identity; v0.1 uses basename(projectRoot)
Source   ← Pindie
Date     ← capture time / state-establishment time
Status   ← Active
Evidence ← bounded Pindie provenance, not raw logs
```

Memory title and body content follow the user's current working language while code, APIs, identifiers, and technical terms may retain their original form.

### Capture semantics

Capture is model judgment, not lifecycle automation. Pindie must not introduce deterministic pseudo-events such as `on_root_cause_confirmed` or `on_design_committed`, and must not auto-capture every completed Task, successful verification, commit, or Agent Run.

The model applies a high threshold and the three-week test: capture only when losing the information would create meaningful reconstruction, understanding, or decision cost when returning later.

Eligible durable states are:

- settled decisions, architecture, technical direction, implementation order, or phase plans that constrain future work;
- meaningful capability milestones;
- confirmed important root causes, constraints, or discoveries that change the project mental model;
- genuinely reusable insights.

Routine execution, temporary hypotheses, ordinary failures, trivial implementation detail, and facts cheaply reconstructable from the repository are not Work Memory.

Task lifecycle and Work Memory are orthogonal. A Memory may be captured while the current Task is idle, active, blocked, waiting on a human, or already done, provided project authority is coherent and the semantic threshold is met. Task completion is not itself a Milestone. Because `pindie_task_complete` terminates the current Run, a meaningful completion Milestone must be captured before `pindie_task_complete`.

### Capability, Tool Effect, and Experience

v0.1 adds a semantic capability:

```text
memory.capture
```

It is legal whenever project authority is coherent, independent of Task status. It is never persisted in `PindieState`.

The concrete Tool Effect is:

```text
pindie_memory_capture → memory.capture / project mutation none
```

Writing external Work Memory is an external side effect, not project Reality mutation. It must not invalidate project Verification or participate in Project Mutation Freshness.

Work Memory capture is also not ordinary coding execution telemetry. Run Experience must classify successful/failed capture separately from execution and exclude it from existing execution counters (`toolCalls`, `consequentialCalls`, `projectMutationEffectCalls`, `verificationCalls`, `toolErrors`, and `deniedCalls`). v0.1 does not add new durable Experience counters for Work Memory.

### External persistence boundary

The core domain depends on a narrow port rather than Notion directly:

```text
ProjectMemorySink
└── capture(memory) → capture result
```

The v0.1 adapter is `NotionProjectMemorySink` implemented with the official Notion API/client. Pindie does not introduce a general MCP client or expose generic Notion tools to the model. Transport asymmetry with ChatGPT is intentional: both surfaces share the same Work Memory database while using the narrowest practical transport for their runtime.

The local integration is enabled only when its configuration is complete, for example:

```text
PINDIE_NOTION_TOKEN
PINDIE_WORK_MEMORY_DATA_SOURCE_ID
```

The Notion integration should be scoped only to the Work Memory database with minimum read/insert/update permissions. Secrets never enter the repository or `PindieState`.

### Create, update, duplicate, and supersede behavior

v0.1 intentionally avoids embeddings or semantic vector search.

For the current `Scope`, the adapter uses Active records and normalized exact Memory-title matching:

```text
no matching Active title
→ create new Active record

same Active title + stronger settled content
→ update existing record; preserve its original Date

same Active title + no meaningful change
→ duplicate/no-op

explicit supersedes title
→ create/update new Active record first
→ only after that succeeds, mark the old matching record Superseded
```

Creating the replacement before superseding the prior state avoids a transient state with no Active truth if the write fails. Near-semantic duplicates are deliberately not solved in v0.1; capture precision is preferred over adding a memory-search subsystem.

### Failure semantics

Work Memory is never on the critical path of coding work.

```text
capture succeeds
→ continue normally

Notion unavailable / timeout / permission / rate-limit / write failure
→ return a bounded non-fatal capture failure
→ continue the main Task
```

v0.1 must not add a local durable retry queue, background daemon, pending JSONL store, hidden Task, or mandatory later replay. Ordinary successful capture should remain quiet and should not create presentation noise.

### Prompt ownership

The existing static Pindie System Contract carries only a compact capture policy. It should tell the model to proactively use `pindie_memory_capture` when a durable state change passes the high threshold, explicitly state that Task completion is not automatically a Milestone, and require meaningful milestones to be captured before `pindie_task_complete`.

It must not instruct the model to check memory after every turn/tool call or introduce a procedural memory lifecycle. Capture remains a sparse semantic side effect of normal work.

### v0.1 implementation boundary

The intended implementation surface is deliberately small:

```text
src/project-memory.ts          → domain types + ProjectMemorySink
src/notion-project-memory.ts   → Notion adapter
src/tools/memory.ts            → pindie_memory_capture
src/semantics.ts               → memory.capture
src/execution-semantics.ts     → memory.capture / mutation none
src/run-experience.ts          → exclude capture from coding telemetry
src/context.ts                 → compact capture policy
src/extension.ts               → optional configuration + wiring
package.json                   → Notion client dependency
focused tests                  → domain/adapter/gateway/tool contracts
```

No `memory-store`, `memory-runtime`, `memory-manager`, memory queue, memory State, autonomous memory Agent, or second persistence subsystem is part of v0.1.

## 15. Architectural invariants

1. Reality determines reconstructable facts.
2. State stores only durable semantic current-work facts.
3. Run Facts are runtime-only and minimal.
4. Snapshot and capabilities are derived, never persisted.
5. Run Baseline, causal State updates, Gateway legality, and deterministic continuation eligibility derive from one semantic world.
6. Pi owns the active Tool Surface; the Gateway re-authorizes every consequential call against current capabilities.
7. Reducer knows semantic events, not Pi tools.
8. Harness closes deterministic branches; model retains genuine semantic choices.
9. Human authority is explicit for consequential judgment.
10. Gateway remains the final execution authority even when a tool remains visible to the model.
11. Global natural-language policy must not duplicate deterministic Harness authority.
12. Verification factual evidence/provenance/freshness belongs to Harness; verification meaning/coverage belongs to the model.
13. Runtime evidence refs/generations and continuation fuses are temporary and never persisted.
14. Durable Verification State remains compact; Pindie is not a tool-result log database.
15. Historical runtime probes remain append-only until normal Pi compaction and never rewrite prior model history.
16. Skills are procedural and do not own semantic correctness.
17. Pi owns the low-level Agent Loop, Skill runtime, concrete tool registry, native system-prompt construction, retries, compaction, and follow-up delivery; Pindie Host owns the process and active `AgentSessionRuntime` lifecycle above those primitives.
18. Optional Remote projection derives from native Pi Session history and existing Pindie runtime/semantic facts; Discord never becomes semantic or conversation authority.
19. Durable Remote metadata stores external routing/delivery identity only and never enters `PindieState`.
20. Remote control targets only the current live Pi Session through Pi public boundaries; it never creates a parallel Session or queue.
21. Remote/Discord failure must not alter local Pindie correctness or stop the local Agent.
22. Strategy Revision Candidates are inactive hypotheses only; SI v0.5 Candidate creation is explicit `/adapt <strategy-id>` work and never activates or overrides Policy.
23. Runtime Independence is an ownership inversion, not a second Agent Loop: Pindie may own Agent/Session lifecycle while Pi remains the low-level execution runtime.
24. Work Memory is an external projection and never becomes `PindieState`, Task continuity, Run Experience, Session truth, or a second memory database.
25. Work Memory meaning and capture worthiness belong to the model; project identity, source, date, provenance, legality, and external-write mechanics belong to the Harness.
26. Work Memory capture never counts as project mutation, never invalidates Verification, and never blocks the primary Task when external persistence fails.
27. Task completion is not automatically a Work Memory Milestone; meaningful completion memory is captured before the terminating completion action.
