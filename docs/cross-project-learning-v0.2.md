# Pindie Cross-Project Learning v0.2 — Cross-Project Strategy Derivation

Status: proposed design only; not implemented or approved for implementation.

Baseline: latest fetched `main`, `1366ba690d359593b51a4750beb6582403950abc`, including merged PR #128 / Composable Pindie Slice F. No existing implementation or artifact is changed by this document.

## 1. Problem and exact boundary

CPL v0.1 transfers an existing project-local promoted Derived revision into wider trust. CPL v0.2 asks a different question: can diverse, already-recorded project-local Experience justify asking the model for a missing-abstraction hypothesis?

The entire new path is:

```text
project-local schema-v4 Experience in multiple namespaces
  → strict source-project trust reconstruction
  → deterministic eligibility and bounded diverse selection
  → deterministic cross-project sufficiency
  → frozen factual packet
  → explicit human-triggered /derive-global native Pi Run
  → zero or one immutable, inactive user-global hypothesis Candidate
  → STOP
```

“Global” describes the hypothesis's storage and intended scope, NOT granted trust. The Candidate has no Policy selector, Trial eligibility, promotion path, recommendation, or automatic use in v0.2.

No autonomous/background learning, learning queue, global Experience store, migration, ranking, quality metric, embeddings, Plugin SDK, new Session, or second Agent Loop is introduced.

## 2. Repository calibration and reuse

Relevant implemented boundaries:

- `cross-project-experience.ts` already supplies `CrossProjectExperienceRefV1`: `{ projectId, recordId, recordFingerprint }`, strict validation, canonicalization and exact live resolution. Reuse it unchanged.
- `experience-store.ts` already supplies `RunExperienceProjectReader.listProjectIds()` and `readProjectId()`. The file reader accepts live schema-v4 records only; malformed project namespaces cause enumeration failure, whereas malformed Experience files are counted and omitted.
- `strategy-derivation.ts` owns trusted-final-Policy eligibility, the local 3-record / 2-goal / 2-profile gate, an eight-Run packet, and `DerivationRuntime`.
- `experience-evaluation.ts` owns attribution, continuous final-Policy exposure, factual outcomes and `policyEvidenceProfileId()`.
- `strategy-derivation-candidates.ts` binds each local Candidate to one `projectId`, one `basePortfolio`, and bare local `sourceRecordIds`. Its exact-field schema and existing fingerprints must not change.
- `tools/strategy-derivation-candidate.ts` revalidates current evidence, portfolio, packet membership and submitted-set sufficiency. It rejects trusted logical-ID collisions and exact trusted semantic duplicates.
- `self-improvement-integration.ts` owns SI Run preparation, read-only restrictions, Experience settlement exclusion and the shared local/Scope Trial slot. CPL currently receives narrow learning/trust access and supplies fixed startup attachment handlers.
- `strategy-trust-safety.ts` reconstructs strict local/complete portfolios. Its public loaders currently take a project root, not an arbitrary project ID. The Scope source resolver addresses a foreign namespace directly, but only resolves promoted Derived sources; it is not a complete foreign-project portfolio loader.
- Portfolio manifest v1 excludes trust-origin metadata. `TrustedPortfolioResolvedEntry.trust` is runtime provenance, not part of that historical fingerprint.

Documentation calibration: the older capability summaries in `docs/architecture.md` and `docs/behavior.md` list adaptation but omit implemented `policy.derive`; their Tool Surface wording also differs from the later composition/AGENTS guidance. This proposal follows the explicit request, completed composition contract and actual SI integration for this work. It does not resolve that older documentation inconsistency through a broader runtime redesign.

### Identity limitation retained

`projectId = sha256(canonical absolute project-root path)`, not repository contents or a portable Git identity. Distinct namespaces establish distinct *Pindie project identities*, not statistical independence. Moving/copying a repository may create another identity. v0.2 neither deduplicates repositories semantically nor migrates their history.

## 3. Ownership and dependency direction

