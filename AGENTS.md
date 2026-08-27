# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authority

For architecture work, use this order:

1. The explicit approved milestone/task specification in the current request.
2. `docs/architecture.md` — target architecture and ownership boundaries.
3. `docs/behavior.md` — semantic and behavioral contract.
4. Existing source and tests — implemented runtime baseline.

Pindie is migrating to v0.2 in small milestones. Source/tests may intentionally lag the target docs while a milestone is in progress. Do not redesign target semantics back toward legacy behavior merely to preserve an obsolete implementation detail.

If the current milestone, target docs, and implementation appear inconsistent, report the contradiction before widening scope.

## Architectural ownership

- Pi owns model invocation, concrete tool registry/execution, sessions, native system-prompt construction, and the low-level `LLM → Tool → Result → LLM` loop.
- Pindie owns durable semantic State, State invariants, deterministic semantic derivation, capabilities, capability-driven Tool Surface narrowing, execution authorization, factual verification-evidence capture/freshness, Human Gate semantics, and Pindie-owned presentation.
- The model owns user-intent interpretation, planning, semantic choices within the legal capability space, and semantic verification judgment: whether factual evidence means a check passed/failed and which success criteria it covers.
- The human owns goals, taste, consequential judgment, and final approval where required.
- Reality is authoritative for reconstructable facts.

Pindie must not implement a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, verification log database, or second Skill runtime.

## Design principles

- **Deterministic closure:** if authoritative facts uniquely determine a constraint, encode it in the Harness.
- **Semantic freedom:** do not hard-code choices that genuinely require interpretation of user intent or project meaning.
- **Eliminate meaningless choices, preserve meaningful choices.**
- **Harness owns facts; model owns meaning.** Verification evidence provenance/freshness is deterministic Harness authority, while evidence interpretation and success-criterion coverage remain model-owned.
- Model-visible affordances and runtime legality are projections of the same semantic capability model.
- Persist only durable semantic current-work information that cannot be reliably reconstructed from reality.
- Capabilities, active tools, Run authority, presentation, reasoning mode, recent evidence refs, evidence generation, continuation fuses, and workflow phases are runtime-derived and never persisted in `PindieState`.
- Reducer transitions remain tool-agnostic; Pi tool names and runtime evidence refs must not leak into persisted State semantics.
- The Execution Gateway remains a defense-in-depth backstop after Tool Surface alignment.
- Pindie may narrow Pi/user tool availability for the current Run but must not enable tools absent from the captured Run baseline.
- **Natural-language policy is a last resort, not a source of deterministic correctness.** If State/Snapshot/Capabilities/Tool Surface/Gateway/Reducer already determine a rule, do not repeat that rule in a global prompt.
- Prefer the smallest implementation that directly represents the approved architecture.

## Development workflow

For each approved milestone:

1. Read only the relevant target docs, source, and tests.
2. Preserve the milestone boundary; do not implement later milestones early.
3. Add focused tests for the approved contract.
4. Implement the smallest change that satisfies those tests.
5. Preserve unrelated runtime behavior.
6. Run `pnpm run check` before declaring completion.

## Approved v0.2 migration sequence

- **M0 — Semantic Foundation:** pure `RunFacts → SemanticSnapshot → Capabilities`. Implemented.
- **M1 — Execution Semantics Foundation:** Tool Effect classification plus capability-membership authorization. Implemented.
- **M2 — Semantic Gateway Cutover:** live execution authorization consumes M0/M1 truth. Implemented.
- **M3 — Model Tool Surface:** narrow semantic tools and capability-driven active Tool Surface over a per-Run Pi/user baseline. Implemented.
- **M4 — Policy Reduction:** global Pindie Core Policy/system-prompt override removed; Runtime Context is factual Snapshot-aligned Knowledge Surface. Implemented.
- **M5 — Verification v0.2:** Harness-owned factual evidence provenance/freshness with model-owned semantic judgment and criterion coverage. Implemented.
- **M6 — Continuation Simplification:** next. Deterministic continuation eligibility plus one thin semantic latest-user-intent probe.
- **M7 — Skill / Docs Prune:** remove duplicated correctness rules from Skills and stale migration documentation.
- **M8 — Extension Composition:** leave `extension.ts` primarily as Pi lifecycle wiring over semantic/runtime subsystems.

## M6 implementation authority

M6 simplifies Active Task Continuation without creating another loop or converting semantic intent into a finite-state workflow.

### Deterministic eligibility belongs to the Harness

Continuation probing is eligible only when all publicly available deterministic facts agree that a semantic continuation decision is meaningful:

- current `SemanticSnapshot.authority` is `coherent`;
- current `SemanticSnapshot.taskStatus` is `active`;
- the final assistant message ended normally (`stopReason === "stop"`);
- Pi has no pending steering/follow-up messages;
- Pindie's one-probe fuse has not already been consumed for the current high-level Agent Run.

`taskStatus === "active"` is the semantic source for unfinished/no-Gate/no-blocker eligibility. Do not duplicate those checks by directly re-reading `task.completed`, `humanGate`, or blockers in continuation code.

Questions do not by themselves suppress continuation because they may coexist with useful active work.

### Pi 0.84.3 public lifecycle boundary

The public extension `AgentEndEvent` in pinned Pi 0.84.3 exposes only `type` and `messages`. It does **not** expose Pi's internal retry decision.

Do not:

- cast an extension `agent_end` event to invent `willRetry`;
- access private Pi internals;
- duplicate Pi retry classification heuristically;
- patch or upgrade Pi solely for M6.

For M6, `stopReason === "stop"` is the public normal-completion fact used by Pindie. Pi's turn-level auto-retry path is for retryable error outcomes, so those abnormal responses are already excluded by the normal-stop requirement. Existing `ctx.hasPendingMessages()` remains the public queue-precedence signal.

### Latest user intent remains model-owned

Once deterministic eligibility is satisfied, the remaining question is semantic:

> Does the latest actual user intent still call for consequential execution now?

The Harness must not infer that answer from Task status, `nextIntent`, prior tool usage, or workflow heuristics.

The model may choose any currently visible/legal semantic action, including continuing the current work, refining/replacing the Task when legal, or returning control. Tool Surface and Gateway already constrain legality.

### Probe stays thin

Keep at most one hidden Pi-native `followUp` custom message per high-level Agent Run.

The probe must explicitly identify itself as runtime-generated metadata, **not user intent and not a new request**. It should ask only for re-evaluation of latest actual user intent and whether consequential execution should continue.

Do not repeat lifecycle instructions such as when to replace, Gate, record blockers, re-observe, verify, or complete. Those branches are already represented by Runtime Context, Tool Surface, Gateway, and reducer invariants.

### Probe context is ephemeral

Pi custom messages participate in model context. Historical Pindie continuation probes must therefore not accumulate as durable semantic instructions in future model turns.

During the actual continuation follow-up, keep only the current/latest Pindie continuation probe in the projected model context. On a fresh user-driven Run, filter prior Pindie continuation probes out of model context entirely.

This is context projection only; do not add a continuation database, persisted flag, or session migration.

### Preserve Pi ownership

Use Pi's existing `agent_end` + `sendMessage(..., { deliverAs: "followUp" })` lifecycle and existing `agent_settled` boundary. A normal-stop follow-up may pass through Pi's own non-retrying compaction handling before delivery; Pindie does not need to predict or reimplement that lifecycle.

Do not add recursive calls, background loops, repeated probes, direct model calls, or a second Agent Loop.

M6 must not redesign M0–M5 semantics, Tool Surface, Gateway, verification evidence, reasoning, Human Gate, Skills, or persisted State.