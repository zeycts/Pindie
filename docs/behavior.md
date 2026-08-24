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

### Task Boundary & Intent Reconciliation v0.1

Before consequential project action, reconcile latest actual user intent with the current Task after any needed read-only observation: start when no unfinished Task exists, continue when intent still belongs to the Task without material Contract change, refine when it does with a material Contract change, and replace an unfinished Task only when intent clearly requests a different Task. Stop, pause, inspection, explanation, or discussion alone does not mutate State or authorize consequential continuation. Use the existing Human Gate for consequential ambiguity; these relationships are Core decision discipline, not persisted State or controller machinery.

### Early Task Admission v0.1

- **ETA01-ETA02** With idle or done State, when latest intent clearly requests a new consequential outcome and already provides enough information for a truthful Task Contract, call `pindie_state(start_task)` before consequential project execution.
- **ETA03-ETA04** Observation-only, explanation, discussion, pause, and return-control intent creates no Task and authorizes no consequential Task work.
- **ETA05** Task-free read-only observation may precede reconciliation only when genuinely needed to understand intent, project reality, the Task boundary, or the Task Contract.
- **ETA06** Generic `bash` remains consequential and is never reclassified through command parsing.
- **ETA07** Insufficient information for a truthful Task Contract must not create a placeholder Task merely to unlock consequential tools.
- **ETA08** Existing unfinished-Task CONTINUE, REFINE, and REPLACE semantics remain unchanged.
- **ETA09** A successfully persisted same-run `start_task` backs subsequent consequential execution through existing Task-Backed Execution.
- **ETA10** Early Task Admission adds no State field, persistent flag, controller, public tool, shell allowlist, or new execution path.

### Task-Backed Execution v0.1

- **TBE-E01-E02** With idle State, `read`, `grep`, `find`, `ls`, and `pindie_git_observe` remain Task-free; only `pindie_state(start_task)` is admitted as a consequential transition.
- **TBE-E03-E08** Idle State blocks `edit`, `write`, generic `bash` (including `git status`), unknown consequential tools, non-start State actions, and Human Gate actions.
- **TBE-E09-E11** A successfully persisted same-run `start_task` backs subsequent consequential execution but does not make the new Task replaceable in that Run.
- **TBE-E12-E14** State availability and authoritative coherence refresh precede Task admission; unavailable or stale Runs fail closed with their existing reasons.
- **TBE-E15-E20** Existing completed-task, Human Gate, active-task, read-only no-refresh, and continuation behavior remains unchanged.

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
- TB01-TB09 `replace_task` atomically replaces only an unfinished current Task with a clean fresh Task Contract, open loops, verification, and no Human Gate; idle rejects with `NO_CURRENT_TASK`, completed rejects with `TASK_COMPLETED`, and existing `start_task` boundaries remain unchanged.
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
- `pindie_state` exposes only `start_task`, `replace_task`, `refine_task`, `set_open_loops`, `record_verification`, and `complete_task`; no arbitrary state patch API.
- The public `pindie_state` action contract is:
  - `start_task`: starts a new Task; `goal` and `successCriteria` required; `constraints` and `nextIntent` optional.
  - `replace_task`: replaces a different unfinished current Task; `goal` and `successCriteria` required; `constraints` and `nextIntent` optional.
  - `refine_task`: changes the existing Task Contract; only `goal`, `constraints`, and `successCriteria`; at least one required.
  - `set_open_loops`: `blockers` and `questions` required; `nextIntent` optional.
  - `record_verification`: `check` required; no other semantic fields.
  - `complete_task`: `summary` required; no other semantic fields.
