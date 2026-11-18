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
import assert from 'node:assert/strict';
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
  // Chrome can discard the chosen page during cleanup, after it was listed but
  // before this websocket opens or its Runtime.evaluate answers. Without a real
  // deadline the awaited promise stays pending and Node exits with status 13
  // (unsettled top-level await), hiding a successful live acceptance result.
  let expire;
  const timedOut = new Promise((_, reject) => {
    expire = () => reject(new Error('DevTools websocket/evaluation exceeded 30 seconds'));
  });
  const timeout = setTimeout(expire, 30_000);
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('DevTools websocket failed to open')), { once: true });
      }),
      timedOut,
    ]);
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
    const result = await Promise.race([answer, timedOut]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'DevTools evaluation failed');
    return result.result?.value;
  } finally {
    clearTimeout(timeout);
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
    await fetch(`${DEVTOOLS}/json/close/${page.id}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}

const id = `live-acceptance-${Date.now()}`;
// A failed live acceptance may never have reached its own `finally`, for example a
// crashed Node process or an older unbounded CDP wait. This is the same exact test
// ownership predicate as the fixture creation below, not a general-purpose archive
// tool: it touches only paused disposable `live-acceptance-<timestamp>` workstreams.
if (process.argv.includes('--cleanup-fixtures')) {
  const rows = (await bridgeGet('/workstreams')).workstreams ?? [];
  const fixtures = rows.filter((row) =>
    /^live-acceptance-\d+$/.test(row.id) && row.phase === 'paused');
  const failures = [];
  for (const fixture of fixtures) {
    const conversations = new Set([
      fixture.conversationId, ...(fixture.retiredConversations ?? []),
    ].filter(Boolean));
    for (const conversation of conversations) {
      const archived = await archiveConversation(conversation).catch((error) => {
        failures.push(`${conversation}: ${error.message}`);
        return null;
      });
      if (archived && !archived.ok) failures.push(`${conversation}: HTTP ${archived.status}`);
      await closeConversationTabs(conversation).catch((error) =>
        failures.push(`${conversation} tab: ${error.message}`));
    }
  }
  console.log(JSON.stringify({ fixtures: fixtures.length, failedCleanups: failures.length }));
  if (failures.length) throw new Error(`Fixture cleanup incomplete: ${failures.join('; ')}`);
  process.exit(0);
}
const noWorkMode = process.argv.includes('--no-work-loop');
const context = noWorkMode ? [
  'LIVE ACCEPTANCE FIXTURE ONLY.',
  'The entire task is to reply with exactly "NO-WORK-DONE". Do not call any ordinary connector tools or edit any files.',
  'This tests whether the controller recognizes a completed turn with no successful tools; make one short reply and stop.'
].join(' ') : [
  'LIVE ACCEPTANCE FIXTURE ONLY.',
  'Do not edit files, run shell commands, or touch another workstream.',
  `Use the plugin named ${pluginName}, not any other connector. First call \`workstream\` with action="continue" and workstream="${id}", then use the returned workstream_id to READ AGENTS.md in /home/dzack/gitclones/chat-on-steroids.`,
  'After that one connector read, stop. This read is the entire DAG task for this fixture.'
].join(' ');
let oldConversation = null;
let replacementConversation = null;

try {
  const startedAt = Date.now();
  await bridgePost('/workstreams/start', { id, context, autoAdvance: noWorkMode });

  if (noWorkMode) {
    // Real ChatGPT: a completed non-tool turn must be diagnosed instead of
    // creating a second send, even though this workstream has auto-advance on.
    const blocked = await waitFor('completed no-work turn blocks the advance', async () => {
      const rows = (await bridgeGet('/workstreams')).workstreams ?? [];
      const row = rows.find((item) => item.id === id);
      if (row?.phase !== 'blocked' || !row.error?.startsWith('auto_continue_without_successful_tool:') ||
          !row.conversationId || row.actionId || row.commandId) return null;
      return row;
    }, START_TIMEOUT_MS);
    oldConversation = blocked.conversationId;
    assert.ok(await pageForConversation(oldConversation));
    await sleep(5_000);
    const after = (await bridgeGet('/workstreams')).workstreams.find((item) => item.id === id);
    assert.equal(after.phase, 'blocked', 'a completed no-work turn must not schedule another');
    assert.equal(after.lastAdvancedTurnId, blocked.lastAdvancedTurnId);
    assert.equal(after.commandId, null);
    console.log(JSON.stringify({
      ok: true, workstream: id, noWorkTurn: true, preventedAdvance: true,
      conversationId: oldConversation
    }, null, 2));
  } else {
  const first = await waitFor('real workstream conversation + connector activity', async () => {
    const rows = (await bridgeGet('/workstreams')).workstreams ?? [];
    const row = rows.find((candidate) => candidate.id === id);
    if (!row?.conversationId || row.phase !== 'active' || !row.sessionId || row.lastActivity <= startedAt) return null;
    // An absolute-path connector read needs no inferred cwd. Requiring `row.workspace`
    // falsely rejected a genuinely working chat even when the exact read was recorded.
    // The recorder's successful tool event is stronger evidence of execution than a
    // convenience workspace inference or an activity/lease timestamp alone.
    let journal;
    try {
      journal = await readFile(path.join(dataRoot, 'sessions', row.sessionId, 'events.jsonl'), 'utf8');
    } catch {
      return null;
    }
    const recordedRead = journal.split('\n').some((line) => {
      try {
        const event = JSON.parse(line);
        return event.kind === 'tool_call' && event.call?.tool === 'read' &&
          event.call?.outcome === 'ok' &&
          event.call?.args?.text?.includes('/home/dzack/gitclones/chat-on-steroids/AGENTS.md');
      } catch { return false; }
    });
    if (!recordedRead) return null;
    if (!await pageForConversation(row.conversationId)) return null;
    return row;
  }, START_TIMEOUT_MS);
  oldConversation = first.conversationId;

  if (!process.argv.includes('--replace-only')) {
    // The full acceptance mode checks the entire paused lease boundary. For a focused
    // archive/replace diagnosis `--replace-only` keeps all real browser, connector and
    // backend checks, without the unrelated five-minute lease wait.
    await bridgePost('/workstreams/pause', { id });
    const paused = (await bridgeGet('/workstreams')).workstreams.find((row) => row.id === id);
    assert.equal(paused.phase, 'paused');
    assert.equal(typeof paused.expiresAt, 'number');
    console.log('Waiting across the paused workstream lease boundary');
    await sleep(Math.max(0, paused.expiresAt - Date.now() + POLL_MS));
    await bridgePost('/workstreams/resume', { id });
    const resumed = (await bridgeGet('/workstreams')).workstreams.find((row) => row.id === id);
    assert.equal(resumed.phase, 'active', 'an intentional pause must not trigger recovery');
    assert.equal(resumed.conversationId, oldConversation);
    assert.equal(resumed.lastActivity, paused.lastActivity, 'resume must not invent worker activity');
    const retained = await chatGptConversation(oldConversation);
    assert.equal(retained.ok, true);
    assert.equal(retained.body.is_archived, false);
  }

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
  }
} finally {
  // The fixture can fail before assigning oldConversation, despite having created a
  // real chat. The durable row owns that chat and gives its exact id for cleanup.
  const current = (await bridgeGet('/workstreams').catch(() => ({ workstreams: [] })))
    .workstreams.find((row) => row.id === id);
  await bridgePost('/workstreams/pause', { id }).catch(() => undefined);
  for (const conversation of new Set(
    [oldConversation, replacementConversation, current?.conversationId].filter(Boolean)
  )) {
    const archived = await archiveConversation(conversation).catch((error) => {
      console.warn(`Could not archive fixture ${conversation}: ${error.message}`);
      return null;
    });
    if (archived && !archived.ok)
      console.warn(`Fixture ${conversation}: archive returned status ${archived.status}`);
    await closeConversationTabs(conversation).catch((error) =>
      console.warn(`Could not close fixture ${conversation} tabs: ${error.message}`));
  }
}
