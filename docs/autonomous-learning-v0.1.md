# Pindie Autonomous Learning Loop v0.1 — Architecture Boundary

Status: approved architecture contract; Slices A–D implemented (Slice E dogfood closure remains).

This document defines the next Self-Improvement boundary after the frozen SI v0.7 and Cross-Project Learning v0.2 contracts. It does not rewrite those contracts or reinterpret their historical artifacts.

The core principle is:

> Experience may be forgotten. Trusted Strategy is durable cognition and must stay bounded, portable, and continuously refinable.

The v0.1 goal is narrower than “self-modifying Agent”. It is to move Pindie from a command-driven learning admission model toward bounded Agent-initiated learning while keeping trust, authority, runtime ownership, and primary-task priority intact.

## 1. Exact goal

Today the learning lifecycle begins only after an explicit Human command:

```text
normal work
    ↓
Human notices a learning opportunity
    ↓
/adapt | /derive | /derive-global
    ↓
existing Candidate / Trial / Review / Human trust lifecycle
```

Autonomous Learning v0.1 changes only the admission boundary:

```text
normal Agent work
    ↓
Model recognizes a possible reusable learning opportunity
    ↓
Learning Opportunity Signal
    ↓
Harness Learning Opportunity Gate
    ↓
if admissible:
one existing bounded learning slow path starts automatically
    ↓
existing immutable Candidate lifecycle
    ↓
explicit Trial / Review / Human trust remains unchanged
```

v0.1 therefore removes the Human requirement to notice and manually start every learning opportunity. It does **not** remove the Human trust boundary.

This is a **v0.1 staging boundary, not the long-term ownership model**. The intended end state is a fully autonomous learning loop in which ordinary learning requires no Human participation:

```text
normal work
→ detect learning opportunity
→ derive / revise hypothesis
→ choose and run bounded Trials
→ evaluate evidence
→ promote / reject / refine
→ update the trusted Strategy portfolio
→ continue normal work
```

Human authority in that end state moves upward: the Human defines goals, safety/authority limits, resource budgets, and exceptional override boundaries, but does not manually operate routine Candidate, Trial, Review, or trust transitions. Later milestones must therefore remove the remaining Human gates only when equivalent bounded evidence, rollback, and trust-safety contracts exist. v0.1 intentionally does not fake that safety before those contracts have been dogfooded.

Success means that a real normal Task can produce a useful inactive Strategy Candidate without the Human issuing `/adapt`, `/derive`, or `/derive-global`, while ordinary project work remains primary and unaffected when learning is unnecessary or fails.

## 2. Non-goals

v0.1 must not add:

- a second Agent Loop, evaluator Agent, planner framework, workflow engine, background daemon, task queue, or learning scheduler;
- automatic Strategy promotion or rejection;
- autonomous Candidate Trial selection;
- autonomous trust transfer;
- model-written Experience files or Strategy files;
- semantic scoring, rewards, embeddings, nearest-neighbor search, learned task taxonomies, or Strategy ranking;
- a generic memory database;
- a mutable “current Strategy table” that replaces immutable trust provenance;
- model-weight updates or fine-tuning;
- a remote/cloud Strategy backend as a prerequisite for learning;
- general merge/consolidation semantics for multiple trusted Strategy identities;
- general revision of already-promoted Derived or user-global Strategies.

Those may be considered only after v0.1 dogfood demonstrates a concrete need.

## 3. Stable authority boundary

Autonomous admission changes who may *start* learning. It does not change who owns facts, meaning, execution, or trust.

