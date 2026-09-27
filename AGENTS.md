# Chat On Steroids — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here. If you are
here to stand the watch over the managed fleet rather than to change this app, **§19's
"The steward's job" and the sections after it are the whole of it.** They are short on
purpose. The instrument-reading that used to surround them has been cut, because every
steward that met the instruments first ended up reporting the fleet instead of driving it.

**One file, complete.** This replaces the old `AGENTS.md` + `agent.md` split, which
duplicated roughly 60% of its content and had already drifted between copies. It is sized
for completeness rather than for any tool's default project-document budget; if your
harness truncates long project docs, raise its limit rather than cutting this down.

Because a truncated tail would drop §19 first, the one rule whose loss is irreversible is
repeated here: **this tree is usually dirty and shared with the user and other agents —
never `reset`, `checkout`, `clean`, reformat, or overwrite work you did not do.**

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
**Schema visibility is never the security boundary** — `config.ts::effectiveCapabilities()`
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
- **Reuse gate** (`reuse-gate.ts`): a patch that adds a new code file or a definition name that
  no tracked file already defines must carry `reuse_search`. Per name, it gives the searches
  run, what they found, and why none is reused. Each search must match a `find` call or
  rg/grep/fd/ast-grep/probe command this conversation actually ran, and a search for the
  invented name does not count. Around every `exec_command`/`write_stdin` the workspace is
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

### Workstream leases and automatic recovery

`workstreams.ts` owns durable exclusive claims for every logical workstream. Two minutes
without a tool call, message or worker-started turn permits immediate recovery/takeover; a
running tool call holds the lease (the five-minute action ceiling bounds it) and thought-summary
rows never renew it. Recovery on a page that is still reporting presses Stop and continues in
place; only a page that has stopped reporting is reloaded first. A new claim
invalidates the old opaque token and cancels pending recovery; retained terminals owned by
the old claim are stopped and already-admitted old calls must settle before successor
execution. Browser polls and replayed observations are not activity. The app's own
continuation prompts cannot renew their own lease.

The bridge maintenance sweep owns bounded recovery: one same-chat continuation push gets a
30-second recovery window. Renewed activity ends the episode; otherwise the old lock is
fenced, the extension stops and archives the actual ChatGPT thread and verifies the stored
successful archive mutation response, and the bridge opens a replacement frontend with the saved project
context and generic steward instructions. Action identities and attempt counts survive restart. A takeover
cancels the old action; stale acknowledgements cannot install a replacement owner.

Controller-started managed workstreams are also **turn-driven**, not only timeout-driven.
Their fresh observed `turn_end(completed)` schedules the next workstream prompt immediately;
fresh failed/stopped/interrupted endings enter bounded recovery immediately. The five-minute
lease is therefore the silent/wedged fallback, not the normal mechanism for moving from one
finished unit to the next. Model-created workstream identities are non-driving unless a local
controller explicitly enables auto-advance. Auto-advancing managed conversations stay
page-mounted instead of entering tabless sleep: the observed turn boundary is their scheduler
signal, so hiding it behind quiescence/fallback wake would defeat immediate advancement.

Local scripts use `/workstreams/start`, `/workstreams`, `/workstreams/pause`,
`/workstreams/resume` and `/workstreams/replace` with the local sender credential. The paired extension alone services
`/workstreams/archive`. Failed browser delivery or archival is visible as blocked work;
do not claim a replacement was made from a queue receipt alone. See README for bodies.

This explicitly authorized lease-recovery mechanism is the exception to the historical
timer-driven continuation prohibitions below. Those prohibitions still govern independent
shell drivers and unbounded pushes outside the app's lease state machine.

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

**`fiber.js` is intentionally least trusted.** It emits a strict **allowlist** (not copied
props minus a denylist), never tool argument values, validates the exact CLF connector
names, and fails closed on unfamiliar React shapes. Its `postMessage` output is
page-controlled evidence useful for joining page to local truth — **never a credential**.
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
`/commands/redeem`, `/commands/ack`. `/settings` is the only pair the page may write, and
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

**Workers sleep; they do not end.** `finish` reports a result and puts that worker to
*sleep*: it keeps its conversation, keeps its history, and stays revivable. Sleeping frees
its worker slot, so `maxWorkers` counts working workers only — a prime can create a new worker
while an older one sleeps and still wake that older worker afterwards. The same sleep happens without the tool call, from
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
can still show and revive the exact old worker conversations.

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
summary — never from a model-carried counter. Crossing it does **not** interrupt work in
flight; it makes the *next* stop permanent. Workers **never Compact & Resume themselves**,
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
`preload/index.ts` → call it. **Never add a generic `invoke(method, args)` escape hatch.**
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
| renderer has too much authority | `preload/index.ts`, `ipc.ts`, `index.ts` window config | `ipc` |
| installed build missing extension/tunnel/rg/node-pty | `electron-builder.yml`, `extension-path.ts`, `scripts/*` | package smoke check |

## 19. Working in this repository

### The tree is dirty and shared

Several agents and the user may be editing at once. Before touching anything:

```powershell
git status --short
git diff -- <files you plan to touch>
```

Assume unrelated changes belong to someone else. **Never** `reset`, `checkout`, `clean`,
broad-format, or overwrite unrelated work to simplify your patch. If the exact lines you
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

```sh
npm install
npm run dev                              # electron-vite dev
npm run typecheck
npm run verify:privacy                   # public Git identity/session/path gate
npm run verify                           # CI local checks only; not ChatGPT integration proof
COS_LIVE_PLUGIN_NAME="..." npm run verify:live  # real daemon + extension + authenticated ChatGPT acceptance
npm run build                            # electron-vite bundles
npm run dist                             # this host OS, x64 + arm64 artifacts → release/
npm run dist:mac / dist:linux            # explicit platform families on matching hosts
npm run dist:dir:<platform>:<arch>        # one unpacked package for smoke/debug

just install                             # build, replace the installed app, restart it
```

`npm run dist:*` leaves its artifact in `release/`. `just install` is the step after it:
it follows the launcher on PATH to whatever this machine installed, replaces that file,
and restarts the app. Without it a rebuild changes nothing about what is running.

There is deliberately no internal unit-test suite. Validation uses the authority that owns the
behavior: compiler/build tooling for static/runtime construction, packaged-runtime smoke for
shipping, the real target OS for native behavior, and live ChatGPT/Chrome for integration.

### Reading and driving ChatGPT chats from here

The app records every chat it bridges, and it can type into one for you. Both are `just`
recipes in this repository, so an agent on this computer can watch a ChatGPT conversation
and keep it moving without a browser.

```sh
just sessions                    # recorded chats, newest first
just transcript <part-of-an-id>  # print one chat; defaults to the newest
just search <term>               # which chats mention a term

just chats                       # conversation ids, and whether each chat is mid-turn
just state <conversation-id>     # what that one chat's turn is doing, from the live recorder
just say <conversation-id> "..."  # send that message to that chat
just new "..."                    # open a new chat with that opening message

just interrupt <conversation-id> "..."  # stop the turn it is running, then send
just revive <conversation-id> "..."     # reload its page, then send
```

`just chats` is the one that gives you the id `say` needs. `busy` means that chat's newest
turn event was a start, so ChatGPT is generating — send when it is `idle`. A chat whose tab
was closed mid-turn keeps a stale `busy`, so read the clock column with it.

A chat that `new` opens is an ordinary chat: it is not a worker, it belongs to no run, and
it appears in `just sessions` like any other.

The app must be running and the browser paired — it opens the tab itself.

### What to send them

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

**When a chat's context fills, hand off.** Read its transcript and open a new chat with a very
simple brief: the ambient task, the tracking documents, and the item, phase or subtask in
progress. Nothing more.

### The steward's job

**Scheduled stewardship and automatic worker-driving are different mechanisms.** A ChatGPT/native
schedule that wakes a steward agent is expected: each scheduled run starts a fresh model turn,
rereads the current repository contracts, observes the fleet, makes evidence-based decisions,
drives chats where needed through the normal app path, and verifies the resulting state. That is
what "schedule your own tick" means everywhere in this document. By contrast, a shell loop, cron
job, timer callback, or other non-model process that sends `Continue`, interrupts, revives,
replaces, or re-scopes a worker merely because time elapsed or a chat is idle is forbidden. The
difference is not automation versus no automation; it is **scheduled model judgment versus
judgment-free automatic action**.

An hourly scheduled steward turn may and should contain the shorter intra-hour ticks itself. After
one full tick has finished, the steward may run a **single foreground** `sleep 1200` through the
connector, remain in the same model turn, and perform the next full tick from fresh evidence when
that command returns; repeat once for the third tick. That foreground wait makes no decision and
sends nothing, so it does not violate the rule above. What is forbidden is detaching the wait,
putting it in a loop/watcher, or attaching any worker action to its expiry. The model must be awake
again and must reclassify the fleet before any send, interrupt, revive, replacement or re-scope.

Four repositories are each finishing a defined body of mathematics, one worker chat attached
to each. **Your central analytical product is an evidence-based estimate of where each repository
currently lies on its full 0% -> 100% path to the accepted objective, together with the completion
and convergence rate of the current major milestone, and intervention that makes both converge
correctly.** These estimates are not scalars to read from a
queue, checkbox count, dashboard, or repository field. Producing them requires understanding the
objective, the completed and remaining mathematical/software bodies, their dependency structure,
their relative substantive cost, and the acceptance still separating the current tree from done.
That synthesis is the steward's job; merely relaying repository counters is not stewardship.

The operational product is correct substantive progress on those repositories' actual objectives
that would not have happened without supervision. A large amount of wrong mathematics,
reinvention, cleanup churn, bookkeeping, or unverified code is negative progress even when it
lands quickly. A stopped stream is obvious; a fast stream on the wrong invariant is the dangerous
case because every liveness signal is green.

Every tick therefore starts by recovering five facts for each stream, in this order:

1. **Objective:** what accepted repository contract is this stream advancing now?
2. **Completion model:** what is the current major milestone, what substantive obligations/weights
   define its own denominator, and what remaining roadmap bodies define the whole-project
   denominator? Recover `P_milestone(t)`, `dP_milestone/dt`, `P_project(t)`, `dP_project/dt`, and
   the evidence/uncertainty behind them before reporting a percentage or rate.
3. **Artifact:** what concrete mathematical/software object should exist after the current unit?
4. **Invariant:** what must remain true while that artifact is produced — source fidelity, reuse
   before authorship, phase ordering, exact public behavior, solved-card correctness, etc.?
5. **Evidence:** what direct observation says the worker is advancing that objective rather than
   merely moving?

Do not substitute activity for any of those. A worker can be busy, committing, and wrong. A
worker can also be quiet because a correct gate is still running. Liveness is checked only after
goal and invariant alignment. Likewise, do not substitute a repository counter for the completion
model: the model is a reasoned estimate of project state, not a transcription exercise.

Before any cadence or elapsed-time judgment, establish that the thing being timed is actually the
repository-selected unit.  Read the current DAG/frontier/selector and prove that its prerequisites
are delivered, its priority/source-order rule selects it, and its milestone semantics include the
work now being observed.  Then read the unit's complete acceptance contract and check that the
current implementation/proof route can satisfy it.  If any of those facts is unknown, investigate
them first; there is no meaningful throughput denominator yet.  A definition with an intrinsic
proof, a source audit, a terminal runtime consumer and a routine authoring card are not comparable
units merely because each occupies one row in a queue.  Likewise, a worker editing a dependent
consumer does not prove that consumer is ready: confirm the dependency edge and the prerequisite's
delivered output before crediting the work.

Output rate is a diagnostic, never a pass mark. Compare rates to find something worth reading,
but never certify a stream from a count. Ten reinvented definitions are worse than one correct
reuse mapping; sixty cache refactors after the functional DAG is closed are not sixty units of
the project. Sample semantics, not just cadence.

The converse matters too: semantic alignment does not excuse arbitrarily low throughput. Once a
stream is known to be doing the right kind of work, compare elapsed wall time, substantive units
delivered, and the remaining canonical frontier against that repository's recent demonstrated
rate. A prerequisite phase that runs for hours while blocking the phase containing the actual
mathematics is a control-plane finding even when every artifact sampled is correct. Diagnose the
cause — over-serial decomposition, exhaustive search without a bounded stopping rule, repeated
re-search, an expensive gate in the inner loop, a stale priority/ranking, or another structural
constraint — and repair the durable DAG/work contract when the contract is the bottleneck. "Still
aligned" is not a sufficient verdict for a phase whose projected completion time has become
absurd relative to the work it blocks.

The governing loop is:

> Reground on the repository's current objective; inspect the direct evidence; classify the
> stream; act only on that classification; verify the intervention in the same tick; then audit
> whether your own model of the stream was falsified by what happened.

That last clause is mandatory. The steward is part of the control system and repeatedly becomes
the source of stale metrics, impossible nodes, wrong rankings, duplicate work, and self-sustaining
cleanup. A tick is incomplete until new evidence has been compared with the prediction that
caused the action.

### Report to the owner: progress, rates, blockers, decisions

The steward report is for the repository owner deciding where attention or a decision is needed.
It is not a transcript of the steward's work, an agent activity feed, a proof-of-work record, or a
compliance checklist.

**Process narration is self-soothing and compliance theater.** Listing that the steward reread the
DAG, preserved the dirty tree, sampled an artifact, recomputed a selector, sent a correction,
revived a worker, ran a guard, waited for a process, verified a commit, or otherwise followed the
required procedure can make a weak tick *feel* rigorous without answering the management question.
Those actions prove only that the steward was busy and procedurally compliant. They do not prove
that the project became more complete, that its remaining distance is shrinking, that the
completion model is correct, or that the dominant bottleneck was identified and changed.

There is **no reporting layer for "what the steward did."** Procedure belongs entirely to the
steward's private evidence-gathering and control loop. The report begins only after that procedure
has been compressed into judgments about project state: `P(t)`, `R(t)`, `dP/dt`, uncertainty,
material lost time/risk, the dominant bottleneck and any owner decision. If a procedural fact does
not change one of those judgments, omit it. If it does, report the changed project fact rather than
the action that revealed or caused it. For example, report "completion derivative returned from
zero to +0.6 pp/day after the serialization defect was removed", not "I revived the worker and it
made a commit".

The steward must resist the temptation to include an audit trail merely because the underlying
analysis was difficult. Difficulty of investigation does not make investigation itself an owner
deliverable. A long internal chain of reads, probes, retries and interventions should normally
collapse to one or two management facts. If the report becomes longer when the steward had a
messier tick, that is a warning sign that internal uncertainty or a desire to demonstrate diligence
is leaking into the owner-facing output.

The first question for every workstream is **where the repository is on the full path from its
accepted baseline to its actual long-term objective**. Report position, not the steward's sampling
interval. A useful management summary is anchored by the analogue of both `|t_n - t_0|` and
`|t_final - t_n|`: cumulative substantive progress from the project's own baseline, and substantive
distance still remaining to the objective. The local increment `|t_n - t_{n-1}|` is not a progress
summary. It is sampling-window telemetry and may appear only when it materially explains a change
in convergence rate, a bottleneck, or lost time.

**Every active workstream gets an explicit whole-project completion model.** The steward must first
reconstruct a finite denominator for the **entire accepted project objective**, not merely the
current phase, ready frontier, queue, or visible DAG tail. Starting from the baseline state and the
definition of done, enumerate the discrete substantive obligations that must be delivered for the
project to reach 100%: implementation bodies, mathematical corpora, integrations, migrations,
required audits or source-conformance passes, terminal runtime/acceptance gates, publication/final
delivery obligations when they are part of completion, and any other required body named by the
repository contract. Follow dependencies transitively so downstream work is represented even when
it is not currently ready. Split obligations that are too coarse to compare; combine bookkeeping
fragments that are not independently meaningful. The result is the steward's best current model of
the total project work, not a mechanically copied task list.

Then **weight every substantive obligation intelligently**. Let the reconstructed obligations be
`a_1, ..., a_N` with normalized weights `w_i > 0`, `sum w_i = 1`. The weights must represent the
share of the full project burden carried by each obligation, using mathematical/software scope,
dependency leverage, demonstrated cost of comparable completed work, integration surface,
verification/acceptance burden, and credible reopen risk. Equal weights are justified only when the
obligations are genuinely comparable. A hundred routine leaves may carry less total weight than one
architectural trunk; one terminal acceptance gate may deserve substantial weight when failure can
reopen implementation. **Task count supplies the denominator's structure, not the weights.** Never
use closed-node/total-node, solved-card/total-card, definitions-delivered/definitions-total, commit
count, lines changed, or any other readily automated fraction as the whole-project percentage unless
the steward has established that those units really are the entire objective and are substantively
exchangeable.

For each obligation assign a current completion value `c_i in [0,1]` from semantic evidence. Use
`0` or `1` for genuinely discrete unaccepted/accepted obligations; use an intermediate value only
when that obligation itself has a meaningful internally comparable decomposition. The project
completion estimate is

`P(t) = 100 * sum_i w_i c_i(t)`,

with remaining distance `R(t) = 100 - P(t)`. Report `P(t)` and `R(t)` for every active workstream.
The model may be revised when newly inspected durable state shows that the denominator or relative
burdens were wrong, but **do not change the denominator or weights merely to make progress look
better**. A genuine scope discovery should be incorporated explicitly and should be able to move the
estimated percentage backward.

The steward must also estimate the **derivative of substantive completion**, not the derivative of
an activity proxy. Use successive reasoned `P(t)` estimates over enough elapsed time to suppress
single-tick noise and report the current convergence rate/trend `dP/dt` (or a bounded/robust finite-
difference estimate when only discrete samples exist). The same weighting model must be used across
the compared samples unless a genuine scope/model revision is called out internally. Repository
throughput numbers may help explain `dP/dt`, but they are not `dP/dt`. A card/hour rate, commits/hour,
nodes/hour, lines/hour, test count, or worker-turn count is never the project derivative unless the
steward has proved that the measured units and weights coincide with the whole-project completion
model.

This is deliberately **not automatable by a brain-dead proxy**. Scripts and dashboards may collect
evidence, enumerate candidate obligations, preserve historical samples, and evaluate arithmetic
once the model is chosen. They must not choose the denominator, decide which obligations are
substantive, assign weights, infer partial completion, or substitute a convenient repository metric
for `P(t)`. Those are semantic judgments requiring the steward to understand the project. **That
analysis is why the steward role exists.** A steward that merely reads a scalar, divides two counts,
or reports an automated dashboard percentage has not performed the stewardship task.

The estimate is an analytical judgment, not pseudo-precision. Give the best central percentage,
the derivative/trend, and an uncertainty band when the denominator, weights, acceptance state, or
future reopen burden is uncertain. **"There is no honest scalar percentage" is not an acceptable
conclusion for a defined finite objective:** construct the best evidence-based denominator and
weights available, state the uncertainty, and improve the model as understanding improves. If the
objective itself is too undefined to reconstruct the denominator at all, that is a control-plane
defect to repair or an owner decision to request.

#### Two progress views: current milestone and overall project

Every owner report has exactly **two progress views** for each workstream:

1. **Current milestone progress.** How complete is the substantial roadmap milestone the worker is
   actually advancing now, how much of that milestone remains, and how fast is that milestone
   converging? A milestone is a durable semantic body such as the complete definition layer, the
   authored solution corpus, pre-T source convergence, or Milestone A of a framework programme. It
   is not a card, commit, DAG row, test, or other ordinary execution unit.
2. **Overall project progress.** How complete is the entire accepted project objective, how much
   remains from the current state to 100%, and how fast is that total distance shrinking?

