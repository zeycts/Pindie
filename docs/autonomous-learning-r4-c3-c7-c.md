# Autonomous Learning R4-C3-C7-C — Production Recovery Readiness Boundary

Status: **Design only.** C7-A admission persistence and C7-B successor materialization remain implemented as described in [R4-C3-C7](autonomous-learning-r4-c3-c7.md). Recovered `EvaluationRun` v2 execution remains disabled. This document specifies production facts and boundaries required before a later change may enable it. It does not authorize replay, alter artifacts, or grant execution authority.

## 1. Real repository seams discovered

The current implementation is a standalone operational foundation, not a production Evaluation scheduler or sandbox:

| Concern | Existing seam | Current fact / design ownership |
| --- | --- | --- |
| Run lifecycle and claim | `src/evaluation-run.ts`, `src/evaluation-run-store.ts` | Strict v1 lifecycle and v2 recovery lineage. `FileEvaluationRunStore.claimExecution()` rejects v2 explicitly. Its genuine claim is process-local in a `WeakMap`; a committed `running` snapshot cannot recreate it. This remains the only operation that may grant live execution ownership. |
| Evaluator invocation | `src/evaluation-execution-runner.ts`, `src/evaluator-contract.ts` | `createExecutionRunner()` claims v1, loads an exact packet, calls a registered `evaluate()` function and publishes terminal Run state. The returned `EvaluationOutputV1` is transient. The evaluator receives data-only packet/context, but the injected JavaScript function itself is not sandboxed and can retain ambient authority. There is no `AbortSignal`, tracked child-work registry, or durable output publisher. |
| Authority and lease | `src/evaluation-execution-authority-store.ts`, `src/evaluation-execution-lease.ts`, `src/evaluation-execution-lease-store.ts`, `src/evaluation-stale-confirmation.ts` | Authority/lease histories and C6 revocation fencing are durable. `executionIncarnation` and claim provenance in the RunStore are process-local. Lease freshness in `src/evaluation-execution-lease-assessment.ts` is only `ACTIVE` / `STALE_CANDIDATE` / `UNKNOWN`; staleness is not cessation. C6's monitor is an injected assertion, not a runtime termination detector. |
| Admission and successor | `src/recovery-admission.ts`, `src/recovery-admission-store.ts`, `src/recovery-successor-binding.ts`, `src/recovery-successor-binding-store.ts`, `src/recovery-capacity.ts` | C7-A/B persist immutable assertions/bindings and v2 `created` snapshots. Reconciliation/resource inspectors are injected. Their shape-valid values do not establish native runtime, provider, publication, or accounting facts. |
| Packet and result contracts | `src/evaluation-contract.ts`, `src/evaluation-packet-store.ts`, `src/evaluator-contract.ts` | `EvaluationPacket` is durable. `EvaluationResult` is a pure semantic observation contract, not an operational attempt receipt. There is no `EvaluationOutput` store or production EvaluationResult writer. |
| Host and Pi lifecycle | `src/host.ts`, `src/pi-runtime.ts` | Host owns the active native Pi runtime/session, session replacement, abort, disposal and lifecycle callbacks. `PiRuntimeAdapter.abortActiveSession()` awaits Pi abort. This is the Human Session, not an Evaluation execution handle; session replacement or Host disposal cannot be used as proof about an unrelated evaluator callback or provider request. |
| Learning job and model runner | `src/learning-job-store.ts`, `src/learning-supervisor.ts`, `src/learning-session-runner.ts`, `src/learning-budget-store.ts` | The durable `LearningJob` scheduler currently serves Learning kinds such as local Discovery, not Evaluation. A job key is derived from kind/scope/input fingerprint/policy version; leases can expire and be reconciled. The isolated Learning Pi runner has no tools/extensions/skills and charges full token/time reservation conservatively, but Pi does not enforce an exact token ceiling. It is a useful bounded pattern, not Evaluation ownership or cessation proof. |
| Accounting and user/provider metrics | `src/learning-budget-store.ts`, `src/run-cost.ts`, `src/task-metrics.ts`, quota modules | Learning reservation ledger prevents budget refund on unknown usage. Human Pi Session cost is reconstructed from session entries. Quota fallback/resume manages the Human Session model and is not an Evaluation accounting or recovery adapter. There is no provider-side Evaluation spend cap or outstanding-request registry. |
| Control | `src/control-mcp.ts`, `src/control-workspace.ts`, `src/host.ts` | Pindie Control owns Host/project/session control. It does not currently create, dispatch, stop, or identify an EvaluationRun. A Control connection or project selection is not Evaluation runtime ownership. |

