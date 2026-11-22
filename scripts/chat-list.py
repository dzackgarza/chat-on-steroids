#!/usr/bin/env python3
"""List the ChatGPT chats that are active now, with model and length.

A chat is active when a turn is generating, or when its newest message is recent. Both come
from ChatGPT's per-chat calls, not from the sidebar list:

  * generating — `/backend-api/conversation/<id>/stream_status` says IS_STREAMING, the chat's
    open tab marks its newest turn `in_progress` (`data-talvt-turn-state`, the attribute
    extension/chatgpt-dom.js reads), or this app's recorder says a turn is running;
  * last activity — `update_time` from `POST /backend-api/conversations/batch`, which follows a
    running turn.

The sidebar list (`/backend-api/conversations`) only enumerates chat ids and titles. Its
`update_time` stays frozen while a long turn runs (measured: 20:04 in the list against 20:38 in
the conversation), so it never decides whether a chat is active.

Pass one checks the `--candidates` newest chats by list time, every chat with an open tab and
every chat the recorder says is busy, with those two cheap calls (neither is under ChatGPT's
history-detail rate limit). Pass two reads the whole conversation (`metadata.model_slug`, size)
only for the chats that passed the activity window. The endpoints are specified in
docs/chatgpt-backend-api.md.

`~tok` is characters of user, assistant and tool text on the current branch divided by
four. It excludes hidden reasoning (`thoughts`, `reasoning_recap`), which is not carried
forward, and system prompts and tool schemas, which are invisible from here. It is a sizing
estimate, not ChatGPT's context counter.
"""

import argparse
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import time

DEVTOOLS = "http://127.0.0.1:9222"


def cdp_targets(endpoint):
    raw = subprocess.run(
        ["curl", "-s", "-m", "5", f"{endpoint}/json"],
        capture_output=True,
        text=True,
    ).stdout
    try:
        return json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []


def evaluate(websocket, expression, timeout="60"):
    payload = json.dumps(
        {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
            },
        }
    )
    raw = subprocess.run(
        ["timeout", timeout, "websocat", "-n1", "-B", "33554432", websocket],
        input=payload,
        capture_output=True,
        text=True,
    ).stdout
    try:
        return json.loads(raw)["result"]["result"].get("value")
    except (json.JSONDecodeError, KeyError, TypeError):
        return None


def live_tab(endpoint):
    """A ChatGPT page that can still run JavaScript. A wedged renderer accepts the
    connection and then answers nothing, which is indistinguishable from a refusal
    until it is probed."""
    for target in cdp_targets(endpoint):
        if target.get("type") != "page" or "chatgpt.com" not in (
            target.get("url") or ""
        ):
            continue
        probe = evaluate(target["webSocketDebuggerUrl"], "1+1", timeout="10")
        if probe == 2:
            return target["webSocketDebuggerUrl"]
    return None


def epoch(value):
    """The list's update_time is ISO; everything else here is UTC epoch seconds."""
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return 0.0
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return 0.0


def load_jsonl(path):
    rows = []
    for lineno, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            print(f"warning: skipping malformed recorder row {path}:{lineno}: {exc}", file=sys.stderr)
    return rows


def describe(row):
    """One line for the newest thing this chat did. `busy` alone says nothing about
    whether work is happening — a chat mid-tool-call and a chat wedged ten minutes ago
    both read the same — so the row carries the action and its clock instead."""
    kind = row.get("kind", "?")
    if kind == "tool_call":
        call = row.get("call", {})
        summary = (call.get("summary") or {}).get("title") or ""
        return " ".join(x for x in (call.get("tool"), call.get("outcome"), summary) if x)
    if kind.endswith("_message"):
        text = (row.get("message") or {}).get("text") or ""
        return f"{kind.removesuffix('_message')}: {' '.join(text.split())[:60]}"
    if kind == "turn_end":
        return f"turn_end {row.get('outcome', '')}".strip()
    if kind == "chat_error":
        return f"error: {' '.join(((row.get('message') or {}).get('text') or '').split())[:60]}"
    return kind


