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

A schema v3 Run Experience contains only bounded factual data equivalent to:

```text
schemaVersion: 3
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
  finalPolicyDeclarationCount
  finalPolicyFirstDeclaredAfter | null
  finalPolicyLastDeclaredAfter | null

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

Schema-v3 records are accepted only when their bounded facts satisfy the deterministic invariants guaranteed by the normal Harness settlement path. Strategy IDs must resolve to the immutable Seed Strategy catalog with the required approach/modifier kinds and unique modifiers; accepted identities are canonicalized from that catalog. Execution and declaration-position counters must be non-negative safe integers, partition tool calls into observations and consequential calls, respect per-counter bounds, and remain monotonic at declaration positions. Policy declaration fields, Run-start facts, and completion/task-status relations are rejected when inconsistent. Impossible records are not repaired or clamped.

Do not store model reasoning, chain-of-thought, assistant reflection, raw transcript, raw tool results, full verification evidence, or arbitrary prose summaries in Experience.

#### Task facts

Do not introduce a task classifier, complexity score, or inferred task type in SI v0.3.

Use existing authoritative Task/Run facts. `runStart.taskStatus` and `runStart.taskGoal` describe the factual Task state and goal at the beginning of the Run; `runStart.taskGoal` is null when no Task existed then. `task.goal` is the goal of the Task associated with the coherent settlement snapshot, and `taskRelation` should come from current semantic Run facts rather than model interpretation. Run-start facts and settlement Task facts are different temporal observations and must not be conflated.

#### Policy attribution facts

Policy declaration remains model-owned and optional.

Runs with no Policy Snapshot are valid Experience and must not be discarded merely because no Strategy was declared. Otherwise the dataset would be biased toward runs that used explicit policy metadata.

For a Run with declarations, retain only:

- the final Snapshot;
- how many successful declarations occurred in total;
- how many successful declarations had the final Policy identity;
- counters immediately before the first successful declaration of the final Policy identity;
- counters immediately before the last successful declaration of the final Policy identity.

The final Policy identity is the normalized combination of one approach ID and the sorted unique modifier IDs. Reordering identical modifiers is the same identity. If the model changes Policy and later returns to an earlier identity, the final-Policy count and first/last positions describe that identity only. Do not persist a full Policy transition history or every intermediate Policy.

Policy declaration calls themselves should not inflate execution exposure counters. The declaration-position counters describe how much non-policy execution had already occurred before each declaration took effect. The runtime tracker may keep minimal Run-scoped aggregates needed to derive the final-Policy facts, but no Policy history is durable.

SI v0.3 stores the raw counters only; it must not compute or persist a `policyExposureScore`, success score, causal score, or reward.

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

New records use schemaVersion 3. Schema v1 and schema v2 records are
immutable historical data: leave them untouched and treat them as unsupported
history, without rewriting, migration, deletion, or a compatibility adapter.

Store one immutable record per eligible Run under the same per-project Pindie storage namespace, conceptually:

```text
~/.pindie/projects/<project-id>/
  state.json
  experience/
    <record-id>.json
    <record-id>.json
```

Prefer one record per file rather than concurrent append to a shared JSONL file. Use collision-resistant record identity and atomic local file creation/replacement semantics appropriate to the existing store design. The Reader consumes only committed canonical UUID `.json` files produced by the writer; temporary files, ordinary files, and directories are ignored rather than treated as Experience records.

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

The output of SI v0.3 is a durable schema-v3 factual dataset of `Run → final-Policy attribution facts → Execution facts → Outcome`, including runs with no declared Policy.

### SI v0.4 — Experience Evaluation

Goal: turn immutable schema-v3 Run Experience into reproducible derived evidence without scoring, judging, adapting, or feeding Evaluation back into the Agent.

Dogfood after SI v0.3 showed three important facts:

- explicit Policy can be declared before execution and remain meaningfully attributable;
- simple focused Runs may complete correctly with no explicit Policy at all;
- cost and outcome cannot be compared across unrelated Tasks as if Policy were the only variable.

Therefore SI v0.4 inserts a distinct Evaluation layer between Experience and future Adaptation:

```text
immutable Run Experience
        ↓
