import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPolicySnapshot,
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import {
  createPromotedStrategyRevisionCatalog,
  createStrategyRevisionDecision,
  FileStrategyDecisionStore,
  formatPromotedStrategyRevisionCatalog,
  loadPromotedStrategyRevisionCatalog,
  validateStrategyRevisionDecisionArtifact,
  validateStrategyRevisionDecisionBinding,
  type StrategyRevisionDecision,
} from "../src/strategy-decisions.ts";
import {
  createStrategyRevisionCandidate,
  strategyCandidateSemanticFingerprint,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import { getSeedStrategy, seedStrategyFingerprint } from "../src/strategies.ts";

const APPROACH_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_APPROACH_ID = "00000000-0000-4000-8000-000000000002";
const MODIFIER_ID = "00000000-0000-4000-8000-000000000003";

function candidate(
  candidateId = APPROACH_ID,
  targetId = "architecture-first",
): StrategyRevisionCandidate {
  return createStrategyRevisionCandidate({
    target: getSeedStrategy(targetId)!,
    candidateId,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: `Use a bounded revision for ${targetId}.`,
      useWhen: ["the current evidence identifies a bounded interface"],
      avoidWhen: ["the correction is already local and clear"],
      principles: ["preserve the boundary", "verify the focused change"],
      sourceRecordIds: ["adapt-one", "adapt-two"],
      hypothesis: "A bounded revision may reduce avoidable rework.",
    },
  });
}

function decision(
  selectedCandidate: StrategyRevisionCandidate,
  terminal: "promoted" | "rejected" = "promoted",
  trialRecordIds = ["trial-one", "trial-two"],
): StrategyRevisionDecision {
  return createStrategyRevisionDecision({
    candidate: selectedCandidate,
    decision: terminal,
    trialRecordIds,
    decidedAt: "2026-02-01T00:00:00.000Z",
  });
}

function readers(
  candidates: readonly StrategyRevisionCandidate[],
  decisions: readonly StrategyRevisionDecision[],
) {
  const candidatesById = new Map(candidates.map((value) => [value.candidateId, value]));
  const decisionsById = new Map(decisions.map((value) => [value.candidateId, value]));
  return {
    decisionReader: {
      read: async (_root: string, candidateId: string) => decisionsById.get(candidateId) ?? null,
      readAll: async () => decisions,
    },
    candidateReader: {
      read: async (_root: string, candidateId: string) => candidatesById.get(candidateId) ?? null,
    },
  };
}

test("valid promoted and rejected Decisions are immutable, bound, and preserve cited Trial IDs", () => {
  const selectedCandidate = candidate();
  const promoted = decision(selectedCandidate);
  const rejected = decision(selectedCandidate, "rejected", ["trial-one"]);

  assert.deepEqual(promoted, {
    schemaVersion: 1,
    candidateId: APPROACH_ID,
    candidateFingerprint: strategyCandidateSemanticFingerprint(selectedCandidate),
    decidedAt: "2026-02-01T00:00:00.000Z",
    target: {
      strategyId: "architecture-first",
      kind: "approach",
      baseFingerprint: seedStrategyFingerprint(getSeedStrategy("architecture-first")!),
    },
    decision: "promoted",
    evidence: { trialRecordIds: ["trial-one", "trial-two"] },
  });
  assert.equal(Object.isFrozen(promoted), true);
  assert.equal(Object.isFrozen(promoted.target), true);
  assert.equal(Object.isFrozen(promoted.evidence), true);
  assert.equal(Object.isFrozen(promoted.evidence.trialRecordIds), true);
  assert.equal(rejected.decision, "rejected");
  assert.deepEqual(rejected.evidence.trialRecordIds, ["trial-one"]);
  assert.equal("status" in selectedCandidate, false);
  assert.doesNotThrow(() => validateStrategyRevisionDecisionBinding(promoted, selectedCandidate));
});

test("Decision binding rejects wrong Candidate UUID, fingerprint, role, or Seed base", () => {
  const selectedCandidate = candidate();
  const promoted = decision(selectedCandidate);

  assert.throws(
    () => validateStrategyRevisionDecisionArtifact({ ...promoted, candidateId: OTHER_APPROACH_ID }, APPROACH_ID),
    /requested Candidate ID/i,
  );
  assert.throws(
    () => validateStrategyRevisionDecisionBinding({
      ...promoted,
      candidateFingerprint: `sha256:${"0".repeat(64)}`,
    }, selectedCandidate),
    /fingerprint/i,
  );
  assert.throws(
    () => validateStrategyRevisionDecisionBinding({
      ...promoted,
      target: { ...promoted.target, kind: "modifier" },
    }, selectedCandidate),
    /role|target/i,
  );
  assert.throws(
    () => validateStrategyRevisionDecisionBinding({
      ...promoted,
      target: { ...promoted.target, baseFingerprint: `sha256:${"0".repeat(64)}` },
    }, selectedCandidate),
    /Seed base|fingerprint|target/i,
  );
});