- `pindie_gate` exposes only `open` and `resolve`.
- `complete_task` is a request to the validator, never direct permission to set `completed`.
- `complete_task.summary` is an ephemeral, user-facing summary of the completed outcome. It is not persisted in Pindie State.
- Successful `complete_task` persists completed State before returning a terminating tool result that includes the supplied summary and recorded verification evidence from current State.
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
- T41 `before_agent_start` injects stable Core Policy only.
- T42 `context`, before every LLM call, appends fresh ephemeral Runtime Context projected from current State.
- T43 Core injection and repeated Runtime Context projection do not duplicate Pindie blocks/messages or rewrite other Pi/session messages.
- T44 Successful `edit` invalidates current verification.
- T45 Successful `write` invalidates current verification.
- T46 Failed `edit` does not invalidate verification.
- T47 `read` does not invalidate verification.
- T48 Generic `bash` calls use Project Mutation Freshness rather than being blindly classified from command text.
- T49 `agent_settled` never auto-completes a task.
- T49a If Pi delivers an old Agent Run's final `agent_settled` after session replacement or reload invalidated its ExtensionContext, Pindie ignores only Pi's specific stale-context error before mutating runtime State or accessing UI; unrelated errors still propagate.
- T50 Successful integrated `complete_task` persists completed State, returns a terminating result, and terminal-task guards block later consequential mutation and same-run `pindie_state(start_task)` calls.

### Active Task Continuation v0.1

- AC01 An active Task continues across response, turn, and low-level Agent Loop boundaries only while latest actual user intent still calls for consequential execution of this current Task and a safe executable next action remains. `nextIntent` records continuation context; it does not authorize yielding or overriding later user intent merely because further implementation, replanning, or verification iterations are needed.
- AC02 `agent_end` is the only continuation decision point. Pindie decides whether semantic work should continue; when eligible, Pi performs it through one hidden CustomMessage continuation probe queued with `pi.sendMessage(..., { deliverAs: "followUp" })` and Pi's existing `agent.continue()` machinery. The probe first re-evaluates whether latest intent belongs to this current Task: it reconciles a clearly different Task through permitted `replace_task`, and settles normally for pause, observation, explanation, discussion, return-control, or ambiguity rather than resuming consequential work. Pindie creates no second Agent Loop.
- AC03 Eligibility requires available State, a current uncompleted Task, no Human Gate, no blockers, a final assistant `stopReason` of `stop`, no pending Pi messages, and an unused extension-local fuse. Questions alone do not suppress continuation.
- AC04 `aborted`, `error`, and `length` stops never continue automatically. Existing pending messages, Pi retry, compaction, user interrupt, and error handling remain Pi-owned and are not overridden.
- AC05 The extension-local fuse resets at `before_agent_start` and permits at most one automatic continuation before final `agent_settled`. A Pi-native follow-up remains in the same user-driven Agent Run and does not reset the fuse, Run Timer, Run Cost baseline, Current Activity Run semantics, Human Gate snapshot boundary, or adaptive reasoning. A second normal stop settles normally.
- AC06 Continuation state is runtime-only: it is absent from `PindieState`, persistence, and task status. Session shutdown, State unavailability, and the next user-driven Agent Run clear the transient allowance.

### Run Timer v0.1

- RT01 `before_agent_start` starts one runtime-only Run timer from a monotonic clock; it is independent of the persistent Pindie Task and State.
- RT02 While an interactive Run is active, the timer updates the unified Pindie status line approximately once per second as `⏱ <duration>` without model calls or persistence.
- RT03 `agent_settled` finalizes the current Run, clears its ticker, and retains `last <duration>` in the Pindie status line. Session shutdown/reload clears transient timer state and status presentation.
- RT04 A later Agent Run replaces any prior transient timing, so consecutive Runs cannot share a start time.
- RT05 Successful `complete_task` output includes `Duration: <duration>` from the Run timer's authoritative elapsed duration; the completion renderer does not calculate timing independently.

### Run Cost v0.1

- RC01 `before_agent_start` captures the cumulative public-session `usage.cost.total` baseline at the same boundary that starts Run Timer. `agent_settled` freezes the non-negative incremental difference after all follow-up work has settled; a later Run replaces it and session shutdown/reload clears it.
- RC02 Session cost mirrors Pi's footer aggregation: assistant-message, tool-result, compaction, and branch-summary usage costs are included when present and finite. Run Cost never reimplements pricing, persists data, or changes State/runtime behavior.
- RC03 Run Cost is informational runtime-only presentation. It may update when authoritative entries arrive, uses Pi-reported model-equivalent cost even for subscription-backed models, and is not necessarily an invoice charge.

