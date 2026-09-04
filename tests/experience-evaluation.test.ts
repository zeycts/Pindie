import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileRunExperienceReader,
  type RunExperienceReadResult,
  type RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import {
  deriveCandidateTrialReview,
  deriveComparableCohorts,
  deriveExperienceEvaluation,
  derivePolicyEvidenceProfiles,
  policyEvidenceProfileId,
  deriveRunEvaluations,
  evaluateRunExperience,
  formatExperienceReport,
} from "../src/experience-evaluation.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
  policySnapshotIdentity,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  normalizeRunExperience,
  parseRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
import {
  createStrategyRevisionCandidate,
  strategyCandidateSemanticFingerprint,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import { getSeedStrategy } from "../src/strategies.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The record is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function snapshot(
  overrides: Partial<Extract<SemanticSnapshot, { authority: "coherent" }>> = {},
): Extract<SemanticSnapshot, { authority: "coherent" }> {
  return {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  };
}

function execution(overrides: Partial<RunExperienceExecution> = {}): RunExperienceExecution {
  return {
    toolCalls: 10,
    observations: 5,
    consequentialCalls: 5,
    projectMutationEffectCalls: 2,
    verificationCalls: 1,
    toolErrors: 2,
    deniedCalls: 4,
    ...overrides,
  };
}

function experience(
  goal: string,
  options: {
    policy?: PolicySnapshot | null;
    finalPolicyFirstDeclaredAfter?: RunExperienceExecution | null;
    finalPolicyLastDeclaredAfter?: RunExperienceExecution | null;
    execution?: RunExperienceExecution;
    verificationStatus?: "pending" | "stale" | "failed" | "passed" | "none";
    completionRelation?: "not_completed" | "completed_before_run" | "completed_during_run";
    hasBlockers?: boolean;
    hasQuestions?: boolean;
    humanGateOpen?: boolean;
    recordedAt?: string;
  } = {},
): RunExperience {
  const policy = options.policy ?? null;
  return assembleRunExperience({
    task: {
      ...task(goal),
      humanGate: options.humanGateOpen
        ? { kind: "approval", question: "Approve this Run?" }
        : null,
    },
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: snapshot({
      verificationStatus: options.verificationStatus ?? "pending",
      completionRelation: options.completionRelation ?? "not_completed",
      hasBlockers: options.hasBlockers ?? false,
      hasQuestions: options.hasQuestions ?? false,
    }),
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: options.finalPolicyFirstDeclaredAfter ?? (policy === null ? null : execution({
        toolCalls: 0,
        observations: 0,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 0,
        deniedCalls: 0,
      })),
      finalPolicyLastDeclaredAfter: options.finalPolicyLastDeclaredAfter ?? (policy === null ? null : execution({
        toolCalls: 0,
        observations: 0,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 0,
        deniedCalls: 0,
      })),
    },
    execution: options.execution ?? execution(),
    durationMs: 100,
    cost: 0.5,
    recordedAt: options.recordedAt ?? "2026-01-01T00:00:00.000Z",
  });
}

function completedBeforeExperience(goal: string, policy: PolicySnapshot | null = null): RunExperience {
  const record = structuredClone(experience(goal, { policy })) as any;
  record.runStart.taskStatus = "done";
  record.outcome.taskStatus = "done";
  record.outcome.verificationStatus = "passed";
  record.outcome.completionRelation = "completed_before_run";
  return record;
}

function legacyV3(value: RunExperience): any {
  const record = structuredClone(value) as any;
  record.schemaVersion = 3;
  if (record.policy.finalSnapshot !== null) {
    const seedPolicy = createPolicySnapshot({
      approach: record.policy.finalSnapshot.approach.strategyId,
      modifiers: record.policy.finalSnapshot.modifiers.map((modifier: any) => modifier.strategyId),
    });
    record.policy.finalSnapshot = seedPolicy;
  }
  return record;
}

function source(recordId: string, value: RunExperience | any): RunExperienceSourceRecord {
  return { recordId, experience: value };
}

const SHARED_CANDIDATE_ID = "00000000-0000-4000-8000-000000000001";

function sharedCandidate(): StrategyRevisionCandidate {
  return createStrategyRevisionCandidate({
    target: getSeedStrategy("architecture-first")!,
    candidateId: SHARED_CANDIDATE_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
      sourceRecordIds: ["adapt-one", "adapt-two"],
      hypothesis: "A narrower boundary check may reduce avoidable rework.",
    },
  });
}

async function writeRecord(
  directory: string,
  name: string,
  value: string,
): Promise<void> {
  await writeFile(join(directory, name), value, "utf8");
}

test("Experience Reader returns zero counts for a missing directory", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-experience-reader-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const result = await new FileRunExperienceReader({ baseDir }).read("/project");

  assert.deepEqual(result, {
    records: [],
    loadedSchemaV3: 0,
    loadedSchemaV4: 0,
    unsupportedSchema: 0,
    invalid: 0,
  });
});