```text
Human
  → owns goals, taste, final consequential judgment
  → still owns /promote and /reject
  → may still use all existing explicit learning commands

Model
  → interprets Task meaning
  → may recognize one reusable learning opportunity during normal work
  → chooses the semantic learning intent:
      revise-existing | derive-local | derive-global
  → never declares evidence sufficient
  → never grants trust

Pindie Harness
  → owns eligible Experience facts and exact Strategy identities
  → owns admission legality, evidence sufficiency, deduplication, capacity,
    runtime lease, provenance, and safe scheduling
  → may start one existing learning slow path after the normal Run settles
  → keeps Strategy cognition bounded
  → owns Experience retention / protection / pruning rules

Pi
  → owns model invocation, Agent Run, tools, Sessions, retries, compaction,
    Skills, and the low-level LLM → Tool → Result → LLM loop
```

The existing rule remains:

> Harness owns facts; model owns meaning; Human owns trust.

## 4. Learning Opportunity Gate

### 4.1 Why the Gate exists

Autonomous Learning must be selective. The failure mode to avoid is:

```text
every Run
→ reflection
→ memory
→ Strategy growth
→ more context
→ more reflection
```

Therefore v0.1 does not automatically “reflect after every Task”. It introduces one sparse semantic signal plus a deterministic Harness gate.

### 4.2 Model-facing signal

Normal Runs may expose one narrow non-project-mutating semantic action:

```text
pindie_learning_signal
```

Conceptually the model may supply only:

```text
intent:
  revise-existing | derive-local | derive-global

targetStrategyId?
  required only for revise-existing

reason
  bounded semantic explanation of the reusable learning opportunity
```

The model must not submit:

- Experience IDs;
- project IDs;
- portfolio fingerprints;
- Candidate IDs;
- evidence counts;
- trust status;
- promotion eligibility;
- scheduling or retry instructions.

Those are Harness-owned facts.

At most one successful learning signal is accepted per ordinary Run. A Run with no genuinely reusable opportunity should emit no signal. The static contract must explicitly say that silence is normal.

The signal itself is runtime-only. It is not `PindieState`, Experience, Work Memory, Strategy, or a durable queue item.

### 4.3 Deterministic admission

After the source Run settles, the Harness may admit the signal only if all required facts hold.

Common requirements:

1. the source Run is an ordinary normal-use Run, not a Self-Improvement or Candidate Trial Run;
2. project authority is coherent;
3. Pi is safely idle before the learning Run begins;
4. no learning slow path or Candidate Trial lease is pending/active;
5. the relevant existing primitive's own evidence-sufficiency and trust-safety checks pass unchanged;
6. the exact evidence/portfolio state has not already produced the same autonomous assessment outcome;
7. learned-Strategy capacity is not exceeded for a new-identity derivation;
8. feature dependencies are selected: local SI for local learning, SI + CPL for global synthesis;
9. user work has priority: fresh Human input before autonomous start cancels that runtime opportunity.

The Gate does not invent a second semantic quality metric. It only asks whether the exact existing learning primitive is legal and sufficiently grounded to run.

### 4.4 Intent mapping

```text
revise-existing
  → existing SI adaptation preparation
  → exact currently trusted Seed target only in v0.1
  → existing StrategyRevisionCandidateV1 lifecycle

derive-local
  → existing SI v0.7 derivation preparation
  → existing StrategyDerivationCandidateV1 lifecycle

derive-global
  → existing CPL v0.2 synthesis preparation
  → existing StrategySynthesisCandidateV1 lifecycle
```

v0.1 does not autonomously initiate Trust Transfer because Trust Transfer is a scope decision about an already-trusted exact Strategy, not discovery of a new learning opportunity.

### 4.5 Reuse existing slow paths

The explicit commands remain valid and unchanged:

```text
/adapt
/derive
/derive-global
```

Implementation should extract only the smallest shared admission primitive needed so command-origin and autonomous-origin requests converge on the same packet builders, leases, capabilities, validation, and immutable Candidate writers.

Conceptually:

```ts
type LearningAdmissionOrigin = "human-command" | "autonomous-signal";
```

This origin is runtime control provenance, not Strategy semantics and not a reason to create new Candidate schemas.

### 4.6 No persistent learning queue

