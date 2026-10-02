# Autonomous Learning R4-C3-C3 — Stale detection and recovery eligibility

Status: C3 architecture design with the C4 standalone lease-freshness assessment implemented as described in Section 10. R4-C2, R4-C3-A/B and R4-C3-C1/C2 remain unchanged. Owner confirmation, recovery eligibility, monotonic observation windows, publication fencing and runtime integration below remain proposed architecture, not implemented behavior. This document does not authorize production recovery, automatic retry, evaluator restart, EvaluationResult publication, or Strategy/Policy/Trust/Decision mutation.

## 1. Architecture and boundaries

`EvaluationRunStore.claimExecution()` remains the only source of execution ownership. The unique acknowledged publisher of `running` receives the live execution claim; a stored run, lease, stale assessment or recovery eligibility record cannot reconstruct that claim. C2's process-local claim provenance is not durable recovery authority.

| Concept | Owns | Does not imply |
| --- | --- | --- |
| EvaluationRun | Immutable execution lifecycle: `created → running → completed / failed` | An evaluation conclusion or trust change |
| ExecutionLease | Historical owner identity, acquisition time and heartbeat metadata | Authenticated liveness or permission to execute |
| Stale assessment | Observation of metadata freshness and owner cessation evidence | Lifecycle failure, expiry or takeover |
| Recovery eligibility | Whether an authorized controller may attempt fenced operational reconciliation | A new execution claim or evaluator replay |
| Recovery authority transition | Explicit revocation of the old owner's write authority, after fresh checks | A replacement execution owner |

The proposed flow is:

```text
exact current run + exact lease chain + clock/policy + owner facts
                              |
                              v
                   pure stale assessment
                              |
               confirmed cessation, if provable
                              |
                              v
           fresh recovery eligibility validation
                              |
          explicitly authorized runtime controller
                              |
                              v
             durable fence / quarantine only
```

The final transition is a future implementation boundary, not an action delivered by C3 design. No arrow invokes an evaluator. A bounded runtime observer/controller belongs to the existing execution ownership boundary; it is not a scheduler, task queue, phase machine or second Agent Loop.

## 2. Heartbeat meaning and time assumptions

A heartbeat means that one immutable metadata snapshot was durably committed after its exact predecessor. It does not prove useful evaluator progress, a successful model call, responsive external I/O, or that the named owner submitted it. C2 permits a caller with the current exact ref to advance metadata while preserving the owner string. That is an integrity check, not authenticated liveness. `acquiredAt` remains the original claim's `startedAt`, not the moment a later observer notices the lease.

A versioned operational policy supplies a positive stale interval `T`, a maximum supported clock-comparison uncertainty `U`, and a confirmation-sample interval `Q`. These are explicit controller configuration, not model-selected values or fields added to ExecutionLease v1. This design chooses no production default or polling frequency. Observation occurs at an authorized explicit inspection or existing safe operational boundary; no timer is required by this proposal.

Use UTC wall time only for durable audit timestamps and comparisons with existing `heartbeatAt`. The observer also captures a monotonic clock sample and its runtime/boot incarnation. Monotonic elapsed time is comparable only within that incarnation; it is never reconstructed from stored UTC dates after restart. A monotonic source must have a known suspend behavior, or suspend/resume invalidates the observation window.

With reliable same-clock-domain comparison, compute the conservative lower bound on heartbeat age:

```text
minimumAge = observedWallTime - heartbeatAt - U
```

A lease becomes a stale candidate only when `minimumAge > T`. Equality does not establish staleness. `U` must include the combined producer/observer clock error and relevant observation uncertainty; canonical ISO formatting alone establishes no bound. A future heartbeat beyond the supported uncertainty, clock rollback/jump, unknown clock domain, invalid policy, or disagreement between wall and monotonic elapsed time yields `UNKNOWN`, not a stale conclusion. Never clamp a future timestamp to now or silently replace a clock assumption.

