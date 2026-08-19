import assert from "node:assert/strict";
import test from "node:test";

import {
  PINDIE_CORE_END,
  PINDIE_CORE_POLICY,
  PINDIE_CORE_START,
  injectPindieCore,
  renderPindieCore,
} from "../src/context.ts";
import type { PindieState } from "../src/state.ts";

function verifiedState(): PindieState {
  return {
    task: {
      goal: "Wire Pindie into Pi",
      constraints: ["Preserve Pi's Agent Loop"],
      successCriteria: [{ id: "c1", description: "Extension wiring works" }],
      openLoops: { blockers: [], questions: [], nextIntent: "Run tests" },
      verification: {
        stale: false,
        checks: [
          {
            name: "tests",
            status: "passed",
            covers: ["c1"],
            evidence: "Extension tests passed.",
          },
        ],
      },
      humanGate: null,
      completed: false,
    },
  };
}

test("C01 the Pindie Core Policy is included", () => {
  const block = renderPindieCore(verifiedState());

  assert.match(block, /Pindie Core Policy/);
  assert.match(block, /Latest user intent and observed project reality/);
  assert.ok(block.includes(PINDIE_CORE_POLICY));
});

test("D04 Core Policy explains durable success-criterion semantics", () => {
  assert.match(PINDIE_CORE_POLICY, /final, durable Definition of Done/i);
  assert.match(PINDIE_CORE_POLICY, /meaningful across sessions/i);
  assert.match(PINDIE_CORE_POLICY, /session-local sequencing/i);
  assert.match(PINDIE_CORE_POLICY, /nextIntent, not success criteria/i);
});

test("C02 persisted Current State is rendered deterministically", () => {
  const first = renderPindieCore(verifiedState());
  const second = renderPindieCore(verifiedState());

  assert.equal(first, second);
  assert.match(first, /Pindie Current State/);
  assert.match(first, /"goal": "Wire Pindie into Pi"/);
});

test("C03 derived task status is rendered", () => {
  assert.match(renderPindieCore(verifiedState()), /Task status: active/);
});

test("C04 derived verification status is rendered", () => {
  assert.match(
    renderPindieCore(verifiedState()),
    /Verification status: passed/,
  );
});

test("C05 repeated injection leaves exactly one Pindie Core block", () => {
  const first = injectPindieCore("Pi base system prompt", verifiedState());
  const second = injectPindieCore(first, verifiedState());

  assert.match(second, /^Pi base system prompt/);
  assert.equal(second.split(PINDIE_CORE_START).length - 1, 1);
  assert.equal(second.split(PINDIE_CORE_END).length - 1, 1);
  assert.equal(second, first);
});

test("C06 load failure renders unavailable State instead of EMPTY_STATE", () => {
  const block = renderPindieCore(
    null,
    "Could not parse the project State file.",
  );

  assert.match(block, /Pindie State is unavailable/);
  assert.match(block, /Could not parse the project State file/);
  assert.match(block, /Do not make consequential project changes/);
  assert.doesNotMatch(block, /"task": null/);
});