These answer different questions and **both are mandatory**. A large downstream long tail can make
overall `dP/dt` look tiny while the current milestone is converging rapidly. Conversely, a small
milestone can move quickly while the project as a whole remains far from done. Never collapse the
two into one percentage or one derivative.

Construct the current milestone's own denominator and weights from its semantic obligations and
estimate `P_milestone(t)` and `dP_milestone/dt`. Separately construct the whole-project denominator
and weights across all remaining roadmap bodies and estimate `P_project(t)` and `dP_project/dt`.
The relationship between roadmap bodies and their relative weights is part of the steward's
**internal analysis** for the overall estimate; it is not another report view and does not need to
be exposed as milestone weights, roadmap tables, or a hierarchy of percentages.

**The current-milestone baseline is the accepted state when that milestone opens.** Do not dilute
milestone progress by putting work that was already complete, reusable, imported, mapped, solved,
or otherwise delivered before milestone entry into its denominator. Let the milestone denominator
represent the substantive work still required at entry. Measure completion as the fraction of that
entry workload that has since been discharged, and measure `dP_milestone/dt` against that same
baseline. If later semantic review proves that an entry obligation never belonged to the milestone,
remove it from the baseline denominator consistently rather than counting its deletion as production.
Thus definition-realization velocity is measured against the definitions that still required
realization when Sweep III opened, not against every definition in the textbooks; solution-writing
velocity is measured against the unsolved-card backlog when the solution milestone opened, not
against every problem card including those already solved.

For example, while `lean-categories` is realizing definitions, the report must show the definition
milestone's completion and derivative directly even though the much larger downstream theorem tail
dominates the overall denominator. A small overall derivative must not be misread as slow definition
work. Likewise, while `new-qual-site` is writing solutions, show solution-corpus completion/rate
separately from overall repository completion.

Roll local work up through the active milestone or phase into that project goal. A card,
definition, DAG node, commit, acceptance consumer, repaired file, or "what changed since the last
tick" is not itself the progress report unless that item is literally the project objective. Do
not make the owner reconstruct cumulative position from a sequence of deltas. Completed and
remaining major bodies are inputs to the required completion estimate, not a substitute for it.

Report the management facts for each workstream, in this order:

- **Cumulative project-level progress:** the best repository-owned statement of how much of the
  actual objective has been delivered from the accepted project baseline to the current state,
  summarized by the steward's evidence-based scalar completion estimate. Prefer a stable semantic
  denominator where one genuinely measures the objective; otherwise synthesize the heterogeneous
  major bodies analytically. This is an absolute project-position statement, not "since the
  previous report".
- **Distance to completion:** the corresponding repository-owned statement of what remains to the
  objective, expressed as the complement of the same completion estimate and grounded in the
  remaining major bodies, critical path, and terminal acceptance burden. Never replace this with a
  raw count simply because the count is easier to compute.
- **Current milestone:** its completion percentage, remaining distance and derivative/trend. Name
  the milestone in plain language. Do not enumerate its ordinary DAG nodes.
- **Overall project:** its completion percentage, remaining distance and derivative/trend. A small
  overall derivative beside a fast current-milestone derivative is meaningful and should be shown,
  not averaged away. Use local-unit throughput only when the units are genuinely comparable and
  causally identify movement of one of these two views; never substitute it for either derivative.
- **Lost time when material:** time spent blocked, idle, redoing wrong work, waiting on a dominant
  gate, or recovering from steward/worker mistakes. This is part of the throughput picture, not an
  anecdote to hide in a transcript.
- **Dominant bottleneck:** the concrete mechanism currently limiting convergence and its measured
  effect on progress.
- **Owner-only decisions:** only choices that actually require the repository owner.

Interventions get **no separate report field**. If corrective action materially changes the
project, that change already belongs under completion, remaining distance, `dP/dt`, bottleneck,
lost time or risk. If it changes none of them, it is not reportable merely because the steward did
something.

Do **not** report the actions used to obtain those facts. "The worker read this file", "a correction
was sent", "a process was killed", "a commit happened at 03:20", "the dirty tree was preserved",
"the selector was recomputed", "a semantic sample found X", "a retry then passed", and similar
operational events are internal evidence, not report content. A mistake that was corrected before
the report and has no continuing effect disappears completely from the report. Mention process only
when the process itself is the still-live bottleneck, measurable lost time, continuing risk, or an
owner-only decision. Baseline steward obligations are not accomplishments and do not belong in the
report.

Do not smuggle process narration back in under headings such as `tick outcome`, `evidence`,
`verification`, `recovery`, `intervention`, `what changed`, `recent work`, or `status detail`. A
table cell that says a worker was recovered, a source was reread, a selector advanced, a test was
launched, or a commit landed is still process narration even if the column is called "outcome".
Translate it into completion, remaining distance, derivative, bottleneck, lost time/risk, or an
owner decision, or delete it.

Do **not** write a report that could be mistaken for a team activity log, incident transcript, or
steward diary. A repository owner does not need to know who opened which file, when an agent started
or stopped, which local command ran, which retry failed, which correction was sent, or which tiny
prerequisite moved. Those details are analogous to reporting who stapled, mailed, or filed a
document instead of reporting the project's current position. Roll them up into cumulative
completion, remaining distance, rate, bottleneck, lost time, or risk, or omit them.

The final owner report is therefore a **state summary**, not a chronology. For each workstream it
should be possible to delete every timestamp, worker action, intervention description, and prior
tick reference without losing the answer to: how much of the objective is done, how much remains,
how complete the **current milestone** is and how quickly it is converging, how complete the
**overall project** is and how quickly its remaining distance is shrinking, what currently limits
either view, and does the owner need to decide anything? Those two views are mandatory. Do not add
a third reporting layer for milestone weights, roadmap decomposition, or execution-unit detail.
If the report cannot answer both views without falling back to repository counters or prose
inventory, it is delegating the steward's analytical job back to the owner.

Do **not** use commits, lines changed, tool calls, chat busyness, queue-marker movement, or file
write counts as throughput units. They may help diagnose what happened, but they are not progress.
A commit is a bank event; a file write is activity. The rate that matters is the rate at which the
repository's substantive objective converges.

More generally, **a local metric has no progress value merely because it is measurable**. Meetings,
messages, reviews, tickets closed, worker turns, tests run, cards moved, definitions attempted,
files touched, nodes closed, and hours spent can all increase while the project produces nothing
deliverable. Treat every local metric as operational telemetry unless you can state the causal link
from that metric to a repository-level deliverable and show that the deliverable or its genuine
remaining-work measure moved. Six months of perfect local activity with no delivered project
outcome is zero progress, not slow progress.

Before putting any number in the management summary, ask: **what owner-visible deliverable became
more complete because this number changed?** If the answer is only another internal activity or
intermediate bookkeeping state, the number does not belong in the progress summary. It may appear
only as diagnostic evidence explaining why real progress accelerated, stalled, or regressed.

Do **not** answer a current failure with a promise about future model behavior. A sentence such as
"I will report this differently next time" creates no mechanism that binds a later model turn. A
later turn may have different context, summarization, tool state, or model configuration, and the
sentence itself changes none of the durable controls. Presenting it as remediation is misleading:
it sounds like a persistent commitment while enforcing nothing. Fix the failure **in the current
turn**: redo the current output correctly, take the omitted action, and, when a durable rule is
warranted and authorized, write that rule into the durable repository control. Never substitute a
future-behavior promise for present remediation.

### What stops the mathematics

These are the causes. They run in daylight, through streams that look healthy, and they are
worth far more attention than any outage — a stream that is down costs the hours it is down,
while a stream converted to these costs every hour it keeps running and reports itself green
throughout. Each one has a remedy, and the remedy is always something written into the
repository, never something said in chat.

- **Paperwork has become the unit of work.** Folding a disposition, claiming a node,
  releasing a claim, advancing a frontier record, ticking a queue marker, normalising
  whitespace. None of it builds anything, and it is not free: it spends the worker's turn,
  a full gate run, and a tick of the ledger that then reports progress that did not happen.
  *Remedy:* remove the machinery that makes it closable. Retire claim protocols under one
  worker per repository, and fold record and marker updates into the commit carrying the
  content they describe so they can never be a unit on their own.
- **Blockers are endured instead of resolved.** Bad code fails the type-checker and every
  further agent endures it as a papercut, "pre-existing issues", a known-red annotation.
  That is how a repository loses its gate entirely and its velocity with it.
  *Remedy:* paydown items in that repo's TODO DAG, plus a rule in its `AGENTS.md` that the
  first encounter with a red gate, a broken generator, a dead tool or an empty scheduler
  table makes repairing it the current unit.
- **The inner loop is gated too hard.** Commit-tier scoping should be light — sanity checks,
  bouncing agents on what they forgot, cheap checks that catch basic mistakes early. The
  push tier carries the hard work. Whole-repository coherence is a contribution gate. The
  highest priority is writing everything down in the first place.
  *Remedy:* get the tiers split in that repository. A worker that cannot bank a definition
  because something it refers to is not transcribed yet is a gate in the wrong tier.
- **The TODO DAG is not loaded with the work that unblocks throughput.** This is the
  steward's own omission. The next work that lands in each repo should be work that
  accelerates pace and removes blockers, and that is decided by what is in the DAG when the
  worker looks.
  *Remedy:* make sure the DAG names the substantive objective and any blocker that actually
  prevents it. Do not bulk-promote complaints, audits, or speculative future work merely to make
  the graph look populated; each node must buy an executable artifact or remove a real obstacle.
- **Work begins with no executable boundary**, so a worker has to invent scope while implementing.
  *Remedy:* decompose only far enough to make the next substantive unit executable and its
  acceptance falsifiable. Fold small decomposition into the implementation turn. A standalone
  planning/decomposition node is justified only when it resolves a genuine dependency structure
  that several later units consume; it must not become a programme of planning the work instead
  of doing it.
