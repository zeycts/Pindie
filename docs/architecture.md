# Pindie Architecture v0.3

> Stable Mode: AL/SI/CPL are retired regardless of flags or overrides. Retired `policy.*` effects remain fail-closed. [Retirement evidence](al-retirement-phase2-d.md) records code/data boundaries; obsolete designs are recoverable from Git, not current authority.

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

### Stable composition boundary

`composition.ts` owns startup selection, explicit storage roots/default dependencies and narrow wiring. Core never imports the composition root or optional Discord/Notion adapters. Disabled features contribute no tools, commands, hooks, prompts or hidden adapter loads. AL/SI/CPL are always disabled; Remote, Work Memory, bundled Skills and Presentation keep independent selection.

Core includes State/Task/Gate/Verification, Snapshot/capabilities, Gateway/mutation/evidence, Run identity/coherence, continuation and continuity. Native Pi, State safety, Handoff/Rollover and Host Task metrics are not optional. Disabling Presentation must not disable measurements, counters or completion summaries. Do not infer feature storage from a concrete StateStore type.

Use per-consumer immutable facts and narrow ports, not a giant CapabilityContext or plugin/workflow registry. Remote uses existing Pi/status/input ports; Memory uses project root/read-only State/time/sink. Bindings distinguish project, Session and Run generation. Readonly types alone are not isolation; copy/freeze where required.

Startup declarations keep tool definition, required capability, mutation effect and telemetry together; they cannot mint capabilities, override Core names or bypass the one Gateway. Preserve conservative unknown-tool effects and captured-baseline-only narrowing. Keep fixed start/authorization/settlement call points, no priority/event-phase engine. Refresh/freeze authoritative facts before continuity/rollover publication, then clear Run bookkeeping and expose read-only final projections. Optional observer failure cannot alter authority. Emitted-import, poisoned-injection and composition tests protect this boundary.

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

Task-occurrence and external-State epochs remain Core authority facts, not Learning attribution. Historical Learning artifacts and remaining inert schema helpers are never loaded by production and are not current State or continuation authority. Code retirement does not migrate or delete user data.

## 4. Capabilities and execution authority

Capability vocabulary:

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

Task/Verification/Gate capabilities are pure derived authority and never persisted. Legacy `policy.*` names classify retired calls for denial; they are not granted capabilities.

Important capability consequences:

