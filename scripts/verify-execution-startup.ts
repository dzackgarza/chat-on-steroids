import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

async function main() {
  const mode = process.argv[2];
  if (!mode) {
    for (const probe of ['absent', 'malformed']) {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', import.meta.filename, probe]);
    }
    for (const probe of ['absent', 'malformed']) {
      const data = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-headless-startup-'));
      if (probe === 'malformed') await fs.writeFile(path.join(data, 'execution.json'), '{}');
      const env: NodeJS.ProcessEnv = {...process.env, COS_DATA_DIR: data};
      delete env.COS_EXECUTION_CONFIG;
      delete env.COS_MANAGED_EXECUTION_CONFIG;
      await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main/headless.ts'], {env}), /Execution configuration/);
    }
    console.log('Normal MCP startup refuses absent or malformed execution configuration before exposing an endpoint.');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-execution-startup-'));
  delete process.env.COS_EXECUTION_CONFIG;
  delete process.env.COS_MANAGED_EXECUTION_CONFIG;
  if (mode === 'malformed') {
    const config = path.join(root, 'execution.json');
    await fs.writeFile(config, '{}');
    process.env.COS_EXECUTION_CONFIG = config;
  }
  const {initConfigPath, loadConfig, getConfig, effectiveCapabilities} = await import('../src/main/config.js');
  const {initDurableStore} = await import('../src/main/durable.js');
  const {initSessionStore} = await import('../src/main/session/store.js');
  initConfigPath(root); initDurableStore(root); initSessionStore(root);
  await loadConfig();
  const {startMcpServer} = await import('../src/main/mcp/server.js');
  await assert.rejects(async () => {
    const endpoint = await startMcpServer(() => ({roots: [{name: 'work', path: root}],
      caps: effectiveCapabilities(getConfig()), readOnly: false}));
    await endpoint.stop({forceAfterMs: 1000});
  }, /Execution configuration/i, 'Normal startup exposed an endpoint without required execution policy');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