deterministic Evaluation
        ↓
derived evidence
        ↓
future adaptation
```

SI v0.4 still keeps:

```text
Policyₙ₊₁ = Policyₙ
```

It evaluates evidence only; it does not change Policy.

#### Raw Experience and derived Evaluation

Raw Experience remains the immutable factual source of truth for Self-Improvement history.

Evaluation is derived data:

- reproducible from source Experience;
- disposable and safe to recompute;
- non-authoritative;
- never written back into Experience;
- never allowed to change `PindieState`, Verification, capabilities, Human Gates, or Task legality.

If Evaluation semantics change later, recompute the derived result rather than rewriting historical Experience. The persisted Experience shape is unchanged by SI v0.4 and remains `schemaVersion: 3`.

#### Experience reading boundary

SI v0.4 may read the per-project Experience Store for evaluation purposes.

The first evaluator consumes only valid `schemaVersion: 3` records. Existing v1 and v2 canonical records are immutable unsupported historical data and should be skipped, not migrated, heuristically upgraded, or adapted through a compatibility layer.

The committed record boundary is a canonical lowercase UUID-v4 `.json` filename produced by the existing Node `randomUUID()` writer, matching `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx.json`. The Reader ignores temporary `.tmp` files, non-v4 UUID-looking names, ordinary non-canonical files, hidden/backup files, and directories. Within that boundary, malformed JSON or semantically invalid schema-v3 facts are invalid records; in-progress temporary files do not count as invalid.

Reading should distinguish at least:

```text
loaded schema-v3 records
unsupported schema records
invalid/unreadable records
```

An invalid or unsupported record must not corrupt valid evaluation input. The schema-v3 Reader/parser rejects deterministic cross-field inconsistencies rather than repairing them, including impossible execution subsets, declaration positions, final-Policy positions, Run-start/Task relationships, completion relationships, and settlement verification status. It does not infer a replacement Task goal or parse transcript/model prose.

Experience reading in SI v0.4 is for offline/derived evaluation only. It must not inject Experience into model context or current Policy.

#### Run Evaluation

Each valid Run Experience may be deterministically transformed into a bounded `RunEvaluation`.

Derived evidence may include values directly calculable from factual fields, such as:

```text
explicit final Policy Snapshot | null
declaration count
final-Policy declaration count
final-Policy first-declaration progress
final-Policy last-activation progress
continuous final-Policy exposure calls
continuous final-Policy exposure ratio
observation ratio
consequential-call ratio
tool-error ratio
denied-call ratio
verification passed | not passed
completed during Run | not completed during Run
finished with blockers/questions/Human Gate
duration
cost
source record identity
attribution eligibility
```

A `completed_before_run` Experience remains valid factual history and is included in evaluated Run accounting, but its settlement Task predates the Run. Its `RunEvaluation.attributionEligible` is therefore `false`; it is not Policy outcome evidence. Other valid schema-v3 Experiences are attribution-eligible. These values are derived measurements, not causal claims.

Continuous final-Policy exposure is derived from the counters immediately before the last successful declaration of the final Policy identity:

```text
T = execution.toolCalls
D = finalPolicyLastDeclaredAfter.toolCalls
finalPolicyExposureCalls = max(0, T - D)
finalPolicyExposureRatio = T > 0 ? finalPolicyExposureCalls / T : null
```

The first occurrence and last activation are distinct evidence. `finalPolicyFirstDeclaredAfter` yields first-declaration progress; `finalPolicyLastDeclaredAfter` yields last-activation progress and is the only basis for continuous final-Policy exposure. A final Policy declared after most execution should therefore have low exposure rather than being treated as if it guided the whole Run. Invalid source facts are rejected by the Reader/parser instead of being silently normalized or clamped.

Runs with `finalSnapshot: null` remain valid Evaluation input. `null` means no explicit Strategy declaration; it is not missing data and must not be replaced with a fabricated `default` Strategy. A `completed_before_run` Run remains visible as evaluated, but is excluded from Policy Evidence Profiles and comparable cohorts, including all of its verification, completion, error, denial, cost, duration, and exposure evidence.

#### Outcome interpretation boundary

SI v0.4 may derive independent outcome indicators from factual Experience, for example whether Verification passed or whether the Task completed during the Run.

It must not collapse those facts into an invented global judgment such as:

```text
successScore
qualityScore
strategyWorked
```

A passed verification check is evidence about the Run outcome. It is not proof that the declared Strategy caused that outcome or is globally superior.

#### Task comparability

Policy evidence is meaningful only when the underlying Runs are sufficiently comparable.

SI v0.4 must not introduce a heuristic or LLM-based Task classifier merely to create larger cohorts.

The first implementation should make comparative claims only under a strict factual cohort boundary, such as:

```text
same project
+
exact same settlement task.goal
```

Runs outside an explicitly supported comparable cohort may still be evaluated individually and included in evidence inventories, but they must not be used to claim that one Strategy outperforms another. Policy Evidence Profiles and exact-goal comparable cohorts consume only attribution-eligible Runs.

Sparse comparable evidence is preferable to false comparability.

Semantic similarity, task taxonomy, task difficulty, or learned task representation may be considered later only if real evidence shows they are necessary.

#### Policy Evidence Profile

Run Evaluations may be aggregated into a bounded Policy Evidence Profile. Only attribution-eligible Run Evaluations enter a Profile; evaluated but non-attributable Runs remain in the evaluation inventory without contributing profile evidence.

A Profile is an evidence inventory, not a Strategy score or ranking.

It may summarize factual/derived quantities such as:

```text
attributed Run count
no-explicit-policy Run count
successful declarationCount distribution per Run
finalPolicyDeclarationCount distribution per Run
final-Policy first-declaration progress distribution
final-Policy last-activation progress distribution
continuous final-Policy exposure calls/ratio distribution
verification outcome counts
completion outcome counts
tool error / denial counts
duration and cost observations
source Experience references
```

`/experience` reports Loaded schema-v3 records, Evaluated Runs, Attributable Runs, and Non-attributable Runs, then exposes these bounded attribution facts compactly for each rendered profile. Profiles and exact-goal cohorts consume attributable Runs only. They let a human distinguish early declaration, Policy changes, late final activation, and little continuous final-Policy exposure without introducing an attribution, confidence, effectiveness, reward, or causal score. No-explicit-policy profiles retain `n/a` for position and exposure fields that do not apply. Profiles preserve enough provenance to trace every aggregate back to source Experience records; presentation shows at most five source IDs per profile and ten profiles while Evaluation retains full provenance.

Do not emit claims such as:

```text
explore-first score = 87
architecture-first > explore-first
Strategy X caused success
```

without a later milestone defining and validating much stronger evaluation semantics.

#### Persistence and execution model

SI v0.4 Evaluation is recomputable derived state.

The first implementation should evaluate on demand from Experience rather than introduce a second persistent analytics database, evaluation cache, background daemon, or settlement-time evaluation pipeline.

Conceptually:

```text
Experience Store
      ↓
