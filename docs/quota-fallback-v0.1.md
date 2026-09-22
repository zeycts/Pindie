# Pindie Quota Fallback v0.1 — Architecture and Implementation Contract

Status: architecture approved; implementation intentionally deferred until the current Pindie TUI v0.1 work is reviewed and merged.

Baseline: Pindie main with Pi 0.86.1 and the implemented Quota Auto Resume behavior in `docs/behavior.md`.

This document is the source of truth for Quota Fallback v0.1. Implementation Slices must follow this contract unless a reviewed architecture change updates this document first.

The purpose is narrow:

> when an OpenAI Codex subscription Run is stopped by confirmed subscription quota exhaustion, Pindie may temporarily continue the same Session and Task on a user-authorized pay-as-you-go DeepSeek backup model, then restore the original Codex model after the subscription reset at a safe idle boundary.

Quota Fallback is not a general multi-provider router. It is one explicit continuity mechanism for one known failure mode.

---

## 1. Mental model

Quota Auto Resume and Quota Fallback solve different problems.

```text
Quota Auto Resume
Codex quota exhausted
        ↓
wait until reset
        ↓
same Session + same Codex model
        ↓
continue

Quota Fallback
Codex quota exhausted
        ↓
temporarily switch model
        ↓
same Session + same Task
        ↓
continue immediately on DeepSeek
        ↓
after reset, restore Codex at safe idle
```

They must remain separate concepts.

The recovery order is:

```text
confirmed Codex quota exhaustion
        │
        ├─ Quota Fallback enabled + backup usable
        │        ↓
        │   commit fallback successor
        │
        └─ otherwise
                 ↓
           Quota Auto Resume
                 ↓
           wait for reset

If neither mechanism commits an automatic successor:
        ↓
ordinary stopped semantics
```

A successful fallback owns recovery for that quota incident. Quota Auto Resume must not also schedule a second continuation for the same incident.

---

## 2. Goals

Quota Fallback v0.1 must provide:

1. confirmed Codex subscription quota exhaustion as the only automatic trigger;
2. explicit human opt-in before pay-as-you-go backup usage;
3. one fixed backup target: `deepseek/deepseek-flash` (DeepSeek V4.1 Flash);
4. same-Session continuation;
5. unchanged Pindie Task / Verification / Human Gate semantics;
6. runtime-only ownership of the temporary fallback lease;
7. preservation of the source model identity and thinking level;
8. safe, non-interrupting restoration of the source Codex model after quota reset;
9. human model selection as higher authority than automatic fallback;
10. strict arbitration with existing Quota Auto Resume;
11. quiet successful continuity, consistent with existing Pindie attention policy;
12. fail-closed behavior when backup auth, model resolution, switching, or continuation cannot be established safely.

---

## 3. Non-goals

v0.1 does not introduce:

- a generic provider router;
- multiple ordered backup models;
- automatic model quality/cost optimization;
- automatic fallback for arbitrary provider errors;
- automatic fallback for ordinary model refusal, tool failure, timeout, or task failure;
- durable fallback state in `PindieState`;
- a second Session;
- transcript copying or migration;
- a second Agent Loop;
- a separate fallback Task;
- persisted workflow phases;
- a new model registry;
- custom DeepSeek protocol handling;
- a Pindie-owned reasoning compatibility table;
- a Pindie-owned spending ledger or budget engine;
- hidden retry loops beyond Pi's existing runtime behavior.

The DeepSeek account balance remains the external hard spending boundary in v0.1. Pindie's existing runtime cost presentation may report usage, but Quota Fallback does not create a new budget subsystem.

---

## 4. Ownership

Existing ownership remains authoritative:

```text
Human
  → whether paid fallback is enabled
  → explicit model selection
  → goals / taste / consequential judgment

Pindie Host
  → active AgentSessionRuntime ownership
  → runtime-only fallback lease
  → safe restoration timing
  → recovery arbitration

Pindie semantic layer
  → Task / Verification / Human Gate / capabilities
  → unchanged by model fallback

Pi
  → provider/model catalog
  → provider authentication
  → model invocation
  → AgentSession model mutation
  → thinking-level capability clamping
  → Session transcript
  → low-level Agent Loop / retries / compaction / queues

Model
  → interpretation and execution inside the same legal Pindie capability space

Reality
  → project facts
```