Therefore the current production facts are: there is no stable Evaluation job/request identity; no durable evaluator runtime handle; no definitive cessation source; no Evaluation-specific process isolation; no closed publication manifest; no durable output/result provenance; and no provider-work or spend enforcement adapter. The current C7 injected values cannot fill these gaps merely by being supplied by Host.

## 2. Runtime cessation architecture

### 2.1 Required execution handle

The future Evaluation dispatcher must create and register one **attempt execution handle** before the first evaluator instruction or provider dispatch. The durable handle record binds:

- exact `EvaluationRunRef`, logical Evaluation key and recovery generation;
- exact execution authority `claimId`, epoch and fencing incarnation;
- a random attempt handle ID and fresh OS process/runtime incarnation ID;
- evaluator contract/profile fingerprint;
- every child task, provider request, callback registration and publication-capable worker spawned under that handle;
- lifecycle events with monotonic sequence numbers and durable acknowledgments.

The dispatcher/Host-side Evaluation runtime supervisor owns the handle. The evaluator cannot create, replace, or report its own handle as proof. Pi owns Pi-native `AgentSession` operations when a future profile uses Pi; Pindie owns the Evaluation supervisor's association between that native session/request and the exact claimed run. This association must not turn the Human Session into an Evaluation worker.

### 2.2 Definitive cessation predicate

`RuntimeCessationInspector` may report `CEASED` only when all of these are positively established for the exact predecessor claim and incarnation:

1. Every local evaluator process/task has acknowledged exit or has been synchronously reaped by its OS parent. A timeout, missed heartbeat, closed socket, disconnected Host, or `AbortSignal.aborted` is not enough.
2. Every registered child asynchronous task and callback has settled; callback registration is closed and queued callbacks are drained or fenced from every publisher.
3. Every provider request has an authoritative terminal response/cancel acknowledgment from a provider contract that guarantees no later execution or effect. If the provider exposes no such query/guarantee, its state is `UNKNOWN`, even when Pi returned an abort error.
4. Every publication worker has exited and lost write authority. Per-attempt write credentials are revoked/fenced at the destination, not merely removed from the in-memory evaluator context.
5. The runtime incarnation is known. An incarnation mismatch after restart proves only that the old controller is gone; it does not prove a remote provider or detached process is gone.

A running registry in the current process is useful evidence while alive, but a registry reset on restart is not evidence of cessation. Durable handle records survive process restart as history; live process handles, Promise state, Pi callbacks and in-memory capabilities do not. After controller/Host restart, locally supervised child processes can be established ceased only if the supervisor has durable identity plus OS-level process containment/reaping or the old isolated worker demonstrably cannot survive the controller. Otherwise the result is `UNKNOWN`. Remote work survives all local restarts until its provider supplies definitive terminal status.

Stop semantics must be strengthened specifically for Evaluation: stop request → close new child/provider/publication admission → revoke/fence all sink credentials → abort Pi/session if used → wait for child exit/reap and provider terminal status → persist cessation receipt. A successful local stop request is not the receipt. Host shutdown may wait for bounded cleanup, but exceeding that wait leaves cessation `UNKNOWN`; it never promotes a timeout to proof.

Unexpected old-owner reappearance is handled by the same durable fencing tokens at every output/result/log sink and by a new isolated incarnation. If a worker can publish after revocation, cessation/isolation is not established and readiness is blocked. No runtime relies on wall-clock lease expiry to stop work.

## 3. Runtime isolation contract

### 3.1 Current classification

The current evaluator is **not isolated for recovery**. Its context object contains no tools or store handles, but the registered evaluator is arbitrary JavaScript executing in the Pindie process. It can access whatever ambient filesystem, network, process environment, imported module state, timers and process APIs are available; it may mutate project files or call providers/APIs itself. There is no enforced capability boundary in `validateEvaluator()` or `createExecutionRunner()`. The current Pi Human Session has the normal configured tool/provider surface. The isolated Learning runner is separate and currently uses a provider-backed Pi Session with `tools: []`, `noTools: "all"`, empty extensions/resources and in-memory SessionManager; this is reduced tool authority, not an OS network/filesystem sandbox or provider spend limit.

