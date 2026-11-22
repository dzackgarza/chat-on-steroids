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

# A readable, live workstream monitor: chronological meaningful actions above
# continuously refreshed workstream/turn/tool state and inactivity evidence.
# Repeated source inspections and auto-continuation turns are summarized, while
# edits, tests, failures and process completions retain their recorded times.
# Examples: just journal; just journal 3 50 sage-indefinite-port
#           just journal 3 50 sage-indefinite-port verbose
# Uses Python Rich for the live status panel (apt install python3-rich).
journal $hours="3" $lines="50" $chat="" $detail="":
    #!/usr/bin/env bash
    set -euo pipefail
    extra=()
    case "$detail" in
        "") ;;
        verbose) extra+=(--verbose) ;;
        trace) extra+=(--verbose --trace) ;;
        plain) extra+=(--plain) ;;
        *) echo 'Detail must be verbose, trace, plain, or empty' >&2; exit 2 ;;
    esac
    exec python3 -u "{{justfile_directory()}}/scripts/activity-journal.py" \
        --root "{{sessions_dir}}" --hours "$hours" --lines "$lines" --chat "$chat" "${extra[@]}"

# Full-screen searchable lnav alternative. Press G to move to the end and
# automatically follow new events; scrolling up pauses the displayed position.
# Install lnav first (sudo apt install lnav / brew install lnav).
journal-ui $hours="3" $lines="100" $chat="":
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v lnav >/dev/null 2>&1; then
        echo 'lnav is required (sudo apt install lnav / brew install lnav)' >&2
        exit 127
    fi
    python3 -u "{{justfile_directory()}}/scripts/activity-journal.py" \
        --root "{{sessions_dir}}" --hours "$hours" --lines "$lines" --chat "$chat" \
        | lnav -N -c ':goto 100%'

# Print a chat transcript; ID may be any substring, default is the newest chat
transcript $id="":
    #!/usr/bin/env python3
    import json, os, pathlib, sys, time

    root = pathlib.Path("{{sessions_dir}}")
    want = os.environ["id"]

    found = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        try:
            meta = json.loads((entry / "meta.json").read_text())
        except OSError:
            continue
        if want in entry.name or want in (meta.get("id") or "") or want in (meta.get("conversationId") or ""):
            found.append((meta, entry))
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

# The ACTIVE ChatGPT chats: generating now, or a message in the last `minutes` (default 10)
#
# Covers every chat on the account, whether or not it ever used the connector. Columns:
# `last msg` is the age of the newest message in the conversation itself. `state` is `busy`
# when the chat's open tab marks its turn in progress or this app's recorder says so;
# otherwise the recorder's idle/stalled/wedged, `idle` for an open tab with no running turn,
# and `-` for a chat with no open tab and no recording, whose running state this does not
# know (read `last msg` for those). `model` is the model that answered last, `msgs` and
# `tools` count messages, `~tok` sizes the chat, and the last column is the newest action
# this app recorded. The id is what `say` wants.
#
# The sidebar list's times are not trusted: they freeze while a long turn runs. So this reads
# the `candidates` newest chats by list time (default 100), plus every open tab and every
# recorder-busy chat, are checked with ChatGPT's cheap metadata and stream_status calls; only
# the ones that pass the `minutes` window are read in full. A chat outside those that is
# generating with no tab and no recording is missed; raise `candidates` to cover more.
# `minutes=0` lists every chat read, active or not. `match` filters on the title.
#
# `~tok` counts user, assistant and tool text at four characters per token. Hidden reasoning,
# system prompts and tool schemas are invisible from here, so it sizes a chat rather than
# reproducing ChatGPT's context counter.
#
# Needs Chromium started with --remote-debugging-port=9222 and signed in to ChatGPT.
chats minutes="10" match="" candidates="100" archived="false" json="false":
    #!/usr/bin/env bash
    set -euo pipefail
    extra=()
    case "{{json}}" in
        true) extra+=(--json) ;;
        false) ;;
        *) echo 'json must be true or false' >&2; exit 2 ;;
    esac
    case "{{archived}}" in
        true) extra+=(--archived) ;;
        false) ;;
        *) echo 'archived must be true or false' >&2; exit 2 ;;
    esac
    exec python3 "{{justfile_directory()}}/scripts/chat-list.py" --sessions "{{sessions_dir}}" \
        --minutes "{{minutes}}" --match "{{match}}" --candidates "{{candidates}}" "${extra[@]}"

