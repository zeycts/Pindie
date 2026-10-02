# Autonomous Learning R4-C3-B — Evaluation execution runner and durable ownership

Status: standalone execution boundary implemented, extending the B1 invocation contract with durable ownership and lifecycle publication. No real evaluator, LLM/Pi invocation, production registration, EvaluationResult publication or semantic mutations.

## Contract and registration

`ExecutionRunner.execute(createdRun)` returns `EvaluationExecutionOutcomeV1` only after both running and terminal snapshots are committed. `createExecutionRunner` registers one strict `EvaluatorV1`, an exact packet reader (`Pick<EvaluationPacketStore, "get">`), an execution claim capability (`Pick<EvaluationRunStore, "claimExecution">`) and an optional operational clock. Registration captures the evaluate function and a detached frozen identity. A run must validate, be `created`, and name exactly the registered evaluator/version. Invalid registration, run, lifecycle placement or identity rejects before claiming, packet reads or invocation. Invalid/nonmonotonic clock values reject through existing transition validation and are caller configuration errors.

The caller must first publish the created attempt through the existing EvaluationRunStore, which validates its exact immutable packet binding. The runner detaches caller input before its first await and asks the store to claim that exact committed created snapshot. Missing, changed, already-running or terminal history rejects before packet reads or evaluator invocation.

## Durable execution ownership

`FileEvaluationRunStore.claimExecution(created, startedAt)` validates the full namespace history under the existing namespace writer lock, requires its current chain to contain only the exact created snapshot, and constructs `running` through `transitionEvaluationRun`. It publishes the running snapshot using the existing exclusive temporary-write, sync, unique hard-link and directory-sync convention. The immutable running artifact is the durable consumed-execution claim; no token artifact, mutable current pointer, new ledger or persistence framework is introduced.

Only the unique creator receives a frozen claim containing `running` and `publishTerminal`. An identical running snapshot is not an ownership retry: a competing or replayed claim always rejects. Independent runners/store instances and processes coordinate through the same filesystem writer lock. The lock is released before packet loading or evaluator invocation; unrelated attempts may publish while an evaluator runs.

The claim's terminal publication capability captures that exact committed running snapshot. Under the same namespace lock it validates the complete history, exact claim binding and legal running-to-terminal edge. It then publishes one immutable completed or failed snapshot. Identical terminal publication retries converge; changed contents or a competing terminal reject without overwrite. This publication idempotency does not authorize evaluator replay.

Claim and claimed terminal publication rely on the exact binding already validated by created publication, without re-reading the packet. This narrow execution path allows missing/corrupt packet reads to become durable failures. Ordinary `publish` retains its R4-C2 packet revalidation contract unchanged. A claimed completion still requires the runner's independent packet/input/output validation. No live Experience or raw source/comparison input is consulted.

## Invocation, lifecycle and failure

After the running commit, the runner reads only its exact packet ref, independently validates packet schema/content fingerprint and full binding, and reuses `prepareEvaluationInput` for detached deeply frozen packet/context. One invocation receives exactly these two arguments. Returned output must satisfy `matchesEvaluationOutputContext`, including strict output validation and exact attempt, packet, evaluator/version and start timestamp bindings. Output is detached, revalidated and frozen before release. An evaluator completion timestamp cannot exceed the runner's observed completion timestamp.

The existing transition helper enforces `created → running → completed | failed`; running/terminal input is rejected. The caller's run/packet is never mutated. Success contains transient validated observation-only output; failure has no output field. Completion records execution only, not strategy quality or trust.

Bounded fixed failure diagnostics distinguish `PACKET_LOAD_FAILED` (including missing/unreadable/corrupt store reads), `INVALID_PACKET`, `PACKET_BINDING_MISMATCH`, `INVALID_INPUT`, `EVALUATOR_EXCEPTION` and `INVALID_OUTPUT`. Arbitrary exception objects/messages are not copied to metadata. Failed snapshots preserve all identity and preceding timestamps. No EvaluationOutput/EvaluationResult artifact is published, even if an evaluator throws after constructing partial output. No retry is automatic.

Publication errors propagate; the runner does not return a successful or failed outcome that was not durably acknowledged. If claim publication fails before linking, no running artifact is visible and no evaluator is invoked. If acknowledgment is lost after linking, the running claim remains consumed and no caller is granted replacement execution ownership. Death after claiming can leave an immutable running attempt indefinitely. Terminal publication failure before linking leaves running history; failure after linking can leave a committed terminal despite rejection. Exact history remains readable, and replay never invokes the evaluator again. Recovery, retry policy, timeout and cancellation are outside this change.

## Metadata and isolation

Run ID, packet ref/fingerprint and evaluator identity/version come from the validated attempt. `startedAt` and terminal `completedAt` come from the supplied clock, independently of semantic observations. The runner allocates no new IDs, verdicts, result refs or model provenance. Equivalent exact attempts in independent histories with the same packet, evaluator output and clock sequence serialize identically; wall-clock timestamps and arbitrary evaluator output are not inherently deterministic. Within one history the attempt executes at most once.

The evaluator receives no Experience, TrialEvidence, Strategy, Policy, Trust or Decision writers, nor a packet/run store, execution claim, clock, runtime Session or scheduler. Its frozen receiver contains only schema version, identity and evaluate function. Frozen detached nested inputs protect supplied artifacts and caller references. This is capability isolation of the supplied interface, not a process sandbox: arbitrary injected functions may retain ambient filesystem/network/closure authority. No production composition imports the runner.

## Remaining execution requirements

Separately approved work must provide native Pi/runtime isolation and real evaluator/model provenance; stale/abort fences; bounded execution and crash/retry reconciliation; immutable EvaluationOutput/EvaluationResult publication with exact bindings; and operational capacity/retention protection. Retry policy, timeout, cancellation, real evaluators/LLM calls and Trust/Decision/Strategy/Policy mutations are absent. No production dogfood is claimed.

Tests use real packet/run stores to cover persisted success and failure, running visibility before invocation, concurrent exclusive claims with identical timestamps, stale-created terminal replay, actual packet loss/corruption, exact claim settlement, immutable history, pre/post-publication failures, capability-free frozen arguments/receiver and stable metadata across independent histories.
