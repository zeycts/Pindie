import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LEARNING_BUDGET_POLICY, FINGERPRINT, validateLearningBudgetPolicy, learningJobKey, validateStrategyHypothesis, validateWorkEpisodeBinding, validateExactEvidenceRef, validateDiscoveryReceipt, validateTrialAssignment, validateTrialEvidence, validateStrategyEvaluation, validateStrategyDecision, learningArtifactFingerprint, hypothesisFingerprint, validateLearningArtifactRef, matchesLearningArtifactRef, matchesTrialEvidenceAssignment, matchesEvaluationTrial, matchesDecisionEvaluation, validateLearningTerminalOutput } from "../src/learning-v1-contract.ts";

test("F1 hypothesis contract rejects authority-bearing fields and fingerprint drift", () => {
  const semantic = { schemaVersion: 1, scope: { kind: "user-global" }, logicalId: "focus", kind: "approach",
    lineage: "new", parent: null, baseRevisionFingerprint: null, summary: "Focus on evidence",
    useWhen: ["Evidence exists"], avoidWhen: ["No evidence"], expectedEffect: "Fewer regressions",
    failureSignals: ["More regressions"], trialHints: [],
    sources: [{ projectId: "a".repeat(64), recordId: "00000000-0000-4000-8000-000000000000.json", fingerprint: `sha256:${"b".repeat(64)}` }],
    discoveryPacketFingerprint: `sha256:${"c".repeat(64)}` };
  const hypothesis = { ...semantic, id: "00000000-0000-4000-8000-000000000000", fingerprint: hypothesisFingerprint(semantic as Parameters<typeof hypothesisFingerprint>[0]) };
  assert.equal(hypothesis.fingerprint, "sha256:2ca67d281c20cf1afefd6e98fe3fba20f91e8cbef8f27f3d2f023dbe066212e1"); // frozen pre-R1 canonical identity
  assert.equal(validateStrategyHypothesis(hypothesis), true);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, principles: ["Not a v1 field"] }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, capability: "task.complete" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, expectedEffect: "" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, fingerprint: `sha256:${"d".repeat(64)}` }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, parent: { schemaVersion: 1, family: "strategy-hypothesis", scope: semantic.scope, id: hypothesis.id, fingerprint: `sha256:${"b".repeat(64)}` } }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, baseRevisionFingerprint: `sha256:${"b".repeat(64)}` }), false);
  const revision = { ...hypothesis, lineage: "revise", parent: { schemaVersion: 1, family: "strategy-hypothesis", scope: semantic.scope, id: "11111111-1111-4111-8111-111111111111", fingerprint: `sha256:${"b".repeat(64)}` } };
  assert.equal(validateStrategyHypothesis({ ...revision, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(revision) as Parameters<typeof hypothesisFingerprint>[0]) }), true);
  const trustedRevision = { ...hypothesis, lineage: "revise", parent: null, baseRevisionFingerprint: `sha256:${"e".repeat(64)}` };
  assert.equal(validateStrategyHypothesis({ ...trustedRevision, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(trustedRevision) as Parameters<typeof hypothesisFingerprint>[0]) }), true);
  const unanchored = { ...hypothesis, lineage: "revise", parent: null, baseRevisionFingerprint: null };
  assert.equal(validateStrategyHypothesis({ ...unanchored, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(unanchored) as Parameters<typeof hypothesisFingerprint>[0]) }), false);
});
test("F1 all frozen artifact shells reject extra fields, malformed IDs and inconsistent relations", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const other = "11111111-1111-4111-8111-111111111111";
  const fp = `sha256:${"a".repeat(64)}`;
  const projectId = "a".repeat(64);
  const ref = { projectId, recordId: `${id}.json`, fingerprint: fp };
  assert.equal(validateExactEvidenceRef(ref), true);
  assert.equal(validateExactEvidenceRef({ ...ref, recordId: id }), false);
  assert.equal(validateExactEvidenceRef({ ...ref, fingerprint: "a".repeat(64) }), false);
  const binding = { schemaVersion: 1, projectId, episodeId: id, observedStateFingerprint: fp,
    openedAt: "2026-01-01T00:00:00.000Z", closedAt: null };
  assert.equal(validateWorkEpisodeBinding(binding), true);
  assert.equal(validateWorkEpisodeBinding({ ...binding, invented: true }), false);
  assert.equal(validateWorkEpisodeBinding({ ...binding, closedAt: "2025-01-01T00:00:00.000Z" }), false);
  const scope = { kind: "project" as const, projectId };
  const hyp = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope, id: other, fingerprint: fp };
  const seal = <T extends Record<string, unknown>>(content: T) => ({ ...content, fingerprint: learningArtifactFingerprint(content) });
  const receipt = seal({ schemaVersion: 1, id, jobKey: fp, packetFingerprint: fp, scope, outcome: "none", hypotheses: [], sources: [{ ...ref, recordedAt: "2026-01-01T00:00:00.000Z" }] });
  assert.equal(validateDiscoveryReceipt(receipt), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "published" })), false);
  const published = seal({ ...receipt, outcome: "published", hypotheses: [hyp] });
  assert.equal(validateDiscoveryReceipt(published), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...published, hypotheses: [{ ...hyp, scope: { kind: "user-global" } }] })), false);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "covered", hypotheses: [hyp] })), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "covered", hypotheses: [] })), false);
  assert.equal(validateDiscoveryReceipt({ ...receipt, id: "arbitrary" }), false);
  const assignment = seal({ schemaVersion: 1, id, projectId, workEpisodeId: other, sessionId: "session",
    hypothesis: hyp, comparison: [ref], offerPolicyFingerprint: fp, offerPolicyVersion: 1,
    hostId: id, authorityGeneration: 1, createdAt: 1, expiresAt: 100, status: "untrusted-advisory" });
  const assignmentRef = { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id, fingerprint: assignment.fingerprint };
  assert.equal(validateTrialAssignment(assignment), true);
  assert.equal(validateTrialAssignment(seal({ ...assignment, comparison: [{ ...ref, projectId: "b".repeat(64) }] })), false);
  assert.equal(validateLearningArtifactRef(assignmentRef), true);
  assert.equal(validateLearningArtifactRef({ ...assignmentRef, scope: { kind: "user-global" } }), false);
  assert.equal(matchesLearningArtifactRef(assignmentRef, assignment), true);
  assert.equal(matchesLearningArtifactRef({ ...assignmentRef, fingerprint: fp }, assignment), false);
  assert.equal(validateTrialAssignment({ ...assignment, permission: "task.complete" }), false);
  assert.equal(validateTrialAssignment({ ...assignment, expiresAt: 101 }), false); // exact content changed
  assert.notEqual(learningArtifactFingerprint({ ...assignment, expiresAt: 101 }), assignment.fingerprint);
  const evidence = seal({ schemaVersion: 1, id, assignment: assignmentRef, hypothesis: hyp, source: ref,
    workEpisodeId: other, exposed: true, eligible: true, eligibilityReason: "verified",
    outcome: "passed", regressions: [], comparison: [] });
  const evidenceRef = { schemaVersion: 1 as const, family: "trial-evidence" as const, scope, id, fingerprint: evidence.fingerprint };
  assert.equal(validateTrialEvidence(evidence), true);
  assert.equal(validateLearningArtifactRef({ ...evidenceRef, scope: { kind: "user-global" } }), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, assignment: { ...assignmentRef, scope: { kind: "user-global" } } })), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, comparison: [{ ...ref, projectId: "b".repeat(64) }] })), false);
  assert.equal(matchesTrialEvidenceAssignment(evidence, assignment), true);
  assert.equal(matchesTrialEvidenceAssignment(seal({ ...evidence, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), assignment), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, exposed: false })), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, assignment: { ...assignmentRef, family: "strategy-evaluation" } })), false);
  const evaluation = seal({ schemaVersion: 1, id, hypothesis: hyp, packetFingerprint: fp,
    gateVersion: 1, trialEvidence: [evidenceRef], verdict: "continue-testing", rationale: "not enough data", citedHandles: ["E1"] });
  const evaluationRef = { schemaVersion: 1 as const, family: "strategy-evaluation" as const, scope, id, fingerprint: evaluation.fingerprint };
  assert.equal(validateStrategyEvaluation(evaluation), true);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, scope: { kind: "project", projectId: "b".repeat(64) } }] })), false);
  const globalHyp = { ...hyp, scope: { kind: "user-global" as const } };
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, hypothesis: globalHyp,
    trialEvidence: [evidenceRef, { ...evidenceRef, scope: { kind: "project", projectId: "b".repeat(64) } }] })), true);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, hypothesis: globalHyp,
    trialEvidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(matchesEvaluationTrial(evaluation, evidence), true);
  assert.equal(matchesEvaluationTrial(seal({ ...evaluation, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), evidence), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, verdict: "suspend" })), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, fingerprint: "bad" }] })), false);
  const decision = seal({ schemaVersion: 1, id, scope, action: "promote", actor: "autonomous", hypothesis: hyp,
    evaluation: evaluationRef, evidence: [evidenceRef], supersedes: null, decidedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(validateStrategyDecision(decision), true);
  assert.equal(validateStrategyDecision(seal({ ...decision, evaluation: { ...evaluationRef, scope: { kind: "user-global" } } })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, scope: globalHyp.scope, hypothesis: globalHyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, evidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(matchesDecisionEvaluation(decision, evaluation), false); // continue-testing cannot promote
  const promoting = seal({ ...evaluation, verdict: "promote" });
  assert.equal(matchesDecisionEvaluation(seal({ ...decision, evaluation: { ...evaluationRef, fingerprint: promoting.fingerprint } }), promoting), true);
  assert.equal(matchesDecisionEvaluation(seal({ ...decision, evaluation: { ...evaluationRef, fingerprint: promoting.fingerprint }, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), promoting), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, evaluation: null })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "reject", supersedes: hyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, supersedes: hyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "suspend", evaluation: evaluationRef })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "suspend", evaluation: null,
    evidence: [{ schemaVersion: 1, family: "terminal-output", scope, id: other, fingerprint: fp }] })), true);
  assert.equal(validateStrategyDecision({ ...decision, actor: "human" }), false); // self-fingerprint binds every field
  assert.equal(matchesLearningArtifactRef({ schemaVersion: 1, family: "strategy-decision", scope, id, fingerprint: decision.fingerprint }, decision), true);
  const terminal = seal({ schemaVersion: 1, id, scope, jobKey: fp, state: "cancelled", stopReason: "budget" });
  assert.equal(validateLearningTerminalOutput(terminal), true);
  assert.equal(matchesLearningArtifactRef({ schemaVersion: 1, family: "terminal-output", scope, id, fingerprint: terminal.fingerprint }, terminal), true);
  assert.equal(validateLearningTerminalOutput(seal({ ...terminal, state: "completed" })), false);
});
test("F1 budget validates bounded positive policy", () => {
  assert.equal(validateLearningBudgetPolicy(DEFAULT_LEARNING_BUDGET_POLICY), true);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, maxAttempts: 0 }), false);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, perJobTokenCap: 30_000 }), false);
  assert.match(learningJobKey("evaluation", { kind: "user-global" }, `sha256:${"a".repeat(64)}`, 1), FINGERPRINT);
});
