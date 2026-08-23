import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getVerificationStatus, type PindieState } from "./state.ts";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export type ReasoningMode = "auto" | "fixed";

export interface ReasoningSnapshot {
  mode: ReasoningMode;
  requestedLevel: ThinkingLevel;
  effectiveLevel: ThinkingLevel;
}

export const FIXED_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export function isFixedThinkingLevel(level: string): level is typeof FIXED_THINKING_LEVELS[number] {
  return FIXED_THINKING_LEVELS.includes(level as typeof FIXED_THINKING_LEVELS[number]);
}

export class ReasoningController {
  private current: ReasoningSnapshot;

  /** The initial effective level is a pre-runtime placeholder; session_start synchronizes Pi authority. */
  constructor() {
    this.current = { mode: "auto", requestedLevel: "medium", effectiveLevel: "medium" };
  }

  get snapshot(): ReasoningSnapshot {
    return { ...this.current };
  }

  reset(effectiveLevel: ThinkingLevel): void {
    this.current = { mode: "auto", requestedLevel: "medium", effectiveLevel };
  }

  synchronizeEffective(effectiveLevel: ThinkingLevel): void {
    this.current.effectiveLevel = effectiveLevel;
  }

  setAuto(): void {
    this.current.mode = "auto";
    this.current.requestedLevel = "medium";
  }

  setFixed(level: ThinkingLevel): void {
    this.current.mode = "fixed";
    this.current.requestedLevel = level;
  }

  beforeAgentStart(): void {
    if (this.current.mode === "auto") this.current.requestedLevel = "medium";
  }

  decideNext(state: PindieState, toolResults: readonly { toolName: string; isError: boolean }[]): boolean {
    if (this.current.mode === "fixed" || toolResults.length === 0) return false;

    const verification = state.task ? getVerificationStatus(state.task) : "pending";
    if (toolResults.some((result) => result.isError) || verification === "failed") {
      this.current.requestedLevel = "high";
    } else if (verification === "passed") {
      this.current.requestedLevel = "low";
    } else if (this.current.requestedLevel === "high") {
      this.current.requestedLevel = "medium";
    } else if (toolResults.some((result) =>
      !result.isError && (result.toolName === "edit" || result.toolName === "write"),
    )) {
      this.current.requestedLevel = "low";
    } else {
      this.current.requestedLevel = "medium";
    }
    return true;
  }
}
