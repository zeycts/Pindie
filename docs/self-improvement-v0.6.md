# Pindie Self-Improvement v0.6 — Candidate Trial & Promotion

Status: architecture contract for SI v0.6.

This document is the just-in-time refinement of the directional SI v0.6 section in `docs/self-improvement.md`. It does not change the stable Self-Improvement ownership model or the SI v0.1–v0.5 contracts.

## 1. Goal

SI v0.5 ends at an immutable, inactive Strategy Revision Candidate:

```text
Experience
  ↓
Evaluation
  ↓
/adapt <seed-strategy-id>
  ↓
Strategy Revision Candidate
  ↓
inactive
```

SI v0.6 closes the first real policy-learning loop:

```text
immutable Seed revision
        │
        │ evidence-backed adaptation
        ▼
Candidate revision
        │
        │ explicit controlled Trial
        ▼
revision-aware Run Experience
        │
        ▼
Trial evidence profile
        │
        ├── explicit reject
        │
        └── explicit promote
                 │
                 ▼
        trusted selectable revision
```

The milestone must preserve this distinction:

```text
Candidate = hypothesis
Trial     = experiment
Promotion = human-approved trust transition
```

Promotion is not automatic Strategy replacement.

## 2. Stable ownership boundary

SI v0.6 must not weaken existing Pindie authority.

```text
Pindie Environment
  State / Reality / Snapshot / Capabilities / Gateway
        │
        │ immutable legality
        ▼
Pindie Policy
  Seed revisions / Candidate Trials / promoted revisions
        │
        │ advisory cognition only
        ▼
Pi Agent Run
```

A Candidate, Trial, or promoted revision must never:

- grant or revoke capabilities;
- bypass the Execution Gateway;
- mutate `PindieState` merely by being selected;
- redefine success criteria;
- fabricate Verification evidence;
- resolve Human Gates;
- alter Task legality;
- alter Pi's low-level Agent Loop;
- create a second inference loop.

The model still owns cognitive policy choice inside the legal action space.

## 3. Strategy identity and Revision identity

SI v0.5 already separated logical Strategy identity from Strategy semantics. SI v0.6 makes revision identity executable.

Example:

```text
Strategy identity
  architecture-first

Revisions
  seed
  candidate 84e4...
  promoted candidate 84e4...
```

The logical Strategy identity remains stable:

```text
strategyId
kind: approach | modifier
```

A revision adds exact semantics and provenance.

Conceptually, a runtime-selectable Strategy revision contains:

```text
strategyId
kind
revisionIdentity
revisionFingerprint
revisionStatusAtRun
semantics
  summary
  useWhen[]
  avoidWhen[]
  principles[]
```

`revisionIdentity` is:

```text
seed
```

for the immutable Seed root, or the immutable Candidate UUID for a Candidate-derived revision.

`revisionStatusAtRun` distinguishes factual trust/use state:

```text
seed
trial
promoted
```

The stable Policy identity must include revision identity. Two Policies that use the same Strategy IDs but different revisions are different Policy identities.

## 4. Candidate fingerprint

SI v0.6 requires a deterministic Candidate fingerprint in addition to the Candidate UUID.

The Candidate UUID identifies the artifact. The fingerprint binds the exact revision semantics.

The fingerprint should be deterministic SHA-256 over a canonical representation containing at least:

```text
target.strategyId
target.kind
target.baseFingerprint
proposal.summary
proposal.useWhen[]
proposal.avoidWhen[]
proposal.principles[]
```

Do not include `createdAt`, evidence record IDs, or hypothesis prose in the semantic revision fingerprint.

The Candidate artifact remains immutable.

## 5. Candidate reading boundary

SI v0.5 storage is intentionally write-only. SI v0.6 may add strict project-local Candidate reading because explicit Trial and decision operations need to resolve one Candidate by ID.

The first reader should support exact read-by-ID rather than a general Strategy database.

A Candidate is usable only when:

- the file name is the canonical Candidate UUID;
- the artifact passes the exact Candidate schema;
- target Strategy ID/kind still resolve to the immutable Seed catalog;
- the current Seed fingerprint equals `target.baseFingerprint`;
- the Candidate semantic fingerprint is valid;
- no terminal reject decision already exists;
- a Trial request is not trying to reinterpret another project's Candidate.

Do not migrate or repair malformed Candidate files.

## 6. Trial has no durable Trial artifact

SI v0.6 must not introduce a `strategy-trials/` history store.

A Trial attempt is runtime control, not durable learning data.

The durable facts already have appropriate homes:

```text
Candidate object
  → strategy-candidates/<candidate-id>.json

what actually happened during Trial
  → revision-aware Run Experience

promote/reject decision
  → Strategy Revision Decision artifact
```

Therefore Trial itself uses only a runtime lease.

This avoids duplicating Run history into a second Trial database.

## 7. Explicit Trial entry

Trial must never be assigned automatically.

Conceptual entry:

```text
/trial <candidate-id>
```

The exact command name may vary, but the semantics are fixed:

- user/operator explicitly chooses one Candidate;
- Pindie must be idle;
- the Candidate belongs to the current project;
- only one pending/active Trial lease may exist;
- the lease is bound to the current native Session;
- the pending lease binds to the next Agent Run;
- the active lease is bound to that Agent Run generation;
- it expires at Run settlement, Session replacement/reload, or cancellation;
- it is never persisted.

A Trial command does not itself claim the Candidate is better.

A Candidate may be trialed repeatedly, but each Trial must be explicitly requested. There is no automatic trial scheduler in v0.6.

## 8. Trial Packet

When a pending Trial lease binds to an Agent Run, Pindie may inject one bounded Trial Packet into that Run.

The packet should contain only:

```text
candidate ID
logical target Strategy ID/kind
Candidate fingerprint
Seed base fingerprint
Candidate proposed semantics
Candidate hypothesis
explicit statement that this is a controlled Trial
exact revision selector allowed for this Run
```

It must not include the whole Experience archive, raw transcripts, hidden reasoning, or claims that the Candidate is superior.

The packet is available only to the Trial Run.

Normal coding Runs must not receive inactive Candidate data.

## 9. Model-owned Policy declaration remains intact

An explicit `/trial` gives the model permission to use one otherwise-inactive revision. It must not fabricate Policy attribution merely because the user armed a Trial.

The model still declares the cognitive Policy that actually guides the Run.

`pindie_policy_set` therefore becomes revision-aware.

Conceptually, each selected Strategy role must resolve to an explicit revision:

```text
approach
  strategyId
  revision

modifiers[]
  strategyId
  revision
```

Backward-compatible Seed shorthand may remain for ordinary declarations, but a non-Seed revision must never be inferred merely from the logical Strategy ID.

An inactive Candidate revision is legal only when the active Trial lease authorizes that exact Candidate in that exact Run.

A promoted revision is legal during ordinary coding Runs.

No other inactive Candidate is selectable.

If the model never successfully declares the armed Candidate revision, the Run is not Candidate Trial evidence.

## 10. Revision-aware Policy Snapshot

Policy Snapshot remains Run-scoped and model-declared, but its Strategy selections now carry exact revision identity.

Conceptually:

```text
PolicySnapshot
  approach
    strategyId
    kind: approach
    revisionIdentity
    revisionFingerprint
    revisionStatusAtRun
    semantics

  modifiers[]
    strategyId
    kind: modifier
    revisionIdentity
    revisionFingerprint
    revisionStatusAtRun
    semantics
```

Do not add rationale, confidence, reward, score, workflow phases, or hidden policy history.

A new Agent Run still starts with no declared Policy Snapshot.

## 11. Experience schema v4 is required

Schema v3 cannot distinguish:

```text
architecture-first@seed
```

from:

```text
architecture-first@candidate-84e4...
```

because its Policy identity is based only on Seed Strategy IDs and its parser canonicalizes against the immutable Seed catalog.

Therefore the first Run that permits a non-Seed revision requires revision-aware Experience schema v4.

Schema v4 should preserve the existing bounded Run Experience structure and change only what revision-aware attribution requires.

Conceptually:

