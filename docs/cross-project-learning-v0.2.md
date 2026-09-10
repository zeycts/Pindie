# Pindie Cross-Project Learning v0.2 — Strategy Synthesis and Global Validation

Status: proposed architecture contract; implementation not started.

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

v0.2 closes a different structural gap: some reusable knowledge may be visible only when Experience from several projects is considered together. No individual project may contain enough evidence to derive the Strategy locally, so v0.1 has nothing to transfer.

v0.2 therefore implements an end-to-end **Strategy Synthesis** path:

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
```

The lifecycle is complete in v0.2. A generated hypothesis is not the endpoint.

v0.2 remains **human-triggered**:

- `/derive-global` explicitly asks Pindie to synthesize a new Strategy hypothesis;
- `/trial synthesis:<candidate-id>` explicitly starts each Trial;
- `/promote synthesis:<candidate-id>` or `/reject synthesis:<candidate-id>` is Human-owned.

Automatic/background detection of when to derive or Trial belongs to a later Autonomous Learning design. v0.2 must not create a learning scheduler, queue, second Agent Loop, or automatic trust transition.

## 2. Authority ladder

Keep discovery, experimentation, and trust as separate authority levels:

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

1. Derivation evidence can justify proposing a hypothesis; it cannot make the hypothesis trusted.
2. Trial evidence can make a Candidate eligible for Human review; it cannot promote the Candidate by itself.
3. Only an immutable Human `promoted` Decision grants user-global trust.
4. Candidate creation must not require trust-transition locking or pretend it is a global authority write.
5. **Discovery provenance is not Promotion authority.** The original derivation Experience may later disappear without invalidating a Candidate or an already-completed Trial. Promotion depends on the immutable Candidate, fresh eligible Trial evidence, current trust-safety facts, and the Human Decision.
6. Strategy identity, evidence provenance, Trial status, and trust scope remain distinct concepts.

## 3. Two origins, one cross-project validation path

v0.1 and v0.2 produce user-global Strategies from different origins:

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

Do **not** replace the existing Scope Candidate with a generic Candidate schema.

The origins retain different validity rules:

- **Transfer** must continue to prove that the exact source project-local Derived revision still exists and remains promoted. The source project is not a valid target project for the v0.1 trust-transfer Trial gate.
- **Synthesis** has no source trusted Strategy. It proves only that its own immutable Candidate and derivation receipt are valid. Any project, including a project that contributed derivation Experience, may later be a Trial project.

The shared validation layer owns only facts common to both origins:

- exact Trial-revision matching;
- project-local Experience resolution;
- Trial evidence eligibility;
- deterministic selected evidence refs;
- eligible Trial Run count;
- distinct Trial project count;
- current user-global logical-ID/capacity safety;
- current project-local logical-ID conflict scan.

Use a small runtime-only normalized subject, not a persisted generic framework. Conceptually:

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

Exact names may follow existing source conventions. This value is a pure validation projection. It is not a new durable artifact, registry, service locator, or universal Candidate API.

## 4. Cross-project discovery

### 4.1 `/derive-global`

CPL owns one new explicit command:

```text
/derive-global
```

It has no arguments in v0.2. SI and CPL must both be enabled.

The command:

1. reserves the existing SI slow-path admission slot before asynchronous preparation;
2. reads project-local Experience across known Pindie project namespaces;
3. reconstructs each contributing project's exact trusted Policy facts;
4. deterministically selects a bounded cross-project evidence packet;
5. if the packet is sufficient, starts one native Pi Agent Run;
6. allows the model to create zero or one immutable Synthesis Candidate;
7. releases the slow-path lease at settlement.

`/derive-global` does not create or change a Task. The Run produces no ordinary Run Experience and no project-work continuation, matching existing `/adapt` and `/derive` learning-run exclusion semantics.

It shares mutual exclusion with `/adapt`, local `/derive`, local Candidate Trial, Derivation Trial, and Scope Trial. Do not create a second scheduler or Agent Loop.

### 4.2 Eligible discovery Experience

Reuse schema-v4 Experience and existing evaluation primitives.

A Run may enter the discovery pool only when:

- its project namespace and Experience artifact are valid;
- `RunEvaluation.attributionEligible` is true;
- it has a final Policy with strictly positive continuous final-Policy exposure;
- every final selection resolves exactly to `seed` or currently `promoted` trust in that Run's owning project;
- no final selection has `revisionStatusAtRun = trial`.

Do not require Verification pass or completed Task. Failed, blocked, unfinished, denied-call, or errorful Runs remain factual evidence if the trust/exposure requirements hold.

Do not infer success, quality, causality, or usefulness from prose or outcome facts.

### 4.3 Sufficiency gate

The discovery admission gate is deliberately weaker than the later Promotion gate because its only output is an inactive hypothesis:

```text
distinct qualified Experience refs >= 3
distinct project IDs                >= 2
distinct exact Task goals            >= 2
distinct Policy evidence profiles    >= 2
```

This means only: enough diverse factual evidence exists to ask whether a missing abstraction may exist.

It is not statistical confidence, proof of generality, or evidence for trust.

### 4.4 Bounded deterministic packet

Show at most 8 Runs and at most 2 Runs from one project.

Selection must be deterministic and must guarantee that a sufficient pool produces a sufficient shown witness. Prefer diversity of represented project, exact Task goal, Policy profile, and factual outcome signature; never rank outcomes as better/worse.

The packet contains only bounded factual projections:

- qualified `CrossProjectExperienceRefV1` identities;
- Run timestamp and exact-goal binding plus bounded display goal;
- final exact Policy selections and exposure facts;
- Verification/completion/blocker/question/Gate/tool-error/denial facts;
- the exact trusted Strategy comparison context supplied to the model.

No transcript, tool-result body, source file, Skill body, or unbounded Experience history enters the packet.

### 4.5 Packet-only synthesis Run

The frozen packet is the complete factual project evidence supplied to the model for synthesis.

During `/derive-global`, allow only:

```text
frozen synthesis packet
pindie_strategy_synthesis_candidate_create
```

Deny live project/git observation, shell/bash, project mutation, Policy declaration, Task/Gate/Verification/Memory tools, existing Candidate tools, trust writes, and unknown tools.

This keeps the Candidate's durable receipt aligned with the factual project evidence actually supplied for derivation. The receipt does not claim to capture the model's pretrained/general knowledge.

## 5. Synthesis Candidate

Add a dedicated immutable user-global hypothesis artifact. Do not overload `StrategyDerivationCandidateV1` or `StrategyTrustScopeCandidateV1`.

```text
~/.pindie/global/
  strategy-synthesis-candidates/
    <candidate-id>.json
