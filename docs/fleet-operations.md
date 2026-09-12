# Fleet operations reference

This file is the steward's instrument manual. Everything in it was learned the expensive
way and none of it is guessable from the code, so it is kept verbatim — but it is
**reference, not doctrine**. The job is in
[`AGENTS.md` § The steward's job](../AGENTS.md#the-stewards-job). Come here when an
instrument is telling you something you are about to act on, and go back as soon as it has
answered.

The failure this split exists to prevent: a steward reads a document that is mostly about
tabs, locks, clocks and refusal codes, and concludes that reading tabs, locks, clocks and
refusal codes is the job. It is not. Every page below exists only to stop a wrong reading
from turning into a wrong action, and consulting it while a repository is producing nothing
is time that repository is paying for.

Three rules govern the whole file:

- **An instrument reading is never a finding.** `just chats`, `/conversation/status`,
  `just tabs`, `free`, a send outcome, a script's own exit code — each reports the state of
  the steward's machinery. A finding is a statement about whether a repository is gaining
  content, and only the repository can supply it.
- **When an instrument and a repository disagree, the repository wins.** Every incident
  recorded below is an instance of this.
- **Nothing here authorises an action.** The three moves are in `AGENTS.md`. This file only
  tells you which reading of an instrument is correct before you take one of them.

## When a chat stops — reading the send path

Driving chats means most of the work is deciding whether one has stopped, and the rows lie in
both directions until you know how to read them.

**`say` reports failure it cannot prove.** It waits for the receipt the browser writes once it
has typed, and calls the push refused when none arrives in its window. A message that landed
slightly late reports as never typed. Re-read `just chats` before believing a refusal — a moved
timestamp means it landed.

**A refused push does not mean the chat is dead.** The page refuses to type while a turn is in
flight, so a chat that is merely busy refuses exactly like a wedged one. Compare the chat's
timestamp before and after the attempt: the push takes up to two minutes and a live chat emits
rows throughout, so a clock that moved means alive and a clock that did not means dead.

**The stall bar is eager, and the timestamp re-check is what makes that safe.** Recorded gaps
between rows inside a live turn run 8.2s at the median and 26s at p90; separating turns that
never stalled from turns that did barely changes the tail, so a multi-minute gap in the
recording is not evidence of slow work — it is the recording being coarser than the agent's
real contact with the app. `just chats` calls a turn stalled at ninety seconds. Being early
costs one refused push, since the re-check above leaves a chat alone when its clock moved.
Being late costs a whole polling interval of a chat doing nothing, which is the expensive
side.

**A stalled chat can only be rescued from inside the page, and now you can ask it to.** The
composer refuses while a turn is in flight, which is exactly the state worth rescuing, so
nothing outside the page can break it. The page breaks it three ways. On its own: the content
script presses Stop and sends `Continue` after a ten-minute stall, retrying every two minutes
because ChatGPT often ignores the first press, and the service worker reloads a tab that holds
a chat and will not act on the command for it. On request: `just interrupt <chat> "..."` makes
that same press happen now and types your message instead of `Continue`, and
`just revive <chat> "..."` reloads the page first. Both destroy or discard whatever the turn
was doing, so they are separate verbs from `say` — read `just state <chat>` before reaching for
one. A chat that is merely working is a chat to leave alone.

**A tab that renders is not a chat that answers.** `just tabs` calls a tab `live` when the
page is loaded and its chat was recently touched; neither half of that asks whether the chat
produced anything. A chat can hold a `live` tab, accept every push, and emit nothing: in
2026-09 `6aa27577` took twenty-one `Continue` pushes across fourteen hours with no assistant
message after 07:18, while `just tabs` showed it `live 0m` and `just chats` showed an ordinary
`turn_end stalled` row. Row kinds and tab verdicts are substrate metrics. The only evidence a
worker is alive is an assistant message dated after the last push, which costs one read:
`just transcript <chat> | grep -E '^## (assistant|user)' | tail -30`. A run of consecutive
`## user` lines with no assistant between them is a corpse absorbing pushes, and every tick
that re-pushes it is a tick that bought nothing.

**`typed_unverified` is not proof of non-delivery, and retrying it duplicates the stream.**
The outcome means the page reported the text accepted while no `turn_start` reached the
recording inside the horizon — a late receipt produces it just as reliably as a wedged draft.
On a `just new`, retrying blind is how one scope ends up with two workers on it. Read
`just chats 1` first: a conversation that was not there before, with a title matching what you
sent, means it landed.

**Unreachable is not dead, and archiving is not cheap to reverse.** A chat can refuse `say`,
`interrupt` and `revive` in succession while its worker is executing normally — `6aa3009c`
refused all three while inside a pytest run at 95% CPU that it went on to bank from. Send
paths fail for reasons that live in the page, not in the worker. Confirm against the worker's
own output — the host process it named, or its repository's clock — before archiving, because
the app archives through `PATCH is_archived` and carries no recipe to undo it.

**The composer gate closes on the steward, not on the worker, and retrying widens it.** The
page refuses to type while local tool calls are in flight, and an unattributed call is charged
against every chat — so a fleet where all four workers happen to be running tools is a fleet
with no reachable chat in it, and the refusal says nothing about any particular worker. Every
send attempt opens its own command tab, which is one more call against the same gate, so a
retry loop is the one response that reliably makes the next attempt fail too. Poll `just state
<chat>` until it reports no pending tool, then send once.

**Two different refusals look identical from outside the page, and waiting on the wrong one
waits forever.** A chat refuses because a turn is already generating, or because local tool
calls are still pending; the composer needs both clear, and the error text does not say which
one you hit. `GET /conversation/status` on the bridge reports them separately — `generating`,
`pendingTools`, plus `generatingForMs` and `noProgressForMs` for how long. A waiter that polls
only `pendingTools` sits through an hour of long turns firing sends that can never type, each
one opening another command tab. Read both fields, and treat an empty response as *unknown*
rather than as clear, because a bridge that did not answer is not a gate that opened.

**A resend loop must verify against something other than the send's own outcome — and the
transcript is not that something.** `say` reports failure it cannot prove, so a loop that
retries on a non-`delivered` result will happily deliver the same message three times to a
worker that received it the first time. But the obvious fix, grepping the transcript for a
phrase from the message, fails the other way: the recorder can stop appending to a chat's
transcript while the chat keeps working. On 2026-09-11 `lean-categories` showed a transcript
frozen at 22:54 while the bridge reported a turn that had started ninety seconds earlier and
the repository banked four commits in between, so two waiters declared the push not landed and
a third would have duplicated it.

Rank the surfaces by what they can actually prove. The repository's commit clock is ground
truth for whether work happened. `GET /conversation/status` is ground truth for delivery: a
`lastStoredKind` of `turn_start`, or a `turnStartedAt` later than your send, means the message
reached the chat. The transcript is the only place the worker's own words live and is
indispensable for reading intent — but it lags, and for a chat whose observer was lost it can
stop advancing altogether, so absence of your message there proves nothing at all. Never
escalate to a resend on transcript absence alone; check the bridge first.

**A chat's title and its early transcript name the repository it started on, not the one it
is working now.** Long-lived chats get repurposed, and the tab title never follows — a chat
titled `Fix Lean Categories Blocker` spent hours on `sage-categories` while every path in its
transcript said so. Counting repository mentions across a whole transcript measures where a
chat has *been*, which is the wrong question; a steward that attributes a worker that way will
route a push at the wrong repo's queue and then read the wrong clock to verify it. Attribute
from the newest output only, and confirm by which repository's clock moves after the push.

Repurposing also runs backwards: telling a worker to re-read its repository's own documents is
the standard way to land policy, but a chat carrying an older identity can take that as an
instruction to return to the repository it started in. Watch the reply, not the send — if the
artifacts it names belong to a different repository than the one you addressed, say the working
directory explicitly and make it echo `pwd` before it does anything else.

**Attributing a commit to a chat by elimination is how a repository quietly loses its worker.**
Two chats each holding a plausible claim on a repository cannot be separated by which one you
last pushed, by a tab title, or by "no other chat was active, so it must have been this one."
On 2026-09-11 a steward credited a `sage-categories` commit to a chat that had said nothing for
thirty-three minutes, withdrew a correct re-scope on that basis, and left the repository
looking owned while its chat sat silent. The separation that works is content: grep each
candidate transcript for a term that appears only in that repository's work — a theorem name, a
module path — and let the chat that mentions it own the commits.

Absence is weaker evidence than presence here, and mistaking the two flips the answer. The
transcript renders an `exec_command` row as a truncated one-liner, so a commit subject typed
inside a long command never appears in it at all; a chat can author a commit whose message the
transcript does not contain. Search for prose the worker wrote — the mathematics it described,
the file it said it was editing — not for the text of the command it ran. And check turn
latency before reading silence as death: a worker whose turns run fifty minutes is not wedged
at thirty-five, and the same chat that looks dead against a tick interval is on schedule
against its own.

**Never refute a worker with a detector you invented. Use the repository's own tool.** A
worker that reports its range already complete is making a claim the steward has to check, and
the cheap-looking check is a grep. It is the wrong instrument: a corpus marks its own state in
its own notation, and that notation is not guessable from outside. `new-qual-site` marks
solutions with a pandoc fenced div, `::: solution`, and ships `tools/unsolved_queue.py` behind
`just unsolved` to count them; on 2026-09-11 a steward grepped for a `## Solution` heading
instead, found none, told a worker its fourteen cards were "entirely unwritten", and pasted the
loop as proof. Every card already had its solution. The worker complied against its own correct
judgment and re-solved a solved card in a format the corpus does not use, and the false premise
then propagated into a retired stream, a handover brief, and a queue item.

The asymmetry is what makes this expensive: a worker that stops on a wrong "it is done" costs
one push to restart, while a worker told its finished work is missing does harmful work
confidently and buries the evidence under a plausible commit. So when a worker's completion
claim conflicts with your reading, suspect the reading first. Find the repository's own
measurement — a `just` recipe, the tool the commit gate runs, the queue file it regenerates —
and quote that. If no such tool exists, the honest move is to ask the worker how completeness
is marked in that corpus, not to assert a negative from a pattern you chose yourself.

**A verification watch that dies takes the verification with it, silently.** The tick's
guarantee is that no unverified push crosses into the next tick, and that guarantee lives in
whatever is watching the clocks. When that watcher fails — a script error, the harness killing
it under memory pressure — nothing announces that three interventions are now unobserved; the
steward simply stops hearing about them and reads the silence as nothing having happened yet.
Keep the watcher boring for that reason: plain variables and one `git log` per repository, no
shell features that can fail, and a final line that names which legs never fired rather than
exiting quietly. When a watcher does die, re-arm it before doing anything else — the pushes it
was holding are the only state that was lost.

**A dirty count read while a commit is in its gate measures the tree before the commit, so
"not banked yet" and "not banking" look identical for minutes.** On a repository whose gate
walks ten thousand files, a worker can be three minutes into exactly the commit you asked for
and still show every path dirty, because nothing moves until the gate returns. On 2026-09-12 a
steward watched `new-qual-site` for ten minutes, saw the count climb from 117 to 279, and was
one step from replacing a worker that had a live `git commit` in flight for the Berkeley
collection at that moment.

Pair the count with `pgrep -af 'git commit'` and the lock's owner before concluding anything
about banking, the same way a lock is read with `pgrep` before being called stale. And read a
rising count carefully: intake continuing alongside a slow commit raises it, which looks like a
worker ignoring the instruction and is not.

The genuine risk in that state is the one the steward controls. A pathspec commit sitting
minutes in a gate is exactly what memory pressure kills, and a killed commit orphans the lock
and stops the repository — so a slow gate is a reason to protect headroom and leave the worker
alone, never a reason to push it again.

**A commit that produces no content is bloat, whatever its size.** Claiming a node, releasing
a claim, advancing a frontier record, ticking a queue marker — none of it is work, and none of
it earns a commit. It buys a gate run, a message, and a line of history that says nothing was
built, and it makes the tick read as a healthy cadence while the repository gains nothing. Size
is not the test and neither is the ratio of administrative lines to content lines; the test is
whether the commit carries mathematics, code, or prose that did not exist before.

On 2026-09-12 `research` produced fifty-five commits in five hours of which thirty-two were
under five lines of pure claim bookkeeping, and `lean-categories` spent fourteen of thirty-four
on frontier-record updates. Both patterns were steward-induced — one worker was told to claim
nodes before working them, the other to bank the mathematics and *then* advance the frontier
record. Instruct the opposite: a record update rides in the commit carrying the content it
describes, or it does not happen. A worker that needs a claim protocol at all is a worker
sharing a repository, which is already forbidden.

**Commit age alone cannot tell working from done, and the tick's three-way classification
collapses without the other two readings.** A repository twenty minutes past its last commit
looks the same in `git log` whether the worker is deep in a long turn or finished and waiting.
The two other facts separate them and both are already to hand: whether the turn ended
(`turn_end` in the rows, `generating: false` on the bridge) and whether the tree is clean. A
worker mid-turn with a dirty tree is working. A worker whose turn has ended, whose tree holds
nothing but its own untracked scratch, and whose clock has been quiet is **done** — it has
banked everything it had and is waiting for an instruction that is not coming.

On 2026-09-12 a steward read a twenty-minute-old commit as "working, leave alone" and moved on;
the worker had in fact finished both of its repository's in-repo prerequisites, leaving only an
externally-owned blocker, and had been idle with a clean tree for twenty-five minutes. Done is
the state that costs the most to misread, because a wedged worker announces itself eventually
and a done one never will.

**`chat_error` is not a verdict. The only test for reachability is a push.** The bridge reports
`lastStoredKind: chat_error` for everything from a transient page failure to a conversation the
app can no longer open, and the accompanying `noProgressForMs` measures the chat, not the
worker. On 2026-09-12 two chats in that state were genuinely gone — `say`, `revive` and three
retries each expired — while a third, showing the same state and fifty-four minutes of no
progress, accepted a push on the first attempt and resumed. Replacing it on the state alone
would have thrown away a working chat and its context.

So the ordering is: attempt, then classify. A chat that takes a message is alive whatever its
last stored row says; a chat that refuses `say` and `revive` in succession is the one to
replace, and `just new` is what distinguishes a dead chat from a broken substrate.

**A handoff that reads like a plan gets a plan back.** A replacement brief naturally ends on a
disposition — "keep taking the frontier without stopping between pieces" — and a fresh chat
answers a disposition in kind: *"I'll reconstruct the position, read the contribution rules,
identify the next units, and then proceed piece-by-piece."* Turn ends, no tool calls, nothing
banked, and the repository stays dry while the steward counts the chat as launched because it
replied. Eight minutes of that is indistinguishable from a chat that is working.

End the brief on one concrete first action instead: the exact command to run, the exact file to
open, and an instruction to bank something before writing another sentence. Context, ownership
and constraints still belong in the brief — a worker that does not know the tree has a live
predecessor's scratch in it will delete it — but they are the middle, never the last thing the
chat reads. A chat that has already acknowledged and stopped does not need replacing for it;
one push naming the first command is usually enough, and replacing a chat twice for the same
symptom is a sign the brief is the problem rather than the chat.

**A browser restart can strand every chat whose tab was open, and a new chat is the test that
tells you whose fault it is.** Reclaiming memory by restarting the browser is cheap and usually
free, but it is not always: on 2026-09-12 a restart left three of four chats at `chat_error`
with `This content is unavailable` and `Failed to load subscription`, and the app could not
re-establish any of them — `say`, `revive` and repeated retries all expired, while the one chat
whose tab predated the restart kept working normally. Two repositories sat dry for the better
part of an hour.

That shape has two readings that call for opposite actions: a substrate fault, where replacing
chats is futile because the replacements will fail the same way, or genuinely dead chats, where
replacing is the only route. `just new` separates them for the price of a chat you would need
anyway if replacement is the answer. If a brand-new chat delivers and starts a turn, the
substrate is fine and the stranded chats are dead — archive and replace them. If it expires
too, stop replacing and repair the app.

The restart itself stays worth doing, because memory pressure OOM-kills workers' own
`exec_command` sessions, which is more expensive than losing a chat. But price it correctly:
it is not a free reclaim, it is a reclaim that may cost every chat currently open, so take it
at a moment when the fleet is between turns and be ready to re-establish all of them.

Check for an in-flight commit in a *separate command* before composing the restart, never in
the same one. On 2026-09-12 a steward chained `pgrep -af 'git commit'` and the restart with
`&&`, read the output afterwards, and saw `git commit --only corpus/collections/SRC-CH7-GROUP-S`
in the very output that confirmed the restart had already run. The commit died in its gate and
orphaned the lock — the outage the rule exists to prevent, caused by the check being inside the
action instead of before it.

Reach for it second. `just tidy` with the live chats in `keep` closes duplicate and orphaned
command tabs and costs nothing — each one is a renderer, and on 2026-09-12 closing two of them
took a host from 261 MB free back to 485 MB with every worker still on the air. Restart only
when tidying leaves nothing to close and the floor is still falling, and never while a worker
has a commit in a slow gate: killing that commit orphans the lock and stops the repository,
which is worse than the pressure you were trying to relieve.

**The steward filing a queue item is a second agent on that index, and on a slow gate it is
the one blocking the worker.** One-worker-per-repository is usually read as a rule about
chats, but a queue filing takes the same single index and runs the same commit gate, and on a
repository whose gate walks ten thousand files that is minutes during which the worker's own
commits are refused. On 2026-09-12 a steward cleared a stale lock off `new-qual-site`, told its
worker to resume, and then took the lock itself for a queue filing — replacing a dead blocker
with a live one.

Two consequences. Do not run a steward commit detached and unwatched on a repository with an
expensive gate: if it dies — and memory pressure kills exactly these — it orphans the lock and
stops the repository, which is the outage the filing was meant to prevent. And where the gate
is slow, prefer handing the item to the worker in the push that tells it about the finding
rather than committing it yourself; the worker is already inside that gate and pays nothing
extra to carry one more file.

**A lock you keep meeting is not a busy worker — check its age and whether anything holds it.**
The two cases look identical at the point of failure and mean opposite things. A live
`git commit` behind the lock is the worker banking, and the steward waits. A lock with no
process behind it is a dead commit that has been refusing *every* commit in that repository
since the moment it was orphaned, including the worker's own — so the repository is not slow,
it is stopped, and waiting politely extends the outage. On 2026-09-12 `new-qual-site` sat
twenty-two minutes dry behind a lock from a commit that died at 00:27:50, while the steward
read the repeated refusals as a busy index and queued behind it.

Two facts separate them and both are one command: `ls -l --time-style=+%H:%M:%S
.git/index.lock` for its age, and `pgrep -ax git` for whether anything is holding it. A lock
older than the repository's longest gate with no git process behind it is stale. Move it
aside rather than deleting it — the dead commit's index may be the only copy of what it was
staging — then tell the worker what happened and to check whether the dead commit left
anything half-applied, because it will otherwise re-run against a tree it does not know
changed.

**Filing into a busy repository means queueing behind its worker, and the attempt must fail
loudly.** A queue item is the steward's one sanctioned write into a managed repository, and it
competes for the same single index the worker is using. A worker committing every few minutes
holds `.git/index.lock` most of the time, so a filing attempt meets it far more often than not
— and the append lands in the file while the commit does not, which leaves the item sitting in
the working tree as more of exactly the churn it was filed to describe.

Wait for the lock rather than clearing it; a lock with a live `git commit` behind it is the
worker banking, not a stale artifact. But make the waiter report what happened: a retry loop
that suppresses output and exits zero after its attempts reads as success, and the steward then
carries a filing it never made into the next tick. Distinguish the lock from every other
refusal, and say which one ended the wait.

**Classify a dirty tree before characterising it; `--stat` counts lines, not content.** A tree
of 98 modified paths carrying 1230 insertions reads like a worker sitting on a day of
unbanked authoring, and on 2026-09-12 a steward told one so, citing the 962 lines this
repository lost that way. Measured, 76 of the 98 differed from `HEAD` only in line breaks —
markdown reflow, byte-identical with newlines collapsed — and the real content was 22 files,
almost all of them the ingest the worker was actively writing. Interrupting it to "bank the
tree" would have stopped the only authoring in flight to commit a formatter's output.

The classification costs one loop and no judgement:

```bash
for f in $(git status --porcelain | awk '$1=="M"{print $2}'); do
  a=$(git show HEAD:"$f" | tr '\n' ' ' | tr -s ' '); b=$(tr '\n' ' ' < "$f" | tr -s ' ')
  [ "$a" = "$b" ] || echo "REAL: $f"
done
```

Churn that never gets committed is still worth filing — a tree whose `git status` cannot be
read is where authored work goes missing unnoticed — but it is a queue item for the repository,
not an intervention against its worker.

**A moved clock verifies that a worker acted, not that it did what you asked.** The rule to
verify against a commit rather than a receipt has a hole in it: any commit moves the clock,
including one that answers the instruction with paperwork. Told to bank a tree carrying 1230
uncommitted insertions of authored cards, a `new-qual-site` worker committed a queue document
titled `docs(queue): bank Pantano PDF intake` and left the dirty count at 98, exactly where it
started. The clock moved, the subject line used the word, and nothing was banked.

So when an instruction names a measurable state change, verify the measurement and not the
commit: the dirty count for a banking push, the queue's own regenerated count for a completion
push, the tracked-file list for an ingest. Put the measurement in the instruction too — say
what number you are watching and that the commit subject is not what you will read — because a
worker that knows which number is being checked stops reaching for the paperwork that would
otherwise satisfy it.

**A turn that starts and emits nothing is the replace signal, and it is quiet.** The familiar
wedge announces itself — a chat error, a refusal, a stall bar. This one does not: the bridge
reports `lastStoredKind: turn_start` and `generating` back to false with no rows in between, so
the chat looks like it is simply between turns. Two of those in a row, with the repository's
clock frozen across both, is a chat that can still accept messages and can no longer act on
them. Pushing it a third time buys nothing; every push lands, and nothing happens.

When that chat's transcript is also frozen — and it usually is, since the same lost observer
explains both — the handoff cannot be read from the chat at all. Reconstruct position from the
repository instead: the ordered list of what it banked before it stopped is a better statement
of where the frontier is than anything the chat would have said, and any generated scheduling
document the repo maintains says what comes next. Add the constraints that cost the previous
workers time rather than the ones in the repo's own docs, which the new worker will read anyway.

**A wedged chat is usually holding unbanked work, and the replacement is the only thing that
can find out.** The steward must not go into the repository to bank it — that is the worker's
job and the tree has one index — but the handoff has to name it, because a fresh worker walking
into a tree with thousands of modified lines it did not write will read them as debris and
reset them. Size the loss before writing the brief: `git status --porcelain | wc -l` and
`git diff --stat | tail -1` cost nothing and turn the handoff from "continue node X" into
"37 modified files, 4362 insertions, evaluate and bank what is correct, do not reset the tree."
A `sage-categories` worker wedged on `Message delivery timed out` holding exactly that, one
node short of banking it.

The rest of the brief is what the wedged chat can no longer tell anyone: which node it was on,
what shape the repository's tracked surface has (a DAG table is not a checklist, and an absence
of checkboxes is not an absence of work), which of that node's prerequisites are externally
owned so the new worker does not wait on them, and the last concrete thing the old worker said
it was about to do. That last sentence is worth more than the rest combined — it is the only
part a fresh worker cannot reconstruct from the repository itself.

