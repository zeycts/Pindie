import assert from "node:assert/strict";
import test from "node:test";

import {
  PINDIE_CORE_END,
  PINDIE_CORE_POLICY,
  PINDIE_CORE_START,
  PINDIE_RUNTIME_CONTEXT_TYPE,
  PINDIE_RUNTIME_END,
  PINDIE_RUNTIME_START,
  createPindieRuntimeContextMessage,
  injectPindieCore,
  isPindieRuntimeContextMessage,
  renderPindieCore,
  renderPindieRuntimeContext,
} from "../src/context.ts";
import type { PindieState } from "../src/state.ts";

function completeState(): PindieState {
  return {
    task: {
      goal: "Wire Pindie into Pi",
      constraints: ["Preserve Pi's Agent Loop"],
      successCriteria: [{ id: "c1", description: "Extension wiring works" }],
      openLoops: {
        blockers: ["Awaiting API access"],
        questions: ["Which release channel?"],
        nextIntent: "Run tests",
      },
      verification: {
        stale: false,
        checks: [{
          name: "tests",
          status: "passed",
          covers: ["c1"],
          evidence: "Extension tests passed.",
        }],
      },
      humanGate: {
        kind: "decision",
        question: "Choose a release strategy.",
        options: ["Canary", "Immediate"],
      },
      completed: false,
    },
  };
}

test("CP01-CP04 Core contains deterministic policy only and is State-independent", () => {
  const first = renderPindieCore();

  assert.ok(first.includes(PINDIE_CORE_POLICY));
  assert.match(first, /Latest user intent and observed project reality/);
  assert.equal(first, renderPindieCore());
  assert.doesNotMatch(first, /Current State|Task status|Verification status|Wire Pindie|unavailable/);
});

test("D04 Core Policy explains durable success-criterion semantics", () => {
  assert.match(PINDIE_CORE_POLICY, /final, durable Definition of Done/i);
  assert.match(PINDIE_CORE_POLICY, /meaningful across sessions/i);
  assert.match(PINDIE_CORE_POLICY, /session-local sequencing.*checkpoint instructions.*as success criteria/i);
  assert.match(PINDIE_CORE_POLICY, /nextIntent only for continuation intent/i);
  assert.match(PINDIE_CORE_POLICY, /unfinished work.*persisted next meaningful step/i);
});

test("D08 Core Policy distinguishes constraints from success criteria", () => {
  assert.match(PINDIE_CORE_POLICY, /Constraints are durable task-wide boundaries governing execution/i);
  assert.match(PINDIE_CORE_POLICY, /success criteria are final observable outcomes required for completion/i);
});

test("SO-C01-SO-C02 Core Policy prefers dedicated Git observation while bash stays consequential", () => {
  assert.match(PINDIE_CORE_POLICY, /prefer pindie_git_observe.*supported read-only Git inspection/i);
  assert.match(PINDIE_CORE_POLICY, /unrestricted bash remains consequential/i);
});

test("EH01 Core Policy requires operation-owned narrow execution cleanup", () => {
  assert.match(PINDIE_CORE_POLICY, /Temporary resources created during execution or verification are owned by that operation/i);
  assert.match(PINDIE_CORE_POLICY, /scope them narrowly, clean only resources it created/i);
  assert.match(PINDIE_CORE_POLICY, /never use broad filesystem or process cleanup/i);
});

test("TB29-TB32 Core Policy reconciles latest intent with the current Task", () => {
  assert.match(PINDIE_CORE_POLICY, /before consequential project action, reconcile latest actual user intent with the current Pindie Task/i);
  assert.match(PINDIE_CORE_POLICY, /Continue or refine only when latest intent still belongs to this current Task/i);
  assert.match(PINDIE_CORE_POLICY, /clearly different user-requested Task may replace an unfinished current Task/i);
  assert.match(PINDIE_CORE_POLICY, /Observation, explanation, discussion, pause, or return-control intent alone does not mutate the Task or authorize consequential continuation/i);
});

