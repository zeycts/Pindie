# Pindie Architecture v0.2

## 1. Purpose

Pindie is a personal AI agent for indie development built on Pi. Pi remains the low-level agent harness. Pindie adds a small semantic operating layer above it.

```text
Human  → goals, taste, consequential judgment, approval
Model  → meaning, interpretation, planning, semantic choice
Pindie → truth, legality, capability, lifecycle, factual evidence freshness
Pi     → LLM execution, tool registry/execution, sessions, low-level agent loop
```

Pindie should eliminate meaningless choices, not meaningful choices.

## 2. Non-goals

Pindie v0.2 does not add a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, verification-log database, second Skill runtime, universal shell parser, or second source of project truth.

## 3. Semantic architecture

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

The semantic center is deliberately small:

```text
PindieState + SemanticRunFacts
        ↓
deriveSemanticSnapshot()
        ↓
deriveCapabilities()
```

Concrete execution semantics remain separate:

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

M0–M5 are implemented: semantic truth drives live authorization, model-visible Tool Surface, factual Runtime Context, and Harness-owned verification evidence provenance/freshness; Pi owns its native system prompt and low-level Agent Loop.

## 4. Durable State and Run Facts

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

Task/verification statuses are derived. Capabilities, active tools, Run authority, presentation, reasoning state, continuation fuses, Git fingerprints, recent evidence refs, evidence generations, and workflow phases are never persisted.

The reducer remains the authority for hard State invariants and consumes semantic `PindieEvent`s, not Pi tool names. Runtime owns project-scoped load/save, authoritative refresh, locking, external-State conflict detection, reducer dispatch, and save-before-publish.

Run-boundary legality uses runtime-only relationships:

```text
TaskRunRelation       none | preexisting_untouched | preexisting_changed | introduced_during_run
CompletionRunRelation not_completed | completed_before_run | completed_during_run
GateRunRelation       none | existed_before_run | opened_during_run
```

Object identity is only a coherent-Run immutable-State change detector, never persistent semantic identity.

## 5. Capabilities and live execution

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

Capabilities are pure derived authority and are never persisted.

Important consequences:

```text
unavailable/stale authority → observation only
idle                       → observation + task.start
done before Run            → observation + task.start
done during Run            → observation only
blocked                    → no project.mutate, no task.complete
same-Run-opened Gate       → observation only
task.complete              → only when completionReady
```

The live Gateway authorizes every non-observation call through current capabilities after authoritative refresh/coherence checks. Reducer and Runtime remain deeper integrity backstops.

Project Mutation Freshness uses the same Tool Effect taxonomy:

```text
mutation none      → no project-mutation observation
mutation known     → successful mutation invalidates prior verification
mutation ambiguous → before/after Reality fingerprint observation
```

## 6. Model Tool Surface — implemented M3

Model-facing semantic tools are narrow capability-shaped adapters:

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

Internal reducer events remain unchanged.

For each actual Agent Run:

```text
Run Tool Baseline
        ∩
Tools allowed by current capabilities
        ↓
Effective Tool Surface
```

The Run Tool Baseline is the Pi/user active set captured at the authoritative `before_agent_start` boundary before Pindie applies restriction. Pindie may narrow it but never enable a tool absent from the baseline. The exact baseline is restored when the Run settles and a fresh one is captured for the next Run.

The M2 Gateway remains authoritative for races, stale pre-generated calls, and temporary visibility mismatch.

## 7. Knowledge Surface / prompt ownership — implemented M4

Pindie no longer owns a global lifecycle-policy system prompt. Pi owns its native system-prompt construction.

Runtime Context remains a hidden factual Knowledge Surface driven by the same `SemanticSnapshot` used by capabilities. It may report authority, Task/verification status, current Task details, verification records, Human Gate, and factual unavailable reason; it must not duplicate structural legality as procedural instructions.

The projection is:

```text
PindieState + SemanticRunFacts
        ↓
SemanticSnapshot
        ├→ Capabilities → Tool Surface / Gateway
        └→ Knowledge Surface + current State details
```

Natural-language policy is a last resort, not a source of deterministic correctness.

## 8. Verification v0.2 — implemented M5

M5 fixes evidence ownership while preserving the durable Verification State shape.

```text
Actual Pi tool execution
        ↓
Harness observes factual result
        ↓
Recent factual Evidence Candidate
        ↓
Model semantic judgment
  - check name
  - passed | failed meaning
  - success-criterion coverage
        ↓
Harness resolves selected evidence refs
        ↓
Existing durable VerificationCheck
        ↓
Reducer / State
```

Harness owns `what happened`. Model owns `what it proves`.

Durable checks remain:

```text
VerificationCheck
├── name
├── status: passed | failed
├── covers: criterion ids[]
└── evidence: string
```

Runtime refs use actual tool-call identity (`ev:<toolCallId>`), are never persisted, and are scoped to one actual Agent Run. Factual materialization is bounded and deterministic. Existing legacy verification records remain compatible without migration.