**Do not diagnose a stubbornly wedged chat. Replace it.** Read the transcript tail, write a
short handoff — ambient task, tracking documents, current item — and `just new`. An hour spent
finding out why one chat will not accept a message is an hour of three chats not working, and
the handoff costs minutes.

**Alarm on available memory, not free memory.** `free` is the wrong column and watching it
manufactures emergencies: Linux spends everything it can on page cache, so a healthy host with
three gigabytes of reclaimable cache reports a hundred megabytes free and looks minutes from
death. The number that says whether the next allocation succeeds is `available`. On 2026-09-12
a steward alarmed at 135 MB free while `available` stood at 2.8 GB, restarted the browser on
that reading, and killed a worker's commit in its gate — the emergency was in the metric, not
the host. Watch `free -m | awk 'NR==2{print $7}'` and treat a few hundred megabytes *available*
as the floor, not a few hundred free.

**The browser is a fleet-wide resource and long-running chats exhaust it.** Each managed chat
holds a renderer whose cost grows with its transcript, and every send opens a command tab that
a send which never redeems leaves behind. On 2026-09-11 four chats and eleven orphaned command
tabs held 2.3 GB on an 8 GB host with 450 MB free and 10 GB swapped — and memory pressure is
the named cause of the dead-process wait in the hourly sweep, because it is the OOM killer that
takes the workers' `exec_command` sessions. So read memory as a fleet metric, not a host
curiosity: `free -m` alongside `df -h`, and `ps -eo pid,rss,pcpu --sort=-rss` when it is tight.
Restarting `chat-on-steroids-browser.service` reclaims it and the app reopens the chats.

