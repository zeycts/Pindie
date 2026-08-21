export type RunActivity =
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "updating"
  | "working";

function activityForTool(toolName: string): RunActivity {
  switch (toolName) {
    case "read":
      return "reading";
    case "edit":
    case "write":
      return "editing";
    case "bash":
      return "running";
    case "pindie_state":
    case "pindie_gate":
      return "updating";
    default:
      return "working";
  }
}

/** Runtime-only observation of public Pi tool execution lifecycle events. */
export class RunActivityTracker {
  private activeRun = false;
  private readonly activeTools = new Map<string, RunActivity>();

  get activity(): RunActivity | null {
    if (!this.activeRun) return null;
    if (this.activeTools.size === 0) return "thinking";

    const activities = new Set(this.activeTools.values());
    return activities.size === 1 ? activities.values().next().value! : "working";
  }

  start(): void {
    this.activeRun = true;
    this.activeTools.clear();
  }

  toolExecutionStart(toolCallId: string, toolName: string): void {
    if (!this.activeRun) return;
    this.activeTools.set(toolCallId, activityForTool(toolName));
  }

  toolExecutionEnd(toolCallId: string): void {
    this.activeTools.delete(toolCallId);
  }

  settle(): void {
    this.activeRun = false;
    this.activeTools.clear();
  }

  reset(): void {
    this.settle();
  }
}
