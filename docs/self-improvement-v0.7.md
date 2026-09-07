# Pindie Self-Improvement v0.7 — Strategy Derivation

Status: implemented, dogfooded, trust-closed, normal-use validated, frozen.

This document is the authoritative SI v0.7 architecture contract. It refines the SI v0.7 direction in `docs/self-improvement.md`. It starts from the frozen SI v0.6 contract in `docs/self-improvement-v0.6.md` and the completed v0.6 dogfood loop. It does not reopen or migrate SI v0.6 artifacts.

The status terms are narrow:

- **implemented** — all four v0.7 slices exist.
- **dogfooded** — the real Derivation → Trial → Review → Human trust lifecycle ran on Pindie's own development work.
- **trust-closed** — the Human `/promote`/`/reject` boundary and immutable trust projection are complete.
- **normal-use validated** — a promoted Derived Strategy was later naturally selected in ordinary non-Trial Runs and recorded as promoted schema-v4 Experience.
- **frozen** — the v0.7 architecture contract is closed; future new capabilities require a new scoped version/problem statement. Frozen does not mean bugs can never be fixed.

Completed real dogfood used the first Derived logical Strategy:

```text
delivery-checkpoints
kind: modifier
```

The bounded lifecycle closed as:

```text
real trusted schema-v4 Experience
        ↓
explicit /derive
        ↓
inactive immutable StrategyDerivationCandidateV1
        ↓
explicit Trial #1
        ↓
explicit Trial #2
        ↓
deterministic /trial-review
        ↓
2 / 2 eligible Candidate Trial Runs
        ↓
Promotion Eligibility: eligible for human review
        ↓
explicit Human /promote
        ↓
immutable promoted StrategyDerivationDecisionV1
        ↓
promoted Derived Strategy enters the trusted portfolio
        ↓
later ordinary non-Trial Runs naturally select delivery-checkpoints
        ↓
normal schema-v4 Experience records promoted status
```

At least three later ordinary promoted-policy Runs had real post-declaration execution exposure. Selection was not immediate in every Run; later ordinary Tasks selected the promoted Strategy when the model judged it appropriate. The same Candidate identity/fingerprint is retained, while Trial and promoted remain distinct status-at-Run identities, and historical Trial Experience was not rewritten after promotion. This demonstrates lifecycle closure and normal usability, not objective superiority, causal improvement, or statistical validation. The durable evidence remains in Experience, Candidate, and Decision artifacts; this record is documentation, not a lifecycle store.

## 1. Goal

SI v0.7 adds one explicit path for proposing a new logical Strategy identity when repeated real project Experience supports a bounded missing-abstraction hypothesis:

```text
repeated real Experience
        ↓
current trusted Strategy portfolio may lack an appropriate abstraction
        ↓
explicit Human /derive
        ↓
optional new-Strategy hypothesis
        ↓
explicit Candidate Trials
        ↓
auditable Derivation review
        ↓
explicit Human reject | promote
        ↓
new trusted logical Strategy identity
```

This is different from revision adaptation:

```text
SI v0.6 revision adaptation
  Strategy S → revision S'

SI v0.7 Strategy Derivation
  trusted portfolio {S1 ... Sn} → new logical Strategy D
```

Keep the concepts distinct:

```text
Derivation source evidence = factual reason a missing abstraction may be worth hypothesizing
Derivation Candidate       = one inactive new-identity hypothesis
Candidate Trial            = one explicitly controlled Agent Run
Derivation Decision        = one immutable Human trust decision
Promoted Derived Strategy  = runtime projection of Candidate + Decision
```

Evidence sufficiency permits a hypothesis. Trial evidence permits Human review. Neither proves novelty, usefulness, superiority, or causation.

## 2. Stable ownership and authority boundary

Strategy Derivation is a Human-owned Self-Improvement slow path. It reuses Pi's current model and native Agent Loop; it does not add another model, evaluator Agent, planner, loop, or background worker.

Ownership remains:

```text
Human
  → explicitly enters /derive, /trial, /trial-review, /promote, /reject
  → owns the final trust decision

Model
  → interprets bounded evidence
  → may propose one Candidate
  → may explicitly declare a Trial Candidate as cognitive Policy
  → never decides trust automatically

Pindie Harness
  → derives eligible factual evidence
  → constructs bounded packets
  → owns project, Candidate, portfolio-fingerprint, lease, and provenance facts
  → validates immutable artifact bindings
  → projects trusted Strategies into the legal Policy catalog

Pi
  → owns the model invocation, Agent Run, tools, sessions, compaction, retries,
    Skills, and low-level LLM → Tool → Result → LLM loop
```

A Derivation Candidate, Trial, Decision, or promoted Derived Strategy is advisory Policy only. It must never:

- mutate or become part of `PindieState`;
- grant or revoke Task, Verification, Gate, observation, or project-mutation authority;
- bypass the Execution Gateway or enable a tool absent from Pi's Run baseline;
- redefine success criteria, fabricate Verification, resolve a Human Gate, or complete a Task;
- alter Task, Long Task Runtime, Session, continuation, or Remote Companion semantics;
- become a Pi Skill or a second Skill runtime; or
- change Pi's Agent Loop or model weights.

A dedicated runtime-only `policy.derive` control capability may authorize only the narrow Candidate-creation tool while an explicit `/derive` lease is active. It is non-project-mutating, is never persisted, and is not part of ordinary Task capability derivation. The Gateway remains the call-boundary backstop. This does not broaden `policy.declare`, `policy.adapt`, or any existing semantic capability.

## 3. Frozen SI v0.6 boundary

SI v0.7 must not change the meaning or schema of:

- `StrategyRevisionCandidateV1`;
- its derived Candidate semantic fingerprint;
- `StrategyRevisionDecisionV1`;
- the existing Seed-targeted `/adapt` contract;
- existing Revision Candidate Trial attribution;
- the one-promoted-revision-per-Seed rule; or
- the existing `strategy-candidates/` and `strategy-decisions/` stores.

`/adapt` remains Seed-targeted in SI v0.7. A promoted Derived Strategy cannot be adapted or revised. Revision-on-revision ancestry remains out of scope.

Revision and Derivation artifacts may be projected through shared command and Policy interfaces, but they are not rewritten into a common durable schema.

## 4. Trusted Strategy portfolio

For SI v0.7, the current project-local trusted portfolio is the deterministic runtime projection of:

```text
immutable Seed Strategies
+
valid promoted Seed revisions from immutable v0.6 Candidate + Decision artifacts
+
valid promoted Derived Strategy identities from immutable v0.7 Candidate + Decision artifacts
```

An inactive or rejected Candidate is not trusted. A Trial lease is not trust. A promoted item is selectable, not selected, and never becomes an automatic default.

The trusted logical-identity set contains all Seed `strategyId` values and all promoted Derived `strategyId` values. A promoted Seed revision shares its Seed's existing logical identity and does not add another logical identity.

The Harness reconstructs this portfolio from immutable source artifacts on demand. There is no mutable active-Strategy table, Derived Strategy database, portfolio state file, or persisted default pointer.

### 4.1 Canonical trusted-portfolio manifest

The Harness derives one canonical bounded manifest. Each entry contains only:

```text
origin
  seed | promoted-seed-revision | promoted-derived
strategyId
kind
revisionIdentity
revisionFingerprint
```

Entries are sorted deterministically by the full tuple above. Every entry is resolved to bounded Strategy semantics from its immutable source artifact before use; the manifest does not become a second semantics store.

The project-local trusted-portfolio fingerprint is:

```text
sha256(canonical JSON of {
  fingerprintVersion: 1,
  projectId,
  entries: canonical manifest entries
})
```

`projectId` is the existing deterministic Pindie identity of the canonical current project root. Including it makes an otherwise identical portfolio in another project a different binding. Timestamps, Experience IDs, Decision evidence, display labels, and ordering from directory reads are excluded.

The fingerprint establishes exact portfolio identity only. It is not a quality score, novelty measure, similarity measure, or reward.

A Derivation Candidate durably retains the Harness-produced manifest and its fingerprint as an evidentiary snapshot. The manifest is bounded by the trusted-portfolio limits and is never authority for the current portfolio. Current trust is always reconstructed from Seeds plus immutable promotion artifacts. Candidate validation recomputes the snapshot fingerprint; current promotion eligibility separately compares it with a freshly reconstructed portfolio fingerprint.

If current trust artifacts cannot be read and validated coherently, `/derive` and Derivation promotion fail closed. Such failure does not weaken immutable Seed availability or change Pindie State.

## 5. Derivation source Experience

### 5.1 Per-record eligibility

A Derivation source record is eligible only when all of the following are true:

1. it is a valid live `schemaVersion: 4` Run Experience record;
2. it comes from the current project's Experience Store;
3. its ordinary `RunEvaluation.attributionEligible` value is true;
4. it has an explicit non-null final Policy Snapshot;
5. continuous final-Policy execution exposure is real: `finalPolicyExposureCalls > 0`;
6. every selection in the complete final Policy resolves exactly to a Strategy revision in the Candidate's captured trusted-portfolio manifest and its immutable trust artifacts; and
7. every final-Policy selection has `revisionStatusAtRun = seed | promoted` with the exact status appropriate to that trusted entry.

