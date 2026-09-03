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
  ├───────────────┬──────────────────┐
  ↓               ↓                  ↓
Knowledge      Tool Surface      Authorization
Surface            │                  │
  │                └──────┬───────────┘
  │                       ↓
  └────────────────────── LLM
                          ↓
                    semantic choice
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

Ordinary Task/verification/Gate capabilities are pure derived authority and are never persisted. `policy.adapt` is a runtime-only control capability granted only to the active Candidate tool while an explicit adaptation lease is bound to the current Agent Run; it is never persisted or included in ordinary capability sets.

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
strategy Candidate tool  → policy.adapt / mutation none (active adaptation lease only)
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

Internal reducer events remain tool-agnostic.

Pi owns the active model Tool Surface. Pindie does not narrow, expand, capture, or restore that surface as semantic State changes. A currently unauthorized tool may remain visible to the model; visibility is not authorization.

The Gateway remains authoritative for every consequential call, including races, stale pre-generated calls, and calls generated before a same-Run semantic change. It derives current capabilities from the current semantic Snapshot and blocks or allows the concrete effect at execution time. Self-Improvement Candidate creation is a separate `policy.adapt` control effect with no project mutation; it additionally requires a live explicit `/adapt <strategy-id>` runtime lease.

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

When eligible, Pindie sends at most one hidden Pi-native follow-up probe asking only whether the latest actual user intent still calls for consequential execution. The probe explicitly identifies itself as runtime-generated metadata, not user intent and not a new request.

The model may then choose any currently visible/legal action or return control. Tool Surface and Gateway own legality; the probe does not teach lifecycle rules or tool sequences.

Delivery stays inside Pi's native lifecycle:

```text
agent_end
→ deterministic eligibility
→ one hidden continuation custom message at most
→ sendMessage(..., { deliverAs: "followUp" })
→ Pi handles its own post-run continuation/compaction/retry machinery
→ agent_settled after automatic work is exhausted
```

Pindie uses only Pi's public extension contract. It does not infer private retry state, call the model directly, recurse, or create another loop.

Historical continuation probes remain in session/model history. Pindie does not filter or reorder them; normal Pi compaction handles history growth.

## 11. Runtime-only presentation, reasoning, and external projection

Activity, Run Timer, Run Cost, status presentation, subscription usage observation, and adaptive reasoning are runtime-only systems. They may present or tune execution but are not semantic State.

Run Activity follows actual Pi tool lifecycle rather than model-authored status. Status presentation consumes authoritative/derived runtime facts rather than becoming an independent source of truth.

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

Runtime Independence v0.1 does not itself implement Long Task Runtime. It establishes the missing ownership primitive:

```text
Pindie can own and replace the active Agent Session
```

Long Task Runtime can then be designed above that boundary as a Pindie-owned lifecycle scheduler rather than as extension callback choreography. Self-Improvement can likewise create purpose-specific Agent executions later without pretending every execution must be initiated by an externally owned Session.

## 14. Architectural invariants

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
