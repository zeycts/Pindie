import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "./liveness.ts";

export class PindieLearningArtifactPublicationUncertainError extends Error {
  readonly label: string;

  constructor(label: string, cause?: unknown) {
    const outcome = cause instanceof PindieLivenessTimeoutError
      ? "timed out"
      : "was aborted";
    super(
      `${label} Candidate publication ${outcome} after publication started; ` +
      "the durable Candidate outcome is currently uncertain, and the current learning publication attempt must not be retried automatically.",
    );
    this.name = "PindieLearningArtifactPublicationUncertainError";
    this.label = label;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface ImmutableLearningArtifactPublicationOptions<T> {
  /** Human-readable Candidate type used in liveness and reconciliation errors. */
  readonly label: string;
  /** Pi's caller signal. */
  readonly signal?: AbortSignal;
  /** Test seam; production callers use the shared Slice A deadline. */
  readonly timeoutMs?: number;
  /** Immutable create-without-replacement operation. */
  readonly save: (signal: AbortSignal) => Promise<void>;
  /** Exact read-back for the preallocated immutable identity. */
  readonly read: (signal: AbortSignal) => Promise<T | null>;
  /** Validate that a read-back artifact is exactly the intended artifact. */
  readonly isExact: (artifact: T) => boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Publish one immutable learning artifact without allowing an uncooperative
 * save or reconciliation read to hold the Agent Run forever.
 *
 * Lease/runtime finalization deliberately remains outside this helper. Once a
 * save has begun, a liveness boundary is an uncertain publication and callers
 * must seal their one-shot learning attempt rather than retry blindly.
 */
export async function publishImmutableLearningArtifact<T>(
  options: ImmutableLearningArtifactPublicationOptions<T>,
): Promise<void> {
  let publicationStarted = false;

  try {
    await runBoundedOperation({
      label: `${options.label} publication`,
      timeoutMs: options.timeoutMs ?? PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
      signal: options.signal,
      run: async (operationSignal) => {
        // This check is intentionally before the save invocation. An already
        // aborted caller has not crossed the publication frontier.
        if (operationSignal.aborted) {
          throw new PindieLivenessAbortError(`${options.label} publication`);
        }
        publicationStarted = true;

        try {
          await options.save(operationSignal);
          return;
        } catch (saveError) {
          // Do not start a late reconciliation read after the bounded caller
          // has already been aborted or timed out.
          if (operationSignal.aborted) {
            throw new PindieLivenessAbortError(`${options.label} publication`);
          }

          let existing: T | null;
          try {
            existing = await options.read(operationSignal);
          } catch (readError) {
            if (operationSignal.aborted) {
              throw new PindieLivenessAbortError(`${options.label} publication`);
            }
            throw new Error(
              `${options.label} persistence/reconciliation failed after save error: ` +
              `could not read Candidate to establish durable state (${errorMessage(readError)}; ` +
              `original save error: ${errorMessage(saveError)}).`,
            );
          }

          // A missing exact artifact proves that the immutable save did not
          // publish this identity; preserve the original retryable failure.
          if (existing === null) throw saveError;

          let exact: boolean;
          try {
            exact = options.isExact(existing);
          } catch (validationError) {
            throw new Error(
              `${options.label} persistence/reconciliation failed: existing Candidate ` +
              `is not a valid immutable artifact (${errorMessage(validationError)}; ` +
              `original save error: ${errorMessage(saveError)}).`,
            );
          }
          if (!exact) {
            throw new Error(
              `${options.label} persistence/reconciliation failed closed: existing Candidate ` +
              "does not exactly match the intended immutable artifact.",
            );
          }
          // The exact artifact is already durable. Reconcile success without
          // issuing a second save for the same immutable identity.
        }
      },
    });
  } catch (error) {
    if (
      (error instanceof PindieLivenessTimeoutError || error instanceof PindieLivenessAbortError) &&
      publicationStarted
    ) {
      throw new PindieLearningArtifactPublicationUncertainError(options.label, error);
    }
    throw error;
  }
}
