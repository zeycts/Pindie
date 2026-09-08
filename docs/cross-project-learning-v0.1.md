# Pindie Cross-Project Learning v0.1 — Strategy Trust Transfer

Status: authoritative architecture contract; implementation has not started.

This contract starts from the frozen Self-Improvement (SI) v0.6 and v0.7 contracts. It designs one personal-user capability only: expanding trust for one exact already-promoted project-local Derived Strategy from its source project to the user's projects generally. It does not design Cross-Project Strategy Derivation.

## 1. Goal and lifecycle

Cross-Project Learning v0.1 answers:

> How can Pindie safely transfer an already-learned exact Strategy revision across projects without erasing project boundaries or treating one repository's evidence as universal truth?

The bounded lifecycle is:

```text
valid project-local promoted Derived Strategy
        ↓
explicit Human trust-scope hypothesis
        ↓
immutable StrategyTrustScopeCandidateV1
        ↓
explicit one-Run Trial in target project A
        ↓
explicit one-Run Trial in distinct target project B
        ↓
project-local schema-v4 Experience in A and B
        ↓
bounded cross-project read-only evidence review
        ↓
deterministic Promotion Eligibility
        ↓
explicit Human promoted | rejected Decision
        ↓
if promoted:
user-global trusted projection of the same exact Strategy revision
```

Keep the transitions distinct:

```text
Scope Candidate = hypothesis that an existing exact revision may deserve wider trust
Cross-project Trial = one explicit experiment outside its source project
Scope Decision = Human-owned trust-scope transition
```

Promotion means only **trusted and selectable in the proposed scope**. It never means default, recommended, automatically selected, proven useful, proven superior, statistically validated, or causally effective.

## 2. Current-reality calibration

The implementation baseline inspected for this contract has these properties:

- `src/strategies.ts` owns seven immutable Seeds and their semantic fingerprints.
- `src/policy.ts` already represents exact non-Seed selections as `strategyId`, `kind`, `revisionIdentity`, `revisionFingerprint`, `revisionStatusAtRun`, and immutable semantics. `revisionStatusAtRun` is exactly `seed | trial | promoted`.
- `src/strategy-portfolio.ts` reconstructs a project-local portfolio on demand from Seeds and valid promotion artifacts. Its canonical manifest contains identity facts only and its fingerprint is version 1 over `{ fingerprintVersion, projectId, entries }`.
- v0.6 Revision Candidates and Decisions live under `strategy-candidates/` and `strategy-decisions/`.
- v0.7 Derivation Candidates and Decisions live under `strategy-derivation-candidates/` and `strategy-derivation-decisions/`.
- Candidate and Decision stores use canonical UUID filenames and immutable create-without-replacement writes. Trust catalogs are projections, not durable catalog files.
- The current live Experience implementation is in `src/run-experience.ts`, `src/experience-store.ts`, and `src/experience-evaluation.ts`; the requested legacy paths `src/experience.ts` and `src/evaluation.ts` do not exist on current main.
- `FileRunExperienceReader` reads only canonical `<uuid-v4>.json` records from a project's live `experience/` directory and accepts only schema-v4.
- `RunEvaluation.attributionEligible` excludes only `completed_before_run`; continuous final-Policy exposure is derived as tool calls after the last successful declaration of the final Policy.
- `TrialRuntime` already has one shared pending/active slot for Revision and Derivation Trials. A pending lease binds a native Session and next Agent Run; an active lease binds that Session and Agent Run generation. It is never persisted.
- `/trial`, `/trial-review`, `/promote`, and `/reject` already dispatch Revision and Derivation Candidates through distinct immutable schemas. `/strategies` reconstructs and presents the complete current trusted portfolio.
- Normal Run trust loading already isolates failures by falling back toward smaller coherent Policy projections; immutable Seeds remain available.

### 2.1 Current project identity and storage

`resolveProjectRoot(cwd)` first canonicalizes `cwd` with `realpath`. Inside Git it canonicalizes `git rev-parse --show-toplevel`; outside Git it uses canonical `cwd`. `getProjectId(canonicalProjectRoot)` is:

```text
sha256(UTF-8 canonicalProjectRoot string)
```

It is a 64-character lowercase hex value. It is stable for one canonical absolute root path, not a repository-content identity.

Current project-local durable layout is:

```text
~/.pindie/projects/<projectId>/
  state.json
  continuity.json
  experience/
  archive/experience-v3/          # historical, outside live evidence
  strategy-candidates/
  strategy-decisions/
  strategy-derivation-candidates/
  strategy-derivation-decisions/
```

For example, Pindie's current canonical root `/home/zey/dev/Pindie` maps to `930f5a6a11738d97d2d75d708214ddbc4fd56c69b263c4a39183384f652695f4`. Its real `delivery-checkpoints` source is Derivation Candidate `e75e2ba2-f658-48a4-8123-eaf7cbe9727d`, promoted by the matching v0.7 Decision, with revision fingerprint `sha256:0853c555cd835603483250eab3775325cfe32f0f8636d60eb186fb68373cf870`.

Cross-project v0.1 reuses this identity and layout reality. It does not pretend that `projectId` is a Git remote, commit, inode, or portable repository UUID.

## 3. Stable ownership and authority boundary

Ownership remains:

```text
Human
  → explicitly creates the trust-scope hypothesis
  → explicitly starts every cross-project Trial
  → interprets evidence
  → explicitly promotes or rejects user-global trust

Model
  → may declare the exact transferred Strategy during the armed Run
  → owns whether that cognitive prior fits the Task
  → never authors trust, scope, identity, status, or evidence provenance

Pindie Harness
  → resolves exact immutable source semantics and local trust
  → owns scope Candidate identity/binding and Trial leases
  → records ordinary project-local Experience
  → derives qualified cross-project evidence and eligibility
  → authors all Decision binding/evidence facts
  → reconstructs current trusted Policy projections

Pi
  → retains model invocation, native Session/Run lifecycle, tools, Skills,
    compaction, retries, follow-ups, and the LLM → Tool → Result → LLM loop
```

Cross-project trust is Policy only. It must never:

