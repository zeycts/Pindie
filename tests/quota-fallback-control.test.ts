import assert from "node:assert/strict";
import test from "node:test";
import { getQuotaFallbackController, installQuotaFallbackReceiver } from "../src/quota-fallback-control.ts";
import type { QuotaFallbackPlan } from "../src/quota-fallback-supervisor.ts";

const plan: QuotaFallbackPlan = { sessionId: "s", anchorEntryId: "a", provider: "openai-codex", modelId: "m", detectedAt: 1, restoreAt: 2 };

test("one Host lease routes request, cancel, model selection and async backup failure", async () => {
  const calls: string[] = [];
  const release = installQuotaFallbackReceiver({
    request: async (p) => { calls.push(`request:${p.anchorEntryId}`); return true; },
    canUseBackup: (id) => { calls.push(`available:${id}`); return true; },
    cancel: (id) => { calls.push(`cancel:${id}`); },
    observeModelSelect: (event) => { calls.push(`model:${event.source}`); return true; },
    backupFailed: async (id) => { calls.push(`backup:${id}`); return plan; },
  });
  try {
    const publisher = getQuotaFallbackController()!;
    assert.equal(await publisher.request(plan), true);
    assert.equal(publisher.canUseBackup("s"), true);
    publisher.cancel("s");
    assert.equal(publisher.observeModelSelect({ sessionId: "s", provider: "deepseek", modelId: "deepseek-flash", source: "set" }), true);
    assert.equal(await publisher.backupFailed("s"), plan);
    assert.deepEqual(calls, ["request:a", "available:s", "cancel:s", "model:set", "backup:s"]);
    assert.throws(() => installQuotaFallbackReceiver({} as never), /already owns/);
    release();
    assert.equal(getQuotaFallbackController(), null);
    const releaseNext = installQuotaFallbackReceiver({
      request: () => false, canUseBackup: () => false, cancel: () => undefined, observeModelSelect: () => false, backupFailed: async () => null,
    });
    try {
      release();
      assert.rejects(Promise.resolve().then(() => publisher.request(plan)), /no longer active/);
      assert.throws(() => publisher.cancel("s"), /no longer active/);
      assert.throws(() => publisher.canUseBackup("s"), /no longer active/);
      assert.equal(getQuotaFallbackController()!.canUseBackup("s"), false);
      assert.equal(await getQuotaFallbackController()!.request(plan), false);
    } finally { releaseNext(); }
  } finally { release(); }
});
