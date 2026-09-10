# Pindie Cross-Project Learning v0.2 — Strategy Synthesis and Global Validation

Status: authoritative architecture contract; implemented through Slice E.

## 1. Goal and exact boundary

Cross-Project Learning v0.1 implements **Strategy Trust Transfer**:

```text
one project already learned and promoted Strategy X
        ↓
/trust-transfer
        ↓
Scope Candidate
        ↓
cross-project Trial + review
        ↓
Human Decision
        ↓
user-global trust for the same exact revision
```

v0.2 closes the complementary gap: reusable knowledge may be visible only when Experience from several projects is considered together. No individual project may contain enough evidence to derive the Strategy locally, so v0.1 has nothing to transfer.

v0.2 implements the complete human-triggered learning lifecycle:

```text
project A Experience
project B Experience
project C Experience ...
        ↓
cross-project synthesis
        ↓
new Synthesis Candidate
        ↓
explicit Trials in real projects
        ↓
cross-project Trial review
        ↓
Human promoted | rejected Decision
        ↓
if promoted:
user-global trusted Strategy
        ↓
explicit reuse in later projects
```

A repository that stops at `Experience → inactive hypothesis` has implemented cross-project derivation, not Cross-Project Learning v0.2.

v0.2 remains explicit:

- `/derive-global` asks Pindie to synthesize a new Strategy hypothesis;
- `/trial synthesis:<candidate-id>` starts each real-project Trial;
- `/trial-review synthesis:<candidate-id>` shows factual cross-project validation;
- `/promote synthesis:<candidate-id>` or `/reject synthesis:<candidate-id>` is Human-owned.

Autonomous triggering, autonomous Trial selection, and automatic trust decisions remain outside v0.2.

## 2. Authority ladder

Discovery, experimentation, and trust are distinct authority levels:

```text
Experience
  factual historical evidence
        ↓
Synthesis Candidate
  hypothesis only; authority = none
        ↓
explicit Trial
  temporary one-Run Policy permission
        ↓
Trial Experience + Review
  factual validation evidence; authority = none
        ↓
Human Decision
        ↓
Promoted user-global Strategy
  durable normal-Policy authority
```

Required invariants:

1. Discovery evidence may justify proposing a hypothesis; it cannot make that hypothesis trusted.
2. Trial evidence may make a Candidate eligible for Human review; it cannot promote it automatically.
3. Only an immutable Human `promoted` Decision grants user-global trust.
4. Candidate creation is not a trust transition and does not use the user-global trust writer lock.
5. **Discovery provenance is not Promotion authority.** Promotion depends on the immutable Candidate, fresh eligible Trial evidence, current trust-safety facts, and the Human Decision. Old discovery Experience may later disappear without invalidating the Candidate.
6. Strategy identity, evidence provenance, Trial status, and trust scope remain distinct.

## 3. Two origins, one validation mechanism

v0.1 and v0.2 create user-global knowledge from different origins:

```text
A. Transfer origin                         B. Synthesis origin

project-local promoted Strategy            cross-project Experience
        ↓                                           ↓
StrategyTrustScopeCandidateV1              StrategySynthesisCandidateV1
        │                                           │
        └──────────────────┬────────────────────────┘
                           ↓
                 cross-project validation
                           ↓
                    explicit Trials
                           ↓
                    Trial Experience
                           ↓
                    factual review
                           ↓
                    Human Decision
                           ↓
                   user-global trust
```

Do not replace existing Scope artifacts with a generic Candidate/Decision framework.

The two origins keep distinct validity rules:

- **Transfer** must continue to prove that its exact source project-local Derived revision exists and remains promoted. The source project remains excluded from v0.1 target-project Trial evidence.
- **Synthesis** has no source trusted Strategy. Its authority before promotion is only its own immutable Candidate identity. A project that contributed discovery Experience may later be a Trial project.

Extract only genuinely common validation facts into a small runtime/pure projection. Conceptually:

```ts
interface CrossProjectTrialSubject {
  origin: "transfer" | "synthesis";
  subjectId: string;
  strategy: {
    strategyId: string;
    kind: "approach" | "modifier";
    revisionIdentity: string;
    revisionFingerprint: string;
    semantics: StrategySemantics;
  };
  excludedTrialProjectIds: readonly string[];
}
```

This is not persisted and is not a registry, service locator, universal Candidate API, or plugin point.

Shared cross-project validation may own only:

- exact Trial-revision matching;
- project-local Experience resolution;
- Trial evidence eligibility;
- deterministic selected Trial refs;
- eligible Trial Run count;
- distinct Trial project count;
- current user-global logical-ID/capacity safety;
- current project-local logical-ID conflict scan.

Origin-specific Candidate/source validity stays in origin-specific wrappers.

## 4. Cross-project discovery

### 4.1 `/derive-global`

CPL owns one new no-argument command:

```text
/derive-global
```

SI and CPL must both be selected.

The command:

1. establishes one SI-owned cross-project derivation reservation before asynchronous preparation;
2. rejects admission while `/adapt`, local `/derive`, or any Candidate Trial is pending/active;
3. reads project-local Experience across known Pindie project namespaces;
4. reconstructs the exact trusted Policy facts required to qualify each source Run;
5. deterministically selects a bounded cross-project packet;
6. if sufficient, requests one native Pi Agent Run;
7. allows zero or one Synthesis Candidate write;
8. keeps that Run read-only and excluded from ordinary Experience/continuation until settlement.

The reservation may extend the current SI derivation/slow-path runtime narrowly; current main does not contain a generic reusable slow-path slot, so implementation must not pretend one already exists or introduce a general workflow scheduler.

`/derive-global` creates or changes no Task and does not create a second Agent Loop or Session.

### 4.2 Eligible discovery Experience

Reuse schema-v4 Experience and existing evaluation primitives.

A Run enters the discovery pool only when:

- project namespace and Experience artifact are valid;
- `RunEvaluation.attributionEligible` is true;
- final Policy exists with strictly positive continuous final-Policy exposure;
- every final selection resolves exactly to `seed` or currently `promoted` trust in the Run's owning project;
- no final selection has `revisionStatusAtRun = "trial"`.

Do not require Verification pass or Task completion. Failed, blocked, unfinished, denied-call, or errorful Runs remain factual evidence if the trust/exposure rules hold.

Do not infer success, quality, causality, usefulness, or superiority from prose or outcome facts.

Use existing `CrossProjectExperienceRefV1` as durable source identity:

```text
(projectId, recordId, recordFingerprint)
```

A bare record UUID is never cross-project identity.

### 4.3 Discovery sufficiency

The discovery gate answers only whether it is worth asking the model for a missing-abstraction hypothesis:

```text
distinct qualified Experience refs >= 3
distinct project IDs                >= 2
distinct exact Task goals            >= 2
distinct Policy evidence profiles    >= 2
```

It is not statistical confidence, proof of generality, or evidence for trust.

### 4.4 Deterministic bounded packet

Show at most 8 Runs and at most 2 Runs from one project.

Selection must be deterministic and guarantee that a sufficient pool can produce a sufficient shown witness. Prefer factual diversity of represented project, exact Task goal, Policy profile, and outcome signature; never rank outcomes as better or worse.

The packet contains bounded factual projections only:

- qualified source refs;
- timestamp and exact-goal binding plus bounded display goal;
- final exact Policy selections and exposure facts;
- Verification/completion/blocker/question/Gate/tool-error/denial facts;
- bounded trusted Strategy comparison context supplied to the model;
- deterministic selection/sufficiency facts and packet fingerprint.

No transcript, tool-result body, source file, Skill body, or unbounded Experience history enters the packet.

### 4.5 Packet-only synthesis Run

The frozen packet is the complete project evidence supplied to the model for synthesis.

During `/derive-global`, allow only:

```text
frozen synthesis packet
pindie_strategy_synthesis_candidate_create
```