```

Proposed shape:

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

The exact schema may be tightened during implementation, but the semantics above are fixed.

Rules:

- the Harness owns `candidateId`, `createdAt`, packet/receipt, fingerprints, and source-ref identity;
- the model supplies only proposal semantics, hypothesis text, and a cited subset of packet refs;
- cited refs must themselves satisfy the full discovery gate;
- at most one Candidate may be created by one `/derive-global` Run;
- the Candidate is inactive and cannot enter normal Policy resolution;
- it has no target projects, Trial counters, trust status, confidence score, ranking, mutable evidence list, or promotion flag.

Keep two fingerprints conceptually distinct:

- **Strategy semantic fingerprint**: binds the exact proposal semantics used by Trial/Policy identity;
- **artifact/receipt fingerprint**: binds the immutable Candidate occurrence and derivation provenance for audit.

Do not change existing fingerprint algorithms.

### 5.1 Candidate creation is not a trust write

Candidate creation does **not** take the user-global trust writer lock.

At packet construction, Pindie strictly validates the selected source Experience and comparison context. At Candidate creation it verifies only the live Run/Session/lease, exact tool identity, cited-ref membership/sufficiency, and proposal validity against the frozen packet.

The Candidate stores the exact historical receipt the model saw. It does not re-read all source Experience or require trusted portfolios to remain byte-identical before saving the inactive hypothesis.

If a trusted logical-ID/semantic duplicate was already present in the frozen comparison context, Candidate creation rejects it as a non-missing abstraction. A new conflict that appears after packet capture is harmless at this authority level and is handled before Trial/Promotion.

## 6. Synthesis Trial

A Synthesis Candidate becomes testable through the existing unified Trial surface:

```text
/trial synthesis:<candidate-id>
/trial-review synthesis:<candidate-id>
/promote synthesis:<candidate-id>
/reject synthesis:<candidate-id>
```

Do not add a second Trial command family.

### 6.1 Shared TrialRuntime

Extend the existing single `TrialRuntime` pending/active slot with one fixed Synthesis Trial lease variant. Do not create `CrossProjectTrialRuntime`.

A Synthesis Trial lease binds:

- native Session;
- target project root/project ID;
- Candidate ID;
- Candidate semantic fingerprint;
- exact `StrategyRevisionSelection` with `revisionStatusAtRun = "trial"`;
- one Agent Run generation.

The Candidate's `candidateId` is its trial `revisionIdentity`; its Strategy semantic fingerprint is the `revisionFingerprint`.

The model may use or decline the Candidate. Merely receiving the Trial packet creates no Candidate attribution.

### 6.2 Target project eligibility

Any real project may be a Synthesis Trial target, including projects whose historical Experience contributed to derivation.

Derivation and Trial evidence remain separate because qualifying Trial Experience must:

- be recorded after Candidate creation;
- contain the exact Synthesis Candidate trial revision in the final Policy;
- have positive final-Policy exposure;
- resolve to the exact Candidate semantics/fingerprint.

A target project with a conflicting trusted revision under the same logical Strategy ID is not a valid Trial target. Do not create local/global precedence rules to make the experiment fit.

The overlap between derivation-source projects and Trial projects is displayed in review as factual context, not used as a hard independence score.

## 7. Shared cross-project Trial validation

v0.2 should extract only the genuinely common validation logic currently embedded in the v0.1 Scope review path.

Keep origin-specific wrappers:

```text
Strategy Trust Transfer Review
  = transfer-source validity
  + shared cross-project Trial evidence
  + shared global promotion safety

