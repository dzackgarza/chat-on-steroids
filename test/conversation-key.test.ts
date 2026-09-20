import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import { defaultConfig, effectiveCapabilities } from '../src/main/config.js';
import { initDurableStore, flushDurable } from '../src/main/durable.js';
import { initSessionStore, listAllSessions, readEvents } from '../src/main/session/store.js';
import { resetRecorderForTests } from '../src/main/session/recorder.js';
import { unifiedExecManager } from '../src/main/codex/manager.js';
import { restoreConversationKeys } from '../src/main/session/conversation-key.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let endpoint: McpEndpoint;
let serial = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params })
  });
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').filter((line) => line.startsWith('data:')).at(-1)!.slice(5));
}
async function call(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  return rpc('tools/call', { name, arguments: args }, headers);
}
function text(reply: { result?: { content?: { text?: string }[] } }): string {
  return reply.result?.content?.map((part) => part.text ?? '').join('\n') ?? '';
}
async function issue(): Promise<string> {
  const reply = await call('read', { paths: ['/a/notes.txt'], conversation_key: 'new' });
  expect(reply.result.isError).toBe(true);
  const key = text(reply).match(/CONVERSATION_KEY_ISSUED: (ck_[A-Za-z0-9_-]{43})/)?.[1];
  expect(key).toBeDefined();
  return key!;
}

beforeAll(async () => {
  dir = await makeTempDir('conversation-key-');
  for (const root of ['a', 'b']) {
    await fs.mkdir(path.join(dir, root));
    await fs.writeFile(path.join(dir, root, 'notes.txt'), `owned by ${root}`);
  }
  initDurableStore(dir);
  initSessionStore(dir);
  resetRecorderForTests();
  const config = defaultConfig();
  endpoint = await startMcpServer(() => ({
    roots: ['a', 'b'].map((name) => ({ name, path: path.join(dir, name) })),
    caps: effectiveCapabilities(config), readOnly: false, sessionTools: true, agentTools: false
  }));
});
afterAll(async () => {
  await endpoint.stop();
  await unifiedExecManager.terminateAllProcesses();
  await flushDurable();
  await removeTempDir(dir);
});

describe('model-carried conversation identity over real MCP HTTP', () => {
  it('requires a key on every published tool and rejects missing or unknown keys before mutation', async () => {
    const listed = await rpc('tools/list', {});
    for (const tool of listed.result.tools) expect(tool.inputSchema.required).toContain('conversation_key');
    const patch = '*** Begin Patch\n*** Add File: /a/should-not-exist\n+unwanted\n*** End Patch';
    for (const key of [undefined, 'ck_unknown', 'new']) {
      const reply = await call('apply_patch', { patch, ...(key ? { conversation_key: key } : {}) }, { 'x-request-id': 'old-header/attempt' });
      expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
      await expect(fs.stat(path.join(dir, 'a/should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps concurrent workspaces and recordings separate without request headers', async () => {
    const [a, b] = await Promise.all([issue(), issue()]);
    expect(a).not.toBe(b);
    for (const [key, root] of [[a, 'a'], [b, 'b']]) {
      const reply = await call('read', { paths: [`/${root}/notes.txt`], conversation_key: key });
      expect(text(reply)).toContain(`owned by ${root}`);
    }
    const replies = await Promise.all([a, b].map((key) => call('read', { paths: ['notes.txt'], conversation_key: key })));
    expect(text(replies[0])).toContain('owned by a');
    expect(text(replies[1])).toContain('owned by b');
    const sessions = await listAllSessions();
    const calls = await Promise.all(sessions.map(async (session) =>
      (await readEvents(session.id)).filter((event) => event.kind === 'tool_call')));
    const recorded = calls.filter((rows) => rows.length > 0);
    expect(recorded).toHaveLength(2);
    for (const rows of recorded) {
      expect(rows).toHaveLength(2);
      for (const event of rows) {
        if (event.kind !== 'tool_call') throw new Error('Expected tool call');
        expect(event.call.attributionMethod).toBe('conversation_key');
        expect(JSON.stringify(event)).not.toContain(a);
        expect(JSON.stringify(event)).not.toContain(b);
      }
    }
  });

  it('refuses another key controlling a live terminal', async () => {
    const a = await issue();
    const b = await issue();
    const started = await call('exec_command', {
      conversation_key: a, cmd: 'cat', workdir: '/a', tty: true, yield_time_ms: 1000
    });
    expect(started.result.isError).not.toBe(true);
    const sessionId = started.result.structuredContent.session_id;
    expect(typeof sessionId).toBe('number');
    const denied = await call('write_stdin', { conversation_key: b, session_id: sessionId, chars: 'wrong-owner\n', yield_time_ms: 1000 });
    expect(denied.result.isError).toBe(true);
    const accepted = await call('write_stdin', { conversation_key: a, session_id: sessionId, chars: 'right-owner\n', yield_time_ms: 1000 });
    expect(accepted.result.isError).not.toBe(true);
    expect(text(accepted)).toContain('right-owner');
    expect(text(accepted)).not.toContain('wrong-owner');
    await call('write_stdin', { conversation_key: a, session_id: sessionId, chars: '\u0003', yield_time_ms: 1000 });
  });

  it('restores issued keys from disk before accepting calls after a registry reload', async () => {
    const key = await issue();
    await flushDurable();
    // Loading a different store removes the in-memory registry; returning must read disk.
    initDurableStore(path.join(dir, 'empty-store'));
    await restoreConversationKeys();
    const absent = await call('read', { paths: ['/a/notes.txt'], conversation_key: key });
    expect(text(absent)).toContain('UNKNOWN_CONVERSATION_KEY');
    initDurableStore(dir);
    await restoreConversationKeys();
    const restored = await call('read', { paths: ['/a/notes.txt'], conversation_key: key });
    expect(restored.result.isError).not.toBe(true);
    expect(text(restored)).toContain('owned by a');
  });
});
