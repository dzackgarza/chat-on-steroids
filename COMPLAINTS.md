# COMPLAINTS

Friction, deficiencies, and observed-but-unfixed defects, logged per the AGENTS.md
standing directive. Each entry names what was observed, where, and what (if anything)
was done about it.

## 2026-09-09 — sleep/wake architecture agent

- **`storedHistory()` closed `observer_lost` turns in the durable rebuild — FIXED.** The
  live projection deliberately keeps an `observer_lost`-ended turn recoverable (in
  `openTurns`, out of `knownTurnEnds`) so a returning page's real boundary or recovered
  final assistant message can supersede the unobserved closure — and its own comment
  admitted the restart rebuild "loses only the supersede nicety". With sleep/wake that
  nicety became load-bearing: a slept conversation's tab detaches mid-turn *by design*
  (`closeConversation` appends `observer_lost`), and the rebuilt `openTurns` on remount no
  longer contained the slept turn, so the reload-recovery path could never close it as
  `completed` and no wake could ever confirm. Fixed in `recorder.ts` by skipping
  `observer_lost` ends when rebuilding `openTurns`/`knownTurnEnds`, aligning the restart
  path with the documented live semantics; covered by the wake-cycle test in
  `test/sleep-wake.test.ts`.
- **`npm run verify:privacy` fails at baseline** with the two accepted historical
  findings (commits `9e27c0f` and `03acbfa` author emails). Every run therefore exits 1
  and the operator must diff the finding list by eye to see whether a change added
  anything. An allowlist for the two accepted commits would make the check green/red
  again. Observed, not fixed (the verifier's finding set is policy, not this task's
  scope).

## 2026-09-09 — push-path hardening agent

- **Flaky pre-existing test at HEAD — RESOLVED (test-harness race, not a Goal
  regression):** `test/content-script.test.ts` › "the goal loop › starts Goal when the
  only hidden-tab terminal mutation is the Stop control outside the transcript" failed
  intermittently (`expected 0 to be greater than 0` on `scans`) on a pristine tree —
  reproduced at commit d7cc9e1 both in full-suite runs and in isolation with `-t`, and
  then passed in a later full-suite run. Diagnosed 2026-09-09 by instrumenting content.js
  and timestamping the run: the production path is correct — the Stop-removal mutation
  does post `clf-fiber-ask` through the urgent microtask edge — but the ask crosses
  jsdom's `postMessage`, which delivers on a real Node timer, and the test armed one
  fixed 10 ms real timer *before* that delivery timer existed. Node runs expired timers
  in expiry order, so whenever the mutation → observe → askFiber chain took more than
  10 ms of wall clock, the test's own timer expired first and the assertions ran before
  the ask could be delivered (fails 3/3 at d7cc9e1 in isolation under 2026-09-09 machine
  conditions, so this was always the race, not a code regression in the push-path or
  session series). Fixed by replacing the fixed wait with `hostRoundsUntil()`, which
  re-arms a fresh short host timer each round until the scan request arrives, bounded by
  a real deadline so a content script that never asks still fails the unchanged
  `scans > 0` assertion. Same fix applied to the sibling hidden-tab case with the
  identical wait pattern. Target test passes 5/5 in isolation and the full
  content-script suite passes 293/293.
