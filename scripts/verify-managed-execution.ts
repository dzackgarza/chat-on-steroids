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
  const hostOnly = path.join(root, 'host-only');
  const escapedWrite = path.join(root, 'escaped-write');
  await fs.writeFile(hostOnly, 'host-only');
  const state = path.join(root, 'state');
  await fs.mkdir(state);
  const otherWorkspace = path.join(root, 'other-workspace');
  await fs.mkdir(path.join(otherWorkspace, 'src'), {recursive: true});
  await fs.writeFile(path.join(otherWorkspace, 'AGENTS.md'), 'Use the second isolated fixture.\n');
  await fs.writeFile(path.join(otherWorkspace, 'src/marker'), 'second-workstream');
  await exec('git', ['init', otherWorkspace]);
  await exec('git', ['-C', otherWorkspace, 'add', '.']);
  await exec('git', ['-C', otherWorkspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Second workstream fixture']);
  const config = path.join(state, 'execution.json');
  await fs.writeFile(config, JSON.stringify([{workstream: 'proof', workspace,
    writablePaths: [path.join(workspace, 'src')], readPaths: [],
    developmentImage: image, validationImage: image, docker, dockerGroup: 'docker',
    jobsRoot: path.join(root, 'jobs'), python,
    spec: {sources: {project: workspace}, cwd: '{project}', argv: ['/usr/bin/python3'], env: {PYTHONPATH: '{project}/src', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1'},
      mode: 'pytest', imports: [], plugins: []}, consumers: {fixture: ['test_consumer.py']}}]));
  const policies = JSON.parse(await fs.readFile(config, 'utf8'));
  policies.push({...policies[0], workstream: 'proof-two', workspace: otherWorkspace,
    writablePaths: [path.join(otherWorkspace, 'src')], jobsRoot: path.join(root, 'jobs-two'),
    spec: {...policies[0].spec, sources: {project: otherWorkspace}}});
  await fs.writeFile(config, JSON.stringify(policies));
  delete process.env.COS_EXECUTION_CONFIG;
  process.env.COS_RECOVERY_CONVERSATION_KEY = 'old-recovery-chat';
  process.env.COS_RECOVERY_WORKSTREAM_LOCK = 'old-recovery-lock';
  const managed = await import(modulePath);
  managed.initExecutionConfig(state);
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
  await fs.writeFile(path.join(workspace, 'test_consumer.py'), 'import pytest, time\nfrom pathlib import Path\nfrom value import value\nif value == 0:\n    reports = Path(__file__).parents[2] / "reports"\n    (reports / "ready").write_text("running")\n    while not (reports / "release").exists():\n        time.sleep(.05)\n@pytest.mark.parametrize("case", [16, 160])\ndef test_case(case):\n    assert case != 16 or value == 42\n');
  await fs.writeFile(path.join(workspace, '.gitattributes'), '*.py diff=boundary\n');
  await fs.writeFile(path.join(workspace, 'src/converter.sh'),
    `#!/bin/sh\nif test -e '${hostOnly}'; then printf escaped > '${escapedWrite}'; fi\ncat "$1"\n`);
  await fs.chmod(path.join(workspace, 'src/converter.sh'), 0o755);
  await exec('git', ['-C', workspace, 'config', 'diff.boundary.textconv', path.join(workspace, 'src/converter.sh')]);
  await exec('git', ['-C', workspace, 'add', '.']);
  await exec('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Frozen consumer fixture']);
  const importProbe = `from pathlib import Path\nif Path(${JSON.stringify(hostOnly)}).exists():\n    Path(${JSON.stringify(escapedWrite)}).write_text('escaped')\n`;
  await fs.writeFile(path.join(workspace, 'src/value.py'), importProbe + 'value = 0\n');
  await exec('git', ['-C', workspace, 'diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--']);
  assert.equal(await fs.readFile(escapedWrite, 'utf8'), 'escaped', 'Fixture did not reproduce host Git execution');
  await fs.unlink(escapedWrite);
  const {initConfigPath, loadConfig, getConfig, effectiveCapabilities} = await import('../src/main/config.js');
  const {initDurableStore} = await import('../src/main/durable.js');
  const {initSessionStore} = await import('../src/main/session/store.js');
  initConfigPath(state); initDurableStore(state); initSessionStore(state);
  await loadConfig();
  const {startMcpServer} = await import('../src/main/mcp/server.js');
  const streams = await import('../src/main/workstreams.js');
  const endpoint = await startMcpServer(() => ({roots: [{name: 'work', path: workspace}, {name: 'second', path: otherWorkspace}],
    caps: effectiveCapabilities(getConfig()), readOnly: false, agentTools: false}));
  async function waitForFile(file: string) {
    const deadline = Date.now() + 20000;
    while (!await fs.stat(file).then(() => true, () => false)) {
      assert(Date.now() < deadline, `Fixture did not produce ${file}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
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
    const recovery = await call('exec_command', {workstream_id: 'old-recovery-lock', cmd: 'printf bypass', workdir: '/work'});
    assert(recovery.isError, 'Recovery credentials bypassed required workstream admission');
    const setup = await call('workstream', {action: 'start', workstream: 'proof', path: '/work'});
    let claim = JSON.stringify(setup).match(/wl_[A-Za-z0-9_-]+/)?.[0];
    assert(claim, JSON.stringify(setup));
    await streams.bindWorkstreamConversation(claim, 'proof-chat');
    await streams.setWorkstreamAutoAdvance('proof', true);
    const policyRead = await call('read', {workstream_id: claim, paths: [config]});
    assert(policyRead.isError || JSON.stringify(policyRead).includes('not inside an approved folder'), JSON.stringify(policyRead));
    const read = await call('read', {workstream_id: claim, paths: ['/work/AGENTS.md']});
    assert(!read.isError, JSON.stringify(read));
    const direct = await call('exec_command', {workstream_id: claim, cmd: 'test ! -S /run/docker.sock && test ! -e /usr/bin/sage && printf direct-ok', workdir: '/work'});
    assert.match(JSON.stringify(direct), /direct-ok/);
    assert(!direct.isError, JSON.stringify(direct));
    assert(!await fs.stat(escapedWrite).then(() => true, () => false), 'Repository Git executed with host access');
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
    // A source disappearing at launch is a real filesystem failure, not a fake runner result.
    await fs.rename(workspace, workspace + '-saved');
    try {
      const unavailable = await validate();
      assert(unavailable.isError, JSON.stringify(unavailable));
    } finally { await fs.rename(workspace + '-saved', workspace); }
    const failedLaunchFiles = await fs.readdir(path.join(root, 'jobs'));
    const afterFailureRead = await call('read', {workstream_id: claim, paths: ['/work/AGENTS.md']});
    assert(!afterFailureRead.isError, JSON.stringify(afterFailureRead));
    await streams.nextWorkstreamActions(Date.now(), true);
    await streams.nextWorkstreamActions(Date.now(), true);
    assert.deepEqual(await fs.readdir(path.join(root, 'jobs')), failedLaunchFiles, 'Scheduler repeated a failed launch');
    assert(streams.workstreamStatus()[0]!.validationRequest?.launchError, 'Launch failure was erased by a read');
    const reclaimed = await streams.continueWorkstream('proof', Date.now() + 24 * 60 * 60 * 1000);
    assert(reclaimed.ok, JSON.stringify(reclaimed));
    claim = reclaimed.workstreamId;
    await streams.bindWorkstreamConversation(claim, 'proof-chat');
    initDurableStore(path.join(root, 'empty-state'));
    await streams.restoreWorkstreams();
    assert.equal(streams.workstreamStatus().length, 0);
    initDurableStore(state);
    await streams.restoreWorkstreams();
    await streams.nextWorkstreamActions(Date.now(), true);
    assert.deepEqual(await fs.readdir(path.join(root, 'jobs')), failedLaunchFiles, 'Reclaim/restart repeated a failed launch');
    const launched = await validate();
    assert(!launched.isError, JSON.stringify(launched));
    const first = streams.workstreamStatus()[0]!.validationWait!;
    assert(first, 'Launch did not register wait');
    await waitForFile(path.join(first.directory, 'reports', 'ready'));
    assert(await streams.scheduleWorkstreamAfterTurn('proof-chat', 'validation-pending-turn', 'completed', Date.now()));
    assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'Running validation generated a polling turn');
    assert.deepEqual(await streams.nextWorkstreamActions(Date.now() + 24 * 60 * 60 * 1000, true), [], 'Elapsed time interrupted validation waiting');
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
    initDurableStore(path.join(root, 'empty-state'));
    await streams.restoreWorkstreams();
    assert.equal(streams.workstreamStatus().length, 0);
    initDurableStore(state);
    await streams.restoreWorkstreams();
    assert.equal(streams.workstreamStatus()[0]!.validationWait?.runId, first.runId);
    await streams.pauseWorkstream('proof');
    const resultFile = path.join(first.directory, 'result.json');
    await fs.writeFile(path.join(first.directory, 'reports', 'release'), 'finish');
    await waitForFile(resultFile);
    assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'Validation undid an owner pause');
    await streams.resumeWorkstream('proof');
    const originalResult = await fs.readFile(resultFile, 'utf8');
    await fs.writeFile(resultFile, JSON.stringify({...JSON.parse(originalResult), runId: 'foreign-run'}));
    assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'Mismatched result resumed this worker');
    assert.match(streams.workstreamStatus()[0]!.error!, /identity mismatch/);
    await fs.writeFile(resultFile, originalResult);
    const failed = await finish();
    assert(!await fs.stat(escapedWrite).then(() => true, () => false), 'Validation import executed with host access');
    assert.match(streams.workstreamPrompt(failed, 'Core'), /Corrected dispatch/);
    assert.deepEqual(failed.validationResult?.failedNodes, ['test_consumer.py::test_case[16]']);
    assert.match(failed.validationOutput!, /FAILED/);
    const obsolete = await call('workstream', {action: 'wait', workstream: 'proof', workstream_id: claim, validation_directory: first.directory});
    assert(obsolete.isError || obsolete.code, 'Caller-supplied validation receipt was accepted');
    const repeated = await validate();
    assert(repeated.isError, 'Unrepaired failure launched another run');
    assert.match(JSON.stringify(repeated), /Repair the recorded failure/);
    assert(!streams.workstreamStatus()[0]?.validationRequest);
    assert(!streams.workstreamPrompt(streams.workstreamStatus()[0]!, 'Core').includes('Validation finished:'), 'Result was offered again after worker resumed');
    const repair = await call('exec_command', {workstream_id: claim, workdir: '/work', cmd: "printf 'value = 42\\n' > src/value.py"});
    assert(!repair.isError, JSON.stringify(repair));
    const retry = await validate();
    assert(!retry.isError, JSON.stringify(retry));
    const retryWait = streams.workstreamStatus()[0]!.validationWait!;
    const retryManifest = JSON.parse(await fs.readFile(path.join(retryWait.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(retryManifest.selected, ['test_consumer.py::test_case[16]']);
    // The full pass must use the repaired snapshot even if development proceeds meanwhile.
    await fs.writeFile(path.join(workspace, 'src/value.py'), 'value = 99\n');
    await waitForFile(path.join(retryWait.directory, 'result.json'));
    const inputs = path.join(retryWait.directory, 'inputs');
    await fs.rename(inputs, inputs + '-held');
    try {
      assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), []);
      assert(streams.workstreamStatus()[0]!.validationRequest?.launchError, 'Failed automatic full launch did not retain its error');
    } finally { await fs.rename(inputs + '-held', inputs); }
    const afterFullFailure = await fs.readdir(path.join(root, 'jobs'));
    await call('read', {workstream_id: claim, paths: ['/work/AGENTS.md']});
    await streams.nextWorkstreamActions(Date.now(), true);
    assert.deepEqual(await fs.readdir(path.join(root, 'jobs')), afterFullFailure, 'Full launch retried without an explicit request');
    assert(!(await validate()).isError, 'Explicit full-launch retry was refused');
    const passed = await finish();
    assert.equal(passed.validationResult?.exitCode, 0, JSON.stringify(passed));
    const fullManifest = JSON.parse(await fs.readFile(path.join(passed.validationResult!.directory, 'manifest.json'), 'utf8'));
    assert.deepEqual(fullManifest.selected, []);
    assert.deepEqual(fullManifest.inputs, retryManifest.inputs);
    assert.equal(fullManifest.previous, retryWait.directory);
    const second = await call('workstream', {action: 'start', workstream: 'proof-two', path: '/second'});
    const secondClaim = JSON.stringify(second).match(/wl_[A-Za-z0-9_-]+/)?.[0];
    assert(secondClaim, JSON.stringify(second));
    const secondRead = await call('read', {workstream_id: secondClaim, paths: ['/second/AGENTS.md']});
    assert(!secondRead.isError, JSON.stringify(secondRead));
    const ownSource = await call('exec_command', {workstream_id: secondClaim, workdir: '/second', cmd: 'cat src/marker'});
    assert.match(JSON.stringify(ownSource), /second-workstream/);
    const foreign = await call('exec_command', {workstream_id: secondClaim, workdir: '/work', cmd: 'cat src/value.py'});
    assert(foreign.isError, 'Another configured workstream obtained this source authority');
    console.log('Normal app endpoint: multiple workstreams remain confined to their assigned policies.');
    console.log('Actual MCP validation: launch owns wait; duplicate retained; exact failure retry automatically followed by full consumer on identical snapshot.');
    console.log('Actual MCP HTTP: direct and nested commands confined; frozen patch and alternate identity refused.');
  } finally { await endpoint.stop({forceAfterMs: 1000}); }
  console.log('Real development container: source edits work; frozen files, Sage runtime and Docker socket unavailable.');
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