When wall-clock comparison cannot be trusted, a candidate can instead be based on two coherent observations of the same exact current lease ref, separated by more than `T` on the same trusted monotonic clock. This measures an observed period without a newly committed heartbeat, not the age of the timestamp. It resets on observer restart, suspend uncertainty, lease advancement or policy change. It still proves neither owner death nor execution failure.

Clock age alone never produces `STALE_CONFIRMED`. A responsive owner can have an old heartbeat because of scheduling delay, paused execution, storage failure or C2 capacity exhaustion.

## 3. Assessment inputs and states

The target Harness assessment computes deterministically from detached factual inputs; the model neither selects the state nor interprets timeout as a failure. Required inputs for the complete future runtime assessment are listed below. C4 implements only the pure metadata freshness subset in Section 10; it does not read or validate runtime run/lease history. Full target inputs are:

- Validated current EvaluationRun and its exact running snapshot ref, including project/root binding, packet identity and start timestamp.
- Complete validated current lease chain, exact current lease ref and origin; origin `runningRef` must match the committed running snapshot and `acquiredAt` must match `startedAt`.
- Versioned threshold/clock policy and captured clock assumptions/samples, including any retained same-incarnation observation window.
- Owner-monitoring facts, if available: exact run/claim binding, unique runtime incarnation, execution handle identity, observation time, and whether owner cessation is conclusively observed.
- Current controller project/generation binding, storage readability and relevant capacity/fencing readiness for the separate eligibility assessment.

Run and lease stores currently have separate locks. A read-only observer can read run, lease, then run again and reject changed bindings; this reduces mixed observations but does not promise an atomic view. Every assessment binds the exact refs it observed and is advisory until fresh commit-time checks. Reads must distinguish absent artifacts from unreadable/corrupt history. A running run without a lease is `UNKNOWN` (`missing-lease`), never an invented expired lease. Terminal/created runs are `NOT_APPLICABLE` for stale running-execution assessment; malformed lifecycle history remains `UNKNOWN` rather than being hidden by a terminal label.

| State | Meaning | Authority/lifecycle effect |
| --- | --- | --- |
| `ACTIVE` | Coherent recent metadata, with no contradictory cessation facts | None; does not certify that execution is alive |
| `STALE_CANDIDATE` | Conservative age or same-ref observation window exceeds policy; cessation is unproven | None; may request bounded owner inspection |
| `STALE_CONFIRMED` | Candidate plus fresh, exactly bound, positive proof that the execution owner cannot continue | None; only input to eligibility checks |
| `UNKNOWN` | Missing, corrupt, incoherent, unsupported or uncertain inputs | Fail closed for recovery |
| `NOT_APPLICABLE` | Valid execution is created or terminal | No stale recovery eligibility |

Assessment is runtime-derived and not persisted in EvaluationRun, ExecutionLease, PindieState or a continuously updated observation log. Retain at most one bounded observation window per inspected running attempt. Restart discards it. If a future authority transition needs an audit record, freeze its exact inputs/proof refs and policy identity at that transition; an old persisted assessment label can never authorize a later action.

```text
ACTIVE --conservative silence exceeds T--> STALE_CANDIDATE
STALE_CANDIDATE --fresh coherent metadata--> ACTIVE
STALE_CANDIDATE --fresh exact cessation proof--> STALE_CONFIRMED
any applicable state --uncertainty/change/conflicting facts--> UNKNOWN
any state --validated created/terminal lifecycle--> NOT_APPLICABLE
UNKNOWN --new coherent facts--> reassess from those facts
```

These are projections, not stored phases. A changed heartbeat invalidates a previous confirmation and requires reassessment. A new heartbeat contradicting cessation proof is `UNKNOWN` until the controller resolves provenance; it must not mechanically become `ACTIVE`. None of these observations calls `transitionEvaluationRun` or writes `failed`.

## 4. Confirmation and recovery authority

Any authorized read-only inspector may compute or display candidates. Confirmation facts come only from a trusted execution runtime/controller that tracked the original claim's exact execution handle and incarnation. The pure assessor verifies those facts and derives `STALE_CONFIRMED`; it cannot fabricate them from an owner string or a timeout.

