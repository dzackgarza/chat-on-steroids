/** Real filesystem regression: changed approved roots cannot expand authority.
 * Run: npx tsx scripts/test-sandbox-approved-alias.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePath, resolveRoot, SandboxError } from '../src/main/sandbox';
import type { Root } from '../src/shared/types';

void (async () => {
const temp = await mkdtemp(path.join(tmpdir(), 'core2-approved-alias-'));
try {
  const home = path.join(temp, 'home');
  const elsewhere = path.join(temp, 'outside');
  const storage = path.join(home, '.local', 'data');
  await mkdir(storage, { recursive: true });
  await mkdir(elsewhere);
  await writeFile(path.join(storage, 'AGENTS.md'), 'source');
  await writeFile(path.join(elsewhere, 'private'), 'must not expose');
  const alias = path.join(home, 'research');
  await symlink(storage, alias, 'dir');
  const roots: Root[] = [{ name: 'research', path: alias }, { name: 'home', path: home }];

  const expected = await realpath(path.join(storage, 'AGENTS.md'));
  const read = await resolvePath(roots, '/research/AGENTS.md');
  assert.equal(read.real, expected);
  assert.equal(read.virtual, '/research/AGENTS.md');
  assert.equal((await resolveRoot(roots, 'research')).real, storage);
  assert.equal((await resolvePath(roots, '/home/.local/data/AGENTS.md')).real, expected);

  // Without an independently valid approval, a symlink root remains forbidden.
  await assert.rejects(resolvePath([roots[0]!], '/research/AGENTS.md'), SandboxError);
  await assert.rejects(resolveRoot([roots[0]!], 'research'), SandboxError);

  // Retargeting outside the approved union does not gain access.
  await rm(alias);
  await symlink(elsewhere, alias, 'dir');
  await assert.rejects(resolvePath(roots, '/research/private'), SandboxError);
  await assert.rejects(resolveRoot(roots, 'research'), SandboxError);
  await rm(alias);
  await symlink(storage, alias, 'dir');
  await symlink(elsewhere, path.join(storage, 'escape'), 'dir');
  await assert.rejects(resolvePath(roots, '/research/escape/private'), SandboxError);

  // A second changed root cannot certify the alias by chaining permissions.
  const secondAlias = path.join(temp, 'home-alias');
  await symlink(home, secondAlias, 'dir');
  await assert.rejects(
    resolvePath([{ name: 'research', path: alias }, { name: 'home', path: secondAlias }], '/research/AGENTS.md'),
    SandboxError,
  );
  console.log('PASS: approved relocation alias and negative containment cases');
} finally {
  await rm(temp, { recursive: true, force: true });
}
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