read on demand
      ↓
RunEvaluation[]
      ↓
Evidence Profile
```

Evaluation belongs to the Self-Improvement slow/offline path. It must not become part of Pi's fast `model → action → feedback` loop or block normal Agent Run settlement.

#### Failure isolation

Evaluation failure is not Task failure.

Malformed input, unsupported schema, arithmetic edge cases, or Evaluation/reporting failure must not:

- mutate or invalidate Experience;
- change `PindieState`;
- affect Verification freshness/status;
- change capabilities or Tool Surface;
- open a Human Gate;
- affect Task completion legality;
- change current Policy.

#### SI v0.4 non-goals

Do not implement:

- Strategy adaptation or mutation;
- Strategy generation or derivation;
- Strategy ranking or a single effectiveness score;
- reward functions;
- causal-effect estimation;
- LLM-as-judge evaluation;
- automatic Strategy selection;
- task taxonomy/classification;
- semantic task similarity or embeddings;
- vector databases;
- Experience injection into model context;
- Evaluation injection into model context;
- persistent analytics/evaluation databases;
- settlement-time/background evaluation loops;
- policy status/evaluation UI unless separately justified;
- reasoning-policy migration;
- a second Agent Loop.

The output of SI v0.4 is reproducible schema-v3 derived evidence that makes future Strategy adaptation more defensible without yet changing how the Agent acts.

### SI v0.5 — Strategy Adaptation Candidate

Goal: let Pindie use trustworthy, attributable SI v0.4 evidence to propose project-local revisions of existing Seed Strategies without changing the active policy.

SI v0.5 is the first milestone that may create a Self-Improvement artifact from prior Experience. It still does not treat that artifact as trusted policy.

The relation is:

```text
immutable schema-v3 Experience
        ↓