| Owner | Responsibility |
| --- | --- |
| SI | Experience parsing/evaluation; existing derivation value primitives; shared slow-path admission, native Run binding/restriction and settlement exclusion |
| CPL | `/derive-global`; multi-project evidence orchestration, selection and gate; global packet; global hypothesis Candidate validation/persistence/tool |
| Shared SI trust substrate | Strict namespace-addressed trust reconstruction, immutable source checks, existing identity/fingerprint rules, shared user-level writer lock |
| Core | Existing Run generation/coherence, startup tool-effect admission, one Gateway, ordinary State/Task authority |
| Pi | Command delivery, model invocation, tool execution, native Session lifecycle |
| Model | Optional proposal, cited evidence subset and hypothesis meaning |
| Human | Explicit invocation; later validation and trust decisions, outside this version |

Dependency remains `CPL → narrow SI interfaces`, never `SI → CPL implementation`. No CPL packet/Candidate type is imported into Core. `composition.ts` constructs and wires only. Extend the existing fixed SI attachment/learning ports narrowly; do not add a generic handler registry or lifecycle bus.

CPL-off constructs no new Candidate store, registers no `/derive-global` or creation tool, injects no packet and performs no cross-project derivation scan. Existing shared global trust-safety reads and writer locking remain mandatory for local trust writes. Inactive global hypothesis artifacts are not trust authority and are not read by that safety projection.

## 4. Evidence eligibility

Enumerate the configured personal user's existing project namespaces on explicit invocation only. Never infer foreign filesystem roots from hashes. Load each potentially contributing namespace's complete effective portfolio: immutable Seeds + locally promoted Seed revisions + locally promoted Derived revisions + valid user-global Derived revisions, using the existing collision and strict source-binding rules.

Add a narrow namespace-addressed trust read backed by existing validators/catalog builders. It must preserve the existing project-bound manifest fingerprint algorithm; never pass a project hash as a fabricated project-root path. Existing root-based APIs continue to work unchanged.

A source Run is eligible only if all of these hold:

1. Namespace is canonical lowercase 64-hex; record filename is canonical lowercase UUID-v4 `.json`.
2. The record parses through the existing strict schema-v4 parser. Unsupported historical schemas and archives are excluded without migration.
3. `(projectId, recordId)` resolves uniquely. Exclude every occurrence of a duplicate locator, including duplicate locators with different fingerprints. The shared ref canonicalizer alone is insufficient for this pair-level check.
4. `RunEvaluation.attributionEligible` is true: `completed_before_run` is excluded.
5. Final Policy exists and its continuous final-Policy exposure is strictly positive, using the existing last-activation calculation.
6. Every final selection has status `seed` or `promoted`, and resolves exactly against that Run's *owning project's* current complete trusted portfolio: ID, kind, revision identity, fingerprint and immutable semantics must match.
7. Any `trial` selection in the final Policy excludes the entire Run, including its co-occurring Seeds. A Trial revision subsequently promoted is still excluded when the record says `trial`.

A local revision trusted only in A cannot qualify a record from B merely because A trusts it. A valid global revision can qualify B's record through B's complete portfolio. Equal exact global revisions used in different projects remain the same Policy profile; do not manufacture profile diversity by prefixing profiles with project IDs.

Do not require passed Verification or completion. Failed, blocked, unfinished, errorful and denied-call evidence remains eligible if the rules above hold. No semantic success is inferred from Task prose, hypothesis text, duration or cost.

### Trial and learning-Run observability

Schema-v4 has no persisted Run-mode discriminator or full Policy activation history. Therefore v0.2 cannot exclude every historically armed Trial Run by label. As with local `/derive`, a Trial Run that never selects the Candidate and records an exposed trusted final Policy may qualify. A Trial selection earlier in a Run but absent from the final snapshot is not retrospectively detectable either. These are final-Policy evidence, not proof of an uncontaminated experiment.

Existing `/adapt` and `/derive` Runs produce no ordinary Experience: SI excludes their generations at settlement. Extend that exclusion to `/derive-global`, including Runs that produce no Candidate or fail. Do not infer these modes from prose, add schema-v5, or retrofit historical flags.

## 5. Deterministic sufficiency

