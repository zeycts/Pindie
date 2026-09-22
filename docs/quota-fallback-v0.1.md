# Pindie Quota Fallback v0.1 — Architecture Contract

Status: design approved; implementation is intentionally deferred until the current Pindie TUI v0.1 work is reviewed and merged.

Baseline: Pindie main with Pi 0.86.1 and the existing Quota Auto Resume behavior in `docs/behavior.md`.

This document is the implementation contract for Quota Fallback v0.1.

The goal is narrow:

> When an OpenAI Codex subscription Run stops because subscription quota is confirmed exhausted, Pindie may temporarily continue the same Session and Task on the user-authorized pay-as-you-go DeepSeek backup model, then restore the original Codex model after quota reset at a safe idle boundary.

Quota Fallback is not a general model router.

---

## 1. Fixed decisions

These decisions are settled for v0.1:

```text
Fallback != Resume

same Task
same Session
same transcript
temporary model change only

backup = deepseek/deepseek-flash
fallback default = OFF

fallback first
quota-resume second
stopped last

Pi owns provider/model/auth/reasoning compatibility
Pindie Host owns temporary fallback timing and lease
Pindie semantic State does not change because of fallback

successful fallback → exactly one hidden continuation
successful restore  → no new Agent turn

reset never interrupts active work
explicit human model selection wins
ordinary user input does not cancel an active fallback
```

No implementation Slice may silently widen these semantics.

---

## 2. Ownership

Existing ownership remains:

```text
Human
  → enables paid fallback
  → explicit model selection
  → goals and consequential judgment

Pindie Host
  → active AgentSessionRuntime ownership
  → runtime-only fallback lease
  → recovery arbitration
  → safe restore timing

Pindie semantic layer
  → Task / Verification / Human Gate / capabilities
  → unchanged by fallback

Pi
  → model catalog
  → provider auth
  → model invocation
  → AgentSession model mutation
  → thinking-level clamping
  → Session transcript
  → Agent Loop / retries / compaction / queues
```

The invariant is:

```text
Fallback changes the LLM backend, not Pindie's semantic truth.
```

Fallback must not create a second Session, Task, Agent Loop, provider registry, workflow state machine, or model router.

---

## 3. Fixed backup model

Pi 0.86.1 already provides:

```text
deepseek/deepseek-flash
= DeepSeek V4.1 Flash
```

Pindie must use Pi's native model catalog and authentication path.

Do not:

- register another DeepSeek provider;
- call DeepSeek through a Pindie-owned raw HTTP client;
- store API keys in Pindie preferences or State;
- add a backup-model picker in v0.1.

The DeepSeek account balance is the external spending boundary. v0.1 does not add a Pindie budget engine.

---

## 4. Trigger and shared quota facts

Fallback uses the same factual standard as existing Quota Auto Resume.

Automatic fallback is eligible only when:

1. the latest conversation message is an assistant error;
2. provider is `openai-codex`;
3. the error matches the existing Codex quota signatures;
4. fresh subscription usage confirms an exhausted supported quota window;
5. that window has a valid future reset time;
6. Session, anchor entry, source provider, and source model still match;
7. the Session is not streaming or compacting;
8. no Pi messages are pending;
9. fallback is enabled;
10. the DeepSeek backup is resolvable and authenticated.

A raw error string or stale usage snapshot is not enough.

Fallback and Resume should consume one factual derivation:

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
             ├─ fallback decision
             └─ resume decision
```

Do not refresh the same subscription facts twice merely because two policies consume them.

The implementation may refactor the existing Quota Resume planning code to expose this neutral factual substrate, but existing Resume behavior must remain unchanged when Fallback is disabled or unavailable.

---

## 5. Same-Session fallback lease

Fallback always stays in the current Pi Session:

```text
Session S / Codex / Task T
        ↓
Session S / DeepSeek / Task T
        ↓
