# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authority

For architecture or implementation work, use this order:

1. The explicit approved task specification in the current request.
2. `docs/pindie-control-v0.2.md` — authoritative approved contract when the task touches workspace/project selection, active-project Host replacement, or the v0.2 Pindie Control surface. Preserve the implemented v0.1 runtime/control safety underneath it.
3. `docs/pindie-control-v0.1.md` — implemented baseline for headless Host control, Control Projection/lease semantics, and the six project-scoped Control tools.
4. `docs/quota-fallback-v0.1.md` — authoritative implemented contract when the task touches Quota Fallback, quota recovery, or temporary backup model switching; not authority over unrelated architecture.
5. `docs/autonomous-learning-v1.md` — approved target architecture for the future Learning Plane; Slice 1, Foundation F1/F2 and Local Discovery D1/D2 implemented; approved Trial reset R0/R1/R2/R3 complete, legacy T1 automatic execution removed; immutable TrialEvidence v2 and retention implemented. It supersedes legacy future-autonomy direction, not current runtime truth.
6. `docs/self-improvement-v0.6.md` and `docs/self-improvement-v0.7.md` — frozen implemented SI artifact and trust contracts during migration, not future autonomy authority.
7. `docs/cross-project-learning-v0.2.md` — implemented legacy contract for Strategy Synthesis, Synthesis Trial/Decision, shared cross-project validation, and synthesis-origin user-global trust.
8. `docs/cross-project-learning-v0.1.md` — implemented contract for Cross-Project Strategy Trust Transfer during migration. Preserve its Scope Candidate/source-project semantics unless v0.2 explicitly extends shared validation around them.
9. `docs/composable-pindie-architecture-v0.1.md` — authoritative implemented architecture contract for the final composition boundary and its Slices A–F.
10. `docs/architecture.md` — current architecture and ownership boundaries.
11. `docs/remote-companion.md` — authoritative Remote Companion architecture/behavior when the task touches Remote Companion or Discord integration.
12. `docs/behavior.md` — current semantic and behavioral contract.
13. Existing source and tests — implemented runtime baseline.

If those sources conflict, report the contradiction before widening scope. Do not preserve obsolete behavior merely because an older implementation or test encoded it.

## Ownership

- **Pi** owns model invocation, concrete tool registry/execution, sessions, native system-prompt construction, Skill loading/runtime, retries/compaction/follow-up delivery, and the low-level `LLM → Tool → Result → LLM` loop.
- **Pindie** owns durable semantic State, State invariants, deterministic semantic derivation, capabilities, capability-driven Tool Surface narrowing, execution authorization, factual verification-evidence provenance/freshness, Human Gate semantics, and Pindie-owned presentation.
- **Model** owns user-intent interpretation, planning, semantic choices within the legal capability space, and semantic verification judgment: whether factual evidence means a check passed/failed and which success criteria it covers.
- **Human** owns goals, taste, consequential judgment, and final approval where required.
- **Reality** is authoritative for reconstructable facts.

Pindie must not implement a second Agent Loop, general workflow engine, persisted Work Plane phase machine or Task queue, planner framework, memory database, verification-log database, or second Skill runtime. Approved Autonomous Learning v1 permits a tiny persistent domain-specific LearningJob scheduler/ledger separate from user Task State; this exception is not a general task queue or second LLM Agent Loop.

**Stable Mode is the production default.** Autonomous Learning is experimental and opt-in through `PINDIE_AUTONOMOUS_LEARNING_ENABLED=1`. With it disabled, ordinary Pindie work must not construct or depend on Self-Improvement, Cross-Project Learning, LearningSupervisor/Discovery jobs, ordinary Trial overlays, or Learning data. Existing Learning artifacts remain preserved on disk but inert.

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
- Quota recovery tries user-authorized same-Session DeepSeek fallback before existing Codex Quota Auto Resume; Host owns runtime recovery leases while Pi owns model/provider execution.

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
- Autonomous/background triggering is outside the implemented v0.2 contract. Its future-autonomy direction is superseded by the approved v1 Learning Plane, pending implementation.

## Development workflow

For an approved task:

1. Read only the relevant architecture/behavior sections, source, and tests. For workspace-aware Pindie Control work, read `docs/pindie-control-v0.2.md` first, then `docs/pindie-control-v0.1.md`, and keep project selection above rather than inside the existing Host/runtime truth. For Autonomous Learning v1 implementation, read the approved `docs/autonomous-learning-v1.md` first; preserve current runtime truth during migration. For current CPL v0.2 work, read `docs/cross-project-learning-v0.2.md` first and preserve the implemented v0.1 transfer contract. For Composable Pindie work, read the relevant Slice and invariants in `docs/composable-pindie-architecture-v0.1.md`; for Remote Companion work, read `docs/remote-companion.md` before implementation.
2. Preserve the requested scope; do not implement adjacent cleanup speculatively.
3. Add focused tests for changed contracts; during implementation, run the smallest relevant test file(s) for rapid feedback. When independent and useful, targeted tests and typecheck may run concurrently; avoid repeating the full suite after every small edit. Broader or brittle changes may justify an earlier full check when evidence requires it.
4. Implement the smallest change that satisfies them.
5. Preserve unrelated runtime behavior and user work.
6. Run `pnpm run check` once at the final completion boundary before declaring completion or delivery.