- mutate or become part of `PindieState`;
- grant Tool Surface or Execution Gateway capabilities;
- weaken project-mutation authority or freshness;
- change Verification truth or freshness;
- change Task admission, completion, replacement, or Human Gate legality;
- affect Long Task Runtime, continuation, rollover, or handoff;
- change Pi Session or Agent Loop behavior;
- become a Skill or a second Skill runtime;
- create a second Agent, planner, evaluator loop, or background learning worker; or
- change model weights.

A user-global Strategy remains only an advisory cognitive prior inside each current project's unchanged legal action space.

## 4. Orthogonal concepts and invariants

### 4.1 Strategy Identity

Strategy Identity answers **what exact cognitive Strategy revision this is**:

```text
strategyId
kind: approach | modifier
revisionIdentity
revisionFingerprint
immutable semantics
  summary
  useWhen[]
  avoidWhen[]
  principles[]
```

For a v0.7 Derived Strategy:

- `revisionIdentity` is the original `StrategyDerivationCandidateV1.candidateId`;
- `revisionFingerprint` remains `strategyDerivationCandidateSemanticFingerprint(candidate)`;
- the original Candidate proposal remains the immutable semantics and derivation-provenance authority; and
- its original `basePortfolio` may retain the exact project-local fingerprint that existed when it was derived.

### 4.2 Trust Scope

Trust Scope answers **where that exact revision is legal as normal trusted Policy**:

```text
seed-global
project:<projectId>
user-global
```

The categories are a runtime semantic model, not one retrofitted field:

- `seed-global` is derived from membership in the immutable Seed catalog. It is never persisted in a scope artifact.
- `project:<projectId>` is derived from an existing valid project-local promotion Candidate + Decision pair.
- `user-global` is derived only from the new valid promoted scope Candidate + Decision pair and its still-valid source binding.

Only the fixed `project` → `user-global` transition is persisted by v0.1 scope artifacts. Promoted Seed revisions remain project-local and are not valid transfer subjects.

### 4.3 Evidence Scope

Evidence Scope answers **which factual project-local Runs support Human review of a possible trust expansion**.

Experience ownership never moves:

```text
Experience ownership = project-local
```

Cross-project review may resolve qualified references into several project Experience stores. It never copies, mirrors, rewrites, or migrates Experience into a global store.

### 4.4 Required invariants

```text
Strategy Identity != Trust Scope != Evidence Scope
```

Therefore:

1. Evidence growth never changes Strategy identity or revision fingerprint.
2. Trust expansion never changes Strategy semantics, revision UUID, or derivation provenance.
3. Project-local and user-global `delivery-checkpoints` are the same exact revision when every identity field matches.
4. Scope artifacts reference source semantics; they never duplicate them as mutable authority.
5. Trust scope is not Policy selection. Selection remains explicit and model-owned per Run.
6. Evidence permits review, not a quality, universality, or causal claim.

## 5. Frozen SI v0.6 and v0.7 boundary

This contract does not change the meaning, schema, validation, or fingerprint rules of:

- `StrategyRevisionCandidateV1` / `StrategyRevisionDecisionV1`;
- `StrategyDerivationCandidateV1` / `StrategyDerivationDecisionV1`;
- Seed fingerprints, Revision Candidate fingerprints, or Derivation Candidate fingerprints;
- the project-local trusted-portfolio fingerprint version-1 algorithm;
- current project-local Experience schema-v4;
- one-Agent-Run Trial semantics; or
- `/adapt`, `/derive`, existing `/trial`, `/trial-review`, `/promote`, `/reject` semantics for v0.6/v0.7 artifacts.

Existing artifacts remain immutable and valid. No old Candidate `basePortfolio` is rewritten, re-fingerprinted, migrated, or interpreted as current authority. Historical portfolio fingerprints remain evidentiary snapshots.

v0.1 transfer subjects are exactly:

```text
valid project-local promoted StrategyDerivationCandidateV1 revisions
```

Excluded subjects include Seeds, promoted Seed revisions, inactive/rejected Derived Candidates, malformed or stale local trust, and arbitrary model-described Strategies. Excluding promoted Seed revisions avoids unresolved same-logical-Seed precedence and does not reopen v0.6 revision semantics.

## 6. Global durable namespace

User-level scope facts live outside every project namespace:

```text
~/.pindie/global/
  strategy-scope-candidates/
    <scope-candidate-id>.json
  strategy-scope-decisions/
    <scope-candidate-id>.json
```

These are the only new durable global stores in v0.1. They follow existing conventions:

- canonical lowercase UUID-v4 filenames;
- strict exact-field validation;
- immutable create-without-replacement writes;
- deterministic directory ordering;
- malformed artifacts are rejected, never repaired or normalized into a new identity; and
- Candidate and Decision are separate artifacts.

v0.1 must not create a global Experience store, mutable global Strategy catalog, active-Strategy pointer, global portfolio snapshot, copied semantics store, evidence index, or message queue. The user-global trusted set remains reconstructable from immutable scope artifacts and project-local authorities.

A short-lived global writer lock may appear beneath `~/.pindie/global/` during a write critical section. It is runtime concurrency control, not durable semantic state or an additional store; section 16 defines it.

## 7. Source Strategy binding and resolution

### 7.1 Exact source binding

Every scope artifact binds the source revision by:

```text
sourceProjectId
strategyId
kind
revisionIdentity
revisionFingerprint
```

`revisionIdentity` is the exact source `StrategyDerivationCandidateV1.candidateId`; no second Strategy UUID is generated. `sourceProjectId` identifies the authoritative project namespace. The artifact type is fixed by this schema: only a v0.7 Derivation Candidate may resolve.

### 7.2 Strict resolution algorithm

Given the source binding, the Harness must:

1. validate `sourceProjectId` as lowercase 64-hex and the revision identity/fingerprint formats;
2. read exactly:

   ```text
   ~/.pindie/projects/<sourceProjectId>/
     strategy-derivation-candidates/<revisionIdentity>.json
     strategy-derivation-decisions/<revisionIdentity>.json
   ```

