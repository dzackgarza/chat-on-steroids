/**
 * The only code this extension runs in ChatGPT's own JavaScript context.
 *
 * It exists because ChatGPT's React view model knows things the rendered page does not
 * show: which connector tool each call ran, the public commentary the model printed
 * between calls (including a workstream claim line), and whether the turn has finished.
 * The DOM draws a collapsed "worked for N minutes" group; the view model behind it still
 * holds every item of the turn in order.
 *
 * The view model read here is ChatGPT's `entries` list. Each exchange is one
 * `div[data-turn-key=<user message id>]`, and a few Fibers above it a component carries
 * `entries`, one per exchange:
 *
 *   { turnKey, conversationId, turn: { status, items: [...] } }
 *
 * `turn.items` is the exchange in order: a `user-message`, then any number of
 * `chatgpt-reasoning-group` items (whose own `items` are `reasoning` entries —
 * `presentation: 'preamble'` is public commentary, `'thought'` is an activity headline —
 * and `mcp-tool-call` entries), then an `assistant-message` when the model answered.
 *
 * Everything here is written on the assumption that it is the least trusted code in the
 * extension:
 *
 *  · **It runs where the page can reach it.** ChatGPT could replace `postMessage`,
 *    `Array.prototype.map` — anything this file touches. Native references are captured
 *    at load, and page-owned arrays are walked with index loops, never array methods.
 *  · **It emits an allowlist, never a filtered copy.** Only the named fields below cross
 *    into the extension. A tool call contributes its id, its tool name and whether the
 *    turn has moved past it. `invocation.arguments` is never read: tool arguments are the
 *    user's own text and this app's own secrets.
 *  · **It fails closed.** An unrecognised shape yields no descriptor for that turn.
 *
 * The receiving side treats everything here as page-controlled evidence regardless: the
 * page can post these same messages itself. See the trust note in content.js.
 */

