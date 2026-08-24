export const RUN_ACTIVITY_LINGER_MS = 250;

export type RunActivity =
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "updating"
  | "working";

export interface RunActivityTrackerOptions {
  now?: () => number;
  lingerMs?: number;
}

function activityForTool(toolName: string): RunActivity {
  switch (toolName) {
    case "read":
    case "grep":
    case "find":
    case "ls":
    case "pindie_git_observe":
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
  private lingeringActivity: RunActivity | null = null;
  private lingerUntil: number | null = null;
  private readonly now: () => number;
  private readonly lingerMs: number;

  constructor(options: RunActivityTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lingerMs = options.lingerMs ?? RUN_ACTIVITY_LINGER_MS;
  }

  get activity(): RunActivity | null {
    if (!this.activeRun) return null;
    if (this.activeTools.size > 0) return this.actualActivity();
    this.clearExpiredLinger();
    return this.lingeringActivity ?? "thinking";
  }

  /** Delay until visible linger becomes thinking, or no presentation transition. */
  get nextPresentationChangeInMs(): number | null {
    if (!this.activeRun || this.activeTools.size > 0) return null;
    this.clearExpiredLinger();
    if (this.lingerUntil === null) return null;
    return this.lingerUntil - this.now();
  }

  start(): void {
    this.activeRun = true;
    this.activeTools.clear();
    this.clearLinger();
  }

  toolExecutionStart(toolCallId: string, toolName: string): void {
    if (!this.activeRun) return;
    this.activeTools.set(toolCallId, activityForTool(toolName));
    this.clearLinger();
  }

  toolExecutionEnd(toolCallId: string): void {
    if (!this.activeRun) return;
    if (!this.activeTools.has(toolCallId)) return;

    const visibleActivity = this.actualActivity();
    this.activeTools.delete(toolCallId);
    if (this.activeTools.size === 0) {
      this.lingeringActivity = visibleActivity;
      this.lingerUntil = this.now() + this.lingerMs;
    }
  }

  settle(): void {
    this.activeRun = false;
    this.activeTools.clear();
    this.clearLinger();
  }

  reset(): void {
    this.settle();
  }

  private actualActivity(): RunActivity {
    const activities = new Set(this.activeTools.values());
    return activities.size === 1 ? activities.values().next().value! : "working";
  }

  private clearExpiredLinger(): void {
    if (this.lingerUntil !== null && this.now() >= this.lingerUntil) {
      this.clearLinger();
    }
  }

  private clearLinger(): void {
    this.lingeringActivity = null;
    this.lingerUntil = null;
  }
}
