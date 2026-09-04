import assert from "node:assert/strict";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStrategyRevisionCandidate,
  FileStrategyCandidateStore,
  formatCandidateCommandLabel,
  isCanonicalStrategyCandidateId,
  MAX_CANDIDATE_COMMAND_LABEL_LENGTH,
  strategyCandidateSemanticFingerprint,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotForRun,
  type StrategyRevisionSelector,
} from "../src/policy.ts";
import { getSeedStrategy, seedStrategyFingerprint } from "../src/strategies.ts";
import {
  buildTrialPacket,
  formatTrialPacket,
  TrialRuntime,
} from "../src/strategy-trial.ts";

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CANDIDATE_ID = "00000000-0000-4000-8000-000000000002";

function candidate(
  id = CANDIDATE_ID,
  targetId = "architecture-first",
): StrategyRevisionCandidate {
  const target = getSeedStrategy(targetId)!;
  return createStrategyRevisionCandidate({
    target,
    candidateId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
      sourceRecordIds: ["record-one", "record-two"],
      hypothesis: "A narrower boundary check may reduce avoidable rework.",
    },
  });
}

async function writeArtifact(
  store: FileStrategyCandidateStore,
  projectRoot: string,
  fileId: string,
  value: unknown,
): Promise<string> {
  const directory = store.strategyCandidateDirectory(projectRoot);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${fileId}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

test("Candidate reader reads exact immutable schema-v1 IDs and derives the approved fingerprint", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-trial-reader-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyCandidateStore({ baseDir });
  const original = candidate();
  await store.save("/project", original);
  const path = join(store.strategyCandidateDirectory("/project"), `${CANDIDATE_ID}.json`);
  const before = await readFile(path, "utf8");

  const read = await store.read("/project", CANDIDATE_ID);

  assert.deepEqual(read, original);
  assert.equal(read && strategyCandidateSemanticFingerprint(read), strategyCandidateSemanticFingerprint(original));
  assert.equal("fingerprint" in (read ?? {}), false);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(await store.read("/project", OTHER_CANDIDATE_ID), null);
});

test("Candidate reader enumerates only strict project-local immutable Candidates in deterministic order", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-candidate-enumeration-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyCandidateStore({ baseDir });
  const first = candidate(CANDIDATE_ID);
  const second = candidate(OTHER_CANDIDATE_ID, "direct-action");
  await store.save("/project", second);
  await store.save("/project", first);
  await store.save("/other-project", candidate("00000000-0000-4000-8000-000000000003"));
  const directory = store.strategyCandidateDirectory("/project");
  const firstPath = join(directory, `${CANDIDATE_ID}.json`);
  const before = await readFile(firstPath, "utf8");
  await writeFile(join(directory, "not-a-candidate.json"), JSON.stringify(first), "utf8");
  await mkdir(join(directory, "00000000-0000-4000-8000-000000000004.json"));

  const all = await store.readAll("/project");

  assert.deepEqual(all.map((value) => value.candidateId), [CANDIDATE_ID, OTHER_CANDIDATE_ID]);
  assert.deepEqual(all, [first, second]);
  assert.equal(await readFile(firstPath, "utf8"), before);
  assert.equal((await store.readAll("/other-project")).length, 1);
});

test("Candidate enumeration fails closed so malformed canonical artifacts cannot become options", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-candidate-enumeration-invalid-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyCandidateStore({ baseDir });
  await store.save("/project", candidate());
  const directory = store.strategyCandidateDirectory("/project");
  await writeFile(
    join(directory, "00000000-0000-4000-8000-000000000002.json"),
    JSON.stringify({ schemaVersion: 1 }),
    "utf8",
  );

  await assert.rejects(store.readAll("/project"), /invalid|Candidate/i);
});

test("Candidate command labels are semantic, bounded, and disambiguatable by a short suffix", () => {
  const first = candidate();
  const second = candidate("10000000-0000-4000-8000-000000000002");
  const long = createStrategyRevisionCandidate({
    target: getSeedStrategy("architecture-first")!,
    candidateId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "A".repeat(512),
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
      sourceRecordIds: ["record-one", "record-two"],
      hypothesis: "A bounded label should remain readable.",
    },
  });

  const firstLabel = formatCandidateCommandLabel(first);
  const secondLabel = formatCandidateCommandLabel(second);
  const longLabel = formatCandidateCommandLabel(long);
  const firstDisambiguated = formatCandidateCommandLabel(first, { includeCandidateId: true });
  const secondDisambiguated = formatCandidateCommandLabel(second, { includeCandidateId: true });

  assert.match(firstLabel, /^architecture-first · Use a bounded architectural check/);
  assert.doesNotMatch(firstLabel, new RegExp(CANDIDATE_ID));
  assert.equal(firstLabel.length <= MAX_CANDIDATE_COMMAND_LABEL_LENGTH, true);
  assert.equal(longLabel.length <= MAX_CANDIDATE_COMMAND_LABEL_LENGTH, true);
  assert.notEqual(firstDisambiguated, secondDisambiguated);
  assert.match(firstDisambiguated, / · 00000000$/);
  assert.match(secondDisambiguated, / · 10000000$/);
});

