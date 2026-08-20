# Pindie Core Extension v0.1 — Behavior Specification

This document is the behavioral contract for the approved v0.1 architecture. Tests should encode these rules before implementation expands.

## 1. Hard invariants

### I1 — One current task
`state.task` is either `null` or one `PindieTask`. v0.1 has no task queue.

### I2 — Completed task is terminal
A completed task must have no Human Gate, blockers, unresolved questions, or next intent, and its verification must be currently passed. The completed task cannot be mutated; a later `start_task` may replace it with a new task.

### I3 — Stale verification has no current evidence
If `verification.stale === true`, `verification.checks` must be empty.

### I4 — Verification references valid criteria
Every entry in `VerificationCheck.covers` must reference an existing success criterion ID.

### I5 — Criterion IDs are unique
Criterion IDs are Extension-generated and unique within the task.

### I6 — Verification check names are unique
A current verification set contains at most one check per `name`. Later records use upsert semantics.

### I7 — One Human Gate
At most one Human Gate may be open.

### I8 — Done requires current evidence
`task.completed === true` implies derived verification status is `passed`.

### I9 — Task Contract requires success criteria
Every active or completed task must contain at least one success criterion.

## 2. Soft invariants

These guide model behavior but cannot be fully proven by the State machine:

The Task Contract fields have distinct responsibilities:

- `goal` is the intended durable outcome.
- `constraints` are durable task-wide execution boundaries or requirements.
- `successCriteria` are final observable outcomes: the final, durable Definition of Done that must be true at task completion and remain meaningful across sessions.

Session-local choreography, sequencing, and checkpoint instructions are not automatically persisted merely because they appear in the current run. When unfinished work needs a persisted continuation direction, `openLoops.nextIntent` carries only the likely next meaningful step.

- Observe relevant reality before consequential action.
- Understand the problem before changing it.
- Choose the smallest safe next action.
- Do not silently expand scope.
- Resume after session/gate/blocker interruption through Observe.
- Leave consequential product taste and architecture judgment to the human.
- Verification evidence must truthfully describe real tool/runtime evidence.

## 3. Derived statuses

### Task status

```text
state.task === null                         → idle
task.completed                              → done
task.humanGate !== null                     → waiting_human
task.openLoops.blockers.length > 0          → blocked
otherwise                                   → active
```

### Verification status

```text
verification.stale                          → stale
checks.length === 0                         → pending
any current check failed                    → failed
all success criteria covered by passed checks → passed
otherwise                                   → pending
```

## 4. State Machine behavior contract (implemented in PR 2)

Open Loops are updated through one semantic `set_open_loops` event that atomically replaces `blockers`, `questions`, and `nextIntent`.

- T01 Start first task.
- T02 Reject starting a second active task.
- T03 A new task may replace a completed task.
- T04 Refining goal invalidates verification.
- T05 Refining constraints invalidates verification.
- T06 Replacing success criteria regenerates IDs and invalidates verification.
- T07 No-op refinement preserves semantic State.
- T08 Adding a blocker derives `blocked` status.
- T09 Removing the final blocker derives `active` status when no gate exists.
- T10 Unresolved questions do not block active execution but do block completion.
- T11 New task verification is pending.
- T12 Partial passed coverage remains pending.
- T13 Full current passed coverage derives `passed`.
- T14 Any current failed check derives `failed`.
- T15 Same-name verification checks are upserted.
- T16 Unknown success-criterion references are rejected.
- T17 Project mutation invalidates passed verification.
- T18 Repeated invalidation is idempotent.
- T19 Recording fresh verification clears `stale` and begins a new current evidence set.
- T20 Completion with pending verification is rejected.
- T21 Completion with failed verification is rejected.
- T22 Completion with stale verification is rejected.
- T23 Completion with blockers is rejected.
- T24 Completion with unresolved questions is rejected.
- T25 Completion with a Human Gate is rejected.
- T26 Valid completion sets the task terminal and clears `nextIntent`.
- T27 Refining a completed task is rejected.
- T28 Altering open loops on a completed task is rejected.
- T29 Recording verification on a completed task is rejected.
- T30 Opening a Human Gate on a completed task is rejected.
- T31 Opening a Human Gate derives `waiting_human`.
- T32 Opening a second Human Gate is rejected.
- T33 Opening a Human Gate without a task is rejected.
- T34 Resolving a Human Gate returns to the derived non-gate status.
- T35 Resolving a missing Human Gate is rejected.

## 5. Custom Tool behavior contract (implemented in PR 4)

- T36 `pindie_gate(open)` persists `waiting_human` State before returning a terminating tool result.
- `pindie_state` exposes only `start_task`, `refine_task`, `set_open_loops`, `record_verification`, and `complete_task`; no arbitrary state patch API.
- The public `pindie_state` action contract is:
  - `start_task`: `goal` and `successCriteria` required; `constraints` and `nextIntent` optional.
  - `refine_task`: only `goal`, `constraints`, and `successCriteria`; at least one required.
  - `set_open_loops`: `blockers` and `questions` required; `nextIntent` optional.
  - `record_verification`: `check` required; no other semantic fields.
  - `complete_task`: `action` only.