deterministic SI v0.4 Evaluation
        ↓
attributable evidence
        ↓
explicit adaptation request
        ↓
bounded Adaptation Packet
        ↓
current model reasons within Pi's existing loop
        ↓
Strategy Revision Candidate
        ↓
immutable project-local Candidate Store

        X

not active Policy
```

The `X` is a hard SI v0.5 boundary: creating a Candidate must not alter the Seed catalog, current Run Policy, future normal coding context, or Experience semantics.

#### Strategy identity and revision are different

Before strategies become mutable, a Strategy ID can appear to identify both the strategy and its semantics. That stops being safe as soon as revisions exist.

From SI v0.5 onward, treat these concepts separately:

```text
Strategy identity
  architecture-first

Strategy revision
  immutable human Seed semantics
  candidate revision A
  candidate revision B
  ...
```

The immutable Seed Strategy remains the trusted root revision. A Candidate is a proposed revision of that root, not a replacement written over it.

SI v0.5 does not activate Candidate revisions, so schema-v3 Run Experience remains valid and continues to record only Seed Strategy identities. Revision identity enters Run Experience only when a later milestone actually allows a non-Seed revision to guide an Agent Run.

#### Seed as immutable baseline

`SEED_STRATEGIES` remains immutable human-validated policy.

SI v0.5 must not edit, overwrite, regenerate, or persist mutations back into the Seed catalog.

Every Candidate targets exactly one existing Seed Strategy and retains:

```text
same strategy id
same strategy kind
```

The Candidate may propose changed advisory semantics such as:

```text
summary
useWhen[]
avoidWhen[]
principles[]
```

It may not change identity or kind. Creating a new Strategy identity belongs to the later Strategy Derivation milestone.

A deterministic fingerprint of the target Seed semantics should bind the Candidate to the exact immutable baseline it was proposed against. A future change to human Seed semantics must therefore be distinguishable from an older Candidate's base.

#### Strategy Revision Candidate

A Candidate is an immutable, bounded, project-local hypothesis artifact conceptually equivalent to:

```text
schemaVersion
candidateId
createdAt

target
  strategyId
  kind
  baseFingerprint

proposal
  summary
  useWhen[]
  avoidWhen[]
  principles[]

evidence
  sourceRecordIds[]

