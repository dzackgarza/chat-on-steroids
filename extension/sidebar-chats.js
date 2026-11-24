/**
 * On-demand overview of ChatGPT's first ten unarchived sidebar entries.
 * The access token stays in a signed-in ChatGPT page. We read only listing,
 * activity and stream metadata; conversation history is never requested.
 */
const $ = (id) => document.getElementById(id);
const CHAT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
let rows = [];
let generation = 0;

/** Serialized into the ChatGPT page's MAIN world; no extension globals here. */
async function inspectIndex() {
  const auth = await fetch('/api/auth/session', {
    credentials: 'include', signal: AbortSignal.timeout(15000)
  });
  if (!auth.ok) return { error: `Session HTTP ${auth.status}` };
  const session = await auth.json();
  if (typeof session.accessToken !== 'string') return { error: 'Sign in to ChatGPT first' };
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const list = await fetch('/backend-api/conversations?order=updated&is_archived=false&offset=0&limit=10', {
    headers, credentials: 'include', signal: AbortSignal.timeout(15000)
  });
  if (!list.ok) return { error: `Sidebar listing HTTP ${list.status}` };
  const items = (await list.json()).items;
  if (!Array.isArray(items)) return { error: 'Invalid ChatGPT sidebar response' };
  const selected = items.slice(0, 10);
  if (selected.some((item) => typeof item?.id !== 'string' || !/^[a-f\d-]{8,64}$/i.test(item.id)))
    return { error: 'Sidebar contains an invalid conversation ID' };
  const found = selected.map((item) => ({
      id: item.id, title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
      sidebarTitle: typeof item.title === 'string' ? item.title.slice(0, 500) : null,
      batchTitle: null, titleSource: 'sidebar',
      sidebarAt: item.update_time || null, createdAt: item.create_time || null,
      pinned: Boolean(item.pinned_time), batchAt: null, batchError: null,
      stream: null, streamError: null
    }));
  if (found.length) {
    try {
      const response = await fetch('/backend-api/conversations/batch', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        credentials: 'include', signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ conversation_ids: found.map((row) => row.id), include_full_history: false })
      });
      if (!response.ok) throw new Error(`POST /conversations/batch: HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('Invalid metadata batch');
      const byId = new Map(body.map((entry) => [entry.id, entry]));
      for (const row of found) {
        const entry = byId.get(row.id);
        row.batchAt = entry?.update_time || null;
        if (typeof entry?.title === 'string' && entry.title.trim()) {
          row.batchTitle = entry.title.slice(0, 500);
          // The batch is ChatGPT's newer metadata projection, unlike the
          // sidebar list whose title and clock can lag an active conversation.
          if (!row.sidebarTitle || (Date.parse(row.batchAt) >= Date.parse(row.sidebarAt))) {
            row.title = row.batchTitle;
            row.titleSource = 'batch';
          }
        }
        if (!row.title) row.titleError = `No title returned for ${row.id}`;
        if (!row.batchAt) row.batchError = `POST /conversations/batch: missing timestamp for ${row.id}`;
        else if (!Number.isFinite(Date.parse(row.batchAt)))
          row.batchError = `POST /conversations/batch: invalid update_time for ${row.id}: ${String(row.batchAt)}`;
      }
    } catch (error) {
      for (const row of found) row.batchError = `POST /conversations/batch: ${String(error.message || error)}`;
    }
    await Promise.all(found.map(async (row) => {
      try {
        const response = await fetch(`/backend-api/conversation/${row.id}/stream_status`, {
          headers, credentials: 'include', signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = (await response.json()).status;
        if (status !== 'COMPLETE' && status !== 'IS_STREAMING')
          throw new Error(`Unrecognized stream status: ${String(status)}`);
        row.stream = status;
      } catch (error) {
        row.streamError = `GET /conversation/<id>/stream_status: ${String(error.message || error)}`;
      }
    }));
  }
  return { rows: found };
}

function timestamp(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function activityTime(row) {
  const backend = timestamp(row.batchAt);
  const local = Number.isFinite(row.local?.lastStoredAt) ? row.local.lastStoredAt : null;
  return backend === null ? local : local === null ? backend : Math.max(backend, local);
}

function age(ms) {
  if (ms === null) return 'Unknown';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
}

function state(row) {
  const ms = activityTime(row);
  const recent = ms !== null && Date.now() - ms < 10 * 60000;
  if (row.streamError) return { kind: 'error', label: 'Status error', why: row.streamError };
  if (row.pageAlert) return { kind: 'error', label: 'Page error', why: row.pageAlert };
  if (row.batchError) return { kind: 'error', label: 'Metadata error', why: row.batchError };
  if (row.pageError) return { kind: 'error', label: 'Page inspection error', why: row.pageError };
  if (row.localError) return { kind: 'error', label: 'Recorder error', why: row.localError };
  // ChatGPT's page can retain an in_progress DOM marker long after its stream
  // has ended. The backend's COMPLETE is the terminal stream state; a recorder
  // with an unclosed turn is not a second live stream.
  if (row.stream === 'COMPLETE') {
    if (row.local?.lastTurnOutcome === 'failed' || row.local?.lastTurnOutcome === 'stalled')
      return { kind: 'error', label: row.local.lastTurnOutcome === 'failed' ? 'Failed' : 'Stalled',
        why: `Last recorded turn: ${row.local.lastTurnOutcome}; backend stream COMPLETE` };
    if (row.local?.lastTurnOutcome === 'observer_lost' ||
        row.local?.lastTurnOutcome === 'interrupted')
      return { kind: 'warning',
        label: row.local.lastTurnOutcome === 'observer_lost' ? 'Observer lost' : 'Interrupted',
        why: `Last recorded turn: ${row.local.lastTurnOutcome}; backend stream COMPLETE` };
    if (row.pageState === 'in_progress')
      return { kind: 'warning', label: 'Page state stale',
        why: 'Backend stream COMPLETE; open tab still marks its turn in_progress' };
    return { kind: 'idle', label: 'Idle', why: 'Backend reports COMPLETE' };
  }
  if (row.stream === 'IS_STREAMING' && recent) return {
    kind: 'busy', label: 'Generating', why: 'Backend IS_STREAMING and recent actual activity'
  };
  if (row.stream === 'IS_STREAMING') {
    if (row.local?.lastTurnOutcome === 'stalled')
      return { kind: 'error', label: 'Stalled',
        why: 'Last recorded turn stalled, with no recent activity; backend streaming flag is unverified' };
    return { kind: 'warning', label: 'Unverified stream',
      why: 'Backend IS_STREAMING flag without recent activity; a page in_progress marker is not proof of work' };
  }
  return { kind: 'warning', label: 'Unknown', why: row.stream || 'Stream status unavailable' };
}

function cell(parent, value, cls = '') {
  const element = document.createElement('td');
  if (cls) element.className = cls;
  if (value !== null && value !== undefined) element.textContent = String(value);
  parent.append(element);
  return element;
}

function secondary(element, value) {
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = value;
  element.append(sub);
}

function render() {
  const body = $('conversations');
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    const title = cell(tr, null, 'chat');
    const link = document.createElement('a');
    link.href = `https://chatgpt.com/c/${row.id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = row.title || 'Title unavailable';
    title.append(link);
    secondary(title, `${row.pinned ? 'Pinned · ' : ''}${row.id.slice(0, 8)}…${row.id.slice(-4)}${row.openTab ? ' · Open tab' : ''}`);
    secondary(title, `Title source: ${row.titleSource}`);
    if (row.sidebarTitle && row.sidebarTitle !== row.title)
      secondary(title, `Sidebar title: ${row.sidebarTitle}`);
    if (row.batchTitle && row.batchTitle !== row.title && row.batchTitle !== row.sidebarTitle)
      secondary(title, `Batch title: ${row.batchTitle}`);
    if (row.titleError) secondary(title, row.titleError);
    title.title = `Created: ${row.createdAt || 'unknown'}\nConversation ID: ${row.id}`;
    const status = state(row);
    const statusCell = cell(tr, null);
    const chip = document.createElement('span');
    chip.className = `status ${status.kind}`;
    chip.textContent = status.label;
    statusCell.append(chip);
    statusCell.title = status.why;
    if (row.stream) secondary(statusCell, `ChatGPT backend: ${row.stream}`);
    if (row.pageState) secondary(statusCell, `Open tab: ${row.pageState}`);
    if (row.local?.generating !== null && row.local?.generating !== undefined)
      secondary(statusCell, `Recorder turn open: ${row.local.generating ? 'yes' : 'no'}`);
    if (row.streamError) secondary(statusCell, row.streamError);
    if (row.batchError) secondary(statusCell, row.batchError);
    if (row.pageError) secondary(statusCell, row.pageError);
    if (row.pageAlert) secondary(statusCell, row.pageAlert.slice(0, 100));
    if (row.local?.inFlightCalls) secondary(statusCell, `${row.local.inFlightCalls} tool call(s) in flight`);
    if (row.local?.lastTurnOutcome && row.local.lastTurnOutcome !== 'completed')
      secondary(statusCell, `Last recorded turn: ${row.local.lastTurnOutcome}`);
    const last = activityTime(row);
    const idle = cell(tr, age(last), 'nowrap');
    if (status.kind === 'warning' && last !== null) secondary(idle, `No update for ${age(last)}`);
    const lastCell = cell(tr,
      row.batchError ? 'Batch metadata error' : last === null ? 'No activity reported' : new Date(last).toLocaleString(),
      'nowrap');
    const fromRecorder = last !== null && last === row.local?.lastStoredAt &&
      (timestamp(row.batchAt) === null || last > timestamp(row.batchAt));
    if (row.batchError) secondary(lastCell, row.batchError);
    if (last !== null) secondary(lastCell, `${age(last)} ago · ${fromRecorder ? 'recorder' : 'ChatGPT'}`);
    else if (timestamp(row.sidebarAt) !== null)
      secondary(lastCell, `Sidebar: ${new Date(row.sidebarAt).toLocaleString()} (not live)`);
    lastCell.title = row.batchError || 'Conversation batch update time';
    if (row.localError) {
      const length = cell(tr, 'Recorder error');
      secondary(length, row.localError);
    } else if (row.local?.recorded && Number.isFinite(row.local.contextTokens)) {
      const tokens = row.local.contextTokens;
      const length = cell(tr, `~${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens} tokens`, 'nowrap');
      secondary(length, 'Estimated current context · local recorder');
    } else cell(tr, row.local ? 'Not recorded' : 'Checking recorder…', 'nowrap');
    const messages = cell(tr, row.local?.recorded ? row.local.userMessages : '—', 'nowrap');
    if (row.localError) secondary(messages, row.localError);
    else if (row.local?.recorded) {
      secondary(messages, `${row.local.userMessages} recorded user messages`);
      secondary(messages, `${row.local.toolCalls} recorded tool calls`);
    }
    cell(tr, row.localError ? `Recorder error: ${row.localError}` :
      row.local?.lastTurnOutcome || (row.local?.recorded ? 'No turn recorded' : 'Not recorded'));
    body.append(tr);
  }
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