def recorded_states(root):
    """Turn state of every chat this app recorded: {conversation id: (ms, state, action)}.

    Only chats that bridged through the app appear here."""
    states = {}
    for meta_file in root.glob("*/meta.json"):
        meta = json.loads(meta_file.read_text())
        chat = meta.get("conversationId")
        if not chat:
            continue
        session = meta_file.parent
        events = load_jsonl(session / "events.jsonl")
        # A message is rewritten in its own shard while it streams, so the newest one is not
        # in events.jsonl at all and is often the only thing that happened recently.
        messages = [json.loads(shard.read_text()) for shard in (session / "messages").glob("*.json")]
        # Ordered by seq as well as time: a turn ending and the next one starting share a
        # second, and the clock alone reports the chat as having just stopped when it started.
        order = lambda row: (row.get("time", 0), row.get("seq", 0))
        newest = max(events + messages, key=order, default=None)

        # turn_start when ChatGPT begins generating, turn_end when it finishes. Only turn_end
        # is a clean ending: a turn that dies to an error or a closed tab keeps turn_start as
        # its newest turn event, so those two alone report a dead chat as busy forever.
        marks = [row for row in events if row.get("kind") in ("turn_start", "turn_end", "chat_error")]
        last = max(marks, key=order, default=None)
        if last is None or last["kind"] == "turn_end":
            state = "idle"
        else:
            state = "busy"
            # A stall report is not an ending: the turn often resumes. Anything recorded after
            # one is the chat working again, so `wedged` stands only while the error is last.
            if last["kind"] == "chat_error" and not any(order(row) > order(last) for row in events):
                state = "wedged"
        # The clock is the last action's own time, never meta.updatedAt: the recorder touches
        # that on any observation of the chat, including its own polling.
        when = newest.get("time", 0) if newest else meta["updatedAt"]

        # A turn nothing has added to for 90 s is not generating, whatever the last event says.
        # Deliberately eager: the cost of being early is one refused push, because callers
        # compare this timestamp before and after the attempt; the cost of being late is a
        # whole polling interval of a chat doing nothing.
        if state == "busy" and time.time() - when / 1000 > 90:
            state = "stalled"

        entry = (when, state, describe(newest) if newest else "-")
        if chat not in states or entry[0] > states[chat][0]:
            states[chat] = entry
    return states


TAB_STATE_JS = """(() => {
  // A failed send ("Message delivery timed out") never reaches the server, so only the page
  // knows: it shows an alert banner while the server keeps answering COMPLETE.
  const alert = document.querySelector('aside[role=alert]');
  if (alert && alert.innerText.trim()) return 'alert:' + alert.innerText.trim();
  const els = [...document.querySelectorAll('[data-talvt-turn-state]')];
  return els.length ? els[els.length - 1].getAttribute('data-talvt-turn-state') : null;
})()"""


def tab_turn_states(endpoint):
    """Turn state of each open ChatGPT conversation tab: {conversation id: state}.

    ChatGPT's own page marks the newest turn `in_progress` while the model works, then
    `complete` or `cancelled`; a tab showing an error banner reports `alert:<banner text>`.
    A chat with no open tab has no entry."""
    states = {}
    for target in cdp_targets(endpoint):
        url = target.get("url") or ""
        if target.get("type") != "page" or "chatgpt.com/" not in url or "/c/" not in url:
            continue
        chat = url.split("/c/", 1)[1].split("?")[0].split("/")[0].split("#")[0]
        state = evaluate(target["webSocketDebuggerUrl"], TAB_STATE_JS, timeout="10")
        if state:
            states[chat] = state
    return states