Strategy Synthesis Review
  = synthesis-candidate validity
  + shared cross-project Trial evidence
  + shared global promotion safety
```

Do not replace the two artifact families with a generic persisted Candidate/Decision union.

### 7.1 Shared Trial evidence gate

For both origins, the minimum deterministic gate remains:

```text
eligible Trial Runs >= 2
distinct eligible Trial projects >= 2
```

For transfer, preserve the existing rule that the source project is excluded from target-project evidence.

For synthesis, no project is excluded merely because it contributed derivation evidence.

This gate means only that enough real cross-project Trial evidence exists for a Human trust decision. It is not statistical validation or proof of superiority.

Trial review continues to show factual outcomes and bounded reasons. No score/reward/ranking system is added.

### 7.2 Trial evidence identity

Use `CrossProjectExperienceRefV1` and direct exact re-resolution.

An eligible Synthesis Trial Run must match the exact Candidate revision identity, fingerprint, semantics, `trial` status, and positive exposure. Old derivation source Experience cannot satisfy this by itself.

Selected Trial refs are deterministic and stored in the terminal Decision for audit provenance.

## 8. Synthesis Decision and Promotion

Add a second immutable user-global terminal artifact:

```text
~/.pindie/global/
  strategy-synthesis-decisions/
    <candidate-id>.json
```

Proposed semantics:

```ts
interface StrategySynthesisDecisionV1 {
  schemaVersion: 1;
  candidateId: string;
  candidateSemanticFingerprint: string;
  decidedAt: string;
  decision: "promoted" | "rejected";
  evidence: {
    trialRefs: readonly CrossProjectExperienceRefV1[];
  };
}
```

A rejection may be written for an open valid Candidate without satisfying the Trial Promotion gate. Rejection means only that no user-global trust is granted.

Promotion is a real trust transition and therefore runs under the existing shared user-global writer lock.

Inside the lock, promotion must re-read and validate:

1. exact immutable Synthesis Candidate and absence of prior terminal Decision;
2. selected Trial Experience refs and their current fingerprints;
3. full shared Trial evidence gate (`>=2` Runs, `>=2` projects);
4. Seed logical-ID collision safety;
5. existing user-global logical-ID collision safety across **both transfer and synthesis origins**;
6. complete project-local conflicting Derived logical-ID scan;
7. combined user-global Derived Strategy capacity;
8. Candidate semantic fingerprint and Decision binding.

Only then may the immutable `promoted` Synthesis Decision be published.

### 8.1 Discovery provenance is historical at Promotion

Promotion must **not** require the original derivation source Experience to still exist or the discovery-time trusted portfolios to remain current.

The immutable Candidate receipt answers:

> Why was this Strategy proposed?

Fresh Trial refs and current trust-safety reads answer:

> Is this exact Strategy now eligible for user-global trust?

Do not conflate those questions.

## 9. User-global trust convergence

After promotion, transfer-origin and synthesis-origin Strategies are behaviorally equivalent normal user-global trusted Derived Strategies.

```text
transfer Scope Decision ───────┐
                               ├→ current user-global trust projection
