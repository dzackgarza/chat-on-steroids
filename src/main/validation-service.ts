/** The endpoint, never the worker, selects validation commands and follow-up scope. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { managedExecution, requireManagedIdentity } from './managed-execution.js';
import { validationRunner, validationResult, validationWait } from './validation-wait.js';

const execute = promisify(execFile);
async function unchanged(python: string, runner: string, prior: string): Promise<boolean> {
  return execute(python, [runner, 'unchanged', prior]).then(() => true, error => {
    if (error.code === 1) return false;
    throw error;
  });
}

export async function prepareValidation(id: string, consumer: string, requestId: string) {
  requireManagedIdentity(id);
  const config = managedExecution(id);
  if (!Object.hasOwn(config.consumers, consumer)) throw new Error('Unknown assigned consumer');
  const spec = {...config.spec, files: config.consumers[consumer]};
  await fs.mkdir(config.jobsRoot, {recursive: true});
  const runner = validationRunner();
  let prior: string | null = null;
  try { prior = JSON.parse(await fs.readFile(path.join(config.jobsRoot, 'active.json'), 'utf8')).directory; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const followup: string[] = [];
  if (prior) {
    const wait = await validationWait(prior);
    const manifest = JSON.parse(await fs.readFile(path.join(prior, 'manifest.json'), 'utf8'));
    if (manifest.requestId === requestId) return {wait, config, spec, runner, followup};
    const result = await validationResult(wait);
    // No consumer switch can discard a running or failed obligation.
    if (JSON.stringify(manifest.spec) !== JSON.stringify(spec)) {
      if (!result || result.exitCode !== 0 || manifest.selected.length)
        throw new Error('Finish the active consumer before selecting another');
    } else if (!result) return {wait, config, spec, runner, followup}; // recover a launch interrupted before scheduler persistence
    else if (result.error || result.signal || !result.inputsUnchanged)
      throw new Error(`Validation execution requires operator repair: ${prior}`);
    else if (result.exitCode !== 0) {
      if (!result.failedNodes.length) throw new Error(`Collection or runtime failed without a failed consumer: ${prior}`);
      if (await unchanged(config.python, runner, prior)) throw new Error('Repair the recorded failure before requesting another run');
      followup.push('--retry', prior);
    } else if (manifest.selected.length) followup.push('--full-after', prior);
    else {
      const same = await unchanged(config.python, runner, prior);
      if (same) return {wait, config, spec, runner, followup};
    }
  }
  return {wait: null, config, spec, runner, followup};
}

export async function launchValidation(id: string, consumer: string, requestId: string) {
  const {wait, config, spec, runner, followup} = await prepareValidation(id, consumer, requestId);
  if (wait) return wait;
  const specFile = path.join(config.jobsRoot, 'spec.json');
  await fs.writeFile(specFile, JSON.stringify(spec));
  // No timeout. Response/turn lifetime is independent of this detached process.
  const {stdout} = await execute(config.python, [runner, 'start', specFile, config.jobsRoot, '--request-id', requestId, ...followup]);
  return validationWait(JSON.parse(stdout).directory);
}

/** A bounded tail lets the worker repair the recorded failure without access to the job store. */
export async function validationOutput(directory: string): Promise<string> {
  const handle = await fs.open(path.join(directory, 'output.log'), 'r');
  try {
    const size = (await handle.stat()).size;
    const data = Buffer.alloc(Math.min(size, 24_000));
    await handle.read(data, 0, data.length, Math.max(0, size - data.length));
    return data.toString('utf8');
  } finally { await handle.close(); }
}
