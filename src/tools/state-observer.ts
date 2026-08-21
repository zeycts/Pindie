/**
 * Observers run only after a State transition has committed. Their failures
 * must not change the already-authoritative semantic tool result.
 */
export function notifyStateChangeBestEffort(
  onStateChange?: () => void,
): void {
  try {
    onStateChange?.();
  } catch {
    // Status presentation is best-effort.
  }
}
