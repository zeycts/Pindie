import type { PindieCapability } from "./semantics.ts";

export interface ToolCallDescriptor {
  readonly toolName: string;
  readonly input?: unknown;
}

export type ProjectMutationEffect = "none" | "known" | "ambiguous";

export interface ToolEffect {
  readonly requiredCapability: PindieCapability;
  readonly projectMutation: ProjectMutationEffect;
}

type SemanticToolName = "pindie_state" | "pindie_gate";

export type ToolEffectClassificationResult =
  | {
      readonly ok: true;
      readonly effect: ToolEffect;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: "invalid_semantic_action";
        readonly toolName: SemanticToolName;
      };
    };

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
): ToolEffectClassificationResult {
  return {
    ok: true,
    effect: { requiredCapability, projectMutation },
  };
}

function invalidSemanticAction(
  toolName: SemanticToolName,
): ToolEffectClassificationResult {
  return {
    ok: false,
    error: { kind: "invalid_semantic_action", toolName },
  };
}

function semanticAction(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return (input as { readonly action?: unknown }).action;
}

export function classifyToolEffect(
  call: ToolCallDescriptor,
): ToolEffectClassificationResult {
  switch (call.toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return classified("observe.project", "none");

    case "pindie_git_observe":
      return classified("observe.git", "none");

    case "edit":
    case "write":
      return classified("project.mutate", "known");

    case "bash":
      return classified("project.mutate", "ambiguous");

    case "pindie_state":
      switch (semanticAction(call.input)) {
        case "start_task":
          return classified("task.start", "none");
        case "replace_task":
          return classified("task.replace", "none");
        case "refine_task":
          return classified("task.refine", "none");
        case "set_open_loops":
          return classified("task.progress", "none");
        case "record_verification":
          return classified("verification.record", "none");
        case "complete_task":
          return classified("task.complete", "none");
        default:
          return invalidSemanticAction("pindie_state");
      }

    case "pindie_gate":
      switch (semanticAction(call.input)) {
        case "open":
          return classified("gate.open", "none");
        case "resolve":
          return classified("gate.resolve", "none");
        default:
          return invalidSemanticAction("pindie_gate");
      }

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