Closing a chat's tab does not stop its worker — the turn runs at ChatGPT and the `exec_command`
sessions run on this host — but it does take the chat off the air until the next send reopens
it, and the app records the gap as `This content is unavailable or could not be found`, which
reads exactly like a wedged chat. Check the repository's clock before believing that row.

Three things break every chat at once and none of them is the chat:

- **The app's bridge is not listening.** The app can be running, small and idle, with nothing
  on 8765-8769. Every send fails and nothing says why. `just install` restarts it.
- **A runaway process from a chat's `exec_command`.** It is orphaned to init, keeps the app's
  path in its argv so it looks like the app in `ps`, and holds a core indefinitely. Check for a
  process burning CPU for many minutes and kill it.
- **ChatGPT's model slider left on a mode that is out of usage.** The chat cannot answer, the
  app has no way to leave that mode, and every send into it fails. Replacing the chat does not
  help; the slider has to be changed.

## Tabs, memory, rate limits and the browser

**Count tabs from the browser, never from `just tabs`.** Both `tabs` and `tidy` match only URLs
containing `/c/<id>`. A tab sitting on bare `chatgpt.com` is invisible to them: it is never
counted and never closed. A run once reported "14 tabs → 4" every twenty minutes while the
window actually held 144, because 139 of them were blank. Count what the browser reports:

```bash
curl -s -m 5 http://127.0.0.1:9222/json | python3 -c "import json,sys; p=[t for t in json.load(sys.stdin) if t.get('type')=='page' and 'chatgpt.com' in t.get('url','')]; print(len(p), 'tabs,', len([t for t in p if '/c/' not in t['url']]), 'blank')"
```

Blank tabs should stay near zero, since the service worker closes a command tab whose command
never acknowledged. Dozens of them means that has regressed. Close a tab directly through
`http://127.0.0.1:9222/json/close/<target id>`.

**A `woke_ready` event does not mean a conversation can be driven with no tab. Keep one
tab per managed conversation.** This rule replaces the one below it, which was written on
2026-09-11 from a single morning's observation and stopped the fleet that same afternoon.
What follows the arrow is the retraction, not the advice.

**Read the tab titles first.** `Just a moment...` is Cloudflare challenging the browser, and
it is the cheapest fleet-wide diagnostic there is — one `curl` against `/json`, no DOM
probing:

```bash
curl -s -m 5 http://127.0.0.1:9222/json | python3 -c "import json,sys; p=[t for t in json.load(sys.stdin) if t.get('type')=='page']; print(sum(1 for t in p if 'Just a moment' in (t.get('title') or '')), 'of', len(p), 'challenged')"
```

