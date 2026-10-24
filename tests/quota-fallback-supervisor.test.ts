import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, AgentSessionRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import {
  PINDIE_QUOTA_FALLBACK_MESSAGE, PINDIE_QUOTA_FALLBACK_TYPE,
  QuotaFallbackSupervisor, detectQuotaFallbackBackupFailure, type QuotaFallbackPlan,
} from "../src/quota-fallback-supervisor.ts";
import type { QuotaFallbackConfig } from "../src/quota-fallback-config.ts";
import { MAX_QUOTA_RESUME_WAIT_MS } from "../src/quota-resume-supervisor.ts";

const NOW = 1_700_000_000_000;
function quota(id = "quota", model = "model-A"): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(NOW).toISOString(), message: {
    role: "assistant", content: [], provider: "openai-codex", model, usage: {}, stopReason: "error",
    errorMessage: "The usage limit has been reached", timestamp: NOW,
  } } as SessionEntry;
}
function plan(overrides: Partial<QuotaFallbackPlan> = {}): QuotaFallbackPlan {
  return { sessionId: "session", anchorEntryId: "quota", provider: "openai-codex", modelId: "model-A", detectedAt: NOW, restoreAt: NOW + 1000, ...overrides };
}
function harness() {
  let branch: SessionEntry[] = [quota()];
  let sessionId = "session";
  let model = { provider: "openai-codex", id: "model-A" };
  let thinking: AgentSession["thinkingLevel"] = "medium";
  let effective: AgentSession["thinkingLevel"] = "high";
  let fixtureEffective: AgentSession["thinkingLevel"] | undefined;
  let onFixtureThinking: (() => void) | undefined;
  let streaming = false, compacting = false, pending = 0;
  let available = true;
  let failThinking = false, failSchedule = false, failSend = false;
  let sendResult: Promise<void> = Promise.resolve();
  let switchWait: Promise<void> = Promise.resolve();
  const switches: string[] = [], levels: string[] = [], sends: unknown[][] = [], logs: string[] = [];
  const timers: Array<{ delay: number; callback: () => void; cancelled: boolean }> = [];
  const listeners = new Set<() => void>();
  const session = {
    get sessionId() { return sessionId; },
    get model() { return model; },
    get thinkingLevel() { return thinking; },
    setThinkingLevel(level: AgentSession["thinkingLevel"]) {
      levels.push(level);
      if (failThinking) { failThinking = false; throw new Error("thinking failed"); }
      thinking = model.provider === "deepseek" ? effective : model.provider === "fixture-paid" ? fixtureEffective ?? level : level;
      if (model.provider === "fixture-paid") onFixtureThinking?.();
    },
    get isStreaming() { return streaming; }, get isCompacting() { return compacting; }, get pendingMessageCount() { return pending; },
    sessionManager: { getBranch: () => branch },
    extensionRunner: { getModelRegistry: () => ({
      find: (provider: string, id: string) => ["openai-codex/model-A", "deepseek/deepseek-flash", "fixture-paid/fixture-backup"].includes(`${provider}/${id}`) ? { provider, id } : undefined,
      getAvailable: () => available ? [{ provider: "openai-codex", id: "model-A", input: ["text"] }, { provider: "deepseek", id: "deepseek-flash", name: "Fixture Flash", input: ["text"], reasoning: true }, { provider: "fixture-paid", id: "fixture-backup", name: "Synthetic Backup", input: ["text"], reasoning: true }] : [{ provider: "openai-codex", id: "model-A", input: ["text"] }],
      hasConfiguredAuth: () => available,
      getProviderAuthStatus: () => ({ configured: available }),
    }) },
    async setModel(target: { provider: string; id: string }) { await switchWait; switches.push(`${target.provider}/${target.id}`); model = target; },
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    sendCustomMessage(...args: unknown[]) { sends.push(args); if (failSend) throw new Error("enqueue failed"); return sendResult; },
  };
  const runtime = new PiRuntimeAdapter({ get session() { return session; } } as unknown as AgentSessionRuntime);
  const supervisor = new QuotaFallbackSupervisor(runtime, {
    now: () => NOW,
    schedule: (delay, callback) => {
      if (failSchedule) throw new Error("scheduler failed");
      const timer = { delay, callback, cancelled: false }; timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    logger: (message) => logs.push(message),
  });
  return { supervisor, switches, levels, sends, timers, logs, listeners,
    get model() { return model; }, get thinking() { return thinking; },
    setFixtureEffective: (value: AgentSession["thinkingLevel"]) => { fixtureEffective = value; },
    onFixtureThinking: (callback: () => void) => { onFixtureThinking = callback; },
    setBranch: (value: SessionEntry[]) => { branch = value; },
    setSession: (value: string) => { sessionId = value; },
    setModel: (provider: string, id: string) => { model = { provider, id }; },
    setBusy: (s = false, c = false, p = 0) => { streaming = s; compacting = c; pending = p; },
    setAvailable: (value: boolean) => { available = value; },
    setEffective: (value: AgentSession["thinkingLevel"]) => { effective = value; },
    failThinking: () => { failThinking = true; }, failSchedule: () => { failSchedule = true; }, failSend: () => { failSend = true; },
    setSendResult: (value: Promise<void>) => { sendResult = value; },
    waitSwitch: (value: Promise<void>) => { switchWait = value; },
    event: () => { for (const listener of [...listeners]) listener(); },
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("valid same-Session commit delegates thinking clamp to Pi and does not await the DeepSeek Run", async () => {
  const h = harness(); h.setEffective("high");
  h.setSendResult(new Promise<void>(() => undefined)); // full Agent Run remains pending
  assert.equal(await h.supervisor.request(plan()), true);
  assert.deepEqual(h.switches, ["deepseek/deepseek-flash"]);
  assert.deepEqual(h.levels, ["medium"]);
  assert.deepEqual(h.sends, [[{ customType: PINDIE_QUOTA_FALLBACK_TYPE, content: PINDIE_QUOTA_FALLBACK_MESSAGE, display: false }, { triggerTurn: true }]]);
  assert.equal(h.timers[0]?.delay, 1000);
  assert.equal(h.listeners.size, 1);
  assert.equal(await h.supervisor.request(plan()), true);
  assert.equal(h.sends.length, 1);
});

test("fixed thinking silently clamped by Pi fails before lease/continuation and rolls back source model/thinking", async () => {
  const backup: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "high" };
  for (const clamped of ["low", "off"] as const) {
    const h = harness(); h.setFixtureEffective(clamped);
    assert.equal(await h.supervisor.request(plan({ backup })), false, clamped);
    assert.deepEqual(h.switches, ["fixture-paid/fixture-backup", "openai-codex/model-A"]);
    assert.deepEqual(h.levels, ["high", "medium"]);
    assert.deepEqual(h.model, { provider: "openai-codex", id: "model-A" });
    assert.equal(h.thinking, "medium");
    assert.deepEqual(h.sends, []); assert.deepEqual(h.timers, []); assert.equal(h.listeners.size, 0);
    assert.match(h.logs.join(" "), new RegExp(`expected high, received ${clamped}`));
    h.setFixtureEffective("high");
    assert.equal(await h.supervisor.request(plan({ backup })), true); // failed request left no lease/commit fuse
    h.supervisor.dispose();
  }
});

test("fixed thinking exact match commits while source mode continues to accept Pi clamping", async () => {
  for (const selected of ["high", "source"] as const) {
    for (const effective of selected === "source" ? ["low", "off"] as const : ["high"] as const) {
      const h = harness(); h.setFixtureEffective(effective);
      const backup: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: selected };
      assert.equal(await h.supervisor.request(plan({ backup })), true);
      assert.equal(h.thinking, effective);
      assert.deepEqual(h.levels, [selected === "source" ? "medium" : "high"]);
      assert.equal(h.sends.length, 1); assert.equal(h.timers.length, 1); assert.equal(h.listeners.size, 1);
      h.timers[0]!.callback(); await flush();
      assert.deepEqual(h.model, { provider: "openai-codex", id: "model-A" }); assert.equal(h.thinking, "medium");
      assert.equal(h.sends.length, 1); assert.equal(h.listeners.size, 0);
    }
  }
});

test("fixed thinking mismatch after an async switch never rolls back over Session/human ownership changes", async () => {
  const backup: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "high" };
  for (const boundary of ["session", "human"] as const) {
    const h = harness(); h.setFixtureEffective("low");
    let release!: () => void;
    h.waitSwitch(new Promise<void>((resolve) => { release = resolve; }));
    const pending = h.supervisor.request(plan({ backup }));
    await flush();
    // Native thinking application can emit synchronous events after the awaited model switch.
    h.onFixtureThinking(() => {
      if (boundary === "session") {
        h.supervisor.observeSessionLifecycle({ sessionId: "session", reason: "new" });
        h.setSession("replacement");
      } else {
        h.supervisor.observeModelSelection({ sessionId: "session", provider: "other", modelId: "user-owned", source: "set" });
      }
      h.setModel("other", "user-owned");
    });
    release(); assert.equal(await pending, false);
    assert.deepEqual(h.model, { provider: "other", id: "user-owned" });
    assert.deepEqual(h.switches, ["fixture-paid/fixture-backup"]);
    assert.deepEqual(h.levels, ["high"]); // neither source model nor source thinking is imposed on the new owner
    assert.deepEqual(h.sends, []); assert.deepEqual(h.timers, []); assert.equal(h.listeners.size, 0);
  }
});

