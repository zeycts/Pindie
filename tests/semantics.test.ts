import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCapabilities,
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticRunFacts,
  type SemanticSnapshot,
} from "../src/semantics.ts";
import { EMPTY_STATE, type PindieState, type PindieTask } from "../src/state.ts";

const AUTHORITY_BASE_CAPABILITIES: PindieCapability[] = ["observe.project", "observe.git"];
const COHERENT_BASE: PindieCapability[] = [
  ...AUTHORITY_BASE_CAPABILITIES,
  "memory.capture",
];
const ACTIVE_BASE: PindieCapability[] = [
  ...COHERENT_BASE,
  "project.mutate",
  "task.refine",
  "task.progress",
  "verification.record",
  "gate.open",
];
const BLOCKED_BASE: PindieCapability[] = [
  ...COHERENT_BASE,
  "project.mutate",
  "task.refine",
  "task.progress",
  "verification.record",
  "gate.open",
];

function createTask(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Ship the semantic foundation",
    constraints: ["Do not change runtime behavior"],
    successCriteria: [
      { id: "c1", description: "Semantic derivation is correct" },
      { id: "c2", description: "The full check passes" },
    ],
    openLoops: {
      blockers: [],
      questions: [],
      nextIntent: "Implement M0",
    },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function passedVerification(): PindieTask["verification"] {
  return {
    stale: false,
    checks: [
      {
        name: "check",
        status: "passed",
        covers: ["c1", "c2"],
        evidence: "All M0 checks passed.",
      },
    ],
  };
}

function completedTask(): PindieTask {
  return createTask({
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: passedVerification(),
    completed: true,
  });
}

function gatedTask(): PindieTask {
  return createTask({
    humanGate: {
      kind: "approval",
      question: "Approve the release?",
    },
  });
}

function stateWith(task: PindieTask): PindieState {
  return { task };
}

type CoherentRunFacts = Extract<SemanticRunFacts, { runCoherent: true }>;

function coherentFacts(
  overrides: Partial<CoherentRunFacts> = {},
): CoherentRunFacts {
  return {
    stateAvailable: true,
    runCoherent: true,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  };
}

function successfulSnapshot(
  state: PindieState | null,
  facts: SemanticRunFacts,
): SemanticSnapshot {
  const result = deriveSemanticSnapshot(state, facts);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result.snapshot;
}

function capabilitiesFor(
  state: PindieState | null,
  facts: SemanticRunFacts,
): ReadonlySet<PindieCapability> {
  return deriveCapabilities(successfulSnapshot(state, facts));
}

function assertCapabilities(
  actual: ReadonlySet<PindieCapability>,
  expected: readonly PindieCapability[],
): void {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

function assertDerivationFails(
  state: PindieState | null,
  facts: SemanticRunFacts,
  message?: RegExp,
): void {
  const result = deriveSemanticSnapshot(state, facts);
  assert.equal(result.ok, false);
  if (!result.ok && message) assert.match(result.error, message);
}

test("S01 unavailable authority exposes observation without retired Policy", () => {
  const snapshot = successfulSnapshot(null, { stateAvailable: false });

  assert.deepEqual(snapshot, { authority: "unavailable" });
  assertCapabilities(deriveCapabilities(snapshot), AUTHORITY_BASE_CAPABILITIES);
});

test("S02 stale authority exposes observation without retired Policy", () => {
  const snapshot = successfulSnapshot(stateWith(createTask()), {
    stateAvailable: true,
    runCoherent: false,
  });

  assert.equal(snapshot.authority, "stale");
  assertCapabilities(deriveCapabilities(snapshot), AUTHORITY_BASE_CAPABILITIES);
});

test("S03 coherent idle exposes start and observation", () => {
  const snapshot = successfulSnapshot(
    EMPTY_STATE,
    coherentFacts({
      taskRelation: "none",
      completionRelation: "not_completed",
      gateRelation: "none",
    }),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.taskStatus, "idle");
  assert.equal(snapshot.verificationStatus, "none");
  assert.equal(snapshot.completionReady, false);
  assertCapabilities(
    deriveCapabilities(snapshot),
    [...COHERENT_BASE, "task.start"],
  );
});

test("S04 a Task completed before the Run exposes start and observation", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(completedTask()),
      coherentFacts({ completionRelation: "completed_before_run" }),
    ),
    [...COHERENT_BASE, "task.start"],
  );
});

