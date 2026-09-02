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

Goal: make model-owned cognitive policy observable during an Agent Run without making strategy choice mandatory ceremony.

The original roadmap relation `Task → Policy Snapshot → Execution` is refined for implementation to a Run-scoped relation:

```text
Agent Run
→ optional current Policy Snapshot
→ Execution
```

A single Task may span multiple Agent Runs with different evidence, user guidance, or strategies. Policy identity therefore must not become Task State or silently carry across Runs.

#### Policy Snapshot

The current Policy Snapshot contains only:

```text
approach: exactly one Seed Strategy whose kind is `approach`
modifiers: zero or more unique Seed Strategies whose kind is `modifier`
```

Do not add rationale, confidence, score, workflow steps, or learned metadata in SI v0.2.

The Snapshot represents the model's current declared cognitive policy, not a deterministic inference by the Harness.

#### Model-owned declaration

Pindie may expose one optional structured tool, conceptually `pindie_policy_set`, that lets the model declare or replace the current Run's Policy Snapshot.

The declaration mechanism must obey these rules:

- calling it is optional;
- the model decides whether a named Strategy materially guides the current work;
- it must not be called merely to populate metadata or satisfy a required opening ceremony;
- it must not create a separate strategy-selection turn;
- it must not invoke another model, router, planner, or selector Agent;
- a later declaration in the same Run replaces the current Snapshot rather than creating persistent history.

SI v0.2 retains only the current Run Snapshot. Historical policy changes belong to a later experience milestone.

#### Lifecycle

Policy Snapshot is runtime-only:

- each new Agent Run starts with no declared Snapshot;
- a declaration may set or replace the Snapshot during that Run;
- the current Snapshot is communicated by the `pindie_policy_set` tool result rather than repeated context projections;
- a new Agent Run resets it;
- session restart/reload does not restore it;
- it is never stored in `PindieState` or another durable policy database.

This prevents stale strategy identity from leaking across new user guidance or changed evidence.

#### Policy visibility

The existing Seed Strategy catalog remains model-visible through Pindie's stable System Contract.

The current Snapshot is model-visible only through the successful `pindie_policy_set` tool call/result in the current transcript. No current Snapshot is fabricated or re-injected on later model requests.

#### Capability and authorization boundary

A structured policy declaration is a real tool action and therefore must remain aligned with Pindie's Tool Surface/Gateway model.

SI v0.2 should introduce a fixed non-consequential capability such as:

```text
policy.declare
```

This capability is part of the stable Harness action space, not learned Policy. It may remain available independent of Task status because declaring runtime cognitive policy does not alter project reality or semantic State.

The policy declaration tool must:

- require `policy.declare`;
- have project-mutation effect `none`;
- pass through normal Tool Surface and Execution Gateway authorization;
- never produce verification evidence merely because it is non-mutating;
- never affect Task Run relations, project mutation freshness, or verification freshness.

Policy chooses within the legal action space; it still cannot redefine that space.

#### SI v0.2 non-goals

Do not implement:

- automatic strategy classification by Harness heuristics;
- parsing assistant prose to infer selected strategies;
- mandatory strategy selection for every Task/Run;
- more than one primary approach at a time;
- rationale/confidence/score fields;
- policy persistence;
- policy history/trajectory storage;
- Experience Store;
- rewards or strategy evaluation;
- adaptation, mutation, derivation, or evolution;
- learned Skills;
- Strategy retrieval/embeddings;
- policy status-line or Remote Companion UI;
- reasoning-policy migration;
- a second Agent Loop.

The output of SI v0.2 is simply an optional, structured, Run-scoped cognitive-policy observation that later milestones can associate with execution outcomes.

### SI v0.3 — Strategy-aware Run Experience

Goal: create the first durable learning dataset from bounded, factual Agent Run records without evaluating or adapting policy yet.

SI v0.2 dogfood showed that a Policy Snapshot may be declared late in a Run. A final Strategy label alone therefore cannot be treated as evidence that the Strategy guided the whole execution. SI v0.3 must preserve enough declaration-position and execution facts to distinguish early guidance from possible post-hoc labeling.

The implementation relation is:

```text
Agent Run
  ├─ Task facts
  ├─ optional Policy Snapshot + declaration position
  ├─ bounded execution counters
  ├─ factual final outcome
  └─ run metrics
        ↓
immutable Run Experience
        ↓
per-project Experience Store
```

The Experience unit is one Agent Run, not one Task. A Task may span several Runs with different declared policies and evidence.

#### Run Experience record

A schema v2 Run Experience contains only bounded factual data equivalent to:

```text
schemaVersion: 2
recordedAt

runStart
  taskStatus
  taskGoal | null

task
  goal
  taskRelation

policy
  finalSnapshot | null
  declarationCount
  firstDeclarationAfter | null
  finalDeclarationAfter | null

execution
  toolCalls
  observations
  consequentialCalls
  projectMutationEffectCalls
  verificationCalls
  toolErrors
  deniedCalls

outcome
  taskStatus
  verificationStatus
  completionRelation
  hasBlockers
  hasQuestions
  humanGateOpen

metrics
  durationMs
  cost
```

The exact internal TypeScript layout may differ, but the semantic boundary should remain this small.

Do not store model reasoning, chain-of-thought, assistant reflection, raw transcript, raw tool results, full verification evidence, or arbitrary prose summaries in Experience.

#### Task facts

Do not introduce a task classifier, complexity score, or inferred task type in SI v0.3.

