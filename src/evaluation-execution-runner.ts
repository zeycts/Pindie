import { canonicalJson } from "./learning-v1-contract.ts";
import { evaluationPacketRef, validateEvaluationPacket } from "./evaluation-contract.ts";
import type { EvaluationPacketStore } from "./evaluation-packet-store.ts";
import { transitionEvaluationRun, validateEvaluationRun, type EvaluationRunV1 } from "./evaluation-run.ts";
import { matchesEvaluationOutputContext, prepareEvaluationInput, validateEvaluator, type EvaluatorV1, type EvaluationOutputV1 } from "./evaluator-contract.ts";

/** Operational outcome only. Snapshots are returned, never published by B1. */
export type EvaluationExecutionOutcomeV1 = {
  readonly schemaVersion: 1;
  readonly running: EvaluationRunV1 & { readonly status: "running" };
} & (
  | { readonly run: EvaluationRunV1 & { readonly status: "completed" }; readonly output: EvaluationOutputV1 }
  | { readonly run: EvaluationRunV1 & { readonly status: "failed" }; readonly output?: never }
);
export interface ExecutionRunner {
  execute(run: EvaluationRunV1): Promise<EvaluationExecutionOutcomeV1>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const detach = <T>(value: T): T => freeze(JSON.parse(canonicalJson(value)));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Standalone invocation seam, not a sandbox or durable execution orchestrator. */
export function createExecutionRunner(options: {
  packets: Pick<EvaluationPacketStore, "get">;
  /** Registration is local to this runner; exact name/version must match the run. */
  evaluator: EvaluatorV1;
  /** Operational clock, injected for reproducible metadata; never derived from observations. */
  now?: () => string;
}): ExecutionRunner {
  if (!validateEvaluator(options.evaluator)) throw new Error("Invalid registered Evaluator.");
  const evaluator = options.evaluator;
  const identity = detach(evaluator.identity), evaluate = evaluator.evaluate;
  // Do not bind `this` to a caller object carrying stores or other capabilities.
  const receiver: EvaluatorV1 = Object.freeze({ schemaVersion: 1, identity, evaluate });
  const packets = options.packets, now = options.now ?? (() => new Date().toISOString());
  return Object.freeze({
    async execute(input: EvaluationRunV1): Promise<EvaluationExecutionOutcomeV1> {
      if (!validateEvaluationRun(input) || input.status !== "created") throw new Error("ExecutionRunner requires a valid created EvaluationRun.");
      const created = detach(input);
      if (!same(created.evaluator, identity)) throw new Error("EvaluationRun does not match registered Evaluator.");
      const running = detach(transitionEvaluationRun(created, "running", now())) as EvaluationExecutionOutcomeV1["running"];
      const failed = (code: string, message: string, at = now()): EvaluationExecutionOutcomeV1 => freeze({ schemaVersion: 1, running,
        run: detach(transitionEvaluationRun(running, "failed", at, { code, message })) as EvaluationRunV1 & { status: "failed" } });
      let loaded: unknown;
      try { loaded = await packets.get(running.packetRef); }
      catch { return failed("PACKET_LOAD_FAILED", "Exact EvaluationPacket could not be loaded."); }
      let packet: unknown;
      try {
        if (!validateEvaluationPacket(loaded)) throw new Error("Invalid EvaluationPacket.");
        packet = detach(loaded);
      }
      catch { return failed("INVALID_PACKET", "EvaluationPacket validation failed."); }
      if (!validateEvaluationPacket(packet)) return failed("INVALID_PACKET", "EvaluationPacket validation failed.");
      if (!same(evaluationPacketRef(packet), running.packetRef)) return failed("PACKET_BINDING_MISMATCH", "EvaluationPacket does not match the exact run binding.");
      let prepared: ReturnType<typeof prepareEvaluationInput>;
      try { prepared = prepareEvaluationInput(packet, running); }
      catch { return failed("INVALID_INPUT", "Evaluation input preparation failed."); }
      let raw: unknown;
      try { raw = await evaluate.call(receiver, prepared.packet, prepared.context); }
      catch { return failed("EVALUATOR_EXCEPTION", "Evaluator invocation failed."); }
      let output: EvaluationOutputV1;
      try {
        if (!matchesEvaluationOutputContext(raw, prepared.context)) throw new Error("Invalid Evaluator output.");
        output = detach(raw as EvaluationOutputV1);
        if (!matchesEvaluationOutputContext(output, prepared.context)) throw new Error("Invalid detached Evaluator output.");
      } catch { return failed("INVALID_OUTPUT", "Evaluator output validation or exact binding failed."); }
      const completedAt = now();
      // The evaluator cannot claim completion later than the observed invocation boundary.
      if (Date.parse(output.execution.completedAt) > Date.parse(completedAt)) {
        return failed("INVALID_OUTPUT", "Evaluator completion exceeds the runner completion time.", completedAt);
      }
      return freeze({ schemaVersion: 1, running, run: detach(transitionEvaluationRun(running, "completed", completedAt)) as EvaluationRunV1 & { status: "completed" }, output });
    },
  });
}