3. strictly validate the frozen v0.7 Candidate without requiring a currently mounted source root;
4. require Candidate `projectId = sourceProjectId`;
5. require Candidate `candidateId`, `proposal.strategyId`, and `proposal.kind` to match the scope binding;
6. recompute the frozen Derivation Candidate fingerprint and require the exact `revisionFingerprint`;
7. validate the matching frozen v0.7 Decision against that Candidate and require `decision = promoted`;
8. reject a same-ID Revision Candidate in the source namespace as existing cross-store ambiguity; and
9. reconstruct the source namespace's project-local Derived trust sufficiently to establish that this exact revision remains a valid locally promoted entry with no project-local logical-ID conflict.

The source Candidate alone is not trust. Candidate + matching promoted source Decision + coherent local projection establish the current `project:<sourceProjectId>` trust scope.

### 7.3 Missing or stale source

If the Candidate, source Decision, or source namespace is missing, malformed, inaccessible, manually replaced, internally conflicting, or no longer proves local promotion:

- Candidate creation and new cross-project Trials are denied;
- Promotion Eligibility is false;
- an already-promoted user-global Strategy is omitted from user-global trust; and
- the global artifacts remain immutable historical facts but are not authority for semantics or trust.

The Harness must not reconstruct semantics from Experience, the scope Candidate, old packets, Decision display text, or model claims. Restoring the exact valid source artifacts restores resolvability; no second Decision is created.

This dependency is an explicit v0.1 limitation. v0.1 does not invent a content-addressed portable Strategy store. Portability independent of the source project namespace is deferred.

## 8. `StrategyTrustScopeCandidateV1`

A scope Candidate is a trust-expansion hypothesis, not a Strategy Candidate and not Strategy semantics.

### 8.1 Exact schema

```text
StrategyTrustScopeCandidateV1

schemaVersion: 1
candidateId                    # canonical lowercase UUID-v4
createdAt                      # valid timestamp, at most 64 characters

sourceStrategy
  sourceProjectId              # lowercase 64-hex projectId
  strategyId                   # frozen source proposal logical ID
  kind                         # approach | modifier
  revisionIdentity             # exact source Derivation Candidate UUID-v4
  revisionFingerprint          # exact lowercase sha256:<64-hex>

currentTrustScope: project
proposedTrustScope: user-global
```

The effective current scope is `project:<sourceStrategy.sourceProjectId>`. The literals are intentionally closed: v0.1 supports no other transition.

The artifact does **not** contain summary, `useWhen`, `avoidWhen`, principles, source Experience IDs, Trial Experience IDs, scores, recommendations, or copied Decision prose.

### 8.2 Candidate fingerprint

`strategyTrustScopeCandidateFingerprint` is derived, not persisted in the Candidate:

```text
sha256(canonical JSON of {
  fingerprintVersion: 1,
  sourceStrategy: {
    sourceProjectId,
    strategyId,
    kind,
    revisionIdentity,
    revisionFingerprint
  },
  currentTrustScope: "project",
  proposedTrustScope: "user-global"
})
```

Canonical field order is exactly the order above; strings are used byte-for-byte after strict validation. `candidateId` and `createdAt` are excluded, matching the existing separation between artifact occurrence and semantic/binding fingerprint. This fingerprint identifies the exact scope hypothesis and source binding; it is not the Strategy revision fingerprint.

### 8.3 Creation rules

Creation is an explicit Human operation in the source project. Under the global writer lock, the Harness supplies `candidateId`, `createdAt`, every source binding fact, and both scope literals. It accepts no model-authored source identity or semantics.

Creation requires:

- the current project ID equals `sourceProjectId`;
- strict section 7 source resolution succeeds;
- the source is a valid promoted Derived Strategy, not a Seed revision;
- the logical ID does not collide with an immutable Seed;
- no user-global revision already owns that logical ID;
- no existing scope Candidate has the same candidate fingerprint; and
- no ambiguous global artifact exists.

Exactly one v0.1 scope Candidate may exist for one exact source revision and `project` → `user-global` transition, including after rejection. Rejection is not falsification, but v0.1 deliberately has no reconsideration/reopen lifecycle.

Candidate creation does not mutate the source Candidate, source Decision, project-local trust, Policy, Experience, or `PindieState`.

## 9. Qualified cross-project Experience references

### 9.1 Exact locator

A Decision never stores an unqualified record ID. Its locator is:

```text
CrossProjectExperienceRefV1

projectId                      # lowercase 64-hex target project identity
recordId                       # canonical lowercase <uuid-v4>.json filename
recordFingerprint              # lowercase sha256:<64-hex>
```

`recordFingerprint` is required. `projectId + recordId` prevents cross-project record-ID confusion; the fingerprint prevents a manually replaced record at the same path from silently satisfying an earlier binding.

The fingerprint is:

```text
sha256(canonical JSON of parseRunExperience(record))
```

The schema-v4 parser's strict, fully materialized canonical object is serialized with the fixed schema-v4 field order and existing array order. Whitespace or JSON object key order in the source file does not change the fingerprint; any factual schema-v4 content change does. This fingerprint is only a reference-integrity binding and does not change Experience identity or schema.

The original file at:

```text
~/.pindie/projects/<projectId>/experience/<recordId>
```

remains the sole Experience authority. The ref is not a copy, mirror, migration, or global record.

### 9.2 Resolution

Resolution directly opens the project-qualified path, strictly parses schema-v4, recomputes the record fingerprint, and requires exact equality. Missing, duplicate, malformed, unsupported-schema, or fingerprint-mismatched records are unresolved. A ref never falls back to another project or searches by bare UUID.

## 10. Explicit cross-project Trial

### 10.1 Entry conditions

A Human may explicitly arm one open scope Candidate in a target project only when:

- the source Strategy and source local trust freshly resolve;
- no scope Decision exists;
- target `projectId != sourceProjectId`;
- target trusted portfolio reconstruction is coherent;
- the target has no project-local trusted Derived Strategy with the same logical ID, whether same or different revision;
- the source logical ID does not collide with a Seed;
- the scope Candidate is not in the normal target portfolio; and
- no adaptation, derivation, Revision Trial, Derivation Trial, or scope Trial lease is pending/active.

