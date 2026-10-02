# Autonomous Learning R4-C1 — EvaluationPacket Store foundation

Status: standalone immutable packet store implemented. No production registration, model invocation, EvaluationResult publication or authority-changing behavior. The standalone EvaluationRun record/store foundation is now implemented separately in [R4-C2](autonomous-learning-r4-c2.md).

## Storage and identity

`EvaluationPacketStore` / `FileEvaluationPacketStore` exposes `publish(packet)`, `get(ref)`, `exists(ref)` and `validate(ref)`. It uses R4-A's dedicated schema-1 `evaluation-packet` ref unchanged, never a LearningArtifactRef/StrategyEvaluation/Decision input. R4-B's deterministic packet UUID and canonical fingerprint are preserved verbatim; the store invents no retry identity.

Project-local `learning-v1/evaluation-packets-v1/<UUID>.json` contains a strict canonical envelope `{ schemaVersion: 1, createdAt, packet }`. `createdAt` is first-publication operational metadata, not an analysis input or part of the packet fingerprint; identical retries retain it. The unchanged packet digest covers the complete packet, including immutable hypothesis and TrialEvidence snapshots. Envelope validation rejects unknown keys/version, non-ISO time, noncanonical bytes, oversized files and incorrect filename/project identity. Packet validation recomputes the digest and validates all snapshot/ref identities, schemas, ordering, disposition and diversity. Files are bounded to the packet's 128KiB limit plus 256 bytes of envelope overhead; namespace capacity is 4096 artifacts. Full history is validated under the publication lock; corruption or capacity blocks new publication without deletion. Identical retries remain legal at capacity.

## Publication transaction

Canonical packet bytes are detached and deeply frozen before any await. A namespace-scoped `FileGlobalWriterLock` covers history validation, immutable input re-resolution and unique publication. Injected readers are the same trusted exact immutable interfaces as R4-B (production consumers can use `immutableHypothesisReader(FileDiscoveryHypothesisStore)` and `FileTrialEvidenceV2Store`). Publication re-resolves the exact v2 hypothesis and every selected TrialEvidence v2 entry, including exclusions, and compares their complete canonical snapshots. Batch evidence lookup is preferred when available. No live Experience, raw comparison/source or current Strategy projection is consulted. Schema validation alone is not source provenance.

Write an exclusive temporary file inside `writer.lock/`, sync and close it, verify the written bytes, then check abort/stale authority immediately before a synchronous exclusive hard link to the final UUID filename. Sync the namespace directory after that commit frontier. Never rename over an existing artifact. Same UUID and canonical packet bytes converge; different content fails closed even if validly re-fingerprinted. Existing bytes and timestamp never change. The optional abort signal/current-authority predicate fence publication, not packet identity; future production wiring must supply actual fresh authority.

Failure/death before linking leaves no visible artifact; owned/dead-owner lock cleanup handles temporary files using the existing lock rules. Failure/death after linking can return no acknowledgement despite a valid committed artifact; exact lookup and identical retry reconcile it without a second identity. Ambiguous locks are not stolen. This is filesystem transaction/crash recovery, not job scheduling or power-loss guarantees beyond the filesystem's sync semantics.

## Exact lookup and lifecycle metadata

`get` returns a detached deeply frozen packet only after strict stored-artifact validation and exact family/schema/project/UUID/fingerprint binding. Missing, malformed, unknown-version or mismatched artifacts throw; no repair or fallback namespace lookup. `exists` returns false only for a genuinely missing exact artifact; corruption, invalid refs and digest conflicts throw. Lookup validates the frozen snapshots without re-reading their original stores, so durable inputs remain usable independently of future source lifecycle. Publication, including retries, still revalidates immutable source provenance.

`validate` returns frozen metadata: `createdAt`, exact `packetRef` (identity/scope/fingerprint), UTF-8 `artifactSize` and total `referencedEvidenceCount` (included plus excluded). Metadata does not confer evaluation/trust eligibility. No retention/deletion is implemented; current retention behavior is unchanged.

## Verification and subsequent execution boundary

Tests cover deterministic round-trip/freezing, metadata and idempotent timestamp, conflicts, exact absence/wrong refs, strict envelope/packet corruption, independently rehashed hypothesis/evidence identity tampering, size/capacity, immutable source/batch rejection, abort/stale barriers, concurrent identical/conflicting writers and real process death on both sides of the link frontier with dead-owner recovery.

The approved bounded [R4-C2](autonomous-learning-r4-c2.md) implements only standalone immutable EvaluationRun records and lifecycle management, superseding the earlier broader R4-C2 scope described here. R4-C3 still requires separately approved production integration: durable job/attempt/input/output retry binding and reconciliation, fresh runtime lease/authority fencing, isolated native Pi evaluator and bounded actual model provenance/execution, immutable EvaluationResult publication and exact packet/result binding, operational capacity/retention protection. None is implied by these stores. Result recommendations must remain observational; Trust/Decision/Strategy/Policy mutation and promotion are separate later boundaries.
