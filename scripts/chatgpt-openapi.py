#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["tree-sitter>=0.25", "tree-sitter-javascript>=0.25"]
# ///
"""Generate docs/chatgpt-backend-api.openapi.json, an OpenAPI 3.1 description of the ChatGPT web
backend API, from the chatgpt.com page build.

Mining: the page's JavaScript is parsed with tree-sitter (https://tree-sitter.github.io), and every
call `<client>.safeGet|safePost|safePut|safePatch|safeDelete("/path", {parameters: {query: {...}},
requestBody: {...}})` (and the plain get/post/... spellings) becomes one operation, with the keys
the call site writes in `query` and `requestBody`. The entry chunks are listed in the page HTML;
the webpack runtime maps every lazy chunk id to a hash. Static CDN files only; no account request.

Types come from two committed inputs, never from the bundle:
  * SCHEMAS and OBSERVED below: confirmed by live requests or archived conversation bodies;
  * docs/chatgpt-backend-api-live-schemas.json: response schemas inferred by
    scripts/chatgpt-live-schemas.py from live requests (types only, no values).
Every other operation is `x-evidence: ["bundle"]`: the client calls it, nothing more is known.

Chunk URLs carry a content hash, so the extracted calls of each chunk are cached by URL in
`--cache`; a rerun downloads only chunks that are new.

Usage:
  chatgpt-openapi.py --cache DIR           regenerate the OpenAPI file
  chatgpt-openapi.py --cache DIR --check   exit 1 if the committed file differs from a regeneration
"""

import argparse
import datetime
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import tree_sitter as ts
import tree_sitter_javascript as tsjs

ORIGIN = "https://chatgpt.com"
DOCS = Path(__file__).resolve().parent.parent / "docs"
OUT = DOCS / "chatgpt-backend-api.openapi.json"
LIVE_SCHEMAS = DOCS / "chatgpt-backend-api-live-schemas.json"
ASSET = re.compile(r"[A-Za-z0-9_.~-]+\.[0-9a-f]{10}\.js")
CHUNK_PAIR = re.compile(r'(\d+):"([0-9a-f]{10,})"')
HTTP_VERBS = {"get", "post", "put", "patch", "delete"}
LANGUAGE = ts.Language(tsjs.language())
CALLS = ts.Query(
    LANGUAGE,
    "(call_expression function: (member_expression property: (property_identifier) @via) "
    "arguments: (arguments) @args) @call",
)


def fetch(url, cache, keep):
    """Body of `url` (b"" on 404). `keep` stores it in the cache."""
    target = cache / "raw" / re.sub(r"[^A-Za-z0-9_.-]", "_", url.removeprefix(ORIGIN))
    if target.exists():
        return target.read_bytes()
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return b""
        except OSError:
            continue
        else:
            if keep:
                target.write_bytes(body)
            return body
    sys.exit(f"could not download {url}")


def lazy_chunk_urls(entry_texts):
    """The webpack runtime maps lazy chunk ids to hashes: n.u=a=>"assets/async/"+a+"."+({id:"hash",...})[a]+".js"."""
    for text in entry_texts:
        marker = text.find("n.miniCssF")
        start = text.rfind("n.u=", 0, marker) if marker >= 0 else -1
        if start >= 0:
            return [
                f"{ORIGIN}/cdn/assets/async/{chunk}.{digest}.js"
                for chunk, digest in CHUNK_PAIR.findall(text[start:marker])
            ]
    sys.exit("no webpack runtime chunk map found in the entry chunks")


def text_of(node):
    return node.text.decode("utf-8", "replace")


def string_value(node):
    """The value of a plain string or substitution-free template literal, else None."""
    if node.type == "string":
        return text_of(node)[1:-1]
    if node.type == "template_string" and not any(c.type == "template_substitution" for c in node.children):
        return text_of(node)[1:-1]
    return None


def object_keys(node):
    """Top-level key names of an object literal; "...spread" for a spread; None if not an object."""
    if node is None or node.type != "object":
        return None
    keys = []
    for child in node.named_children:
        if child.type == "spread_element":
            keys.append("...spread")
        elif child.type == "shorthand_property_identifier":
            keys.append(text_of(child))
        elif child.type in ("pair", "method_definition"):
            name = child.child_by_field_name("key") if child.type == "pair" else child.child_by_field_name("name")
            if name is not None and name.type in ("property_identifier", "identifier"):
                keys.append(text_of(name))
            elif name is not None and name.type == "string":
                keys.append(text_of(name)[1:-1])
            else:
                keys.append("...computed")
    return keys