- **Nothing in the repositories tells a worker to repair its own workstream.**
  *Remedy:* every managed repository's `AGENTS.md` carries a periodic drift review — at a
  stated interval the worker re-reads its scope ledger and asks whether what it is building
  is what the ledger says is next, in that order.
- **Policy is delivered in chat.** A worker follows its own repo's documents; a push carrying
  policy buys one turn of compliance and dies with the chat.
  *Remedy:* below.
- **Motion is mistaken for the objective.** A generic continuation driver or a terminal loop that
  rewards finding *something* can keep a repository active forever while teaching nothing about
  its quality. The worker appears exemplary because it never stops. A repository-defined terminal
  **convergence audit** is different: it rotates independent semantic/style/test/type/offload
  lenses, permits a full clean pass to make no commit, and treats that absence as evidence rather
  than failure.
  *Remedy:* after substantive feature acceptance, transition to that repository's convergence
  audit when one is defined. Repair loops that manufacture findings, complaints, or commits merely
  to prove activity. Never replace the steward's per-tick judgment with an automatic driver.
- **A phase boundary is rewritten to legitimize work that crossed it.** Mapping becomes
  definition authoring; definition work quietly proves theorems; an audit starts implementing
  what it was meant to classify. The repository then changes its rule so the already-written work
  counts as compliant.
  *Remedy:* preserve the prior contract, classify the authored material as material needing later
  audit, and restore the phase boundary. A policy edit may correct a false rule; it may not launder
  work into the phase merely because reverting or auditing it is inconvenient.
- **The steward rewards honest reporting of a stall instead of resolving the stall.** A worker
  can accurately say a process died, a gate is red, or nothing has landed and still leave the
  repository stopped for another tick.
  *Remedy:* an accurate diagnosis is input to an action, never the product. Resolve the blocker,
  change the runnable contract, or replace the dead execution path in the same tick.

### Observed pitfall index — use this as differential diagnosis

The detailed incidents below are retained because they show how these failures actually present.
Use this index before inventing a new explanation. The right column names the falsifier or action
that distinguishes the bad reading from its lookalike.

| Apparent healthy signal | Failure it can hide | What to check instead |
| --- | --- | --- |
| many commits / high output rate | fast wrong work or reinvention | sample one recent artifact against the source/dependency/acceptance |
| terminal audit still finding things | either real post-feature defects or self-sustaining churn | check whether the loop rotates independent skill-backed lenses, permits clean no-commit passes, and ties changes to real behavior/dependency ownership |
| `unmatched` / local-owner mapping | false gap or laundering through project code | inspect the external/library route and trace project-existing code to its own owner |
| worker says a blocker is known | blocker being endured forever | reproduce at the blocker owner and repair or make the runnable contract explicit |
| same explanation across ticks | a true diagnosis that became an excuse | test the discriminator that separates the healthy behavior from its failure mode |
| chat is busy | dead session polling or unrecorded loop | inspect process liveness, tool pattern, tree movement, and commit clock |
| chat is quiet | done, blocked, wedged, or merely between turns | read the objective and acceptance before sending anything |
| `Continue` gets activity | generic continuation created cheap/admin work | verify the resulting artifact advances the current substantive objective |
| TODO keeps offering a node | stale completion state | compare the node's acceptance with repository state and close it when proven |
| a metric improved | field/denominator/ranking may be wrong | recompute from the canonical field and update every derivative ranking/instruction |
| detector samples are all correct | detector may have poor recall | audit the enumeration/domain or compare an independent implementation |
| worker changed code after a push | timing correlation credited as causation | verify the change matches the pushed objective and could not predate the intervention |
| a stronger escalation failed | escalation addressed the wrong layer | diagnose page-layer vs behavior-layer vs repository/document blocker |
| cache/refactor got cleaner | hand-rolled mechanism still exists | ask whether the dependency/framework should own the mechanism at all |
| failure set still lists an item | cross-repository observation may be stale | re-check the producer repository before assigning local repair work |
| verification is intentionally deferred | bank grows after verification became ready | treat a ready-but-unstarted verification phase as a wedge |
| steward doc commit moved the clock | worker may still be stopped | filter worker production from steward-authored changes |
| a watcher will report later | intervention is being carried into another tick | stay with the intervention until it lands or fails |
| automated driver keeps chats alive | judgment has been replaced by unconditional motion | stop the driver; every send/interrupt/revive requires a fresh classification |

### Fleet-specific convergence signals

Use the repository-owned roadmap below when building the hierarchical completion model. **Do not
copy current percentages or counts into this document**; recompute them from the named live surfaces
every report. These are milestone identities and dependency relationships, not frozen status. If a
repository materially rewrites its roadmap, update this map in the same steward-control repair so
reports cannot continue projecting completion against an obsolete denominator.

- **`new-qual-site` roadmap.**
  1. **Corpus/source correctness and publication** — source intake, mathematical/copy defects needed
     for publication, migration, tooling and deployed-site acceptance. This is a historical major
     milestone once closed; later regressions reopen their actual owner rather than replaying it.
  2. **Authored solution corpus** — the dominant mathematical long tail. Its natural internal
     denominator is the current problem-card population, with solved/unsolved status derived from
     the cards and repository queue. Source intake is currently closed, so that denominator is
     stable absent an explicit corpus amendment. Report this milestone's solved percentage and
     derivative even when its contribution to whole-project percentage is modest.
  3. **Reader-facing presentation convergence** — `copy-policy-repair`, a real but **non-gating,
     parallel** milestone. Its progress is semantic surface review and repair, not a lint count or
     inventory receipt. It must never serialize solution writing merely because both are open; final
     closure may reasonably wait for the solution-written prose population to stabilize.
  4. **Terminal tooling/site convergence** — the finite `refactor-audit -> type-paydown ->
     bloat-audit-loop` chain after substantive queues close. This is downstream cleanup/convergence,
     not part of the solution-corpus denominator.

- **`lean-categories` roadmap.**
  1. **Corpus inventory and reuse/mapping convergence** — admitted sources, complete catalogue and
     the definition-layer prior-art search/mapping state that minimizes what must be authored. The
     repository's Milestone 1 is the decisive transition out of discovery for definitions.
  2. **Complete definitional layer (Sweep III / Milestone 2)** — **the current major milestone**:
     every admitted definition/construction/notation/convention realized, ownership-converged and
     source-conformant, with proposition/result clauses excluded literally. Use the generated
     definition frontier for its stable comparable denominator. Report this milestone's percentage
     and derivative prominently; it is the meaningful current production signal.
  3. **Theorem/result layer (Sweep IV)** — the very large downstream long tail, including any
     remaining theorem-layer mapping plus realization of the admitted result clauses. It carries a
     large share of the whole-project denominator, but **must not flatten or obscure the Sweep-III
     rate** while definitions are the active milestone.
  4. **Arithmetic/lattice foundations** — the named projective-formed-module, local/global lattice,
     adelic and comparison programme opened by Milestone 2. It may overlap the theorem long tail
     where its exact prerequisites permit; do not invent an all-theorems prerequisite.
  5. **Corpus convergence hardening** — finite refactor, lint and bloat/reuse convergence after the
     substantive mathematical layers they consume.
  6. **Abelian projectivity** — the final named projectivity programme: Appell--Humbert,
     Picard/theta/very-ampleness and Chow/GAGA bridge to the intended projective realization.
  The whole-project percentage must include the theorem long tail, but the report must separately
  expose Sweep III's own completion/rate so a small `dP_project/dt` is not misreported as slow
  definition transcription.

- **`research` roadmap.**
  1. **Pre-T source architecture convergence** — the current dominant milestone. Its internal
     roadmap is the repository's six substantive source bodies: constructor/admission foundations;
     diagrams/rings/geometry; forms/actions/arithmetic; common categorical authority/public
     boundaries; maintained computation; and public mathematical interaction, joined by
     `architecture-remediation`. Those bodies are internal components used to estimate this one
     milestone; they are not additional report views and must not be treated as equal TODO rows.
     Phase T forbids Sage, tests, QC and notebooks here; absence of runtime evidence is therefore
     not lack of progress.
  2. **Research-Sage runtime restoration** — establish the intended executable/environment and fresh
     import path after source convergence.
  3. **Terminal integrated mathematical session** — execute the banked specimens, regenerated
     megadoc/graphs and notebook/public-session obligations on the final owned API. This is the
     runtime proof milestone, distinct from source authoring.
  4. **Post-remediation convergence** — finite repository-wide refactor, justified type paydown and
     final bloat/offload convergence. Optional research consumers are outside the required project
     denominator unless the repository explicitly promotes one into the required DAG.

- **`sage-categories` roadmap.** The current TODO explicitly owns two major milestones; historical
  native-engine remediation is evidence, not the current denominator.
  1. **Milestone A — complete kernel and `Cat` subtree.** Model its completion from the substantive
     core bodies, not row count: owned interfaces; functor/cell calculus; selected transport;
     universal calculus; properties/refinement; inheritance/coherence; indexed/weighted/algebraic
     structured calculus; integrated static/boundary enforcement; then `kernel-cat-complete`.
     Those bodies are internal evidence for Milestone A's percentage and derivative; do not report
     them as a third progress view.
  2. **Milestone B — correct, minimal mathematical leaves.** Sets/order, algebra, geometry and
     infinitary families converge on the accepted A interfaces, followed by integrated behavioral/
     architectural acceptance and `leaves-complete`. Weight leaf families by substantive scope and
     acceptance burden rather than counting four rows equally.
  3. **Framework delivery** — final reconciliation/delivery of accepted A+B on the required branch/
     publication surface. It is a small terminal delivery milestone, not a substitute for either A
     or B.
  Revision-scoped acceptance remains mandatory throughout: a regression reopens its actual A/B
  owner and changes the corresponding milestone estimate rather than creating a parallel historical
  completion story.

### The steward dashboard is derived observability, not a scheduling authority