```text
unavailable/stale authority → observation only
idle                       → observation + task.start
done before Run            → observation + task.start
done during Run            → observation only
blocked                   → no project.mutate, no task.complete
same-Run-opened Gate      → observation only
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
retired Policy/Strategy tools → unavailable policy.* effects; never granted
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

The Gateway remains authoritative for every consequential call, including races, stale pre-generated calls, and calls generated before a same-Run semantic change. It derives current capabilities from the current semantic Snapshot and blocks or allows the concrete effect at execution time. Retired Policy/Strategy calls remain denied even if captured in a stale tool baseline.

## 7. Knowledge Surface and prompt ownership

Pindie appends a deterministic static System Contract to Pi's already-chained system prompt in `before_agent_start`. The contract contains runtime authority, Gateway, Task, verification, Human Gate and append-only update semantics; no Seed/Policy/Trial guidance is mounted.

The same `SemanticSnapshot` used by capabilities produces a hidden Run Baseline message at Agent Run start. It may report:

- coherent/stale/unavailable Run authority;
- Task and verification status;
- current Task contract and open loops;
- current verification records;
- Human Gate details;
- factual unavailability reason.

The same projection includes a compact Current Pindie Action Eligibility block. It is derived directly from the current capabilities and is an affordance for the model, not authorization; the Gateway still makes the final call-boundary decision. It appears in the Run Baseline and in causal semantic State results when the capability set changes.

Pi compaction is an intentional request reset boundary. After a successful `session_compact`, Pindie appends one hidden State Checkpoint containing the exact current authoritative State, Run authority and eligibility. Overflow recovery queues that checkpoint before its retry when Pi exposes that continuation; failed or aborted compaction emits no checkpoint. Pindie does not depend on Pi's generic compaction summary to preserve semantic State and does not create an extra model turn solely for the checkpoint.

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

Run Timer and Run Cost remain independent one-Run telemetry for Core measurements and diagnostics. For Task-owned execution, a process-local Host-owned Task metrics accumulator presents cumulative active Run time and model-equivalent cost across legitimate automatic Session rollover; no-Task execution presents only current/latest Run consumption. Task metrics are not persisted and restart from zero after a process restart.

Remote Companion is an optional external projection/control surface over the same live Pi Session and existing Pindie facts. It must not create another Agent, Session, message queue, or semantic truth. The canonical Project maps to a Discord channel for navigation, and the native Pi Session ID maps to a Discord thread for readable Session history and remote input. Discord is a replica/control surface; Pi Session history remains conversation truth and `PindieState` remains semantic truth.

The only durable Remote data is external routing/delivery metadata (for example Project→channel, Pi Session→thread, and a delivery cursor) stored outside `PindieState`. Remote input uses Pi-native user-message, steer, follow-up, and current-context abort boundaries. Historical Discord threads never implicitly switch the active local Pi Session. See `docs/remote-companion.md` for the authoritative Remote Companion contract.

## 12. Skills

Pi is the only Skill runtime. Pindie may bundle procedural Skills, but a Skill must not become another semantic authority layer.

A Skill may describe a reusable procedure such as Git delivery. It must not duplicate Task admission, capability legality, verification authority, Human Gate lifecycle, or completion rules already enforced by the Harness.

## 13. Runtime Independence v0.1 — implemented ownership inversion

Host owns Pindie's process and active Session lifecycle while Pi implements Session execution. Core Task/State/authority/Gateway/Verification and optional Remote retain their boundaries.

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
existing State / Gateway / verification / measurement behavior
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

Existing Pi/Pindie semantics remain intact: project State loading, model/tool execution, system-contract injection, independent measurements, `/reload` behavior where applicable, compaction checkpoints, Remote projection and shutdown correctness must not silently diverge.

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
[Long Task runtime](./long-task-runtime.md). This ownership does not authorize
background Learning executions or a second Agent Loop.

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

### Browser Reality v0.2

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
Network observations are never written to `PindieState`. One runtime-only Host
manager owns both the bridge and browser/profile; Session replacement merely
invalidates outgoing tool closures. Neither Host startup nor tool registration
starts a process, discovers tools, allocates an endpoint, or creates a profile.

The 13 selected declarations are a checked-in exact upstream snapshot, including
descriptions and complete JSON schemas, bound to browser-use 0.1.15 / DevTools
1.9.0. First execution checks installed versions before launch, single-flights
startup, then checks live declarations before dispatch. Mismatch fails closed;
it never substitutes guessed schemas. Explicit maintenance commands are
`node --experimental-strip-types scripts/browser-tool-catalog.ts --check` and
`--write`; these start a metadata bridge intentionally, not during registration.
Review regenerated declarations before upgrading the version binding.

`browser_status` reads the manager phase without startup. `browser_release`
refuses in-flight startup/tools and closes the bridge before stopping the owned
browser and deleting only its temporary profile. Subsequent execution starts
fresh. Caller cancellation does not cancel another caller's shared startup.
Host disposal aborts active calls and bounds bridge close/call drain before
browser deletion; a late startup cannot publish a usable bridge after disposal.
Cleanup failure remains visible and blocks automatic replacement. A failed or
timed-out bridge close retains its original promise: a second upstream no-op
`close()` cannot substitute for confirmation. Bridge confirmation here means
settlement of that original SDK close operation, not independent OS process-tree
verification (the pinned SDK can resolve after requesting its final SIGKILL).
Actual tool drain and browser termination are separately required before profile
deletion. Session shutdown alone never releases Host resources.

A runtime-only 15-minute inactivity timer may release resources only with known
settled Session facts (no streaming, compaction, pending messages or bash), known
State, no Human Gate/quota wait, and no pending UI interaction. Browser calls and
ordinary agent starts refresh activity. Owned UI exposes its current overlay,
queued-dialog and pending-picker facts. Native UI uses human-approved bounded
per-instance Pi 1.3.0 instrumentation: pending UI promises include asynchronous
custom factories before mounting; selector/editor/overlay facts cover mounted
native interactions. Unknown versions, changed shapes or replaced wrappers
prevent automatic release. There are no prototype/global patches or new policy
loop, and this observer grants no tool execution authority.

Linux launches a dedicated session/process group, binds the exact launch handle
to its `/proc` start identity, signals only that group, and requires
kernel-confirmed group absence after bounded TERM/KILL escalation. Direct-child
exit or a `/proc` member enumeration alone is not confirmation; lingering zombies
can conservatively keep cleanup unconfirmed. WSL launches Windows Chrome
suspended, assigns it to a uniquely named non-breakaway Windows Job, and uses
`DuplicateHandle` to put a non-inheritable, query-only Job handle in that exact
browser root before resuming it. The handle belongs to the browser, not the
short-lived launch helper; closing the helper's handles does not close it.
Member references alone do **not** preserve a kernel object's name: see
[kernel object name lifetime](https://scorpiosoftware.net/2023/05/15/kernel-object-names-lifetime/).

Windows release must reopen the exact random Job name, terminate the Job, query
zero active members using its still-open stop handle, and return an exact
Job-bound acknowledgment before profile cleanup. Missing name, access failure,
missing/wrong acknowledgment or surviving descendants are unconfirmed, never
success. If the browser root exits or closes its retained handle before release,
the Job name can disappear while descendants survive. Cleanup then fails closed,
retains the profile and blocks replacement; even a fully exited browser can
conservatively require manual stale-resource review in this case. No PID-only
fallback is used. A launch helper killed between process creation, assignment
and handle duplication can also leave unconfirmed resources; no retry/deletion
is authorized. Arbitrary launch handles are rejected on both platforms.
Explicit profiles remain developer-managed and are never deleted.

Native InteractiveMode alone receives a runtime facade whose `dispose` awaits
Host cleanup before Pi's own normal/SIGTERM/SIGHUP exit; the Adapter retains the
original runtime to avoid recursion. Pi still owns shutdown, signals, the
terminal and process.exit. Emergency terminal exit, uncaught crash, SIGKILL and
machine loss bypass or can interrupt asynchronous cleanup. No guarantee is
claimed for those exits. In particular, the browser-owned Windows Job handle
survives Host death while that browser root lives; it is not a kill-on-Host-exit
lease, and there is no watchdog that promises to stop those orphan resources.
No persisted resource registry or startup janitor is
introduced: a later Host neither adopts nor kills old processes nor scans/deletes
old profiles. Stale resources require independent human identification and
manual cleanup; an unconfirmed bridge stop, call drain or browser stop never
authorizes profile deletion. Disabled or unavailable Browser Reality does not
alter Task truth or prevent ordinary Pindie startup.

Validation includes isolated real Linux/browser-use startup, reuse, navigation,
evaluation, snapshot, release/restart and cleanup, plus pinned native shutdown
and real signal-handler subprocess tests with inert terminal/Session fixtures.
The Windows Job boundary has generated-script checks plus Host/runtime/manager
integration with a handle/name/member lifetime model. Regressions explicitly
remove the last handle/name while Chrome members survive and verify zero profile
deletions, including an old-helper exit-0/no-ack response. These are not a native
PowerShell interpreter or Windows kernel verification. Real Windows/WSL execution
and a full native PTY smoke are not claimed.

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

### Capability, Tool Effect, and measurements

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

Work Memory capture is not ordinary coding execution telemetry. Preserve its separate classification rather than count capture as coding/verification activity. Core counters and Task measurements remain independent of Learning persistence; capture adds no durable Learning record.

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
src/run-integration.ts        → independent Core counters; capture is separate
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
22. Retired Policy/Strategy tools have no Core grants; old flags and injections cannot reactivate Learning.
23. Runtime Independence is an ownership inversion, not a second Agent Loop: Pindie may own Agent/Session lifecycle while Pi remains the low-level execution runtime.
24. Work Memory is an external projection and never becomes `PindieState`, Task continuity, Run Experience, Session truth, or a second memory database.
25. Work Memory meaning and capture worthiness belong to the model; project identity, source, date, provenance, legality, and external-write mechanics belong to the Harness.
26. Work Memory capture never counts as project mutation, never invalidates Verification, and never blocks the primary Task when external persistence fails.
27. Task completion is not automatically a Work Memory Milestone; meaningful completion memory is captured before the terminating completion action.