function route(url) {
  try { return new URL(url).pathname.match(/^\/c\/([a-f\d-]{8,64})\/?$/i)?.[1] || null; }
  catch { return null; }
}

async function inPage(tabId, func, args = [], ms = 35000) {
  let timer;
  try {
    const answer = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ChatGPT tab did not respond')), ms); })
    ]);
    if (!answer?.[0]) throw new Error('ChatGPT tab returned no result');
    return answer[0].result;
  } finally { clearTimeout(timer); }
}

async function inspectOpenTabs(tabs, current, stamp) {
  const targetIds = new Set(current.map((row) => row.id));
  const inspections = await Promise.all(tabs.filter((tab) => targetIds.has(route(tab.url))).map(async (tab) => {
    const expectedId = route(tab.url);
    try {
      const observation = await inPage(tab.id, (id) => {
        const match = decodeURIComponent(location.pathname).match(/^\/c\/([a-f\d-]{8,64})\/?$/i);
        if (match?.[1] !== id) return { error: `Tab navigated away from ${id}` };
        const alert = document.querySelector('aside[role="alert"]');
        const states = document.querySelectorAll('[data-talvt-turn-state]');
        return { id, title: document.title, alert: alert?.innerText?.trim().slice(0, 250) || null,
          state: states.length ? states[states.length - 1].getAttribute('data-talvt-turn-state') : null };
      }, [expectedId], 3000);
      return { expectedId, tabId: tab.id, observation };
    } catch (error) {
      return { expectedId, tabId: tab.id, error: String(error.message || error) };
    }
  }));
  if (stamp !== generation) return;
  for (const row of current) {
    const matches = inspections.filter((entry) => entry.expectedId === row.id);
    if (!matches.length) continue;
    row.openTab = true;
    const errors = matches.filter((entry) =>
      entry.error || entry.observation?.error || entry.observation?.id !== row.id
    );
    if (errors.length) {
      row.pageError = errors.map((entry) =>
        `Tab ${entry.tabId}: ${entry.error || entry.observation?.error || 'conversation identity mismatch'}`
      ).join('; ');
    }
    const good = matches.filter((entry) => !errors.includes(entry));
    const signatures = new Set(good.map((entry) =>
      JSON.stringify([entry.observation.title, entry.observation.state, entry.observation.alert])
    ));
    if (signatures.size > 1) {
      row.pageError = `${row.pageError ? row.pageError + '; ' : ''}Open tabs disagree: ${good.map(
        (entry) => `tab ${entry.tabId}: ${JSON.stringify({
          title: entry.observation.title, state: entry.observation.state, alert: entry.observation.alert
        })}`
      ).join('; ')}`;
      continue; // Never choose an arbitrary last-response winner.
    }
    const observation = good[0]?.observation;
    if (!observation) continue;
    // On a live page the document title can already contain the final
    // conversation name while both backend list and batch still say New chat.
    const pageTitle = typeof observation.title === 'string' ? observation.title.trim() : '';
    if (pageTitle && pageTitle !== 'ChatGPT' && pageTitle !== 'New chat') {
      row.title = pageTitle.slice(0, 500);
      row.titleSource = 'open ChatGPT tab';
    }
    if (observation.alert) row.pageAlert = observation.alert;
    if (observation.state) row.pageState = observation.state;
  }
  render();
}

