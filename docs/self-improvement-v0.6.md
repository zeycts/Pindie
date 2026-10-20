# Pindie Self-Improvement v0.6 — Candidate Trial & Promotion

> **Retired research history.** [AL retirement](al-retirement-phase1.md) supersedes activation and migration direction below; [Phase 2-D](al-retirement-phase2-d.md) is the current bounded deletion record. Retained artifact contracts are not permission to reactivate SI or modify historical user data.

Status: implemented and frozen SI v0.6 artifact/trust contract, retained for compatibility and history during migration; not authority for future Autonomous Learning v1. All four implementation slices are implemented.

This document preserves the SI v0.1–v0.5 ownership model for the implemented v0.6 lifecycle. The approved target architecture is in `docs/autonomous-learning-v1.md` (implementation pending).

## 1. Goal

SI v0.5 ends at an immutable inactive Candidate. SI v0.6 closes the first real policy-learning loop:

```text
Seed-attributed Experience
        ↓
Candidate hypothesis
        ↓
explicit Candidate Trial
        ↓
revision-aware Experience
        ↓
Trial evidence review
        ↓
explicit Human decision
   reject | promote
              ↓
     trusted selectable revision
```

Keep the concepts distinct:

```text
Candidate = hypothesis
Trial     = experiment
Promotion = human-approved trust transition
```

Promotion never silently replaces Seed policy.

## 2. Stable authority boundary

Strategy revisions remain advisory Policy. They cannot change deterministic Environment authority.

A Candidate, Trial, or promoted revision must never grant/revoke capabilities, bypass the Gateway, mutate `PindieState` merely by selection, redefine success criteria, fabricate Verification, resolve Human Gates, alter Task legality, or change Pi's low-level Agent Loop.

The model still owns cognitive Policy declaration inside the legal action space.

## 3. Strategy identity vs Revision identity

The logical Strategy identity remains:

```text
strategyId
kind: approach | modifier
```

Its revisions are separate:

```text
architecture-first
  ├─ Seed revision
  └─ Candidate revision <candidate-id>
```

A runtime-selectable revision must carry enough identity to distinguish exact semantics:

```text
strategyId
kind
revisionIdentity      # seed | candidate UUID
revisionFingerprint
revisionStatusAtRun   # seed | trial | promoted
semantics
  summary
  useWhen[]
  avoidWhen[]
  principles[]
```

Policy identity must include revision identity. The same logical Strategy IDs with different revisions are different Policies.

## 4. Candidate integrity

Candidate files remain immutable SI v0.5 artifacts.

SI v0.6 adds a deterministic Candidate semantic fingerprint derived from the immutable v1 artifact; it is not a new persisted Candidate field. It binds at least:

```text
target.strategyId
target.kind
target.baseFingerprint
proposal.summary
proposal.useWhen[]
proposal.avoidWhen[]
proposal.principles[]
```

Do not include timestamps, evidence IDs, or hypothesis prose in the semantic fingerprint.

SI v0.6 may add strict project-local Candidate read-by-ID. It does not need a general Strategy database. A Candidate is usable only when its schema, Candidate UUID, Seed target/kind, Seed base fingerprint, and Candidate fingerprint remain valid.

Malformed artifacts are rejected, not migrated or repaired.

## 5. Trial is runtime-only

Do not introduce a durable `strategy-trials/` store.

The durable facts already have appropriate homes:

```text
Candidate object
  → strategy-candidates/<candidate-id>.json

what actually happened in a Trial Run
  → Run Experience

promote/reject decision
  → strategy-decisions/<candidate-id>.json
```

Trial itself is only a Session/Run-scoped lease.

Conceptual entry:

```text
/trial <candidate-id>
```

The exact command name is not important; the contract is:

- user explicitly chooses one Candidate;
- Pindie is idle;
- only one pending/active Trial lease exists;
- pending Trial is bound to the current native Session and next Agent Run;
- active Trial is bound to that Run generation;
- it clears at Run settlement, Session replacement/reload, or cancellation;
- it is never persisted;
- no automatic Trial assignment exists in v0.6.

A Candidate may be trialed repeatedly, but each Trial is explicitly requested.

## 6. Trial Packet and Policy declaration

When a pending Trial binds to a Run, Pindie may inject one bounded Trial Packet containing only:

```text
candidate ID + fingerprint
target Strategy ID/kind
Seed base fingerprint
Candidate proposed semantics
Candidate hypothesis
explicit controlled-Trial boundary
exact revision selector allowed in this Run
```

Normal Runs never receive inactive Candidate data.

Arming a Trial does not fabricate Policy attribution. The model must still declare the Policy that actually guides execution.

`pindie_policy_set` therefore becomes revision-aware. Seed shorthand may remain backward compatible, but every non-Seed selection must identify the exact revision explicitly.