### 3.2 Minimal recovery profile

Recovery must initially be limited to a versioned `EvaluationRecoveryExecutionProfile` with:

- a fresh per-attempt worker/process boundary, no reuse of the predecessor's Pi Session or process incarnation;
- immutable packet/context input only; no project-root working directory with write access;
- read-only, bounded input access through explicit handles, no arbitrary project file access, no general tools, no shell/process spawn, no extension/skill/MCP loading, no inherited credentials or ambient environment secrets;
- evaluator output returned as bounded data over one parent-owned channel; no direct run/output/result/store writes;
- all durable publication through Pindie-owned fenced publishers after worker output validation;
- either **no network/provider access** for the first recoverable evaluator class, or a narrow parent-owned provider broker that records request identity, enforces policy, exposes authoritative request status, and blocks replay until predecessor requests are terminal. Direct evaluator network access is forbidden;
- process-level restrictions and an explicit profile fingerprint. Language-level “data-only” input does not constitute enforcement.

If the evaluator needs model output, the broker/provider contract is part of the execution profile and publication manifest. If no authoritative provider request status/cancellation exists, model-backed retries are unsupported and readiness is `UNKNOWN`. Do not claim exactly-once provider computation. The initial dogfood may instead use a deterministic offline evaluator so external execution is absent by construction.

This is a narrow Evaluation recovery profile, not a redesign of general Pindie or Human Pi sandboxing.

## 4. Closed publication-surface manifest

### 4.1 Versioned manifest

The dispatcher must capture a closed `EvaluationPublicationManifestV1` from the registered evaluator/profile before claim. The manifest is strict, versioned, fingerprinted, and bound to the exact attempt. Each entry identifies surface ID/version, writer class, destination/namespace, whether it is applicable, the fence/claim checked by the sink, durable frontier/receipt reader, and whether the surface can cause external effects. Unknown entry/schema is blocking.

Manifest entries cover at least:

| Surface | Current status | Required fact for recovery |
| --- | --- | --- |
| `EvaluationRun` created/running/terminal snapshots | Existing durable writer | Exact immutable history and C6 authority chain. Terminal/run publication remains attempt-specific and fenced. |
| `EvaluationOutput` | No store exists; current output is returned transiently | Future operational output store must be exact-attempt fenced and immutable; inspect its publication frontier and private temp/commit state. |
| `EvaluationResult` | Pure contract only; no publisher | Future operational result publisher and uniqueness index must participate in the shared logical-result serialization/fence. |
| Private temporary files, staging files, links, directory sync/ack | Run/lease stores use private temp + exclusive link + directory sync; evaluator output has none | Every publisher reports write intent, temp identity, link/commit identity and durable acknowledgment. Missing ack or orphan temp with unknown ownership is ambiguous. Empty directory is insufficient. |
| Arbitrary project files | Not prohibited by current callback | In current profile this surface is plausibly applicable and uncontrolled, so isolation fails. Recovery profile makes it inaccessible and the manifest records known absent. |
| Semantic learning stores (Experience, Strategy, Policy, Trust, Decision, Trial artifacts) | Not exposed as runner capabilities by contract, but ambient evaluator code is unrestricted | New profile must prove known absent through enforced capability/process boundary. Any enabled semantic writer is forbidden for Evaluation and blocks recovery. |
| Operational logs/receipts | No Evaluation attempt log/receipt contract | Bounded append-only handle/cessation/accounting/publication receipts are operational and must carry claim/attempt IDs and their own durable frontier. No raw secrets or semantic trust authority. |
| Provider/model requests | No Evaluation request registry | Known absent for offline profile; otherwise exact request ledger plus authoritative provider terminal status, idempotency key where supported, and metered usage evidence. |
| External tools/APIs | No evaluator tool adapter today, ambient JavaScript can call network | Known absent under enforced profile. Any permitted external effect needs an explicit idempotent/reconcilable sink contract; otherwise unsupported. |

