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
  deriveComparableCohorts,
  deriveExperienceEvaluation,
  derivePolicyEvidenceProfiles,
  deriveRunEvaluations,
  evaluateRunExperience,
  formatExperienceReport,
} from "../src/experience-evaluation.ts";
import { createPolicySnapshot, type PolicySnapshot } from "../src/policy.ts";
import {
  assembleRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
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
    consequentialCalls: 3,
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
    firstDeclarationAfter?: RunExperienceExecution | null;
    finalDeclarationAfter?: RunExperienceExecution | null;
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
      firstDeclarationAfter: options.firstDeclarationAfter ?? (policy === null ? null : execution({ toolCalls: 0 })),
      finalDeclarationAfter: options.finalDeclarationAfter ?? (policy === null ? null : execution({ toolCalls: 0 })),
    },
    execution: options.execution ?? execution(),
    durationMs: 100,
    cost: 0.5,
    recordedAt: options.recordedAt ?? "2026-01-01T00:00:00.000Z",
  });
}

function source(recordId: string, value: RunExperience): RunExperienceSourceRecord {
  return { recordId, experience: value };
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
    loadedSchemaV2: 0,
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
  const valid = JSON.stringify(experience("valid"), null, 2);
  const secondValid = JSON.stringify(experience("also valid"), null, 2);
  await writeRecord(directory, "a-valid.json", valid);
  await writeRecord(directory, "b-v1.json", JSON.stringify({ schemaVersion: 1 }));
  await writeRecord(directory, "c-v9.json", JSON.stringify({ schemaVersion: 9 }));
  await writeRecord(directory, "d-invalid.json", "{not json");
  await writeRecord(directory, "e-malformed.json", JSON.stringify({ schemaVersion: 2 }));
  await writeRecord(directory, "f-invalid-metadata.json", JSON.stringify({ schemaVersion: "2" }));
  await writeRecord(directory, "g-valid.json", secondValid);
  const before = await readFile(join(directory, "a-valid.json"), "utf8");

  const result = await reader.read("/project");

  assert.equal(result.loadedSchemaV2, 2);
  assert.equal(result.unsupportedSchema, 2);
  assert.equal(result.invalid, 3);
  assert.deepEqual(result.records.map((record) => record.recordId), ["a-valid.json", "g-valid.json"]);
  assert.equal(result.records[0]!.experience.task.goal, "valid");
  assert.equal(await readFile(join(directory, "a-valid.json"), "utf8"), before);
});

test("Run Evaluation preserves no-Policy null and derives policy exposure/progress", () => {
  const noPolicy = evaluateRunExperience(source("none.json", experience("no policy")));
  assert.equal(noPolicy.source.recordId, "none.json");
  assert.equal(noPolicy.policy.finalSnapshot, null);
  assert.equal(noPolicy.policy.firstDeclarationProgress, null);
  assert.equal(noPolicy.policy.finalDeclarationProgress, null);
  assert.equal(noPolicy.policy.finalPolicyExposureCalls, null);
  assert.equal(noPolicy.policy.finalPolicyExposureRatio, null);

  const policy = createPolicySnapshot({ approach: "direct-action" });
  const early = evaluateRunExperience(source("early.json", experience("early", {
    policy,
    firstDeclarationAfter: execution({ toolCalls: 0 }),
    finalDeclarationAfter: execution({ toolCalls: 0 }),
  })));
  assert.equal(early.policy.firstDeclarationProgress, 0);
  assert.equal(early.policy.finalDeclarationProgress, 0);
  assert.equal(early.policy.finalPolicyExposureCalls, 10);
  assert.equal(early.policy.finalPolicyExposureRatio, 1);

  const late = evaluateRunExperience(source("late.json", experience("late", {
    policy,
    firstDeclarationAfter: execution({ toolCalls: 7 }),
    finalDeclarationAfter: execution({ toolCalls: 8 }),
  })));
  assert.equal(late.policy.firstDeclarationProgress, 0.7);
  assert.equal(late.policy.finalDeclarationProgress, 0.8);
  assert.equal(late.policy.finalPolicyExposureCalls, 2);
  assert.equal(late.policy.finalPolicyExposureRatio, 0.2);
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
  assert.deepEqual(combined.exposure.calls, { count: 2, min: 10, median: 10, max: 10 });
  assert.deepEqual(combined.durationMs, { count: 2, min: 100, median: 100, max: 100 });
  assert.deepEqual(combined.sourceRecordIds, ["one.json", "two.json"]);
  assert.equal(profiles.find((profile) => profile.snapshot === null)?.runCount, 1);
  assert.equal(JSON.stringify(profiles).includes("score"), false);
  assert.equal(JSON.stringify(profiles).includes("ranking"), false);
  assert.equal(JSON.stringify(profiles).includes("effectiveness"), false);
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
    policyProfileIds: ["no-explicit-policy", 'policy:{"approachId":"direct-action","modifierIds":[]}'],
  });
  assert.equal(JSON.stringify(cohorts).includes("winner"), false);
  assert.equal(JSON.stringify(cohorts).includes("rank"), false);
});

test("Experience report is bounded and explicitly evidence-only", () => {
  const record = source("report.json", experience("report"));
  const read: RunExperienceReadResult = {
    records: [record],
    loadedSchemaV2: 1,
    unsupportedSchema: 2,
    invalid: 3,
  };
  const report = formatExperienceReport(read, deriveExperienceEvaluation(read.records));

  assert.match(report, /Loaded schema-v2 records: 1/);
  assert.match(report, /Unsupported-schema records: 2/);
  assert.match(report, /Invalid\/unreadable records: 3/);
  assert.match(report, /Explicit-Policy Runs: 0/);
  assert.match(report, /No-explicit-Policy Runs: 1/);
  assert.match(report, /Evidence inventory only; contains no Strategy score, ranking, or causal claim\./);
});

test("Experience report bounds profile provenance without changing derived profiles", () => {
  const records = Array.from({ length: 6 }, (_, index) =>
    source(`record-${index + 1}.json`, experience("many records")),
  );
  const evaluation = deriveExperienceEvaluation(records);
  const profile = evaluation.profiles[0]!;
  const read: RunExperienceReadResult = {
    records,
    loadedSchemaV2: records.length,
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
    loadedSchemaV2: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
  const report = formatExperienceReport(read, evaluation);

  assert.equal(evaluation.profiles.length, 11);
  assert.equal(report.split("\n").filter((line) => line.startsWith("  - ")).length, 10);
  assert.match(report, /\.\.\. \+1 more profiles/);
  assert.match(report, /Evidence inventory only; contains no Strategy score, ranking, or causal claim\./);
});