Use this versioned factual gate on both the shown packet and the exact model-cited subset:

```text
distinct qualified record locators >= 3
distinct project IDs              >= 3
distinct exact Task goal strings   >= 2
distinct Policy Evidence Profiles  >= 2
```

Three projects is the smallest proposed floor beyond a bilateral comparison: it prevents two namespaces, however prolific, from constituting cross-project synthesis. It is a product admission threshold, not a confidence level. Three records, one from each project, can suffice; multiple records per project are not mandatory.

Goals are compared before presentation truncation, using exact strings without semantic clustering or project prefixes. Profiles reuse `policyEvidenceProfileId()` unchanged. Count qualified locators, not fingerprints alone and not bare UUIDs. No minimum positive-outcome count or outcome-variety gate is introduced.

The only conclusion is: “Enough diverse factual evidence is present to ask whether a missing abstraction might exist.” It establishes no novelty, utility, superiority, causality, quality, reward or rank.

## 6. Deterministic bounded selection

### Bounds and ordering

- At most **8 shown Runs**, matching local Derivation's evidence bound.
- At most **2 shown Runs from one project**; therefore at most 8 represented projects.
- Task goal presentation at most **512 characters**, using local truncation behavior.
- Each represented portfolio retains the existing `MAX_TRUSTED_PORTFOLIO_ENTRIES` bound and existing semantic field limits. Shared identical entries/semantics are rendered once with explicit project membership.
- No transcript, tool output body, source file contents, Skill body, or full historical Experience dump enters the packet.

Sort eligible records by parsed `recordedAt` descending, then exact timestamp text descending, then `projectId`, `recordId`, and fingerprint ascending, with locale-independent comparisons. Project enumeration is canonical lexical order. Timestamps are ordering facts, not quality or authority.

The on-demand scan may read all live records through the existing reader. Bounded *context* does not imply bounded historical disk I/O. Do not silently cap scanning to the newest records and call the remainder insufficient. Scan failure/cancellation fails the command; optimizing very large histories is deferred until a real requirement exists.

### Selection algorithm v1

1. Validate/evaluate all sources and compute the full eligible-pool gate. If insufficient, report counts and stop without a model turn.
2. In stable ordered-pair order, find the first pair of records that differs in **both** exact goal and Policy profile. This is diversity selection, not outcome scoring. Such a pair exists whenever both diversity counts exceed one.
3. Starting with that pair, add the first ordered record from an unrepresented project until three projects are represented. The witness contains three or four records, and never exceeds two records per project. Thus a sufficient eligible pool always has a bounded sufficient witness; a high-volume project cannot exhaust packet capacity before the cross-project gate is met.
4. Fill to eight records, subject to the two-per-project cap. At each step prefer, in order:
   - the lowest current selected count for that record's project (unrepresented projects first);
   - a previously unseen factual outcome signature;
   - a previously unseen exact goal;
   - a previously unseen Policy profile;
   - the stable record order above.
5. The outcome signature is the exact tuple `(verificationPassed, completedDuringRun, hasBlockers, hasQuestions, humanGateOpen, toolErrors > 0, deniedCalls > 0)`. All signatures are symmetric; none is “better.” This is only a tie-break for factual coverage, not a learning score.
6. Canonically order the selected Runs for presentation, recompute the shown-set gate, and freeze the packet. Failure is a command error, never permission to show an insufficient packet.

Expose eligible/shown/omitted counts, eligible/represented project counts, invalid/unsupported/duplicate-source counts, and shown gate facts. These are inventory facts, not model evaluation. The bounded packet need not show every outcome or every eligible project.

## 7. Packet and captured authority context

Proposed `CrossProjectDerivationPacketV1` contains:

```text
packetVersion: 1
selectionVersion: 1
sufficiencyVersion: 1
attemptId, capturedAt
invocationProjectId                    # operational context only
limits                               # the fixed bounds in section 6
inventory                            # aggregate factual scan counts
shownSufficiency
sourceRefs[]                         # canonical qualified refs, 3..8
runs[]                               # bounded factual projection for those refs
authorityContext
boundaryText
packetFingerprint                    # canonical packet body excluding this field
```