A challenged tab is indistinguishable from a wedged chat through every surface a steward
normally reads: the turn stays marked generating, nothing renders, the ten-minute watchdog
fires, `/send` returns `expired` or `no_live_composer_tab`, and `just new` reports
`No tab produced a usable composer`. It also poisons recorded state — a conversation's
`meta.json` title becomes the literal string `Just a moment...`, so a roster read from
titles is wrong in a way that looks like a dead stream. On 2026-09-11 six of sixteen pages
were challenged; a steward spent forty minutes on send-path verbs, substrate checks and a
DOM probe for a rate-limit modal before looking at the titles. `Page.reload` with
`ignoreCache` cleared all six, and repositories that had been silent for over an hour
committed within minutes.

The reasoning behind the retracted rule was: `/sleep/status` shows `slept` → `wake_started`
→ `woke_ready` cycles, the turn runs on chatgpt.com's servers, so the tab is only a view and
can go. Tabs were closed for every conversation with a `woke_ready`, taking the browser from
107 pages to 8. The fleet kept working for about two hours, which read as confirmation and
was not.

**The two causes compound, and the tab rule is what made the first one fatal.** Cloudflare
was the trigger; a thinned tab pool was why it took everything down at once. At 107 tabs
there are always already-cleared pages to fall back on and a challenge wave is absorbed
invisibly. At 8 there is no slack, and the same wave removes every path to every worker
simultaneously. Keeping one tab per conversation is the floor, not the target — it is
enough to be reachable and not enough to survive a challenge wave, so expect to clear
challenges by hand when the pool is thin. What happened after the pool was thinned: every managed repository went to zero writes for over an hour, `/send`
returned `expired` or `refused` for six of eight pushes, `just new` failed with
`No tab produced a usable composer for this chat`, and turns that did start rendered
nothing until the ten-minute watchdog killed them. Reopening one tab per conversation
restored delivery immediately — three of five pushes `delivered` where two of eight had
before — and the first repository commit landed within ten minutes.

Two lessons worth more than the rule they replace. **A sleep/wake cycle recorded in
`/sleep/status` proves the conversation slept and woke while a tab existed; it is not
evidence that the wake path can materialise a composer from nothing.** And **a fleet that
keeps working for two hours after a change has not validated it** — the tabs already open
were carrying the work, and the damage surfaced only when those conversations needed a
fresh composer.

What is still true from the original finding: every `/send` opens its own command tab
carrying a distinct `clf` token and nothing closes it, so duplicates accumulate one per
push and are the fleet's largest memory cost. Collapsing **duplicates** is correct and
recovered about 2 GB. Collapsing to **zero** is what broke it. Keep one tab per managed
conversation — prefer one whose URL carries `clf=`, which the app has adopted — and close
the rest.

---

*Retracted 2026-09-11 — see above. Retained so the next steward recognises the reasoning
if it re-occurs to them.*