The source project itself is not a cross-project Trial target. A project that already trusts the exact revision locally needs no transfer Trial; a project that trusts a different revision under the same logical ID is a conflict, not an experiment.

There is no automatic Trial assignment, ambient injection, or model-triggered transfer.

### 10.2 Runtime lease

The existing shared `TrialRuntime` concept gains a tagged scope-Transfer lease; it does not gain a second Trial runtime or durable union artifact.

Pending lease:

```text
scopeCandidateId + scopeCandidateFingerprint
exact source Strategy binding
validated source artifact snapshot
native sessionId
agentRunGeneration: null
```

Active lease adds the exact next `agentRunGeneration`. The Harness re-resolves the global Candidate, source Candidate, source promotion, target project, and collision facts before binding and again when resolving the Policy selector.

Lifetime remains exactly one Agent Run. The lease clears on settlement, cancellation, failed binding, Session replacement/reload, process restart, or Long Task automatic rollover. A fresh rollover Run never inherits it.

### 10.3 Trial Packet and Policy declaration

The bounded packet may include:

- scope Candidate ID/fingerprint and `project` → `user-global` hypothesis boundary;
- source and target project IDs;
- exact source Strategy ID/kind/revision identity/fingerprint;
- source Candidate hypothesis and immutable semantics resolved at packet construction;
- the exact compact selector already supported by `pindie_policy_set`; and
- explicit text that Trial is optional, one-Run, non-trust, and non-causal.

Including resolved semantics in an ephemeral Trial Packet is not a second durable authority. Every use is bound back to the source artifact.

The allowed selector remains:

```text
{
  strategyId,
  revisionIdentity,
  revisionFingerprint
}
```

The Harness, never the model, supplies exact kind, semantics, and `revisionStatusAtRun = trial`. If the model does not successfully declare that exact selector in the correct role, no transferred-Strategy attribution exists. Receiving or arming the packet alone never fabricates attribution.

A scope Trial does not add the Strategy to the target's normal trusted portfolio. Other exact trusted Strategies may still be selected in the same Policy under their ordinary rules.

### 10.4 Coexistence with `/trial`

This is semantic unification, not durable-schema unification:

```text
TrialSubject = Revision Candidate | Derivation Candidate | Trust Scope Candidate
```

All three use one runtime Trial lease and one-Run semantics. Their source artifacts, validators, eligibility rules, and Decisions remain distinct.

Existing local `/trial <candidate-uuid>` behavior stays unchanged. Scope Candidates use an explicit namespaced command value such as `scope:<scope-candidate-uuid>` supplied by completion. The prefix prevents guessing between a project-local Candidate UUID and a global scope Candidate UUID. No common persisted Candidate wrapper is introduced.

## 11. Schema-v4 Trial attribution remains unchanged

Schema-v4 can already represent every fact required for the Trial selection:

```text
strategyId
kind
revisionIdentity
revisionFingerprint
revisionStatusAtRun: trial
semantics
```

A cross-project Trial records the original source Derivation Candidate UUID and fingerprint, not the scope Candidate UUID. This is necessary because the Trial tests the exact Strategy revision; the scope Candidate is only its trust hypothesis.

No `trustScope`, `sourceProjectId`, `scopeCandidateId`, `origin`, or transfer flag is added to Experience. Project qualification comes from the owning Experience directory and cross-project ref. Exact source resolution establishes the tested semantics. Historical local Trial and promoted records remain valid.

`revisionStatusAtRun = promoted` also remains sufficient for normal use after user-global promotion. Both project-local and user-global trust make the same exact Strategy revision normally selectable. Scope is current trust-projection metadata, not Strategy identity and not a v0.1 evaluation distinction.

Consequently, schema-v4 does not preserve historical trust origin by itself. v0.1 does not require that fact for Trial eligibility or normal-use evaluation: transfer evidence must have `trial` status before terminal scope promotion, while later normal use needs exact revision identity and `promoted` status only. A future requirement for historical scope-at-Run would require a separately justified contract; it is not schema-v5 creep here.

## 12. Cross-project evidence review and eligibility

### 12.1 Read-only projection

Review is anchored by one valid open scope Candidate. It enumerates known canonical project namespaces under `~/.pindie/projects/` in deterministic project-ID order, reads each original live schema-v4 Experience store, and selects records matching the exact source revision. It never writes to those projects.

The projection is bounded:

- one scope Candidate and one exact Strategy identity per review;
- at most 1,024 eligible refs may be retained for a Decision;
- aggregate counts cover all successfully scanned matching records;
- Human presentation shows bounded IDs/details and explicit omitted counts; and
- records are streamed/aggregated rather than copied into a global archive.

If complete deterministic scanning or the selected reference set cannot be established, Promotion Eligibility is false. Review may still present the bounded facts it did establish and the failure reason. There is no background scan, index, or persisted review result.

### 12.2 Per-Run eligibility

One scope-Transfer Trial Experience is eligible only when all are true:

1. it is a valid live schema-v4 Experience;
2. its `CrossProjectExperienceRefV1` uniquely and exactly resolves;
3. target `projectId != sourceProjectId`;
4. `RunEvaluation.attributionEligible = true`;
5. final Policy contains the exact `strategyId`, `kind`, `revisionIdentity`, and `revisionFingerprint` in the correct role;
6. recorded immutable semantics exactly equal the freshly resolved source Candidate proposal;
7. `revisionStatusAtRun = trial`;
8. `finalPolicyExposureCalls > 0`, proving continuous real non-policy execution after the final Policy activation;
9. the source Strategy binding and project-local source promotion remain valid; and
10. no malformed or ambiguous source/global binding exists.

The Trial lease itself is intentionally not persisted. Exact status-at-Run is a Harness-authored factual consequence of the only legal scope-Trial selector path; the record need not persist a second lease receipt.

Multiple eligible Runs in one target project count as multiple Runs but only one distinct target environment. Duplicate qualified refs count once. A bare record UUID never counts.

### 12.3 Negative evidence

Review includes every valid exact-revision Trial record found in the bounded scan, including records that are ineligible because attribution or post-activation exposure is absent. Eligible records retain factual failed Verification, incomplete Task, blockers, questions, tool errors, and denied calls. Promotion does not require positive outcomes.