The manifest must enumerate known-absent surfaces as explicit entries rather than omitting them. A surface is reconciled only when known absent, definitely ceased, durably fenced against the predecessor, or durably reconciled to an exact committed record. `temp/` emptiness or scanning selected output directories does not prove closure.

### 4.2 Provenance

Every write intent and publication receipt carries exact `logicalEvaluationKey`, exact `EvaluationRunRef`, generation, packet ref/fingerprint, evaluator/profile fingerprint, execution authority ref/epoch/claim ID, execution handle/incarnation, surface ID/version and publication identity. The frontier records both content fingerprint and durable publication acknowledgment. A result/output writer serializes with recovery on the project Evaluation lock (or a narrowly defined lock domain preserving one documented order) and rechecks current authority under that lock.

## 5. Output/result provenance

Keep `EvaluationOutput` operational and `EvaluationResult` semantic contracts distinct.

- `EvaluationOutputV1` remains the evaluator's bounded observation payload. Persisting it as an operational artifact is recommended before recovery is enabled: otherwise a crash after completed Run publication loses the output and prevents diagnosis/reconciliation. Add a separate immutable `EvaluationOutputReceiptV1` envelope/store rather than changing the payload's meaning. Bind logical key, exact run ref, generation, packet, evaluator, profile, authority epoch/claim, handle/incarnation, output fingerprint, publication ID and durable receipt/frontier.
- Keep `EvaluationResult`'s semantic contract unchanged. Add a separate strict `EvaluationResultPublicationV1` operational envelope that binds its exact semantic result ref/content fingerprint to logical key, exact run ref, generation, packet, evaluator, execution authority claim/epoch, output publication ref and publication ID. The envelope is provenance, not new verdict semantics or authority.
- “One logical Evaluation has already produced a result” means a valid, durable unique slot keyed by `(project, logicalEvaluationKey)` points to exactly one immutable result-publication envelope, and the envelope validates through its exact output and run lineage. Packet equality or evaluator equality is not enough. If legacy/unbound result bytes plausibly match but cannot be assigned to a logical key/attempt, classify `UNKNOWN`; never attach them heuristically.
- At-most-one result is enforced at publication, not by a preflight scan alone. The result writer and recovery readiness/claim boundary share one serialization frontier. Result commit first blocks recovered claim; recovered claim first fences old publishers and reserves the logical result slot for its winning attempt. Both attempts may compute only if the runtime/provider policy permits, but only the current claim may publish, and an existing result prevents any later generation from rerunning.
- A late old output after successor materialization is not adopted. Its old claim is fenced at the output/result sink; detection means the surface manifest was not closed and blocks readiness. A committed result beats recovery. A committed output with no result blocks rerun; future output-to-result completion would be a distinct non-execution reconciliation operation.

Evaluation observations remain separate from Trust/Decision. These envelopes grant no Strategy promotion, Policy selection, Trust, Decision, Experience or semantic evidence authority.

## 6. Logical Evaluation job and root identity

There is no current Evaluation job/request identity. `FileLearningJobLedger` is for configured Learning kinds and keys jobs using kind, scope, input fingerprint and policy version. That key is not a suitable Evaluation identity unless an Evaluation-specific owner explicitly creates/binds it before the first root. Host currently does not schedule EvaluationRuns.

The smallest required addition is an Evaluation-owned durable `LogicalEvaluationBindingV1` (or an Evaluation-specific LearningJob kind plus immutable binding) created by the authorized request boundary before dispatch. It contains a stable request/job UUID or caller-issued idempotency key, project, canonical request fingerprint, exact packet ref/fingerprint, evaluator/profile identity, policy generation and the unique root `EvaluationRunRef` once committed. A unique index prevents the same request key from binding to a second root; a unique root binding prevents one root from representing two request keys. Retries of enqueue/dispatch reconcile this binding, not create a new UUID/root.

Required graph:

```text
stable Evaluation request/job key
        ↓ unique immutable binding
one logicalEvaluationKey + one root created ref
        ↓
zero or more linear recovered successors (generation 1, 2, ...)
```

