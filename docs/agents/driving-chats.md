# Reading and driving ChatGPT chats from here

The app records every chat it bridges, and it can type into one for you. Both are `just`
recipes in this repository, so an agent on this computer can watch a ChatGPT conversation
and keep it moving without a browser.

| Command | Effect |
| --- | --- |
| `just sessions` | recorded chats, newest first |
| `just transcript <part-of-an-id>` | print one chat; defaults to the newest |
| `just search <term>` | which chats mention a term |
| `just chats [minutes]` | ACTIVE chats (generating, or a message in the last 10 min): id, state, model, ~tokens |
| `just chats 0` | every chat it reads, active or not (see `candidates`) |
| `just state <conversation-id>` | what that one chat's turn is doing, from the live recorder |
| `just say <conversation-id> "..."` | send that message to that chat |
| `just new "..."` | open a new chat with that opening message |
| `just interrupt <conversation-id> "..."` | stop the turn it is running, then send |
| `just revive <conversation-id> "..."` | reload its page, then send |

These recipes change chats and projects. They need only a signed-in ChatGPT tab on port 9222,
not the app. `scripts/chat-manage.py` sends the request that the page sends for the same menu
action (`docs/chatgpt-backend-api.md`, "Chat and project management").

| Command | Effect |
| --- | --- |
| `just archive <id>...` | archive chats |
| `just unarchive <id>...` | unarchive chats |
| `just pin <id>...` | pin chats; ChatGPT allows at most 10 pinned chats |
| `just unpin <id>...` | unpin chats |
| `just rename <id> "title"` | rename one chat |
| `just projects` | project id and name |
| `just move <project> <id>...` | move chats into a project; `<project>` is an id (`g-p-…`) or the exact name |
| `just unmove <id>...` | take chats out of their project, back to the chat list |
| `just project-new "name"` | create a project and print its id |
| `just delete <id>...` | delete chats permanently |
| `just project-delete <project> [--with-chats]` | delete a project |

Deleting a project deletes every chat in it, so `project-delete` refuses a project that holds
chats unless `--with-chats` is given.

`just chats` is the one that gives you the id `say` needs. `busy` requires a
recently updated backend streaming indication; a stale page marker or recorder turn
cannot establish live generation by itself. Inspect explicit error and uncertainty
states before sending.

