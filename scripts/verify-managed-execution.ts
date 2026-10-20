import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

async function main() {
  const modulePath = path.resolve('src/main/managed-execution.ts');
  assert(await fs.stat(modulePath).then(() => true, () => false), 'Missing enforced development execution boundary');
  const python = process.argv[2];
  assert(python && path.isAbsolute(python), 'Usage: npm run verify:managed -- /absolute/pytest/python');
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/cos-managed-proof-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), {recursive: true});
  await fs.writeFile(path.join(workspace, 'frozen'), 'unchanged');
  const exec = promisify(execFile);
  await exec('git', ['init', workspace]);
  const docker = (await exec('/bin/sh', ['-c', 'command -v docker'])).stdout.trim();
  const image = (await exec('/usr/bin/sg', ['docker', '-c', `${docker} image inspect cos-validation-development:local --format "{{.Id}}"`])).stdout.trim();
  const config = path.join(root, 'policy.json');
  await fs.writeFile(config, JSON.stringify({workstream: 'proof', workspace,
    writablePaths: [path.join(workspace, 'src')], readPaths: [],
    developmentImage: image, docker, dockerGroup: 'docker',
    jobsRoot: path.join(root, 'jobs'), python,
    spec: {sources: {project: workspace}, cwd: '{project}', argv: [python], env: {PYTHONPATH: '{project}/src', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1'}, transport: [],
      mode: 'pytest', imports: [], plugins: []}, consumers: {fixture: ['test_consumer.py']}}));
  process.env.COS_MANAGED_EXECUTION_CONFIG = config;
  const managed = await import(modulePath);
  const command = managed.developmentCommand('proof', workspace,
    'python3 -c "import pathlib,importlib.util; assert importlib.util.find_spec(\'sage\') is None; assert not pathlib.Path(\'/run/docker.sock\').exists(); pathlib.Path(\'src/edited\').write_text(\'42\')" && printf boundary-ok');
  const result = await exec(command[0]!, command.slice(1));
  assert.equal(result.stdout, 'boundary-ok');
  assert.equal(await fs.readFile(path.join(workspace, 'src/edited'), 'utf8'), '42');
  const escaped = managed.developmentCommand('proof', workspace, 'printf changed > frozen');
  await assert.rejects(exec(escaped[0]!, escaped.slice(1)));
  assert.equal(await fs.readFile(path.join(workspace, 'frozen'), 'utf8'), 'unchanged');
  assert.throws(() => managed.developmentCommand('other-stream', workspace, 'true'));
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'Use this isolated fixture.\n');
  await fs.writeFile(path.join(workspace, 'src/value.py'), 'value = 0\n');
  await fs.writeFile(path.join(workspace, 'test_consumer.py'), 'import pytest\nfrom value import value\n@pytest.mark.parametrize("case", [16, 160])\ndef test_case(case):\n    assert case != 16 or value == 42\n');
  await exec('git', ['-C', workspace, 'add', '.']);
  await exec('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Frozen consumer fixture']);
  const {initConfigPath, loadConfig, getConfig, effectiveCapabilities} = await import('../src/main/config.js');
  const {initDurableStore} = await import('../src/main/durable.js');
  const {initSessionStore} = await import('../src/main/session/store.js');
  const state = path.join(root, 'state');
  initConfigPath(state); initDurableStore(state); initSessionStore(state);
  await loadConfig();
  const {startMcpServer} = await import('../src/main/mcp/server.js');
  const streams = await import('../src/main/workstreams.js');
  const endpoint = await startMcpServer(() => ({roots: [{name: 'work', path: workspace}],
    caps: effectiveCapabilities(getConfig()), readOnly: false, agentTools: false}));
  let request = 0;
  async function call(name: string, args: Record<string, unknown>) {
    const response = await fetch(endpoint.url, {method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18'}, body: JSON.stringify({jsonrpc: '2.0', id: ++request,
        method: 'tools/call', params: {name, arguments: args}})});
    const raw = await response.text();
    const payload = JSON.parse(raw.startsWith('{') ? raw : raw.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    return payload.result ?? payload.error;
  }
  try {
    const setup = await call('workstream', {action: 'start', workstream: 'proof', path: '/work'});
    const claim = JSON.stringify(setup).match(/wl_[A-Za-z0-9_-]+/)?.[0];
    assert(claim, JSON.stringify(setup));
    await streams.bindWorkstreamConversation(claim, 'proof-chat');
    const policyRead = await call('read', {workstream_id: claim, paths: [config]});
    assert(policyRead.isError || JSON.stringify(policyRead).includes('not inside an approved folder'), JSON.stringify(policyRead));
    const read = await call('read', {workstream_id: claim, paths: ['/work/AGENTS.md']});
    assert(!read.isError, JSON.stringify(read));
    const direct = await call('exec_command', {workstream_id: claim, cmd: 'test ! -S /run/docker.sock && test ! -e /usr/bin/sage && printf direct-ok', workdir: '/work'});
    assert.match(JSON.stringify(direct), /direct-ok/);
    assert(!direct.isError, JSON.stringify(direct));
    const nested = await call('exec', {workstream_id: claim, code: 'text(await tools.exec_command({cmd:"test ! -S /run/docker.sock && test ! -e /usr/bin/sage && printf nested-ok",workdir:"/work"}))'});
    assert.match(JSON.stringify(nested), /nested-ok/);
    assert(!nested.isError, JSON.stringify(nested));
    const patch = await call('apply_patch', {workstream_id: claim, patch: '*** Begin Patch\n*** Update File: frozen\n@@\n-unchanged\n+changed\n*** End Patch'});
    assert(patch.isError, JSON.stringify(patch));
    assert.equal(await fs.readFile(path.join(workspace, 'frozen'), 'utf8'), 'unchanged');
    const other = await call('workstream', {action: 'start', workstream: 'escape', path: '/work'});
    assert(other.isError, JSON.stringify(other));
    assert.equal(streams.workstreamStatus().length, 1);
    const extra = await call('workstream', {action: 'validate', workstream: 'proof', workstream_id: claim, consumer: 'fixture', timeout: 275});
    assert(extra.isError || extra.code, JSON.stringify(extra));
    assert(!streams.workstreamStatus()[0]?.validationRequest, 'Rejected override persisted a request');
    const validate = () => call('workstream', {action: 'validate', workstream: 'proof', workstream_id: claim, consumer: 'fixture'});
    const launched = await validate();
    assert(!launched.isError, JSON.stringify(launched));
    const first = streams.workstreamStatus()[0]!.validationWait!;
    assert(first, 'Launch did not register wait');
    assert(await streams.configureWorkstream('proof', 'Corrected dispatch while validation retains its process.'));
    const duplicate = await validate();
    assert(!duplicate.isError, JSON.stringify(duplicate));
    assert.equal(streams.workstreamStatus()[0]!.validationWait?.runId, first.runId);
    async function finish() {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await streams.nextWorkstreamActions(Date.now(), true);
        const row = streams.workstreamStatus()[0]!;
        if (row.validationResult && !row.validationWait) return row;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Fixture result was not delivered');
    }
    await streams.restoreWorkstreams();
    assert.equal(streams.workstreamStatus()[0]!.validationWait?.runId, first.runId);
    const failed = await finish();
    assert.match(streams.workstreamPrompt(failed, 'Core'), /Corrected dispatch/);
    assert.deepEqual(failed.validationResult?.failedNodes, ['test_consumer.py::test_case[16]']);
    assert.match(failed.validationOutput!, /FAILED/);
    const repeated = await validate();
    assert(repeated.isError, 'Unrepaired failure launched another run');
    assert.match(JSON.stringify(repeated), /Repair the recorded failure/);
    assert(!streams.workstreamStatus()[0]?.validationRequest);
    const repair = await call('exec_command', {workstream_id: claim, workdir: '/work', cmd: "printf 'value = 42\\n' > src/value.py"});
    assert(!repair.isError, JSON.stringify(repair));
    const retry = await validate();
    assert(!retry.isError, JSON.stringify(retry));
    const retryWait = streams.workstreamStatus()[0]!.validationWait!;
    const retryManifest = JSON.parse(await fs.readFile(path.join(retryWait.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(retryManifest.selected, ['test_consumer.py::test_case[16]']);
    // The full pass must use the repaired snapshot even if development proceeds meanwhile.
    await fs.writeFile(path.join(workspace, 'src/value.py'), 'value = 99\n');
    const passed = await finish();
    assert.equal(passed.validationResult?.exitCode, 0, JSON.stringify(passed));
    const fullManifest = JSON.parse(await fs.readFile(path.join(passed.validationResult!.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(fullManifest.selected, []);
    assert.deepEqual(fullManifest.inputs, retryManifest.inputs);
    assert.equal(fullManifest.previous, retryWait.directory);
    console.log('Actual MCP validation: launch owns wait; duplicate retained; exact failure retry automatically followed by full consumer on identical snapshot.');
    console.log('Actual MCP HTTP: direct and nested commands confined; frozen patch and alternate identity refused.');
  } finally { await endpoint.stop({forceAfterMs: 1000}); }
  console.log('Real development container: source edits work; frozen files, Sage runtime and Docker socket unavailable.');
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
