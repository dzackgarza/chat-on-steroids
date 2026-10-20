/** Execution receipts schedule work; they never grant mathematical acceptance. */
import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const validationWaitSchema = z.object({
  directory: z.string(), runId: z.string(), manifestHash: z.string(),
});
export const validationResultSchema = z.object({
  directory: z.string(), runId: z.string(), manifestHash: z.string(),
  exitCode: z.number().int().nullable(), signal: z.number().nullable(),
  error: z.string().nullable(), failedNodes: z.array(z.string()), inputsUnchanged: z.boolean(),
});
export type ValidationWait = z.infer<typeof validationWaitSchema>;

async function readBounded(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('Validation record exceeds 16 MiB');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function validationWait(directory: string): Promise<ValidationWait> {
  const real = await fs.realpath(directory);
  const raw = await readBounded(path.join(real, 'manifest.json'));
  const manifest = z.object({ version: z.literal(1), runId: z.string().uuid() }).parse(JSON.parse(raw));
  if (path.basename(real) !== manifest.runId) throw new Error('Validation directory/run identity mismatch');
  return { directory: real, runId: manifest.runId,
    manifestHash: createHash('sha256').update(raw).digest('hex') };
}

export async function validationResult(wait: ValidationWait) {
  let raw: string;
  try { raw = await readBounded(path.join(wait.directory, 'result.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const result = validationResultSchema.parse({ ...JSON.parse(raw), directory: wait.directory });
  const current = await validationWait(wait.directory);
  if (result.runId !== wait.runId || result.manifestHash !== wait.manifestHash ||
      current.manifestHash !== wait.manifestHash) throw new Error('Validation result/source identity mismatch');
  return result;
}

/** Native POSIX runner resources; Windows can still hand off externally produced receipts. */
export function validationLauncher(): string | null {
  if (process.platform === 'win32') return null;
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, 'validation', 'sage-validation.py') : null;
  const source = path.resolve(__dirname, '../../scripts/sage-validation.py');
  if (packaged && existsSync(packaged)) return packaged;
  if (existsSync(source)) return source;
  throw new Error('Validation launcher resource is missing');
}
