/** Every app endpoint uses operator-owned workstream policies; there is no host-command mode. */
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const absolute = z.string().refine(value => path.isAbsolute(value) && !value.includes(','), 'Absolute native path required');
const configSchema = z.object({
  workstream: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  workspace: absolute, writablePaths: z.array(absolute), readPaths: z.array(absolute),
  developmentImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  validationImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  docker: absolute, dockerGroup: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  jobsRoot: absolute, python: absolute,
  spec: z.object({
    sources: z.record(z.string(), absolute), cwd: z.string(), argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()),
    mode: z.literal('pytest'), imports: z.array(z.string()), plugins: z.array(z.string()),
  }).strict(),
  consumers: z.record(z.string(), z.array(z.string()).min(1)),
}).strict();
export type ManagedExecution = z.infer<typeof configSchema>;
let policies: Map<string, ManagedExecution> | null = null;
let configFile: string | null = null;

/** Both normal entrypoints resolve the same required file before starting services. */
export function initExecutionConfig(userData: string): void {
  configFile = process.env.COS_EXECUTION_CONFIG || path.join(userData, 'execution.json');
  const configs = executionPolicies();
  mkdirSync(userData, {recursive: true});
  const state = realpathSync(userData);
  if (configs.some(config => [config.workspace, ...config.readPaths].some(root => contains(root, state))))
    throw new Error('Execution configuration exposes app state to a worker');
}

export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** Missing or invalid configuration is an error, never permission to use host execution. */
export function executionPolicies(): ManagedExecution[] {
  if (policies) return [...policies.values()];
  const file = configFile ?? process.env.COS_EXECUTION_CONFIG;
  if (!file) throw new Error('Execution configuration is required before starting the app');
  if (process.platform !== 'linux') throw new Error('Execution configuration requires the Linux container service');
  let configs: ManagedExecution[];
  try {
    configs = z.array(configSchema).min(1).parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`Execution configuration could not be loaded: ${(error as Error).message}`);
  }
  const loaded = new Map<string, ManagedExecution>();
  for (const config of configs) {
    if (loaded.has(config.workstream)) throw new Error('Execution configuration has duplicate workstreams');
    config.workspace = realpathSync(config.workspace);
    config.writablePaths = config.writablePaths.map(entry => realpathSync(entry));
    config.readPaths = config.readPaths.map(entry => realpathSync(entry));
    if (config.writablePaths.some(entry => !contains(config.workspace, entry) || entry === config.workspace))
      throw new Error('Writable development paths must be explicit children of the workspace');
    mkdirSync(config.jobsRoot, {recursive: true});
    config.jobsRoot = realpathSync(config.jobsRoot);
    loaded.set(config.workstream, config);
  }
  const privatePaths = [realpathSync(file), ...configs.map(config => config.jobsRoot)];
  const exposed = configs.flatMap(config => [config.workspace, ...config.readPaths]);
  if (exposed.some(root => privatePaths.some(target => contains(root, target))))
    throw new Error('Execution configuration and validation stores must be outside every worker-visible tree');
  if (new Set(configs.map(config => config.jobsRoot)).size !== configs.length)
    throw new Error('Each workstream requires its own validation store');
  policies = loaded;
  return configs;
}

export function managedExecution(id: string | null): ManagedExecution {
  executionPolicies();
  const config = id ? policies!.get(id) : null;
  if (!config) throw new Error('No execution policy assigned to this workstream');
  return config;
}

export function requireManagedIdentity(id: string | null): void {
  managedExecution(id);
}

export function managedToolRefusal(id: string | null, tool: string): string | null {
  managedExecution(id);
  if (!['read', 'find', 'view_image', 'apply_patch', 'exec_command', 'write_stdin', 'exec', 'list_roots'].includes(tool))
    return 'MANAGED_OPERATION_UNAVAILABLE: this endpoint owns development and structured validation only.';
  return null;
}

export function requireManagedPath(id: string | null, tool: string, target: string): void {
  const config = managedExecution(id);
  const roots = tool === 'apply_patch' ? config.writablePaths : [config.workspace, ...config.readPaths];
  if (!roots.some(root => contains(root, target))) throw new Error('Path is outside this managed operation\'s permitted source trees');
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function sourceCommand(id: string | null, cwd: string, command: string, writable: boolean): string[] {
  const config = managedExecution(id);
  if (!contains(config.workspace, cwd)) throw new Error('Development command cwd must be in the assigned workspace');
  const args = [config.docker, 'run', '--rm', '-i', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--pids-limit', '256',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--workdir', cwd, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/bin:/bin'];
  for (const root of [config.workspace, ...config.readPaths])
    args.push('--mount', `type=bind,src=${root},dst=${root},readonly`);
  for (const root of writable ? config.writablePaths : [])
    args.push('--mount', `type=bind,src=${root},dst=${root}`);
  args.push(config.developmentImage, '/bin/sh', '-c', command);
  return ['/usr/bin/sg', config.dockerGroup, '-c', args.map(quote).join(' ')];
}

export function developmentCommand(id: string | null, cwd: string, command: string): string[] {
  return sourceCommand(id, cwd, command, true);
}

/** Repository configuration can execute programs even during a nominally read-only Git query. */
export function repositoryCommand(id: string | null, cwd: string, args: string[]): string[] {
  return sourceCommand(id, cwd, args.map(quote).join(' '), false);
}