Acceptable cessation evidence is a controller-owned execution handle's definitive exit/join, or reliable local runtime/process termination evidence bound to the exact original incarnation and its publication-capable workers. A PID alone is insufficient because it can be reused. Host restart, failure to ping, network disconnection, absent process metadata, abort-request acknowledgment, or two stale samples do not prove cessation. Stopping one callback does not prove that outstanding asynchronous I/O or child workers have stopped. The proof must cover all actors that retained this attempt's publication capability.

C2 stores no authenticated runtime incarnation or cessation proof. Existing artifacts can therefore support metadata freshness assessment, but cannot independently produce confirmed cessation after restart. Even conclusive cessation is insufficient to recover a legacy attempt until write fencing is available. A Human may authorize inspection/reconciliation; that authorization does not convert uncertain facts into proof or bypass fences.

Only the trusted project-bound runtime controller may initiate a future reconciliation authority transition, under explicit operational authorization for that exact attempt. For the first implementation, initiation is an explicit request, not automatic dispatch from `STALE_CONFIRMED`. No new UI, tool or production registration is specified here. The controller receives narrow run/lease reads and the run store's future revocation capability; the assessor receives no writers. Evaluators, models, lease readers and arbitrary filesystem callers receive no recovery capability.

`RecoveryEligibility` is a separate transient result:

- `ELIGIBLE_FOR_FENCED_RECONCILIATION`: fresh `STALE_CONFIRMED`, exact current running binding, supported authenticated owner incarnation, available durable fencing, healthy/coherent storage, current controller authorization, and no competing revocation/terminal transition.
- `INELIGIBLE`: terminal/created run, recent/unconfirmed metadata, unsupported legacy attempt, or lack of authorization.
- `UNKNOWN`: corrupt/missing/mixed history, uncertain clocks/proof, ambiguous authority history, or unavailable storage.

Eligibility never returns permission to execute. It carries exact observed refs, proof/policy identity, expected epoch and controller binding for revalidation. It is not a reusable bearer token. If cessation is known but the age policy cannot be assessed, this stale-recovery path remains unavailable; designing a separate non-stale shutdown path is outside scope.

## 5. Fencing strategy

Choose an immutable per-attempt authority epoch, enforced by the EvaluationRun store, for a future revocation boundary. Epoch scope is `(projects root, projectId, runId, exact running fingerprint)`, not a user/global Host generation. A new attempt uses a new run ID. The epoch record is a tiny operational record of publication authority, not semantic State or a generic job ledger.

| Option | Benefit | Limitation |
| --- | --- | --- |
| Opaque random fencing token | Exact unguessable capability identity | No inherent ordering; requires a durable current-authority comparison |
| Monotonic per-attempt epoch | Explicit ordering and durable stale-writer rejection | Every consequential write must check it under the same serialization boundary |
| Host/runtime generation only | Cheap in-process invalidation | Resets/disappears on restart and does not fence another process |
| Lease timestamp or ownerId | Already readable metadata | Neither is execution authority; neither can safely fence |

Use the epoch with an opaque claim-bound write credential and an exact runtime incarnation. The credential is not published in lease metadata; epoch ordering alone is not authentication. `claimExecution()` remains the sole operation that grants execution ownership. Future epoch initialization accompanies that claim before any capability is exposed to execution. It must not be inferred lazily from a readable legacy running snapshot.

A proposed separate versioned immutable authority record binds the exact running ref, epoch number, original claim/incarnation identity, permitted writer role and predecessor fingerprint. Current epoch is derived from a validated append-only chain. A revocation advances the epoch and records `revoked`; it grants no evaluator role to the controller or another owner. ExecutionLease v1 stays unchanged: `ownerId` and `acquiredAt` never change, and epoch records reference exact lease metadata instead of becoming lease revisions with replacement owners. Exact artifact schema/ref/limits require a later approved implementation specification.

