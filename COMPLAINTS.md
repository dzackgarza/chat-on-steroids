# COMPLAINTS

Friction, deficiencies, and observed-but-unfixed defects, logged per the AGENTS.md
standing directive. Each entry names what was observed, where, and what (if anything)
was done about it.

## 2026-09-09 — push-path hardening agent

- **Flaky pre-existing test at HEAD:** `test/content-script.test.ts` › "the goal loop ›
  starts Goal when the only hidden-tab terminal mutation is the Stop control outside the
  transcript" fails intermittently (`expected 0 to be greater than 0` on `scans`) on a
  pristine tree with none of this session's changes applied — reproduced at commit
  d7cc9e1 both in full-suite runs and in isolation with `-t`, and then passed in a later
  full-suite run. It appears order/timing sensitive (it mixes the harness's instant
  timers with real `globalThis.setTimeout` waits). Not touched here: the goal loop is
  outside this session's push-path territory. Whoever owns Goal should reproduce under
  load before trusting a red run of this test.
- **`/commands/ack` truncates page error text to 200 chars** before it reaches the
  receipt, and the failed-send receipt wraps it further ("the browser could not start
  the chat — …"). Typed-outcome classification works on substrings so it survives this,
  but any future page-side failure reason must keep its distinguishing words near the
  front of the string or classification degrades to `failed`.
