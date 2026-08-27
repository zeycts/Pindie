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
- Capabilities, active tools, Run authority, presentation, reasoning mode, recent evidence refs, evidence generation, and workflow phases are runtime-derived and never persisted in `PindieState`.
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
- **M5 — Verification v0.2:** next. Harness owns factual evidence capture/provenance/freshness; model owns semantic pass/fail and criterion coverage judgment.
- **M6 — Continuation Simplification:** deterministic continuation eligibility plus a thin semantic intent probe.
- **M7 — Skill / Docs Prune:** remove duplicated correctness rules from Skills and stale migration documentation.
- **M8 — Extension Composition:** leave `extension.ts` primarily as Pi lifecycle wiring over semantic/runtime subsystems.

## M5 implementation authority

M5 changes verification evidence provenance without redesigning persisted verification State.

### Persisted verification schema stays compatible

Do **not** change the durable `VerificationCheck` shape merely to add runtime evidence references. Existing State continues to persist:

```text
name
status: passed | failed
covers: string[]
evidence: string
```

Existing v0.1 verification records are grandfathered. Do not introduce State migration, schema-version machinery, forced stale-on-load behavior, or a verification log database.

### Runtime evidence references are temporary

Recent evidence refs are runtime-only handles tied to actual Pi tool results, preferably `ev:<toolCallId>` or an equivalent deterministic handle. They must never be persisted into `PindieState`.

`pindie_verification_record` should accept model-owned semantic judgment plus runtime evidence refs; the Harness resolves those refs and materializes bounded factual evidence into the existing durable `evidence: string` field before dispatching the existing reducer event.

### Evidence ownership

Harness owns:

- which actual tool result a ref denotes;
- tool/result success-vs-error fact;
- factual bounded input/result excerpts and deterministic digests;
- evidence freshness and invalidation;
- refusing unknown/stale refs.

Model owns:

- verification check name;
- `status: passed | failed` semantic interpretation;
- success-criterion coverage.

Do not derive `status` from `isError`; an error result may legitimately prove a criterion such as rejection of invalid input.

### Evidence eligibility

Evidence candidates are factual observations, not arbitrary semantic-State mutations.

- `observe.project` / `observe.git`: eligible while a coherent unfinished Task exists.
- ambiguous project-effect tools such as `bash`/unknown custom tools: eligible only after M2 mutation observation proves project reality unchanged.
- known project mutations (`edit`/`write`): not evidence candidates.
- Pindie Task/Gate/verification semantic tools: not evidence candidates.

### Evidence freshness

Use a runtime-only evidence generation/freshness token so parallel or late results from an older project/Task basis cannot become current evidence.

An authorized call records the generation at call time. A result may be captured only if its call generation still equals the current generation after existing mutation bookkeeping has completed.

Advance/clear recent evidence when the verification basis changes, including at least:

- actual Agent Run start;
- successful Task start/replace;
- successful Task refinement;
- known project mutation;
- detected/unknown ambiguous project mutation;
- external authority discontinuity / State unavailable.

Do not advance merely for observation, Task progress, Gate open/resolve, or verification record.

### Mutation ordering

For ambiguous tools, existing Project Mutation Freshness must run before evidence capture. If project mutation is detected or cannot be proven absent, invalidate verification/evidence freshness and do not expose that tool result as current evidence.

### Bounded persistence

Do not persist raw tool-result logs automatically. Recent candidates remain runtime-only. Only evidence refs explicitly selected in `pindie_verification_record` are materialized into durable evidence, using deterministic Harness-side bounding/excerpts/digests.

M5 must not redesign continuation, Skills, capability semantics, Tool Surface, Gateway legality, or reducer transition vocabulary.