The logical key is derived from the stable binding plus exact root, packet, evaluator and execution profile as appropriate. Job identity is assigned before scheduling and is never inferred from timestamp, packet equality, evaluator equality, or a later result. Missing or conflicting binding is `UNKNOWN`. Existing v2 successors keep their current exact root/run lineage; they do not retroactively acquire a guessed job identity.

## 7. Resource and accounting source

`RecoveryAccountingReader` must combine durable artifact capacity facts with attempt/job/model accounting receipts. These are different claims:

- **Artifact capacity accounting:** existing run/authority/lease/admission/binding namespace limits and `recovery-capacity.ts` reservations can establish finite slots if histories are complete under the same locks. Read exact usage and reservations; do not prune or infer a free slot from an incomplete directory read. Include output/result/receipt/handle namespace capacity and global recovery reservations.
- **Actual provider/model spend:** no current Evaluation facility enforces provider-side token/cost ceilings. Learning budget reservations in `FileLearningBudgetLedger` conservatively charge full token/time caps, but `LearningSessionRunner` notes Pi has no per-request token cap; this is reservation accounting, not provider enforcement. Human session costs and quota fallback are not Evaluation costs. A reservation can bound accepted internal policy but cannot prevent provider spend above it.

Before model-backed recovery is enabled, either use a provider adapter that enforces per-request limits and returns authoritative request IDs, terminal status, token/cost usage receipts and outstanding-work queries, or keep provider execution outside the supported recovery profile. Unknown predecessor usage is charged at the full configured per-attempt cap for tokens/cost/duration; if no defensible cap/receipt exists, resource state is `UNKNOWN` and claim is blocked. Do not refund an interrupted reservation because a job lease expired.

Accounting must include old attempt maximum exposure, all earlier generations, pending reservations, successor reservations, and global reservations. Maintain separate ledgers for artifact slots and spend ceilings; never describe one as proof of the other. Unknown backend, stale snapshot, corrupt ledger, clock-domain ambiguity or lock failure means `UNKNOWN`, not zero use.

## 8. Read-only `RecoveryExecutionReadiness`

Define one deterministic, read-only projection over exact immutable refs and fresh inspectors:

```ts
interface RecoveryExecutionReadinessV1 {
  schemaVersion: 1;
  state: "READY" | "BLOCKED" | "UNKNOWN";
  targetRunRef: EvaluationRunRef; // exact v2 created snapshot
  admissionRef: RecoveryAdmissionRef;
  successorBindingRef: RecoverySuccessorBindingRef;
  logicalEvaluationKey: string;
  observedAt: string;
  facts: { /* exact source refs/fingerprints and per-guard state */ };
  reasons: readonly { code: string; detail: string }[];
}
```

It resolves and validates, in bounded deterministic order: exact admission/binding/v2 created run; full root-to-target linear lineage and unique job/root binding; predecessor authority/lease/C6 confirmation/fence; current runtime cessation receipt including children/provider/callbacks; execution profile/isolation and fresh runtime availability; complete versioned publication manifest and all frontiers; output/result slot uniqueness; current project/request authorization and policy; exact packet/evaluator/profile registration; current artifact capacity and conservative accounting reservations. Every fact binds the observed `observedAt` and exact refs/digests. The projection grants no claim, reservation, write right or dispatch right.

- `READY`: every required fact is positively established and fresh under the specified lock/version frontier.
- `BLOCKED`: a known current prohibition exists (for example revoked authorization, result already published, unsupported evaluator, capacity exhausted, wrong exact ref).
- `UNKNOWN`: required history/fact is absent, unavailable, stale, corrupt, unsupported, ambiguous or not provable (including lost runtime handle/provider status).

It explains blockers with stable reason codes and source refs; explanations are diagnostic only. It does not mutate admission, binding, Run, accounting, authority or output. It should not persist a durable “ready” boolean because the facts age immediately.

## 9. Future pre-claim transaction boundary

`READY` is advisory and can race. Future C7-D must place the final check and claim in a serialized boundary. The intended order is:

```text
EvaluationRun v2(created)
        |
        v
fresh production readiness projection
        |
        v
narrow one-use recovery execution admission (internal to claim boundary)
        |
        v
claimExecution(v2)
        |
        v
new epoch-0 execution authority + fresh handle/incarnation
```

