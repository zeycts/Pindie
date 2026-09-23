import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession, AgentSessionRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import {
  PINDIE_QUOTA_FALLBACK_MESSAGE, PINDIE_QUOTA_FALLBACK_TYPE,
  QuotaFallbackSupervisor, detectQuotaFallbackBackupFailure, type QuotaFallbackPlan,
} from "../src/quota-fallback-supervisor.ts";
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
      thinking = model.provider === "deepseek" ? effective : level;
    },
    get isStreaming() { return streaming; }, get isCompacting() { return compacting; }, get pendingMessageCount() { return pending; },
    sessionManager: { getBranch: () => branch },
    extensionRunner: { getModelRegistry: () => ({
      find: (provider: string, id: string) => ["openai-codex/model-A", "deepseek/deepseek-flash"].includes(`${provider}/${id}`) ? { provider, id } : undefined,
      getAvailable: () => available ? [{ provider: "openai-codex", id: "model-A" }, { provider: "deepseek", id: "deepseek-flash" }] : [{ provider: "openai-codex", id: "model-A" }],
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
