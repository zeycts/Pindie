# Pindie Long Task Runtime v0.1 — Architecture Contract

Long Task Runtime lets one durable Pindie Task survive as many finite Pi Context Windows as necessary without requiring the human to manage Sessions manually.

The core invariant is:

```text
Task lifetime != Session lifetime
```

The human submits one Task. Pindie may compact or replace working Context internally and continues autonomously until the Task completes, reaches a Human Gate, becomes truly blocked, or a runtime safety boundary returns control.

## 1. Mental model

A Pi Session is working memory, not Task identity.

```text
Durable Task
────────────────────────────────────────────>

Session A          Session B          Session C
working memory     fresh memory       fresh memory
    │                  │                  │
    └── checkpoint ────┴── checkpoint ───┘
                                           │
                                           ▼
                                     Task Complete
```

The logical Lead Agent is a role attached to the durable Task, not an immortal Session. Replacing the Session replaces working memory; it does not replace the Task, project, semantic State, or human intent.

Long Task Runtime v0.1 solves vertical longevity: one logical Agent role can continue across multiple Context Windows. Subagents and parallel workers are later context-isolation/parallelism mechanisms and are not part of v0.1.

## 2. Context lifecycle

Long-horizon work has different context-management mechanisms with different jobs:

```text
subagent delegation  → isolate context-heavy side work        (later)
Pi compaction        → compress the current working memory     (existing)
Session rollover     → replace the whole working-memory epoch  (v0.1)
```

Pi compaction remains a normal lifecycle mechanism. Long Task Runtime does not replace it or force a fresh Session whenever context usage rises.

A fresh Session is appropriate when the model reaches a clean semantic handoff boundary or when repeated context pressure/compaction indicates that continuing the same Session is becoming inefficient or unstable.

Context percentage is an advisory resource signal, never semantic correctness or a hard Task boundary.

## 3. Durable Task remains the authority

`PindieState` remains the only durable semantic Task authority:

```text
goal
constraints
successCriteria
openLoops.blockers
openLoops.questions
openLoops.nextIntent
verification
humanGate
completed
```

Long Task Runtime does not introduce a Task queue, phase machine, Slice database, persistent plan, second Task ID, or Session-scoped Task copy.

In particular, `openLoops.nextIntent` remains the authoritative durable statement of the next meaningful Task direction.

## 4. Task Continuity Checkpoint

The new durable artifact stores only working-memory information that cannot be reconstructed cheaply from project Reality or `PindieState`.

Conceptually:

```text
TaskContinuityV1
├── schemaVersion: 1
├── checkpointId
├── sequence
├── createdAt
├── taskFingerprint
├── sourceSessionId
├── progressSummary
└── decisions[]
```

`progressSummary` is a compact current-work snapshot, not a transcript summary of only the immediately previous step.

`decisions[]` contains only decisions that still matter to a fresh Agent Session. Superseded decisions are not carried forward.

The artifact deliberately does not duplicate:

```text
goal / constraints / success criteria
blockers / questions / nextIntent
verification / Human Gate / completion
Git branch / HEAD / filesystem facts
raw tool results / diffs / logs
conversation transcript
chain of thought
```

Those facts already have authoritative sources and should be re-observed or projected from State.

Storage is project-local and outside `PindieState`, for example:

```text
~/.pindie/projects/<project-id>/continuity.json
```

Only the latest checkpoint is needed. Writes are atomic; this is bounded current working memory, not an append-only history database.

Loss or corruption of the continuity artifact must never corrupt Task truth. At worst, a fresh Agent must reconstruct more context from State and Reality.

## 5. Task binding

v0.1 does not introduce a persistent Task UUID solely for Long Task Runtime.

A deterministic Task Contract fingerprint binds a checkpoint to the current Task:

```text
taskFingerprint = hash(
  goal,
  constraints,
  successCriteria ids + descriptions
)
```

Mutable execution facts such as `nextIntent`, blockers, questions, verification, and completion are excluded from the fingerprint.

A checkpoint whose fingerprint does not match the current Task Contract is stale and must not be used for automatic continuation.

## 6. Model handoff request

The model gets one explicit semantic/runtime affordance:

```text
pindie_task_handoff
```

Conceptual input:

```text
progressSummary

decisions[]

nextIntent
```

`nextIntent` is written through the existing Task progress transition and remains authoritative in `PindieState`; it is not duplicated into the continuity artifact.

A handoff means:

> The Task remains unfinished, but the current Session has reached a coherent working-memory boundary and may be replaced after safe settlement.

It does not complete the Task and does not create a subtask or phase.

Handoff is legal only for a coherent active Task. It is unavailable for idle, completed, waiting-human, or blocked Task states.

It may reuse existing Task-progress semantic authority; v0.1 does not require a new durable semantic capability merely to represent runtime rollover.

