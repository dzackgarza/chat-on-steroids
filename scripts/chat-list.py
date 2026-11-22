#!/usr/bin/env python3
"""List the account's ChatGPT conversations with idle time, answering model and length.
(`just gpt` runs this.)

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
        "--match and --hours have filtered the whole index.",
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=0,
        help="Only conversations updated within this many hours (0 = no age limit).",
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

    cutoff = time.time() - args.hours * 3600 if args.hours > 0 else 0.0
    wanted = [
        item
        for item in items
        if (not args.match or args.match.lower() in (item.get("title") or "").lower())
        and epoch(item.get("update_time")) >= cutoff
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
                        )
                    }
                    for row in rows
                ],
                indent=1,
            )
        )
        return

    print(
        f"{'updated':<12} {'idle':>6} {'id':<38} {'model':<18} {'msgs':>5} {'tools':>5} {'~tok':>7}  title"
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
            f"{when:<12} {idle:>6} {row['id']:<38} {model:<18} {messages:>5} {row.get('tool') or 0:>5} "
            f"{tokens:>7}  {title}"
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