**~~A conversation that has woken tablessly needs no tab at all, and tabs are the fleet's
largest memory cost.~~** Every `/send` opens its own command tab carrying a distinct `clf`
token, and nothing closes it afterwards, so tabs accumulate one per push for the life of a
stream. On 2026-09-11 the browser held **107 pages for 16 conversations** — one chat alone
had fourteen, another thirteen, twenty-seven were blank — at 4.4 GB of Chrome on a host with
7.9 GB total and 286 MB free. Collapsing it to 8 pages returned about 2 GB, which on this
box is the difference between workers running and workers swapping.

The tab is a view, not the conversation: the turn runs on chatgpt.com's servers and
`session/sleep-wake.ts` (§14) wakes a slept conversation with no tab open. So the question is
not whether a chat is busy, it is whether that chat has a proven wake path. Read
`/sleep/status` and keep a tab only for a conversation with no `woke_ready` event — one that
has never completed a wake cycle has nothing to wake it, and closing its last tab strands it
behind `no_live_composer_tab`:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/chat-on-steroids/state/local-token)" \
  http://127.0.0.1:8765/sleep/status |
  python3 -c "import json,sys; e=json.load(sys.stdin)['events']; print(sorted({x['conversationId'][:8] for x in e if x['kind']=='woke_ready'}))"
```

~~Everything with a `woke_ready` can lose every tab it has.~~ **Retracted — this is the
sentence that stopped the fleet.** Collapse duplicates to one per conversation and stop
there, preferring a tab whose URL carries `clf=`, which is one the app has adopted.

**This is tick work, not spring cleaning.** Tabs accrue at the rate you push, so the sweep
belongs in every check-in beside reading the fleet, and it costs one command:

```bash
just tidy 45 "$(just chats 5 2>/dev/null | grep -vE 'sitecustomize|ModuleNotFound' \
  | awk -F'\t' 'NF>1 && $2!=""{print $2}' | sort -u | paste -sd,)"
