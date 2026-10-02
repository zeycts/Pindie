# Autonomous Learning R4-C3-C1 — Execution Lease contract

Status: standalone pure contract implemented. No lease persistence, heartbeat timer, stale detection, recovery, cancellation, retry, evaluator invocation or production wiring is added.

## Schema and meaning

`ExecutionLeaseV1` represents ownership metadata for the authority to continue one EvaluationRun execution. Strict fields are `schemaVersion: 1` (the lease version), UUID-v4 `runId`, nonempty `ownerId` of at most 128 characters, and canonical ISO `acquiredAt` / `heartbeatAt` timestamps. Owner IDs reuse the existing LearningJob owner-length convention and are opaque operational identities, not evaluator/model provenance or authentication credentials. `heartbeatAt >= acquiredAt`; missing/unknown keys, unsupported versions, invalid IDs and noncanonical or reversed timestamps fail closed through `validateExecutionLease`.

`createExecutionLease(running, ownerId)` projects a frozen initial lease from a valid running EvaluationRun: `runId` is exact and both timestamps equal `startedAt`. Created and terminal runs reject. This pure helper does not prove that running was committed or acquire execution authority. All fields are primitive and readonly; no caller reference is retained. Existing `canonicalJson` and `learningFingerprint` conventions give stable bytes/digests for the same metadata regardless of object key order. No dedicated artifact ref, storage namespace or changed EvaluationRun schema is introduced.

## Ownership and claimExecution

Only one active lease may represent one execution. The existing R4-C3-B `claimExecution` boundary remains the authority acquisition mechanism: under the EvaluationRun namespace lock, only the unique publisher of the immutable running snapshot receives the claim and its exact terminal-publication capability. Competing/replayed claims reject, including identical timestamps. Lease creation is intended for that unique claim owner; validating or copying lease bytes, inventing an owner ID or reading committed running history grants no claim. The contract helper is deliberately not a second ownership registry and cannot independently enforce uniqueness among caller-created values.

This slice defines the metadata contract only: it does not attach leases to claims, accept lease bytes as authorization, change ExecutionRunner, or add persistence. Future durable integration must atomically bind the single lease owner to the unique claim and exact attempt in its project namespace, preserving the existing consumed-claim behavior. A terminal run has no continuing execution authority, even if an old lease snapshot remains readable. No release/reacquisition or replacement owner is legal in this contract.

## Immutable heartbeat history

`heartbeatExecutionLease(previous, heartbeatAt)` returns a new frozen snapshot and leaves the previous snapshot unchanged. `isExecutionLeaseHeartbeat` independently validates both snapshots and requires identical schema version, run ID, owner ID and acquisition timestamp; only heartbeat time may advance. Equal timestamps are legal identical metadata retries. Backward or invalid times and changed ownership reject. This preserves who owned execution and when ownership began across the complete supplied snapshot chain; no helper rewrites prior history. There is no durable history store in C1.

Heartbeat timestamps describe operational progress reports only. They imply no expiration duration, deadline, timeout, liveness proof or right to reclaim. Stale detection still needs a separately approved clock/threshold policy and durable heartbeat publication with exact owner/attempt fencing and immutable history. Recovery, takeover and retry need their own explicit authority rules; an old/missing heartbeat alone cannot replay evaluator execution. Lost claim acknowledgment or process death retains the existing consumed running attempt without replacement ownership.

## Capability boundary

Lease values expose only metadata and grant no Strategy mutation, Policy mutation, Trust mutation, Decision authority, EvaluationResult publication, evaluator invocation or terminal-publication capability. The module imports pure contracts only, performs no I/O and is not imported by production composition or ExecutionRunner. Frozen values and strict shape validation protect the supplied interface; they are not a process sandbox or proof of an owner's identity.

Tests cover valid creation/lifecycle placement, missing/unknown fields, malformed IDs/owners/times/versions, deterministic serialization/fingerprints, immutable owner/acquisition identity, monotonic and identical heartbeats, and absent mutation/execution capabilities. Existing run-store/runner tests retain exclusive claim and immutable lifecycle coverage.