All future authority-record writes use the existing EvaluationRun namespace writer lock, although their artifacts live in a separate namespace so existing run-history readers do not misparse them. No reverse dependency from run storage into the lease store is introduced. The controller coordinates both namespaces with a fixed lock order: **EvaluationRun lock, then ExecutionLease lock**. It revalidates current lifecycle, lease ref, epoch, authorization and cessation proof while holding these locks; C2's existing lease writers take only the lease lock, so no reverse-order path is allowed.

At the revocation commit frontier, exclusively publish and sync the new epoch record. The revocation record is the authority-transition linearization point. After that point, every terminal writer, ordinary run-publication route, claim-bound metadata creation and heartbeat route must reject an old execution credential/epoch before its final link. In particular, fencing only `publishTerminal` would leave the public `publish` route as a bypass. Lease writes must check a fresh execution/metadata credential through the coordinator; C2's current public exact-ref-only heartbeat API is insufficient for this future authority boundary. Ref comparison can remain as an additional metadata consistency check.

Authority initialization may require multiple immutable commits; it is not a cross-directory transaction. A partial epoch/run initialization exposes no execution capability and must be classified as incomplete until exact bindings resolve. A partial revocation remains revoked once the epoch commit exists, even if later acknowledgment or audit writes fail. The controller resolves the exact committed record rather than replaying execution. Missing/ambiguous authority history fails closed for both execution writers and reconciliation.

Legacy claims do not carry an epoch, and currently running old processes do not consult future fences. Installing an epoch file cannot make those writers safe. Such attempts are ineligible for online recovery. Future activation must use a verified quiescent upgrade boundary with no legacy publication-capable processes, or leave those attempts unresolved under their existing contract. Do not silently reconstruct, retrofit or grant a replacement live claim. Durable fencing rejects cooperative stale writes; it is not a process sandbox for code with ambient filesystem authority and cannot roll back evaluator work already performed.

## 6. Recovery and lifecycle relationship

In this design, recovery means eligibility to revoke/quarantine an orphaned attempt's publication authority and inspect committed operational facts. It does not mean continuing execution on the same run or giving a second owner its claim.

```text
running + original execution authority at epoch N
           |
           | fresh eligibility + explicit controller authorization
           v
running + revoked authority at epoch N+1
```

The run remains `running`. Revocation is an authority fact, not a new lifecycle status and not evidence that evaluation failed. A later separately specified reconciliation operation could record an accurately evidenced operational terminal outcome using a narrow reconciliation-only capability; neither its terminal mapping nor cancellation execution is designed here. It must use the legal lifecycle edge and the same fence/lock boundary, never overwrite history or infer semantic failure from timeout. No `running → created`, reopening of a terminal run, new evaluator invocation, retry allocation, output recovery or EvaluationResult interpretation is permitted by this proposal.

A valid terminal snapshot committed before the revocation lock wins; fresh eligibility becomes inapplicable. If revocation commits first, later old-owner terminal publication rejects. An old owner returning after a candidate observation may still settle normally because no authority changed; returning after committed revocation cannot publish. Losing the controller's acknowledgment never resurrects the old owner.

## 7. Failure and race scenarios

| Scenario | Assessment / required handling |
| --- | --- |
| Slow evaluator, paused process, congested I/O | Old heartbeat may produce candidate only; no failure or takeover |
| Crash between running and lease publication | Missing lease is unknown; do not recreate a claim or synthesize a lease after restart |
| Heartbeat linked but acknowledgment lost | Inspect exact/current metadata; reject stale-predecessor writes; do not replay evaluator |
| Heartbeat advances during inspection | Invalidate old observation/eligibility and reassess exact current refs |
| Clock rollback, future heartbeat, suspend uncertainty | Unknown time basis; restart a trusted observation window if available |
| Controller restart with old owner still alive | Lost in-process registry is not cessation proof; no confirmation or replacement authority |
| Owner definitively stopped but asynchronous writers remain | Cessation proof is incomplete; confirmation/recovery cannot proceed |
| PID reuse or ownerId collision | Require exact runtime incarnation and claim binding; otherwise unknown |
| Fresh metadata appears after apparent owner death | Conflicting provenance is unknown; metadata does not authenticate the owner |
| Terminal publication races revocation | Shared run lock and epoch frontier select one legal outcome; no overwritten terminal |
| Death after durable revocation | Read committed epoch; old credentials remain rejected despite lost acknowledgment |
| Corrupt/missing predecessor or authority history | Fail closed; no age-based repair, deletion or lock stealing |
| Lease snapshot capacity exhausted | A heartbeat cannot publish; absence is not evidence of death. Preserve history and surface bounded actionable diagnostics |
| Legacy unfenced running attempt | Observation only; no online recovery based on new epoch files |
| Two controllers request reconciliation | One exact expected-epoch revocation can commit; the other reads the result without receiving execution ownership |