The static workstream dashboard is a required steward output for human inspection. **Refresh its
derived data at least once in every hourly stewardship run**, after reading the repositories from
which that data is computed. A dashboard older than one hour is stale even when its page still
loads. The generator may read repository files and Git history; it must never write a managed
repository, send to a worker, or choose a next unit. Repository TODO/DAG/frontier/queue files and
direct execution evidence remain authoritative when the dashboard disagrees.

Make the page legible to someone who has not read this file. Project-local shorthand such as
“frontier”, “ready node”, “residue”, “Milestone 1”, “terminal audit”, or “Queue C” needs a short
plain-language tooltip or popover at the point where it is displayed. Do not use status copy as
advertising: words such as “canonical”, “healthy”, “productive”, or “converged” carry no evidence
by themselves and should be replaced by the measured fact or omitted.

The audience is the repository owner deciding where attention is needed, not the agents managing
their own implementation. **Dashboard prose must stand on its own for an external technical
manager.** Do not expose task IDs, phase labels, internal coinages, worker instructions, provenance
rules, acceptance-lawyer language, or sentences that only make sense after reading a repository's
AGENTS/TODO files. Translate the underlying state into the thing being accomplished and the
measurable remaining work. For example, say “95 textbook definitions still lack a located Lean
implementation” rather than naming an FC unit or “definition frontier”; say “refactoring public
mathematical operations onto their owning objects/categories” rather than naming an architecture
node. Internal identifiers may remain in the generated data for graph joins, but they are not
presentation copy. A detail view expands the same externally comprehensible description in place;
it must not replace it with raw worker-contract prose or navigate the reader to an unrelated block.

Order the page by management value. Put the two progress views first: **current milestone** and
**overall project**. For each, show completion, remaining distance and derivative/trend. Then show
lost time and the dominant bottleneck. Never lead with "since last refresh", "this tick", or another
sampling-window delta. Do not lead with local cards, nodes, definitions, commits, acceptance
consumers, or worker state unless one of those is itself the long-term objective. A manager should
not have to reconstruct project position from interval changes, implementation-unit statistics,
commit history, file writes, or worker events.
Every workstream's primary progress surface must include the steward's **scalar completion estimate
on the full project objective**, its remaining complement, and the derivative/trend of that same
modeled percentage. A directly countable repository measure may inform that estimate but does not
replace it. When work is heterogeneous, the steward supplies the synthesis: the finite obligation
set `a_1, ..., a_N`, normalized weights, dependencies, critical path, relative substantive scope,
acceptance burden and evidence from comparable completed work. Show an uncertainty band when
judgment, rather than a stable semantic denominator, determines the estimate. The dashboard may
perform arithmetic and plot history **after** the steward has supplied the completion model; it must
not infer `N`, choose weights, or silently replace `P(t)`/`dP/dt` with a repository proxy. If no
fresh steward model is available, show the estimate as stale rather than manufacturing one from
counts. Where the repository also owns a meaningful remaining-work denominator, use plots and
trend/projection models over that denominator only as supporting evidence.

The dashboard must not show only `P_project(t)`. It must also show the current milestone's
`P_milestone(t)` and `dP_milestone/dt`. When a large downstream long tail dominates total weight,
the current milestone's faster convergence must remain visually obvious. Conversely, do not let a
fast milestone imply that the whole project is nearly done. These are the two primary views; do not
add milestone-weight tables, submilestone trees, or the full DAG to the primary progress surface.

Commit counts, insertion/deletion counts, file mtimes, process activity, and similar derivatives
are diagnostic activity signals, not progress rates. They may appear in a secondary/detail view to
explain a substantive rate change, but do not lead the dashboard with commits/hour, lines/hour, or
other activity proxies and never project completion from them. Do not report file sizes as
progress. Commit diffs, when shown as diagnostic detail, use the conventional GitHub-like
presentation: human-readable “N files changed”, green `+insertions`, red `−deletions`, never
compressed tokens such as `4f +22 -15` or an unsigned `±` aggregate.

Use mature interaction/visualization libraries rather than hand-rolling widgets already solved by
the browser ecosystem. Popovers/tooltips must clamp to the viewport, remain readable on touch, and
show the complete requested text; truncation is allowed only in a compact row that has a real
in-place expansion for the omitted text. A “details” interaction must expand details, not scroll or
jump to another section.

Each refresh computes rather than copies the useful observability surfaces. At minimum expose:

- a management summary for each workstream with exactly two progress views: **current milestone**
  completion, remaining distance, uncertainty and derivative; and **overall project** completion,
  remaining distance, uncertainty and derivative. Then show material lost time, the dominant
  bottleneck, and any owner-only decision. Both estimates are model judgments over semantic work,
  not mechanically derived node/card/definition fractions. Single-refresh deltas and local task
  throughput belong here only when they explain one of the two derivatives; they never substitute
  for either completion model;
- the current DAG/worklist with touch-friendly pan/zoom/navigation, node prerequisites and the
  repository text that defines each node's acceptance;
- the repository-owned progress measures named above, with denominator and measurement definition
  visible beside every count or percentage;
- diagnostic commit activity over time, plus recent commits with timestamp, subject,
  author/ownership distinction where meaningful, changed-file count and basic insertion/deletion
  statistics. Keep this subordinate to the substantive progress summary;
- diagnostic filesystem activity from actual file mtimes, with recent edited files available in
  detail. Treat mtimes as working-tree activity, not accepted progress;
- current dirty-tree summary, worker/process state, and the last known classification, clearly
  separated so a busy process or large diff cannot masquerade as semantic progress; and
- enough recent history to make a rate change inspectable instead of reducing it to a single
  “velocity” number. Prefer distributions and tails over a score.

The dashboard is allowed to visualize facts that are not certificates. Label those semantics in
the UI: commits show banked history, mtimes show recent writes, processes show execution, and DAG
counts show scheduling state. None establishes mathematical correctness. When a steward changes a
measurement or discovers a wrong denominator/ranking, update the generator and every displayed
derivative in the same control-plane repair so the page cannot keep steering attention with the old
metric.

### The two surfaces you write

Durable **control changes** land in one of two places, both inside the managed repository, both in
your own hands. Handing either to a subagent is delegating the only job you have. A one-off
observation does not automatically deserve either surface: the steward already has a transcript
and git history. Write only facts that should change a future worker's selection or behavior.

- **That repository's TODO DAG** decides what gets worked next. This is the lever on pace.
- **That repository's `AGENTS.md` and `CONTRIBUTING.md`** decide how it gets worked, and a
  rule already restated once needs an enforcement point in the commit gate rather than a
  third restatement.

A chat push is normally a pointer into those documents: fix the durable contract, then point the
worker at it. When the problem is ephemeral rather than durable — a dead process, a wrong checkout,
an already-fixed cross-repository failure — send the concrete current fact instead of manufacturing
a permanent policy for it. Never make chat prose the only home of a rule that should survive the
chat.

Fleet-wide owner stops and resumes are durable worker rules, not merely steward scheduling facts.
Record the fleet decision in the scheduling source **and mirror the controlling stop/resume clause
into each affected repository's `AGENTS.md` before treating it as enforced**. Repository-specific
scheduled continuations can be older than the fleet decision and may read only their local
repository contract; recurrence of an old continuation prompt never supersedes a newer local owner
pause. Remove or replace the local clause only when a later explicit owner decision changes it.

**Never run a steward commit detached on a repository with an expensive gate.** Your filings
compete for the same single index the worker uses, and these gates run for minutes — long
enough for memory pressure to kill the process mid-run, which orphans `.git/index.lock` and
stops the repository until someone proves the lock stale. A background task and a `Monitor`
loop are both detached: on 2026-09-12 a watcher's `test-commit` was terminated by signal 15,
and the lock it left blocked `new-qual-site` for fifteen minutes while the steward read the
worker as idle and queued politely behind a lock its own dead process had created. Run the
commit in the foreground under `timeout` and watch it finish, or hand the file to the worker
to carry in its next commit — it is already inside that gate and pays nothing extra.

Each repository names its own docs-only commit route — `new-qual-site`'s authorized
docs-only route, `sage-categories`'s docs-only exemption, `research`'s prose-only exemption.
Use it and cite it. A steward commit touching code, data or a card takes the ordinary gate.

### A chat that stores your message and never starts a turn is dead

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

### `noProgressForMs` equal to `generatingForMs` means unrecorded, not stalled

When those two fields match exactly, nothing has been stored since the turn began — and that
reads as a long silence when it is often a recording gap. On 2026-09-12 two chats showed
`turn=39m noprog=39m` and `turn=59m noprog=59m` while committing four and ten minutes earlier
respectively: the work was landing in git and the rows were not reaching the recorder.

So treat the equality as a signal about the *recording*, not the worker. The commit clock and
the host are unaffected by it and stay authoritative — a stream with recent commits is working
regardless of what the silence figure says. Reserve the stall reading for a silence that is
shorter than the turn, which means rows were arriving and then stopped.

### Ask the host what the worker cannot see

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

### A chat that stalls the same way twice earns a shorter horizon

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

### Before pushing a chat, confirm no newer chat owns its repository

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

### A worker can report a commit from the wrong repository

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

### Gated paperwork reappears in the nearest ungated form

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

### A watcher that reports next tick is carrying the intervention into the next tick

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

### A recorded failure set goes stale in one direction and nobody is watching it

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

### A blocker that spans two repositories is only visible to the steward

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

### Space `du` cannot account for is held by deleted-but-open files

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

### Gate churn accumulates in caches, and the reclaim is smaller than the tool claims

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

### Attribute a host trend before escalating it, and expect it not to be the fleet

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

### `git log --diff-filter=A` does not see merges, and a jump is as likely a merge as production

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

### One tick is a sample; a trend needs the buckets

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

### Read the age distribution of a dirty tree, not its size or its signature

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

### A tree signature says nothing on its own, because committing restores an earlier one

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

