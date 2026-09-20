import { afterAll, beforeAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { enableHeadlessSecretStore, initSecretsPath } from '../src/main/secrets.js';
import { getConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { initSessionStore } from '../src/main/session/store.js';
import { flushDurable, initDurableStore } from '../src/main/durable.js';
import { startBridge, stopBridge, pendingCommands, setBrowserOpener, sweepWorkstreams } from '../src/main/bridge.js';
import { claimWorkstream, configureWorkstream, workstreamStatus, WORKSTREAM_LEASE_MS } from '../src/main/workstreams.js';
import { conversationForKey, conversationKeyForCommand, startConversationKey } from '../src/main/session/conversation-key.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../src/main/version.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let base: string;
let localToken: string;
let extensionToken: string;
beforeAll(async () => {
  dir = await makeTempDir('workstream-bridge-');
  initConfigPath(dir);
  initDurableStore(dir);
  initSessionStore(dir);
  enableHeadlessSecretStore();
  initSecretsPath(dir);
  base = `http://127.0.0.1:${await startBridge()}`;
  localToken = (await fs.readFile(path.join(dir, 'state/local-token'), 'utf8')).trim();
  const paired = await post('/pair', '', {});
  extensionToken = (await paired.json()).token;
});
afterAll(async () => {
  setBrowserOpener(null);
  await stopBridge();
  await flushDurable();
  await removeTempDir(dir);
});
async function post(route: string, token: string, body: unknown) {
  return fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
      'x-extension-protocol': String(BRIDGE_PROTOCOL), 'x-extension-version': APP_VERSION },
    body: JSON.stringify(body)
  });
}

it('denies extension management and reports a missing browser driver before queuing work', async () => {
  const rejected = await post('/workstreams/start', extensionToken, { id: 'research', context: 'Work in /project.' });
  expect(rejected.status).toBe(401);
  const started = await post('/workstreams/start', localToken, { id: 'research', context: 'Work in /project.' });
  expect(started.status).toBe(503);
  expect(workstreamStatus()).toEqual([]);
  expect(pendingCommands()).toEqual([]);
  const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';
  const key = conversationKeyForCommand('scripted', conversationId);
  await claimWorkstream(key, conversationId, 'research');
  const paused = await post('/workstreams/pause', localToken, { id: 'research' });
  expect(paused.status).toBe(200);
  expect(workstreamStatus().find((row) => row.id === 'research')?.phase).toBe('paused');
});

it('binds an ad hoc issued key using its exact assistant announcement, without request headers', async () => {
  const key = await startConversationKey();
  const conversationId = 'abcdef12-3456-7890-abcd-ef1234567891';
  const result = await post('/events', extensionToken, { conversationId, events: [{
    kind: 'assistant_message', time: Date.now(), messageId: 'identity-announcement', text: `Chat On Steroids identity: ${key}`, final: true
  }] });
  expect(result.status).toBe(200);
  expect(conversationForKey(key)).toBe(conversationId);
  // A later quote in another conversation cannot retarget an already bound key.
  await post('/events', extensionToken, { conversationId: 'abcdef12-3456-7890-abcd-ef1234567892', events: [{
    kind: 'assistant_message', time: Date.now(), messageId: 'quoted-identity', text: `Chat On Steroids identity: ${key}`, final: true
  }] });
  expect(conversationForKey(key)).toBe(conversationId);
});

it('renews on fresh chat activity with recording disabled, but not on replay or recovery prompt echo', async () => {
  const config = getConfig();
  await saveConfig({ ...config, sessions: { ...config.sessions, record: false } });
  const conversationId = 'abcdef12-3456-7890-abcd-ef1234567893';
  const key = conversationKeyForCommand('chat-activity', conversationId);
  const now = Date.now();
  await claimWorkstream(key, conversationId, 'chat-progress', now - WORKSTREAM_LEASE_MS);
  const event = { kind: 'assistant_message', time: now, messageId: 'current-answer', text: 'Working on the next construction.', final: true };
  await post('/events', extensionToken, { conversationId, events: [event] });
  expect(workstreamStatus().find((row) => row.id === 'chat-progress')!.lastActivity).toBeGreaterThanOrEqual(now);
  const expired = now - WORKSTREAM_LEASE_MS;
  await claimWorkstream(key, conversationId, 'chat-progress', expired);
  await post('/events', extensionToken, { conversationId, events: [event, {
    kind: 'user_message', time: Date.now(), messageId: 'recovery-echo', text: 'Continue workstream chat-progress. Claim it and continue.'
  }] });
  expect(workstreamStatus().find((row) => row.id === 'chat-progress')!.lastActivity).toBe(expired);
  expect((await post('/workstreams/pause', localToken, { id: 'chat-progress' })).status).toBe(200);
  await saveConfig(config);
});

