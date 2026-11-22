#!/usr/bin/env python3
"""Generate docs/chatgpt-backend-api.openapi.json, an OpenAPI 3.1 description of the ChatGPT web
backend API, from the chatgpt.com page build.

Mining: every `.safeGet/.safePost/...("/path", {parameters: {query: {...}}, requestBody: {...}})`
call site in the page's JavaScript (entry chunks listed in the page HTML plus every lazy chunk
named in the webpack runtime) becomes one operation, with the query keys and body keys the call
site writes. Static CDN files only; no account request is made.

Observed overlay: OBSERVED below holds types, enums and response schemas confirmed by live
requests or by archived conversation bodies; those operations carry x-evidence naming the source.
Everything else is `x-evidence: ["bundle"]`: the client calls it, nothing more is known.

Usage: chatgpt-openapi.py --cache DIR [--out FILE]
`--cache` holds the page HTML and entry chunks. The 8,900 lazy chunks (hundreds of MB) are
streamed and not kept, so a rerun downloads them again.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ORIGIN = "https://chatgpt.com"
ASSET = re.compile(r"[A-Za-z0-9_.~-]+\.[0-9a-f]{10}\.js")
CALL = re.compile(
    r'\.(?:safe)?(Get|Post|Put|Patch|Delete|get|post|put|patch|delete)\(\s*(["`])(/[A-Za-z_][^"`]{1,200}?)\2',
    re.S,
)
CHUNK_PAIR = re.compile(r'(\d+):"([0-9a-f]{10,})"')
CALL_WINDOW = 900


def fetch(url, cache, keep=True):
    target = cache / re.sub(r"[^A-Za-z0-9_.-]", "_", url.removeprefix(ORIGIN))
    if target.exists():
        return target.read_text(errors="replace")
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8", "replace")
            if keep:
                target.write_text(text)
            return text
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return ""
        except OSError:
            continue
    return ""


def lazy_chunk_urls(entry_texts):
    """The webpack runtime maps lazy chunk ids to hashes: n.u=a=>"assets/async/"+a+"."+({id:"hash",...})[a]+".js"."""
    for text in entry_texts:
        marker = text.find('n.miniCssF')
        start = text.rfind("n.u=", 0, marker) if marker >= 0 else -1
        if start < 0:
            continue
        return [
            f"{ORIGIN}/cdn/assets/async/{chunk}.{digest}.js"
            for chunk, digest in CHUNK_PAIR.findall(text[start:marker])
        ]
    sys.exit("no webpack runtime chunk map found in the entry chunks")


def call_arguments(window):
    """The call's own argument text, cut at its closing parenthesis."""
    depth, quote = 0, None
    for index, char in enumerate(window):
        if quote:
            if char == quote and window[index - 1] != "\\":
                quote = None
        elif char in "\"'`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return window[:index]
    return window


def object_keys(text, key):
    """Top-level keys of the object literal after `key:{`, or None."""
    start = text.find(key + ":{")
    if start < 0:
        return None
    depth, keys, current = 1, [], ""
    for char in text[start + len(key) + 2 :]:
        if char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
            if depth == 0:
                break
        if depth == 1 and char == ",":
            keys.append(current)
            current = ""
        else:
            current += char
    keys.append(current)
    names = []
    for item in keys:
        if item.strip().startswith("..."):
            names.append("...spread")
            continue
        match = re.match(r"\s*([A-Za-z_$][\w$]*|\"[^\"]+\")\s*(?::|$)", item)
        if match:
            names.append(match.group(1).strip('"'))
    return names