Any final Policy containing a `trial` selection is ineligible in full. Candidate Trial evidence—Revision or Derivation—is never Derivation source evidence. It is not enough to ignore the Trial selection and use the other co-occurring Strategies.

A promoted Seed revision or promoted Derived Strategy may participate in eligible source Policy only when its exact Candidate/Decision binding validates. A bare logical ID, stale fingerprint, wrong status, malformed artifact, or untrusted revision fails closed.

“Current project” is established by the project-local Experience reader and checked against the active project identity; it is not model-authored metadata. No cross-project Experience is eligible.

### 5.2 Conservative evidence-sufficiency gate

The exact source set cited by a Derivation Candidate must establish at least:

```text
3 distinct eligible Experience record IDs
2 distinct exact Task goal strings
2 distinct Policy Evidence Profile identities
```

Policy Evidence Profile identity is the existing schema-v4 deterministic identity of the complete revision-aware final Policy, including revision status. It is not a task class or learned feature.

The gate applies both before a `/derive` packet is offered and again to the exact source IDs submitted at Candidate creation. Packet construction must select a bounded set that itself satisfies the gate; satisfying the gate somewhere in omitted history is insufficient.

These thresholds establish only enough repeated and varied factual exposure to permit a hypothesis. They do not establish that:

- the portfolio is incomplete;
- the proposed Strategy is semantically novel;
- any current Strategy failed;
- the new Strategy caused or will cause a better outcome; or
- different Task goals are otherwise comparable.

## 6. Explicit `/derive` slow path

`/derive` is an explicit Human command. It is never model-triggered or automatically scheduled.

The command contract is:

- a canonical project root is loaded;
- Pi is idle enough to start one native Agent Run;
- no `/adapt`, `/derive`, or `/trial` lease is pending or active;
- the current trusted portfolio can be reconstructed and fingerprinted;
- enough eligible source Experience exists to build a compliant bounded packet; and
- one pending Derivation lease binds the current native Session and the next Agent Run.

The lease becomes active only for that Run generation and clears at Run settlement, cancellation, Session replacement/reload, or failed binding. It is runtime-only and never enters `PindieState`.

`/derive` is Self-Improvement work, not a project implementation Task. It does not start, replace, refine, progress, verify, gate, or complete a Pindie Task. Existing Task truth and capabilities remain unchanged.

One `/derive` Run may create at most one Candidate. Candidate creation is optional. It is a valid and expected result to conclude that the evidence does not justify a new logical Strategy identity. Settlement without a successful Candidate-creation call persists nothing and is not failure.

## 7. Bounded Derivation Packet

The active `/derive` Run receives one bounded factual packet and ordinary Runs receive none.

The packet contains only:

```text
project binding
  projectId

current trusted portfolio
  portfolio fingerprint
  bounded canonical entries
  each entry's origin, exact revision selector, kind, and bounded semantics

source evidence
  eligible/shown/omitted counts
  3..8 selected Run evidence items
  exact source record ID
  bounded exact Task goal
  complete final Policy identity
  first-declaration and last-activation progress
  continuous final-Policy exposure calls/ratio
  verification-passed and completed-during-Run indicators
  tool-error and denied-call counts
  duration and cost when present

sufficiency facts
  distinct source record count
  distinct exact Task goal count
  distinct Policy Evidence Profile identity count

boundary text
  evidence-only, optional hypothesis, no novelty/usefulness/causal claim
```

The packet may expose at most 8 source Runs. Existing Strategy semantic bounds apply: summary at most 512 characters; each `useWhen`, `avoidWhen`, and `principles` list at most 8 items; each item at most 256 characters. Task goals are bounded to 512 characters for presentation without changing their exact underlying identity used by the gate.

Selection is deterministic and must preserve the three-record/two-goal/two-profile gate in the shown set before filling remaining slots by a stable recency and record-ID order. The exact source IDs in the shown set are the only IDs the Candidate tool may accept.

The packet must not contain:

- transcripts or session history;
- chain-of-thought, hidden reasoning, or arbitrary model reflection;
- raw tool results or full Verification evidence;
- embeddings, nearest-neighbor results, task taxonomy, clusters, or inferred task types;
- Strategy scores, rankings, rewards, similarity, or novelty judgments; or
- fabricated causal or comparative conclusions.

The packet is ephemeral Knowledge Surface for the explicit Run, not durable State and not a second source of Experience truth.

## 8. Immutable `StrategyDerivationCandidateV1`

Derivation uses a new artifact. It must not add fields to or reinterpret frozen `StrategyRevisionCandidateV1`.

Conceptually:

```text
StrategyDerivationCandidateV1

schemaVersion: 1
candidateId                    # canonical lowercase UUID-v4
createdAt
projectId                      # Harness-owned current project binding

basePortfolio
  fingerprintVersion: 1
  fingerprint                  # Harness-owned project-local SHA-256
  entries[]                    # canonical bounded manifest from section 4.1

proposal
  strategyId
  kind: approach | modifier
  summary
  useWhen[]
  avoidWhen[]
  principles[]

evidence
  sourceRecordIds[]            # 3..8 exact packet IDs

hypothesis
```

Storage is project-local and immutable:

```text
~/.pindie/projects/<project-id>/
  strategy-derivation-candidates/
    <candidate-id>.json
```

The store uses canonical UUID filenames and atomic create-without-replacement semantics. Malformed artifacts are rejected, never repaired, migrated, or normalized into a different identity.

### 8.1 Candidate semantic fingerprint

The Derived Candidate revision fingerprint is a deterministic SHA-256 over a canonical projection containing:

```text
basePortfolio.fingerprint
proposal.strategyId
proposal.kind
proposal.summary
proposal.useWhen[]
proposal.avoidWhen[]
proposal.principles[]
```

It excludes `candidateId`, `createdAt`, `projectId`, source record IDs, hypothesis prose, and display labels. Project binding and evidence provenance remain independently validated artifact fields. The same Candidate therefore retains one revision identity and fingerprint from Trial through promotion.

The fingerprint identifies exact proposed semantics and its portfolio base. It does not prove semantic novelty.

## 9. Narrow Candidate creation tool

The only model-callable Derivation mutation is conceptually:

```text
pindie_strategy_derivation_candidate_create
```

It is visible/callable only under the matching active `/derive` lease and requires `policy.derive`. It has project-mutation effect `none`, passes through normal Gateway authorization, and produces no Verification evidence.

The model may provide only:

```text
strategyId
kind
summary
useWhen[]
avoidWhen[]
principles[]
sourceRecordIds[]
hypothesis
```

Bounds are:

```text
strategyId       1..64 characters, strict lowercase kebab-case
summary          1..512 characters
useWhen          1..8 non-empty items, each at most 256 characters
avoidWhen        0..8 non-empty items, each at most 256 characters
principles       1..8 non-empty items, each at most 256 characters
sourceRecordIds  3..8 unique IDs, each at most 128 characters
hypothesis       1..1024 characters
```

The Harness exclusively supplies and validates:

- `candidateId` and `createdAt`;
- `projectId`;
- the canonical base portfolio manifest and fingerprint from the active lease;
- exact source membership in the active packet;
- fresh schema-v4 source eligibility and evidence sufficiency;
- Strategy ID collision and exact-duplicate checks; and
- immutable persistence.

The model cannot submit Candidate IDs, project identity, portfolio entries/fingerprint, revision status, or trust status.

On persistence success, the one-Candidate lease is consumed. On validation failure, no artifact is written. Persistence failure may leave the current lease retryable, but must not affect Task or project truth.

## 10. Logical Strategy identity and bounded novelty checks

A proposed logical `strategyId` must match:

```text
^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$
```

and be at most 64 characters. Uppercase, underscores, whitespace, leading/trailing hyphens, repeated hyphens, and non-ASCII characters are rejected rather than normalized.

At Candidate creation, the ID must not equal any logical Strategy identity in the captured current trusted portfolio. At promotion, it must still be absent from the freshly reconstructed trusted portfolio. Multiple inactive hypotheses may propose the same logical ID, but once one becomes trusted, all others with that ID are promotion-ineligible. Candidate UUIDs are unique across both Revision and Derivation stores; an ambiguous cross-store UUID fails closed in unified commands.

The Harness also rejects an exact semantic duplicate of a trusted Strategy. Exact equality means byte-for-byte equality after validated canonical construction of:

```text
{
  kind,
  summary,
  useWhen,
  avoidWhen,
  principles
}
```

against every entry in the applicable trusted portfolio. This is a structural duplicate check only. SI v0.7 does not implement semantic similarity, paraphrase detection, ranking, clustering, embeddings, or an LLM novelty judge. Passing the exact check is not a claim that a Candidate is genuinely novel.

## 11. Unified Human Candidate lifecycle

Human lifecycle commands remain one bounded UX:

```text
/trial <candidate-id>
/trial-review <candidate-id>
/promote <candidate-id>
/reject <candidate-id>
```

The command layer projects a tagged union:

```text
CandidateRef = RevisionCandidate | DerivationCandidate
```

It resolves the exact project-local UUID from the distinct immutable stores, validates the corresponding artifact and Decision type, and presents the Candidate kind in labels when needed. It does not persist a union wrapper or common mutable status.