### Current Activity v0.1

- CA01 Current Activity is runtime-only observable Pi execution activity for compact status presentation, not Pindie State and not a semantic Observe / Understand / Decide / Act / Verify / Update State Core Loop phase.
- CA02 `before_agent_start` starts a clean active Run at `thinking`. Public `tool_execution_start` / `tool_execution_end` track active executions by `toolCallId`; `agent_settled`, `session_shutdown`, and `session_start` clear all tracking. No historical session entries are reconstructed.
- CA03 Known tool names map as: `read` / `grep` / `find` / `ls` / `pindie_git_observe` → `reading`; `edit` / `write` → `editing`; `bash` → `running`; `pindie_state` / `pindie_gate` → `updating`; unknown tools → `working`. No model prose, hidden reasoning, individual Git-observe action inspection, or bash command parsing is used.
- CA04 With no active tools in an active Run, Current Activity is `thinking`; simultaneous tools of one mapped kind retain that kind; multiple mapped kinds render `working`. Unknown/duplicate tool ends are harmless. When the final short-lived tool ends, its activity may remain visible for a small bounded presentation interval before returning to `thinking`; actual active tools always take precedence and linger is presentation-only. No activity survives settlement or session reset.
- CA05 Current Activity is presentation-only. Lifecycle tracking, status rendering, or one-shot linger-expiry refresh failure cannot alter tool execution, State transitions, Human Gates, or Agent Runs. Tool start/end immediately refresh existing status; Run Timer remains the only periodic timer.

### Adaptive Reasoning v0.1