No score, reward, rank, embedding, semantic similarity, task taxonomy, LLM judgment, counterfactual, statistical claim, or causal claim is derived.

## 13. Cross-project Promotion Eligibility

Promotion Eligibility means only:

> enough auditable cross-environment evidence exists for a Human to review user-global trust.

It requires all of:

```text
eligible exact scope-Transfer Trial Runs >= 2
and
distinct eligible target projectIds >= 2
```

plus:

- valid immutable `StrategyTrustScopeCandidateV1` and scope-candidate fingerprint;
- exact source Candidate identity/fingerprint/semantics resolution;
- source project-local promoted trust still valid;
- source project excluded from target-project count;
- every selected project-qualified Experience ref resolvable and freshly eligible;
- no prior terminal Scope Decision;
- fewer than 8 currently valid user-global Derived Strategies;
- current user-global logical identity available;
- no user-global same-logical-ID different-revision entry;
- no known valid project-local promoted Derived Strategy under that logical ID with a different exact revision;
- no Seed logical-ID collision;
- no global/local or cross-store ambiguity; and
- complete global Candidate/Decision and relevant project evidence reads for the gate.

The conflict scan covers every canonical project namespace visible under the user's Pindie projects directory at the decision boundary. Any unreadable trust namespace that prevents determining same-ID local trust makes promotion ineligible; the slow Human trust path fails closed rather than assuming absence.

The source project never satisfies either distinct target project. There is no exception in v0.1: environment diversity requires two other project identities.

Eligibility does not require Verification passed, Task completion, zero errors, or evidence that the Strategy helped. No threshold triggers an automatic Decision.

## 14. `StrategyTrustScopeDecisionV1`

### 14.1 Exact schema

```text
StrategyTrustScopeDecisionV1

schemaVersion: 1
candidateId
candidateFingerprint          # derived scope Candidate fingerprint
decidedAt                     # Harness timestamp, at most 64 characters

sourceStrategy
  sourceProjectId
  strategyId
  kind
  revisionIdentity
  revisionFingerprint

currentTrustScope: project
proposedTrustScope: user-global

decision: promoted | rejected

evidence
  trialRefs[]                 # CrossProjectExperienceRefV1, 0..1024
```

For `promoted`, `trialRefs` must contain at least two eligible refs and satisfy the two-distinct-target-project gate. For `rejected`, zero or more currently resolved eligible refs may be recorded; rejection never claims that evidence falsified the Strategy.

The Harness supplies every field except the Human's explicit `promoted` or `rejected` choice. Refs are unique and sorted canonically by `projectId`, then `recordId`, then `recordFingerprint`. The Decision repeats exact source/scope binding facts intentionally so validation can detect a mismatched Candidate; it does not repeat Strategy semantics.

### 14.2 Binding and terminal semantics

A valid Decision must:

- strictly validate its own exact fields;
- resolve the matching scope Candidate by `candidateId`;
- recompute and match `candidateFingerprint`;
- exactly match Candidate source and scope fields; and
- contain only valid qualified reference shapes.

Exactly one terminal Decision exists per scope Candidate. The store uses atomic create-without-replacement. A structurally valid, correctly Candidate-bound Decision remains terminal even if source or evidence later becomes unavailable; this prevents a second conflicting Human Decision. However, a `promoted` Decision projects user-global trust only while source resolution and every persisted promotion evidence ref remain valid and eligible.

Promotion rechecks all section 13 gates under the global writer lock immediately before the immutable write. Rejection requires a valid Candidate and source binding but does not require Promotion Eligibility.

Rejection means only that the Human declined this trust expansion. It is not experimental falsification, global demotion, source-project rejection, or mutation of the Strategy.

## 15. User-global trusted projection

### 15.1 No mutable global catalog

One user-global trusted Derived Strategy exists at runtime only when this complete chain validates:

```text
valid StrategyTrustScopeCandidateV1
+
valid matching promoted StrategyTrustScopeDecisionV1
+
valid immutable source StrategyDerivationCandidateV1
+
valid matching promoted source StrategyDerivationDecisionV1
+
resolvable eligible Decision evidence refs
        ↓
user-global trusted exact Derived Strategy revision
```

The source Candidate supplies semantics. Scope Candidate and Decision supply only trust expansion and evidence binding. No materialized global Strategy copy or portfolio JSON exists.

A rejected Decision contributes no trust. An inactive Candidate contributes no normal selector. A promoted-but-stale chain contributes no current global trust.

### 15.2 Current project portfolio

Conceptually:

```text
TrustedStrategyPortfolio(Project X)
  = immutable Seeds
  + valid user-global trusted Derived Strategies
  + Project X valid promoted Seed revisions
  + Project X valid promoted Derived Strategies
```

Projection occurs in that order conceptually, but it defines no precedence. All entries are validated as one collision-free identity set before use.

Normal Runs receive bounded exact selectors for global entries. The Harness resolves kind, semantics, identity, and `revisionStatusAtRun = promoted`. The model still supplies only Seed shorthand or a compact exact selector and may ignore every global Strategy.

Global trust does not inject, rank, recommend, or select a Strategy. Global and local entries have equal advisory status once valid; neither is preferred.

## 16. Portfolio fingerprints, collisions, bounds, and concurrency

### 16.1 Fingerprint compatibility

The canonical v0.7 manifest remains an **identity manifest**, not a trust-scope manifest. A user-global Derived Strategy uses the existing manifest origin:

```text
origin: promoted-derived
strategyId
kind
revisionIdentity
revisionFingerprint
```

Trust origin is held in a separate runtime presentation/resolution projection and is excluded from the canonical manifest and fingerprint. This follows the central invariant: changing trust scope must not change Strategy identity.

The project-local fingerprint algorithm and `fingerprintVersion: 1` remain unchanged:

```text
sha256(canonical JSON of {
  fingerprintVersion: 1,
  projectId,
  entries: canonical deduplicated identity manifest
})
```

A project's **current** fingerprint naturally changes when a new exact global identity becomes trusted there. If the exact identity was already trusted locally, deterministic deduplication leaves the identity manifest and fingerprint unchanged.

