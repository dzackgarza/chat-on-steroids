# Steward incident evidence

The dated failures behind the principles in `AGENTS.md` §19, "Principles learned from observed
failures". Each essay is kept verbatim as the evidence its principle was derived from. The
operative content lives in `AGENTS.md`: each lesson is stated there once, as a principle with its
test or as an operational fact, so a steward never has to read this file to act correctly.

Read an essay here when a principle's application is unclear, or when a new failure seems not
to fit any principle. Before writing a new rule, check whether the failure is a new form of an
existing principle. If it is, add the incident here and amend that principle in `AGENTS.md` only
if its test would not have caught it. A new principle is justified only by a failure that no
existing test would have caught. Never add a rule shaped like the incident's mechanism, because
the next instance will take a different shape (P1).

| # | Incident | Where the lesson lives in `AGENTS.md` §19 |
| --- | --- | --- |
| 1 | [A chat that stores your message and never starts a turn is dead](#a-chat-that-stores-your-message-and-never-starts-a-turn-is-dead) | P2 · fact |
| 2 | [`noProgressForMs` equal to `generatingForMs` means unrecorded, not stalled](#noprogressforms-equal-to-generatingforms-means-unrecorded-not-stalled) | P2 · fact |
| 3 | [Ask the host what the worker cannot see](#ask-the-host-what-the-worker-cannot-see) | P4 · fact |
| 4 | [A chat that stalls the same way twice earns a shorter horizon](#a-chat-that-stalls-the-same-way-twice-earns-a-shorter-horizon) | P4 |
| 5 | [Before pushing a chat, confirm no newer chat owns its repository](#before-pushing-a-chat-confirm-no-newer-chat-owns-its-repository) | P9 |
| 6 | [A worker can report a commit from the wrong repository](#a-worker-can-report-a-commit-from-the-wrong-repository) | P9, P4 · fact |
| 7 | [Gated paperwork reappears in the nearest ungated form](#gated-paperwork-reappears-in-the-nearest-ungated-form) | P1 |
| 8 | [A watcher that reports next tick is carrying the intervention into the next tick](#a-watcher-that-reports-next-tick-is-carrying-the-intervention-into-the-next-tick) | P10 |
| 9 | [A recorded failure set goes stale in one direction and nobody is watching it](#a-recorded-failure-set-goes-stale-in-one-direction-and-nobody-is-watching-it) | P5, P9 |
| 10 | [A blocker that spans two repositories is only visible to the steward](#a-blocker-that-spans-two-repositories-is-only-visible-to-the-steward) | P9 |
| 11 | [Space `du` cannot account for is held by deleted-but-open files](#space-du-cannot-account-for-is-held-by-deleted-but-open-files) | P6 · fact |
| 12 | [Gate churn accumulates in caches, and the reclaim is smaller than the tool claims](#gate-churn-accumulates-in-caches-and-the-reclaim-is-smaller-than-the-tool-claims) | P6 · fact |
| 13 | [Attribute a host trend before escalating it, and expect it not to be the fleet](#attribute-a-host-trend-before-escalating-it-and-expect-it-not-to-be-the-fleet) | P6 |
| 14 | [`git log --diff-filter=A` does not see merges, and a jump is as likely a merge as production](#git-log---diff-filtera-does-not-see-merges-and-a-jump-is-as-likely-a-merge-as-production) | P2 · fact |
| 15 | [One tick is a sample; a trend needs the buckets](#one-tick-is-a-sample-a-trend-needs-the-buckets) | P6 · fact |
| 16 | [Read the age distribution of a dirty tree, not its size or its signature](#read-the-age-distribution-of-a-dirty-tree-not-its-size-or-its-signature) | P2 · fact |
| 17 | [A tree signature says nothing on its own, because committing restores an earlier one](#a-tree-signature-says-nothing-on-its-own-because-committing-restores-an-earlier-one) | P2 |
| 18 | [A true explanation becomes an excuse the second time you reach for it](#a-true-explanation-becomes-an-excuse-the-second-time-you-reach-for-it) | P6 |
| 19 | [Shared tooling that prints for a human is a context tax on every agent that calls it](#shared-tooling-that-prints-for-a-human-is-a-context-tax-on-every-agent-that-calls-it) | P10 |
| 20 | [When a worker will not do a cheap thing, price it before pushing again](#when-a-worker-will-not-do-a-cheap-thing-price-it-before-pushing-again) | P4 |
| 21 | [Closing finished nodes is the steward's work, and an unmarked one stays ready forever](#closing-finished-nodes-is-the-stewards-work-and-an-unmarked-one-stays-ready-forever) | P8 |
| 22 | [Correcting a total does not correct the worklist built from it](#correcting-a-total-does-not-correct-the-worklist-built-from-it) | P7 |
| 23 | [A count with a moving denominator is not a progress measure](#a-count-with-a-moving-denominator-is-not-a-progress-measure) | P1 |
| 24 | [Count the field, not a phrase that happens to appear near it](#count-the-field-not-a-phrase-that-happens-to-appear-near-it) | P1, P7 |
| 25 | [A transcript tail of generic lines is not evidence of inactivity](#a-transcript-tail-of-generic-lines-is-not-evidence-of-inactivity) | P2 |
| 26 | [A burst of unsent turn-starts predicts stalls in exactly those chats](#a-burst-of-unsent-turn-starts-predicts-stalls-in-exactly-those-chats) | P2 · fact |
| 27 | [The app's send registry is not a complete record of what starts turns](#the-apps-send-registry-is-not-a-complete-record-of-what-starts-turns) | P2 · fact |
| 28 | [An outlier turn duration is the signal, not silence against commit age](#an-outlier-turn-duration-is-the-signal-not-silence-against-commit-age) | P2 · fact |
| 29 | [Revive fixes a page; it does not fix a loop, and the rungs are not ordered by strength](#revive-fixes-a-page-it-does-not-fix-a-loop-and-the-rungs-are-not-ordered-by-strength) | P4 |
| 30 | [The ladder is for stopped streams, not for streams doing the wrong thing](#the-ladder-is-for-stopped-streams-not-for-streams-doing-the-wrong-thing) | P4 · fact |
| 31 | [Chain the edit to the commit, or the commit will describe work that did not happen](#chain-the-edit-to-the-commit-or-the-commit-will-describe-work-that-did-not-happen) | fact |
| 32 | [Syntax-check an instrument before the intervention that uses it](#syntax-check-an-instrument-before-the-intervention-that-uses-it) | P3 |
| 33 | [Never wrap a sender in a timeout shorter than its own deadline](#never-wrap-a-sender-in-a-timeout-shorter-than-its-own-deadline) | P3 |
| 34 | [A waiter cannot outlast a turn, and turns grow with the conversation](#a-waiter-cannot-outlast-a-turn-and-turns-grow-with-the-conversation) | P3 |
| 35 | [After an app restart, `lastStoredKind` is empty, not dead](#after-an-app-restart-laststoredkind-is-empty-not-dead) | fact |
| 36 | [`chat_error` is a fifth state: running at the tool layer, storing nothing](#chat_error-is-a-fifth-state-running-at-the-tool-layer-storing-nothing) | P2 · fact |
| 37 | [The steward's own footprint does not appear in the steward's instruments](#the-stewards-own-footprint-does-not-appear-in-the-stewards-instruments) | P10 · fact |
| 38 | [Filing is only delegation where a worker exists; elsewhere it is deferral](#filing-is-only-delegation-where-a-worker-exists-elsewhere-it-is-deferral) | P9 |
| 39 | [A migration that leaves the old path writable has not migrated anything](#a-migration-that-leaves-the-old-path-writable-has-not-migrated-anything) | P8 |
| 40 | [A correction can be worse than the mistake; say what was wrong, not what to undo](#a-correction-can-be-worse-than-the-mistake-say-what-was-wrong-not-what-to-undo) | P5 |
| 41 | [Verify a blocking node's premise harder than an adding node's](#verify-a-blocking-nodes-premise-harder-than-an-adding-nodes) | P5 |
| 42 | [A cleanup loop improves what it finds and never asks whether it should exist](#a-cleanup-loop-improves-what-it-finds-and-never-asks-whether-it-should-exist) | P8, P1 |
| 43 | [Ask whether the work should have existed, not only whether it happened](#ask-whether-the-work-should-have-existed-not-only-whether-it-happened) | P1 |
| 44 | [An error rate is not comparable across streams doing different work](#an-error-rate-is-not-comparable-across-streams-doing-different-work) | P6 |
| 45 | [Repair the document that states the rule, not the one that describes the work](#repair-the-document-that-states-the-rule-not-the-one-that-describes-the-work) | P5 |
| 46 | [Fix a failure mode in one repository, then sweep the other three for it](#fix-a-failure-mode-in-one-repository-then-sweep-the-other-three-for-it) | P7 |
| 47 | [Sampling a detector's hits proves precision and says nothing about recall](#sampling-a-detectors-hits-proves-precision-and-says-nothing-about-recall) | P7 |
| 48 | [Verify against the fastest true signal, not the most convenient one](#verify-against-the-fastest-true-signal-not-the-most-convenient-one) | P2 |
| 49 | [Historical failure: the continuation driver replaced stewardship judgment](#historical-failure-the-continuation-driver-replaced-stewardship-judgment) | Hard constraints (no driver) |
| 50 | [Historical failure: "make the failure impossible" was read as "remove the tool"](#historical-failure-make-the-failure-impossible-was-read-as-remove-the-tool) | §1 Who sets the limits |
| 51 | [A cleanup step that has never once run looks exactly like a clean fleet](#a-cleanup-step-that-has-never-once-run-looks-exactly-like-a-clean-fleet) | P3 |
| 52 | [Check the work is possible before climbing the ladder](#check-the-work-is-possible-before-climbing-the-ladder) | P4 |
| 53 | [Production nobody has executed is not production](#production-nobody-has-executed-is-not-production) | P8, P1 |
| 54 | [The acceptance you write into a node is the work the node will produce](#the-acceptance-you-write-into-a-node-is-the-work-the-node-will-produce) | P8, P1 |
| 55 | [Check a complaint is open before filing it as work](#check-a-complaint-is-open-before-filing-it-as-work) | P8 |
| 56 | [In this repository, author no longer separates steward from worker](#in-this-repository-author-no-longer-separates-steward-from-worker) | P9 · fact |
| 57 | [Do not count your own commits as the worker's](#do-not-count-your-own-commits-as-the-workers) | P9 · fact |

## A chat that stores your message and never starts a turn is dead

There are two silences and they look identical in the repository. In one the chat is mid-turn
and producing nothing; `interrupt` is the move, because there is a turn to stop. In the other
the bridge shows your message stored — `lastStoredKind: user_message` — with `generating` false
and `generatingForMs` at zero, meaning no turn ever began. Nothing can be interrupted, a second
push only adds another stored message, and the chat has not written a sentence since long
before either arrived.

**The same reading is normal for the first minutes after a push.** Between the message being
stored and the turn beginning there is a window in which `lastStoredKind` is `user_message`,
`generating` is false and `generatingForMs` is zero — identical to the dead state. A watcher
that samples there reports a dead chat for a chat that is about to start work: on 2026-09-12
one fired at six minutes against a `sage-categories` chat whose turn began moments later and
which had banked six commits in the previous hour. What made the `lean-categories` case a real
verdict was duration and repetition — 88 minutes across two separate pushes, with no assistant
message in between. Read the state only after the window a turn normally takes to start, and
prefer two pushes' worth of evidence to one.

On 2026-09-12 a `lean-categories` chat took two pushes that way across 88 minutes without
starting a turn or emitting one assistant message, while the steward read it as running out of
push and sent it more work. Check the pair before choosing a rung: a turn that exists and is
silent is a candidate for `interrupt`; a message stored with no turn behind it goes straight to
replacement.

Check what it was waiting for before writing the handoff, because the last thing it said is
often already obsolete. That chat's final message described waiting on an elaboration before
banking a batch — the batch had been committed twenty minutes later, so there was nothing left
to wait for and nothing unbanked. A handoff repeating its last stated intent would have sent
the replacement to redo finished work.

## `noProgressForMs` equal to `generatingForMs` means unrecorded, not stalled

When those two fields match exactly, nothing has been stored since the turn began — and that
reads as a long silence when it is often a recording gap. On 2026-09-12 two chats showed
`turn=39m noprog=39m` and `turn=59m noprog=59m` while committing four and ten minutes earlier
respectively: the work was landing in git and the rows were not reaching the recorder.

So treat the equality as a signal about the *recording*, not the worker. The commit clock and
the host are unaffected by it and stay authoritative — a stream with recent commits is working
regardless of what the silence figure says. Reserve the stall reading for a silence that is
shorter than the turn, which means rows were arriving and then stopped.

## Ask the host what the worker cannot see

A worker waiting on a build, test or gate has no way to learn that it ended. The chat stays
coherent, the figure it quotes stays real, and it waits — twice on 2026-09-12 a
`lean-categories` chat lost an hour that way, the second time in a replacement briefed
specifically about it, because the constraint is not something a chat can check about itself
from the inside.

So the steward checks. When a stream goes quiet with a clean tracked tree, ask the host before
asking anything else; it costs one command and it decides between two opposite actions:

```bash
pgrep -a -x 'lean|lake'            # lean-categories
pgrep -af 'sage|mypy|pytest'       # sage-categories, research
```

A process there means a long compile and the stream is left alone. Nothing there, with a clean
tree and a silent turn, means the work is already done and unbanked behind a wait that will
never end — interrupt, and the instruction is to re-run in the foreground and bank. The
`lean-categories` interrupt that followed that check released seventeen definitions that had
been sitting finished.

Documentation cannot fix this one. Three separate statements of the rule in that repository's
own `AGENTS.md` did not prevent either occurrence, because a chat cannot act on a fact it has
no way to observe. The check belongs to whoever can run it.

## A chat that stalls the same way twice earns a shorter horizon

The general signal — a turn generating for many minutes with `turn_start` as the last stored
event and nothing after it — is worth an interrupt whenever it appears. What the general rule
misses is that this is often a property of the particular chat rather than of the moment. On
2026-09-12 one `sage-categories` chat did it three times in ninety minutes: forty-six minutes,
then thirty-nine, then thirty-nine again, each time producing work within a minute of being
interrupted and producing nothing at all until then.

So track it per chat. The first occurrence is diagnosed at the usual horizon; the second in the
same chat justifies interrupting as soon as the pattern is recognised, because the evidence
that waiting longer helps has already been collected and is negative. The cost of interrupting
a chat that turns out to be working is one lost turn, and the cost of waiting out a chat with
this habit is the whole interval — which is the trade the horizon exists to make, and it moves
once the chat has shown you which side it sits on.

Check the tree before interrupting either way: a long silent turn over a dirty tree may hold
verified work the chat has not banked, and the instruction is then *bank what is verified*
rather than *take the next node*. Over a clean tree there is nothing in flight and the
interrupt costs nothing at all.

## Before pushing a chat, confirm no newer chat owns its repository

More than one steward drives this fleet. A chat that was the repository's worker when you last
looked may since have been stopped and replaced, and a push to it restarts a second worker beside
the replacement. On 2026-09-17 a `say` at 10:19 revived a sage-categories chat another steward had
deliberately stopped and replaced one minute earlier, and both then edited the same tree. Before
any `say`, `revive` or `interrupt` that asks a chat to continue work, list the chats opened since
your last observation and read each one's first user message: if a newer chat names the same
repository as its worker, that chat is the stream, and the older one gets no push.

Recency decides only when neither chat is demonstrably working. A chat that is generating and
whose writes are landing in that repository right now is the stream, however new the other one
is: stand the idle one down instead. Replacing a worker mid-unit costs the unit, and both
stewards have now done it in both directions.

## A worker can report a commit from the wrong repository

On 2026-09-12 a `research` worker reported banking `d9ff84a` with a named construction and a
reconciled TODO row. That hash was absent from `research` entirely — not in `git log --all`,
the reflog, any branch or the stash — and its tree was clean, so the work was not sitting
uncommitted either. It looked like a fabricated completion claim.

It was not. `d9ff84a` is real: `test(sets): pin indexed colimit functoriality` in
`sage-categories`, committed at the exact minute the report was written, inside a run of that
repository's own work. The `research` chat had read a sibling checkout's log — every worker
runs shell commands on the same host, and a `git log` without `-C` reports whatever directory
the shell happens to be in. Confronted with the fact, it checked, said plainly that its report
had been false for this repository, and committed the real work minutes later.

Two things follow. A hash a worker cites is checkable in one command and should be checked
whenever it is the evidence for a node closing — but check the *other* repositories before
concluding it was invented:

```bash
for r in <all managed repos>; do git -C "$r" show -s --format="%h %s" <hash> 2>/dev/null; done
```

And the remedy is different from replacement. A worker confused about which checkout it is in
is still working correctly; it needs the fact, not a new chat. Give it the absence — "that hash
is not in this repository, your last commit is X" — and let it reconcile. Replacement is for a
worker that cannot square its own account with what git shows, which this one did immediately.

## Gated paperwork reappears in the nearest ungated form

Paperwork is not produced adversarially; it is produced because it is the cheapest thing that
looks like progress, so blocking one shape of it moves the behaviour rather than ending it. In
`new-qual-site` on 2026-09-12 it went one-line queue ticks, then six-line reconciliation notes
that cleared a four-line threshold, then `completion: complete` written into a collection's
`index.md` with no card touched — each landing just outside what the previous rule caught, and
each looking like a different kind of commit.

Two consequences. A gate written against a *path* will be outgrown: `queues/` did not cover
`index.md`, and `index.md` will not cover whatever is next. The durable test is the property —
did anything exist after this commit that did not exist before — and where that cannot be
expressed mechanically, the path gate is a proxy that has to be re-aimed each time the shape
moves. Expect to widen it rather than to have solved it.

And re-aiming it requires reading the commits rather than their subjects. All three shapes
arrived under `docs(...)`, alongside genuine card authoring that carried the same prefix: one
sampled `docs(prelim)` commit added real mathematical statements to two cards, while two others
touched only an index. Nothing in the subject line separated them.

## A watcher that reports next tick is carrying the intervention into the next tick

The rule is verify against new content within ninety seconds and never bridge an unverified push.
A steward can violate it while appearing to honour it, by arming a background watcher, reporting
"not verified, watching", and reading the result twenty minutes later. That is the bridging the
rule forbids, dressed as diligence. On 2026-09-13 nearly every intervention in a long session was
discharged that way, and the cost came due on `research`: revived at 05:33, reported unverified,
and only looked at again after the owner asked how a stream could be forty-five minutes dry.

Stay with an intervention until content appears or the rung fails. Watching a repository for a
commit costs a loop and a few minutes of the interval, and the interval exists so the fleet is
never unlooked-at for longer than it — not so the steward has somewhere to put unfinished
follow-through. A background watcher is for a second stream while you attend to the first, never
for the one you just acted on.

The same session shows what the delay buys. `research` had gone from one dirty path to 102 with
nothing committed in forty-nine minutes; the push to bank produced a single token commit, and
only staying to watch showed it resume properly and come down to 85. A steward that had armed a
watcher and moved on would have recorded "banking, verified" from one commit and missed that the
first push had barely been obeyed.

## A recorded failure set goes stale in one direction and nobody is watching it

An observed failure set is the right artefact: it turns "the suite is red" into a list a worker
can close one item at a time. Its weakness is that items naming another repository are verified
once, at observation, and then re-read as current forever. Nothing in the observing repository
re-checks them, and the fixing repository does not know the item exists.

On 2026-09-13 `research` carried "`sage-categories` importing `typing.TypeIs` under Sage's Python
3.12" in its terminal failure set. `sage-categories` had closed a node named
`bloat-role-typeis-import` and its `kernel/roles.py` now reads `if TYPE_CHECKING: from typing
import TypeIs`, so nothing imports it at runtime. The item had been dead for hours while the
worker treated it as outstanding work.

The steward reads both repositories and is the only party that can notice. So when a failure set
names another repository, re-check those items against that repository each time the set is
reviewed — it is a `grep` per item — and send the result rather than editing the set, because the
set is the worker's observational record and overwriting it destroys the provenance of what was
actually seen.

Send what was verified and no more. Here the guard was confirmed present; whether the whole import
succeeds was not, because the probe ran outside a real session and hit an unrelated circular
import. Reporting "it works now" from that would have replaced one stale item with a false one.

## A blocker that spans two repositories is only visible to the steward

Each worker sees one repository. When a failure's cause is in another, the consumer reports a
symptom it cannot explain and the producer reports nothing at all, because nothing in the
producing repository consumes its own published artifact. On 2026-09-13 `research` recorded that
`just test-push` could not resolve `sage-categories@66efc15b`. From inside `research` that reads
as a bad pin. It is not: the revision exists, ten hours old, an ancestor of `sage-categories`'
local `main` — and that repository's `origin/main` is **1341 commits behind it**, so every
revision `research` could sensibly pin is equally absent, and the newest one the remote carries is
1341 commits stale.

Neither worker could have found that. The steward is the only reader of both, so cross-repository
resolution failures are the steward's to diagnose: take the identifier the consumer could not
resolve, look for it in the producer, and compare the producer's local history against the remote
the consumer fetches from.

File it on both sides, differently. The consumer needs to know the failure is not repairable
locally, and specifically that the tempting local fix — a filesystem path dependency — hides a
publication gap affecting every other consumer. The producer needs to know a consumer exists at
all, and what it owes that consumer.

Then stop at the decision. Publishing 1341 commits of accumulated history is outward-facing and
irreversible, so it is the owner's call and not a node's acceptance. Record the question, name the
decision, and leave it; a node whose deliverable is "push this" is a steward committing someone
else's repository to publication by writing it down.

## Space `du` cannot account for is held by deleted-but-open files

A steward chasing disk will `du` the candidates, find nothing that moved, and report the decline
as diffuse. On 2026-09-13 free space fell 1.1 GB in twenty minutes while every measured directory
was flat and `/tmp` had actually shrunk by 461 MB. The space was in files already unlinked but
still held open: **1347 MB** across 597 deleted descriptors, the largest being an `opencode.db`
at 583 MB and a `.hermes/state.db` at 305 MB held twice. Both are long-running tools that rewrite
a database and keep the old file descriptor, so each rewrite leaks another copy until the process
restarts. `du` walks directory entries and these have none.

So when `du` cannot account for a drop, that *is* the finding, not a dead end. One loop over
`/proc/*/fd` readlinks for `(deleted)` and stats through the descriptor gives the total and names
the holder. Space is reclaimed by restarting that process, never by deleting anything.

And note whose it is before acting. Here the holders were the owner's own tooling, not a managed
repository or this app, so the finding is reported rather than fixed — restarting someone's
editor or agent runtime to reclaim disk is not a steward's call, and the fleet was not the cause
of a decline it had been blamed for across three ticks.

## Gate churn accumulates in caches, and the reclaim is smaller than the tool claims

Running four repositories whose commit gates each resolve `uvx` tools puts the fleet's disk cost
somewhere a steward does not think to look. On 2026-09-13 `~/.cache/uv` stood at 5.2 GB and had
grown 749 MB in two and a half hours while every managed repository's own size was flat and
`.lake` had not moved at all. The growth was not work; it was the same tools being resolved on
every commit, four repositories over.

`uv cache prune` is the right response and it reports optimistically. It removed 176301 files and
announced 4.9 GiB, while the directory shrank 570 MB and free space rose 300 MB — most of what it
counts is hardlinked and shared. It also declines to touch entries in use, which on a host where
gates run continuously means a partial pass. Report the measured delta in `df`, never the tool's
own figure.

The rest of a `/tmp` at 6 GB divides cleanly. Fleet debris with a worker to route it to — a
merge snapshot, a reproduction tree — goes to that worker with the rule that prevents recurrence.
Everything else is retention: a 2.5 GB tool directory from three days ago, a 949 MB pytest tree, a
3.5 GB monitoring log. Those are the owner's to decide and a steward should say so rather than
carrying them tick to tick as a fleet problem.

## Attribute a host trend before escalating it, and expect it not to be the fleet

Disk on this host went from 15 GB free to 11 GB across a session, and the steward reported it
three times as a fleet constraint trending toward binding. Measured, the decline was irregular —
two gigabytes in forty minutes, then one across seven hours — and the largest consumers were
nothing the fleet owns: `/var/log/atop` at 3.4 GB of daily performance captures, `~/.cache` at
7.6 GB of package caches, `/tmp/sage314` at 2.5 GB. The app's own journal, suspected because it
logs a warning per unattributed tool call, was 105 MB. The fleet's entire contribution was two
stale reproduction directories worth half a gigabyte.

A host-level number is the sum of everything on the machine, and the fleet is usually a small
part of it. Before reporting one as a fleet constraint, attribute it: `du` the candidates, check
the suspected source's actual size, and separate what a managed repository produced from what the
operating system, the package manager and unrelated tooling did. Otherwise a steward spends ticks
watching a number it cannot move and reporting urgency it cannot act on.

What *is* the steward's is the fleet's share and the recurrence. Half a gigabyte of abandoned
repro trees is small, and the rule that stops them accumulating belongs in the repository that
makes them. Everything else on that list is an owner decision about retention, and should be
reported as one rather than carried as a fleet problem.

## `git log --diff-filter=A` does not see merges, and a jump is as likely a merge as production

A corpus that grows by 581 files in two hours looks like a worker producing at an implausible
rate, and on 2026-09-13 that reading was one step from a scope intervention against
`new-qual-site` — "ingesting faster than it solves, the queue will never converge". The
author-filtered query meant to confirm it returned **zero** files added in five hours, which
should have settled the question and instead produced a contradiction the steward nearly ignored.

Both halves were artefacts. `git log --diff-filter=A --name-only` omits merge commits entirely
unless asked for them, so in a repository doing branch consolidation every file that arrives by
merge is invisible to it. And `HEAD@{5 hours ago}` is a reflog reference, not a point in time;
comparing against it measures wherever HEAD happened to be. The truth came from
`git rev-list -1 --before=` for the anchor and a per-commit diff against each parent: one commit,
`merge: reconcile Core2 and remote main`, carrying the whole jump. Nothing was over-produced;
existing work was absorbed, which the DAG has open items for.

So when a count jumps, look for a merge before inferring a rate. Use `git rev-list -1 --before=`
for historical anchors, never `HEAD@{time}`. And treat a contradiction between two measurements
as the finding — the steward here had "581 added" and "0 added" in hand simultaneously and the
temptation was to act on the one that fit the story.

## One tick is a sample; a trend needs the buckets

A tick shows twenty-one minutes, and twenty-one minutes of four workers is noisy enough to
support almost any story. On 2026-09-13 a steward read three streams down against the previous
tick, noticed a load average of seven with the browser taking most of the CPU, and had a
plausible account ready: long conversations, heavy DOM, a host being eaten by the watching.
Bucketing commits by hour showed nothing of the kind — `research` had gone 3, 4, 26, 20 across
four hours as its terminal phase opened up, `sage` 23, 11, 50, 31, and the fleet total 52, 81,
104, 62. The apparent slowdown was one sample against another, and the one real decline,
`new-qual-site` at 3, was the stall the same tick had already found and fixed.

So before attributing a rate change to anything — the host, conversation length, a worker's
discipline — bucket the commits. `git log --pretty=%ct` piped through `awk` over hour boundaries
is one command per repository and it settles the question that inspection cannot.

The failure this guards against is specific and seductive: a steward with a plausible systemic
explanation and two data points will write the explanation down, and it will then shape the next
several ticks' decisions. A fleet that is working normally will absorb a great deal of
intervention aimed at a decline that is not happening.

## Read the age distribution of a dirty tree, not its size or its signature

A growing dirty tree reads as a worker mid-batch, and a changing signature reads as a worker still
writing. Both pass while a stratum at the bottom never lands. On 2026-09-13 `new-qual-site` held
112 tracked paths of which **78 were older than thirty minutes**, the oldest — a whole
`SRC-UGA-MATH8155-STARTER-PROBLEMS` collection — written at 02:45 and still uncommitted eleven
hours later. Every tick had seen the count rise and the signature change, because each new source
piled a fresh layer on top, and every tick had concluded the stream was banking normally.

So bucket the modification times: how many dirty paths are under ten minutes old, how many over
thirty, and when was the oldest written. A healthy tree is mostly recent with an old tail of
nothing; a stream in trouble has a floor that never moves while the ceiling churns. Swept across
the fleet the same reading separated them cleanly — `lean-categories` carried zero dirty paths at
all, `sage-categories` four all older than thirty minutes, `research` two of twelve.

The instruction that follows is the one to give a worker: before starting a new unit, commit
anything in the tree older than the unit you are about to start. That makes the floor impossible
to accumulate without requiring anyone to remember what is down there.

## A tree signature says nothing on its own, because committing restores an earlier one

Hashing the tracked dirty paths catches the stall that a count cannot: a worker holding the same
files across ticks looks identical to one batching, until the signature proves it never changed.
It also produces a false positive that will fool a steward exactly once. A worker that writes
three files and commits them returns the tree to the signature it had before, so a tick that
samples on either side of that commit reports `STATIC` for a stream that just banked. On
2026-09-13 `research` did precisely this — 9 paths, 12 paths, commit, 9 paths — and read as static
while being the most recently active stream on the board.

The signature is only a stall signal paired with commit age. Static tree *and* no recent commit
is the stall; static tree with a commit minutes ago is a worker that finished something. Record
both in the same line so the pair is always read together, and never act on the signature alone.

The general form is worth keeping in view: every cheap signal in this tick is a projection that
loses information, and each one has a state it cannot distinguish. Counts miss which files;
signatures miss the commit between two samples; commit age misses whether anything is being
written; the stored kind misses whether work reaches the repository. The tick works because they
fail differently, not because any of them is trustworthy.

## A true explanation becomes an excuse the second time you reach for it

Pricing `new-qual-site`'s gate was right: its commit hook reparses the whole corpus, so batching
is a rational response and per-card pushes were asking it to pay a tax. The steward recorded
that, stopped pushing, and classified the stream "working — batching under its gate tax". It then
used the same sentence the following tick, and the tick after, while twenty-three written cards
sat unbanked for roughly two hours. The explanation had stopped describing what was happening and
become the reason not to look.

The discriminator was in the tree the whole time. A worker that is batching keeps writing: its
dirty set grows and its paths change. This one held the same twenty-three
`SRC-PERUTZ-ALGEBRAIC-TOPOLOGY-I-2008` cards across every reading, with nothing recorded for
twenty-four minutes and no tool calls in flight. Static tree plus silence is a stall wearing the
costume of a known-good behaviour, and one revive banked the batch immediately.

So when a diagnosis explains a stream's behaviour, write down what would distinguish that
behaviour from its failure mode, and check *that* on later ticks rather than re-asserting the
diagnosis. For batching it is whether the tree is still moving; for a long reuse search it is
whether new files are being read; for a slow gate it is whether the gate is actually running.
A cause that is real is the most durable way to stop seeing, precisely because it survives
scrutiny the first time.

## Shared tooling that prints for a human is a context tax on every agent that calls it

A gate's output is free when a person runs it and scrolls past. It is not free when the caller is
an agent: every line enters a conversation that is already the scarcest resource in the fleet. On
2026-09-13 `_semgrep-autofix` in the shared review CI was found printing all 41 findings with code
snippets on every invocation — 177 lines, 8.4 KB, measured — while its own comment says CI-tier
verification owns those findings and the recipe itself only checks the exit status. A repository
committing twenty times an hour pushed roughly 200 KB an hour of output nobody could act on into
its worker's context, in four repositories at once.

That is a plausible part of why one chat kept ending in `chat_error`: it commits most, so it
absorbed most. The fix was to capture the scan, print the autofix result and a finding count, and
replay the log only on failure — three lines instead of 177, with behaviour and exit codes
unchanged.

So when a fleet's conversations grow faster than the work explains, audit what the gates print,
not only what the workers write. The question for any shared recipe is what the caller can act on:
output that exists to be read by a human reviewing a terminal is a defect when the caller is an
agent that must carry it forward. Capture it, summarise it, and replay it on failure.

This lives upstream in the tooling repository, not in the consumers — a per-repo workaround would
leave the tax in place for everyone else.

## When a worker will not do a cheap thing, price it before pushing again

A steward that asks twice for something obvious and does not get it has learned something about
the request, not about the worker. On 2026-09-13 `new-qual-site` held twenty-two written cards
across half an hour and ignored two pushes to bank them per collection. The reason was in its own
commit gate: every commit touching `corpus` materializes the entire corpus, vocabularies and wiki
into a temporary tree and reparses roughly 5900 cards, observed at sixty seconds. Per-card
banking costs twenty to forty minutes of gate for that batch. The worker was not undisciplined;
it was avoiding a tax, and both pushes were asking it to pay one.

So when an instruction is cheap to state and is not being followed, open the recipe it implies
and price it before repeating yourself. A gate whose cost scales with the whole repository
rather than the change is an incentive against small commits, and no amount of doctrine about
banking will outweigh it — the fleet's granularity is set by what the gate charges, not by what
the documents ask.

This is the same rule as fixing the obstruction rather than routing around it, pointed at the
steward's own instructions: a push that asks a worker to absorb a cost the steward has not
measured is the cheapest thing to send and the least likely to work.

## Closing finished nodes is the steward's work, and an unmarked one stays ready forever

A DAG's whole function is naming what to do next, and a node that is complete but unmarked keeps
naming itself. On 2026-09-13 three `new-qual-site` nodes — the detector, the repair, the pipeline
— were finished by 02:37 and still carried `Needs: none` at 08:50. The worker did the only
sensible thing: it read `extraction-detector` as the first ready node, went to implement it,
found it already built and wired into the commit gate, and recorded that `TODO.md` was stale
relative to the code. Two turns spent on the steward's bookkeeping.

Filing is the visible half of maintaining a DAG and closing is the half that makes the filing
mean anything. A steward that only ever adds nodes is building a list that steadily loses its
ability to answer the question it exists for, and the damage is silent: nothing fails, the worker
simply does finished work and reports the file is wrong.

Two habits follow. Close a node in the tick that verifies its acceptance, with the evidence, not
later. And check that the format *has* a way to be closed — this list used bullets with no
checkbox and no convention, which is why nothing was ever marked; the other three repositories
used `- [x]` or a `Closed.` cell and stayed current.

When sweeping for this, match the convention loosely. A sweep for exactly `Closed.` reported a
node open that in fact read `Closed, superseded at the mechanism level.` — a prose convention
searched literally will manufacture its own false positives.

## Correcting a total does not correct the worklist built from it

A bad metric produces two artefacts: the number in the report and the ordering the steward
derived from it. On 2026-09-13 a steward found it had been counting a justification phrase
instead of the route field, corrected the total in the node — and left standing the per-file
ordering that same phrase had produced. The next thing it did was push a worker at
`chapter-2-schemes-fc06.md` as "the heaviest file, 203 rows". That file has **three** unmatched
rows. The phrase is residue: it stays in rows whose route has since moved, so it accumulates
exactly where work has already been done and points the worker at finished files.

The real ordering was a different set of files entirely — `chapter-4-homotopy-theory-fc07.md` at
183, `chapter-3-cohomology-fc06.md` at 181 — and none of the top eight by the bad metric matched
the top of the true list.

So when a measurement is found wrong, find everything derived from it before moving on: the
totals, the per-item ranking, the node text, and any instruction already sent to a worker. The
ranking is the dangerous one, because a total that is merely wrong gets reported while a ranking
that is wrong gets *acted on* — it is the steward's lever on what the fleet does next, and a
worker will follow it straight into finished work.

And put the recomputation in the node instead of the numbers. A list of file counts is stale the
moment the worker starts; a one-line command that regenerates it is not.

## A count with a moving denominator is not a progress measure

The third way the same ledger misled a steward in one session: after fixing which field to count
and which files to rank by, the raw number still lied, because the population itself grows while
the work is done. Matching a bundled source row clause by clause correctly splits it into several
rows, so a good remapping pass *adds* rows. Between 06:29 and 12:30 on 2026-09-13
`lean-categories` went from 8888 route-bearing rows to 9066; `unmatched` fell 6563 to 6409 and
ticked upward across one twenty-minute window while the work was going well.

Report the fraction, and report a monotone companion. Here that is 73.8% to 70.7% unmatched,
alongside `mathlib` routes rising 1795 to 2127 — a count that can only go up as reuse is
established, and therefore cannot be confused by resizing.

The general test before trusting any ledger number as progress: ask what happens to it when the
work goes perfectly. If the answer involves the denominator, the numerator alone is not a measure,
and a steward watching it will eventually report a stall or push a worker that is doing exactly
what was asked.

## Count the field, not a phrase that happens to appear near it

A steward tracking a structured ledger will reach for `grep` on whatever string it noticed first,
and that string is almost never the field. On 2026-09-13 a whole session of reporting on
`lean-categories` counted the *justification text* `Strict bundle semantics reject` as a stand-in
for rows whose route is `unmatched`. Counting the route cell instead gives 6563 unmatched rows of
8888, seventy-four percent of the corpus; the phrase covers 1305 of them. The same session
reported `project-existing` falling from 465 to 321 by matching that word anywhere in a row — the
route cell carries it on 195. Every figure was wrong, in both directions, and they were wrong
consistently enough to look like a trend.

Two corrections. Anchor a count to the column it lives in — `| \`unmatched\` |`, not `unmatched` —
and print the denominator beside it, because a bare numerator hides exactly this: 1305 sounded
like most of the problem and was a fifth of it.

And when a count refuses to move while related work visibly lands, suspect the measurement before
the worker. That reading persisted here for over an hour and produced a push, a node edit and a
paragraph of reporting about a stream that was working the whole time. The same tick also nearly
reported a fabricated regression, from switching between `Strict bundle` and `Strict bundle
semantics reject` between two measurements and comparing them — a metric whose definition changes
mid-session is worse than no metric, because it manufactures events.

## A transcript tail of generic lines is not evidence of inactivity

`just transcript` renders tool calls, and many of them render as `Ran a command · ✓ 0ms` with no
text. A tail of four such lines looks like a worker idling on trivia. On 2026-09-13 a steward
read exactly that and reported that `sage-categories` "has not visibly taken the node yet" —
while, in the same window, it was committing `@cached_method` conversions at 08:24:33, 08:25:57
and 08:27:58, which is precisely the work the node asked for. The commit log said so plainly and
was one command away.

The transcript is the right instrument for *what kind* of thing a worker is doing — a repeated
`write_stdin` wait is a loop, a run of `rg` and file reads is a search. It is a poor instrument
for whether anything is happening, because its most common rendering carries no content, and a
tail is a slice. Never report a negative from it. Pair it with the commit log and the tree, which
answer "is there output" directly.

This is the ordinary rule about partial reads, pointed at the steward's own tooling: a slice
supports "not found in what I looked at", never "not happening".

## A burst of unsent turn-starts predicts stalls in exactly those chats

The app logs `send-origin: … a turn started that this app did not send` and those events arrive in
bursts. On 2026-09-13 five fired between 11:20:56 and 11:21:05; three of them began the current
turns of `research`, `lean-categories` and `sage-categories`, at 11:20:59, 11:21:05 and 11:21:05.
Fifty minutes later all three sat in `chat_error` with no tool calls running, nothing stored for
thirty-nine minutes, and between them one `todo` commit. The same shape appeared at 06:25, when a
three-chat burst was followed by the same three needing revives.

Two bursts is not a mechanism and this does not explain what starts the turns. What it does give
is an early signal the tick was not using: `journalctl --user -u chat-on-steroids.service | grep
'did not send'` names the chats and the minute, and a burst there is a reason to look hard at
those specific chats on the next pass rather than waiting for the commit drought to accumulate.

Read it as a predictor, never as a diagnosis. Some externally started turns produce normally —
the count today ran to dozens against a handful of stalls — so the burst narrows where to look
and the tree, the commit log and `pendingTools` still decide. All three revived here and two had
committed within four minutes.

## The app's send registry is not a complete record of what starts turns

A steward reasons as though the only things that begin a managed turn are its own pushes and its
continuation driver. The app says otherwise, in its own words: `send-origin: … a turn started
that this app did not send; … the send registry, draft ledger and push-correlated attribution
simply do not describe this turn`. On 2026-09-13 it logged **23** of those, spread across the
session — 04:24, 05:24, 05:42, 05:45, 05:53 twice, 06:14, 06:22, then three chats at 06:25:30,
:33 and :36 within six seconds of each other, with the observer healthy throughout.

The mechanism was not established, and guessing at it is not the point. The consequence is: two
inferences the tick leans on are unsound. A turn beginning shortly after a push is not evidence
the push started it, and a chat that begins working after an interval of silence has not
necessarily been reached by anything the steward did. Attributing fleet behaviour to
interventions on timing alone will credit the steward for work that was going to happen.

So verify interventions against content, which was already the rule, and treat turn starts as
observations rather than receipts. When three turns begin within seconds of each other, look for
a common cause before reading three separate stories into it — and check `turnStartedAt` rather
than `generatingForMs`, since the latter is a duration and the former is the timestamp that makes
coincidence visible.

## An outlier turn duration is the signal, not silence against commit age

The decisive miss happened twenty minutes before that revive. `research` read `4 commits/21m`
alongside `silent=71m`, and the steward took the commit count as health and left it for a full
interval. The first attempt to name the signal said that `noProgressForMs` greatly exceeding time
since the last commit means producing without storing — and the very next tick showed that rule
firing on two healthy streams at once, `research` at `silent=17m` with a commit a minute earlier
and `sage` at `silent=14m` with the same. Both were fine.

The reason is that `noProgressForMs` tracks the current turn's recording, so it sits at roughly
the turn's own age whenever a turn is under way and has not stored yet. `silent ≈ turn` is the
ordinary reading and says nothing. Silence against commit age is therefore not the comparison to
make.

What distinguished the real case was the turn itself: seventy-two minutes, against a fleet whose
turns otherwise run two to twenty. `sage` was at sixty-five minutes in the same tick and also
needed reviving. A turn far outside the fleet's own current range means the worker has not
reached a turn boundary in that whole time — no boundary, no stored output, and nothing the
composer can reach — and it precedes the stopped state rather than following it.

So compare each turn duration against the other three, not against a fixed threshold, because the
normal range moves with conversation length. An outlier is the tick's business that tick: read
its tree and its commits, and if those are empty too, revive. Reading the four together also
catches the case where every turn is long at once, which is a host problem rather than four
worker problems.

## Revive fixes a page; it does not fix a loop, and the rungs are not ordered by strength

The ladder reads as increasing force — push, interrupt, revive, replace — and that ordering is
about how much of the chat each rung disturbs, not about how likely each is to work. On
2026-09-13 `research` stalled with `chat_error`, a static tree and no commits for twenty-one
minutes. A revive reloaded the page, the turn restarted, and ten minutes later the tree was byte
for byte identical and nothing had been stored. Reading the transcript showed why: its last
several calls were `write_stdin … Waited on session` against an exec session with no process
behind it. The worker was in a wait loop, and a reload restored the conversation faithfully —
including the loop.

What broke it was an interrupt, nominally a weaker rung, carrying the one thing a reload cannot:
a description of what the worker was doing wrong. "You are waiting on a session that will not
produce anything; abandon it and use short bounded commands." Its tree moved within two minutes.

So diagnose the stall's layer before choosing a rung. A page-layer problem — an error state, a
frozen composer, a conversation that will not store — is what revive is for. A behaviour-layer
problem is information-shaped, and no amount of reloading supplies information; the worker will
resume the behaviour because the behaviour is in the conversation the reload just restored.
Reaching for a weaker rung after a stronger one failed is the correct move when the stronger one
addressed the wrong layer.

The transcript is what separates them, and it is one command. A stalled stream whose tool calls
are all the same call is looping; one with no calls at all is stopped.

## The ladder is for stopped streams, not for streams doing the wrong thing

A worker that ignores an instruction and a worker that has stopped look different in every
instrument, and only one of them is what the unwedge ladder is for. On 2026-09-13 a steward
wanted `lean-categories` to switch from one remap channel to the other, saw the count it cared
about unchanged across ninety minutes, and climbed straight to `revive` — three times, against a
chat that was generating, recording progress a minute earlier, and committing. The reloads all
failed with `No page redeemed`, which is the app refusing to reload a live page, and each attempt
opened a tab: seven duplicates and 686 MB of browser memory before `tidy` recovered it. The
instruction had in fact landed on the first interrupt, and the worker was acting on it — its next
commit was `fix(mapping): audit FC05 chapter 1 routes`, exactly the per-source work that had been
asked for.

So separate the two readings before choosing a rung. A stopped stream shows an empty tree, no
commits, and nothing stored; the ladder exists for it. A stream that is committing while not
doing the thing you asked is a scheduling or priority disagreement, and the remedy is the
document plus evidence plus time to read it — never a reload, which at best discards the turn
that was about to comply.

Impatience is the tell. A count that has not moved for ninety minutes is a strong signal about
priority and a weak one about liveness, and reaching for a stronger rung because a weaker one
did not *appear* to work is how a steward spends an interval fighting its own fleet. Check
whether the last message landed before sending a stronger one; a delivered interrupt does not
need to be repeated because its effect is not visible yet.

## Chain the edit to the commit, or the commit will describe work that did not happen

`git commit -- TODO.md` commits whatever that path holds in the working tree, which is not
necessarily what the steward just wrote. On 2026-09-13 an edit script failed its anchor assertion
— a worker's markdown formatter had reflowed the paragraph being matched — and the commit ran
anyway, because the edit and the commit were separate statements rather than joined by `&&`. The
result was a commit whose message described a memory measurement, containing instead the worker's
reflow and its own node closure. A false message in a repository's history is worse than a failed
edit: it is evidence, and the next reader has no reason to doubt it.

Two mechanical habits. Join the edit and the commit with `&&` so a failed edit stops the commit.
And name the paths the edit touched, rather than committing a file wholesale, when a worker may
be writing the same file — in a shared tree `-- <path>` is not a filter on *your* changes, only
on that path's changes.

When it happens, amend immediately if the commit is still `HEAD` and unpushed, describing what
the commit actually contains and why the message was wrong. Leaving it and adding a correction
later means the wrong message is what a log reader sees first.

Editing a file a worker is concurrently formatting is also why the anchor moved. Prefer anchors
that survive reflow — a node identifier, a heading — over a sentence from the middle of a
paragraph.

## Syntax-check an instrument before the intervention that uses it

The edit that added the escalation above placed its check before the helper it calls, so the
script died on `status: command not found` at the moment it was launched against a live chat. The
intervention did not happen. Nothing else reported a problem — the launch was backgrounded, the
log held one unfamiliar line, and only reading that log distinguished it from a push in flight. A
steward that had glanced at the exit status and moved on would have spent the interval believing
a worker had been redirected.

`bash -n` is one command and would have caught it. Run it after editing any script the tick
depends on, and prefer to exercise the change once against something harmless before aiming it at
a stream. Editing a tool and using it on a live target in the same step means a defect in the
tool presents as a defect in the fleet.

This is the same shape as a maintenance step that silently never runs: the failure mode of
instrumentation is doing nothing while reporting nothing, and the only defence is reading what it
actually printed rather than assuming the absence of a complaint.

## Never wrap a sender in a timeout shorter than its own deadline

The waiter reports `LANDED`, `NOT LANDED`, or that it escalated — and prints nothing at all while
it is still waiting, which is its normal state for up to fifteen minutes. On 2026-09-13 a steward
ran it under `timeout 150`. The timeout killed it mid-wait, the pipeline exited zero, the log held
a blank line, and the steward reported the message as in flight. It had never been sent, and the
worker spent the next interval on a file the steward had already discovered was finished.

Silence from a sender means nothing either way, so never truncate one and never read its absence
of output as progress. Run it in the background and let it reach its own conclusion, or use
`interrupt`, which returns a delivery line immediately. Where a wrapper timeout is unavoidable,
make it longer than the sender's deadline, and treat an empty log as a failed send rather than a
pending one.

This is the third time in one session that an instrument failed by doing nothing: a cleanup that
never ran, a waiter that expired unattempted, and now one killed from outside. The pattern is
worth the generalisation — every component of this tick reports success by silence, so the
steward has to know which silences are meaningful and check the rest against the world.

## A waiter cannot outlast a turn, and turns grow with the conversation

The send-on-a-gap waiter was written when managed turns lasted a few minutes, and it carries a
fifteen-minute deadline on that assumption. By 2026-09-13 the same conversations were running
fifty-two-minute turns, because a turn lengthens as its context does. A waiter launched against a
chat already deep into one cannot reach a boundary before its deadline, so it waits out the
entire steward interval and reports `NOT LANDED` — an intervention that was never attempted,
indistinguishable in the log from one that was refused.

Two things follow. Pick the tool by the chat's current turn length: a waiter for a chat between
turns or early in one, `interrupt` for a chat already past the deadline, since interrupt injects
into a running turn and is the only thing that reaches one. The waiter now reads
`generatingForMs` before committing to wait and escalates itself rather than expiring quietly.

And treat every assumption about timing in this instrumentation as having a shelf life. Turn
duration, tab memory, gate runtime and transcript size all grow with the conversation, so a
threshold that was generous when it was written becomes a silent failure later — and it fails by
doing nothing, which is the hardest failure to notice. When a number in a script encodes "long
enough", the tick that finds it too small should fix it rather than route around it.

A last note on crediting. During that expired wait `research` banked its tree anyway. The
intervention did not land and the outcome happened regardless, which is the ordinary case for a
worker that was already going to do the right thing. Report the push as not landed and the stream
as working, and never let a coincidence of timing become evidence that a rung did something.

## After an app restart, `lastStoredKind` is empty, not dead

The recorder's per-conversation state lives in the MCP server process, so restarting
`chat-on-steroids.service` clears it. Every managed chat then reports `lastStoredKind: None` until
it next stores something — which is indistinguishable, in that field alone, from a chat that has
never stored anything, and adjacent to the dead-chat reading the tick escalates on.

So a restart costs the stall detector its primary signal for a few minutes per chat. Fall back to
the tree and the commit log, which are unaffected, and do not classify on `None` until each chat
has stored once. On 2026-09-13 two of four chats read `None` immediately after a restart while
both were generating normally.

The restart itself is cheap if aimed correctly: `chat-on-steroids.service` is the MCP server, and
the browser and tunnel are separate units, so restarting it leaves every tab and conversation
intact. Wait for `pendingTools` to reach zero across all managed chats first — an in-flight
`exec_command` dies with the process and the worker sees an unexplained tool failure.

## `chat_error` is a fifth state: running at the tool layer, storing nothing

A chat whose `lastStoredKind` is `chat_error` can keep executing tool calls indefinitely. On
2026-09-13 `lean-categories` sat that way for twenty-seven minutes — `generating` true,
`exec_command`s starting and completing, and across the whole stretch not one file written, not
one commit, and not one stored message. Every instrument the tick normally reads said busy.
`noProgressForMs` said ten minutes, not twenty-seven, because the page was still doing something;
the working tree said clean; the commit log said quiet, which for a worker mid-analysis is
unremarkable. Only `lastStoredKind` distinguished it, and only because someone went looking.

The state is worth naming because its remedy is different. A push or an interrupt puts a message
into a page that has already shown it cannot store what it produces, so both are wasted rungs.
The fix is `revive`, which reloads the page: the stored kind moved to `assistant_message` on the
next turn, and reloading incidentally drops a long conversation's DOM, which on a swapping host
is worth having anyway.

So read `lastStoredKind` every tick alongside `generating` and the clocks. `chat_error` standing
while tool calls continue means revive now rather than climbing from the bottom of the ladder.

But the stored kind alone never decides it, and the first draft of this section got that wrong
within the hour. It said a standing `user_message` reads as a dead chat once it persists past a
few minutes; the next tick found `research` with `user_message` standing for thirty-two minutes
and forty-eight minutes since its last commit, which under that rule is a revive. It was working:
the process table had its commit gate running, and its transcript was a live source search
through `IsoCategoryConstruction` and `FixedIsoCategory`. Reviving would have thrown away a long
analysis at the moment it was banking.

The stored kind says where a chat's output is going; only the tree, the process table and the
commit log say whether there is output. `chat_error` earned its rung because it came with an
empty tree, no commits, and nothing stored across twenty-seven minutes — the kind plus the
absence, never the kind alone. A long silence with a gate running is a worker thinking, and the
one intervention guaranteed to waste it is the one that reloads the page.

## The steward's own footprint does not appear in the steward's instruments

An interrupt against a sleeping chat does not return quickly: the app discards a tab after a
verified push, has to wake it, and answers `that chat is sleeping … Waiting`. On 2026-09-13 a
steward read that as a stalled command and sent the next one, five times into `lean-categories`
across one session. It ended the session holding three duplicate tabs on that conversation — one
per wake attempt — against one on `sage-categories`, which was interrupted once. Duplicate tabs
on a managed chat are both a second typing surface and, for a long ChatGPT conversation,
hundreds of megabytes of DOM apiece.

Meanwhile the tick was reading `free -m`'s available column every twenty minutes and reporting
three or four gigabytes, which looked unremarkable. Swap was at 48% with roughly five hundred
megabytes genuinely free and pages faulting back in. Available memory cannot show swap pressure,
so the instrument that was supposed to notice the host filling up was structurally incapable of
it, and the thing filling it up was the steward's own retry behaviour.

Two changes. Read swap and truly-free alongside available, because a host that is swapping is
slowing every worker on it and the friendly number will not say so. And treat a pending wake as
pending: one interrupt per chat until it lands or fails, then `tidy` afterwards, because the
cleanup is what turns an abandoned wake into nothing rather than into a resident duplicate.

A steward that never measures its own cost will attribute it to the fleet. The workers were slow;
the reason was partly the watching.

## Filing is only delegation where a worker exists; elsewhere it is deferral

Repository work goes into that repository's queue because each managed repository has a worker
who reads the queue and does the work. The rule is about routing, not about the steward's hands,
and it silently inverts when applied to anything outside the four: the agent-memory vault, the
shared review CI, a config nothing is assigned to. Those have no queue and no worker. Writing a
node for them is not delegation; it is a decision not to do the work, dressed as routing.

On 2026-09-13 a steward found the vault's `lean-categories` subtree carrying seventeen hours of
uncommitted mapping records and filed it as a node for the lean worker, reasoning that the vault
was the owner's and not the steward's to touch. The owner asked why the obvious fix was not
simply being made. It was one `git add` and one commit, in a git repository, fully recoverable —
and making it was what exposed the real problem underneath, which was not a stale copy at all but
an active split with the regression on the newer side. The node would have sat there while the
good mapping was overwritten.

So before filing, name the worker who will pick it up. If there is not one, the question is only
whether the action is safe and reversible, and a commit in a git repository almost always is.
Preservation in particular is never the thing to defer: banking work costs nothing, loses
nothing, and frequently surfaces what a status read could not.

The boundary that does hold is the live tree of a running worker. Not clobbering files a worker
wrote minutes ago is a real constraint with a real failure behind it; "that repository belongs to
someone else" applied to an unattended git repo is not the same rule and should not borrow its
authority.

## A migration that leaves the old path writable has not migrated anything

Moving data to a new home is two operations, and a steward that files only the first gets a
second writable copy rather than a move. On 2026-09-13 `lean-categories` moved 378 mapping
records out of a vault symlink into a tracked `corpus/`, correctly and verifiably — and the
symlink stayed live, because it also carries plans and decisions that had nothing to do with the
migration. Within half an hour the two copies had diverged in both directions, and the newer one
was the worse one: rows the worker had correctly re-mapped to `PrimeSpectrum.zariskiTopology` and
`CofiniteTopology` in the old path were back at `unmatched` in the new path, and two more had
been rewritten to point at the repository's own files instead of the library. Work was being
destroyed by being done twice.

So a migration closes the old path in the same operation that opens the new one, and when the
old path cannot be removed wholesale — because something else legitimately lives behind it — the
thing to close is the specific subtree that moved. "Ignored by git" does not close a path; git
stops seeing it while every tool, script and worker still reads and writes it.

Until the old path is closed, the two copies are the steward's to reconcile, and reconciling
means reading the diff rather than taking the newer file. Freshness is not correctness here: the
regression arrived last, and a steward that resolved by timestamp would have discarded the good
mapping and kept the one that recorded reinvention as a route.

## A correction can be worse than the mistake; say what was wrong, not what to undo

A steward who finds it wrote something false will want to retract it, and the retraction goes
out while the worker is already acting. On 2026-09-13 a steward filed a node claiming
`lean-categories`' mapping catalogue was outside version control, discovered the directory was a
symlink into a tracked vault, and sent a correction telling the worker to disregard it. The
worker had by then read the node and gone further than it asked: it moved all 378 records into a
tracked `corpus/` directory, repointed the frontier generator at it, gave the symlinks an
explicit ignore rule, and verified that a fresh clone reproduces `FOUNDATIONAL_FRONTIER.md`
byte-for-byte — which had not been true before. The premise was wrong; the defect underneath it
was real, and the worker fixed the real one. Had the correction been obeyed, good work would have
been reverted on the steward's authority.

So a correction states which claim was false and what the evidence now is, and leaves the
decision about work already underway to whoever can see it. "Disregard that" and "revert it" are
instructions about work; "the premise was wrong, here is what is actually true" is information,
and a worker holding the file in front of it is better placed to act on information than the
steward is. Where the steward does want something undone, that is a fresh instruction with its
own justification, not a rider on an apology.

And check afterwards what the worker did with it. The correction here was ignored in the right
direction, which is only visible by reading the commit — a steward that logged the retraction and
moved on would have recorded a stream as reverted while it was in fact ahead.

## Verify a blocking node's premise harder than an adding node's

Nodes are not symmetric. One that adds work costs the time it takes; one that blocks work costs
everything downstream of it for as long as it stands, and it stops a stream that was otherwise
running. On 2026-09-13 a steward ran `git status` in `lean-categories`, saw `?? .agents`, and
concluded that the corpus catalogue and every mapping decision — the artifact gating the whole
program — was outside version control. It filed that as a node blocking the re-mapping work that
mattered, and interrupted the worker with it. `.agents` is a symlink into the agent-memory
vault, a separate git repository, where 336 of 378 mapping files are tracked with full history.
`git status` in one repository cannot report the tracking state of a symlinked tree owned by
another; it reports only that this repository does not track the link.

So before a node blocks anything, state its premise as a claim and try to break it. Here that
was one `ls -ld` and one `readlink`. The narrower true finding survived — 42 tables untracked in
the vault, 23 files modified and uncommitted there, so mapping work is unbanked unless the vault
is committed too — and it belonged beside the re-mapping rather than in front of it.

The tell that a premise deserves this scrutiny is that it implies something alarming about work
that has been running for a long time without anyone noticing. A real defect of that size is
possible; far more often the steward is reading one instrument outside the context that makes it
meaningful. Correct a false blocker the moment it is found, in the document and to the worker,
and say plainly that it was wrong — a stop-work order left standing on a misreading costs more
than the misreading did.

## A cleanup loop improves what it finds and never asks whether it should exist

An audit that looks for bloat will find the worst implementation of a thing and make it a better
implementation of that thing. On 2026-09-13 `sage-categories`' terminal loop closed
`bloat-scheme-affine-wrapper-identity-cache` by replacing a hand-rolled `id()` dictionary with
Sage's `MonoDict` — a genuine improvement, recorded with a proper acceptance, and the wrong
question answered. The method still hand-writes check-dict, compute, store around that container;
`@cached_method` removes the cache outright, and the repository already uses that decorator 174
times. The owner spotted it from a one-line summary in a report.

Behind it sat the larger version. `UniqueRepresentation` and `CachedRepresentation` appear
nowhere in that repository, while `kernel/construction.py` keeps 394 lines of global
identity-keyed tables mapping every object, element and morphism to the construction that
produced it. That is precisely what the Sage mechanism provides, and the repository's own rule
requires verified evidence that no dependency satisfies a requirement before writing one — no
such evidence was recorded anywhere.

So a loop that audits implementation quality needs the prior question written into its
acceptance: does this exist because something upstream refused to do it, and is that refusal
recorded? Otherwise reinvention survives every cleanup pass, looking better each time, because
each pass is scored on the improvement it made rather than the question it skipped.

For the steward, the tell is a repair whose description names a data structure rather than a
behaviour. "Replaced X with Y" is a container swap; "removed X, the framework does this" is the
offload. The first deserves a second look at the mechanism around it.

## Ask whether the work should have existed, not only whether it happened

Counting commits was a proxy, so the tick started counting objects — definitions elaborated,
statements restored, constructions landed. That is better and it is still a proxy, because an
object that should never have been made counts exactly like one that should. On 2026-09-13 a
steward classified `lean-categories` as working for five consecutive ticks on a rate of roughly
twenty definitions an hour and on the definitions-before-theorems invariant holding, and never
asked the only question that mattered: whether Mathlib already had them. It did. The owner asked
after one definition took thirty-seven minutes, and the answer was a mapping sweep that had
written `unmatched` — the label that clears a unit for repo-local invention — across 70 of 70
rows in one source and 183 of 188 in another, on the ground that no single library declaration
realized a whole bundled textbook row. Every hour of that stream's healthy-looking output was
partly transcription of a textbook into Lean.

A reuse-first program cannot be audited from its output rate, because reinvention and
formalization produce the same commits at the same cadence and the reinvention is often faster.
It is audited by sampling: take one recent unit, find what the library actually has, and compare.
That is a few minutes per stream and it is the only check that distinguishes the two.

Run it on any stream whose product is mathematics against an existing library, and run it
especially when the stream looks healthy — a stalled stream gets read closely, and a productive
one gets left alone, which is exactly backwards when the failure mode is fast wrong work. Where
a repository decides reuse through a generated classification rather than a rule, read that
classification directly: a rule in a document is followed at a rate, but a table that says
`unmatched` is obeyed every time.

## An error rate is not comparable across streams doing different work

A steward with four transcripts will eventually divide errors by calls and compare. On
2026-09-13 that produced `lean-categories` at 13.8% against `sage-categories` at 1.6%, and a
first draft of a fleet-wide instrument defect. Reading the errors dissolved it: half were `lake
env lean` exiting 1 because a file did not elaborate, which in a proof assistant is not a fault
but the feedback loop itself — the worker reads the error, patches, and elaborates again. A
stream whose tool reports failure as its normal output will always look broken beside one whose
tool reports success.

The rate is not the finding; it is at best a pointer at which transcript to read. Classify the
errors by what failed before comparing anything, and expect the denominators to be
incommensurable — a Lean elaboration, a Sage suite and a pandoc render are not the same event.

Reading them did find something real, and much narrower than the rate suggested: thirteen
`cat > Foo.lean <<'EOF'` file writes failed in that one chat against zero in the three
repositories that do not write Lean, with the patch tool succeeding on the same content every
time. That is worth a rule in the repository that hits it. It is not worth the fleet-wide claim
the ratio was about to support, and the difference between the two was one command spent
reading the errors instead of counting them.

## Repair the document that states the rule, not the one that describes the work

A repository's documents are not interchangeable, and a worker blocked by one of them is
blocked by a specific one. On 2026-09-13 `research` would not start its verification phase
because a policy in `CONTRIBUTING.md` suspended all execution "while that work remains open".
The steward diagnosed it correctly and then wrote the correction into `TODO.md` — that the
suspension's condition was satisfied and the phase had begun — which is the work document. The
policy text did not change. The fix happened to reach the worker, but a worker consulting the
governing policy, which is what a policy is for, would have read the same prohibition and drawn
the same conclusion, and the next worker in that chat still would.

The rule states a condition; something else records whether the condition holds. When those are
different documents, the policy has to name where its own condition is checked, or it reads as
unconditional to everyone who does not already know the answer. That is the repair: not
restating the state somewhere convenient, but making the rule point at its own evidence.

So when a worker is blocked by a rule, find the text that actually blocked it before writing
anything. The document that describes the work is the tempting place to put a correction,
because it is the one the steward edits every tick; it is rarely the one that caused the block.

## Fix a failure mode in one repository, then sweep the other three for it

The fleet is four repositories with one steward, so a habit of that steward is present in all
four and a defect in how it writes is never local. On 2026-09-13 a steward found that a count
it had measured by hand and written into `new-qual-site`'s DAG was wrong, recorded the general
rule — route the node to the tool, never to the steward's arithmetic — committed it, and went
back to the tick. Twenty minutes later `lean-categories` turned out to carry the same mistake
twelve times over, one per source, with `fc05-definitions` still reading "199 definitions
pending of 376" after that source had closed at 371 of 371 and the denominator had moved twice
under classifier repairs. `research` carried a third instance in the steward's own prose.

Recording a failure mode is not the same as repairing it, and the repair is not the instance
that exposed it. When a tick produces a rule about how documents are written, the rest of that
tick is spent grepping the other three repositories for the same shape — before the next
measurement, because the stale documents are steering workers the whole time it is deferred.

The shapes worth grepping for are the ones that duplicate something a command regenerates: a
count, a percentage, a file list, a "N of M" in a node body, a frontier figure restated. A
record of finished work is different and belongs frozen — an audit that verified ten cards at a
named commit is a historical fact, not a stale worklist, and rewriting it destroys evidence.

## Sampling a detector's hits proves precision and says nothing about recall

A steward who writes a detector to size a defect will check it, and the natural check is to
read some of what it caught. On 2026-09-13 one scanned `new-qual-site` for unicode mathematics
outside LaTeX, got 182 cards, and validated it by reading samples from five unrelated
collections — every one genuinely damaged, so the detector was declared sound and its counts
were written into three DAG nodes as the worklist. When the repository's own tool landed it
reported 168 against a corpus the hand scan called 153: it caught U+2212 minus, the asterisk
operator, the tilde operator and the wedge, none of which were in the hand-written character
class. Every figure the steward had published was low, and no amount of reading the hits could
ever have revealed it — the misses are invisible to that check by construction.

Two rules follow. When a detector is a character class, an extension list or any other
enumeration, the thing to review is the enumeration itself against the domain, not a sample of
its output; and the cheapest real test of recall is a second implementation by someone else,
which is exactly what the worker's tool turned out to be.

And a count a steward measured by hand does not belong in a document a worker will work from.
Route the node to the tool that produces the number, so the worklist moves as the corpus moves
and so the steward's arithmetic is never the thing the worker is trusting. A number written
into a DAG is stale at the next commit even when it was right.

## Verify against the fastest true signal, not the most convenient one

An intervention is verified against new content, and content arrives in the repository last. On
2026-09-13 a steward pushed `research` onto its verification phase and then watched two proxies
for it: the mtime of the document that phase regenerates, and whether the next commit subject
stopped starting with `fix(`. Both said nothing for fifteen minutes and the steward reported the
intervention unverified twice. The worker had started two minutes after the push — `just
test-ci` and `just test-push` were in the process table, `scripts/build_graph.py` had just been
restored from an earlier commit, and the chat's own tool-call record showed Sage running under
half a dozen `exec_command` calls. The `fix(` commits the steward was discounting were the
repairs those runs were producing.

The instruments are ordered, and the order is not the order they come to mind in. The chat's
in-flight tool calls and stored transcript show what the worker is doing *now*. The process
table shows what it started and when, with real timestamps. The working tree shows what it has
written but not banked. The commit log shows what survived a gate, minutes later. A file's mtime
shows only that one particular path was touched, and a commit's subject line is a worker's
prose. Reaching for the last two when the first two are one command away is how a stream gets
reported stopped while it is running the suites.

So when a push aims a worker at a *kind* of work, name in advance what that work will look like
in the earliest instrument that can show it — which process it starts, which tool call it makes —
and look there. Reserve mtimes and commit subjects for confirming something the direct
instruments have already indicated.

## Historical failure: the continuation driver replaced stewardship judgment

A 2026-09-13 experiment used an unsupervised `bash` continuation driver so streams ending a turn
would not wait for the next stewardship tick. It sent work from timer/idleness state rather than
from a fresh reading of repository objective, artifact, invariant and evidence. That mechanism is
now prohibited. **Do not restart `driver.sh`, recreate it under another name, or treat its absence
as a fleet defect.** If such a process is still present, it is stale control machinery to retire
after the managed streams are safely accounted for.

The replacement is a **scheduled steward agent**. A native scheduler may wake a fresh model turn
on a fixed cadence (for example hourly). That model turn rereads the current durable contracts,
inspects all managed streams, classifies each one, chooses any send/interrupt/revive/replacement
from the evidence, and verifies the effect before ending. The scheduler decides only *when the
steward wakes*; the steward model decides *what to do*. This is active orchestration, not an
automatic continuation script.

For shorter intra-run cadence, the app's native sleep/wake state may be used to park and remount
conversation tabs and to expose `woke_ready`/sleep status as evidence. It does not authorize a
script to turn those events into unconditional `Continue` messages. A model stewardship tick may
use those events as one input to its normal classification and then drive the chat through the app
when the classification calls for it.

## Historical failure: "make the failure impossible" was read as "remove the tool"

On 2026-10-20 a Codex agent was asked to make the fleet's recurring worker failures
behaviourally impossible. The failures were rediscovery loops, wrong validation runs and
polling. The agent read the request as a capability problem and spent the day removing
capability:

- `bcdddad7`, `88808ae2`: signed-verifier "durable assignments", where a completed turn could not
  authorize a transition without a verifier receipt;
- `5da7bb10`, `de05d842`, `dc6852ca`, `9ada7608`, `b9e2146d`: controller-owned validation, a
  validation service, and Docker-isolated repository execution;
- `cdfe1cb8`: removed the app's unrestricted execution mode;
- `4f792d38`: unregistered `exec_command`/`write_stdin` from the worker surface, including in
  code mode. AGENTS.md was rewritten to say "Worker shell execution is absent" and "Workers ... cannot
  submit command text". The trigger was one worker running `timeout 5 python3 -m pytest
  ...::test_other` outside the job store;
- `a3d97dbf`: enforced assigned pytest scope.

It was merged as `a237fab6` and reverted the same evening (`9ba2342d`). `8887afaf` then removed
the assignment harness, keeping general MCP execution. None of it changed what the research
or Sage worker did next. Each mechanism became a second stream of unproductive work: the
supervisor substituting elaborate activity for the outcome, which is exactly the worker failure
it was meant to cure.

The error was the category. The failures were bad **decisions** made with adequate tools.
Removing the tools makes the product useless and leaves the decision unchanged. The correct
remedies are steward correction at the earliest wrong decision, and repository work contracts
(targeted tests, CI for significant runs).

The particular mechanisms are not the lesson, and pattern-matching against them guards
only against this exact repeat. The lesson is the two questions in §1, "Who sets the limits".
Each mechanism above reduced what models could do, or made the app act on their behaviour
without judgment.

**Near-repeats during the 2026-10-21 correction.** These came from the follow-up work, including
a strategy report and a Claude Code session. All are corrected:

- The report recommended that long computations be bounded only by their acceptance contract,
  and that steward docs preserve and supervise long runs. The owner rejected this. Workers do
  work with small targeted tests, significant runs go to CI asynchronously, and a worker job
  here over five minutes is a setup defect (owner decision 2026-10-21, "The managed
  workstreams").
- The liveness prompt's five-minute trigger was replaced with "elapsed time alone never
  establishes a wedge". Five minutes with nothing in flight is a real ChatGPT failure, and
  the trigger is restored.
- The orchestrator's uncommitted fix for stale bound-chat context sent `row.context` only to
  opening chats. That would have silently cut the steward's `/workstreams/context` redirect
  channel to running workers: a correction route removed to stop a nuisance. The committed fix
  (`91711214`) delivers each context revision once per conversation.

The common shape is a true observation about one failure turned into a rule that removes a
capability or a signal the system needs. Before committing a remedy, name the capability or
signal it removes and who relied on it.

## A cleanup step that has never once run looks exactly like a clean fleet

`tidy` takes positional parameters — `quiet` in minutes, then a comma-separated `keep` list —
and on 2026-09-13 a steward spent the session calling `just tidy quiet keep`, passing the
parameter names as values. It failed every time with a `float()` traceback from inside the
generated script, the failure scrolled past in a tick that had louder things in it, and no tab
was tidied for hours. By the time anyone looked there were duplicate tabs on two managed
conversations, which is a second typing surface on a chat that is supposed to have one.

The shape generalizes past this recipe. A maintenance step whose only evidence of success is
the absence of a complaint will be presumed to have run, and a step that never runs is
indistinguishable from a step with nothing to do. Read what a cleanup command actually printed
at least once per session rather than only noticing it when it is loud, and prefer a command
that says what it kept and what it closed over one that says nothing on success.

The recipe now names the mistake instead of raising. That fixes this call and not the class:
any recipe invoked from a tick script is worth invoking once by hand, with its output read,
before it is trusted to be quietly working.

## Check the work is possible before climbing the ladder

A worker doing something other than the node you pointed it at looks identical whether it is
ignoring you or blocked, and the unwedge ladder treats both as the first case. On 2026-09-13
`research` took a push, then an interrupt, and committed another unrelated repair after each —
by the ladder, two rungs spent and `revive` next. The node was `terminal-reference`, whose
deliverable comes from `just preamble-megadoc`, which surveys a live Sage session; the
repository's own phase rule forbids running Sage until a terminal phase the document never said
had started. The worker was doing the only thing it believed it was permitted to do, and
reviving it would have produced the same behaviour from a fresh chat, with the tree lost.

So before the second rung: open the node, find the command that produces its deliverable, and
check that the repository's own rules let the worker run it. A node that cannot be built as
written is a document defect, and it is the steward's defect, because the DAG is the steward's
surface. Escalating against it spends the fleet's time proving the same block twice.

The tell is a worker that keeps producing real work of the wrong kind. Genuine ignoring tends
to look like nothing, or like the same thing again; a blocked worker is busy, competent and
consistently adjacent — it has found the nearest thing it is allowed to do, and it will keep
finding it for as long as the gate stays shut.

## Production nobody has executed is not production

Counting objects rather than commits was the fix for one proxy and it quietly installed
another. A stream that lands definitions, constructions and repairs at rate reads as the
healthiest thing on the board, and the count never asks whether anything has ever run them. On
2026-09-13 `research` had produced its last sixty commits under a phase rule that suspends all
tests, gates and executions until a terminal node — sixty consecutive constructions, each
committed with the specimens that would falsify it and none of them executed — while the tick
scored it as working every twenty minutes for hours.

The bank is not the defect; deferring verification to a phase is a legitimate way to build, and
the repository says so in its own policy. The defect is a steward whose measurement cannot see
the difference between work that has been checked and work that merely exists, and who
therefore never asks the question the arrangement depends on: is the phase that retires this
still reachable, and is anyone moving toward it. There it had been reachable for some time —
twenty-eight work nodes closed, the terminal node carrying no prerequisites — and the worker
was spending its turns on further unverified repairs instead.

So the count has a second column. For each stream, what has executed the work it produced, and
when. Where the answer is a future phase, the phase's readiness is part of the tick: a
verification node that is ready and unstarted is a wedged stream however fast the commits
arrive, because everything landing meanwhile enlarges what that node has to survive.

And a repair made before the suite has run is a guess about what it would have said. If the
construction was sound, the repair changed working mathematics on no evidence. Repairs belong
after execution, against observed failures — which is what a terminal repairs node is for, and
why it sits downstream of execution rather than beside it.

## The acceptance you write into a node is the work the node will produce

A DAG node is a contract, and a worker satisfies the contract as written rather than the one
you meant. On 2026-09-13 the terminal audit loop in all four managed repositories said to
append every finding to `COMPLAINTS.md` and that findings need not be fixed in the same pass.
That is satisfiable in perpetuity by writing notes, and it is the node with the longest
residence time in the whole DAG — terminal and looping, so it is where a worker ends up and
stays. The same steward had spent the previous day removing paperwork from those repositories
and then wrote a node whose acceptance *was* paperwork.

Two things follow. Every node's acceptance must name an object that did not exist in the
repository before the turn: a solution written, a definition elaborated, a construction landed,
a refactor committed. "Record", "note", "audit", "review", "reconcile" and "mark" are verbs
that produce receipts, and a node whose acceptance is one of them will produce receipts. Where
a record genuinely belongs in the node — a backlog file, a findings log — it is the residue of
the turn, not its product, and the node must say so: the same turn repairs at least one of what
it files.

And looping nodes deserve the strictest reading, because a node that closes is audited once
when it closes, while a node that never closes is audited only by whoever reads the commits it
produces.

## Check a complaint is open before filing it as work

Promoting outstanding complaints into the DAG is steward work, and the word doing the work in
that sentence is *outstanding*. A `COMPLAINTS.md` heading is not a backlog item: many such
files carry resolved entries whose text records the repair, and most carry no status field at
all, so open and closed are indistinguishable without reading each entry to its end. On
2026-09-12 a steward promoted three `research` complaints as ready nodes and its worker deleted
all three the same hour as already delivered, then removed 137 lines of resolved text; the same
steward had filed 53 `new-qual-site` complaints the same way, of which four in a sample of five
described their own repair.

Filing already-finished work is worse than filing nothing. It sends a worker to re-derive a
repair that exists, and it inflates the ledger the tick is measured against, so the fleet reads
as having more to do and less done than is true.

Read the entry before promoting it. Where the file cannot answer whether an entry is open —
no status field, no resolution line — that absence is the defect to file first, ahead of any
individual repair, because every later promotion from that file is guesswork until it is
fixed. A promoted list whose entries have not been checked must say so in its own preamble,
so the worker checks before working rather than after.

## In this repository, author no longer separates steward from worker

Production is measured by filtering on `dzackgarza@gmail.com` because workers commit under it and
the steward commits under a noreply address. That separation broke here the moment this repository
became an approved sandbox root: a worker editing it commits under the repository's own configured
identity, which this repository's own policy requires to be the noreply address. On 2026-09-13 two
commits at 11:41 and 12:03 carried the steward's address and were not the steward's.

Both were good — one adding fleet convergence signals that warn against copying counts into this
file, one recording that a reuse search is not exhausted without querying the live
formalization-corpus index. Quality is not the issue; attribution is. Any measurement here that
assumes author distinguishes the two parties is now wrong, and a steward reading its own commit
count in this repository will over-report itself.

So in this repository use the commit *time* against the tick's own record of what it wrote, or
read the diff, rather than the author field. The four managed repositories are unaffected — they
are not sandbox roots for each other, and their workers still commit under the personal address.

And note the general shape: granting a worker write access to a repository silently merges its
identity with whoever else commits there under the same configured user. That is a reason to
decide the access question deliberately rather than as a side effect of making a path readable.

## Do not count your own commits as the worker's

The steward writes into the managed repositories — DAG items, `AGENTS.md` rules, queue filings
— and every one of those moves the same commit clock the tick verifies workers against. A
recovery watched with `git log -1` closes on the steward's own doc commit and reports the stream
restarted. On 2026-09-12 a `research` replacement produced nothing for twenty-five minutes while
three consecutive steward commits made its clock look alive, and the tick called it recovered.

The author field separates them cleanly: steward commits carry the GitHub noreply address
required of maintainer commits, worker commits carry the account's own address. Filter every
production read and every verification watch by it.

```bash
git -C <repo> log --all --since='<last tick>' --author='dzackgarza@gmail.com' --pretty='%s'
```

The same caution applies to any surface the steward writes: a ledger count moved by a filing, a
queue entry closed by a steward's own commit, a dirty count changed by a doc edit. Measure the
worker by what the worker did.
