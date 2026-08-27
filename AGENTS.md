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

- Pi owns model invocation, concrete tool registry/execution, sessions, system-prompt construction, and the low-level `LLM → Tool → Result → LLM` loop.
- Pindie owns durable semantic State, State invariants, deterministic semantic derivation, capabilities, capability-driven Tool Surface narrowing, execution authorization, verification semantics, Human Gate semantics, and Pindie-owned presentation.
- The model owns user-intent interpretation, planning, semantic choices within the legal capability space, and semantic evidence-coverage judgment.
- The human owns goals, taste, consequential judgment, and final approval where required.
- Reality is authoritative for reconstructable facts.

Pindie must not implement a second agent loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, or second Skill runtime.

## Design principles

- **Deterministic closure:** if authoritative facts uniquely determine a constraint, encode it in the Harness.
- **Semantic freedom:** do not hard-code choices that genuinely require interpretation of user intent or project meaning.
- **Eliminate meaningless choices, preserve meaningful choices.**
- Model-visible affordances and runtime legality are projections of the same semantic capability model.
- Persist only durable semantic current-work information that cannot be reliably reconstructed from reality.
- Capabilities, active tools, Run authority, presentation, reasoning mode, and workflow phases are runtime-derived and never persisted in `PindieState`.
- Reducer transitions remain tool-agnostic; Pi tool names must not leak into State semantics.
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
- **M4 — Policy Reduction:** next. Remove the global Pindie Core Policy/system-prompt override and make Runtime Context a factual Knowledge Surface derived from the same semantic snapshot used by capabilities.
- **M5 — Verification v0.2:** separate Harness-owned factual evidence from model-owned semantic coverage judgment.
- **M6 — Continuation Simplification:** deterministic continuation eligibility plus a thin semantic intent probe.
- **M7 — Skill / Docs Prune:** remove duplicated correctness rules from Skills and stale migration documentation.
- **M8 — Extension Composition:** leave `extension.ts` primarily as Pi lifecycle wiring over semantic/runtime subsystems.

## M4 implementation authority

M4 is a deletion/reconciliation milestone. M0–M3 semantic legality and Tool Surface behavior are already live and must not be redesigned.

### Delete the global Core Policy layer

Remove `PINDIE_CORE_POLICY`, Core block rendering/injection, and the `before_agent_start` `systemPrompt` override used solely to append Pindie lifecycle policy.

Do **not** move that policy into:

- a hidden custom message;
- Runtime Context;
- tool descriptions;
- Gateway errors;
- another prompt file.

Pi should own its native system prompt. After M3 changes active tools, Pindie should allow Pi's current base prompt to track those active tools naturally instead of pinning a Pindie-owned override.

### Runtime Context becomes factual Knowledge Surface

Runtime Context may describe only current semantic facts, including:

- Agent Run authority: `coherent | stale | unavailable`;
- Task status and verification status when available;
- current Task goal, constraints, success criteria, open loops, verification records, and Human Gate;
- an unavailable-State reason when applicable.

It must not tell the model which lifecycle action to call, prohibit an action already prohibited structurally, or restate capability legality.

Runtime Context status values must consume the same `SemanticSnapshot` truth used by capability derivation rather than independently re-deriving Task/verification status.

The context header should make clear that the block is runtime metadata, not user intent or a new request.

### Preserve existing structural authority

Do not change:

- M0 capability semantics;
- M1 Tool Effects;
- M2 Gateway authorization;
- M3 narrow semantic tool names or Tool Surface projection;
- reducer/runtime backstops;
- verification schema;
- Human Gate semantics;
- Project Mutation Freshness;
- reasoning behavior.

### Continuation boundary

M6 owns continuation redesign. M4 may only make the smallest literal rename needed if the existing continuation prompt references a retired broad tool name such as `replace_task`; otherwise leave continuation semantics unchanged.

### Recovery text

Do not mechanically delete operation-specific error/recovery text. M4 removes duplicated global policy, not useful factual diagnostics for exceptional runtime failures.