```text
schemaVersion: 4

runStart
  ... existing facts

task
  ... existing facts

policy
  finalSnapshot | null
    revision-aware approach/modifiers
  declarationCount
  finalPolicyDeclarationCount
  finalPolicyFirstDeclaredAfter | null
  finalPolicyLastDeclaredAfter | null

execution
  ... existing counters

outcome
  ... existing facts

metrics
  ... existing metrics
```

Do not use schema v4 as an excuse to add transcript, reasoning, scores, task classification, or arbitrary Trial metadata.

## 12. Schema v3 remains immutable baseline history

Schema v1/v2 remain unsupported historical records.

Schema v3 becomes supported legacy Seed-only Experience.

Schema v4 is the current revision-aware writer format.

Do not rewrite or migrate schema-v3 files.

Evaluation should normalize valid v3 and v4 records into one revision-aware derived representation:

```text
schema-v3 Seed Policy
  → revisionIdentity = seed
  → revisionStatusAtRun = seed
  → current Seed fingerprint

schema-v4 Policy
  → use recorded revision identity/fingerprint/status
```

This is necessary because SI v0.6 still needs historical Seed evidence as the baseline for Candidate Trials.

## 13. Adaptation must continue after schema v4

Switching the current writer to schema v4 must not silently kill `/adapt`.

Future Candidate creation still targets the immutable Seed baseline in SI v0.6.

Its eligible source evidence may come from:

- valid schema-v3 Runs where the target Seed Strategy participated;
- valid schema-v4 Runs where the target **Seed revision** participated.

Runs using Trial or promoted Candidate revisions are not Seed evidence for a new Seed-targeted Candidate in SI v0.6.

Revision-on-revision adaptation is deferred.

## 14. Trial evidence eligibility

A valid Trial Run is not automatically useful promotion evidence merely because a Trial lease existed.

A Candidate Trial evidence record must satisfy at least:

- valid schema-v4 Experience;
- ordinary Run `attributionEligible` is true;
- final explicit Policy contains the exact Candidate revision in the target role;
- `revisionStatusAtRun` for that revision is `trial`;
- Candidate UUID and fingerprint match the immutable Candidate artifact;
- continuous final-Policy exposure contains at least one non-policy tool call;
- the source record belongs to the current project.

A Trial lease with no successful Candidate declaration produces no Candidate Trial evidence.

A Candidate declared only after all non-policy execution has finished does not count toward promotion eligibility.

The full exposure facts remain visible; Pindie must not invent an exposure score.

## 15. Trial evidence profile

Evaluation remains deterministic and recomputable.

For one Candidate, Pindie may derive a bounded Trial Evidence Profile containing factual/derived quantities already consistent with SI v0.4, for example:

```text
eligible Trial Run count
verification-passed count
completed-during-Run count
tool error / denial totals
first-declaration progress
last-activation progress
continuous exposure calls/ratio
duration
cost
source Experience IDs
```

The Candidate profile is an evidence inventory, not a Candidate score.

## 16. Seed baseline comparison

A Candidate is a revision of one immutable Seed Strategy, so its review should show the corresponding Seed evidence profile.

Baseline evidence may use valid attributable v3/v4 Runs where the exact Seed revision participated.

Candidate Trial evidence and Seed baseline evidence may be displayed side-by-side.

Do not claim one outperforms the other merely because aggregate counts differ across unrelated Tasks.

Comparative claims remain limited by SI v0.4's factual comparability boundary. Exact same Task goal cohorts may be surfaced when available.

If no defensible comparable cohort exists, show the evidence inventories without a superiority claim.

## 17. Promotion eligibility is evidence sufficiency, not superiority

SI v0.6 must not create an automatic `candidateIsBetter` judgment.

A deterministic Promotion Eligibility gate means only:

> enough auditable Trial evidence exists for a human to make a promote/reject decision.

The first contract requires at least:

```text
2 distinct eligible Candidate Trial Experience records
+
Candidate/Seed fingerprint integrity
+
Candidate has no prior terminal decision
+
current project identity matches
```

The existing Candidate provenance already supplies at least two historical Seed-attributable source records. Promotion review should re-read current Experience and fail closed if the required baseline provenance can no longer be established.