test("S05 a Task completed during the Run exposes observation without retired Policy", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(completedTask()),
      coherentFacts({
        taskRelation: "preexisting_changed",
        completionRelation: "completed_during_run",
      }),
    ),
    COHERENT_BASE,
  );
});

test("S06 an active preexisting untouched Task has the exact replace-capable base", () => {
  assertCapabilities(
    capabilitiesFor(stateWith(createTask()), coherentFacts()),
    [...ACTIVE_BASE, "task.replace"],
  );
});

test("S07 an active Task introduced during the Run cannot be replaced", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(createTask()),
      coherentFacts({ taskRelation: "introduced_during_run" }),
    ),
    ACTIVE_BASE,
  );
});

test("S08 an active preexisting changed Task cannot be replaced", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(createTask()),
      coherentFacts({ taskRelation: "preexisting_changed" }),
    ),
    ACTIVE_BASE,
  );
});

test("S09 pending verification does not permit completion", () => {
  const snapshot = successfulSnapshot(stateWith(createTask()), coherentFacts());

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.verificationStatus, "pending");
  assert.equal(snapshot.completionReady, false);
  assertCapabilities(deriveCapabilities(snapshot), [...ACTIVE_BASE, "task.replace"]);
});

test("S10 stale verification does not permit completion", () => {
  const snapshot = successfulSnapshot(
    stateWith(createTask({ verification: { stale: true, checks: [] } })),
    coherentFacts({ taskRelation: "preexisting_changed" }),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.verificationStatus, "stale");
  assert.equal(snapshot.completionReady, false);
  assertCapabilities(deriveCapabilities(snapshot), ACTIVE_BASE);
});

test("S11 failed verification does not permit completion", () => {
  const snapshot = successfulSnapshot(
    stateWith(
      createTask({
        verification: {
          stale: false,
          checks: [
            {
              name: "check",
              status: "failed",
              covers: ["c1", "c2"],
              evidence: "The check failed.",
            },
          ],
        },
      }),
    ),
    coherentFacts(),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.verificationStatus, "failed");
  assert.equal(snapshot.completionReady, false);
  assertCapabilities(deriveCapabilities(snapshot), [...ACTIVE_BASE, "task.replace"]);
});

test("S12 fully passed verification with no open loops or Gate permits completion", () => {
  const snapshot = successfulSnapshot(
    stateWith(createTask({ verification: passedVerification() })),
    coherentFacts(),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.verificationStatus, "passed");
  assert.equal(snapshot.completionReady, true);
  assertCapabilities(deriveCapabilities(snapshot), [
    ...ACTIVE_BASE,
    "task.replace",
    "task.complete",
  ]);
});

test("S13 an unresolved question prevents completion but preserves active work", () => {
  const snapshot = successfulSnapshot(
    stateWith(
      createTask({
        openLoops: {
          blockers: [],
          questions: ["Which wording should be used?"],
          nextIntent: "Continue other work",
        },
        verification: passedVerification(),
      }),
    ),
    coherentFacts(),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.hasQuestions, true);
  assert.equal(snapshot.completionReady, false);
  assertCapabilities(deriveCapabilities(snapshot), [...ACTIVE_BASE, "task.replace"]);
});

test("S14 passed verification plus a blocker applies the blocked capability set", () => {
  const snapshot = successfulSnapshot(
    stateWith(
      createTask({
        openLoops: {
          blockers: ["External service is unavailable"],
          questions: [],
          nextIntent: "Wait for the service",
        },
        verification: passedVerification(),
      }),
    ),
    coherentFacts(),
  );

  assert.equal(snapshot.authority, "coherent");
  assert.equal(snapshot.hasBlockers, true);
  assert.equal(snapshot.completionReady, false);
  const capabilities = deriveCapabilities(snapshot);
  assertCapabilities(capabilities, [...BLOCKED_BASE, "task.replace"]);
  assert.equal(capabilities.has("task.complete"), false);
});