Deny live project/git observation, shell/bash, project mutation, Policy declaration, Task/Gate/Verification/Memory tools, existing Candidate tools, trust writes, and unknown tools.

This keeps durable derivation provenance aligned with the factual project evidence the model actually received. The receipt does not claim to capture pretrained/general model knowledge.

## 5. Strategy Synthesis Candidate

Add one dedicated immutable user-global hypothesis artifact:

```text
~/.pindie/global/
  strategy-synthesis-candidates/
    <candidate-id>.json
```

The v1 exact-field semantic contract is:

```ts
interface StrategySynthesisCandidateV1 {
  schemaVersion: 1;
  candidateType: "cross-project-synthesis";
  candidateId: string;
  createdAt: string;
  proposal: {
    strategyId: string;
    kind: "approach" | "modifier";
    summary: string;
    useWhen: readonly string[];
    avoidWhen: readonly string[];
    principles: readonly string[];
  };
  hypothesis: string;
  evidence: {
    sourceRefs: readonly CrossProjectExperienceRefV1[];
  };
  derivationReceipt: CrossProjectDerivationPacketV1;
}
```

No additional durable fields may be introduced by an implementation Slice without an explicit contract correction.

Rules:

- Harness owns `candidateId`, `createdAt`, the frozen receipt, canonicalization, and fingerprints;
- model supplies only proposal semantics, hypothesis text, and a cited subset of packet refs;
- cited refs must belong to the packet and independently satisfy the discovery gate;
- one `/derive-global` Run may create at most one Candidate;
- Candidate is inactive and unavailable to normal Policy resolution;
- Candidate has no target projects, Trial counters, trust status, confidence, rank, score, mutable evidence, or promotion flag;
- strict exact-field validation and immutable create-without-replacement storage apply.

Define two new fingerprints without altering existing algorithms:

```text
Strategy semantic fingerprint
  = deterministic hash of exact proposal identity + semantics
  = Trial/Policy revision fingerprint

Candidate artifact fingerprint
  = deterministic hash of the complete immutable Candidate artifact
  = Candidate/Decision provenance binding
```

The Candidate's `candidateId` is its future Trial `revisionIdentity`.

### 5.1 Candidate creation is authority-free

Candidate creation does not take the user-global writer lock.

Before the model Run, source Experience and comparison context are strictly validated while constructing the packet. At Candidate creation, Pindie validates:

- live Session/root/generation and exact global-derivation reservation;
- exact allowed creation tool;
- exact frozen packet binding;
- cited-ref membership, uniqueness, and discovery sufficiency;
- proposal schema/bounds;
- logical-ID and exact semantic duplication against the frozen comparison context;
- at-most-one publication for the active attempt.

Do not require discovery source Experience or discovery-time portfolios to remain live/unchanged at Candidate publication. The frozen receipt is historical provenance, not trust authority.

A conflict created after packet capture is harmless at Candidate authority level and is handled before Trial/Promotion.

## 6. Synthesis Trial

Synthesis Candidates use the existing unified command family:

```text
/trial synthesis:<candidate-id>
/trial-review synthesis:<candidate-id>
/promote synthesis:<candidate-id>
/reject synthesis:<candidate-id>
```

Do not add a second Trial command family.

### 6.1 Extend the existing TrialRuntime

Add one fixed Synthesis lease variant to the existing single pending/active `TrialRuntime`. Do not create `CrossProjectTrialRuntime`.

A Synthesis Trial lease binds:

- native Session;
- target project root/project ID;
- Candidate ID;
- Candidate semantic fingerprint;
- exact Candidate semantics;
- exact `StrategyRevisionSelection` with `revisionStatusAtRun = "trial"`;
- one Agent Run generation.

The model may use or decline the Candidate. Merely receiving the Trial packet creates no Candidate attribution.

### 6.2 Trial admission

Before arming a Synthesis Trial:

- Candidate must be valid and have no terminal Synthesis Decision;
- current target project must be loaded and idle;
- no other Trial or SI derivation/adaptation slow path may be pending/active;
- current complete target trusted portfolio must not contain a conflicting trusted revision under the proposed logical Strategy ID;
- exact Candidate semantic identity/fingerprint must still validate.

