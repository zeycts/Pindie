import { canonicalJson, learningFingerprint } from "./learning-v1-contract.ts";
import { validateExecutionLease, type ExecutionLeaseV1 } from "./evaluation-execution-lease.ts";

export interface ExecutionLeaseStalePolicyV1 {
  readonly schemaVersion: 1;
  readonly staleAfterMs: number;
  readonly maxClockUncertaintyMs: number;
}
/** Bounded comparison is an explicit caller-supplied clock-domain assumption, not a liveness proof. */
export interface ExecutionLeaseClockSampleV1 {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly comparison: { readonly kind: "bounded"; readonly uncertaintyMs: number } | { readonly kind: "untrusted" };
}
export interface ExecutionLeaseAssessmentClock {
  now(): ExecutionLeaseClockSampleV1;
}
/** C4 cannot confirm owner cessation or determine execution lifecycle applicability. */
export interface ExecutionLeaseAssessmentV1 {
  readonly schemaVersion: 1;
  readonly state: "ACTIVE" | "STALE_CANDIDATE" | "UNKNOWN";
  readonly reason: "within-threshold" | "beyond-threshold" | "invalid-lease" | "invalid-policy" | "invalid-clock" |
    "untrusted-clock" | "unsupported-clock-uncertainty" | "future-heartbeat" | "unsafe-age";
  readonly lease: ExecutionLeaseV1 | null;
  readonly leaseFingerprint: string | null;
  readonly policy: ExecutionLeaseStalePolicyV1 | null;
  readonly clock: ExecutionLeaseClockSampleV1 | null;
  readonly minimumAgeMs: number | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected.split(",").sort().join();
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
function freeze<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}
const detach = <T>(v: T): T => freeze(JSON.parse(canonicalJson(v)));
export function validateExecutionLeaseStalePolicy(v: unknown): v is ExecutionLeaseStalePolicyV1 {
  return object(v) && keys(v, "schemaVersion,staleAfterMs,maxClockUncertaintyMs") && v.schemaVersion === 1 &&
    uint(v.staleAfterMs) && v.staleAfterMs > 0 && uint(v.maxClockUncertaintyMs);
}
export function validateExecutionLeaseClockSample(v: unknown): v is ExecutionLeaseClockSampleV1 {
  try {
    return object(v) && keys(v, "schemaVersion,observedAt,comparison") && v.schemaVersion === 1 && time(v.observedAt) && object(v.comparison) &&
      (v.comparison.kind === "untrusted" ? keys(v.comparison, "kind") : v.comparison.kind === "bounded" &&
        keys(v.comparison, "kind,uncertaintyMs") && uint(v.comparison.uncertaintyMs));
  } catch { return false; }
}

/** Pure metadata observation: explicit sampled time, no stores, system clock or execution capabilities. */
export function assessExecutionLeaseFreshness(leaseInput: unknown, policyInput: unknown, clockInput: unknown): ExecutionLeaseAssessmentV1 {
  let lease: ExecutionLeaseV1 | null = null, policy: ExecutionLeaseStalePolicyV1 | null = null, clock: ExecutionLeaseClockSampleV1 | null = null;
  const result = (state: ExecutionLeaseAssessmentV1["state"], reason: ExecutionLeaseAssessmentV1["reason"], minimumAgeMs: number | null = null): ExecutionLeaseAssessmentV1 =>
    freeze({ schemaVersion: 1, state, reason, lease, leaseFingerprint: lease === null ? null : learningFingerprint(lease), policy, clock, minimumAgeMs });
  // Validate originals before JSON detachment; unknown keys/capabilities may not disappear in serialization.
  try {
    if (!validateExecutionLease(leaseInput)) return result("UNKNOWN", "invalid-lease");
    const copy = detach(leaseInput);
    if (!validateExecutionLease(copy)) return result("UNKNOWN", "invalid-lease");
    lease = copy;
  }
  catch { return result("UNKNOWN", "invalid-lease"); }
  try {
    if (!validateExecutionLeaseStalePolicy(policyInput)) return result("UNKNOWN", "invalid-policy");
    const copy = detach(policyInput);
    if (!validateExecutionLeaseStalePolicy(copy)) return result("UNKNOWN", "invalid-policy");
    policy = copy;
  }
  catch { return result("UNKNOWN", "invalid-policy"); }
  try {
    if (!validateExecutionLeaseClockSample(clockInput)) return result("UNKNOWN", "invalid-clock");
    const copy = detach(clockInput);
    if (!validateExecutionLeaseClockSample(copy)) return result("UNKNOWN", "invalid-clock");
    clock = copy;
  }
  catch { return result("UNKNOWN", "invalid-clock"); }
  if (clock.comparison.kind === "untrusted") return result("UNKNOWN", "untrusted-clock");
  const uncertainty = clock.comparison.uncertaintyMs;
  if (uncertainty > policy.maxClockUncertaintyMs) return result("UNKNOWN", "unsupported-clock-uncertainty");
  const age = Date.parse(clock.observedAt) - Date.parse(lease.heartbeatAt), minimumAge = age - uncertainty;
  if (!Number.isSafeInteger(age) || !Number.isSafeInteger(minimumAge)) return result("UNKNOWN", "unsafe-age");
  if (age < -uncertainty) return result("UNKNOWN", "future-heartbeat");
  return minimumAge > policy.staleAfterMs ? result("STALE_CANDIDATE", "beyond-threshold", minimumAge) : result("ACTIVE", "within-threshold", minimumAge);
}

/** Injected clock adapter; samples once, freezes input first, and has no default system clock. */
export function assessExecutionLeaseWithClock(lease: unknown, policy: unknown, clock: ExecutionLeaseAssessmentClock): ExecutionLeaseAssessmentV1 {
  const prepared = assessExecutionLeaseFreshness(lease, policy, null);
  if (prepared.lease === null || prepared.policy === null) return prepared;
  let sampled: unknown;
  try { sampled = clock.now(); } catch { sampled = null; }
  return assessExecutionLeaseFreshness(prepared.lease, prepared.policy, sampled);
}
