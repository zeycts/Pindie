# Pindie Remote Companion v0.1

This document is the authoritative architecture, behavior, and test contract for Pindie's optional remote companion. It extends the Pindie v0.3 architecture without changing semantic ownership.

The target use case is simple: a Task is already running in the local Pi TUI, the human leaves the computer, and the same live Pi Session remains observable and steerable from a phone through Discord. Returning to the computer must reveal the same Session history and the same Pindie Task.

## 1. Ownership and non-goals

The only valid topology is:

```text
Phone
  ↓
Discord
  ↓
Remote Companion
  ↓
existing Pindie Extension
  ↓
SAME live Pi Session
  ├→ Pi TUI
  └→ existing Pindie Runtime
```

Ownership remains:

```text
Pindie Host → Pindie process lifecycle, active AgentSessionRuntime lifecycle/replacement
Pi          → active AgentSession implementation, native Session lifecycle, message delivery,
              steer/followUp queues, concrete tools, retries, compaction, Skills
Pindie      → semantic State, capabilities, execution authority, verification, Human Gate
Remote  → external routing, filtered Session projection, remote input/output
Discord → presentation/control surface only
```

Remote Companion must not introduce a Remote Agent, second Pi Session, second Agent Loop, Remote Task, Remote semantic State, Remote tool queue, workflow engine, planner, memory database, or duplicate conversation store.

## 2. Discord information architecture

Use one private Discord server as the remote workspace:

```text
Discord Server
└── Project Channel
    ├── Session Anchor A
    │   └── Session Thread A
    └── Session Anchor B
        └── Session Thread B
```

The identity rules are strict:

```text
canonical ProjectRoot  1:1  Discord text channel
Pi Session ID          1:1  Discord thread
```

Pi Session ID remains conversation identity. A fresh Host-owned Session replacement gets a new native Pi Session ID and therefore a new active Remote Session/thread identity; the old thread remains historical.

A channel is a Project index. Ordinary Session conversation does not live in the channel root.

A thread is the readable remote representation of one Pi Session. It contains the Session timeline: user prompts, visible assistant output, compressed execution milestones, verification, Human Gate events, and Task lifecycle events.

Channel/thread names are presentation only. Project identity comes from the existing canonical project-root/project-id convention. Session identity comes from Pi's native Session ID.

Use ordinary text channels and public threads inside the private server. Do not depend on Discord private-thread entitlement or treat a thread name as an identifier.

## 3. Configuration and security

Remote Companion is optional and uses environment configuration only:

```text
PINDIE_DISCORD_TOKEN
PINDIE_DISCORD_USER_ID
PINDIE_DISCORD_GUILD_ID
PINDIE_DISCORD_PROXY # optional; Discord REST and Gateway WebSocket proxy
```

Discord transport proxy resolution is `PINDIE_DISCORD_PROXY`, then `HTTPS_PROXY`, then `https_proxy`, then a direct connection. The resolved proxy applies to both Discord REST and the Gateway WebSocket. Proxy configuration is runtime-only and credentials are never logged.

If all are absent, Remote Companion is disabled and Pindie behaves exactly as before.

If configuration is partial or invalid, Remote Companion stays disabled, emits one best-effort local warning, and must not prevent the local Pindie session from starting or running.

Remote input is accepted only when all of these are true:

- the event belongs to the configured Discord guild;
- the sender ID exactly matches `PINDIE_DISCORD_USER_ID`;
- the sender is not a bot;
- the message belongs to a mapped Session thread.

Unauthorized input is ignored. There is no `!exec`, `!bash`, raw shell endpoint, webhook control path, public HTTP server, tunnel, or VPS requirement in v0.1. Remote text becomes a real Pi user message and remains subject to existing Pindie authority.

The Discord token is never persisted, committed, or logged.

## 4. Routing metadata

Remote Companion needs a small durable mapping because a Pi Session can be resumed after the process or machine restarts.

Store it separately from semantic State:

```text
~/.pindie/remote/discord/projects/<projectId>.json
```

The v0.1 shape is intentionally narrow:

```ts
interface DiscordProjectRoutingV1 {
  version: 1;
  guildId: string;
  channelId: string;
  sessions: Record<string, {
    threadId: string;
    anchorMessageId: string;
    headerMessageId: string | null;
    lastMirroredEntryId: string | null;
  }>;
}
```

The `sessions` key is the native Pi Session ID.

This file may answer only external-delivery questions: which channel/thread/message corresponds to an existing Project/Session, and how far the Discord replica has been delivered. It must not persist Task goal/status, verification, Human Gate, activity, prompts, assistant output, tool results, capabilities, or any semantic truth.

Routing writes must be atomic. Reuse the existing canonical project identity instead of implementing another hash/normalization scheme.

## 5. Project channel behavior

The first meaningful remote projection for a Project ensures its channel exists:

```text
projectId
  ↓
load routing
  ↓
valid mapped channel? ─ yes → reuse
  │
  no
  ↓
create Discord channel
  ↓
persist channelId
```

The display name derives deterministically from the project basename and is Discord-safe. Two Projects with the same basename remain distinct because `projectId`, not the name, owns identity.

If a mapped channel was manually deleted, create a replacement channel and replace the stale channel mapping. Session thread mappings below the deleted parent are discarded; Pi Session history remains authoritative and can be mirrored again when those Sessions become active.

## 6. Session thread behavior

`session_start` binds the current native Pi Session but does not by itself create Discord objects. Thread creation is lazy.

The first meaningful event — a real user prompt, visible assistant output, Pindie Task, or explicit remote access — ensures:

```text
Project Channel
  ↓
Session Anchor
  ↓
Session Thread
  ↓
Session Header
```

An existing mapping for the same Pi Session ID is always reused. `/new` produces a new Session ID and therefore a new thread. `/resume` returns to the existing mapped thread for that Session. `/fork` produces a new Session and a new thread.

Thread title priority is deterministic and does not call an LLM:

1. explicit Pi Session name;
2. first meaningful user-prompt line from this Pi Session;
3. current Pindie Task goal only while the Task is active, blocked, or waiting for a human;
4. `Session <short-id>`.

A completed Task remains visible in the Session Header but never supplies the identity of a newly created Pi Session.

`session_info_changed` may rename the existing Discord thread and update its anchor, but never changes the mapping identity.

A Session Anchor lives in the Project channel and acts as a compact Session-index entry. A Session Header lives inside the thread and is edited in place to show the current live summary.

## 7. Active and historical Sessions

At any moment the local process has one current Pi Session owned by the active Host runtime. Only its mapped thread is remotely controllable.

Historical threads remain readable but are read-only in v0.1. A message sent to a historical thread must not call Pi, switch Sessions, resume a Session, or mutate project state. It returns a concise explanation that the Session must first be resumed from the local TUI.

A local `/resume` rebinds Remote Companion to that native Pi Session, reuses its mapped thread, catches up any missing projection, and makes the thread controllable again.

Remote session switching such as `!resume` is explicitly out of scope for v0.1.

## 8. Session context ownership

Asynchronous Discord callbacks must never permanently capture one old `ExtensionContext`.

Remote Companion tracks the current session generation and resolves the current live context at operation time. On `/new`, `/resume`, `/fork`, reload, or any other session replacement, the old context is invalidated and must never be retried or used as fallback.

`session_shutdown` clears the current live binding and session-scoped runtime bookkeeping. `session_start` establishes the new binding.

The Discord connection may be restarted across a session switch in v0.1. Do not add a process-global daemon merely to avoid a short reconnect.

## 9. Session Mirror

The Pi Session is the authoritative conversation history. Discord is a filtered replica.

Mirror all real user prompts and all completed visible assistant text. Do not make a second semantic judgment about whether assistant text is "important"; if it is normal visible assistant text in the Session, mirror it.

User presentation should distinguish live-origin when it is reliably known:

```text
YOU · TUI
YOU · DISCORD
YOU · DISCORD · STEER
YOU · DISCORD · FOLLOW-UP
```

A Discord inbound message is not mirrored directly as a second transcript item. It is delivered to Pi, and the resulting native user Session entry is the transcript authority. Runtime-only correlation may label that entry with its Discord/steer/follow-up origin. If origin cannot be reconstructed safely during later catch-up, use a neutral user label rather than guessing.