Historical v0.7 Candidate `basePortfolio` entries and fingerprints are never rewritten. Validation recomputes each historical fingerprint from its stored version-1 manifest and project ID, exactly as today. A historical fingerprint is evidence of the portfolio at derivation time, not authority over current trust. Future project-local `/derive` may capture the then-current expanded identity manifest without changing the frozen v0.7 artifact schema or fingerprint rule; source resolution must follow each promoted-derived entry to its actual immutable local or global trust chain.

### 16.2 Same-ID rules

Case A:

```text
global delivery-checkpoints exact revision A
local delivery-checkpoints exact revision A
```

The canonical tuple `(strategyId, kind, revisionIdentity, revisionFingerprint)` is identical. The portfolio contains one `promoted-derived` manifest entry. Runtime trust metadata records both `user-global` and `project:<projectId>` origins for presentation. Semantics must resolve byte-for-byte identically; otherwise it is not Case A and fails closed.

Case B:

```text
global delivery-checkpoints exact revision A
local delivery-checkpoints exact revision B
```

There is no local-over-global or global-over-local choice. Prevention occurs at both mutation boundaries:

- global scope promotion is denied if any known valid local B exists; and
- future project-local Derived promotion is denied if valid global A exists.

If conflict appears through manual artifact changes, missing prior visibility, or restored old data, the user-global layer is unavailable in that project and a conflict is reported. The coherent project-local portfolio and immutable Seeds remain available; omitting the optional global layer is failure isolation, not a precedence rule. No normal selector for A is offered there until the conflict is removed by restoring coherent immutable facts outside v0.1.

Any user-global Derived logical ID matching an immutable Seed is invalid everywhere. Multiple valid promoted global scope chains with one logical ID are also an invalid global projection, even when exact revision is the same; v0.1 permits only one terminal global trust chain per exact source transition.

### 16.3 Capacity

The conservative v0.1 bound is:

```text
MAX_USER_GLOBAL_DERIVED_STRATEGIES = 8
```

This is one new single source of truth. Existing bounds remain:

```text
Seeds                              = 7
MAX_PROMOTED_STRATEGY_REVISIONS    = number of Seeds = 7
MAX_PROMOTED_DERIVED_STRATEGIES    = 8 per project
```

The total current-project identity-manifest bound is derived, never repeated as an independent literal:

```text
MAX_TRUSTED_PORTFOLIO_ENTRIES
  = Seeds
  + MAX_PROMOTED_STRATEGY_REVISIONS
  + MAX_PROMOTED_DERIVED_STRATEGIES
  + MAX_USER_GLOBAL_DERIVED_STRATEGIES
  = 30 before exact-identity deduplication
```

Review, promotion, catalog construction, Candidate manifest validation, and model-context rendering import these bounds from their owning constants. Reaching a bound causes no ranking, retirement, replacement, or automatic rejection.

Expanding the accepted current manifest bound from 22 to the derived 30 does not invalidate an old v0.7 Candidate whose stored manifest had at most 22 entries.

### 16.4 Process safety

Two runtime leases are required:

1. **Trial lease** — the existing Session + next/current Agent Run generation lease from section 10; lifetime at most one Agent Run and never persisted.
2. **Global writer lock** — one user-level inter-process critical-section lease for scope Candidate creation and terminal Decision creation. It serializes fresh duplicate, logical-ID, capacity, conflict, and terminal checks with the immutable write.

The global writer lock should reuse the existing owned lock-directory discipline: random owner token, PID, acquisition time, bounded retry, conservative dead-owner reclaim, and owner-checked release. It lives only for one command's read-check-write critical section, never for a Trial, review, Task, Session, or process lifetime. Atomic file creation remains the final no-replacement backstop.

Read-only review and portfolio projection need no long-lived lock. They validate a coherent snapshot and discard it if artifacts change during reconstruction.

## 17. Human UX and command dispatch

Human-facing UX is meaning-first and completion-driven; Humans do not copy UUIDs.

### 17.1 One necessary new entry command

Existing commands have no semantic operation that creates a trust-scope hypothesis: `/strategies` is read-only, while `/trial` requires an existing Candidate. Therefore v0.1 adds one explicit command, provisionally named:

```text
/trust-transfer <local-promoted-derived-strategy>
```

Its completion lists only valid transferable Derived Strategies trusted in the current source project, with logical ID, kind, short exact revision identity, and current scope. It creates one immutable global Scope Candidate and does not start a Trial or Run. The command name may change during Slice A only if the same meaning remains unambiguous; the semantic operation and artifact contract may not.

`/strategies` remains the inspection surface. Before transfer it labels a source entry conceptually:

```text
delivery-checkpoints · promoted e75e2ba2
  project-local trusted Derived Strategy
  transferable to a user-global trust hypothesis
```

### 17.2 Existing lifecycle commands

The existing commands safely dispatch the rest through explicit subject namespacing:

```text
/trial scope:<candidate-id>
/trial-review scope:<candidate-id>
/promote scope:<candidate-id>
/reject scope:<candidate-id>
```

Completion values carry the opaque namespaced ID; labels show Strategy meaning and a short source-project ID. Existing bare local Candidate UUIDs retain frozen behavior. Unknown prefixes, duplicate IDs, malformed global artifacts, or a value resolving to more than one subject fail closed.

- `/trial` completion shows open scope Candidates eligible in the current target project.
- `/trial-review` shows source binding, each target project's evidence inventory, negative evidence, distinct-project count, and gate reasons.
- `/promote` shows only Scope Candidates currently eligible for Human global trust review.
- `/reject` shows valid open Scope Candidates without claiming eligibility.

The Human commands resolve fresh authority at execution; completion visibility is not authorization.

### 17.3 Trusted presentation

After promotion, `/strategies` in another project presents one exact entry conceptually as:

```text
delivery-checkpoints · global e75e2ba2
  user-global trusted Derived Strategy
```

In the source project, exact same-revision deduplication may show:

```text
Trust: user-global + project-local
```

Trust labels and source-project abbreviations are presentation only. They do not enter Strategy identity, Policy selectors, Experience, or portfolio fingerprints. `/strategies` continues to show all coherent current trusted Strategies, not only global entries.

