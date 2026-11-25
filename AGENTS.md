# Chat On Steroids — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here. If you are
here to stand the watch over the managed fleet rather than to change this app,
**[`docs/agents/steward.md`](docs/agents/steward.md) is the whole of it; read it in full
before you act on the fleet.** Each lesson there
is stated once; the dated incidents behind them are evidence in `docs/steward-incidents.md`, and
a steward never needs to read that file to act correctly. A replacement chat in this repository
must read every line of this file before it may act (the owner-requested rules gate,
`src/main/rules-gate.ts`), so every line here costs every replacement chat. Put evidence in the
incident file, not here.

**One map, plus task files.** This replaces the old `AGENTS.md` + `agent.md` split, which
duplicated roughly 60% of its content and had already drifted between copies. Every task
reads this file. Guidance that only one kind of task needs lives in `docs/agents/`, and §19,
"Task-specific guidance", says which file to read before which task. If your harness truncates long project docs, raise its limit rather than cutting
this down.

Because a truncated tail would drop §19 first, the one rule whose loss is irreversible is
repeated here: **this tree is usually dirty and shared with the user and other agents —
never `reset`, `checkout`, `clean`, reformat, or overwrite work you did not do.**

The second rule whose violation destroys the product is repeated here for the same reason:
do not neuter this app to restrict or control agent behaviour automatically. It is an
instrument that extends what agents can do, not a policy engine that decides for them. Any
change that reduces what connected models can do, or makes the app act on agent behaviour
without an owner or model judgment, needs an explicit owner instruction, whatever mechanism it
uses. See §1, "Who sets the limits".

---

## 1. The app in sixty seconds

A **Windows/macOS/Linux Electron app** that hands ChatGPT a deliberately small set of local
computer capabilities over MCP. It is a bridge and a permission layer — not a chat client,
not a model host. It also ships a Chrome extension that watches ChatGPT itself, so the app can
record conversations, prove which conversation issued which tool call, replace generic tool
rows with what actually happened, compact a long chat into a fresh one, and run worker chats.
Core is portable; the Desktop/computer-use surface is deliberately Windows-only and must be
absent from live macOS/Linux capability/discovery state.

Four runtime planes, only two of which are servers:

```text
              ── PUBLIC / CHATGPT SIDE ──────────────────────────────

 ChatGPT model                                    ChatGPT web page
   │  MCP over HTTPS                                │
   ▼                                                ├─ chatgpt-dom.js  selectors only
 ┌──────────────┐  ┌──────────────┐                 ├─ content.js      isolated-world
 │ Core         │  │ Desktop      │                 │                  recorder + UI
 │ files/term/  │  │ screen/input/│                 └─ fiber.js        MAIN-world React
 │ session/     │  │ clipboard    │                                    evidence
 │ agents       │  │              │                        │
 └──────┬───────┘  └──────┬───────┘                        ▼
        └────────┬────────┘                        background.js  MV3 worker, journal,
                 │ tunnel                                         tab↔conversation registry
                 ▼                                                │ HTTP 8765-8769
   127.0.0.1  MCP server                                          ▼
   secret tokenized path per surface                        bridge.ts
                 │                                                │
   server.ts → tools.ts → kernel.ts                               ├→ recorder / correlation
                 │                                                ├→ Compact & Resume
        ┌────────┴────────┐                                       └→ agent bootstrap
   Core tools        Desktop tools
        │                 │                        ── ELECTRON RENDERER ──
   sandbox +        computer/*                      renderer → preload (fixed API)
   codex/* ports                                             → ipc.ts → main services
        │
   files + processes
```

**The MCP server and the browser bridge are two different servers with two different
threat models.** MCP is the model's capability endpoint. The bridge exists only for the
Chrome extension and deliberately has no route that reads a file, runs a command, or
changes a permission. Never merge their lifecycles or their auth.

The extension never executes a tool. It observes ChatGPT and reports evidence. **The app is
the only authority on what a local tool actually did.** The renderer has no Node, no
filesystem, no command, no network authority; it crosses preload through named IPC.

### Who sets the limits