# ---------------------------------------------------------------------------
# The browser's actual tabs.
#
# `chats` reports what this app recorded; it cannot see a tab. Chromium's DevTools endpoint
# can, and it is the only thing that knows a conversation is open twice. Every tab the app
# opens carries a `clf` marker and nothing closes it when the command ends, so tabs pile up:
# duplicates of live chats, and chats whose work finished hours ago.
#
# Needs Chromium started with --remote-debugging-port=9222.

devtools := "http://127.0.0.1:9222"

# Archive one conversation in ChatGPT, whether or not it has a tab open
archive chat:
    @just _set-archived {{chat}} true archived

# Archiving is how a chat leaves management, and a chat archived on a wrong call is still a
# live worker: it keeps executing, it just stops being reachable.
#
# Bring an archived conversation back into the managed set, so it can be pushed again
unarchive chat:
    @just _set-archived {{chat}} false unarchived

[private]
_set-archived chat flag verb:
    #!/usr/bin/env python3
    import json, subprocess

    targets = json.loads(subprocess.run(
        ["curl", "-s", "-m", "5", "{{devtools}}/json"], capture_output=True, text=True).stdout or "[]")
    # Any ChatGPT tab will do — it is only the execution context that holds the credentials, and
    # the conversation is named explicitly rather than taken from what is on screen. But it has
    # to be a tab that can still run JavaScript: a wedged page accepts the connection and then
    # answers nothing, which is indistinguishable from a refusal until you probe it.
    ws = None
    for target in targets:
        if target.get("type") != "page" or "chatgpt.com" not in (target.get("url") or ""):
            continue
        probe = subprocess.run(
            ["timeout", "10", "websocat", "-n1", "-B", "16777216", target["webSocketDebuggerUrl"]],
            input=json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": "1+1", "returnByValue": True}}),
            capture_output=True, text=True).stdout
        if '"value":2' in probe:
            ws = target["webSocketDebuggerUrl"]
            break
    if not ws:
        raise SystemExit("no ChatGPT tab that can still run a request — open one and retry")

    expr = (
        "(async () => {"
        ' const s = await (await fetch("/api/auth/session", {credentials:"include"})).json();'
        ' const r = await fetch("/backend-api/conversation/' + "{{chat}}" + '", {'
        '   method: "PATCH",'
        '   headers: {"Content-Type":"application/json", "Authorization":"Bearer " + s.accessToken},'
        '   credentials: "include",'
        '   body: JSON.stringify({is_archived: {{flag}}})'
        " });"
        " return r.status;"
        "})()"
    )
    payload = json.dumps({"id": 1, "method": "Runtime.evaluate",
                          "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}})
    raw = subprocess.run(["timeout", "15", "websocat", "-n1", "-B", "16777216", ws],
                         input=payload, capture_output=True, text=True).stdout
    # A page that cannot answer returns nothing at all, and crashing on that reads as a broken
    # tool rather than as the page being wedged.
    try:
        status = json.loads(raw)["result"]["result"].get("value")
    except Exception:
        status = None
    if status == 200:
        print("{{verb}} {{chat}}")
    elif status is None:
        raise SystemExit("the tab this ran through did not answer — try again, or open another ChatGPT tab")
    else:
        raise SystemExit(f"ChatGPT refused the change with status {status}")

# Every open ChatGPT tab, what its chat last did, and whether the tab is worth keeping
tabs quiet="30":
    #!/usr/bin/env python3
    import json, subprocess, pathlib, sys, time, glob

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

    def dt(path):
        out = subprocess.run(["curl", "-s", "-m", "5", "{{devtools}}" + path],
                             capture_output=True, text=True).stdout
        return json.loads(out) if out.strip().startswith(("[", "{")) else None

    targets = dt("/json")
    if targets is None:
        raise SystemExit("DevTools is not answering on {{devtools}} — start Chromium with --remote-debugging-port=9222")

    sessions = pathlib.Path("{{sessions_dir}}")
    last, titles = {}, {}
    for meta_file in sessions.glob("*/meta.json"):
        meta = json.loads(meta_file.read_text())
        chat = meta.get("conversationId")
        if not chat:
            continue
        titles[chat] = " ".join((meta.get("title") or "").split())[:38]
        rows = load_jsonl(meta_file.parent / "events.jsonl")
        rows += [json.loads(open(f).read()) for f in glob.glob(str(meta_file.parent / "messages/*.json"))]
        if rows:
            last[chat] = max(rows, key=lambda r: (r.get("time", 0), r.get("seq", 0))).get("time", 0) / 1000

    try:
        quiet = float("{{quiet}}") * 60
    except ValueError:
        raise SystemExit(
            'quiet must be a number of minutes, not "{{quiet}}" — '
            'the parameters are positional: `just tidy 30 "id1,id2"`'
        )
    now = time.time()
    seen = set()
    for target in targets:
        if target.get("type") != "page" or "chatgpt.com/c/" not in (target.get("url") or ""):
            continue
        chat = target["url"].split("/c/")[1].split("?")[0].split("#")[0]
        idle = now - last[chat] if chat in last else None
        # One conversation, two tabs: the second is a tab a later command opened rather than
        # reusing the one already showing that chat. Only the first is worth keeping.
        if chat in seen:
            verdict = "duplicate"
        elif idle is None:
            verdict = "unrecorded"
        elif idle > quiet:
            verdict = "stale"
        else:
            verdict = "live"
        seen.add(chat)
        age = f"{idle/60:5.0f}m" if idle is not None else "    ?"
        print(f"{verdict:<10} {age}  {chat}  {titles.get(chat, '')}")

# Archive the finished chats in ChatGPT and close their tabs, plus any duplicate tabs
#
# `keep` is a comma-separated list of conversation ids never to archive, whatever their idle
# time — a chat under active management is quiet between pushes, and quiet is not finished.
tidy quiet="30" keep="":
    #!/usr/bin/env python3
    import json, subprocess, pathlib, sys, time, glob

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

    def dt(path):
        out = subprocess.run(["curl", "-s", "-m", "5", "{{devtools}}" + path],
                             capture_output=True, text=True).stdout
        return json.loads(out) if out.strip().startswith(("[", "{")) else out

    targets = dt("/json")
    if not isinstance(targets, list):
        raise SystemExit("DevTools is not answering on {{devtools}}")

    sessions = pathlib.Path("{{sessions_dir}}")
    last = {}
    for meta_file in sessions.glob("*/meta.json"):
        meta = json.loads(meta_file.read_text())
        chat = meta.get("conversationId")
        if not chat:
            continue
        rows = load_jsonl(meta_file.parent / "events.jsonl")
        rows += [json.loads(open(f).read()) for f in glob.glob(str(meta_file.parent / "messages/*.json"))]
        if rows:
            last[chat] = max(rows, key=lambda r: (r.get("time", 0), r.get("seq", 0))).get("time", 0) / 1000

    # Archive calls run in a tab opened for the purpose, not in an existing one. Two reasons:
    # a page wedged enough to be worth archiving cannot run the request, and Chromium freezes
    # the renderer of a tab left in the background long enough, so an idle tab stops answering
    # CDP entirely — which is every tab, by the time a sweep is worth running.
    scratch = subprocess.run(
        ["curl", "-s", "-m", "10", "-X", "PUT", "{{devtools}}/json/new?https://chatgpt.com/"],
        capture_output=True, text=True).stdout
    healthy = scratch_id = None
    if scratch.strip().startswith("{"):
        opened = json.loads(scratch)
        scratch_id, healthy = opened.get("id"), opened.get("webSocketDebuggerUrl")
        time.sleep(6)  # the page has to reach a state where it can run a request at all
    keep = {c.strip() for c in "{{keep}}".split(",") if c.strip()}

    def archive(chat, ws):
        """Archive through the page's own session, which is the only thing holding the
        credentials. The conversation and the operation are both named explicitly, so this
        cannot land on delete the way driving the chat's menu could."""
        # Built by concatenation rather than an f-string: a literal doubled brace is how just
        # opens an interpolation, and this recipe is read by just before Python ever sees it.
        expr = (
            "(async () => {"
            ' const s = await (await fetch("/api/auth/session", {credentials:"include"})).json();'
            ' const r = await fetch("/backend-api/conversation/' + chat + '", {'
            '   method: "PATCH",'
            '   headers: {"Content-Type":"application/json", "Authorization":"Bearer " + s.accessToken},'
            '   credentials: "include",'
            '   body: JSON.stringify({is_archived: true})'
            " });"
            " return r.status;"
            "})()"
        )
        payload = json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}})
        got = subprocess.run(["timeout", "15", "websocat", "-n1", "-B", "16777216", ws],
                             input=payload, capture_output=True, text=True).stdout
        try:
            return json.loads(got)["result"]["result"]["value"]
        except Exception:
            return None

    try:
        quiet = float("{{quiet}}") * 60
    except ValueError:
        raise SystemExit(
            'quiet must be a number of minutes, not "{{quiet}}" — '
            'the parameters are positional: `just tidy 30 "id1,id2"`'
        )
    now = time.time()
    seen = set()
    for target in targets:
        if target.get("type") != "page" or "chatgpt.com/c/" not in (target.get("url") or ""):
            continue
        chat = target["url"].split("/c/")[1].split("?")[0].split("#")[0]
        idle = now - last[chat] if chat in last else None

        if chat in seen:
            # A second tab on a conversation that is still live: close the tab, keep the chat.
            dt("/json/close/" + target["id"])
            print(f"closed duplicate tab   {chat}")
            continue
        seen.add(chat)

        if idle is None or idle <= quiet or chat in keep:
            why = "under management" if chat in keep else ("unrecorded" if idle is None else f"{idle/60:.0f}m idle")
            print(f"kept                   {chat}  ({why})")
            continue

        if not healthy:
            print(f"no healthy tab to archive through — {chat} left open")
            continue
        status = archive(chat, healthy)
        if status == 200:
            dt("/json/close/" + target["id"])
            print(f"archived and closed    {chat}  ({idle/60:.0f}m idle)")
        else:
            print(f"COULD NOT ARCHIVE      {chat}  (status {status}) — tab left open")

    if scratch_id:
        dt("/json/close/" + scratch_id)

    # Every send opens a command tab on bare chatgpt.com, and a send that never redeems leaves
    # its tab behind. They carry no conversation id, so the loop above never sees them, and they
    # accumulate one renderer at a time until the host is swapping — which is what kills the
    # workers' own exec sessions.
    #
    # A managed chat's own tab is momentarily bare too, between opening and navigating to the
    # conversation, and closing one of those takes a live worker off the air. The two look
    # identical in a single snapshot, so look twice: a tab still bare several seconds later is
    # not on its way anywhere. Keep the newest survivor as the app's spare.
    def bare_ids():
        listing = json.loads(subprocess.run(
            ["curl", "-s", "-m", "5", "{{devtools}}/json"], capture_output=True, text=True).stdout or "[]")
        return {t["id"] for t in listing
                if t.get("type") == "page"
                and (t.get("url") or "").rstrip("/") == "https://chatgpt.com"
                and t.get("id") != scratch_id}

    first = bare_ids()
    if first:
        time.sleep(8)
        orphans = sorted(first & bare_ids())
        for tab in orphans[1:]:
            dt("/json/close/" + tab)
        if len(orphans) > 1:
            print(f"closed {len(orphans) - 1} orphaned command tab(s)")