Session S / Codex / Task T
```

No Task or Verification transition occurs merely because the model changes.

A committed fallback is represented only by Host/runtime state. Conceptually:

```ts
{
  sessionId,
  anchorEntryId,

  sourceModel: { provider: "openai-codex", modelId },
  backupModel: { provider: "deepseek", modelId: "deepseek-flash" },

  sourceThinkingLevel,

  detectedAt,
  resetAt,
  restoreDue
}
```

This lease is runtime-only.

It must not be persisted in:

- `PindieState`;
- Task continuity artifacts;
- Experience;
- Work Memory;
- policy/strategy artifacts;
- a new fallback database.

Process exit loses the lease.

Pi may persist the model change in the Session transcript. After process restart, Pindie must not guess the lost source model or reconstruct a lease from old transcript entries.

---

## 6. Fallback commit protocol

Fallback is committed only after the backup continuation has been established.

Required order:

```text
1. validate current quota-recovery facts
2. validate current Session/source model/anchor
3. validate DeepSeek model + auth
4. capture source model + thinking level
5. switch current Session to DeepSeek
   - do not persist a new global default
6. reapply source thinking level through Pi
7. install runtime-only fallback lease
8. send exactly one hidden fallback continuation
9. mark fallback successor committed
```

The hidden continuation uses `triggerTurn: true` and is runtime metadata, not user intent.

Its meaning is:

```text
The prior Run stopped because confirmed Codex quota was exhausted.
The active model is temporarily the configured backup.
Continue the latest actual user request from the current transcript and
Pindie Run Baseline. Do not broaden the request.
```

If switching succeeds but the continuation cannot be queued:

```text
best-effort restore source model
→ clear fallback lease
→ fallback is NOT committed
→ Quota Auto Resume may take over
```

A half-committed fallback must never suppress Resume.

---

## 7. Reasoning preservation

Pindie does not own a DeepSeek-specific reasoning mapping.

Before fallback, capture the source Session thinking level.

After switching to DeepSeek, reapply that level through Pi. Pi clamps it to what the target model supports.

With Pi 0.86.1, DeepSeek V4.1 Flash currently supports:

```text
off / low / high / max
```

So `medium` currently clamps to `high`. That is Pi behavior, not Pindie policy.

When restoring Codex, reapply the captured source thinking level through Pi.

If Pi's model metadata changes later, Pi remains authoritative.

---

## 8. Safe restoration

Quota reset does not interrupt DeepSeek work.

```text
resetAt reached
   │
   ├─ Session safe idle
   │      → restore source Codex model
   │
   └─ Session busy / compacting / queued work
          → mark restoreDue
          → wait for next safe idle boundary
```

Safe restore requires at minimum:

```text
same Session
same current fallback lease
active model == backup model
not streaming
not compacting
pending message count == 0
```

Restoration:

1. switches back to the captured source model;
2. reapplies the captured source thinking level;
3. clears the fallback lease;
4. does not trigger a new Agent turn;
5. does not create user intent;
6. does not alter Task/Verification/Human Gate.

Do not abort or reorder Pi queues merely to restore the preferred model.

A race may allow one additional DeepSeek Run after the nominal reset time. That is acceptable; preserving runtime correctness is more important than switching at the exact millisecond.

---

## 9. Human authority and lease cancellation

Explicit human model selection always wins.

```text
automatic fallback
      ↓
temporary Host ownership

human selects a model
      ↓
drop fallback lease
      ↓
do not auto-restore the old source model later
```

The implementation must distinguish supervisor-owned model mutations from human model selection. The fallback's own switch/restore events must not cancel themselves.

Use an explicit runtime mutation guard/generation or equivalent narrow mechanism. Do not infer ownership from model identity alone if that creates races.

Ordinary user input does not cancel an active fallback lease.

This intentionally differs from Quota Resume waiting:

```text
Resume waiting:
human input means the planned future auto-continuation is obsolete
→ cancel wait

Fallback active:
human input is valid ongoing work on the temporary backend
→ keep lease
```

The lease is Session-bound and clears when the Session is replaced, switched away, invalidated, or Host disposal occurs.

Long Task rollover does not carry a fallback lease into the new Session in v0.1.

---

## 10. Recovery arbitration

For one confirmed Codex quota incident:

```text
A. try Quota Fallback
   │
   ├─ committed
   │    → do not schedule Resume for this incident
   │
   └─ not committed
        ↓
