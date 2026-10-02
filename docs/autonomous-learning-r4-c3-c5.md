# Autonomous Learning R4-C3-C5 — Stale confirmation and recovery authority boundary

Status: C5 authority design with the standalone C6 persistence boundary implemented in Section 9. C6 adds immutable authority origins/confirmations and fences the existing RunStore and lease write routes; it adds no production wiring, real owner monitor, takeover, retry, evaluator restart, cancellation or EvaluationResult. Sections 1–8 describe the target boundary; Section 9 distinguishes implemented behavior from remaining work. Execution ownership still comes only from R4-C3-B `claimExecution()`; C1/C2 lease schemas and C4 assessment are unchanged.

## 1. Contract and terminology

Observation, ownership invalidation and permission for new execution are three separate decisions:

| Boundary | Statement | Effect |
| --- | --- | --- |
| Observation | “Execution appears stale.” | C4 returns `STALE_CANDIDATE`; no authority or lifecycle change. |
| Confirmation | “Authority declares this ownership invalid.” | A freshly validated, durably committed fence revokes the original owner's publication authority. |
| Recovery | “A new execution may proceed.” | Requires separate operational authorization and reconciliation, then a new attempt acquiring its own claim. Confirmation alone never permits invocation. |

There is a terminology conflict with [C3 Sections 3–6](autonomous-learning-r4-c3-c3.md): that proposal calls positive owner-cessation evidence `STALE_CONFIRMED`, explicitly without authority effects, and puts revocation in a later transition. This C5 design uses `CESSATION_PROVEN` for that evidence predicate and reserves `STALE_CONFIRMED` for acknowledged durable revocation. This refines the proposed confirmation boundary to meet the current request; it changes no implemented behavior. C4 still emits only `ACTIVE`, `STALE_CANDIDATE` and `UNKNOWN`.

`CESSATION_PROVEN` is a factual prerequisite, not a persisted lifecycle phase. The confirmation decision and fence are one authority commit; there must be no durable “confirmed” label followed by an unfenced interval. Recovery remains a separate operation after that commit.

Preserve [R4-C3-B](autonomous-learning-r4-c3-b1.md): `EvaluationRunStore.claimExecution()` is the sole execution-ownership acquisition mechanism. A consumed run is never reclaimed, reopened or returned to `created`. A lease, epoch number, cessation proof, confirmation record or recovery authorization cannot reconstruct a lost live claim. EvaluationRun retains `created → running → completed | failed`. Confirmation does not mean evaluation failure or a semantic verdict.

## 2. Confirmation authority

Choose a **project-bound Recovery Coordinator within the existing execution runtime/controller boundary**. It is a small deterministic operational component, not a scheduler, general workflow engine, new Agent Loop or independent trust authority.

| Candidate | Appropriate responsibility | Why it does not independently own confirmation |
| --- | --- | --- |
| EvaluationRunStore | Serialize lifecycle/authority publication and enforce durable fences. | It has storage facts, not authenticated execution-handle cessation facts or current operational authorization. It must not decide owner death from timestamps. |
| Recovery Coordinator | Combine owner facts, current run/lease bindings, explicit authorization and fresh policy; request conditional revocation. | **Selected confirmation authority.** It belongs to execution ownership and can gather the needed facts without scheduling or invoking cognition. |
| Scheduler | Offer future work after its own admission/budget gates. | Dispatch permission does not confer owner-inspection or revocation authority. Stale candidates must not automatically reset jobs or replay attempts. |
| Dedicated authority component | Could provide a separate revocation service. | Unnecessary for this bounded local execution boundary; it would duplicate controller provenance and authorization plumbing. Reconsider only if a concrete distributed-runtime requirement needs it. |

The Coordinator receives exact read capabilities, an authenticated owner-monitor interface and a narrow conditional-revocation capability enforced by the RunStore. It receives no evaluator invocation, live claim reconstruction, generic terminal writer, EvaluationResult writer or Strategy/Policy/Trust/Decision mutation capability. The pure assessor receives no writers. Models and evaluators cannot confirm stale. An `ownerId` string, filesystem read access or a caller-supplied boolean is not an authority credential.