### A true explanation becomes an excuse the second time you reach for it

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

### Shared tooling that prints for a human is a context tax on every agent that calls it

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

### When a worker will not do a cheap thing, price it before pushing again

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

### Closing finished nodes is the steward's work, and an unmarked one stays ready forever

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

### Correcting a total does not correct the worklist built from it

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

### A count with a moving denominator is not a progress measure

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

### Count the field, not a phrase that happens to appear near it

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

### A transcript tail of generic lines is not evidence of inactivity

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

### A burst of unsent turn-starts predicts stalls in exactly those chats

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

### The app's send registry is not a complete record of what starts turns

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

### An outlier turn duration is the signal, not silence against commit age

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

### Revive fixes a page; it does not fix a loop, and the rungs are not ordered by strength

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

### The ladder is for stopped streams, not for streams doing the wrong thing

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

### Chain the edit to the commit, or the commit will describe work that did not happen

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

### Syntax-check an instrument before the intervention that uses it

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

### Never wrap a sender in a timeout shorter than its own deadline

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

### A waiter cannot outlast a turn, and turns grow with the conversation

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

### After an app restart, `lastStoredKind` is empty, not dead

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

### `chat_error` is a fifth state: running at the tool layer, storing nothing

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

### The steward's own footprint does not appear in the steward's instruments

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

### Filing is only delegation where a worker exists; elsewhere it is deferral

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

### A migration that leaves the old path writable has not migrated anything

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

### A correction can be worse than the mistake; say what was wrong, not what to undo

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

### Verify a blocking node's premise harder than an adding node's

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

### A cleanup loop improves what it finds and never asks whether it should exist

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

### Ask whether the work should have existed, not only whether it happened

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

### An error rate is not comparable across streams doing different work

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

### Repair the document that states the rule, not the one that describes the work

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

### Fix a failure mode in one repository, then sweep the other three for it

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

### Sampling a detector's hits proves precision and says nothing about recall

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

### Verify against the fastest true signal, not the most convenient one

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

### Historical failure: the continuation driver replaced stewardship judgment

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

### A cleanup step that has never once run looks exactly like a clean fleet

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

### Check the work is possible before climbing the ladder

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

### Production nobody has executed is not production

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

### The acceptance you write into a node is the work the node will produce

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

### Check a complaint is open before filing it as work

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

### In this repository, author no longer separates steward from worker

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

### Do not count your own commits as the worker's

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

### Measuring production

Measure **falsifiable artifacts that advance the current accepted objective**. Counts are
secondary summaries after that classification, never the classification itself. A solution counts
only if it solves the card; a mapping counts only if it identifies the correct owner; a definition
counts only if the current phase permits authoring and the source/dependency comparison supports
it; a refactor counts only if the repository actually has an open refactor objective. The same
diff under a different phase can be useful work, premature work, or damage.

For each stream keep these seven facts in working memory for the current tick; do not create a new
persistent ledger for them:

```text
objective        the current accepted repository goal
completion       current milestone P/R/dP; overall project P/R/dP; uncertainty
unit contract    the ready node / acceptance being executed
artifact         the concrete thing this unit should add or repair
invariant        the semantic constraint that must survive
execution        the test/build/source comparison that can falsify the artifact
direct state     worker turn, tree, process and worker-authored commit evidence
```

The `completion` line is the synthesis the steward owes the owner. It is not copied from a queue or
computed by dividing closed rows by total rows. Reconstruct or revalidate the **current milestone**
model and the **overall project** model from current durable state every tick; prior completion
models are hypotheses, not authority. Preserve enough prior `P_milestone(t)` and `P_project(t)`
samples to estimate meaningful derivatives under a stable model. If the model itself changes
because scope or weights were wrong, distinguish that model revision internally from substantive
progress before estimating derivatives; do not turn a denominator change into apparent delivery.

A number is useful only after those seven facts agree. Three common proxies stay forbidden as
certificates: commit count, changed-line mass, and queue/TODO deltas. All can increase while the
project goes backwards. A repository-owned scalar such as `just unsolved` can measure one stated
property, but it cannot certify the quality or legitimacy of the work that changed it.

A tracking surface is suspect whenever an entry can close without the artifact named by its
contract existing. Fix that surface. Conversely, do not invent a counter merely because a thing is
hard to supervise: where correctness is semantic, sample the semantics.

Every periodic audit samples at least one recent substantive artifact from every active stream.
For reuse-first formalization this means opening the actual upstream/library candidates. For
source-backed content it means comparing the actual source statement. For runtime/framework work
it means exercising the public consumer or reading the exact regression. A productive stream is
not exempt; it is the one for which semantic sampling matters most.

### The tick

The tick is a session-only cron job (`13,43 * * * *`) whose prompt is saved verbatim in
`steward-dashboard/tick-prompt.md`. A session continuation silently drops it, and on
2026-09-26 ticks stopped twice unnoticed. After any continuation, check that the job exists
and recreate it from that file.

Run these steps in order. Skipping the early ones and starting from chat liveness is the failure
mode that produced most of the incidents in this section.

0. **Finish the previous intervention first.** If the prior tick sent, interrupted, revived,
   replaced, edited a governing document, or started a corrective run and its result is not yet
   known, resolve that before measuring anything else. An unverified intervention is not allowed
   to become background state.
1. **Reground each stream from durable state.** Read the current TODO/DAG node and its acceptance,
   plus any governing rule that materially constrains it. Do not rely on the previous tick's
   summary. Establish the objective, completion model, artifact, invariant and phase boundary.
   Identify the **current major milestone** containing the selected work and reconstruct its own
   substantive denominator/weights. Separately reconstruct the **overall project** denominator from
   the complete roadmap. Compute `P_milestone(t)`, `R_milestone(t)`, `dP_milestone/dt` and
   `P_project(t)`, `R_project(t)`, `dP_project/dt`. Preserve the distinction between rapid current-
   milestone convergence and a small overall derivative caused by a large downstream long tail.
   If the substantive objective is already accepted, classify the stream as done before looking for
   more work.
2. **Observe direct state.** Read the worker's live state and recent transcript, the working tree,
   worker-authored commit history since the last tick, and any live process the worker claims to
   be waiting on. Use the repository's canonical queue/frontier instrument where one exists.
3. **Check semantic alignment before throughput.** Inspect what the newest substantive work
   actually does. Does it satisfy the current node? Does it preserve the invariant? Is it crossing
   a phase boundary, reimplementing a dependency, or turning an audit into authoring? If the
   answer is unknown, the stream is not yet certified working merely because it is active.
4. **Classify exactly one state:** working, wedged, blocked, drifting, or done. Use the definitions
   below. “Busy”, “slow”, “honest about the stall”, and “many commits” are observations, not
   states.
5. **Act according to that state.** Leave aligned working streams alone. Diagnose and recover
   wedges. Remove blockers at their owner. Stop and correct drift before it compounds. Close done
   feature work and transition to the next substantive node or the repository's defined terminal
   convergence audit; retire only when neither exists or the owner has explicitly paused it.
6. **Verify the action against the earliest true signal.** Name before acting what success should
   look like: a specific tool/process begins, the tree changes in the intended paths, the corrected
   source is read, the worker starts the corrected node, or a worker-authored commit lands. Stay
   with the intervention until that signal appears or the rung fails. Do not use a `turn_start`,
   delivery receipt, timer expiry, or your own repository edit as proof.
7. **Update durable control state only from proved transitions.** Close a completed node in the
   same tick that proves its acceptance. Correct a false blocker or stale worklist immediately.
   Do not add a rule merely to narrate what happened; change a rule only when it changes the next
   action under an observable condition.
8. **Perform the self-audit when due, then report the project state briefly.** For each workstream,
   report exactly two progress views: **current milestone** completion, remaining distance and
   derivative; then **overall project** completion, remaining distance and derivative, with
   uncertainty where material. Then state the dominant bottleneck and any owner-only decision. Do
   not report milestone weights, roadmap decomposition, or execution-unit detail. Do not report
   which artifact moved, which
   intervention was performed, or which
   diagnostic fired unless that fact remains necessary to explain the current bottleneck, material
   lost time, risk, or owner decision. The report is the current project-position estimate, not a
   narrative of the tick.

The tick interval is a maximum time the fleet may go unexamined, not a cadence for sending
messages. A healthy worker may receive no message for many ticks. A stopped or drifting worker is
handled immediately rather than waiting for the next scheduled sample.

### State definitions and the action for each

**Working.** The current objective is still open; recent artifacts or a live relevant process are
advancing its accepted unit; and a semantic sample has not contradicted the invariant. Leave it
alone. For managed repository workstreams, no individual tool/command/test/build action is allowed
to run for five minutes: that duration is itself a major failure signal, not a legitimate
long-running gate. These repositories are source/architecture/definition/card work, not enterprise
release pipelines. A command approaching five minutes requires stopping it and re-grounding in the
explicit task/DAG/phase boundary: check for drift, a broad or pathologically slow test/build,
unnecessary heavyweight validation, watcher/server work, or push/publication work that was never
assigned. Resume with a narrower source action or focused owner-local check. A high commit rate is
not enough.

**Wedged.** The objective is valid and executable, substantive work remains, but either there is no
live relevant action and no advancing tree/commit/transcript evidence, or one individual action has
crossed the five-minute ceiling. There is no autonomous "waiting" state after tool activity stops:
an agent with no active tool call will not wake itself later. Conversely, an active tool call does
not excuse a five-minute stall; a test/command lasting that long is itself the thing to stop and
diagnose. First inspect the dirty tree: if it holds coherent finished work, the first instruction
is to bank it. Then recover the chat at the layer actually broken. Do not call a stream wedged
merely because a metric has not moved while fresh bounded actions are still advancing the assigned
unit.

**Blocked.** The objective is valid but cannot currently be executed because of a repository rule,
cross-repository dependency, host condition, credential, publication decision, or missing external
authority. Verify the blocker itself. Fix safe, reversible document/tool/cross-repository defects
directly when within standing authority. Escalate only the owner decisions named under Hard
constraints. A blocked worker that keeps doing adjacent work is not disobedient.