Immediately before the unique running/authority publication, revalidate exact v2 created ref, admission, successor binding, entire lineage/job root, predecessor fence and cessation receipt, isolation/profile registration, publication manifest/frontier, result/output unique slots, packet/evaluator, current authorization/policy and resource/accounting limits. Recheck shared versions/locks after any external read that cannot be performed under the local lock. No filesystem or provider scan can be treated as a snapshot unless its own revision/frontier is bound.

The claim path must be extended narrowly to support v2 only with a private recovery-admission callback/token that is non-persistable, one-use and scoped to the genuine RunStore. It is not a bearer claim and is not accepted by ordinary `publish()`. Under the Run/result serialization lock it revalidates all local durable facts, then publishes the unique running snapshot and its fresh epoch-zero authority/lease origin in the documented order before returning the genuine process-local claim. These immutable files are not a cross-directory atomic transaction: if the running frontier commits but authority initialization or its durability acknowledgment is uncertain, the target is consumed without a returned claim and must not be replayed or reconstructed. `claimExecution()` remains the sole live-ownership grant. Any failure before the running frontier leaves v2 `created`; any uncertain failure after it is treated as consumed and cannot invoke the evaluator from reconstructed history.

A valid `RecoveryAdmission`, `RecoverySuccessorBinding`, or `EvaluationRun v2(created)` alone is never enough. If future design cannot make result publication and claim share one linearization point, result-bearing recovery remains disabled.

## 10. Narrow capability model

Future adapter interfaces should expose facts and no mutation authority:

| Capability | Allowed operations | Must not expose |
| --- | --- | --- |
| `RuntimeCessationInspector` | Inspect exact handle/claim/incarnation; read durable child/provider terminal receipts; return `CEASED` / `ACTIVE` / `UNKNOWN` with evidence refs | Invocation, abort as proof, runtime creation, Run publication, claims |
| `ExecutionIsolationInspector` | Read registered immutable profile, worker/process confinement facts and exact runtime readiness | Arbitrary evaluator invocation, filesystem/network/process handles |
| `PublicationSurfaceInspector` | Read captured manifest, write-intent/publication receipts, sink fence and durable frontiers | Generic publication or cleanup/delete authority |
| `LogicalEvaluationBindingReader` | Resolve stable request key, exact root and linear job/run lineage | Enqueue, root allocation, job mutation |
| `RecoveryAccountingReader` | Read reservations, usage receipts, outstanding requests and artifact capacity under a versioned snapshot | Spend, reserve, refund, or provider invocation (reservation may be a separate narrow commit capability later) |
| `ResultProvenanceReader` | Resolve exact logical result slot and output/result envelope lineage | Result publication, semantic decision, trust writes |
| `RecoveryExecutionReadinessReader` | Compose the above into a read-only projection | Claim or dispatch |

Keep admission creation, successor materialization, recovery slot reservation, result publication and `claimExecution()` as separate narrowly registered capabilities. None of the read adapters can write Strategy, Policy selection, Trust, Decision or Experience. Do not introduce a generic RecoveryManager with all authorities.

## 11. Failure and race analysis

| Scenario | Classification / required behavior |
| --- | --- |
| Host/controller restart loses runtime handle | Durable record survives, live handle does not. `UNKNOWN` unless OS containment/reaping and every external request are independently proven terminal. |
| Provider request status unknown | `UNKNOWN`; local abort, timeout, missing callback, or lost network is not cessation. No replay. |
| Old owner unexpectedly reappears | Sink fencing rejects its writes. If any route cannot enforce the old claim/epoch, profile invalid and `UNKNOWN`; quarantine, never reopen old claim. |
| Committed output appears after successor materialization | Late output is rejected by old claim fence and recorded as a manifest violation. Recompute readiness as blocked/unknown; do not adopt output or execute successor. |
| Result publication races recovery claim | Same result/run serialization frontier gives a single order: result wins and claim blocks, or claim wins and old publisher is fenced; exact winning attempt may publish one unique result. If no common lock/fence, keep recovery disabled. |
| Accounting backend unavailable | `UNKNOWN`, no zero/default usage and no claim. |
| Job/root identity missing | `UNKNOWN`; no inference from packet, evaluator or timestamps. Existing successor stays created. |
| Runtime isolation unavailable | `BLOCKED` for known absent required profile or `UNKNOWN` if facts cannot be established; no recovery execution. |
| Admission valid but authorization changed | `BLOCKED`; immutable admission does not preserve current authorization. |
| Successor remains `created` for a long time | No lease expiry creates authority. Readiness is recomputed; policy, authorization, result frontier, capacity and runtime facts may make it blocked/unknown. Admission remains consumed; no second successor. |
| Two dispatchers attempt pre-claim concurrently | Project Run/result lock serializes final revalidation and claim. One wins; the second sees running/consumed claim and cannot invoke. Lost acknowledgment is reconciled as consumed, never retried. |
| Crash during output/result temp/link/sync | Reconcile exact temporary identity, link, directory sync and receipt. Any ambiguous frontier is `UNKNOWN`; a scan finding no final file is not enough. |
| Worker exit observed but callback/provider remains | Not ceased. Every registered child, callback, publisher and external request must be independently settled or fenced. |