If an opportunity cannot start because new Human work arrived, Session ownership changed, or the runtime is no longer safe, v0.1 drops the runtime opportunity.

It must not create:

- pending learning JSON;
- a background retry daemon;
- a durable job queue;
- a hidden Task;
- a workflow phase in `PindieState`.

Future ordinary Runs may independently identify the opportunity again.

### 4.7 Deduplication

Autonomy must not repeatedly spend model calls on the same unchanged evidence.

The Harness derives an assessment identity from factual inputs, conceptually:

```text
intent
+ exact target Strategy identity when present
+ source evidence packet fingerprint
+ trusted portfolio fingerprint
```

A bounded learning-assessment receipt may remember only that the exact identity already settled as:

```text
candidate-created | no-candidate
```

This receipt:

- is operational deduplication metadata, not cognition;
- is not `PindieState`;
- grants no trust;
- contains no transcript or hidden reasoning;
- is bounded and may discard old entries.

A changed evidence packet or changed trusted portfolio produces a new assessment identity.

## 5. Strategy Portfolio — durable cognition

### 5.1 Strategy, not Experience, is long-lived cognition

Pindie should distinguish:

```text
Experience
  = episodic evidence
  = high volume
  = replaceable / forgettable

Trusted Strategy
  = reusable cognition / policy
  = low volume
  = human-trusted
  = bounded
  = durable across projects, Sessions, models, and host migration
```

Long-term learning quality is not “number of Strategies created”. A healthy system may process more Experience while keeping the trusted portfolio the same size or making individual Strategy semantics sharper.

### 5.2 Ownership is not physical storage

“Harness-owned Strategy” does not mean bytes exist magically inside the Agent process. Durable cognition must still be persisted somewhere.

The architecture requirement is:

> Filesystem paths and file layout must not be the semantic API of Strategy cognition.

Introduce a narrow persistence boundary, conceptually:

```ts
interface StrategyKnowledgeStore {
  readProjectTrust(projectId: string): Promise<...>;
  readGlobalTrust(): Promise<...>;

  readCandidate(...): Promise<...>;
  writeCandidate(...): Promise<...>;

  readDecision(...): Promise<...>;
  writeDecision(...): Promise<...>;

  readAssessmentReceipts(...): Promise<...>;
  writeAssessmentReceipt(...): Promise<...>;

  exportSnapshot(): Promise<StrategyKnowledgeSnapshotV1>;
  importSnapshot(snapshot: StrategyKnowledgeSnapshotV1): Promise<void>;
}
```

Exact methods should stay narrower than this sketch and follow existing artifact families. Do not build a generic repository framework.

Existing `FileStrategy*` implementations may remain as the first adapter. The important v0.1 inversion is that domain/runtime logic depends on the Strategy knowledge boundary rather than on `~/.pindie/.../*.json` path semantics.

This solves ownership and migration coupling without pretending local persistence is inherently lossless.

### 5.3 Portable cognition snapshot

v0.1 should define one versioned portable snapshot of Strategy cognition only:

```text
StrategyKnowledgeSnapshotV1

- immutable Strategy Candidate artifacts
- immutable Strategy Decision artifacts
- user-global trust artifacts
- exact schema/version metadata
- integrity fingerprints
- no operational assessment receipts in Slice A (Slice C may provide separately portable bounded dedupe metadata without granting trust)
```

It must exclude:

- Run Experience;
- Session transcripts;
- Task State;
- Work Memory;
- raw tool evidence;
- secrets and provider credentials.

Export/import is for backup and host migration. Import validates all immutable bindings and fails closed on collision or malformed provenance.

Remote replication/sync is intentionally a later storage-adapter concern. v0.1 must not couple Autonomous Learning correctness to a new cloud service.

### 5.4 Bounded learned cognition

The current implementation already has conservative limits:

```text
project-local promoted Derived identities <= 8
user-global promoted Derived identities   <= 8
```