The core invariant is:

```text
Fallback changes the LLM backend, not Pindie's semantic truth.
```

No fallback fact becomes a Task fact merely because the active model changed.

---

## 5. Pi baseline and fixed backup target

Pi 0.86.1 already contains the native model:

```text
provider: deepseek
model:    deepseek-flash
name:     DeepSeek V4.1 Flash
API:      openai-completions
base URL: https://api.deepseek.com
context:  1,000,000
max output tokens: 384,000
input:    text + image
reasoning: supported
```

Pi also owns the DeepSeek compatibility behavior and thinking-level mapping.

Therefore Pindie must use Pi's native model catalog and authentication path. It must not register a duplicate DeepSeek provider or construct its own raw HTTP client.

The v0.1 backup identity is a constant:

```text
deepseek/deepseek-flash
```

It is intentionally not a user-selectable list in v0.1.

---

## 6. Trigger: confirmed quota exhaustion only

Quota Fallback reuses the same factual trigger standard as Quota Auto Resume.

An automatic fallback may be considered only when all of the following are true:

1. the latest conversation message is an assistant error;
2. provider is `openai-codex`;
3. the error matches the existing Codex quota-error signatures;
4. fresh subscription usage confirms an exhausted supported quota window;
5. the exhausted window has a valid future reset time;
6. the current Session, anchor entry, source provider, and source model still match the incident;
7. the Session is not streaming or compacting;
8. no pending Pi messages exist;
9. fallback is enabled for the current Session;
10. the fixed DeepSeek backup model is resolvable and authenticated.

A raw error string alone is not enough.

A stale subscription snapshot is not enough.

An arbitrary OpenAI API `insufficient_quota` condition outside the existing verified subscription-usage path must not silently widen v0.1 semantics.

### 6.1 Shared quota-recovery facts

Fallback and Resume should share one factual quota-recovery derivation rather than independently refreshing subscription usage.

Conceptually:

```text
terminal Codex quota candidate
        +
fresh subscription usage
        ↓
CodexQuotaRecoveryFacts
        ├─ sessionId
        ├─ anchorEntryId
        ├─ source provider/model
        ├─ detectedAt
        └─ resetAt
             │
             ├─ Quota Fallback planner
             └─ Quota Resume planner
```

The implementation may refactor the existing `QuotaResumePlan` derivation to expose a neutral factual substrate, but it must preserve existing Quota Auto Resume behavior.

Do not perform two independent network refreshes merely because two recovery policies consume the same facts.

---

## 7. Same-Session continuity

Fallback always stays in the current Pi Session.

```text
before
Session S
  model = openai-codex/<source>
  Task  = T

fallback
Session S
  model = deepseek/deepseek-flash
  Task  = T

restore
Session S
  model = openai-codex/<source>
  Task  = T
```

Do not:

- create a fallback Session;
- fork the Session;
- copy transcript messages;
- create a fallback Task;
- write model identity into `PindieState`;
- reset Verification merely because the model changed.

Pi's normal Session transcript remains conversation truth and records native model changes.

---

## 8. Runtime-only fallback lease

A committed fallback is represented only by Host/runtime state.

Conceptually:

```ts
interface QuotaFallbackLease {
  generation: number;

  sessionId: string;
  anchorEntryId: string;

  sourceModel: {
    provider: "openai-codex";
    modelId: string;
  };

  backupModel: {
    provider: "deepseek";
    modelId: "deepseek-flash";
  };

  sourceThinkingLevel: ThinkingLevel;

  detectedAt: number;
  resetAt: number;

  restoreDue: boolean;
}
```

This shape is illustrative, not a required exported interface.

The lease must not be persisted in:

- `PindieState`;
- Task continuity artifacts;
- Experience;
- Work Memory;
- strategy/policy artifacts;
- a new fallback database.

Process exit loses the lease.