Recent evidence uses a runtime-only generation token. Calls remember generation-at-call; verification-basis changes advance the generation and clear candidates. Project Mutation Freshness runs before evidence capture for ambiguous tools, so mutating/unknown results cannot become current evidence.

## 9. Human authority

A Human Gate is an explicit authority boundary. A Gate opened during the current Run has observation-only capability space until new human input. A pre-existing Gate may expose `gate.resolve` and legal Task-boundary choices; the model interprets human input among those choices.

## 10. Continuation — M6 target

Continuation is the remaining place where Pindie intentionally asks the model a semantic question after deterministic facts have been closed.

Pi owns the low-level run lifecycle. In pinned Pi 0.84.3, the public extension `agent_end` event contains only `type` and `messages`; Pi's internal session-event stream computes a `willRetry` value separately, but that value is not part of the public extension API. Pindie must not reach into private Pi internals or recreate retry classification to obtain it.

### 10.1 Deterministic eligibility

M6 derives continuation-probe eligibility from one semantic world plus only public Pi runtime facts:

```text
SemanticSnapshot
+
probe already attempted?
pending Pi messages?
final assistant stopped normally?
        ↓
Continuation probe eligible?
```

Eligibility is true only when:

```text
snapshot.authority == coherent
snapshot.taskStatus == active
probe not already attempted
no pending Pi messages
final stopReason == stop
```

`taskStatus == active` already closes completed, Human Gate, and blocker branches. Continuation code must not independently re-read those Task fields as a second policy source. Unresolved questions may coexist with active work and therefore do not automatically suppress the probe.

The normal-stop condition is also the correct public retry boundary for M6. Pi's turn-level automatic retry path operates on retryable error outcomes, while an assistant response with `stopReason == stop` is a successful completion and is not that retry case. Pindie therefore does not need a private/internal `willRetry` signal for an otherwise normal-stop probe.

### 10.2 Semantic probe

Once deterministic eligibility is satisfied, one genuinely semantic question remains:

> Does the latest actual user intent still call for consequential execution now?

Pindie must not infer this from `nextIntent`, unfinished status, prior tool usage, or a workflow phase.

The model receives one thin runtime-generated hidden follow-up probe and may choose among the currently visible/legal semantic actions. The probe must not enumerate lifecycle rules or specific tool sequences; Tool Surface, Gateway, Runtime Context, and reducer invariants already express those constraints.

The probe must explicitly state that it is **not user intent and not a new request**.

### 10.3 One-shot Pi-native continuation

Keep Pi's native mechanism:

```text
agent_end
→ deterministic eligibility
→ at most one hidden Pindie custom message
→ sendMessage(..., { deliverAs: "followUp" })
→ Pi performs its own post-run handling
→ queued probe is delivered if Pi continues for queued work
→ agent_settled only after no automatic continuation remains
```

For a successful normal stop, Pi may perform non-retrying auto-compaction before draining the queued follow-up. That remains Pi-owned and does not require Pindie to predict compaction/retry internals.

The fuse is runtime-only and resets for a fresh user-driven Agent Run. M6 must not add recursion, direct model calls, background loops, repeated probes, a phase machine, or a second Agent Loop.

### 10.4 Ephemeral probe context

Pi custom messages participate in model context. Historical continuation probes must therefore not accumulate as durable semantic instructions.

During the actual continuation follow-up, model context should retain only the current/latest Pindie continuation probe. On a fresh user-driven Run, prior Pindie continuation probes should be filtered from model context entirely.

This is context projection only. The session may still contain hidden custom entries for audit/history; they simply stop affecting later LLM context.

## 11. Activity, reasoning, skills

Activity, timer, cost, status, and adaptive reasoning remain runtime-only systems. Pi remains the sole Skill runtime.

## 12. Architectural invariants

1. Reality determines reconstructable facts.
2. State stores only durable semantic current-work facts.
3. Run Facts are runtime-only and minimal.
4. Snapshot and capabilities are derived, never persisted.
5. Knowledge Surface, Tool Surface, Gateway legality, and deterministic continuation eligibility derive from one semantic world.
6. Effective tools are a subset of the captured Pi/user Run baseline.
7. Reducer knows semantic events, not Pi tools.
8. Harness closes deterministic branches; model retains genuine semantic choices.
9. Human authority is explicit for consequential judgment.
10. Gateway remains defense in depth after Tool Surface alignment.
11. Global natural-language policy must not duplicate deterministic Harness authority.
12. Verification factual evidence/provenance/freshness belongs to Harness; verification meaning/coverage belongs to the model.
13. Runtime evidence refs/generations and continuation fuses are temporary and never persisted.
14. Durable Verification State remains compact; Pindie is not a tool-result log database.
15. Historical runtime probes must not become persistent model policy through context accumulation.
16. Pi owns the low-level Agent Loop, Skill runtime, concrete tool registry, native system-prompt construction, retries, compaction, and follow-up delivery. Pindie uses only Pi's public extension contract.

## 13. Migration plan

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

M6 simplifies continuation authority and context hygiene; it does not redesign Task/verification semantics, Tool Surface, Gateway legality, or Pi's low-level Agent Loop.