# Pindie Long Task Runtime v0.1 — Architecture Contract

Status: implemented, dogfooded, compatibility-closed, frozen.

Frozen means the v0.1 architecture contract is closed, not that bugs can never
be fixed.

Long Task Runtime lets one durable Pindie Task survive as many finite Pi Context Windows as necessary without requiring the human to manage Sessions manually.

```text
Task lifetime != Session lifetime
```

The human submits one Task. Pindie may compact or replace working Context internally and continues autonomously until the Task completes, reaches a Human Gate, becomes truly blocked, or a runtime safety boundary returns control.

## 1. Mental model and context lifecycle

A Pi Session is working memory, not Task identity. The logical Lead Agent is a role attached to the durable Task, not an immortal Session.

```text
Durable Task
────────────────────────────────────────────>

Session A          Session B          Session C
working memory     fresh memory       fresh memory
    │                  │                  │
    └── handoff ───────┴── handoff ──────┘
                                           │
                                           ▼
                                     Task Complete
```

Long-horizon context management has three different mechanisms:

```text
subagent delegation  → isolate context-heavy side work        (later)
Pi compaction        → compress the current working memory     (existing)
Session rollover     → replace the whole working-memory epoch  (v0.1)
```

Pi compaction remains the normal in-Session compression mechanism. A fresh Session is appropriate when the model reaches a clean semantic handoff boundary or when repeated post-compaction context pressure indicates that continuing the same Session is becoming inefficient or unstable.

Context percentage is advisory resource pressure, never semantic correctness or a hard Task boundary.

v0.1 solves vertical longevity only. Subagents, worker pools, worktrees, and parallel coordination remain later context-isolation/parallelism work.

## 2. Durable Task authority and continuity memory

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

Long Task Runtime does not introduce a Task queue, phase machine, Slice database, persistent plan, second Task ID, or Session-scoped Task copy. `openLoops.nextIntent` remains the authoritative durable statement of the next meaningful Task direction.

The only new durable artifact is a bounded working-memory checkpoint outside `PindieState`:

```text
TaskContinuityV1
├── schemaVersion: 1
├── checkpointId
├── createdAt
├── taskFingerprint
├── sourceSessionId
├── progressSummary
└── decisions[]
```

`progressSummary` is a compact snapshot of where the whole Task currently stands. `decisions[]` contains only still-relevant decisions that a fresh Session cannot cheaply reconstruct from project Reality.

The checkpoint deliberately does not duplicate:

```text
goal / constraints / success criteria
blockers / questions / nextIntent
verification / Human Gate / completion
Git branch / HEAD / filesystem facts
raw tool results / diffs / logs
conversation transcript / chain of thought
```

Those already have better authoritative sources and are re-observed or projected from State.

Storage is project-local, atomic, and latest-only, for example:

```text
~/.pindie/projects/<project-id>/continuity.json
```

This is bounded current working memory, not a history database. Loss or corruption of the checkpoint must never corrupt Task truth.

### Task binding

v0.1 does not add a persistent Task UUID solely for Long Task Runtime. A deterministic Task Contract fingerprint binds the checkpoint to the current Task:

```text
taskFingerprint = hash(
  goal,
  constraints,
  successCriteria ids + descriptions
)
```

Mutable execution facts such as `nextIntent`, blockers, questions, verification, and completion are excluded. A non-matching checkpoint is stale and cannot be used for automatic continuation.

## 3. Model handoff and terminal boundary

The model gets one explicit affordance:

```text
pindie_task_handoff
```

Conceptual input:

```text
progressSummary
decisions[]
nextIntent
```

`nextIntent` is applied through the existing Task progress transition and remains authoritative in `PindieState`; it is not duplicated into the continuity artifact.

A handoff means:

> The Task remains unfinished, but the current Session has reached a coherent working-memory boundary and may be replaced after safe settlement.

It does not complete the Task and does not create a subtask or phase. It is legal only for a coherent active Task.

### Fail-closed handoff admission

A handoff must represent a stable work frontier. Therefore it is accepted only when no other tool call is already in flight for the current Run.

This matters for Pi turns that contain multiple/parallel tool calls:

```text
other tool admitted first
→ handoff sees in-flight work
→ handoff rejected

handoff admitted first
→ terminal latch armed
→ every later tool_call in the Run is rejected
```

The model can retry the handoff alone on a later turn after current tool work settles.

Once accepted, the runtime creates a Session/Run-bound `PendingHandoff` and arms a terminal latch. No later observation, semantic, or project tool may extend the represented working state.

If an unexpected late result or runtime ordering anomaly still proves that work crossed the handoff frontier, the pending handoff is invalidated fail-closed and no rollover occurs.

Existing automatic continuation probing is suppressed while a valid handoff is pending.

## 4. Settlement, checkpoint commit, and user precedence

The handoff tool never replaces the Session while its own Agent/tool lifecycle is active.

On accepted handoff:

```text
validate active/coherent Task
        ↓
apply nextIntent through Task progress
        ↓
stage progressSummary + decisions
        ↓
create PendingHandoff bound to native Session ID + Run generation
        ↓
arm terminal latch
        ↓
finish current turn
```

The durable checkpoint is committed only after the Run reaches `agent_settled`, after normal Run Experience settlement.

At settlement, Pindie revalidates:

```text
PendingHandoff still valid
source Session is still current
Task is still coherent + active
Task Contract fingerprint still matches
no real user input is already pending
no Human Gate or true blocker owns control
```

The pending-user check is a native Pi queue check and includes both `steer` and
`followUp` messages. It is repeated by Host at the automatic replacement
boundary; a Human message accepted before that boundary keeps the outgoing
Session in control.

Then:

```text
build TaskContinuityV1
        ↓
atomic write continuity.json
        ↓
publish one committed rollover request to Host
```

If persistence fails, no automatic Session replacement occurs.

Real user input always outranks automatic rollover. User input already accepted into the outgoing Pi Session before the rollover linearization point must keep that Session in control. Input accepted after native Session replacement belongs to the new Session. Long Task Runtime never silently drops or migrates a real user message.

## 5. Host control and automatic rollover

Extension-hosted semantic integration only needs to tell the Host one thing:

```text
CommittedRolloverRequest
├── sourceSessionId
├── checkpoint
└── runtime correlation/generation as needed
```

The concrete wiring is a tiny process-local, non-durable, session-bound control bridge. It is not a generic event bus and carries no Task authority, planner state, or LLM logic.

### Pi 0.84.4 compatibility boundary

The pinned Pi 0.84.4 runtime starts an idle `sendCustomMessage(...,
{ triggerTurn: true })` by entering its agent loop directly. That native path
does not run the `before_agent_start` preflight that Pindie uses to establish
Run authority and the Run Baseline. Pindie therefore carries a small pnpm
patch at the Pi runtime boundary that applies the existing preflight to this
one custom-trigger path while preserving the custom runtime-message role.
The patch does not copy Pi's Agent Loop or change Pindie semantic ownership.

