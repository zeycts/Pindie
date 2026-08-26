# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authority

Read only the context relevant to the current task. For Pindie architecture work, use this authority order:

1. The explicit approved milestone/task specification in the current request.
2. `docs/architecture.md` — authoritative target architecture and ownership boundaries.
3. `docs/behavior.md` — authoritative semantic and behavioral contract.
4. Existing source and tests — authoritative for the currently implemented runtime baseline.

Pindie is migrating from the implemented v0.1 runtime to the approved v0.2 architecture in small milestones. During that migration, source/tests may intentionally lag the target docs. Do not redesign v0.2 back toward v0.1 merely to match legacy implementation details. Existing tests remain regression constraints unless the current approved milestone explicitly changes the behavior they cover.

If the current milestone, target docs, and implementation appear inconsistent, report the contradiction before expanding scope. Implement only the approved slice.

## Architectural ownership

- Pi owns model invocation, tool execution, sessions, the low-level `LLM → Tool → Result → LLM` agent loop, and the concrete active-tool registry.
- Pindie owns durable semantic State, State invariants, deterministic semantic derivation, legal capabilities, execution authorization, capability-driven narrowing of the active Tool Surface, verification semantics, Human Gate semantics, and Pindie-owned presentation.
- The model owns interpretation of user intent, planning, semantic choices within the legal capability space, and semantic evidence-coverage judgment.
- The human owns goals, taste, consequential judgment, and final approval where required.
- Reality is authoritative for reconstructable facts.

Pindie must not implement a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, or second Skill runtime.

## Design principles

- **Deterministic closure:** if authoritative facts uniquely determine a constraint, encode it in the Harness rather than asking the model to remember it.
- **Semantic freedom:** do not hard-code choices that genuinely require interpretation of user intent or project meaning.
- **Eliminate meaningless choices, preserve meaningful choices.**
- Model-visible affordances and runtime legality are projections of the same semantic capability model.
- Persist only durable semantic current-work information that cannot be reliably reconstructed from reality.
- Capabilities, active tools, run authority, presentation, reasoning mode, and workflow phases are runtime-derived and never persisted in `PindieState`.
- Reducer transitions remain tool-agnostic; Pi tool names must not leak into State semantics.
- The Execution Gateway remains a defense-in-depth backstop even after Tool Surface alignment.
- Pindie may narrow Pi/user tool availability for the current Run, but must not re-enable tools that were absent from the Run baseline.
- Prefer the smallest implementation that directly represents the approved architecture.
- Do not create a second temporary semantic truth merely to preserve legacy affordances during migration.

## Development workflow

For each approved milestone:

1. Read only the relevant target docs, source, and tests.
2. Preserve the milestone boundary; do not implement later milestones early.
3. Add focused tests for the approved semantic contract.
4. Implement the smallest change that satisfies those tests.
5. Preserve unrelated runtime behavior.
6. Run `pnpm run check` before declaring completion.

## Approved v0.2 migration sequence

- **M0 — Semantic Foundation:** pure `RunFacts → SemanticSnapshot → Capabilities` derivation and tests. Implemented.
- **M1 — Execution Semantics Foundation:** pure Tool Effect classification plus capability-membership authorization. Implemented.
- **M2 — Semantic Gateway Cutover:** real Agent-run facts now feed M0/M1; capability authorization is the live semantic execution authority and Project Mutation Freshness consumes shared Tool Effects. Implemented.
- **M3 — Model Tool Surface:** next. Replace broad semantic action enums with narrow semantic tools and make model-visible active tools a capability-driven narrowing of the Pi/user Run baseline.
- **M4 — Policy Reduction:** remove Core Policy, tool-description, and Guard instructions made redundant by the semantic/capability architecture; also resolve the temporary Pi v0.84.3 system-prompt override limitation left by M3.
- **M5 — Verification v0.2:** separate Harness-owned factual evidence from model-owned semantic coverage judgment.
- **M6 — Continuation Simplification:** deterministic continuation eligibility plus a thin semantic intent probe.
- **M7 — Skill / Docs Prune:** remove duplicated Core correctness rules from Skills and prune stale migration documentation.
- **M8 — Extension Composition:** leave `extension.ts` primarily as Pi lifecycle wiring over semantic/runtime subsystems.

## M3 implementation authority

M3 aligns model-visible affordances with the already-live M2 legality model. It must not change M0 capability semantics or weaken the M2 Gateway.

Replace the broad model-facing semantic tools with narrow capability-shaped tools:

```text
pindie_task_start          → task.start
pindie_task_replace        → task.replace
pindie_task_refine         → task.refine
pindie_task_progress       → task.progress
pindie_verification_record → verification.record
pindie_task_complete       → task.complete
pindie_gate_open           → gate.open
pindie_gate_resolve        → gate.resolve
pindie_git_observe         → observe.git
```

Internal reducer events remain unchanged. M3 does not redesign verification data, Gate semantics, or State.

Pindie is pinned to Pi v0.84.3. Its exact active-tool API is replacement-style: `getActiveTools()` returns the current names and `setActiveTools(names)` replaces the active set, ignores unknown names, rebuilds Pi's base system prompt, and takes effect on the next agent turn. There is no public composable overlay or active-tool-change event.

Therefore M3 uses a runtime-only **Run Tool Baseline**:

```text
Run baseline = Pi/user active tools captured at the authoritative `before_agent_start` Run boundary
Effective tools = Run baseline ∩ tools allowed by current Pindie capabilities
```

Pindie may only remove tools from that baseline during the Run. It must never activate a tool that the baseline did not contain. Restore the exact baseline when the Run settles; the next actual Run captures a fresh baseline.

Do **not** pre-apply semantic tool restriction from the `input` event. In Pi v0.84.3, `input` occurs before model/auth preflight and may be handled or rejected without an Agent Run, so mutating active tools there can strand a narrowed set and corrupt the next baseline. `before_agent_start` is the single authority boundary for both Run Facts and Run Tool Baseline.

Within an active Run, recompute the effective Tool Surface after semantic capability changes, project-mutation verification invalidation, and stale/unavailable authority changes. The M2 Gateway remains authoritative for races and already-generated calls.

Pi v0.84.3 has one integration limitation: Pindie's current `before_agent_start` Core Policy injection creates a system-prompt override for the high-level Run. `setActiveTools()` at `before_agent_start` still makes the actual tool schemas/action space correct before model execution, but selected-tool text already present in the prompt input may lag; mid-Run changes may also leave stale text in the existing override. Do not parse/rebuild Pi's private system prompt or import private Pi internals. M4 owns removal/restructuring of the Core Policy override so prompt text and dynamic Tool Surface can fully converge.

M3 must not prune Core Policy, redesign verification, redesign continuation, or invent a custom tool-registry framework.