def age_text(seconds):
    minutes = int(max(seconds, 0) // 60)
    if minutes < 1:
        return f"{int(max(seconds, 0))}s"
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 48 * 60:
        return f"{minutes // 60}h{minutes % 60:02d}"
    return f"{minutes // 1440}d"


# Summarises one conversation inside the page so a large detail never crosses the DevTools
# boundary. Restricted to the current branch: `mapping` holds every node including branches
# the user edited away, and `current_node`'s parent chain is what ChatGPT loads.
SUMMARY_JS = r"""
  function contentChars(c) {
    if (!c || typeof c !== 'object') return 0;
    if (c.content_type !== 'text' && c.content_type !== 'code'
        && c.content_type !== 'execution_output' && c.content_type !== 'multimodal_text') return 0;
    let n = 0;
    if (Array.isArray(c.parts)) for (const p of c.parts) if (typeof p === 'string') n += p.length;
    if (typeof c.text === 'string') n += c.text.length;
    return n;
  }
  function summarize(d) {
    const mapping = d.mapping || {};
    const path = []; let cur = d.current_node; const seen = new Set();
    while (cur && mapping[cur] && !seen.has(cur)) { seen.add(cur); path.push(cur); cur = mapping[cur].parent; }
    const nodes = path.length ? path : Object.keys(mapping);
    const roles = {user: 0, assistant: 0, tool: 0};
    const models = {}; let chars = 0; let latest = null; let latestAt = -1; let lastAt = 0;
    for (const id of nodes) {
      const m = mapping[id] && mapping[id].message;
      if (!m || typeof m !== 'object') continue;
      const role = (m.author && m.author.role) || 'unknown';
      roles[role] = (roles[role] || 0) + 1;
      const md = m.metadata || {};
      if (role === 'assistant' && typeof md.model_slug === 'string') {
        models[md.model_slug] = (models[md.model_slug] || 0) + 1;
        const at = Number(m.create_time) || 0;
        if (at >= latestAt) { latestAt = at; latest = md.model_slug; }
      }
      chars += contentChars(m.content);
      lastAt = Math.max(lastAt, Number(m.create_time) || 0);
    }
    return {last_at: lastAt, update_time: Number(d.update_time) || 0,
            model: latest || d.default_model_slug || null, models,
            user: roles.user || 0, assistant: roles.assistant || 0, tool: roles.tool || 0,
            tokens: Math.ceil(chars / 4)};
  }
"""


def index_expression(archived, max_items):
    """The sidebar list (ids, titles, list times), at least `max_items` long (0 = all).
    Its paging order is not strictly by time, so callers sort what they get."""
    return f"""(async () => {{
  const s = await (await fetch('/api/auth/session', {{credentials: 'include'}})).json();
  if (typeof s.accessToken !== 'string') return JSON.stringify({{error: 'no_access_token'}});
  const headers = {{Authorization: 'Bearer ' + s.accessToken}};
  const out = []; let offset = 0;
  while ({max_items} === 0 || out.length < {max_items}) {{
    const response = await fetch('/backend-api/conversations?order=updated&is_archived={archived}&offset='
      + offset + '&limit=100', {{headers, credentials: 'include'}});
    if (response.status !== 200) return JSON.stringify({{error: response.status, items: out}});
    const body = await response.json();
    const items = body.items || [];
    if (!items.length) break;
    for (const item of items) out.push({{id: item.id, update_time: item.update_time,
      title: item.title, archived: !!item.is_archived}});
    offset += items.length;
  }}
  return JSON.stringify({{items: out}});
}})()"""


ACTIVITY_JS = r"""
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = {};
  // POST /backend-api/conversations/batch is what the page uses for chat metadata: up to 10 ids
  // per call, no message bodies (about 0.5 KB per chat), and it is not under the history-detail
  // 429 budget. Its update_time follows a running turn; the sidebar list's does not.
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    try {
      const response = await fetch('/backend-api/conversations/batch', {method: 'POST',
        headers: {...headers, 'Content-Type': 'application/json'}, credentials: 'include',
        body: JSON.stringify({conversation_ids: chunk, include_full_history: false}),
        signal: AbortSignal.timeout(30000)});
      if (!response.ok) { for (const id of chunk) out[id] = {batch_status: response.status}; continue; }
      for (const item of await response.json())
        out[item.id] = {update_time: item.update_time,
                        latest_assistant: item.latest_assistant_turn_created_at || null};
    } catch (error) { for (const id of chunk) out[id] = {batch_status: null}; }
    await sleep(200);
  }
  // The page polls /conversation/<id>/stream_status (a 21-byte reply): COMPLETE, or
  // IS_STREAMING while a turn runs. It is not under the history-detail budget either. Sixteen
  // at a time read 100 chats in 7 s with no 429 (measured 2026-11-22).
  async function stream(id) {
    try {
      const response = await fetch('/backend-api/conversation/' + id + '/stream_status',
        {headers, credentials: 'include', signal: AbortSignal.timeout(20000)});
      return response.ok ? (await response.json()).status : 'HTTP_' + response.status;
    } catch (error) { return 'ERROR'; }
  }
  for (let i = 0; i < ids.length; i += 16) {
    const chunk = ids.slice(i, i + 16);
    const states = await Promise.all(chunk.map(stream));
    chunk.forEach((id, k) => { out[id] = {...out[id], stream: states[k]}; });
  }
  return JSON.stringify(out);
"""


def fetch_activity(websocket, ids):
    """Cheap per-chat activity: {id: {update_time, latest_assistant, stream}} (ISO times)."""
    if not ids:
        return {}
    expression = (
        "(async () => {\n"
        + f"  const ids = {json.dumps(ids)};\n"
        + """  const s = await (await fetch('/api/auth/session', {credentials: 'include'})).json();
  if (typeof s.accessToken !== 'string') return JSON.stringify({});
  const headers = {Authorization: 'Bearer ' + s.accessToken};
"""
        + ACTIVITY_JS
        + "})()"
    )
    # 10 ids per batch call and 16 per stream_status round: about 0.1 s per chat, measured.
    value = evaluate(websocket, expression, timeout=str(60 + len(ids) // 4))
    try:
        return json.loads(value) if value else {}
    except json.JSONDecodeError:
        return {}


def fetch_summaries(websocket, ids):
    """Read each conversation, one at a time, stopping at the first 429; {id: summary} or {id: {status: http}}."""
    if not ids:
        return {}
    expression = (
        "(async () => {\n"
        + SUMMARY_JS
        + f"\n  const ids = {json.dumps(ids)};\n"
        + """  const s = await (await fetch('/api/auth/session', {credentials: 'include'})).json();
  if (typeof s.accessToken !== 'string') return JSON.stringify({error: 'no_access_token'});
  const headers = {Authorization: 'Bearer ' + s.accessToken};
  const out = {};
  // One read at a time: a burst of full-conversation reads is what trips HTTP 429. The first
  // 429 stops every further full read (the limit lasts about a minute, and waiting it out would
  // make the listing slower than the question it answers); those rows report !429 but keep their
  // state and time.
  let limited = false;
  async function one(id) {
    if (limited) { out[id] = {status: 429}; return; }
    try {
      const response = await fetch('/backend-api/conversation/' + id,
        {headers, credentials: 'include', signal: AbortSignal.timeout(60000)});
      if (response.status === 429) limited = true;
      out[id] = response.ok ? summarize(await response.json()) : {status: response.status};
    } catch (error) { out[id] = {status: null}; }
  }
  for (const id of ids) await one(id);
  return JSON.stringify(out);
})()"""
    )
    value = evaluate(websocket, expression, timeout="240")
    try:
        return json.loads(value) if value else {}
    except json.JSONDecodeError:
        return {}


def activity_rows(candidates, titles, tabs, states, activity, now, minutes):
    """One row per chat worth listing, newest first, from the cheap pass (no message bodies).

    `activity` is fetch_activity's {id: {update_time, stream}} or {id: {batch_status}} when the
    metadata call failed. A chat is listed when a turn runs (ChatGPT's stream_status, an open tab
    marked in progress, or the recorder), when its newest message is within `minutes`, or when
    its metadata could not be read: a chat whose time is unknown cannot be ruled inactive."""
    rows = []
    for chat in candidates:
        seen = activity.get(chat, {})
        when, recorded, action = states.get(chat, (0, "-", ""))
        stream = seen.get("stream")
        state = recorded
        last_at = max(epoch(seen.get("update_time")), when / 1000)
        fresh = minutes <= 0 or now - last_at <= minutes * 60
        if tabs.get(chat, "").startswith("alert:"):
            # The page shows an error banner (e.g. "Message delivery timed out"); the server
            # still answers COMPLETE because the message never arrived.
            state, action = "alert", tabs[chat].removeprefix("alert:")
        elif tabs.get(chat) == "in_progress":
            state = "busy"
        elif stream == "IS_STREAMING":
            # ChatGPT keeps IS_STREAMING on some chats for weeks after their last update
            # (28 h to 24 d on 2026-11-22), so a streaming flag with no change inside the window
            # is reported as `stream`, not `busy`: the server claims it, nothing confirms it.
            state = "busy" if fresh or recorded == "busy" else "stream"
        elif state == "busy":
            # The recorder keeps "busy" until it sees a turn end; ChatGPT says the stream is over.
            state = "idle" if stream == "COMPLETE" else state
        elif state == "-" and (chat in tabs or stream == "COMPLETE"):
            state = "idle"
        failed = "batch_status" in seen or not seen
        if not failed and state not in ("busy", "stream", "alert") and not fresh:
            continue
        row = {"id": chat, "title": titles[chat], "state": state, "action": action,
               "last_at": last_at}
        if failed:
            row["status"] = seen.get("batch_status")
        rows.append(row)
    rows.sort(key=lambda row: row["last_at"], reverse=True)
    return rows


def render(rows, now):
    lines = [
        f"{'last msg':>8} {'state':<8} {'id':<38} {'model':<18} {'msgs':>5} {'tools':>5} "
        f"{'~tok':>7}  title | last action"
    ]
    for row in rows:
        model = row.get("model") or (f"!{row['status']}" if "status" in row else "?")
        if len(row.get("models") or {}) > 1:
            model += f"+{len(row['models']) - 1}"
        messages = (row.get("user") or 0) + (row.get("assistant") or 0)
        tokens = row.get("tokens") or 0
        size = f"{tokens / 1000:.1f}k" if tokens >= 1000 else str(tokens)
        last = age_text(now - row["last_at"]) if row["last_at"] else "?"
        title = " ".join(row["title"].split())[:60]
        lines.append(
            f"{last:>8} {row['state']:<8} {row['id']:<38} {model:<18} {messages:>5} "
            f"{row.get('tool') or 0:>5} {size:>7}  {title}"
            + (f" | {row['action']}" if row["action"] else "")
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--minutes",
        type=float,
        default=10,
        help="A chat is active if its newest message is within this many minutes "
        "(default 10), or if a turn is generating. 0 lists every candidate read.",
    )
    parser.add_argument(
        "--candidates",
        type=int,
        default=20,
        help="How many chats, newest by sidebar-list time, to check for activity (default 20; "
        "0 = every chat), "
        "in addition to every open tab and every recorder-busy chat.",
    )
    parser.add_argument(
        "--match", default="", help="Only chats whose title contains this text."
    )
    parser.add_argument(
        "--archived",
        action="store_true",
        help="Read archived conversations instead of active ones.",
    )
    parser.add_argument("--devtools", default=DEVTOOLS)
    parser.add_argument(
        "--sessions",
        required=True,
        help="This app's recorder directory (the justfile's sessions_dir).",
    )
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    args = parser.parse_args()

    websocket = live_tab(args.devtools)
    if not websocket:
        sys.exit(
            f"no ChatGPT tab that can still run a request on {args.devtools} — "
            "open https://chatgpt.com in Chromium with --remote-debugging-port=9222"
        )

    # The list pages 100 at a time and a full pass over a large account takes about a minute
    # (1409 chats: 52 s). Its first pages hold the newest chats, so read only enough of them
    # for the candidates, with headroom for the few pinned chats that come first out of order.
    # A title match has to search the whole list.
    list_size = 0 if args.match or args.candidates == 0 else 100 * (1 + args.candidates // 100)
    listing = evaluate(
        websocket,
        index_expression("true" if args.archived else "false", list_size),
        timeout="90",
    )
    try:
        body = json.loads(listing) if listing else {}
    except json.JSONDecodeError:
        body = {}
    if not body.get("items"):
        sys.exit(
            "ChatGPT did not answer the conversation list"
            + (f" (status {body['error']})" if body.get("error") else "")
        )
    titles = {item["id"]: item.get("title") or "" for item in body["items"]}

    tabs = tab_turn_states(args.devtools)
    states = recorded_states(Path(args.sessions).expanduser())
    generating = {
        chat
        for chat in titles
        if tabs.get(chat) == "in_progress" or states.get(chat, (0, "-", ""))[1] == "busy"
    }

    newest = sorted(
        body["items"], key=lambda item: epoch(item.get("update_time")), reverse=True
    )
    candidates = {item["id"] for item in newest[: args.candidates or None]}
    candidates |= generating | {chat for chat in tabs if chat in titles}
    candidates = {
        chat
        for chat in candidates
        if not args.match or args.match.lower() in titles[chat].lower()
    }

    activity = fetch_activity(websocket, sorted(candidates))
    if candidates and not any("update_time" in seen for seen in activity.values()):
        sys.exit(
            "ChatGPT answered none of the per-chat metadata calls "
            "(POST /backend-api/conversations/batch); try again, or lower --candidates"
        )

    now = time.time()
    rows = activity_rows(candidates, titles, tabs, states, activity, now, args.minutes)

    # Model and size need the whole conversation, which is under ChatGPT's history-detail budget
    # (HTTP 429), so only the chats that survived the activity window are read in full.
    summaries = fetch_summaries(websocket, [row["id"] for row in rows if "status" not in row])
    for row in rows:
        if "status" not in row:
            row.update(summaries.get(row["id"]) or {"status": None})

    if args.json:
        keys = ("id", "title", "state", "last_at", "model", "models", "user", "assistant",
                "tool", "tokens", "action", "status")
        print(json.dumps([{key: row.get(key) for key in keys} for row in rows], indent=1))
        return

    print(render(rows, now))
    if any("status" in row for row in rows):
        print(
            "\n!n is the HTTP status of a read that failed (!None: no reply); run again.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
