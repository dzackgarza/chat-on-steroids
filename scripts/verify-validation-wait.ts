import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initDurableStore } from '../src/main/durable.js';
import * as streams from '../src/main/workstreams.js';

async function main() {
  assert.equal(typeof streams.waitForWorkstreamValidation, 'function', 'No executable validation wait');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cos-validation-wait-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'job.py'), 'import time\ntime.sleep(2)\nraise SystemExit(9)\n');
  const spec = path.join(root, 'spec.json');
  await fs.writeFile(spec, JSON.stringify({sources: {project: source}, cwd: '{project}',
    argv: ['python3', 'job.py'], env: {}, transport: [], mode: 'command'}));
  const {stdout} = await promisify(execFile)('python3', ['scripts/validation-run.py', 'start', spec, path.join(root, 'jobs')]);
  const job = JSON.parse(stdout);
  initDurableStore(path.join(root, 'state'));
  await streams.restoreWorkstreams();
  const claim = await streams.startWorkstream('validation-proof', source);
  assert(claim.ok);
  await streams.bindWorkstreamConversation(claim.workstreamId, 'proof-chat');
  await streams.setWorkstreamAutoAdvance('validation-proof', true);
  await assert.rejects(streams.waitForWorkstreamValidation('validation-proof', 'another-claim', job.directory), /active worker claim/);
  await streams.waitForWorkstreamValidation('validation-proof', claim.workstreamId, job.directory);
  // The historical recorder lost browser turn observations while tools kept running.
  // Explicit handoff must work even when no turn_end event arrives.
  assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'A wait generated another worker turn');
  const restored = path.join(root, 'restored');
  await fs.mkdir(path.join(restored, 'state'), {recursive: true});
  await fs.copyFile(path.join(root, 'state/state/workstreams.json'), path.join(restored, 'state/workstreams.json'));
  initDurableStore(restored);
  await streams.restoreWorkstreams();
  assert(streams.workstreamStatus()[0]?.validationWait, 'Wait lost on persistence restore');
  await streams.pauseWorkstream('validation-proof');
  const resultDeadline = Date.now() + 15000;
  while (Date.now() < resultDeadline) {
    try { await fs.access(path.join(job.directory, 'result.json')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'Completion undid an owner pause');
  await streams.resumeWorkstream('validation-proof');
  const resultFile = path.join(job.directory, 'result.json');
  const originalResult = await fs.readFile(resultFile, 'utf8');
  await fs.writeFile(resultFile, JSON.stringify({...JSON.parse(originalResult), runId: 'another-run'}));
  assert.deepEqual(await streams.nextWorkstreamActions(Date.now(), true), [], 'Foreign result resumed this worker');
  assert(streams.workstreamStatus()[0]?.error?.includes('identity mismatch'));
  await fs.writeFile(resultFile, originalResult);
  await streams.configureWorkstream('validation-proof', 'Keep every individual command/check bounded below five minutes and prefer the narrow acceptance/oracle that falsifies the current artifact.');
  const deadline = Date.now() + 15000;
  let actions: ReturnType<typeof streams.workstreamStatus> = [];
  while (Date.now() < deadline && actions.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
    actions = await streams.nextWorkstreamActions(Date.now(), true);
  }
  assert.equal(actions.length, 1);
  const action = actions[0]!;
  assert.equal(action.validationWait, null);
  assert.match(action.actionId!, /^advance-wl_/);
  assert(!streams.workstreamPrompt(action, 'Core').includes('bounded below five minutes'));
  assert.equal(action.validationResult?.exitCode, 9);
  assert(streams.workstreamPrompt(action, 'Core').includes(job.directory));
  assert.equal((await streams.nextWorkstreamActions(Date.now(), true))[0]?.actionId, action.actionId, 'Completion scheduled duplicate actions');
  await streams.admitWorkstreamCall(claim.workstreamId);
  assert(!streams.workstreamPrompt(streams.workstreamStatus()[0]!, 'Core').includes('Validation finished:'), 'A consumed result was injected again on ordinary continuations');
  console.log('Real process wait suppresses turns, persists, and returns exact failing result in one action.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
