# Chat On Steroids — repo task surface.
#
# Build, packaging and the QC gate stay on the npm scripts in package.json;
# AGENTS.md §19 documents that workflow.
#
# The recipes below read the app's durable recordings. They live outside the repo,
# in the Electron userData directory, and are written by src/main/session/store.ts:
# tool activity appends to events.jsonl, each user/assistant message is one shard
# under messages/ rewritten in place while it streams, and oversized text spills to
# assets/. A transcript is those producers merged and ordered by `seq`.
#
# Tool rows print as headlines. For the exact arguments and result of one call, read
# its record straight out of the log:
#   jq 'select(.call.callId == "<id>")' <session>/events.jsonl

sessions_dir := if os() == "macos" {
    home_directory() / "Library/Application Support/chat-on-steroids/sessions"
} else {
    env_var_or_default("XDG_CONFIG_HOME", home_directory() / ".config") / "chat-on-steroids/sessions"
}

# Show available recipes
default:
    @just --list

# List recorded chats, newest first: updated, id, counts, title
sessions:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob
    for meta in "{{sessions_dir}}"/*/meta.json; do
        jq -r '[.updatedAt, (.updatedAt / 1000 | localtime | strftime("%m-%d %H:%M")),
                .id, "\(.userMessages)msg \(.toolCalls)tool", .title] | @tsv' "$meta"
    done | sort -rn | cut -f2-

# Print a chat transcript; ID may be any substring, default is the newest chat
transcript $id="":
    #!/usr/bin/env python3
    import json, os, pathlib, sys

    root = pathlib.Path("{{sessions_dir}}")
    want = os.environ["id"]

    found = []
    for entry in root.iterdir():
        if not entry.is_dir() or want not in entry.name:
            continue
        try:
            found.append((json.loads((entry / "meta.json").read_text()), entry))
        except OSError:
            continue
    if not found:
        sys.exit(f"No recording matches {want!r} under {root}")
    meta, session = max(found, key=lambda pair: pair[0]["updatedAt"])

    rows = []
    for line in (session / "events.jsonl").read_text().splitlines():
        if line.strip():
            rows.append(json.loads(line))
    rows += [json.loads(shard.read_text()) for shard in (session / "messages").glob("*.json")]
    # Pre-migration sessions keep their messages in one legacy map instead of shards.
    legacy = session / "messages.json"
    if legacy.exists():
        rows += list(json.loads(legacy.read_text() or "{}").values())
    rows.sort(key=lambda row: row.get("seq", 0))

    def text(stored):
        spill = stored.get("assetId")
        if spill and (session / "assets" / spill).exists():
            return (session / "assets" / spill).read_text()
        return stored.get("text", "")

    try:
        print(f"# {meta['title']}  [{meta['id']}]  chat {meta.get('conversationId')}")
        for row in rows:
            kind = row["kind"]
            if kind.endswith("_message"):
                print(f"\n## {kind.removesuffix('_message')}\n{text(row['message'])}")
            elif kind == "tool_call":
                call = row["call"]
                summary = call.get("summary") or {}
                parts = (summary.get("title"), summary.get("detail"), summary.get("metric"))
                headline = " · ".join(part for part in parts if part)
                print(f"\n[{call['tool']} {call['outcome']} {call['callId']}] {headline}")
    except BrokenPipeError:
        os._exit(0)  # a transcript is long and gets piped into head; leave quietly

# Find which recorded chats mention a term
search $term:
    #!/usr/bin/env bash
    set -euo pipefail
    grep -rlisF -e "$term" "{{sessions_dir}}" \
        | sed "s|^{{sessions_dir}}/||; s|/.*||" | sort -u \
        | while read -r id; do
            printf '%s\t%s\n' "$id" "$(jq -r .title "{{sessions_dir}}/$id/meta.json")"
        done