Command completion and filtering are derived fresh from Candidates, Decisions, and Experience. Duplicate IDs across stores, conflicting Decisions, missing bindings, or malformed artifacts fail closed rather than guessing a Candidate type.

Existing Revision Candidate command behavior remains unchanged. Derivation-specific eligibility and review logic dispatch by artifact kind behind the shared command surface.

## 12. Explicit Derivation Trial

A Derivation Trial uses the existing one-Agent-Run Trial concept. `/trial` may arm one valid inactive Derivation Candidate only when:

- the Candidate and project binding validate;
- no terminal Derivation Decision exists;
- the proposed logical Strategy ID is still absent from the current trusted portfolio;
- the Candidate's base portfolio fingerprint still equals the current trusted-portfolio fingerprint;
- no adaptation, derivation, or other Trial lease is active; and
- Pi is idle enough to bind the next Run.

Requiring a current base fingerprint avoids collecting new evidence for a hypothesis whose stated portfolio basis has already changed. SI v0.7 has no Candidate rebase mechanism.

The bounded Trial Packet contains the Candidate UUID/fingerprint, project and base-portfolio bindings, proposed logical identity/kind/semantics, hypothesis, the controlled-Trial boundary, and the exact compact Policy selector. It does not repeat the Derivation source archive.

Conceptually, the allowed selector is:

```text
{
  strategyId: "boundary-first",
  revisionIdentity: "<candidate UUID>",
  revisionFingerprint: "<candidate semantic fingerprint>"
}
```

The pending lease binds the current native Session and next Agent Run; the active lease binds that Run generation. It clears at Run settlement, cancellation, Session replacement/reload, or failed binding. It never persists or carries through Long Task automatic rollover.

Arming or receiving a Trial Packet does not create Policy attribution. The model must successfully declare the exact Candidate selector in the correct `approach` or `modifier` role. The Harness supplies semantics and `revisionStatusAtRun = trial`; model input supplies identity only.

A Derivation Candidate Trial Experience record is eligible only when it is valid current-project schema-v4 Experience, ordinarily attribution-eligible, contains the exact Candidate revision in the final Policy with `revisionStatusAtRun = trial`, matches the immutable Candidate identity/fingerprint/semantics, and has `finalPolicyExposureCalls > 0`.

Each Trial is one Agent Run. A Candidate may be trialed repeatedly, but every Run requires a new explicit Human `/trial` command.

## 13. Policy and Experience schema-v4 compatibility

Experience schema-v4 remains the only live Experience schema. Its revision-aware selection already has the semantic capacity to represent a newly derived logical Strategy:

```text
strategyId
kind
revisionIdentity
revisionFingerprint
revisionStatusAtRun
semantics
```

SI v0.7 extends Policy/catalog resolution and schema-v4 selection validation so a non-Seed logical identity is accepted only when it resolves to:

- the exact active Derivation Trial lease with status `trial`; or
- an exact valid promoted Derived Strategy catalog entry with status `promoted`.

It must not weaken strict Seed validation or permit arbitrary self-described non-Seed revisions. The compact selector still contains identity only; the Harness supplies kind, semantics, and status from immutable artifacts.

The same promoted Candidate is represented without schema churn:

```text
Trial Run
  strategyId: boundary-first
  revisionIdentity: <candidate UUID>
  revisionFingerprint: <candidate semantic fingerprint>
  revisionStatusAtRun: trial

Normal Run after promotion
  strategyId: boundary-first
  revisionIdentity: <same candidate UUID>
  revisionFingerprint: <same candidate semantic fingerprint>
  revisionStatusAtRun: promoted
```

Historical schema-v4 parsing remains self-contained and strict. Specialized source/trial/trust evaluation additionally validates recorded selectors against the relevant immutable Candidate and Decision artifacts. No schema-v5, origin field, derivation flag, transcript field, or arbitrary evaluation field is added to Experience.

Policy identity continues to include exact revision identity/fingerprint. Policy Evidence Profile identity additionally includes `revisionStatusAtRun`, so Trial and promoted use remain factually distinct.

## 14. Derivation Trial Review

`/trial-review <candidate-id>` is read-only and recomputable from immutable Candidate, Experience, trust, and Decision artifacts. It creates no Decision and changes no Policy.

A Derivation review keeps two inventories separate:

```text
Derivation Source Evidence
  → exactly the Candidate's cited source Experience records
  → revalidated against schema-v4, project, captured portfolio, exposure,
    trust status, goals, and Policy Evidence Profile identities

Candidate Trial Evidence
  → every eligible exact-Candidate Trial Experience record
  → revalidated against Candidate identity, fingerprint, semantics, status,
    project, attribution eligibility, and execution exposure
```

