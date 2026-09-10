export const PINDIE_TOOL_LIVENESS_TIMEOUT_MS = 10_000;

export interface BoundedOperationOptions<T> {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
}

export class PindieLivenessTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "PindieLivenessTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export class PindieLivenessAbortError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`${label} was aborted.`);
    this.name = "PindieLivenessAbortError";
    this.label = label;
  }
}

/**
 * Bound the caller's wait without depending on the operation honoring abort.
 * The inner Promise remains observed after settlement so a late rejection is
 * consumed, while its value can never change the already-settled result.
 */
export function runBoundedOperation<T>(
  options: BoundedOperationOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const abort = (): void => {
      if (settled) return;
      controller.abort();
      settle(() => reject(new PindieLivenessAbortError(options.label)));
    };
    const timeout = (): void => {
      if (settled) return;
      controller.abort();
      settle(() => reject(new PindieLivenessTimeoutError(options.label, options.timeoutMs)));
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(timeout, options.timeoutMs);
    if (options.signal?.aborted) {
      abort();
      return;
    }

    Promise.resolve()
      .then(() => {
        if (settled) return undefined;
        return options.run(controller.signal);
      })
      .then(
        (value) => settle(() => resolve(value as T)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}
