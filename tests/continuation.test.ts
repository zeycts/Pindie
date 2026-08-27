import assert from "node:assert/strict";
import test from "node:test";

import {
  PINDIE_CONTINUATION_PROBE_MESSAGE,
  PINDIE_CONTINUATION_PROBE_TYPE,
  isPindieContinuationProbeMessage,
  shouldProbeContinuation,
  type ContinuationProbeFacts,
} from "../src/continuation.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { TaskStatus, VerificationStatus } from "../src/state.ts";

const normalFacts: ContinuationProbeFacts = {
  probeAlreadyAttempted: false,
  hasPendingMessages: false,
  stoppedNormally: true,
};

function snapshot(
  authority: "coherent" | "stale",
  taskStatus: TaskStatus,
  verificationStatus: VerificationStatus | "none" = "pending",
): SemanticSnapshot {
  const available = {
    taskStatus,
    verificationStatus,
    hasBlockers: taskStatus === "blocked",
    hasQuestions: false,
    completionReady: false,
  };
  return authority === "stale"
    ? { authority, ...available }
    : {
        authority,
        ...available,
        taskRelation: taskStatus === "idle" ? "none" : "preexisting_untouched",
        completionRelation: taskStatus === "done"
          ? "completed_before_run"
          : "not_completed",
        gateRelation: taskStatus === "waiting_human"
          ? "existed_before_run"
          : "none",
      };
}

test("C01-C11 continuation eligibility uses only the approved semantic and runtime facts", () => {
  assert.equal(
    shouldProbeContinuation(snapshot("coherent", "active"), normalFacts),
    true,
  );

  for (const taskStatus of [
    "idle",
    "done",
    "blocked",
    "waiting_human",
  ] as const) {
    assert.equal(
      shouldProbeContinuation(snapshot("coherent", taskStatus), normalFacts),
      false,
      taskStatus,
    );
  }

  assert.equal(
    shouldProbeContinuation(snapshot("stale", "active"), normalFacts),
    false,
  );
  assert.equal(
    shouldProbeContinuation({ authority: "unavailable" }, normalFacts),
    false,
  );
  assert.equal(
    shouldProbeContinuation(snapshot("coherent", "active"), {
      ...normalFacts,
      probeAlreadyAttempted: true,
    }),
    false,
  );
  assert.equal(
    shouldProbeContinuation(snapshot("coherent", "active"), {
      ...normalFacts,
      hasPendingMessages: true,
    }),
    false,
  );
  assert.equal(
    shouldProbeContinuation(snapshot("coherent", "active"), {
      ...normalFacts,
      stoppedNormally: false,
    }),
    false,
  );
});

test("C12 verification status does not independently alter active continuation eligibility", () => {
  for (const verificationStatus of [
    "pending",
    "stale",
    "failed",
    "passed",
  ] as const) {
    assert.equal(
      shouldProbeContinuation(
        snapshot("coherent", "active", verificationStatus),
        normalFacts,
      ),
      true,
      verificationStatus,
    );
  }
});

test("continuation eligibility equals the exact five-condition conjunction", () => {
  const booleans = [false, true] as const;
  for (const coherent of booleans) {
    for (const active of booleans) {
      for (const probeAlreadyAttempted of booleans) {
        for (const hasPendingMessages of booleans) {
          for (const stoppedNormally of booleans) {
            const semanticSnapshot = snapshot(
              coherent ? "coherent" : "stale",
              active ? "active" : "idle",
            );
            const facts = {
              probeAlreadyAttempted,
              hasPendingMessages,
              stoppedNormally,
            };
            assert.equal(
              shouldProbeContinuation(semanticSnapshot, facts),
              coherent &&
                active &&
                !probeAlreadyAttempted &&
                !hasPendingMessages &&
                stoppedNormally,
              JSON.stringify({ coherent, active, ...facts }),
            );
          }
        }
      }
    }
  }
});

test("the continuation probe is the exact thin latest-user-intent question", () => {
  assert.equal(
    PINDIE_CONTINUATION_PROBE_MESSAGE,
    "Pindie continuation probe — runtime-generated metadata, not user intent or a new request. Do not treat this probe as changing or extending the user's request. Re-evaluate the latest actual user intent. If it still calls for consequential execution, continue using the currently available actions. Otherwise return control without further consequential project action or restating the prior response.",
  );
  for (const required of [
    /runtime-generated/i,
    /not user intent/i,
    /not .*new request/i,
    /latest actual user intent/i,
    /consequential execution/i,
    /otherwise return control/i,
  ]) {
    assert.match(PINDIE_CONTINUATION_PROBE_MESSAGE, required);
  }
  for (const obsolete of [
    /pindie_task_replace/i,
    /Human Gate/i,
    /nextIntent/i,
    /smallest safe/i,
    /record blocker/i,
    /re-observe/i,
    /verified completion/i,
  ]) {
    assert.doesNotMatch(PINDIE_CONTINUATION_PROBE_MESSAGE, obsolete);
  }
});

test("continuation probes are identified structurally, independent of content", () => {
  assert.equal(isPindieContinuationProbeMessage({
    role: "custom",
    customType: PINDIE_CONTINUATION_PROBE_TYPE,
    content: "historical content can differ",
  }), true);
  assert.equal(isPindieContinuationProbeMessage({
    role: "custom",
    customType: "other",
  }), false);
  assert.equal(isPindieContinuationProbeMessage({
    role: "user",
    customType: PINDIE_CONTINUATION_PROBE_TYPE,
  }), false);
  for (const malformed of [null, undefined, 0, "probe", {}, { role: "custom" }]) {
    assert.equal(isPindieContinuationProbeMessage(malformed), false);
  }
});