Do not require every Trial Run to pass Verification or complete the Task. Negative Trial evidence is evidence and must remain visible.

Do not automatically promote when the threshold is reached.

## 18. Human-owned promote/reject decision

Promotion/rejection is a consequential Self-Improvement trust decision and remains explicit in v0.6.

Conceptually:

```text
/promote <candidate-id>
/reject <candidate-id>
```

These are operator commands, not model tools.

Promotion requires Promotion Eligibility.

Rejection may be explicit before or after Trial if the user has enough judgment to reject the hypothesis.

Neither command mutates `PindieState` or project files.

## 19. Immutable Strategy Revision Decision artifact

Promotion/rejection is persisted separately from the immutable Candidate.

Conceptually:

```text
StrategyRevisionDecisionV1

schemaVersion
candidateId
candidateFingerprint
decidedAt

target
  strategyId
  kind
  baseFingerprint

decision
  promoted | rejected

evidence
  trialRecordIds[]
```

Persist one terminal decision per Candidate, keyed by Candidate ID, under the project's Pindie storage namespace:

```text
~/.pindie/projects/<project-id>/
  strategy-candidates/
    <candidate-id>.json
  strategy-decisions/
    <candidate-id>.json
```

Decision files are immutable and fail closed on duplicate Candidate decisions.

No mutable Candidate `status` field is introduced.

## 20. Promotion means trusted selectable revision

Promotion does **not** mean:

```text
Seed file rewritten
Candidate silently becomes default
current Policy mutated mid-Run
all future Runs forced to use Candidate
```

Promotion means:

> this project-local Candidate revision is now trusted enough to be selectable by normal model-owned Policy declaration.

The Seed remains immutable and selectable.

Therefore promotion is operationally reversible without a mutable active-strategy pointer:

```text
future Run chooses promoted revision
or
future Run chooses Seed revision
```

SI v0.6 does not need a `rollback` state machine because Promotion does not overwrite the Seed or become a mandatory default.

Revocation/retirement/supersession of a promoted revision is deferred until real portfolio-evolution evidence justifies that lifecycle.

## 21. Bounded promoted portfolio in v0.6

SI v0.6 permits at most one promoted Candidate revision for each immutable Seed Strategy in one project.

This keeps the normal project-local revision catalog bounded:

```text
7 Seed Strategies
+
max 7 promoted revisions
```

If a promoted revision already exists for a target Strategy, another Candidate for that target may still remain historical or be trialed, but v0.6 must not promote it until a later milestone defines explicit supersession/rebase/retirement semantics.

This avoids inventing portfolio management prematurely.

## 22. Promoted revision visibility

Normal coding Runs may receive a bounded project-local promoted-revision catalog in addition to the stable Seed catalog.

The projection must clearly distinguish:

```text
logical Strategy ID
Seed revision
promoted Candidate revision ID
revision semantics
```

Do not hide the Seed merely because a promoted revision exists.

Do not inject rejected or inactive Candidate revisions into normal Runs.

Promoted revision projection is advisory Policy context, not Environment truth.

## 23. Normal Policy selection after promotion

The model may declare either:

```text
architecture-first@seed
```

or the project's promoted `architecture-first` revision.

The exact wire syntax is an implementation detail, but revision identity must be explicit and unambiguous.

The Harness must never infer a promoted revision solely from logical Strategy ID.

A promoted revision used in a normal Run records:

```text
revisionStatusAtRun = promoted
```

in schema-v4 Experience.

This allows future milestones to distinguish Trial evidence from post-promotion use of the same immutable revision semantics.

## 24. Decision audit packet

Before promotion, Pindie should render a bounded deterministic review containing:

```text
Candidate identity / target / hypothesis
Candidate proposed semantics
Candidate creation source Experience IDs
eligible Trial evidence profile
Seed baseline evidence profile
exact-goal comparable cohorts when available
Candidate/Seed fingerprints
clear non-causal boundary
```

The review must not say:

```text
Candidate score = 91
Candidate is 23% better
promotion recommended with 87% confidence
```

