# Pindie Self-Improvement

## 1. Purpose

Pindie v0.3 introduces a Self-Improvement layer above the existing Pi/Pindie runtime.

The goal is not to create a better hand-written Agent Loop. The goal is to let Pindie gradually improve how it approaches development tasks while keeping Pi's low-level Agent Loop and Pindie's deterministic semantic authority stable.

The long-term learning relation is:

```text
Human-validated priors
        ↓
Current cognitive policy
        ↓
Task execution
        ↓
Outcome + evidence
        ↓
Experience
        ↓
Policy adaptation
        ↓
Better future policy
```

The model weights remain external and unchanged. Self-Improvement happens in the mutable policy, experience, and reusable capability layers around the model.

## 2. Architectural boundary

Self-Improvement must preserve the existing ownership model.

```text
Pi Kernel
  LLM ↔ Tool ↔ Result
        ↓
Pindie Environment
  State / Reality / Snapshot / Authority / Gateway
        ↓
Pindie Evaluation
  Verification evidence / outcome / cost / human feedback
        ↓
Pindie Policy
  Strategies / selection / adaptation / evolution
        ↓
Capabilities
  Tools / Pi Skills / external capabilities
```

Interface systems such as TUI status and Remote Companion remain projections/control surfaces and are not part of the learning mechanism.

### Stable layers

The following remain deterministic and are not learnable policy:

- `PindieState` and hard State invariants;
- `SemanticRunFacts → SemanticSnapshot → Capabilities`;
- Tool Effect classification and live execution authorization;
- Project Mutation Freshness;
- factual verification-evidence provenance and freshness;
- Human Gate authority;
- Pi's native Agent Loop, sessions, tool execution, retries, compaction, follow-up delivery, and Skill runtime.

A learned policy may choose how to act within the legal action space. It must never redefine the legal action space.

## 3. Policy, Skill, and Environment are different concepts

### Strategy

A Strategy is a cognitive prior about how to approach a problem.

Examples:

- `direct-action`
- `reproduce-first`
- `explore-first`
- `hypothesis-driven`
- `architecture-first`
- `minimal-change`
- `verify-as-you-go`

A Strategy is advisory. It is not a workflow, phase machine, authority rule, or mandatory sequence of steps.

### Skill

A Skill is a reusable procedure/capability executed through Pi's native Skill runtime.

Example: `git-workflow`.

Strategies may influence when a Skill is useful, but Strategy and Skill must not become the same abstraction.

### Environment

Environment describes current truth and legal action space. It does not tell the model how it should think.

The test for future design decisions is:

> Is this a fact/authority requirement, or merely a belief about how the Agent should solve the problem?

Facts and authority belong to the deterministic Harness. Problem-solving preferences belong to Policy.

## 4. Two time scales

Pindie must not implement a second inference-time Agent Loop.

### Fast loop — Pi

```text
model → action → feedback → model
```

This operates within a single Agent Run.

### Slow loop — Self-Improvement

```text
policyₙ
  ↓
task(s)
  ↓
outcomes
  ↓
experience/evaluation
  ↓
policyₙ₊₁
```

This operates across tasks.

Self-Improvement is the slow loop only.

## 5. Seed policy

Pindie does not start from zero.

Human engineering practice already contains useful validated priors. Pindie starts from a small Seed Strategy portfolio and adapts those priors using real task outcomes.

The intended relation is:

```text
Human knowledge as prior
+
Pindie experience as evidence
→
Better local policy
```

This allows Pindie to specialize toward the actual user, repositories, tools, and development environment instead of rediscovering generic engineering knowledge from scratch.

## 6. Self-Improvement milestones

These milestones are implementation checkpoints inside the Pindie v0.3 direction. They are not additional Agent Loops or persisted workflow phases.

### SI v0.1 — Seed Strategy Runtime

Goal: establish `Policy₀`.

- define a small immutable Seed Strategy catalog;
- expose it as bounded, runtime-only model context;
- strategies are optional and may be used, combined, or ignored;
- no explicit strategy-selection tool;
- no persistence;
- no Experience Store;
- no scoring, mutation, adaptation, or evolution;
- no changes to State, capabilities, Gateway, Pi Skill runtime, or Pi Agent Loop.

Initial Seed Strategies:

```text
Approaches
- direct-action
- reproduce-first
- explore-first
- hypothesis-driven
- architecture-first

Modifiers
- minimal-change
- verify-as-you-go
```

A Strategy should contain only compact semantics such as:

```text
id
kind: approach | modifier
summary
useWhen[]
avoidWhen[]
principles[]
```

It must not contain a mandatory `steps[]`, transition graph, phase machine, or hidden workflow engine.

### SI v0.2 — Explicit Policy Snapshot

Goal: make cognitive policy observable without making it mandatory ceremony.

- represent the Agent's current strategy choice as runtime-only data;
- support composition of an approach plus zero or more modifiers;
- keep strategy choice model-owned;
- do not persist policy identity in `PindieState`;
- avoid forcing every trivial task through an explicit strategy-selection turn.

Output of this milestone is an observable relation:

```text
Task → Policy Snapshot → Execution
```

### SI v0.3 — Strategy-aware Experience

Goal: create the first learning dataset.

Record a bounded cross-task relation:

```text
Task
→ Policy Snapshot
→ relevant trajectory facts
→ factual outcome/evaluation
```

Experience should prefer reconstructable/factual signals over unconstrained model-authored reflection.

Potential signals include:

- verification result and coverage;
- CI/test outcome when available;
- human acceptance/rejection when explicit;
- run duration;
- token/cost facts;
- consequential tool/mutation facts;
- task completion status.

Do not turn Experience into a raw transcript database.

### SI v0.4 — Strategy Adaptation

Goal: allow evidence-backed specialization of existing strategies.

```text
seed/current strategy
        ↓
repeated relevant experience
        ↓
candidate adaptation
        ↓
future evaluation
        ↓
promote or reject
```

Adaptation must create a candidate first. A single task must not silently rewrite the active policy.

### SI v0.5 — Strategy Derivation

Goal: allow new strategies to emerge from repeated useful patterns.

New candidates may arise through specialization or composition of existing strategies plus experience.

```text
human priors + local experience → Pindie-native strategy candidate
```

Derived strategies must enter evaluation as candidates before becoming trusted policy.

### SI v0.6 — Strategy Portfolio Evolution

Goal: prevent strategy accumulation from becoming policy debt.

The portfolio lifecycle may include:

```text
create
promote
demote
merge
split
retire
```

The system must control overlap and stale strategies rather than only adding more policy.

### SI v0.7 — Contextual Policy

Goal: move from choosing named strategies toward a context-sensitive cognitive policy.

Conceptually:

```text
P(policy | task, environment, history, outcomes)
```

Named strategies remain useful interpretable priors, but the policy layer may learn which combinations and execution parameters work best under different contexts.

Reasoning effort may eventually become one policy-controlled execution parameter rather than an independent hard-coded heuristic.

## 7. SI v0.1 runtime contract

SI v0.1 should be implemented as the smallest extension of the existing context projection.

Current conceptual flow:

```text
conversation
→ fresh Pindie Runtime Context
→ model
```

SI v0.1:

```text
conversation
→ fresh Pindie Policy Context
→ fresh Pindie Runtime Context
→ model
```

Runtime Context remains last because it represents current factual reality/authority. Policy Context is advisory.

Historical Policy Context must be filtered so it never accumulates in future model context.

The first implementation should require only a small Strategy module plus context integration. It should not create a policy manager hierarchy, Strategy database, retrieval subsystem, additional model call, router, planner, or selector Agent.

## 8. SI v0.1 hard invariants

A Strategy must never be able to:

- grant or revoke capabilities;
- bypass the Execution Gateway;
- mutate `PindieState` merely by being selected;
- redefine success criteria;
- fabricate or mark verification evidence as factual;
- resolve a Human Gate;
- complete a Task;
- enable a tool absent from the Pi/user Run baseline;
- alter Pi's low-level Agent Loop;
- trigger a second model loop.

Strategy semantics are weaker than Runtime/Environment truth.

## 9. Implementation method for Pindie v0.3

Use an architecture-first, just-in-time implementation process.

### Stable design first

This document defines the long-term ownership boundaries and milestone sequence.

Do not pre-design the detailed implementation of all later milestones. Later designs must be allowed to change based on real dogfood evidence from earlier milestones.

### One milestone at a time

For each SI v0.x milestone:

```text
1. inspect current main and previous milestone evidence
2. design only the next contract
3. generate one focused implementation prompt
4. implement on a focused branch
5. run tests/checks
6. review the diff against this architecture
7. dogfood on real Pindie tasks
8. record concrete failures/observations
9. only then design the next milestone
```

Implementation prompts are execution artifacts and should normally not be stored as permanent architecture documents.

### Evidence before evolution

Do not advance merely because a milestone compiles.

The next milestone should be justified by at least one of:

- a capability required by the roadmap cannot be observed yet;
- real dogfood reveals a concrete limitation;
- the previous milestone produces enough trustworthy evidence for the next learning mechanism.

### Minimize speculative infrastructure

Avoid adding systems early merely because later milestones might need them.

Examples to defer until demonstrated necessary:

- embeddings/vector retrieval for a seven-strategy catalog;
- a Strategy database before strategies become mutable;
- a dedicated policy Agent;
- a second Skill runtime;
- raw trajectory/transcript persistence;
- generalized workflow DSL;
- multi-Agent evaluation machinery.

## 10. Review rule

Every future Self-Improvement change should be reviewed with two separate questions:

1. **Correctness boundary:** did this change weaken deterministic State, authority, evidence, Human Gate, or Pi ownership?
2. **Learning value:** does this change make policy behavior more observable, evaluable, adaptable, or evolvable using real evidence?

If a change adds complexity but answers neither question, it should usually not be part of Self-Improvement.

## 11. v0.3 direction

Pindie v0.3 should evolve from:

```text
Pi
+
Pindie deterministic semantic layer
+
human-written execution heuristics
```

toward:

```text
Pi Kernel
+
Pindie deterministic Environment/Evaluation
+
Human Seed Policy
+
Pindie Experience
+
Evidence-driven Policy evolution
```

The target property is:

```text
same model + same Pi Kernel

Pindie(day 1) ≠ Pindie(day 100)
```

because the policy and reusable experience around the model have improved through real development work, while deterministic authority remains stable.