Autonomous Learning v0.1 keeps these bounds rather than increasing them.

Seed Strategies are the fixed base and do not consume the learned-identity budget. Seed revisions keep the same logical identity and therefore do not grow identity count.

When a learned-identity budget is full:

- autonomous new-identity derivation fails closed;
- Pindie may still revise a legal existing Seed through the existing adaptation path;
- Pindie must not silently evict or replace trusted cognition;
- v0.1 does not invent automatic consolidation.

This deliberately creates pressure toward refinement rather than unbounded Strategy accumulation.

### 5.5 Refinement boundary

The long-term direction is:

```text
Experience growth
    ↓
distillation
    ↓
small trusted Strategy portfolio
    ↓
revision / supersession / consolidation
    ↓
small trusted Strategy portfolio
```

However, v0.1 does not generalize Strategy revision beyond the already-supported Seed adaptation contract. Promoted Derived and user-global Strategies remain frozen exact revisions.

General refinement of any trusted Strategy, semantic merge of several Strategies, and supersession at full capacity require a new trust contract and should be designed only after autonomous admission is dogfooded.

This is a deliberate scope limit, not the desired final state.

## 6. Experience Lifecycle — evidence that may be forgotten

### 6.1 Experience is not memory authority

Run Experience remains factual historical evidence used for:

- adaptation / derivation / synthesis sufficiency;
- Trial attribution and review;
- debugging Self-Improvement provenance.

It must not become a permanent personal-memory archive.

Trusted Strategy semantics and immutable Human Decisions must remain valid without requiring indefinite retention of every old ordinary Run.

### 6.2 Lifecycle

v0.1 defines four conceptual states without persisting a new phase field:

```text
live
  valid Experience currently available for learning/evaluation

protected
  old Experience temporarily retained because an unresolved learning artifact
  still requires exact source revalidation

expired
  outside retention budget and not protected

pruned
  physically removed from the Experience Store
```

These are derived storage states, not `PindieState`.

### 6.3 Deterministic retention

Use a simple bounded policy rather than model-authored importance scores.

Initial v0.1 policy:

```text
keep newest 256 valid ordinary Experience records per project
+ keep any older record that is still protected
```

The number is an implementation constant, not semantic truth, and may be changed by later dogfood if the bounded discovery windows prove too small or unnecessarily large. Schema-v4 permits non-ISO `recordedAt` strings, so maintenance fails closed rather than guessing their chronological order; newly written records use canonical ISO instants.

Pruning runs opportunistically after Experience persistence or at project-store maintenance boundaries. It is not a timer, daemon, or background worker.

### 6.4 Protection rules

An old Experience record is protected only when an unresolved artifact still needs the exact record for current validation.

Conservatively, protection includes source/Trial evidence required by:

- an inactive local Revision Candidate that has not received a final Human Decision;
- an inactive local Derivation Candidate whose frozen contract still revalidates source Experience;
- an active/incomplete Trial lifecycle whose review requires exact Trial Experience.

Where an existing frozen contract explicitly states that old discovery Experience may disappear without invalidating a Candidate, v0.1 must preserve that rule and not add fake retention authority.

Once immutable artifacts and final Human Decisions are sufficient under the relevant frozen contract, ordinary source Experience may expire.

### 6.5 No semantic forgetting model

v0.1 must not ask the model:

- which Experience is “important”;
- what to forget;
- how to score memory strength;
- whether to compress old Runs into prose summaries.

Forgetting is deterministic retention of factual evidence. Learning is the semantic distillation into Strategy.

## 7. Primary-work priority and failure semantics

Autonomous Learning is never on the critical path of normal project work.

```text
normal Run completes
    ↓
learning signal absent
    → nothing happens

learning signal present but Gate rejects
    → nothing user-visible happens

Gate admits, autonomous slow path succeeds
    → zero or one existing immutable Candidate is created
    → bounded user-visible notice may be shown

autonomous slow path concludes “no candidate”
    → record dedupe receipt
    → remain quiet

learning preparation/runtime/store fails
    → bounded diagnostic
    → no Task truth change
    → no trust change
    → normal project work remains usable
```