The first integration requires an explicit operational request bound to projects root, project, exact attempt, controller incarnation and current project/generation. Authorization is checked again at commit. A Human can authorize inspection/reconciliation but cannot turn uncertain evidence into cessation proof or waive fencing. No automatic scheduler trigger or new UI/tool surface is specified.

## 3. Required evidence and confirmation transition

The Coordinator may propose confirmation only when all of these are available:

1. Complete validated EvaluationRun history whose current lifecycle is `running`, with exact project/root, packet/evaluator identity, running fingerprint and start timestamp.
2. Complete validated lease history, exact current lease ref and origin bound to that running snapshot; acquisition equals its start time. A C4 lease-byte fingerprint alone does not establish committed currentness.
3. A newly sampled, supported clock and versioned stale policy producing `STALE_CANDIDATE` for that exact current lease. Age uses C4's conservative strict threshold; additional elapsed time never substitutes for owner evidence. No production threshold or sampling cadence is chosen here.
4. Fresh positive cessation evidence from the trusted monitor that tracked the original acknowledged claim: exact runtime/boot incarnation, execution handle and claim binding, definitive exit/join or verified termination, observation provenance, and coverage of every publication-capable child/worker/outstanding operation.
5. A complete validated execution-authority chain at expected epoch `N`, still owned by that original claim; supported fenced writers, healthy storage, reserved authority capacity and current explicit Coordinator authorization.

PID absence, PID reuse, Host restart, ping failure, network partition, a cancellation request/acknowledgment, two stale samples or a long timeout are insufficient. Joining one callback while an asynchronous publisher remains is insufficient. If the monitor lost its exact registry on restart, artifacts do not reconstruct proof. Contradictory fresh heartbeat/owner facts yield `UNKNOWN` pending provenance resolution.

Before committing, the Coordinator performs a conditional operation with expected running ref, current lease ref, authority ref/epoch, proof identity and policy/controller binding. The operation:

1. Acquires **EvaluationRun writer lock, then ExecutionLease writer lock**, always in that order. Every future authority-sensitive lease writer must use that order too; none may acquire RunStore authority while holding only the lease lock.
2. Re-reads and validates full relevant histories. Requires exact equality with expected refs, current `running` lifecycle, unchanged ownership/epoch and current authorization. Changed refs invalidate the request; do not silently substitute new inputs.
3. Revalidates the monitor proof's binding, completeness and current provenance, and takes a fresh clock sample to recompute candidacy under the same policy. Pre-lock inspection is advisory. Owner monitoring is bounded and performs no evaluator invocation or waiting for cognition under storage locks.
4. Publishes one immutable authority record at epoch `N+1`, disposition `revoked`, containing the confirmation audit inputs. Unique publication and durability acknowledgment use the existing immutable-store convention.
5. Returns `STALE_CONFIRMED` only after successful durable acknowledgment. A linked but unacknowledged record is an ambiguous outcome requiring exact storage reconciliation; it does not permit execution.

The publication frontier serializes revocation with terminal and heartbeat commits. No separate confirmation artifact must succeed afterward to make the fence effective: the authority record itself contains the decision and bounded audit binding.

```text
Observation, no ownership changes:
  ACTIVE <---- fresh coherent metadata ---- STALE_CANDIDATE
    |                                        |
    +---- uncertainty/change ------------> UNKNOWN
                                             |
                                     fresh facts: reassess

Authority, separate from observation and run lifecycle:
  owned(N) + fresh candidate + CESSATION_PROVEN + explicit authorization
      |
      | conditional durable revocation
      v
  revoked(N+1): STALE_CONFIRMED
      |
      | separately authorized reconciliation; no invocation
      v
  quarantined old attempt; possible future new-attempt admission
      |
      | separately specified recovery gates + new created attempt
      v
  claimExecution(new attempt) -> unique new execution owner
```

Before revocation, fresh metadata can remove a candidate. After committed revocation, the invalidation is irreversible for that attempt; an old heartbeat cannot restore ownership. `UNKNOWN` describes an observer's inability to resolve facts, not undoing an already committed fence. Valid created/terminal runs are inapplicable; corrupt histories remain unknown.

## 4. Fencing epoch and storage strategy