Each Run includes its qualified ref, recorded timestamp, bounded goal, exact-goal digest, final Policy identity/profile/exact selections, declaration counts/progress, continuous exposure calls/ratio, Verification/completion facts, blockers/questions/Gate facts, tool errors/denials, duration and cost. Reuse local packet projection semantics; digest the exact untruncated UTF-8 goal solely to bind displayed gate identity. Compute gates from the actual strings, not the displayed truncation.

`authorityContext` contains:

- Complete identity-only portfolio v1 manifests/fingerprints for each represented project.
- Resolved immutable Strategy semantics for those manifests, deduplicated by exact identity only when semantics also match.
- Explicit per-project trust origins and source-project bindings. Capture exact validating Candidate/Decision artifact references and canonical artifact digests for learned entries, including the Scope and source authority chain for global entries.
- One versioned canonical context digest binding all of the above, including provenance that existing manifest fingerprints intentionally omit.

Different local revisions using the same logical ID in different projects remain namespace-qualified facts. Do not merge them into a fictitious single globally coherent portfolio or resolve one project's conflict by picking another project's revision.

The captured comparison universe is Seeds, user-global trust, and local trust in the **represented** projects. The packet explicitly says that omitted projects and external Strategies are not covered by its missing-abstraction comparison. Reject new proposal IDs and exact semantic duplicates against this complete bounded comparison universe, not against arbitrary untrusted Candidate history. This does not prove world-wide novelty or reserve an ID globally.

Packet text marks all historical Task goals and Strategy prose as quoted data, not instructions. Inject it only into the bound `/derive-global` Run through existing SI prompt contribution plumbing. Reuse existing packet-history handling and add the new marker to any mode-specific context filtering. Never reconstruct an executable lease from conversation text or a compaction summary.

## 8. `/derive-global` command and native Run lifecycle

### Admission

CPL owns and registers `/derive-global`, with no arguments in v0.2. SI and CPL must both be selected. Require an idle Agent, loaded canonical invocation project and a current native Session. No Task is created or altered; an existing Task's status is not interpreted as derivation work.

Through a narrow SI operation, reserve the single SI slow-path admission slot **before asynchronous evidence preparation**. Reservation is runtime-only, bound to invocation project/root, native Session and a lifecycle epoch. This closes double-command races while reading. `/adapt`, `/derive`, local Trial and Scope Trial admission must reject while this reservation/attempt exists, and global admission rejects any of theirs. Trust-changing command handlers must not write during the active read-only generation; they must respect the same busy exclusion, not merely rely on model-tool restrictions.

After reading/selection, recheck Session, root, lifecycle epoch, idle state and exclusive ownership. Establish the pending derivation attempt and request one native Pi Run through the same explicit user-message delivery pattern as `/derive`. Launch failure releases the reservation; insufficient evidence never starts a model turn.

### Binding and authority

SI owns a small extension of the existing derivation slow-path envelope: local vs cross-project mode plus an opaque attempt token, rendered packet and exact allowed Candidate tool identity. CPL owns its typed packet and provenance lease. SI does not import their implementation types. Both use the same invocation binding and invalidation token; no independent CPL Run scheduler is created.

At Run start, SI binds the pending attempt to exactly one Agent Run generation. CPL revalidates its captured source/authority context before packet injection through a fixed attachment callback. Failure clears the attempt and rejects the requested slow path; never silently reinterpret its request as ordinary coding.

Keep the read-only *Run-generation marker* until settlement, even after Candidate creation consumes the creation lease. Otherwise consuming the Candidate could accidentally restore mutation or allow the Run to record normal Experience.

### Tools and restrictions

Reuse `policy.derive` as a runtime-only derivation control effect, not a normal Task capability. New tool:

```text
pindie_strategy_global_derivation_candidate_create
```

Register it as project-mutation effect `none`, with the same Candidate telemetry category. Admission requires the active **global** mode, exact tool identity, matching token/Session/root/generation and fresh authority. The local tool requires local mode. Sharing the capability must not make the tools interchangeable.