def member(obj, name):
    """Value node of key `name` in an object literal, or None."""
    for child in obj.named_children:
        if child.type == "pair":
            key = child.child_by_field_name("key")
            if key is not None and text_of(key).strip("\"'") == name:
                return child.child_by_field_name("value")
        elif child.type == "shorthand_property_identifier" and text_of(child) == name:
            return child
    return None


def calls_in(data):
    """Backend call sites in one JavaScript file: [{via, path, query, body}].

    `query` and `body` are key lists, or None when the call site passes no such object, or a
    value that is not an object literal (then "dynamic" names which)."""
    root = LANGUAGE and ts.Parser(LANGUAGE).parse(data).root_node
    found = []
    for _, captured in ts.QueryCursor(CALLS).matches(root):
        via = text_of(captured["via"][0])
        if via.removeprefix("safe").lower() not in HTTP_VERBS:
            continue
        arguments = captured["args"][0].named_children
        path = string_value(arguments[0]) if arguments else None
        if path is None or not re.match(r"^/[A-Za-z_]", path):
            continue
        options = arguments[1] if len(arguments) > 1 and arguments[1].type == "object" else None
        parameters = member(options, "parameters") if options else None
        query_node = member(parameters, "query") if parameters is not None and parameters.type == "object" else None
        body_node = member(options, "requestBody") if options else None
        dynamic = [
            name
            for name, node in (("query", query_node), ("body", body_node))
            if node is not None and node.type != "object"
        ]
        found.append(
            {
                "via": via,
                "path": path,
                "query": object_keys(query_node),
                "body": object_keys(body_node),
                "dynamic": dynamic,
            }
        )
    return found


def chunk_calls(url, cache, keep):
    """Calls of one chunk, cached by its content-hashed URL."""
    target = cache / "calls" / (re.sub(r"[^A-Za-z0-9_.-]", "_", url.removeprefix(ORIGIN)) + ".json")
    if target.exists():
        return json.loads(target.read_text())
    found = calls_in(fetch(url, cache, keep))
    target.write_text(json.dumps(found))
    return found


def mine(cache):
    for sub in ("raw", "calls"):
        (cache / sub).mkdir(parents=True, exist_ok=True)
    home = fetch(ORIGIN + "/", cache, keep=False).decode("utf-8", "replace")
    names = sorted(set(ASSET.findall(home)))
    entry_urls = [f"{ORIGIN}/cdn/assets/{name}" for name in names]
    entry_texts = [fetch(url, cache, keep=True).decode("utf-8", "replace") for url in entry_urls]
    # Entry chunks name more chunks; one more round reaches the runtime chunk.
    for text in list(entry_texts):
        for name in sorted(set(ASSET.findall(text)) - set(names)):
            names.append(name)
            entry_urls.append(f"{ORIGIN}/cdn/assets/{name}")
            entry_texts.append(fetch(entry_urls[-1], cache, keep=True).decode("utf-8", "replace"))
    urls = entry_urls + lazy_chunk_urls(entry_texts)
    with ThreadPoolExecutor(6) as pool:
        per_chunk = list(pool.map(lambda url: chunk_calls(url, cache, keep=url in entry_urls), urls))
    return [call for calls in per_chunk for call in calls]


def merge_calls(calls):
    """{(METHOD, path): {query, body, dynamic, via}} over every call site of that operation."""
    operations = {}
    for call in calls:
        key = (call["via"].removeprefix("safe").upper(), call["path"])
        entry = operations.setdefault(key, {"query": set(), "body": set(), "dynamic": set(), "via": set()})
        entry["query"] |= set(call["query"] or [])
        entry["body"] |= set(call["body"] or [])
        entry["dynamic"] |= set(call["dynamic"])
        entry["via"].add(call["via"])
    return operations


