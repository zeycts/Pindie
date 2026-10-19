import type { ToolEffect } from "./execution-semantics.ts";

/** Core runtime-only facts for handoff/settlement diagnostics. No Policy or persistence. */
export interface RunExecutionCounters {
  readonly toolCalls: number;
  readonly observations: number;
  readonly consequentialCalls: number;
  readonly projectMutationEffectCalls: number;
  readonly verificationCalls: number;
  readonly toolErrors: number;
  readonly deniedCalls: number;
}
const zero = (): RunExecutionCounters => ({ toolCalls: 0, observations: 0, consequentialCalls: 0,
  projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 });
export class RunCounters {
  private counters = zero();
  private readonly calls = new Map<string, "execution" | "memory">();
  reset(): void { this.counters = zero(); this.calls.clear(); }
  recordAuthorizedCall(id: string, effect: ToolEffect): void {
    if (effect.requiredCapability.startsWith("policy.")) return;
    const memory = effect.requiredCapability === "memory.capture";
    this.calls.set(id, memory ? "memory" : "execution");
    if (memory) return;
    const observation = effect.requiredCapability === "observe.project" || effect.requiredCapability === "observe.git";
    this.counters = { ...this.counters, toolCalls: this.counters.toolCalls + 1,
      observations: this.counters.observations + Number(observation),
      consequentialCalls: this.counters.consequentialCalls + Number(!observation),
      projectMutationEffectCalls: this.counters.projectMutationEffectCalls + Number(effect.projectMutation !== "none"),
      verificationCalls: this.counters.verificationCalls + Number(effect.requiredCapability === "verification.record") };
  }
  recordDeniedCall(effect: ToolEffect): void {
    if (effect.requiredCapability.startsWith("policy.") || effect.requiredCapability === "memory.capture") return;
    this.counters = { ...this.counters, deniedCalls: this.counters.deniedCalls + 1 };
  }
  recordToolResult(id: string, isError: boolean): "execution" | "memory" | null {
    const kind = this.calls.get(id) ?? null;
    this.calls.delete(id);
    if (kind === "execution" && isError) this.counters = { ...this.counters, toolErrors: this.counters.toolErrors + 1 };
    return kind;
  }
  get execution(): RunExecutionCounters { return Object.freeze({ ...this.counters }); }
}