test("Candidate reader rejects malformed IDs before Candidate path lookup", async () => {
  let pathLookups = 0;
  class ObservedStore extends FileStrategyCandidateStore {
    override strategyCandidateDirectory(projectRoot: string): string {
      pathLookups += 1;
      return super.strategyCandidateDirectory(projectRoot);
    }
  }
  const store = new ObservedStore({ baseDir: "/tmp/does-not-matter" });
  await assert.rejects(
    store.read("/project", `${CANDIDATE_ID.slice(0, 7)}A${CANDIDATE_ID.slice(8)}`),
    /canonical lowercase UUID-v4/i,
  );
  assert.equal(pathLookups, 0);
  assert.equal(isCanonicalStrategyCandidateId(CANDIDATE_ID), true);
  assert.equal(isCanonicalStrategyCandidateId(`${CANDIDATE_ID.slice(0, 7)}A${CANDIDATE_ID.slice(8)}`), false);
});

test("Candidate reader fails closed for identity, schema, target, binding, proposal, and Seed-equality errors", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-trial-invalid-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyCandidateStore({ baseDir });
  const valid = candidate();

  const cases: Array<[string, unknown, RegExp]> = [
    ["requested ID mismatch", { ...valid, candidateId: OTHER_CANDIDATE_ID }, /requested Candidate ID/i],
    ["malformed schema", { ...valid, schemaVersion: 2 }, /schemaVersion must be 1/i],
    ["wrong target kind", { ...valid, target: { ...valid.target, kind: "modifier" } }, /target Strategy or immutable Seed binding/i],
    ["stale Seed binding", { ...valid, target: { ...valid.target, baseFingerprint: `sha256:${"0".repeat(64)}` } }, /immutable Seed binding/i],
    ["invalid proposal", { ...valid, proposal: { ...valid.proposal, useWhen: [] } }, /useWhen must contain/i],
    ["Candidate equals Seed", {
      ...valid,
      proposal: {
        summary: valid.target.strategyId === "architecture-first"
          ? "Clarify ownership, boundaries, and invariants before changing a cross-cutting design."
          : valid.proposal.summary,
        useWhen: ["the request affects multiple components or established architecture"],
        avoidWhen: ["a local correction does not change an ownership or interface decision"],
        principles: [
          "preserve existing authority boundaries",
          "prefer the smallest coherent design",
          "align projections with their source of truth",
        ],
      },
    }, /must differ from the Seed Strategy semantics/i],
  ];

  for (const [name, artifact, error] of cases) {
    const fileId = CANDIDATE_ID;
    const path = await writeArtifact(store, "/project", fileId, artifact);
    const before = await readFile(path, "utf8");
    await assert.rejects(store.read("/project", fileId), error, name);
    assert.equal(await readFile(path, "utf8"), before, name);
    await rm(path);
  }

  const extraField = { ...valid, unexpected: true };
  await writeArtifact(store, "/project", CANDIDATE_ID, extraField);
  await assert.rejects(store.read("/project", CANDIDATE_ID), /artifact fields are invalid/i);
});

test("TrialRuntime holds one runtime-only, exact-generation Candidate lease", () => {
  const runtime = new TrialRuntime();
  const selectedCandidate = candidate();
  assert.equal(runtime.establish("session-a", selectedCandidate), true);
  assert.equal(runtime.establish("session-a", candidate(OTHER_CANDIDATE_ID)), false);
  assert.equal(runtime.bind("session-b", 4), null);
  assert.equal(runtime.hasPendingTrial, true);

  const active = runtime.bind("session-a", 4);
  assert.ok(active);
  assert.equal(active.agentRunGeneration, 4);
  assert.equal(runtime.activeFor("session-a", 3), null);
  assert.equal(runtime.activeFor("session-b", 4), null);
  assert.equal(runtime.activeFor("session-a", 4)?.candidateId, undefined);
  assert.equal(runtime.activeFor("session-a", 4)?.candidate.candidateId, CANDIDATE_ID);
  assert.equal(runtime.isActiveForGeneration(4), true);
  assert.equal(runtime.isActiveForGeneration(5), false);

  const selector = active.revisionSelection;
  const compactSelector: StrategyRevisionSelector = {
    strategyId: selector.strategyId,
    revisionIdentity: selector.revisionIdentity,
    revisionFingerprint: selector.revisionFingerprint,
  };
  assert.equal(
    runtime.resolveRevisionSelector("session-a", 4, compactSelector, "approach").revisionStatusAtRun,
    "trial",
  );
  assert.throws(
    () => runtime.resolveRevisionSelector("session-a", 5, compactSelector, "approach"),
    /without an active Candidate Trial/i,
  );
  runtime.clear();
  assert.equal(runtime.hasTrial, false);
  assert.equal(runtime.activeTrial, null);
  assert.equal(runtime.pendingTrial, null);
});