it('drives expiry through three revival attempts, archive acknowledgement, and a bound replacement chat', async () => {
  const opened: string[] = [];
  setBrowserOpener(async (url) => { opened.push(url); });
  await post('/status', extensionToken, {}); // fresh browser-presence evidence for recovery delivery

  const conversationId = 'abcdef12-3456-7890-abcd-ef1234567894';
  const replacementConversation = 'abcdef12-3456-7890-abcd-ef1234567895';
  const key = conversationKeyForCommand('auto-recovery-old', conversationId);
  const start = Date.now();
  const lease = await claimWorkstream(key, conversationId, 'auto-recovery', start);
  if (!lease.ok) throw new Error(lease.code);
  await configureWorkstream('auto-recovery', 'Objective: continue the repository-owned DAG without inventing work.');

  const checkpoints = [
    start + WORKSTREAM_LEASE_MS,
    start + WORKSTREAM_LEASE_MS + 60_000,
    start + WORKSTREAM_LEASE_MS + 3 * 60_000
  ];
  for (let index = 0; index < checkpoints.length; index += 1) {
    await sweepWorkstreams(checkpoints[index]);
    for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const row = workstreamStatus().find((item) => item.id === 'auto-recovery')!;
    expect(row.phase).toBe('recovering');
    expect(row.attempts).toBe(index + 1);
    expect(row.commandId).toBeTruthy();
    const redeemed = await post('/commands/redeem', extensionToken, {
      id: row.commandId,
      client: `recovery-page-${index + 1}`,
      conversationId
    });
    expect(redeemed.status).toBe(200);
    const body = await redeemed.json();
    expect(body.command.text).toContain('Continue workstream auto-recovery.');
    expect(body.command.text).toContain('workstream_lock="claim:auto-recovery"');
    expect(body.command.conversationId).toBe(conversationId);
    const sent = await post('/commands/ack', extensionToken, {
      id: row.commandId,
      client: `recovery-page-${index + 1}`,
      status: 'sent',
      conversationId
    });
    expect(sent.status).toBe(200);
    expect(workstreamStatus().find((item) => item.id === 'auto-recovery')!.lastActivity).toBe(start);
  }

  await sweepWorkstreams(start + WORKSTREAM_LEASE_MS + 7 * 60_000);
  const archiving = workstreamStatus().find((item) => item.id === 'auto-recovery')!;
  expect(archiving.phase).toBe('archiving');
  expect(archiving.attempts).toBe(3);
  expect(archiving.actionId).toMatch(/^archive-/);
  expect(pendingCommands()).toEqual([]);

  const archived = await post('/workstreams/archive', extensionToken, {
    id: 'auto-recovery', actionId: archiving.actionId, error: null
  });
  expect(archived.status).toBe(200);
  for (let turn = 0; turn < 3; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const opening = workstreamStatus().find((item) => item.id === 'auto-recovery')!;
  expect(opening.phase).toBe('opening');
  expect(opening.commandId).toBeTruthy();
  const replacementId = opening.commandId!;

  const replacement = await post('/commands/redeem', extensionToken, {
    id: replacementId, client: 'replacement-page'
  });
  expect(replacement.status).toBe(200);
  const replacementBody = await replacement.json();
  expect(replacementBody.command.conversationId).toBeNull();
  expect(replacementBody.command.text).toContain('Objective: continue the repository-owned DAG without inventing work.');
  expect(replacementBody.command.text).toContain('Read AGENTS.md and the repository TODOs.');
  expect(replacementBody.command.text).toContain('Read the vault plans when needed.');
  expect(replacementBody.command.text).toContain('Identify the next unblocked DAG work and start it immediately.');

  const acknowledged = await post('/commands/ack', extensionToken, {
    id: replacementId,
    client: 'replacement-page',
    status: 'sent',
    conversationId: replacementConversation
  });
  expect(acknowledged.status).toBe(200);
  const active = workstreamStatus().find((item) => item.id === 'auto-recovery')!;
  expect(active.phase).toBe('active');
  expect(active.conversationId).toBe(replacementConversation);
  expect(active.ownerKey).not.toBe(key);
  expect(active.lock).not.toBe(lease.lock);
  expect(active.retiredKeys).toContain(key);
  expect(active.retiredConversations).toContain(conversationId);
  expect(opened).toContainEqual(expect.stringContaining(conversationId));
  expect(opened).toContainEqual(expect.stringContaining(replacementId));
});
