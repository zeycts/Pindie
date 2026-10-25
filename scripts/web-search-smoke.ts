/** Opt-in paid/network smoke. No global packages/settings or production Host are used. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = process.env.PINDIE_WEB_SEARCH_AUTH_SOURCE;
if (!source) throw new Error("Set PINDIE_WEB_SEARCH_AUTH_SOURCE to an authorized Pi agent directory; credentials are copied privately, never printed.");
const root = await mkdtemp(join(tmpdir(), "pindie-bundled-search-smoke-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldSearchConfig = process.env.PI_WEB_SEARCH_CONFIG;
let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
try {
  await chmod(root, 0o700);
  const agentDir = join(root, "agent"), cwd = join(root, "project");
  await mkdir(agentDir, { mode: 0o700 }); await mkdir(cwd);
  for (const name of ["auth.json", "models.json", "models-store.json"]) {
    try { await copyFile(join(source, name), join(agentDir, name)); await chmod(join(agentDir, name), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const provider = process.env.PINDIE_WEB_SEARCH_PROVIDER ?? "openai-codex";
  const model = process.env.PINDIE_WEB_SEARCH_MODEL ?? "gpt-6.1-sol";
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [], defaultProvider: provider, defaultModel: model, defaultThinkingLevel: "medium" }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_SEARCH_CONFIG = join(agentDir, "web-search.json");
  const { createPindieRuntimeFactory } = await import("../src/host.ts");
  const { TaskMetricsTracker } = await import("../src/task-metrics.ts");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const factory = createPindieRuntimeFactory({}, new TaskMetricsTracker(), {
    env: {}, featureSelection: { remote: false, workMemory: false, bundledSkills: false, presentation: false },
    storageRoots: { projectsBaseDir: join(root, "state"), globalBaseDir: join(root, "global"), remoteRoutingBaseDir: join(root, "routing") },
  });
  const result = await factory({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  session = result.session;
  assert.deepEqual(result.extensionsResult.errors, []);
  const paths = result.extensionsResult.extensions.map(extension => extension.path);
  assert.ok(paths.some(path => path.includes("pindie-web-search")));
  assert.ok(paths.every(path => !path.includes("node_modules/pi-web-search")));
  assert.equal(session.model?.provider, provider); assert.equal(session.model?.id, model);
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes("web_search"));
  console.log(JSON.stringify({ agentDir, packages: [], extensions: paths, provider, model }));
  let successful = 0;
  session.subscribe(event => {
    if (event.type !== "tool_execution_end" || event.toolName !== "web_search") return;
    const details = event.result?.details as any;
    const passed = !event.isError && !details?.error && details?.nativeSearchUsed && details?.sources?.length > 0;
    if (passed) successful++;
    console.log(JSON.stringify({ searchPassed: Boolean(passed), nativeSearchUsed: details?.nativeSearchUsed,
      model: details?.model, events: details?.nativeSearchEvents, sources: details?.sources }));
  });
  const timeout = setTimeout(() => void session?.abort(), 150_000);
  try { await session.prompt("Use web_search once to find the latest Node.js release on its official site now. Return the version/date and official source URL. Do not use other tools or rely only on memory."); }
  finally { clearTimeout(timeout); }
  assert.ok(successful > 0, "Expected a successful native web search with actual sources");
  console.log("PASS: actual Pindie Host Session performed native search without any plugin package.");
} finally {
  try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
  finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldSearchConfig === undefined) delete process.env.PI_WEB_SEARCH_CONFIG; else process.env.PI_WEB_SEARCH_CONFIG = oldSearchConfig;
    await rm(root, { recursive: true, force: true });
  }
}
