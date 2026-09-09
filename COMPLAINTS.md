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