test("Experience Reader preserves filenames, isolates bad records, and does not write", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-experience-reader-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const reader = new FileRunExperienceReader({ baseDir });
  const directory = reader.experienceDirectory("/project");
  await mkdir(directory, { recursive: true });
  const valid = JSON.stringify(legacyV3(experience("valid")), null, 2);
  const secondValid = JSON.stringify(experience("also valid"), null, 2);
  await writeRecord(directory, "00000000-0000-4000-8000-000000000001.json", valid);
  await writeRecord(directory, "00000000-0000-4000-8000-000000000002.json", JSON.stringify({ schemaVersion: 1 }));
  await writeRecord(directory, "00000000-0000-4000-8000-000000000003.json", JSON.stringify({ schemaVersion: 9 }));
  await writeRecord(directory, "00000000-0000-4000-8000-000000000004.json", "{\"schemaVersion\":3");
  const semanticallyInvalid = JSON.parse(valid) as any;
  semanticallyInvalid.execution.observations = 4;
  await writeRecord(directory, "00000000-0000-4000-8000-000000000005.json", JSON.stringify({ schemaVersion: 2 }));
  await writeRecord(directory, "00000000-0000-4000-8000-000000000008.json", JSON.stringify(semanticallyInvalid));
  await writeRecord(directory, "00000000-0000-4000-8000-000000000006.json", JSON.stringify({ schemaVersion: "2" }));
  await writeRecord(directory, "00000000-0000-4000-8000-000000000007.json", secondValid);
  await writeRecord(directory, ".00000000-0000-4000-8000-000000000008.json.tmp", "{not json");
  await writeRecord(directory, "00000000-0000-5000-8000-000000000009.json", "{not json");
  await writeRecord(directory, "foo.json", "{not json");
  await writeRecord(directory, ".hidden.json", "{not json");
  await writeRecord(directory, "backup.json", "{not json");
  await writeRecord(directory, "README", "{not json");
  await mkdir(join(directory, "00000000-0000-4000-8000-000000000010.json"));
  await mkdir(join(directory, "random-directory"));
  const before = await readFile(
    join(directory, "00000000-0000-4000-8000-000000000001.json"),
    "utf8",
  );

  const result = await reader.read("/project");

  assert.equal(result.loadedSchemaV3, 1);
  assert.equal(result.loadedSchemaV4, 1);
  assert.equal(result.unsupportedSchema, 3);
  assert.equal(result.invalid, 3);
  assert.deepEqual(result.records.map((record) => record.recordId), [
    "00000000-0000-4000-8000-000000000001.json",
    "00000000-0000-4000-8000-000000000007.json",
  ]);
  assert.equal(result.records[0]!.experience.task.goal, "valid");
  assert.equal(
    await readFile(join(directory, "00000000-0000-4000-8000-000000000001.json"), "utf8"),
    before,
  );
});