Composable Pindie Architecture v0.1 is complete through final Slice F. Preserve its final feature-selection, trust-safety, lifecycle, and dependency-direction invariants.

Cross-Project Learning v0.2 is implemented through final Slice E. Preserve its completed human-triggered lifecycle during the approved v1 migration; do not add a CPL v0.2 Slice F.

## Maintenance posture

The existing implemented Pindie architecture baseline and the Composable Pindie v0.1 migration through Slice F are complete.

`docs/composable-pindie-architecture-v0.1.md` records the implemented final composition boundary and remains the single architecture source of truth for that boundary. Source/tests and the synchronized architecture guidance remain the implemented-state baseline.

`docs/cross-project-learning-v0.2.md` records the implemented v0.2 architecture through Slice E and remains compatibility/history authority for those artifacts and trust rules during migration. SI v0.6/v0.7 likewise remain frozen implemented artifact/trust contracts. Source/tests are current runtime truth. `docs/autonomous-learning-v1.md` is the approved target architecture for Autonomous Learning; Slice 1, Foundation F1/F2 and Local Discovery D1/D2 are implemented. The approved Trial reset has completed R0/R1/R2/R3: legacy T1 automatic execution is removed; StrategyHypothesis v1 is immutable/readable/non-executable, new Discovery v4 / selection v4 produces v2 with model-authored principles, and exact lineage projects open leaves without deleting history. Old v3 committed outputs recover; uncommitted v3 jobs are stale. A v1 leaf upgrades only through normal future Discovery with new evidence. R2 TrialAssignment v2 + ordinary-work overlay is implemented: bounded atomic episode assignment, preexisting-Task first-request and authorized same-Run task_start placement, one-shot transient advisory and explicit exact `trial` Policy selection. Obsolete T1 reservation/watcher/preflight execution is removed; frozen v1 contract/read history compatibility remains. R3 immutable TrialEvidence v2 is implemented: exact committed ordinary v5 Experience plus final assigned trial Policy and subsequent ordinary execution materializes bounded immutable factual support in a separate namespace; retention protects unmaterialized support and live comparisons, while materialized raw sources may expire. Frozen v1 compatibility remains unchanged. R4-A EvaluationPacket v1 / EvaluationResult v1 pure contracts are documented in `docs/autonomous-learning-r4-a.md`: immutable TrialEvidence-only observational analysis, dedicated non-trust refs, no runtime execution or live Experience reads. R4-B standalone immutable EvaluationPacket builder is implemented (`docs/autonomous-learning-r4-b.md`): deterministic exact resolution/selection/freeze only, no production wiring. R4-C1 standalone immutable EvaluationPacket Store is implemented (`docs/autonomous-learning-r4-c1.md`): exact lookup, source-revalidated locked unique publication and lifecycle metadata only, without production execution or retention wiring. R4-C2 standalone EvaluationRun v1 foundation is implemented (`docs/autonomous-learning-r4-c2.md`): exact immutable packet binding, append-only lifecycle snapshots and isolated namespace-locked publication only; no evaluator or production runtime wiring. R4-C3-A standalone Evaluator contract foundation is implemented (`docs/autonomous-learning-r4-c3-a.md`): versioned capability-free context, observation-only output, exact bindings and detached deeply frozen input preparation only; no evaluator invocation, output persistence or runtime sandbox. R4-C3-B standalone ExecutionRunner is implemented (`docs/autonomous-learning-r4-c3-b1.md`): exact registered evaluator invocation, frozen capability-free input, strict output validation, durable exclusive execution claims and immutable running/terminal publication; no retry policy, timeout, cancellation, real evaluator, result persistence or runtime sandbox. R4-C3-C1 pure ExecutionLease v1 contract is implemented (`docs/autonomous-learning-r4-c3-c1.md`): strict ownership metadata and immutable heartbeat helpers only; no runner wiring, stale detection or recovery. Production Evaluation execution and autonomous trust remain pending; assignment/render/selection alone do not constitute applied-Trial evidence. No production dogfood has been claimed. R4-C3-C2 now adds standalone immutable lease persistence in `execution-leases-v1`, genuine-claim-bound origin publication, exact lookup and strictly advancing linked heartbeat snapshots; ExecutionRunner and claim execution authority remain unchanged. Stale detection, expiry, takeover and recovery remain pending. [R4-C3-C4](docs/autonomous-learning-r4-c3-c3.md) adds standalone pure lease-freshness assessment with explicit policy/clock inputs and ACTIVE / STALE_CANDIDATE / UNKNOWN observations; no run/lease writes, owner confirmation, recovery eligibility, fencing or production wiring.

Pindie Control v0.1 is implemented and dogfood-validated through ChatGPT → Secure MCP Tunnel → headless Pindie Control. `docs/pindie-control-v0.2.md` is the approved next architecture contract for workspace-aware single-active-project selection.

Quota Fallback v0.1 is complete through final Slice E; `docs/quota-fallback-v0.1.md` records its implemented quota recovery boundary.

Future architecture changes should be driven by concrete dogfood failures, explicit user goals, or verified incompatibilities with Pi/runtime reality, not by speculative cleanup.

Do not create new architectural milestones or refactor established ownership boundaries merely for additional cleanup.
