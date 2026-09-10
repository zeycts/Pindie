import assert from "node:assert/strict";
import test from "node:test";

import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import {
  createTrustedStrategyPortfolioForProjectId,
} from "../src/strategy-portfolio.ts";
import { getProjectId } from "../src/store.ts";
import {
  buildSynthesisTrialPacket,
  createSynthesisTrialBinding,
  filterSynthesisTrialCommandOptions,
  formatSynthesisTrialCommandLabel,
  formatSynthesisTrialPacket,
  listOpenSynthesisTrialCandidates,
  parseSynthesisTrialCommandValue,
  revalidateSynthesisTrialBinding,
  resolveSynthesisTrialBinding,
  sameSynthesisTrialBinding,
  strategyRevisionSelectionFromSynthesisTrial,
  synthesisTrialCommandValue,
} from "../src/strategy-synthesis-trial.ts";
import {
  TrialRuntime,
  type SynthesisTrialCandidateSnapshot,
} from "../src/strategy-trial.ts";
import {
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
} from "../src/strategy-synthesis-candidates.ts";
import { createStrategySynthesisDecision } from "../src/strategy-synthesis-decisions.ts";
import { makeSynthesisTrialFixture } from "./synthesis-trial-fixture.ts";

const TARGET_ROOT = "/synthesis-trial-target";
const TARGET_PROJECT_ID = getProjectId(TARGET_ROOT);
const OTHER_PROJECT_ID = getProjectId("/synthesis-trial-other");
const EMPTY_PORTFOLIO = createTrustedStrategyPortfolioForProjectId(
  TARGET_PROJECT_ID,
  createPromotedStrategyRevisionCatalog([]),
);

function candidateReader(
  candidate: Awaited<ReturnType<typeof makeSynthesisTrialFixture>>["candidate"],
) {
  return {
    read: async (candidateId: string) => candidateId === candidate.candidateId ? candidate : null,
    readAll: async () => [candidate],
  };
}

function assertNarrowSynthesisTrialCandidate(
  snapshot: SynthesisTrialCandidateSnapshot,
  candidate: Awaited<ReturnType<typeof makeSynthesisTrialFixture>>["candidate"],
): void {
  assert.deepEqual(snapshot, {
    candidateId: candidate.candidateId,
    createdAt: candidate.createdAt,
    proposal: {
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      summary: candidate.proposal.summary,
      useWhen: candidate.proposal.useWhen,
      avoidWhen: candidate.proposal.avoidWhen,
      principles: candidate.proposal.principles,
    },
    hypothesis: candidate.hypothesis,
  });
  assert.notEqual(snapshot, candidate);
  assert.notEqual(snapshot.proposal, candidate.proposal);
  assert.deepEqual(Object.keys(snapshot).sort(), ["candidateId", "createdAt", "hypothesis", "proposal"]);
  for (const field of ["schemaVersion", "candidateType", "evidence", "derivationReceipt"]) {
    assert.equal(field in (snapshot as unknown as Record<string, unknown>), false, field);
  }
}

function conflictingPortfolio(
  candidate: Awaited<ReturnType<typeof makeSynthesisTrialFixture>>["candidate"],
) {
  const selection = createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: "99999999-9999-4999-8999-999999999999",
    revisionFingerprint: `sha256:${"9".repeat(64)}`,
    revisionStatusAtRun: "promoted",
    semantics: {
      summary: "A separately trusted revision occupies this logical identity.",
      useWhen: ["the target already trusts this logical Strategy"],
      avoidWhen: ["the identity is unoccupied"],
      principles: ["never choose between conflicting logical identities"],
    },
  });
  return createTrustedStrategyPortfolioForProjectId(
    TARGET_PROJECT_ID,
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    [{ sourceProjectId: OTHER_PROJECT_ID, selection }],
  );
}

