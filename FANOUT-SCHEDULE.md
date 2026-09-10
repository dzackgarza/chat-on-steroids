# FANOUT-SCHEDULE

The fleet's parallelization plan: how many managed worker streams each repository
supports, how the work is partitioned so streams cannot collide, what must be true
before fanning out, and which events change the stream count. Derived from a
DAG-structure and file-surface analysis of each repository on 2026-09-09; landing
projections use each repo's measured content velocity, not commit counts.

Stewards act on this document: spawn and route workers to match the target stream
counts, watch the unlock triggers during the hourly failure-mode sweep, and update
this schedule when a trigger fires or measured velocity moves a projection. Stream
counts are targets under current conditions, not maxima to exceed — every width
number below is capped by a named constraint (file-surface contention, DAG width,
or machine RAM), and exceeding it recreates a documented failure mode.

Universal rules, inherited from AGENTS.md and each repo's own docs: one front per
worker, closed to acceptance; claims before authoring; workers read their repo's
AGENTS/CONTRIBUTING, not steward prompts, for policy. When fanning out, **stagger
the initial launch requests by at least 10 seconds each** — a simultaneous burst of
new-worker requests trips rate limiting; spacing the kickoffs costs nothing against
hours-long streams.

**Messaging a worker goes through the app:** `just say` → `POST /send` → poll
`/send/outcome` to `sent_verified`, then the sleep/wake contract in AGENTS.md §14.
The app owns the browser, so it holds the send registry, the draft ledger,
single-driver enforcement, sleep/wake state, and send-correlated attribution; a
send it did not make leaves all of that wrong, and it records any such send as
`sendOrigin: out_of_band`. A nonzero out-of-band counter means something is
driving a composer behind the app — treat it as an incident and find it.

**A broken send path is a P0 defect in tooling we own — fix it.** That is what the
degraded-control brake buys time for: hold width, keep existing streams running,
and repair the app. Repair is also the faster path. The attribution outage that
took the send path down was root-caused and fixed in hours once someone looked at
it, and the day spent working beside it instead cost a fleet-wide bookkeeping
blackout, a wedged-composer failure class, and a day of unattributed calls.

*Status 2026-09-10: brake lifted. The transport stopped sending `x-request-id`, so
the app now attributes connector calls by evidence — session keys bound at moments
the app can prove — and the charge-against-every-chat rule narrows per worker as
each key binds. Sends, tab recovery, and sleep/wake all run through the app; §14
holds the contract and the browser behaviors it handles (activation before typing,
duplicate and frozen tabs, draft recovery, turn_start verification). new-qual-site
is at its 8-stream target.*

While attribution is broken, per-chat `tool_call` recency is unavailable as an
evidence channel — every call lands in one unattributed session. Stream state
comes from `just chats` rows, and fleet-level execution from the unattributed
bucket still growing.

---

## new-qual-site — 8 streams (widest, cleanest)

Card corpus, file-independent units. Measured remaining: 3,484 unsolved of 7,319
problem cards, plus a 502-card Gemini-redo set and a 464-card RA audit sweep.
Real-analysis authoring is complete (0 unsolved); its stream capacity rolls into
the partition below.

**Partition (claim-by-collection; each stream single-subject, directory-disjoint):**

| Stream | Scope | Load (card-eq) |
|---|---|---|
| S1 alg-loose | `problems/Algebra` unsolved | 412 |
| S2 alg-exams | UCSD-APALG/ALG, UGA-ALG, UW-ALG, ART-ALG, LERMAN (60 colls) | 427 |
| S3 alg-drill+orals | TEXT-HK71, HUN74, DF04, Harvard algebra orals | 344 |
| S4 top-exams | UCSD-TOP-\*, TOP-JUSTIN, 290QUALS, TOP-20xx, `problems/Topology` | 456 |
| S5 top-drill | TEXT-MUN00, TEXT-HAT02, TOP-WORKSHOP(-2020) | 388 |
| S6 CA | `problems/Complex_Analysis`, EMORY-CA, CA-ART, UCSD/UGA-CA, complex oral | 411 |
| S7 RA audit+small | RA audit sweep (464 files) + JHU, INTEGRAL-PRACTICE, UGA-PRELIM, SS03/SMI | 464 |
| S8 alg-redo | the 502 Gemini-authored files (explicit file list, not directories) | 402 |

