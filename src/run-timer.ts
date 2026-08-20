export interface RunTiming {
  durationMs: number;
  active: boolean;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface RunTimerScheduler {
  schedule(callback: () => void, intervalMs: number): IntervalHandle;
  cancel(handle: IntervalHandle): void;
}

export interface RunTimerOptions {
  now?: () => number;
  scheduler?: RunTimerScheduler;
}

const DEFAULT_SCHEDULER: RunTimerScheduler = {
  schedule: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: (handle) => clearInterval(handle),
};

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(
    0,
    Math.floor(Number.isFinite(durationMs) ? durationMs / 1_000 : 0),
  );
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Runtime-only timing for one Pi Agent Run. */
export class RunTimer {
  private readonly now: () => number;
  private readonly scheduler: RunTimerScheduler;
  private startedAt: number | null = null;
  private finalizedDurationMs: number | null = null;
  private ticker: IntervalHandle | null = null;
  private onUpdate: ((timing: RunTiming) => void) | null = null;

  constructor(options: RunTimerOptions = {}) {
    this.now = options.now ?? performance.now.bind(performance);
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  }

  get active(): boolean {
    return this.startedAt !== null;
  }

  get durationMs(): number | null {
    if (this.startedAt === null) return this.finalizedDurationMs;
    return Math.max(0, this.now() - this.startedAt);
  }

  start(onUpdate?: (timing: RunTiming) => void): void {
    this.clearTicker();
    this.startedAt = this.now();
    this.finalizedDurationMs = null;
    this.onUpdate = onUpdate ?? null;
    this.publish();

    if (this.onUpdate) {
      this.ticker = this.scheduler.schedule(() => this.publish(), 1_000);
    }
  }

  finish(): number | null {
    if (this.startedAt === null) return this.finalizedDurationMs;

    this.finalizedDurationMs = Math.max(0, this.now() - this.startedAt);
    this.startedAt = null;
    this.clearTicker();
    this.publish();
    this.onUpdate = null;
    return this.finalizedDurationMs;
  }

  reset(): void {
    this.clearTicker();
    this.startedAt = null;
    this.finalizedDurationMs = null;
    this.onUpdate = null;
  }

  private clearTicker(): void {
    if (this.ticker === null) return;
    this.scheduler.cancel(this.ticker);
    this.ticker = null;
  }

  private publish(): void {
    const durationMs = this.durationMs;
    if (durationMs === null) return;
    this.onUpdate?.({ durationMs, active: this.active });
  }
}
