import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initDurableStore, flushDurable } from '../src/main/durable.js';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { defaultConfig, effectiveCapabilities } from '../src/main/config.js';
import { conversationKeyForCommand } from '../src/main/session/conversation-key.js';
import { claimWorkstream, nextWorkstreamActions, restoreWorkstreams, workstreamStatus, noteWorkstreamChatActivity, finishWorkstreamArchive, recordWorkstreamCommand, bindWorkstreamReplacement, WORKSTREAM_LEASE_MS } from '../src/main/workstreams.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let endpoint: McpEndpoint;
let serial = 0;
beforeEach(async () => {
  dir = await makeTempDir('workstream-');
  initDurableStore(dir);
  endpoint = await startMcpServer(() => ({
    roots: [{ name: 'project', path: dir }], caps: effectiveCapabilities(defaultConfig()),
    readOnly: false, sessionTools: false, agentTools: false
  }));
});
afterEach(async () => {
  await endpoint.stop();
  await flushDurable();
  await removeTempDir(dir);
});
async function call(key: string, lock: string | undefined, patch: string) {
  const response = await fetch(endpoint.url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method: 'tools/call', params: {
      name: 'apply_patch', arguments: { conversation_key: key, ...(lock ? { workstream_lock: lock } : {}), patch }
    } })
  });
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5));
}
const patch = '*** Begin Patch\n*** Add File: /project/result.txt\n+successor owns this\n*** End Patch';

it('fences an expired owner at the actual mutation boundary after immediate takeover', async () => {
  const old = conversationKeyForCommand('old', 'old-chat');
  const next = conversationKeyForCommand('next', 'next-chat');
  const issued = await claimWorkstream(old, 'old-chat', 'research', Date.now() - WORKSTREAM_LEASE_MS);
  if (!issued.ok) throw new Error(issued.code);
  const takeover = await claimWorkstream(next, 'next-chat', 'research');
  if (!takeover.ok) throw new Error(takeover.code);
  for (const lock of [issued.lock, undefined, 'claim:research', 'claim:another-stream']) {
    await call(old, lock, patch);
    await expect(fs.stat(path.join(dir, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await call(next, takeover.lock, patch);
  expect(await fs.readFile(path.join(dir, 'result.txt'), 'utf8')).toBe('successor owns this\n');
});

it('bounds recovery at three attempts, persists the episode, and requires archive confirmation before replacement', async () => {
  const key = conversationKeyForCommand('recovery', 'failed-chat');
  const start = Date.now();
  await claimWorkstream(key, 'failed-chat', 'research', start);
  expect(await nextWorkstreamActions(start + WORKSTREAM_LEASE_MS - 1)).toEqual([]);
  let actions = await nextWorkstreamActions(start + WORKSTREAM_LEASE_MS);
  expect(actions.map((row) => [row.phase, row.attempts])).toEqual([['recovering', 1]]);
  await recordWorkstreamCommand('research', actions[0]!.actionId!, 'first-push');
  const firstDeadline = actions[0]!.nextCheck;
  await flushDurable();
  initDurableStore(path.join(dir, 'other'));
  await restoreWorkstreams();
  initDurableStore(dir);
  await restoreWorkstreams();
  actions = await nextWorkstreamActions(firstDeadline - 1);
  expect(actions[0]!.commandId).toBe('first-push');
  actions = await nextWorkstreamActions(firstDeadline);
  expect(actions[0]!.attempts).toBe(2);
  actions = await nextWorkstreamActions(actions[0]!.nextCheck);
  expect(actions[0]!.attempts).toBe(3);
  actions = await nextWorkstreamActions(actions[0]!.nextCheck);
  expect(actions[0]!.phase).toBe('archiving');
  await bindWorkstreamReplacement('not-acknowledged', 'other-key', 'other-chat');
  expect(workstreamStatus()[0]!.conversationId).toBe('failed-chat');
  expect(await finishWorkstreamArchive('research', 'stale-action', null)).toBe(false);
  expect(await finishWorkstreamArchive('research', actions[0]!.actionId!, null)).toBe(true);
  const opening = workstreamStatus()[0]!;
  await recordWorkstreamCommand('research', opening.actionId!, 'replacement');
  const replacementKey = conversationKeyForCommand('replacement', 'replacement-chat');
  await bindWorkstreamReplacement('replacement', replacementKey, 'replacement-chat');
  const lease = workstreamStatus()[0]!;
  await call(key, actions[0]!.lock, patch);
  await expect(fs.stat(path.join(dir, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await call(replacementKey, lease.lock, patch);
  expect(await fs.readFile(path.join(dir, 'result.txt'), 'utf8')).toBe('successor owns this\n');
});

it('real tool activity exits recovery and stale chat backfill cannot postpone expiry', async () => {
  const key = conversationKeyForCommand('progress', 'progress-chat');
  const now = Date.now();
  const issued = await claimWorkstream(key, 'progress-chat', 'research', now - WORKSTREAM_LEASE_MS);
  if (!issued.ok) throw new Error(issued.code);
  noteWorkstreamChatActivity('progress-chat', now - 120_000, now);
  expect((await nextWorkstreamActions(now))[0]!.attempts).toBe(1);
  await call(key, issued.lock, patch);
  expect(await nextWorkstreamActions(Date.now())).toEqual([]);
  expect(workstreamStatus()[0]!.attempts).toBe(0);
  expect(await fs.readFile(path.join(dir, 'result.txt'), 'utf8')).toBe('successor owns this\n');
});