- AR01 Runtime-only reasoning resets at `session_start` to Auto, requested Medium, with its effective level synchronized from Pi; session shutdown/replacement clears the transient controller.
- AR02 `before_agent_start` requests Medium in Auto for every user-driven Agent Run; Fixed reapplies its selected request. Pi remains authoritative for effective level and model capability clamping.
- AR03 Only `/reasoning` changes Pindie's Auto/Fixed mode. `thinking_level_select` only synchronizes effective level and refreshes presentation.
- AR04 At `turn_end`, only a turn with one or more tool results may adapt Auto. Priority is: any tool error or failed verification → High; passed verification → Low; clean current High → Medium; successful built-in edit/write → Low; otherwise → Medium.
- AR05 Fixed ignores Auto evidence. Auto requests only Low, Medium, or High; Fixed may request `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- AR06 Reasoning is neither Pindie semantic State nor State Store/session/project persistence. It adds no model routing, phase inference, tool-set changes, history, cache behavior, or keyboard shortcut.

### Efficiency Inspector v0.1

- EI01 `/efficiency` is an on-demand, read-only command. With no arguments it reports the current runtime ReasoningController mode/requested/effective levels, `ctx.getContextUsage()`, and public `ctx.sessionManager.getEntries()` usage facts with existing Run Cost; it sends no model message, appends no session entry, and changes no Pindie State, State Store, reasoning request, Pi thinking level, model, tools, or status line.
- EI02 Session totals mirror Pi footer semantics: assistant-message, usage-bearing tool-result, compaction, and branch-summary usage contribute input, output, cache read, and cache write. The report does not create independent Pindie usage/cache state or count synthetic Runtime Context separately.
- EI03 Latest request means the latest assistant message usage. Its CH is `cacheRead / (input + cacheRead + cacheWrite) * 100` only when that denominator is positive; it never substitutes an older assistant request and does not expose session-wide cache metrics.
- EI04 Context is only `ctx.getContextUsage()`: known tokens/percent render against the context window, temporarily unknown values render `? / <window>`, and unavailable context renders unavailable. `/efficiency` with arguments only shows `Usage: /efficiency` and is otherwise side-effect free.

### Pindie Status Line v0.1 — Verification + Alerts

- SL01 Pi owns the infrastructure footer; Pindie owns exactly one semantic current-work status entry (`pindie-status`) beneath it. Pindie does not replace Pi's footer.
- SL02 The status line orders available segments as Run timing, Run Cost, Auto indicator when runtime reasoning is Auto, Current Activity, Task lifecycle, verification, then one actionable attention condition. The compact `auto` segment is absent in Fixed mode; Pi continues to render actual model and effective thinking separately. Segments are derived from runtime timing, Current Activity, reasoning mode, State, and direct runtime availability—not persisted display state.
- SL03 Verification progress is distinct passed-criterion coverage over total success criteria. Overlapping passed checks do not double-count; failed checks do not add coverage.
- SL04 Pending verification renders `verify <covered>/<total>`; stale renders `verify stale` without historical progress; failed renders `verify failed <covered>/<total>`; passed renders `✓ <covered>/<total>`; no task omits verification.
- SL05 Attention is absent normally. State-unavailable is an error alert. Otherwise an open Human Gate takes precedence, then an active stale Run renders `⚠ stale run`, then a blocker renders `⚠ blocked`.
- SL06 Semantic segments use the active Pi theme individually: `dim` for timing, Run Cost, account usage, and separators; `accent` for Current Activity; `text` for normal verification; `success` for passed verification; `warning` for stale/gate/blocked; and `error` for failed verification or State-unavailable.
- SL07 Successful Pindie State/Human Gate transitions and known verification invalidation refresh the status after persistence. Tool execution start/end refresh Current Activity immediately. All status presentation is best-effort and cannot alter semantic or runtime behavior, including the result of an already committed State transition. Timer ticks remain the only periodic refresh. Session shutdown clears the one status entry.
- SL08 The status line has a left current-work region and an optional right account-resource region. ChatGPT Codex usage is runtime-only and best-effort: a declared-duration-identified 7-day window (including backend `limit_window_seconds`) renders remaining percentage as `◉ <remaining>%` and optional reset countdown as `↻ <countdown>`, both dim. The countdown is derived at status render time from `resetsAt`: at least 24 hours renders `d+h`, at least one hour renders `h+m`, at least one minute renders `m`, and less than one minute renders `<1m`; an expired timestamp omits the reset segment. The authoritative usage-summary manual reset count, when positive, appends dim `⟳ <count>`; a complete set of usable available `codex_rate_limits` details may append its nearest future expiry as ` · <countdown>`. Credit expiry uses days only at least 24 hours, then `h+m`, `m`, or `<1m`; expired, unavailable, failed, or incomplete details show count only. Detail coverage is complete in v0.1 only when eligible available detail rows are at least the authoritative count, so a capped list never guesses an expiry. Details are fetched only after a positive count, and their failure cannot discard the weekly data or count. This read-only observation never consumes a credit. It is fetched through Pi's runtime global fetch—therefore follows Pi's standard proxy environment/configuration—at session start and no more than once per five minutes thereafter; it is never persisted or allowed to affect Pindie State/runtime behavior.

### Status Semantic Alignment v0.1

- **SSA01-SSA03** Loaded idle State renders `idle`; executable unfinished Tasks render `active`; completed Tasks render `done`.
- **SSA04-SSA05** Verification and Task lifecycle remain independent: passed verification does not imply done. Blocked and waiting-human Tasks retain their existing attention segments without duplicate lifecycle labels.
- **SSA06-SSA08** An active Agent Run whose external-State epoch differs from its run-start snapshot renders `⚠ stale run`; it clears on Agent settlement and fresh Run snapshot. Attention precedence is State unavailable > Human Gate > stale Run > blocker.
- **SSA09** `read`, `grep`, `find`, `ls`, and `pindie_git_observe` all present as `reading`.
- **SSA10** Status alignment is runtime-only presentation: it changes no State, Runtime Context, or execution semantics.

`terminate: true` remains Pi's tool-batch early-termination hint. Human Gate and completed-task safety do not depend on that hint alone: `tool_call` also blocks consequential work while a gate is open or the current task is completed. Successful `edit` and `write` results invalidate verification through `PindieRuntime.dispatch()`; failed edits, observation tools, and generic `bash` results do not.

`before_agent_start` is the Agent-run boundary for transient guard permissions. These permissions are not persisted in `PindieState`:

- TB18-TB28 An unfinished Task that existed at `before_agent_start` may be replaced exactly once only while its object identity remains the current Task. A Task started, replaced, or semantically mutated during the Run is not replaceable; ordinary consequential tools remain allowed after a legal replacement. This permits direct replacement of pre-existing active, blocked, or gated Tasks, while a Gate opened during the Run blocks replacement.
- RG01-RG02 A Human Gate opened during the current Agent run cannot be refined away or resolved during that same run.
- RG03-RG04 A Human Gate already present when the Agent run begins permits `pindie_state(refine_task)` and `pindie_gate(resolve)`.
- RG05 Resolving a pre-existing Gate A and opening Gate B does not permit Gate B to be refined or resolved in the same run.
- RC01-RC02 A task completed during the current Agent run cannot be replaced or followed by consequential mutation during that same run.
- RC03 A completed task already present when the Agent run begins may be replaced by one new task.
- RC04 Replacing completed Task A and completing Task B does not permit Task C to start in the same run.

Read-only observation remains available throughout these boundaries. A later Agent run may consume a persisted Human Gate or replace a completed task because the consequential state was already present at that run's start.

### Project State Coherence v0.1

- **PSC-V01-V03** Internal `invalidate_verification` reopens a completed/passed Task to unfinished stale verification after known mutation; completed Tasks remain terminal to every model-facing semantic action.
- **PSC-L01-L12 / FIX-L01-L08** `FileStateStore.withProjectLock(projectRoot, operation)` serializes same-project State critical sections with an atomic `state.lock` directory, never serializes different projects, releases only matching token ownership in `finally`, and uses bounded retry. Valid live or uncertain PID owners are never stolen because of age. A valid confirmed-dead owner is reclaimed only after one reclaimer atomically claims an in-lock marker and rechecks the exact owner identity and liveness. Missing or corrupt ownership metadata is fail-closed and never age-stolen in v0.1. Busy is a transient `StateLockBusyError`, not State unavailability.
- **PSC-R01-R04** `PindieRuntime.refresh()` loads disk authority. A deep-equal load preserves State and Task object identity and epoch; a differing load is adopted and increments only the runtime external-State epoch; failed loads preserve the working snapshot and throw.
- **PSC-D01-D09** Dispatch locks, reloads, compares with the State against which the event was decided, then reduces/saves/publishes. Stale ordinary events throw `PindieStateConflictError` after adopting authority; only internal invalidation safely rebases. Save still precedes publish.
- **PSC-A01-A13** Run start refreshes before identity snapshots. Consequential preflight detects external change and makes the remainder of that Run read-only; read/grep/find/ls and `pindie_git_observe` remain available. The next user-driven Run snapshots the current epoch and recovers normally. A stale Run does not queue Active Task Continuation. Busy, conflict, and unavailable State remain distinct.

### Project Mutation Freshness v0.1

- **PMF-E01-E04** Only an admitted ambiguous consequential tool (`bash` or unknown/custom consequential tool) joins a runtime-only shared mutation window after all ordinary guards pass; its first call captures BEFORE and overlapping calls share that baseline. Blocked calls, Safe Observation, Pindie semantic tools, and edit/write do not probe.
- **PMF-E05-E10** The matching `tool_result` consumes its `toolCallId`; the window remains until every pending tool settles. Known equal baseline/current Git-visible worktree content preserves verification regardless of tool success/failure; changed or unknown freshness dispatches existing `invalidate_verification` and clears current checks.
- **PMF-F01-F14** A Git fingerprint deterministically hashes tracked plus nonignored untracked worktree paths and raw contents/mode, symlink target text, and tracked missing paths. It excludes index/HEAD/branch metadata, ignored artifacts, and mtimes; non-Git or unsafe/unsupported/bounded-out observations are unknown and fail closed only for verification freshness.

### Safe Observation v0.1

- **SO01-SO04** `pindie_git_observe` accepts only `status`, `branch`, `root`, `diff`, `diff_cached`, `diff_check`, `log`, and `remote`; it exposes no command, args, flags, executable, shell, cwd, or environment input. Paths are diff-only positional paths after `--`; log has a fixed bounded limit.
- **SO05-SO08** It directly invokes fixed Git argv without a shell, with pager/prompt/optional-lock/lazy-fetch/fsmonitor hardening and external diff/textconv disabled for diff actions. Output is bounded, timeout and Pi AbortSignal terminate the child, and nonzero Git exits are errors.
- **SO09-SO11** It is read-only for Extension guards before State/coherence/Gate/terminal preflight, so it remains available with completed State, an open Gate, stale Run, or unavailable State. It does not save or mutate Pindie State, verification, Gate, or external-State epoch; generic `bash` remains consequential.

Project coherence does not hold State locking across arbitrary edit/write/bash execution. A narrow project-tool TOCTOU race remains between consequential preflight and project mutation; later State invalidation/dispatch is still protected.

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
- inject stable Core Policy and project current Runtime Context per LLM call
- create/refine semantic work State through controlled tools
- invalidate known verification after project mutation
- track verification against success criteria
- refuse premature completion
- support Human Gate and resume
- support blocked and resume
- keep completed tasks terminal
- avoid a second Agent Loop
- avoid task queues, history systems, and memory databases

### Execution Hygiene v0.1

- **EH01** Temporary execution and verification resources have explicit operation ownership.
- **EH02** One interactive smoke invocation uses one unique, disposable owned workspace.
- **EH03** Cleanup affects only resources created by that invocation.
- **EH04** Owned process trees originate at spawn-time ownership; broad PID or name matching is forbidden.
- **EH05** Success, failure, and timeout clean by default; explicit keep mode preserves files only.
- **EH06** Stale recovery is namespace-bound and age-bound and cannot touch fresh or foreign resources.

## 10. Pindie Skill Integration v0.1

### SR01 — Pi owns Skill runtime mechanics

Pi is the only Skill runtime. Pindie does not implement a Skill registry, loader, selector, discovery, validation, collision resolver, lifecycle manager, or command system. It introduces no `SkillRuntime`, `SkillRegistry`, `SkillLoader`, `SkillResolver`, or `SkillSelector` abstraction.

### SR02 — Pindie exposes bundled Skills through Pi

`package.json` declares `./skills` in `pi.skills` while preserving `./src/extension.ts` in `pi.extensions`. Pi discovers that package resource; Pindie does not scan it. v0.1 bundles one approved directory Skill, `git-workflow`, and keeps the configured Skill root free of root-level Markdown candidates.

### SR03 — Progressive disclosure is preserved

Pindie does not inject complete Skill bodies into Agent Runs. Pi continues to provide discovery metadata/index in the system prompt and loads `SKILL.md` on demand. `injectPindieCore()` preserves every incoming Pi-generated Skill metadata block unchanged and replaces only its own stable `<PINDIE_CORE>...</PINDIE_CORE>` block. Dynamic State is a separate request-time Runtime Context projection, not system-prompt or Skill content.

### SR04 — Skills are subordinate to Pindie Core

A Skill is an optional specialized procedure, not policy authority. It cannot override, in order: runtime/safety constraints, latest user intent, observed project reality, Pindie Core invariants, the current Task Contract, Verification requirements, or Human Gates. A Skill cannot bypass an open Gate or verification, illegally mutate a completed task, silently expand scope, or prefer stale State to observed reality.

### SR05 — Skills own no persistent Pindie State

`PindieState`, the reducer, and persistence schema contain no Skill lifecycle data. Pindie does not persist `activeSkill`, `skillsUsed`, `skillProgress`, `skillStep`, `skillHistory`, `skillState`, or a separate Skill state file. Skill selection and local progress remain reconstructable runtime/context information.

### SR06 — Skills receive no privileged execution path

A Skill may guide use of ordinary Pi or extension tools, including `read`, `edit`, `write`, `bash`, `pindie_state`, and `pindie_gate`. Every resulting call follows the same Pi execution, `tool_call` guards, State transitions, completed-task rules, Human Gate rules, and verification invalidation rules as any other call.

### SR07 — Skills do not change Verification semantics

Loading or reading a Skill is observational and does not invalidate Verification. Existing mutation behavior remains authoritative: successful `edit` or `write` invalidates Verification; failed edits, reads, and unsupported generic mutation inference do not. T47 already proves the read-only behavior, so no Skill-specific duplicate test is required.

### SR08 — Explicit Skill invocation remains Pi-owned

Pi owns explicit `/skill:<name>` invocation. Pindie adds no `pindie_skill` tool and no `activate_skill`, `deactivate_skill`, `use_skill`, or other Pindie Skill command system.

### SR09 — Skill configuration failure is not State failure

A malformed, unavailable, conflicting, or invalid Skill is a Pi Skill resource/configuration problem. It must not unload the Pindie runtime, mark Pindie State unavailable, corrupt State, or block consequential work through the State-unavailable path.

### SR10 — No inferred active Skill lifecycle

Pindie creates no inferred `skill_started`, `skill_active`, or `skill_finished` lifecycle and no Skill status-line segment. Reading `SKILL.md` proves only that it was read. Without a future authoritative Pi Skill lifecycle event, Pindie does not infer semantic activity.

### SR11 — Skill source and trust remain Pi-owned

Pindie creates no parallel `~/.pindie/skills` or `.pindie/skills` location. Pi remains responsible for global, project, package, and configured Skill resolution; priority; project trust; collisions; and reload behavior.

## 11. git-workflow Skill v0.1

`git-workflow` is a narrow delivery procedure for a code-changing task that should reach a reviewable branch or pull request. Pi remains responsible for selection: intended routing includes requests to implement/fix and open a PR, commit and push changes, continue a task branch/PR, or use the repository's normal branch/PR workflow. It is not intended for read/explain/inspection tasks, Git knowledge questions, or a bare `git status` request.

### GW01 — Observe Git reality before mutation

Before the first consequential Git action, observe the smallest relevant set of current branch, working tree status, and repository context. Inspect remote, upstream, recent commits, or existing PR context only when needed; do not mechanically run every Git command.

### GW02 — Do not assume local changes belong to the Task

Modified, untracked, and staged files do not automatically belong to the current Task. Never automatically reset, restore, clean, or stash them. When ownership cannot be determined reliably and proceeding would be consequential, use the existing Pindie Human Gate rather than a Git-specific confirmation mechanism.

### GW03 — One Task uses one focused working branch

For code-changing PR delivery, move from `main`/`master` to one focused task branch. Reuse a branch that clearly belongs to the Task; do not create another branch merely to make the procedure appear complete. When uncommitted changes on `main`/`master` are confirmed to belong to the Task, create or switch to that focused branch while preserving them and commit there rather than on `main`/`master`.

### GW04 — Repository convention outranks Skill defaults

Observe repository branch names, commit-message style, PR template, and delivery workflow before using a default. Respect conventions such as `feature/foo` or `bugfix/foo`; only absent clear convention may use a simple `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/` fallback.

### GW05 — Prepare the branch before normal implementation when practical

For a new code-changing Task on clean `main`/`master`, prefer inspect → create focused branch → implement. If confirmed current-Task changes already exist on `main`/`master`, preserve them while creating or switching to the focused branch, then continue the normal pre-commit workflow. Do not implement on main first merely to create a branch later, and never destroy, rewrite, stash, or discard existing work to force this sequence; ambiguous ownership follows GW02.

### GW06 — The Skill does not orchestrate implementation

After branch preparation, Pindie Core owns implementation and Verification. Do not require status after each edit, commits after each implementation step, or Git checkpoints after every Core Loop iteration; use delivery boundaries such as task start, pre-commit, pre-PR, and review update.

### GW07 — Inspect the actual diff before staging

Before committing, re-observe the real change set with appropriate status, unstaged diff, and staged-diff inspection. The pending diff—not agent memory—is the source of truth for what will be submitted.

### GW08 — Exclude unrelated changes

Commit only changes intended for the current Task. Do not silently commit, discard, or restore unrelated work; leave it untouched unless current user intent includes it.

### GW09 — Inspect before broad staging

Use inspect change set → identify intended Task changes → stage. Broad staging is acceptable only after verifying the full working tree belongs to the Task; this is not a universal ban on valid Git commands.

### GW10 — Commit message follows repository reality

Prefer the repository's commit-message convention. When none is clear, use a concise semantic message such as `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`, `test: ...`, or `chore: ...` that describes the actual commit rather than copying a large Task description.

### GW11 — Normal push is default; history rewrite is exceptional

A new task branch may use `git push -u origin <branch>` and an existing upstream branch `git push`. Force pushes, force-with-lease, published-history rewrites, and remote-branch deletion are exceptional: observe consequences first and use the existing Human Gate when unknown remote work could be overwritten or consequential judgment is needed.

### GW12 — PRs are focused and evidence-based

Use an existing PR template when present; otherwise keep PR content minimal with `## Summary` and `## Verification`. Verification names only checks actually run—never invent tests, builds, or manual evidence. Do not create a generic PR-template system.