test("configuration preflight uses exact Pi availability for the current Session without quota or idle requirements", () => {
  const h = harness();
  h.setBranch([]); h.setModel("other", "model"); h.setBusy(true, true, 3);
  assert.equal(h.supervisor.canUseBackup("session"), true);
  h.setAvailable(false); assert.equal(h.supervisor.canUseBackup("session"), false);
  h.setAvailable(true); assert.equal(h.supervisor.canUseBackup("other"), false);
  h.supervisor.dispose(); assert.equal(h.supervisor.canUseBackup("session"), false);
});

test("unavailable backup fails without model mutation, message, timer or subscription", async () => {
  const h = harness(); h.setAvailable(false);
  assert.equal(await h.supervisor.request(plan()), false);
  assert.deepEqual([h.switches, h.sends, h.timers], [[], [], []]);
  assert.equal(h.listeners.size, 0);
});

test("stale source and invalid time fail closed", async () => {
  const cases: Array<[string, (h: ReturnType<typeof harness>) => QuotaFallbackPlan]> = [
    ["wrong session", (h) => { h.setSession("other"); return plan(); }],
    ["wrong model", (h) => { h.setModel("openai-codex", "other"); return plan(); }],
    ["stale anchor", (h) => { h.setBranch([quota("other")]); return plan(); }],
    ["streaming", (h) => { h.setBusy(true); return plan(); }],
    ["compacting", (h) => { h.setBusy(false, true); return plan(); }],
    ["queued", (h) => { h.setBusy(false, false, 1); return plan(); }],
    ["expired", () => plan({ restoreAt: NOW })],
    ["too far", () => plan({ restoreAt: NOW + MAX_QUOTA_RESUME_WAIT_MS + 1 })],
  ];
  for (const [name, mutate] of cases) {
    const h = harness(); assert.equal(await h.supervisor.request(mutate(h)), false, name);
    assert.equal(h.switches.length + h.sends.length + h.timers.length + h.listeners.size, 0, name);
  }
});