unless a later milestone introduces and validates those semantics.

The Human owns the final trust judgment.

## 25. Failure isolation

Self-Improvement persistence must remain outside Task authority.

Failure to read a Candidate, write a Decision artifact, evaluate Trial evidence, or project promoted revisions must not:

- mutate Task truth;
- change Verification status;
- open a Human Gate;
- invalidate project Reality;
- bypass the Gateway;
- make a project implementation Task fail.

When revision trust cannot be established, fail closed to Seed-only Policy availability.

## 26. Interaction with Long Task Runtime

Long Task Runtime and SI v0.6 are orthogonal.

A Trial Policy may span a Run inside any Session. If Long Task Runtime rolls to a fresh Session, the old Run's Trial lease ends normally.

A fresh automatically resumed Run does not silently inherit the prior Trial lease.

If the user wants the Candidate trialed again in the fresh Run, a later design may automate that only after real evidence justifies it. SI v0.6 does not.

Promoted revisions, unlike Trial leases, are project-local trusted policy and may be selected normally in any future Run.

## 27. v0.6 non-goals

Do not implement:

- automatic Candidate trial assignment;
- automatic promotion or rejection;
- Candidate scoring/ranking;
- global reward functions;
- causal-effect estimation;
- LLM-as-judge promotion;
- revision-on-revision adaptation;
- Seed mutation;
- promoted revision as silent default;
- mutable active-Strategy pointers;
- rollback/retirement/supersession state machines;
- more than one promoted revision per Seed target;
- task taxonomy/classification;
- semantic task similarity or embeddings;
- new Strategy identities;
- Strategy Derivation;
- learned Skills;
- multi-Agent evaluation;
- a dedicated policy/evaluator Agent;
- a second Agent Loop.

## 28. Implementation slices

Implement SI v0.6 in bounded slices.

### Slice A — Revision-aware Policy & Experience substrate

Goal: make revision identity representable without activating Candidates yet.

- add deterministic Candidate semantic fingerprint;
- define revision-aware Strategy selection / Policy identity;
- preserve Seed declaration compatibility;
- introduce schema-v4 Run Experience;
- read/evaluate schema v3 as legacy Seed-only evidence plus schema v4;
- keep all inactive Candidates unselectable;
- keep normal runtime behavior Seed-only.

### Slice B — Explicit Candidate Trial

Goal: allow one explicitly chosen Candidate into one controlled Run.

- strict Candidate reader by ID;
- runtime-only Trial lease;
- bounded Trial Packet;
- exact Candidate revision becomes selectable only under that lease;
- Trial Run writes revision-aware schema-v4 Experience;
- no promotion/rejection yet.

### Slice C — Trial Evaluation & Decision Review

Goal: make Candidate Trial evidence inspectable without changing policy trust.

- derive Trial evidence profiles;
- derive Seed baseline profile across supported v3/v4 evidence;
- surface exact-goal comparable cohorts when available;
- deterministic Promotion Eligibility gate;
- bounded human review packet;
- no policy mutation yet.

### Slice D — Promotion / Rejection & Promoted Selection

Goal: complete the first trust transition.

- immutable Strategy Revision Decision artifact;
- explicit human promote/reject commands;
- max one promoted revision per Seed target;
- promoted revisions projected into normal Policy context;
- `pindie_policy_set` may select promoted revisions explicitly;
- rejected/inactive Candidates remain unavailable;
- compatibility tests and real dogfood closure.

## 29. Completion criterion

SI v0.6 is complete only when real dogfood demonstrates the full loop:

```text
Seed-attributed Experience
        ↓
Candidate
        ↓
explicit Trial Run 1
        ↓
explicit Trial Run 2
        ↓
revision-aware Experience
        ↓
Candidate vs Seed evidence review
        ↓
explicit human promote or reject
        ↓
if promoted:
normal coding Run explicitly selects promoted revision
        ↓
Experience records promoted revision identity
```

At that point Pindie has crossed the first real Self-Improvement boundary:

```text
Experience
→ hypothesis
→ experiment
→ human-approved policy trust
→ future policy use
```

while deterministic Environment authority remains unchanged.
