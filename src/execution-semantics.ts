import type { PindieCapability } from "./semantics.ts";

export type ProjectMutationEffect = "none" | "known" | "ambiguous";

export interface ToolEffect {
  readonly requiredCapability: PindieCapability;
  readonly projectMutation: ProjectMutationEffect;
}

export type AuthorizationDecision =
  | {
      readonly allowed: true;
      readonly requiredCapability: PindieCapability;
    }
  | {
      readonly allowed: false;
      readonly requiredCapability: PindieCapability;
      readonly reason: "missing_capability";
    };

function classified(
  requiredCapability: PindieCapability,
  projectMutation: ProjectMutationEffect,
): ToolEffect {
  return { requiredCapability, projectMutation };
}

export function classifyToolEffect(toolName: string): ToolEffect {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
    case "web_search":
    case "url_context":
      return classified("observe.project", "none");

    case "pindie_git_observe":
      return classified("observe.git", "none");

    case "edit":
    case "write":
      return classified("project.mutate", "known");

    case "bash":
      return classified("project.mutate", "ambiguous");

    case "pindie_policy_set":
      return classified("policy.declare", "none");
    case "pindie_memory_capture":
      return classified("memory.capture", "none");
    case "pindie_strategy_candidate_create":
      return classified("policy.adapt", "none");
    case "pindie_strategy_derivation_candidate_create":
      return classified("policy.derive", "none");

    case "pindie_task_start":
      return classified("task.start", "none");
    case "pindie_task_replace":
      return classified("task.replace", "none");
    case "pindie_task_refine":
      return classified("task.refine", "none");
    case "pindie_task_progress":
    case "pindie_task_handoff":
      return classified("task.progress", "none");
    case "pindie_verification_record":
      return classified("verification.record", "none");
    case "pindie_task_complete":
      return classified("task.complete", "none");
    case "pindie_gate_open":
      return classified("gate.open", "none");
    case "pindie_gate_resolve":
      return classified("gate.resolve", "none");

    default:
      return classified("project.mutate", "ambiguous");
  }
}

export function authorizeToolEffect(
  capabilities: ReadonlySet<PindieCapability>,
  effect: ToolEffect,
): AuthorizationDecision {
  if (capabilities.has(effect.requiredCapability)) {
    return {
      allowed: true,
      requiredCapability: effect.requiredCapability,
    };
  }

  return {
    allowed: false,
    requiredCapability: effect.requiredCapability,
    reason: "missing_capability",
  };
}
