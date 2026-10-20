/** A dedicated managed endpoint has one principal and no host command capability. */
import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const absolute = z.string().refine(value => path.isAbsolute(value) && !value.includes(','), 'Absolute native path required');
const configSchema = z.object({
  workstream: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  workspace: absolute, writablePaths: z.array(absolute), readPaths: z.array(absolute),
  developmentImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  docker: absolute, dockerGroup: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
  jobsRoot: absolute, python: absolute,
  spec: z.object({
    sources: z.record(z.string(), absolute), cwd: z.string(), argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()), transport: z.array(z.string()),
    mode: z.literal('pytest'), imports: z.array(z.string()), plugins: z.array(z.string()),
  }).strict(),
  consumers: z.record(z.string(), z.array(z.string()).min(1)),
}).strict();
export type ManagedExecution = z.infer<typeof configSchema>;
let loaded = false;
let policy: ManagedExecution | null = null;
export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** Configuration is operator-owned and immutable for this endpoint's lifetime. */
export function managedExecution(): ManagedExecution | null {
  if (loaded) return policy;
  const file = process.env.COS_MANAGED_EXECUTION_CONFIG;
  if (!file) { loaded = true; return null; }
  if (process.platform !== 'linux') throw new Error('Managed execution requires the Linux container service');
  const config = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  config.workspace = realpathSync(config.workspace);
  config.writablePaths = config.writablePaths.map(entry => realpathSync(entry));
  config.readPaths = config.readPaths.map(entry => realpathSync(entry));
  if (config.writablePaths.some(entry => !contains(config.workspace, entry) || entry === config.workspace))
    throw new Error('Writable development paths must be explicit children of the workspace');
  mkdirSync(config.jobsRoot, {recursive: true});
  config.jobsRoot = realpathSync(config.jobsRoot);
  const exposed = [config.workspace, ...config.readPaths];
  if (exposed.some(root => contains(root, realpathSync(file)) || contains(root, config.jobsRoot)))
    throw new Error('Execution policy and validation store must be outside worker-visible trees');
  policy = config;
  loaded = true;
  return config;
}

export function requireManagedIdentity(id: string | null): void {
  const config = managedExecution();
  if (config && id !== config.workstream) throw new Error('This managed endpoint serves only its assigned workstream');
}

export function managedToolRefusal(id: string | null, tool: string): string | null {
  const config = managedExecution();
  if (!config) return null;
  if (id !== config.workstream) return 'MANAGED_IDENTITY_REQUIRED: use the assigned workstream on this endpoint.';
  if (!['read', 'find', 'view_image', 'apply_patch', 'exec_command', 'write_stdin', 'exec', 'list_roots'].includes(tool))
    return 'MANAGED_OPERATION_UNAVAILABLE: this endpoint owns development and structured validation only.';
  return null;
}

export function requireManagedPath(id: string | null, tool: string, target: string): void {
  const config = managedExecution();
  if (!config) return;
  requireManagedIdentity(id);
  const roots = tool === 'apply_patch' ? config.writablePaths : [config.workspace, ...config.readPaths];
  if (!roots.some(root => contains(root, target))) throw new Error('Path is outside this managed operation\'s permitted source trees');
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function developmentCommand(id: string | null, cwd: string, command: string): string[] {
  const config = managedExecution();
  if (!config) throw new Error('Development container requested without a managed policy');
  requireManagedIdentity(id);
  if (!contains(config.workspace, cwd)) throw new Error('Development command cwd must be in the assigned workspace');
  const args = [config.docker, 'run', '--rm', '-i', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--pids-limit', '256',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--workdir', cwd, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/bin:/bin'];
  for (const root of [config.workspace, ...config.readPaths])
    args.push('--mount', `type=bind,src=${root},dst=${root},readonly`);
  for (const root of config.writablePaths)
    args.push('--mount', `type=bind,src=${root},dst=${root}`);
  args.push(config.developmentImage, '/bin/sh', '-c', command);
  return ['/usr/bin/sg', config.dockerGroup, '-c', args.map(quote).join(' ')];
}
