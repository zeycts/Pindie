# Autonomous Learning R4-C3-C7 — Recovery admission and new attempt boundary

Status: **C7-A immutable admission persistence and C7-B unique successor materialization implemented, standalone only.** [C5/C6](autonomous-learning-r4-c3-c5.md) remains the confirmation/fencing boundary. Sections 12–13 record implemented permission, target selection and v2 `created` persistence. Recovered execution, fresh pre-claim admission, production adapters, scheduling and EvaluationResult handling remain future work. Execution requirements elsewhere in this document are design requirements, not runtime claims.

The recommended rule is: **one reconciled, durably fenced attempt may obtain one immutable admission authorizing one recovery opportunity, only when the entire logical evaluation remains safe to retry.** An immutable unique successor binding selects the exact new attempt; only `claimExecution()` grants its execution ownership. A consumed old attempt is never reopened, reset, reclaimed, transferred or executed again.

## 1. Current facts and scope

[R4-C3-B](autonomous-learning-r4-c3-b1.md) invokes a registered evaluator after uniquely claiming an exact committed `created` run. Its output is transient; it publishes running/terminal lifecycle, not EvaluationOutput or EvaluationResult artifacts. [C4](autonomous-learning-r4-c3-c3.md#10-r4-c3-c4-implemented-observational-assessment) observes freshness only. C6 persists an authority origin at epoch zero and a stale-confirmation revocation at epoch one, rejecting old-owner terminal, heartbeat and ordinary publication after that frontier. C6 confirmation leaves the old run `running`.

Important implemented limits:

- C6's monitor is an injected trusted assertion covering publication-capable actors. It is not an OS/runtime termination detector and does not independently prove that external provider execution or side effects have ceased.
- The current evaluator interface is capability-limited, not a process sandbox; an injected evaluator can retain ambient filesystem/network authority.
- EvaluationRun v1 rejects unknown fields and has no recovery lineage or logical job identity. [EvaluationResult v1](autonomous-learning-r4-a.md) is a pure contract with packet/hypothesis binding, without attempt/job provenance or a production result publisher.
- C7-A supplies a strict operational recovery policy and admission writer with registered reconciliation/resource gates. It supplies no native runtime isolation, provider cessation detector, production accounting adapter or recovery dispatcher.

Therefore existing confirmation records alone cannot admit recovery. This design does not reinterpret the LearningJob target's lease reconciliation in [Autonomous Learning v1](autonomous-learning-v1.md#3-learning-scheduler-and-durable-work) as permission to reset an EvaluationRun or replay its consumed claim. A job may retain its logical identity across attempts; a run is one immutable execution attempt.

## 2. Exact recovery eligibility

Eligibility is a deterministic transient projection of current factual inputs, not a model judgment, persisted phase or bearer token. `ELIGIBLE_FOR_ADMISSION` requires **all** of the following at the admission commit frontier:

1. **Acknowledged fence:** exact StaleConfirmation lookup succeeds, its canonical digest and full authority chain validate, and revocation durability is acknowledged. Lost acknowledgment must first be reconciled and directory durability synchronized through the confirmation boundary. Merely finding file bytes is insufficient.
2. **Exact old execution:** current old run history is coherent and still names the exact `running` snapshot in the confirmation. Project, resolved projects root, start timestamp, packet and evaluator are identical. A valid terminal is handled by reconciliation below, never ignored to fit a stale-retry path.
3. **Exact authority:** the origin is epoch zero, current authority is that exact confirmation at epoch one, and the previous authority/lease ref, owner, claim ID and incarnation all match their validated histories. The old claim remains irrevocably fenced through every applicable writer route.
4. **Exact immutable input:** the original packet resolves and validates its complete schema, scope, ref and content fingerprint. The exact evaluator name/version is registered with the same frozen operational execution contract. No updated packet, evaluator version or fallback model is silently substituted. Where a runtime/model policy applies, its immutable binding must also match the retry contract.
5. **Complete cessation and isolation:** a trusted runtime can freshly establish that every old local worker, asynchronous publisher, child, external execution handle and relevant retained capability has stopped or is permanently contained. Confirmation's publication-actor proof is necessary but may need additional external-execution facts. A provider request that may still run is unresolved, even if no local callback remains.
6. **Safe reconciliation:** Section 3 yields `SAFE_NO_COMMITTED_OUTPUT`, with no unresolved temporary/link/sync/acknowledgment frontier, committed output/result/receipt, external effect or live output writer anywhere in this logical evaluation's attempt lineage.
7. **Exact opportunity:** the old run is the last admitted attempt of one unambiguous logical evaluation chain; it has no admitted successor. Root identity, parent, confirmation and derived next generation are exact. No fork, orphan, independent sibling dispatch or conflicting request/job binding exists.
8. **Current authorization and policy:** a separately registered Recovery admission capability is authorized for this exact project, logical evaluation and predecessor under the current controller/project generation. The versioned deterministic policy allows this evaluator and the `fenced-owner-cessation-no-output` class, and its recovery count is below the limit.
9. **Resources:** bounded run, admission, authority and lease capacity is reserved; a fresh conservative recovery budget reservation fits Human-configured aggregate/per-evaluation limits. The old attempt's possibly incurred cost is not erased. Unknown usage is charged conservatively or blocks admission.
10. **Execution readiness:** the native isolated Evaluation runtime, required model/provider and execution adapters are available and support the exact contract. Work Plane preemption, project/Host/quota and operational capacity gates permit learning work. Availability at admission is rechecked before actual claim; it is not a durable entitlement to capacity.

`INELIGIBLE` covers known prohibitions: existing output, unsupported evaluator, limit exhaustion, missing authorization or a non-recoverable terminal. `UNKNOWN` covers uncertain cessation, absent/corrupt required history, unsupported publication provenance, ambiguous effects or unavailable storage. Neither permits a new admission. Absence of a prerequisite is never converted into a timeout-based permission.

## 3. Reconciliation before admission

Reconciliation inspects the **whole exact logical evaluation lineage**, not merely the latest run. A trusted, bounded operational inspector combines validated artifacts with the captured execution/publication capability manifest and runtime/provider facts. Its report binds root/attempt refs, confirmation, publication-surface versions and exact evidence/frontiers. It grants no execution authority and is freshly revalidated under the commit serialization boundary.

| Observed state | Classification | Admission consequence |
| --- | --- | --- |
| All publishers/external actors ceased; complete coherent history proves no committed output/result/receipt or effect | `SAFE_NO_COMMITTED_OUTPUT` | May proceed if every other predicate passes. |
| Output existed only in memory, with positive proof it was never durably published/exported and all holders ceased | `SAFE_NO_COMMITTED_OUTPUT` | Discard memory; do not salvage or inject old output into the replacement. Merely lacking a returned runner outcome does not prove this state. |
| A temporary artifact is proven private, unlinked and inaccessible to any future publisher; publication has definitively ended | `SAFE_NO_COMMITTED_OUTPUT` | May proceed; cleanup is separate and unnecessary for authority. A temporary filename alone proves nothing. |
| An exact committed operational output exists, with or without a terminal/result | `COMMITTED_OUTPUT_EXISTS` | Block re-execution. A later output-to-result completion contract may resolve it without rerunning; C7 defines no salvage or conversion. |
| An exact valid result/terminal receipt exists for this logical evaluation | `COMMITTED_RESULT_EXISTS` | Recovery is unnecessary/forbidden. Resolve its exact provenance through its own read/acknowledgment boundary; do not generate another semantic evaluation result. |
| A valid old terminal exists | `TERMINAL_EXISTS` | No C7 stale recovery. Resolve its exact committed outcome, even if acknowledgment was lost. `completed` does not imply a result exists; ordinary failed-attempt retry requires a separate policy/specification. |
| A final link may exist, directory sync/acknowledgment is uncertain, or a writer frontier cannot be resolved | `PUBLICATION_AMBIGUOUS` | Block until exact history and durability reconciliation establish one of the above states. Never infer “nothing committed” from a thrown write call. |
| Provider execution, child work or external effects may still exist | `EXTERNAL_EXECUTION_UNKNOWN` | Block. A partition, local abort acknowledgment or inability to query the provider is not proof of cessation. |
| Required namespaces/manifests/provenance are missing, incomplete, corrupt or unsupported | `HISTORY_UNKNOWN` | Fail closed; no automatic repair, deletion or inferred result ownership. |

“No output” requires a **closed publication surface**: every admitted writer is known, all of its immutable histories can be inspected consistently, and it cannot publish after the inspected frontier. A directory scan returning no files does not establish this. For current B, positive runtime facts must show that output/result/export capabilities were absent and ambient effects were contained; capability omission in the input object alone is insufficient. C6's assertion cannot be upgraded to that stronger fact by renaming it.

If a future output/result writer is introduced, it must bind logical evaluation, attempt, authority epoch and publication identity, and participate in the same fencing/serialization boundary **before** recovery is enabled with it. A packet-matching EvaluationResult v1 without exact attempt/logical provenance is ambiguous; do not guess its owner or treat it as an exact recovered result. Unsupported plausible matching results block admission pending explicit provenance resolution.

C7 allows no replay of consequential external effects. Even a known committed side effect with no output is outside the initial retry class. A provider model call with unknown completion remains blocked; a conclusively stopped observation-only call may be repeated only under the explicit retryable execution contract, accepting separately accounted cost. C7 guarantees at-most-once invocation **per attempt**, not exactly-once computation across recovered attempts.

Reconciliation does not write a terminal to the old run. A coherent `running + revoked` history is an operationally quarantined predecessor and can satisfy this design. It need not be relabeled `failed` before admission, and absence of a terminal cannot be presented as evaluation failure. C6's supported serialized writers cannot produce both an old terminal and its stale-confirmation revocation: terminal first prevents confirmation, revocation first prevents terminal. History presenting both without a separately authorized reconciliation contract is inconsistent and `UNKNOWN`, rather than permission to choose a preferred outcome.

## 4. Logical evaluation and recovery identity

Keep two identities distinct:

- **Logical evaluation key:** a canonical fingerprint of versioned identity facts: project, exact original root `created` ref, exact packet ref/fingerprint and evaluator identity/version. The original independently authorized attempt has generation zero. Root identity is fixed before any recovery; children inherit it exactly.
- **Recovery opportunity key:** a canonical fingerprint of versioned facts: logical evaluation key, exact parent running ref, exact acknowledged confirmation ref, fencing epoch one, derived next generation, exact preceding admission ref, packet/evaluator and frozen operational execution-contract fingerprint. It excludes controller identity, policy revision, clocks and the random new run ID.

Generation is derived from validated lineage: root parent implies generation one; a recovered parent at generation `g` implies `g+1`. The caller cannot choose a generation or skip a parent. Later recovery is possible only after the admitted child itself has been claimed, stale-confirmed/fenced and reconciled. No second successor can be allocated directly from the original parent.

Use both uniqueness constraints under lock: **one admission per `(project, parentRunId)`**, and **one admission per `(logicalEvaluationKey, generation)`**. The opportunity key must recompute from those immutable facts. This prevents a changed policy, confirmer, fabricated confirmation digest or generation from opening another slot. Future successor binding must resolve each stored admission to at most one target run ID; independent UUID allocation is never the deduplication mechanism.

When a production Evaluation LearningJob/request exists, its owning boundary must bind its stable job/request key to this one root and packet/evaluator identity before dispatch. A new root ID for the same job is not a permitted workaround for a consumed claim, limit or existing admission. Normal dispatch, recovery admission and later result publication must all respect that binding. This is an Evaluation-specific identity requirement on the existing job owner, not a new generic job ledger. An independently authorized new logical evaluation is separate work and must not masquerade as recovery or reuse this job's result permission.

Current v1 artifacts have no such job binding. A standalone root may be explicitly bound using its exact committed created ref only when all isolation/provenance predicates are positively established. Uncertain job/root attribution is `UNKNOWN`; timestamps and “same packet” are not lineage evidence.

## 5. Immutable RecoveryAdmission v1

Choose a dedicated, bounded **`RecoveryAdmissionV1`** artifact in project-local `learning-v1/recovery-admissions-v1`, with a dedicated operational ref family outside EvaluationRef, LearningArtifactRef and learning trust/Decision contracts. It is durable permission metadata for one opportunity, without a successor ID, mutable reservation queue or additional run lifecycle.

Proposed strict contents:

- Schema/identity version, project, logical evaluation key, exact root created ref, opportunity key and derived recovery generation; exact preceding admission ref for a recovered parent, null for a root parent.
- Exact old running ref, exact StaleConfirmation/authority ref, original authority ref and current fencing epoch one.
- Exact packet ref/fingerprint and evaluator name/version; exact job/request binding when applicable and the frozen retryable operational execution contract identity.
- Controller/authorization identity and scope, policy version/fingerprint, canonical `admittedAt`, and fixed reason `fenced-owner-cessation-no-output`.
- Bounded frozen reconciliation support and cessation/provenance bindings establishing `SAFE_NO_COMMITTED_OUTPUT`. Live runtime authority is rechecked, never reconstructed from this audit metadata.
- Exact conservative budget reservation identity/limits and reserved storage capacity facts.
- No new-attempt specification, successor UUID, creation timestamp, execution claim or lease. C7-B must select the target through a separate immutable, exclusive successor binding keyed by the exact admission. Published v1 admissions cannot be amended.

The record's fingerprint covers all content. There is one fixed publication slot per logical evaluation/generation; the opportunity key and parent uniqueness are independently validated from complete history. Identical bytes reconcile; different bytes at an occupied slot conflict without overwrite. A losing Coordinator returns the exact winning admission through inspection rather than inventing a second target ID or relabeling its own proposal as identical.

An admission authorizes **one logical recovery opportunity**, subject to fresh materialization and execution gates. It grants no run publication or execution capability. C7-B consumes that opportunity by committing a unique immutable successor binding before publishing its exact `created` run. Repeated consumption must reconcile the exact binding/run, never create a second target. No mutable consumed flag is permitted.

Once committed, admission identity and policy audit never change. Changed authorization, limits, budget or readiness can prevent consumption/claim; they do not free the slot, rewrite admission or grant another successor. A permanently blocked admission remains counted. Release/retention/cancellation policy is separate future work.

**Concrete C7-A scope correction:** the original C7 proposal embedded a successor UUID/specification in admission. The approved C7-A task expressly prohibits successor ID allocation. Permission and target selection are therefore separate immutable frontiers. C7-B must add the exclusive successor binding and reconcile its partial publications; it must not migrate or modify existing admissions. Admission and successor creation are separable because no admitted artifact grants execution by itself.

## 6. Admission and creation transaction

Choose **separate immutable publications inside one serialized operational request**, admission first, then a unique successor binding, then exact new-run creation (the latter two are C7-B). Do not claim filesystem atomicity across namespaces. The admission's exclusive link selects one permission opportunity; the future binding's exclusive link is the unique successor-selection frontier; no target can be claimed before its admission and created artifacts are both validated and durably acknowledged.

Serialization order for the future implementation is:

1. Existing Learning operational budget/admission lock, when global budget/capacity is shared across projects.
2. Project EvaluationRun writer lock, reused to protect recovery history, authority, run creation and relevant publication facts.
3. Project ExecutionLease writer lock for coherent predecessor checks.

C6's `Run → Lease` order is preserved. No path may acquire a global budget lock while already holding project locks. All output/result publishers relevant to recovery must acquire the project Run lock before any private namespace lock and recheck their attempt's authority. Their internal namespace lock order must be fixed before activation. No external cessation wait/model call occurs while these locks are held; already gathered bounded facts are revalidated through trusted operational adapters.

Under the locks, first validate complete run/authority/lease/admission history and job/root binding, then distinguish existing-admission reconciliation from a fresh decision. An existing successor is expected during reconciliation; do not mistakenly apply the new-admission “no successor” or “spare recovery slot” predicates to it. Reconcile output frontiers and recheck current authorization/policy/resources before any target creation. Apply all Section 2 predicates and reserve new budget/capacity only when no admission already occupies this opportunity. Then:

1. If a validated admission occupies the parent/generation slot, reconcile its exact bytes and durability. Do not reserve another budget or publish another permission. Creation/claim still requires fresh gates.
2. Otherwise derive permission-only canonical admission bytes; exclusively write/sync/verify a temporary file, link its fixed slot and sync its directory. A pre-link failure commits no admission. C7-A stops here.
3. In C7-B, under shared serialization, discover or exclusively commit one immutable successor binding selecting a candidate UUID and complete fixed target specification for the exact admission. Reconcile existing bytes; conflicting candidates must resolve the winning binding or fail, never publish a second target.
4. Construct the exact new `created` snapshot from the committed binding and admission refs; validate fresh permission, packet and lineage, then uniquely publish/sync through the narrow RunStore recovery creation boundary. Reconcile identical committed bytes and acknowledge directory durability. Never call `claimExecution()` or an evaluator in this transaction.

Do not call the existing public `publish()` recursively while holding its non-reentrant lock; C7-B uses a narrow private locked creation primitive. Ordinary publication/claim routes must validate recovered-run admission and lineage too, so callers cannot bypass a blocked admission, fabricate a recovered target or claim an orphan.

Budget/capacity reservations are keyed by the immutable opportunity and counted from committed admissions by the existing operational resource owner. Pending admissions reserve space for their target and future authority origin/revocation/lease; ordinary writers must respect those reservations. Admission may carry the reservation facts rather than requiring an independently committed mutable pointer. If a resource adapter requires a separate durable reservation, it must reserve before admission and reconcile by the same key without releasing a possibly committed admission's reservation. That adapter's exact crash contract is an activation prerequisite; “budget probably available” is not a fallback.

No attempt/root/admission identity or required predecessor may be pruned while it is needed for deduplication, resource accounting, live execution or result provenance. At capacity, fail closed; this design introduces no pruning or unbounded history promise.

## 7. Partial publication and crash reconciliation

| Durable state after failure/death | Required action |
| --- | --- |
| No admission linked | No recovery permission exists. A later authorized request revalidates everything and may publish one admission. Private preparation/temp files are not admission. |
| Admission linked, acknowledgment/sync uncertain | Resolve its exact slot, canonical history and durability under lock. Do not assume absence, allocate another UUID or consume a second budget. Unknown storage blocks progress. |
| Acknowledged admission, no created target | Retain the opportunity and reservation; discover or select its one immutable successor binding in C7-B. Freshly authorized reconciliation may materialize exactly that run after rechecking safety and resources. If gates no longer pass, leave it unmaterialized; do not replace the admission. |
| Created target linked, acknowledgment lost | Read exact target/history, compare against the exact successor-binding-derived bytes and reconcile directory durability. Return existing refs; never allocate another run. |
| Admission and created acknowledged, no claim | The target remains a normal `created` run. A later permitted dispatch rechecks current authorization, resources, isolation and no-result facts, then asks `claimExecution()` for its exact snapshot. |
| Target running/origin committed, claim acknowledgment lost | Ownership is consumed. Neither admission replay nor created reconciliation reconstructs a claim or invokes the evaluator. Further recovery needs this child's own acknowledged confirmation, full reconciliation and a new generation within limits. |
| Created target with no valid admission, mismatched target, fork or corrupt predecessor | `UNKNOWN`; no claim, repair-by-recreation or guessed lineage. A recovered run cannot fall back to normal unbound execution. |

An already-materialized target does not become eligible merely because admission was once valid. Fresh pre-claim result discovery, revoked controller authorization, missing packet, changed evaluator/runtime contract, budget uncertainty or unavailable isolation blocks its claim. Runtime-derived blocked/ready observations are not persisted as new EvaluationRun phases.

## 8. Exact old/new attempt lineage

Inherit exactly: project/root, packet ref/fingerprint, evaluator name/version, logical evaluation identity, stable job/request binding where present, root ref and frozen retryable operational contract. Recovery does not refresh TrialEvidence, rebuild the packet, switch evaluator versions or apply a newly selected Strategy. Changed analysis input is separately authorized evaluation work.

Mint anew: run ID, fixed creation timestamp, later start/terminal timestamps, unique live execution claim, epoch-zero authority origin/claim ID, lease origin and execution handle/incarnation. The old epoch one is **not** the new run's epoch; each attempt owns its own authority chain. A fresh isolated execution incarnation is required even if the same Host process dispatches it; C6's process-incarnation metadata alone does not establish a fresh execution handle/Session. The runtime adapter must record/bind that distinction before recovery dispatch is supported.

Choose an explicit, versioned **EvaluationRun v2 recovery extension**, rather than adding unknown fields to strict v1 or inferring lineage from dates. A recovered created snapshot carries logical evaluation key, recovery generation and exact `{ rootCreatedRef, parentRunningRef, admissionRef }`; legal transitions preserve these fields byte-for-byte. Retain the existing EvaluationRunRef v1 envelope shape: its schema version describes the ref, while its fingerprint binds the complete addressed run, including run schema version and lineage. Future readers validate the addressed v1/v2 artifact explicitly; they do not strip or downgrade v2. This avoids requiring changed C6 authority/lease ref envelopes merely to address v2 runs. RunStore history/claim, transition validation and evaluator input preparation still need explicit v2 support before execution. Existing v1 history remains immutable and readable.

Avoid a content-fingerprint cycle: commit permission-only admission first. Future C7-B commits a separate target specification naming its exact admission ref, without the whole new-run fingerprint. Then construct the new v2 created run naming those exact refs and compute its fingerprint. Validators must prove one target per admission and both-direction binding between specification and run. A random UUID alone is never the consumption/deduplication boundary.

Lineage is a linear operational chain, not a generic candidate/job framework. A child can have at most one admission predecessor and a parent at most one admission successor. Validate acyclicity, root consistency, exact packet/evaluator continuity and generation increments from complete bounded history.

The lifecycle is unchanged for both run versions:

```text
old run: created → running             (immutable history, revoked at epoch 1)
                       |
                 exact admission
                       |
                       v
new run: created → running → completed | failed
                       ^
                 claimExecution()
```

The vertical edge is cross-attempt lineage, not `running → recovered`, `running → retrying` or `running → created`. The old run is never relabeled or reopened.

## 9. Minimal deterministic recovery policy

Define a narrowly scoped `EvaluationRecoveryPolicyV1`, configured by the operational owner and captured exactly in admission. It identifies its version/fingerprint and contains:

- Explicit enabled/disabled recovery and a bounded nonnegative safe-integer `maxRecoveryAdmissions` per logical evaluation; zero disables recovery. Initial invocation is generation zero, not a recovery admission.
- An exact allowlist of evaluator name/version and immutable retryable execution-contract identities. Shape-valid or capability-free evaluators are not automatically retryable.
- Initially only `fenced-owner-cessation-no-output` as an allowed recovery class. Exclude arbitrary terminal failures, timeouts, partial outputs, unknown effects and model-quality judgments.
- Positive bounded per-admission token/cost/time reservation ceilings and aggregate evaluation/global budget limits, plus bounded storage/runtime capacity constraints. A spending reservation is not a provider-enforced invocation limit; execution needs its own proven bounds before integration.

Count every committed admission, including unmaterialized and never-claimed targets. A failed materialization or controller restart cannot reset the count. New admission requires the committed count to be strictly below the maximum. Materializing/claiming an existing target does not consume another slot: its recorded generation must fit the current limit, rather than incorrectly requiring a spare slot beyond its own admission. A stricter policy can block that target without freeing its slot. Failed/unknown old usage remains charged under the conservative budget rule. Derive next generation and count from immutable lineage, not clocks, owner strings or a mutable retry counter.

No production default, automatic backoff, polling cadence, failure classifier based on free text, semantic recommendation or generic retry framework is introduced. Policy changes do not change existing opportunity identity or reopen consumed slots; current policy may be stricter at materialization/dispatch. Evaluation model judgment has no role in eligibility, retryability or resource admission.

## 10. Authority and execution admission

| Component/capability | Permitted responsibility | Explicit limit |
| --- | --- | --- |
| Stale assessor | Observe `ACTIVE / STALE_CANDIDATE / UNKNOWN`. | No revocation, admission or invocation. |
| Recovery Coordinator confirmation | Publish C6 exact ownership revocation. | No new-run allocation or execution permission. |
| Recovery Coordinator admission, separately registered | Reconcile and conditionally publish one immutable opportunity; C7-A stops before successor creation. | No live execution claim, evaluator invocation, terminal rewrite or output salvage. |
| Operational resource/job owner | Preserve one logical request/root binding; account budgets/capacity; offer existing created targets when current gates pass. | Cannot reinterpret expired job leases as EvaluationRun execution ownership or remint a successor. |
| EvaluationRunStore | Persist exact immutable lifecycle/lineage; enforce admission and authority checks; grant new ownership only through `claimExecution()`. | Admission inspection, ordinary publication and reconstruction of bytes grant no claim. |
| ExecutionRunner and native Pi runtime | Invoke registered evaluator only after an acknowledged unique new claim and isolated runtime readiness. | No fallback to old claim, caller-provided lineage or unvalidated admission. Pi continues to own the LLM/tool loop. |
| Future output/result publisher | Publish only under exact attempt authority, logical result uniqueness and shared serialization. | Cannot bypass old fences, adopt late old output or race recovery into duplicate results. |

At pre-claim dispatch, freshly check complete admission/lineage, packet/evaluator/runtime contract, authorization and logical evaluation's no-output/result frontier under the project serialization boundary. Resource admission precedes these locks. The RunStore's future claim path for recovered v2 runs must require this narrow execution-admission capability/check; presenting a valid created run or persisted admission cannot bypass it. It then performs the normal unique running/origin commit. Evaluator/model functions receive neither admission nor resource writers.

No live claim is returned to a reconciliation process that merely discovers `running`. The unique claimant alone may invoke; if it fails before invocation, the consumed attempt is still not replayed. New-attempt execution is a separate operation from materialization, even when one authorized caller eventually requests both.

All these components are isolated from Strategy, Policy selection, Trust, Decision and Experience mutation. They consume frozen packets and operational facts, not live Experience, human transcripts or semantic success criteria. There is no new PindieState field, Work Plane queue, phase machine or second Agent Loop.

## 11. Races, safety limits and legacy compatibility

| Scenario | Required outcome |
| --- | --- |
| Two Coordinators propose admissions or future retry UUIDs | Same parent/generation slot serializes admission; C7-B separately serializes target binding. One wins; competitors reconcile exact committed metadata or conflict. Policy/controller/time differences cannot create another opportunity. |
| Result/output publication races admission | Both use the project Run serialization boundary and relevant epoch checks. A prior committed output/result blocks admission. After old revocation, old-epoch output publication rejects; a future publisher must respect the logical admission/result boundary. |
| Existing result discovered after admission but before materialization/claim | Block new creation/claim. Preserve admission and its count; no duplicate result or automatic output salvage. If unexpected publication violated the closed surface, diagnose that inconsistency rather than continuing. |
| Old owner resumes | C6 rejects its old-run publications; it lacks the new claim and cannot target the new run/authority. Resumption contradicts cessation proof: invalidate recovery readiness and quarantine any unclaimed target. If the new attempt was already claimed, stop subsequent publication/admission through an explicit future safety mechanism; C7 does not invent cancellation or a new fence operation. |
| New created attempt never claimed | Keep the exact normal created snapshot. Later authorized dispatch may claim it once; age does not create a replacement, reconstruct a claim or free admission accounting. |
| Recovery limit reached | No new admission. Existing created targets need current execution gates; a stricter policy can block them. Expose an actionable operational limitation without changing learning trust. |
| Corrupt/incomplete admission, result, root or authority history | Fail closed for materialization and claim. No mutable-pointer repair, choosing a sibling, deleting predecessors or resetting limits. |

Local fencing cannot physically stop arbitrary ambient filesystem writes or remote computation. Recovery therefore requires a verified isolation boundary and fresh proof of cessation, not just cooperating metadata checks. If old execution can still affect any protected surface, no new attempt is admissible. A runtime that cannot handle a proven contradiction before output publication is not ready for recovery integration.

Existing v1 runs/leases/confirmations are never rewritten. Legacy unfenced runs, interrupted authority initialization, unsupported evaluator isolation, missing required job/root binding and missing external cessation/publication provenance remain ineligible or unknown. An explicitly bound standalone root does not require an invented LearningJob, as described in Section 4. C6-confirmed roots are eligible for consideration only with newly established exact runtime/provenance facts; the confirmation alone does not retroactively provide them. No migration sweep, automatic adoption or claim reconstruction is designed.

Frozen EvaluationResult v1 remains unchanged. Until an operational result-provenance/uniqueness boundary is approved, recovery may be activated only for an explicitly closed execution configuration that can positively prove no result/output publisher existed or remains. Any result-bearing configuration needs that boundary first. Deduplication of results must be by logical evaluation, not arbitrary result UUID or packet alone; C7 does not implement its store or recommendation semantics.

## 12. C7-A implemented contract and persistence

`src/recovery-admission.ts` defines strict RecoveryAdmission v1, its dedicated exact ref, deterministic identity helpers, operational policy, reconciliation and resource evidence. Unknown fields are rejected recursively. Canonical records are bounded to 16KiB, identifiers to 128 characters, retryable evaluators to 16 unique entries, and counters/amounts to nonnegative safe integers. Policy spending ceilings are positive. Controller authorization is captured by ID/incarnation and authorization fingerprint; policy schema version and canonical fingerprint identify the frozen policy. These are operational permissions, not learning Policy selection.

The binding carries project, exact root-created/old-running/confirmation refs, epoch one, packet ref/fingerprint, evaluator name/version, operational contract fingerprint, generation/previous-admission ref and recomputable logical/opportunity keys. Origin authority, policy/controller identity, canonical admission time, fixed reason, cessation/reconciliation evidence and resource reservation are fingerprinted audit facts. No target run ID or execution capability exists in v1.

Only **generation one for an explicitly reconciled standalone v1 root** is currently writable. Root and old run IDs must agree; previous admission is null. The pure identity schema can represent later structurally linked generations, but persistence refuses them until exact successor lineage exists. It never accepts caller-selected generation jumps or silently associates independent roots using packet identity. A production job-bound configuration is unsupported until its owning adapter proves a unique job/root association.

`createRecoveryAdmissionCoordinator(...).admit(record)` is a separately registered capability. C6's confirmation Coordinator does not expose admission, and admission does not expose confirmation. Registration captures detached controller/policy values, root-bound run/lease reads, packet reads, explicit synchronous current authorization, clock and trusted reconciliation/resource inspection functions. Inspectors receive frozen exact context, not execution or semantic writers. Submitted safe-looking metadata is insufficient: fresh captured inspector results must match it exactly. Unknown/incomplete cessation, output, effects, publication frontier, root association, isolation, provider/operational readiness or accounting blocks publication. No defaults, elapsed-time inference or model judgment fills missing facts.

The inspectors are **trusted adapter assertions**, following C6's injection boundary; C7-A does not implement OS joins, external-provider termination, filesystem-wide output discovery, native sandboxing, Host/quota readiness or production usage accounting. A closed publication manifest must positively cover every local/external publisher and artifact/effect surface. Known `evaluation-outputs-v1` or `evaluation-results-v1` entries block admission conservatively even when an inspector reports safe. Other surfaces are the manifest inspector's responsibility; empty directories alone never establish safety. A runtime that cannot produce complete exact evidence cannot register a usable admission path. Production wiring remains absent.

`FileRecoveryAdmissionStore` exposes historical **exact `get(ref)` only**. Historical lookup validates the complete bounded project admission inventory, canonical envelope, strict schema, digest/filename/ref/project binding, supported root generation and parent/slot uniqueness. It does not reauthorize metadata as current execution permission and remains readable if a source later becomes unavailable. There is no public store writer or mutable current pointer.

Publication uses a shared projects-root resource/admission lock, then project Run lock, Lease lock and Admission namespace lock, preserving C6's Run → Lease order. The shared lock is runtime serialization only, not a ledger/current-retry pointer. All project admission inventories in that resolved projects-root scope are read under it; at most 4096 projects/admissions globally are supported, with no pruning. Corruption in any required inventory blocks new admission. The exclusive filename is `<logicalEvaluationKey hex>.<generation>.json`; independent history checks also enforce one parent run. Reordered inputs hash identically. Changed exact confirmation/evaluator/packet/contract/generation changes opportunity identity, while policy/controller/time cannot open another slot.

Before publication, and again after temporary preparation immediately before the link, admission revalidates complete coherent old run/authority/lease histories, exact packet/evaluator bindings, current epoch-one confirmation and its epoch-zero origin, claim/incarnation/handle evidence, authorized controller, fresh safe report and resource sample. The exact validated fence's directory is synchronized to acknowledge durability without rewriting authority bytes. Proposed admission/inspection timestamps must exactly match the captured fresh clock sample and must not predate confirmation. The old run remains running and revoked.

Resource accounting requires known or conservative old usage included in evaluation/global base usage. Base usage excludes the reservations independently counted from every committed admission under the shared lock. Pending/never-consumed admissions remain charged; exact replay never double charges. Reservation and aggregate token/cost-micro/time amounts are bounded by the captured policy using overflow-safe sums. Fresh capacity evidence and physical run/authority/lease inventories must leave room after all pending project admissions. These are durable accounting metadata and admission checks. C7-A alone did not protect reservations from ordinary creation paths; C7-B enforces/revalidates them before consumption and reserves physical capacity against ordinary Run creation, execution claims and Lease creation/heartbeat publication. There is no reservation release or provider spending enforcement in C7-A.

Temporary bytes are exclusively created inside `writer.lock`, synced and verified, linked exclusively into the deterministic final slot, and followed by directory sync. Pre-link failure leaves no admission. A linked artifact survives sync/acknowledgment failure; exact retry under locks revalidates sources/fence/current authorization, validates immutable history and synchronizes its directory before returning the exact record. An identical acknowledgment retry does not issue another admission or require a new transient inspection/resource charge; it does not authorize execution. Changed material contents conflict. Dead process locks/private temps are reclaimed through the existing writer-lock convention. Unavailable storage, malformed history or uncertain exact source binding fails closed.

Admission writes no successor, run lifecycle, claim, authority epoch, heartbeat, Strategy, learning Policy, Trust, Decision or Experience artifact. Existing old-owner terminal/ordinary/heartbeat writes still reject under C6 fencing after admission. Tests cover exact/immutable/canonical lookup, strict bounds, deterministic identity, conflicts, source/evidence/authorization failures, policies/resources, corruption, lost acknowledgment, independent stores, separate-process races/death, unchanged histories and namespace isolation.

## 13. C7-B implemented unique successor materialization

**RecoveryAdmission is permission; RecoverySuccessorBinding uniquely selects the target; EvaluationRun v2 records explicit recovery lineage.** Materialization creates only `created`. Recovered execution remains disabled. `claimExecution()` remains the sole future execution-ownership boundary; no binding or discovered run reconstructs a claim.

`src/recovery-successor-binding.ts` defines strict immutable RecoverySuccessorBinding v1 and a dedicated exact ref. It binds the exact admission, project/logical/opportunity identities, generation, root-created/parent-running refs, selected successor UUID, exact packet/evaluator/operational execution contract and fixed `selectedAt`. That timestamp becomes the target's immutable creation timestamp. Records are bounded to 8KiB; unknown fields, foreign refs, malformed identities and mismatched admission facts reject. No claim, authority credential, lease, output or trust state exists in the binding.

Bindings live in project-local `learning-v1/recovery-successor-bindings-v1/<admission fingerprint hex>.json`. `FileRecoverySuccessorBindingStore` exposes exact `get(ref)` and `find(admissionRef)` historical reads only. Complete bounded canonical history validates strict envelopes, digests, filenames, exact admissions and parent/opportunity/target uniqueness. The internal selection helper commits verified, fsynced private temporary bytes by exclusive hard link followed by directory sync; identical bytes reconcile, competing specifications conflict. No mutable successor pointer or UUID-based deduplication exists.

`createRecoverySuccessorMaterializer(...)` in the RunStore module registers the narrow `materialize(exactAdmissionRef, optionalProposedRunId)` capability over a genuine FileEvaluationRunStore, detached current controller/policy, root-bound lease reads and trusted fresh reconciliation/resource/authorization/clock adapters. It serializes **global recovery/resource → Run → Lease → successor-binding namespace**. The binding namespace lock is released after selection while the enclosing locks remain held for exact Run publication. Admission, binding and created snapshot are separate immutable publications, never a cross-namespace filesystem transaction. The internal selection helper exposes metadata only; its documented caller-held locks and factual revalidation are mandatory. It supplies no run writer or execution capability.

Before binding selection and again before Run creation/link, the materializer resolves the exact committed admission, coherent root/old-running/authority/lease histories and original packet, acknowledges the existing epoch-one fence, and checks current authorization, registered retryable evaluator/contract, closed quiescent no-output/effect reconciliation and fresh resource accounting. Trusted adapter assertions remain the C7-A boundary: this slice supplies no OS/provider cessation detector, native sandbox, production accounting or runtime wiring. Known output/result namespaces block conservatively. Current reconciliation may refresh its observation time but must preserve the exact established provenance/closed publication manifest. Changed policy/controller/time cannot open another admission or successor slot.

Budget accounting counts each existing admission reservation once, including this admission. Materialization requires its generation to fit current policy, without requiring another generation or admission slot. Fresh base usage includes conservative old cost and excludes independently counted reservations. Current ceilings/readiness/capacity can block an immutable admission; they never rewrite or release it. Physical run capacity counts already materialized targets once, while pending bindings/admissions reserve uncreated run slots. Every admission continues to reserve future authority origin/revocation capacity and a lease slot because recovered execution is disabled. Ordinary Run creation, v1 claims before their running publication, and Lease creation/heartbeat writes honor these reservations under the Run lock. No reservation-release or pruning policy is added.

EvaluationRun is an explicit v1/v2 union. Strict v1 validation and historical bytes remain unchanged; v2 adds `logicalEvaluationKey`, `recoveryGeneration` and exact `recovery: { rootCreatedRef, parentRunningRef, admissionRef }`. Pure lifecycle validation preserves those fields byte-for-byte across created → running → completed/failed. The unchanged EvaluationRunRef v1 envelope fingerprints the complete addressed snapshot. Store history validates both-direction admission/binding/run identity, exact root/parent snapshots, generation and packet/evaluator continuity without stripping v2. The supported writable admission remains generation one from a fenced standalone v1 root; later generations require the future recovered execution boundary.

The v2 snapshot writer is private to the RunStore module's registered materialization capability. Ordinary `publish(v2)` rejects every status, including valid-looking admitted/bound records. Ordinary v1 publication also rejects IDs already selected by a recovery binding, preventing an unbound v1 target from occupying the crash gap. `claimExecution(v2)` explicitly rejects before publication; ExecutionRunner remains v1-only. No successor running snapshot, execution claim, execution authority origin, ExecutionLease, evaluator invocation or EvaluationResult is created. The old run remains running/revoked; admission and all Strategy/Policy selection/Trust/Decision/Experience bytes remain unchanged.

Crash reconciliation follows the immutable frontiers: before the binding link no target is selected; after it, retries permanently use its fixed UUID/time and never allocate another target. Binding-without-run retries publish exactly that v2 created record. Run-link acknowledgment loss resolves exact history and synchronizes durability. Existing exact created runs reconcile without another budget charge; conflicting targets, siblings, foreign/missing/corrupt sources or malformed history fail closed without overwrite, repair or a second selection. Fresh gates also apply to replay; blocked admissions/bindings remain immutable history.

Focused tests cover v1/v2 strictness and transition/ref binding, canonical exact binding persistence/replay/conflicts, independent instances and separate-process races, process death before binding/after binding/after Run link, publication/claim bypasses, fresh authorization/resource/result gates, physical reservation protection, corrupt/conflicting histories and unchanged fencing/semantic namespaces. No production dogfood or recovered execution is claimed.

## 14. Remaining slices and recommended sequence

1. **C7-B unique successor materialization (implemented):** immutable admission-keyed binding, explicit EvaluationRun v2 lineage and narrow locked `created` publication reconcile partial publications without a second target. Recovered execution remains disabled.
2. **Production reconciliation/resource adapters:** prove isolated execution/provider cessation, every publication/effect surface, stable job/root identity and conservative resource accounting through trusted bounded adapters. Unsupported facts remain closed. Establish logical output/result provenance and uniqueness before enabling any result-bearing configuration.
3. **Fresh pre-claim recovery execution admission:** implement current authorization, policy/resource/isolation/no-result revalidation and explicit RunStore/runner v2 support. Preserve `claimExecution()` as sole ownership authority; an admission or discovered running snapshot cannot reconstruct it.
4. **Explicit bounded runtime integration:** only after those guards exist, support an explicitly authorized recovery through the existing Learning runtime owner. Recovery execution, retry scheduling, EvaluationResult handling and any release/retention policy remain separately approved future work; there is no generic retry framework or semantic trust change.

Recommended sequence: **C7-A permission persistence (implemented) → C7-B unique binding/created attempt (implemented) → complete production reconciliation/resource/result guards → fresh claim admission → explicit isolated recovery execution**. No production execution may consume admission until every applicable prerequisite is implemented and verified.