test("Trial Packet is bounded, exact, and does not fabricate attribution", () => {
  const packet = buildTrialPacket(candidate());
  const rendered = formatTrialPacket(packet);

  assert.equal(packet.candidateId, CANDIDATE_ID);
  assert.equal(packet.candidateFingerprint, strategyCandidateSemanticFingerprint(candidate()));
  assert.deepEqual(packet.target, {
    strategyId: "architecture-first",
    kind: "approach",
    baseFingerprint: seedStrategyFingerprint(getSeedStrategy("architecture-first")!),
  });
  assert.deepEqual(packet.selector, {
    strategyId: "architecture-first",
    revisionIdentity: CANDIDATE_ID,
    revisionFingerprint: packet.candidateFingerprint,
  });
  for (const expected of [
    CANDIDATE_ID,
    packet.candidateFingerprint,
    "architecture-first",
    "approach",
    packet.target.baseFingerprint,
    "Use a bounded architectural check before changing code.",
    "the change crosses a known interface boundary",
    "the issue is already a local correction",
    "name the boundary",
    "A narrower boundary check may reduce avoidable rework.",
    "This is an explicitly requested Candidate Trial",
    "This is not new user Task intent",
    "Candidate is a hypothesis, not proven better",
    "The model must explicitly declare the Candidate revision",
    "Merely receiving this packet does NOT create Candidate attribution",
    "It is valid not to use the Candidate",
  ]) assert.match(rendered, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rendered, /sourceRecordIds|transcript|reward|ranking|promotion|revisionStatusAtRun/i);
});

test("exact Candidate selectors are resolved by the Harness and preserve logical uniqueness", () => {
  const approachCandidate = candidate();
  const trial = new TrialRuntime();
  trial.establish("session", approachCandidate);
  trial.bind("session", 1);
  const selector = trial.activeTrial!.revisionSelection;
  const exact = {
    strategyId: selector.strategyId,
    revisionIdentity: selector.revisionIdentity,
    revisionFingerprint: selector.revisionFingerprint,
  };
  const resolved = createPolicySnapshotForRun(
    { approach: exact, modifiers: ["minimal-change"] },
    (value, kind) => trial.resolveRevisionSelector("session", 1, value, kind),
  );
  assert.equal(resolved.approach.revisionIdentity, CANDIDATE_ID);
  assert.equal(resolved.approach.revisionStatusAtRun, "trial");
  assert.equal(resolved.approach.revisionFingerprint, strategyCandidateSemanticFingerprint(approachCandidate));
  assert.deepEqual(resolved.approach.semantics, approachCandidate.proposal);

  assert.throws(
    () => createPolicySnapshotForRun({ approach: exact }, undefined),
    /Seed Strategy ID/i,
  );
  assert.throws(
    () => createPolicySnapshotForRun(
      { approach: exact, modifiers: [exact] },
      (value, kind) => trial.resolveRevisionSelector("session", 1, value, kind),
    ),
    /wrong.*modifier|role/i,
  );

  const modifierCandidate = createStrategyRevisionCandidate({
    target: getSeedStrategy("minimal-change")!,
    candidateId: OTHER_CANDIDATE_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Keep the first patch deliberately narrow and observable.",
      useWhen: ["the requested change has a bounded acceptance edge"],
      avoidWhen: ["the required scope is still expanding"],
      principles: ["change one surface", "check the result immediately"],
      sourceRecordIds: ["record-one", "record-two"],
      hypothesis: "A narrower modifier may reduce speculative edits.",
    },
  });
  const modifierTrial = new TrialRuntime();
  modifierTrial.establish("session", modifierCandidate);
  modifierTrial.bind("session", 2);
  const modifierSelection = modifierTrial.activeTrial!.revisionSelection;
  const modifierSelector = {
    strategyId: modifierSelection.strategyId,
    revisionIdentity: modifierSelection.revisionIdentity,
    revisionFingerprint: modifierSelection.revisionFingerprint,
  };
  assert.throws(
    () => createPolicySnapshotForRun({
      approach: "direct-action",
      modifiers: ["minimal-change", modifierSelector],
    }, (value, kind) => modifierTrial.resolveRevisionSelector("session", 2, value, kind)),
    /unique by logical Strategy identity/i,
  );
  assert.equal(createPolicySnapshot({ approach: "direct-action" }).approach.revisionIdentity, "seed");
});
