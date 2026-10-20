/** Dedicated service entrypoint: absence of policy must never produce a host-shell endpoint. */
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contains, managedExecution } from './managed-execution.js';

const policy = managedExecution();
if (!policy) throw new Error('COS_MANAGED_EXECUTION_CONFIG is required');
const data = process.env.COS_DATA_DIR;
if (!data || !path.isAbsolute(data)) throw new Error('COS_DATA_DIR must name a dedicated absolute service directory');
mkdirSync(data, {recursive: true});
const real = realpathSync(data);
if (real === path.join(os.homedir(), '.config/chat-on-steroids') ||
    [policy.workspace, ...policy.readPaths].some(root => contains(root, real)))
  throw new Error('Managed service state must be separate from the existing app and worker-visible trees');
if (!process.env.COS_PORT || !process.env.CLF_BRIDGE_PORTS)
  throw new Error('Set COS_PORT and CLF_BRIDGE_PORTS for this separate service (0 allocates unused ports)');
process.env.COS_ROOT = policy.workspace;
void import('./headless.js');
