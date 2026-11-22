#!/usr/bin/env python3
"""List the account's ChatGPT conversations with idle time, answering model and length.
(`just chats` runs this.)

The account's own conversation index is the only complete list, and it carries no
model: `default_model_slug` and per-message `metadata.model_slug` exist only on
`/backend-api/conversation/<id>`. That detail endpoint is expensive (one request per
conversation), so this script resolves each row from the cheapest current source:

  1. the exported corpus (`chatgpt-web-export`), when its recorded update time equals
     the live one — offline, no request;
  2. a summary cache under the app's state directory, keyed by update time;
  3. one live detail fetch, bounded per run.

Nothing here mutates a conversation, the corpus, or the cache's source of truth. The
cache only remembers compact summaries (model, message counts, character count).

Length is `~tok` = characters of user, assistant and tool text divided by four. It
excludes hidden reasoning (`thoughts`, `reasoning_recap`), which is not carried
forward, and system prompts and tool schemas, which are invisible from here. It is a
sizing estimate, not ChatGPT's context counter.
"""

import argparse
import json
from datetime import datetime
from pathlib import Path
import subprocess
import sys
import time

DEVTOOLS = "http://127.0.0.1:9222"
CORPUS = Path.home() / "agent-transcripts/chatgpt-browser"
STATE = Path.home() / ".config/chat-on-steroids/state/chat-models.json"

# Content types that carry conversation text. `thoughts` and `reasoning_recap` are
# reasoning the model does not get back, so counting them would overstate context.
TEXT_CONTENT = ("text", "code", "execution_output", "multimodal_text")


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
    """Live update_time is ISO; corpus and cache store UTC epoch seconds."""
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

    Only chats that bridged through the app appear here; any other account chat has no
    recorded turn state, so its row shows `-`."""
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
    `complete` or `cancelled` (the same attribute the extension reads, see
    extension/chatgpt-dom.js). This is the direct signal that a chat is generating now;
    the account index's update time can lag a turn that is still streaming. A chat with
    no open tab has no entry."""
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


def idle_text(seconds):
    minutes = int(max(seconds, 0) // 60)
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 48 * 60:
        return f"{minutes // 60}h{minutes % 60:02d}"
    return f"{minutes // 1440}d"


def content_chars(content):
    if not isinstance(content, dict):
        return 0
    if content.get("content_type") not in TEXT_CONTENT:
        return 0
    chars = 0
    parts = content.get("parts")
    if isinstance(parts, list):
        chars += sum(len(part) for part in parts if isinstance(part, str))
    text = content.get("text")
    if isinstance(text, str):
        chars += len(text)
    return chars


def summarize(detail):
    """Model and size of one conversation detail, restricted to the current branch.

    `mapping` holds every node, including branches the user edited away. Walking
    `current_node`'s parent chain counts the conversation ChatGPT actually loads."""
    mapping = detail.get("mapping") or {}
    path = []
    current = detail.get("current_node")
    seen = set()
    while current and current in mapping and current not in seen:
        seen.add(current)
        path.append(current)
        current = (mapping[current] or {}).get("parent")
    nodes = path or list(mapping)

    roles = {"user": 0, "assistant": 0, "tool": 0}
    models = {}
    chars = 0
    latest_model = None
    latest_at = -1.0
    for node_id in nodes:
        message = (mapping.get(node_id) or {}).get("message")
        if not isinstance(message, dict):
            continue
        role = ((message.get("author") or {}).get("role")) or "unknown"
        roles[role] = roles.get(role, 0) + 1
        metadata = message.get("metadata") or {}
        slug = metadata.get("model_slug")
        if role == "assistant" and isinstance(slug, str):
            models[slug] = models.get(slug, 0) + 1
            at = message.get("create_time") or 0
            try:
                at = float(at)
            except (TypeError, ValueError):
                at = 0.0
            if at >= latest_at:
                latest_at = at
                latest_model = slug
        chars += content_chars(message.get("content"))

    return {
        "model": latest_model or detail.get("default_model_slug"),
        "models": models,
        "user": roles.get("user", 0),
        "assistant": roles.get("assistant", 0),
        "tool": roles.get("tool", 0),
        "chars": chars,
        "tokens": (chars + 3) // 4,
    }


# The same summary, computed inside the page so a large conversation detail never
# crosses the DevTools boundary.
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
    const models = {}; let chars = 0; let latest = null; let latestAt = -1;
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
    }
    return {model: latest || d.default_model_slug || null, models, user: roles.user || 0,
            assistant: roles.assistant || 0, tool: roles.tool || 0, chars,
            tokens: Math.ceil(chars / 4)};
  }