Filter from the remote transcript:

- model thinking/reasoning content;
- raw tool results;
- raw tool-call payloads;
- Pindie hidden continuation probes;
- Pindie runtime-context injections;
- internal hidden/custom messages that are not user-visible conversation.

Discord must never become a hidden-chain-of-thought surface.

## 10. Execution summaries

Tool telemetry is useful for process awareness but too noisy to mirror one event at a time.

Aggregate an execution span into compact milestones, for example:

```text
EXECUTION
read ×6
edit ×2
bash · pnpm test ✓
bash · pnpm run check ✓
```

A failed meaningful command may include a bounded failure summary, but not full stdout/stderr.

Do not mirror complete read bodies, edit diffs, bash output, token deltas, or every tool lifecycle event.

Flush execution summaries at natural boundaries such as visible assistant completion, `agent_end`, `agent_settled`, Human Gate, blocked state, or another semantic boundary. The exact aggregation mechanism is runtime presentation, not semantic State.

## 11. Session header and semantic milestones

The Session Header is an editable projection of existing facts, not another status authority. It may show:

```text
Project
Task
Task status
current activity
verification summary
elapsed time
Pi Session ID/short ID
Remote connection state
```

Its inputs come from the existing Pindie Runtime/semantic snapshot, Run Activity, Run Timer, verification facts, and current Pi Session.

The timeline should also emit high-value semantic milestones when they change:

- Human Gate opened or materially changed — attention-worthy;
- Task became blocked or materially changed — attention-worthy;
- semantic authority became unavailable;
- verification milestone changed meaningfully;
- Task completed — attention-worthy at final settlement.

Deduplication fingerprints are runtime-only presentation bookkeeping and are never persisted in `PindieState`.

### Attention delivery

A `TimelineEvent` may carry an explicit runtime-only `attention` marker when Pindie has already decided that the configured human should be actively interrupted. `RemoteSurface` and the Discord transport deliver that presentation metadata; they do not decide attention eligibility.

Ordinary Discord timeline messages use `allowed_mentions: { parse: [] }`. An attention event prefixes the configured `PINDIE_DISCORD_USER_ID` mention and allows exactly that user ID while keeping automatic parsing disabled. Text from the model, user, or event cannot add `@everyone`, role, or arbitrary-user notifications.

If one attention event is split for Discord's message-size limit, only its first chunk retains the marker and mention. The remaining chunks are quiet, so one logical event produces at most one notification.

Attention is presentation metadata only. It is not persisted in `PindieState`, routing metadata, or Pi Session transcript truth.

Semantic attention is deliberately narrow: a Human Gate opening/material change, a blocked Task/material blocker change, and Task completion at `agent_settled`. Existing runtime milestone fingerprints deduplicate unchanged blocked and Gate states; because `waiting_human` takes precedence over blockers, a Gate state does not add a duplicate blocked attention event. Completion remains transition-driven and settlement-gated: a `done` transition sets completion pending, while only the final `agent_settled` path emits the attention milestone after catch-up and execution-summary flushing. Rebinding a Session whose Task is already done does not replay it.

A `STOPPED` milestone means the Task is still `active` after final settlement and no automatic successor remains. `agent_end` alone is not stopped: an existing Pi-native continuation suppresses premature attention. An accepted Quota Auto Resume schedule and a committed Long Task rollover likewise suppress stopped attention. `blocked`, `waiting_human`, and `done` use their own existing attention milestones. `stopped` is runtime presentation only and is never persisted in `PindieState`; it is emitted only after transcript catch-up and the final execution summary.

## 12. Remote input semantics

Remote input operates only on the active mapped thread.

Normal text:

```text
Pi idle → pi.sendUserMessage(text)
Pi busy → pi.sendUserMessage(text, { deliverAs: "steer" })
```

`!after <text>`:

```text
Pi idle → pi.sendUserMessage(text)
Pi busy → pi.sendUserMessage(text, { deliverAs: "followUp" })
```

`!stop`:

```text
active run → current ExtensionContext.abort()
idle       → no abort; report no active run
```

Pindie must not implement a parallel remote steer/follow-up queue. Pi owns message queueing and delivery.