Each inventory may report the existing bounded factual measurements: Run count, verification-passed count, completed-during-Run count, tool errors, denied calls, declaration positions, continuous exposure calls/ratio, duration, cost, exact source IDs, exact Task goals, and Policy Evidence Profile identities where applicable. Negative evidence remains visible.

There is no fabricated Seed baseline because a new logical Strategy has no Seed revision. Source evidence is not relabeled as a baseline or counterfactual.

Exact comparable cohorts may be shown only when both inventories naturally contain current-project records with the exact same `task.goal`. A cohort lists source and Trial record IDs separately. It does not combine unrelated source Policies, infer task similarity, or claim that the Candidate improved the outcome. Outside these cohorts, the two inventories remain side by side without comparison.

The review must explicitly state that it derives no Candidate score, reward, rank, novelty finding, usefulness finding, superiority claim, or causal conclusion.

## 15. Derivation Promotion Eligibility

Promotion Eligibility means only that enough auditable evidence exists for Human trust review. It is deterministic, recomputable, and not a promotion recommendation.

Promotion requires all of:

```text
at least 2 distinct eligible Candidate Trial Experience records
valid immutable StrategyDerivationCandidateV1 and semantic fingerprint binding
valid Candidate project binding to the current project
valid Derivation source provenance
source set still satisfies 3 records / 2 goals / 2 Policy profiles
fresh current trusted-portfolio fingerprint equals Candidate base fingerprint
proposed logical Strategy ID is absent from the current trusted portfolio
proposal is not an exact semantic duplicate of the current trusted portfolio
fewer than 8 promoted Derived Strategy identities currently exist
no prior terminal Derivation Decision for the Candidate
```

Eligibility does not require every Trial to pass Verification or complete its Task. Failed, denied, blocked, and incomplete factual outcomes remain review evidence.

A stale base portfolio makes the Candidate promotion-ineligible. SI v0.7 does not rebase, edit, merge, or automatically regenerate the Candidate. The Human may reject it or leave it inactive.

No threshold or positive outcome automatically promotes or rejects a Candidate.

## 16. Immutable `StrategyDerivationDecisionV1`

Derivation Decisions use a distinct immutable artifact because a new identity binds to a project portfolio rather than one Seed target.

Conceptually:

```text
StrategyDerivationDecisionV1

schemaVersion: 1
candidateId
candidateFingerprint
decidedAt
projectId

basePortfolioFingerprint
strategy
  strategyId
  kind

decision
  promoted | rejected

evidence
  sourceRecordIds[]
  trialRecordIds[]
```

The Harness copies the Candidate's exact 3..8 source IDs and a deterministic bounded set of 0..1024 fresh eligible Trial IDs (at least 2 for promotion). If more than 1024 eligible Trials exist, it records the first 1024 in stable recorded-time/record-ID order and reports the omitted count during review; it does not rank them. The Human chooses only the terminal command. Promotion requires section 15 eligibility; rejection may occur for any valid current-project Candidate without satisfying promotion eligibility.

Storage is separate and immutable:

```text
~/.pindie/projects/<project-id>/
  strategy-derivation-decisions/
    <candidate-id>.json
```

Exactly one terminal Decision may exist per Candidate. Atomic create-without-replacement is the final duplicate/conflict backstop. A Decision with a mismatched Candidate UUID/fingerprint, project, portfolio base, logical identity, kind, or evidence binding is invalid.

The frozen `StrategyRevisionDecisionV1` schema and store remain unchanged.

## 17. Promotion and normal trusted selection

A promoted Derived Strategy is a runtime projection of:

```text
valid immutable StrategyDerivationCandidateV1
+
valid immutable promoted StrategyDerivationDecisionV1
```

There is no second mutable Derived Strategy database and no materialized active copy. If either artifact or their binding is invalid, that Derived Strategy is not selectable.

Normal trusted context becomes conceptually:

```text
immutable Seeds
+
promoted Seed revisions
+
promoted Derived Strategy identities
```

A normal Run sees only the bounded validated promoted catalog. Inactive and rejected Derivation Candidates appear only in explicit lifecycle commands; an inactive Candidate is selectable only under its exact active Trial lease.

The project-local limit is:

```text
MAX_PROMOTED_DERIVED_STRATEGIES = 8
```

Only promoted Derived logical identities count toward this limit. The existing v0.6 maximum remains at most one promoted revision for each of the 7 Seeds. Therefore the maximum normal trusted revision entries are bounded conceptually to:

```text
7 immutable Seeds
+ at most 7 promoted Seed revisions
+ at most 8 promoted Derived identities
= at most 22 entries
```

The limit is checked against fresh valid trust artifacts at promotion and when constructing normal context. Reaching it does not retire, rank, or replace anything; further Derivation Candidates may remain inactive or be rejected, but cannot be promoted in SI v0.7.