test("schema-v3 parser requires exact recorded Seed semantics and rejects impossible bounded facts", () => {
  const explicit = legacyV3(experience("parse", {
    policy: createPolicySnapshot({
      approach: "architecture-first",
      modifiers: ["minimal-change", "verify-as-you-go"],
    }),
  }));
  const parsed = parseRunExperience(explicit);
  const canonicalApproach = createPolicySnapshot({ approach: "architecture-first" }).approach;
  assert.equal(parsed?.schemaVersion, 3);
  assert.equal(parsed?.policy.finalSnapshot?.approach.revisionIdentity, "seed");
  assert.equal(
    parsed?.policy.finalSnapshot?.approach.revisionFingerprint,
    canonicalApproach.revisionFingerprint,
  );

  const semanticMutations: Array<[string, (selection: any) => void]> = [
    ["summary", (selection) => { selection.summary = "forged prose"; }],
    ["useWhen", (selection) => { selection.useWhen[0] = "forged guidance"; }],
    ["avoidWhen", (selection) => { selection.avoidWhen[0] = "forged boundary"; }],
    ["principles", (selection) => { selection.principles[0] = "forged principle"; }],
  ];
  for (const [name, mutate] of semanticMutations) {
    const forged = structuredClone(explicit) as any;
    mutate(forged.policy.finalSnapshot.approach);
    assert.equal(parseRunExperience(forged), null, name);
  }

  const invalidCases: Array<[string, (record: any) => void]> = [
    ["forged Strategy ID", (record) => {
      record.policy.finalSnapshot.approach.id = "forged-approach";
    }],
    ["wrong approach kind", (record) => {
      record.policy.finalSnapshot.approach.kind = "modifier";
    }],
    ["wrong modifier kind", (record) => {
      record.policy.finalSnapshot.modifiers[0].kind = "approach";
    }],
    ["duplicate modifier identity", (record) => {
      record.policy.finalSnapshot.modifiers.push(record.policy.finalSnapshot.modifiers[0]);
    }],
    ["null final Snapshot with declarations", (record) => {
      record.policy.finalSnapshot = null;
      record.policy.declarationCount = 1;
    }],
    ["explicit Snapshot with zero declarations", (record) => {
      record.policy.declarationCount = 0;
      record.policy.finalPolicyDeclarationCount = 0;
      record.policy.finalPolicyFirstDeclaredAfter = null;
      record.policy.finalPolicyLastDeclaredAfter = null;
    }],
    ["final Policy declarations exceed all declarations", (record) => {
      record.policy.finalPolicyDeclarationCount = record.policy.declarationCount + 1;
    }],
    ["declaration position exceeds final execution", (record) => {
      record.policy.finalPolicyFirstDeclaredAfter = execution({
        toolCalls: 11,
        observations: 5,
        consequentialCalls: 6,
      });
      record.policy.finalPolicyLastDeclaredAfter = record.policy.finalPolicyFirstDeclaredAfter;
    }],
    ["first final Policy position follows last", (record) => {
      record.policy.declarationCount = 2;
      record.policy.finalPolicyDeclarationCount = 2;
      record.policy.finalPolicyFirstDeclaredAfter = execution({
        toolCalls: 7,
        observations: 3,
        consequentialCalls: 4,
      });
      record.policy.finalPolicyLastDeclaredAfter = execution({
        toolCalls: 5,
        observations: 2,
        consequentialCalls: 3,
      });
    }],
    ["one final Policy declaration has unequal positions", (record) => {
      record.policy.finalPolicyFirstDeclaredAfter = execution({
        toolCalls: 1,
        observations: 1,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 0,
        deniedCalls: 0,
      });
      record.policy.finalPolicyLastDeclaredAfter = execution({
        toolCalls: 1,
        observations: 1,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 1,
        deniedCalls: 0,
      });
    }],
    ["execution observations do not partition calls", (record) => {
      record.execution.observations = 4;
    }],
    ["project mutation effects exceed calls", (record) => {
      record.execution.projectMutationEffectCalls = 11;
    }],
    ["project mutation effects exceed consequential calls", (record) => {
      record.execution.projectMutationEffectCalls = 6;
    }],
    ["verification calls exceed calls", (record) => {
      record.execution.verificationCalls = 11;
    }],
    ["verification calls exceed consequential calls", (record) => {
      record.execution.verificationCalls = 6;
    }],
    ["declaration position project mutations exceed consequential calls", (record) => {
      record.policy.finalPolicyFirstDeclaredAfter.projectMutationEffectCalls = 1;
    }],
    ["declaration position verification calls exceed consequential calls", (record) => {
      record.policy.finalPolicyLastDeclaredAfter.verificationCalls = 1;
    }],
    ["tool errors exceed calls", (record) => {
      record.execution.toolErrors = 11;
    }],
    ["idle Run starts with a goal", (record) => {
      record.runStart.taskStatus = "idle";
      record.runStart.taskGoal = "should be null";
    }],
    ["idle Run starts with a preexisting Task", (record) => {
      record.runStart.taskStatus = "idle";
      record.runStart.taskGoal = null;
    }],
    ["untouched Task has a different Run-start goal", (record) => {
      record.runStart.taskGoal = "different goal";
    }],
    ["untouched Task changes status", (record) => {
      record.runStart.taskStatus = "blocked";
    }],
    ["changed Task starts from idle", (record) => {
      record.runStart.taskStatus = "idle";
      record.runStart.taskGoal = null;
      record.task.taskRelation = "preexisting_changed";
    }],
    ["completed-before-Run does not start done", (record) => {
      record.runStart.taskStatus = "active";
      record.outcome.taskStatus = "done";
      record.outcome.verificationStatus = "passed";
      record.outcome.completionRelation = "completed_before_run";
    }],
    ["settled Task cannot have verification none", (record) => {
      record.outcome.verificationStatus = "none";
    }],
    ["completion relation does not match outcome status", (record) => {
      record.outcome.completionRelation = "completed_during_run";
    }],
    ["done outcome is not completed", (record) => {
      record.outcome.taskStatus = "done";
      record.outcome.completionRelation = "not_completed";
    }],
  ];
  for (const [name, mutate] of invalidCases) {
    const record = structuredClone(explicit);
    mutate(record);
    assert.equal(parseRunExperience(record), null, name);
  }
});

test("schema-v4 parser rejects unknown fields while schema-v3 keeps its historical field handling", () => {
  const valid = structuredClone(experience("strict v4", {
    policy: createPolicySnapshot({ approach: "architecture-first" }),
  })) as any;
  const invalidCases: Array<[string, (record: any) => void]> = [
    ["root", (record) => { record.reward = 1; }],
    ["runStart", (record) => { record.runStart.reward = 1; }],
    ["task", (record) => { record.task.trialState = "invalid"; }],
    ["policy", (record) => { record.policy.arbitraryMetadata = true; }],
    ["Policy Snapshot", (record) => { record.policy.finalSnapshot.trialState = true; }],
    ["Strategy revision selection", (record) => { record.policy.finalSnapshot.approach.reward = 1; }],
    ["revision semantics", (record) => { record.policy.finalSnapshot.approach.semantics.reward = 1; }],
    ["execution", (record) => { record.execution.trialState = true; }],
    ["first declaration position", (record) => { record.policy.finalPolicyFirstDeclaredAfter.trialState = true; }],
    ["last declaration position", (record) => { record.policy.finalPolicyLastDeclaredAfter.trialState = true; }],
    ["outcome", (record) => { record.outcome.reward = 1; }],
    ["metrics", (record) => { record.metrics.arbitraryMetadata = true; }],
  ];
  for (const [name, mutate] of invalidCases) {
    const record = structuredClone(valid);
    mutate(record);
    assert.equal(parseRunExperience(record), null, name);
  }

  const legacy = legacyV3(valid);
  legacy.reward = 1;
  assert.ok(parseRunExperience(legacy));
});

