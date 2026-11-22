#!/usr/bin/env python3
"""List the ChatGPT chats that are active now, with model and length.

A chat is active when a turn is generating, or when its newest message is recent.
Both come from the conversation itself, not from ChatGPT's sidebar list:

  * generating — the chat's open tab marks its newest turn `in_progress`
    (`data-talvt-turn-state`, the attribute extension/chatgpt-dom.js reads), or this app's
    recorder says a turn is running;
  * last activity — `create_time` of the newest message in
    `/backend-api/conversation/<id>`.

The sidebar list (`/backend-api/conversations`) is used only to enumerate chat ids and
titles. Its `update_time` equals the conversation's own `update_time` for chats at rest but
stays frozen while a long turn runs (measured: 20:04 in the list against 20:38 in the
conversation), so it never decides whether a chat is active.

Because the list time cannot rule a chat out, this reads the conversation of every
candidate: the `--candidates` newest chats by list time, every chat with an open tab, and
every chat the recorder says is busy. Model (`metadata.model_slug`) and size come from the
same read.

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
  const els = [...document.querySelectorAll('[data-talvt-turn-state]')];
  return els.length ? els[els.length - 1].getAttribute('data-talvt-turn-state') : null;
})()"""


def tab_turn_states(endpoint):
    """Turn state of each open ChatGPT conversation tab: {conversation id: state}.

    ChatGPT's own page marks the newest turn `in_progress` while the model works, then
    `complete` or `cancelled`. A chat with no open tab has no entry."""
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


def fetch_summaries(websocket, ids):
    """Read each conversation, four at a time; {id: summary} or {id: {status: http}}."""
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
  async function one(id) {
    try {
      const response = await fetch('/backend-api/conversation/' + id,
        {headers, credentials: 'include', signal: AbortSignal.timeout(60000)});
      out[id] = response.ok ? summarize(await response.json()) : {status: response.status};
    } catch (error) { out[id] = {status: null}; }
  }
  for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(one));
  return JSON.stringify(out);
})()"""
    )
    value = evaluate(websocket, expression, timeout="240")
    try:
        return json.loads(value) if value else {}
    except json.JSONDecodeError:
        return {}


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
        default=10,
        help="How many chats, newest by sidebar-list time, to read in full (default 10), "
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
    list_size = 0 if args.match else 100 * (1 + args.candidates // 100)
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
    candidates = {item["id"] for item in newest[: args.candidates]}
    candidates |= generating | {chat for chat in tabs if chat in titles}
    candidates = {
        chat
        for chat in candidates
        if not args.match or args.match.lower() in titles[chat].lower()
    }

    summaries = fetch_summaries(websocket, sorted(candidates))

    now = time.time()
    rows = []
    for chat in candidates:
        summary = summaries.get(chat) or {"status": None}
        when, recorded, action = states.get(chat, (0, "-", ""))
        state = recorded
        if tabs.get(chat) == "in_progress":
            state = "busy"
        elif state == "-" and chat in tabs:
            state = "idle"
        # The recorder's clock counts when this app saw something newer than the message.
        last_at = max(summary.get("last_at") or 0, when / 1000)
        if state != "busy" and args.minutes > 0 and now - last_at > args.minutes * 60:
            continue
        rows.append({"id": chat, "title": titles[chat], "state": state, "action": action,
                     "last_at": last_at, **summary})
    rows.sort(key=lambda row: row["last_at"], reverse=True)

    if args.json:
        keys = ("id", "title", "state", "last_at", "model", "models", "user", "assistant",
                "tool", "tokens", "action", "status")
        print(json.dumps([{key: row.get(key) for key in keys} for row in rows], indent=1))
        return

    print(
        f"{'last msg':>8} {'state':<8} {'id':<38} {'model':<18} {'msgs':>5} {'tools':>5} "
        f"{'~tok':>7}  title | last action"
    )
    for row in rows:
        model = row.get("model") or (
            f"!{row['status']}" if "status" in row else "?"
        )
        if len(row.get("models") or {}) > 1:
            model += f"+{len(row['models']) - 1}"
        messages = (row.get("user") or 0) + (row.get("assistant") or 0)
        tokens = row.get("tokens") or 0
        size = f"{tokens / 1000:.1f}k" if tokens >= 1000 else str(tokens)
        last = age_text(now - row["last_at"]) if row["last_at"] else "?"
        title = " ".join(row["title"].split())[:60]
        print(
            f"{last:>8} {row['state']:<8} {row['id']:<38} {model:<18} {messages:>5} "
            f"{row.get('tool') or 0:>5} {size:>7}  {title}"
            + (f" | {row['action']}" if row["action"] else "")
        )
    if any("status" in row for row in rows):
        print(
            "\n!n is the HTTP status of a conversation read that failed; run again.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