Fresh Human input always outranks autonomous learning before the autonomous Run begins.

Autonomous learning must never delay Task completion, mutate Verification truth, resolve a Human Gate, change project authority, or consume reset/fallback authority on its own.

## 8. Human attention contract

The purpose of autonomy is to reduce Human monitoring, not create a new notification stream.

Normal non-events remain silent.

v0.1 may surface only materially actionable learning events:

- a new inactive Candidate was created autonomously;
- an explicit existing Trial/review flow now needs Human action;
- learned-Strategy capacity blocks a genuinely new identity and Human portfolio judgment is required.

Do not notify for:

- every learning signal;
- Gate rejection;
- no-candidate conclusions;
- Experience pruning;
- dedupe receipt writes.

## 9. Compatibility with frozen SI / CPL contracts

SI v0.7 and CPL v0.2 remain historical authoritative contracts for their artifact semantics.

Autonomous Learning v0.1 extends admission around them:

```text
old:
Human command
→ existing preparation / lease / Candidate writer

new:
Human command OR admitted autonomous signal
→ same existing preparation / lease / Candidate writer
```

The following remain unchanged in v0.1:

- Candidate schemas and semantic fingerprints;
- Trial attribution rules;
- Trial review evidence rules;
- Human `/promote` / `/reject`;
- immutable trust decisions;
- project-local versus user-global trust meaning;
- user-global Trust Transfer semantics;
- existing Strategy capacity constants;
- Pi ownership of the low-level Agent Loop.

If an implementation requires changing one of those, that change is outside this v0.1 contract and must be designed explicitly instead of hidden inside Autonomous Learning.

## 10. Implementation slices

### Slice A — Durable Cognition Boundary

Goal: make Strategy cognition Harness-owned rather than path-owned without changing trust behavior.

- introduce the narrow Strategy knowledge persistence boundary;
- adapt existing File-based stores behind it;
- preserve all current candidate/decision validation and portfolio reconstruction;
- add versioned Strategy cognition export/import; the first File adapter publishes a validated snapshot into a fresh, isolated host-migration namespace only, never merges into an existing `~/.pindie` tree;
- bounded assessment receipts are operational deduplication metadata for Slice C, not durable Strategy cognition in the Slice A snapshot;
- prove current SI/CPL behavior is byte-for-byte semantically unchanged.

No autonomy and no Experience deletion yet.

### Slice B — Experience Lifecycle

Goal: make Experience explicitly forgettable and bounded.

- implement newest-256 live retention per project;
- derive protection from unresolved artifact requirements;
- prune only unprotected expired Experience;
- prove trusted Strategy / Decision validity does not depend on deleted ordinary history;
- prove frozen contracts that require source revalidation remain protected.

No semantic summarizer and no background GC.

### Slice C — Learning Opportunity Gate

Implemented: one runtime-only signal per ordinary Run, evaluated read-only after ordinary Experience persistence and Core settlement. Exact factual identities check bounded terminal receipts; no receipt is written on admission. Gate outcomes are internal diagnostics only; Slice D admits safe opportunities after this Gate.

Goal: let a normal Agent Run identify one possible learning opportunity without starting learning yet.

- add `pindie_learning_signal`;
- add capability / Tool Effect as non-project-mutating semantic control;
- enforce one signal per ordinary Run;
- derive exact admissibility facts after settlement;
- add bounded assessment deduplication;
- initially expose Gate decisions in focused tests / diagnostics only.

No automatic Candidate Run yet.

### Slice D — Autonomous Learning Admission