test("Synthesis Trial namespace, packet, selector, and completion are exact and bounded", async () => {
  const { candidate, packet } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-00000000003a");
  const binding = createSynthesisTrialBinding(candidate, TARGET_ROOT, EMPTY_PORTFOLIO);
  const value = synthesisTrialCommandValue(candidate.candidateId);

  assert.equal(parseSynthesisTrialCommandValue(value), candidate.candidateId);
  assert.equal(parseSynthesisTrialCommandValue(candidate.candidateId), null);
  assert.throws(
    () => parseSynthesisTrialCommandValue(`synthesis:${candidate.candidateId.toUpperCase()}`),
    /canonical lowercase UUID-v4/i,
  );
  assert.equal(binding.targetProjectId, TARGET_PROJECT_ID);
  assert.equal(binding.candidateSemanticFingerprint, packetFingerprint(candidate));
  assert.equal(binding.revisionSelection.revisionIdentity, candidate.candidateId);
  assert.equal(binding.revisionSelection.revisionStatusAtRun, "trial");
  assert.deepEqual(binding.revisionSelection.semantics, {
    summary: candidate.proposal.summary,
    useWhen: candidate.proposal.useWhen,
    avoidWhen: candidate.proposal.avoidWhen,
    principles: candidate.proposal.principles,
  });

  const rebuiltPacket = buildSynthesisTrialPacket({ candidate, targetProjectId: TARGET_PROJECT_ID });
  assert.deepEqual(binding.packet, rebuiltPacket);
  assert.equal(binding.renderedPacket, formatSynthesisTrialPacket(rebuiltPacket));
  assert.match(binding.renderedPacket, /inactive hypothesis|exact proposed revision/i);
  assert.doesNotMatch(binding.renderedPacket, /sourceRefs|recordFingerprint/i);

  const projection = await listOpenSynthesisTrialCandidates({
    targetProjectRoot: TARGET_ROOT,
    targetPortfolio: EMPTY_PORTFOLIO,
    candidateReader: candidateReader(candidate),
  });
  assert.equal(projection.entries.length, 1);
  assert.equal(projection.entries[0]?.binding.candidate.candidateId, candidate.candidateId);
  assert.deepEqual(filterSynthesisTrialCommandOptions(projection.entries, "synthesis:"), [{
    value,
    label: formatSynthesisTrialCommandLabel(candidate),
  }]);
});

test("Synthesis Trial admission revalidates target logical identity and detects Candidate races", async () => {
  const first = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000032");
  const resolved = await resolveSynthesisTrialBinding({
    candidateId: first.candidate.candidateId,
    targetProjectRoot: TARGET_ROOT,
    targetPortfolio: EMPTY_PORTFOLIO,
    candidateReader: candidateReader(first.candidate),
  });
  assert.equal(sameSynthesisTrialBinding(resolved, createSynthesisTrialBinding(first.candidate, TARGET_ROOT, EMPTY_PORTFOLIO)), true);

  const changed = await makeSynthesisTrialFixture(first.candidate.candidateId, {
    summary: "The Candidate changed between two authority reads.",
  });
  const changedBinding = await revalidateSynthesisTrialBinding(
    resolved,
    EMPTY_PORTFOLIO,
    candidateReader(changed.candidate),
  );
  assert.equal(sameSynthesisTrialBinding(resolved, changedBinding), false);

  await assert.rejects(
    resolveSynthesisTrialBinding({
      candidateId: first.candidate.candidateId,
      targetProjectRoot: TARGET_ROOT,
      targetPortfolio: conflictingPortfolio(first.candidate),
      candidateReader: candidateReader(first.candidate),
    }),
    /already trusts this logical Strategy ID/i,
  );
});

test("terminal Synthesis Decisions close admission, completion, and active-selector revalidation", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000036");
  const terminal = createStrategySynthesisDecision({
    candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-02-06T00:00:00.000Z",
  });
  const decisionReader = {
    read: async (candidateId: string) => candidateId === candidate.candidateId ? terminal : null,
    readAll: async () => [terminal],
  };
  const reader = candidateReader(candidate);

  assert.equal((await listOpenSynthesisTrialCandidates({
    targetProjectRoot: TARGET_ROOT,
    targetPortfolio: EMPTY_PORTFOLIO,
    candidateReader: reader,
    decisionReader,
  })).entries.length, 0);
  await assert.rejects(
    resolveSynthesisTrialBinding({
      candidateId: candidate.candidateId,
      targetProjectRoot: TARGET_ROOT,
      targetPortfolio: EMPTY_PORTFOLIO,
      candidateReader: reader,
      decisionReader,
    }),
    /terminal rejected Decision/i,
  );
  const binding = createSynthesisTrialBinding(candidate, TARGET_ROOT, EMPTY_PORTFOLIO);
  await assert.rejects(
    revalidateSynthesisTrialBinding(binding, EMPTY_PORTFOLIO, reader, decisionReader),
    /terminal rejected Decision/i,
  );
});