# Schemas confirmed by live requests (LIVE, 2026-11-22) or archived bodies (ARCHIVE).
ISO = {"type": "string", "format": "date-time"}
NULLABLE_STRING = {"type": ["string", "null"]}
SCHEMAS = {
    "ConversationMeta": {
        "description": "Chat metadata without message bodies (list item and batch item). Times are ISO-8601 strings.",
        "type": "object",
        "required": ["id", "title", "create_time", "update_time"],
        "properties": {
            "id": {"type": "string"},
            "title": NULLABLE_STRING,
            "create_time": ISO,
            "update_time": ISO,
            "latest_assistant_turn_created_at": {"oneOf": [ISO, {"type": "null"}]},
            "is_archived": {"type": "boolean"},
            "is_starred": {"type": ["boolean", "null"]},
            "is_temporary_chat": {"type": "boolean"},
            "is_do_not_remember": {"type": ["boolean", "null"]},
            "memory_scope": {"type": "string"},
            "async_status": {"type": ["integer", "null"]},
            "gizmo_id": NULLABLE_STRING,
            "conversation_origin": NULLABLE_STRING,
            "conversation_template_id": NULLABLE_STRING,
            "pinned_time": {"oneOf": [ISO, {"type": "null"}]},
            "context_scopes_v2": {"type": "object"},
            "safe_urls": {"type": "array", "items": {"type": "string"}},
            "blocked_urls": {"type": "array", "items": {"type": "string"}},
            "sugar_item_visible": {"type": "boolean"},
        },
        "additionalProperties": True,
    },
    "ConversationList": {
        "type": "object",
        "required": ["items", "total", "limit", "offset"],
        "properties": {
            "items": {"type": "array", "items": {"$ref": "#/components/schemas/ConversationMeta"}},
            "total": {"type": "integer"},
            "limit": {"type": "integer"},
            "offset": {"type": "integer"},
        },
    },
    "StreamStatus": {
        "type": "object",
        "required": ["status"],
        "properties": {
            "status": {
                "type": "string",
                "description": "COMPLETE when no turn runs (also for ids that do not exist); IS_STREAMING while a turn runs. IS_STREAMING was also seen on chats whose newest update was 28 h to 24 d old, so it does not prove a live turn. Other values are not observed.",
                "examples": ["COMPLETE", "IS_STREAMING"],
            }
        },
    },
    "Message": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "author": {
                "type": "object",
                "properties": {
                    "role": {"enum": ["user", "assistant", "tool", "system"]},
                    "name": NULLABLE_STRING,
                    "metadata": {"type": "object"},
                },
            },
            "create_time": {"type": ["number", "null"], "description": "Epoch seconds."},
            "update_time": {"type": ["number", "null"]},
            "content": {
                "type": "object",
                "required": ["content_type"],
                "description": "Discriminated by content_type: code, thoughts, text, execution_output, multimodal_text, reasoning_recap, model_editable_context, user_editable_context, system_error, computer_output, tether_browsing_display, tether_quote.",
                "properties": {"content_type": {"type": "string"}},
                "additionalProperties": True,
            },
            "status": {"type": "string", "examples": ["finished_successfully", "in_progress", "finished_partial_completion"]},
            "end_turn": {"type": ["boolean", "null"]},
            "weight": {"type": "integer"},
            "recipient": {"type": "string"},
            "channel": NULLABLE_STRING,
            "metadata": {"type": "object", "additionalProperties": True},
        },
    },
    "ConversationNode": {
        "type": "object",
        "required": ["id", "children"],
        "properties": {
            "id": {"type": "string"},
            "parent": NULLABLE_STRING,
            "children": {"type": "array", "items": {"type": "string"}},
            "message": {"oneOf": [{"$ref": "#/components/schemas/Message"}, {"type": "null"}]},
        },
    },
    "Conversation": {
        "description": "Full conversation body. Shape from archived bodies; times are epoch seconds here.",
        "type": "object",
        "required": ["conversation_id", "current_node", "mapping"],
        "properties": {
            "conversation_id": {"type": "string"},
            "title": NULLABLE_STRING,
            "create_time": {"type": "number"},
            "update_time": {"type": "number"},
            "current_node": {"type": "string", "description": "Newest node on the current branch; follow `parent` links to the root."},
            "mapping": {"type": "object", "additionalProperties": {"$ref": "#/components/schemas/ConversationNode"}},
            "default_model_slug": NULLABLE_STRING,
            "is_archived": {"type": "boolean"},
            "is_temporary_chat": {"type": "boolean"},
            "memory_scope": {"type": "string"},
            "async_status": {"type": ["integer", "null"]},
        },
        "additionalProperties": True,
    },
    "Error": {"type": "object", "properties": {"detail": {}}, "additionalProperties": True},
}


def json_response(description, schema):
    return {"description": description, "content": {"application/json": {"schema": schema}}}


RATE_LIMITED = {
    "description": "History-detail budget spent. Body {\"detail\":\"Too many requests\"}. Honour Retry-After; do not retry in a loop.",
    "headers": {
        "Retry-After": {"schema": {"type": "integer"}, "description": "Seconds; 50 or 51 observed."},
        "X-OAI-History-Detail-Rate-Limited": {"schema": {"type": "string"}, "description": "1"},
    },
    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}},
}
ERROR_REF = {"$ref": "#/components/schemas/Error"}