test("schema-v3 parser accepts valid consequential subsets and declaration positions", () => {
  const valid = structuredClone(experience("valid subsets", {
    policy: createPolicySnapshot({ approach: "direct-action" }),
  })) as any;
  valid.execution.projectMutationEffectCalls = 5;
  valid.execution.verificationCalls = 5;
  assert.ok(parseRunExperience(valid));

  valid.policy.declarationCount = 2;
  valid.policy.finalPolicyDeclarationCount = 2;
  valid.policy.finalPolicyFirstDeclaredAfter = {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  valid.policy.finalPolicyLastDeclaredAfter = {
    toolCalls: 1,
    observations: 1,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  assert.ok(parseRunExperience(valid));

  const introduced = structuredClone(experience("introduced")) as any;
  introduced.runStart.taskStatus = "idle";
  introduced.runStart.taskGoal = null;
  introduced.task.taskRelation = "introduced_during_run";
  assert.ok(parseRunExperience(introduced));

  const changed = structuredClone(experience("changed")) as any;
  changed.task.taskRelation = "preexisting_changed";
  assert.ok(parseRunExperience(changed));
});

test("schema-v3 and schema-v4 normalize to one revision-aware Evaluation shape", () => {
  const seedPolicy = createPolicySnapshot({
    approach: "architecture-first",
    modifiers: ["minimal-change"],
  });
  const current = experience("normalization", { policy: seedPolicy });
  const legacy = legacyV3(current);
  const parsedLegacy = parseRunExperience(legacy);
  const parsedCurrent = parseRunExperience(current);
  assert.equal(parsedLegacy?.schemaVersion, 3);
  assert.equal(parsedCurrent?.schemaVersion, 4);
  assert.ok(parsedLegacy);
  assert.ok(parsedCurrent);

  const normalizedLegacy = normalizeRunExperience(parsedLegacy);
  const normalizedCurrent = normalizeRunExperience(parsedCurrent);
  assert.equal(normalizedLegacy.schemaVersion, 4);
  assert.deepEqual(normalizedLegacy, normalizedCurrent);
  assert.deepEqual(
    evaluateRunExperience(source("legacy.json", parsedLegacy)).policy.finalSnapshot,
    evaluateRunExperience(source("current.json", parsedCurrent)).policy.finalSnapshot,
  );

  const revision = createStrategyRevisionSelection({
    strategyId: "architecture-first",
    kind: "approach",
    revisionIdentity: "00000000-0000-4000-8000-000000000099",
    revisionFingerprint: `sha256:${"2".repeat(64)}`,
    revisionStatusAtRun: "trial",
    semantics: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
    },
  });
  const revisionRecord = experience("revision normalization", {
    policy: createPolicySnapshotFromRevisions({ approach: revision }),
  });
  const parsedRevision = parseRunExperience(revisionRecord);
  assert.ok(parsedRevision);
  assert.equal(parsedRevision.policy.finalSnapshot?.approach.revisionIdentity, revision.revisionIdentity);
  assert.equal(parsedRevision.policy.finalSnapshot?.approach.revisionStatusAtRun, "trial");
  assert.equal(parsedRevision.policy.finalSnapshot?.approach.id, "architecture-first");
  assert.equal(
    Object.keys(normalizeRunExperience(parsedRevision).policy.finalSnapshot!.approach).join(","),
    "strategyId,kind,revisionIdentity,revisionFingerprint,revisionStatusAtRun,semantics",
  );

  const forgedSeed = structuredClone(current) as any;
  forgedSeed.policy.finalSnapshot.approach.semantics.summary = "forged Seed semantics";
  assert.equal(parseRunExperience(forgedSeed), null);
});

test("Run Evaluation marks completed-before-Run facts non-attributable", () => {
  const policy = createPolicySnapshot({ approach: "direct-action" });
  const completedBefore = completedBeforeExperience("same goal", policy);
  assert.ok(parseRunExperience(completedBefore));

  const evaluated = evaluateRunExperience(source("before.json", completedBefore));
  assert.equal(evaluated.attributionEligible, false);
  assert.equal(evaluated.source.recordId, "before.json");
  const ordinary = evaluateRunExperience(source("ordinary.json", experience("same goal", { policy })));
  assert.equal(ordinary.attributionEligible, true);

  const records = [
    source("before.json", completedBefore),
    source("ordinary.json", experience("same goal", { policy })),
    source("ordinary-no-policy.json", experience("same goal")),
  ];
  const evaluations = deriveRunEvaluations(records);
  const profiles = derivePolicyEvidenceProfiles(evaluations);
  const directProfile = profiles.find((profile) =>
    profile.identity.approachId === "direct-action" && profile.identity.modifierIds.length === 0);
  assert.equal(directProfile?.runCount, 1);
  assert.equal(profiles.find((profile) => profile.profileId === "no-explicit-policy")?.runCount, 1);
  assert.equal(profiles.some((profile) => profile.sourceRecordIds.includes("before.json")), false);

  const cohorts = deriveComparableCohorts(evaluations);
  assert.deepEqual(cohorts[0]?.sourceRecordIds, ["ordinary-no-policy.json", "ordinary.json"].sort());
  assert.equal(cohorts[0]?.sourceRecordIds.includes("before.json"), false);

  const report = formatExperienceReport({
    records,
    loadedSchemaV3: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  }, { evaluations, profiles, cohorts });
  assert.match(report, /Evaluated Runs: 3/);
  assert.match(report, /Attributable Runs: 2/);
  assert.match(report, /Non-attributable Runs: 1/);
});

test("schema-v3 parser accepts every real Task verification status except none", () => {
  for (const verificationStatus of ["pending", "stale", "failed", "passed"] as const) {
    const record = structuredClone(experience(`verification ${verificationStatus}`)) as any;
    record.outcome.verificationStatus = verificationStatus;
    assert.ok(parseRunExperience(record), verificationStatus);
  }
});

test("Run Evaluation preserves no-Policy null and derives policy exposure/progress", () => {
  const noPolicy = evaluateRunExperience(source("none.json", experience("no policy")));
  assert.equal(noPolicy.source.recordId, "none.json");
  assert.equal(noPolicy.attributionEligible, true);
  assert.equal(noPolicy.policy.finalSnapshot, null);
  assert.equal(noPolicy.policy.finalPolicyFirstDeclarationProgress, null);
  assert.equal(noPolicy.policy.finalPolicyLastActivationProgress, null);
  assert.equal(noPolicy.policy.finalPolicyExposureCalls, null);
  assert.equal(noPolicy.policy.finalPolicyExposureRatio, null);

  const policy = createPolicySnapshot({ approach: "direct-action" });
  const early = evaluateRunExperience(source("early.json", experience("early", {
    policy,
    finalPolicyFirstDeclaredAfter: execution({ toolCalls: 0 }),
    finalPolicyLastDeclaredAfter: execution({ toolCalls: 0 }),
  })));
  assert.equal(early.policy.finalPolicyFirstDeclarationProgress, 0);
  assert.equal(early.policy.finalPolicyLastActivationProgress, 0);
  assert.equal(early.policy.finalPolicyExposureCalls, 10);
  assert.equal(early.policy.finalPolicyExposureRatio, 1);

  const late = evaluateRunExperience(source("late.json", experience("late", {
    policy,
    finalPolicyFirstDeclaredAfter: execution({ toolCalls: 7 }),
    finalPolicyLastDeclaredAfter: execution({ toolCalls: 8 }),
  })));
  assert.equal(late.policy.finalPolicyFirstDeclarationProgress, 0.7);
  assert.equal(late.policy.finalPolicyLastActivationProgress, 0.8);
  assert.equal(late.policy.finalPolicyExposureCalls, 2);
  assert.equal(late.policy.finalPolicyExposureRatio, 0.2);
  assert.equal(late.policy.finalPolicyFirstDeclarationProgress, 0.7);
  assert.equal(late.policy.finalPolicyLastActivationProgress, 0.8);
});

test("Run Evaluation derives execution ratios and factual outcomes without non-finite values", () => {
  const evaluated = evaluateRunExperience(source("facts.json", experience("facts", {
    execution: execution({ toolCalls: 10, observations: 5, consequentialCalls: 3, toolErrors: 2, deniedCalls: 4 }),
    verificationStatus: "passed",
    completionRelation: "completed_during_run",
    hasBlockers: true,
    hasQuestions: true,
    humanGateOpen: true,
  })));
  assert.equal(evaluated.execution.observationRatio, 0.5);
  assert.equal(evaluated.execution.consequentialRatio, 0.3);
  assert.equal(evaluated.execution.toolErrorRatio, 0.2);
  assert.equal(evaluated.execution.deniedCallRatio, 4 / 14);
  assert.equal(evaluated.execution.toolErrors, 2);
  assert.equal(evaluated.execution.deniedCalls, 4);
  assert.deepEqual(evaluated.outcome, {
    verificationPassed: true,
    completedDuringRun: true,
    hasBlockers: true,
    hasQuestions: true,
    humanGateOpen: true,
  });

  const zero = evaluateRunExperience(source("zero.json", experience("zero", {
    execution: execution({ toolCalls: 0, observations: 100, consequentialCalls: 100, toolErrors: 100, deniedCalls: 0 }),
  })));
  for (const value of [
    zero.execution.observationRatio,
    zero.execution.consequentialRatio,
    zero.execution.toolErrorRatio,
    zero.execution.deniedCallRatio,
  ]) assert.equal(value, null);
  assert.doesNotMatch(JSON.stringify(zero), /NaN|Infinity/);
});

test("Policy Evidence Profiles aggregate complete normalized Policies and preserve evidence", () => {
  const firstPolicy = createPolicySnapshot({
    approach: "architecture-first",
    modifiers: ["verify-as-you-go", "minimal-change"],
  });
  const equivalentPolicy = createPolicySnapshot({
    approach: "architecture-first",
    modifiers: ["minimal-change", "verify-as-you-go"],
  });
  const differentPolicy = createPolicySnapshot({ approach: "explore-first" });
  const evaluations = deriveRunEvaluations([
    source("one.json", experience("same", { policy: firstPolicy, verificationStatus: "passed" })),
    source("two.json", experience("same", { policy: equivalentPolicy, completionRelation: "completed_during_run" })),
    source("three.json", experience("other", { policy: differentPolicy })),
    source("four.json", experience("other")),
  ]);

  const profiles = derivePolicyEvidenceProfiles(evaluations);
  assert.equal(profiles.length, 3);
  const combined = profiles.find((profile) => profile.identity.approachId === "architecture-first");
  assert.ok(combined);
  assert.equal(combined.runCount, 2);
  assert.equal(combined.verificationPassedCount, 1);
  assert.equal(combined.completedDuringRunCount, 1);
  assert.equal(combined.totalToolErrors, 4);
  assert.equal(combined.totalDeniedCalls, 8);
  assert.deepEqual(combined.declarationCount, { count: 2, min: 1, median: 1, max: 1 });
  assert.deepEqual(combined.finalPolicyDeclarationCount, { count: 2, min: 1, median: 1, max: 1 });
  assert.deepEqual(combined.exposure.calls, { count: 2, min: 10, median: 10, max: 10 });
  assert.deepEqual(combined.exposure.finalPolicyFirstDeclarationProgress, { count: 2, min: 0, median: 0, max: 0 });
  assert.deepEqual(combined.exposure.finalPolicyLastActivationProgress, { count: 2, min: 0, median: 0, max: 0 });
  assert.deepEqual(combined.durationMs, { count: 2, min: 100, median: 100, max: 100 });
  assert.deepEqual(combined.sourceRecordIds, ["one.json", "two.json"]);
  const noPolicyProfile = profiles.find((profile) => profile.snapshot === null);
  assert.equal(noPolicyProfile?.runCount, 1);
  assert.deepEqual(noPolicyProfile?.exposure.finalPolicyFirstDeclarationProgress, {
    count: 0,
    min: null,
    median: null,
    max: null,
  });
  assert.equal(JSON.stringify(profiles).includes("score"), false);
  assert.equal(JSON.stringify(profiles).includes("ranking"), false);
  assert.equal(JSON.stringify(profiles).includes("effectiveness"), false);
});

test("Experience Policy profiles label Seed, Trial, and promoted revisions without exposing fingerprints", () => {
  const seedPolicy = createPolicySnapshot({ approach: "architecture-first" });
  const revisionSemantics = {
    summary: "Use a bounded architectural check before changing code.",
    useWhen: ["the change crosses a known interface boundary"],
    avoidWhen: ["the issue is already a local correction"],
    principles: ["name the boundary", "verify the smallest coherent change"],
  };
  const trial = createStrategyRevisionSelection({
    strategyId: "architecture-first",
    kind: "approach",
    revisionIdentity: "11111111-1111-4111-8111-111111111111",
    revisionFingerprint: `sha256:${"3".repeat(64)}`,
    revisionStatusAtRun: "trial",
    semantics: revisionSemantics,
  });
  const promoted = createStrategyRevisionSelection({
    strategyId: "architecture-first",
    kind: "approach",
    revisionIdentity: "22222222-2222-4222-8222-222222222222",
    revisionFingerprint: `sha256:${"4".repeat(64)}`,
    revisionStatusAtRun: "promoted",
    semantics: revisionSemantics,
  });
  const trialPolicy = createPolicySnapshotFromRevisions({ approach: trial });
  const promotedPolicy = createPolicySnapshotFromRevisions({ approach: promoted });
  const records = [
    source("seed.json", experience("seed", { policy: seedPolicy })),
    source("trial.json", experience("trial", { policy: trialPolicy })),
    source("promoted.json", experience("promoted", { policy: promotedPolicy })),
  ];

  const evaluation = deriveExperienceEvaluation(records);
  const read: RunExperienceReadResult = {
    records,
    loadedSchemaV3: 0,
    loadedSchemaV4: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const report = formatExperienceReport(read, evaluation);

  assert.match(report, /  - architecture-first · trial 11111111 · runs 1/);
  assert.match(report, /  - architecture-first · promoted 22222222 · runs 1/);
  assert.match(report, /  - architecture-first · runs 1/);
  assert.doesNotMatch(report, /sha256:/);
  assert.equal(evaluation.profiles.length, 3);
  const trialProfile = evaluation.profiles.find((profile) =>
    profile.profileId === policyEvidenceProfileId(trialPolicy));
  const promotedProfile = evaluation.profiles.find((profile) =>
    profile.profileId === policyEvidenceProfileId(promotedPolicy));
  assert.equal(trialProfile?.profileId, policyEvidenceProfileId(trialPolicy));
  assert.equal(promotedProfile?.profileId, policyEvidenceProfileId(promotedPolicy));
  assert.notEqual(trialProfile?.profileId, promotedProfile?.profileId);
  assert.notEqual(policySnapshotIdentity(trialPolicy), policySnapshotIdentity(promotedPolicy));
  assert.equal("candidateStatus" in trialPolicy.approach, false);
  assert.equal("trust" in promotedPolicy.approach, false);
});

test("Experience evidence profiles separate Trial and promoted use of one Candidate revision", () => {
  const selectedCandidate = sharedCandidate();
  const candidateFingerprint = strategyCandidateSemanticFingerprint(selectedCandidate);
  const selection = (status: "trial" | "promoted") => createStrategyRevisionSelection({
    strategyId: selectedCandidate.target.strategyId,
    kind: selectedCandidate.target.kind,
    revisionIdentity: selectedCandidate.candidateId,
    revisionFingerprint: candidateFingerprint,
    revisionStatusAtRun: status,
    semantics: selectedCandidate.proposal,
  });
  const trialPolicy = createPolicySnapshotFromRevisions({
    approach: selection("trial"),
    modifiers: ["verify-as-you-go", "minimal-change"],
  });
  const equivalentTrialPolicy = createPolicySnapshotFromRevisions({
    approach: selection("trial"),
    modifiers: ["minimal-change", "verify-as-you-go"],
  });
  const promotedPolicy = createPolicySnapshotFromRevisions({
    approach: selection("promoted"),
    modifiers: ["minimal-change", "verify-as-you-go"],
  });
  const trialProfileId = policyEvidenceProfileId(trialPolicy);
  const equivalentTrialProfileId = policyEvidenceProfileId(equivalentTrialPolicy);
  const promotedProfileId = policyEvidenceProfileId(promotedPolicy);

  assert.equal(trialPolicy.approach.revisionIdentity, selectedCandidate.candidateId);
  assert.equal(promotedPolicy.approach.revisionIdentity, selectedCandidate.candidateId);
  assert.equal(trialPolicy.approach.revisionFingerprint, candidateFingerprint);
  assert.equal(promotedPolicy.approach.revisionFingerprint, candidateFingerprint);
  assert.equal(policySnapshotIdentity(trialPolicy), policySnapshotIdentity(promotedPolicy));
  assert.notEqual(trialProfileId, promotedProfileId);
  assert.equal(trialProfileId, equivalentTrialProfileId);
  assert.ok(trialProfileId.includes(selectedCandidate.candidateId));
  assert.ok(trialProfileId.includes(candidateFingerprint));
  assert.match(trialProfileId, /"revisionStatusAtRun":"trial"/);
  assert.match(promotedProfileId, /"revisionStatusAtRun":"promoted"/);

  const records = [
    source("trial-a.json", experience("same goal", { policy: trialPolicy })),
    source("trial-b.json", experience("same goal", { policy: equivalentTrialPolicy })),
    source("promoted.json", experience("same goal", { policy: promotedPolicy })),
  ];
  assert.deepEqual(records.map((record) => record.experience.schemaVersion), [4, 4, 4]);

  const evaluation = deriveExperienceEvaluation(records);
  assert.equal(evaluation.profiles.length, 2);
  const trialProfile = evaluation.profiles.find((profile) => profile.profileId === trialProfileId);
  const promotedProfile = evaluation.profiles.find((profile) => profile.profileId === promotedProfileId);
  assert.ok(trialProfile);
  assert.ok(promotedProfile);
  assert.equal(trialProfile.runCount, 2);
  assert.equal(promotedProfile.runCount, 1);
  assert.deepEqual(trialProfile.sourceRecordIds, ["trial-a.json", "trial-b.json"]);
  assert.deepEqual(promotedProfile.sourceRecordIds, ["promoted.json"]);
  assert.equal(trialProfile.snapshot?.approach.revisionStatusAtRun, "trial");
  assert.equal(promotedProfile.snapshot?.approach.revisionStatusAtRun, "promoted");

  const report = formatExperienceReport({
    records,
    loadedSchemaV3: 0,
    loadedSchemaV4: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  }, evaluation);
  assert.match(report, /  - architecture-first · trial 00000000 \+ minimal-change, verify-as-you-go · runs 2/);
  assert.match(report, /  - architecture-first · promoted 00000000 \+ minimal-change, verify-as-you-go · runs 1/);

  assert.equal(evaluation.cohorts.length, 1);
  const cohort = evaluation.cohorts[0]!;
  assert.deepEqual(cohort.sourceRecordIds, ["promoted.json", "trial-a.json", "trial-b.json"]);
  assert.deepEqual(
    [...cohort.policyProfileIds].sort(),
    [trialProfileId, promotedProfileId].sort(),
  );

  const review = deriveCandidateTrialReview(selectedCandidate, [
    ...records,
    source("seed.json", experience("same goal", {
      policy: createPolicySnapshot({ approach: "architecture-first" }),
    })),
  ]);
  assert.deepEqual(
    review.trialEvaluations.map((run) => run.source.recordId),
    ["trial-a.json", "trial-b.json"],
  );
  assert.equal(review.candidateProfile.runCount, 2);
  assert.deepEqual(review.candidateProfile.sourceRecordIds, ["trial-a.json", "trial-b.json"]);
  assert.equal(review.promotionEligibility.eligibleTrialRunCount, 2);
  assert.equal(review.promotionEligibility.eligible, true);
  assert.equal(review.seedBaselineProfile.runCount, 1);
});

test("Comparable cohorts require exact repeated goals and preserve provenance without winners", () => {
  const evaluations = deriveRunEvaluations([
    source("a.json", experience("exact goal")),
    source("b.json", experience("exact goal", { policy: createPolicySnapshot({ approach: "direct-action" }) })),
    source("c.json", experience("different goal")),
  ]);
  const cohorts = deriveComparableCohorts(evaluations);

  assert.equal(cohorts.length, 1);
  assert.deepEqual(cohorts[0], {
    taskGoal: "exact goal",
    sourceRecordIds: ["a.json", "b.json"],
    policyProfileIds: [
      "no-explicit-policy",
      policyEvidenceProfileId(createPolicySnapshot({ approach: "direct-action" })),
    ],
  });
  assert.equal(JSON.stringify(cohorts).includes("winner"), false);
  assert.equal(JSON.stringify(cohorts).includes("rank"), false);
});

test("Experience report is bounded and explicitly evidence-only", () => {
  const record = source("report.json", experience("report"));
  const read: RunExperienceReadResult = {
    records: [record],
    loadedSchemaV3: 1,
    unsupportedSchema: 2,
    invalid: 3,
  };
  const report = formatExperienceReport(read, deriveExperienceEvaluation(read.records));

  assert.match(report, /Loaded schema-v3 records: 1/);
  assert.match(report, /Loaded schema-v4 records: 0/);
  assert.match(report, /Unsupported-schema records: 2/);
  assert.match(report, /Invalid\/unreadable records: 3/);
  assert.match(report, /Evaluated Runs: 1/);
  assert.match(report, /Attributable Runs: 1/);
  assert.match(report, /Non-attributable Runs: 0/);
  assert.match(report, /Explicit-Policy Runs: 0/);
  assert.match(report, /No-explicit-Policy Runs: 1/);
  assert.match(report, /Attributable Runs only; comparable exact-goal cohorts use attributable Runs only\./);
  assert.match(report, /first final-Policy declaration progress: n\/a · last activation progress: n\/a/);
  assert.match(report, /continuous final-Policy exposure calls: n\/a · ratio: n\/a/);
  assert.match(report, /Evidence inventory only; contains no Strategy score, ranking, or causal claim\./);
});

test("Experience report exposes bounded Policy attribution evidence", () => {
  const policy = createPolicySnapshot({ approach: "direct-action" });
  const record = source("attribution.json", experience("attribution", {
    policy,
    finalPolicyFirstDeclaredAfter: execution({ toolCalls: 2, observations: 1, consequentialCalls: 1 }),
    finalPolicyLastDeclaredAfter: execution({ toolCalls: 8, observations: 4, consequentialCalls: 4 }),
  }));
  const evaluation = deriveExperienceEvaluation([record]);
  const read: RunExperienceReadResult = {
    records: [record],
    loadedSchemaV3: 1,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const report = formatExperienceReport(read, evaluation);

  assert.match(report, /declarations: n=1, min=1, median=1, max=1/);
  assert.match(report, /final-Policy declarations: n=1, min=1, median=1, max=1/);
  assert.match(report, /first final-Policy declaration progress: n=1, min=20\.0%, median=20\.0%, max=20\.0%/);
  assert.match(report, /last activation progress: n=1, min=80\.0%, median=80\.0%, max=80\.0%/);
  assert.match(report, /continuous final-Policy exposure calls: n=1, min=2, median=2, max=2 · ratio: n=1, min=20\.0%, median=20\.0%, max=20\.0%/);
  assert.doesNotMatch(report, /attribution score|confidence score|effectiveness score|causal score|winner/);
});

test("Experience report bounds profile provenance without changing derived profiles", () => {
  const records = Array.from({ length: 6 }, (_, index) =>
    source(`record-${index + 1}.json`, experience("many records")),
  );
  const evaluation = deriveExperienceEvaluation(records);
  const profile = evaluation.profiles[0]!;
  const read: RunExperienceReadResult = {
    records,
    loadedSchemaV3: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const report = formatExperienceReport(read, evaluation);

  assert.deepEqual(profile.sourceRecordIds, records.map((record) => record.recordId));
  assert.match(report, /record-1\.json, record-2\.json, record-3\.json, record-4\.json, record-5\.json \(\+1 more\)/);
  assert.doesNotMatch(report, /record-6\.json/);
  assert.match(report, /Evidence inventory only; contains no Strategy score, ranking, or causal claim\./);
});

test("Experience report bounds the number of rendered profiles while retaining all evaluation data", () => {
  const policies = [
    { approach: "direct-action" },
    { approach: "reproduce-first" },
    { approach: "explore-first" },
    { approach: "hypothesis-driven" },
    { approach: "architecture-first" },
    { approach: "direct-action", modifiers: ["minimal-change"] },
    { approach: "direct-action", modifiers: ["verify-as-you-go"] },
    { approach: "direct-action", modifiers: ["minimal-change", "verify-as-you-go"] },
    { approach: "reproduce-first", modifiers: ["minimal-change"] },
    { approach: "reproduce-first", modifiers: ["verify-as-you-go"] },
    { approach: "reproduce-first", modifiers: ["minimal-change", "verify-as-you-go"] },
  ];
  const records = policies.map((policy, index) => source(
    `profile-${index + 1}.json`,
    experience(`profile ${index + 1}`, { policy: createPolicySnapshot(policy) }),
  ));
  const evaluation = deriveExperienceEvaluation(records);
  const read: RunExperienceReadResult = {
    records,
    loadedSchemaV3: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const report = formatExperienceReport(read, evaluation);

  assert.equal(evaluation.profiles.length, 11);
  assert.equal(report.split("\n").filter((line) => line.startsWith("  - ")).length, 10);
  assert.match(report, /\.\.\. \+1 more profiles/);
  assert.match(report, /Evidence inventory only; contains no Strategy score, ranking, or causal claim\./);
});