```

Check the keep list is non-empty before trusting that line. If `just chats` returns nothing
— the app down, the bridge not listening — the substitution collapses to `""` and `tidy`
archives every quiet conversation in the browser, including the whole managed fleet. An
empty keep list is never correct while streams exist.

`tidy`'s two arguments are what make it safe, and its behaviour is not what its name
suggests. It closes duplicate tabs for **every** conversation unconditionally, keep-listed or
not, which is most of the win. It archives only a conversation quiet longer than the first
argument *and* absent from the second — so the keep list must be the live fleet, computed
fresh in the same command, never a remembered one. A chat with no recording at all is kept
regardless. Follow it with the blank-tab close above, since `tidy` matches only
`chatgpt.com/c/` and cannot see a blank, and with the `woke_ready` close, since `tidy` always
leaves one tab per conversation.

**Archive before you close the last tab — the two rules above conflict in that order.**
`tidy` walks DevTools targets, so it only ever sees a conversation that still has a tab
open. A chat whose tabs you closed on the strength of a `woke_ready` is invisible to it:
it cannot be archived, and it stays in `just chats` attracting pushes forever. Observed
2026-09-11 — a cold lean stream sat through a full sweep untouched because it was already
tabless, while every chat that still had one was correctly kept or archived. So retire in
this order: decide the chat is finished, archive it, *then* close its tabs. The tab-closing
economy applies to chats you intend to keep working; a chat you intend to retire needs its
tab for one more command. If you find an already-tabless chat that should be retired, open
one on its conversation URL and archive through that, rather than leaving it in the roster.

**Archive a chat the moment it is known finished; do not leave it idling.** A worker that has
run out of scope says so plainly — "no remaining TODO in the collection-defined scope",
"nothing further to execute within the assigned scope" — and answers every further `Continue`
the same way. That chat is done: it will never produce again, it holds tabs and browser
memory for as long as it stays open, and it pads the fleet count so a real stall hides inside
an apparently healthy roster. Retiring it is the same verb as re-scoping it — archive it,
close its tabs, drop it from the keep list — and it is the steward's call, needing nobody's
permission. The distinction that matters is **finished versus merely quiet**: quietness alone
is why `tidy` needs an accurate keep list, and finishedness is read from what the chat last
said, not from its clock.

**An idle chat refused while its neighbours work is now a bug, not the design.** The gate that
refuses is the content script's own `pendingTools`, refreshed on its activity loop; the count
`just say` prints is the app's, sampled once at the POST, so the two can disagree. Until
2026-09-10 `countFor` in `src/main/mcp/call-context.ts` charged a call with no `conversationId`
against **every** conversation, so two chats running `exec_command` back to back held a third
unreachable — and at fleet width one unplaced call was always in flight, which closed the
control path entirely (four repositories idle for ten minutes, no chat reachable, and no way
in: the gate cleared only when the workers it was waiting on finished by themselves). An
unplaced call is now charged only against conversations the app cannot observe to have been
quiescent when it arrived (`recorder.ts::mayOwnUnattributedCall`, §11), which is evidence
rather than a timer and leaves the compaction barrier's own chat charged exactly as before.
If an observably idle chat is refused again, read `inFlightCalls` off the refusal: an
`unattributed` row against an idle chat means the recorder never watched that chat's last turn
end, which is the fact to go and fix. Do not replace the chat — a replacement needs the same
send path, and the chat has real in-flight work — and neither dismissing the app's error notice
nor reloading the tab does anything.

**Most chat deaths are ChatGPT's, not this app's.** A steward watching several chats will see
them go cold one after another and reach for a local cause. Check who wrote the error string
first. "A network error occurred. Please check your connection and try again." and "Message
delivery timed out." appear nowhere in this repository — the extension read them out of
chatgpt.com's own DOM. Only "No visible progress for ten minutes. The turn is still marked as
generating." is ours, at `extension/content.js`, and it is a watchdog for a turn that stays
marked generating while nothing renders. A turn that never completes cannot emit a tool call
either, so a chat whose `tool_call` events stop is showing the same upstream stall, not a
separate broken connector. Replacement is still the remedy — a wedged conversation stays
wedged and a fresh one gets a clean turn — but do not go looking for a local defect to fix,
and do not read a run of these as this app degrading.

**A chat sitting on a rate limit is not dead, and reopening its tab will not free it.** The
limit arrives as a modal dialog whose only control reads "Got it", it leaves the Stop button in
place so the page still looks like it is generating, and it belongs to the conversation rather
than the tab — so a reopened tab shows the same dialog. The content script clears this itself:
dismiss, Stop, `Continue`, on a five-minute floor. Leave such a chat for a tick and push it on
the next. A chat still showing that dialog after two ticks means the recovery has regressed.

**Two chats showing that error in one tick is the account, not the chats.** Retry dispatch or pushes at stepped intervals: 30s, 1m, 2m, and 5m. Defer pushing or replacements to the next tick only when repeated rate limits persist across those retries. One chat can be limited while others run normally, so test whether any chat accepts a push before declaring an account-level block.

**Do not open several chats at once.** That is a burst of requests from one account and it earns
the limit described above, which then lands on the chats themselves. Recovery already spaces the
tabs it opens; a steward should space its own pushes the same way.

**Judge a wedge by the *kind* of row the clock moved to.** A push that moves the clock only to a
`page_tool`, a `chat_error`, or a turn ending without work has not woken anything. A `turn_start`
right after a push is alive. A chat that answers one push and refuses the next with an unmoved
clock is dead.

**The recording is the only evidence that a chat is still working.** A chat that has lost the
connector can still talk: it answers every push, reports progress, and describes work it never
did, because reasoning and writing fail separately. Its `tool_call` events are the proof, so
sample the newest one per chat each tick and compare them against each other — a chat at
forty-five minutes beside siblings at seconds is cold, whatever it says:

```bash
dir=$(grep -rl "<conversation id>" ~/.config/chat-on-steroids/sessions/*/meta.json | head -1 | xargs dirname)
grep '"kind":"tool_call"' "$dir/events.jsonl" | tail -1 | sed -n 's/^{"time":\([0-9]\+\).*/\1/p'
```

Never scan a recording with `jq`. Some contain an invalid surrogate-pair escape that makes it
abort mid-file, and with stderr hidden it then reports the newest call among only the lines
before the bad one — a healthy chat looks frozen for hours. Line-wise `grep` and `sed` read the
whole file. The confirming signature of a cold chat is consecutive `turn_start`/`turn_end` pairs
with outcome `unknown` or `failed` and no `tool_call` between them. A brand-new chat with no
calls yet is not stale, and neither is asking a chat to run a shell command to prove itself: it
answers from its own sandbox, and only the recording settles it.

**A worker polling a dead process defeats that test, so check the host too.** The one state
the recording cannot distinguish is a chat waiting on a long-running `exec_command` session
that has already been killed — by a daemon restart, or by the OOM killer on a loaded box. Its
calls keep flowing because polling *is* a call, the transcript stays specific and plausible,
and the progress figure it quotes is real but frozen. Nothing inside the chat can see that the
process is gone. So when a chat says it is waiting on a build, a hook or a test run, confirm
from outside that the thing exists — the process, and fresh writes to whatever it produces:

```bash
/usr/bin/ps -eo pid,etime,pcpu,args | grep -iE 'lake|lean|sage-eval|pytest' | grep -v grep
find <repo>/<build dir> -newermt '30 minutes ago' -type f | wc -l
```

**The poll loop itself is not the signal — the PID is.** A transcript tail full of
`ps -p 453381` followed by `Waited on session`, repeating for minutes, reads exactly like the
dead-process trap and is also exactly what correctly watching a live six-minute test looks
like. The two are indistinguishable from the loop alone, and on 2026-09-12 a steward read a
worker's careful liveness polling as the trap and was one step from replacing a chat that was
running the Sets engine suite at 46% CPU. Resolve it the only way that settles it: take the PID
out of the loop and ask the host whether it exists.

```bash
ps -p <pid> -o pid=,etime=,pcpu=,args=    # empty output is the trap; a running line is work
```

A worker that polls with `ps -p <pid>` on every cycle is doing what its own documentation asks
of it. Punishing that pattern teaches workers to wait blindly instead.

No process and no new artifacts means the wait will never end. Tell the chat plainly — that is
external context it cannot obtain, not a hint about method — and say what the host looks like
now, so it does not relaunch a multi-thousand-job build into a machine that cannot carry one.

**`say`'s verdict is not evidence; the chat's clock is.** It reports failure whenever no receipt
arrives inside its window, and under the send gate above most pushes report refused and land
anyway. Always re-read `just chats` afterwards and judge by whether the clock moved. When a push
is genuinely refused, push a different chat in the same window: if that one moves into real work,
the bridge is fine and the gate is transient rather than the first chat being dead.

**Carry findings into the handoff, not just the task.** A replacement that has to rediscover
which corpus block is already promoted, or that a repository's commit gate reports a known
baseline of pre-existing errors, spends its first hour re-deriving what the dead chat already
knew. Read the transcript tail for what it established and put that in the message. Check
`git status` too: uncommitted work belongs to the previous owner and must be built on, and
untracked files it left are its work rather than debris.

Three things belong in every handoff and are cheap to establish. Name the timestamp of the
predecessor's last `tool_call` and say plainly that anything it claimed after that point is
unverified reasoning rather than landed work. List its scratch files in `/tmp` by name, since
they hold search work a replacement will otherwise repeat — and when two chats share a subject,
ownership of a file is decidable rather than guessable:

```bash
grep -l "<filename>" ~/.config/chat-on-steroids/sessions/*/events.jsonl
```

Name its long-running `exec_command` session ids as well. Those sessions outlive the
conversation, and `write_stdin` against one from a different chat is refused by the ownership
rule, so a replacement that inherits an id without being warned reads that refusal as a broken
tool instead of starting its own session.

**Two small traps in the surrounding tools.** `ps` on this machine is aliased to `exa`, which
rejects the flags a parent-process check needs — use `/usr/bin/ps -o pid,ppid,etime,args -p <pid>`
before deciding whether a CPU-heavy process is a chat's orphan or another session's test run
already wrapped in its own `timeout`. And `agent-memory sync status` carries a `last_failure`
whose vault path is under `/tmp/pytest-of-dzack`; that is a test fixture, not this vault, and it
does not mean a sync is broken.

**Two chats on one body of work will duplicate it.** When they share a task, tell each
replacement to check what has already landed and to reuse recorded audits; and when one chat's
transcript shows that a unit another was told to start is already done, send that correction to
the chat holding the stale instruction rather than letting it find out.
## Instruments that have misled a steward

Every mistake in this section has been made, and each one turned a working fleet into a
reported outage. They share a shape: the steward measured its own machinery and reported
the answer as a fact about the work.

**The fleet's output is in the repositories, not in your outbox.** Whether a push landed
says nothing about whether the program moved. `git log --all --since=...` in each managed
repo is the measurement, and it is two seconds away. On 2026-09-10 a steward reported "no
file written in any managed repo for ten minutes, no commits for twenty" and declared an
app-wide deadlock; `new-qual-site` took eight commits in that exact window, seven of them
on `main`, and they were solved algebra problems and recovered analysis proofs. The
workers were fine. What had stopped was the steward's ability to push, and it never
checked the difference. **"I cannot reach a worker" and "the fleet is stopped" are
different claims and need different evidence.**

**Never tell a worker its process is dead on the strength of missing artifacts.** The
liveness test is the process, and specifically whether a child's cumulative CPU is
advancing between two samples — not whether files have appeared. Long stages write
nothing for many minutes: a Lean exporter or axiom audit can run for the better part of
an hour with zero writes under `.lake/build` while doing real work. On 2026-09-10 a
steward saw no artifacts in five minutes, told a worker its build was gone and to stop
re-running it, and the build was in fact alive and had simply moved to a stage that
writes nothing — the message was a instruction to abandon work in progress. Sample
`/usr/bin/ps -o pid,times,pcpu --ppid <pid>` twice, twenty seconds apart, and read
`times`; only "no process at all" is death. **And a false statement to a worker has to be
retracted immediately and confirmed landed** — it will act on the wrong fact within one
turn, and the chat is usually busy doing exactly that, so the retraction must be retried
until it delivers rather than left for the next tick.

**Archive a conversation the moment it stops being a managed stream.** Every replaced
worker, retired duplicate, failed launch and one-off probe stays in the owner's ChatGPT
sidebar forever unless somebody archives it, and a day of stewarding produces dozens.
They are not only clutter: a steward reading `just chats` has to tell live streams from
dead ones on every tick, and a dead chat that still answers is exactly how duplicate work
starts. `just archive <full conversation id>` takes a chat whether or not it has a tab
open and is reversible, so there is no reason to defer it. Archive as part of the same
action that ends the stream — when you launch a replacement, archive the predecessor;
when a launch fails and leaves an empty chat, archive it then — rather than letting a
cleanup pass accumulate. On 2026-09-11 the sidebar held thirty-six conversations of which
eight were live.

**A send batch the harness kills is not a failed send.** Under memory pressure the
steward's own shell gets killed mid-batch, so the terminal states for the remaining
pushes never print — and on 2026-09-11 that happened three times in one hour while every
one of those chats went on to move its clock. Read the outcome from `just chats`, never
from whether your batch survived to report it. The corollary is to keep batches small
when memory is tight: a batch of six serial sends holds a shell for ten minutes and is a
fat target, where two batches of three usually both survive.

**Count the browser's tabs every tick; they accumulate and they degrade the control
path silently.** Tab count is a substrate metric like disk and load, and it is the one
that presents as chat trouble rather than as a browser problem. As it climbs, sends
start returning `expired` and `no_live_composer_tab` — *"ChatGPT never exposed a usable
composer for bootstrap"* — and `just new` stops working, so replacements cannot be
launched exactly when wedged chats make them necessary. On 2026-09-10 it reached 47 and
every new-chat launch failed; hours later it reached 100 and sends were expiring across
the whole fleet. Restarting `chat-on-steroids-browser.service` clears it, costs nothing
that is not recreated on demand, and on both occasions the next send landed immediately.
Read it with the CDP endpoint rather than `just tabs`, which only matches `/c/` URLs:

```bash
curl -s -m 8 http://127.0.0.1:9222/json | grep -c '"type": "page"'
```

**Check the substrate before you blame the app.** `df -h`, `uptime`, `/usr/bin/ps` — a
few seconds, before any theory about attribution tiers or gates. A full volume does not
present as a disk error; it presents as killed processes, dying `exec_command` sessions
and workers that look like they have gone stupid, and it reads as worker misbehaviour for
hours until somebody runs `df`. In the same 2026-09-10 window a worker committed
`docs: clear resolved filesystem blocker` while the volume filled from 27 duplicated
worktrees, and the steward diagnosed an attribution deadlock instead. The
cheapest check that could refute your hypothesis goes first, not last.

**You are inside the system you are measuring, and your remedy is part of the load.**
Every send opens a command tab and counts against every chat's gate, so pushing harder
into a saturated fleet produces fewer deliveries, not more. If your corrective action
makes the symptom worse, stop treating the symptom as external. The steward that filed
the deadlock complaint had written exactly this mechanism into the header comment of its
own push loop, and left the loop running.

**Queued is not failed.** A send that ends in state `queued` is held by the app and typed
when the page's in-flight calls settle. Re-sending stacks a second queued message for the
same chat and consumes the gate the first one is waiting on. Read the terminal states —
`sent_verified`, `typed_unverified`, `refused`, `expired` — and treat everything else as
in progress. The same applies to `just say` printing a hint and waiting: that is the app
working, not the app stuck.

**"There is no way in" is nearly always false; enumerate what you still have.** You have
a shell. You have every read-only route on the bridge (`/conversation/status`,
`/sleep/status`, `/send/outcome`), every managed repository's git history, the process
table, and the disk. A steward that concludes it is locked out has usually stopped at the
first closed door — the composer — and not looked at the room. Before escalating a
control-path failure, state which of those you checked and what they said.

**A rule reaches workers only where workers read.** Fleet-level documents in this
repository are read by the steward and by nobody else. A worker follows its own repo's
`AGENTS.md` and `CONTRIBUTING.md`, and if those say something different, that is what
happens — regardless of how many times the rule was explained in chat or written into a
schedule here. `new-qual-site` rebuilt 27 worktrees and filled the volume while the
no-worktrees rule sat in `FANOUT-SCHEDULE.md`, because its own `AGENTS.md` still carried a
`# Worktrees` chapter telling every stream to open one. **And a rule that has already been
restated once needs an enforcement point, not a third restatement** — a check in that
repo's commit gate, so the next stream that violates it finds out at its next commit
instead of at 100% disk.