# What a chat is: driven prime, swarm worker, or nothing the app is still using
#
# Paste the id from a tab's URL. Answers the only question a pile of open tabs raises —
# whether this one is still someone's live work, or a leftover the app has finished with.
who chat:
    #!/usr/bin/env python3
    import json, pathlib, sys, time, glob

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

    home = pathlib.Path.home()
    want = "{{chat}}"
    state = home / ".config/chat-on-steroids/state"
    sessions = pathlib.Path("{{sessions_dir}}")

    def info_of(entry):
        if isinstance(entry, list) and len(entry) == 2:
            entry = entry[1]
        return entry.get("info") if isinstance(entry, dict) else None

    # When it last actually did something, from its own recording.
    when, title = None, ""
    for meta_file in sessions.glob("*/meta.json"):
        meta = json.loads(meta_file.read_text())
        if meta.get("conversationId") != want:
            continue
        title = " ".join((meta.get("title") or "").split())[:60]
        rows = load_jsonl(meta_file.parent / "events.jsonl")
        rows += [json.loads(open(f).read()) for f in glob.glob(str(meta_file.parent / "messages/*.json"))]
        if rows:
            when = max(rows, key=lambda r: (r.get("time", 0), r.get("seq", 0))).get("time", 0) / 1000

    swarm = json.loads((state / "swarm.json").read_text()) if (state / "swarm.json").exists() else {}
    role = "not part of any run — an ordinary chat"
    if swarm.get("primeConversationId") == want:
        role = "prime of the app's CURRENT run"
    for entry in swarm.get("agents", []):
        got = info_of(entry)
        if got and got.get("conversationId") == want:
            role = f"{got['id']} ({got['state']}) in the CURRENT run — {got.get('label', '')}"
    for run in swarm.get("dormantRuns") or []:
        owner = run[0] if isinstance(run, list) else None
        body = run[1] if isinstance(run, list) and len(run) == 2 else run
        if owner == want:
            role = "prime of a DORMANT run — that run is finished"
        for entry in (body or {}).get("agents", []):
            got = info_of(entry)
            if got and got.get("conversationId") == want:
                role = f"{got['id']} ({got['state']}) of a DORMANT run — that run is finished"

    print(f"chat    {want}")
    print(f"title   {title or '(not recorded)'}")
    print(f"role    {role}")
    if when:
        print(f"active  {time.strftime('%m-%d %H:%M:%S', time.localtime(when))}  ({(time.time()-when)/60:.0f} min ago)")
    else:
        print("active  never recorded by this app")