Use existing authoritative Task/Run facts. `runStart.taskStatus` and `runStart.taskGoal` describe the factual Task state and goal at the beginning of the Run; `runStart.taskGoal` is null when no Task existed then. `task.goal` is the goal of the Task associated with the coherent settlement snapshot, and `taskRelation` should come from current semantic Run facts rather than model interpretation. Run-start facts and settlement Task facts are different temporal observations and must not be conflated.

#### Policy attribution facts

Policy declaration remains model-owned and optional.

Runs with no Policy Snapshot are valid Experience and must not be discarded merely because no Strategy was declared. Otherwise the dataset would be biased toward runs that used explicit policy metadata.

For a Run with declarations, retain only:

- the final Snapshot;
- how many successful declarations occurred;
- execution counters immediately before the first successful declaration;
- execution counters immediately before the final successful declaration.

Do not persist a full policy-transition history in SI v0.3.

Policy declaration calls themselves should not inflate execution exposure counters. The declaration-position counters describe how much non-policy execution had already occurred before the declaration took effect.

A later milestone may derive exposure ratios or attribution confidence. SI v0.3 stores the raw counters only; it must not compute or persist a `policyExposureScore`, success score, causal score, or reward.

#### Execution facts

Execution counters are Harness-owned telemetry derived from actual tool activity and existing Tool Effect/capability semantics, not from model-authored reflection.

Counters should distinguish at least:

- non-policy tool calls;
- project/git observations;
- consequential semantic/project calls;
- calls whose Tool Effect may mutate the project;
- verification-record calls;
- tool-result errors;
- calls denied by the live Execution Gateway.

`projectMutationEffectCalls` counts calls whose Tool Effect has a
`projectMutation` classification other than `none`. It describes Tool Effect
classification, not a confirmed filesystem or project mutation.

Do not infer semantic categories from assistant prose.

#### Outcome facts

Outcome is a factual snapshot at Run settlement. It may include current Task status, verification status, completion relation, blockers/questions presence, and Human Gate presence.

Do not persist claims such as:

```text
success: true
strategyWorked: true
quality: 9/10
```

unless a later Evaluation milestone defines those semantics from external evidence.

SI v0.3 does not introduce an LLM judge or self-reflection evaluator.

#### Run metrics

Reuse existing Run-scoped telemetry where available, especially Run duration and model-equivalent Run cost. Do not create a duplicate usage/cost accounting system for Experience.

#### Experience eligibility

Experience writing is fail-closed for dataset integrity.

A Run is eligible only when:

- it reaches the live `agent_settled` boundary;
- a project root is available;
- final semantic authority is coherent;
- a Task exists at settlement;
- the Run contains at least one non-policy tool execution.

Do not fabricate Experience for stale/unavailable authority or policy-only/no-action Runs.

A completed-before-run relation may be retained if the Run otherwise satisfies the factual eligibility contract; later Evaluation may decide whether such records are useful.

#### Persistence

Experience is durable learning data but is not `PindieState`.

New records use schemaVersion 2. Existing schemaVersion 1 records are
immutable historical data: leave them untouched, without rewriting, migration,
delete, or backward-compatible reader machinery.

Store one immutable record per eligible Run under the same per-project Pindie storage namespace, conceptually:

```text
~/.pindie/projects/<project-id>/
  state.json
  experience/
    <record-id>.json
    <record-id>.json
```

Prefer one record per file rather than concurrent append to a shared JSONL file. Use collision-resistant record identity and atomic local file creation/replacement semantics appropriate to the existing store design.

Experience must never be written into `state.json`, and State validation must not depend on Experience availability.

#### Settlement ordering

At `agent_settled`, freeze all Experience inputs before clearing Run-scoped policy/execution bookkeeping.

Conceptually:

```text
capture final semantic + policy + execution facts
finish/freeze duration and cost
assemble Run Experience
persist eligible Experience best-effort
clear Run-scoped bookkeeping
```

The exact code order may differ as long as the persisted record observes one coherent settled Run and no required v0.2 Policy data is cleared before capture.

#### Failure isolation

Experience collection must never become Task authority.

If Experience assembly or persistence fails:

- do not block or fail the Task;
- do not mark verification failed/stale;
- do not make semantic authority unavailable;
- do not open a Human Gate;
- do not alter Tool Surface or completion legality.

A local diagnostic may be emitted, but normal Pindie semantics remain unchanged. Losing one Experience record is preferable to corrupting Task truth.

#### One-way data flow

SI v0.3 only writes Experience:

```text
Run → Experience → disk
```

It does not read Experience back into future model context or Policy.

Therefore SI v0.3 still does not change future Policy from past Experience. It creates the trustworthy substrate required for later evaluation/adaptation.

#### SI v0.3 non-goals

Do not implement:

- Experience retrieval or context injection;
- raw transcript/session archival;
- model reasoning or reflection capture;
- task classification or difficulty scoring;
- Strategy success rates or rankings;
- reward functions;
- policy exposure/causal scores;
- LLM-as-judge evaluation;
- automatic Strategy selection;
- Strategy adaptation, mutation, derivation, or evolution;
- learned Skills;
- embeddings/vector databases;
- policy UI/history UI;
- reasoning-policy migration;
- a second Agent Loop.

The output of SI v0.3 is a durable factual dataset of `Run → Policy attribution facts → Execution facts → Outcome`, including runs with no declared Policy.

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

SI v0.1 uses Pi's append-only message path rather than rebuilding a context projection.

Current conceptual flow:

```text
stable Pindie System Contract
→ Run Baseline
→ conversation and causal Pindie tool/runtime updates
→ model
```

The Run Baseline contains the authoritative Task, verification, open-loop, Human Gate, authority, and unavailability facts at Run start. State-changing tool results and project-mutation updates append later facts at their causal location. Pi's normal compaction handles history growth.

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