An inactive Candidate revision is legal only under its matching active Trial lease. A promoted revision is legal in normal Runs. All other inactive Candidates remain unavailable.

If the model never successfully declares the armed Candidate revision, that Run is not Candidate Trial evidence.

## 7. Revision-aware Policy Snapshot

Policy Snapshot remains Run-scoped, optional, and model-declared.

Conceptually:

```text
PolicySnapshot
  approach: StrategyRevisionSelection
  modifiers: StrategyRevisionSelection[]
```

where each selection contains the logical Strategy identity, exact revision identity/fingerprint/status, and bounded revision semantics.

Do not add rationale, confidence, reward, workflow phases, or durable Policy history.

## 8. Experience schema v4

Schema-v4 is the only live Run Experience contract. It keeps the existing bounded Run Experience structure and carries the Policy facts required for revision-aware attribution:

```text
schemaVersion: 4
runStart      # same factual boundary
task          # same
policy
  finalSnapshot | null   # revision-aware
  declarationCount
  finalPolicyDeclarationCount
  finalPolicyFirstDeclaredAfter | null
  finalPolicyLastDeclaredAfter | null
execution     # same counters
outcome       # same facts
metrics       # same
```

No transcript, reasoning, quality score, task taxonomy, or arbitrary Trial log enters v4.

The Experience unit remains one settled Agent Run, not one durable Task. Across automatic Session rollover, the outgoing eligible Run freezes and attempts at most one immutable record before continuity commit; the fresh Session receives a new Run-scoped Policy/attribution, execution, duration, and cost boundary. Human-facing cumulative Task Time/Cost is runtime presentation outside schema-v4 `metrics` and never replaces those per-Run values. Hidden automatic resume is not Human intent and does not fabricate a record without non-policy execution.

### Historical records outside live evidence

Pre-v4 records are not part of the live Experience evidence set. They may be
archived outside the live `experience/` directory, for example under
`archive/experience-v3/`, and are not parsed, normalized, or evaluated.

Evaluation consumes only valid schema-v4 records and uses their recorded
revision identity, fingerprint, and status directly. Current schema-v4 Seed
records provide the Candidate baseline.

## 9. `/adapt` must continue after v4

Switching the current writer to v4 must not break SI v0.5 adaptation.

In SI v0.6, new Candidates still target the immutable Seed revision. Eligible source evidence may come from:

- schema-v4 Runs containing that exact Seed revision.

Trial/promoted Candidate revision Runs are not Seed evidence for Seed-targeted `/adapt`.

Revision-on-revision adaptation remains deferred.

## 10. Candidate Trial evidence

A Trial lease existing is not enough. Promotion evidence requires an actual revision-attributed Run.

One Candidate Trial Experience is eligible only when:

- it is valid schema-v4 Experience;
- ordinary Run `attributionEligible` is true;
- final Policy contains the exact Candidate revision in the target role;
- `revisionStatusAtRun = trial` for that revision;
- Candidate UUID/fingerprint match the immutable artifact;
- continuous final-Policy exposure contains at least one non-policy tool call;
- the Experience belongs to the current project.

A Candidate declared after all non-policy execution has finished does not count toward promotion eligibility.

Do not invent an exposure score; preserve the existing declaration/exposure facts.

## 11. Trial evidence review

Evaluation remains deterministic and recomputable.

For one Candidate, derive a bounded Trial profile using the same factual style as SI v0.4:

```text
eligible Trial Run count
verification-passed count
completed-during-Run count
tool error / denied-call totals
declaration positions
continuous exposure calls/ratio
duration / cost
source Experience IDs
```

Also derive the corresponding Seed baseline profile from current schema-v4 Seed evidence.

Show exact-goal comparable cohorts when they exist. Outside that factual cohort boundary, display Candidate and Seed evidence inventories side-by-side without claiming superiority.

No Candidate score, ranking, reward, or causal claim exists in v0.6.

## 12. Promotion eligibility

Promotion eligibility means only:

> enough auditable Trial evidence exists for a human to make a trust decision.

It does **not** mean the Harness proved the Candidate is better.

The first gate requires at least:

```text
2 distinct eligible Candidate Trial records
+
valid Candidate/Seed fingerprint binding
+
current project match
+
no prior terminal decision for this Candidate
+
Seed baseline provenance still available
```

Negative Trial evidence remains visible. Eligibility does not require every Trial to pass Verification or complete the Task.

No automatic promotion occurs when the threshold is reached.

## 13. Human-owned decision

Promotion/rejection remains explicit operator authority, conceptually:

```text
/promote <candidate-id>
/reject <candidate-id>
```

These are commands, not model tools.

Promotion requires Promotion Eligibility. Rejection may be explicit whenever the user has enough evidence/judgment.

The decision does not mutate `PindieState` or project Reality.

## 14. Immutable Strategy Revision Decision

