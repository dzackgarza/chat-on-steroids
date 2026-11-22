"""chatgpt-openapi.py: call sites in page JavaScript become OpenAPI operations."""

import importlib.util
from pathlib import Path

from openapi_spec_validator import validate

SCRIPTS = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("chatgpt_openapi", SCRIPTS / "chatgpt-openapi.py")
openapi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(openapi)

# Call-site shapes as the page build writes them (minified).
PAGE = b"""
const a=async e=>(await Request.safeGet("/conversations",{parameters:{query:{offset:e.offset,limit:e.limit,order:"updated"}}})).data;
const b=e=>Request.safePost("/conversation/{conversation_id}/feedback",{parameters:{path:{conversation_id:e.id}},requestBody:{rating:e.rating,...e.extra}});
const c=e=>Request.safeGet(`/conversation/${e}/stream_status`);
const d=e=>client.get("/me");
const f=e=>map.get("not-an-api-path");
"""


def operations():
    return openapi.merge_calls(openapi.calls_in(PAGE))


def test_a_call_site_yields_its_method_path_and_the_keys_it_writes():
    found = operations()
    assert found[("GET", "/conversations")]["query"] == {"offset", "limit", "order"}
    assert found[("POST", "/conversation/{conversation_id}/feedback")]["body"] == {"rating", "...spread"}
    assert ("GET", "/me") in found


def test_non_api_calls_and_computed_paths_are_not_operations():
    assert set(operations()) == {
        ("GET", "/conversations"),
        ("POST", "/conversation/{conversation_id}/feedback"),
        ("GET", "/me"),
    }


def test_the_built_document_is_valid_openapi_and_keeps_confirmed_types():
    live = {("GET", "/me"): {"status": 200, "schema": {"type": "object", "properties": {"id": {"type": "string"}}}}}
    document = openapi.build(operations(), live, "2026-01-01")
    validate(document)
    batch = document["paths"]["/conversations/batch"]["post"]
    assert batch["requestBody"]["content"]["application/json"]["schema"]["properties"]["conversation_ids"]["maxItems"] == 10
    me = document["paths"]["/me"]["get"]
    assert me["x-evidence"] == ["live", "bundle"]
    assert me["responses"]["200"]["content"]["application/json"]["schema"]["properties"] == {"id": {"type": "string"}}
    feedback = document["paths"]["/conversation/{conversation_id}/feedback"]["post"]
    assert feedback["requestBody"]["content"]["application/json"]["schema"]["additionalProperties"] is True
