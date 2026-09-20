#!/usr/bin/env node
/**
 * Live ChatGPT acceptance for script-driven workstreams.
 *
 * No ChatGPT/Chrome/bridge dependency is mocked here. The script requires the installed
 * daemon, paired unpacked extension, authenticated ChatGPT browser profile and DevTools port.
 * It creates a disposable real conversation, waits for real connector activity, drives the
 * production archive/replacement path, asks ChatGPT itself whether the old conversation is
 * archived, and proves that a distinct replacement conversation exists.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (!process.argv.includes('--live')) {
  throw new Error('Refusing to touch ChatGPT without --live. This acceptance run creates and archives real conversations.');
}

const pluginName = process.env.COS_LIVE_PLUGIN_NAME?.trim();
if (!pluginName) {
  throw new Error('COS_LIVE_PLUGIN_NAME is required and must name the real ChatGPT plugin connected to this daemon.');
}

const DEVTOOLS = process.env.CHROME_DEVTOOLS_URL ?? 'http://127.0.0.1:9222';
const BRIDGE_PORTS = [8765, 8766, 8767, 8768, 8769];
const POLL_MS = 1_000;
const START_TIMEOUT_MS = 180_000;
const REPLACE_TIMEOUT_MS = 180_000;

const dataRoot = process.env.COS_DATA_DIR ?? (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'chat-on-steroids')
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'chat-on-steroids'));
const stateRoot = path.join(dataRoot, 'state');
const localToken = (await readFile(path.join(stateRoot, 'local-token'), 'utf8')).trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function findBridge() {
  if (process.env.COS_BRIDGE_URL) return process.env.COS_BRIDGE_URL.replace(/\/+$/, '');
  for (const port of BRIDGE_PORTS) {
    try {
      const { response, body } = await json(`http://127.0.0.1:${port}/hello`);
      if (response.ok && body?.app === 'chat-on-steroids') return `http://127.0.0.1:${port}`;
    } catch { /* try the next fixed bridge port */ }
  }
  throw new Error('No live Chat On Steroids bridge answered on 8765-8769');
}

const bridge = await findBridge();
const localHeaders = { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' };

async function bridgeGet(route) {
  const { response, body } = await json(`${bridge}${route}`, { headers: { authorization: `Bearer ${localToken}` } });
  if (!response.ok) throw new Error(`${route} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function bridgePost(route, body) {
  const result = await json(`${bridge}${route}`, {
    method: 'POST', headers: localHeaders, body: JSON.stringify(body)
  });
  if (!result.response.ok) throw new Error(`${route} -> ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not become true within ${timeoutMs}ms`);
}

async function pages() {
  const response = await fetch(`${DEVTOOLS}/json/list`);
  if (!response.ok) throw new Error(`Chrome DevTools /json/list -> ${response.status}`);
  return response.json();
}

async function pageForConversation(conversationId) {
  return (await pages()).find((page) =>
    page.type === 'page' && typeof page.url === 'string' && page.url.includes(`/c/${conversationId}`)
  ) ?? null;
}

async function anyChatGptPage() {
  const page = (await pages()).find((candidate) =>
    candidate.type === 'page' && typeof candidate.url === 'string' && candidate.url.startsWith('https://chatgpt.com/')
  );
  if (!page?.webSocketDebuggerUrl) throw new Error('No live ChatGPT page exposes a DevTools websocket');
  return page;
}

async function cdpEvaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools websocket failed to open')), { once: true });
  });
  try {
    const id = 1;
    const answer = new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        ws.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      ws.addEventListener('message', onMessage);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
      expression, awaitPromise: true, returnByValue: true
    } }));
    const result = await answer;
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'DevTools evaluation failed');
    return result.result?.value;
  } finally {
    ws.close();
  }
}

async function chatGptConversation(conversationId) {
  const page = await anyChatGptPage();
  return cdpEvaluate(page, `(async () => {
    const session = await fetch('/api/auth/session', { credentials: 'include' });
    if (!session.ok) return { error: 'session_http_' + session.status };
    const auth = await session.json();
    if (typeof auth.accessToken !== 'string') return { error: 'session_token_missing' };
    const response = await fetch('/backend-api/conversation/${conversationId}', {
      credentials: 'include', headers: { Authorization: 'Bearer ' + auth.accessToken }
    });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, ok: response.ok, body };
  })()`);
}

async function archiveConversation(conversationId) {
  const page = await anyChatGptPage();
  return cdpEvaluate(page, `(async () => {
    const session = await fetch('/api/auth/session', { credentials: 'include' });
    if (!session.ok) return { error: 'session_http_' + session.status };
    const auth = await session.json();
    if (typeof auth.accessToken !== 'string') return { error: 'session_token_missing' };
    const response = await fetch('/backend-api/conversation/${conversationId}', {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.accessToken },
      body: JSON.stringify({ is_archived: true })
    });
    return { status: response.status, ok: response.ok };
  })()`);
}

async function closeConversationTabs(conversationId) {
  for (const page of await pages()) {
    if (page.type !== 'page' || !page.id || typeof page.url !== 'string' || !page.url.includes(`/c/${conversationId}`)) continue;
    await fetch(`${DEVTOOLS}/json/close/${page.id}`).catch(() => undefined);
  }
}

const id = `live-acceptance-${Date.now()}`;
const context = [
  'LIVE ACCEPTANCE FIXTURE ONLY.',
  'Do not edit files, run shell commands, or touch another workstream.',
  `Use the plugin named ${pluginName}, not any other connector, to READ AGENTS.md in /home/dzack/gitclones/chat-on-steroids.`,
  'After that one connector read, stop. This read is the entire DAG task for this fixture.'
].join(' ');
let oldConversation = null;
let replacementConversation = null;

try {
  const startedAt = Date.now();
  await bridgePost('/workstreams/start', { id, context });

  const first = await waitFor('real workstream conversation + connector activity', async () => {
    const rows = (await bridgeGet('/workstreams')).workstreams ?? [];
    const row = rows.find((candidate) => candidate.id === id);
    if (!row?.conversationId || row.phase !== 'active' || !row.workspace || row.lastActivity <= startedAt) return null;
    if (!await pageForConversation(row.conversationId)) return null;
    return row;
  }, START_TIMEOUT_MS);
  oldConversation = first.conversationId;

  await bridgePost('/workstreams/replace', { id });

  const replacement = await waitFor('archived old chat + distinct replacement conversation', async () => {
    const rows = (await bridgeGet('/workstreams')).workstreams ?? [];
    const row = rows.find((candidate) => candidate.id === id);
    if (!row?.conversationId || row.phase !== 'active' || row.conversationId === oldConversation) return null;
    const old = await chatGptConversation(oldConversation);
    if (!old?.ok || old.body?.is_archived !== true) return null;
    if (await pageForConversation(oldConversation)) return null;
    if (!await pageForConversation(row.conversationId)) return null;
    return row;
  }, REPLACE_TIMEOUT_MS);
  replacementConversation = replacement.conversationId;

  console.log(JSON.stringify({
    ok: true,
    workstream: id,
    oldConversation,
    replacementConversation,
    oldArchived: true,
    replacementLive: true
  }, null, 2));
} finally {
  await bridgePost('/workstreams/pause', { id }).catch(() => undefined);
  if (replacementConversation) {
    await archiveConversation(replacementConversation).catch(() => undefined);
    await closeConversationTabs(replacementConversation).catch(() => undefined);
  }
  if (oldConversation) await closeConversationTabs(oldConversation).catch(() => undefined);
}
