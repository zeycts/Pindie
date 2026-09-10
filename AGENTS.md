# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authority

For architecture or implementation work, use this order:

1. The explicit approved task specification in the current request.
2. `docs/cross-project-learning-v0.2.md` — authoritative architecture contract when the task touches Cross-Project Learning v0.2 Strategy Synthesis, Synthesis Trial/Decision, shared cross-project validation, or synthesis-origin user-global trust.
3. `docs/cross-project-learning-v0.1.md` — authoritative implemented contract for Cross-Project Strategy Trust Transfer. Preserve its Scope Candidate/source-project semantics unless v0.2 explicitly extends shared validation around them.
4. `docs/composable-pindie-architecture-v0.1.md` — authoritative implemented architecture contract for the final composition boundary and its Slices A–F.
5. `docs/architecture.md` — current architecture and ownership boundaries.
6. `docs/remote-companion.md` — authoritative Remote Companion architecture/behavior when the task touches Remote Companion or Discord integration.
7. `docs/behavior.md` — current semantic and behavioral contract.
8. Existing source and tests — implemented runtime baseline.

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
- Remote Companion, when enabled, is an external projection/control surface over the current native Pi Session. Discord routing metadata may persist external IDs/delivery cursor only; it must not become semantic State, conversation truth, a second Session, or a second message queue.

## Cross-Project Learning boundary

Cross-Project Learning has two distinct knowledge origins:

```text
v0.1 Trust Transfer
project-local promoted Strategy
→ Scope Candidate
→ cross-project Trial/review
→ Human Decision
→ user-global trust

v0.2 Strategy Synthesis
multi-project Experience
→ Synthesis Candidate
→ cross-project Trial/review
→ Human Decision
→ user-global trust
```

Preserve these rules:

- v0.1 transfers an already-trusted exact project-local revision; v0.2 synthesizes a new untrusted hypothesis from distributed Experience.
- Scope Candidate and Synthesis Candidate remain distinct immutable artifact families.
- Reuse only the common cross-project Trial evidence and global promotion-safety facts; do not introduce a persisted generic Candidate framework.
- Discovery evidence never grants trust. Synthesis Candidate authority is none until explicit Trial; only Human promotion grants user-global trust.
- Synthesis discovery provenance is historical audit context, not Promotion authority. Promotion revalidates fresh Trial evidence and current trust safety.
- Transfer-origin and synthesis-origin promoted Strategies converge only at the normal user-global trusted Policy projection.
- Autonomous/background triggering is outside v0.2.

## Development workflow

For an approved task:

1. Read only the relevant architecture/behavior sections, source, and tests. For CPL v0.2 work, read `docs/cross-project-learning-v0.2.md` first and preserve the implemented v0.1 transfer contract. For Composable Pindie work, read the relevant Slice and invariants in `docs/composable-pindie-architecture-v0.1.md`; for Remote Companion work, read `docs/remote-companion.md` before implementation.
2. Preserve the requested scope; do not implement adjacent cleanup speculatively.
3. Add focused tests for changed contracts.
4. Implement the smallest change that satisfies them.
5. Preserve unrelated runtime behavior and user work.
6. Run `pnpm run check` before declaring completion.

Composable Pindie Architecture v0.1 is complete through final Slice F. Preserve its final feature-selection, trust-safety, lifecycle, and dependency-direction invariants.

Cross-Project Learning v0.2 is approved for implementation only through the Slices defined in `docs/cross-project-learning-v0.2.md`. Complete and review one Slice before starting the next. Do not skip ahead to Autonomous Learning.

## Maintenance posture

The existing implemented Pindie architecture baseline and the Composable Pindie v0.1 migration through Slice F are complete.

`docs/composable-pindie-architecture-v0.1.md` records the implemented final composition boundary and remains the single architecture source of truth for that boundary. Source/tests and the synchronized architecture guidance remain the implemented-state baseline.

`docs/cross-project-learning-v0.2.md` is an approved forward contract, not yet an implemented-state claim. Until its Slices land, existing v0.1 source/tests remain runtime truth where v0.2 has not yet been implemented.

Future architecture changes should be driven by concrete dogfood failures, explicit user goals, or verified incompatibilities with Pi/runtime reality, not by speculative cleanup.

Do not create new architectural milestones or refactor established ownership boundaries merely for additional cleanup.