Promotion means only that the exact Derived Candidate is trusted enough for explicit model-owned Policy declaration. It does not:

- select the Strategy automatically;
- make it a default approach or modifier;
- rewrite Seeds or promoted Seed revisions;
- mutate a current Run's Policy;
- imply superiority or causal value; or
- permit `/adapt` to target it.

## 18. Failure, lifecycle, and isolation rules

Self-Improvement artifacts and derived evaluation are not Task authority. Read, validation, packet, store, review, or trust-catalog failure must not:

- mutate `PindieState` or project Reality;
- change Task status, success criteria, open loops, or completion legality;
- change Verification truth or freshness;
- open or resolve a Human Gate;
- alter ordinary capability derivation or the Execution Gateway;
- alter Long Task Runtime, continuation, Session, or Pi behavior; or
- fabricate Experience.

Derivation operations fail closed to no Candidate creation, no Trial selection, no promotion, or no Derived catalog entry as appropriate. Immutable Seeds remain available under their existing contract. Existing v0.6 promoted revision trust continues to be validated by its existing artifacts rather than by v0.7 artifacts.

All Derivation packets, leases, command projections, evaluation profiles, and active catalogs are runtime-derived and never persisted in `PindieState`.

## 19. Explicit non-goals

SI v0.7 does not design or implement:

- automatic `/derive` triggers or ambient learning;
- automatic Strategy or Candidate generation;
- Strategy scoring, ranking, reward, or effectiveness tables;
- embeddings, vector databases, semantic retrieval, or similarity novelty scoring;
- task taxonomy, classification, clustering, or learned task representations;
- LLM-as-judge evaluation or a novelty/usefulness judge;
- automatic Trial assignment, promote, reject, or default selection;
- cross-project Strategy transfer;
- adaptation or revision of Derived Strategies;
- revision-on-revision ancestry;
- merge, split, retire, demote, supersede, archive, rebase, or rollback portfolio semantics;
- mutable active-revision pointers or a mutable Derived Strategy store;
- learned Skills or another Skill runtime;
- another evaluator/planner Agent;
- another inference-time loop; or
- Experience schema-v5.

## 20. Implemented slices

This architecture was implemented as four explicit, independently reviewable slices. The acceptance criteria below are the closed conformance record, not a plan for additional v0.7 capability. Each slice added focused contract tests and only the runtime behavior named for that slice.

### Slice A — Derivation Evidence + Candidate substrate

Ownership boundary:

```text
Harness
  → current trusted-portfolio projection/fingerprint
  → eligible schema-v4 source selection and sufficiency gate
  → runtime-only /derive lease and bounded packet
  → narrow policy.derive Candidate tool
  → immutable Derivation Candidate validation/store

Model
  → optional bounded proposal only

Human
  → explicit /derive entry only
```

Acceptance criteria:

1. The trusted portfolio and project-local fingerprint are deterministic, bounded, and reconstructed only from immutable Seeds and valid promotion artifacts.
2. Source selection enforces schema-v4, current project, ordinary attribution, explicit trusted-only final Policy, real final-Policy exposure, and total exclusion of Trial evidence.
3. The shown packet and any accepted Candidate source set each satisfy 3 distinct records, 2 exact goals, and 2 Policy Evidence Profile identities.
4. `/derive` is explicit, one-Run, mutually exclusive with adaptation/Trial leases, and may end with no Candidate.
5. The model tool accepts only the eight proposal fields; Harness-owned identity, project, portfolio, and provenance fields cannot be forged.
6. `StrategyDerivationCandidateV1` is immutable, bounded, project-local, structurally distinct from frozen Revision Candidates, and exact ID/semantic duplicates are rejected without similarity judgment.
7. No Derivation Candidate is selectable as Policy and no Trial, review, Decision, or normal trust behavior is introduced in this slice.
8. Existing State, Gateway, Verification, Task, Long Task, Pi, v0.6, and ordinary Run behavior remains unchanged.

### Slice B — Explicit Derivation Trial

Ownership boundary:

```text
Human
  → explicitly chooses one Candidate with existing /trial UX

Harness
  → resolves Candidate type and immutable bindings
  → owns one-Run Trial lease and exact Policy selector resolution
  → records ordinary schema-v4 facts

Model
  → optionally declares the exact Candidate Policy
  → performs the normal Task within unchanged authority
```

Acceptance criteria:

1. Unified `/trial <candidate-id>` resolves Revision and Derivation Candidates without combining their durable schemas or weakening existing Revision behavior.
2. A Derivation Trial is denied for stale portfolio/project binding, ID collision, terminal Decision, or conflicting lease.
3. The inactive Candidate selector is legal only under its exact active one-Run lease; ordinary Runs cannot resolve it.
4. Receiving or arming a Trial creates no attribution. Only exact final Candidate Policy declaration followed by non-policy execution yields eligible Trial evidence.
5. Schema-v4 records the derived logical ID, Candidate UUID/fingerprint, and `trial` status without schema-v5.
6. Trial settlement, cancellation, reload, Session replacement, and Long Task rollover clear the lease without changing Task or Pi semantics.
7. No Trial review, promotion, rejection, or normal Derived selection is introduced in this slice.

### Slice C — Derivation Trial Review

Ownership boundary:

```text
Harness
  → read-only revalidation and deterministic evidence inventories/cohorts

Human
  → interprets evidence; no trust command is executed by review
```

Acceptance criteria:

1. Unified `/trial-review <candidate-id>` dispatches to Revision or Derivation review by validated artifact kind.
2. Derivation Source Evidence and Candidate Trial Evidence remain separately named and separately traceable to exact Experience IDs.
3. No Seed baseline is fabricated; exact-goal cohorts appear only when both factual inventories naturally contain the same exact goal.
4. Review revalidates source sufficiency/provenance, Candidate binding, project, current portfolio match, logical-ID absence, capacity, eligible Trial count, and prior Decision state.
5. Promotion Eligibility requires every condition in section 15 and is presented only as readiness for Human review.
6. Negative evidence is retained and no score, rank, novelty, usefulness, superiority, or causal claim is produced.
7. Review is on-demand, read-only, non-persistent derived evaluation and cannot affect Task, Verification, Policy, or trust.
8. No Decision or normal Derived selection is introduced in this slice.

### Slice D — Human Trust + Normal Derived Strategy selection

Ownership boundary:

```text
Human
  → explicit /promote or /reject terminal choice

Harness
  → fresh eligibility enforcement
  → immutable Derivation Decision write
  → bounded normal trusted-catalog projection and exact selector resolution

Model
  → may explicitly select a promoted Derived Strategy in a later normal Run
```

Acceptance criteria:

1. Unified `/promote` and `/reject` preserve existing Revision behavior and write the correct distinct Decision artifact for a Derivation Candidate.
2. Promotion rechecks all section 15 conditions at the command boundary; rejection remains explicit and never fabricates promotion eligibility.
3. Duplicate/conflicting terminal Decisions fail closed and Candidate/Decision/project/portfolio/evidence bindings are immutable and auditable.
4. At most 8 Derived logical identities are promoted per project; reaching the bound adds no automatic retirement or replacement behavior.
5. A promoted Derived Strategy is reconstructed only from its immutable Candidate + promoted Decision and appears in bounded normal context with an exact selector.
6. Inactive/rejected Candidates remain unavailable; no promoted item becomes the default.
7. Normal schema-v4 Experience records the same Candidate UUID/fingerprint with `promoted` status after explicit selection.
8. `/adapt` remains Seed-targeted, and all State, Verification, Gateway, Human Gate, Task, Long Task Runtime, and Pi Agent Loop boundaries remain unchanged.

## 21. Architecture audit

Before any slice is accepted, inspect its design and diff for these failure modes:

```text
Frozen SI v0.6 mutation?
  → No v0.6 Candidate/Decision schema or Seed-targeted behavior is changed.

Hidden automatic learning?
  → Every derive, trial, review, promote, and reject entry is explicit Human action.

Duplicate source of truth?
  → Current trust comes only from Seeds + immutable Decisions/Candidates;
    Candidate manifests are bounded historical bindings, not active catalogs.

Unverifiable novelty claim?
  → Only exact structural duplicate rejection exists; passing it proves no novelty.

Unnecessary Experience churn?
  → Schema-v4 remains live; catalog binding and validation are extended instead.

Premature portfolio machinery?
  → No adaptation of Derived identities, ancestry, merge/split, rebase,
    retirement, ranking, or mutable active portfolio exists.
```

## 22. Closed v0.7 success contract

SI v0.7 closed with all four slices and real dogfood demonstrating:

```text
3+ eligible trusted-policy source Runs
across 2+ exact Task goals and 2+ Policy profiles
  ↓
explicit /derive
  ↓
optional immutable Derivation Candidate
  ↓
explicit Trial Run 1
  ↓
explicit Trial Run 2
  ↓
separate source/trial evidence review
  ↓
explicit Human promote or reject
  ↓
if promoted:
normal Run explicitly selects the Derived Strategy
  ↓
schema-v4 Experience records the same identity/fingerprint as promoted
```

This document is the closed architecture contract for that implemented path. It does not authorize capabilities outside SI v0.7.
