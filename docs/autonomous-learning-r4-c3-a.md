# Autonomous Learning R4-C3-A — Evaluator contract foundation

Status: standalone pure version-1 contract boundary implemented. No real evaluator, invocation, LLM/Pi execution, scheduler registration, persistence or production wiring.

## Boundary

`EvaluatorV1` is a structural plain-object extension interface with `schemaVersion: 1`, bounded `{ name, version }` identity and `evaluate(immutablePacket, isolatedContext): Promise<EvaluationOutputV1>`. It consumes an existing validated EvaluationPacket v1 and returns execution output, not strategy quality, trust, promotion or Policy changes. `validateEvaluator` checks interface shape only; it neither invokes nor certifies implementation behavior. Names/versions reuse EvaluationRun's identity convention and do not claim actual model provenance.

`EvaluationExecutionContextV1` contains only schema version, UUID-v4 run ID, exact packet ref, redundant matching packet fingerprint, evaluator identity and execution metadata (`startedAt`, canonical ISO timestamp). No stores, callbacks, live Experience reader, runtime Session, learning state writer or decision authority is exposed. Strict exact-key validation rejects additional capabilities and malformed/missing packet context; its canonical size is bounded to 4KiB.

`prepareEvaluationInput(packet, runningRun)` validates both existing contracts and their exact packet binding, projects context from a valid running attempt, then returns detached, recursively frozen packet/context values. It performs no I/O, invocation or lifecycle transition and does not prove that the supplied run was durably published. The context has no mutable input references. `matchesEvaluationExecutionContext` independently validates packet content and its complete exact ref, including scope, ID and fingerprint.

## Execution output

`EvaluationOutputV1` is transient, not an immutable published artifact or EvaluationResult. It contains schema version, run ID, exact packet ref/fingerprint, evaluator identity, execution metadata (`startedAt`, `completedAt >= startedAt`), observations and diagnostics. Observations are up to 16 nonempty strings of at most 1024 characters. Diagnostics are up to 16 strict `{ code, message }` objects (128/1024 characters). Empty arrays are legal; no observations are invented to signify success. Total canonical output is at most 16KiB. Identity strings are at most 128 characters. Invalid versions, unknown fields at each structured level, malformed identities/times, missing binding and excessive sizes fail closed.

No score, verdict, recommendation, promotion, confidence or trust field exists. Free text carries bounded observations/operational diagnostics, not hidden reasoning or decision authority; schema validation cannot certify the semantic truth of prose. `matchesEvaluationOutputContext` additionally requires exact run, packet, evaluator/version and start timestamp agreement. Shape validation alone cannot establish provenance or successful execution. Serialization uses the existing `canonicalJson` / `learningFingerprint` conventions; object key order is immaterial, while ordered observation/diagnostic arrays retain their meaning. There is no output ID/ref family, store or automatic conversion to EvaluationResult/Decision.

## Isolation guarantees and limits

Readonly TypeScript contracts, strict capability-free context shape and detached deeply frozen preparation prevent mutation through supplied packet/context references. This is **not a sandbox**: arbitrary evaluator code could retain ambient filesystem, network or closure capabilities. No evaluator is run here, and no claim of enforced process/native Pi isolation is made. The module imports only pure contracts and does not expose or alter Experience, TrialEvidence, Strategy, Policy, Trust, Decision, Task, LearningJob or runtime stores. Existing R4-A result schemas and R4-C2 lifecycle/storage remain unchanged.

## Remaining R4-C3-B requirements

Separately approved execution work must enforce native Pi/runtime isolation and restricted capabilities; bind the selected evaluator identity and actual bounded model provenance to the exact durable attempt; validate prepared inputs and returned output at invocation boundaries; fence stale/aborted execution and publication; reconcile durable job/attempt/packet/output/result retries after crashes; and implement immutable EvaluationResult publication/exact bindings plus operational capacity/retention protection. This slice supplies only contracts and pure preparation/validation, none of those execution mechanisms. Trust, Decision and Strategy mutation remain separate later boundaries.

Tests cover structural evaluator shape without invoking it, strict observation-only output, missing/foreign packet context, exact output binding, limits/timestamps, absent mutation capabilities, readonly typing, detached deep freezing and deterministic serialization.
