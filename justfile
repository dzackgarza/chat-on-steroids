sessions_dir := if os() == "macos" {
    home_directory() / "Library/Application Support/chat-on-steroids/sessions"
} else {
    env_var_or_default("XDG_CONFIG_HOME", home_directory() / ".config") / "chat-on-steroids/sessions"
}

[doc("Show available recipes")]
default:
    @just --list

[doc("List recorded chats, newest first: updated, id, counts, title")]
[script("bash")]
sessions:
    set -euo pipefail
    shopt -s nullglob
    for meta in "{{sessions_dir}}"/*/meta.json; do
        jq -r '[.updatedAt, (.updatedAt / 1000 | localtime | strftime("%m-%d %H:%M")),
                .id, "\(.userMessages)msg \(.toolCalls)tool", .title] | @tsv' "$meta"
    done | sort -rn | cut -f2-

[doc("Live workstream monitor: meaningful actions above refreshed turn and tool state")]
[script("bash")]
journal $hours="3" $lines="50" $chat="" $detail="":
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

[doc("Full-screen searchable lnav view of the journal")]
[script("bash")]
journal-ui $hours="3" $lines="100" $chat="":
    set -euo pipefail
    if ! command -v lnav >/dev/null 2>&1; then
        echo 'lnav is required (sudo apt install lnav / brew install lnav)' >&2
        exit 127
    fi
    python3 -u "{{justfile_directory()}}/scripts/activity-journal.py" \
        --root "{{sessions_dir}}" --hours "$hours" --lines "$lines" --chat "$chat" \
        | lnav -N -c ':goto 100%'

[doc("Print a chat transcript; ID may be any substring, default is the newest chat")]
[script("python3")]
transcript $id="":
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
    legacy = session / "messages.json"
    if legacy.exists():
        rows += list(json.loads(legacy.read_text() or "{}").values())
    def position(row):
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
        os._exit(0)

[doc("Find which recorded chats mention a term")]
[script("bash")]
search $term:
    set -euo pipefail
    grep -rlisF -e "$term" "{{sessions_dir}}" \
        | sed "s|^{{sessions_dir}}/||; s|/.*||" | sort -u \
        | while read -r id; do
            printf '%s\t%s\n' "$id" "$(jq -r .title "{{sessions_dir}}/$id/meta.json")"
        done

state_dir := if os() == "macos" {
    home_directory() / "Library/Application Support/chat-on-steroids/state"
} else {
    env_var_or_default("XDG_CONFIG_HOME", home_directory() / ".config") / "chat-on-steroids/state"
}

[doc("The ACTIVE ChatGPT chats: generating now, or a message in the last `minutes` (default 10)")]
[script("bash")]
chats minutes="10" match="" candidates="20" archived="false" json="false":
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

devtools := "http://127.0.0.1:9222"

manage := 'python3 "' + justfile_directory() / "scripts/chat-manage.py" + '" --devtools "' + devtools + '"'

[doc("Archive conversations in ChatGPT, whether or not they have a tab open")]
archive +chats:
    @{{manage}} archive {{chats}}

[doc("Bring archived conversations back into the managed set, so they can be pushed again")]
unarchive +chats:
    @{{manage}} unarchive {{chats}}

[doc("Delete conversations permanently")]
delete +chats:
    @{{manage}} delete {{chats}}

[doc("Pin conversations in the sidebar (ChatGPT allows at most 10)")]
pin +chats:
    @{{manage}} pin {{chats}}

[doc("Unpin conversations")]
unpin +chats:
    @{{manage}} unpin {{chats}}

[doc("Rename one conversation")]
rename chat $title:
    @{{manage}} rename {{chat}} "$title"

[doc("Move conversations into a project")]
move $project +chats:
    @{{manage}} move "$project" {{chats}}

[doc("Take conversations out of their project, back to the chat list")]
unmove +chats:
    @{{manage}} remove-from-project {{chats}}

[doc("The account's projects: id and name")]
projects:
    @{{manage}} projects

[doc("Create a project and print its id")]
project-new $name:
    @{{manage}} project-new "$name"

[doc("Delete a project; it refuses while the project holds chats unless --with-chats is given")]
project-delete $project *flags:
    @{{manage}} project-delete "$project" {{flags}}

[doc("Every open ChatGPT tab, what its chat last did, and whether the tab is worth keeping")]
[script("python3")]
tabs quiet="30":
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

[doc("Archive the finished chats in ChatGPT and close their tabs, plus any duplicate tabs")]
[script("python3")]
tidy quiet="30" keep="":
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

    scratch = subprocess.run(
        ["curl", "-s", "-m", "10", "-X", "PUT", "{{devtools}}/json/new?https://chatgpt.com/"],
        capture_output=True, text=True).stdout
    healthy = scratch_id = None
    if scratch.strip().startswith("{"):
        opened = json.loads(scratch)
        scratch_id, healthy = opened.get("id"), opened.get("webSocketDebuggerUrl")
        time.sleep(6)
    keep = {c.strip() for c in "{{keep}}".split(",") if c.strip()}

    def archive(chat, ws):
        """Archive through the page's own session, which is the only thing holding the
        credentials. The conversation and the operation are both named explicitly, so this
        cannot land on delete the way driving the chat's menu could."""
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

[doc("What a chat is: driven prime, swarm worker, or nothing the app is still using")]
[script("python3")]
who chat:
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

[doc("Send a message to an open chat, by conversation id (see `just chats`)")]
say $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" refuse false

[doc("Start a new chat with this opening message")]
new $text:
    @just -f {{justfile()}} _send "" "$text" refuse false

[doc("Stop the turn that chat is running, then send this message — for a turn that will not end")]
interrupt $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" stop_first false

[doc("Reload that chat's page, then send this message — for a tab that is stuck rather than busy")]
revive $chat $text:
    @just -f {{justfile()}} _send "$chat" "$text" refuse true

[doc("What that chat's turn is doing right now, from the live recorder rather than from disk")]
[script("bash")]
state chat:
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    for port in 8765 8766 8767 8768 8769; do
        if curl -fsS --connect-timeout 2 -m 45 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            curl -fsS --connect-timeout 5 -m 45 -G "http://127.0.0.1:$port/conversation/status" \
                --data-urlencode "conversationId={{chat}}" \
                -H "authorization: Bearer $token" | jq .
            exit 0
        fi
    done
    echo "Chat On Steroids is not answering on 8765-8769; is the app running?" >&2
    exit 1

[doc("Read the controller's live workstream phases and schema gate before any managed dispatch")]
[script("bash")]
workstreams:
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

[doc("POST one message to the running app's bridge; an empty chat means a new one")]
[script("bash")]
_send $chat $text mode="refuse" reload="false":
    set -euo pipefail
    token=$(cat "{{state_dir}}/local-token")
    body=$(jq -nc --arg c "$chat" --arg t "$text" --arg m "{{mode}}" --argjson r {{reload}} \
        'if $c == "" then { text: $t } else { conversationId: $c, text: $t, ifGenerating: $m, reloadFirst: $r } end')
    for port in 8765 8766 8767 8768 8769; do
        if curl -fsS --connect-timeout 2 -m 45 "http://127.0.0.1:$port/hello" 2>/dev/null | grep -q chat-on-steroids; then
            waited=0
            while :; do
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

            horizon=$(jq -r '.verifyHorizonMs // 90000' <<<"$accepted")
            if [[ "$pending" != "0" && "$pending" != "null" ]]; then
                echo "note: $pending local tool call(s) in flight; the page will not type until they settle." >&2
                jq -r '.inFlightCalls[]? | "      \(.tool) \((.ageMs / 1000) | floor)s \(.attribution) \(.conversationId // "unplaced")"' \
                    <<<"$accepted" >&2 2>/dev/null || true
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

[doc("Build this tree, install it over the installed app, and restart it")]
[linux]
[script("bash")]
install:
    set -euo pipefail

    launcher=$(command -v chat-on-steroids || true)
    if [[ -z "$launcher" ]]; then
        echo "No chat-on-steroids on PATH: install a release once, then this recipe upgrades it." >&2
        exit 1
    fi
    target=$(readlink -f "$launcher")

    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) echo "Unsupported architecture $(uname -m)." >&2; exit 1 ;;
    esac
    npm run "dist:linux:$arch"
    built="release/Chat-On-Steroids-Linux-$arch.AppImage"

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

    install -m 755 "$built" "$target.incoming"
    mv "$target.incoming" "$target"
    echo "installed $(basename "$target")"

    while read -r loaded; do
        [[ -n "$loaded" ]] || continue
        command cp -af extension/. "$loaded/"
        echo "extension updated at $loaded — reload it at chrome://extensions"
    done < <(node scripts/extension-load-paths.mjs)

    if [[ "$was_running" == yes ]]; then
        setsid "$launcher" >/dev/null 2>&1 < /dev/null &
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

[doc("Refresh the read-only steward workstream dashboard from live repository state")]
steward-dashboard *args:
    python3 scripts/generate-steward-dashboard.py {{args}}

[doc("Python tests for the scripts/ CLIs (chat-list.py, chatgpt-openapi.py)")]
[private]
_test-scripts:
    uvx --with openapi-spec-validator --with tree-sitter --with tree-sitter-javascript pytest -q scripts/tests

[doc("Run the fast commit check; the commit hook runs this")]
test-commit: _test-scripts
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-commit

[doc("Run the fast push check; the push hook runs this")]
test-push:
    @just -f ~/ai-review-ci/justfiles/bun.just -d . test-push
