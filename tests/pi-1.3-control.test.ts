import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PindieControlClient, PindieControlError } from "../src/control-client.ts";
import { createPindieHost, type PindieHost } from "../src/host.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

for (const stop of [false, true]) {
  test(`Pi 1.3.0 Control during native preflight: ${stop ? "stop aborts" : "queues and settles"}`, { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "pindie-pi130-control-"));
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(project);
    await mkdir(agentDir);
    const faux = fauxProvider({ provider: `preflight-${Date.now()}-${stop}` });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.refresh({ allowNetwork: false });
    const entered = barrier();
    const resume = barrier();
    let host: PindieHost | undefined;
    let control: PindieControlClient | undefined;
    let preflights = 0;
    let starts = 0;
    const settlements: boolean[] = [];
    try {
      host = await createPindieHost({ cwd: project, agentDir, sessionManager: SessionManager.inMemory(project),
        storageRoots: { projectsBaseDir: join(root, "state"), globalBaseDir: join(root, "global"), remoteRoutingBaseDir: join(root, "routing") },
        env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_TUI: "0", PINDIE_AUTONOMOUS_LEARNING_ENABLED: "0", PINDIE_REMOTE_ENABLED: "false", PINDIE_WORK_MEMORY_ENABLED: "false" },
        dependencies: {
          createAgentSessionServices: (options) => createAgentSessionServices({ ...options, modelRuntime,
            resourceLoaderOptions: { ...options.resourceLoaderOptions,
              extensionFactories: [...options.resourceLoaderOptions?.extensionFactories ?? [], (pi) => {
                pi.on("input", (event) => event.text.startsWith("consume:") ? { action: "handled" } : undefined);
                pi.on("before_agent_start", async (_event, ctx) => {
                  preflights++;
                  assert.equal(ctx.isIdle(), false);
                  entered.release();
                  await resume.promise;
                });
              }],
            },
          }),
          createAgentSessionFromServices: (options) => createAgentSessionFromServices({ ...options, model: faux.getModel() }),
          createInteractiveMode: () => ({ run: async () => {} }),
        },
      });
      control = new PindieControlClient(host.runtime, host.presentation, {
        bindActiveSession: () => host!.runtime.bindActiveSessionExtensions({ mode: "print" }),
      });
      await control.start();
      host.runtime.activeSession.subscribe((event) => {
        if (event.type === "agent_start") starts++;
        if (event.type === "agent_settled") settlements.push(event.aborted);
      });
      faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("complete")));
      const before = control.observe();
      const input = control.input({ lease: before.lease, text: "initial input" });
      await entered.promise;
      assert.equal(starts, 0);
      assert.equal(control.observe().runtime.idle, false);
      for (const timing of ["now", "after_current_run"] as const) {
        await assert.rejects(control.input({ lease: before.lease, text: `consume:${timing}`, timing }),
          (error: unknown) => error instanceof PindieControlError && error.code === "delivery_failed");
        const queued = await control.input({ lease: before.lease, text: `queued:${timing}`, timing });
        assert.equal(queued.delivery, timing === "now" ? "steer" : "followUp");
      }
      assert.equal(host.runtime.getActiveSessionFacts().pendingMessageCount, 2);
      let waitResolved = false;
      const wait = control.wait({ lease: before.lease, until: "settled", timeoutSeconds: 5 }).then((result) => { waitResolved = true; return result; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitResolved, false);
      const stopped = stop ? control.stop({ lease: before.lease }) : undefined;
      resume.release();
      await stopped;
      assert.equal((await input).delivery, "prompt");
      assert.equal((await wait).reason, "settled");
      assert.equal(preflights, 1);
      assert.deepEqual(settlements, [stop]);
      assert.equal(host.runtime.getActiveSessionFacts().pendingMessageCount, 0);
      const timeline = control.readTimeline().timeline;
      for (const text of ["initial input", "queued:now", "queued:after_current_run"]) {
        assert.equal(timeline.filter((block) => block.type === "message" && block.text === text).length, 1);
      }
      assert.equal(timeline.some((block) => block.type === "message" && block.text.startsWith("consume:")), false);
      const replaced = await control.freshSession({ lease: before.lease });
      assert.notEqual(replaced.snapshot.lease, before.lease);
      await assert.rejects(control.input({ lease: before.lease, text: "stale" }),
        (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
    } finally {
      resume.release();
      control?.dispose();
      await host?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