## 18. Project movement, deletion, and recreation

v0.1 guarantees only identity by the current canonical absolute root-path hash:

- **same canonical root path** → same `projectId`;
- **repository moved to another path** → new `projectId` and a separate Pindie project namespace;
- **separate worktree root paths** → separate project IDs;
- **source repository no longer mounted/deleted** → source artifacts can still resolve directly by old `sourceProjectId` if its `~/.pindie/projects/<projectId>/` namespace remains readable;
- **source Pindie namespace deleted/inaccessible** → transferred trust fails closed;
- **repository recreated at the same canonical path** → it reuses the same path-derived `projectId`; v0.1 cannot distinguish reincarnation by Git content or remote;
- **symlink-only path spelling changes** → `realpath` normally collapses them to the same canonical root.

No trust decision depends on a display path. Paths may be shown only from current runtime context. Scope artifacts persist project IDs, not path labels.

v0.1 does not migrate project namespaces after a move, infer repository sameness, or add a portable project identity. A moved source continues to support existing global trust only through the old namespace; the new path does not silently become the source authority.

## 19. Restart and lifecycle semantics

Survives process restart:

- source project v0.7 Candidate and Decision;
- every original project-local schema-v4 Experience file;
- immutable global Scope Candidates;
- immutable global Scope Decisions; and
- user-global trust reconstructed from those artifacts when every binding still validates.

Does not survive restart:

- pending/active Trial leases;
- global writer-lock ownership after safe dead-owner handling;
- packets, command completions, review projections, eligibility results;
- active trusted portfolios/catalogs or selector-resolution caches;
- model Policy Snapshot; and
- any presentation labels.

No Trial is resumed after restart. The Human must explicitly arm another one.

## 20. Failure isolation

Prefer loss of optional transferred trust over ambiguity.

### 20.1 Failure surface

- A malformed or unreadable scope Candidate/Decision enumeration makes the **user-global layer** unavailable for that reconstruction; it does not invalidate project-local artifacts.
- A missing/malformed source or promoted source Decision invalidates only scope operations and user-global trust that depend on it.
- An unresolved Decision evidence ref makes that promoted global trust chain stale and therefore unavailable.
- A target local/global same-ID different-revision collision omits the global layer in that target and reports conflict; it does not silently shadow either revision.
- An incomplete review, changing read snapshot, stale candidate, full capacity, or unreadable conflict namespace makes Promotion Eligibility false.
- Candidate/Decision write failure persists no replacement and changes no trust.
- Trial packet or selector-resolution failure clears/denies that optional Trial path and does not fabricate Experience attribution.

### 20.2 Protected surfaces

These failures must not:

- make immutable Seeds unavailable;
- corrupt or mutate `PindieState`;
- corrupt, copy, or rewrite project-local Experience;
- mutate source/local Candidate or Decision artifacts;
- remove coherent project-local promoted trust;
- change Task, Verification, Human Gate, Gateway, project mutation, Long Task, Pi Session, or Remote Companion authority; or
- block ordinary non-Policy Task execution.

When global projection fails, normal Policy availability falls back to the largest coherent current project-local projection using the existing component-isolation posture, with a bounded diagnostic. This is failure isolation, not implicit precedence.

## 21. Explicit non-goals

Cross-Project Learning v0.1 does not design or implement:

- cross-project `/derive` or any new Strategy identity from multi-project evidence;
- a global Experience store, Experience copy, mirror, migration, or index;
- automatic Strategy transfer, Candidate creation, Trial, promotion, or rejection;
- promoted Seed revision globalization;
- global Strategy revision or adaptation;
- local-over-global or global-over-local precedence;
- Strategy ancestry, merge, split, supersession, retirement, demotion, rollback, or rebase;
- a portable/content-addressed Strategy semantics store;
- repository identity migration or movement recovery;
- semantic similarity, embeddings, Strategy ranking/scoring, rewards, task taxonomy, causal inference, or LLM-as-judge;
- model-weight learning;
- global defaults or recommendations;
- fleet, team, organization, or multi-user sharing; or
- any runtime implementation in this architecture Task.

The contract is personal-user only.

## 22. Implementation slices

No Slice is implemented by this document. Each future Slice must use focused contract tests and preserve the earlier slices' boundaries.

### Slice A — Trust Scope substrate

Deliver:

- strict `StrategyTrustScopeCandidateV1` and `StrategyTrustScopeDecisionV1` validators/types without changing frozen artifacts;
- immutable global Candidate/Decision stores under `~/.pindie/global/`;
- project-ID-addressed source Candidate/Decision resolution;
- derived scope-candidate fingerprint and exact source binding;
- explicit Human scope-hypothesis creation;
- user-global writer lock and no mutable catalog.

Acceptance criteria:

1. Only a valid project-local promoted Derived Strategy can produce a scope Candidate.
2. Source semantics are never copied into the scope artifact; the original v0.7 Candidate remains authority.
3. Missing, malformed, inaccessible, wrong-project, wrong-kind, wrong-ID, wrong-fingerprint, rejected, or ambiguous source facts fail closed.
4. Candidate and Decision paths are user-global, canonical, immutable, and create-without-replacement.
5. Duplicate exact scope hypotheses and Seed/promoted-Seed subjects are rejected.
6. The global lock serializes read-check-write and leaves no semantic state.
7. No Trial, Experience change, global trusted projection, or State/authority change exists yet.

### Slice B — Explicit cross-project Trial and attribution

Deliver:

- scope subject dispatch through the existing shared Trial runtime;
- explicit target-project Trial arming and bounded packet;
- fresh source/target/collision validation at arm, bind, and selector resolution;
- exact compact selector resolution to the source Candidate semantics with status `trial`;
- unchanged schema-v4 project-local Experience attribution.

Acceptance criteria:

1. One scope Trial binds exactly one native Session and Agent Run generation and clears under every existing one-Run condition.
2. Source project, already-local same identity, same-ID conflict, terminal Decision, stale source, and concurrent SI leases are denied.
3. The scope Candidate never enters normal target trust.
4. Packet receipt creates no attribution; only successful exact declaration followed by real non-policy exposure can become eligible.
5. The Experience record contains the source Strategy identity/fingerprint/semantics and `trial`, not scope fields or copied Experience.
6. Existing Revision/Derivation `/trial` behavior and schema-v4 parsing remain unchanged.
7. Restart and Long Task rollover never inherit the Trial.