**No worktrees, no branches — streams work directly on `main`.** Authoring a solution
creates prose in a card file that no other stream owns; two streams writing different
cards cannot conflict, so there is nothing for a branch to isolate. The worktree-and-
branch apparatus this repo accumulated bought nothing and cost a great deal: 37
worktrees, 31 duplicated virtualenvs, 15 GB, a full volume, and — worst — roughly
1,800 commits of finished solutions stranded on branches that were never merged, so
`main` did not have the work. Commit straight to `main`; git already serialises
concurrent commits to disjoint files. Reserve a branch for something that genuinely
needs isolation, such as a sweeping change to shared tooling, and merge it the same
day.

**Contention rule:** streams never touch `queues/C-unsolved-cards.md`; each derives
its worklist with `just unsolved-in <collection>`. S1/S8 and S3/S8 share directories
but are provably file-disjoint (unsolved vs Gemini-solved); S8's claim boundary is
its saved file list. Queue regeneration happens once, on main, at consolidation.

**Preconditions:** a shared-resource contract, and it was missing when this repo was
fanned to 8 — which is how the checkout reached 16 GB across 38 worktrees, each
carrying its own `.venv`, on a disk that then hit 100%. Streams may hold separate
worktrees, but never separate copies of anything regenerable: one virtualenv, shared
read-only, exactly as lean-categories shares `.lake/packages`. A worktree is retired
by the agent that created it once its unit is integrated, and a stale entry in
`git worktree list` is a retirement debt, not a second writer. Branch consolidation
is not a precondition — algebra branches are already consolidated into main (all
`agent/*` solved sets are subsets of main). **Projected landing: Sep 11–12 at N=8; N=6 is the
minimum that makes Sep 13.**

---

## research — 5 workers + archive stream (~2.5×)

TODO.md dependency DAG, 58 open nodes, ready frontier 12 wide, sustained width ≥5.
Critical path 13 nodes; final ~5 nodes (`package-organization` → terminal chain) are
strictly serial whole-tree surfaces — the last day is single-stream by nature.

**Assignment (one claim at a time per worker, DEV-60/61):**

- **W1 rings/local-algebra:** `localization` → `local-module-maps` → `normalization` → completion chain. Surface: `rings/*`.
- **W2 kernel/wiring (exclusive owner of all shared-preamble surfaces):** `universal-constructions` first (gates the 7-node completion spine), then `category-order` → `constructor-convergence` → `category-boundaries`; `framework-transfer` last. All `all.py`/`lexicon/` edits route through W2.
- **W3 schemes/descent:** `affine-descent` → `general-descent` → `sheaf-operations` → `sheaf-functors` → `relative-spec`, then the divisor/scheme-products web.
- **W4 cohomology:** `complexes` → `dga-cohomology` → `toric-cohomology` → `tor-ext` → `geometric-cohomology`.
- **W5 arithmetic:** `reduction-complexes` (lattices read-only), `witt-recursion` when the live `parabolic-gluing` claim releases, then `arithmetic-applications`.
- **W6 archive-reconciliation:** continues as-is (per-item claims, leaf-additive).

**Cap: 6 workers.** The funnel is serial and `collection-ownership`/`package-organization`
require everyone else stopped.

**Preconditions (blocking — do not fork worktrees until done):**
1. The shared checkout's ~60 dirty paths (including an uncommitted 435-line `all.py`
   diff) must land or be attributed; they cover exactly the W1–W5 surfaces.
2. TODO.md's Active-claims table is collision-corrupted; restructure to per-worker
   claim blocks (claim/release commits stay on main inside the flock mutex).
3. Reconcile the dangling `witt-recursion → lattice-embeddings` edge (delivered node
   still listed as a blocker).

**Projected landing: implementation queue ~Sep 11–12 (from Sep 14–16 single-stream).**
Phase-T verification remains a separately scheduled phase; no gates run mid-refactor
(DEV-58) and stewards never chase these workers into gated commits.

---

## lean-categories — 4 streams now; rack migration is the real unlock

Source-manifest DAG: FC04←{01,03}, FC05←{01,03,04}, FC13←{01,04,05}, FC06←{01–05,13},
FC07←{01,02,05}, FC08←{01,02,07}, FC09←{01,04}, FC10←{01,04,09}, FC11←{01,04,09,10},
FC12←{05,06,07,08,11}, FC14←{01,03}, FC15←{01,11,14}, FC16←{01,04,06,14}. Sustained
sweep-III width: **2–3** (critical path FC04→FC05→FC13→FC06→FC12 carries most units).
Zero cross-source unit references — sources are clean claim boundaries.