`just chats` reads ChatGPT conversations, not only the ones this app recorded, so it covers
chats that never used the connector. It runs in two passes. The cheap pass asks ChatGPT's
`POST /backend-api/conversations/batch` (10 ids per call, metadata only) for each candidate's
`update_time`, and `/backend-api/conversation/<id>/stream_status` for whether a turn runs
(`IS_STREAMING`, else `COMPLETE`). Neither call is under the history-detail rate limit. `last msg`
is the age of that `update_time` (or the recorder's clock, if newer). `state` is:

| `state` | Meaning |
| --- | --- |
| `busy` | Backend `IS_STREAMING` and the newest observed activity is recent (ten-minute verification window, independent of listing filter). |
| `alert` | An open tab actually displays an `aside[role=alert]`; show its text. Never invent an alert from a stale stream flag. |
| `stalled`, `failed`, `interrupted`, `observer_lost`, `wedged` | The recorded final/abnormal turn state; a backend `COMPLETE` only says the stream is no longer generating, not that the turn succeeded. |
| `page_stale`, `unverified` | Conflicting page `in_progress` with backend `COMPLETE`, or a stale/unknown streaming indication; neither proves generation. |
| `error` | Batch metadata could not be read. Its HTTP error remains visible. |
| `idle`, `-` | Backend `COMPLETE` without an observed failure, or no evidence of a running turn. |

The full pass reads only the rows that survive the window, one at a time, for model and size
(`/backend-api/conversation/<id>` is under the history-detail limit, HTTP 429).
The first 429 stops all further full reads (waiting out `Retry-After`, about 50 s, would make the
listing slower than the question it answers) and lists the
remaining rows as `!429`, so a rate-limited run still answers "which chats are generating". A
chat whose metadata call failed also stays listed, as `!status`.

The sidebar chat list (`/backend-api/conversations`) only enumerates ids and titles. Its
`update_time` stays frozen while a long turn runs, so it never decides what is active.
The CLI also reads each open tab's identity-checked `document.title`: on 2026-11-24
both list and batch said `New chat` while the actual conversation tab carried a
specific Lean CAS milestone title. The command
checks the `candidates` (default 20) newest chats by list time, plus every open tab and
recorder-busy chat, with `stream_status` 16 at a time (20 chats in about 3 s, 100 in 15 s). A chat outside those that
is generating with no tab and no recording is missed; `just chats 10 "" 0` checks the whole
list. `~tok` is visible user, assistant and tool text at four characters per token, not ChatGPT's
context counter. It needs Chromium on port 9222 signed in to ChatGPT. Details:
`scripts/chat-list.py`; its tests: `scripts/tests/test_chat_list.py` (run by `just test-commit`).
The endpoints it calls, their response shapes, and the rate limits are specified in
`docs/chatgpt-backend-api.md` and `docs/chatgpt-backend-api.openapi.json`.

A chat that `new` opens is an ordinary chat: it is not a worker, it belongs to no run, and
it appears in `just sessions` like any other.

The app must be running and the browser paired — it opens the tab itself.

## What to send them

The chats on the other end are frontier models. Brief them the way you would brief a senior
engineer who already has the context — not the way you would call a 2024 API.

**Point at a task. Do not say how to do it.** "Work through the open issues on `<repo>`",
"proceed through the repo todos", "audit `<area>` and report what you find". A model told to
do a task already forms the verdicts an older prompt would have asked it to return, and acts
on them. Asking for "a list of YES/NO verdicts" throws away the half of the job that matters.

**Never dispatch the next unit of a task.** Not the next chapter, issue, file, or item. A chat
that just finished one knows what it finished, and the repository it is working in says what
comes after. Handing it one unit at a time makes it stop after each one and wait, so it idles
most of every window, and every tick is spent recomputing something the chat could read for
itself. If a repository does not say how to pick the next unit and carry on without being asked,
that is a missing paragraph in that repository's `AGENTS.md` or task list — write it there. Chats
are ephemeral and a new one starts with none of what you told the last; only the repository
survives.

**Keep it to one or two paragraphs.** The task, plus any external context it cannot already
see: a path, an issue number, a decision taken elsewhere. Nothing else.

**Never constrain, dictate method, or control.** No step lists, no output formats, no rules
about how to work. Open-ended, but clear and precise about what the task is.

**They are not one-shots.** One chat runs for many turns — typically tens of minutes, often
hours. Leave it alone while it works.

**Do not send a bare `Continue` until you have classified the stop.** A quiet chat can be
working on a long process, wedged, done, blocked by its own repository rules, or producing the
wrong work. Those states require opposite actions. `Continue` is appropriate only when the
current repository objective is still open, the next substantive unit is genuinely ready, no
host/process/document blocker explains the stop, and the chat merely ended a turn early. Even
then prefer a pointer to the durable source of truth — “continue the current TODO/AGENTS.md
objective” — over a generic imperative.

If the chat is repeating a behaviour, an interrupt carries the missing fact. If the page cannot
store or start turns, revive it. If the task is complete, retire it. If the worker is producing
wrong work, fix the governing repository document first and then point the worker at the corrected
contract. A continuation is never a substitute for deciding which of those cases you are in.

**Give `say` the whole conversation id, never a prefix.** `say` passes its first argument
straight through as the `conversationId` of the queued command, so an eight-character prefix is
not the chat you meant — it names no conversation, and the app opens a fresh one, types into
that, and leaves a second empty recording behind under the prefix. The push then reports refused
while the intended chat sits untouched, which reads exactly like a wedged conversation. Three
chats looked dead this way in one tick and all three typed immediately when pushed again with
their full ids. The same applies to every recipe that takes a chat: pass the id `just chats`
prints, in full.

**When a chat's context fills, hand off.** The replacement's opening message already carries
the predecessor's recorded execution ([AGENTS.md §11](../../AGENTS.md#workstream-leases-and-recovery), "Workstream leases and recovery"). The brief adds only
what that record cannot show: the ambient task, the tracking documents, and the item, phase or
subtask in progress. Nothing more.
A brief that states what is already done is acceptance evidence the new chat will act on, so
take it from the repository's record (commits by path, the node's own ledger), never from the
old chat's prose: on 2026-10-02 a brief saying a copy pass "has read algebra, analysis,
topology" meant wiki pages, and the replacement closed the node with 1,600 corpus cards unread.
Name the ongoing task, never "the next" unit, or the chat stops after one.