### Slice C — Cross-project evidence review and Promotion Eligibility

Deliver:

- strict `CrossProjectExperienceRefV1` and canonical record fingerprint;
- bounded read-only projection across project-local Experience stores;
- exact transferred-revision Trial matching and exposure validation;
- per-project factual inventories, negative evidence, and deterministic gate;
- fresh global/local collision, source trust, capacity, and terminal checks.

Acceptance criteria:

1. Every evidence item is project-qualified, fingerprint-bound, directly resolvable to valid live schema-v4, and never copied globally.
2. Eligibility requires at least two eligible Runs in at least two distinct non-source target projects.
3. Exact identity, kind, semantics, trial status, ordinary attribution, and post-activation exposure are all required.
4. Missing refs, incomplete reads, stale source trust, collision, ambiguity, capacity exhaustion, or prior Decision make eligibility false.
5. Negative outcomes remain visible; no score, rank, reward, similarity, universality, superiority, or causal claim appears.
6. Review is on-demand, bounded, read-only, and non-persistent.
7. No Scope Decision or normal global selection exists yet.

### Slice D — Human user-global trust and normal projection

Deliver:

- explicit Human scope `/promote` and `/reject` dispatch;
- fresh lock-protected eligibility and immutable Scope Decision write;
- valid user-global Derived projection from complete source/scope/evidence chain;
- current-project portfolio composition, exact dedupe, fail-closed conflicts, and bounded context;
- `/strategies` trust-origin presentation;
- real normal-use dogfood in projects other than the source.

Acceptance criteria:

1. The Human supplies only `promoted | rejected`; the Harness supplies all identity, scope, time, and evidence facts.
2. Exactly one immutable terminal Decision exists per Scope Candidate; rejection is not falsification.
3. Promotion requires the complete section 13 gate at the command boundary and never occurs automatically.
4. At most eight user-global Derived Strategies are valid; total portfolio capacity is derived from owning constants.
5. Global trust is reconstructed without a mutable catalog or copied semantics and becomes an exact normal selector in another project.
6. Same-ID same-revision trust deduplicates; same-ID different-revision never shadows and fails the optional global layer closed.
7. Fingerprint version 1 and all historical frozen v0.7 base fingerprints remain valid without migration.
8. `/strategies` visibly distinguishes user-global, project-local, and combined trust while Experience remains schema-v4.
9. A later ordinary non-Trial Run may explicitly select the global Strategy and record the same revision with `promoted` status; non-selection is also valid.
10. State, capability, Gateway, Verification, Task, Long Task, Pi, Skill, and Session behavior remains unchanged.

## 23. Future v0.2 boundary

Reserved future problem:

```text
Cross-Project Learning v0.2
Cross-Project Strategy Derivation

project-local Experience from multiple projects
        ↓
bounded cross-project evidence projection
        ↓
new global Strategy identity hypothesis
```

v0.2 would ask whether multi-project evidence can justify proposing a **new** Strategy identity. v0.1 only expands trust for an **existing exact** project-local Derived revision. Nothing in this contract preselects v0.2 artifact schemas, evidence gates, identity authority, or storage beyond preserving project-local Experience ownership.

## 24. Resolved v0.1 decisions

1. **Global artifacts live at** `~/.pindie/global/strategy-scope-candidates/` and `strategy-scope-decisions/`.
2. **Exact source reference is** source project ID + logical ID + kind + original Derivation Candidate UUID + frozen revision fingerprint.
3. **Missing source behavior is** fail closed; no semantics copy or reconstruction and no portable store in v0.1.
4. **Cross-project Experience identity is** `projectId + canonical record filename + canonical schema-v4 record fingerprint`.
5. **Experience schema is** unchanged v4; exact identity and `trial` status are sufficient.
6. **Current portfolio fingerprinting is** unchanged version 1 over a deduplicated identity manifest; current fingerprints naturally include newly trusted global identities.
7. **Historical v0.7 fingerprints remain** immutable valid snapshots and are never migrated or compared as current authority except under their frozen rules.
8. **Global/local same-ID same-revision is** one deterministic manifest entry with separate runtime trust-origin metadata.
9. **Global/local same-ID different-revision is** prevented at promotion; if later observed, the optional global layer fails closed without shadowing.
10. **Minimum evidence is** two eligible Trial Runs across two distinct non-source target project IDs.
11. **Maximum user-global Derived Strategies is** eight.
12. **Human command lifecycle is** existing `/trial`, `/trial-review`, `/promote`, `/reject` with `scope:` dispatch, plus one necessary explicit scope-hypothesis creation command because existing commands cannot create that artifact unambiguously.
13. **`/strategies` presentation is** one exact deduplicated Strategy entry labeled user-global, project-local, or both; labels are not identity.
14. **Leases are** one existing one-Run Trial lease and one short global write critical-section lock; neither is semantic State.
15. **Restart persistence is** immutable source, Experience, Scope Candidate, and Scope Decision artifacts only; leases, packets, reviews, catalogs, and active Policy do not survive.

## 25. Architecture audit

Before any implementation Slice is accepted, inspect it for:

```text
Frozen v0.6/v0.7 semantic or fingerprint change?       → reject
Scope artifact copying Strategy semantics?              → reject
Global Experience storage/copy/index?                   → reject
Mutable global Strategy catalog or active pointer?      → reject
Implicit local/global precedence or shadowing?          → reject
Old portfolio fingerprint migration/rewrite?            → reject
Experience schema-v5 or trust-scope field creep?        → reject
Cross-project Derivation/new identity creep?             → reject
Automatic Trial or Human trust Decision?                → reject
Unbounded user-global trusted portfolio?                 → reject
State/capability/Gateway/Task/Pi authority leakage?      → reject
```

The smallest conforming implementation transfers trust, never Strategy identity, semantics, Experience ownership, or Environment authority.