synthesis promoted Decision ───┘
                                      ↓
                           TrustedStrategyPortfolio
```

Both are:

- exact immutable Derived Strategy revisions;
- `revisionStatusAtRun = "promoted"` when selected normally;
- explicitly selectable by exact Policy selector;
- advisory cognitive Policy only;
- never default or automatically recommended.

Their provenance remains different and inspectable through their origin-specific artifacts.

### 9.1 Preserve portfolio identity semantics

Do not change `TRUSTED_PORTFOLIO_FINGERPRINT_VERSION` or persisted project-local artifacts.

Evolve only the runtime user-global entry representation as needed so a trusted global Strategy may have:

- one transfer source project; or
- no single source project for a synthesized Strategy.

The canonical portfolio manifest continues to fingerprint Strategy identity facts, not trust provenance. Runtime `sourceProjectIds` may be empty for synthesis-origin trust.

`MAX_USER_GLOBAL_DERIVED_STRATEGIES` applies to the combined promoted set from both origins.

## 10. Trust-safety and Composable boundary

Preserve the completed Composable Pindie architecture:

```text
Core  ✗→ SI implementation
Core  ✗→ CPL implementation
SI    ✗→ CPL implementation
CPL    → narrow SI learning/trial/trust ports
```

`composition.ts` selects and wires; it does not absorb learning logic.

CPL-off continues to mean:

- no `/trust-transfer`;
- no `/derive-global`;
- no Scope/Synthesis Trial workflow registration;
- no cross-project Experience scan;
- no CPL packet injection;
- no CPL write workflow.

But CPL-off must **not** make existing user-global trust disappear from safety validation.

Once synthesis promotion exists, the shared SI trust-safety substrate must include promoted Synthesis Decisions in global logical-ID/collision reconstruction even when CPL workflow is disabled, just as it already retains v0.1 global trust safety.

Important failure isolation:

- an unrelated corrupt inactive Synthesis Candidate must not poison ordinary global trust reconstruction;
- a promoted/rejected Decision that references a missing, corrupt, or mismatched Candidate fails the relevant global authority reconstruction closed;
- malformed relevant user-global authority may make the optional global layer unavailable, while ordinary Core/project-local SI remains usable according to existing fallback boundaries.

Do not add a Plugin SDK, DI framework, event bus, generic lifecycle engine, Candidate registry, or persisted feature-selection state.

## 11. Lifecycle and failure boundaries

Runtime-only `/derive-global` and Synthesis Trial leases are cleared by the same supported boundaries as existing SI/CPL leases:

- Session replacement;
- same-Session resource reload where current runtime is rebuilt;
- project-root change;
- shutdown;
- abort/settlement;
- stale Agent Run generation.

Candidate and Decision artifacts are durable and never reconstructed from conversation history.

Required failure behavior:

- insufficient discovery evidence → no model Run, no Candidate;
- model proposes nothing → valid `/derive-global` outcome, no Candidate;
- stale `/derive-global` Session/generation → no Candidate write;
- malformed Synthesis Candidate → no Trial/Decision for that Candidate;
- missing old derivation source files after Candidate creation → historical receipt remains inspectable; this alone does not block Trial/Promotion;
- stale/missing selected Trial refs → Promotion fails closed;
- global/local logical-ID conflict → Promotion fails closed;
- ambiguous global write → reconcile the same Candidate/Decision identity; never silently create another terminal authority artifact;
- no failure mutates `PindieState`, Task/Gate/Verification authority, Experience schema, or Pi Session ownership.

## 12. Explicitly unchanged behavior

v0.2 does not change:

- CPL v0.1 Scope Candidate/Decision schemas or transfer semantics;
- the existing v0.1 source-project trust requirement;
- local `/adapt` and `/derive` semantics;
- local Revision/Derivation Candidate schemas, Trial semantics, and Decisions;
- Experience schema-v4;
- Task/Gate/Verification/Reducer/State semantics;
- Execution Gateway and mutation freshness;
- Remote, Work Memory, Presentation, Bundled Skills, Long Task Runtime, or continuation;
- Pi's native Agent Loop and Session ownership;
- model weights;
- trusted Strategy default/recommendation behavior.

No data migration is introduced.

## 13. Implementation slices

Implement only after this architecture is approved. Each Slice is independently reviewed before the next begins.

### Slice A — Cross-project synthesis evidence and packet

Build the pure discovery substrate only:

- qualified multi-project Experience scan;
- strict owning-project trust resolution;
- deterministic `3 records / 2 projects / 2 goals / 2 profiles` sufficiency;
- max-8 / max-2-per-project selection;
- frozen packet + rendering;
- packet fingerprint and bounded comparison context.

No `/derive-global` command and no Candidate store yet.

Done when focused tests prove deterministic selection, project/record identity correctness, malformed evidence/trust behavior, bounds, and no change to existing local Derivation or v0.1 CPL.

### Slice B — Synthesis Candidate and `/derive-global`

Add:

- `StrategySynthesisCandidateV1` strict immutable store/fingerprints;
- `pindie_strategy_synthesis_candidate_create`;
- explicit `/derive-global` lifecycle;
- SI slow-path mutual exclusion/generation binding;
- packet-only tool restriction;
- no ordinary Experience/continuation for the learning Run.

Candidate creation remains authority-free and does not use the global trust writer lock.

Done when one explicit command can create zero or one inactive Candidate and nothing in Policy/Trial/Trust can yet consume it.

### Slice C — Synthesis Trial

Extend the existing unified Trial system with `synthesis:<candidate-id>`:

- one new fixed Trial lease variant in the existing `TrialRuntime`;
- exact Candidate trial selection;
- target-project conflict validation;
- prompt packet;
- unified command completion/dispatch;
- normal schema-v4 Experience attribution.

Do not implement promotion yet.

Done when a Synthesis Candidate can be explicitly Trialed in multiple real projects, while all existing Revision/Derivation/Scope Trial semantics remain compatible and mutually exclusive.

### Slice D — Shared cross-project validation, Human Decision, and global trust

Extract the minimum common Trial-evidence and global-promotion-safety logic from the existing v0.1 Scope review path without replacing its artifact model.

Add:

- Synthesis Trial review;
- `StrategySynthesisDecisionV1`;
- `/promote synthesis:<id>` and `/reject synthesis:<id>`;
- lock-protected fresh Promotion revalidation;
- combined transfer+synthesis global collision/capacity checks;
- synthesized user-global trust projection.

Done when both origins pass through shared factual validation but retain origin-specific validity, and a promoted synthesis revision is exactly selectable as normal user-global Policy.

### Slice E — Composition and compatibility closure

Close the matrix and documentation:

- Core only;
- SI only;
- SI + CPL;
- default full composition;
- CPL off with existing transfer/synthesis global authority still enforced for safety;
- Session replacement/reload/shutdown;
- architecture import-direction guards;
- existing v0.1 transfer behavior unchanged;
- no State/Experience migration;
- authoritative docs/AGENTS synchronization.

`HOME=$(mktemp -d) pnpm run check` and `git diff --check` must pass.

## 14. v0.2 completion definition

Cross-Project Learning v0.2 is complete only when the following real loop exists:

```text
Distributed project Experience
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
available for explicit reuse in later projects
```

A repository that only reaches `Experience → inactive hypothesis` has implemented cross-project derivation, not Cross-Project Learning v0.2.

## 15. Deferred work

Explicitly outside v0.2:

- autonomous/background triggering of synthesis;
- autonomous choice of Trial targets;
- automatic promotion/rejection;
- strategy ranking, reward, confidence, or quality scores;
- semantic clustering/embeddings/vector search;
- repository-portable project identity;
- model weight updates;
- generic learning/plugin frameworks.

A later Autonomous Learning phase may decide *when* to invoke the already-complete v0.2 lifecycle. It must not silently take over the Human trust decision without a separate approved authority design.