C2's 4096-snapshot-per-project bound is preserved. Before regular heartbeat production, specify a bounded cadence/admission budget and capacity reporting; never prune live predecessor chains to make room. Future retention of closed histories is a separately approved storage contract. Authority revocation must not depend on spare lease snapshot capacity; its separate bounded namespace must reserve the ability to fence already-admitted attempts. Storage unavailability still blocks the transition rather than weakening its durability.

## 8. Future implementation slices and acceptance

These are proposed work boundaries requiring separate implementation tasks, not claims of completed milestones:

1. **Pure observation foundation:** versioned policy/time inputs, binding validators, runtime-only assessment and eligibility shapes, deterministic tests for thresholds, clock uncertainty, changed refs and missing leases. No production wiring or writer capabilities.
2. **Owner confirmation facts:** bounded execution-handle/incarnation provenance and read-only cessation facts from the existing runtime owner. Prove that joins/exits cover child and outstanding writers. A timeout or abort request remains insufficient.
3. **Publication fencing foundation:** exact immutable epoch contracts/store, claim-time initialization, coordinated lock ordering, all write-route fences and legacy quiescence rules. Tests must exercise real competing processes, terminal/heartbeat/revocation races, incomplete initialization and death before/after commit. No recovery invocation or evaluator restart.
4. **Explicit eligibility and revocation boundary:** narrow controller authorization, fresh combined validation, immutable revocation audit and exact acknowledgment reconciliation. Return quarantine/revocation facts only; leave run lifecycle unchanged. No automatic trigger, retry, cancellation execution or replacement owner.
5. **Bounded inspection integration:** only after the preceding foundations are approved, expose read-only assessment at an existing operational boundary and an explicitly authorized reconciliation request. Include cadence/capacity and restart tests; do not add a general scheduler or LearningJob kind.

Acceptance requires proof that lease existence/age never grants execution, candidate/confirmation states never mutate lifecycle, corrupt or uncertain facts block recovery, old credentials cannot use any publication route after the revocation frontier, and no controller can replay the evaluator or mutate semantic learning/trust state. Missing leases and legacy attempts must remain visibly unresolved rather than falsely recovered. Operational termination mapping and any eventual execution resumption require separate specifications outside these slices.

## 9. References and implemented limits

- [R4-C2](autonomous-learning-r4-c2.md): immutable run lifecycle and exact bindings.
- [R4-C3-A](autonomous-learning-r4-c3-a.md): capability-free evaluator contract.
- [R4-C3-B](autonomous-learning-r4-c3-b1.md): unique consumed execution claim and claim-bound settlement.
- [R4-C3-C1/C2](autonomous-learning-r4-c3-c1.md): pure lease contract, genuine-claim creation, immutable persistence and strict heartbeat advancement.
- [Autonomous Learning v1](autonomous-learning-v1.md): Learning Plane ownership and Work Plane isolation.

C4 now supplies the standalone pure freshness assessor below, without changing production runtime behavior. There is no implemented owner monitor, epoch store, recovery controller, retry, cancellation execution or takeover, and no production dogfood is claimed.

## 10. R4-C3-C4 implemented observational assessment

