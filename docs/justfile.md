# The justfile recipes

This file holds the design notes for the recipes in `justfile`. `just --list` shows a one-line
summary of each recipe.

Build, packaging and the QC gate use the npm scripts in `package.json`. AGENTS.md §19
documents that workflow.

## Session recordings

`sessions`, `journal`, `journal-ui`, `transcript`, `search`, `tabs`, `tidy` and `who` read the
app's durable recordings. These live outside the repo, in the Electron userData directory
(`~/.config/chat-on-steroids/sessions` on Linux, `~/Library/Application Support/chat-on-steroids/sessions`
on macOS). `src/main/session/store.ts` writes them:

- Tool activity appends to `events.jsonl`.
- Each user or assistant message is one shard under `messages/`. The shard is rewritten in
  place while the message streams.
- Oversized text spills to `assets/`.

A transcript is those producers merged and ordered by `origin ?? seq`.

Tool rows print as headlines. For the exact arguments and result of one call, read its record
from the log:

```sh
jq 'select(.call.callId == "<id>")' <session>/events.jsonl
```

### `journal` and `journal-ui`

`journal` puts the chronological meaningful actions above a continuously refreshed panel of
workstream, turn and tool state and inactivity evidence. Repeated source inspections and
auto-continuation turns are summarized. Edits, tests, failures and process completions keep
their recorded times. It uses Python Rich for the live panel (`apt install python3-rich`).

```sh
just journal
just journal 3 50 sage-indefinite-port
just journal 3 50 sage-indefinite-port verbose
```

`journal-ui` is the full-screen searchable lnav view. Press G to move to the end and follow new
events; scrolling up pauses the displayed position. It needs lnav (`apt install lnav` or
`brew install lnav`).

### `transcript` ordering

Sessions from before the shard migration keep their messages in one legacy map,
`messages.json`, instead of shards. The recipe reads both.

A message shard is rewritten in place as it streams, and a reloaded page reports old messages
again, so `seq` is append order, not conversation order. `origin` holds the first position of a
rewritten item; `src/shared/chronology.ts` orders by the same key. Known limit: tool rows still
sit where `seq` put them, which draws a slow call after the turn it ran under. Port the
`chronology.ts` grouping if that becomes a problem.

A transcript is long and often piped into `head`, so a broken pipe exits quietly.

## `chats`

`chats` covers every chat on the account, whether or not it ever used the connector. Columns:

- `last msg` is the age of the newest message in the conversation itself.
- `state` is `busy` when the chat's open tab marks its turn in progress or this app's recorder
  says so. Otherwise it is the recorder's `idle`, `stalled` or `wedged`; `idle` for an open tab
  with no running turn; and `-` for a chat with no open tab and no recording, whose running
  state this does not know (read `last msg` for those).
- `model` is the model that answered last. `msgs` and `tools` count messages. `~tok` sizes the
  chat. The last column is the newest action this app recorded. The id is what `say` wants.

The sidebar list's times are not trusted: they freeze while a long turn runs. So the recipe
takes the `candidates` newest chats by list time (default 20), plus every open tab and every
recorder-busy chat, and checks them with ChatGPT's cheap metadata and `stream_status` calls.
Only the chats that pass the `minutes` window are read in full. A chat outside those that is
generating with no tab and no recording is missed; raise `candidates` to cover more.
`minutes=0` lists every chat read, active or not. `match` filters on the title.

`~tok` counts user, assistant and tool text at four characters per token. Hidden reasoning,
system prompts and tool schemas are not visible from here, so it sizes a chat; it does not
reproduce ChatGPT's context counter.

It needs Chromium started with `--remote-debugging-port=9222` and signed in to ChatGPT.

## The browser's tabs: `tabs`, `tidy`, `who`

`chats` reports what this app recorded; it cannot see a tab. Chromium's DevTools endpoint
(`devtools`, `http://127.0.0.1:9222`) can, and it is the only thing that knows a conversation
is open twice. Every tab the app opens carries a `clf` marker and nothing closes it when the
command ends, so tabs pile up: duplicates of live chats, and chats whose work finished hours
ago. These recipes need Chromium started with `--remote-debugging-port=9222`.

