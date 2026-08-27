# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authority

For architecture or implementation work, use this order:

1. The explicit approved task specification in the current request.
2. `docs/architecture.md` — current architecture and ownership boundaries.
3. `docs/behavior.md` — current semantic and behavioral contract.
4. Existing source and tests — implemented runtime baseline.

If those sources conflict, report the contradiction before widening scope. Do not preserve obsolete behavior merely because an older implementation or test encoded it.

## Ownership

- **Pi** owns model invocation, concrete tool registry/execution, sessions, native system-prompt construction, Skill loading/runtime, retries/compaction/follow-up delivery, and the low-level `LLM → Tool → Result → LLM` loop.
- **Pindie** owns durable semantic State, State invariants, deterministic semantic derivation, capabilities, capability-driven Tool Surface narrowing, execution authorization, factual verification-evidence provenance/freshness, Human Gate semantics, and Pindie-owned presentation.
- **Model** owns user-intent interpretation, planning, semantic choices within the legal capability space, and semantic verification judgment: whether factual evidence means a check passed/failed and which success criteria it covers.
- **Human** owns goals, taste, consequential judgment, and final approval where required.
- **Reality** is authoritative for reconstructable facts.

Pindie must not implement a second Agent Loop, workflow engine, persisted phase machine, task queue, planner framework, memory database, verification-log database, or second Skill runtime.

## Design principles

- **Deterministic closure:** if authoritative facts uniquely determine a constraint, encode it in the Harness.
- **Semantic freedom:** do not hard-code choices that genuinely require interpretation of user intent or project meaning.
- **Eliminate meaningless choices, preserve meaningful choices.**
- **Harness owns facts; model owns meaning.**
- Model-visible affordances and runtime legality are projections of the same semantic capability model.
- Persist only durable semantic current-work information that cannot be reliably reconstructed from Reality.
- Capabilities, active tools, Run authority, presentation state, recent evidence refs/generation, continuation fuses, and workflow phases are runtime-derived and never persisted in `PindieState`.
- Reducer transitions remain tool-agnostic; Pi tool names and runtime evidence refs must not leak into persisted State semantics.
- The Execution Gateway remains a defense-in-depth backstop after Tool Surface alignment.
- Pindie may narrow Pi/user tool availability for the current Run but must never enable tools absent from the captured Run baseline.
- Natural-language policy is a last resort, not a source of deterministic correctness.
- Prefer the smallest implementation that directly represents the approved architecture.

## Current architectural baseline

- `PindieState + SemanticRunFacts → SemanticSnapshot → Capabilities` is the semantic source of truth.
- Tool Effects map concrete tools to required capabilities and project-mutation effects.
- The active Tool Surface is the captured Pi/user Run baseline filtered by current capabilities.
- The Execution Gateway re-authorizes consequential calls against fresh authority.
- Runtime Context is factual Snapshot-aligned Knowledge Surface; Pindie does not own a global lifecycle-policy system prompt.
- Verification facts come from actual tool results through runtime-only evidence refs; the model still owns pass/fail meaning and criterion coverage.
- Active Task Continuation is a one-shot Pi-native follow-up whose deterministic eligibility comes from `SemanticSnapshot`; the probe asks only whether latest actual user intent still calls for consequential execution.
- Historical runtime probes are filtered from future model context.

## Development workflow

For an approved task:

1. Read only the relevant architecture/behavior sections, source, and tests.
2. Preserve the requested scope; do not implement adjacent cleanup speculatively.
3. Add focused tests for changed contracts.
4. Implement the smallest change that satisfies them.
5. Preserve unrelated runtime behavior and user work.
6. Run `pnpm run check` before declaring completion.

## Current maintenance focus

The remaining v0.2 internal cleanup is **Extension Composition**: reduce `src/extension.ts` toward Pi lifecycle wiring over existing semantic/runtime subsystems without changing the established behavior above. Do not redesign semantics merely to make file decomposition easier.
