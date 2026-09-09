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
        # The recorder writes turn_start when ChatGPT begins generating. Three things end that
        # turn: turn_end when it finishes, and chat_error or a wedged/closed tab when it does
        # not. Only the first is a clean ending, and a turn that died the other two ways still
        # has turn_start as its newest turn event — so reading those alone reports a dead chat
        # as busy forever, which is exactly the row nobody should be waiting on.
        state = "idle"
        for line in reversed((meta_file.parent / "events.jsonl").read_text().splitlines()):
            kind = json.loads(line).get("kind") if line.strip() else None
            if kind == "chat_error":
                state = "wedged"
                break
            if kind in ("turn_start", "turn_end"):
                state = "busy" if kind == "turn_start" else "idle"
                break
        # A turn nothing has added to for a while is not generating, whatever the last event
        # says. ChatGPT streams continuously, so a genuinely live turn is never this quiet.
        if state == "busy" and time.time() - meta["updatedAt"] / 1000 > 300:
            state = "stalled"
        rows.append((meta["updatedAt"], chat, state, meta["title"]))

    for updated, chat, state, title in sorted(rows, reverse=True):
        clock = time.strftime("%m-%d %H:%M", time.localtime(updated / 1000))
        print(f"{clock}\t{chat}\t{state}\t{title}")

# Send a message to an open chat, by conversation id (see `just chats`)
say $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text"

# Start a new chat with this opening message
new $text:
    @just -f {{justfile()}} _send "" "$text"

# POST one message to the running app's bridge. Empty chat means a fresh one.
_send $chat $text:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    # Built by jq, never by string interpolation: a message is arbitrary prose and will
    # contain the quotes, newlines and backslashes that hand-built JSON gets wrong.
    body=$(jq -nc --arg c "$chat" --arg t "$text" \
        'if $c == "" then { text: $t } else { conversationId: $c, text: $t } end')
    for port in 8765 8766 8767 8768 8769; do
        # /hello is unauthenticated and names the app, so it is how a local caller finds
        # which of the five candidate ports this app actually bound.
        if curl -fsS -m 1 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            id=$(curl -fsS -m 10 "http://127.0.0.1:$port/send" \
                -H "authorization: Bearer $token" \
                -H 'content-type: application/json' \
                --data-binary "$body" | jq -r '.command.id')

            # Accepting the message only queues it. The browser still has to open the chat,
            # find a composer it may type into, and send — and it fails outright if that chat
            # is mid-turn. Reporting "sent" at the queue is how a caller ends up believing a
            # message landed when nothing was typed, so wait for the real outcome instead.
            state="{{state_dir}}/bridge-commands.json"
            for _ in $(seq 1 120); do
                jq -e --arg id "$id" 'any(.commands[]?; .id == $id)' "$state" >/dev/null 2>&1 || break
                sleep 1
            done
            landed=$(jq -r --arg id "$id" '(.receipts[]? | select(.id == $id) | .conversationId) // empty' "$state" 2>/dev/null)
            if [[ -n "$landed" ]]; then
                echo "typed into $landed"
                exit 0
            fi
            echo "queued but never typed: the browser did not send it (chat mid-turn, or no tab)" >&2
            exit 1
        fi
    done
    echo "Chat On Steroids is not answering on 8765-8769; is the app running?" >&2
    exit 1

# ---------------------------------------------------------------------------
# Running your own build.
#
# `npm run dist:*` writes an artifact into release/ and stops there, which leaves the
# last step — putting that artifact where the launcher points and restarting — as
# something a person does by hand and forgets. `just install` is that step.
#
# It follows the launcher on PATH to find what to replace, so it upgrades whatever
# installation this machine actually has rather than a path written down in here.

# Build this tree, install it over the installed app, and restart it
[linux]
install:
    #!/usr/bin/env bash
    set -euo pipefail

    launcher=$(command -v chat-on-steroids || true)
    if [[ -z "$launcher" ]]; then
        echo "No chat-on-steroids on PATH: install a release once, then this recipe upgrades it." >&2
        exit 1
    fi
    # The launcher is normally a symlink into the install directory. Replace what it
    # resolves to, so the launcher, the .desktop entry and the tray icon all keep working.
    target=$(readlink -f "$launcher")

    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
    esac
    npm run "dist:linux:$arch"
    built="release/Chat-On-Steroids-Linux-$arch.AppImage"

    # An AppImage runs from a mount of its own file, so it is stopped before the file
    # underneath it changes. SIGTERM is the app's ordinary shutdown; it drains in-flight
    # MCP work and writes its durable state.
    #
    # Matched on the process name rather than on any path: the running app's argv holds the
    # /tmp mount it unpacked itself into, never the file being replaced here. Linux truncates
    # a process name to 15 characters, which is where the missing final `s` comes from.
    app=chat-on-steroid
    if pkill -TERM -x "$app" 2>/dev/null; then
        for _ in $(seq 1 40); do
            pgrep -x "$app" >/dev/null || break
            sleep 0.25
        done
        pgrep -x "$app" >/dev/null && { echo "The app is still running after SIGTERM; quit it and retry." >&2; exit 1; }
        was_running=yes
    else
        was_running=no
    fi

    # Written beside the target and renamed, so a failed copy cannot leave a half-written
    # AppImage where the launcher points.
    install -m 755 "$built" "$target.incoming"
    mv "$target.incoming" "$target"
    echo "installed $(basename "$target")"

    if [[ "$was_running" == yes ]]; then
        setsid "$launcher" >/dev/null 2>&1 < /dev/null &
        # The bridge answering is the proof it came back on the new build.
        for _ in $(seq 1 60); do
            for port in 8765 8766 8767 8768 8769; do
                if curl -fsS -m 1 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
                    echo "restarted, bridge listening on $port"
                    exit 0
                fi
            done
            sleep 0.5
        done
        echo "installed, but the bridge did not come back within 30s; start the app yourself." >&2
        exit 1
    fi