In `tabs`, one conversation in two tabs means a later command opened a second tab and did not
reuse the one already showing that chat. Only the first is worth keeping.

### `tidy`

`keep` is a comma-separated list of conversation ids never to archive, whatever their idle
time. A chat under active management is quiet between pushes, and quiet is not finished.

Archive calls run in a tab opened for the purpose, not in an existing one, for two reasons. A
page wedged enough to be worth archiving cannot run the request. And Chromium freezes the
renderer of a tab left in the background long enough, so an idle tab stops answering CDP
entirely, which is every tab by the time a sweep is worth running. The new page needs about six
seconds before it can run a request at all.

The archive goes through the page's own session, which is the only thing holding the
credentials. The conversation and the operation are both named explicitly, so it cannot land
on delete the way driving the chat's menu could. The JavaScript expression is built by
concatenation, not an f-string: a literal doubled brace is how just opens an interpolation, and
just reads the recipe before Python sees it.

A second tab on a conversation that is still live is closed; the chat is kept.

Every send opens a command tab on bare chatgpt.com, and a send that never redeems leaves its
tab behind. These tabs carry no conversation id, so the main loop never sees them, and they
accumulate one renderer at a time until the host is swapping, which kills the workers' own exec
sessions. A managed chat's own tab is momentarily bare too, between opening and navigating to
the conversation, and closing one of those takes a live worker off the air. The two look the
same in a single snapshot, so `tidy` looks twice: a tab still bare eight seconds later is not
on its way anywhere. It keeps the newest survivor as the app's spare.

### `who`

Paste the id from a tab's URL. It answers the one question a pile of open tabs raises: whether
this tab is still someone's live work, or a leftover the app has finished with. "Active" is when
the chat last did something, from its own recording.

## Changing chats and projects

`archive`, `unarchive`, `delete`, `pin`, `unpin`, `rename`, `move`, `unmove`, `projects`,
`project-new` and `project-delete` call `scripts/chat-manage.py`. It sends the request the
chatgpt.com page sends for the same menu action, from inside any ChatGPT tab that still runs
JavaScript. The requests are in `docs/chatgpt-backend-api.md`, "Chat and project management".
Each recipe takes conversation ids; a project is an id (`g-p-…`) or its exact name.

Archiving is how a chat leaves management, and a chat archived on a wrong call is still a live
worker: it keeps executing, it just stops being reachable. `unarchive` brings it back into the
managed set, so it can be pushed again.

## Driving chats: `say`, `new`, `interrupt`, `revive`, `state`, `_send`

The app's bridge has one route for local callers: `POST /send` types a message into a ChatGPT
chat, or opens a new one. It is the same transport the app uses to open a worker chat, with the
agent half removed. What these recipes open is an ordinary chat that shows up in
`just sessions` like any other. Chat On Steroids must be running, and the browser must be
paired; the app opens the tab itself. The credential is minted at bridge startup and lives in
`state/local-token`, mode 0600.

### `interrupt`

The composer refuses while a turn is in flight, so a turn that will never finish makes the chat
unreachable by anything; `interrupt` is the one thing that gets past it. It also destroys
whatever that turn was producing. That is why it is its own verb and never something `say`
decides to do: a chat that is merely working is a chat to leave alone. Read `just state <chat>`
first: it says how long the turn has been open, and when the recording last changed.

### `revive`

For a document alive enough to poll but stuck behind a turn its renderer will never resolve:
the state where a person would press reload. The reload is offered once, before the message is
typed, and only while nothing has claimed the send yet. A renderer frozen hard enough not to
poll at all is not reachable this way; the extension recycles those tabs itself.

### `_send`

`mode` is what the send may do to a turn already running. `refuse` never interrupts one and
refuses immediately when the recorder already knows that chat is generating; every ordinary
push uses it. `stop_first` presses Stop first. `reload` reloads the page holding the chat once
before typing. Both extras need a named chat.

The request body is built by jq, never by string interpolation: a message is arbitrary prose
and will contain the quotes, newlines and backslashes that hand-built JSON gets wrong.