### GW13 — PR creation is not merge authorization

A request to implement and open a PR normally ends with the PR opened, updated, or ready for review. Do not merge merely because the PR exists or checks are green; merge requires explicit current user intent and existing Pindie safety constraints. This Skill adds no merge automation.

### GW14 — Review feedback begins from current reality

For review updates: read actual feedback → inspect current branch/code → make targeted changes → re-verify → inspect diff → commit → push. Feedback remains subordinate to current user intent, Task Contract, project reality, Verification, Human Gates, and Core invariants; do not mechanically implement scope-expanding or consequential suggestions.

### GW15 — Destructive Git operations are outside the normal happy path

Do not use `git reset --hard`, `git clean -fd`, discarding unknown local work, rewriting published history, force pushing, or deleting potentially unmerged branches as shortcuts. Observe the consequence, prefer safer options, and use the existing Human Gate for consequential human judgment. No separate destructive-command policy engine exists.

### GW16 — The Skill never decides Pindie Task completion

Branch prepared, commit created, pushed, PR opened/updated, and Git-delivery-ready are delivery milestones only. Task completion remains exclusively the Task Contract plus current Verification and cleared blockers, questions, and Human Gate under existing completion invariants; the Skill never calls completion because a PR milestone was reached.

### Dogfood cases

