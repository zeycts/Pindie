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
  assert.match(
    PINDIE_CORE_POLICY,
    /session-local sequencing.*checkpoint instructions.*as success criteria/i,
  );
  assert.match(PINDIE_CORE_POLICY, /nextIntent only for continuation intent/i);
  assert.match(
    PINDIE_CORE_POLICY,
    /unfinished work.*persisted next meaningful step/i,
  );
});

test("D08 Core Policy distinguishes constraints from success criteria", () => {
  assert.match(
    PINDIE_CORE_POLICY,
    /Constraints are durable task-wide boundaries governing execution/i,
  );
  assert.match(
    PINDIE_CORE_POLICY,
    /success criteria are final observable outcomes required for completion/i,
  );
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

test("SI02 Core injection preserves Pi Skill metadata unchanged", () => {
  const skillIndex = `<available_skills>\n<skill><name>release</name><description>Prepare a release when requested.</description></skill>\n</available_skills>`;
  const prompt = `Pi base system prompt\n\n${skillIndex}\n\nPi closing instructions`;

  const result = injectPindieCore(prompt, verifiedState());

  assert.ok(result.includes(skillIndex));
  assert.match(result, /^Pi base system prompt/);
  assert.match(result, /Pi closing instructions/);
  assert.equal(result.split("<available_skills>").length - 1, 1);
  assert.equal(result.split(PINDIE_CORE_START).length - 1, 1);
});

test("SI03 repeated Core injection preserves one Pi Skill index and one Core block", () => {
  const skillIndex = `<available_skills>\n<skill><name>release</name><description>Prepare a release when requested.</description></skill>\n</available_skills>`;
  let result = `Pi base system prompt\n\n${skillIndex}`;

  for (let index = 0; index < 3; index += 1) {
    result = injectPindieCore(result, verifiedState());
  }

  assert.equal(result.split("<available_skills>").length - 1, 1);
  assert.equal(result.split(PINDIE_CORE_START).length - 1, 1);
  assert.equal(result.split(PINDIE_CORE_END).length - 1, 1);
  assert.ok(result.includes(skillIndex));
});

test("SI05 Core Policy keeps optional Skills subordinate to Core safeguards", () => {
  assert.match(PINDIE_CORE_POLICY, /Specialized Skills are optional procedures/i);
  assert.match(
    PINDIE_CORE_POLICY,
    /cannot override latest user intent, observed reality, Pindie Core and State invariants, the Task Contract, Verification, or Human Gates/i,
  );
  assert.match(PINDIE_CORE_POLICY, /Skill selection and Skill-local progress.*not persistent Pindie State/i);
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