Do not mutate Candidate status. Persist one terminal sidecar decision per Candidate:

```text
StrategyRevisionDecisionV1

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

Storage:

```text
~/.pindie/projects/<project-id>/
  strategy-candidates/<candidate-id>.json
  strategy-decisions/<candidate-id>.json
```

Decision files are immutable and duplicate decisions fail closed.

## 15. Promotion semantics

Promotion means:

> this project-local Candidate revision is trusted enough to become selectable by normal model-owned Policy declaration.

Promotion does **not**:

- rewrite Seed;
- silently make the Candidate default;
- mutate current Policy mid-Run;
- force future Runs to use it.

The immutable Seed remains visible and selectable. Therefore v0.6 needs no mutable active-revision pointer or rollback state machine: a future Run can explicitly select Seed instead of the promoted revision.

Revocation/retirement/supersession is later portfolio-evolution work.

## 16. Bounded promoted portfolio

SI v0.6 allows at most one promoted Candidate revision per Seed Strategy per project.

This bounds the normal portfolio to:

```text
7 Seed revisions
+
max 7 project-local promoted revisions
```

If a target already has a promoted revision, another Candidate may remain historical or be trialed, but v0.6 cannot promote it until later supersession/rebase semantics exist.

Normal coding Runs may receive a bounded promoted-revision catalog in addition to the stable Seed catalog. Inactive/rejected Candidates never enter normal context.

The Harness must never infer a promoted revision solely from logical Strategy ID; revision choice is explicit.

A normal Run using a promoted revision records `revisionStatusAtRun = promoted` in schema-v4 Experience.

## 17. Failure and Long Task boundaries

Self-Improvement artifacts are never Task authority. Candidate/Decision read/write or Evaluation failure must not mutate Task truth, Verification, Human Gates, capabilities, or project Reality. When revision trust cannot be established, fail closed to Seed-only Policy availability.

Long Task Runtime and Trial are orthogonal. A Trial lease belongs to one Agent Run and does not silently carry across automatic Session rollover. A fresh resumed Run starts without that Trial lease. Promoted revisions are durable trusted Policy and may be selected normally later.

## 18. v0.6 non-goals

Do not implement:

- automatic Trial assignment;
- automatic promote/reject;
- Candidate scoring/ranking or global reward;
- causal-effect estimation or LLM-as-judge promotion;
- revision-on-revision adaptation;
- Seed mutation;
- promoted revision as silent default;
- mutable active-revision pointers;
- rollback/retirement/supersession state machines;
- more than one promoted revision per Seed target;
- task taxonomy, semantic similarity, embeddings;
- new Strategy identities / Strategy Derivation;
- learned Skills;
- dedicated evaluator/policy Agent;
- second Agent Loop.

## 19. Implementation slices

### Slice A — Revision-aware Policy & Experience substrate

Make revision identity representable without activating Candidates:

- Candidate semantic fingerprint;
- revision-aware Strategy selection and Policy identity;
- Seed declaration backward compatibility;
- schema-v4 Experience writer/parser;
- schema-v4 Evaluation and Seed-attributed `/adapt` evidence;
- normal runtime remains Seed-only.

### Slice B — Explicit Candidate Trial

Allow one explicitly chosen Candidate into one controlled Run:

- strict Candidate reader by ID;
- runtime-only Trial lease;
- bounded Trial Packet;
- exact Candidate revision selectable only under that lease;
- Trial Run produces revision-aware Experience;
- no promotion/rejection yet.

### Slice C — Trial Evaluation & Review

Make Trial evidence inspectable without changing trust. The current read-only presentation is `/trial-review <candidate-id>`; it does not promote or reject a Candidate.

- Candidate Trial profile;
- Seed baseline profile;
- exact-goal cohorts when available;
- deterministic Promotion Eligibility;
- bounded non-causal review;
- no policy trust mutation yet.

### Slice D — Promotion / Rejection & Promoted Selection

Complete the trust transition:

- immutable Decision artifact;
- explicit human promote/reject commands;
- max one promoted revision per Seed target;
- promoted revisions appear in normal bounded Policy context;
- `pindie_policy_set` can explicitly select promoted revisions;
- inactive/rejected revisions remain unavailable;
- compatibility + real dogfood closure.

## 20. Completion criterion

SI v0.6 is complete only when real dogfood demonstrates:

```text
Seed evidence
  ↓
Candidate
  ↓
Trial Run 1
  ↓
Trial Run 2
  ↓
revision-aware Experience
  ↓
Candidate / Seed evidence review
  ↓
explicit promote or reject
  ↓
if promoted:
normal coding Run explicitly uses promoted revision
  ↓
Experience records promoted revision identity
```

That is the first complete Pindie Self-Improvement trust loop:

```text
Experience
→ hypothesis
→ experiment
→ human-approved policy trust
→ future policy use
```