test("file Decision storage is project-local, immutable, and rejects duplicate terminal writes", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-decisions-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyDecisionStore({ baseDir });
  const selectedCandidate = candidate();
  const promoted = decision(selectedCandidate);

  await store.save("/project", promoted);
  const path = join(store.strategyDecisionDirectory("/project"), `${APPROACH_ID}.json`);
  const before = await readFile(path, "utf8");
  await assert.rejects(
    store.save("/project", decision(selectedCandidate, "rejected")),
    /already exists|terminal Decision/i,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await store.readAll("/project"), [promoted]);
  assert.equal(await store.read("/other-project", APPROACH_ID), null);
});

test("promoted catalog exposes only validated promoted revisions and exact selectors", async () => {
  const promotedCandidate = candidate();
  const rejectedCandidate = candidate(OTHER_APPROACH_ID, "direct-action");
  const promoted = decision(promotedCandidate);
  const rejected = decision(rejectedCandidate, "rejected", ["trial-one"]);
  const { decisionReader, candidateReader } = readers(
    [promotedCandidate, rejectedCandidate],
    [promoted, rejected],
  );

  const catalog = await loadPromotedStrategyRevisionCatalog(
    "/project",
    decisionReader,
    candidateReader,
  );
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0]?.candidate.candidateId, APPROACH_ID);
  assert.equal(catalog.entries[0]?.selection.revisionStatusAtRun, "promoted");
  assert.deepEqual(catalog.entries[0]?.selection.semantics, promotedCandidate.proposal);
  const selector = {
    strategyId: "architecture-first",
    revisionIdentity: APPROACH_ID,
    revisionFingerprint: strategyCandidateSemanticFingerprint(promotedCandidate),
  };
  const resolved = catalog.resolve(selector, "approach");
  assert.equal(resolved.revisionStatusAtRun, "promoted");
  assert.deepEqual(resolved.semantics, promotedCandidate.proposal);
  assert.throws(() => catalog.resolve({ ...selector, revisionIdentity: OTHER_APPROACH_ID }, "approach"), /unavailable|wrong role/i);
  assert.throws(() => catalog.resolve(selector, "modifier"), /unavailable|wrong role/i);

  const rendered = formatPromotedStrategyRevisionCatalog(catalog);
  assert.match(rendered, /<PINDIE_PROMOTED_STRATEGIES>/);
  assert.match(rendered, /Revision status: promoted/);
  assert.match(rendered, /Use a bounded revision for architecture-first/);
  assert.doesNotMatch(rendered, new RegExp(rejectedCandidate.candidateId));
  assert.doesNotMatch(rendered, /direct-action/);
  assert.doesNotMatch(rendered, /hypothesis|trial-one/);
  assert.deepEqual(createPolicySnapshot({ approach: "architecture-first" }).approach.revisionIdentity, "seed");
});

test("duplicate/conflicting Decisions and a second promoted revision for one Seed fail closed", async () => {
  const firstCandidate = candidate();
  const secondSameTarget = candidate(OTHER_APPROACH_ID);
  const first = decision(firstCandidate);
  const second = decision(secondSameTarget);

  const duplicate = readers([firstCandidate], [first, { ...first }]);
  await assert.rejects(
    loadPromotedStrategyRevisionCatalog("/project", duplicate.decisionReader, duplicate.candidateReader),
    /duplicate|conflicting/i,
  );
  const conflicting = readers([firstCandidate, secondSameTarget], [first, second]);
  await assert.rejects(
    loadPromotedStrategyRevisionCatalog("/project", conflicting.decisionReader, conflicting.candidateReader),
    /same Seed Strategy|promoted Candidate/i,
  );

  const failedDecisionRead = readers([firstCandidate], [first]);
  failedDecisionRead.decisionReader.readAll = async () => { throw new Error("trust disk unavailable"); };
  await assert.rejects(
    loadPromotedStrategyRevisionCatalog("/project", failedDecisionRead.decisionReader, failedDecisionRead.candidateReader),
    /trust disk unavailable/i,
  );
  const missingCandidate = readers([], [first]);
  await assert.rejects(
    loadPromotedStrategyRevisionCatalog("/project", missingCandidate.decisionReader, missingCandidate.candidateReader),
    /missing.*Candidate/i,
  );
});

test("catalog rejects non-Harness promoted status or semantics and does not trust arbitrary selectors", () => {
  const selectedCandidate = candidate();
  const promoted = decision(selectedCandidate);
  const exact = createStrategyRevisionSelection({
    strategyId: selectedCandidate.target.strategyId,
    kind: selectedCandidate.target.kind,
    revisionIdentity: selectedCandidate.candidateId,
    revisionFingerprint: strategyCandidateSemanticFingerprint(selectedCandidate),
    revisionStatusAtRun: "trial",
    semantics: selectedCandidate.proposal,
  });
  assert.throws(
    () => createPromotedStrategyRevisionCatalog([{
      candidate: selectedCandidate,
      decision: promoted,
      selection: exact,
    }]),
    /Harness-derived|promoted/i,
  );
});