**Streams:** after FC03 closes (~13 units): three sweep-III streams starting
{FC04, FC14}, then {FC05, FC09}, then {FC13, FC07, FC10}…; plus **one sweep-IV
stream on FC01 theorems immediately** — FC01's mapping is complete (1,234 units, 91
unmatched) and its obligations consume only FC01 vocabulary + mathlib.

**Preconditions:**
1. A bounded TODO.md edge refinement: replace the global `definitions → theorems`
   edge with per-source `theorems(FCk) ← definitions(FCk ∪ prereqs(FCk))` (the
   plan's own semantics — "a consumer is blocked only by the exact theorem units it
   requires" — already endorse this; use the DAG-change protocol in TODO.md).
2. Worktree scaffolding: branch per source (`corpus/fc04-defs`, `corpus/fc01-thms`),
   shared read-only `.lake/packages` symlink, per-worktree `.lake/build`, a shared
   build flock, `merge=union` gitattribute for the append-only `All.lean`, no
   `lake update` in streams.

**Hard constraint: 7 GB RAM caps concurrent `lake build`s at 1–2**; a 5th stream
contends for memory, not work. Integrator merges to main daily, runs the single
full `just test` per batch, and solely owns `foundational-corpus-status.md` flips.
**Projection: sweeps III+IV in ~60–75 days at 4 streams vs ~130+ single-stream.
The remote-rack migration lifts the RAM ceiling and makes sweep-IV width (the
majority of remaining effort) the payoff — revisit this section when it lands.**

---

## sage-categories — 3 workers now; 5–6 + integrator after the unlock

Remediation DAG: ten root nodes, but kernel-file contention collapses useful width.
Domain leaves consume kernel API; kernel fronts collide on `cat/category.py` and
siblings and must run one at a time.

**Now (pre-unlock), 3 workers:**
- **W1:** `python-runtime` to closure, then `gate`. **This is unlock 0 — no front
  can reach acceptance while the declared Sage runtime is unavailable to execution
  processes; parallelizing source fronts before it closes recreates
  breadth-of-uncommittable-work.** File-disjoint from everything.
- **W2:** `sets` to acceptance (owns `sets/*`, `engines/finite_sets.py`); this
  legalizes the in-flight `indexed` (~0.7 done) for acceptance next.
- **W3:** `functors` — the sole `cat/category.py` lane; the refinement quartet
  (`refinement`/`inverses`/`isofibrations` → `named`) takes this lane afterward,
  never concurrently.

**Unlock 1:** when `universal`, `named`, and `additive` accept, five file-disjoint
domain fronts open simultaneously: `orders`, `kan`, `groups`, `tensor`→`modules`,
`rings`→`spaces-sheaves`→`affine`→`gluing` (the geometry chain becomes the new
critical path — start `rings` immediately), plus `diagrams` on the kernel lane.
Then: **5–6 workers + one integrator** (sole writer to `codex/functorial-core-kernel`,
merges at plan-acceptance only; workers on `front/<node>` branches rebase on the
integrator tip before every claim). Pre-agree: `cat/relations.py` belongs to the
`kan` front; `orders` stays inside `order/posets.py`.

**Hard rule:** no front is assigned before its DAG prerequisites are accepted — the
early `additive` work already demonstrated the cost. Compression is entirely in the
back half; the pre-unlock spine is serial and more workers cannot shorten it.

---

## Fleet totals and machine constraints

**Every width number assumes streams share regenerable state.** Per-stream worktrees
are cheap; per-stream virtualenvs, package caches and build outputs are not, and they
multiply by exactly the number this document authorizes. Before raising a stream count,
name what the new streams will share and what they will duplicate — a partition that is
collision-free on files can still be ruinous on disk. The failure is silent until the
volume fills, and then it presents as killed builds and dead exec sessions rather than
as a disk error.

Full fan-out ≈ 20 streams. Card-solving and prose-authoring streams are I/O-light;
the only machine-bound repo is lean-categories (RAM). Actual stream counts are the
owner's resourcing decision; this schedule defines the ceilings, partitions, and
triggers so scaling is a dial, not a redesign.