Because Pi persists native Session model changes in the transcript, a process restart while the Session is on DeepSeek may reopen with DeepSeek selected. v0.1 must not guess the lost source model or reconstruct a lease from historical messages. The human may explicitly select the desired model after restart.

This is preferable to inventing durable fallback workflow state.

---

## 9. Fallback commit protocol

A fallback is considered committed only after the backup continuation has been safely established.

The intended sequence is:

```text
1. validate fresh recovery facts
2. validate current Session/source model/anchor
3. validate backup model availability/auth
4. capture source model + source thinking level
5. switch current Session to DeepSeek (non-persistent global default)
6. restore requested source thinking level through Pi
   → Pi clamps to DeepSeek-supported level
7. install runtime-only fallback lease
8. send one hidden fallback continuation with triggerTurn=true
9. classify fallback successor as committed
```

If a step before the hidden continuation cannot be established safely, fallback is not committed.

If model switching succeeds but the continuation cannot be queued, Pindie must make a best-effort safe rollback to the source model without triggering a turn, clear the fallback lease, and allow Quota Auto Resume to arbitrate recovery.

No half-committed fallback may suppress Quota Auto Resume.

### 9.1 Hidden continuation

Fallback continuation is runtime metadata, not new human intent.

Conceptually:

```text
<PINDIE_QUOTA_FALLBACK>

Runtime-generated continuation after the previous Agent Run was interrupted
by confirmed OpenAI Codex subscription quota exhaustion.

The active model has temporarily changed to the configured backup model.
This is runtime metadata, not new user intent.

Continue the latest actual user request using the current transcript and
the new Pindie Run Baseline. Do not broaden the user's request.

</PINDIE_QUOTA_FALLBACK>
```

Exact wording may be refined during implementation, but these semantics are required.

There is exactly one fallback continuation for one committed quota incident.

---

## 10. Reasoning preservation

Pindie must not maintain a DeepSeek-specific reasoning compatibility table.

Pi 0.86.1 owns model thinking capabilities and clamping. DeepSeek V4.1 Flash currently supports:

```text
off
low
high
max
```

The fallback supervisor captures the source Session's current thinking level before switching.

After switching to DeepSeek, it explicitly reapplies that requested level through Pi. Pi determines the effective DeepSeek level.

For the current Pi mapping this means, for example:

```text
source off    → DeepSeek off
source low    → DeepSeek low
source medium → DeepSeek high
source high   → DeepSeek high
source max    → DeepSeek max
```

This table documents current observed behavior only. It is not a Pindie policy table and must not be hard-coded in Pindie.

When restoring the source Codex model, Pindie reapplies the captured source thinking level through Pi.

If Pi's model metadata changes in a future upgrade, Pi's clamping remains authoritative.

---

## 11. Restoration after quota reset

The source model is restored only at a safe idle boundary.

The reset timer does not interrupt active work.

Example:

```text
18:00 Codex quota exhausted
18:00 fallback → DeepSeek
18:25 Codex reset time reached
18:25 DeepSeek is still running
      ↓
do not abort
do not switch mid-stream
      ↓
next safe idle boundary
      ↓
restore source Codex model
```

A safe restore requires at minimum:

```text
same Session
fallback lease still current
active model still equals backup model
not streaming
not compacting
pending message count == 0
```

If reset time arrives while those conditions are not true, the lease becomes `restoreDue` and restoration waits.

Restoration:

1. switches back to the captured source model;
2. reapplies the captured source thinking level through Pi;
3. clears the fallback lease;
4. does not trigger a new Agent turn;
5. does not synthesize user intent;
6. does not alter Task/Verification/Human Gate state.

### 11.1 No interruption to queued work

If Pi already has a queued steer/follow-up/successor when reset time arrives, restoration waits.

Quota Fallback does not reorder or cancel Pi's queues just to restore the preferred model.

This may allow one additional backup-model Run after the reset boundary in a race. That is acceptable in v0.1; preserving Pi queue semantics is more important than exact reset-time switching.

---

## 12. Human authority and cancellation

Explicit human model selection always wins over the fallback lease.

```text
automatic fallback
      ↓
temporary Host ownership

human explicitly selects any model
      ↓
human takes ownership
      ↓
drop fallback lease
      ↓
do not auto-restore the old source model later
```