test("restore at safe idle switches to Codex, restores captured thinking, and sends no turn", async () => {
  const h = harness(); await h.supervisor.request(plan());
  h.timers[0]!.callback(); await flush();
  assert.deepEqual(h.switches, ["deepseek/deepseek-flash", "openai-codex/model-A"]);
  assert.deepEqual(h.levels, ["medium", "medium"]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.listeners.size, 0); assert.equal(h.timers[0]?.cancelled, true);
});

test("busy reset defers until a safe Session event, without duplicate restores", async () => {
  const h = harness(); await h.supervisor.request(plan()); h.setBusy(true);
  h.timers[0]!.callback(); await flush(); assert.equal(h.switches.length, 1);
  h.setBusy(false, true); h.event(); await flush(); assert.equal(h.switches.length, 1);
  h.setBusy(false, false, 1); h.event(); await flush(); assert.equal(h.switches.length, 1);
  h.setBusy(); h.event(); h.timers[0]!.callback(); await flush();
  assert.deepEqual(h.switches, ["deepseek/deepseek-flash", "openai-codex/model-A"]);
});

test("partial commit errors roll back without continuation or ownership", async () => {
  for (const fail of ["thinking", "scheduler", "send"] as const) {
    const h = harness();
    if (fail === "thinking") h.failThinking();
    if (fail === "scheduler") h.failSchedule();
    if (fail === "send") h.failSend();
    assert.equal(await h.supervisor.request(plan()), false, fail);
    assert.deepEqual(h.switches, ["deepseek/deepseek-flash", "openai-codex/model-A"], fail);
    assert.equal(h.listeners.size, 0, fail);
    assert.deepEqual(h.levels, ["medium", "medium"], fail);
    assert.equal(h.timers.every((timer) => timer.cancelled), true, fail);
    assert.equal(h.sends.length, fail === "send" ? 1 : 0, fail);
  }
});