Epoch scope is `(resolved projects root, projectId, runId, exact running fingerprint)`. Store a separate versioned append-only authority chain in a project-local `learning-v1/execution-authorities-v1` namespace. This is a proposed operational namespace, not an implemented schema or generic ledger. It does not add fields to PindieState, EvaluationRun v1 or ExecutionLease v1.

The authority chain binds its scope, original claim identity and runtime incarnation, monotonic safe-integer epoch, permitted writer role/disposition, predecessor fingerprint and immutable decision provenance. Revocation freezes the exact running/lease refs, policy and clock sample, bounded cessation proof, authorization scope/controller identity and confirmation time. Credential secrets never enter readable artifacts. Current authority is derived from complete validated history; no mutable pointer or timestamp-based owner selection is introduced. Branches, missing predecessors, invalid epochs and overflow fail closed.

RunStore initializes epoch `0` through the unique `claimExecution()` operation before exposing its live execution capability. Initialization binds the exact committed running snapshot and an opaque claim-bound credential. Multiple immutable files are not a cross-directory transaction: partial initialization grants no capability and consumes any linked running claim without allowing replay. Missing authority must never be treated as implicit epoch zero for a running attempt.

Only the Coordinator's narrow revocation capability can request the `N → N+1` increment; RunStore validates and publishes it under the shared RunStore lock. Increment happens **at the ownership-invalidation frontier**, not when candidacy is observed, a heartbeat is missed, cessation is proven or an inspection begins. Repeated inspection or exact reconciliation does not increment again. C5 allows one owned-to-revoked transition and no replacement owner on that chain. A future new attempt starts its own epoch zero; it does not inherit a reclaimed old claim.

Old owners are rejected through both exact claim credential/incarnation verification and current epoch/disposition checks under the same serialization boundary immediately before publication. Reading epoch `N+1` does not confer a credential. Required fence coverage includes:

- Claim-bound terminal publication and every ordinary RunStore publication route that could advance the claimed run. Public `publish()` cannot bypass revocation or synthesize execution ownership.
- Claim-bound lease origin creation and heartbeat publication. C2's exact-ref-only heartbeat checks remain useful consistency checks but are insufficient for authorization; future fenced APIs must also authenticate the execution credential and check current epoch.
- Any later output/result publication or reconciliation writer, with an explicitly limited role and the same fence boundary before it is introduced. A result computed under the old epoch cannot be published by a replacement owner merely by copying it.

Exact historical reads remain available. After revocation, an old writer may inspect an already committed terminal/artifact through read APIs; a write retry cannot obtain fresh authority even if its bytes match history. A Coordinator reconciliation role grants no evaluator role or generic ability to impersonate the old owner.

Authority storage uses the RunStore writer lock while retaining a separate namespace so existing run-history readers do not misparse authority records. The Coordinator assembles cross-store facts; RunStore need not import the lease store. Admission reserves bounded revocation capacity for every fenced execution. Exhausting C2's lease-snapshot capacity cannot prevent a reserved authority write, though unavailable or corrupt authority storage still blocks confirmation. Artifact limits, lock plumbing and strict schemas belong to a later implementation specification.

At exclusive link publication, cooperating serialized writers must treat the new epoch as a fence; acknowledgment requires successful directory durability synchronization. A crash or failure after linking can leave a fence whose durability is uncertain to the caller. Never roll it back or restore old rights because acknowledgment failed. Re-read exact history under lock and complete durability reconciliation before declaring success or admitting anything new. If committed state cannot be established, fail closed.

Existing B/C2 claims have no epoch and existing processes do not consult these fences. Writing an authority file cannot retrofit their safety. Legacy attempts remain observation-only for online recovery. Activation requires a verified quiescent upgrade with no legacy publication-capable actors, or leaves those attempts unresolved under their old contract; neither path reconstructs a claim. Fencing protects cooperative publication APIs, not ambient filesystem access, already performed effects or external model calls.

## 5. Recovery boundary and authority

An acknowledged confirmation authorizes only inspection/quarantine and explicitly scoped operational reconciliation of the old attempt. It leaves EvaluationRun `running`; no timeout-derived `failed`, fabricated completion, semantic evaluation conclusion or trust mutation is legal.