The implementation must distinguish supervisor-owned model mutations from human model selection so that the fallback's own switch/restore events do not cancel themselves.

Do not infer this distinction from model identity alone if that creates a race. Use an explicit runtime mutation guard/generation or equivalent narrow mechanism.

### 12.1 User input is not cancellation

Ordinary user input while fallback is active does not cancel the fallback lease.

The user may continue to steer or add follow-up instructions while DeepSeek is temporarily active.

This differs from Quota Auto Resume waiting:

```text
Quota Resume waiting
  human input → planned automatic continuation is obsolete → cancel wait

Quota Fallback active
  human input → current temporary backend remains valid → keep lease
```

### 12.2 Session lifecycle

The fallback lease is Session-bound.

The lease must be cleared when the owned Session is replaced, switched away, invalidated, or the Host is disposed.

It must never migrate to a new Session automatically.

Long Task rollover and Quota Fallback remain separate runtime mechanisms. A Session replacement ends the old Session's fallback lease; v0.1 does not transfer a fallback lease across Long Task rollover.

---

## 13. Preference semantics

Quota Fallback is opt-in because it can spend pay-as-you-go API balance.

Default:

```text
quota fallback = off
```

Command:

```text
/quota-fallback
```

The intended preference behavior mirrors the existing `/quota-resume` interaction model:

```text
Enter   → change current Session
Ctrl+S  → save Global default + apply to current Session
Esc     → cancel
```

The fixed v0.1 choice is:

```text
on  → deepseek/deepseek-flash
off
```

There is no backup-model picker in v0.1.

The preference belongs in the existing Pindie global preferences surface, not in `PindieState`.

A possible stored field is:

```json
{
  "quotaFallback": true
}
```

The exact key may be chosen during implementation, but it must preserve unrelated preference fields atomically in the same manner as Quota Auto Resume.

### 13.1 Enabling requires a usable backup

When the user enables fallback, Pindie should verify that Pi can resolve the fixed DeepSeek model and that DeepSeek authentication is configured.

If the backup is unavailable, the command should report the problem instead of silently promising fallback coverage.

API keys remain owned by Pi/provider authentication. Pindie must never copy a DeepSeek API key into its preference file, Session custom entries, semantic State, logs, Remote messages, or UI projection.

---

## 14. Recovery arbitration

Quota Fallback and Quota Auto Resume use one ordered recovery decision.

For one confirmed Codex quota incident:

```text
A. attempt fallback eligibility/commit
   │
   ├─ committed
   │    → no quota-resume schedule for this incident
   │
   └─ not committed
        ↓
B. attempt existing quota-resume schedule
   │
   ├─ committed
   │    → wait quietly
   │
   └─ not committed
        ↓
C. ordinary stopped semantics
```

Remote completion/stopped classification must treat either a committed fallback successor or a committed quota-resume successor as automatic continuity.

Conceptually:

```text
automaticSuccessorCommitted =
  longTaskSuccessorCommitted
  OR fallbackSuccessorCommitted
  OR quotaResumeSuccessorCommitted
  OR other already-existing automatic successor semantics
```

Do not allow both fallback and quota-resume to independently claim the same incident.

---

## 15. Backup failure after fallback commit

v0.1 distinguishes initial fallback commit failure from a later backup Run failure.

### 15.1 Before fallback continuation is committed

If backup model resolution, auth, switching, reasoning application, or continuation enqueue fails:

```text
fallback not committed
→ best-effort rollback if needed
→ clear fallback lease
→ Quota Auto Resume may take over
```

### 15.2 After fallback continuation is committed

A later DeepSeek Run may itself terminate with a provider/auth/rate-limit transport error.

Pindie must not start a third-provider cascade.

If the original Codex reset time is still in the future and Quota Auto Resume is enabled, the recovery path may:

1. stop using the failed backup;
2. restore the captured source Codex model at a safe idle boundary without triggering a turn;
3. refresh/validate Codex subscription usage when needed;
4. schedule the existing Quota Auto Resume against the source model if still valid.

If that recovery cannot be established safely, ordinary stopped semantics apply.