test("S15 a blocked preexisting untouched Task has the exact replace-capable blocked set", () => {
  const blocked = createTask({
    openLoops: {
      blockers: ["Waiting for credentials"],
      questions: [],
      nextIntent: "Resume when credentials arrive",
    },
  });

  assertCapabilities(
    capabilitiesFor(stateWith(blocked), coherentFacts()),
    [...BLOCKED_BASE, "task.replace"],
  );
});

test("S16 blocked introduced and changed Tasks cannot be replaced", () => {
  const blocked = stateWith(
    createTask({
      openLoops: {
        blockers: ["Waiting for credentials"],
        questions: [],
        nextIntent: "Resume when credentials arrive",
      },
    }),
  );

  for (const taskRelation of [
    "introduced_during_run",
    "preexisting_changed",
  ] as const) {
    assertCapabilities(
      capabilitiesFor(blocked, coherentFacts({ taskRelation })),
      BLOCKED_BASE,
    );
  }
});

test("S17 a Gate opened during the current Run exposes observation without retired Policy", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(gatedTask()),
      coherentFacts({
        taskRelation: "preexisting_changed",
        gateRelation: "opened_during_run",
      }),
    ),
    COHERENT_BASE,
  );
});

test("S18 a preexisting Gate and untouched Task expose the exact resolvable set", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(gatedTask()),
      coherentFacts({ gateRelation: "existed_before_run" }),
    ),
    [...COHERENT_BASE, "task.refine", "task.replace", "gate.resolve"],
  );
});

test("S19 a preexisting Gate and changed Task do not permit replacement", () => {
  assertCapabilities(
    capabilitiesFor(
      stateWith(gatedTask()),
      coherentFacts({
        taskRelation: "preexisting_changed",
        gateRelation: "existed_before_run",
      }),
    ),
    [...COHERENT_BASE, "task.refine", "gate.resolve"],
  );
});

test("S20 no Task with a non-none Task relation fails derivation", () => {
  assertDerivationFails(
    EMPTY_STATE,
    coherentFacts({ taskRelation: "preexisting_untouched" }),
    /without a Task.*taskRelation 'none'/i,
  );
});

test("S21 no Task with a Gate relation fails derivation", () => {
  assertDerivationFails(
    EMPTY_STATE,
    coherentFacts({ taskRelation: "none", gateRelation: "opened_during_run" }),
    /without a Task.*gateRelation 'none'/i,
  );
});

test("S22 an unfinished Task with a completed relation fails derivation", () => {
  assertDerivationFails(
    stateWith(createTask()),
    coherentFacts({ completionRelation: "completed_before_run" }),
    /unfinished Task.*not_completed/i,
  );
});

test("S23 a completed Task with a not-completed relation fails derivation", () => {
  assertDerivationFails(
    stateWith(completedTask()),
    coherentFacts(),
    /completed Task.*completed Run relation/i,
  );
});

test("S24 a present Gate with gateRelation none fails derivation", () => {
  assertDerivationFails(
    stateWith(gatedTask()),
    coherentFacts(),
    /with a Human Gate.*non-'none'/i,
  );
});

test("S25 an absent Gate with a non-none Gate relation fails derivation", () => {
  assertDerivationFails(
    stateWith(createTask()),
    coherentFacts({ gateRelation: "opened_during_run" }),
    /without a Human Gate.*gateRelation 'none'/i,
  );
});

test("S26 completed-before-Run rejects introduced and changed Tasks", () => {
  for (const taskRelation of [
    "introduced_during_run",
    "preexisting_changed",
  ] as const) {
    assertDerivationFails(
      stateWith(completedTask()),
      coherentFacts({
        taskRelation,
        completionRelation: "completed_before_run",
      }),
      /completed before the Run.*preexisting and untouched/i,
    );
  }
});

test("S27 completed-during-Run cannot accompany an untouched Task", () => {
  assertDerivationFails(
    stateWith(completedTask()),
    coherentFacts({ completionRelation: "completed_during_run" }),
    /completed during the Run.*cannot be preexisting and untouched/i,
  );
});

test("S28 a Gate opened during the Run cannot accompany an untouched Task", () => {
  assertDerivationFails(
    stateWith(gatedTask()),
    coherentFacts({ gateRelation: "opened_during_run" }),
    /Opening a Gate during the Run changes/i,
  );
});

