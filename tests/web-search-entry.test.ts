import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("actual Pi package extension entry loads search with clean HOME/agentDir", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-search-entry-"));
  try {
    const entry = new URL("../src/extension.ts", import.meta.url).pathname;
    const code = `
      import assert from 'node:assert/strict';
      import {mkdirSync} from 'node:fs';
      import {join} from 'node:path';
      import {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
      import {fauxProvider} from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
      const cwd=process.env.HOME, agentDir=process.env.PI_CODING_AGENT_DIR;
      mkdirSync(agentDir,{recursive:true});
      const settingsManager=SettingsManager.inMemory({});
      const modelRuntime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,refreshOnCreate:false});
      const faux=fauxProvider(); modelRuntime.registerNativeProvider(faux.provider);
      const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,additionalExtensionPaths:[${JSON.stringify(entry)}]});
      await loader.reload();
      const {session,extensionsResult}=await createAgentSession({cwd,agentDir,modelRuntime,model:faux.getModel(),resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(cwd)});
      try {
        assert.deepEqual(extensionsResult.errors,[]);
        await session.bindExtensions({});
        assert.ok(session.getActiveToolNames().includes('web_search'));
        assert.equal(session.getAllTools().filter(tool=>tool.name==='web_search').length,1);
        console.log('PASS actual src/extension.ts entry');
      } finally {session.dispose();}
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_WEB_SEARCH_CONFIG: join(root, "no-search-config.json"), PINDIE_REMOTE_ENABLED: "false", PINDIE_WORK_MEMORY_ENABLED: "false", PINDIE_PRESENTATION_ENABLED: "false" },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.match(child.stdout, /PASS actual src\/extension.ts entry/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
