# Chat On Steroids — repo task surface.
#
# Build, packaging and the QC gate stay on the npm scripts in package.json;
# AGENTS.md §19 documents that workflow.
#
# The recipes below read the app's durable recordings. They live outside the repo,
# in the Electron userData directory, and are written by src/main/session/store.ts:
# tool activity appends to events.jsonl, each user/assistant message is one shard
# under messages/ rewritten in place while it streams, and oversized text spills to
# assets/. A transcript is those producers merged and ordered by `origin ?? seq`.
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
    import json, os, pathlib, sys, time

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
    def position(row):
        # A message shard is rewritten in place as it streams, and a reloaded page reports
        # old messages again, so `seq` is append order, not conversation order. `origin`
        # holds the first position of a rewritten item; src/shared/chronology.ts orders by
        # the same key. ponytail: tool rows still sit where seq put them, which draws a slow
        # call after the turn it ran under; port chronology.ts grouping if that starts to bite.
        origin = row.get("origin")
        return (origin if isinstance(origin, int) else row.get("seq", 0), row.get("seq", 0))

    rows.sort(key=position)

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
                clock = time.strftime("%H:%M:%S", time.localtime(row["time"] / 1000))
                print(f"\n## {kind.removesuffix('_message')}  {clock}\n{text(row['message'])}")
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

# ---------------------------------------------------------------------------
# Driving chats from here.
#
# The app's bridge has one route for local callers: POST /send types a message into a
# ChatGPT chat, or opens a fresh one. It is the same transport the app uses to open a
# worker chat, with the agent half removed — what these recipes open is an ordinary chat
# that shows up in `just sessions` like any other. Chat On Steroids must be running, and
# the browser must be paired; the app opens the tab itself.
#
# The credential is minted at bridge startup and lives in state/local-token, mode 0600.

state_dir := if os() == "macos" {
    home_directory() / "Library/Application Support/chat-on-steroids/state"
} else {
    env_var_or_default("XDG_CONFIG_HOME", home_directory() / ".config") / "chat-on-steroids/state"
}

# Which chats are recorded, whether each is mid-turn, and the id `say` wants
chats:
    #!/usr/bin/env python3
    import json, pathlib, time

    root = pathlib.Path("{{sessions_dir}}")
    rows = []
    for meta_file in root.glob("*/meta.json"):
        meta = json.loads(meta_file.read_text())
        chat = meta.get("conversationId")
        if not chat:
            continue  # nothing to address a message to
        # The recorder writes turn_start when ChatGPT begins generating and turn_end when it
        # stops, so the newest of the two is what "is this chat busy right now" means here.
        # A tab closed mid-turn never records its turn_end, so an old "busy" row is a chat
        # nobody is watching rather than one still generating. Read the clock column too.
        state = "idle"
        for line in reversed((meta_file.parent / "events.jsonl").read_text().splitlines()):
            kind = json.loads(line).get("kind") if line.strip() else None
            if kind in ("turn_start", "turn_end"):
                state = "busy" if kind == "turn_start" else "idle"
                break
        rows.append((meta["updatedAt"], chat, state, meta["title"]))

    for updated, chat, state, title in sorted(rows, reverse=True):
        clock = time.strftime("%m-%d %H:%M", time.localtime(updated / 1000))
        print(f"{clock}\t{chat}\t{state}\t{title}")

# Send a message to an open chat, by conversation id (see `just chats`)
say chat text:
    @just -f {{justfile()}} _post '{"conversationId": {{ quote(chat) }}, "text": {{ quote(text) }}}'

# Start a new chat with this opening message
new text:
    @just -f {{justfile()}} _post '{"text": {{ quote(text) }}}'

# POST one body to the running app's bridge
_post body:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    for port in 8765 8766 8767 8768 8769; do
        # /hello is unauthenticated and names the app, so it is how a local caller finds
        # which of the five candidate ports this app actually bound.
        if curl -fsS -m 1 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            curl -fsS -m 10 "http://127.0.0.1:$port/send" \
                -H "authorization: Bearer $token" \
                -H 'content-type: application/json' \
                -d {{ quote(body) }} | jq -r '.command | "opened \(.conversationId // "a fresh chat") as command \(.id)"'
            exit 0
        fi
    done
    echo "Chat On Steroids is not answering on 8765-8769; is the app running?" >&2
    exit 1
