# exec_command orphan accumulation — 2026-09-09

Observed at the Sep 9 daemon restart (headless rack, 7 GB box): the daemon's cgroup
held **52 processes** — roughly 40 orphaned `exec_command` wait-loops and about a
dozen stranded pandoc servers — at 6.0 G peak memory with 4.7 G swap in use. The
restart cleared them; nothing in the app reaped them while it ran.

Two distinct defects:

1. **No lifetime bound on exec_command descendants.** Worker-spawned wait-loops and
   servers outlive their tool calls indefinitely. The `exec` suite covers
   process-tree termination primitives and `shutdown` covers teardown, but nothing
   bounds or reaps long-lived orphans *during* operation. Wanted: a reaper or
   lifetime policy for exec descendants that have no live tool call, with loud
   logging when it acts (and an allowance for deliberately persistent processes, if
   any exist, to be declared rather than inferred).

2. **Self-matching poll loops can never exit.** Several orphans were
   `pgrep -f <pattern>` loops whose pattern matched their own command line — each
   loop finds itself, stays "alive," and spins forever. Worker-authored, but the
   app is the only place a guard can live (e.g., the reaper above; the pattern is
   detectable: a poll loop whose watched pid set includes itself or its own shell).

Fix owner: this repo. Status: **fixed, pending restart** — implemented in
`84c1b72e9578a24cc600ae67a12aa07e946f7844` (reaper, spawn marker, startup sweep,
tests). Every unified exec spawn now carries a `CLF_EXEC_SPAWN` ownership marker
inherited by all descendants; a periodic sweep (default 10 min cadence and 10 min
orphan lifetime, `COS_EXEC_REAP_INTERVAL_MS` / `COS_EXEC_ORPHAN_LIFETIME_MS`)
kills the process tree of every session whose owning tool call ended beyond the
lifetime — which subsumes the self-matching poll loops in defect 2 — plus, on
Linux, marked descendants that outlived their session; and a startup sweep reaps
a previous run's leftovers deliberately, with every kill logged at warn level
with pid, age, and command line. Deliberately persistent sessions are declarable
(`UnifiedExecProcessManager.declareSessionPersistent`), not inferred; a
model-facing declaration surface still needs wiring in `mcp/tools-core.ts` once
the attribution work there lands. The code activates at the next daemon restart;
the live daemon predates it and still has no reaper until then.