- `pindie_gate` exposes only `open` and `resolve`.
- `complete_task` is a request to the validator, never direct permission to set `completed`.
- Successful `complete_task` persists completed State before returning a terminating tool result.
- A terminating tool result is Pi's early-termination hint for its tool batch; automatic follow-up is skipped only when every finalized result in that batch is terminating. PR 5 verifies this behavior in the integrated Pi runtime.
- Tool mutation must be sequential when multiple calls affect the same State.
- Error results must be actionable and explain why a transition was rejected.
- Successful `start_task` results expose every generated success criterion ID and description.
- Successful `refine_task` results expose the current criterion mapping, including regenerated IDs when success criteria change.
- `record_verification.check.covers` accepts current success criterion IDs, not criterion descriptions; unknown-ID rejections list the valid current IDs.

## 6. Pi integration behavior contract (implemented in PR 5)

- T37 `session_start` loads project State.
- T38 `/new` in the same project preserves the same current Pindie task.
- T39 Different repositories resolve to different State.
- T40 Different subdirectories of one Git repository resolve to one State.
- T41 `before_agent_start` injects the Core Policy.
- T42 `before_agent_start` injects Current State.
- T43 Injection does not duplicate Pindie policy/context blocks.
- T44 Successful `edit` invalidates current verification.
- T45 Successful `write` invalidates current verification.
- T46 Failed `edit` does not invalidate verification.
- T47 `read` does not invalidate verification.
- T48 Generic `bash` calls are not blindly treated as project mutation.
- T49 `agent_settled` never auto-completes a task.
- T50 Successful integrated `complete_task` persists completed State, returns a terminating result, and terminal-task guards block later consequential mutation and same-run `pindie_state(start_task)` calls.

`terminate: true` remains Pi's tool-batch early-termination hint. Human Gate and completed-task safety do not depend on that hint alone: `tool_call` also blocks consequential work while a gate is open or the current task is completed. Successful `edit` and `write` results invalidate verification through `PindieRuntime.dispatch()`; failed edits, observation tools, and generic `bash` results do not.

`before_agent_start` is the Agent-run boundary for transient guard permissions. These permissions are not persisted in `PindieState`:

- RG01-RG02 A Human Gate opened during the current Agent run cannot be refined away or resolved during that same run.
- RG03-RG04 A Human Gate already present when the Agent run begins permits `pindie_state(refine_task)` and `pindie_gate(resolve)`.
- RG05 Resolving a pre-existing Gate A and opening Gate B does not permit Gate B to be refined or resolved in the same run.
- RC01-RC02 A task completed during the current Agent run cannot be replaced or followed by consequential mutation during that same run.
- RC03 A completed task already present when the Agent run begins may be replaced by one new task.
- RC04 Replacing completed Task A and completing Task B does not permit Task C to start in the same run.

Read-only observation remains available throughout these boundaries. A later Agent run may consume a persisted Human Gate or replace a completed task because the consequential state was already present at that run's start.

## 7. State Store behavior contract (implemented in PR 3)

- T51 Missing State file loads empty State.
- T52 Malformed JSON fails loudly and preserves the corrupted file.
- T53 Semantically invalid State fails load rather than silently resetting.
- T54 Save is atomic (`temp → rename`).

## 8. End-to-end paths

### E2E-01 — Normal success

```text
User task
→ start_task
→ Observe / refine task contract
→ Act
→ mutation invalidates verification
→ Verify
→ full current evidence
→ complete_task
→ Done
```

### E2E-02 — Verify / fix / verify

```text
Act
→ Verify fails
→ Observe failure
→ Act fix
→ verification stale
→ Verify again
→ passed
→ complete
```

### E2E-03 — Human Gate across session boundary

```text
active task
→ gate opened
→ waiting_human persisted
→ terminating tool result returned
→ user answers later
→ State reloads
→ task contract refined
→ gate resolved
→ Observe reality again
→ continue
```

### E2E-04 — External blocker

```text
active
→ blocker discovered
→ blocked
→ external condition changes
→ Observe
→ blocker removed
→ active
→ continue
```

### E2E-05 — Premature completion attempt

```text
some criteria verified
→ model calls complete_task too early
→ Extension rejects with missing/unverified criteria
→ model continues working
```

## 9. v0.1 Core Extension acceptance target

The eventual v0.1 core is accepted when it can:

- persist one current task per project
- survive Pi session changes
- inject Core Policy and Current State
- create/refine semantic work State through controlled tools
- invalidate known verification after project mutation
- track verification against success criteria
- refuse premature completion
- support Human Gate and resume
- support blocked and resume
- keep completed tasks terminal
- avoid a second Agent Loop
- avoid task queues, history systems, and memory databases
