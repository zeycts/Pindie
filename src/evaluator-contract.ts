import { canonicalJson, UUID_V4 } from "./learning-v1-contract.ts";
import { evaluationPacketRef, validateEvaluationPacket, validateEvaluationRef, type EvaluationPacket } from "./evaluation-contract.ts";
import { validateEvaluationRun, type EvaluationPacketRef, type EvaluationRunV1 } from "./evaluation-run.ts";

export interface EvaluatorIdentityV1 { readonly name: string; readonly version: string }
/** Capability-free data only, not a runtime, writer or decision authority. */
export interface EvaluationExecutionContextV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly packetRef: EvaluationPacketRef;
  readonly packetFingerprint: string;
  readonly evaluator: EvaluatorIdentityV1;
  readonly execution: { readonly startedAt: string };
}
/** Operational observations only. Not EvaluationResult, a verdict or a trust input. */
export interface EvaluationOutputV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly packetRef: EvaluationPacketRef;
  readonly packetFingerprint: string;
  readonly evaluator: EvaluatorIdentityV1;
  readonly execution: { readonly startedAt: string; readonly completedAt: string };
  readonly observations: readonly string[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}
/** An extension seam only; this foundation never invokes an implementation. */
export interface EvaluatorV1 {
  readonly schemaVersion: 1;
  readonly identity: EvaluatorIdentityV1;
  evaluate(packet: EvaluationPacket, context: EvaluationExecutionContextV1): Promise<EvaluationOutputV1>;
}
export const MAX_EVALUATION_CONTEXT_BYTES = 4096;
export const MAX_EVALUATION_OUTPUT_BYTES = 16_384;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: object, fields: string) => Object.keys(v).sort().join() === fields.split(",").sort().join();
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const identity = (v: unknown): v is EvaluatorIdentityV1 => object(v) && keys(v, "name,version") && text(v.name, 128) && text(v.version, 128);
function binding(v: Record<string, unknown>): boolean {
  return v.schemaVersion === 1 && typeof v.runId === "string" && UUID_V4.test(v.runId) &&
    validateEvaluationRef(v.packetRef, "evaluation-packet") && v.packetFingerprint === v.packetRef.fingerprint && identity(v.evaluator);
}
export function validateEvaluator(v: unknown): v is EvaluatorV1 {
  return object(v) && keys(v, "schemaVersion,identity,evaluate") && v.schemaVersion === 1 && identity(v.identity) && typeof v.evaluate === "function";
}
export function validateEvaluationExecutionContext(v: unknown): v is EvaluationExecutionContextV1 {
  try {
    return object(v) && keys(v, "schemaVersion,runId,packetRef,packetFingerprint,evaluator,execution") && binding(v) &&
      object(v.execution) && keys(v.execution, "startedAt") && time(v.execution.startedAt) &&
      Buffer.byteLength(canonicalJson(v)) <= MAX_EVALUATION_CONTEXT_BYTES;
  } catch { return false; }
}
export function matchesEvaluationExecutionContext(context: unknown, packet: unknown): boolean {
  return validateEvaluationExecutionContext(context) && validateEvaluationPacket(packet) && same(context.packetRef, evaluationPacketRef(packet));
}
export function validateEvaluationOutput(v: unknown): v is EvaluationOutputV1 {
  try {
    return object(v) && keys(v, "schemaVersion,runId,packetRef,packetFingerprint,evaluator,execution,observations,diagnostics") && binding(v) &&
      object(v.execution) && keys(v.execution, "startedAt,completedAt") && time(v.execution.startedAt) && time(v.execution.completedAt) &&
      Date.parse(v.execution.completedAt) >= Date.parse(v.execution.startedAt) &&
      Array.isArray(v.observations) && v.observations.length <= 16 && Array.from(v.observations).every((s) => text(s, 1024)) &&
      Array.isArray(v.diagnostics) && v.diagnostics.length <= 16 && Array.from(v.diagnostics).every((d) => object(d) && keys(d, "code,message") && text(d.code, 128) && text(d.message, 1024)) &&
      Buffer.byteLength(canonicalJson(v)) <= MAX_EVALUATION_OUTPUT_BYTES;
  } catch { return false; }
}
/** A well-shaped output is not enough: exact attempt, packet, evaluator and start must match. */
export function matchesEvaluationOutputContext(output: unknown, context: unknown): boolean {
  if (!validateEvaluationOutput(output) || !validateEvaluationExecutionContext(context)) return false;
  return output.runId === context.runId && same(output.packetRef, context.packetRef) && output.packetFingerprint === context.packetFingerprint &&
    same(output.evaluator, context.evaluator) && output.execution.startedAt === context.execution.startedAt;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Pure preparation only. No store reads, evaluator invocation or lifecycle writes. */
export function prepareEvaluationInput(packet: EvaluationPacket, run: EvaluationRunV1): {
  readonly packet: EvaluationPacket; readonly context: EvaluationExecutionContextV1;
} {
  if (!validateEvaluationPacket(packet) || !validateEvaluationRun(run) || run.schemaVersion !== 1 || run.status !== "running") throw new Error("Invalid Evaluation execution input.");
  const context: EvaluationExecutionContextV1 = { schemaVersion: 1, runId: run.runId, packetRef: run.packetRef, packetFingerprint: run.packetFingerprint,
    evaluator: run.evaluator, execution: { startedAt: run.startedAt! } };
  if (!matchesEvaluationExecutionContext(context, packet)) throw new Error("Mismatched Evaluation execution packet.");
  return freeze(JSON.parse(canonicalJson({ packet, context })));
}
