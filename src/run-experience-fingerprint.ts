import { createHash } from "node:crypto";
import { parseRunExperience, type RunExperience } from "./run-experience.ts";

/** Versioned exact canonical projection shared by legacy cross-project refs and v1. */
export function runExperienceRecordFingerprint(value: unknown): string {
  const record = parseRunExperience(value);
  if (record === null) throw new Error("Invalid schema-v4/v5 Run Experience artifact.");
  const selection = (selected: NonNullable<RunExperience["policy"]["finalSnapshot"]>) => {
    const revision = (v: any) => ({
      strategyId: v.strategyId, kind: v.kind, revisionIdentity: v.revisionIdentity,
      revisionFingerprint: v.revisionFingerprint, revisionStatusAtRun: v.revisionStatusAtRun,
      semantics: { summary: v.semantics.summary, useWhen: [...v.semantics.useWhen],
        avoidWhen: [...v.semantics.avoidWhen], principles: [...v.semantics.principles] },
    });
    return { approach: revision(selected.approach), modifiers: selected.modifiers.map(revision) };
  };
  // Preserve the exact v4 ordering and projection used by cross-project-experience.ts.
  const canonical = {
    schemaVersion: record.schemaVersion,
    ...(record.schemaVersion === 5 ? { workEpisodeId: record.workEpisodeId } : {}),
    recordedAt: record.recordedAt,
    runStart: { taskStatus: record.runStart.taskStatus, taskGoal: record.runStart.taskGoal },
    task: { goal: record.task.goal, taskRelation: record.task.taskRelation },
    policy: {
      finalSnapshot: record.policy.finalSnapshot === null ? null : selection(record.policy.finalSnapshot),
      declarationCount: record.policy.declarationCount,
      finalPolicyDeclarationCount: record.policy.finalPolicyDeclarationCount,
      finalPolicyFirstDeclaredAfter: record.policy.finalPolicyFirstDeclaredAfter === null
        ? null : { ...record.policy.finalPolicyFirstDeclaredAfter },
      finalPolicyLastDeclaredAfter: record.policy.finalPolicyLastDeclaredAfter === null
        ? null : { ...record.policy.finalPolicyLastDeclaredAfter },
    },
    execution: {
      toolCalls: record.execution.toolCalls, observations: record.execution.observations,
      consequentialCalls: record.execution.consequentialCalls,
      projectMutationEffectCalls: record.execution.projectMutationEffectCalls,
      verificationCalls: record.execution.verificationCalls, toolErrors: record.execution.toolErrors,
      deniedCalls: record.execution.deniedCalls,
    },
    outcome: {
      taskStatus: record.outcome.taskStatus, verificationStatus: record.outcome.verificationStatus,
      completionRelation: record.outcome.completionRelation, hasBlockers: record.outcome.hasBlockers,
      hasQuestions: record.outcome.hasQuestions, humanGateOpen: record.outcome.humanGateOpen,
    },
    metrics: { durationMs: record.metrics.durationMs, cost: record.metrics.cost },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