Remote stop suppresses an aborted partial assistant message as a normal final result. A concise `Stopped.` acknowledgement may be emitted after the run settles.

`!status` is read-only. On the active thread it projects current runtime/semantic facts. On a historical thread it reports only historical/session metadata and explicitly does not claim live activity.

## 13. Human Gate and local UI prompts

Pindie Human Gate remains a semantic human-authority boundary and is fully compatible with Remote Companion. When a Gate opens, mirror the question/options into the active thread. A normal authorized reply becomes a real Pi user message; existing Pindie semantics decide whether/how the Gate is resolved.

Pi `ui_prompt_start` / `ui_prompt_end` represent blocking local extension UI such as `select`, `confirm`, `input`, `editor`, or `custom`. Remote Companion may show `WAITING FOR LOCAL UI`, but v0.1 must not pretend that an arbitrary Discord message can resolve that TUI prompt.

While a local UI prompt is active, `!status` remains available and `!stop` may use the current official abort boundary. Ordinary remote input and `!after` must not claim success when the local UI prompt cannot consume them.

## 14. Completion and Pi lifecycle

`agent_end` is never a final remote-delivery boundary because Pi/Pindie may still retry, compact, follow up, or continue.

`agent_settled` is the final lifecycle boundary after automatic work is exhausted.

A semantic Task-complete transition marks completion pending; the final Task-completed milestone is emitted at `agent_settled`, after the latest visible assistant conclusion and final execution/verification summary are available.

Hidden Pindie continuation remains Pi-native and is never shown as a user prompt. Real user steer/follow-up messages remain visible and, through Pi's pending-message semantics, take precedence over unnecessary automatic continuation.

## 15. Catch-up, delivery cursor, and ordering

When Remote Companion binds/rebinds a mapped Session:

```text
Pi Session entries
  ↓
lastMirroredEntryId
  ↓
project unseen visible entries
  ↓
RemoteSurface delivery
  ↓ success
persist new cursor
```

If the cursor is `null`, mirror the existing visible history. If it exists, mirror only entries after that cursor.

The cursor advances only after successful remote delivery. A failed send must not silently advance it.

v0.1 intentionally provides at-least-once projection. A crash after Discord accepted a message but before cursor persistence may duplicate a projection after restart; silent loss is worse and must not be "fixed" with a second durable event database.

Historical catch-up and live projection must be serialized so Discord cannot show entry N+1 before unseen entry N.

Long Discord messages may be split at paragraph/newline/space boundaries while preserving content and order.

### Discord user-message presentation

An authorized Discord input message already visibly exists in its mapped Session Thread. When Pi records that same input, its runtime PromptOrigin is carried into the timeline event. Discord-origin normal, steer, and follow-up entries therefore complete RemoteSurface delivery as a successful no-op: the persisted cursor advances without deleting, matching, reposting, or duplicating the inbound message. TUI and neutral user entries continue to be mirrored normally. Historical entries whose origin is no longer safely known use the neutral projection.

## 16. Failure and recovery

Discord is optional I/O. Transport failure must never alter semantic correctness or stop the local Agent.

Discord login/send/disconnect failures are best effort and isolated from Pindie State, Tool Surface, execution authorization, verification, continuation, and Pi lifecycle.

On reconnect, use native Pi Session history plus the persisted delivery cursor to catch up before returning to live projection.

If a mapped thread was manually deleted, create a replacement thread, reset that Session's delivery cursor, and rebuild its visible projection from the authoritative Pi Session.

If the parent project channel was deleted, recreate the channel and rebuild child thread mappings lazily as Sessions become active.

## 17. v0.1 scope limits

v0.1 deliberately supports one Remote-enabled local Pi process at a time. Multiple simultaneous local Pi processes sharing one Discord Bot introduce process ownership/routing concerns and require a later local daemon or equivalent architecture.

Multiple Remote-enabled Pindie processes for the same Project/routing may each receive the same Discord Gateway message; normal use should keep one active Remote-enabled Pindie process per Project.

Also out of scope:

- remote Session switching;
- multiple authorized users;
- inbound images/files;
- Discord approval buttons;
- raw tool-log streaming;
- full bash stdout/diffs;
- remote Agent startup when no local Pi process exists;
- a public network service;
- a process-global Remote daemon.

These may be considered only after dogfood demonstrates a concrete need.

## 18. Implementation boundaries

The first implementation should remain small and transport-independent:

```text
remote-routing.ts    → external routing metadata + Project/Session mapping
session-mirror.ts    → Pi Session → readable timeline projection
remote-companion.ts  → active-session ownership, input semantics, status/milestones
extension.ts         → composition/lifecycle wiring
```

A later Discord adapter may add one transport file such as `discord-remote.ts`.

Use one narrow `RemoteSurface` seam for deterministic tests. It may ensure project/session Discord objects, send timeline events, update anchor/header messages, rename a thread, and report stale external objects. It must not evolve into a generic protocol/adapter framework.

Do not create `remote/protocol`, `remote/domain`, `remote/state`, a Remote SessionManager, event database, or transport hierarchy without a demonstrated requirement.

## 19. Required test contract

Automated tests must not connect to real Discord or invoke a real model. Use a deterministic fake RemoteSurface and fake Pi-facing seams.

At minimum verify:

### Routing

- a new Project creates one channel mapping;
- an existing Project reuses its channel;
- a stale/deleted channel is replaced;
- same-basename Projects remain distinct;
- an empty Session creates no thread;
- the first meaningful event lazily creates one anchor/thread/header;
- the same resumed Pi Session reuses its original thread;
- a new/forked Pi Session gets a new thread;
- Session rename changes presentation, not identity.

### Mirror and catch-up

- no cursor mirrors existing visible history;
- an existing cursor mirrors only unseen entries;
- user prompts are mirrored exactly once;
- live Discord/steer/follow-up origins are labeled when reliably correlated;
- visible assistant text is mirrored;
- thinking, hidden Pindie messages, and raw tool results are filtered;
- tool activity is aggregated rather than streamed;
- the cursor advances only after successful delivery;
- failed delivery does not lose an entry;
- catch-up and live delivery preserve chronological order.

### Control

- active-thread input while idle sends a normal Pi user message;
- active-thread input while busy uses Pi `steer`;
- `!after` uses Pi `followUp` while busy;
- `!stop` uses the current `ExtensionContext.abort()`;
- a historical thread cannot control or switch Pi Sessions;
- local `/resume` makes the existing mapped thread active again;
- a stale ExtensionContext is never reused after session replacement.

### Semantic/lifecycle projection

- Human Gate notification is deduplicated;
- blocked/unavailable transitions are deduplicated;
- local UI prompt state is distinguished from Human Gate;
- `agent_end` does not emit final completion;
- Task completion waits for `agent_settled`;
- remote stop does not expose aborted partial output as a normal final answer;
- Remote disabled leaves all existing Pindie behavior unchanged.

### Failure isolation

- Discord/RemoteSurface login or send failure does not alter the Agent run;
- reconnect catches up from native Session history;
- deleted channel/thread routing can be rebuilt without changing Pi Session or Pindie State.

The full repository `pnpm run check` must remain green.

## 20. Definition of Done

Remote Companion v0.1 is complete only when all of these are true:

```text
✓ one canonical Project maps to one Discord channel
✓ one native Pi Session maps to one Discord thread
✓ Discord mirrors the readable Session timeline, not hidden reasoning or raw telemetry
✓ all real user prompts and visible assistant text remain recoverable from the thread
✓ the active thread controls the same live Pi Session used by the local TUI
✓ busy remote guidance uses Pi-native steer; follow-up uses Pi-native followUp
✓ stop uses the current official ExtensionContext boundary
✓ local /resume returns to the original mapped thread
✓ historical threads cannot secretly switch/control Pi Sessions
✓ routing persistence contains external IDs/cursor only
✓ Pi Session remains conversation truth
✓ PindieState remains semantic truth
✓ Discord failure cannot corrupt or stop local Pindie
✓ no second Agent, Session, Loop, queue, or semantic State exists
✓ the complete automated test suite passes
✓ real phone dogfood confirms the leave-computer → observe/steer → return-to-TUI flow
```
