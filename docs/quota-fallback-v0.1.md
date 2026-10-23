# Pindie Quota Fallback v0.1 — Architecture Contract

Status: **Implemented through final Slice E.** The Host uses native Pi InteractiveMode as its only interactive shell; see the [Pi 1.4.0 compatibility audit](pi-1.4.0-compatibility.md) for the pinned runtime. References to 0.86.1 below are historical implementation observations, not current dependency requirements.

Baseline: the implemented Quota Fallback and Quota Auto Resume behavior in `docs/behavior.md`.

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

The fixed native catalog identity used by Pindie is:

```text
deepseek/deepseek-flash
= DeepSeek Flash (version-neutral UI label)
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

Fallback and Resume consume one factual derivation:

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
        └─ recoveryAt (latest exhausted reset + 30s grace)
             │
             ├─ fallback decision
             └─ resume decision
```

Do not refresh the same subscription facts twice merely because two policies consume them.

`buildCodexQuotaRecoveryFacts` force-refreshes usage once for both policies; `quotaResumePlanFromRecoveryFacts` converts the same facts without a second refresh. New planning accepts only the latest Codex quota error. After backup failure, Resume revalidates the exact original anchor on the current branch, even when it is no longer the latest message.

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
  recoveryAt,
  restoreDue
}
```

This lease is runtime-only.

It must not be persisted in:

- `PindieState`;
- Task continuity artifacts;
- Work Memory;
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

At the original Pi 0.86.1 implementation audit, DeepSeek V4.1 Flash supported:

```text
off / low / high / max
```

In that audit, `medium` clamped to `high`. This is historical Pi behavior, not a fixed Pindie mapping; current supported levels come from the installed Pi model metadata.

When restoring Codex, reapply the captured source thinking level through Pi.

If Pi's model metadata changes later, Pi remains authoritative.

---

## 8. Safe restoration

Quota reset does not interrupt DeepSeek work.

```text
recoveryAt reached (reset + grace)
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

If the latest backup Run terminates with a `deepseek/deepseek-flash` assistant provider error while the original Codex recovery time is still in the future:

```text
stop using failed backup
→ restore source Codex model at safe idle, without triggering a turn
→ validate the exact original Codex quota anchor still belongs to the branch
→ schedule existing Quota Auto Resume if still valid (no second usage refresh)
```

If that cannot be established safely, ordinary stopped semantics apply.

Do not treat ordinary Task failure, verification failure, tool failure, or model-chosen stop as a backup-provider failure. In the original Pi 0.86.1 implementation audit, `Agent.runWithLifecycle()` turns provider/Run exceptions into terminal assistant error messages with the current model provider/id and emits message/turn/agent end events. `AgentSession._runAgentPrompt()` then emits `agent_settled` in its finally path after flushing pending messages. This feeds the existing detection path; no separate failure bus is needed.

---

## 11. Preference and TUI semantics

Fallback is opt-in because it can spend pay-as-you-go balance.

```text
default: OFF
command: /quota-fallback
backup:  deepseek/deepseek-flash
```

The Pi InteractiveMode extension selector shares the lightweight, presentation-only
`SettingsMenu` component with `/quota-resume` and `/discord-remote`. It receives
choices, current/default values, status text and action callbacks; it does not read
preferences or own activation. The Quota selectors retain their Session scope:

```text
Enter   → current Session
configured app.models.save (Ctrl+S by default) → Global default + current Session
Esc     → cancel
```

Navigation, confirm, save and cancel all use Pi's injected keybindings; help is
generated from the actual bindings and menu-specific action labels. `→` marks the
cursor, `✓` marks the current Session value, and `· default` marks the saved global
value. Discord instead saves only a global next-Host preference on either confirm
or save; it never pretends confirm applies a temporary Session override.

Session preference entries (`pindie-quota-fallback-preference`, `{ enabled: boolean }`) follow current branch transcript truth. The Global default is `quotaFallback` in the shared `~/.pindie/global/preferences.json`, alongside `quotaAutoResume`; missing or invalid values fail closed to OFF. Saving preserves unrelated fields with atomic rename. ON performs an exact Pi model availability/auth preflight before either write; OFF needs no auth and does not cancel an active fallback lease. If auth disappears after enabling, the saved choice stays ON but a future fallback request fails closed to Resume.

API keys remain Pi/provider-owned secrets and must never be copied into:

- preferences;
- Session custom entries;
- semantic State;
- logs;
- Remote/Discord payloads;
- UI projection.

### Production Pi TUI boundary