test("rejected continuation is observed, restores safely, and stale rejection cannot damage a newer lease", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.setSendResult(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  assert.equal(await h.supervisor.request(plan()), true);
  reject(new Error("DeepSeek failed")); await flush();
  assert.match(h.logs.join(" "), /DeepSeek failed/);
  assert.equal(h.listeners.size, 0);
  h.setBranch([quota("new")]);
  h.setSendResult(Promise.resolve());
  assert.equal(await h.supervisor.request(plan({ anchorEntryId: "new" })), true);
  assert.equal(h.listeners.size, 1);
  await flush(); assert.equal(h.listeners.size, 1);
});

test("a rejected old continuation cannot clear a newer generation", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.setSendResult(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  await h.supervisor.request(plan());
  h.supervisor.observeSessionLifecycle({ sessionId: "session", reason: "reload" });
  h.setModel("openai-codex", "model-A"); h.setBranch([quota("new")]);
  h.setSendResult(Promise.resolve());
  assert.equal(await h.supervisor.request(plan({ anchorEntryId: "new" })), true);
  reject(new Error("old Run failed")); await flush();
  assert.equal(h.listeners.size, 1);
  assert.equal(h.switches.length, 2);
  assert.match(h.logs.join(" "), /old Run failed/);
});

test("lifecycle invalidation during an in-flight switch cannot install a lease", async () => {
  const h = harness();
  let release!: () => void;
  h.waitSwitch(new Promise<void>((resolve) => { release = resolve; }));
  const request = h.supervisor.request(plan());
  await flush();
  h.supervisor.observeSessionLifecycle({ sessionId: "session", reason: "fork" });
  h.setSession("replacement");
  release();
  assert.equal(await request, false);
  assert.equal(h.timers.length, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.sends.length, 0);
});

test("owned model mutation events survive, external selection and cancel invalidate ownership", async () => {
  const h = harness();
  let release!: () => void;
  h.waitSwitch(new Promise<void>((resolve) => { release = resolve; }));
  const pending = h.supervisor.request(plan());
  assert.equal(h.supervisor.observeModelSelection({ sessionId: "session", provider: "deepseek", modelId: "deepseek-flash", source: "set" }), true);
  h.supervisor.cancel("session"); release();
  assert.equal(await pending, false);
  assert.equal(h.sends.length, 0);
  const next = harness(); await next.supervisor.request(plan());
  assert.equal(next.supervisor.observeModelSelection({ sessionId: "session", provider: "deepseek", modelId: "deepseek-flash", source: "cycle" }), false);
  assert.equal(next.listeners.size, 0);
  next.timers[0]!.callback(); await flush(); assert.equal(next.switches.length, 1);
});

test("terminal backup provider error restores source and returns plan for Resume without sending", async () => {
  const h = harness(); await h.supervisor.request(plan());
  h.setBranch([quota(), { ...quota("backup"), message: { ...quota().message, provider: "deepseek", model: "deepseek-flash", errorMessage: "provider failure" } } as SessionEntry]);
  assert.equal(detectQuotaFallbackBackupFailure([quota()]), false);
  assert.equal(detectQuotaFallbackBackupFailure([quota(), { type: "message", id: "tool", message: { role: "toolResult", isError: true } } as SessionEntry]), false);
  assert.equal(detectQuotaFallbackBackupFailure([{ type: "message", id: "backup", message: { role: "assistant", provider: "deepseek", model: "deepseek-flash", stopReason: "error", errorMessage: "provider failure" } } as SessionEntry]), true);
  assert.deepEqual(await h.supervisor.handleBackupFailure("session"), plan());
  assert.deepEqual(h.switches, ["deepseek/deepseek-flash", "openai-codex/model-A"]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.listeners.size, 0);
});

