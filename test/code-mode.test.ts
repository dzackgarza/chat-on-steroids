/**
 * Code mode (`exec`) over the real Core MCP endpoint: real HTTP, real files, a real QuickJS
 * worker. Proves the three things this app owns on top of the interpreter — composing the
 * connector's own tools, re-checking live permissions for each child, and filing each child
 * as its own nested tool call under the conversation the `exec` call proved.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { startMcpServer, type McpEndpoint } from '../src/main/mcp/server.js';
import type { ToolContext } from '../src/main/mcp/tools.js';
import { createSession, initSessionStore, readEvents } from '../src/main/session/store.js';
import { observeRequestCorrelation } from '../src/main/session/correlation.js';
import { DEFAULT_CAPABILITIES, type Root } from '../src/shared/types.js';
import { makeTempDir, removeTempDir, writeTree } from './helpers.js';

let base: string;
let endpoint: McpEndpoint;
let ctx: ToolContext;

type CallReply = { result: { content: Array<{ type: string; text?: string }>; isError?: boolean } };

async function exec(code: string, requestId?: string): Promise<CallReply> {
  const response = await fetch(endpoint.urls.core, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(requestId ? { 'x-request-id': `${requestId}/att1` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'exec', arguments: { code } } })
  });
  const raw = await response.text();
  return JSON.parse(raw.startsWith('{') ? raw : [...raw.matchAll(/^data: (.+)$/gm)].at(-1)![1]!) as CallReply;
}

const texts = (reply: CallReply): string[] => reply.result.content.flatMap((item) => (item.type === 'text' ? [item.text ?? ''] : []));

beforeAll(async () => {
  base = await makeTempDir('cos-code-mode-');
  initSessionStore(path.join(base, 'sessions'));
  await writeTree(path.join(base, 'workspace'), {
    'alpha.txt': 'alpha 31\n',
    'beta.txt': 'beta 47\n'
  });
});

beforeEach(async () => {
  if (endpoint) await endpoint.stop();
  ctx = {
    roots: [{ name: 'workspace', path: path.join(base, 'workspace') }] as Root[],
    caps: { ...DEFAULT_CAPABILITIES, read: true, metadata: true, browse: true },
    readOnly: true,
    sessionTools: true,
    agentTools: false
  };
  endpoint = await startMcpServer(() => ctx);
});

afterAll(async () => {
  if (endpoint) await endpoint.stop();
  await removeTempDir(base);
});

it('composes parallel reads and returns only what the script emits', async () => {
  const reply = await exec(`
    const [a, b] = await Promise.all([
      tools.read({ paths: ['/workspace/alpha.txt'] }),
      tools.read({ paths: ['/workspace/beta.txt'] })
    ]);
    const number = (result) => Number(/\\t\\w+ (\\d+)/.exec(result.content[0].text)[1]);
    text(String(number(a) + number(b)));
  `);
  expect(reply.result.isError, texts(reply).join('\n')).not.toBe(true);
  // Only the explicit emission crosses back: the file text itself stays in the runtime.
  expect(texts(reply)).toEqual(['78']);
});

it('gives a child call no permission its direct call would not have', async () => {
  const script = `
    const result = await tools.read({ paths: ['/workspace/alpha.txt'] });
    text(String(JSON.stringify(result).includes('alpha 31')));
  `;
  expect(texts(await exec(script))).toEqual(['true']);
  // With the permission off, read answers with metadata only; the contents must not reach the script.
  ctx = { ...ctx, caps: { ...ctx.caps, read: false } };
  expect(texts(await exec(script))).toEqual(['false']);
});

it('files each child as a nested call under the conversation the exec call proved', async () => {
  const conversationId = `conv-${randomUUID()}`;
  const requestId = `wfr_${randomUUID().replaceAll('-', '')}`;
  const session = await createSession({ conversationId, title: 'Code mode recording' });
  expect(
    observeRequestCorrelation({ requestId, conversationId, sessionId: session.id, messageId: randomUUID(), tool: 'exec', observedAt: Date.now() })
  ).toBe('stored');

  const reply = await exec(`await tools.read({ paths: ['/workspace/beta.txt'] }); text('done');`, requestId);
  expect(texts(reply)).toEqual(['done']);

  const calls = (await readEvents(session.id)).flatMap((event) => (event.kind === 'tool_call' ? [event.call] : []));
  const child = calls.find((call) => call.tool === 'read');
  const outer = calls.find((call) => call.tool === 'exec');
  expect(child?.nested).toBe(true);
  expect(child?.conversationId).toBe(conversationId);
  expect(child?.requestId).toBe(requestId);
  expect(outer?.nested).toBeUndefined();
});