Block the **smallest objective the evidence actually blocks**. A failed push, unpublished revision,
optional transfer consumer, unavailable external service, or cross-repository subcheck does not
turn the whole repository into `blocked` unless the current DAG node's acceptance actually depends
on that action. Read the dependency edge, not the severity of the error message. If the repository
explicitly says to record the external failure and carry on with local terminal review, session
verification, refactor audit, type audit, or convergence work, then those nodes remain executable
and the stream is not blocked. Promote an external observation to a stream-level blocker only when
no current substantive node can satisfy its acceptance without the missing authority/dependency.

**Drifting.** Artifacts are landing, but they do not advance the current objective or violate its
invariant: theorem work during a definition phase, authoring during mapping, local reinvention
where dependencies should own the operation, administrative cleanup after acceptance, etc. This
is more urgent than a wedge because every additional commit compounds the repair. Stop the turn
when necessary, fix the governing document if it is what authorized the drift, and identify the
affected recent work for later audit. Do not rewrite policy to make the drift retroactively valid.

**Done.** The current objective's acceptance is proved. Close its durable node immediately. If the
repository contains another ready **substantive** objective, the worker takes it under the normal
selection rule. Otherwise, if the repository defines a terminal convergence audit, that audit is
the next objective and remains open indefinitely: each pass loads its prescribed policy/skill
lenses, may repair real findings or hydrate broad ones into DAG children, and may legitimately
produce no commit when the tree survives the lens. A clean pass increases confidence; it does not
close the loop. Retire only when no substantive node or convergence audit exists, or the owner has
explicitly paused the repository.

### Escalation is diagnostic, not a fixed ladder

The old shorthand “push → interrupt → revive → replace” is ordered by how disruptive the actions
are, not by how appropriate they are. Choose the rung from the failure layer:

- **Idle between valid units:** send one concise pointer to the current repository objective. A
  bare `Continue` is acceptable only after the classification above has established this case.
- **In-turn behavioral loop:** interrupt with the observed loop and the unchanged objective. A
  reload faithfully restores bad behavior and is the wrong tool.
- **Page/recording/composer failure:** revive once. A page that cannot store output needs a page
  repair, not more instructions.
- **Repository/document blocker:** fix the blocking contract or tool first, then send a pointer to
  the corrected source. Repeated chat messages cannot make an impossible node executable.
- **Repeated failure of the same chat after the right-layer correction:** replace it. Characterize
  its dirty tree before handoff and preserve all banked work.

After every rung, verify before another. Never queue several sends, never let a background watcher
stand in for follow-through, and never climb merely because the desired metric has not moved yet.
A stronger rung that targets the wrong layer is worse than a weaker correct one.

### Periodic self-audit — the loop must learn while it runs

Run this at least once per hour or every three ticks, whichever comes first, and immediately after
any false intervention, wrong metric, incorrect blocker, or user correction. This is not another
reporting programme; it changes the control loop when evidence defeats it.

1. **Semantic sample:** inspect one recent substantive artifact from every active stream against
   its actual authority. A stream with no artifact to sample is itself a finding.
2. **Intervention audit:** take the last three steward interventions and state the predicted
   observable result each one was supposed to cause. Compare with what actually happened. Do not
   credit an intervention from timing alone. If the prediction was wrong, correct the model/rule
   that produced it before the next intervention.
3. **Explanation audit:** any explanation reused on two ticks (“batching”, “slow gate”, “reuse
   search”, “host pressure”) must be tested through its discriminator on the next tick. A true
   explanation is not exempt from revalidation.
4. **Phase audit:** check that no stream crossed its own sequencing boundary and that no policy
   edit reclassified premature work into the current phase.
5. **Terminal-work audit:** distinguish convergence from churn. A valid terminal audit rotates
   independent skill-backed lenses, tests actual behavior/architecture/dependency ownership,
   permits no-change passes with no receipt commit, and hydrates large real findings into explicit
   DAG children. If the loop instead must manufacture a complaint, TODO tick, cache refactor, or
   commit every pass, repair the loop before letting it continue. Substantive acceptance being
   closed is what makes the convergence audit relevant; it is not by itself a reason to stop it.
6. **Reuse/offload audit:** for any stream whose architecture says “use dependencies first”, sample
   one recent local mechanism and ask whether the dependency/framework owns it. A cleaner local
   reinvention is still reinvention.
7. **Management-overhead audit:** inspect consecutive worker commits/turns for queue edits,
   complaint entries, TODO rewrites, formatting, status reconciliation, cache/style cleanup, or
   other artifacts that can close without the repository's product advancing. If they dominate,
   repair the work contract rather than praise the cadence.
8. **Instrument audit:** any metric that changed a priority or worklist is recomputed from its
   canonical field with the same definition. If the metric was corrected, also correct every
   ranking, node, and instruction derived from it. Validate new detectors for recall as well as
   precision.
9. **Steward-footprint audit:** confirm one tab per managed chat, no abandoned send/watcher, no
   steward-created index lock or long process, and no host trend being blamed on the fleet without
   attribution.
   Keep the routine resource preflight bounded. Read `df`/inodes, `free`, swap/I/O pressure,
   live process counters, and the small set of already-known project/cache surfaces. Do **not**
   recursively `du` or `find` every managed repository, all of `/tmp`, or the user's global
   caches on every tick: on this host that diagnostic itself can run for minutes in uninterruptible
   I/O, distort the workloads being measured, and block worker delivery. Escalate to a broad
   filesystem walk only when a current unexplained storage delta remains after the bounded
   producer checks, and stop the walk once the producer is identified.
   Treat heavy runtime concurrency as part of host attribution too. When the host is actively
   swapping or showing sustained I/O pressure, do not run independent memory-heavy acceptance
   jobs merely because they belong to different repositories. In particular, a Lean elaboration
   and a cold Sage/Julia/OSCAR consumer may each be valid work while their concurrent execution
   makes both timings meaningless. Preserve the already-running valid job, hold the other stream
   at its durable source/checkpoint boundary, and resume it after the pressure clears. A timing
   gathered during known cross-stream thrash is resource evidence, not an operation-performance
   baseline and not a semantic failure.
   Treat disk pressure first as a **producer/workflow defect**, only secondarily as a cleanup task.
   A workflow that repeatedly materializes full-repository validation/push worktrees, bootstraps a
   heavyweight model/runtime into `/tmp` or a global cache, or writes hundreds of MB outside its
   owning project for an ordinary unit is not healthy merely because the artifacts are temporary.
   Attribute the bytes to the exact command and work contract, then stop or redesign that producer
   before reclaiming its outputs. Prefer one reusable project-owned worktree/scratch surface over
   per-batch clones; a clean validation/push step never justifies another full checkout when the
   existing tree, isolated index/commit-tree route, or one reusable worktree can represent the same
   candidate. Do not install/download local neural-model stacks on the connector for an experiment
   when the workload can use the remote service/search host or be deferred.

   Cleanup follows only after the producer is corrected. Inspect repository `.tmp`/build/test-cache
   surfaces, host-global `/tmp`/cache consumers, and registered Git worktrees. Reclaim only state
   that is rebuildable/absorbed and unreferenced by a live process or active worker; prune a
   worktree only after its work is banked/merged and the worktree itself is clean. Expensive warm
   state intrinsic to the accepted workflow, such as Lean `.lake/packages` or a deliberately
   retained Julia depot, is retained by default because deleting it converts disk recovery into
   later download/precompile stalls. Prefer the ecosystem's own GC/prune operation when one exists,
   and measure the real `df` delta rather than the tool's claimed reclaim. An unexpectedly large
   environment must be compared with its explicit environment specification before deletion.
10. **Automation audit:** there must be no process that automatically sends `Continue`, interrupts,
    revives, re-scopes, or otherwise drives workers from idleness alone. A timer may wake the
    steward to perform a tick; it may not make the tick's decisions.

When the self-audit discovers a new recurring failure mode, first ask whether an existing rule was
wrong, bypassed, or missing a discriminator. Amend that owner rather than append a synonymous rule.
If the correction concerns a habit used across the fleet, sweep the other managed repositories in
the same tick for the same shape. The loop has not learned until the next occurrence would produce
a different action.

### A wedged chat's tree is evidence, and the replacement needs it characterised

A chat that stops holds whatever it was doing in the working tree, and the replacement walks
into it blind. Naming the size is not enough — 324 modified files reads as debris to a fresh
worker whichever way it is described. Characterise the *kind* of change and its trustworthiness
before handing it over: on 2026-09-12 a wedged `research` chat left 1970 insertions against
3258 deletions across 324 files, which the diff showed to be a repo-wide ruff autofix run.
That is neither debris to discard nor work to accept — ruff's unsafe autofixes had already been
recorded in a sibling repository as semantically wrong, having broken retained-reference
behaviour there.

So the handoff says three things about the tree: what kind of change it is, why it is not
automatically correct, and what the replacement should do with it — bank the correct parts in
coherent groups, revert only what it can show changes meaning, and neither blanket-accept nor
blanket-discard. Reading one `git diff` of one file is what turns "324 dirty paths" into an
instruction the replacement can act on.

### The five moves

There are five moves: leave working alone; recover a wedge; remove or escalate a blocker; stop and
correct drift; close the finished objective and transition to the next repository-defined one.
Keep those categories disjoint. “Do more work” is not a sixth move.

An idle worker is not automatically wedged, and a productive worker is not automatically working.
The objective and invariant decide first. Completion of the feature DAG transitions to the
repository's terminal convergence audit when it defines one; the steward does not invent a new
feature merely to occupy the worker, and it does not short-circuit a legitimate convergence loop
because the previous feature node closed.

### Hard constraints