Remove the patch once the pinned Pi release includes the shared turn-start
preflight described by [Pi PR #8262](https://github.com/earendil-works/pi/pull/8262),
after conformance tests confirm that an idle custom runtime turn dispatches
the normal Pindie `before_agent_start` path. Pi's native
`sendCustomMessage()` Promise still represents the full triggered run in
0.84.4, so the Host starts it without awaiting that Promise and observes a
later rejection fail-closed.

The Host already owns the active `AgentSessionRuntime`, so settlement, replacement, and the new active Session do not need to be mirrored back through another event platform.

The extension also reports each native `session_shutdown` boundary to the
Host control lease. The supervisor cancels pending rollover requests and
TaskMetrics leases for manual `/new`, `/resume`, `/fork`, `/reload`, and quit
boundaries, and resets its safety-chain counter even when `/reload` reuses the
same native Session ID. The one exception is the `new` shutdown emitted by the
Host's own in-flight automatic `newSession` transaction; that exact transaction
keeps its lease until the fresh Session is installed. A released Host lease
cannot receive late lifecycle notices, so shutdown and process restart leave no
reusable automatic state.

Conceptually:

```text
Pindie extension
      │
      │ committed rollover request
      ▼
Host control bridge
      │
      ▼
Pindie Host
      │
      ▼
PiRuntimeAdapter / AgentSessionRuntime
```

Every request is bound to native Pi Session identity. A stale Session cannot replace the current Host runtime.

### Native replacement transaction

The Host performs rollover through Pi's existing `AgentSessionRuntime.newSession({ withSession })` transaction rather than reproducing teardown/rebind logic.

```text
committed checkpoint
        ↓
Host verifies sourceSessionId == activeSessionId
        ↓
final pending-user/runtime guard
        ↓
runtime.newSession({ withSession })
        ↓
Pi emits native shutdown, teardown, create and InteractiveMode rebind
        ↓
withSession receives ReplacedSessionContext for the NEW Session
        ↓
Host sets the fresh Session's native display name
        ↓
Host checks the fresh Session's native user/run queue
        ↓
Host injects hidden runtime-resume custom message only when no Human input won
```

Host-owned automatic continuation Sessions receive a bounded native Pi lineage display name (`cont. N · base`) so the Session selector keeps them recognizable. This is presentation metadata only; it is not Task, continuity, Experience, or LLM context data.

`withSession` runs after Pi applies/rebinds the replacement Session, so v0.1 does not need a reverse “new Session endpoint registered” channel. If Human input is accepted while that rebind is in progress, the fresh Session remains in control and stale hidden resume is suppressed; Pindie does not copy the input into another queue.

Replacement cancellation/failure does not mutate Task truth. The Task remains active; there is no infinite automatic retry loop. Because Experience is settled before the committed replacement request, these outcomes add no replacement Run record.

Automatic rollover has a finite runtime safety fuse. The exact default is tuning, not architecture.

## 6. Fresh-Session resume

Automatic continuation must not fabricate a human message such as `continue`.

Inside Pi's replacement `withSession` callback, Host sends one hidden custom runtime message to the fresh Session with `triggerTurn: true` using `ReplacedSessionContext.sendMessage(...)`.

The new Agent Run therefore receives:

```text
normal authoritative Pindie Run Baseline
+
hidden runtime continuation message:
  progressSummary
  carried decisions
  explicit "not new user intent" marker
```

The authoritative `nextIntent`, Task contract, blockers, Verification, and Human Gate remain in the normal State projection; the resume message does not duplicate them.

The model re-observes project Reality where needed and treats continuity as advisory working memory, not factual proof.

A checkpoint is consumed automatically only by the Host-owned rollover flow that created it. v0.1 does not inject the latest checkpoint into arbitrary manual `/new`, `/resume`, or process-restart Sessions. Crash/restart autonomous recovery is later work.

## 7. Context Governor and compaction

Context Governor is a Session-scoped, runtime-only advisory observer. Its only
pressure vocabulary is:

```text
normal → elevated → high
```

It observes Pi's factual context usage and successful compaction lifecycle. Pi's
`context` extension event is the ephemeral projection point: before each
provider call, the Governor observes the current usage and, when the existing
Long Task semantic gate allows it, appends one hidden custom message to that
provider context. While pressure remains elevated or high, the current guidance
is re-projected for every provider context. These messages are not sent through
`pi.sendMessage()`, are not session entries, and do not accumulate in Session
history.

A successful compaction creates a new comparison epoch, resets pressure to
`normal` until a known usage sample arrives, and makes the first later known
percentage the post-compaction baseline. Threshold and overflow compactions are
pressure-driven compactions; manual compaction creates the same baseline epoch
but does not increase the pressure-driven count. Failed or aborted compactions
do not create an epoch. The first successful compaction does not imply rollover.

The Governor never calls `pindie_task_handoff`, triggers Session replacement, or
triggers compaction. It only advises Luna to continue bounded work at elevated
pressure, or to converge and use the existing semantic handoff affordance once a
stable frontier exists at high pressure. Exact percentage thresholds and
regrowth delta remain injectable implementation tuning, not architecture
constants.

Pi compaction remains authoritative for in-Session history compression. Current-session continuity after compaction is supplied by Pi plus Pindie's existing authoritative State Checkpoint, not by re-injecting an old rollover checkpoint that may already be stale.

## 8. Autonomy, Experience, and future subagents

The autonomous lifecycle returns control only on:

```text
Task Complete  → final result
Human Gate     → wait for human authority
True Blocker   → return blocker facts
runtime safety fuse / replacement failure → return with Task still unfinished
```

Ordinary short Tasks expose no Long Task mode or ceremony:

```text
Task → one Session → complete
```

There is no `/long` command and no durable `longTask=true` Task type.

Long Task Runtime v0.1 does not change Experience schema. A large Task naturally creates multiple ordinary Runs/Experiences across Sessions. At settlement, an eligible ordinary Run freezes its own Run timer, Run cost, Policy/attribution, execution, and outcome and attempts one immutable schema-v4 record; repeated settlement notifications cannot add another record. A Run with no Task or non-policy execution remains ineligible rather than receiving a fabricated record.

Each Experience keeps that Run's own duration and cost. Human status and Task completion instead present cumulative Task-owned active Run time and model-equivalent cost; the process-local Host preserves that accumulator across automatic rollover without counting idle time between Runs. Task cumulative metrics are never copied into schema-v4 `metrics`, are not stored in `PindieState` or `TaskContinuityV1`, and do not survive process restart.

The outgoing Run's Experience is frozen before its continuity checkpoint is committed. A fresh automatic Session starts new Run-scoped Policy, attribution, timer, and cost bookkeeping; its hidden resume message is runtime metadata, not Human intent, and cannot create a record by itself. Trial, Adaptation, and Derivation leases are all one-Run runtime state: they clear at their Run boundary or Session replacement and never carry across automatic rollover, while a deliberately selected promoted revision remains recorded with `revisionStatusAtRun = promoted`. Cancelled or failed replacement does not enter a continuation Run and does not fabricate Experience. Handoff and rollover are non-project-mutating runtime control and must not manufacture project execution evidence or false Policy declarations.

Future Self-Improvement may learn when to hand off or which Policy works in long-horizon situations, but v0.1 contains no learned rollover policy.

Subagents solve context isolation and parallel breadth, not coordinator longevity. Future architecture may therefore look like:

```text
Durable Task
    ↓
Logical Lead
    ├── Lead Session A → handoff → Lead Session B
    ├── future Worker A (isolated context)
    └── future Worker B (isolated context)
```

v0.1 contains no subagent manager, worker pool, shared task list, worktree scheduler, or agent-team protocol.

## 9. Implementation slices (complete)

v0.1 was implemented as small reviewable slices. The compatibility and dogfood
closure is complete:

```text
Slice A — Continuity + Handoff Substrate
Task fingerprint
latest continuity store
pindie_task_handoff
in-flight admission + terminal latch
PendingHandoff settlement/commit
NO automatic Session replacement

Slice B — Host Control + Automatic Rollover
one-way session-bound control bridge
Host rollover supervisor
safe source-session validation
newSession({ withSession })
hidden custom resume turn
NO Context Governor

Slice C — Context Lifecycle Governor
context usage observation
compaction-aware pressure state
bounded hidden guidance
NO subagents

Slice D — Compatibility + Dogfood Closure
one real Task across multiple automatic Sessions
user steer/follow-up precedence
Remote / reload / shutdown compatibility
Experience accounting
behavior/docs synchronization
```

All four slices are implemented and dogfooded. The v0.1 contract is
compatibility-closed and frozen; this freezes the architecture contract, not
bug fixing.

## 10. v0.1 success contract

Long Task Runtime v0.1 is complete. Its closed success contract is:

```text
receive one user request
        ↓
work in Session A
        ↓
commit bounded continuity
        ↓
automatically replace the Session
        ↓
resume in Session B without fake user intent
        ↓
repeat when useful
        ↓
complete the SAME durable Task
        ↓
return final result
```

while all remain true:

1. The human never types `/new` or `continue` for normal long-task progression.
2. `PindieState` remains the only semantic Task authority.
3. Native Pi Session ID remains conversation identity; Session replacement never creates a new Task.
4. Pi compaction remains functional and is not replaced by rollover.
5. Handoff cannot commit across concurrent/in-flight tool work.
6. Real user input is never lost to automatic rollover.
7. Failed checkpoint/replacement/resume paths fail closed without corrupting Task State.
8. No second Agent Loop, planner state machine, or subagent system is introduced.
9. Short Tasks remain behaviorally simple and expose no Long Task ceremony.