Production uses Pi InteractiveMode and its public extension UI/model APIs. `/quota-fallback` is a two-row on/off selector; there is no parallel Pindie model picker.

Pi's existing active-model indicator provides ambient visibility when the Session switches to DeepSeek. v0.1 adds no dedicated fallback footer, status line, toast, or Discord success message. Successful switch and source restore remain quiet.

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
- add time-of-day DeepSeek pricing logic solely for this feature.

Off-peak price differences may remain approximate in Pindie's static cost display.

---

## 13. Implemented runtime boundary

PiRuntimeAdapter uses Pi's exact model availability/auth check, active-Session
`setModel` and thinking-level setter (Pi clamps supported levels). The Host owns
a process-local fallback lease/timer; an owned model-mutation guard distinguishes
its switches/restores from human selection. Extension captures one fresh quota
fact derivation and arbitrates Fallback → Resume → stopped. The runtime lease
never enters `PindieState`, preferences or Session custom entries. Restart loses
it, even if Pi's transcript still records DeepSeek as the active model; Pindie
does not infer a Codex source or auto-restore it. Human model selection remains
available.

---

## 14. Implementation Slices

Slices A–E are implemented. The following headings record their historical scope; they are not future work:

### Slice A — Runtime Model Control

Result: Host-owned fallback uses the Pi runtime adapter's native model controls.

The runtime provides:

- `getActiveSessionModelIdentity()`;
- `isActiveSessionModelAvailable()` for exact registry availability, independent of picker scope;
- `setActiveSessionModel(provider, modelId)`, which delegates to Pi and does not persist a global default;
- `getActiveSessionThinkingLevel()`.

The completed slice adds:

- an exact model availability/auth preflight for `provider/modelId` using Pi's registry availability, independent of scoped picker choices;
- a thin active-Session thinking-level setter that delegates to Pi and lets Pi clamp to model capabilities;
- focused adapter tests proving active-Session-at-call-time behavior, authenticated availability semantics, no scoped-picker coupling, and no duplicate thinking policy.

Native Pi's model picker remains unchanged.

No fallback policy, quota behavior, preference, or native Pi UI changes.

Do not create a Pindie model registry, raw provider client, or DeepSeek-specific reasoning map.

### Slice B — Fallback Core

Result: same-Session temporary fallback and safe restoration are Host runtime mechanisms.

The completed slice includes:

- neutral quota-recovery facts (finalized in Slice C);
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

Production is now opt-in through the Slice D preference; the temporary authorization seam was removed.

No TUI work.

### Slice C — Recovery Arbitration

Result: Fallback and Resume are ordered without duplicate successors. The slice includes:

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

### Slice D — Preference + Pi TUI Integration

The completed slice includes:

- `/quota-fallback`;
- default OFF;
- Session override;
- Ctrl+S Global default + current Session;
- fixed DeepSeek target;
- auth/model availability diagnosis;
- atomic preference persistence preserving unrelated fields;
- ambient active-model visibility via Pi InteractiveMode without a dedicated fallback status;
- focused preference and Pi-TUI extension-UI tests.

The selector uses native Pi extension UI.

### Slice E — Hardening + Documentation Sync

The final hardening covers:

- Codex quota → fallback → DeepSeek continuation;
- reset during active DeepSeek Run → deferred safe restore;
- manual model selection → lease cancellation;
- fallback unavailable → Resume;
- partial fallback commit failure → rollback → Resume;
- backup provider failure → Resume when valid;
- Session replacement/disposal → stale timer cannot act;
- no duplicate successor.

The architecture, behavior and agent guidance describe the implemented state.

---

## 15. Historical post-TUI readiness result

The 2026-09-23 pre-implementation review established the following at that time (not today's package pins or an outstanding readiness checklist):

1. interactive model selection uses native Pi InteractiveMode / Pi model plumbing;
2. `PiRuntimeAdapter` exposes active model identity, exact model availability, and direct active-Session model switching;
3. Pi emits `model_select`, which remains the event seam for later distinguishing explicit human selection from supervisor-owned fallback mutations;
4. Pindie's PresentationIntegration remains the existing status/extension presentation layer under Pi TUI;
5. existing Quota Auto Resume settlement and Host ownership remain compatible with ordered recovery arbitration;
6. Long Task rollover remains Session replacement and therefore still terminates a Session-bound fallback lease;
7. Pi was then pinned to 0.86.1, which exposed `deepseek/deepseek-flash`;
8. one fresh subscription-usage derivation can still feed both Fallback and Resume;
9. Remote stopped classification now recognizes either committed fallback or Resume as a quota successor.

UI ownership remains with Pi InteractiveMode's extension API.

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