hypothesis
```

The exact internal TypeScript shape may differ, but the artifact should stay compact and auditable.

`hypothesis` explains what repeated evidence suggests may be improved and what the revision is intended to change. It is model-authored proposal text, not factual Experience and not proof that the Candidate is better.

Do not persist chain-of-thought, hidden reasoning, full transcripts, raw tool outputs, or an open-ended reflection log in a Candidate.

#### Evidence-backed proposal boundary

Candidate creation must fail closed on provenance.

At minimum:

- the target Strategy exists in the immutable Seed catalog;
- the Candidate preserves the target Strategy ID and kind;
- the Candidate is bound to the current target Seed fingerprint;
- at least two distinct source Experience records are cited;
- every cited Experience is a valid current schema-v3 record;
- every cited Run Evaluation is attribution-eligible;
- every cited Run's explicit final Policy actually contains the target Strategy in the correct role;
- source records belong to the current project;
- the proposed semantics differ meaningfully at the structural/text level from the Seed baseline;
- all candidate fields remain bounded and structurally valid.

For an approach target, the cited Run's final approach must equal the target. For a modifier target, the cited Run's final modifiers must contain the target.

SI v0.5 does not require exact-goal cohorts. Exact-goal cohorts support stricter comparative claims; adaptation Candidates are explicitly hypotheses and may be proposed from repeated attributable patterns across different Tasks. Sparse or heterogeneous evidence must remain visible rather than being converted into a false claim of superiority.

The Harness validates structure and provenance. It does not decide that a proposed principle is intellectually correct or that the Candidate is an improvement.

#### Explicit slow-path entry

Adaptation must never happen ambiently during ordinary development work.

A Candidate may be proposed only through an explicit Self-Improvement adaptation entry chosen by the user/operator. The exact UI/tool integration should remain minimal, but the semantics are:

```text
explicit target Strategy
        ↓
read current-project attributable evidence on demand
        ↓
build bounded Adaptation Packet
        ↓
make that packet available only to the explicitly entered adaptation work
        ↓
current model proposes a Candidate
```

Do not run adaptation:

- automatically at `agent_settled`;
- automatically after `/experience`;
- on a timer or background daemon;
- because one Run succeeded or failed;
- merely because the model notices an interesting pattern during a normal Task.

The model may perform the reasoning, but it must reuse Pi's existing model/Agent loop rather than create a dedicated evaluator, router, policy Agent, or second inference loop.

#### Adaptation Packet

The model should not receive the entire Experience archive.

Explicit adaptation should expose a bounded packet for one target Strategy containing only the information needed to propose a revision, for example:

```text
target Seed Strategy semantics
Seed fingerprint
bounded attributable source records / provenance
relevant SI v0.4 derived evidence
clear evidence-only / hypothesis boundary
```

The packet may summarize deterministic Evaluation facts and preserve source record IDs for auditability. It must not include hidden reasoning or fabricate task similarity, quality, causal effect, or Strategy ranking.

Normal coding Runs must not receive Adaptation Packets, Candidate data, or historical Evaluation simply because SI v0.5 exists.

#### Candidate persistence

Candidates are Self-Improvement artifacts, not `PindieState`.

Persist one immutable Candidate per file under the current project's Pindie storage namespace, conceptually:

```text
~/.pindie/projects/<project-id>/
  state.json
  experience/
    ...
  strategy-candidates/
    <candidate-id>.json