async function refresh() {
  const stamp = ++generation;
  $('refresh').disabled = true;
  rows = [];
  render();
  notice('Reading the first 10 sidebar conversations…');
  try {
    const tabs = await chrome.tabs.query({ url: CHAT_URLS });
    if (!tabs.length) throw new Error('Open a signed-in ChatGPT tab, then refresh.');
    tabs.sort((a, b) => Number(b.active) - Number(a.active));
    // A failed tab is a failed read. Do not silently switch to a different tab,
    // which may even belong to a different ChatGPT account.
    const tab = tabs[0];
    let snapshot;
    try {
      snapshot = await inPage(tab.id, inspectIndex);
    } catch (error) {
      throw new Error(`ChatGPT tab ${tab.id}: ${String(error.message || error)}`);
    }
    if (!Array.isArray(snapshot?.rows))
      throw new Error(`ChatGPT tab ${tab.id}: ${snapshot?.error || 'invalid response'}`);
    if (stamp !== generation) return;
    rows = snapshot.rows;
    const checked = new Date().toLocaleTimeString();
    render();
    if (!rows.length) { notice('No unarchived sidebar conversations returned.'); return; }
    notice(`${rows.length} conversations · checked ${checked} · checking recorder…`);
    const observed = inspectOpenTabs(tabs, rows, stamp);
    const local = chrome.runtime.sendMessage({
      type: 'sidebar_metrics', ids: rows.map((row) => row.id)
    }).then((result) => {
      if (stamp !== generation) return;
      if (!result?.ok || !Array.isArray(result.rows))
        throw new Error(`POST /sidebar/metrics: ${result?.error || 'invalid response'}`);
      const metrics = new Map(result.rows.map((item) => [item.id, item]));
      for (const row of rows) {
        if (!metrics.has(row.id)) {
          row.localError = `POST /sidebar/metrics: no result for ${row.id}`;
        } else {
          row.local = metrics.get(row.id);
        }
      }
      render();
    }).catch((error) => {
      if (stamp !== generation) return;
      for (const row of rows) {
        if (!row.local) row.localError = String(error.message || error);
      }
      render();
    });
    await Promise.all([observed, local]);
    if (stamp === generation) {
      render();
      const errors = rows.flatMap((row) =>
        [row.batchError, row.streamError, row.pageError, row.localError].filter(Boolean));
      notice(
        `${rows.length} conversations · checked ${checked} · ${errors.length ? `${errors.length} request/observation error(s); see affected rows` : 'all metadata requests succeeded'}`,
        errors.length > 0
      );
    }
  } catch (error) {
    if (stamp === generation) notice(error.message || String(error), true);
  } finally {
    if (stamp === generation) $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', () => void refresh());
setInterval(() => { if (rows.length) render(); }, 30000);
void refresh();
