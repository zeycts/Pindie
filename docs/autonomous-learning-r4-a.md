# Autonomous Learning v1 R4-A — Evaluation foundation

Status: contracts and contract tests only. No Evaluation runtime, enqueue hook, model Run, artifact writer, retention change or trust integration is implemented. This refines the future Evaluation direction in `autonomous-learning-v1.md`; R3 production behavior is unchanged.

## Authority and inspected baseline

R3 (#246, merged) publishes immutable `TrialEvidenceV2` in project-local `learning-v1/trial-evidence-v2/`. Its schema-1 `LearningArtifactRef` binds family, project scope, UUID and canonical `sha256:` content fingerprint; lookup must resolve v2, not the frozen v1 shell. `learningArtifactFingerprint` excludes only the fingerprint field. Hypotheses instead have semantic fingerprints excluding ID/provenance, so exact refs must also match UUID and scope.

R3's `FileGlobalWriterLock({ baseDir: artifactDirectory })` protects history validation and publication. Canonical bytes are frozen before await; a temporary file inside `writer.lock/` is exclusively created and uniquely linked to the final filename. Exact retries reuse identity; conflicting bytes, malformed/full history and stale authority fail closed. The lock name does not imply global scope: its explicit base directory determines scope. Dead-owner reclamation validates ownership; ambiguous locks are not stolen.

R3 retains raw comparison Experience refs, **not comparison snapshots**. Its source may already have expired after materialization. Evaluation must not load source, comparison or hypothesis discovery-source Experience, even if still present. Those nested refs are historical provenance, not Evaluation inputs or proof of comparison outcomes.

## Boundary

Evaluation is observational analysis of immutable factual TrialEvidence. It asserts neither delivery/attention nor causal use, effectiveness or superiority. Harness validates identity and deterministic packet facts; a future model interprets observational support, contradictions and limitations. No recommendation changes Trust, Decision, Policy, open lineage, Task, assignment counts or scheduler state. No score/reward or hidden reasoning is stored.

R4-A introduces **EvaluationPacket v1** and **EvaluationResult v1**, separate from F1's frozen `StrategyEvaluation` shell. Their dedicated exact ref families (`evaluation-packet`, `evaluation-result`) are intentionally not `LearningArtifactFamily`; neither is a StrategyDecision input or LearningJob terminal output. Do not reinterpret old artifacts, broaden frozen matchers, or wire a conversion to trust. Four result verdicts are recommendations only: `promote | continue-testing | revise | reject`. Even `promote` is not a sufficiency certificate; `revise` does not enqueue Discovery.

## EvaluationPacket v1

Exact fields (unknown keys rejected):

- `schemaVersion: 1`, UUID-v4 `id`, canonical content `fingerprint`, project-only `scope`.
- `gateVersion: 1`, `analysisMode: "observational"`.
- `hypothesis`: exact schema-1 StrategyHypothesis ref; `hypothesisSnapshot`: fully validated executable immutable v2 hypothesis matching that ref and scope. Expected effect, failure signals and advisory semantics are already in this snapshot; do not independently copy or reinterpret them.
- `trials`: 1–32 ordered entries `{ handle, ref, snapshot, disposition }`. Handles are exactly `T1`…`Tn` in array order. Ref is schema-1 trial-evidence; snapshot is full strict TrialEvidence v2 matching ID, fingerprint and project. Entries are ordered by UUID, duplicate IDs are forbidden even with different fingerprints.
- `disposition`: `included` when the snapshot hypothesis exactly equals the packet hypothesis, otherwise `excluded-hypothesis`. Gate v1 is an identity gate only, not temporal, diversity, safety or promotion sufficiency. Missing/corrupt/v1 evidence fails the packet, never becomes an invented excluded observation. At least one included entry is required.
- `diversity`: `{ workEpisodeCount, projectCount }`, recomputed from included entries only. Multiple Runs from one WorkEpisode do not become independent trials; projectCount is exactly 1. These counts do not establish independence from confounding or any minimum promotion gate.
- `comparisonStatus: "unavailable"`: no immutable comparison facts are materialized by R3. Nested comparison refs cannot be treated as observations or dereferenced. No A/B claim or fabricated baseline is permitted.

The packet is bounded to 128KiB canonical UTF-8 bytes, including snapshots, not merely entry count. Factual counters/outcome/verification/error/duration/cost are carried verbatim in each TrialEvidence snapshot. Duration/cost describe whole Runs, counters describe post-declaration work; do not attribute whole-Run cost or Task outcome to the Strategy. No aggregate effect metric is invented. Current trust/lineage snapshots, exclusion windows and sufficiency policies are deliberately deferred to a later versioned design; gate v1 cannot authorize promotion.

The [R4-B builder foundation](autonomous-learning-r4-b.md) now accepts only exact immutable TrialEvidence refs and resolves them with `FileTrialEvidenceV2Store.readExactMany` (or `readExact` for readers without batch lookup), plus an exact immutable hypothesis for semantic context. It never accepts a live Experience reader. Frozen snapshots are copied into the packet once exact lookup passes. A standalone schema validator checks internal consistency, not filesystem provenance; publication must perform exact immutable resolution. The future model receives only this frozen bounded packet, never the Human transcript or live stores.

## EvaluationResult v1

Exact fields:

- `schemaVersion: 1`, UUID-v4 `id`, canonical content `fingerprint`, project-only `scope`.
- `packet`: dedicated exact EvaluationPacket ref, binding schema, family, scope, UUID and digest.
- `hypothesis`: exact target ref; `gateVersion: 1`, `analysisMode: "observational"`.
- `verdict`: one of the four recommendation values above.
- `rationale`: non-empty bounded observational explanation, <=1024 characters.
- `limitations`: 1–8 non-empty strings, each <=512 characters. Future model must explicitly discuss confounding, heterogeneity, absent comparison and weak support as applicable. This is concise analysis, not hidden reasoning. Strings cannot deterministically prove absence of causal claims; later runtime instructions/review must preserve this semantic boundary.
- `citedHandles`: 1–16 unique `Tn` handles. Binding validation requires each to name an included packet entry; excluded entries cannot support a verdict.

Canonical result size <=16KiB. Standalone validation checks shape/digest; `matchesEvaluationResultPacket` additionally validates the complete packet, exact packet/hypothesis/scope/gate identity and citation membership. A valid digest alone proves neither provenance nor semantic correctness. No model identity/job key is invented in this foundation; future execution must separately design immutable operational provenance and retries before production publication.

## Reserved storage and future publication (not implemented)

Reserve project-local `learning-v1/evaluation-packets-v1/<UUID>.json` and `learning-v1/evaluation-results-v1/<UUID>.json`. Dedicated schema-1 refs include their family and project scope, with exact canonical persisted-content digest. No lookup may fall through to `strategy-evaluation`, v1 TrialEvidence, live Experience or a different version namespace.

Future stores must freeze canonical validated bytes before I/O, enforce size/capacity bounds and use `FileGlobalWriterLock` at the namespace directory plus atomic unique creation, following R3. Under lock revalidate exact refs and publication authority; identical retries preserve the same ID/bytes, conflicting retries fail closed. Durable job-to-output identity, capacity limits, cross-store crash reconciliation, result model provenance and retention protection must be approved before runtime implementation. Packet/result history must not be pruned opportunistically; this slice creates no stored artifacts and changes no retention behavior.

## Contract acceptance

Pure tests cover valid packets/results, strict fields/digests/bounds, v1 evidence rejection, exact snapshot/ref/hypothesis bindings, disposition, ordering/deduplication, included-only episode counts and citations, absent comparison semantics and dedicated ref separation from frozen trust/job contracts. No filesystem writer, scheduler, Host/extension wiring, model invocation, Decision or Policy mutation belongs to R4-A.