def mine(cache):
    cache.mkdir(parents=True, exist_ok=True)
    home = fetch(ORIGIN + "/", cache)
    entries = sorted(set(ASSET.findall(home)))
    entry_texts = [fetch(f"{ORIGIN}/cdn/assets/{name}", cache) for name in entries]
    # Entry chunks name more chunks; one more round reaches the runtime chunk.
    for text in list(entry_texts):
        for name in sorted(set(ASSET.findall(text)) - set(entries)):
            entries.append(name)
            entry_texts.append(fetch(f"{ORIGIN}/cdn/assets/{name}", cache))
    urls = lazy_chunk_urls(entry_texts)
    with ThreadPoolExecutor(6) as pool:
        lazy_texts = list(pool.map(lambda url: fetch(url, cache, keep=False), urls))
    found = {}
    for text in entry_texts + lazy_texts:
        for match in CALL.finditer(text):
            method, path = match.group(1).upper(), match.group(3)
            arguments = call_arguments(text[match.start() : match.end() + CALL_WINDOW])
            entry = found.setdefault((method, path), {"query": set(), "body": set()})
            entry["query"] |= set(object_keys(arguments, "query") or [])
            entry["body"] |= set(object_keys(arguments, "requestBody") or [])
    return found


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
                "description": "COMPLETE when no turn runs (also for ids that do not exist); IS_STREAMING while a turn runs. Other values are not observed; clients treat only IS_STREAMING as running.",
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
    ("POST", "/conversation/init"): {
        "summary": "Defaults, send block (blocked_features) and limits_progress.",
        "evidence": ["live", "repo"],
    },
    ("GET", "/wham/usage"): {"summary": "Quota windows (rate_limit.primary_window, secondary_window, credits).", "evidence": ["live"]},
    ("GET", "/me"): {"summary": "User profile.", "evidence": ["live"]},
    ("GET", "/models"): {"summary": "Model catalogue (about 75 KB).", "evidence": ["live"]},
    ("GET", "/settings/user"): {"summary": "User settings.", "evidence": ["live"]},
}
OBSERVED_ONLY = {
    ("GET", "/accounts/check/v4-2023-04-27"): {"summary": "Account entitlements and features.", "evidence": ["live"]},
    ("GET", "/celsius/ws/user"): {"summary": "Returns {websocket_url} for the realtime socket.", "evidence": ["live"]},
}


def operation_id(method, path):
    words = re.sub(r"[{}]", "", path).strip("/").replace("-", "_").replace(".", "_").split("/")
    return method.lower() + "_" + "_".join(words)


def build(found):
    for key in OBSERVED_ONLY:
        found.setdefault(key, {"query": set(), "body": set()})
    paths, canonical = {}, {}
    for (method, path), mined in sorted(found.items(), key=lambda item: (item[0][1], item[0][0])):
        shape = re.sub(r"\{[^}]*\}", "{}", path)
        path = canonical.setdefault(shape, path)
        observed = {**OBSERVED, **OBSERVED_ONLY}.get((method, path), {})
        operation = {
            "operationId": operation_id(method, path),
            "tags": [path.strip("/").split("/")[0]],
            "x-evidence": observed.get("evidence", ["bundle"]),
            "responses": observed.get("responses", {"default": {"description": "Response schema not extracted."}}),
        }
        if observed.get("summary"):
            operation["summary"] = observed["summary"]
        parameters = [
            {"name": name, "in": "path", "required": True, "schema": {"type": "string"}}
            for name in re.findall(r"\{([^}]+)\}", path)
        ]
        query_types = observed.get("query", {})
        for name in sorted(set(query_types) | (mined["query"] - {"...spread"})):
            parameters.append({"name": name, "in": "query", "schema": query_types.get(name, {})})
        if "...spread" in mined["query"]:
            operation["x-query-spread"] = True
        if parameters:
            operation["parameters"] = parameters
        body_types = observed.get("body", {})
        body_keys = set(body_types) | (mined["body"] - {"...spread"})
        if body_keys:
            schema = {"type": "object", "properties": {k: body_types.get(k, {}) for k in sorted(body_keys)}}
            if observed.get("body_required"):
                schema["required"] = observed["body_required"]
            if "...spread" in mined["body"]:
                schema["additionalProperties"] = True
            operation["requestBody"] = {"content": {"application/json": {"schema": schema}}}
        paths.setdefault(path, {})[method.lower()] = operation
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "ChatGPT web backend API (as observed)",
            "version": "2026-11-22",
            "description": "Unofficial. OpenAI publishes no specification. Operations come from the call sites in the chatgpt.com page build; x-evidence says what else confirms each one (live request, archived bodies, this repository's code). Types are filled in only where confirmed; an empty schema means unknown, and an absent query or body key means the call site names none, not that the server rejects it. Re-verify before relying on a field. Prose, rate limits and caveats: docs/chatgpt-backend-api.md.",
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
    parser.add_argument("--out", type=Path, default=Path(__file__).parent.parent / "docs" / "chatgpt-backend-api.openapi.json")
    args = parser.parse_args()
    document = build(mine(args.cache))
    args.out.write_text(json.dumps(document, indent=1, sort_keys=False) + "\n")
    operations = sum(len(item) for item in document["paths"].values())
    print(f"{len(document['paths'])} paths, {operations} operations -> {args.out}")


if __name__ == "__main__":
    main()
