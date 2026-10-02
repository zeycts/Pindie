# Autonomous Learning R4-C2 — EvaluationRun foundation

Status: standalone execution-record foundation implemented. No evaluator, Pi Session/Run, model invocation, EvaluationResult generation/publication, scheduler hook or production registration. This approved bounded slice supersedes R4-C1's earlier broader description of remaining R4-C2 work.

## Meaning and schema

One `EvaluationRunV1` is one operational attempt to evaluate one immutable EvaluationPacket. It is not a conclusion, recommendation, strategy decision or trust transition. Strict version-1 fields: UUID-v4 `runId`, exact dedicated `packetRef`, redundant matching `packetFingerprint`, bounded nonempty evaluator `{ name, version }`, status, canonical ISO `createdAt` and status-dependent timestamps/failure. Unknown keys, including score/verdict/confidence/recommendation, are rejected. Canonical run size is at most 8KiB. Evaluator strings identify the intended evaluator only; no invocation or model provenance is claimed.

- `created`: only creation timestamp.
- `running`: adds `startedAt >= createdAt`.
- `completed`: adds `completedAt >= startedAt`, no failure.
- `failed`: adds `completedAt >= startedAt` and bounded nonempty `{ code, message }`.

Only `created → running → completed | failed` is legal. Identity, exact packet, evaluator, creation timestamp and existing start timestamp cannot change. Terminal states have no outgoing edge. `completed` records operational completion only and neither requires nor invents an EvaluationResult in this foundation. Failures are operational diagnostics, not analysis or hidden reasoning.

## Immutable lifecycle storage

`EvaluationRunStore` / `FileEvaluationRunStore` exposes `publish(run)`, `get(exactSnapshotRef)` and `getCurrent(projectId, runId)`, plus the R4-C3-B `claimExecution(created, startedAt)` boundary described below. `transitionEvaluationRun` constructs and validates a legal edge; store publication independently validates it against committed history. Callers choose the attempt UUID and timestamps once and reuse exact snapshots on retry. A new attempt requires a new UUID; no scheduler/retry allocation is implemented.

Project-local `learning-v1/evaluation-runs-v1/<runId>.<status>.json` contains a strict canonical `{ schemaVersion: 1, fingerprint, run }` envelope. The SHA-256 digest covers all run fields. Each state is a separate immutable artifact; no mutable current pointer or overwritten run file exists. Current state is derived from the complete validated chain. Missing predecessors, conflicting terminals, malformed filenames, foreign project/UUID, unknown fields/version, noncanonical bytes, digest mismatch and oversized files fail closed. Full namespace validation bounds history to 4096 attempts and at most three snapshots each. Capacity blocks new attempts without pruning, but permits existing attempts to finish/retry.

A dedicated `EvaluationRunRef` binds schema, family `evaluation-run`, project ID, run ID, status and whole-snapshot fingerprint. It is not an EvaluationRef, LearningArtifactRef, LearningJob output or Decision input. Exact lookup returns detached deeply frozen snapshots and does not substitute the current state. Lookup validates stored history without needing the packet to remain available; ordinary `publish` (including retries and transitions) requires the packet to resolve again. The separate R4-C3-B execution claim/settlement path uses the exact prevalidated created binding.

## Packet binding and transaction

The only injected read capability is `packets.get(exactRef)`, structurally compatible with R4-C1 EvaluationPacketStore. Before ordinary `publish`, under the namespace's `FileGlobalWriterLock`, resolve the exact immutable packet, independently validate its schema/content fingerprint and compare its complete ref and fingerprint. Missing, corrupt or mismatched packets reject publication. Never resolve live Experience, raw comparison/source refs, current Strategy, Policy or Trust. Packet snapshots already contain the analysis inputs; their original sources need not remain available.

Freeze detached canonical caller bytes before the first await. Under lock validate all history, enforce the legal next edge or identical historical retry, revalidate packet availability and publication authority, write an exclusive temporary file inside `writer.lock/`, sync/close and verify bytes, then synchronously hard-link to the final filename and sync the directory. Abort/current-authority checks fence the commit frontier. Same run ID/status and identical content is idempotent; changed content at the same state or a competing terminal fails without overwrite. A valid next state is a new artifact, not permission to republish changed content at the same identity. Concurrent identical writers converge; competing contents/terminal edges yield only one commit.

Failure/death before linking leaves no visible state; after linking an acknowledgement may be lost. Exact lookup and identical retry reconcile the committed snapshot without allocating another attempt. Existing FileGlobalWriterLock dead-owner recovery applies; ambiguous locks are not stolen. No automatic repair, deletion, retention change or stronger power-loss claim is introduced.

## R4-C3-B durable execution claim

The approved durable ownership extension adds `claimExecution(created, startedAt)`. Under the existing namespace lock it requires the exact committed created snapshot to be current, constructs running through the existing lifecycle helper and uniquely publishes it using the same immutable snapshot writer. An identical running snapshot is never an ownership retry: only the unique publisher receives the frozen `{ running, publishTerminal }` claim. Missing, changed, running or terminal history rejects. No persisted lease/token or new artifact family is added.

Claim-bound `publishTerminal` captures the exact running snapshot, independently checks full history and the legal terminal edge under lock, and publishes one immutable completed/failed artifact. Identical terminal retries converge; competing contents reject. Claim/settlement use the packet binding already validated by created publication without reloading the packet, enabling durable missing/corrupt-packet failure records. This exception is confined to the new execution path; ordinary `publish` retains packet revalidation unchanged. The runner validates its loaded packet and output before claimed completion. No evaluator receives the claim or store.

Lost acknowledgment after running commits grants no replacement claim; no automatic reclaim or evaluator replay exists. Terminal publication failures propagate and leave either the preceding running state or the already-linked terminal state readable. Recovery, retry policy, timeout and cancellation remain pending. See [R4-C3-B](autonomous-learning-r4-c3-b1.md) for invocation and ownership guarantees.

## Execution isolation and remaining R4-C3

The module owns only its `evaluation-runs-v1` namespace. It receives no Experience, TrialEvidence, Strategy, Policy, Trust, Decision, runtime Session, scheduler or model write/execution capability. It is not imported by production composition and cannot affect normal Agent behavior. No tool surface, policy selection, Task state or LearningJob transition changes. This is a constrained record/store API, **not a sandbox for an arbitrary injected reader or future evaluator**.

[R4-C3-A](autonomous-learning-r4-c3-a.md) now supplies only the pure versioned Evaluator/context/output contract boundary and detached frozen input preparation; it does not invoke evaluators or change this store. R4-C3-B now adds exclusive execution claims and durable lifecycle publication only. Remaining execution work still needs separately approved evaluator/native Pi execution and authority fencing, durable job/attempt/packet/result retry binding and crash reconciliation, bounded actual model provenance, immutable EvaluationResult publication/exact bindings, runtime isolation enforcement for the evaluator, and operational capacity/retention protection. This foundation supplies none of those capabilities and grants no trust. Strategy/Policy/Trust/Decision mutation remains a separate later boundary.

Tests cover strict schema, timestamps, lifecycle edges, immutable history and exact lookup, packet absence/corruption/ref/digest rejection, idempotency/conflicts, concurrent publications/terminal races, stored corruption, precommit abort/staleness, postcommit reconciliation and namespace isolation.

[R4-C3-C1](autonomous-learning-r4-c3-c1.md) now defines pure ExecutionLease v1 ownership metadata and immutable heartbeat updates. It does not alter this execution claim/store boundary or add lease persistence, stale detection, recovery or takeover.