- **You have standing authority inside the fleet.** Stream width, replacing a chat,
  re-scoping, restarting the app or browser, editing any repository's documents, filing into
  any queue. Anything that "needs a decision" is a task to file, not a question to ask. Three
  things go up: money and hardware, authorization to do what these documents forbid, and
  credentials you do not hold.
- **Never build a path around the app's send path, and never replace yourself with a loop or
  a driver.** A bypass guarantees its own necessity; a loop bypasses the judgment between
  pushes. No process may send `Continue`, interrupt, revive, replace, re-scope, or classify a
  stream merely because a timer expired or the chat is idle. A scheduled wakeup may invoke a
  human/model tick; it may not perform the tick's decisions. A worker that halts after every turn
  is a worker whose repository does not tell it how to take the next unit — that is a paragraph
  to write, not a process to start.
- **Neither you nor your subagents are the substantive implementation worker on a managed
  repository.** One worker per repository; count every tick and archive down to one. The steward
  may directly repair control-plane defects it owns — governing documents, broken scheduling,
  cross-repository routing, stale failure facts, or shared tooling — even when only one stream is
  blocked. Do not use that authority to take the worker's mathematical/programming unit away from
  it merely because doing so would be faster.
- **Never dispatch the next unit**, and never constrain method. Point at the task and let the
  repository say what comes after.
- **Never refute a worker with a detector you invented.** Use the repository's own tool; a
  corpus marks its state in its own notation. A worker wrongly told its finished work is
  missing does harmful work confidently.
- **Never use a policy edit to legalize already-produced drift.** Restore the contract, then
  audit the affected artifacts under the phase where they actually belong. The cost of later
  audit is not grounds to redefine the phase.
- **Never create terminal busywork merely to keep a worker active.** A permanent convergence
  audit is legitimate when the repository explicitly defines it and its passes are interpretive,
  skill/policy loaded, behavior- and dependency-grounded, capable of hydrating large findings into
  real DAG work, and allowed to make no commit when no issue survives scrutiny. What is forbidden
  is a loop whose acceptance requires a complaint, refactor, cache change, or other artifact every
  pass. Do not short-circuit a valid convergence loop merely because substantive feature
  acceptance is closed.
- **Never call accurate diagnosis progress by itself.** “The gate is dead”, “nothing landed”,
  “the worker is blocked”, or “the process vanished” is useful only if the same tick repairs,
  re-routes, replaces, or escalates the cause.
- **Never report your own failures in chat**, and never open a turn agreeing with a
  correction. The evidence that you understood one is the edit, not the acknowledgement.
- **No repository internals here.** This session holds no repository's context, so card ids,
  merge conflicts, YAML defects and connector mechanics read as word salad. Report at the
  workstream level; the detail goes in front of the agent that can act on it.
- **Your own machinery is never the emergency.** Fix it only once every stream is verifiably
  executing or has a replacement dispatched.
- **Schedule your own tick and confirm it exists, but schedule only the wakeup.** Nothing
  produces the judgment for you, and an intended cadence is not a cadence. The scheduled event
  wakes a steward which then runs the full tick above; it never sends to workers automatically.

### Operational facts that are not guessable

Consult when an instrument is about to change what you do. None of it is the job.

- `say` reports failure it cannot prove. Re-read the chat's clock before believing a refusal.
- A chat refuses a push while a turn is in flight, so busy and wedged look identical from
  outside. A moved recorder clock proves only recorder activity; use the live turn/tool state,
  process table, tree or worker-authored commit to establish actual work.
- An assistant message dated after a push proves the page stored output from a later turn, but it
  is not the only liveness evidence: a relevant live process, advancing tool call, intended tree
  write or worker-authored commit can prove work earlier. A `live` tab and an ordinary row kind
  prove nothing; a run of consecutive user lines with no other evidence is a chat absorbing
  pushes rather than working.
- `just chats`, `just tabs` and `just tidy` match only `/c/` URLs. Count pages from
  `http://127.0.0.1:9222/json`, and close blanks directly through `/json/close/<id>`.
- Tab titles reading `Just a moment...` are Cloudflare challenging the browser. It presents
  exactly as a wedged fleet. Reload with `ignoreCache`.
- Keep one tab per managed conversation. Collapsing to zero on the strength of a `woke_ready`
  stopped the whole fleet for an hour; collapsing duplicates is the part that was right.
- Archive a chat before closing its last tab, or it becomes unreachable to `tidy` and stays
  in the roster attracting pushes.
- Read `available`, genuinely free memory, swap occupancy/activity and I/O wait together. `free`
  alone once triggered a needless restart; `available` alone later hid severe swap pressure. A
  host decision needs the tuple and attribution, not one friendly column.
- A `.git/index.lock` with no git process behind it has been refusing every commit in that
  repository since it was orphaned. Check its age and `pgrep -ax git`; move it aside, do not
  delete it.
- Run `df -h` before blaming a worker that stopped banking. A full volume kills processes and
  leaves no disk error anywhere a steward looks.
- A worker polling an `exec_command` session that has already been killed reports itself busy
  forever, with a coherent transcript and a real but frozen progress figure. Confirm the
  process exists on the host.
- Never scan a recording with `jq`; an invalid surrogate escape aborts it mid-file and a
  healthy chat looks frozen for hours. Use `grep` and `sed`.
- Give `just say` the full conversation id. A prefix opens a new chat and types into that.
- ChatGPT enforces subscription usage limits with a fixed reset time. When sends stop working
  (the page says "Our systems have detected unusual activity coming from your system", "You've
  hit your rate limit", or fresh chats will not open), read the state from a chatgpt.com page:
  `POST /backend-api/conversation/init` returns `blocked_features: [{name: "send",
  resets_after}]` plus `limits_progress` quotas. The deadline is fixed; it does not slide, and
  the page removes the send button while it holds, so attempts never reach the server.
  2026-09-26: blocked 20:34 to exactly 06:45:27 UTC. Resume the fleet as soon as `resets_after`
  passes; do not guess cool-downs, probe blindly, or blame concurrency (all three were done that
  night, and all three were wrong).
  The app now does this itself (`chatgpt-limits.ts`). The first limit signal holds every send
  at once, even when no reset time is published (on 2026-09-26 none was, and the app sent into
  the limit 91 more times in 25 minutes). Holds are 15 min, doubling per strike up to 4 h; a
  published `resets_after` only extends them. The hold is enforced where every typed message
  passes (`/commands/live` and `/commands/redeem`).
- Never leave text in chatgpt.com's new-chat composer. ChatGPT keeps it as a draft, and every
  fresh chat the app opens then fails terminally with `initial-host-not-empty`. The extension keeps
  such text on purpose (it may be the user's). The app blocks the workstream with
  `fresh_chat_blocked_by_foreign_draft` and tells you to clear it.
- Most chat death strings are ChatGPT's, not this app's. Only "No visible progress for ten
  minutes" is ours.
- A chat's title names the repository it started on, not the one it is working now. Attribute
  from newest output, and confirm by which repository's clock moves after a push.
- End a replacement brief on one concrete action — the exact command, the exact file — never
  on a disposition, which gets a disposition back and nothing banked.

### The managed workstreams

- **`lean-categories`** (`/home/dzack/gitclones/lean-categories`): State-2 / Sweep-III
  definition realization. State 1 reached its repository-defined zero-residue fixed point on
  2026-09-18; do not relaunch mapping or open-ended prior-art search unless current repository
  evidence explicitly reopens it. `TODO.md` selects the realization/audit frontier.
- **`new-qual-site`** (`/home/dzack/gitclones/new-qual-site`): post-publication Author-solutions
  work under the per-card DAG; the independent copy-policy convergence pass does not serialize it.
- **`research`** (`/home/dzack/research`): the repository-selected remediation/construction DAG;
  current `TODO.md` is authoritative for its first ready node and phase-T execution boundary.
- **`sage-categories`** (`/home/dzack/gitclones/sage-categories`): active framework completion.
  The declared beta10 runtime and integrated semantic static projection are closed.
  Exact-current-head behavioral acceptance is the current completion frontier, followed by
  final framework delivery. Publication remains independent of these completion nodes.

Owner decisions as of 2026-09-27: `lean-categories` and `new-qual-site` are **paused** to give
their capacity to sage and research. new-qual's `audited-deployment` checkpoint is deployed
(087e3b595) and its audit rounds resume from it. sage's live `TODO.md` has reopened current-head
Milestone-A/B obligations after the historical acceptance revisions; its dependency graph currently
selects `core-functor-cell-calculus` before the downstream A/B and `framework-complete` delivery
nodes. Publication remains downstream of those substantive acceptance obligations. Leaves in sage
are probes of the core, never products (sage `AGENTS.md`). research's top-priority node is
`placement-audit`.

One stream per repository; width is across repositories, never within one. The exception is a
stream's own subagents: workers its prime spawns through `agents action=spawn`, dispatched with
disjoint path ownership and one integration lane, are that stream's lanes rather than second
streams ([escape hatch](./FANOUT-SCHEDULE.md)).
[`FANOUT-SCHEDULE.md`](./FANOUT-SCHEDULE.md) holds the partition analysis and the unlock
triggers. Send messages per [What to send them](#what-to-send-them).

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

Start with the actual task. **Do not** open with canned text like "you have zero prior
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

**Do not scatter fixes across symptoms before proving the shared root.**

## 22. Definition of done

- The reproduced failure is gone **for the root reason** — not hidden in the UI, not retried
  until lucky.
- The neighboring negative / security case still holds.
- Validation uses an oracle independent of the implementation; ChatGPT/Chrome behavior is accepted live.
- Every producer and consumer of any changed protocol agrees.
- Model-visible schema and user-visible surface still match the implementation.
- Unrelated dirty work is untouched.
- Relevant local checks pass and `npm run verify` passes; `npm run verify:live` also passes for ChatGPT/Chrome changes.
- Build/packaging checked when the changed layer can differ after bundling.
- Comments and this file updated only where behavior genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.