- **GD01 — New delivery task from main:** From clean `main`, “Implement X and open a PR” inspects Git, creates a focused branch, implements, verifies, inspects the diff, stages intended changes, commits, pushes, and opens a PR; it must not commit directly to main.
- **GD02 — Existing Task branch:** From `feat/foo` that clearly belongs to the Task, “Continue implementing X and update the PR” reuses `feat/foo` and does not create a redundant branch.
- **GD03 — Unknown dirty working tree:** From `main` with pre-existing modified/untracked files, “Implement X and submit a PR” observes and preserves unknown work; it must not reset, restore, clean, blindly stash, or blindly include it. Use a Human Gate if safe ownership cannot be determined.
- **GD04 — Pure observation task:** “Explain how `PindieRuntime.dispatch()` works” must not route to `git-workflow` merely because the repository uses Git.
- **GD05 — Git knowledge question:** “What does `git rebase --onto` do?” must not route to `git-workflow` merely because it mentions Git.
- **GD06 — Unrelated changes before commit:** With Task changes A/B and unrelated pre-existing C, commit A/B and leave C untouched; do not silently commit or discard C.
- **GD07 — Existing PR review feedback:** With a Task branch and PR, “Fix the review comments” reads the actual focused feedback, makes a targeted change, re-verifies, inspects the diff, commits, and pushes the existing branch without creating a second PR.
- **GD08 — PR without merge authorization:** “Implement this and open a PR” ends with a PR opened/ready for review and does not merge automatically.
- **GD09 — Diverged remote / force-push temptation:** When normal push is rejected because the remote diverged, inspect divergence first. Never immediately force-push; use a Human Gate if proceeding could overwrite unknown remote work.
- **GD10 — Confirmed Task changes already exist on main:** From dirty `main` with all relevant uncommitted changes confirmed as current-Task work, “Submit the completed changes through the normal branch/PR workflow” inspects the actual state and diff, creates or switches to a focused branch while preserving the changes, verifies, stages intended changes, commits, pushes, and opens or updates the PR. It must not commit directly to `main`, reset, restore, blindly stash, or discard the changes.