test("S29 a Gate existing before the Run cannot belong to an introduced Task", () => {
  assertDerivationFails(
    stateWith(gatedTask()),
    coherentFacts({
      taskRelation: "introduced_during_run",
      gateRelation: "existed_before_run",
    }),
    /Gate that existed before the Run.*Task introduced during the Run/i,
  );
});

test("S30 invalid PindieState fails with the existing State validation error", () => {
  assertDerivationFails(
    stateWith(createTask({ successCriteria: [] })),
    coherentFacts(),
    /Invalid PindieState:.*at least one success criterion/i,
  );
});

test("available and unavailable State inputs cannot contradict their Run Facts", () => {
  assertDerivationFails(
    stateWith(createTask()),
    { stateAvailable: false },
    /cannot be supplied.*unavailable/i,
  );
  assertDerivationFails(
    null,
    { stateAvailable: true, runCoherent: false },
    /available.*no State was supplied/i,
  );
});

test("authority dominance reduces representative stale States to observation only", () => {
  const representativeStates = [
    stateWith(createTask({ verification: passedVerification() })),
    stateWith(
      createTask({
        openLoops: {
          blockers: ["External blocker"],
          questions: [],
          nextIntent: "Wait",
        },
      }),
    ),
    stateWith(gatedTask()),
    stateWith(completedTask()),
  ];

  for (const state of representativeStates) {
    assertCapabilities(
      capabilitiesFor(state, { stateAvailable: true, runCoherent: false }),
      AUTHORITY_BASE_CAPABILITIES,
    );
  }
});

test("replace exclusivity holds across eligible coherent Task statuses", () => {
  const active = stateWith(createTask());
  const blocked = stateWith(
    createTask({
      openLoops: {
        blockers: ["External blocker"],
        questions: [],
        nextIntent: "Wait",
      },
    }),
  );
  const gated = stateWith(gatedTask());

  const cases: Array<
    [PindieState, CoherentRunFacts, replaceExpected: boolean]
  > = [];
  for (const state of [active, blocked]) {
    cases.push(
      [state, coherentFacts(), true],
      [
        state,
        coherentFacts({ taskRelation: "preexisting_changed" }),
        false,
      ],
      [
        state,
        coherentFacts({ taskRelation: "introduced_during_run" }),
        false,
      ],
    );
  }
  cases.push(
    [gated, coherentFacts({ gateRelation: "existed_before_run" }), true],
    [
      gated,
      coherentFacts({
        taskRelation: "preexisting_changed",
        gateRelation: "existed_before_run",
      }),
      false,
    ],
    [
      gated,
      coherentFacts({
        taskRelation: "preexisting_changed",
        gateRelation: "opened_during_run",
      }),
      false,
    ],
    [
      gated,
      coherentFacts({
        taskRelation: "introduced_during_run",
        gateRelation: "opened_during_run",
      }),
      false,
    ],
  );

  for (const [state, facts, replaceExpected] of cases) {
    const capabilities = capabilitiesFor(state, facts);
    assert.equal(
      capabilities.has("task.replace"),
      replaceExpected,
      `${facts.taskRelation} with Gate relation ${facts.gateRelation}`,
    );
  }
});

test("completion exclusivity follows completionReady", () => {
  const cases: Array<[PindieState, CoherentRunFacts]> = [
    [stateWith(createTask()), coherentFacts()],
    [
      stateWith(createTask({ verification: { stale: true, checks: [] } })),
      coherentFacts({ taskRelation: "preexisting_changed" }),
    ],
    [
      stateWith(
        createTask({
          openLoops: {
            blockers: [],
            questions: ["Unresolved"],
            nextIntent: "Continue",
          },
          verification: passedVerification(),
        }),
      ),
      coherentFacts(),
    ],
    [stateWith(createTask({ verification: passedVerification() })), coherentFacts()],
  ];

  for (const [state, facts] of cases) {
    const snapshot = successfulSnapshot(state, facts);
    assert.notEqual(snapshot.authority, "unavailable");
    assert.equal(
      deriveCapabilities(snapshot).has("task.complete"),
      snapshot.completionReady,
    );
  }
});