Allow existing `observe.project` and `observe.git` tools plus this exact creation tool. Block Policy declaration, Task/Gate/Verification/Memory tools, other Candidate tools, project writes, generic shell and unknown tools. Bash remains conservatively mutation-ambiguous even if its text claims to be read-only. Observation can inform discussion but cannot add source refs to the frozen packet.

Use existing Core/SI startup effect and Run-control ports for affordances and Gateway enforcement. Do not introduce a second Tool Surface manager or enable tools absent from the Pi/user baseline. If generic Core diagnostics need to mention both derivation commands, change wording only, not Core ownership.

### End and invalidation

Session replacement, same-Session resource reload, project change, shutdown, abort/settlement or a different Run generation clears pending/active permission. Recheck after each asynchronous boundary. Compaction within the same live generation does not create a second attempt. Failed/optional-no-Candidate Runs still settle normally through Pi and release the slot.

SI excludes the entire generation from ordinary Experience and active project-work continuation, as for existing derivation. Preserve settlement ordering: authority refresh/freeze → SI observer/exclusion → lease cleanup → continuity/Host publication → Core bookkeeping cleanup.

## 9. Dedicated global hypothesis Candidate

Do **not** evolve `StrategyDerivationCandidateV1` or overload Scope Candidate. Their single-project and existing-source bindings are incompatible with synthesis provenance. Add a new strict immutable schema in its own namespace:

```text
~/.pindie/global/strategy-cross-project-derivation-candidates/<uuid-v4>.json
```

Proposed contract, with all unspecified fields forbidden:

```ts
interface CrossProjectStrategyDerivationCandidateV1 {
  schemaVersion: 1;
  candidateType: "cross-project-derivation";
  candidateId: string;                // Harness UUID-v4
  createdAt: string;                  // Harness canonical timestamp
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
    sourceRefs: readonly CrossProjectExperienceRefV1[]; // exact cited subset
  };
  derivationContext: {
    packet: CrossProjectDerivationPacketV1;
  };
}
```

The packet is embedded once as a **bounded historical derivation receipt**, not as a global Experience collection or renewable trust catalog. This preserves exactly what the model saw, the selection/gate version, source content bindings, comparison universe, observed trust chains and their semantics if live source files later disappear. Full Experience records are not copied. All packet refs remain project-local locators; the source files remain authority for fresh evidence resolution.

The receipt is the only proposed future-proofing beyond a plain proposal: later validation can refer to an exact typed Candidate and inspect its derivation context without inventing a source project or rewriting it. Do not add target projects, Trial budgets, trust status, confidence, score, promotion fields or mutable evidence accumulation.

Reuse local proposal limits: ID 1..64 lowercase ASCII kebab-case; summary ≤512; guidance item ≤256 and up to eight items; nonempty `useWhen`/`principles`, optional empty `avoidWhen`; hypothesis ≤1024. Source refs contain 3..8 unique locators, are canonical sorted, must be a subset of packet refs and must themselves pass the full cross-project gate.

Model tool input contains only the proposal fields, hypothesis and cited qualified refs. IDs, timestamps, context, fingerprints, scope interpretation and provenance are Harness-authored. The model cannot supply a portfolio, rewrite a ref fingerprint, or assert trusted status.

### Identity and fingerprints

- Durable artifact identity is `(candidateType, candidateId)` in the dedicated user-global namespace, never invocation project + Candidate ID.
- Reuse strict canonical UUID/field validation and create-without-replacement publication patterns.
- Define versioned canonical SHA-256 packet/context/artifact fingerprints for this new type; do not change any existing fingerprint algorithm. The complete artifact fingerprint binds its exact proposal, hypothesis, source refs and receipt.
- These are artifact/provenance identities, **not** an authorized `StrategyRevisionSelection`. Eventual revision-selector semantics belong to the later validation design.
- Invocation project is an audit fact only. It need not contribute evidence and does not own the hypothesis. Relocating the invocation project cannot change the Candidate's durable identity.
- Inactive Candidates reserve no trusted logical ID or global portfolio capacity. Repeated explicit attempts may produce distinct inactive hypotheses; v0.2 does not add semantic deduplication across all Candidate history.

