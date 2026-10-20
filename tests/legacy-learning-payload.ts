import { createHash } from "node:crypto";

// Frozen legacy JSON shapes for Stable safety tests, not a Learning runtime.
// Keep integrity hashes valid so rejection of malformed data cannot accidentally
// make an activated reader look safe. No retired module is imported, even as a type.
function orderedJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(orderedJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${orderedJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(orderedJson(value)).digest("hex")}`;
}
export function legacyHypothesis(projectId: string, kind = "approach") {
  const semantic = {
    schemaVersion: 2, scope: { kind: "project", projectId }, logicalId: "bounded-check", kind, lineage: "new", parent: null,
    baseRevisionFingerprint: null, summary: "Check affected contracts", useWhen: ["Local edits"], avoidWhen: [],
    principles: ["Keep verification focused"], expectedEffect: "Fewer unrelated edits", failureSignals: ["Missed tests"], trialHints: [],
    sources: [{ projectId, recordId: "00000000-0000-4000-8000-000000000005.json", fingerprint: `sha256:${"a".repeat(64)}` }],
  };
  return { ...semantic, id: "00000000-0000-4000-8000-000000000001", fingerprint: fingerprint(semantic), discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
}
export function legacyPublication(h: ReturnType<typeof legacyHypothesis>) {
  const content = {
    schemaVersion: 2, packetFingerprint: h.discoveryPacketFingerprint, outcome: "published",
    refs: [{ schemaVersion: 1, family: "strategy-hypothesis", scope: h.scope, id: h.id, fingerprint: h.fingerprint }],
    newHypotheses: [h], modelIdentity: { provider: "faux", modelId: "discovery", thinkingLevel: "off" },
  };
  return { ...content, fingerprint: fingerprint(content) };
}
export function legacyTrialPayload(projectId: string, hypothesis: ReturnType<typeof legacyPublication>["refs"][number]) {
  const a = { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000002", projectId,
    workEpisodeId: "00000000-0000-4000-8000-000000000003", sessionId: "historical-session", hypothesis,
    comparison: [], offerPolicyVersion: 1, offerPolicyFingerprint: fingerprint({ schemaVersion: 1, version: 1, enabled: true,
      maxOffersPerHypothesis: 3, cooldownMs: 86_400_000, leaseMs: 86_400_000, operationTimeoutMs: 100 }),
    hostId: "00000000-0000-4000-8000-000000000004", authorityGeneration: 1, createdAt: 1000, expiresAt: 2000, status: "untrusted-advisory" };
  const assignment = { ...a, fingerprint: fingerprint(a) };
  const r = { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000006", projectId, workEpisodeId: a.workEpisodeId,
    offerPolicyVersion: a.offerPolicyVersion, offerPolicyFingerprint: a.offerPolicyFingerprint, createdAt: a.createdAt,
    outcome: "offered", reason: "selected", assignment: { schemaVersion: 1, family: "trial-assignment",
      scope: { kind: "project", projectId }, id: assignment.id, fingerprint: assignment.fingerprint } };
  const receipt = { ...r, fingerprint: fingerprint(r) };
  const pending = { ...r, assignment: null, outcome: "no-offer", reason: "interrupted" };
  return { commit: { schemaVersion: 1, assignment, receipt }, pending: { ...pending, fingerprint: fingerprint(pending) } };
}
export function legacyExperience(workEpisodeId: string, minute: number) {
  return {
    schemaVersion: 5, workEpisodeId, recordedAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    runStart: { taskStatus: "active", taskGoal: "goal" }, task: { goal: "goal", taskRelation: "preexisting_untouched" },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: minute % 2, deniedCalls: 0 },
    outcome: { taskStatus: "active", verificationStatus: "pending", completionRelation: "not_completed", hasBlockers: false, hasQuestions: false, humanGateOpen: false },
    metrics: { durationMs: 1, cost: 0 },
  };
}
