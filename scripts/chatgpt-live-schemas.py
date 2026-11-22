#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Record the response shape (JSON types only, never values) of read-only ChatGPT backend calls into
docs/chatgpt-backend-api-live-schemas.json, which chatgpt-openapi.py merges into the OpenAPI file.

Requests run inside a signed-in chatgpt.com tab over Chromium DevTools (port 9222), as in
chat-list.py. Only GETs without side effects, plus the read-only batch call, are probed.
Strings keep a `format` hint (date-time, uuid) and nothing else; maps keyed by uuid become
`additionalProperties`. No value or id is stored, so the output holds no account data.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "docs" / "chatgpt-backend-api-live-schemas.json"
FETCH = """(async () => {
  const session = await (await fetch("/api/auth/session", {credentials: "include"})).json();
  const headers = {Authorization: "Bearer " + session.accessToken, "Content-Type": "application/json"};
  const results = {};
  for (const [method, path, body] of %s) {
    const response = await fetch("/backend-api" + path, {
      method, headers, credentials: "include", body: body ? JSON.stringify(body) : undefined});
    results[method + " " + path.split("?")[0]] = {status: response.status, body: await response.json().catch(() => null)};
  }
  return JSON.stringify(results);
})()"""
READ_ONLY = [
    ["GET", "/me", None],
    ["GET", "/models", None],
    ["GET", "/settings/user", None],
    ["GET", "/accounts/check/v4-2023-04-27", None],
    ["GET", "/wham/usage", None],
    ["GET", "/celsius/ws/user", None],
    ["GET", "/conversations?limit=3&offset=0&order=updated&is_archived=false", None],
]
DATE_TIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def schema_of(value):
    """JSON Schema of one value; array items are the merge of every element's schema."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        if DATE_TIME.match(value):
            return {"type": "string", "format": "date-time"}
        return {"type": "string", "format": "uuid"} if UUID.match(value) else {"type": "string"}
    if isinstance(value, list):
        return {"type": "array", "items": merge([schema_of(item) for item in value])}
    named = {k: v for k, v in value.items() if not UUID.match(k)}
    by_id = [v for k, v in value.items() if UUID.match(k)]
    result = {"type": "object", "properties": {k: schema_of(v) for k, v in sorted(named.items())}}
    if by_id:
        # Keys that are ids (accounts) are values, so keep only the shared value type.
        result["additionalProperties"] = merge([schema_of(v) for v in by_id])
    return result


def merge(schemas):
    """One schema accepting every input schema (union of object keys, oneOf for differing types)."""
    if not schemas:
        return {}
    kinds = {json.dumps(s, sort_keys=True) for s in schemas}
    if len(kinds) == 1:
        return schemas[0]
    objects = [s for s in schemas if s.get("type") == "object"]
    others = [s for s in schemas if s.get("type") != "object"]
    merged_others = {json.dumps(s, sort_keys=True): s for s in others}
    if objects:
        keys = sorted({k for s in objects for k in s["properties"]})
        properties = {k: merge([s["properties"][k] for s in objects if k in s["properties"]]) for k in keys}
        merged_others["object"] = {"type": "object", "properties": properties}
    options = list(merged_others.values())
    return options[0] if len(options) == 1 else {"oneOf": options}


def main():
    spec = importlib.util.spec_from_file_location("chat_list", HERE / "chat-list.py")
    chat_list = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(chat_list)
    tab = chat_list.live_tab(chat_list.DEVTOOLS)
    if tab is None:
        sys.exit("no signed-in chatgpt.com tab on port 9222")
    first = json.loads(chat_list.evaluate(tab, FETCH % json.dumps(READ_ONLY)))
    chat = first["GET /conversations"]["body"]["items"][0]["id"]
    second = json.loads(
        chat_list.evaluate(
            tab,
            FETCH
            % json.dumps(
                [
                    ["POST", "/conversations/batch", {"conversation_ids": [chat], "include_full_history": False}],
                    ["GET", f"/conversation/{chat}/stream_status", None],
                ]
            ),
        )
    )
    operations = {}
    for key, result in {**first, **second}.items():
        method, path = key.split(" ", 1)
        path = path.replace(chat, "{conversation_id}")
        operations[f"{method} {path}"] = {"status": result["status"], "schema": schema_of(result["body"])}
    OUT.write_text(json.dumps({"operations": operations}, indent=1, sort_keys=True) + "\n")
    print(f"{len(operations)} operations -> {OUT}")


if __name__ == "__main__":
    main()