# Send a message to an open chat, by conversation id (see `just chats`)
say $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" refuse false

# Start a new chat with this opening message
new $text:
    @just -f {{justfile()}} _send "" "$text" refuse false

# The composer refuses while a turn is in flight, so a turn that will never finish makes the
# chat unreachable by anything; this is the one thing that gets past it. It also destroys
# whatever that turn was producing, which is why it is its own verb and never something `say`
# decides to do — a chat that is merely working is a chat to leave alone. Read
# `just state <chat>` first: it says how long the turn has been open, and when the recording
# last actually changed.

# Stop the turn that chat is running, then send this message — for a turn that will not end
interrupt $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" stop_first false

# For a document alive enough to poll but stuck behind a turn its renderer will never resolve:
# the state where a person would press reload. The reload is offered once, before the message
# is typed, and only while nothing has claimed the send yet. A renderer frozen hard enough not
# to poll at all is not reachable this way; the extension recycles those tabs itself.

# Reload that chat's page, then send this message — for a tab that is stuck rather than busy
revive $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" refuse true

# What that chat's turn is doing right now, from the live recorder rather than from disk
state chat:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    for port in 8765 8766 8767 8768 8769; do
        # A stalled bridge is not an absent one; see the note in `_send`.
        if curl -fsS --connect-timeout 2 -m 45 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            curl -fsS --connect-timeout 5 -m 45 -G "http://127.0.0.1:$port/conversation/status" \
                --data-urlencode "conversationId={{chat}}" \
                -H "authorization: Bearer $token" | jq .
            exit 0
        fi
    done
    echo "Chat On Steroids is not answering on 8765-8769; is the app running?" >&2
    exit 1