- **`/commands/ack` truncates page error text to 200 chars** before it reaches the
  receipt, and the failed-send receipt wraps it further ("the browser could not start
  the chat — …"). Typed-outcome classification works on substrings so it survives this,
  but any future page-side failure reason must keep its distinguishing words near the
  front of the string or classification degrades to `failed`.

## 2026-09-10 — out-of-band send detection agent

- **`session.test.ts` was never verified green against the send-origin change.** The
  work in `193539c` (send-origin classifier, `sendOrigin` on every `turn_start`, the
  out-of-band ledger) is proven by `test/sleep-wake.test.ts` (35/35) and
  `test/bridge.test.ts` (150/150), both re-run after the final edits, with
  `tsc --noEmit` clean and `verify:privacy` adding nothing beyond the two accepted
  historical findings. `test/session.test.ts` is the gap. One five-file parallel run
  reported 8 failures in it — the whole `open turns whose page observer disappeared`
  describe plus two in `naming the chats this app opened` — but that run had a second
  vitest process and a `tsc` competing for the machine, and
  `closes a silently open turn as observer_lost, on the record` passes 1/1 in isolation.
  Four attempts to reproduce the failures in a clean solo run did not produce a result:
  the file takes 8+ minutes, and each attempt was either reaped as a background job or
  (once) lost to an invalid `--reporter=basic` flag. **So the 8 failures are neither
  confirmed as a regression nor cleared as contention.** Next step for a fresh worker:
  run `npx vitest run test/session.test.ts` alone, with nothing else on the machine, and
  read the assertion text. If they are real, the two prime suspects are both in
  `recorder.ts`'s `turn_start` case — the classifier is called before the block's own
  bookkeeping mutates `observerLostAt`/`knownTurnStarts`, and `recordOutOfBandSend()`
  now writes a `logWarn` per unexplained `turn_start`, which can evict older lines from
  the 500-entry ring buffer that other tests assert against.
- **Behavior change to the sleep/wake contract, deliberate.** Page evidence of a fresh
  turn in a slept conversation used to be released quietly as
  `woke_unconfirmed` ("a tab this app did not open is observing the chat"). Under the
  break-glass demotion that reading is what made a bypass look like ordinary
  observation, so it is now `sleep_cancelled(out_of_band_send)` at error level, and the
  `slept` branch of `noteObservedTurnStart` is unreachable by construction. The
  superseded assertion in `test/sleep-wake.test.ts` was rewritten rather than deleted.
- **An out-of-band send now closes any open `push_correlated` window.** Found by the new
  test, not by inspection: a window armed by an *earlier* legitimate send stayed open
  across an out-of-band send and bound the next unseen key as `push_correlated` — the
  exact tier poisoning the feature exists to prevent. Fixed in `noteOutOfBandSend()`.
  One pre-existing test (`condemns a key whose first sight is claimed by the window and
  a different sole generator`) reached its contradiction through a decoy turn that is
  now classified out-of-band; its decoy was changed to an in-flight-command evidence gap,
  which is a real path to the same state, so the contradiction branch stays covered.
- **`pending_sleep` is deliberately not an evidence-gap excuse**, only `waking` is. The
  tab is alive and the turn the app verified is running, so a second turn starting in
  that window is a second message, not an artifact of the app's own bookkeeping.

## 2026-09-10 — send-path P0 verification agent

Verified the app send path end to end against the live fleet, on a scratch conversation
(`6aa25226-2c2c-83e8-8c28-eba743e4f51a`, "Reply verification") driven only through
`POST /send` / `just say`. Three separate defects made the sanctioned surface look broken.
All three are fixed and the fixes are live — the daemon was restarted onto them at 07:20 by
another worker, so nothing here is waiting on a restart.

- **The push window bound strangers' keys, and the wake detector then trusted the
  binding.** `claimPushCorrelation` claimed the first key it saw inside the correlation
  window, reading "not in `byKey`" as "never seen before". Under load almost nothing is
  ever in `byKey`, so an unbound key is normally one that has been calling for twenty
  minutes. Measured: **172 of 284 `push_correlated` attributions** in the 05:46–07:20
  daemon were filed into the scratch chat, a conversation whose entire content is "reply
  with ACK-n" and which has never made a tool call. Its worker's `uv pip install` and
  `just check-card` stream went into the wrong record and was charged to the wrong chat.
  Fixed by remembering first sighting for every key (`noteSessionKeySeen` in
  `connector-session.ts`) and gating the window on it. **After the restart: 0 misattributed
  calls, unattributed down from 74% to 32%, and `connector_session` firing at 40% where it
  had produced literally nothing before** — the tier was being starved by wrong claims.
- **A slept conversation with a bound key had no wake ceiling.** `armWakeTimers` armed a
  quiescence check and nothing else, so a foreign call stream reset the quiet clock forever.
  Live reproduction: **112 attempts, 111 refusals, 19 minutes** to deliver one message to an
  idle chat, with the next-check hint counting down to 1s and jumping back to 227s four
  times. `pendingTools` was 0 when it finally landed — the in-flight charge rule was never
  the blocker. `wakeDelayMs` now caps the wait at the same fallback horizon a keyless slept
  chat already had. Waking is not pushing: a remount that finds the turn still generating
  re-sleeps, so a busy conversation is still never interrupted.
- **`just say` reported a stalled bridge as an absent app.** The port hunt probed `/hello`
  with a flat `-m 1`. Sixty probes against a healthy daemon measured a median near 100ms,
  one at 6.3s, and one that never answered inside 30s — so **four of five pushes to an idle
  chat died with "Chat On Steroids is not answering on 8765-8769; is the app running?"**
  about a running app. `curl -fsS` on `POST /send` also turned every typed 409 into a bare
  `curl: (22)`, discarding the reason, the conversation and the next-check hint. Both fixed
  in the justfile (`--connect-timeout` split from `-m`, 409 bodies read and waited on).

### Measurements a fresh worker should not have to redo

- **In-flight records do not leak.** 1016 tool calls in the 05:46 daemon: durations p50
  1.2s, p90 30s, p99 38s, **max 92s**, two over 60s, none over 300s. The in-flight set held
  1–3 calls throughout and the daemon's child process census showed 8 children, longest
  15 minutes and legitimately waiting on a live `git commit`. There is no stale-record
  fleet-wide deadlock, and no evidence a dead process leaves its call record open. **Do not
  add an auto-abandon timer for a defect that has not been observed.**
- **Idle conversations are messageable now.** Post-fix `just say` into an idle scratch chat:
  58s, 123s, and 1163s (that one slept behind a genuinely busy turn). The floor is set by
  `sleepWake.quietMs = 4min` — a chat that answers in two seconds still costs one quiet
  window per message, because a discarded tab is the only thing that can see the turn end.
  That is the cadence to plan fleet pushes around, not a bug.
- **The refusal now names its calls.** `POST /send` and `GET /sleep/status` carry
  `inFlightCalls` (tool, age, attribution tier, `unplaced` for the charge-everyone case) and
  `just say` prints them. Deliberately reported and never judged: whether an hour-old call
  is plausible depends on what that worker was asked to do.

### Left open

- **The bridge stalls its event loop for tens of seconds under fleet load.** Reproducer:
  `for i in $(seq 1 60); do curl -s -m 30 -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:8765/hello; sleep 1; done` — expect roughly one probe in twenty outside
  a second and occasionally one that never returns. The justfile no longer mistakes this for
  a dead app, but the stall itself is unexplained. `readRecentEvents` was checked and is
  tail-bounded, so it is not the obvious culprit; the two largest `events.jsonl` are 61MB
  and 48MB if that turns out to matter. Needs a profiler on a daemon that can be restarted.
- **Key rotation can still mis-bind.** The first-sight gate stops a *pre-existing* key being
  claimed, but a worker whose key rotates mid-turn presents a genuinely new key that the
  window may claim. Blast radius is now bounded by the wake ceiling rather than unbounded.
  If this shows up, the next step is requiring the window to see exactly one first-sighting
  before it binds anything, rather than claiming on the first.
- `verify:privacy` fails on two 2026-08-28 merge commits from an external contributor
  (`totec448@gmail.com`, PRs #19/#20). They are not ancestors of HEAD. Pre-existing.