(() => {
  'use strict';

  /** Bumped when the descriptor shape changes, so a stale pair cannot half-understand. */
  const VERSION = 11;
  // The MAIN world survives an extension reload because the ChatGPT document survives it.
  // Recovery may therefore execute this file again in a page that still has an older helper
  // listener. Keep at most one listener for this protocol version; content.js rejects older
  // versions, so an older listener can coexist harmlessly until the document navigates.
  const ACTIVE_HELPER = '__clfFiberHelper';
  const ASK = 'clf-fiber-ask';
  const REPLY = 'clf-fiber-reply';
  /** A runaway guard on the climb from an exchange to its `entries` holder. */
  const MAX_CLIMB = 80;
  const MAX_TEXT = 200;
  /** Exchanges whose view model is read, newest first. */
  const MAX_TURNS = 6;
  /** Connector calls reported for one turn. Far above any real turn's call count. */
  const MAX_CALLS = 200;
  /** One rendered exchange: the user message and everything the model did in reply. */
  const TURN_BLOCK = '[data-turn-key]';
  /** The role units chatgpt-dom.js reports as page turns, inside one exchange. */
  const UNIT = '[data-chatgpt-search-unit-key], [data-content-search-unit-key]';
  const STAMP = 'data-clf-fiber-turn';
  // A 15k–20k-token compaction answer is routinely 60k–90k characters. Safety guard only:
  // one event must stay below the 512 KiB bridge body cap.
  const MAX_RENDERED_TEXT = 256_000;
  /** Aggregate authored text copied through MAIN -> isolated world in one scan. */
  const MAX_RESPONSE_TEXT = MAX_TURNS * 512 * 1024;
  const MAX_TURN_TEXT = 512 * 1024;
  /**
   * The connectors this app is reached through. Nothing else is ours to vouch for.
   *
   * ChatGPT takes the connector name from the `resource_name` this app serves (`server.ts`),
   * and the user may add a machine label when registering it, which ChatGPT shows as
   * `Chat On Steroids Core (Laptop)`. So a name is ours when it is one of these exactly, or
   * one of these followed by one parenthesised label. Never a bare prefix:
   * `Chat On Steroids Backup` would be somebody else's connector.
   */
  const OUR_APPS = ['Chat On Steroids Core', 'Chat On Steroids Desktop'];
  const LABEL = /^ \([^()]{1,64}\)$/;
  /** A tool name we are willing to report. */
  const NAME = /^[a-z0-9_.-]{1,64}$/i;

  // Captured before the page can swap them.
  const post = window.postMessage.bind(window);

  /** A short, plain string or null. Never a number, object, or anything with a toString. */
  function str(value) {
    return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : null;
  }

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  function budgetedText(value, budget) {
    if (typeof value !== 'string' || !value || budget.remaining <= 0) return '';
    const taken = value.slice(0, Math.min(MAX_RENDERED_TEXT, budget.remaining));
    budget.remaining -= taken.length;
    return taken;
  }

  /** Whether a connector name is one of this app's own connectors. */
  function ourApp(name) {
    if (typeof name !== 'string') return false;
    for (let at = 0; at < OUR_APPS.length; at++) {
      const app = OUR_APPS[at];
      if (name === app) return true;
      if (name.indexOf(app) === 0 && LABEL.test(name.slice(app.length))) return true;
    }
    return false;
  }

  /** "link_…/workstream" -> "workstream", or null if that is not a name. */
  function toolName(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const tail = value.slice(value.lastIndexOf('/') + 1);
    return NAME.test(tail) ? tail : null;
  }

  /**
   * The React Fiber node for a DOM element.
   *
   * React hangs it off a property whose name carries a per-build random suffix, so the
   * key has to be discovered rather than named.
   */
  function fiberOf(node) {
    for (const key in node) {
      if (key.charCodeAt(0) === 95 && key.indexOf('__reactFiber$') === 0) return node[key];
    }
    return null;
  }

  /**
   * The view-model entry that renders this exchange, and the conversation it belongs to.
   *
   * The nearest `entries` holder is the list; its `turnKey` must equal the block's own
   * `data-turn-key`, so the join is exact rather than positional. Every conversation id on
   * the climb must agree with the entry's own. During navigation React can leave chat A's
   * props mounted beside chat B's for a tick; that contradiction is reported as a conflict so
   * content.js fails closed instead of filing A's messages under B.
   */
  function entryOf(block, key) {
    let entry = null;
    let conversationId = null;
    let conflict = false;
    const note = (value) => {
      const id = str(value);
      if (!id) return;
      if (conversationId && conversationId !== id) conflict = true;
      conversationId = conversationId || id;
    };
    let at = fiberOf(block);
    for (let up = 0; at && up < MAX_CLIMB; up++, at = at.return) {
      const props = at.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      note(props.conversationId);
      if (entry || !Array.isArray(props.entries)) continue;
      const entries = props.entries;
      for (let index = 0; index < entries.length; index++) {
        const candidate = entries[index];
        if (candidate && typeof candidate === 'object' && candidate.turnKey === key) entry = candidate;
      }
      if (!entry) return null;
      note(entry.conversationId);
    }
    if (!entry || !entry.turn || typeof entry.turn !== 'object' || !Array.isArray(entry.turn.items)) return null;
    return { entry, conversationId: conflict ? null : conversationId, conflict };
  }

  /** The exchange's items in order, with reasoning groups expanded in place. */
  function flatItems(turn) {
    const out = [];
    const items = turn.items;
    for (let at = 0; at < items.length; at++) {
      const item = items[at];
      if (!item || typeof item !== 'object') continue;
      if (item.type !== 'chatgpt-reasoning-group') {
        out.push(item);
        continue;
      }
      const inner = item.items;
      if (!Array.isArray(inner)) continue;
      for (let index = 0; index < inner.length; index++) {
        if (inner[index] && typeof inner[index] === 'object') out.push(inner[index]);
      }
    }
    return out;
  }

  /**
   * Whether the tool call at `at` has returned.
   *
   * The view model leaves `completed: false` on every call it rehydrated from the server,
   * so that field is not evidence. The model cannot write past a call until its result
   * arrives, so any later non-call item proves every call before it has returned. A run of
   * calls at the tail of an unfinished turn is still waiting.
   */
  function answeredAt(items, at, finished) {
    if (finished || items[at].completed === true) return true;
    for (let later = at + 1; later < items.length; later++) {
      if (items[later].type !== 'mcp-tool-call') return true;
    }
    return false;
  }

  /**
   * One exchange's descriptor, or null when the shape is not the one we know.
   *
   * Identity:
   *  · user and assistant messages carry ChatGPT's own message ids;
   *  · a tool call's `callId` is ChatGPT's id for the request message;
   *  · commentary and thought items carry no id. Each is named by the nearest preceding
   *    item that has one plus its ordinal since that anchor. The exchange only ever grows
   *    at its tail, and the anchor is a server id, so the name survives streaming and
   *    reload alike.
   */
  function describeTurn(block, key, index, budget) {
    const found = entryOf(block, key);
    if (!found) return null;
    const turn = found.entry.turn;
    const items = flatItems(turn);
    const finished = turn.status === 'complete';
    const calls = [];
    const messages = [];
    const activities = [];
    const callIds = new Set();
    const duplicated = new Set();
    let anchor = null;
    let since = 0;
    let finalAnswer = null;
    for (let at = 0; at < items.length; at++) {
      const item = items[at];
      const type = item.type;
      if (type === 'user-message') {
        const id = str(item.messageId);
        if (!id) return null;
        anchor = id;
        since = 0;
        const rawText = budgetedText(item.message, budget);
        if (rawText) {
          messages.push({
            messageId: id,
            rawMessageId: id,
            role: 'user',
            stable: true,
            order: at,
            createTime: num(item.sentAtMs),
            rawText,
            renderedHtml: ''
          });
        }
        continue;
      }
      if (type === 'mcp-tool-call') {
        const id = str(item.callId);
        if (!id) return null;
        anchor = id;
        since = 0;
        const invocation = item.invocation && typeof item.invocation === 'object' ? item.invocation : null;
        if (!invocation || !ourApp(invocation.server)) continue;
        const tool = toolName(invocation.tool);
        if (!tool || calls.length >= MAX_CALLS) continue;
        if (callIds.has(id)) duplicated.add(id);
        callIds.add(id);
        calls.push({
          messageId: id,
          tool,
          order: 0,
          answered: answeredAt(items, at, finished),
          requestId: null,
          createTime: null
        });
        continue;
      }
      if (type === 'assistant-message') {
        const id = str(item.messageId);
        if (!id) return null;
        anchor = id;
        since = 0;
        const rawText = budgetedText(item.content, budget);
        if (rawText) {
          messages.push({
            messageId: id,
            rawMessageId: str(item.latestMessageId) || id,
            role: 'assistant',
            stable: true,
            order: at,
            createTime: null,
            rawText,
            renderedHtml: ''
          });
        }
        finalAnswer = item.completed === true && item.phase === 'final_answer' ? id : null;
        continue;
      }
      if (type !== 'reasoning' || !anchor) continue;
      since += 1;
      const logicalId = `${anchor}:${since}`;
      if (item.presentation === 'preamble') {
        const rawText = budgetedText(item.content, budget);
        if (!rawText) continue;
        messages.push({
          messageId: logicalId,
          rawMessageId: logicalId,
          role: 'assistant',
          stable: true,
          order: at,
          createTime: null,
          rawText,
          renderedHtml: ''
        });
      } else if (item.presentation === 'thought') {
        const label = str(item.content);
        if (label) activities.push({ messageId: logicalId, label, order: at });
      }
    }
    // An id reported twice is an ambiguity, not a second call; drop both.
    const kept = [];
    for (let at = 0; at < calls.length; at++) {
      if (duplicated.has(calls[at].messageId)) continue;
      calls[at].order = kept.length;
      kept.push(calls[at]);
    }
    if (kept.length === 0 && messages.length === 0 && activities.length === 0) return null;
    return {
      index,
      turnId: key,
      conversationId: found.conversationId,
      conversationConflict: found.conflict,
      // Only the final answer of a finished exchange ends it. A final answer that is the
      // last item of a still-running exchange is not yet terminal.
      endMessageId: finished && finalAnswer && items[items.length - 1].type === 'assistant-message' ? finalAnswer : null,
      calls: kept,
      requests: [],
      messages,
      activities
    };
  }

  /**
   * The per-exchange evidence for the newest exchanges on screen.
   *
   * Each descriptor is stamped `scanToken:index` onto its exchange block and on every role
   * unit inside it, which is how content.js joins a page turn to its descriptor.
   */
  function turnsOf(scanToken) {
    const out = [];
    const blocks = document.querySelectorAll(TURN_BLOCK);
    // A descriptor index is valid for one scan only. These attributes are observed by the
    // isolated-world MutationObserver, so clearing every stamp up front would make each scan
    // trigger the next. Build the desired stamps first, then change only what differs.
    const desired = new Map();
    const budget = { remaining: MAX_RESPONSE_TEXT };
    const first = Math.max(0, blocks.length - MAX_TURNS);
    for (let at = first; at < blocks.length; at++) {
      const block = blocks[at];
      const key = str(block.getAttribute('data-turn-key'));
      if (!key) continue;
      let descriptor = null;
      try {
        const turnBudget = { remaining: Math.min(MAX_TURN_TEXT, budget.remaining) };
        const before = turnBudget.remaining;
        descriptor = describeTurn(block, key, out.length, turnBudget);
        budget.remaining -= before - turnBudget.remaining;
      } catch {
        // One unreadable exchange must not cost the others their evidence.
        descriptor = null;
      }
      if (!descriptor) continue;
      out.push(descriptor);
      const stamp = `${scanToken}:${descriptor.index}`;
      desired.set(block, stamp);
      const units = block.querySelectorAll(UNIT);
      for (let unit = 0; unit < units.length; unit++) desired.set(units[unit], stamp);
    }
    const stale = document.querySelectorAll(`[${STAMP}]`);
    for (let at = 0; at < stale.length; at++) {
      if (!desired.has(stale[at])) stale[at].removeAttribute(STAMP);
    }
    for (const [node, stamp] of desired) {
      if (node.getAttribute(STAMP) !== stamp) node.setAttribute(STAMP, stamp);
    }
    return out;
  }

  /** Answers a request from the isolated world. The nonce names the scan in both worlds. */
  function scan(nonce) {
    let turns = [];
    let scanOk = true;
    try {
      turns = turnsOf(nonce);
    } catch {
      turns = [];
      scanOk = false;
    }
    post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk, rows: [], turns }, location.origin);
  }

  const listener = (event) => {
    // Only this window, only our own request shape. Anything else is not ours to answer.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== ASK) return;
    const nonce = typeof data.nonce === 'string' ? data.nonce.slice(0, 64) : '';
    if (!nonce) return;
    try {
      scan(nonce);
    } catch {
      try {
        post({ source: REPLY, nonce, scanToken: nonce, v: VERSION, scanOk: false, rows: [], turns: [] }, location.origin);
      } catch {
        // Nothing further to try. The other side times out.
      }
    }
  };
  // Re-execution is a repair, not a marker check. A stale primitive marker could survive
  // while its listener did not, so keep the actual listener and always replace it.
  const prior = window[ACTIVE_HELPER];
  if (prior && prior.version === VERSION && typeof prior.listener === 'function') {
    try {
      window.removeEventListener('message', prior.listener);
    } catch {
      // Installing the replacement below is still the only useful recovery action.
    }
  }
  window.addEventListener('message', listener);
  window[ACTIVE_HELPER] = { version: VERSION, listener };
})();