"Permission layer" means the **owner's** limits: the capability toggles, approved roots,
read-only mode and security boundaries the owner configures (§8, §21). It is not a place for
agents to encode corrections of other agents. The app's purpose is to give ChatGPT
general-purpose local capability: shell, files, patching, agents. A worker that makes bad
decisions with that capability is corrected at the decision, by the steward ([`docs/agents/steward.md`](docs/agents/steward.md#an-intervention-is-a-change-in-the-workers-next-decision), "An
intervention is a change in the worker's next decision"), and in its repository's work
contract. It is never corrected by making the app refuse, gate, wrap, confine or kill.

Every change to this app is tested against two questions, and the mechanism does not matter:

1. **Does it reduce what a connected model can do?** That includes removing a capability,
   narrowing it, confining it, hiding it, slowing it, adding friction or approval steps in front
   of it, or altering what it reports.
2. **Does it make the app act on agent behaviour without a judgment?** That means the app
   refusing, blocking, pausing, killing, re-scoping or redirecting work because a rule,
   detector, threshold or timer fired, rather than because the owner configured it or a steward
   model decided it from evidence.

A "yes" to either needs an explicit owner instruction naming the change. The app exposes state
and verbs, and judgment is exercised by the owner and by stewards that read evidence. Encoding
judgment into the app replaces judgment with a mechanism that cannot see whether the work is
right. That is the failure mode this whole document exists to prevent, moved into code where
it is harder to see and harder to undo.

Existing owner-approved mechanisms stay. The test governs what gets added or tightened. The
[2026-10-20 incident](docs/steward-incidents.md#historical-failure-make-the-failure-impossible-was-read-as-remove-the-tool) is one instance. Do not treat its particular mechanisms as the boundary,
because the next instance will use different ones. A request to make a failure "impossible" is
a request about decisions and contracts, never about capability.

## 2. Where the bugs actually are

Almost nothing hard here is a local algorithm bug. The hard ones live on six boundaries:

| Boundary | The two things people confuse |
| --- | --- |
| Discovery vs. enforcement | a schema ChatGPT cached vs. a permission that is live *now* |
| Path spelling | `/project/src/a.ts` vs. a native `C:\work\...` or `/home/...` path — same decision required |
| Request vs. conversation | HTTP `x-request-id` vs. the ChatGPT conversation that owns it |
| Process lifetime | content script (document) vs. service worker (suspends) vs. app (restarts) |
| Durable vs. frontend identity | local session id vs. the ChatGPT conversation attached to it |
| Async vs. selection | a load started for A vs. the B the user has since selected |

If a bug looks like four subsystems failing at once, it is one of these, once. Find the
**earliest wrong identity or state transition** — not the last UI that displayed it.

### Name the identity, then find where it is lost

Every boundary above is a place where one specific identity is supposed to survive. Before
reading any code, say which one this bug is about. If you cannot state it, you have not
found the real boundary yet.

| Plane | The identity that must survive |
| --- | --- |
| filesystem | approved root + canonical real path |
| MCP call | required admitted workstream id; optional request id for diagnostics |
| tool ownership | logical workstream + current opaque claim |
| browser observation | conversation id + navigation epoch + message/turn identity |
| agent | conversation id -> prime or worker slot |
| workspace | logical workstream/agent key -> cwd |
| terminal | logical workstream + opaque claim -> exec session id |
| session | logical workstream -> durable recorder session; browser conversation is optional routing metadata |
| compaction | continuation token + from/to conversation |
| renderer load | selected session id + load generation |
| connection | tunnel/endpoint generation |
| desktop coordinates | screenshot frame id |

Then classify which plane produced the **first** wrong fact — MCP transport/discovery,
permission/sandbox/tool runtime, browser observation/identity, bridge/session/agent
orchestration, renderer presentation, or tunnel/packaging. Do not start in the file where
the symptom is displayed.

Three policies apply everywhere and are not repeated per section:

- **Fail closed** when a guess could cause cross-root access, cross-chat attribution,
  cross-agent terminal control, wrong workspace mutation, wrong compaction target, unsafe
  rendered HTML, or invalid image content reaching the model. For presentation-only
  degradation, keep the UI usable and label the uncertainty instead.
- **Scope every async result to the epoch that requested it** — navigation epoch, load
  generation, connection generation, endpoint lifetime. Id equality alone is not enough:
  an A → B → A navigation defeats it.
- **Bound every representation of large output** — bytes, tokens, decoded pixels, base64,
  structured fields. Not just the visible text, and not just the compressed input.

## 3. What is authoritative

Sources disagree here because the architecture moved fast. Precedence:

1. current implementation **plus a reproducible test or live repro**;
2. current declarations: `mcp/surfaces.ts`, `mcp/tools-core.ts`, `mcp/tools-desktop.ts`,
   `shared/types.ts`, `package.json`, `main/version.ts`, `extension/manifest.json`;
3. `README.md`;
4. public design references such as `docs/tool-surface.md`. Internal working notes and
   security reproductions are maintainer-only; a public clone should treat §5–§18 of this
   file as the architecture and design record.

**Code comments in this project are unusually load-bearing.** Many name the exact live
failure that motivated a guard. Read the comment before deleting the guard or "simplifying"
the state machine. Code and current tests still win when a comment has drifted.

### Baseline

Release numbers are authoritative in `package.json`, `src/main/version.ts` and
`extension/manifest.json`; the bridge protocol is `version.ts::BRIDGE_PROTOCOL`. Tests assert
the app/extension versions stay in sync, so this architecture guide deliberately does not
copy a release number that can drift. Core is cross-platform; main process is TypeScript;
extension is plain MV3 JavaScript with no build step; `node-pty` is the main native
terminal dependency. Desktop automation remains explicitly Windows-only.

Fresh-install defaults from `config.ts` — **all Core tool permissions on**, **read-only off**,
**recording on**, session advisory/limit **400k/533k** estimated tokens, **auto-compaction on
at 400k and edge-triggered**, **multi-agent on** with `maxWorkers` 2 (hard max 8). The limit is
derived, never typed: the Chat panel offers one threshold and writes `limit = threshold × 4/3`,
so the defaults have to satisfy that relation or the first save in that panel moves the red
line. Existing
configs keep explicit user choices; conservative migration defaults do not widen omitted legacy
permissions merely because the fresh-install defaults are broader. Windows also enables the
Desktop capability group; macOS/Linux mask that group off at runtime while preserving stored
choices so a config moved back to Windows does not lose them.

### Stale-doc traps

Do not "restore" these from an older document:

- `view_image` is its own Core tool, not a mode of `read`.
- Core declares **8** tool names but at most **7** are live: `find` and the exec pair are
  mutually exclusive. Desktop adds at most 2. Live ceiling is 9, and reporting must derive
  from the surface projection, never a hardcoded count.
- `session` has exactly two actions, `search` and `read`. Search discovers recordings; read
  requires an explicit local session id and returns lossless cursor pages. Compact & Resume is
  app/browser orchestration — there is no model-visible `save_handoff`.
- Extension pairing is silent loopback `/pair` bearer provisioning. The six-digit flow is gone.
- Canonical messages live in `messages/*.json`, one replaceable shard per logical id; legacy
  `messages.json` is read during lazy migration. They are not appended forever to `events.jsonl`.
- `computer` carries **13** action variants, not 11.

## 4. Repository map

```text
── shell / config ─────────────────────────────────────────────────────────
src/main/index.ts             Electron startup, window/tray, shutdown, security shell
src/main/shutdown.ts          ordered teardown phases, each bounded, ending in the exit
src/main/config.ts            validated settings, migrations, defaults, read-only caps
src/main/connection.ts        MCP + tunnel lifecycle, per-surface publication & status
src/main/ipc.ts               every renderer→main operation and main→renderer push
src/preload/index.ts          the complete renderer-facing API allowlist
src/main/secrets.ts           Electron safeStorage-backed secret storage
src/main/logger.ts            redacted RAM-only operational log (not the session store)
src/main/durable.ts           small named JSON state files under userData/state
src/main/diagnostics.ts       the UI self-test chain, hop by hop

── MCP ────────────────────────────────────────────────────────────────────
src/main/mcp/server.ts        HTTP transport, secret paths, body bounds, exposure cache
src/main/mcp/tools.ts         builds exactly one surface's server; refuses foreign names
src/main/mcp/surfaces.ts      Core/Desktop discovery boundaries + declared tool names
src/main/mcp/kernel.ts        dispatch, live guards, caller/workspace identity, agent inbox
src/main/mcp/tools-core.ts    Core registration + connector wrappers
src/main/mcp/tools-desktop.ts Desktop registration + wrappers
src/main/mcp/inbound.ts       x-request-id extraction and normalization
src/main/mcp/call-context.ts  AsyncLocalStorage per call + in-flight accounting
src/main/mcp/instructions.ts  model-facing server instructions

── filesystem / execution ─────────────────────────────────────────────────
src/main/sandbox.ts           approved-root authority; virtual↔native containment
src/main/workspace.ts         per-chat/agent learned project cwd (convenience, not auth)
src/main/rawfs.ts             raw Node fs, bypassing Electron's asar interception
src/main/fsops.ts             shared bounded file/image/text helpers
src/main/search.ts            connector search implementation
src/main/codex/tool-specs.ts  model-visible Codex contract text
src/main/codex/unified-exec.ts        exec_command / write_stdin runtime
src/main/codex/unified-exec-constants.ts  yield deadlines, buffer and token policy
src/main/codex/exec-output.ts model-facing exec serialization
src/main/codex/shell.ts       host shell selection, quoting, launch
src/main/codex/ownership.ts   terminal-session caller ownership
src/main/exec-reaper.ts       orphaned exec descendant reaper (startup + periodic sweeps)
src/main/exec-spawn-marker.ts CLF_EXEC_SPAWN ownership marker for exec descendants
src/main/codex/filesystem.ts  ported low-level Codex fs primitives (no policy)
src/main/codex/read-backend.ts  connector read semantics over those primitives
src/main/codex/view-image.ts  image load/validate + MCP content adaptation
src/main/codex/apply-patch/*  V4A parser / matcher / runtime / shell interception

── sessions ───────────────────────────────────────────────────────────────
src/main/session/store.ts     durable sessions, messages, assets, handoffs
src/main/session/recorder.ts  merges MCP truth with browser observations
src/main/session/correlation.ts  requestId → conversationId proof registry
src/main/session/continuation.ts transactional Compact & Resume rebind
src/main/session/handoff-prompt.ts  the brief injected into the old chat
src/main/session/summarize.ts human-readable activity summaries
src/shared/chronology.ts      timeline ordering and folding
src/shared/session.ts         session/activity/swarm wire types
src/shared/goal.ts            Goal prompts (continuation + specific goal) and their bounds
src/shared/types.ts           config/app/IPC types and Capabilities

── browser ────────────────────────────────────────────────────────────────
src/main/bridge.ts            extension HTTP bridge + compaction/worker orchestration
src/main/goal.ts              the goal loop: OpenRouter request, context, one draft per turn
src/main/agents.ts            the one global star-topology multi-agent broker
extension/chatgpt-dom.js      EVERY ChatGPT selector and DOM-shape assumption
extension/content.js          page recorder, turn lifecycle, Overwrite, compact UI
extension/fiber.js            MAIN-world React/Fiber evidence reader (least trusted)
extension/background.js       service worker: token, journal, tab↔conversation registry
extension/popup.*             status/reconnect UI

── other ──────────────────────────────────────────────────────────────────
src/renderer/main.ts          setup/settings/connection/activity UI
src/renderer/chat.ts          session timeline, handoff, swarm UI
src/main/computer/*           screenshots, UI Automation, SendInput/clipboard helper
src/main/tunnel/*             index.ts lifecycle · health.ts metrics · locate.ts binaries
scripts/live-chatgpt-workstream.mjs  real daemon/extension/ChatGPT workstream acceptance
scripts/*                     build-time icon / tunnel-client / ripgrep fetchers
electron-builder.yml          Windows/macOS/Linux package contents and target policy
```

`exec.ts` remains as the shared low-level process/environment primitive used by unified exec,
the Windows desktop helper and tunnels. The retired connector-native managed-process and patch
stacks were removed after production moved to `codex/unified-exec.ts` and `codex/apply-patch/*`;
do not recreate parallel runtimes beside those live owners.

---

## 5. Startup and shutdown — `index.ts`

```text
single-instance lock → userData paths (config/secrets/sessions/state)
  → load validated config + durable state
  → restore request correlations, repair deterministic attribution
  → restore swarm if multi-agent enabled
  → hardened BrowserWindow → register fixed IPC handlers
  → start bridge if recording OR multi-agent → prune old sessions
  → auto-connect MCP/tunnel if configured
```

**Must hold.** The window keeps context isolation on, Node integration off, renderer
sandbox on, navigation and window creation constrained, permission requests denied unless
explicitly supported. Never weaken that to solve a renderer convenience problem. Every new
long-lived process, timer, listener, queue or durable writer names its shutdown owner —
teardown covers tunnels, both listeners, process sessions, then flushes session and durable state.

`will-quit` calls `preventDefault()` and owns the decision to quit from then on, and it
destroys the tray before teardown starts. So teardown is not merely ordered, it is **bounded**:
`shutdown.ts` gives each phase its own budget and always ends the process. A task that never
settles would otherwise strand an invisible main process holding the single-instance lock, and
every later launch of the app would silently do nothing. Per-task bounds are not a substitute
for that — "each piece is bounded" is a different claim from "the sequence ends".

Ending it is `app.exit(0)`, never `app.quit()`, and that is not interchangeable. Electron drops
a quit raised from the promise continuation that finishes teardown: on Windows the call returns
without even emitting `before-quit`, while the same call one macrotask later quits normally.
`shutdown.ts` therefore owns the exit itself rather than trusting its caller to remember.

## 6. MCP surfaces and discovery — `surfaces.ts`, `tools.ts`, `server.ts`

ChatGPT discovers **one server's entire tool list as a unit**: a no-query
`list_resources` returns every schema that server advertises. Splitting into separate
servers is therefore the only mechanism that actually bounds the worst case. Two surfaces
earn it today.

**Core** (`chat-on-steroids-core`, required):

| Tool | Live when | Implementation |
| --- | --- | --- |
| `read` | `read` \| `browse` \| `metadata` | `tools-core.ts` → `codex/read-backend.ts` |
| `view_image` | `read` | `tools-core.ts` → `codex/view-image.ts` |
| `find` | `search` **and not** `command` | `tools-core.ts` → `search.ts` |
| `apply_patch` | any of `create`/`edit`/`move`/`deleteFile` | `codex/apply-patch/*` |
| `exec_command`, `write_stdin` | `command` | `codex/unified-exec.ts` |
| `session` | recording enabled | session subsystem |
| `agents` | multi-agent enabled | `agents.ts` |
| `exec` (code mode) | always; each child call re-admits the workstream claim and re-checks its own permission and gates | `mcp/code-mode-*.ts` (QuickJS worker), children via `kernel.ts::dispatchNested` |

**Desktop** (`chat-on-steroids-desktop`, optional, **Windows-only**): `observe` needs `screen`;
`computer` registers on `control` **or** either clipboard permission, then re-checks each
of its 13 actions at runtime. The surface is offered at all only when one of those four
permissions exists on Windows — an empty or impossible connector is worse than no connector.

**Exposure is monotonic per endpoint lifetime.** ChatGPT caches schemas, and yanking one
from under a cached snapshot surfaces as a transport-level UNKNOWN failure. So
`server.ts` remembers what this endpoint has ever exposed. A permission revoked after
exposure leaves the schema registered and its handler returns `TOOL_DISABLED`. The
`find`-vs-exec choice is frozen the same way, at first discovery.

**Must hold.** Two separate concepts, never collapsed: *exposed* (a schema may exist
because it was visible earlier) and *live* (the operation is allowed now).
Schema visibility is not the security boundary: `config.ts::effectiveCapabilities()`
and the live guards are. A server registers only tools its surface declares and answers
anything else with a protocol-level unknown-tool error; there is no merged list and no
hidden acceptance. A deliberate reconnect is the clean boundary for changing the shape.
2026-09-26: publishing one new Core tool (`reuse_record`) while fleet chats ran was followed
within minutes by every chat reporting that the `workstream` operation was "not available in
the current tool surface", and 35 minutes of no progress until the tool was withdrawn. A new
tool waits for an owner-planned reconnect.

**A schema change is not deployed until the ChatGPT app is refreshed.** ChatGPT holds its own
snapshot of each connector's tool schemas. Any change to what `tools/list` serves (a new
tool, a new or changed argument, even an optional one, or a changed description) reaches chats
only after the custom app is refreshed in ChatGPT (Settings → Apps → the app → Refresh) and a
new chat starts. Until then chats call the old shape. After d002ef1 added the optional
`reuse_search` to `apply_patch`, only 9 of 48 patches carried it, while the reuse gate
demanded it of every minting patch. Committing and restarting the daemon is half the change:
the author of a schema change arranges the refresh in the same step, and checks a new chat's
calls for the new field before any gate relies on it. `connector-schema.ts` enforces this. It
fingerprints the Core `tools/list` the handler serves and records the fingerprint whenever
ChatGPT fetches `tools/list` through the managed connector path. Self-tests and the tunnel
client's marked startup probes are excluded; do not key this proof on a provider-specific
forwarding header. While
the two differ, it holds every new workstream send and logs the refresh it needs. GET
`/workstreams` reports the state as `connectorSchema`. A steward reads it before resuming any
workstream.

**Acceptance.** Connector discovery/schema behavior is accepted only against the live ChatGPT
connector. Typechecking can catch implementation errors but is not protocol proof.

## 7. One MCP call, end to end

Two gates run inside every admitted workstream call, before the handler (`kernel.ts`
registrar):

- **Rules gate** (`rules-gate.ts`): until the `read` tool has returned every line of
  `<workspace>/AGENTS.md` to this conversation, every tool except `read`, `find` and
  `view_image` is refused with `RULES_UNREAD`, naming the unread ranges and the exact next read.
  Coverage is per conversation and durable (`rules-coverage` state), so restarts do not force
  re-reads. The notice is imperative ("your next call, now, in this turn") because a chat that
  was told the rule descriptively ended its turn calling it a blocker.
  It is a gate, not a pointer, because whether a chat reads "read AGENTS.md" is up to the model:
  replacement chats reached for the TODO first and worked for hours against rules they had never
  opened. Coverage is durable because forcing every chat to reread a 200 KB file after each app
  restart was pure load on the account, which ChatGPT flagged as unusual activity. Coverage
  belongs to the conversation, keyed as described in §11, because a chat that re-attaches after
  a restart or recovery has the file in its context already and a replacement chat does not.
  The `orchestrator` workstream (`ORCHESTRATOR_WORKSTREAM_ID`) must also read every line of this
  repository's [`docs/agents/steward.md`](docs/agents/steward.md), whatever its workspace, before
  it may act: that file is its whole job, and a pointer to it was ignored exactly as the
  `AGENTS.md` pointer was. The gate finds the file two directories above the running module, so
  it is present in a source checkout and in `out/` builds; in a packaged build without `docs/`
  the orchestrator's first acting call fails with an assertion that names the missing file. The
  refusal names the file by its native absolute path, which `read` accepts, and the gate resolves
  it through the same `resolvePath()` call as the workspace, so a file outside every approved
  root fails loudly instead of being skipped.
  Calls with no claimed workstream, such as the emergency recovery credential, are exempt; a
  workstream with no workspace or whose workspace has no `AGENTS.md` needs no `AGENTS.md`
  coverage. The workspace is resolved with `resolvePath()` on an app-owned, approved path, so a
  failure there is a broken contract and propagates.
  Run `npx tsx scripts/test-rules-gate-steward.ts` after changing the gate.
- **Reuse gate** (`reuse-gate.ts`): a patch that adds a new code file or a definition name that
  no tracked file already defines must carry `reuse_search`. Per name, it gives the searches
  run, what they found, and why none is reused. Each search must match a `find` call or
  rg/grep/fd/ast-grep/probe command this conversation actually ran, and a search that looks
  only for invented names does not count; one that includes a new name among other terms does
  (2026-10-10: a helper named `cokernel` voided the real search `'cokernel|elementary_divisors'`
  and the bare refusal locked lean-cas-dsl-leaves out for 80 minutes). A refusal says, per
  quoted search, why it failed, and lists the chat's searches that would count. Around every `exec_command`/`write_stdin` the workspace is
  diffed against the pre-command HEAD, so shell-written definitions become pending, and every
  tool except reading ones is refused until an `apply_patch` carries a covering `reuse_search`.
  Names already defined elsewhere (Sage's `one()`, `zero()`, `_repr_`) are overrides, not
  mints; before that rule, a new `one()` locked research out for half an hour.

```text
tunnel request
 → server.ts    loopback Host/Origin, secret tokenized path, bounded body,
                x-request-id read + normalized (split before '/'),
                x-openai-session read as an opaque connector session key
 → tools.ts     build only the requested surface
 → kernel.ts    AsyncLocalStorage call context
                validate required workstream_id before execution
                resolve agent identity from the admitted logical workstream
                enforce the live capability / read-only guard
 → tool handler sandbox any model path, execute, attach structured evidence
                (changes, counts, exit code, session id, assets)
 → recorder.ts  exact args/result/outcome; file under the workstream-owned recorder session
 → kernel       agent inbox offer/ack bookkeeping
 → response
```

`server.ts` manually reads and bounds chunked / no-`Content-Length` POST bodies before
handing parsed JSON to the MCP adapter. **Do not regress that to a `Content-Length`-only
guard.** `inbound.ts` captures the raw header because the MCP library's higher-level
context has not reliably exposed it.

`call-context.ts` keeps **two** in-flight counters: handlers currently executing, and MCP
requests still in dispatch (including the identity wait and the durable recording that
happens after the handler returns). Orphan and stale-agent cleanup depends on the wider
one — a tool can have finished mutating the machine while its request is still being
attributed.

**Every refusal a model receives is an instruction.** The reader is a chat that has never
heard of this app, its leases, slots, barriers or claims. Each `fail(...)` / `AgentError`
text says, in that chat's terms, what is true now, whether anything was done, and the exact
next call — including when to try again and what to check first (e.g. slot refusals report
live slot use and point at `agents action=status` → `freeWorkerSlots`; they never say only
"retry"). A leading code (`NO_FREE_SLOT:`) may stay for matching, but it never stands alone,
and app-internal vocabulary never reaches the model. A state only a bug can reach says so
and says not to retry. When the steward finds itself telling a worker how to react to a
refusal, that text belongs in the refusal (0d1db26).

## 8. Filesystem containment — `sandbox.ts`

The authority for every model-supplied path. Approved folders get virtual roots such as
`/project`; native absolute paths are also accepted when they resolve inside an approved root.

**Must hold.**

- Every model filesystem path converges on `Sandbox.resolve()` or an already-validated
  wrapper. "It is only a read" is not an exemption — reads are confidentiality-sensitive.
- **Virtual and native spellings receive identical authorization.** Test both the virtual
  spelling and the host spelling (`C:\approved\project\src\a.ts` on Windows,
  `/home/me/project/src/a.ts` or `/Users/me/project/src/a.ts` on POSIX). Never "improve" native
  normalization by letting it collapse traversal the virtual spelling rejects.
- Containment covers root selection, host-invalid/path-trick rejection, canonical checks on
  existing targets, deepest-existing-ancestor validation for missing targets, reserved virtual
  root names, and symlink/reparse/junction handling as applicable to that OS.
- Authorization must remain valid at the point of filesystem use; avoid designs that rely
  only on an earlier pathname check when the underlying target can change.
- Native filesystem error text must not leak hidden physical root paths back to the model.

**Not contained: shell commands.** `exec_command` is arbitrary code execution as the
logged-in user. Its *starting cwd* is restricted to an approved folder; the command is not.
That is why `command` is the strongest permission and why read-only mode disables it
outright. Never claim approved roots contain arbitrary commands — they contain the app's
filesystem tools. Read-only derives from the complete write-capability list, so a new write
capability must become read-only-blocked automatically.

**Acceptance.** Exercise real approved/outside paths on the target OS. Security claims are about
what the filesystem actually permits or refuses, not an in-memory path fixture.

## 9. Workspaces — `workspace.ts`

Two ideas that are easy to confuse: **approved roots** are the security boundary the user
configured; a **workspace** is convenience state saying which project *this exact chat or
agent* is working in.

Keyed by exact chat/agent identity, learned from proven absolute paths and project markers,
inherited by spawned workers, moved by Compact & Resume.

**Must hold.** A relative path or omitted `workdir` with no trustworthy workspace **fails**
rather than mutating a guessed project. When caller identity is unresolved during a swarm,
never silently fall back to the first approved root — that turns an attribution failure
into a wrong-target mutation. Moving a workspace is state continuity, never a new
permission; the target still has to be legal.

**Acceptance.** Workspace effects must be observed through real connector file operations;
worker ownership/routing requires live ChatGPT workstreams.

## 10. The Codex-derived tools — `src/main/codex/*`

Selected public Codex behavior ported into TypeScript. **It does not launch a Codex model
or require a Codex installation.**

**`exec_command` / `write_stdin`.** `unified-exec.ts` ports session ids, output draining,
head/tail buffering, yield deadlines, output token policy, interactive stdin, and sessions
that outlive the call that created them. Windows adaptations (quoting, interrupt) live
beside the port and stay explicit and tested against model-facing behavior. There is a
known Ctrl+C vs. natural-exit race worth keeping a regression for. The local MCP adaptation
also accepts `cmds` to run related commands sequentially in one labeled shell session, and an
empty `write_stdin` poll returns on first output instead of holding Codex's full collection
window. Start at `tools-core.ts`
→ `unified-exec.ts` → `shell.ts` → `ownership.ts` → `exec-output.ts`.

**These tools are the product, not a defect surface.** Changes to them are governed by §1,
"Who sets the limits".

**`apply_patch`.** Model syntax is Codex V4A. MCP cannot expose a true freeform tool, so
the raw patch rides inside the `patch` string while the grammar lives in the description.
Engine under `apply-patch/`; the wrapper adds capability checks (per hunk kind — add needs
`create`, delete needs `deleteFile`, content change needs `edit`, rename needs `move`),
sandbox resolution, workspace behavior, recorder evidence. **Shell interception** also
exists so a model emitting `apply_patch` as a shell command still reaches the port — if the
failure involves `cd`, quoting, `&&` or other control flow, the bug is above the parser.

**`read`.** Deliberately four layers: `tools-core.ts` owns the model contract and
multi-path behavior; `read-backend.ts` owns decoding/listing semantics; `filesystem.ts` is
primitives only; `sandbox.ts` is policy. **Do not push authorization down into
`filesystem.ts` and assume the public tool became safe.**

**`view_image`.** 8 MiB transport ceiling. PNG gets a real decode check; JPEG/GIF/WebP
validation has documented limits and does not yet match upstream's full-decoder guarantee.
Synchronous validation of an adversarial compressed payload is a main-process resource
risk. An invalid `image` content block can break an entire model turn — **prefer rejection
over optimistic decoding.**

**Local checks.** Real process/filesystem/image behavior lives in `exec.test.ts`,
`exec-reaper.test.ts`, `fsops.test.ts`, `read-backend.test.ts`, and `image-decoding.test.ts`.

## 11. Identity — the spine of the whole project

Every ordinary Core/Desktop tool requires a `workstream_id`. The unscoped `workstream`
setup tool is the chat's identity-registration step: `action=start` with a new logical
workstream name registers and claims that repository/task identity, while `action=continue`
with an already-registered name claims it. Either action issues the `workstream_id`; `kernel.ts` validates it against
`workstreams.ts` before execution, and the model retains one id per attached workstream and
supplies it on every ordinary call. Unknown or superseded ids refuse execution with
`WORKSTREAM_SETUP_REQUIRED`. The setup tool itself is completely unscoped: it needs no
conversation key, lock, browser identity or prior claim, and never returns
`BROWSER_IDENTITY_REQUIRED`. The opaque id is the only model-carried identity for
steady-state calls; it is stripped from recorded tool arguments.

Setup has no browser-provenance dependency. `continue` rotates the opaque claim token for the
logical workstream directly. The previous token becomes retired ownership; already-admitted
calls/processes under that token must settle or be terminated before the successor executes.
The workstream's stored browser conversation is not part of that authority calculation. It is
only the current route the controller may later use for continuation/archive/replacement.
`WORKSTREAM_BUSY` therefore means an already-admitted call from a retired opaque claim is still
settling; retry the same ordinary call with the same current token rather than calling setup again.

Browser commands reserve a logical workstream in `opening` and send bootstrap prose that
directs the model to call `workstream action=continue` first; the model's own continue is
what activates the row and issues the fresh id. The browser ACK records which concrete
ChatGPT conversation the controller opened — observation/orchestration state for later
continuation/archive, never a prerequisite for admission and never a model attachment. A
superseded id cannot execute tools; already admitted calls must settle and retained
terminal processes are stopped before the successor executes.

The admitted logical workstream determines recording, workspace grouping, terminal ownership
and ordinary-tool provenance. Its opaque claim token fences superseded owners. Headers,
request-id correlation, extension observations, browser timing and ChatGPT conversation ids
cannot override that ownership. The recorder session is owned by the logical workstream; the
controller may separately retain a current conversation id solely so page observations and
continuation/recovery sends can be routed to the present frontend. Recordings label this
method `workstream` and persist the logical workstream id explicitly.
For a current identity failure, inspect id issuance, durable restoration, browser-command
reservation, and then kernel dispatch. A stale connector schema must be refreshed.

### Workstream leases and recovery

**Ownership is not execution quality.** An in-flight MCP call, live PID, renewed lease, busy
browser turn or active CPU is evidence that something holds execution resources, *not* evidence
that it is doing appropriate work. The object of stewardship is the worker's decision relative
to the repository's actual task: was this operation worth launching, and should it be blocking
the agent at all? Small targeted tests/probes answer the question raised by the current edit.
Large builds, full suites and acceptance families run asynchronously on CI; the worker keeps
implementing rather than synchronously waiting, polling or repeatedly relaunching them.
For `research`, a worker-run job exceeding five minutes is a serious workflow failure,
not an ordinary thirty-minute computation to leave alone. An agent can be fully alive while
drifting into unnecessary validation, GitHub-run waiting, a forbidden PR workflow, or
repeated tool calls that cannot advance its objective. Diagnose and correct that *upstream
decision*, not its latest timeout symptom. The short execution bounds protect useful work
from serial blockage; they do not imply that a call occupying the lease is productive, nor
that a long-running job should be polled to completion. See the October 21 owner ruling under
[`docs/agents/steward.md`, "The managed workstreams"](docs/agents/steward.md#the-managed-workstreams) and
"A computational wait in place of work" in
[`docs/agents/steward.md`](docs/agents/steward.md#an-intervention-is-a-change-in-the-workers-next-decision). Preserve ownership fencing and avoid
duplicating side effects when recovering; those are safety properties, not excuses for delay.

`workstreams.ts` owns durable exclusive claims for every logical workstream. Admitted tool
calls renew the five-minute lease; running calls hold it open. Lease expiry alone never
starts revival or replacement. The steward diagnoses stalled work from the actual task,
tool results and browser state. An intentional pause resumes the same holder without
inventing activity or treating the wait as a failed conversation. A new claim
invalidates the old opaque token and cancels pending recovery. Already-admitted old calls must
settle before successor execution, and the old claim's retained terminal sessions pass to the
new claim (`transferExecOwnership`). Archive and recovery stop the turn, never the running
work. Fencing is the lock rotation plus `execOwnershipDenied`; killing the work was never
needed for it. Browser polls and replayed observations are not activity. The app's own
continuation prompts cannot renew their own lease.

For the scheduled `orchestrator`, a fresh observed terminal turn releases its claim
immediately so the next tick can attach. A running tool call still holds the claim;
observer loss and uncertain turn outcomes do not release it. The ordinary five-minute
lease remains the fallback when no terminal turn was observed.

After an explicit recovery decision or a failed delivery, the bridge maintenance sweep owns
bounded recovery. It tracks the same-chat command's delivery and response. Renewed activity
ends the episode; when that recovery is exhausted, the old lock is
fenced, the extension stops and archives the actual ChatGPT thread and verifies the stored
successful archive mutation response, and the bridge opens a replacement frontend with the saved project
context and generic steward instructions. Action identities and attempt counts survive restart. A takeover
cancels the old action; stale acknowledgements cannot install a replacement owner.

An unbound claimant's **archive flag is not terminality**. The paired extension
checks the last exact claimant against ChatGPT's authenticated conversation API.
When it exists but is archived, the bridge first reserves restoration against
the unchanged workstream claim/last-activity generation; the extension unarchives
that exact conversation, verifies the new backend archive state with a second
GET, and only then returns it to same-chat recovery. If the backend instead
returns HTTP 413 with the typed code `conversation_length_exceeds_limit`, the
claimant is terminal: the controller opens the retained workstream's successor
(or releases the scheduled orchestrator claim) without waiting for its lease.
The live conversation POST's SSE `error_code: conversation_too_large` is the
other terminal signal. English error prose, a bare 404, missing browser
bindings, an archive flag, and elapsed time alone never prove terminality.
Every browser recovery receipt is compared against the current row's
`lastActivity`; a newer claim invalidates it.
The controller additionally records which conversation displayed the CURRENT
opaque claim token. Historical `claimedBy` membership alone cannot authorize
a pre-lease terminal takeover: a newly rotated claim may not yet have published
its claim line, and an old chat's late HTTP 413 must not fence the successor.
Browser terminality probes may precede lease expiry only for the independently
proven current claimant; nonterminal recovery still observes the lease and
turn-liveness gates.
Authenticated recovery probes have bounded page-script waits and fall back to
a disposable ChatGPT home tab if the currently open conversation renderer is
hung or no conversation tab exists. A frozen unrelated tab cannot stall every
workstream's recovery, and the temporary host is closed after use.
The extension service worker first attempts the metadata-only conversation
probe directly with its authenticated ChatGPT session, without depending on
any page renderer. It does not expose tokens or conversation bodies. If that
worker context lacks the correct session, the existing bounded page-context
lookup remains the fallback; all-404 ambiguity never retires workstreams.
Extension startup/injection operations are likewise bounded against frozen
renderers, and the headless CDP opener propagates failed HTTP/timeout/no-target
results to command delivery. An opener failure cannot become a phantom
successful bootstrap waiting indefinitely for a nonexistent page ACK.
One browser delivery failure is not evidence that the original chat is dead.
Two separately *page-redeemed and acknowledged* same-chat delivery failures
can trigger the bounded archive/replacement fallback. An unredeemed send
that simply expires proves only a browser transport outage, not conversation
terminality. Lost receipts, account-wide usage holds, and other unverified
transport failures never count as proof of a dead page.

**A replacement inherits its predecessors' execution, not just the brief.** A workstream keeps
one recorder session across every chat that holds it, so the opening message of any replacement
carries the inherited execution record (`workstream-inheritance.ts`):
- the newest tool calls in order, with arguments and metrics;
- result tails for failures and for calls that changed files, processes or agents;
- the files those calls changed;
- the last instruction the stream was given and the predecessor's last real prose;
- any terminal sessions it left running.

The record is a projection of recorded facts and makes no judgment. Without it, every
replacement was a fresh start that repeated setup, orientation, source reading and runs
(2026-10-19/20). Bound chats do not get it, because their own conversation already holds it.
On the current ChatGPT frontend a final answer can be a generative-UI block whose `content` is only
`::chatgpt-content-reference{index=…}` directives. `fiber.js` resolves each one to its
`model_dil_v2.fallbackMarkdown`, so the recorder and the inherited record carry the prose.

The rules gate counts coverage per conversation: the bound conversation, else exact
conversation evidence, else the connector session key, and only then the claim. Keying an
unbound row by its rotating claim made the scheduled orchestrator reread this whole file on
every tick, 432 times by 2026-10-21.

Controller-started managed workstreams are **turn-driven**.
Their fresh observed `turn_end(completed)` schedules the next workstream prompt immediately;
fresh failed/stopped/interrupted endings enter bounded recovery immediately.
Model-created workstream identities are non-driving unless a local
controller explicitly enables auto-advance. Auto-advancing managed conversations stay
page-mounted instead of entering tabless sleep: the observed turn boundary is their scheduler
signal, so hiding it behind quiescence/fallback wake would defeat immediate advancement.

Local scripts use `/workstreams/start`, `/workstreams`, `/workstreams/pause`,
`/workstreams/resume` and `/workstreams/replace` with the local sender credential. The paired extension alone services
`/workstreams/archive`. Failed browser delivery or archival is visible as blocked work;
do not claim a replacement was made from a queue receipt alone. See README for bodies.

This explicitly authorized lease-recovery mechanism is the exception to the historical
timer-driven continuation prohibitions in §19 and in
[`docs/agents/steward.md`](docs/agents/steward.md#the-stewards-job). Those prohibitions still govern independent
shell drivers and unbounded pushes outside the app's lease state machine.

**2026-10-25 owner authorization: an external, 30-minute workstream watchdog.**
`scripts/workstream_watchdog.py` is a further, narrowly authorized exception. Its cron
tick inspects the controller's live state and durable recorder evidence, treats prolonged
in-flight tools as an execution defect rather than healthy work, and can request native
same-chat recovery or fenced replacement for demonstrated stalls. It reports an over-budget
call for the model steward to diagnose; elapsed time alone never authorizes it to kill the
call. It restarts the headless daemon only when the daemon is stopped or an opening or
archiving transition is wedged. A
restart is a last-resort loss of the daemon's in-memory calls, not a routine response to a
normal terminal process running in the background. It never claims a
worker's workstream, unpauses one, directly edits a managed repository or bypasses the
bridge's ownership and delivery machinery. An accepted replacement request is not proof
that a new worker executed; failed recovery must be retried on the next watchdog tick,
not treated as completed just because a message was logged.

The watchdog's decision rules (`action_allowed`, then `run_watchdog`):

- It is not a workstream participant: it never calls `workstream` start or continue and never
  invents a replacement chat. Every intervention goes through the controller's fenced
  recover/replace routes, on recorded evidence, never on lease expiry or a browser heartbeat.
  Cron supplies the cadence; one run is one finite pass.
- The idle horizon is five minutes (`DEFAULT_IDLE_MINUTES`): the owner's failure horizon of
  five minutes with no workstream activity and no call in flight, in
  [`docs/agents/steward.md`](docs/agents/steward.md#the-managed-workstreams) (2026-10-21) and the
  Wedged state in [its state definitions](docs/agents/steward.md#state-definitions-and-the-action-for-each).
  The thirty-minute cron cadence must not add another half-hour before native recovery is
  eligible.
- Activity is the recorder's latest non-polling tool call. Polling an unfinished process is not
  activity; reading a completed process result is. A recorder tail of only polling calls is never
  forward motion, even though those calls renew the lease. The lease's admitted-call time counts
  only when the recorder has no evidence at all. A non-polling call is evidence of an action, not
  of progress; the orchestrator judges whether the action was worth taking.
- The in-flight check runs before the phase, lease and cooldown rules. An overlong tool is an
  execution defect, not proof of progress, and no elapsed time lets the watchdog evict a call
  still in flight. The census is refused when it holds 50 calls, the
  bridge's cap, because a truncated census cannot prove a workstream has no call running.
- A row whose error is `auto_continue_without_successful_tool:` is left for the steward. The
  controller withheld that send on purpose; reviving it would revive and replace the same chat
  forever. A later real tool call clears that error in the controller, and ordinary inactivity
  recovery is then eligible again.
- After an intervention, only a new substantive tool call proves it worked. A new browser turn,
  a renewed lease or a poll does not. The watchdog records only that the bridge accepted a
  request, not that ChatGPT received it, so an earlier unproven intervention needs diagnosis,
  not escalation.
- A `blocked` row, a refused same-chat recovery (409), a lost binding and a stale retired flag
  are not proof that the chat is dead: a failed browser binding can leave a usable chat unbound
  with its claimant marked retired. Each needs exact-chat recovery diagnosis before any
  replacement. On 2026-11-19 a Sage replacement was requested without one delivery attempt to the
  still-live chat. These outcomes are logged as errors, not as an idle tick.
- In `recovering` the controller owns delivery, the response window and exhaustion; an accepted
  `/recover` POST alone never justifies a replacement.
- The daemon exposes the bridge only after it restores durable sessions, which can take much
  longer than the systemd start acknowledgement. The watchdog does not restart a daemon in that
  state, since that discards the restoration; only a stopped daemon gets native service recovery.
  After a restart it waits up to 45 seconds for the bridge listener (the real service needed
  about 17 seconds on 2026-10-25, and a 15-second probe misreported that success as a failure).
  Cron has no `XDG_RUNTIME_DIR`, so the watchdog sets it before `systemctl --user`.
- During a repair, a successor conversation bound by another recovery is never interrupted on
  the old observation, and an owner pause that arrives mid-repair wins. After a refused
  recovery, a row whose conversation, activity or phase moved, or a worker that began a call
  while the request was refused, gets no retry and no replacement. A wedged opening or
  archiving transition that survives a daemon restart gets a fresh controller bootstrap with the
  existing durable brief, rather than another half-hour on a dead transition.
- `scripts/test_workstream_watchdog.py` covers these rules.

### Historical header correlation and browser evidence

The following describes the former transport join and the browser evidence still used for
historical recording repair. It is not a fallback for a current tool call without a key.
An MCP payload supplies no independently authenticated ChatGPT conversation id. The former
proof chain was:

```text
HTTP x-request-id                       (inbound.ts, normalized before '/')
  ≡ page message.metadata.request_id
  → fiber.js      emits allowlisted request evidence from the MAIN world
  → content.js    reports requestId + conversationId
  → background.js journals it durably
  → bridge.ts     accepts it for that conversation
  → correlation.ts  proves requestId → conversationId
  → consumed only by browser/session diagnostics and historical recording repair
```

This chain is no longer an authority path for current ordinary tool calls. Current ownership
is already known from the required claimed workstream: logical workstream owns provenance,
workspace and recording; the current opaque claim fences execution/terminal control. Browser
and request evidence may explain which frontend displayed a call, repair historical records,
or support page diagnostics, but it cannot grant or override tool/agent/workspace/terminal
authority.

**The 2026-09 connector platform broke the exact chain at its first link.** Measured live
on 2026-09-09 (loopback capture of real traffic): tools/call arrives with **no
`x-request-id` anywhere** — headers or body — and the page's `metadata.request_id` UUIDs
appear nowhere in the request. The one per-conversation identity on the wire is the opaque
`x-openai-session` header (mirrored in `params._meta["openai/session"]`), distinct across
concurrently generating workers and stable across a worker's own calls, but never visible
to page evidence — so no exact join exists. Two **degraded attribution tiers** adapt to
this (`recorder.ts::inferDegradedCaller`, `connector-session.ts`), and they are recording
and charge-scoping evidence only:

- `temporal_unique`: exactly one managed conversation was generating when the call
  arrived; zero or several attribute nothing.
- `connector_session`: the call's session key was bound to a conversation at an earlier
  temporally unique moment; contradictory temporal evidence permanently kills a key.

Both are honestly labeled in `attribution`/`attributionMethod` and never masquerade as
`request_id`. They never grant agent identity, inbox delivery, workspace authority or
terminal ownership — current tool calls already carry the admitted logical workstream.
Historical ambiguous calls stay Unattributed and are charged against every conversation
the app cannot *observe* to have been quiescent when the call arrived
(`recorder.ts::mayOwnUnattributedCall`). ChatGPT issues connector calls only from inside a
turn, so a chat whose turn was watched to end before the call arrived cannot be its origin;
everything else — an open turn, a turn open at any point since the call arrived, an
unobserved closure inside its uncertainty ceiling, a chat with no recorded lifecycle at all —
is still charged. Charging the whole fleet unconditionally is what deadlocked the control
path at fleet width; see §18 for the symptom and what to read off a refusal.

Both tiers are only as strong as the turn-lifecycle evidence beneath them, so that
lifecycle carries a **staleness invariant**: an open turn is evidence only while its page
observer actually reports. A mid-turn conversation with no page contact (observations or
`/activity` polls) for five minutes has *lost* its observer — discarded/frozen tab,
orphaned isolated world, dead browser — and the app closes the turn with the honest
`observer_lost` outcome (`recorder.ts::closeStaleObserverTurns`, run from the bridge's
maintenance sweep). An **unobserved closure is not a "stopped generating" boundary**: while
any conversation is inside its observer-lost/detached-mid-turn uncertainty window,
`soleGeneratingConversation()` certifies no moment as temporally unique, because the
unwatched server turn may still be running and a false unique moment poisons a key binding
permanently. Only the app may append `observer_lost` (the bridge refuses it from `/events`
— an observer cannot report its own absence), and a page-observed boundary that arrives
later supersedes the staleness closure and ends the uncertainty.

This chain now explains recording/browser-attribution symptoms only — calls piling into
Unattributed, wrong page tool placement, missing visible activity, or failed historical repair.
It must not be used to diagnose current tool ownership, worker identity, project cwd or
terminal authority; those start at workstream admission/claim state.

```text
server.ts/inbound.ts  did x-request-id arrive and normalize?
fiber.js              did the page model expose a matching metadata.request_id?
content.js            did refreshFiber receive it and emit tool_evidence?
background.js         was it journalled and delivered?
bridge.ts             was it accepted for the intended conversation?
correlation.ts        was requestId→conversationId stored, and restored after restart?
recorder.ts            did the historical/page record use the available evidence honestly?
```

ChatGPT can place `metadata.request_id` on the user-message branch that opened the active
generation. That Fiber descriptor can have `conversationId: null`, even while the browser route
has the concrete conversation id. Preserve the triggering user section when the local generation
opens. Join its scan-qualified `data-clf-fiber-turn` stamp to the descriptor, then submit the exact
request id through the app's correlation handshake. This path is page/recording evidence only.
It does not grant workstream ownership, agent identity, workspace, terminal authority or a
recorder thread.

**Acceptance.** Correlation and browser identity are live-only claims. Use the installed extension,
the real ChatGPT page and connector observations; never accept a synthetic Fiber/DOM transcript.

## 12. Session recording — `recorder.ts`, `store.ts`

Two independent producers, one durable timeline, neither replaceable by the other:

1. **MCP/app truth** — exact tool, arguments, result, outcome, file changes, duration, assets.
2. **Browser observation** — authored messages, turn lifecycle, native progress, visible
   errors, conversation identity, page request evidence.

The app knows *what the tool did*. The browser knows *which conversation and turn showed it*.

```text
userData/sessions/<id>/
  events.jsonl        append-oriented tool/turn/error/activity events
  messages/*.json     canonical user/assistant messages, one shard per logical id
  messages.json       legacy canonical map, read during lazy migration
  meta.json           atomically rewritten projection
  assets/<id>         screenshots and large/binary material
  handoffs/<id>.json  saved compaction briefs
```

**Must hold.** Streaming website messages are mutable snapshots of one logical message, so
Canonical message shards **replace by stable identity** — never turn that back into blind appends.
Structured activity stays append-oriented. Large values bound inline and spill to assets;
never fix a display-size problem by discarding the durable source. Durable state is the
authority across restart, and `meta.json` must never claim events that `events.jsonl` does
not contain. Unattributed is a **first-class state**, not a bug to paper over.

Distinct from `logger.ts`, which is small, redacted, RAM-only and operational.

**Acceptance.** Session chronology and conversation replacement are checked on real recorded
ChatGPT conversations, not by replaying a repository-authored event trace.

## 13. The Chrome extension — `extension/*`

Three execution contexts with **three different lifetimes**:

| File | World / lifetime | Owns |
| --- | --- | --- |
| `chatgpt-dom.js` | isolated, document | every selector and DOM-shape assumption |
| `content.js` | isolated, document | observation, turn lifecycle, Overwrite, compact UI |
| `fiber.js` | **MAIN**, document | React/Fiber evidence the DOM does not reveal |
| `background.js` | MV3 worker, **suspends freely** | bridge token, journal, tab↔conversation registry |

Plus `chrome.storage.session` — survives worker sleep, dies with the browser session — and
tab↔conversation binding, which follows tab lifetime and explicit navigation.

**`chatgpt-dom.js`** groups logical turns, extracts authored text, finds buttons/errors/tool
rows, and strips CLF-owned surfaces before reading so rendered replacements do not feed back
into recording. When ChatGPT changes markup, fix it here. **Never scatter emergency
selectors into `content.js`.**

**`content.js`** owns per-document memory: conversation epoch, seen-message identities, live
turn state, Fiber cache, rendered replacement state, pre-service-worker queue.

**`sidebar-chats.html/js/css`** is an on-demand, read-only extension page opened from the
popup. It takes the first ten unarchived entries in ChatGPT sidebar order and fetches
per-conversation batch/stream metadata from a signed-in ChatGPT tab. It never fetches
full ChatGPT history: the read-only bridge `POST /sidebar/metrics` supplies bounded
local recorder context-size estimates, message counts and progress facts when available.
Missing recordings are not zeros, and any failed request is an explicit error to the
consumer rather than an invisible fallback. A same-conversation live tab may already
have the correct `document.title` while both list and batch still say `New chat`;
associate it by verified page route and surface the differing source titles. Reconcile
one status: a page `in_progress` marker or an unclosed recorder turn never overrides
backend `COMPLETE`, and an old `IS_STREAMING` flag alone never proves work. The
overview must never use
`/activity` as a status probe: that feed asserts live page contact, which viewing another
chat from the overview cannot prove.

**`fiber.js` is intentionally least trusted.** It emits a strict **allowlist** (not copied
props minus a denylist), never tool argument values, validates the exact CLF connector
names, and fails closed on unfamiliar React shapes. Its `postMessage` output is
page-controlled evidence useful for joining page to local truth — not a credential.
Its protocol version and the content-side expectations move together.

**Must hold.** ChatGPT is an SPA: every async result proves it still belongs to its
navigation epoch before mutating state. Turn boundaries must stay **event-driven**: Chrome's
intensive throttling slows a hidden tab's timers to one tick a minute, so the periodic
`observe()` loop may never be the only path to a `turn_start`/`turn_end` — the Stop
control mounting/unmounting is itself a body mutation, and `watchTranscript()`'s
lifecycle-edge check wakes the recorder from a MutationObserver microtask (unthrottled)
in both directions, with a fresh one-shot settle re-check timer (nesting 0, so also
unthrottled) booked whenever a closeable quiet window would otherwise wait on a throttled
tick. `unknown` outcomes book nothing: elapsed time is not evidence and never closes a
turn. `pagehide` is **not** proof a conversation ended —
reload and bfcache fire it too; real closure is decided at the service-worker layer from tab
removal and navigation away. **Reload is not conversation close.** Content-script acceptance
means *handed to the journal*, not *stored by the app*, and the journal must never silently
lose something it already acknowledged as durable. Recovery must validate **every** context
whose health it needs — proving the isolated recorder is alive says nothing about a dead
MAIN-world Fiber helper. Recorder takeover is total ownership transfer: the predecessor must
disconnect MutationObservers and DOM/window handlers **and** unregister extension-level
`chrome.runtime.onMessage` / `chrome.storage.onChanged` listeners. An `alive=false` predecessor
must never answer a health check, compete for a worker-revival command, or repaint Overwrite
after the successor owns the document.

**Acceptance.** Extension/DOM behavior must be exercised in the installed Chrome extension against
the current ChatGPT page. jsdom, VM pages and fake service workers are not acceptance evidence.

## 14. The browser bridge — `bridge.ts`

A second loopback HTTP service on the first free port of **8765–8769**. The extension finds
it with `/hello`, silently provisions a bearer token with `/pair`, then uses authenticated
routes: `/status`, `/events`, `/closed`, `/activity`, `/compact/claim-auto`, `/compact`,
`/goal/draft`, `/goal/ack`, `/goal/objective`, `/goal/open`, `/settings` (GET and POST),
`/commands/redeem`, `/commands/ack`, `/sidebar/metrics` (read-only, bounded POST).
`/settings` is the only pair the page may write, and
its GET exists for the one composer with no conversation to read `/activity` for: a New Chat.

`/send`, `GET /send/outcome`, `GET /conversation/status` and `GET /sleep/status` are the
four routes that do not
belong to the extension. A
local program — the justfile recipes, a script, an agent on this computer — posts
`{conversationId?, text, verifyHorizonMs?, ifGenerating?, reloadFirst?}` and the app types
that text into that chat, or
into a fresh one when no conversation is named. Queueing is not delivery and even the
page's ACK is only a click receipt: `/send/outcome?id=` reports the typed state machine
(`queued → delivering → typed → sent_verified`, or a terminal
`typed_unverified`/`refused`/`draft_left_in_composer`/`no_live_composer_tab`/`expired`/
`failed` with the concrete next action), where the sole success is a fresh `turn_start`
observed in the recording within the horizon. `/conversation/status?conversationId=` is one
chat's turn state (below) and `/sleep/status` is the read-only sleep/wake
fleet projection (below). All four routes present the separate credential
in `<userData>/state/local-token` (mode `0600`, minted once at bridge startup), never the
extension's bearer token, because `/pair` reissues that one whenever the browser
reconnects.

### What a send may do to a turn already running — `ifGenerating`, `reloadFirst`

The composer refuses a new message while a turn is in flight. That is the whole shape of the
problem: a chat generating and a chat wedged look identical from outside, and the one state a
caller most wants to recover is the one state nothing outside the page can reach. So the send
path carries two page actions, and neither is ever a default.

- **`ifGenerating: 'refuse'`** — the default, and exactly what this route has always done. It
  never interrupts. The message waits for the composer and ends as `expired` if the turn never
  finishes. `just say` and `just new` use it. Use it for everything: a stream mid-turn is
  producing work, and a push that arrives while it is thinking is meant to land afterwards.
- **`ifGenerating: 'stop_first'`** — press ChatGPT's Stop control in that chat, then type.
  `just interrupt <chat> "..."`. This destroys whatever the turn was producing, so it exists
  only where somebody typed it. The app does not second-guess it: whether a turn deserves to
  be interrupted needs the task and the history, which the agent driving the fleet has and the
  app does not. What the app owes that decision is the state, below. It presses again every
  ten seconds while the send waits, because ChatGPT ignores the first press often enough that
  one attempt is not a stop, and it stops asking the moment a page redeems the send. The press
  is recorded: a `chat_error` row in the chat's own recording, and a warning line naming the
  turn id, how long it had been open, and how long since the recording last changed.
- **`reloadFirst: true`** — reload the page holding the chat once, before the message is typed.
  `just revive <chat> "..."`. For a document alive enough to poll but stuck behind a turn its
  renderer will never resolve. Offered exactly once per command and only before any document
  has redeemed it, so it can never cost a lease or loop; the app holds that latch, because a
  page that reloads forgets everything it knew. A renderer frozen hard enough not to poll is
  not reachable this way at all — the service worker's frozen-duplicate recycle owns those.

Both extras need a named conversation: a fresh chat has no turn to stop and no page to reload,
and asking for either there is `400 needs_conversation`. An `ifGenerating` value this app does
not implement is `400 bad_if_generating` rather than a quiet fall back to the safe one.

### What one chat is actually doing — `GET /conversation/status`

`just state <chat>`. Facts from the live recorder, and no verdict.

`just chats` answers a similar question from the recording on disk and gets one thing wrong
that matters: a canonical message keeps the time it was **first seen**, so a chat spending four
minutes writing a long final answer looks exactly like a chat that stopped. This route reads
the recorder instead, where every streaming revision is a durable write, so `lastStoredAt`
moves as the prose grows.

`{known, sessionId, generating, activeTurnId, turnStartedAt, generatingForMs, lastStoredAt,
lastStoredKind, noProgressForMs, lastPageToolAt, lastContactAt, observerLostAt, pendingTools,
inFlightCalls, sleeping}`. `lastContactAt` is a heartbeat and never progress — a wedged page
still polls. A conversation this app has never recorded answers `known: false` rather than a
manufactured idle state, and unknown numbers are `null` rather than zero. The same block rides
on the `POST /send` answer and on a still-queued `/send/outcome`, so a caller deciding whether
to push does not have to queue a message to find out what is in the way.

There is deliberately no `stalled` field. Whether a turn open for eleven minutes with no stored
observation for four of them is a wedge or an agent thinking is a judgment that needs the task,
and the agent driving the fleet is the one holding it.

**Must hold.** The extension token never enters the ChatGPT page — the service worker holds
it in extension-owned state and the app keeps its counterpart out of config and log surfaces.
The two credentials stay separate. The bridge exposes **no** filesystem, command, or
config-mutation route. Protocol mismatch against `BRIDGE_PROTOCOL` warns once rather than
spamming. Concurrent startup must not race on listener ownership.

Because this is where browser-observed lifecycle meets recorder, agents, continuation and
workspace state, a `bridge.ts` bug presents as a session, extension, or agent bug depending
on which end you inspect.

### Sleep/wake tabless generation — `session/sleep-wake.ts` (config-gated, default off)

Evidence base: `docs/tabless-generation-experiment-2026-09-09.md`. A ChatGPT MCP
tool-looping turn runs entirely at OpenAI — a turn kept calling for eleven minutes after
its tab was destroyed, *faster* than with the tab attached — so the tab is needed only at
turn boundaries. With `sleepWake.enabled` in `config.json` (default **off**; when off every
hook is inert and behavior is identical to a build without the feature), the push path
becomes a per-conversation cycle: **push → verify → sleep → quiet → wake → record →
ready for the next push**.

- **Sleep.** When a `/send` reaches `sent_verified` (the recorder observed the fresh
  `turn_start`), the conversation's tab is discarded after `sleepWake.graceMs` via the
  injected tab driver (`headless.ts` wires it over CDP `/json/close`, the HTTP form of
  `Target.closeTarget`; the desktop entrypoint wires none, so sleeping there fails loudly).
- **Push-correlated attribution.** The verification also opens a bounded window
  (`correlationWindowMs`): the first unbound `x-openai-session` key whose calls begin
  inside it binds to the pushed conversation as `push_correlated` — the strongest degraded
  tier (`exact > push_correlated > temporal_unique > connector_session`, see
  `connector-session.ts`), resting on what the app *did* rather than on fleet appearance,
  and needing zero page evidence. Same sticky contradiction handling as every other
  binding: disagreeing evidence kills the key for good.
- **Wake.** A slept conversation with a bound key wakes when its call stream is quiet
  past `quietMs` (mid-turn gaps measured up to ~80s; the final text phase is call-silent,
  so quiescence is the trigger, never proof of completion). The tab is remounted, the
  recorder captures the finished turn cold through the reload-recovery path (an
  `observer_lost` end deliberately keeps the turn recoverable, in the durable rebuild as
  well as live), and a `woke_ready` event says the worker can take its next push. A
  remount that shows the turn still generating re-sleeps and keeps monitoring. Slept with
  **no** bound key, quiescence is unobservable: the wake runs on `fallbackWakeMs` instead
  and the events say so. Restored-after-restart conversations are always keyless
  (bindings are in-memory by design) and ride the fallback timer.
- **Single-driver invariant.** While slept or waking, POST `/send` answers `409
  {state:'refused', reason:'sleeping'|'waking', nextCheckHintMs}` — wake→record→push-next
  is one serialized sequence per conversation.
- **Honest page evidence.** A slept conversation with a bound key is excluded from
  temporal-uniqueness computations from its *sleep state*, never by inference — a closed
  generating tab must not poison "exactly one generating" for the fleet. Slept without a
  key stays fail-closed.

The steward polls `GET /sleep/status` (local token): `{enabled, conversations:
[{conversationId, state, sleptAt, sessionKeyBound, lastCallAt, nextCheckAt, wakeCause}],
events}` with typed events `slept`, `sleep_cancelled`, `sleep_failed`, `wake_started`,
`wake_failed`, `resleep_still_generating`, `woke_ready`, `woke_unconfirmed`, `restored`.
`woke_ready` is the "push the next task" signal. Config knobs: `sleepWake.{enabled,
graceMs, quietMs, fallbackWakeMs, correlationWindowMs}`; changes take effect at the next
daemon restart, like every other config edit the daemon reads at startup.

**Send origin — `session/send-origin.ts`.** Every observed
`turn_start` is stored with an honest `sendOrigin`: `app` when a registered app send (POST
`/send`, a worker bootstrap, a revival offer, a resume handoff, a goal draft) explains it,
`out_of_band` when nothing does — something other than the app typed into that composer —
and `unknown` for real evidence gaps (the three-minute startup window, an `observer_lost`
or detached-mid-turn remount, a `waking` remount, a command still in flight whose page
typed before it ACKed). It never guesses `app`, and the page never supplies the field. The
field is an observation, not an accusation: the app keeps no record against whoever drove
the composer. What it does keep is its own state consistent. A turn the app did not send is
a log line saying so and a typed `out_of_band_send` event describing what the app corrected;
landing in a *slept* conversation it is an error line plus
`sleep_cancelled(out_of_band_send)`, because the app cannot know what was sent and its state
machine no longer describes that chat. It also closes any open correlation window: the app
sent nothing, so nothing may bind `push_correlated` off it. `GET /sleep/status` carries
`sendOrigin: {events}` — a bounded in-memory ring of the recent ones, reporting current app
state rather than a running total. Break-glass direct-CDP tooling still works.

**Acceptance.** Run the real bridge and installed extension. `npm run verify:live` exercises a
disposable real ChatGPT workstream through connector activity, archive and replacement. Other
bridge/sleep-wake changes require an equivalent live repro against the external behavior changed.

## 15. Compact & Resume — `session/continuation.ts`

**The local session id is the durable identity.** ChatGPT conversations A and B are
frontends attached to that one session in sequence.

```text
chat A owns session S
  → A writes its own final handoff brief   → captured and stored verbatim
  → open continuation token for S
  → open one marked fresh chat; exactly one claimant B redeems it
  → preflight   freeze prime/swarm transfers that must move atomically
  → DURABLE COMMIT   rebind S from A to B on disk        ← the one fallible phase
  → publish     recorder mapping, workspace binding, swarm prime binding
  → B continues session S
```

**B receives the record as well as the brief.** When the brief is stored, the handoff also captures the
session's recorded execution (`Handoff.record`, `workstream-inheritance.ts`), and B is typed
`handoffBody()`: A's brief verbatim, then that record. A compacted chat's successor therefore
starts from what was actually run, not only from what A said about it. Every consumer that types
or matches the bootstrap (the bridge, Goal, the provenance checks) uses the same body.

**Must hold.** If preflight or the durable write fails, **A keeps the session**. Once the
durable write succeeds, publication is total in-memory map movement. Never implement
compaction by creating a second session or copying history — the whole feature is continuity
of one durable id. Automatic compaction is **edge-triggered and durable**: reopening an
already-large old chat must not re-fire merely because its level sits above the threshold.

**Acceptance.** Compact/resume is accepted only when a real ChatGPT A→B replacement preserves the
intended session/goal behavior in the running app.

## 16. Multi-agent — `agents.ts`

Experimental, enabled on fresh installs while existing configs preserve their stored choice,
**one active execution run per prime workstream, concurrently across primes**, star topology
within each run: `worker ← prime → worker`. Workers never message each other or another
prime. `multiAgent.maxWorkers` is **app-wide**: slot-holding (invited/active/detached/waking)
workers of every run share it, first-come, because it bounds the load on ChatGPT. A spawn or
wake that finds no free slot is refused with `NO_FREE_SLOT`; no caller is ever refused because
another prime has a run, and none is shown another prime's run.

**Identity.** The prime is the logical workstream that successfully called
`agents action=spawn`. Every worker receives its own preallocated logical workstream
(`swarm-<run>-worker-N`); its browser bootstrap requires `workstream action=continue` for
that exact name before any ordinary connector call. Agent membership, inbox routing and
sender identity therefore come from admitted workstream identity. The extension-reported
ChatGPT conversation is browser lifecycle metadata only: it lets the app reopen/focus that
worker's frontend, but it never authenticates the worker's tool calls.

**Messaging is at-least-once until acknowledged**: queued durably → offered on a tool result
→ acknowledged by the next authenticated tool call. Offering on a result is **not** proof
the model received it. Never delete a message merely because it was offered.

**Worker sleep is short-lived.** `finish` reports a result and puts that worker to
*sleep* for at most one hour: it keeps its conversation, keeps its history, and stays revivable during that window. Sleeping frees
its worker slot, so `maxWorkers` counts working workers only — a prime can create a new worker
while an older one sleeps and still wake that older worker during that hour. Afterward the broker makes the worker terminal, preserves its undelivered inbox in durable history, and tells the prime to reassess and spawn fresh work. The same sleep happens without the tool call, from
durable evidence that the worker stopped: a settled final assistant turn, or quiescence
proven by `activeTurnId`/live-generating state rather than by a page heartbeat.

**Ownership outlives the active run.** When no worker of a run occupies a slot, that run's active
incarnation is parked immediately. Its complete agent map becomes a durable history keyed by the
prime workstream: sleeping workers, terminal/non-revivable rows, their exact ChatGPT conversation
bindings, queued prime reports and monotonically allocated `worker-N` history all remain. New
`worker-N` suffixes are unique across every prime's history, active or dormant; histories from
before per-prime runs can still repeat an id across primes, so browser commands carry their run
id and the broker resolves a bare worker id only when it is unambiguous. Caller-scoped `status`
always returns only the history owned by that prime. A dormant prime may spawn a fresh worker
without reviving a sleeper; waking an old worker reactivates that owner's history whenever an
app-wide slot is free. Internally every exported broker operation first finds the run it
concerns (caller workstream, conversation, or command run id) and runs scoped to it. The swarm
snapshot is version 7 (`runs[]` plus `dormantRuns[]`); a version-6 file, which held one active
run in top-level fields, is migrated on restore and rewritten as version 7. Explicit
swarm clear is different from parking: it retires the worker conversation fences and discards the
retained histories. Turning Multi-agent **off is not Clear**: it stops/withdraws live execution,
parks the owner history, and keeps that history durable through disabled app restarts so re-enable
can still show the exact old worker conversations; workers past the one-hour sleep window cannot be revived.

**Waking is messaging.** `agents action=message` to a sleeping worker reserves a free slot
inside the same durable barrier that queues the message, and only after that commit does the
browser get asked for anything. The revival is an ordinary durable bridge command whose spec
names the worker's own `conversationId`: the app opens `/c/<id>?clf=<command>`, the service
worker hands the job to that chat's existing tab if it is open (closing the duplicate it was
about to be typed in, then focusing the real one), and the content script types the prime's
words as a genuine user message. No free slot means the send is refused outright — nothing is
queued and nothing is typed. A revival that fails puts the worker back to `sleeping`, returns
the slot, leaves the message queued, and tells the prime.

**The ceiling is the only ending.** A worker becomes terminally `finished` when its chat
reaches `WORKER_CONTEXT_CEILING_TOKENS` (400k), measured from the app's own durable session
summary — never from a model-carried counter. Crossing it does not interrupt work in
flight; it makes the *next* stop permanent. Workers do not Compact & Resume themselves,
automatically or manually: their reusable browser conversation is deliberately kept stable
for revival even though agent/tool identity is the worker workstream. Because workers outlive their tabs and their
prime's tab, closing the prime chat pauses the run instead of ending it: the user comes back,
the prime resumes, and the same workers are still there.

**Finish and cleanup.** `finish` is idempotent; final worker output routes to the prime
workstream even if parking happens on that same finish. Once no worker holds a slot, the active
incarnation releases immediately; pending reports remain in the dormant prime's inbox and retain
the same at-least-once offer/ack semantics. Dormant worker **workstreams** remain authority fences,
including terminal rows, so a stale browser tab cannot acquire ordinary agent authority merely by
being observed while a different prime is active. Orphan cleanup uses durable quiescence plus the
wider in-flight MCP/observation counters — not a heartbeat guess. Compact & Resume moves only the
active or dormant prime's browser route and session presentation A→B; the logical prime workstream
and its complete worker history remain the same owner throughout normal commit and recovery repair.

**Acceptance.** Agent spawn/revival/sleep is a live ChatGPT/browser workflow. Validate the actual
worker conversations and connector calls; an in-memory broker simulation is not evidence.

## 17. Renderer, IPC, connection and desktop

**Goal.** `goal.ts` sends only authored user messages and final assistant answers to
OpenRouter. **Two** persisted prompts are editable under Chat → Settings, both bounded by the
same shared limit at config and IPC: `goal.prompt` is the gate used by a chat with no goal of
its own, and `goal.objectivePrompt` is the driver used instead once a chat carries one. The
driver was a source constant until it became editable; nothing else about which one applies
changed. Both are written as meta-prompter instructions rather than as review policies — the
model is told it sits in the user's seat, given the two moves it has (next user message, or
exactly `NO_REPLY`), and taught by five worked examples each, at least one of which ends in
silence. The failure they are written against is a small model that reviews the conversation
or invents work nobody requested, because either one lands in a real composer.
An untouched persisted copy of **any** previously shipped default migrates to the current
prompt — `SUPERSEDED_GOAL_SYSTEM_PROMPTS` is walked, so an install that skipped a release is
not stranded — while customized prompts are preserved exactly. A change to either prompt
retires existing drafts so one draft never mixes old and new instructions. Terminal Goal cards persist for
visibility but their × dismissal is keyed to the finished turn, so activity repaints cannot
resurrect the card and the next Goal run still appears normally. They are presentation scoped
to the exact conversation route: New Chat, a concrete chat switch, or the user's next authored
message removes the old card immediately while async activity remains navigation-epoch guarded.
The provider boundary is non-streaming strict JSON Schema with `require_parameters`, excluded
reasoning and OpenRouter Response Healing. A fixed app-owned output protocol sits after the
editable policy prompt, and an app-owned **trailer** sits after the transcript — a long chat
pushes the instruction out of effective attention, so the closing reminder restates the two
moves where the model read last. Placement is app-owned; the policy it restates is not. Local validation is still authoritative: mixed/wrapped `NO_REPLY` stops,
tokenizer wrappers are normalized away, and malformed schema, reasoning tags, or an empty cleaned
reply fail closed before `humanReply()` or the browser can see a sendable payload.

**A chat's own goal.** The same engine, pointed the other way. The composer control is now
present in a New Chat as well (`injectControl`), because a goal written there is what writes
that chat's first message; compaction stays unavailable there and says why. `/goal/objective` stores one goal
per conversation in durable Goal state, separate from global config. Reopening the same chat
restores that text but does not itself manufacture a new Goal draft from an old finished turn. A
stored goal arms the loop for that chat even while the
standing switch is off (`goalActiveFor` in `bridge.ts`), because writing down a finish line is
the stronger statement; the worker rule still overrides both, and `/goal/objective` refuses a
worker chat outright rather than storing a goal nothing may act on. With a goal the standing
continuation policy is replaced, not augmented — the explicit finish line is the sole driver —
and the empty-conversation refusal inverts: `no_conversation`
becomes an opening message, since the goal *is* the request. A model decision that the goal is
reached stops that run but deliberately keeps the objective until the user clears/replaces it.
Compact & Resume projects the objective A→B in the same continuation transaction, including the
recovery repair path, so overnight resumptions keep the same finish line. `/goal/open` is the one goal
message not keyed by conversation: a New Chat has no id until the message is sent, so that route
holds nothing, streams nothing and is awaited by the page, which then binds the goal to the real
id once ChatGPT issues one.

**Turn outcomes the loop answers.** `completed` and `interrupted`, and no others. `interrupted`
is not the user stopping anything — `endOutcome()` reaches it only when `userStopped` is false —
it is ChatGPT closing its own turn early, which is the case the loop exists for. It was refused
alongside `stopped`/`failed`/`stalled` until 2026-08-25, and silently: session
A retained live regression shows four consecutive prime turns ending `interrupted` with answers
that said work was unfinished, none of which drew anything at all.

**Renderer/IPC.** `renderer/main.ts` is setup/permissions/connection/activity;
`renderer/chat.ts` is session timeline, handoff, swarm. To add a capability: narrow
main-process action → validate in `ipc.ts` → expose exactly that method in
`preload/index.ts` → call it. Do not add a generic `invoke(method, args)` escape hatch; each capability gets its own narrow, validated method.
Async loads use generation counters so a slow load for session A cannot paint over the B the
user selected, and unsolicited state pushes must not clobber a focused unsaved form field.
Captured ChatGPT HTML is untrusted: `chat.ts::renderedMessage()` allowlists semantic tags,
strips attributes, drops executable/form/embed content and non-safe link schemes.
Acceptance: build/run the real packaged renderer and inspect the visible behavior; source-shape
assertions and duplicated expected markup are not acceptance.

**Connection and tunnel.** `connection.ts` owns local MCP server → Core publication →
optional Desktop publication → UI status, across the `openai`, `cloudflared` and `manual`
transports. On OpenAI tunnels **Core and Desktop need separate tunnel ids**, because the
connector UI addresses one tunnel id as one endpoint; on whole-origin transports both
tokenized paths share the origin. Lifecycle operations are serialized and generation ids
invalidate callbacks from replaced tunnels — reuse that for any new async status producer.
`tunnel/index.ts` supervises the child; `tunnel/health.ts` parses its `/metrics` and
`/api/status`. **The poll metric, not a log line, is the proof of a live route**: `/readyz`
is local and stays green through an internet outage, and a single failed long poll is a
retry, not an outage — an outage is complaints that outlive a poll cycle with no completed
poll. `diagnostics.ts` builds the UI self-test and must agree with that same grace period.
Acceptance: the live `/readyz`/poll path and actual tunnel traffic are the oracle.

**Desktop automation (Windows only).** `tools-desktop.ts` + `computer/*` for screenshots, UI
Automation and SendInput/clipboard. Registration-time permission is not enough: each action re-checks. The
helper is prewarmed only when native Desktop capabilities are published; window observation is
background-first and never focuses. Recent immutable frames bind coordinates to screenshot and
window geometry; semantic refs bind cached elements to bounded UIA snapshots. Physical input
revalidates the target, batches report partial completion and route evidence, and compact local
postconditions avoid model-driven wait/observe loops. Validate these operations against the real
Windows desktop/helper, not a fake child process or synthesized UIA reply.

**On-disk state to inspect.** Electron `userData` — `%APPDATA%\chat-on-steroids\` on Windows,
`~/Library/Application Support/chat-on-steroids/` on macOS, `${XDG_CONFIG_HOME:-~/.config}/chat-on-steroids/`
on Linux — contains `config.json` (non-secret validated settings), `sessions/` (durable history),
`state/` (small durable indexes, e.g. `request-correlations`, swarm), and the stable packaged
extension mirror used by Chrome. Credentials live through `secrets.ts`/OS safeStorage. Extension
state is separate: `chrome.storage.local` for preferences/pairing, `chrome.storage.session`
for the journal and live tab state. When a restart bug appears, **first name which process
restarted** — app, service worker, content script, Fiber helper, document, tab, or browser.
Each has a different persistence boundary.

---

## 18. Symptom → open these → tests

| Symptom | Open, in order | Tests |
| --- | --- | --- |
| tool missing/extra in ChatGPT | `surfaces.ts`, `tools-core.ts`, `tools-desktop.ts`, `server.ts` | `mcp` |
| tool still visible after permission off | `server.ts` exposure cache, `kernel.ts` guard | `mcp`, `config` |
| permission / read-only mismatch | `config.ts`, `kernel.ts`, the tool wrapper | `config`, `mcp` |
| native vs virtual path disagreement | `sandbox.ts`, `kernel.ts`, `tools-core.ts` | `sandbox`, `mcp` |
| symlink/junction escape or race | `sandbox.ts`, then the real I/O call site, `rawfs.ts` | `sandbox`, bughunt repros |
| `read` wrong content/list/glob/budget | `tools-core.ts`, `read-backend.ts`, `filesystem.ts`, `fsops.ts` | `mcp`, `fsops` |
| `view_image` validation/transport | `view-image.ts`, `tools-core.ts`, `fsops.ts` | `codex-view-image-parity` |
| patch parse/match/write | `apply-patch/*`, `tools-core.ts` | both `codex-apply-patch-*` |
| shell-intercepted patch behavior | `tools-core.ts`, `apply-patch/invocation.ts` | invocation parity, `mcp` |
| exec / PTY / stdin / output / session | `unified-exec.ts`, `shell.ts`, `ownership.ts`, `exec-output.ts` | `codex-runtime-parity`, `mcp` |
| `RULES_UNREAD` refuses a chat that read its rules, or lets one act unread | `rules-gate.ts`, `kernel.ts` `gatedHandler`, `tools-core.ts` `read` | `scripts/test-rules-gate-steward.ts` |
| one chat touches another's terminal | `ownership.ts`, `kernel.ts`, then §11 chain | `mcp`, `workspace` |
| **calls land in Unattributed** | **§11 chain in order** — `inbound`→`fiber`→`content`→`background`→`bridge`→`correlation`→`recorder` | `correlation`, `mcp-inbound`, `fiber`, `content-script` |
| worker identity / inbox / liveness | §11 chain **first**, then `agents.ts`, stale sweep in `bridge.ts` | `agents`, `swarm` |
| wrong worker/project cwd | `workspace.ts`, `kernel.ts`, §11 chain | `workspace`, `swarm` |
| transcript duplicates / reorders / jumps | `chatgpt-dom.js`, `fiber.js`, `content.js`, `background.js`, `recorder.ts`, `chronology.ts` | `content-script`, `extension`, `session` |
| turn ends early / false stall | `content.js` lifecycle + Fiber terminal evidence | `content-script`, `fiber` |
| Overwrite vanishes / sticks / stale rows | `content.js` paint streams, `fiber.js`, `/activity` in `bridge.ts` | `content-script`, `bridge` |
| extension dies after reload/update | `background.js::restoreOpenChatgptTabs`, content↔Fiber handshake | `extension`, `fiber` |
| navigation resurrects wrong chat | `background.js` tab registry, `content.js` epoch | `extension`, `content-script` |
| bridge pairing / connect / stop | `bridge.ts`, `background.js`, `popup.*` | `bridge`, `extension` |
| Compact & Resume split or lost | `continuation.ts`, `bridge.ts`, `store.ts`, `workspace.ts`, `agents.ts` | `continuation`, `resume` |
| auto-compaction repeats or never fires | `store.ts` edge state, `/compact/claim-auto` in `bridge.ts` | `continuation`, `resume` |
| agents spawn/message/finish | `agents.ts`, `tools-core.ts`, `bridge.ts` | `agents`, `swarm`, `bridge` |
| session UI or main process freezes | `store.ts`, `chronology.ts`, `ipc.ts` read path, `chat.ts` | `session`, retained stress probe |
| stale render / typed input clobbered | `renderer/main.ts`, `chat.ts` generation guards, `ipc.ts` push order | `ipc`, `renderer-state` |
| screenshot / input / clipboard / stale coords | `tools-desktop.ts`, `computer/*` frame-id checks | `computer` |
| connector offline / tunnel / self-test | `connection.ts`, `tunnel/*`, `diagnostics.ts`, `server.ts` | `tunnel`, `mcp` |
| app window open but empty; re-launch only focuses it | Activity log `window renderer gone (<reason>)`; `index.ts::createWindow` `render-process-gone` reload. Linux earlyoom/OOM kills renderers first | live: `kill -TERM` the `--type=renderer` pid; the page must reload with state |
| renderer has too much authority | `preload/index.ts`, `ipc.ts`, `index.ts` window config | `ipc` |
| installed build missing extension/tunnel/rg/node-pty | `electron-builder.yml`, `extension-path.ts`, `scripts/*` | package smoke check |

## 19. Working in this repository

### The tree is dirty and shared

Several agents and the user may be editing at once. Before touching anything:

```powershell
git status --short
git diff -- <files you plan to touch>
```

This repository is an approved sandbox root, which is not an invitation to work other projects inside it: clone another repository to `~/gitclones/<name>` and work there. On 2026-10-09 a full `zettlr-pandoc` clone (1.6 GB, 24 commits never pushed anywhere else), three upstream source copies and a stray `sage-mypy-plugin` patch were found here and moved out.

Assume unrelated changes belong to someone else. Do not `reset`, `checkout`, `clean`,
broad-format, or overwrite unrelated work to simplify your patch. `~/.cc-safety-net` blocks the
destructive git forms. If the exact lines you
planned to edit changed underneath you, reread and integrate — do not replay an old patch.

### The fix loop

1. Reproduce the real bug against the authority that actually owns the behavior.
2. Fix the earliest root cause — not the last place the wrongness became visible.
3. Validate against an **independent oracle**. A test is not evidence when both the behavior
   and the expected answer were authored from the same repository assumption.
4. `npm run verify` runs local side-effect checks: real filesystem/process/OS/git/image-decoder
   behavior plus type/privacy checks. It does **not** establish ChatGPT integration correctness.
5. If the change depends on ChatGPT, Chrome, the extension, conversation lifecycle, connector
   discovery, browser timing, or undocumented web behavior, run `npm run verify:live`. That path
   uses the installed daemon/extension and a real authenticated disposable ChatGPT conversation.
6. `npm run build` / package checks when bundling, native modules, resources, extension
   shipping or installer behavior could differ.

**No self-authored oracle.** Do not write a test whose essential proof is that one thing this
repository defines equals another thing this repository defines: duplicated constants, expected
prompt strings, hand-written state-machine traces, source-code substring checks, fake ChatGPT or
Chrome responses, mocked private APIs, or a mock that returns the response the implementation was
written to expect. Such tests can detect editing accidents but cannot establish correctness and do
not belong in the acceptance suite.

Mocks of an external authority are specifically forbidden as acceptance evidence. ChatGPT is a
closed, changing external application; its DOM, private endpoints, auth/session shape, composer,
turn lifecycle, archive semantics and extension behavior must be observed live. A green simulation
of an invented ChatGPT contract is evidence only that the simulation agrees with itself.

Local tests remain appropriate where the oracle is genuinely independent: inspect the file that
was really written, the process that really ran or died, the OS window that really exists, git's
real history, or a real decoder/standard implementation. Prefer externally visible postconditions
over internal fields and branch counters.

### Commands

| Command | Effect |
| --- | --- |
| `npm install` | install dependencies |
| `npm run dev` | electron-vite dev |
| `npm run typecheck` | type check |
| `npm run verify:privacy` | public Git identity/session/path gate |
| `npm run verify` | CI local checks only; not ChatGPT integration proof |
| `COS_LIVE_PLUGIN_NAME="..." npm run verify:live` | real daemon + extension + authenticated ChatGPT acceptance |
| `npm run build` | electron-vite bundles |
| `npm run dist` | this host OS, x64 + arm64 artifacts → `release/` |
| `npm run dist:mac / dist:linux` | explicit platform families on matching hosts |
| `npm run dist:dir:<platform>:<arch>` | one unpacked package for smoke/debug |
| `just install` | build, replace the installed app, restart it |

`npm run dist:*` leaves its artifact in `release/`. `just install` is the step after it:
it follows the launcher on PATH to whatever this machine installed, replaces that file,
and restarts the app. Without it a rebuild changes nothing about what is running.

There is deliberately no internal unit-test suite. Validation uses the authority that owns the
behavior: compiler/build tooling for static/runtime construction, packaged-runtime smoke for
shipping, the real target OS for native behavior, and live ChatGPT/Chrome for integration.

### Never type into another agent's terminal, and never drive workers from a timer

These two prohibitions apply to every task in this repository.
[`docs/agents/steward.md`, "The steward's job"](docs/agents/steward.md#the-stewards-job) gives
their full context.

Never send text, keystrokes, control sequences, pasted buffers or commands into an
existing tmux/screen pane, interactive shell, REPL, TTY, or independently running
Codex/other CLI agent session. This includes `tmux send-keys`, `tmux paste-buffer`,
`screen -X stuff`, writing to a pane's TTY, or equivalent GUI input automation.

A shell loop, cron job, timer callback, or other non-model process that sends `Continue`,
interrupts, revives, replaces, or re-scopes a worker merely because time elapsed or a chat is
idle is forbidden. A schedule may wake a model steward; it may not make the steward's
decisions. The owner-authorized exceptions are the lease recovery and the workstream watchdog
in §11, "Workstream leases and recovery".

### Task-specific guidance

Read the linked file in full before the task it names.

- [`docs/agents/driving-chats.md`](docs/agents/driving-chats.md): before you read, list,
  create, message, interrupt, revive, archive, move or delete a ChatGPT chat from this computer
  with the `just` recipes, or write a brief for one. It holds the recipes, the `just chats`
  states, and how to brief a frontier-model chat.
- [`docs/agents/steward.md`](docs/agents/steward.md): before you act on the managed fleet as
  the steward, the `orchestrator` workstream or any helper — any tick, owner report, dashboard
  refresh, pause, resume, recover, replace or retire of a workstream, or edit to a managed
  repository's DAG or `AGENTS.md`. It holds the steward's job, the tick, the state definitions,
  reporting, the hard constraints, the operational facts and the owner's decisions about which
  streams run. The rules gate refuses the `orchestrator` workstream every acting tool until it
  has read this file in full (§7).

### Where a regression belongs

There is no internal regression suite. A regression belongs at its actual authority boundary.
Filesystem/process/native changes need a real target-host repro or packaged-runtime smoke.
Everything whose authority is ChatGPT/Chrome belongs in a live acceptance path. The workstream
path is `npm run verify:live`; other browser/connector changes need an equally direct live repro.
Do not add a fake local suite to make externally owned behavior look testable.

### Delegating to workers

The prompt is part of the engineering work — a worker receives its task, not this
conversation. Each assignment states: project path, concrete objective, relevant subsystem
and likely files, evidence or reproduced symptoms it should inherit, constraints and
ownership boundaries, what it may edit, validation to run, and the expected handoff.

Start with the actual task. Do not open with canned text like "you have zero prior
context" — prefer `Fix the renderer state-clobber bug in C:\…; the confirmed symptom is …`.
Workers are already bound to their slot when launched, so nothing is asked of them about
identity. Put what every worker in the batch needs — project path, conventions file,
ownership boundaries, validation to run — in `spawn`'s `context` once; each `task` then
carries only that worker's own objective and files.

For audit-only roles make the write boundary explicit: source, tests, AppData and config
stay read-only, and each worker may create only its named report. The prime then reads the
source itself, reproduces release-blocking claims, records what it accepted or rejected, and
owns every production edit. **Parallel reports are independent hypotheses — not votes, not
proof.**

When a recurring symptom is not yet a clean issue, use the available local transcripts and
durable session metadata to follow **one** concrete request id, conversation id, worker slot
or event sequence end to end. Keep any security-sensitive reproduction material private.

## 20. Packaging and release — `electron-builder.yml`

App id `com.chatonsteroids.app`, product `Chat On Steroids`. Releases build six native
platform/architecture jobs: Windows x64/ARM64 NSIS, macOS x64/ARM64 DMG+ZIP, and Linux
x64/ARM64 AppImage+DEB. Windows stays per-user-capable, `asInvoker`, no forced elevation.

- Only `out/**` + `package.json` go into app files.
- Target-specific tunnel and ripgrep resources ship outside asar — they must execute as real files.
- `extension/` ships outside asar — Chrome's "Load unpacked" needs a real folder.
- In packaged runtime `extension-path.ts` mirrors that bundled extension to stable `userData/extension`;
  do not point Chrome directly at an AppImage's temporary mount.
- `node-pty`, Sharp/libvips and tree-sitter native payloads are staged for the exact target
  platform/arch; host-native build/prebuild leftovers must never override them.
- Uninstall/package replacement deliberately preserves per-user app data.

Before cutting a version, synchronize `package.json`, `src/main/version.ts` and
`extension/manifest.json`, and run the local gates plus the relevant live/runtime acceptance. After installing a local build, verify
the **packaged** app really contains the target extension/tunnel/ripgrep/native runtime and can
execute its PTY/parser/image stack — a successful installer/archive build does not prove it.

`release.yml` is reusable and its matrix builds/smokes every target on a native runner, then one
`assemble` job downloads all package artifacts, creates the standalone extension ZIP and
`SHA256SUMS.txt`, and uploads one release candidate. Publishing runs through
`.github/workflows/publish.yml`, dispatched at the tag itself
(`gh workflow run publish.yml --ref vX.Y.Z`). It calls `release.yml` as a reusable workflow,
so the installers a release carries are built from the tag being published inside the run
that publishes them, and never travel between runs. A tag alone no longer builds anything.
`publish.yml` refuses a non-tag ref, refuses a tag with no reviewed
`docs/release-notes/vX.Y.Z.md`, re-checks the packaging runner's SHA-256 sums before
attaching the files, runs the public-history privacy gate again, and refuses to overwrite an
existing release. Maintainers and agents install the versioned Git hooks with
`npm run hooks:install`; those hooks reject personal maintainer identities and Claude session
provenance before it can be committed or pushed. `release.yml` on
`workflow_dispatch` still produces an unpublished candidate from any ref.

## 21. Security-sensitive areas

Some subsystems sit directly on trust boundaries and need extra review: browser/session identity,
MCP request lifecycle, approved-path enforcement, process execution, desktop control, secrets,
and resource limits. Keep public documentation focused on contracts and invariants rather than
publishing exploit recipes or detailed reproductions for unresolved weaknesses.

Before changing one of these areas, reproduce the behavior against the current authority, preserve
fail-closed behavior, and verify neighboring negative/security cases with an independent oracle.
For ChatGPT/Chrome boundaries that means a live repro, not a mock. Suspected security issues and reproduction details belong through the
private process in `SECURITY.md`, not in public issues, comments, or fixtures.

Prove the shared root before you fix symptoms in several places.

## 22. Definition of done

- The reproduced failure is gone **for the root reason** — not hidden in the UI, not retried
  until lucky.
- The neighboring negative / security case still holds.
- Validation uses an oracle independent of the implementation; ChatGPT/Chrome behavior is accepted live.
- Every producer and consumer of any changed protocol agrees.
- Model-visible schema and user-visible surface still match the implementation.
- Unrelated dirty work is untouched.
- The change passes both questions in §1, "Who sets the limits", or an explicit owner
  instruction named it.
- Relevant local checks pass and `npm run verify` passes; `npm run verify:live` also passes for ChatGPT/Chrome changes.
- Build/packaging checked when the changed layer can differ after bundling.
- Comments and this file updated only where behavior genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.