A derivation-source project may be a Synthesis Trial target.

Qualifying Synthesis Trial Experience must:

- be recorded no earlier than Candidate creation;
- contain the exact Synthesis Candidate revision in final Policy with status `trial`;
- have strictly positive final-Policy exposure;
- match Candidate ID, semantic fingerprint, kind, logical ID, and immutable semantics exactly.

Discovery Experience cannot satisfy the Trial gate by itself.

## 7. Shared cross-project Trial validation

Extract only common pure/factual logic from the existing v0.1 Scope review path.

Keep origin-specific wrappers:

```text
Strategy Trust Transfer Review
  = transfer-source validity
  + shared cross-project Trial evidence
  + shared global promotion safety

Strategy Synthesis Review
  = synthesis-Candidate validity
  + shared cross-project Trial evidence
  + shared global promotion safety
```

For both origins, the minimum deterministic Trial gate remains:

```text
eligible Trial Runs >= 2
distinct eligible Trial projects >= 2
```

For transfer, preserve the source-project exclusion. For synthesis, no project is excluded merely because it contributed discovery evidence.

This gate means only that enough real cross-project Trial evidence exists for a Human trust decision. It is not proof of superiority or statistical validation.

Use `CrossProjectExperienceRefV1` and exact direct re-resolution. Selected refs are deterministic and bounded.

Synthesis review should display, as factual context:

- eligible/selected Trial Run counts;
- distinct Trial projects;
- bounded outcome facts;
- discovery-source project IDs;
- Trial project IDs;
- overlap and newly represented Trial projects;
- current global/local trust-safety blockers.

Overlap is presentation context, not a confidence score or hard independence rule.

## 8. Synthesis Decision and Promotion

Add one immutable terminal artifact family:

```text
~/.pindie/global/
  strategy-synthesis-decisions/
    <candidate-id>.json
```

The v1 exact-field semantic contract is:

```ts
interface StrategySynthesisDecisionV1 {
  schemaVersion: 1;
  candidateId: string;
  candidateArtifactFingerprint: string;
  candidateSemanticFingerprint: string;
  decidedAt: string;
  decision: "promoted" | "rejected";
  evidence: {
    trialRefs: readonly CrossProjectExperienceRefV1[];
  };
}
```

The artifact fingerprint binds the exact immutable Candidate including its historical derivation receipt. The semantic fingerprint separately binds the exact revision that Trial and Policy use.

A rejection may be written for any open valid Candidate without satisfying the promotion Trial gate. It grants no trust. Rejection may retain zero Trial refs.

Promotion is a trust transition and runs under the existing shared user-global writer lock.

Inside the lock, promotion must freshly validate:

1. exact Candidate and both Candidate fingerprints;
2. absence of a prior terminal Synthesis Decision;
3. selected Trial refs and current record fingerprints;
4. full shared Trial evidence gate (`>=2` Runs, `>=2` projects);
5. Seed logical-ID collision safety;
6. user-global logical-ID collision safety across transfer and synthesis origins;
7. complete project-local conflicting Derived logical-ID scan;
8. combined user-global Derived Strategy capacity;
9. Decision binding and immutable no-replacement publication.

Only then may `promoted` be persisted.

### 8.1 Historical discovery receipt

Promotion must not require original discovery Experience to remain present or discovery-time trusted portfolios to remain current.

```text
Candidate receipt answers:
Why was this Strategy proposed?

Fresh Trial refs + current trust safety answer:
Is this exact Strategy eligible for user-global trust now?
```

Do not conflate those questions.

## 9. User-global trust convergence

After promotion, transfer-origin and synthesis-origin Strategies are behaviorally equivalent normal user-global trusted Derived Strategies:

```text
transfer Scope Decision ───────┐
                               ├→ user-global trust projection
synthesis promoted Decision ───┘
                                      ↓
                           TrustedStrategyPortfolio
```

Both are:

- exact immutable Derived Strategy revisions;
- selected normally with `revisionStatusAtRun = "promoted"`;
- explicitly selectable by exact Policy selector;
- advisory cognitive Policy only;
- never default or automatically recommended.

Their provenance remains origin-specific.

Do not change `TRUSTED_PORTFOLIO_FINGERPRINT_VERSION` or project-local persisted artifacts.

The runtime user-global entry representation may evolve narrowly into an origin-aware union so transfer entries retain one source project while synthesis entries have no fictitious source project. The canonical portfolio manifest continues to fingerprint Strategy identity facts, not trust provenance. Runtime `sourceProjectIds` may be empty for synthesis-origin trust.

`MAX_USER_GLOBAL_DERIVED_STRATEGIES` applies to the combined promoted set from both origins.

## 10. Trust safety and Composable boundary

Preserve:

```text
Core  ✗→ SI implementation
Core  ✗→ CPL implementation
SI    ✗→ CPL implementation
CPL    → narrow SI learning/trial/trust ports
```

`composition.ts` selects/wires only.

CPL-off removes CPL workflow:

- no `/trust-transfer`;
- no `/derive-global`;
- no Scope/Synthesis Trial workflow handlers;
- no cross-project discovery scan;
- no CPL packet injection;
- no new CPL workflow writes.

But disabling CPL must never weaken durable global authority safety.

Once synthesis promotion exists, shared SI trust-safety reconstruction must include relevant promoted/rejected Synthesis artifacts in collision/authority validation even when CPL workflow is disabled, exactly as existing v0.1 global trust safety remains enforceable without the CPL workflow.

Failure isolation:

- unrelated corrupt inactive Synthesis Candidate does not poison ordinary global trust reconstruction;
- a promoted Decision with missing/corrupt/mismatched Candidate fails relevant user-global authority reconstruction closed;
- malformed relevant global authority may make the optional global layer unavailable while existing Core/project-local SI fallback semantics remain intact.

Do not add a Plugin SDK, DI framework, event bus, lifecycle engine, Candidate registry, persisted feature-selection state, second Skill runtime, or second Agent Loop.

## 11. Lifecycle and failure boundaries

Runtime-only `/derive-global` and Synthesis Trial permissions clear on the same supported boundaries as existing SI/CPL leases:

- Session replacement;
- supported same-Session runtime/resource reconstruction;
- project-root change;
- shutdown;
- abort/settlement;
- stale Agent Run generation.

Candidate and Decision artifacts are durable and are never reconstructed from conversation text or compaction summaries.

Required failures:

- insufficient discovery evidence → no model Run, no Candidate;
- model proposes nothing → valid outcome, no Candidate;
- stale `/derive-global` binding → no Candidate write;
- malformed/terminal Synthesis Candidate → no Trial;
- missing old discovery sources after Candidate creation → receipt remains inspectable and Trial may continue;
- stale/missing selected Trial refs → Promotion fails closed;
- target/global/local logical-ID conflict → relevant Trial or Promotion fails closed;
- ambiguous immutable write → reconcile the same preallocated identity; never create a second terminal authority artifact;
- no failure mutates `PindieState`, Task/Gate/Verification truth, Experience schema, or Pi Session ownership.

## 12. Explicitly unchanged behavior

v0.2 does not change:

- CPL v0.1 Scope Candidate/Decision schemas or transfer semantics;
- v0.1 source-project trust requirement and source-project Trial exclusion;
- local `/adapt` and `/derive` semantics;
- local Revision/Derivation Candidate schemas, Trial semantics, or Decisions;
- Experience schema-v4;
- Task/Gate/Verification/Reducer/State semantics;
- Execution Gateway and project-mutation freshness;
- existing Strategy fingerprint algorithms;
- Remote, Work Memory, Presentation, Bundled Skills, Long Task Runtime, or continuation;
- Pi native Agent Loop and Session ownership;
- model weights;
- default/recommendation behavior of trusted Strategies.

No data migration is introduced.

## 13. Implementation slices

Each Slice is reviewed before the next starts.