Implemented: admitted opportunities use the existing explicit-command preparation, lease, packet and Candidate tool paths. One native Pi Run may start after settlement and a fresh idle/Session check; runtime origin and exact Candidate tool-result identity remain ephemeral. Completed outcomes write bounded atomic terminal receipts only after exact Candidate revalidation (or normal no-Candidate settlement). Unsafe opportunities silently drop; Trial and trust remain explicit.

Goal: remove the Human command requirement for the first learning step.

- map admitted signals to existing adapt / local derive / global derive preparation;
- reuse the same packet builders, leases, capability narrowing, Candidate writers, and failure semantics;
- schedule at most one native Pi learning Run after safe settlement;
- cancel when fresh Human work wins;
- leave Trial / Review / Human trust explicit.

This Slice is the actual command-driven → autonomous-learning transition.

### Slice E — Dogfood Closure

Dogfood correction (in progress): ordinary Runs #208 and #210 completed without signaling. A successful `pindie_task_complete` during the current ordinary Run now carries a bounded, model-facing, optional learning checkpoint in its normal tool result; the Run-start policy clarifies that the model recognizes a plausible Strategy-level pattern while the Harness decides evidence sufficiency. Neither surface creates a signal, Candidate, receipt, notification, or extra Run. Slow-path and completed-before-run discussion Runs do not receive the checkpoint. This does not complete Slice E dogfood validation.

Goal: prove the feature reduces Human meta-work without causing learning noise.

Required real dogfood:

```text
normal Pindie development Task
→ no explicit /adapt | /derive | /derive-global
→ model emits a justified learning signal
→ Harness Gate admits it
→ autonomous learning Run starts
→ zero or one existing-schema Candidate is produced
→ ordinary Task truth remains unchanged
→ Candidate is then handled by the existing explicit Trial / Review / Human trust flow
```

Also prove negative behavior:

- several ordinary Runs produce no learning action;
- repeated identical evidence does not retrigger the same autonomous assessment;
- user input preempts a pending autonomous start;
- at capacity, autonomous derivation fails closed;
- Experience pruning cannot invalidate protected unresolved learning evidence;
- restart does not create a durable hidden learning job.

Only after this dogfood should Pindie consider Autonomous Trials or generalized Strategy refinement.

## 11. Future boundary after v0.1

The long-term target is **fully autonomous learning with no routine Human participation**. The following are deferred stages toward that target, not optional permanent Human workflows:

The next questions are intentionally deferred:

1. **Autonomous Trial Selection**  
   Can Pindie safely decide when a real Task is a suitable Candidate Trial without polluting normal work?

2. **General Strategy Refinement**  
   Can any trusted exact revision — Seed, Derived, or user-global — produce a same-identity refined revision under one unified but still auditable trust contract?

3. **Portfolio Consolidation / Supersession**  
   When the learned identity budget is full, can two overlapping Strategies be merged or one safely retired without losing useful cognition?

4. **Remote Strategy Store / Sync**  
   Once the StrategyKnowledgeStore boundary is stable, does host-loss resilience justify a remote canonical adapter or replication layer?

Those are separate because combining autonomous triggering, automatic experimentation, new trust semantics, portfolio consolidation, and remote persistence in one milestone would make failures hard to attribute.

## 12. Architectural invariants

1. Experience is evidence, not permanent cognition.
2. Trusted Strategy is durable cognition and stays bounded.
3. More learning does not imply more Strategy identities.
4. Filesystem layout is an adapter detail, not Strategy semantics.
5. Human promotion remains the only path to durable trust.
6. Autonomous learning may start a hypothesis path; it may not grant authority.
7. Existing SI/CPL Candidate and Decision schemas remain valid and immutable.
8. Normal project work always outranks autonomous learning.
9. No persistent learning queue, second Agent Loop, or background worker is introduced.
10. Harness owns evidence, capacity, provenance, and legality; model owns semantic learning judgment.
11. Experience forgetting is deterministic and must not depend on model-authored importance scores.
12. Strategy persistence must be portable across host migration even when the first storage adapter remains local.