test("configured cross-provider identity/thinking is snapshotted; reset restores source and source thinking without duplicate Run", async () => {
  const h = harness();
  const backup = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "high" } satisfies QuotaFallbackConfig;
  const p = plan({ backup });
  let release!: () => void;
  h.waitSwitch(new Promise<void>((resolve) => { release = resolve; }));
  const pending = h.supervisor.request(p);
  backup.model.modelId = "different-menu-choice"; // configuration changes during await must not retarget lease
  backup.thinking = "off" as "high";
  release(); assert.equal(await pending, true);
  assert.deepEqual(h.switches, ["fixture-paid/fixture-backup"]);
  assert.deepEqual(h.levels, ["high"]);
  h.setBusy(true); h.timers[0]!.callback(); await flush(); assert.equal(h.switches.length, 1);
  h.setBusy(); h.event(); await flush();
  assert.deepEqual(h.switches, ["fixture-paid/fixture-backup", "openai-codex/model-A"]);
  assert.deepEqual(h.levels, ["high", "medium"]);
  assert.equal(h.sends.length, 1); assert.equal(h.listeners.size, 0); assert.equal(h.timers[0]!.cancelled, true);
});

test("configured unavailable/Codex/unsupported backup fails closed, while provider failure matches only actual lease", async () => {
  for (const backup of [
    { enabled: true, model: { provider: "openai-codex", modelId: "model-A" }, thinking: "source" },
    { enabled: true, model: { provider: "fixture-paid", modelId: "absent" }, thinking: "source" },
    { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "xhigh" },
    { enabled: false, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "source" },
  ] satisfies QuotaFallbackConfig[]) {
    const h = harness(); assert.equal(await h.supervisor.request(plan({ backup })), false);
    assert.deepEqual([h.switches, h.sends, h.timers], [[], [], []]);
  }
  const h = harness();
  const backup: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "high" };
  assert.equal(await h.supervisor.request(plan({ backup })), true);
  assert.equal(await h.supervisor.handleBackupFailure("session"), null); // original Codex error is not backup failure
  const error = { ...quota("backup"), message: { ...quota().message, provider: "fixture-paid", model: "fixture-backup" } } as SessionEntry;
  h.setBranch([quota(), error]);
  assert.equal(detectQuotaFallbackBackupFailure([error]), false); // default identity is not a wildcard
  assert.equal(detectQuotaFallbackBackupFailure([error], backup.model), true);
  assert.deepEqual((await h.supervisor.handleBackupFailure("session"))?.backup, backup);
  assert.deepEqual(h.switches, ["fixture-paid/fixture-backup", "openai-codex/model-A"]);
  assert.deepEqual(h.levels, ["high", "medium"]); assert.equal(h.sends.length, 1);
  assert.equal(await h.supervisor.handleBackupFailure("session"), null);
});

test("configured backup compensation and Session/human ownership invalidation preserve user-owned model", async () => {
  const backup: QuotaFallbackConfig = { enabled: true, model: { provider: "fixture-paid", modelId: "fixture-backup" }, thinking: "high" };
  const failed = harness(); failed.failSend();
  assert.equal(await failed.supervisor.request(plan({ backup })), false);
  assert.deepEqual(failed.switches, ["fixture-paid/fixture-backup", "openai-codex/model-A"]);
  assert.deepEqual(failed.levels, ["high", "medium"]);
  for (const boundary of ["session", "human"] as const) {
    const h = harness(); await h.supervisor.request(plan({ backup }));
    if (boundary === "session") { h.supervisor.observeSessionLifecycle({ sessionId: "session", reason: "new" }); h.setSession("replacement"); }
    else { h.supervisor.observeModelSelection({ sessionId: "session", provider: "fixture-paid", modelId: "fixture-backup", source: "cycle" }); }
    h.timers[0]!.callback(); await flush();
    assert.deepEqual(h.switches, ["fixture-paid/fixture-backup"]);
    assert.equal(h.sends.length, 1); assert.equal(h.listeners.size, 0);
  }
});

test("model change, lifecycle and disposal drop lease without stale callbacks restoring", async () => {
  for (const cause of ["model", "lifecycle", "dispose"] as const) {
    const h = harness(); await h.supervisor.request(plan());
    if (cause === "model") h.setModel("other", "human");
    if (cause === "lifecycle") h.supervisor.observeSessionLifecycle({ sessionId: "session", reason: "new" });
    if (cause === "dispose") h.supervisor.dispose();
    h.timers[0]!.callback(); h.event(); await flush();
    assert.equal(h.switches.length, 1, cause);
    assert.equal(h.listeners.size, 0, cause);
    assert.equal(h.timers[0]?.cancelled, true, cause);
  }
});