B. try existing Quota Auto Resume
   │
   ├─ committed
   │    → wait quietly
   │
   └─ not committed
        ↓
C. ordinary stopped semantics
```

Remote/stopped classification must consider a committed fallback successor equivalent to any other successful automatic continuity path.

There must never be two automatic continuations for one quota incident.

### Backup failure after fallback

Do not create a third-provider cascade.

If the backup later terminates because of a provider/auth/rate-limit transport failure while the original Codex reset is still in the future:

```text
stop using failed backup
→ restore source Codex model at safe idle, without triggering a turn
→ revalidate Codex quota facts if necessary
→ schedule existing Quota Auto Resume if still valid
```

If that cannot be established safely, ordinary stopped semantics apply.

Do not treat ordinary Task failure, verification failure, tool failure, or model-chosen stop as a backup-provider failure.

---

## 11. Preference and TUI semantics

Fallback is opt-in because it can spend pay-as-you-go balance.

```text
default: OFF
command: /quota-fallback
backup:  deepseek/deepseek-flash
```

The intended interaction matches `/quota-resume`:

```text
Enter   → current Session
Ctrl+S  → Global default + current Session
Esc     → cancel
```

Preference storage belongs in the existing Pindie global preference surface, not `PindieState`.

Enabling fallback should verify that Pi can resolve the fixed DeepSeek model and that provider auth is configured. If not, report the problem instead of silently promising coverage.

API keys remain Pi/provider-owned secrets and must never be copied into:

- preferences;
- Session custom entries;
- semantic State;
- logs;
- Remote/Discord payloads;
- UI projection.

### Final TUI boundary

Quota Fallback must consume the completed Pindie TUI architecture. It must not create a parallel model picker, status system, or command framework.

Required runtime facts are small:

```text
fallback enabled
fallback active
source model
resetAt / restoreDue
```

Possible presentation:

```text
Header:
DeepSeek V4.1 Flash · High

Runtime transition:
↪ Quota fallback · Codex → DeepSeek
  Codex reset 18:25