## 10. Creation, concurrency and freshness

At creation:

1. Validate exact input shape, global mode/lease and packet membership before I/O.
2. Acquire the existing shared user-global writer lock. Never hold it across the model Run.
3. Re-resolve every shown qualified source ref and its fingerprint, reconstruct represented-project trust, and compare exact captured context including provenance. Revalidate the submitted subset's eligibility and complete gate. No current-presentation fallback is permitted.
4. Reject a trusted logical-ID collision or exact trusted semantic duplicate in the captured comparison universe, using existing semantic equality rules.
5. Recheck root/Session/lifecycle/generation after asynchronous reads. Reserve publication for this attempt with a single in-flight latch and one preallocated Candidate ID; serialize tool execution.
6. Publish the immutable artifact using the existing atomic no-replacement pattern, with a final binding check at the publication boundary. On success permanently consume the attempt's creation permission, retaining its read-only generation marker until settlement.

Use an explicit publication linearization point: invalidation before commit authorization cancels publication; invalidation after commit authorization cannot turn a successfully published inactive artifact into an active permission or trigger a second write. An ambiguous I/O result must be reconciled against that same Candidate ID/content, never retried with a fresh ID. Definite pre-publication failure may be retried within the still-current attempt; a committed artifact permits no second Candidate.

New unrelated Experience appended after capture does not invalidate the packet or force reselection. Any shown record deletion/replacement, changed represented portfolio or changed authority provenance invalidates it: start a new explicit attempt. Changes in omitted projects do not claim to be covered. The lock serializes cooperating trust writers; manual out-of-band file tampering is detected by strict re-reads/fingerprints, not prevented by a fictional global filesystem transaction.

## 11. Failure behavior

| Condition | Behavior |
| --- | --- |
| No project/Session, busy Agent, bad command args, conflicting slow path | Diagnostic; no model Run, no Candidate |
| Missing Experience directories | Empty evidence, potentially insufficient |
| Noncanonical project namespace, malformed reader collection, enumeration/read failure | Abort this derivation; do not silently present a partial successful scan |
| Unsupported/malformed individual Experience | Count and exclude; never repair |
| Duplicate qualified locator | Exclude all occurrences; report count |
| Malformed relevant local/global trust or collision | Fail closed for derivation; never fall back to Seeds to make evidence qualify |
| Insufficient pool/shown/cited set | No Run or no Candidate as appropriate; factual counts only |
| Unknown/wrong fingerprint/cross-namespace substituted ref | Reject; no bare-UUID fallback |
| Candidate tool called in normal/local/Trial Run | Deny through runtime/Gateway and tool binding |
| Stale Session/root/generation or changed packet sources/authority | Invalidate attempt; fresh explicit command required |
| Store failure | No claimed success; reconcile same-ID publication before any retry |
| Model proposes nothing | Valid outcome; no Candidate and no fabricated negative judgment |
| Corrupt inactive global hypothesis file | Inspection/related creation diagnostic only; never poison existing global trust or ordinary coding |

Diagnostics and packet text remain bounded. Failure never mutates `PindieState`, closes an unrelated Human Gate, writes a trust Decision, deletes evidence, or weakens existing authority.

After creation, missing evidence or changed trust does not rewrite/delete the Candidate. Its receipt is historical provenance, not proof that the source remains valid today. Any future validation must distinguish historical inspection from fresh evidence qualification.

## 12. Distinct Candidate concepts

| | Local Derivation Candidate | Scope Candidate | Cross-Project Derivation Candidate |
| --- | --- | --- | --- |
| Question | Missing abstraction in one project's portfolio? | Wider trust for an existing exact revision? | Missing abstraction suggested by multiple projects? |
| Source | Local Experience + one portfolio | Promoted local Derived revision | Qualified cross-project Experience + bounded multi-project authority context |
| Semantics | New local proposal | References existing immutable source semantics | New hypothesis proposal |
| Durable binding | One project | Exact source project/revision; global artifact | User-global typed artifact; no source Strategy |
| Evidence identity | Bare IDs within bound project | Qualified Trial refs in review/Decision | Qualified derivation refs and bounded receipt |
| v0.2 lifecycle | Existing local Trial/review/Decision unchanged | Existing Scope Trial/review/Decision unchanged | Inactive creation only |

