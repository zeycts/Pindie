export interface ConsumptionMetrics {
  readonly durationMs: number;
  readonly cost: number;
}

interface TaskMetricsEpoch {
  projectRoot: string;
  taskBinding: string;
  finished: ConsumptionMetrics;
  finalized: ConsumptionMetrics | null;
}

interface TaskRunContribution {
  baseline: ConsumptionMetrics;
  settled: boolean;
}

interface AutomaticRolloverLease {
  projectRoot: string;
  taskBinding: string;
  sourceSessionId: string;
}

function safeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function metrics(durationMs: number, cost: number): ConsumptionMetrics {
  const safeCost = safeMetric(cost);
  const roundedCost = Math.round(safeCost * 1_000_000_000_000) /
    1_000_000_000_000;
  return {
    durationMs: safeMetric(durationMs),
    cost: Number.isFinite(roundedCost) ? roundedCost : safeCost,
  };
}

function add(
  first: ConsumptionMetrics,
  second: ConsumptionMetrics,
): ConsumptionMetrics {
  return metrics(
    first.durationMs + second.durationMs,
    first.cost + second.cost,
  );
}

function contribution(
  current: ConsumptionMetrics,
  baseline: ConsumptionMetrics,
): ConsumptionMetrics {
  return metrics(
    safeMetric(current.durationMs) - safeMetric(baseline.durationMs),
    safeMetric(current.cost) - safeMetric(baseline.cost),
  );
}

/**
 * Process-local cumulative consumption for one Task execution epoch.
 *
 * RunTimer and RunCostTracker remain the measurement sources. This tracker
 * stores only finished contributions plus the current Run's subtraction
 * baseline; it owns no clock, ticker, Session history, or durable State.
 */
export class TaskMetricsTracker {
  private epoch: TaskMetricsEpoch | null = null;
  private currentRun: TaskRunContribution | null = null;
  private rolloverLease: AutomaticRolloverLease | null = null;

  get currentRunBelongsToTask(): boolean {
    return this.epoch !== null && this.currentRun !== null;
  }

  /** Starts a fresh Task epoch at an exact point within the current Run. */
  startTask(
    projectRoot: string,
    taskBinding: string,
    baseline: ConsumptionMetrics,
  ): void {
    this.rolloverLease = null;
    this.epoch = {
      projectRoot,
      taskBinding,
      finished: metrics(0, 0),
      finalized: null,
    };
    this.currentRun = {
      baseline: metrics(baseline.durationMs, baseline.cost),
      settled: false,
    };
  }

  /**
   * Binds a fresh Run to an unfinished coherent Task. Matching epochs continue;
   * unknown or incompatible bindings fail closed into a fresh zero epoch.
   */
  startRunForTask(
    projectRoot: string,
    taskBinding: string,
    baseline: ConsumptionMetrics,
  ): void {
    this.rolloverLease = null;
    if (
      this.epoch === null ||
      this.epoch.finalized !== null ||
      this.epoch.projectRoot !== projectRoot ||
      this.epoch.taskBinding !== taskBinding
    ) {
      this.epoch = {
        projectRoot,
        taskBinding,
        finished: metrics(0, 0),
        finalized: null,
      };
    }
    this.currentRun = {
      baseline: metrics(baseline.durationMs, baseline.cost),
      settled: false,
    };
  }

  /** Marks this Run as unrelated without altering a previously finalized Task. */
  startRunWithoutTask(): void {
    this.currentRun = null;
    this.rolloverLease = null;
  }

  /** Keeps the current epoch while updating the mutable Task Contract binding. */
  refineTask(projectRoot: string, taskBinding: string): void {
    if (
      this.epoch === null ||
      this.currentRun === null ||
      this.epoch.projectRoot !== projectRoot ||
      this.epoch.finalized !== null
    ) return;
    this.epoch.taskBinding = taskBinding;
  }

  snapshot(current: ConsumptionMetrics): ConsumptionMetrics | null {
    if (this.epoch === null || this.currentRun === null) return null;
    if (this.epoch.finalized !== null) return this.epoch.finalized;
    if (this.currentRun.settled) return this.epoch.finished;
    return add(
      this.epoch.finished,
      contribution(current, this.currentRun.baseline),
    );
  }

  /** Freezes Task consumption at the successful completion transition. */
  completeTask(current: ConsumptionMetrics): ConsumptionMetrics | null {
    const total = this.snapshot(current);
    if (total === null || this.epoch === null || this.currentRun === null) {
      return null;
    }
    this.epoch.finished = total;
    this.epoch.finalized = total;
    this.currentRun = {
      baseline: metrics(current.durationMs, current.cost),
      settled: true,
    };
    this.rolloverLease = null;
    return total;
  }

  /** Adds this Run exactly once while preserving its final status presentation. */
  settleRun(current: ConsumptionMetrics): ConsumptionMetrics | null {
    if (this.epoch === null || this.currentRun === null) return null;
    if (this.epoch.finalized !== null || this.currentRun.settled) {
      return this.snapshot(current);
    }
    this.epoch.finished = this.snapshot(current)!;
    this.currentRun = {
      baseline: metrics(current.durationMs, current.cost),
      settled: true,
    };
    return this.epoch.finished;
  }

  /**
   * Arms one Host-owned automatic replacement. The fresh extension instance
   * must consume this exact project/Task binding before metrics can survive.
   */
  prepareAutomaticRollover(
    sourceSessionId: string,
    taskBinding: string,
  ): boolean {
    if (
      this.epoch === null ||
      this.epoch.finalized !== null ||
      this.epoch.taskBinding !== taskBinding ||
      sourceSessionId.trim() === ""
    ) {
      this.rolloverLease = null;
      return false;
    }
    this.rolloverLease = {
      projectRoot: this.epoch.projectRoot,
      taskBinding,
      sourceSessionId,
    };
    return true;
  }

  /**
   * Adopts metrics only for the exact pending automatic rollover. Every other
   * Session/project boundary drops process-local Task telemetry fail closed.
   */
  enterSession(projectRoot: string, taskBinding: string | null): boolean {
    const lease = this.rolloverLease;
    this.rolloverLease = null;
    this.currentRun = null;
    if (
      lease !== null &&
      this.epoch !== null &&
      this.epoch.finalized === null &&
      taskBinding !== null &&
      lease.projectRoot === projectRoot &&
      lease.taskBinding === taskBinding &&
      this.epoch.projectRoot === projectRoot &&
      this.epoch.taskBinding === taskBinding
    ) {
      return true;
    }
    this.epoch = null;
    return false;
  }

  cancelAutomaticRollover(): void {
    this.rolloverLease = null;
  }

  reset(): void {
    this.epoch = null;
    this.currentRun = null;
    this.rolloverLease = null;
  }
}