```

Candidate persistence must not affect State validation, Task authority, Verification, capabilities, Human Gates, Tool Surface, or normal Task completion.

A Candidate file is append-only historical evidence of a proposal. SI v0.5 does not mutate Candidate status, overwrite an older Candidate, or maintain a mutable active-strategy database.

#### Candidate is not active policy

SI v0.5 ends at Candidate creation.

A Candidate must not:

- appear in the normal Seed Strategy catalog;
- become selectable by `pindie_policy_set`;
- alter `PolicySnapshot` identity;
- be injected into ordinary Run context;
- change current or future default behavior;
- modify Experience schemaVersion 3;
- receive automatic promotion, rejection, ranking, or trial assignment.

Therefore normal policy behavior after Candidate creation is still based on the immutable Seed portfolio.

Conceptually:

```text
Evidence → Candidate
```

but not yet:

```text
Candidate → active Policy
```

#### Authority boundary

Candidate semantics remain weaker than deterministic Environment truth.

Even a future activated revision must never grant/revoke capabilities, bypass the Gateway, redefine success criteria, fabricate Verification, resolve Human Gates, mutate `PindieState` merely by selection, or alter Pi's low-level Agent Loop.

SI v0.5 itself never activates a Candidate, so these invariants remain unchanged in runtime behavior.

#### SI v0.5 non-goals

Do not implement:

- Candidate activation or trial use;
- Seed Strategy mutation;
- active Strategy revision selection;
- Experience schema v4 or revision-aware Run attribution;
- promotion/rejection/demotion lifecycle;
- Strategy scoring/ranking or a global reward;
- causal-effect estimation;
- automatic adaptation triggers;
- task taxonomy/classification or semantic similarity;
- embeddings/vector databases;
- new Strategy IDs;
- Strategy derivation;
- portfolio merge/split/retirement;
- learned Skills;
- a dedicated policy/evaluator Agent;
- a second Agent Loop.

The output of SI v0.5 is an auditable set of evidence-backed Strategy Revision Candidates that can be inspected before any revision is allowed to influence execution.

### SI v0.6 — Candidate Trial & Promotion

The authoritative SI v0.6 contract is maintained in [`docs/self-improvement-v0.6.md`](./self-improvement-v0.6.md). Its directional goal is to allow an explicitly chosen Candidate revision to enter controlled Agent Runs, record revision-aware Experience, compare its evidence against the Seed baseline where defensible, and support an auditable promote/reject decision without silently replacing policy. Slice B implements only the explicit Candidate Trial entry and Run-scoped attribution substrate; Trial evaluation and promotion remain later slices.

SI v0.6 is implemented in explicit slices. The current Slice A substrate provides:

- deterministic derived semantic fingerprints for immutable schema-v1 Candidate artifacts;
- revision-aware Policy identity and canonical schema-v4 Policy serialization;
- backward-compatible Seed-only `pindie_policy_set` declarations;
- schema-v3 historical Experience reading plus schema-v4 writing and deterministic Evaluation normalization; and
- Seed-only `/adapt` evidence selection across v3/v4 records, excluding non-Seed revision attribution.

Slice B now additionally provides a strict project-local Candidate read by ID, a runtime-only one-Run Trial lease, a bounded Trial Packet, and exact Candidate revision selection only under the active lease. Trial Runs remain ordinary schema-v4 Experience Runs and require explicit Candidate Policy declaration for attribution.

Slice A/B intentionally do not implement Trial evaluation, promotion/rejection, automatic Policy selection, or other later slices. Existing schema-v3 Experience/Candidate artifacts remain immutable and are never migrated or rewritten.

### SI v0.7 — Strategy Derivation

Directional goal: allow a genuinely new Strategy identity to emerge from repeated useful patterns when evidence shows that revising an existing Seed Strategy is no longer the right abstraction.

A derived Strategy must enter the same candidate/trial/evaluation path before becoming trusted policy. Detailed derivation semantics remain intentionally unspecified until Candidate Trial produces real revision evidence.

### Later direction — Strategy Portfolio Evolution

Prevent accumulated Seed, promoted, and derived revisions from becoming policy debt.

Possible portfolio operations may eventually include promote, demote, merge, split, retire, archive, or rebase, but the actual lifecycle must be designed from real mutable-policy evidence rather than treated as a fixed implementation contract now.

### Later direction — Contextual Policy

A later direction may move from choosing named strategies toward a context-sensitive cognitive policy:

```text
P(policy | task, environment, history, outcomes)
```

Named strategies can remain useful interpretable priors while the policy layer learns which combinations and execution parameters work best under different contexts.

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