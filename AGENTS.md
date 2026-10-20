# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on Pi. Improvement uses model judgment, Harness constraints, native Skills/workflows, tests and human review.

## Authority

1. The explicit approved task in the current request.
2. `docs/pindie-control-v0.2.md` for workspace/project selection and active-project Host replacement; preserve `docs/pindie-control-v0.1.md` runtime/control safety.
3. `docs/quota-fallback-v0.1.md` for quota recovery and temporary backup switching.
4. `docs/architecture.md` and `docs/behavior.md` for current ownership, composition, semantic truth and behavior.
5. `docs/remote-companion.md` for Remote/Discord; `docs/long-task-runtime.md` for continuation/rollover; current Pi compatibility and TUI docs for their respective surfaces.
6. Source/tests as implemented runtime evidence.

Report contradictions before widening scope. Do not retain obsolete behavior merely because an older test encoded it.

## Ownership

- **Pi:** model invocation, concrete tool execution, native Sessions/prompts/Skills, retries, compaction, follow-up delivery and the low-level LLM → Tool → Result loop.
- **Pindie:** durable semantic State/invariants, deterministic Snapshot/capabilities, Tool Surface narrowing, authorization, factual verification provenance/freshness, Human Gates and owned presentation. Host owns active Session lifecycle/replacement; Pi implements the Session.
- **Model:** intent interpretation, planning and semantic choices/verification judgment within legal capabilities.
- **Human:** goals, taste, consequential judgment and required approval.
- **Reality:** reconstructable facts.

Do not implement a second Agent Loop, generic workflow/planner/Task queue, persisted work phase machine, memory database, verification-log database or second Skill runtime.

## Current invariants

- `PindieState + SemanticRunFacts → SemanticSnapshot → Capabilities` is the semantic source of truth.
- Tool Effects map concrete calls to required capabilities and project-mutation effects. Active tools are the captured Pi/user baseline filtered by current capabilities; never enable tools absent from that baseline.
- The Gateway re-authorizes consequential calls against fresh authority. Visibility is not authorization; stale/pre-generated calls cannot bypass it.
- Reducers remain tool-agnostic; Pi tool names/runtime evidence refs do not enter persisted State semantics.
- Persist only durable current-work meaning that cannot reliably be reconstructed. Capabilities, Run authority, presentation, evidence generations and continuation fuses are runtime-derived.
- Verification facts come from actual tool results with runtime-only refs. The model owns pass/fail meaning and criterion coverage.
- Runtime Context is a factual Snapshot-aligned Knowledge Surface, not a global lifecycle-policy prompt.
- Continuation is a one-shot Pi-native follow-up with deterministic Snapshot eligibility; its probe asks only about latest actual user intent. Filter historical probes from future model context.
- Native Pi/TUI, Task/Verification/Gate, State authority, Session/Run, Attention, metrics/counters, Handoff/Rollover, Quota, Browser, Control, Remote, Work Memory and Skills retain their ownership and safety boundaries.
- Remote is an external projection/control surface over the same native Session, never a second Session/conversation/message queue. Persist only external routing IDs/cursors.
- Quota recovery uses authorized same-Session backup switching before existing Codex auto-resume; Host owns recovery leases, Pi owns provider execution.
- Composition owns startup selection, explicit storage roots/default dependencies and narrow wiring. Core does not import optional adapters or composition. Presentation selection must not disable measurement or Task metrics.

## Safety boundaries

Reserved unsupported Pindie semantic tool names are denied because their required capabilities are unavailable. Other unrecognized/custom tool calls are treated as ambiguous project mutations and require current `project.mutate` authorization. Ignore unsupported dependency-injection fields without reading their values or invoking getters. Preserve safety regressions for rejected tools, ignored payloads and Core authority.

Preserve user data, including State/continuity, preferences, routing, credentials and Sessions. Do not proactively read unrelated user files; migration or deletion requires explicit user authorization. Production deployment/restarts and PR merges need explicit user authority.

## Development workflow

1. Read relevant current contracts/source/tests only. For Control selection read v0.2 then v0.1; for Remote read its contract first. Preserve Core composition/dependency invariants in `docs/architecture.md`.
2. Preserve scope and unrelated user work; no speculative architecture milestones or cleanup.
3. Add focused tests for changed contracts. Preserve Core and safety assertions; remove coverage only with explicit scope approval and exact accounting. No skip/filter/glob changes to manufacture green.
4. Use the smallest coherent implementation. Batch independent reads/checks when useful; avoid CPU-heavy contention and repeated full checks after small edits.
5. Run targeted tests, then `pnpm run check` at the final implementation boundary. For docs-only follow-ups, document actual targeted/link validation and prior full results; exact-head CI may provide fresh full-suite evidence without duplicating a completed equivalent local run.
6. Inspect actual diff and `git diff --check`; use native development/git-workflow Skills. Commit focused changes, push and open a reviewable Draft PR. Do not merge without explicit approval.

Architecture changes should follow explicit goals, concrete failures or verified runtime incompatibilities—not invented future milestones.