Ordinary Task-level failure, verification failure, tool failure, or model-chosen stop while DeepSeek is functioning is not a backup-provider failure and must not automatically trigger this path.

---

## 16. TUI and presentation boundary

Quota Fallback must consume the final Pindie TUI/runtime boundary. It must not create a parallel model selector, status framework, or interaction layer.

This is why implementation is intentionally deferred until the current Pindie TUI v0.1 work is merged.

Required presentation facts are small:

```text
current model              → already Pi-owned
fallback preference        → runtime preference
fallback active            → Host runtime lease
source model               → Host runtime lease
reset/restore time         → Host runtime lease
```

Possible projection:

```text
Header:
Pindie · project                         DeepSeek V4.1 Flash · High

Timeline runtime transition:
↪ Quota fallback · Codex → DeepSeek
  Codex reset 18:25

Status while active:
fallback · until 18:25
```

Exact visual treatment is Slice D work and must fit the final TUI vocabulary.

Successful fallback is not a hard Attention state.

### 16.1 Human Signal Policy

Consistent with `docs/pindie-tui-v0.1.md`:

| Situation | Timeline | Local Attention | External notify |
| --- | --- | --- | --- |
| fallback committed successfully | runtime transition | no | no |
| fallback active | ambient status | no | no |
| source model restored successfully | optional compact runtime transition | no | no |
| fallback unavailable, quota-resume successfully scheduled | existing quota wait | no | no |
| both recovery paths unavailable and Task remains active | stopped semantics | existing policy | yes |
| backup provider later fails and quota-resume takes over | runtime transition / quota wait | no | no |
| backup provider fails and no successor commits | stopped semantics | existing policy | yes |

Successful autonomous continuity stays quiet.

---

## 17. Remote Companion and notification boundary

Remote Companion remains a projection/control surface over the same live Pi Session.

Quota Fallback must not:

- create a Remote-only fallback state;
- create a second conversation;
- send duplicate continuation messages through Discord;
- treat Discord as model-selection authority unless an existing explicit remote control action already owns that behavior.

Remote status may project the current model and fallback runtime state.

A successfully committed fallback or successful source-model restoration does not create an external attention notification by itself.

If all automatic recovery is exhausted and the Task remains active, existing stopped notification semantics apply.

---

## 18. Cost and accounting

A fallback Run is an ordinary Pi model Run using the DeepSeek provider.

Existing runtime cost accounting should consume Pi's model usage/cost metadata where available.

Do not:

- merge DeepSeek spend into OpenAI subscription quota percentages;
- fabricate a subscription-equivalent cost;
- write fallback spend into semantic State;
- maintain a second cost database.

Task cumulative runtime metrics may naturally include model-equivalent cost across Runs according to existing Pindie accounting rules.

Off-peak DeepSeek pricing may not be exactly representable by Pi's static catalog cost metadata. v0.1 accepts that limitation; do not add a time-of-day pricing engine solely for Quota Fallback.

---

## 19. Security and secrets

DeepSeek credentials are provider secrets.

Required invariants:

1. Pindie reads/uses auth only through Pi's provider/model runtime.
2. No API key is written to `PindieState`.
3. No API key is written to `preferences.json`.
4. No API key is appended to Session history.
5. No API key is included in hidden fallback metadata.
6. No API key is sent to Remote/Discord.
7. No API key is included in diagnostic errors beyond Pi's existing safe provider-auth behavior.

---

## 20. Failure and race invariants

The implementation must preserve these invariants:

1. One confirmed quota incident can commit at most one fallback continuation.
2. One incident cannot simultaneously own a fallback continuation and quota-resume continuation.
3. Fallback never changes semantic Task authority by itself.
4. Fallback never invalidates Verification merely because the model changed.
5. Source-model restoration never triggers a turn.
6. Reset-time restoration never aborts active work.
7. Human model selection cancels automatic restoration ownership.
8. Ordinary user input does not cancel an active fallback lease.
9. Session replacement clears the lease.
10. Process exit loses the lease.
11. Backup auth failure never blocks Quota Auto Resume from taking over.
12. Stale Session/anchor/model facts cannot authorize fallback.
13. Supervisor-owned model changes must not be mistaken for human overrides.
14. A late timer from an old lease cannot restore a model in a newer Session or generation.
15. A stale model-select event cannot mutate a newer lease.
16. No fallback action may persist a new global default model.
17. No fallback path may construct a provider outside Pi's model/runtime APIs.
18. No recovery path may manufacture a second Agent Loop.

