import assert from "node:assert/strict";
import test from "node:test";
import { projectControlQuota } from "../src/control-quota.ts";
import { PindieControlClient } from "../src/control-client.ts";
import type { QuotaResumePhase } from "../src/quota-resume-control.ts";

const now = 1_700_000_000_000;
const base = { sessionId: "session", model: { provider: "openai", modelId: "gpt-6.1-sol" },
  monitorFetchedAt: null, recoveryEvent: null };

test("quota observation never transfers legacy Codex-account facts to OpenAI, Codex or fallback models", () => {
  for (const model of [base.model, { provider: "openai-codex", modelId: "gpt-5-codex" },
    { provider: "deepseek", modelId: "deepseek-flash" }, null]) {
    const result = projectControlQuota({ ...base, model, monitorFetchedAt: now }, now);
    assert.deepEqual(result.activeModel, model);
    assert.equal(result.subscription.status, "unknown");
    assert.equal(result.subscription.reason, model?.provider === "openai-codex"
      ? "active_account_provenance_unverified" : "no_supported_source_for_active_provider");
    for (const key of ["source", "fetchedAt", "fiveHour", "weekly"] as const) assert.equal(result.subscription[key], null);
    assert.equal(result.monitor.accountApplicability, "unverified");
    assert.equal(result.monitor.freshness, "fresh"); // Cache age, not active-account health.
    assert.ok(!JSON.stringify(result).includes("usedPercent"));
  }
});

test("monitor cache freshness distinguishes age, missing facts and future/invalid clocks without fetching", () => {
  for (const [monitorFetchedAt, freshness] of [[now, "fresh"], [now - 60_000, "fresh"],
    [now - 60_001, "stale"], [now + 1, "unknown"], [null, "unavailable"], [NaN, "unavailable"]] as const) {
    const result = projectControlQuota({ ...base, monitorFetchedAt }, now);
    assert.equal(result.observedAt, now); assert.equal(result.monitor.freshness, freshness);
    assert.equal(result.monitor.fetchedAt, Number.isFinite(monitorFetchedAt) ? monitorFetchedAt : null);
    assert.equal(result.subscription.status, "unknown");
  }
  assert.equal(projectControlQuota({ ...base, monitorFetchedAt: now }, NaN).monitor.freshness, "unknown");
});

test("mocked incident phases, reset dates and fallback never certify exhausted or restored active quota", () => {
  for (const phase of ["waiting", "wake_started", "cancelled", "invalidated", "wake_failed"] as QuotaResumePhase[]) {
    const result = projectControlQuota({ ...base, model: { provider: "deepseek", modelId: "deepseek-flash" },
      recoveryEvent: { sessionId: "session", phase, resumeAt: now + 30_000, anchorEntryId: "incident" } }, now);
    assert.deepEqual(result.recovery, { phase, resumeAt: now + 30_000, anchorEntryId: "incident" });
    assert.equal(result.subscription.status, "unknown");
  }
  assert.equal(projectControlQuota({ ...base, recoveryEvent: { sessionId: "old-session", resumeAt: now } }, now).recovery, null);
  assert.equal(projectControlQuota({ ...base, recoveryEvent: { sessionId: "session", resumeAt: now } }, now).recovery?.phase, "waiting");
});

test("Control quota uses only existing safe observation and cached timestamps, not auth, percentages or raw payloads", () => {
  const snapshot = { session: { id: "session" }, executionConfig: { model: base.model }, recovery: { quotaWaiting: null } };
  const read = (presentation: unknown) => PindieControlClient.prototype.readQuota.call({
    observe: () => snapshot,
    get runtime() { assert.fail("quota read must not resolve provider/auth or fetch"); },
    presentation: { current: () => presentation },
  } as unknown as PindieControlClient);
  const result = read({ snapshot: () => ({ status: { subscriptionUsage: {
    fetchedAt: now,
    get windows() { assert.fail("must not expose unbound account usage"); },
    get resetCredits() { assert.fail("must not inspect raw credit identities"); },
  } }, quotaResumeEvent: { sessionId: "session", phase: "cancelled", resumeAt: now,
    get raw() { assert.fail("no unrecognized recovery payload"); } } }) });
  assert.equal(result.monitor.fetchedAt, now); assert.equal(result.subscription.status, "unknown");
  assert.equal(result.recovery?.phase, "cancelled");
  for (const presentation of [null, { snapshot: () => { throw new Error("private credential path"); } }]) {
    const unavailable = read(presentation);
    assert.equal(unavailable.monitor.freshness, "unavailable");
    assert.ok(!JSON.stringify(unavailable).includes("private"));
  }
  assert.throws(() => PindieControlClient.prototype.readQuota.call({
    observe: () => { throw new Error("unbound"); },
    get presentation() { assert.fail("binding required before telemetry"); },
  } as unknown as PindieControlClient), /unbound/);
});