Permission for a **new** execution is a distinct future recovery admission decision. Its issuer is the same project-bound Coordinator under a separately granted recovery capability; the scheduler can request admission, but cannot issue it. That capability is absent from the C5 confirmation interface.

Future recovery admission must revalidate the exact committed revocation, complete cessation coverage, current controller/project binding and an accurately reconciled old attempt. It must apply a separately approved retry policy, stable job identity and old/new-attempt linkage, deduplication against existing outputs/results/receipts, exact packet/evaluator binding, attempt limits, budget/capacity and native execution isolation. Any unresolved publication or possible live external execution blocks admission. Storage facts from a previous confirmation are not reusable permission.

Admission allocates no replacement claim for the old run. A permitted retry uses a new immutable `created` attempt with a new run ID and exact recovery linkage; it obtains ownership solely through `claimExecution()`. Concurrent recovery requests must atomically deduplicate the logical recovery opportunity before producing competing new run IDs: per-run claim exclusivity alone does not prevent two different retry attempts. The future retry/admission contract must specify that transaction and ambiguous-commit reconciliation.

C5 deliberately does not define an operational terminal mapping, retry policy, retry transaction schema, output salvage or evaluator replay. Until those are separately approved and implemented, **no new execution may proceed from this stale-recovery path**, even after confirmation. This preserves C3's quarantine-only recovery scope and B's at-most-once invocation per attempt while stating the conditions for a future broader recovery boundary.

## 6. Failure scenarios and races

| Scenario | Required outcome |
| --- | --- |
| Owner resumes after candidate observation | Ownership is unchanged; it may heartbeat/settle under its valid claim. Reassess changed refs before any confirmation. |
| Owner resumes after stale confirmation | Genuine full cessation proof should exclude resumption; resumption exposes incomplete proof or an untracked actor. Regardless, epoch `N` terminal/lease/output writes reject. Stop further recovery admission and inspect the provenance failure; never reactivate the old claim. |
| Two Coordinators race to confirm | Both present expected epoch `N`. Shared locks let one publish revocation at `N+1`. The loser reconciles that exact decision without another increment, recovery grant or new owner. A conflicting decision/history fails closed. |
| Two recovery attempts race after confirmation | Confirmation grants neither execution. Future atomic recovery admission must select one logical successor; only then does its new run acquire a unique claim. Until that admission contract exists, both are denied. |
| Heartbeat arrives during inspection/confirmation | If it commits first, the expected lease ref differs and confirmation aborts. Refresh and inspect conflicting cessation provenance. If confirmation holds both locks and commits first, the waiting old-epoch heartbeat rejects. A heartbeat started earlier cannot bypass the final fence check. |
| Terminal publication races confirmation | Terminal first makes stale confirmation inapplicable. Revocation first rejects the old terminal. No terminal overwrite, lifecycle rollback or semantic verdict is inferred. |
| Storage unavailable before publication | No acknowledged confirmation; return unknown/unavailable. No in-memory substitute, age-based fallback or new execution. Existing ownership is not revoked by the observation. |
| Storage fails after link or acknowledgment is lost | Fence may already exist. Do not report successful confirmation or assume it failed; reconcile exact authority history and durability under lock. Old-owner writes must fail closed if authority cannot be validated. No replay or extra epoch increment. |
| Lease absent, corrupt or capacity exhausted | Absent/corrupt history is unknown; exhaustion explains silence without proving cessation. No synthetic lease, pruning of live chains or claim recreation. |
| Coordinator restarts or project/generation changes | Discard transient assessments/authorization and rebind fresh requests. Committed revocation remains effective; readable history grants no live execution credential. |

## 7. Future implementation work boundaries

These are proposed slices of this requested design, not completed milestones or authorization to implement adjacent runtime changes:

1. **Cessation provenance foundation:** strict bounded exact-claim/incarnation proofs from the existing owner monitor, covering all publication-capable actors. Test PID reuse, restart, incomplete joins and contradictory heartbeats. No revocation or production integration.
2. **Authority persistence and complete writer fencing:** strict authority records, claim-time initialization, reserved capacity, coordinated lock order and credential/epoch enforcement across every current publication route. Test real competing processes, partial initialization, authority corruption, all bypass routes and link/sync/acknowledgment failures. No recovery invocation.
3. **Conditional confirmation operation:** narrow explicit Coordinator authorization, fresh under-lock evidence checks and one immutable revoked decision. Test heartbeat/terminal/confirmation races, exact reconciliation, authorization changes and storage failures. Return confirmation/quarantine facts only; leave lifecycle unchanged.
4. **Bounded explicit inspection integration:** expose observation and explicitly requested confirmation at an existing safe operational boundary, with capacity and restart behavior. No periodic task queue, automatic retry or LearningJob state reset.

Any terminal reconciliation and new-attempt recovery admission require their own approved specification covering the gates in Section 5. They must not be smuggled into confirmation implementation.

Acceptance: observation never grants authority; cessation proof alone never revokes ownership; acknowledged `STALE_CONFIRMED` always resolves to a durable fence; all old-owner publication paths reject after the frontier; races select one immutable decision; unknown storage/provenance never permits execution; confirmation never changes run lifecycle or learning trust; no consumed attempt is invoked twice.

## 8. References and unchanged limits

- [Autonomous Learning v1](autonomous-learning-v1.md): Learning Plane ownership and isolation from Human Task truth.
- [R4-C2](autonomous-learning-r4-c2.md) and [R4-C3-B](autonomous-learning-r4-c3-b1.md): immutable lifecycle, exclusive claim acquisition and publication acknowledgment.
- [R4-C3-C1/C2](autonomous-learning-r4-c3-c1.md): historical lease metadata, genuine-claim origin publication and exact linked heartbeat history.
- [R4-C3-C3 / implemented C4](autonomous-learning-r4-c3-c3.md): proposed cessation/eligibility/fencing architecture and implemented observational assessor. Section 1 explains C5's refinement of the proposed confirmation terminology.

No production dogfood, autonomous recovery or trust authority is claimed.

## 9. R4-C3-C6 implemented persistence boundary

`evaluation-stale-confirmation.ts` defines strict version-1 `StaleConfirmationV1`, `ExecutionAuthorityOriginV1`, `ExecutionCessationEvidenceV1` and dedicated `ExecutionAuthorityRef` contracts. These refs are outside EvaluationRef and LearningArtifactRef and grant no trust or execution authority. `FileExecutionAuthorityStore` exposes only exact `get(ref)` and `getCurrent(projectId, runId)`; it exposes no confirmation publication API. The registered `createRecoveryCoordinator(...).confirm(record)` capability is the only confirmation writer. Internal origin initialization belongs to RunStore claim publication and cannot return/reconstruct a live execution claim.

An owned origin contains the exact running ref, epoch zero, unique claim ID and process-incarnation identity. `claimExecution()` commits running and then its immutable origin under the RunStore lock, returning its existing live claim only after both are acknowledged. Its terminal closure captures that exact authority ref. These are separate immutable commits, not a cross-directory transaction. Lost running/origin acknowledgment consumes the attempt and grants no replacement claim; incomplete histories fail closed for writes. The claim shape and evaluator interface are unchanged, and no evaluator is invoked during authority initialization.

A confirmation contains `runId`, exact running ref, previous authority ref, previous lease ref/owner, previous lease epoch, new fencing epoch, confirmer ID/incarnation, confirmation timestamp, fixed `owner-cessation` reason, bounded exact cessation evidence and the frozen policy/clock sample. **Previous lease epoch is the epoch of the execution authority governing that lease; it is not a new field on ExecutionLease v1.** The pure schema requires nonnegative safe-integer epochs with an exact increment of one. Store history permits only `owned(0) → stale-confirmation(1)` for a consumed attempt. There is no repeated revocation, owner replacement or reacquisition; a higher structurally increasing epoch cannot bypass the exact origin predecessor. Identical confirmation retries return the same immutable record without incrementing again; changed confirmation contents conflict.

Registration captures a project-root-bound RunStore/lease reader pair, detached confirmer identity and stale policy, a trusted monitor inspection function, an injected clock and an explicit synchronous operational authorization check. Caller-supplied owner strings/evidence alone cannot publish: the Coordinator revalidates against the captured monitor, current exact storage facts and fresh sampled clock. All stored input is strictly validated before detachment and independently revalidated afterward. The monitor's exact claim/incarnation/handle assertion must cover all publication-capable actors, agree with the submitted evidence and not predate the current heartbeat. The fresh clock must match the proposed immutable sample, and C4 must still return `STALE_CANDIDATE`. Changed clock samples require a fresh proposal; no hidden timestamp substitution occurs. The registered policy cannot be changed by a proposed record.