Generation/fuse techniques are runtime implementation details and must remain ephemeral.

---

## 21. Interaction with existing systems

### Quota Auto Resume

Fallback has first recovery priority when enabled and usable.

Quota Auto Resume remains unchanged in meaning and becomes the second recovery path.

### Long Task Runtime

Fallback changes the active model within one Session.

Long Task rollover changes the Session while preserving a durable Task.

They are orthogonal.

A Session rollover ends the old fallback lease; v0.1 does not transfer it.

### Active Task Continuation

Fallback's hidden continuation is the automatic successor for the quota incident.

Do not also manufacture a normal semantic continuation probe solely because fallback occurred.

Existing continuation eligibility continues to use its own rules for later settled Runs.

### Experience / Learning

Fallback model identity and actual usage may already appear through existing Run/Experience attribution if that system records model/runtime facts.

Do not create a special `fallback experience` family.

### Verification

Model switching alone is not project mutation and does not invalidate evidence.

Normal project mutations performed by DeepSeek continue through the same Execution Gateway and Project Mutation Freshness rules.

---

## 22. Implementation sequencing gate

No Quota Fallback implementation Slice starts while the current Pindie TUI v0.1 work is still in progress.

Required order:

```text
1. finish current Pindie TUI work
2. review TUI PR
3. merge TUI to main
4. re-read merged main
5. run implementation-readiness review against this document
6. revise this document only if the final TUI/runtime boundary materially changed
7. start Quota Fallback Slice A
```

This document may be merged before the TUI implementation is complete because it is architecture-only and does not change runtime behavior.

---

## 23. Implementation Slices

Each Slice is implemented on a fresh branch from the then-current main, with focused tests, `pnpm run check`, commit, PR, review, and merge before the next Slice begins.

### Slice A — Runtime Model Control

Goal: expose only the Pi model controls that Host-owned fallback requires.

Scope:

- extend `PiRuntimeAdapter` with the smallest public operations needed to:
  - resolve the fixed model identity through Pi's model runtime;
  - determine whether provider auth is usable;
  - switch the active Session model without persisting a global default;
  - set/read the active Session thinking level;
- preserve active-Session-at-call-time semantics;
- add focused adapter tests.

Constraints:

- no fallback policy;
- no quota detection changes;
- no preferences;
- no TUI;
- no generic Pindie model registry;
- no raw DeepSeek HTTP client.

Exit condition:

```text
Host can safely ask Pi:
"can this exact model be used?"
"switch this active Session to this exact model"
"apply this thinking level"
without owning provider plumbing.
```

### Slice B — Fallback Core

Goal: implement temporary same-Session fallback and safe restoration as a Host runtime mechanism.

Scope:

- introduce neutral/shared Codex quota-recovery facts if needed;
- add `QuotaFallbackSupervisor` or equivalent narrow Host controller;
- validate Session/anchor/source-model freshness;
- capture source model + thinking level;
- switch to `deepseek/deepseek-flash`;
- install runtime-only lease;
- send one hidden fallback continuation;
- schedule reset-time restoration;
- wait for safe idle before restoring;
- clear on Host/session lifecycle;
- add deterministic unit tests for timers, stale generations, rollback, and safe restore.

Production behavior may remain disabled by an injected/default-false gate until preference wiring is added.

Constraints:

- no generic recovery-policy framework;
- no TUI;
- no Remote changes beyond seams required for later projection;
- no quota-resume semantic change yet beyond any neutral factual extraction necessary to avoid duplication.

### Slice C — Recovery Arbitration

Goal: integrate fallback with the existing settlement/recovery path without duplicate successors.

Scope:

- one fresh quota-recovery derivation;
- ordered decision:
  `fallback → quota-resume → stopped`;
