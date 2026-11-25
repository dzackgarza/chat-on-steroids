#!/usr/bin/env python3
"""Change ChatGPT chats and projects: delete, archive, pin, rename, move between projects,
create and delete projects, list projects.

Every change is the request the chatgpt.com page itself sends for the same menu action,
sent from inside a signed-in tab (Chromium with --remote-debugging-port=9222), because only
the page holds the credentials. The requests, and how they were observed, are in
docs/chatgpt-backend-api.md, "Chat and project management".

Deleting a project also deletes every chat in it, so `project-delete` refuses a project that
still holds chats unless `--with-chats` is given.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import sys

SPEC = importlib.util.spec_from_file_location("chat_list", Path(__file__).resolve().parent / "chat-list.py")
chat_list = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(chat_list)


def call(websocket, method, path, body=None):
    """(HTTP status, parsed JSON or text) for one backend request sent by the page."""
    init = {"method": method, "credentials": "include", "headers": {}}
    if body is not None:
        init["headers"]["Content-Type"] = "application/json"
        init["body"] = json.dumps(body)
    expression = (
        "(async () => {"
        ' const s = await (await fetch("/api/auth/session", {credentials: "include"})).json();'
        f" const init = {json.dumps(init)};"
        ' init.headers.Authorization = "Bearer " + s.accessToken;'
        f" const r = await fetch({json.dumps(path)}, init);"
        " return {status: r.status, text: await r.text()};"
        "})()"
    )
    answer = chat_list.evaluate(websocket, expression)
    if answer is None:
        raise SystemExit("the ChatGPT tab did not answer; open another ChatGPT tab and retry")
    try:
        return answer["status"], json.loads(answer["text"]) if answer["text"] else None
    except json.JSONDecodeError:
        return answer["status"], answer["text"]


def require_ok(status, reply, action):
    if not 200 <= status < 300:
        raise SystemExit(f"ChatGPT refused {action}: HTTP {status} {reply}")


def projects(websocket):
    """{project id: name} for the projects this account owns."""
    found, cursor = {}, None
    while True:
        path = "/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0"
        if cursor is not None:
            path += "&cursor=" + cursor
        status, reply = call(websocket, "GET", path)
        require_ok(status, reply, "listing projects")
        for item in reply["items"]:
            gizmo = item["gizmo"]["gizmo"]
            found[gizmo["id"]] = gizmo["display"]["name"]
        cursor = reply.get("cursor")
        if cursor is None:
            return found


def project_id(websocket, project):
    """A project id from an id (g-p-…) or an exact project name."""
    if project.startswith("g-p-"):
        return project
    matches = [pid for pid, name in projects(websocket).items() if name == project]
    if len(matches) != 1:
        raise SystemExit(f"{len(matches)} projects are named {project!r}; pass the project id")
    return matches[0]


def project_chats(websocket, project):
    chats, cursor = [], "0"
    while cursor is not None:
        status, reply = call(websocket, "GET", f"/backend-api/gizmos/{project}/conversations?cursor={cursor}")
        require_ok(status, reply, f"listing the chats of {project}")
        chats += [item["id"] for item in reply["items"]]
        cursor = reply.get("cursor")
    return chats


def patch(websocket, chat, body, action):
    status, reply = call(websocket, "PATCH", f"/backend-api/conversation/{chat}", body)
    require_ok(status, reply, f"{action} {chat}")
    print(f"{action} {chat}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--devtools", default=chat_list.DEVTOOLS)
    sub = parser.add_subparsers(dest="command", required=True)
    delete = sub.add_parser("delete", help="delete chats permanently")
    delete.add_argument("chats", nargs="+")
    for name in ("archive", "unarchive", "pin", "unpin", "remove-from-project"):
        sub.add_parser(name).add_argument("chats", nargs="+")
    rename = sub.add_parser("rename")
    rename.add_argument("chat")
    rename.add_argument("title")
    move = sub.add_parser("move", help="move chats into a project (id or exact name)")
    move.add_argument("project")
    move.add_argument("chats", nargs="+")
    sub.add_parser("projects", help="list projects: id and name")
    new = sub.add_parser("project-new", help="create a project and print its id")
    new.add_argument("name")
    new.add_argument("--instructions", default="")
    gone = sub.add_parser("project-delete", help="delete a project and every chat in it")
    gone.add_argument("project")
    gone.add_argument("--with-chats", action="store_true", help="also delete the chats it holds")
    args = parser.parse_args()

    websocket = chat_list.live_tab(args.devtools)
    if websocket is None:
        raise SystemExit("no ChatGPT tab that can still run a request; open one and retry")

    if args.command == "delete":
        for chat in args.chats:
            status, reply = call(
                websocket, "DELETE",
                f"/backend-api/conversation/id/{chat}?delete_generated_artifacts=true&delete_uploaded_artifacts=true",
            )
            require_ok(status, reply, f"deleting {chat}")
            print(f"deleted {chat}")
    elif args.command in ("archive", "unarchive"):
        for chat in args.chats:
            patch(websocket, chat, {"is_archived": args.command == "archive"}, args.command + "d")
    elif args.command in ("pin", "unpin"):
        for chat in args.chats:
            patch(websocket, chat, {"is_starred": args.command == "pin"}, args.command + "ned")
    elif args.command == "remove-from-project":
        for chat in args.chats:
            patch(websocket, chat, {"gizmo_id": ""}, "removed from its project:")
    elif args.command == "rename":
        status, reply = call(websocket, "POST", f"/backend-api/conversation/id/{args.chat}/rename", {"title": args.title})
        require_ok(status, reply, f"renaming {args.chat}")
        print(f"renamed {args.chat} to {args.title!r}")
    elif args.command == "move":
        target = project_id(websocket, args.project)
        for chat in args.chats:
            patch(websocket, chat, {"gizmo_id": target}, f"moved to {target}:")
    elif args.command == "projects":
        for pid, name in sorted(projects(websocket).items(), key=lambda item: item[1].lower()):
            print(f"{pid}  {name}")
    elif args.command == "project-new":
        status, reply = call(websocket, "POST", "/backend-api/projects", {
            "name": args.name, "instructions": args.instructions,
            "emoji": None, "theme": None, "memory_scope": "unset",
        })
        require_ok(status, reply, f"creating project {args.name!r}")
        if reply.get("error") is not None:
            raise SystemExit(f"ChatGPT refused creating project {args.name!r}: {reply['error']}")
        print(reply["resource"]["gizmo"]["id"])
    elif args.command == "project-delete":
        target = project_id(websocket, args.project)
        held = project_chats(websocket, target)
        if held and not args.with_chats:
            raise SystemExit(
                f"{target} holds {len(held)} chats, and deleting it deletes them; move them out, "
                "or pass --with-chats"
            )
        status, reply = call(websocket, "DELETE", f"/backend-api/gizmos/{target}")
        require_ok(status, reply, f"deleting project {target}")
        print(f"deleted project {target} and its {len(held)} chats")


if __name__ == "__main__":
    sys.exit(main())