Do not add this type to existing `/trial`, `/trial-review`, `/promote`, `/reject`, `/trust-transfer`, promoted catalogs or normal Policy completion. Those paths must not reinterpret its UUID or JSON shape as an existing Candidate. A read-only file inspection is enough for v0.2; a new generic Candidate browser is not required.

## 13. Explicitly unchanged semantics

- CPL v0.1 transfer eligibility, exact source binding, Trial attribution, two-target-project promotion gate, Scope Decisions and normal user-global projection.
- Local `/adapt`, `/derive`, Revision/Derivation Trial and promotion evidence semantics, schemas and fingerprints. Only exclusion/admission wiring expands to account for the new mutually exclusive slow path.
- Seeds, Policy profile identity and exact selector semantics; trust is never a default or recommendation.
- Experience schema-v4, attribution/exposure calculations, project identity and project-local storage ownership.
- Task/Gate/Verification/Reducer/State, project mutation freshness and native Pi ownership.
- Existing shared writer lock, fail-closed local/global trust collision checks and CPL-off safety exception.
- Startup-only feature selection, Core independence, fixed lifecycle ordering, no hot unload or dependency framework.

## 14. Minimal affected modules

Likely new responsibility-focused files (names provisional):

- `src/cross-project-derivation.ts`: eligibility orchestration, gate, selector, bounded packet and receipt value validation.
- `src/cross-project-derivation-candidates.ts`: dedicated artifact, fingerprint and immutable store.
- `src/tools/strategy-global-derivation-candidate.ts`: narrow model proposal/write adapter.

Existing modules with bounded changes:

- `self-improvement-integration.ts`, `strategy-derivation.ts`: shared admission token/mode envelope, exact tool restriction, fixed CPL callbacks, invalidation and Experience exclusion. Extract only genuinely shared pure packet/proposal helpers where duplication would otherwise alter semantics.
- `cross-project-learning-integration.ts`: command, typed global attempt/provenance handling, store/tool dependencies.
- `strategy-trust-safety.ts`, relevant Candidate/Decision readers and `strategy-portfolio.ts`: namespace-addressed complete trust read and provenance projection, reusing frozen validation/fingerprint logic. Keep root-taking public behavior compatible.
- `composition.ts`: explicit CPL-only store construction and narrow dependency wiring.
- Existing context/effect registration points only where needed for the packet marker, exact mode authorization or diagnostic wording. No Core import of CPL types.
- Focused new evidence/Candidate/lifecycle tests plus `tests/composition.test.ts`, `tests/extension.test.ts` and relevant existing SI/CPL tests.

Do not change `run-experience.ts` schema, `state.ts`, transitions, trust Decision schemas or existing global projection to admit this new type.

## 15. Implementation slices and acceptance criteria

These are proposed slices for later approval, not a continuation of Composable Slices A–F.

### Slice A — Qualified evidence and foreign-project trust facts

Implement namespace-addressed complete trust reads and bounded provenance values; reuse existing qualified refs/evaluation.

Acceptance:

- Same bare record ID in two projects resolves distinctly; changed content cannot satisfy an old ref; duplicate pair with differing fingerprints is rejected.
- Tests cover schema-v4 validity, unsupported/malformed files, noncanonical namespaces, missing stores and injected malformed collections.
- Eligibility matrix covers completed-before-run, absent/zero-exposure Policy, trusted Seeds/local/global revisions, wrong namespace, semantic/fingerprint mismatch, Trial final selections and the documented trusted-final-Policy Trial limitation.
- Foreign project roots are never inferred; current local/global fingerprint fixtures and trust collision behavior remain byte-compatible.
- Relevant malformed trust fails closed without affecting normal coding.

### Slice B — Gate, deterministic selection and packet

Implement pure cross-project selection and receipt construction; no model command yet.

Acceptance:

- Two projects never suffice; three can. Exact-goal and exact-profile diversity remain independently necessary.
- Shown and cited-set gate helpers count qualified locators, not bare UUIDs or truncated goals.
- Permuting reader order produces identical packet output; timestamp ties are deterministic.
- Hundreds of records in one project cannot dominate: eight total, two per project; a sufficient pool produces a sufficient witness even when rare goals/profiles/projects are old.
- Negative outcomes survive eligibility and are preferentially exposed only by symmetric diversity tie-breaks.
- Packet/portfolio/proposal string bounds are enforced; receipts bind untruncated goal identities and trust provenance without full Experience copies.

### Slice C — Immutable inactive global Candidate substrate

Implement strict schema/store/fingerprints and fresh proposal validation against a supplied frozen context, without user command exposure.

Acceptance:

- Exact fields only, typed namespace, canonical IDs, atomic no-replacement writes and full fingerprint round trips.
- Model cannot set identity/context/trust; wrong packet refs, pair duplicates, insufficient cited subsets, trusted-ID collisions and exact semantic duplicates fail.
- Invocation project is not source ownership; a Candidate can cite three entirely different projects.
- Existing local/Scope validators do not accept the new schema; no normal selector/catalog/Trial/promotion path admits it.
- Bounded receipt survives source deletion as historical inspection only, never as renewed evidence authority.

### Slice D — Explicit command, shared Run restriction and safe publication

Wire CPL command/tool through narrow SI ports and native Pi delivery.

Acceptance:

- No-args explicit command only; no background work or model turn for failed admission/insufficiency.
- All pairwise `/adapt` / `/derive` / local Trial / Scope Trial / `/derive-global` exclusions hold, including simultaneous async preparation.
- Exactly one Run gets the packet; local/global Candidate tools cannot cross-use `policy.derive`.
- Observation remains available; shell, mutation, Policy, Task/Gate/Verification/Memory and trust writes are denied for the global generation.
- Stale Session, same-Session reload, root change, shutdown, abort, generation change, authority/source change and delayed callbacks invalidate correctly.
- At most one artifact is committed, including concurrent calls and ambiguous write retry. Consuming creation permission does not lift the read-only Run restriction.
- All global derivation Runs produce no ordinary Experience or project-work continuation; ordinary Trial settlement order is unchanged.

### Slice E — Composition and compatibility closure

Acceptance:

- Core-only, SI-only, SI+CPL and default assemblies pass; CPL-off removes command/tool/store/packet/scan but retains existing global trust safety for local writes.
- Import-direction checks prove Core does not depend on CPL and SI does not import CPL business types.
- Existing local Derivation, CPL v0.1 transfer/Trial/review/promotion and source-binding tests remain unchanged in meaning.
- No State/Experience/trust schema migration or reinterpretation; inactive global hypotheses remain absent from normal Policy presentation/resolution.
- Focused tests, isolated-HOME `pnpm run check`, and `git diff --check` pass; implementation guidance records the exact inactive-only boundary.

## 16. Intentionally deferred Global Hypothesis Validation

v0.2 ends at an inspectable inactive artifact. The following require a separate approved design:

1. What explicit Trial artifact/selector can refer to this new origin without pretending it is a transferred local Strategy?
2. Who chooses target projects, and must they differ from the derivation source projects?
3. How many projects/Runs are necessary, and what factual Trial/review gate is appropriate?
4. How are explicit per-project Trials armed, and how can evidence accumulate without mutating the Candidate or creating a queue?
5. What is the Human review/rejection/promotion artifact, and what exact authority could grant user-global trust?
6. What happens when a proposed logical ID later collides with trusted authority or another validated global hypothesis?
7. Does future trust depend on original source evidence remaining available, or only on a later immutable Human Decision and independently validated semantics?
8. How should failed or abandoned hypotheses be inspected/retained without ranking or automatic recommendations?
9. Is any stronger project-independence or repository-portability identity actually needed?

No answers to these are encoded speculatively in the v0.2 Candidate. In particular, neither `/trust-transfer` nor existing Scope Trial is a shortcut from this hypothesis to trust.