test("AC15 Core Policy contains each active-Task continuation semantic exactly once", () => {
  assert.equal((PINDIE_CORE_POLICY.match(/An active Task should continue only while the latest actual user intent still calls for consequential execution of this current Task/g) ?? []).length, 1);
  assert.equal((PINDIE_CORE_POLICY.match(/A hidden continuation follow-up is a probe subordinate to latest user intent/g) ?? []).length, 1);
  assert.equal((PINDIE_CORE_POLICY.match(/persisting it does not authorize yielding or overriding later user intent/gi) ?? []).length, 1);
});

test("CP05-CP06 repeated Core injection leaves one block and preserves Pi Skill metadata", () => {
  const skillIndex = "<available_skills>\n<skill><name>release</name></skill>\n</available_skills>";
  const first = injectPindieCore(`Pi base system prompt\n\n${skillIndex}`);
  const second = injectPindieCore(first);

  assert.equal(second, first);
  assert.equal(second.split(PINDIE_CORE_START).length - 1, 1);
  assert.equal(second.split(PINDIE_CORE_END).length - 1, 1);
  assert.ok(second.includes(skillIndex));
});

test("SI05 Core Policy keeps optional Skills subordinate to Core safeguards", () => {
  assert.match(PINDIE_CORE_POLICY, /Specialized Skills are optional procedures/i);
  assert.match(PINDIE_CORE_POLICY, /cannot override latest user intent, observed reality, Pindie Core and State invariants, the Task Contract, Verification, or Human Gates/i);
  assert.match(PINDIE_CORE_POLICY, /Skill selection and Skill-local progress.*not persistent Pindie State/i);
});

test("CP07-CP11 Runtime Context deterministically projects the complete active semantic State", () => {
  const first = renderPindieRuntimeContext(completeState());
  const second = renderPindieRuntimeContext(completeState());

  assert.equal(first, second);
  assert.match(first, /Runtime metadata only; not user intent\./);
  assert.match(first, /Latest actual user intent and observed project reality remain authoritative\./);
  assert.match(first, /Task status: waiting_human/);
  assert.match(first, /Verification status: passed/);
  assert.match(first, /Goal:\nWire Pindie into Pi/);
  assert.match(first, /Constraints:\n- Preserve Pi's Agent Loop/);
  assert.match(first, /Success criteria:\n- c1: Extension wiring works/);
  assert.match(first, /Blockers:\n- Awaiting API access/);
  assert.match(first, /Questions:\n- Which release channel\?/);
  assert.match(first, /Next intent:\nRun tests/);
  assert.match(first, /tests — passed — covers: c1\n  Evidence: Extension tests passed\./);
  assert.match(first, /Human gate:\n- Kind: decision\n- Question: Choose a release strategy\.\n- Options:\n  - Canary\n  - Immediate/);
});

test("CP12 idle State has minimal meaningful Runtime Context", () => {
  const runtime = renderPindieRuntimeContext({ task: null });

  assert.equal(runtime, `${PINDIE_RUNTIME_START}\nPindie Runtime Context\n\nRuntime metadata only; not user intent.\nLatest actual user intent and observed project reality remain authoritative.\n\nTask status: idle\n${PINDIE_RUNTIME_END}`);
  assert.doesNotMatch(runtime, /"task": null/);
});

test("CP13 unavailable State has fail-closed Runtime Context", () => {
  const runtime = renderPindieRuntimeContext(null, "Could not parse the project State file.");

  assert.match(runtime, /State: unavailable/);
  assert.match(runtime, /Could not parse the project State file/);
  assert.match(runtime, /Do not make consequential project changes/);
});

test("CP14 empty optional Runtime Context sections are omitted", () => {
  const state: PindieState = {
    task: {
      ...completeState().task!,
      constraints: [],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
    },
  };
  const runtime = renderPindieRuntimeContext(state);

  assert.doesNotMatch(runtime, /Constraints:|Blockers:|Questions:|Next intent:|Verification checks:|Human gate:/);
});

test("Runtime Context messages use the stable custom type without volatile model-facing content", () => {
  const message = createPindieRuntimeContextMessage(completeState());

  assert.equal(message.customType, PINDIE_RUNTIME_CONTEXT_TYPE);
  assert.equal(message.timestamp, 0);
  assert.ok(isPindieRuntimeContextMessage(message));
  assert.match(String(message.content), new RegExp(PINDIE_RUNTIME_START));
});