# (method, path template) -> overrides for one operation.
OBSERVED = {
    ("GET", "/conversations"): {
        "summary": "Sidebar list of chats (ids, titles, times).",
        "evidence": ["live", "repo"],
        "query": {
            "order": {"type": "string", "enum": ["updated"], "description": "order=created returns HTTP 500."},
            "is_archived": {"type": "boolean"},
            "offset": {"type": "integer", "minimum": 0},
            "limit": {"type": "integer", "maximum": 100, "description": "Above 100 returns HTTP 422."},
        },
        "responses": {
            "200": json_response("Pinned chats first; otherwise not strictly newest first. update_time freezes while a long turn runs.", {"$ref": "#/components/schemas/ConversationList"}),
            "422": json_response("limit above 100.", ERROR_REF),
            "500": json_response("order=created.", ERROR_REF),
        },
    },
    ("POST", "/conversations/batch"): {
        "summary": "Chat metadata for up to 10 ids, no message bodies. Not under the history-detail budget.",
        "evidence": ["live", "page"],
        "body": {
            "conversation_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
            "include_full_history": {"type": "boolean"},
        },
        "body_required": ["conversation_ids"],
        "responses": {
            "200": json_response("update_time follows a running turn.", {"type": "array", "items": {"$ref": "#/components/schemas/ConversationMeta"}}),
            "422": json_response("More than 10 ids.", ERROR_REF),
        },
    },
    ("GET", "/conversation/{conversation_id}/stream_status"): {
        "summary": "Whether a turn is generating. Cheap (21 bytes); not under the history-detail budget.",
        "evidence": ["live", "page"],
        "responses": {
            "200": json_response("Also returned for ids that do not exist.", {"$ref": "#/components/schemas/StreamStatus"}),
            "404": {"description": "The page maps this to UNAVAILABLE."},
        },
    },
    ("GET", "/conversation/{conversation_id}"): {
        "summary": "Full conversation body. Under the history-detail budget.",
        "evidence": ["live", "archive"],
        "responses": {
            "200": json_response("Whole tree including edited-away branches.", {"$ref": "#/components/schemas/Conversation"}),
            "413": json_response("detail.code conversation_length_exceeds_limit.", ERROR_REF),
            "429": RATE_LIMITED,
        },
    },
    ("GET", "/conversations/{conversation_id}"): {
        "summary": "The page's own conversation load. Under the history-detail budget. Body shape not observed.",
        "evidence": ["live"],
        "query": {"num_turns": {"type": "integer"}, "include_has_versions": {"type": "boolean"}},
        "responses": {"429": RATE_LIMITED, "423": {"description": "The page expects this status."}},
    },
    ("PATCH", "/conversation/{conversation_id}"): {
        "summary": "Update a chat; {\"is_archived\": true} archives it.",
        "evidence": ["repo", "bundle"],
        "body": {"is_archived": {"type": "boolean"}},
    },
    ("GET", "/me"): {"summary": "User profile.", "evidence": ["live"]},
    ("GET", "/models"): {"summary": "Models available to the account.", "evidence": ["live"]},
    ("GET", "/settings/user"): {"summary": "Account settings.", "evidence": ["live"]},
    ("GET", "/accounts/check/v4-2023-04-27"): {"summary": "Accounts, plan and entitlements.", "evidence": ["live"]},
    ("GET", "/wham/usage"): {"summary": "Usage limits and credits.", "evidence": ["live"]},
    ("GET", "/celsius/ws/user"): {"summary": "Returns {websocket_url} for the realtime socket.", "evidence": ["live"]},
    ("POST", "/conversation/init"): {
        "summary": "Defaults, send block (blocked_features) and limits_progress. Response shape not recorded.",
        "evidence": ["live", "repo"],
    },
    ("GET", "/gizmos/snorlax/sidebar"): {"summary": "Projects (folders) for the sidebar. Answered 200 on 2026-11-22.", "evidence": ["live"]},
    ("GET", "/pins/content"): {"summary": "Pinned items. Answered 200 on 2026-11-22.", "evidence": ["live"]},
    ("GET", "/tbo"): {"summary": "Agent (\"tbo\") list. Answered 200 on 2026-11-22.", "evidence": ["live"]},
    ("GET", "/pets"): {"summary": "Companion list. Answered 200 on 2026-11-22.", "evidence": ["live"]},
    ("GET", "/memory/status"): {
        "summary": "GET answers 404: no such route for GET.",
        "evidence": ["live"],
        "responses": {"404": json_response("No such route for GET.", ERROR_REF)},
    },
    ("GET", "/codex/notification/subscriptions"): {
        "summary": "GET answers 405; the page calls this path with another method.",
        "evidence": ["live"],
        "responses": {"405": {"description": "GET is not allowed."}},
    },
}


