import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Run the real built desktop entrypoint with isolated app state and its own instance lock.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-desktop-execution-'));
for (const mode of ['absent', 'malformed']) {
  const state = path.join(root, mode);
  await fs.mkdir(state);
  if (mode === 'malformed') await fs.writeFile(path.join(state, 'execution.json'), '{}');
  const entry = path.join(root, `${mode}.cjs`);
  await fs.writeFile(entry, `
const {app} = require('electron');
app.setPath('userData', ${JSON.stringify(state)});
process.on('unhandledRejection', error => {
  if (!/Execution configuration/.test(String(error))) { console.error(error); app.exit(1); return; }
  process.stdout.write('Required execution configuration refused startup\\n');
  app.exit(0);
});
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`);
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.COS_EXECUTION_CONFIG;
  delete env.COS_MANAGED_EXECUTION_CONFIG;
  const {stdout} = await promisify(execFile)('xvfb-run', ['-a', path.resolve('node_modules/electron/dist/electron'), '--no-sandbox', entry], {env, timeout: 20000});
  assert.match(stdout, /Required execution configuration refused startup/);
  assert(!await fs.stat(path.join(state, 'state')).then(() => true, () => false), 'Desktop reached service-state initialization');
}
console.log('Built Electron app refused missing and malformed execution configuration before service bootstrap.');
