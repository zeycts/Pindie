# Autonomous Learning R4-C3-B1 — Evaluation execution runner contract

Status: standalone runner boundary implemented. Registered test evaluators can be invoked; no real evaluator, LLM/Pi invocation, production registration, artifact publication or semantic mutations.

## Contract and registration

`ExecutionRunner.execute(createdRun)` returns `EvaluationExecutionOutcomeV1`. `createExecutionRunner` registers one strict `EvaluatorV1`, an exact packet reader (`Pick<EvaluationPacketStore, "get">`) and an optional operational clock. Registration captures the evaluate function and a detached frozen identity. A run must validate, be `created`, and name exactly the registered evaluator/version. Invalid registration, run, lifecycle placement or identity rejects before packet reads or invocation; it cannot manufacture a valid failure for invalid input. Invalid/nonmonotonic clock values reject through existing transition validation and are caller configuration errors.

The runner detaches the run before its first await, constructs `running` via `transitionEvaluationRun`, reads only its exact packet ref, independently validates the packet and full binding, and reuses `prepareEvaluationInput` for detached deeply frozen packet/context. One invocation receives exactly these two arguments. Returned output must satisfy `matchesEvaluationOutputContext`, including strict output validation and exact attempt, packet, evaluator/version and start timestamp bindings. Output is detached, revalidated and frozen before release. An evaluator completion timestamp cannot exceed the runner's observed completion timestamp.

## Lifecycle and failure

Both snapshots are returned: `running`, followed by terminal `run`. The existing transition helper enforces `created → running → completed | failed`; running/terminal input is rejected. The caller's run/packet is never mutated. Success contains validated observation-only output; failure has no output field. Completion records execution only, not strategy quality or trust.

Bounded fixed failure diagnostics distinguish `PACKET_LOAD_FAILED` (including missing/unreadable/corrupt store reads), `INVALID_PACKET`, `PACKET_BINDING_MISMATCH`, `INVALID_INPUT`, `EVALUATOR_EXCEPTION` and `INVALID_OUTPUT`. Arbitrary exception objects/messages are not copied to metadata. Failed snapshots preserve all identity and preceding timestamps. No output or result is published, even if an evaluator throws after constructing partial output. No retry is automatic.

B1 integrates **in-memory lifecycle transitions**, not durable orchestration. It does not inject a run store or publish snapshots. R4-C2 deliberately requires a resolvable packet for every publication, including failed states; durably recording missing-packet failure cannot be accomplished by blindly forwarding this outcome to that store. That storage/orchestration decision belongs to separately approved R4-C3-C work. B1 leaves the established store contract intact. Reusing a created snapshot can invoke again; at-most-once execution, concurrent attempt claims and recovery after death are not guaranteed here.

## Metadata and isolation

Run ID, packet ref/fingerprint and evaluator identity/version come from the validated attempt. `startedAt` and terminal `completedAt` come from the supplied clock, independently of semantic observations. The runner allocates no new IDs, verdicts, result refs or model provenance. Given the same exact attempt, packet, evaluator output and clock sequence, outcome serialization is stable; wall-clock timestamps and arbitrary evaluator output are not inherently deterministic.

The evaluator receives no Experience, Strategy, Policy, Trust or Decision writers, nor a packet/run store, clock, runtime Session or scheduler. Its frozen receiver contains only schema version, identity and evaluate function, rather than binding `this` to the registration object. Frozen detached nested inputs protect supplied artifacts and caller references. This is capability isolation of the **supplied interface**, not a process sandbox: arbitrary injected functions may retain ambient filesystem/network/closure authority. No production composition imports the runner.

## Remaining R4-C3-C requirements

Separately approved work must provide native Pi/runtime execution isolation and real evaluator/model provenance; durable run claiming and lifecycle orchestration (including unavailable-packet failures); stale/abort fences; bounded execution and crash/retry reconciliation; immutable EvaluationOutput/EvaluationResult publication with exact bindings; and operational capacity/retention protection. Result persistence, real evaluators/LLM calls and Trust/Decision/Strategy/Policy mutations are absent from B1. No production dogfood is claimed.

Tests cover success and both lifecycle edges, failed packet reads/schema/bindings, evaluator exceptions and invalid/foreign outputs, terminal/identity rejection before reads, capability-free frozen arguments/receiver, detachment across awaits and stable metadata under an injected clock.