## 7. Pending handoff and terminal semantics

The handoff tool must not physically replace the Session while its own Agent turn/tool lifecycle is still active.

On a valid tool call Pindie:

```text
validate current active/coherent Task
        ↓
apply nextIntent through existing Task progress semantics
        ↓
stage model-authored progressSummary + decisions
        ↓
create runtime-only PendingHandoff bound to this Session/Run
        ↓
arm handoff terminal latch
        ↓
return: finish this turn; no further tool work
```

The durable continuity checkpoint is committed only at the safe settlement boundary, not in the middle of the tool call.

After `PendingHandoff` is staged, no new tool execution may extend the working state represented by that handoff. The runtime terminal latch rejects later tool calls in the same Run.

If already-in-flight or late tool activity makes the proposed handoff stale, the pending handoff is invalidated and no rollover occurs. The model must establish a fresh handoff later.

Existing automatic continuation probing is suppressed while a valid handoff is pending.

## 8. Settlement and checkpoint commit

At `agent_settled`, Pindie revalidates the pending handoff against current authoritative facts.

A rollover may proceed only if:

```text
PendingHandoff still valid
active Session still matches request Session
Task is still coherent + active
Task Contract fingerprint still matches
no real user steer/follow-up/input is pending
no Human Gate or true blocker now owns control
```

Normal Run Experience settlement must complete before physical Session replacement.

Then:

```text
build latest TaskContinuityV1
        ↓
atomic write continuity.json
        ↓
publish committed rollover request to Host
```

If checkpoint persistence fails, no automatic Session replacement occurs.

Real user input always outranks automatic rollover. If user input arrives before replacement, the pending handoff is cancelled or invalidated and Pi handles the user's actual intent in the current Session.

## 9. Runtime Control Bus

Extension-hosted semantic integration and Host-owned Session lifecycle need one small in-process control channel.

```text
Pindie extension
      │
      │ committed rollover request
      ▼
Runtime Control Bus
      │
      ▼
Pindie Host
      │
      ▼
PiRuntimeAdapter
```

The bus is process-local, runtime-only, non-durable, and contains no LLM or semantic authority.

It carries only lifecycle coordination such as:

```text
handoff committed for Session X / checkpoint Y
active Session settled
new live Session endpoint registered
resume checkpoint Y in Session Z
```

Every control action is bound to native Pi Session identity/generation. Stale Sessions cannot control the current Host runtime.

The bus must not persist orchestration state or become a generic event platform.

## 10. Session Rollover Supervisor

Pindie Host owns a deterministic rollover supervisor above `PiRuntimeAdapter`.

Conceptually:

```text
committed checkpoint
        ↓
verify request belongs to active Session
        ↓
wait for safe settlement / no pending real user input
        ↓
runtime.replaceWithFreshSession()
        ↓
Pi performs native Session teardown/create/rebind
        ↓
new Session endpoint becomes live
        ↓
trigger runtime continuation
```

The supervisor does not plan, reason, choose implementation steps, judge verification, or call a second model.

Replacement cancellation/failure does not mutate Task truth. The Task remains active and control is surfaced without an infinite automatic retry loop.

Automatic rollover has a finite runtime safety fuse. The exact default is tuning, not architecture; exhausting it returns control with the Task still unfinished instead of churning Sessions indefinitely.

## 11. Fresh-Session resume

Automatic continuation after Host-owned rollover must not fabricate a new human message such as `continue`.

The new live Pindie extension receives the specific committed checkpoint through the runtime control channel and triggers a hidden Pi custom runtime message/turn using Pi's public message lifecycle.

The resumed model context contains:

```text
current authoritative Run Baseline
+
<PINDIE_TASK_CONTINUITY>
  progressSummary
  carried decisions
  authoritative State nextIntent
</PINDIE_TASK_CONTINUITY>
```

The continuity block explicitly states that it is runtime continuation, not new user intent, and that current `PindieState` plus project Reality remain authoritative.

The model re-observes Reality where needed rather than treating the checkpoint as factual proof.

A durable checkpoint is consumed automatically only by the Host-owned rollover flow that created it. v0.1 does not automatically inject the latest checkpoint into arbitrary manual `/new`, `/resume`, or process restart Sessions, because an old checkpoint may be stale relative to later work.

Crash/restart autonomous recovery can be designed later if dogfood shows a need.

## 12. Context Governor

Context Governor is an advisory runtime component. It observes factual resource signals such as:

```text
current context usage
successful compaction count in this Session
context re-growth after compaction
whether a handoff is already pending
```

It does not own Task status or Session replacement.

The governor emits bounded hidden guidance only when pressure meaningfully changes, for example:

```text
normal
→ continue normally

elevated
→ look for a coherent handoff boundary; avoid unnecessary context-heavy work

high / repeated post-compaction growth
→ converge current work and commit a durable handoff instead of opening another major branch
```