Status:
fallback · until 18:25
```

Exact UI treatment belongs to Slice D after TUI is merged.

Successful fallback and successful restore are quiet continuity events:

| Situation | Local Attention | External notify |
| --- | --- | --- |
| fallback committed | no | no |
| fallback active | no | no |
| source model restored | no | no |
| fallback unavailable, Resume scheduled | no | no |
| all recovery exhausted, Task still active | existing stopped policy | yes |

Remote Companion remains a projection over the same live Session. It must not create a second fallback state or duplicate continuation.

---

## 12. Cost and semantic interaction

Fallback model switching itself is not project mutation and does not invalidate Verification.

DeepSeek tool/project mutations continue through the same Execution Gateway and Project Mutation Freshness rules.

Existing cost accounting may consume Pi usage/cost metadata. Do not:

- merge DeepSeek spend into OpenAI subscription quota percentages;
- create a second cost database;
- create a special fallback Experience family;
- add time-of-day DeepSeek pricing logic solely for this feature.

Off-peak price differences may remain approximate in Pindie's static cost display.

---

## 13. Implementation gate

No Quota Fallback implementation Slice starts until the current Pindie TUI work is finished and merged.

Required sequence:

```text
1. finish current Pindie TUI work
2. review + merge TUI PR
3. re-read merged main
4. perform implementation-readiness review against this contract
5. revise only material incompatibilities
6. begin Slice A
```

This architecture document may merge before TUI implementation finishes because it changes no runtime behavior.

---

## 14. Implementation Slices

Each Slice uses a fresh branch from then-current `main`, focused tests, `pnpm run check`, commit, PR, review, and merge before the next Slice.

### Slice A — Runtime Model Control

Goal: expose only the Pi operations Host-owned fallback needs.

Implement the smallest `PiRuntimeAdapter` boundary required to:

- resolve `deepseek/deepseek-flash` through Pi's model runtime;
- verify usable provider auth;
- switch the active Session model without persisting a global default;
- read/set active Session thinking level.

No fallback policy, quota behavior, preference, or TUI changes.

Do not create a Pindie model registry or raw provider client.

### Slice B — Fallback Core

Goal: implement same-Session temporary fallback and safe restoration as a Host runtime mechanism.

Implement:

- shared neutral quota-recovery facts if needed;
- Host-owned `QuotaFallbackSupervisor` or equivalent;
- source Session/model/anchor validation;
- source model + thinking capture;
- switch to DeepSeek;
- hidden continuation;
- runtime-only lease;
- reset timer;
- safe-idle restore;
- stale-generation/session/disposal protection;
- rollback when fallback cannot fully commit.

Production behavior may remain default-disabled through an injected seam until preference wiring exists.

No TUI work.

### Slice C — Recovery Arbitration

Goal: combine Fallback with existing Resume without duplicate successors.

Implement:

- one factual quota refresh;
- strict `fallback → resume → stopped` ordering;
- one automatic successor maximum per incident;
- preservation of current Resume behavior when Fallback is unavailable;
- distinction between supervisor-owned and human model selection;
- human model selection cancels lease;
- ordinary input does not;
- backup provider failure may return to Resume;
- Remote settlement classification recognizes fallback successor.

Do not introduce a generic successor scheduler or persisted workflow.

### Slice D — Preference + Final TUI Integration

Prerequisite: final current Pindie TUI work is merged and this contract has passed post-merge readiness review.

Implement:

- `/quota-fallback`;
- default OFF;
- Session override;
- Ctrl+S Global default + current Session;
- fixed DeepSeek target;
- auth/model availability diagnosis;
- atomic preference persistence preserving unrelated fields;
- fallback runtime facts in the final TUI projection;
- compact RuntimeBlock/status presentation;
- focused preference/TUI tests.

Use the final Action Registry / extension UI boundary. Do not create parallel TUI infrastructure.

### Slice E — Hardening + Documentation Sync

Close operational edges with end-to-end tests for:

- Codex quota → fallback → DeepSeek continuation;
- reset during active DeepSeek Run → deferred safe restore;
- manual model selection → lease cancellation;
- fallback unavailable → Resume;
- partial fallback commit failure → rollback → Resume;
- backup provider failure → Resume when valid;
- Session replacement/disposal → stale timer cannot act;
- no duplicate successor.

Then:

- run full `pnpm run check`;
- synchronize `docs/architecture.md`, `docs/behavior.md`, and `AGENTS.md` to the implemented state only.

---

## 15. Post-TUI readiness check

Before Slice A, re-read current main and verify:

1. final model-selection action path in Pindie TUI;
2. final `PiRuntimeAdapter` model APIs;
3. how human model selection is surfaced;
4. Host runtime facts available to UI projection;
5. whether Quota Resume settlement timing changed;
6. whether Long Task rollover changed Session lifecycle signals;
7. whether pinned Pi still exposes `deepseek/deepseek-flash` with expected reasoning/auth metadata;
8. whether one subscription refresh can still feed Fallback and Resume;
9. whether Remote successor classification still needs explicit fallback integration.

Only material incompatibilities justify changing this architecture.

---

## 16. Hard invariants

1. Fallback changes model, not Task identity.
2. Fallback never creates a second Session.
3. Fallback never creates a second Agent Loop.
4. Fallback state is runtime-only.
5. Paid fallback requires explicit opt-in.
6. Backup model is fixed in v0.1.
7. One incident commits at most one fallback continuation.
8. One incident cannot simultaneously commit Fallback and Resume continuations.
9. Fallback model switching alone does not invalidate Verification.
10. Source-model restore never triggers an Agent turn.
11. Reset never interrupts active work.
12. Human model selection cancels automatic restore ownership.
13. Ordinary user input does not cancel an active fallback lease.
14. Session replacement ends the lease.
15. Process exit loses the lease.
16. Backup auth/switch failure leaves Resume free to take over.
17. Late timers/events from stale generations cannot affect a newer Session or lease.
18. Supervisor-owned model changes must not be mistaken for human overrides.
19. Fallback never persists a new global default model.
20. Pindie never owns DeepSeek protocol/auth/reasoning compatibility.
