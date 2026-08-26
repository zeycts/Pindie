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

- Pi owns model invocation, tool execution, sessions, and the low-level `LLM → Tool → Result → LLM` agent loop.
- Pindie owns durable semantic State, State invariants, deterministic semantic derivation, legal capabilities, execution authorization, verification semantics, Human Gate semantics, and Pindie-owned presentation.
- The model owns interpretation of user intent, planning, semantic choices within the legal capability space, and semantic evidence-coverage judgment.
- The human owns goals, taste, consequential judgment, and final approval where required.
- Reality is authoritative for reconstructable facts.

Pindie must not implement a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, or second Skill runtime.

## Design principles

- **Deterministic closure:** if authoritative facts uniquely determine a constraint, encode it in the Harness rather than asking the model to remember it.
- **Semantic freedom:** do not hard-code choices that genuinely require interpretation of user intent or project meaning.
- **Eliminate meaningless choices, preserve meaningful choices.**
- Model-visible affordances and runtime legality should be projections of the same semantic capability model.
- Persist only durable semantic current-work information that cannot be reliably reconstructed from reality.
- Capabilities, active tools, run authority, presentation, reasoning mode, and workflow phases are runtime-derived and never persisted in `PindieState`.
- Reducer transitions remain tool-agnostic; Pi tool names must not leak into State semantics.
- Guards are execution-time backstops, not the primary way the normal Agent Loop learns what is legal.
- Prefer the smallest implementation that directly represents the approved architecture.
- Do not create a second temporary semantic truth merely to preserve legacy v0.1 affordances during migration. Build pure target semantics first, then cut runtime consumers over at the milestone that explicitly owns that behavior change.

## Development workflow

For each approved milestone:

1. Read only the relevant target docs, source, and tests.
2. Preserve the milestone boundary; do not implement later milestones early.
3. Add focused tests for the approved semantic contract.
4. Implement the smallest change that satisfies those tests.
5. Preserve unrelated runtime behavior.
6. Run `pnpm run check` before declaring completion.

## Approved v0.2 migration sequence

- **M0 — Semantic Foundation:** pure `RunFacts → SemanticSnapshot → Capabilities` derivation and tests; no runtime behavior change. Implemented.
- **M1 — Execution Semantics Foundation:** pure Tool Effect Model plus capability-based authorization helpers; no `extension.ts`/Guard cutover and no runtime behavior change.
- **M2 — Semantic Gateway Cutover:** adapt real Agent-run/runtime facts into `SemanticRunFacts` and make capability authorization the semantic execution authority. This is the first intentional runtime semantic cutover and includes the already-approved blocker, Human Gate, and completion capability semantics rather than preserving them through a parallel compatibility policy.
- **M3 — Model Tool Surface:** replace broad model-facing semantic action enums with narrow semantic tools and capability-driven dynamic tool visibility.
- **M4 — Policy Reduction:** remove Core Policy, tool-description, and Guard instructions made redundant by the semantic/capability architecture.
- **M5 — Verification v0.2:** separate Harness-owned factual evidence from model-owned semantic coverage judgment.
- **M6 — Continuation Simplification:** deterministic continuation eligibility plus a thin semantic intent probe.
- **M7 — Skill / Docs Prune:** remove duplicated Core correctness rules from Skills and prune stale migration documentation.
- **M8 — Extension Composition:** leave `extension.ts` primarily as Pi lifecycle wiring over semantic/runtime subsystems.

Implement only the current approved milestone. M1 must not wire the new authorization path into live `tool_call` handling. M2 must not preserve target/legacy differences by inventing a second compatibility capability model; it intentionally moves the live semantic authorization boundary onto the v0.2 capability truth.