- ensure one incident commits at most one automatic successor;
- preserve existing quota-resume behavior when fallback is disabled/unavailable;
- distinguish supervisor-owned model changes from explicit human model selection;
- explicit human model selection cancels an active fallback lease;
- ordinary user input does not;
- handle backup-provider terminal failure → source-model restore + quota-resume when safely valid;
- update Remote settlement successor classification so successful fallback suppresses false "stopped" signals;
- focused race/arbitration tests.

Constraints:

- do not introduce a generic successor scheduler;
- do not merge Long Task rollover, fallback, and quota resume into one persisted workflow state.

### Slice D — Preference + Final Pindie TUI Integration

Prerequisite: the current Pindie TUI v0.1 work has been reviewed and merged, and this contract has passed the post-merge implementation-readiness review.

Goal: expose fallback as an explicit paid-continuity preference using the final TUI boundaries.

Scope:

- `/quota-fallback`;
- default OFF;
- Session override;
- Ctrl+S Global default + current Session behavior consistent with `/quota-resume`;
- fixed DeepSeek target, no model list;
- refuse/diagnose enabling when backup model/auth is unavailable;
- preference persistence preserving unrelated fields;
- project Host fallback lease into the final TUI read model;
- compact Timeline/status treatment consistent with the final RuntimeBlock vocabulary;
- tests for preference restore/branch behavior and TUI action routing.

Constraints:

- do not create a parallel selector/palette/status system;
- use the final Pindie TUI Action Registry / extension UI boundary where applicable;
- do not expose or persist API keys.

### Slice E — Remote, Notifications, Hardening, Documentation Sync

Goal: close operational edges and synchronize implemented architecture.

Scope:

- Remote status projection of fallback state where useful;
- no external notification for successful fallback/restore;
- existing stopped notification only when no automatic recovery commits;
- end-to-end tests for:
  - quota exhaustion → fallback → DeepSeek continuation;
  - reset during active DeepSeek Run → deferred safe restore;
  - manual model selection → lease cancellation;
  - fallback unavailable → quota resume;
  - fallback switch/continuation partial failure → rollback → quota resume;
  - backup provider failure → quota resume when valid;
  - Session replacement/process disposal → stale timer cannot act;
  - no duplicate successor;
- run full `pnpm run check`;
- synchronize `docs/architecture.md`, `docs/behavior.md`, and `AGENTS.md` only to the final implemented state.

Exit condition:

Quota Fallback v0.1 is implemented, dogfooded enough to validate the contract, and the general architecture documents describe reality rather than aspiration.

---

## 24. Review checklist before Slice A

After Pindie TUI merges, re-read the then-current main and answer these before implementation:

1. What is the final public model-selection action path in Pindie TUI?
2. Does `PiRuntimeAdapter` already expose any new model mutation APIs?
3. How does the final TUI distinguish human model selection from runtime-owned model changes?
4. What Host/runtime facts are already available to the UI projection?
5. Did Quota Auto Resume ownership or settlement timing change?
6. Did Long Task rollover gain any new Session lifecycle signals relevant to lease cancellation?
7. Is `deepseek/deepseek-flash` still present in the pinned Pi version with the expected auth/reasoning metadata?
8. Can one shared subscription-usage refresh still feed both fallback and resume decisions?
9. Does Remote settlement still need an explicit successor-committed classification?
10. Are any implementation details in this document now redundant because Pi/TUI added a public primitive?

Only material incompatibilities justify revising the architecture. Do not reopen settled design merely for cleanup.

---

## 25. v0.1 invariants summary

```text
Fallback != Resume

same Task
same Session
same transcript
different temporary model

DeepSeek target is fixed
paid usage requires explicit opt-in
preference default is OFF

Pi owns provider/model/auth/reasoning compatibility
Pindie Host owns temporary fallback lease and recovery timing
Pindie semantic State does not change because of fallback

fallback first
quota-resume second
stopped last

successful fallback = one hidden successor
successful restore = zero new turns

reset never interrupts work
human model selection wins
ordinary user input does not cancel fallback
Session replacement/process exit ends runtime ownership

no multi-provider router
no second Agent Loop
no persisted fallback workflow
```