`/hello` is unauthenticated and names the app, so it is how a local caller finds which of the
five candidate ports (8765–8769) this app bound. The probe splits a connect deadline from a
response deadline, because the two failures are not alike. A port nothing listens on refuses
the connection in under a millisecond, so hunting the other four costs nothing. A port this app
*is* bound to can take far longer than a second to answer: sampled 2026-09-10, 60 consecutive
`/hello` probes against a healthy daemon returned a median of ~100ms, one at 6.3s and one that
never answered inside 30s. Under the old flat `-m 1` those stalls fell out of the loop as if no
app were listening, and `say` reported "is the app running?" about a running app, four times in
five on an idle chat. A false liveness verdict is worse than a slow one: it is the reading that
makes the send path look dead. `state` uses the same probe for the same reason.

A sleep-managed chat answers 409 with a typed reason, a next-check hint and the concrete next
action. `curl -f` threw all three away and left the caller a bare `curl: (22)`, which looks the
same as a dead app, a bad token or a wedged composer; that blindness sent a steward off to drive
composers over CDP. So `_send` reads the body, relays what it says, and keeps the documented
contract by waiting for the wake instead of failing the push. The wait is bounded at 25
minutes, longer than the app's own fallback wake horizon, so a chat still refusing past it is
stuck, not busy, and the steward is told to go look.

A transport failure on `POST /send` is retried, not fatal: the app stalling past the deadline
is a slow app, not a refused send, and aborting the whole push on one slow response threw away a
message the bridge meant to accept.

Accepting the message only queues it, and even a page click receipt is not delivery: in a
background tab the send button reports enabled and the click silently does nothing. The only
success is the app confirming a new `turn_start` in the recording, which is what
`GET /send/outcome` reports. `_send` polls it to a terminal state. A slow answer is not a lost
send: an empty reply keeps the poll in its current state and tries again until the deadline. A
terminal state without proof of delivery carries the cause and the next action; `_send` relays
both.

When local tool calls are in flight, `_send` prints which calls and how old. A call a few
seconds in is an agent working and the wait is correct; a call an hour in is a fact only the
steward can act on, and a bare count hides the difference. `unplaced` is the one charged to
every chat. When `_send` itself was started through a connector `exec_command`, that call is
among the pending unattributed calls. Polling synchronously from inside it deadlocks delivery:
the call cannot settle until the recipe exits, and the browser cannot type until it settles. So
`_send` leaves the queued message intact, exits 75, and lets the caller verify the outcome from a
later call. It never claims delivery.

An app that predates `/send/outcome` (which activates on its next restart) gets the old
contract: the receipt the browser writes once it has typed. No receipt within the 90s command
deadline means it never sent.

## `install`

`npm run dist:*` writes an artifact into `release/` and stops there. That leaves the last step,
putting the artifact where the launcher points and restarting, as something a person does by
hand and forgets. `just install` is that step. It follows the launcher on PATH to find what to
replace, so it upgrades whatever installation this machine has, not a path written in the
justfile.

- The launcher is normally a symlink into the install directory. The recipe replaces what it
  resolves to, so the launcher, the `.desktop` entry and the tray icon keep working.
- An AppImage runs from a mount of its own file, so the app is stopped before that file
  changes. SIGTERM is the app's ordinary shutdown; it drains in-flight MCP work and writes its
  durable state. The process is matched by name, not by path: the running app's argv holds the
  `/tmp` mount it unpacked itself into, never the file being replaced. Linux truncates a
  process name to 15 characters, so the name is `chat-on-steroid`.
- The new AppImage is written beside the target and renamed, so a failed copy cannot leave a
  half-written file where the launcher points.
- The browser runs the extension from wherever it was loaded unpacked, which the AppImage never
  touches. Skipping this step leaves the browser on an old build while the app reports a
  successful install, and every extension-side fix silently does nothing. The files are copied
  into the loaded directory, not swapped for it: the browser holds that exact path, and a loaded
  copy can carry files of its own that are not ours to remove.
- The bridge answering on a port is the proof that the app came back on the new build.