def operation_id(method, path):
    words = re.sub(r"[{}]", "", path).strip("/").replace("-", "_").replace(".", "_").split("/")
    return method.lower() + "_" + "_".join(words)


def live_overlay():
    """{(METHOD, path): {status, schema, body}} from the committed live-schema file."""
    document = json.loads(LIVE_SCHEMAS.read_text())
    return {tuple(key.split(" ", 1)): value for key, value in document["operations"].items()}


def build(operations, live, snapshot):
    found = dict(operations)
    for key in list(OBSERVED) + list(live):
        found.setdefault(key, {"query": set(), "body": set(), "dynamic": set(), "via": set()})
    paths, canonical = {}, {}
    for (method, path), mined in sorted(found.items(), key=lambda item: (item[0][1], item[0][0])):
        shape = re.sub(r"\{[^}]*\}", "{}", path)
        path = canonical.setdefault(shape, path)
        observed = OBSERVED.get((method, path), {})
        live_entry = live.get((method, path))
        responses = observed.get("responses")
        evidence = list(observed.get("evidence", ["bundle"]))
        if live_entry:
            responses = {str(live_entry["status"]): json_response("Observed live; types only.", live_entry["schema"])}
            evidence = ["live"] + [e for e in evidence if e != "live" and e != "bundle"]
            if mined["via"]:
                evidence.append("bundle")
        operation = {
            "operationId": operation_id(method, path),
            "tags": [path.strip("/").split("/")[0]],
            "x-evidence": evidence,
            "responses": responses or {"default": {"description": "Response schema not extracted."}},
        }
        if observed.get("summary"):
            operation["summary"] = observed["summary"]
        parameters = [
            {"name": name, "in": "path", "required": True, "schema": {"type": "string"}}
            for name in re.findall(r"\{([^}]+)\}", path)
        ]
        query_types = observed.get("query", {})
        spread = {"...spread", "...computed"}
        for name in sorted(set(query_types) | (mined["query"] - spread)):
            parameters.append({"name": name, "in": "query", "schema": query_types.get(name, {})})
        if mined["query"] & spread or "query" in mined["dynamic"]:
            operation["x-query-dynamic"] = True
        if parameters:
            operation["parameters"] = parameters
        body_types = observed.get("body", {})
        body_keys = set(body_types) | (mined["body"] - spread)
        if body_keys or "body" in mined["dynamic"] or mined["body"] & spread:
            schema = {"type": "object", "properties": {k: body_types.get(k, {}) for k in sorted(body_keys)}}
            if observed.get("body_required"):
                schema["required"] = observed["body_required"]
            if mined["body"] & spread or "body" in mined["dynamic"]:
                schema["additionalProperties"] = True
            operation["requestBody"] = {"content": {"application/json": {"schema": schema}}}
        paths.setdefault(path, {})[method.lower()] = operation
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "ChatGPT web backend API (as observed)",
            "version": snapshot,
            "description": "Unofficial. OpenAI publishes no specification. Operations come from the call sites in the chatgpt.com page build; x-evidence says what else confirms each one (live request, archived bodies, this repository's code). Types are filled in only where confirmed; an empty schema means unknown. A query or body key is listed when a call site names it; x-query-dynamic and additionalProperties mark call sites that also pass keys the parser cannot read. Re-verify before relying on a field. Prose, rate limits and caveats: docs/chatgpt-backend-api.md.",
        },
        "servers": [{"url": ORIGIN + "/backend-api"}],
        "security": [{"bearer": []}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearer": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "accessToken from GET /api/auth/session (cookies only), sent from a page on the chatgpt.com origin with credentials included.",
                }
            },
            "schemas": SCHEMAS,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--check", action="store_true", help="Compare with the committed file instead of writing.")
    args = parser.parse_args()
    committed = json.loads(args.out.read_text()) if args.out.exists() else None
    snapshot = committed["info"]["version"] if args.check and committed else datetime.date.today().isoformat()
    document = build(merge_calls(mine(args.cache)), live_overlay(), snapshot)
    operations = sum(len(item) for item in document["paths"].values())
    if args.check:
        if document != committed:
            sys.exit(f"{args.out} is out of date: regenerate with chatgpt-openapi.py --cache {args.cache}")
        print(f"{args.out} is current ({operations} operations)")
        return
    args.out.write_text(json.dumps(document, indent=1) + "\n")
    print(f"{len(document['paths'])} paths, {operations} operations -> {args.out}")


if __name__ == "__main__":
    main()