### Slice A — Cross-project synthesis evidence and packet

Implement only the discovery substrate:

- namespace-addressed complete trust reads required to qualify foreign-project Experience;
- qualified multi-project Experience scan;
- deterministic `3 records / 2 projects / 2 goals / 2 profiles` gate;
- deterministic max-8 / max-2-per-project witness selection;
- bounded frozen synthesis packet, rendering, and packet fingerprint;
- focused malformed/duplicate/stale evidence behavior.

No `/derive-global`, Candidate store, Trial, Decision, or trust projection.

Done when focused tests prove:

- same bare record ID in different projects stays distinct;
- wrong/missing fingerprint cannot resolve as evidence;
- discovery eligibility matches section 4.2;
- one project never suffices and a valid 3-record/2-project witness can;
- input ordering does not change packet output;
- a high-volume project cannot dominate the shown packet;
- packet bounds and comparison context are enforced;
- current local `/derive`, CPL v0.1, trust safety, and portfolio fingerprints remain unchanged.

### Slice B — Synthesis Candidate and `/derive-global`

Add the strict Candidate store/fingerprints, creation tool, explicit command lifecycle, narrow SI reservation, packet-only Run restriction, and Experience/continuation exclusion.

Candidate creation remains authority-free and uses no trust writer lock.

Done when one explicit command can create zero or one inactive Candidate and no normal Policy/Trial/Trust path can yet consume it.

### Slice C — Synthesis Trial

Extend the existing unified `TrialRuntime` and unified Candidate commands with `synthesis:<candidate-id>`.

Add exact Trial selection, target conflict validation, Synthesis Trial packet, normal schema-v4 Experience attribution, and lifecycle invalidation.

Do not implement Synthesis Promotion yet.

### Slice D — Shared validation, Human Decision, and global trust

Extract the minimum common cross-project Trial evidence/global promotion-safety logic from the existing Scope review path while retaining origin-specific wrappers and artifacts.

Add Synthesis review, strict Decision artifacts, `/promote`/`/reject synthesis:<id>`, lock-protected fresh Promotion, combined transfer+synthesis collision/capacity safety, and synthesis-origin user-global trust projection.

Done when both origins reuse common factual validation without becoming a generic Candidate framework, and a promoted Synthesis revision is exactly selectable as normal user-global Policy.

### Slice E — Composition and compatibility closure

Verify:

- Core only;
- SI only;
- SI + CPL;
- default full composition;
- CPL-off workflow absence with global transfer+synthesis trust safety retained;
- Session replacement/reload/shutdown;
- no duplicate registrations/leases;
- architecture import-direction guards;
- existing v0.1 transfer and local SI behavior unchanged;
- no State/Experience migration;
- docs/AGENTS synchronized to implemented state.

Run isolated-HOME `pnpm run check` and `git diff --check`.

Slice E is implemented and closes the v0.2 compatibility boundary. Production
composition reuses the selected Synthesis Store instances for SI authority reads,
while CPL-off keeps the read-only Synthesis trust substrate. Focused composition,
registration, lifecycle, real-file reconstruction, combined-origin, persisted
schema/fingerprint, and import-direction tests cover the final boundary. No
additional Slice F is defined for v0.2.

## 14. Completion definition

v0.2 is complete only when this real loop exists:

```text
distributed project Experience
        ↓
new Strategy hypothesis
        ↓
explicit real-project Trials
        ↓
cross-project factual review
        ↓
Human trust decision
        ↓
user-global trusted Strategy
        ↓
explicit reuse in later projects
```

## 15. Deferred work

Outside v0.2:

- autonomous/background synthesis triggering;
- autonomous Trial-target choice;
- automatic promotion/rejection;
- ranking, reward, confidence, or quality scores;
- embeddings/vector search/semantic clustering;
- repository-portable project identity;
- model-weight updates;
- generic learning/plugin frameworks.

A later Autonomous Learning phase may decide **when** to invoke this complete lifecycle. It must not silently take over Human trust decisions without a separate approved authority design.