"""


def index_expression(archived):
    """The whole index: its paging order is not strictly by update time (pinned and
    project chats come first), so a prefix of it is not the newest chats."""
    return f"""(async () => {{
  const s = await (await fetch('/api/auth/session', {{credentials: 'include'}})).json();
  if (typeof s.accessToken !== 'string') return JSON.stringify({{error: 'no_access_token'}});
  const headers = {{Authorization: 'Bearer ' + s.accessToken}};
  const out = []; let offset = 0;
  while (true) {{
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
  for (const id of ids) {
    try {
      const response = await fetch('/backend-api/conversation/' + id,
        {headers, credentials: 'include', signal: AbortSignal.timeout(20000)});
      if (!response.ok) { out[id] = {status: response.status}; if (response.status === 429) break; continue; }
      const detail = await response.json();
      out[id] = summarize(detail);
    } catch (error) { out[id] = {status: null}; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return JSON.stringify(out);
})()"""
    )
    value = evaluate(websocket, expression, timeout="180")
    try:
        return json.loads(value) if value else {}
    except json.JSONDecodeError:
        return {}


def load_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return default


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=30,
        help="How many conversations to list, newest first (default 30), after "
        "--match and --minutes have filtered the whole index.",
    )
    parser.add_argument(
        "--minutes",
        type=float,
        default=0,
        help="Only conversations updated within this many minutes (0 = no age limit).",
    )
    parser.add_argument(
        "--match", default="", help="Only rows whose title contains this text."
    )
    parser.add_argument(
        "--fresh",
        type=int,
        default=20,
        help="Live detail fetches allowed per run (default 20). Rows beyond "
        "this use a current corpus export, a cache entry, or show '?'.",
    )
    parser.add_argument(
        "--archived",
        action="store_true",
        help="List archived conversations instead of active ones.",
    )
    parser.add_argument("--devtools", default=DEVTOOLS)
    parser.add_argument(
        "--corpus",
        default=str(CORPUS),
        help="Exported conversation library from chatgpt-web-export.",
    )
    parser.add_argument("--cache", default=str(STATE))
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

    listing = evaluate(
        websocket,
        index_expression("true" if args.archived else "false"),
        timeout="90",
    )
    try:
        body = json.loads(listing) if listing else {}
    except json.JSONDecodeError:
        body = {}
    if not body.get("items"):
        sys.exit(
            f"ChatGPT did not answer the conversation index"
            + (f" (status {body['error']})" if body.get("error") else "")
        )
    items = body["items"]

    corpus_root = Path(args.corpus).expanduser()
    manifest = load_json(corpus_root / "manifest.json", {}).get("entries", {})
    cache_path = Path(args.cache).expanduser()
    cache = load_json(cache_path, {})

    cutoff = time.time() - args.minutes * 60 if args.minutes > 0 else 0.0
    tabs = tab_turn_states(args.devtools)
    wanted = [
        item
        for item in items
        if (not args.match or args.match.lower() in (item.get("title") or "").lower())
        and (epoch(item.get("update_time")) >= cutoff or tabs.get(item["id"]) == "in_progress")
    ]
    wanted.sort(key=lambda item: epoch(item.get("update_time")), reverse=True)
    wanted = wanted[: args.limit]

    rows = []
    to_fetch = []
    for item in wanted:
        live_at = epoch(item.get("update_time"))
        entry = manifest.get(item["id"])
        cached = cache.get(item["id"])
        row = {
            "id": item["id"],
            "title": item.get("title") or "",
            "update_time": live_at,
            "archived": item.get("archived"),
            "source": None,
            "stale": False,
        }
        if entry and epoch(entry.get("update_time")) >= live_at:
            detail = load_json(corpus_root / entry["json_path"], None)
            if detail:
                row.update(summarize(detail))
                row["source"] = "corpus"
                rows.append(row)
                continue
        if cached and epoch(cached.get("update_time")) == live_at:
            row.update(cached)
            row["source"] = "cache"
            rows.append(row)
            continue
        to_fetch.append((row, entry, cached))

    budget = max(0, args.fresh)
    fetched = fetch_summaries(websocket, [row["id"] for row, _, _ in to_fetch[:budget]])
    for row, entry, cached in to_fetch:
        summary = fetched.get(row["id"])
        if isinstance(summary, dict) and "chars" in summary:
            row.update(summary)
            row["source"] = "live"
            cache[row["id"]] = {**summary, "update_time": row["update_time"]}
        elif isinstance(summary, dict) and "status" in summary:
            row["status"] = summary["status"]
        elif entry:
            detail = load_json(corpus_root / entry["json_path"], None)
            if detail:
                row.update(summarize(detail))
                row["source"] = "corpus"
                row["stale"] = True
        elif cached:
            row.update(cached)
            row["source"] = "cache"
            row["stale"] = True
        rows.append(row)

    states = recorded_states(Path(args.sessions).expanduser())
    for row in rows:
        when, state, action = states.get(row["id"], (0, "-", ""))
        # The account index can lag a turn that is still streaming; the recorder's own
        # clock is the fresher of the two when this app saw the chat.
        row["update_time"] = max(row["update_time"], when / 1000)
        tab = tabs.get(row["id"])
        if tab == "in_progress":
            state = "busy"
        elif state == "-" and tab:
            state = "idle"
        row["state"] = state
        row["action"] = action
    rows.sort(key=lambda row: row["update_time"], reverse=True)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        cache_path.write_text(json.dumps(cache, separators=(",", ":")))
    except OSError:
        pass

    if args.json:
        print(
            json.dumps(
                [
                    {
                        key: row.get(key)
                        for key in (
                            "id",
                            "title",
                            "model",
                            "models",
                            "user",
                            "assistant",
                            "tool",
                            "tokens",
                            "update_time",
                            "source",
                            "stale",
                            "archived",
                            "status",
                            "state",
                            "action",
                        )
                    }
                    for row in rows
                ],
                indent=1,
            )
        )
        return

    print(
        f"{'updated':<12} {'idle':>6} {'state':<8} {'id':<38} {'model':<18} {'msgs':>5} {'tools':>5} {'~tok':>7}  title | last action"
    )
    for row in rows:
        model = row.get("model") or (
            f"!{row['status']}" if row.get("status") is not None else "?"
        )
        if len(row.get("models") or {}) > 1:
            model += f"+{len(row['models']) - 1}"
        if row["stale"]:
            model += "*"
        messages = (row.get("user") or 0) + (row.get("assistant") or 0)
        tokens = (
            f"{row['tokens'] / 1000:.1f}k"
            if (row.get("tokens") or 0) >= 1000
            else str(row.get("tokens") or 0)
        )
        if row["stale"]:
            tokens += "*"
        when = (
            time.strftime("%m-%d %H:%M", time.localtime(row["update_time"]))
            if row["update_time"]
            else "?"
        )
        idle = idle_text(time.time() - row["update_time"]) if row["update_time"] else "?"
        title = " ".join((row.get("title") or "").split())[:60]
        print(
            f"{when:<12} {idle:>6} {row['state']:<8} {row['id']:<38} {model:<18} {messages:>5} "
            f"{row.get('tool') or 0:>5} {tokens:>7}  {title}"
            + (f" | {row['action']}" if row["action"] else "")
        )
    if any(row["stale"] for row in rows):
        print(
            "\n* corpus export predates the live conversation; run the chatgpt-web-export "
            "sync or raise --fresh for current values.",
            file=sys.stderr,
        )
    unresolved = [row for row in rows if not row.get("model")]
    if unresolved:
        print(
            "\n!n is the HTTP status of a detail fetch that failed; ? means no fetch was "
            "attempted (raise --fresh) and no current corpus or cache entry exists. Run "
            "again: the cache keeps every row that did resolve.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