Exact percentages are implementation tuning and must be injectable/testable rather than architectural constants.

A semantic handoff may happen before compaction if the model reaches a clean boundary naturally. Conversely, the first compaction does not imply an immediate rollover.

Pi compaction remains authoritative for in-Session history compression. Long Task Runtime does not re-inject an old rollover checkpoint after later compaction inside the resumed Session; that checkpoint can already be stale as new work proceeds. Current-session continuity belongs to Pi's compaction plus Pindie's existing authoritative State Checkpoint.

## 13. Autonomy and human precedence

The autonomous lifecycle has three semantic exits:

```text
Task Complete  → return final result
Human Gate     → wait for human authority
True Blocker   → return control with blocker facts
```

A real user message, steer, follow-up, or supported Remote input is always higher priority than automatic rollover/continuation. Long Task Runtime must never discard or move real user input across Sessions silently.

Ordinary short Tasks require no special mode and should never expose Long Task ceremony:

```text
Task → one Session → complete
```

There is no `/long` command and no durable `longTask=true` Task type in v0.1.

## 14. Experience and Self-Improvement

Long Task Runtime v0.1 does not change Experience schema.

A large Task naturally produces multiple ordinary Agent Runs/Experiences across Sessions:

```text
Task X
  Session A / Run A / Policy A
  Session B / Run B / Policy B
  Session C / Run C / Policy C
```

This is preferable to forcing arbitrarily large work into one noisy Experience record.

The handoff/control lifecycle is non-project-mutating runtime coordination and must not manufacture false project execution evidence.

Future Self-Improvement may learn when to hand off or which Policy works for different long-horizon situations, but v0.1 contains no learned rollover policy.

## 15. Relation to future subagents

Subagents solve a different problem: context isolation and parallel work breadth.

They do not remove the finite-context problem of a long-lived coordinator. The future architecture therefore treats the Lead as a logical Task role rather than one permanent Session:

```text
Durable Task
    ↓
Logical Lead
    ├── Lead Session A → checkpoint → Lead Session B
    ├── future Worker A (isolated context)
    └── future Worker B (isolated context)
```

v0.1 implements only the Lead/session longevity substrate. No subagent manager, worker pool, worktree scheduler, shared task list, or agent-team protocol is introduced.

## 16. v0.1 scope boundaries

Long Task Runtime v0.1 adds only the minimum substrate for autonomous cross-Session continuation:

```text
bounded Task Continuity checkpoint
pindie_task_handoff + terminal semantics
runtime control bus
Host-owned safe Session rollover + hidden resume
compaction-aware Context Governor
```

It does not add:

```text
subagents / agent teams / parallel workers
persistent plan / Slice / phase graph
Task queue or second Task identity
second Agent Loop or second evaluator
forced model-generated emergency summary Agent
automatic process restart/daemon recovery
model routing
Experience schema v4
Self-Improvement v0.6+
```

## 17. Implementation slices

Implement v0.1 as small reviewable slices rather than one large Agent Run.

```text
Slice A — Continuity + Handoff Substrate
Task fingerprint
latest continuity store
pindie_task_handoff
pending-handoff terminal semantics
focused unit/integration tests
NO automatic Session replacement

Slice B — Runtime Control + Automatic Rollover
session-bound control bus
Host rollover supervisor
safe settle ordering
fresh Session replacement
hidden runtime resume
NO Context Governor

Slice C — Context Lifecycle Governor
context usage observation
compaction-aware pressure state
bounded hidden guidance
handoff recommendation behavior
NO subagents

Slice D — Compatibility + Dogfood Closure
Task/State continuity across multiple automatic Sessions
user steer/follow-up precedence
Remote / reload / shutdown compatibility
Experience accounting checks
behavior/docs synchronization
```

Slices B–D should dogfood the capability as soon as enough of the previous slices exist to do so safely.

## 18. v0.1 success contract

Long Task Runtime v0.1 is complete when a real implementation Task can:

```text
receive one user request
        ↓
work in Session A
        ↓
commit a bounded handoff
        ↓
automatically replace the Session
        ↓
resume in Session B without fake user intent
        ↓
repeat when necessary
        ↓
complete the same durable Task
        ↓
return the final result
```

and all of these remain true:

1. The human never has to type `/new` or `continue` for normal long-task progression.
2. `PindieState` remains the only semantic Task authority.
3. Native Pi Session ID remains conversation identity; Session replacement never creates a new Task.
4. Pi compaction remains functional and is not replaced by the rollover mechanism.
5. Real user input is never lost to automatic rollover.
6. Failed checkpoint/replacement/resume paths fail closed without corrupting Task State.
7. No second Agent Loop, planner state machine, or subagent system is introduced.
8. Short Tasks remain behaviorally simple and do not expose Long Task ceremony.