test("Synthesis Trial uses the single runtime lease and resolves only the exact active revision", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000033");
  const binding = createSynthesisTrialBinding(candidate, TARGET_ROOT, EMPTY_PORTFOLIO);
  const runtime = new TrialRuntime();

  assert.equal(runtime.establishSynthesis("session-a", binding), true);
  assert.equal(runtime.establishSynthesis("session-a", binding), false);
  const pending = runtime.pendingSynthesisTrial;
  assert.ok(pending);
  assertNarrowSynthesisTrialCandidate(pending.candidate, candidate);
  assert.equal(pending.candidateSemanticFingerprint, strategySynthesisCandidateSemanticFingerprint(candidate));
  assert.equal(pending.candidateArtifactFingerprint, strategySynthesisCandidateArtifactFingerprint(candidate));
  assert.equal(runtime.pendingTrial, null);
  assert.equal(runtime.bindSynthesis("session-b", 1), null);

  const active = runtime.bindSynthesis("session-a", 1);
  assert.ok(active);
  assert.equal(runtime.hasActiveSynthesisTrial, true);
  assertNarrowSynthesisTrialCandidate(active.candidate, candidate);
  assert.equal(active.candidateSemanticFingerprint, strategySynthesisCandidateSemanticFingerprint(candidate));
  assert.equal(active.candidateArtifactFingerprint, strategySynthesisCandidateArtifactFingerprint(candidate));
  assert.equal(runtime.activeSynthesisFor("session-a", 1)?.candidate.candidateId, candidate.candidateId);
  const selector = {
    strategyId: active.revisionSelection.strategyId,
    revisionIdentity: active.revisionSelection.revisionIdentity,
    revisionFingerprint: active.revisionSelection.revisionFingerprint,
  };
  const resolved = runtime.resolveSynthesisSelector("session-a", 1, selector, "approach", active.candidate);
  assert.equal(resolved.revisionIdentity, candidate.candidateId);
  assert.equal(resolved.revisionStatusAtRun, "trial");
  assert.deepEqual(resolved.semantics, {
    summary: candidate.proposal.summary,
    useWhen: candidate.proposal.useWhen,
    avoidWhen: candidate.proposal.avoidWhen,
    principles: candidate.proposal.principles,
  });
  assert.throws(
    () => runtime.resolveSynthesisSelector("session-a", 1, selector, "modifier", active.candidate),
    /wrong.*modifier|role/i,
  );
  assert.throws(
    () => runtime.resolveSynthesisSelector("session-a", 2, selector, "approach", active.candidate),
    /without an active Synthesis Trial/i,
  );
  assert.throws(
    () => runtime.resolveSynthesisSelector(
      "session-a",
      1,
      { ...selector, revisionIdentity: "00000000-0000-4000-8000-000000000034" },
      "approach",
      active.candidate,
    ),
    /does not match/i,
  );
  assert.throws(
    () => runtime.resolveSynthesisSelector(
      "session-a",
      1,
      { ...selector, revisionFingerprint: `sha256:${"f".repeat(64)}` },
      "approach",
      active.candidate,
    ),
    /does not match/i,
  );
  assert.throws(
    () => runtime.resolveSynthesisSelector(
      "session-a",
      1,
      selector,
      "approach",
      { ...active.candidate, proposal: { ...active.candidate.proposal, summary: "changed" } },
    ),
    /artifact changed/i,
  );
  runtime.clear();
  assert.throws(
    () => runtime.resolveSynthesisSelector("session-a", 1, selector, "approach", active.candidate),
    /without an active Synthesis Trial/i,
  );
});

function packetFingerprint(
  candidate: Awaited<ReturnType<typeof makeSynthesisTrialFixture>>["candidate"],
): string {
  return strategyRevisionSelectionFromSynthesisTrial(candidate).revisionFingerprint;
}