`src/evaluation-execution-lease-assessment.ts` implements pure `assessExecutionLeaseFreshness(lease, policy, clockSample)` and an injected-clock adapter `assessExecutionLeaseWithClock(lease, policy, clock)`. Neither has a default clock, reads system time, consults stores, starts a timer or changes execution. The adapter samples `clock.now()` exactly once after detaching valid lease/policy inputs. Invalid inputs skip sampling; clock exceptions produce fixed `UNKNOWN` diagnostics without copying arbitrary exception messages.

Strict version-1 operational inputs are:

- `ExecutionLeaseStalePolicyV1`: positive safe-integer `staleAfterMs` and nonnegative safe-integer `maxClockUncertaintyMs`.
- `ExecutionLeaseClockSampleV1`: canonical ISO `observedAt` and comparison assumptions, either `{ kind: "bounded", uncertaintyMs }` or `{ kind: "untrusted" }`. A bounded sample asserts reliable producer/observer clock-domain comparison with combined nonnegative safe-integer uncertainty within the policy maximum. This assertion must come from the caller's clock adapter; shape validation cannot prove clock reliability. A known rollback/jump, unknown clock domain or suspend uncertainty must be supplied as untrusted comparison.

The returned detached deeply frozen `ExecutionLeaseAssessmentV1` contains schema version, state, bounded reason, validated lease/policy/clock snapshots (or null where validation fails), the lease's canonical fingerprint, and conservative `minimumAgeMs` where assessable. It is transient metadata, has no artifact/ref family, is never persisted in lease/run/Task State and carries no execution or recovery capability. The lease fingerprint identifies only the supplied lease bytes, not project scope, durable currentness or a committed history.

C4 emits only `ACTIVE`, `STALE_CANDIDATE` and `UNKNOWN`. It cannot emit `STALE_CONFIRMED`: no authenticated owner-cessation source exists in this slice. It also cannot derive `NOT_APPLICABLE` because it receives no EvaluationRun lifecycle. These target states remain reserved for the future complete runtime observer; no boolean or owner string is accepted as fabricated cessation proof.

For a supported bounded clock sample, let `age = observedAt - heartbeatAt` and `minimumAge = age - uncertaintyMs`. `minimumAge > staleAfterMs` yields `STALE_CANDIDATE`. Exactly at the threshold, including exactly at the uncertainty-adjusted threshold, yields `ACTIVE`. Recent metadata and future timestamps within the accepted uncertainty also yield `ACTIVE`; negative age is retained rather than clamped. `ACTIVE` describes freshness only, never authenticated owner liveness.

Missing/invalid leases, malformed/unsupported policy or clock schemas, untrusted comparisons, sample uncertainty above the configured maximum, a future heartbeat beyond accepted uncertainty, and unsafe integer age arithmetic yield `UNKNOWN`. Strict validation rejects unknown fields before detachment so function/capability fields cannot disappear through JSON conversion, then independently revalidates the detached values before assessment. Advancing the supplied heartbeat can turn a later assessment back to `ACTIVE`; no stale flag is sticky. Old heartbeat metadata remains a candidate regardless of how far beyond threshold it is and never becomes execution failure or confirmed cessation solely with age.

C4 does not implement monotonic fallback, rollback detection across samples, complete lease-chain resolution, current-run applicability, durable currentness verification, owner monitoring, recovery eligibility, epoch/fencing enforcement or production wiring. Those require the later separately approved boundaries above. The caller supplies the purported current lease; this API does not certify that claim. EvaluationRunStore, ExecutionLeaseStore, ExecutionRunner and claim ownership behavior remain unchanged. Recovery remains future work.

Focused tests cover fresh/old metadata, exact threshold and uncertainty boundaries, future/untrusted/invalid clocks, invalid policies/leases, safe arithmetic, one-shot deterministic injected sampling, exception handling, revalidation of values that change during copying, reassessment after heartbeat advancement, frozen detached output and absence of run/lease/ownership mutation. Lease persistence and EvaluationRun regression tests continue to cover their independent contracts.