The monitor is an injected trusted factual capability, **not an implemented OS/runtime cessation detector or sandbox**. C6 does not prove termination from PIDs, timers or lease bytes. A production monitor and project/generation authorization adapter remain future work; models/evaluators must never receive Coordinator registration capabilities. Capability isolation protects this interface, not arbitrary code with ambient filesystem authority.

Confirmation acquires the EvaluationRun lock followed by the ExecutionLease lock. It validates complete authority/run/lease histories, current running applicability, exact lease/ref/owner/acquisition, expected authority epoch, monitor evidence, fresh clock/policy and explicit authorization. Authorization is checked again immediately before the exclusive artifact link. Heartbeat and lease-origin writers now acquire those same locks in that order; terminal and ordinary run publishers use the RunStore lock. Locks cover the final publication frontier, so no competing supported writer can change an expected predecessor during confirmation.

Artifacts live at project-local `learning-v1/execution-authorities-v1/<runId>.<digest>.json`. Canonical envelopes are `{ schemaVersion: 1, record, fingerprint }`; the digest covers the entire record, including predecessor and evidence bindings. There is no mutable pointer or overwritten history. Writers use exclusive temporary creation inside the RunStore lock directory, file sync/byte verification, unique hard-link publication and authority-directory sync. Confirmation acknowledgment occurs only after durability synchronization. Reconciliation of an identical linked record synchronizes the authority directory again; it does not inspect/replay an evaluator or make a new decision.

History validates schema, canonical bytes, digest/filename/project/run binding, complete origin/predecessor linkage, exact running/claim/incarnation identities and legal epoch progression. Invalid, missing, branched, oversized or corrupt history rejects reads and writes. Records are bounded to 8KiB plus envelope allowance. At most 4096 attempt chains and two artifacts per chain are admitted, reserving one revocation slot per origin without depending on spare lease capacity. No pruning, authority-history repair or retention change is implemented.

After publication, the new epoch rejects the captured old terminal closure, ordinary running/terminal publication retries, lease origin publication and heartbeat updates, across independent store instances/processes. All check fresh authority under the RunStore lock before linking. Historical exact reads stay available. Heartbeat's existing exact-ref API is retained and checks durable owned authority; authenticated heartbeat credentials beyond C2's metadata consistency contract remain future work. Reading an origin/confirmation does not grant any execution claim.

Legacy unfenced run/lease histories remain readable. Ordinary terminal publication and running publication retries now require an exact owned authority origin; lease writes require it too. Thus a readable legacy running record cannot silently initialize an epoch, settle online or obtain a replacement owner. Existing C2 lifecycle tests establish actual claims before exercising terminal publication. This closes the ordinary-publication bypass rather than treating a missing authority chain as implicit epoch zero. No legacy migration or retroactive fencing of already running old binaries is claimed; activation still requires the quiescent upgrade boundary in Section 4.

Pre-link errors leave the previous authority intact. A link/sync/acknowledgment failure can leave a committed fence even though the call rejects. Exact lookup and identical confirmation reconciliation resolve the record; no rollback, extra increment or execution retry is allowed. Unreadable authority history blocks all affected writes. Tests cover canonical immutable/exact restart lookup, identical/conflicting decisions, nonmonotonic epochs, stale predecessors, same-process and separate-process competing confirmations, heartbeat/terminal races, strict proof/authorization checks, corruption, interrupted initialization, process death before/after publication, detached inputs and semantic namespace isolation.

**Stale confirmation persistence is implemented. Recovery execution remains future work.** Confirmation leaves EvaluationRun lifecycle unchanged and carries no Strategy, Policy, Trust, Decision, Experience or EvaluationResult mutation capability. ExecutionRunner remains standalone with no recovery invocation or production import. Concrete runtime owner monitoring, production integration, operational terminal reconciliation and deduplicated new-attempt admission remain separately approved future work.