All ambiguous cases fail closed. No heartbeat threshold, elapsed time, process disconnection, cancellation request or empty directory is cessation proof.

## 12. Legacy compatibility

- Keep EvaluationRun v1 parsing, C6 authority history, C7-A admissions, C7-B bindings and all already-created v2 successor bytes immutable and readable. Do not rewrite, reclassify, backfill guessed job IDs, or republish them.
- `claimExecution(v2)` continues to reject until a separately approved C7-D implementation integrates every readiness requirement and the result/claim linearization boundary.
- Existing recovered successors remain `created` and non-executable whenever job/root binding, runtime handle/cessation, isolation, publication manifest, output/result provenance, current authorization, accounting, or fresh resource facts cannot be established. Current repository seams do not establish these production facts; therefore currently materialized v2 successors remain non-executable under this design.
- Historical v1 root attempts may be given an explicit job/root binding only by an authorized future migration that can positively identify the original request. Otherwise the chain is `UNKNOWN`; packet/evaluator matching is insufficient.
- Do not treat C7-A/B injected reconciliation/resource assertions or their stored snapshots as production proof. They remain immutable historical admission evidence and are not modified by this design.
- Observation and Evaluation remain separate from Trust/Decision. This design adds no Strategy/Policy/Trust/Decision/Experience authority and no automatic promotion.

## 13. Implementation sequence

The suggested C7-C1 / C7-C2 / C7-D / C7-E split is appropriate, with C7-C1 required to settle ownership/contract shapes before adapters are added:

1. **C7-C1 — production readiness contracts and projection.** Add strict versioned facts, `EvaluationPublicationManifest`, `LogicalEvaluationBinding`, cessation/isolation/accounting/result provenance reader contracts, and deterministic `RecoveryExecutionReadiness`. Keep all injected C7-A/B contracts and v2 claim rejection unchanged. This slice should include no live provider execution and no new claim authority.
2. **C7-C2 — bounded production adapters and operational provenance guards.** Add Evaluation-specific job/root binding at the actual request owner; process/attempt handle ledger and exact stop/cessation receipts; enforce the narrow recovery profile; add output receipt and result publication envelope/unique slot; connect provider request/accounting only where authoritative status and bounds exist; serialize every publisher/frontier with old-claim fencing. Keep recovered claim disabled until dogfood proves every surface.
3. **C7-D — fresh pre-claim recovery execution admission.** Extend only the internal genuine RunStore claim path to revalidate readiness at the shared claim/result frontier, create fresh epoch-zero authority/lease/handle ownership, and make claim the sole execution grant. Keep normal v1 behavior and ordinary publication constrained; concurrent and crash-recovery cases must be covered before rollout.
4. **C7-E — explicit isolated recovery dogfood.** Start with one deterministic offline evaluator and a single bounded project/job. Exercise restart, worker kill/reap, late publication, lost acknowledgment, duplicate dispatch and result races. Add model-backed execution only if its provider adapter proves request cessation, stable request identity and enforced accounting bounds. Human approval/Trust/Decision remains outside this execution path.

The sequence is ordered: do not build a model-backed recovery adapter before the runtime and publication contracts close, and do not enable v2 claim after contracts alone. Production recovered execution remains disabled until C7-D and explicit C7-E evidence establish each fact at runtime.