# Read the controller's live workstream phases and schema gate before any managed dispatch.
workstreams:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    for port in 8765 8766 8767 8768 8769; do
        if curl -fsS --connect-timeout 2 -m 45 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            curl -fsS --connect-timeout 5 -m 45 "http://127.0.0.1:$port/workstreams" \
                -H "authorization: Bearer $token" | jq '{connectorSchema, active: [.workstreams[] | select(.phase != "paused" and .phase != "blocked") | {id, phase, conversationId, lastActivity}], pausedCount: ([.workstreams[] | select(.phase == "paused")] | length)}'
            exit 0
        fi
    done
    echo "Chat On Steroids is not answering on 8765-8769; is the app running?" >&2
    exit 1

# POST one message to the running app's bridge. Empty chat means a fresh one.
#
# `mode` is what the send may do to a turn already running: `refuse` never interrupts one and
# refuses immediately when the recorder already knows that chat is generating; it is what every
# ordinary push uses. `stop_first` presses Stop first. `reload` reloads the page holding the
# chat once before typing. Both extras need a named chat.
_send $chat $text mode="refuse" reload="false":
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    # Built by jq, never by string interpolation: a message is arbitrary prose and will
    # contain the quotes, newlines and backslashes that hand-built JSON gets wrong.
    body=$(jq -nc --arg c "$chat" --arg t "$text" --arg m "{{mode}}" --argjson r {{reload}} \
        'if $c == "" then { text: $t } else { conversationId: $c, text: $t, ifGenerating: $m, reloadFirst: $r } end')
    for port in 8765 8766 8767 8768 8769; do
        # /hello is unauthenticated and names the app, so it is how a local caller finds
        # which of the five candidate ports this app actually bound.
        #
        # Split into a connect deadline and a response deadline, because the two failures are
        # nothing alike. A port nothing is listening on refuses the connection in under a
        # millisecond, so hunting the other four costs nothing. A port this app *is* bound to
        # can take far longer than a second to answer: sampled 2026-09-10, 60 consecutive
        # /hello probes against a healthy daemon returned a median of ~100ms, one at 6.3s and
        # one that never answered inside 30s. Under the old flat `-m 1` those stalls fell out
        # of the loop as if no app were listening, and `say` reported "is the app running?"
        # about a running app — four times in five on an idle chat. A false liveness verdict
        # is worse than a slow one: it is the reading that makes the send path look dead.
        if curl -fsS --connect-timeout 2 -m 45 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            # A sleep-managed chat answers 409 with a typed reason, a next-check hint and the
            # concrete next action. `curl -f` threw all three away and left the caller a bare
            # `curl: (22)` — indistinguishable from a dead app, a bad token or a wedged
            # composer, which is exactly the blindness that sent a steward off to drive
            # composers over CDP. Read the body, relay what it says, and honour the documented
            # contract by waiting for the wake instead of failing the push.
            #
            # Bounded, because waiting forever is its own kind of lie: 25 minutes is longer
            # than the app's own fallback wake horizon, so a chat still refusing past it is
            # stuck rather than busy and the steward is told to go look.
            waited=0
            while :; do
                # Same split, and the transport failure is retried rather than fatal: the app
                # stalling for longer than this deadline is a slow app, not a refused send, and
                # aborting the whole push on one slow response threw away a message the bridge
                # had every intention of accepting.
                answer=$(curl -sS --connect-timeout 5 -m 60 -w '\n%{http_code}' "http://127.0.0.1:$port/send" \
                    -H "authorization: Bearer $token" \
                    -H 'content-type: application/json' \
                    --data-binary "$body" || printf '\n000')
                code=$(tail -n1 <<<"$answer")
                accepted=$(sed '$d' <<<"$answer")
                if [[ "$code" == "200" ]]; then break; fi
                if [[ "$code" == "000" ]]; then
                    if (( waited >= 1500 )); then
                        echo "gave up after ${waited}s: the app never answered POST /send inside its deadline." >&2
                        exit 1
                    fi
                    echo "note: the app did not answer POST /send in time; it is stalled rather than gone. Retrying." >&2
                    sleep 10
                    waited=$(( waited + 10 ))
                    continue
                fi
                reason=$(jq -r '.reason // .error // empty' <<<"$accepted" 2>/dev/null || true)
                if [[ "$code" != "409" || ( "$reason" != "sleeping" && "$reason" != "waking" ) ]]; then
                    echo "the app refused this send (HTTP $code): ${reason:-no reason given}" >&2
                    jq -r '.message // empty' <<<"$accepted" 2>/dev/null >&2 || true
                    exit 1
                fi
                if (( waited == 0 )); then
                    echo "note: that chat is $reason — the app discarded its tab after the last verified push and is the only driver allowed to type into it. Waiting." >&2
                fi
                if (( waited >= 1500 )); then
                    echo "gave up after ${waited}s: the chat is still '$reason', which is longer than a healthy sleep lasts." >&2
                    echo "Read GET /sleep/status — if its nextCheckAt keeps moving away while lastCallAt keeps advancing, its session key is bound to another chat's call stream." >&2
                    exit 1
                fi
                hint=$(jq -r '((.nextCheckHintMs // 15000) / 1000) | floor' <<<"$accepted")
                if (( hint > 30 )); then hint=30; fi
                if (( hint < 5 )); then hint=5; fi
                sleep "$hint"
                waited=$(( waited + hint ))
            done
            id=$(jq -r '.command.id' <<<"$accepted")
            pending=$(jq -r '.pendingTools' <<<"$accepted")

            # Accepting the message only queues it, and even a page click receipt is not
            # delivery: in a background tab the send button reports enabled and the click
            # silently no-ops. The only success is the app confirming a fresh turn_start in
            # the recording, which is what GET /send/outcome reports — poll it to terminal.
            horizon=$(jq -r '.verifyHorizonMs // 90000' <<<"$accepted")
            if [[ "$pending" != "0" && "$pending" != "null" ]]; then
                echo "note: $pending local tool call(s) in flight; the page will not type until they settle." >&2
                # Which calls, and how old. A call a few seconds in is an agent working and the
                # wait is correct; a call an hour in is a fact only the steward can act on, and
                # a bare count hides the difference. `unplaced` is the one charged to every chat.
                jq -r '.inFlightCalls[]? | "      \(.tool) \((.ageMs / 1000) | floor)s \(.attribution) \(.conversationId // "unplaced")"' \
                    <<<"$accepted" >&2 2>/dev/null || true
                # When _send itself was started through a connector exec_command, that
                # call is among the pending unattributed calls. Synchronously polling
                # from inside it deadlocks delivery: the call cannot settle until this
                # recipe exits, and the browser cannot type until it settles. Leave the
                # already-queued message intact, then let the caller verify the outcome
                # separately after its own tool call has returned. Never claim delivery.
                if jq -e '.inFlightCalls[]? | select(.tool == "exec_command" and .attribution == "unattributed")' \
                    <<<"$accepted" >/dev/null 2>&1; then
                    echo "queued but NOT delivered: command $id; the connector tool must finish before the browser can type." >&2
                    echo "Verify GET /send/outcome?id=$id from a later call; only sent_verified proves delivery." >&2
                    exit 75
                fi
            fi
            probe=$(curl -sS --connect-timeout 5 -m 45 -o /dev/null -w '%{http_code}' \
                "http://127.0.0.1:$port/send/outcome?id=$id" -H "authorization: Bearer $token" || echo 000)
            if [[ "$probe" == "200" ]]; then
                deadline=$(( $(date +%s) + 90 + horizon / 1000 + 30 ))
                while :; do
                    # A slow answer is not a lost send: an empty reply keeps the poll in its
                    # current state and tries again, which is what the deadline below is for.
                    out=$(curl -fsS --connect-timeout 5 -m 45 "http://127.0.0.1:$port/send/outcome?id=$id" \
                        -H "authorization: Bearer $token" || echo '{}')
                    state=$(jq -r '.state // empty' <<<"$out")
                    case "$state" in
                        sent_verified)
                            conv=$(jq -r '.conversationId' <<<"$out")
                            ts=$(( $(jq -r '.turnStartTs' <<<"$out") / 1000 ))
                            echo "delivered to $conv — turn_start at $(date -d "@$ts" +%H:%M:%S 2>/dev/null || echo "$ts")"
                            exit 0 ;;
                        queued|delivering|typed|"")
                            ;;
                        *)
                            # Terminal without proof of delivery. The app states the cause and
                            # the concrete next action; relay both instead of a bare failure.
                            echo "$state: $(jq -r '.reason // .message // empty' <<<"$out")" >&2
                            hint=$(jq -r '.message // empty' <<<"$out")
                            [[ -n "$hint" ]] && echo "$hint" >&2
                            exit 1 ;;
                    esac
                    if (( $(date +%s) >= deadline )); then
                        echo "gave up polling in state '${state:-unknown}'. $(jq -r '.message // empty' <<<"$out")" >&2
                        exit 1
                    fi
                    sleep 1
                done
            fi
            # The running app predates /send/outcome (it activates on its next restart).
            # Fall back to the receipt the browser writes once it has actually typed — the
            # old contract: no receipt within the 90s command deadline means it never sent.
            state="{{state_dir}}/bridge-commands.json"
            for _ in $(seq 1 180); do
                landed=$(jq -r --arg id "$id" '(.receipts[]? | select(.id == $id) | .conversationId) // empty' "$state" 2>/dev/null || true)
                if [[ -n "$landed" ]]; then
                    echo "typed into $landed (unverified: this app build cannot confirm turn_start; restart onto the new build for verified sends)"
                    exit 0
                fi
                sleep 1
            done
            echo "queued but never typed. $pending local tool call(s) were running when it was queued;" >&2
            echo "the page refuses to type while any are, and an unattributed call counts against every chat." >&2
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

    # The browser runs the extension from wherever it was loaded unpacked, which the AppImage
    # never touches. Skipping this leaves the browser on an old build while the app reports a
    # successful install, and every extension-side fix silently does nothing.
    while read -r loaded; do
        [[ -n "$loaded" ]] || continue
        # Copied into the directory rather than replacing it: the browser holds this exact path,
        # and a loaded copy can carry files of its own that are not ours to remove.
        command cp -af extension/. "$loaded/"
        echo "extension updated at $loaded — reload it at chrome://extensions"
    done < <(node scripts/extension-load-paths.mjs)

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

# Refresh the read-only steward workstream dashboard from live repository state.
steward-dashboard *args:
    python3 scripts/generate-steward-dashboard.py {{args}}

# Python tests for the scripts/ CLIs (chat-list.py, chatgpt-openapi.py).
[private]
_test-scripts:
    uvx --with openapi-spec-validator pytest -q scripts/tests

# Run the fast commit check; the commit hook runs this
test-commit: _test-scripts
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

# Run the fast push check; the push hook runs this
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push
