import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import {
  MAX_QUOTA_RESUME_WAIT_MS,
  PINDIE_QUOTA_RESUME_MESSAGE,
  PINDIE_QUOTA_RESUME_TYPE,
  QuotaResumeSupervisor,
} from "../src/quota-resume-supervisor.ts";
import type { QuotaResumePlan } from "../src/quota-resume-incident.ts";

const NOW = 1_700_000_000_000;
function quota(id = "quota", model = "gpt-5-codex"): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(NOW).toISOString(), message: {
    role: "assistant", content: [], provider: "openai-codex", model, usage: {}, stopReason: "error",
    errorMessage: "The usage limit has been reached", timestamp: NOW,
  } } as SessionEntry;
}
function user(id = "user"): SessionEntry {
  return { type: "message", id, parentId: null, timestamp: new Date(NOW).toISOString(), message: { role: "user", content: "new input", timestamp: NOW } } as SessionEntry;
}
function plan(overrides: Partial<QuotaResumePlan> = {}): QuotaResumePlan {
  return { sessionId: "session", anchorEntryId: "quota", provider: "openai-codex", modelId: "gpt-5-codex", detectedAt: NOW, resumeAt: NOW + 1000, ...overrides };
}
function harness() {
  let branch: SessionEntry[] = [quota()];
  let sessionId = "session";
  let model = { provider: "openai-codex", id: "gpt-5-codex" };
  let streaming = false, compacting = false, pending = 0;
  let throwingRead: "facts" | "model" | "branch" | null = null;
  const sends: unknown[][] = [];
  let sendResult: Promise<void> = Promise.resolve();
  const session = {
    get sessionId() {
      if (throwingRead === "facts") throw new Error("active Session facts unavailable");
      return sessionId;
    },
    get model() {
      if (throwingRead === "model") throw new Error("active Session model unavailable");
      return model;
    },
    get isStreaming() { return streaming; }, get isCompacting() { return compacting; }, get pendingMessageCount() { return pending; },
    sessionManager: {
      getBranch: () => {
        if (throwingRead === "branch") throw new Error("active Session branch unavailable");
        return branch;
      },
    },
    sendCustomMessage: (...args: unknown[]) => { sends.push(args); return sendResult; },
  };
  const runtime = { get session() { return session; } } as unknown as AgentSessionRuntime;
  const callbacks: Array<{ cancelled: boolean; callback: () => void }> = [];
  const supervisor = new QuotaResumeSupervisor(new PiRuntimeAdapter(runtime), {
    now: () => NOW,
    schedule: (_delay, callback) => { const item = { cancelled: false, callback }; callbacks.push(item); return () => { item.cancelled = true; }; },
    logger: () => undefined,
  });
  return { supervisor, callbacks, sends,
    setBranch: (value: SessionEntry[]) => { branch = value; }, setSession: (value: string) => { sessionId = value; },
    setModel: (provider: string, id: string) => { model = { provider, id }; }, setBusy: (s: boolean, c = false, p = 0) => { streaming = s; compacting = c; pending = p; },
    throwOnRead: (value: "facts" | "model" | "branch" | null) => { throwingRead = value; },
    setSendResult: (value: Promise<void>) => { sendResult = value; },
  };
}

test("valid plan schedules once, accepts metadata after anchor, and sends exact hidden custom trigger", () => {
  const h = harness();
  h.setBranch([quota(), { type: "custom", id: "meta", parentId: "quota", timestamp: "", customType: "x", data: {} } as SessionEntry]);
  h.supervisor.request(plan()); h.supervisor.request(plan());
  assert.equal(h.callbacks.length, 1);
  h.callbacks[0]!.callback();
  assert.deepEqual(h.sends, [[{ customType: PINDIE_QUOTA_RESUME_TYPE, content: PINDIE_QUOTA_RESUME_MESSAGE, display: false }, { triggerTurn: true }]]);
});

test("invalid time, session, busy state, model, and anchor fail closed", () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => h.supervisor.request(plan({ resumeAt: NOW })),
    (h: ReturnType<typeof harness>) => h.supervisor.request(plan({ resumeAt: NOW + MAX_QUOTA_RESUME_WAIT_MS + 1 })),
    (h: ReturnType<typeof harness>) => { h.setSession("other"); h.supervisor.request(plan()); },
    (h: ReturnType<typeof harness>) => { h.setBusy(true); h.supervisor.request(plan()); },
    (h: ReturnType<typeof harness>) => { h.setBusy(false, true); h.supervisor.request(plan()); },
    (h: ReturnType<typeof harness>) => { h.setBusy(false, false, 1); h.supervisor.request(plan()); },
    (h: ReturnType<typeof harness>) => { h.setModel("other", "gpt-5-codex"); h.supervisor.request(plan()); },
    (h: ReturnType<typeof harness>) => { h.setBranch([quota("other")]); h.supervisor.request(plan()); },
  ]) { const h = harness(); mutate(h); assert.equal(h.callbacks.length, 0); }
});

test("throwing active branch validation fails closed during request", () => {
  const h = harness();
  h.throwOnRead("branch");
  assert.doesNotThrow(() => h.supervisor.request(plan()));
  assert.equal(h.callbacks.length, 0);
  assert.equal(h.sends.length, 0);
});

test("throwing runtime reads during wake abandon the lease without escaping or resuming", () => {
  for (const read of ["facts", "model", "branch"] as const) {
    const h = harness();
    h.supervisor.request(plan());
    h.throwOnRead(read);
    assert.doesNotThrow(() => h.callbacks[0]!.callback(), read);
    assert.equal(h.sends.length, 0, read);

    h.throwOnRead(null);
    h.callbacks[0]!.callback();
    assert.equal(h.sends.length, 0, `${read} lease was not abandoned`);
  }
});

test("a valid newer anchor replaces, cancel and stale callbacks cannot resume", () => {
  const h = harness(); h.supervisor.request(plan()); const stale = h.callbacks[0]!;
  h.setBranch([quota("new")]); h.supervisor.request(plan({ anchorEntryId: "new", resumeAt: NOW + 2000 }));
  assert.equal(stale.cancelled, true); stale.callback(); assert.equal(h.sends.length, 0);
  h.supervisor.cancel("session"); h.callbacks[1]!.callback(); assert.equal(h.sends.length, 0);
});

test("wake revalidates conversation, model, busy and pending state", () => {
  const mutations = [
    (h: ReturnType<typeof harness>) => h.setBranch([quota(), user()]),
    (h: ReturnType<typeof harness>) => h.setModel("openai-codex", "changed"),
    (h: ReturnType<typeof harness>) => h.setBusy(true),
    (h: ReturnType<typeof harness>) => h.setBusy(false, true),
    (h: ReturnType<typeof harness>) => h.setBusy(false, false, 1),
  ];
  for (const mutate of mutations) { const h = harness(); h.supervisor.request(plan()); mutate(h); h.callbacks[0]!.callback(); assert.equal(h.sends.length, 0); }
});

test("lease releases before resume Promise settles and rejection never retries", async () => {
  const h = harness(); let reject!: (error: Error) => void;
  h.setSendResult(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  h.supervisor.request(plan()); h.callbacks[0]!.callback();
  h.setBranch([quota("new")]); h.supervisor.request(plan({ anchorEntryId: "new", resumeAt: NOW + 2000 }));
  assert.equal(h.callbacks.length, 2);
  reject(new Error("failed")); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sends.length, 1);
  h.supervisor.dispose(); assert.equal(h.callbacks[1]!.cancelled, true);
  h.callbacks[1]!.callback(); assert.equal(h.sends.length, 1);
});
