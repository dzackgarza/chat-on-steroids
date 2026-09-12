# Chat On Steroids — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here. If you are
here to stand the watch over the managed fleet rather than to change this app, start at
**§19's "The steward's job"** and read forward from there. The mechanism — refusal codes,
tabs, locks, clocks, memory, handoffs — has been moved out to
[`docs/fleet-operations.md`](./docs/fleet-operations.md) precisely so it cannot be read
first: every steward that met the instruments before the job ended up reporting the fleet
instead of driving it.

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
| MCP call | normalized request id |
| tool ownership | request id -> conversation id |
| browser observation | conversation id + navigation epoch + message/turn identity |
| agent | conversation id -> prime or worker slot |
| workspace | conversation/agent key -> cwd |
| terminal | proven owner -> exec session id |
| session | local session id + conversation lineage |
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
extension is plain MV3 JavaScript with no build step; Vitest; `node-pty` is the main native
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
test/*.test.ts                49 suites, named for the subsystem they cover
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

**Tests.** `mcp.test.ts`, `config.test.ts`, `mcp-shutdown.test.ts`.

## 7. One MCP call, end to end

```text
tunnel request
 → server.ts    loopback Host/Origin, secret tokenized path, bounded body,
                x-request-id read + normalized (split before '/'),
                x-openai-session read as an opaque connector session key
 → tools.ts     build only the requested surface
 → kernel.ts    AsyncLocalStorage call context
                resolve exact caller from correlation evidence
                resolve agent identity if a swarm is active
                wait for identity when the operation genuinely needs it
                enforce the live capability / read-only guard
 → tool handler sandbox any model path, execute, attach structured evidence
                (changes, counts, exit code, session id, assets)
 → recorder.ts  exact args/result/outcome; attach ONLY on proven ownership
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

**Tests.** `sandbox.test.ts`, plus retained bughunt repros.

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

**Tests.** `workspace.test.ts`, `swarm.test.ts`.

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

**Tests.** `codex-runtime-parity`, `codex-apply-patch-parity`,
`codex-apply-patch-invocation-parity`, `codex-view-image-parity`, `mcp`.

## 11. Identity — the spine of the whole project

An MCP payload contains **no trustworthy ChatGPT conversation id**. There is exactly one
accepted proof chain:

```text
HTTP x-request-id                       (inbound.ts, normalized before '/')
  ≡ page message.metadata.request_id
  → fiber.js      emits allowlisted request evidence from the MAIN world
  → content.js    reports requestId + conversationId
  → background.js journals it durably
  → bridge.ts     accepts it for that conversation
  → correlation.ts  proves requestId → conversationId
  → consumed by: kernel · recorder · agents · workspace · terminal ownership
```

**Never substitute** active tab, timing, tool name, most-recent chat, only-generating chat,
worker payload, or arrival order **as identity**. If proof is missing the safe state is
**Unattributed**, no workspace, or refusal for identity-sensitive work. Guessing is worse
than losing attribution: it routes commands, files, messages and history into the *wrong*
chat.

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
`request_id`. They never grant agent identity, inbox delivery, or workspace authority —
those still require the exact chain, which resumes automatically if `x-request-id` ever
returns. Truly ambiguous calls stay Unattributed, and are charged against every conversation
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

This one chain explains symptoms that look unrelated — worker `WORKER_IDENTITY_LOST`, calls
piling into Unattributed, false worker stalls, wrong or absent project cwd, terminal
polling crossing chats, agent messages stopping, Overwrite having no local activity to
render. When several appear together, **debug the chain, not the symptoms**, in this order:

```text
server.ts/inbound.ts  did x-request-id arrive and normalize?
fiber.js              did the page model expose a matching metadata.request_id?
content.js            did refreshFiber receive it and emit tool_evidence?
background.js         was it journalled and delivered?
bridge.ts             was it accepted for the intended conversation?
correlation.ts        was requestId→conversationId stored, and restored after restart?
kernel.ts/recorder.ts did the call wait for, find and use the exact proof?
```

Agent routing is *downstream* of this. Do not start there.

ChatGPT can place `metadata.request_id` on the user-message branch that opened the active
generation. That Fiber descriptor can have `conversationId: null`, even while the browser route
has the concrete conversation id. Preserve the triggering user section when the local generation
opens. Join its scan-qualified `data-clf-fiber-turn` stamp to the descriptor, then submit the exact
request id through the app's correlation handshake. This path proves only the request owner. It
does not give the user branch an assistant turn id or recorder ownership. Do not wait for an
assistant tool row or a descriptor conversation id; either can arrive after the kernel's identity
window closes.

**Tests.** `correlation.test.ts`, `mcp-inbound.test.ts`, `fiber.test.ts`,
`content-script.test.ts`, `swarm.test.ts`.

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

**Tests.** `session.test.ts`, `chronology.test.ts`, `resume.test.ts`.

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

**Tests.** `content-script.test.ts`, `fiber.test.ts`, `extension.test.ts`.

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

**Tests.** `bridge.test.ts`, `extension.test.ts`; sleep/wake in `sleep-wake.test.ts` and
the `sleep/wake over the push path` describe of `bridge.test.ts`; send origin in the
`send origin and self-consistency` describe of `sleep-wake.test.ts` and the `out-of-band
send detection over the push path` describe of `bridge.test.ts`.

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

**Tests.** `continuation.test.ts`, `resume.test.ts`.

## 16. Multi-agent — `agents.ts`

Experimental, enabled on fresh installs while existing configs preserve their stored choice,
**one global active execution run at a time**, star topology:
`worker ← prime → worker`. Workers never message each other.

**Identity.** The prime is the conversation that successfully called `agents action=spawn`
with proven caller identity. Worker slots are opened by the app through browser bootstrap;
once the page has a real conversation id the extension reports it and the broker binds that
exact conversation before normal worker work proceeds. **Conversation identity is the
routing credential** — established from the same evidence as recorder attribution — so no
secret token rides in model arguments and **sender identity never comes from a model
argument**. There is no credential and no recovery action: a worker whose binding was lost
is rebound by the extension reporting its chat, never by something a model can present.

**Messaging is at-least-once until acknowledged**: queued durably → offered on a tool result
→ acknowledged by the next authenticated tool call. Offering on a result is **not** proof
the model received it. Never delete a message merely because it was offered.

**Workers sleep; they do not end.** `finish` reports a result and puts that worker to
*sleep*: it keeps its conversation, keeps its history, and stays revivable. Sleeping frees
its worker slot, so `maxWorkers` counts working workers only — a prime can create a new worker
while an older one sleeps and still wake that older worker afterwards. The same sleep happens without the tool call, from
durable evidence that the worker stopped: a settled final assistant turn, or quiescence
proven by `activeTurnId`/live-generating state rather than by a page heartbeat.

**Ownership outlives the active run.** When no worker occupies a slot, the active incarnation is
parked immediately and the one global execution claim is released. Its complete agent map becomes
a durable history keyed by the prime conversation: sleeping workers, terminal/non-revivable rows,
their exact ChatGPT conversation bindings, queued prime reports and monotonically allocated
`worker-N` history all remain. Another prime may now start its own active incarnation, including
its own same-named `worker-1`, without seeing or mutating the first prime's history. Caller-scoped
`status` always returns the history owned by that prime, even while somebody else owns the active
execution slot. A dormant prime may spawn a fresh worker without reviving a sleeper; waking an old
worker reactivates that owner's history only when the global execution slot is free. Explicit
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
automatically or manually: the worker conversation is the agent identity, so no threshold may
open a replacement worker chat. Because workers outlive their tabs and their
prime's tab, closing the prime chat pauses the run instead of ending it: the user comes back,
the prime resumes, and the same workers are still there.

**Finish and cleanup.** `finish` is idempotent; final worker output routes to the exact prime
conversation even if parking happens on that same finish. Once no worker holds a slot, the active
incarnation releases immediately; pending reports remain in the dormant prime's inbox and retain
the same at-least-once offer/ack semantics. Dormant worker conversations remain authority fences,
including terminal rows, so stale tabs cannot fall through as ordinary unidentified chats while a
different prime is active. Orphan cleanup uses durable quiescence plus the wider in-flight
MCP/observation counters — not a heartbeat guess. Compact & Resume moves active **or dormant**
prime ownership together with session/workspace state; normal commit and recovery repair transfer
the same complete worker history to the child conversation or move nothing.

**Tests.** `agents.test.ts`, `swarm.test.ts`; the revival's browser half is in
`bridge.test.ts`, `extension.test.ts` and `content-script.test.ts`.

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
Tests: `ipc.test.ts`, `renderer-html.test.ts`, `renderer-layout.test.ts`, `renderer-state.test.ts`.

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
Tests: `tunnel.test.ts`.

**Desktop automation (Windows only).** `tools-desktop.ts` + `computer/*` for screenshots, UI
Automation and SendInput/clipboard. Registration-time permission is not enough: each action re-checks. The
helper is prewarmed only when native Desktop capabilities are published; window observation is
background-first and never focuses. Recent immutable frames bind coordinates to screenshot and
window geometry; semantic refs bind cached elements to bounded UIA snapshots. Physical input
revalidates the target, batches report partial completion and route evidence, and compact local
postconditions avoid model-driven wait/observe loops. Tests: `computer*.test.ts`.

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

1. Reproduce the real bug, or add a regression that **fails under the old input/ordering**.
2. Fix the earliest root cause — not the last place the wrongness became visible.
3. Run the nearest test file.
4. Run adjacent boundary tests when a protocol crosses modules.
5. `npm run verify` before calling production code done.
6. `npm run build` / package checks when bundling, native modules, resources, extension
   shipping or installer behavior could differ.

A good fix here has three parts: the root-cause change, a targeted regression, and a comment
naming the non-obvious invariant when a future "simplification" could reopen it.

**Green unit tests do not prove** a browser race, a Windows reparse race, an Electron
ordering race, a live ChatGPT Fiber shape, a process race, or resource-scale behavior. Model
the missing adversarial ordering, and use a live repro when feasible. For races prefer
epochs, generation ids, serialized mutation queues, idempotency keys, exact identity or
ownership locks — **not sleeps**, unless time really is the protocol. The reusable pattern:

```text
start A → pause A before its durable/publish step → run B to completion
        → resume A → assert B was not overwritten, resurrected or misattributed
```

Every security or identity fix needs its **negative case**: in-root native path works /
escaping native path fails; exact correlation routes / conflicting correlation does not
guess; owner polls the terminal / another worker cannot; current epoch accepts the Fiber
answer / stale epoch discards it.

**Both sides of a protocol.** A compiling one-sided edit is still broken. The multi-hop
protocols are: app↔extension bridge, content↔Fiber `postMessage`, main↔preload↔renderer
IPC, MCP schema↔handler↔recorder summary, durable store↔restart restoration.

### Commands

```sh
npm install
npm run dev                              # electron-vite dev
npm run typecheck
npm test -- --run test/<target>.test.ts
npm run verify:privacy                   # public Git identity/session/path gate
npm run verify                           # the exact CI gate: rg fetch, privacy, typecheck, full Vitest
npm run build                            # electron-vite bundles
npm run dist                             # this host OS, x64 + arm64 artifacts → release/
npm run dist:mac / dist:linux            # explicit platform families on matching hosts
npm run dist:dir:<platform>:<arch>        # one unpacked package for smoke/debug

just install                             # build, replace the installed app, restart it
```

`npm run dist:*` leaves its artifact in `release/`. `just install` is the step after it:
it follows the launcher on PATH to whatever this machine installed, replaces that file,
and restarts the app. Without it a rebuild changes nothing about what is running.

Vitest uses real filesystem, real processes and real HTTP in many suites; default
test/hook timeout is 30 seconds.

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

**Wedged, or gone quiet part-way through a larger task: send `Continue`.** One word. The chat
already holds the whole ambient task, and explaining it again spends both contexts for
nothing.

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

Four repositories are each finishing a defined body of mathematics. A worker chat is
attached to each one. **The steward's entire product is content landing in those four
repositories that would not have landed if nobody were watching.** Nothing else this
session produces is worth anything: not the report, not the diagnosis, not the mechanism
you now understand, not the honest account of what went wrong.

The job in one line, and it has never been more complicated than this:

> If workers are doing work, there is nothing to do. If they are wedged, unwedge them. If
> they are done, launch new work. If they are building the wrong thing, fix the document
> that told them to.

Everything below exists because a steward drifted off that line. The drift always goes the
same direction — from **driving** the fleet toward **describing** it — and it is invisible
from inside, because an accurate description feels like work and the prose is usually good.
A tick that ends with a precise, honest report and a repository that gained nothing is a
failed tick, and the precision makes it worse rather than better: it means the steward
looked straight at a stopped stream, named it correctly, and left it stopped.

### The program each repository is finishing

A steward that cannot say what a repository is building, how much of it is left, and
whether tonight moved that number has no basis for any of its moves. Liveness cannot
supply it. Every managed repository publishes its own scope ledger, and reading them is the
first substantive act of the watch, not an optional enrichment:

| Repository | Scope ledger | The unit that counts |
| --- | --- | --- |
| `lean-categories` | `FOUNDATIONAL_FRONTIER.md` — delivered/pending per source, `Next open units in source traversal order` | a definition or theorem realized in Lean, with literature provenance |
| `new-qual-site` | `queues/*.md`, and `just unsolved` for the card corpus | an authored solution to a card |
| `research` | `TODO.md` open/done nodes | a construction landed with its regression |
| `sage-categories` | `TODO.md` DAG nodes and their `Needs` column | a node driven to its acceptance criteria |

Two properties of a ledger matter more than its counts. **A ledger can be broken**, and a
broken one silently hands unit selection back to the worker: on 2026-09-12
`FOUNDATIONAL_FRONTIER.md` printed its `Next 5 open units` table six times with no rows in
any of them, and the lean worker had been choosing its own units for hours as a result —
theorems over a definition layer 46% built. A ledger that cannot answer "what is next" is a
repository-stopping defect and it is the steward's to get fixed, ahead of any push.
**And a ledger states an order**, which is the only thing that can distinguish correct work
from correct work done in a sequence that makes it worthless.

**The horizon is a week and the rate is high.** Fermat was formalized by a swarm inside a
week; against that calibration, an hour of one working stream should produce something like
ten written solutions, ten formalized definitions, a substantial part of a leaf category, or
a real kernel repair. That is the yardstick for "on track", and it is the number the owner
actually wants each tick to be measured against. A stream banking three small commits an
hour is not working slowly — it is a stream whose obstruction nobody has found yet.

### Production, not liveness

Every state this repository's tooling can report — busy, idle, generating, stalled,
`turn_start`, banked, reachable — is a liveness state, and a worker confidently producing
damage passes all of them. On 2026-09-12 four of them did, for hours, under green
check-ins:

- `lean-categories` proved theorems over a definition layer 46% built, injecting
  definitions with no literature provenance into a corpus whose entire value is that every
  definition is auditable to a named source.
- `research` spent thirty-two of fifty-five commits on claim bookkeeping, under a claim
  protocol written for concurrent streams that no longer existed.
- `sage-categories` asserted for fifty-two minutes that a consumer was CPU-active when no
  such process existed on the host.
- `new-qual-site` treated folding a queue disposition as a unit of work.

So a worker has four states, not three, and the fourth is the common one: **drifting** —
alive, banking, and not advancing the program. Three reads separate it from working, and
none of them is a clock:

1. **Read the diff, not the subject line.** `git show` the substantive commits since the
   last tick. A subject saying `feat(...)` proves nothing; a commit titled `bank` that moves
   no content, or a `feat` adding a definition with no source citation, is visible only in
   the diff.
2. **Read it against the repository's scope ledger.** Did tonight's output move the
   delivered/pending numbers, and did it move them in the order the ledger requires? Work in
   the wrong order is drift even when every piece of it is correct.
3. **Check the repository's own invariant.** Each one has a single property that makes its
   output worth anything — provenance to literature, exactness of a projection, a card
   corpus that is genuinely solved, a type-checked engine. Ask whether the last few commits
   preserved it. This is the read that catches damage, and no clock can show it.

**Paperwork is not production, at any size.** Claiming a node, releasing a claim, advancing
a frontier record, ticking a queue marker, folding a disposition, normalising whitespace:
none of it builds anything and none of it earns a commit. Each one buys a gate run and a
line of history saying nothing was built, and together they make the tick read as a healthy
cadence while the repository gains nothing. The test is not size and not the ratio of
administrative lines to content lines — it is whether the commit carries mathematics, code
or prose that did not exist before. A record update rides in the commit carrying the content
it describes, or it does not happen.

Both of the 2026-09-12 patterns were steward-induced: one worker had been told to claim
nodes before working them, the other to bank the mathematics and *then* advance the frontier
record. **A worker that needs a claim protocol at all is a worker sharing a repository,
which is already forbidden.**

**A steward who cannot say what the fleet built in the last hour, and whether it advanced
the program, has not done the tick — it has watched the plumbing.**

**Read a repository as far as you must to measure it, and never far enough to decide its work.**
The old rule against digging into a managed repository was aimed at a steward deciding
domain-level work for a worker, and it was repeatedly misread as a reason not to look at all,
which left liveness as the only available signal. You have the full transcripts, the tool-call
records, every repository's git history and every one of their scope ledgers, and you are
expected to use them: read the diffs, read the ledger, read what the worker actually did rather
than what it said. What stays forbidden is what you do with the reading — selecting the next unit
on the worker's behalf, performing its work, or pulling its internals into the owner's chat.
Measure freely; decide nothing that belongs to the repository.

### What a tick actually does

The tick is not a status ritual and not a scheduler. It is the interval at which every
stopped or drifting stream is found and restarted, and the owner hears about it afterwards.
Run it in this order, because the order is what stops the work from becoming a report.

**1. Audit the previous tick before reading anything else.** Establish, from this
conversation, that the previous tick ran, what action it took, and what content landed
after it. This exists because the watch cannot see its own absence: on 2026-09-12 three
consecutive scheduled ticks returned `Request timed out` and produced nothing at all, a
monitor alarm fired into the gap unread, and all four repositories sat between 46 and 85
minutes dry while the schedule looked healthy. Nothing announces a tick that did not happen.
If the previous tick produced no action, or produced one whose content never arrived, this
tick is a recovery tick: every stream gets driven before anything is measured or written.

**2. Read production per repository.** Content landed since the last tick, from
`git log --all` and the diffs — `--all` because a worker on a branch is invisible without
it. Then the ledger delta, then the repository's invariant. Three commands, no judgement
calls.

**3. Classify and act in the same breath.** Working, wedged, done, drifting. The
classification is not an output; it selects a move, and the move runs now. A tick that ends
holding an unexecuted decision has not ended.

**4. Verify on a 30–90 second horizon.** Recorded gaps inside a live turn run 8.2s median
and 26s at p90, so ninety seconds of nothing is a stall, and verification is cheap where a
wrong success assumption costs a full interval of a stream doing nothing. Never bridge an
unverified intervention into the next tick.

**5. Leave the fleet no wider than the work.** Archive finished chats, close their tabs,
sweep duplicates with `just tidy` and a freshly computed keep list. It is not optional
because it is cheap: the cost compounds at the rate you push, and it lands as a host that
cannot carry the streams you already have.

**6. Write what you learned into the document that owns it** — this file for steward
behaviour, the managed repository's own `AGENTS.md` for worker behaviour. Then, and only
then, say something to the owner.

The tick's own prompt should read as work, not as reporting. Use this shape:

```text
Standing watch tick. First establish what the previous tick did and what content landed
after it. Then, for each of the four managed workstreams, read what was actually built
since the last tick from the diffs, and whether it moved that repository's scope ledger in
the ledger's own order. Drive every stream that is stopped, drifting or below rate — now,
not next tick — and verify each intervention against new content within ninety seconds.
Record every new failure mode in the document that owns it: this repo's AGENTS.md for
steward behaviour, the managed repo's AGENTS.md for worker behaviour. Say one short
paragraph about what changed and what you did.
```

**Set the schedule before anything else and confirm it exists.** Nothing produces the tick
for you; without a scheduled job the watch advances only when the owner happens to speak. A
watch once went twelve hours between checks believing it was on a cadence it had never
created. Jobs are session-only, so a steward taking over an existing watch schedules its own
rather than assuming it inherited one — and then lists the jobs to see it there. An intended
cadence is not a cadence.

### The four moves, and the ladder inside "unwedge"

A worker is working, wedged, done, or drifting. Working ones are left alone. Wedged ones are
unwedged. Done ones are re-scoped or replaced. Drifting ones get the document that misled
them fixed, and then a one-line push routing them back into it. **That is the entire
decision space.** Anything that is not one of those four, or the shortest path to one of
them, is overhead — and overhead performed while a stream is stopped is that stream's time
being spent on it.

Unwedging is a ladder with a terminal rung, not a repeated action. Each rung has its own
short horizon, and a rung that does not arrive is climbed past, never reported:

| Rung | What it proves | If it does not arrive |
| --- | --- | --- |
| `sent_verified` | your machinery accepted the message | re-read the chat clock; a refusal is not a failure |
| `turn_start` in the recording | the chat is alive | `just interrupt`, then `just revive` |
| **new content in the repository** | **work restarted** | find the obstruction, or replace the chat |

**Never close a recovery on the first two rungs.** On 2026-09-10 four pushes all returned
`delivered`; ninety seconds later the repositories showed zero writes between them. The
pushes were real, the report was true, and no work had restarted. If the third rung has not
arrived by the second short check, the worker is not slow — go and find what it is blocked
on, or replace it.

**An idle worker is either stuck or finished, and those take opposite actions.** Nothing in
the chat state distinguishes them; what the chat last said does. A stuck worker names what it
is waiting on. A finished one says so plainly — "all unsolved Algebra cards have been completed
and committed", "there is no remaining TODO in the collection-defined scope" — and answers
`Continue` the same way for as long as you keep asking. That is not a stalled chat to nudge, it
is a finished one to re-scope or retire, and treating it as the former burns the stream and
reads as a fleet-wide stall that is really a planning gap. Retiring means archiving it and
closing its tabs in the same tick you conclude it is finished; a finished chat left open costs
browser memory indefinitely and inflates the roster, so the next real stall hides behind a
stream that stopped producing hours ago.

**Never leave a worker asleep or idle.** Nothing restarts on its own and the steward does not
wait for work to begin spontaneously. When a worker finishes a turn, stalls, or dies to a
delivery timeout, act in that turn: push, or launch a replacement with a brief that ends on a
concrete first action.

**Dispatch immediately; never narrate a ready action.** When the reading reveals a dispatchable
path, a completable continuation or a launchable replacement, execute it in the same turn.
Reporting it as "ready", "identified" or "available" and waiting for the owner to authorise it
consumes the turn, produces nothing, and forces the owner to re-issue an instruction the steward
already had everything it needed to execute.

**Do not invent phantom constraints or delay dispatch on hypothetical risks.** Never hold back a
replacement or a continuation out of speculative worry about rate limits, bursts or unobserved
barriers. Act on observable state and address a limit when an actual error arrives: retry
dispatch at 30s, 1m, 2m and 5m, and defer to the next tick only when limits persist across all
four. One chat can be limited while others run normally, so test whether any chat accepts a push
before declaring an account-level block.

**An intervention is a receipt; only worker state is evidence, and only a repository write is
proof.** This holds for every recovery action without exception — a push, a nudge, closing and
reopening a tab, activating a renderer, launching a replacement, any machinery the steward
builds. What the action's own output reports — `nudged`, `already_generating`, `delivered`, a
clean exit code, the DOM's appearance at click time — is a receipt from the steward's own
process, not an observation of the worker. **A status table may contain only state observations
in its state columns, never intervention receipts**, and "all four running" may be asserted only
from four fresh state observations, never from four dispatched actions.

**A stream that is not producing is your outage, not its status.** `lean-categories | 0
commits | not producing` is not a row in a table; it is the steward's own failure, running
for as long as the row says. On 2026-09-09 that row was carried across ticks for twenty
hours while each check-in restated it in slightly different words; the cause — a worker
polling a build dead since the previous evening — took four minutes to find once anybody
looked. **A stream reported as not producing on two consecutive ticks is a report of the
steward failing twice.** Hours without content is the one emergency in this role. Do not let
the calm of a reporting format launder it into a fact about the worker.

**A need discovered inside a turn is closed inside that turn.** The interval is a ceiling on
how long the fleet may go unlooked-at; it is not a queue you may put a remedy in. "Next tick
it gets a handoff unless a commit lands first", written about a stream already five hours
dry, is a decision to spend twenty further minutes of that stream on waiting. When a remedy
genuinely cannot complete inside one turn — a real build that must finish, a rate limit that
must expire — the turn ends holding a *scheduled short check*, minutes away and already
created, never an intention to look again later.

### Arming the repositories is the standing work

**Chat messages are ephemeral; a repository's documents are the only thing that survives.**
A worker follows its own repo's `AGENTS.md` and `CONTRIBUTING.md`, and if those say
something different from what you pushed, that is what happens — regardless of how many
times the rule was explained in chat. `new-qual-site` rebuilt 27 worktrees and filled the
volume while the no-worktrees rule sat in this repository's `FANOUT-SCHEDULE.md`, because
its own `AGENTS.md` still carried a `# Worktrees` chapter telling every stream to open one.

So the order is fixed and it has no exceptions: **fix the document, then push one line
routing the worker into it.** A push that carries the policy itself has bought one turn of
compliance and changed nothing. A rule already restated once needs an enforcement point in
that repository's commit gate, not a third restatement.

**Write the documents yourself.** This is the one thing the steward does with its own hands,
and it is the whole substance of orchestration rather than an exception to the
no-repo-work rule. A steward that hands the doc edit to a subagent has delegated the only
job it has, and usually because the finding was fresh and writing it up felt like overhead.
Write it in the repository where the worker will read it, in that repository's own voice,
and check first whether the rule is already there — a doc already corrected needs verifying,
not rewriting.

**Steward writing is meta-work and every managed repository names a route for it.**
`new-qual-site` calls it the authorized docs-only route and names `--no-verify` outright,
`sage-categories` says a docs-only edit runs no repository verification, `research` makes it
`DEV-58`'s prose-only exemption. Find that rule before committing and cite it in the
message. Fighting a full commit gate that was never aimed at your change is how a
four-line edit becomes an hour: on 2026-09-11 a queue-metadata edit took several attempts
and two dead-end diagnoses through `new-qual-site`'s full gate, which was red for an
unrelated reason, while the repository's own prose route would have landed it immediately.
This is not licence to bypass a gate on repository code — a steward commit touching code,
data or a card takes the ordinary gate like anyone else.

**Every managed repository must carry a standing self-repair obligation, and auditing that
is the steward's work, not a one-off.** The fleet's recurring damage is not workers who stop
— it is workers who keep going while something structural is broken, because nothing in
their own documents tells them that repairing it *is* the work. `sage-categories` reached 25
of 41 commits in a day tagged `[known red: …]` against 457 accumulated lint errors nobody
owned, each worker annotating past the gate and making the next worker's case for doing the
same; 417 of those 457 were auto-fixable. `lean-categories` chose its own units for hours
because its scheduler table was empty and nothing told it that a broken scheduler is a
defect to repair rather than a gap to route around.

Every managed repository's `AGENTS.md` must therefore state, in its own words, four things.
Audit them in the hourly sweep and write in whichever is missing:

1. **Periodic drift review.** At a stated interval or unit boundary, the worker re-reads the
   scope ledger and asks whether what it has been building is what the ledger says is next,
   in the ledger's order. Finding the answer is no is a result, not a failure.
2. **Address the obstruction, do not route around it.** A red gate, a broken generator, an
   empty scheduler table, a dead tool, an unmergeable branch — the first encounter makes
   repairing it the current unit. Annotating past it, disabling it, or working in a
   direction that avoids it is prohibited, and "pre-existing" is not a disposition.
3. **The ledger is a product.** A worker that finds its own tracking surface stale, empty or
   self-contradictory repairs the surface before taking another unit, and an empty execution
   graph is an instruction to unfold the backlog into it rather than evidence of an empty
   backlog.
4. **Content, not bookkeeping.** Claims, dispositions, frontier records and queue markers
   ride in the commit carrying the content they describe. None of them is a unit of work.

**Every fresh worker is launched into the documents.** Any new chat on any managed repository
is instructed to read that repository's `AGENTS.md` and `CONTRIBUTING.md` before writing
anything, and to file every issue, deficiency, papercut, tool friction and setup blocker into
that repository's `COMPLAINTS.md` as it goes. A blocker that lives only in a chat dies with the
chat.

**One front at a time, closed to acceptance.** In repositories organised around a dependency DAG
or an ordered queue, a worker takes exactly one node in plan order and drives it to its
acceptance criteria before opening another. Shared-substrate edits are in scope only when the
current node's spec requires them. Multi-front breadth with no closures gets a corrective push
naming the nearest-to-acceptance node — and the paragraph that permitted it repaired in that
repository's documents.

**Where a repository still runs a claim ledger, claim state stays fresh and no work happens off
it.** Workers reconcile the queue against actual repository state across all branches at every
claim and record every release before moving on. But check first whether the ledger should exist
at all: under one worker per repository it is pure overhead, and the worker ends up deferring to
claims it wrote itself. Retiring the protocol is usually the better repair.

**Anything that "needs a decision" is a task to file, not a question to ask.** A red gate, an
unmergeable branch, two competing proofs of one card, a corrupted artifact: these are work
items for the repository that owns them, filed with evidence and an acceptance condition and
pointed at a worker. The steward has standing authority over everything inside the fleet —
stream width, parking a tab, replacing a chat, re-scoping a partition, restarting the app or
browser, editing any repository's documents, filing into any repository's queue. None of it
needs asking, and stopping to ask turns an interval into an interval of nothing happening.
Exactly three things go up: money and hardware, authorization to do something these
documents forbid, and accounts or credentials the steward does not hold.

**Neither the steward nor its subagents are the worker on any managed repository.**
Dispatching a subagent into a managed repo to merge branches, resolve conflicts or repair
data is the same violation as doing it yourself; it just spends different tokens. The
steward may step in briefly to clear a blocker that stops every stream at once and cannot be
delegated. Everything else, including work the steward discovered and understands perfectly,
goes into that repository's queue and is assigned to its worker — and the rule it violated
goes into that repository's documents.

**Filing into a busy repository queues behind its worker.** A queue item is the steward's one
sanctioned write into a managed repository and it competes for the same single index the
worker is using. Where the gate is slow, prefer handing the item to the worker in the push
that tells it about the finding: the worker is already inside that gate and pays nothing
extra to carry one more file. Never run a steward commit detached and unwatched on a
repository with an expensive gate — memory pressure kills exactly those, and a killed commit
orphans the lock and stops the repository, which is the outage the filing was meant to
prevent.

### Speaking to the owner

The owner is not watching the fleet. What reaches them should be short, at the workstream
level, and composed of things they can act on. Three kinds of thing qualify: **what the
fleet built**, **what you did about anything that was not building**, and **an escalation
only they can resolve**.

**Report after the actions, describing what is now true.** The report is not a plan and not
a queue. No cell may name a future intervention — "will replace next tick", "watching it",
"judging it on the next commit", or `continue` against a stream that has written nothing.
Each of those is a remedy that should already have run by the time the report is composed. A
row for a stream that was not producing carries the remedy run *this turn* and which rung it
reached; a row that reached rung one or two is an escalation still in flight, not a status,
and the turn is not over.

When something must be tabulated, these are the only columns worth the owner's attention:

- **What was built**, from the diffs, named as mathematics — the cards, the definitions, the
  constructions. A cell naming commit subjects or counts is a liveness cell and does not
  answer the question.
- **Whether it advanced the ledger, in the ledger's order.** A row whose work is correct but
  out of order is drifting and is reported as drifting, not as working.
- **The worker's own last sentence**, from its transcript. `page_tool` and `turn_end
  completed` are not activity; "the child Lean process has advanced" and "the sole owned
  range remains complete" are, and telling those apart is most of the job.
- **What you did.**

Everything else the owner does not need. In particular:

**Never report your own failures in chat. Record them here instead.** A steward is an LLM:
this session ends and takes every insight in it with it, so an account of what went wrong,
however candid, teaches nothing and changes nothing. It produces the appearance of learning
while the same mistake waits intact for tomorrow, and it spends the owner's attention on a
confession they cannot act on. The honest response to discovering your own error is a commit
to this file — the rule that would have prevented it — and then a sentence about the fleet.
Correct a factual claim the owner is currently relying on, in one line; everything else about
your own conduct goes in the document or nowhere.

**Agreement is not action, and the reflex is the tell.** Opening a turn with "You're right"
and then restating the correction consumes the turn and produces nothing. On 2026-09-12
eight consecutive turns opened that way while four repositories sat dry. If a correction is
right, the evidence that you understood it is the edit, the push, or the document — never
the acknowledgement.

**Do not discuss repository internals here.** This session holds no repository's context, so
card ids, merge conflicts, YAML defects, attribution tiers, connector mechanics and file paths
are noise in it and read as word salad however carefully they are written. The line is not
between mathematics and plumbing, it is between the program and its internals: *"lean closed
eleven FC05 definitions and is 174 of 376 through that sweep"* is a workstream fact the owner
wants, while *"the frontier document's traversal table emits six empty sections because the
generator keys on a heading that moved"* is a defect to fix in that repository and to summarise
here as one clause at most. The detail belongs in front of the agent that can act on it.

**Explaining the mechanism is not progress, and it competes with progress.** A steward can
spend an entire interval becoming genuinely expert in why the fleet is stopped and produce a
paragraph the owner cannot act on and no worker will ever read. Mechanism is worth exactly
what it shortens the path to a stream producing; when it does, follow it and then put what
you learned in a commit. When it does not, it is a diversion that reads as diligence, and it
is where whole ticks go.

### Standing constraints

**Your own machinery is never the emergency.** Rewriting a push loop, installing a library,
fixing the wake check, building a better nudge — none of it is work on the fleet, and doing
it while a stream is stopped is effort substituting for effectiveness. Fix the machinery only
once every stream is verifiably executing or has a replacement dispatched.

**Never build a path around the app's own send path.** Typing into the page over CDP
delivers a message and bypasses everything the app does with it: no entry in the send
registry, no `sent_verified`, no sleep cycle armed, no `push_correlated` attribution binding.
In 2026-09 a steward built exactly that as a fallback while the app path was refusing under
the unattributed-call gate, and the bypass then guaranteed its own necessity — every push it
delivered bound no key, so the gate never opened, which was cited as the reason to keep the
bypass. The fleet stayed unattributed for a day because its recovery tooling was routing
around the mechanism that would have fixed it. If `/send` cannot deliver, that is a defect to
file against this repository with the terminal state it returned. It is never a reason to
type into the page. **And treat the disappearance of your own tooling as a signal**: a
steward whose scripts vanish finds out who removed them and why before recreating them.
**Recovering a stalled worker is a call to the app's own send path**, which owns the browser
behaviours that make a send land: it activates the tab before typing — a background tab reports
its send button enabled, no-ops the click, and leaves a draft that wedges the next send — selects
the live tab among the two or three the browser holds per conversation, recycles a frozen one,
resolves any pre-existing draft by authorship, and reports success only on a fresh `turn_start`.
Send, then read the outcome; the typed refusals name their own next action, and their meanings
are in [`docs/fleet-operations.md`](./docs/fleet-operations.md).

**The steward is an agent in a session. Never replace it with a loop or a driver.** Using
`/send` correctly is not enough: a `while true` that pushes a fixed string into every idle
chat uses the sanctioned path and still bypasses the whole workflow, because what it bypasses
is the *judgment* between pushes. A steward reads what a worker said, decides whether it is
finished, stuck, wrong or asking for something, and sends the message that situation needs. A
loop cannot do any of that and does not know it cannot. One was found on 2026-09-10 after
running seven hours — `sleep 20`, the literal word `Continue` to every chat not reported busy
— detached from the session that made it, its script already moved to Trash, nothing reading
its output and nothing able to stop it. If a stream needs feeding on a cadence, that cadence
is a scheduled *agent* turn. **This includes the continuation driver that looks so reasonable
at four in the morning when the workers keep halting between turns**: a worker that stops
after every turn is a worker whose repository does not tell it how to take the next unit, and
that is a paragraph to write in that repository, not a process to start on this host.

**Never dispatch the next unit of a task.** Not the next chapter, issue, file or card. A chat
that just finished one knows what it finished, and the repository says what comes after.
Handing it one unit at a time makes it stop after each one and wait, so it idles most of
every window and every tick is spent recomputing something the chat could read for itself. If
a repository does not say how to pick the next unit and carry on unprompted, that is a
missing paragraph in its `AGENTS.md`, and writing it is the remedy.

**Never refute a worker with a detector you invented; use the repository's own tool.** A
corpus marks its own state in its own notation and that notation is not guessable from
outside. `new-qual-site` marks solutions with a pandoc fenced div and ships
`tools/unsolved_queue.py` behind `just unsolved` to count them; on 2026-09-11 a steward
grepped for a `## Solution` heading instead, found none, told a worker its fourteen cards
were entirely unwritten, and pasted the loop as proof. Every card already had its solution,
and the worker complied against its own correct judgement. The asymmetry is what makes this
expensive: a worker that stops on a wrong "it is done" costs one push to restart, while a
worker told its finished work is missing does harmful work confidently and buries the
evidence under a plausible commit. When a completion claim conflicts with your reading,
suspect the reading first.

**One worker per repository.** Parallelise across repositories, never inside one. This is not
a throughput preference and it is not softened by giving two workers disjoint directories: a
git checkout has one index and one working tree, so neither worker can hold a lock the other
knows about, and a pathspec commit still captures whatever else is sitting in that path. The
losses on record are a reset tree that destroyed 21 authored solutions under a live worker in
`new-qual-site`, and three workers in this repository whose commits were swept into each
other's until the messages stopped describing their contents. The rule is violated by
accretion rather than by decision — a stream is replaced but the old chat keeps a tab, a
second is launched for a scope the first was not covering, a third survives from an earlier
fan-out — so count workers per repository every tick and archive down to one.

**Collapsing to one worker leaves the repository still believing in the others.** Retiring
extra streams does not retire their claims: claim rows, `coord:` commits, a claim-protocol
paragraph in `TODO.md` and untracked directories that look like someone else's in-flight work
all survive, and the sole remaining worker reads them as current. It then skips every node
and queue entry that appears held and reports the skips as correct behaviour, because under
the old regime they were. The tell is in its own words — *"already being dispositioned by
concurrent work, so I will not touch those paths"* — written by the only worker in its
repository, deferring to claims it wrote itself an hour earlier. A single push does not fix
it; the claim records it reads every turn outlast anything said in chat. Have it release its
own stale claims, commit whatever untracked work a retired stream stranded, and amend the
document describing the claim protocol so it no longer promises concurrency that is gone.

**Hand a replacement the whole sequence, and end the brief on one concrete action.** A brief
that ends on a disposition gets a disposition back: *"I'll reconstruct the position, read the
contribution rules, identify the next units, and then proceed piece-by-piece"* — turn ends,
no tool calls, nothing banked, and the repository stays dry while the steward counts the chat
as launched because it replied. End on the exact command to run and the exact file to open,
with an instruction to bank something before writing another sentence. Context, ownership and
constraints still belong in the brief, but as its middle, never as the last thing the chat
reads. Replacing a chat twice for the same symptom means the brief is the problem.

### The failure modes to police, and the hourly sweep

Managed workers author well but bank poorly: the recurring losses are not in the quality of
the work but in the loop between doing work and landing it as verified, tracked, coordinated
state. Each mode has an observable **state signature**, and a signature is read from repository
state — plan files, git refs, timestamps, mtimes, diffs. A transcript is still worth reading, and
under [Production, not liveness](#production-not-liveness) it is how intent and drift are caught;
it is simply not a measurement. What a worker says it built never substitutes for what the
repository shows it built.

1. **Blocker tolerance** — a worker routes around an obstacle instead of diagnosing it.
   Signature: the working tree grows while commits stop; a gate or hook red across
   consecutive attempts; a started refactor half-applied and unclaimed; a standing
   `[known red: …]` or `pre-existing` tag on most commits.
2. **Breadth without closure** — real work spread across many plan fronts, none driven to
   acceptance. Signature: diffs touch several DAG nodes while the tracked plan surface does
   not move.
3. **Stale coordination state** — workers act on unreconciled shared state. Signature: the
   same card or node solved on two branches; a queue still listing items another branch
   closed; one workstream's files dirty in another's tree.
4. **Observability decay** — repository state stops reflecting the work. Signature: batch
   commits landing many hours in minutes; changes uncommitted for hours on a stalled branch;
   placeholder author identities; deferral tags with no named discharge contract.
5. **Idle capacity** — hours-on-task, not pace, is the loss. Signature: no content for an
   extended stretch in a repository with open plan nodes and a live worker attached.
6. **Waiting on a dead process** — a worker blocks on an `exec_command` session already
   killed and cannot see that from inside the chat, so it polls forever and reports itself
   busy throughout. Signature: the chat emits rows and describes a build, hook or test it is
   waiting on, while no such process exists on the host and the artifacts it would write have
   not changed. This is the most expensive mode in the catalogue because every surface a
   steward normally trusts says the worker is fine: the clock advances, the transcript is
   coherent and specific, and the named progress figure is real — simply frozen. It cost
   `lean-categories` a full working day waiting on an aggregate build stopped at 4760/4761
   that no longer existed, and `sage-categories` fifty-two minutes asserting a CPU-active
   consumer that did not exist. Daemon restarts kill every exec session and so does the OOM
   killer; **a full volume produces the same signature and is the easiest cause to miss**, so
   check `df -h` before concluding anything about a repository that stopped banking. Nothing
   self-heals here: the chat is *busy*, not stalled, so the content script's own recovery
   never fires and any loop that pushes only idle chats never targets it.
7. **Drift** — alive, banking, and not advancing the program: work in the wrong order, on a
   broken ledger, or against the repository's own invariant. Signature: content mass is
   healthy while the ledger's delivered/pending numbers do not move, or move out of order.
   This is the mode the other six cannot see, and it is the common one.
8. **A ledger that cannot answer "what is next."** Signature: an empty or self-contradictory
   scheduler table, queue or DAG frontier in a repository that still has open scope. The
   worker is now choosing its own units and nobody is measuring the choice. Repairing the
   ledger outranks every push.

**Every hour, sweep every managed repository for these signatures**, and while there, audit
the four self-repair obligations under
[Arming the repositories](#arming-the-repositories-is-the-standing-work) and the unlock
triggers in `FANOUT-SCHEDULE.md`. The sweep is state-level and cheap — `git log`/`status`
timestamps across branches and worktrees, ledger deltas, queue files cross-checked against
solved state, mtimes — and it stays on the measuring side of
[the reading boundary](#production-not-liveness): it looks for the signatures above and never
decides a repository's domain work. Respect each repository's own contract while sweeping; a
deferred-verification repository has no gates by design, so signature 1's gate clause does not
apply there.

**On evidence, the remedy is a document, then a push.** Repair the managed repository's own
surfaces so the failure mode is prevented in-repo — amend the rules where they were silent or
ambiguous, fix the queue or claim tooling that allowed staleness, repair the gate or ledger
that was wedged, checkpoint stranded state. Only once the repo's documents carry the rule does
the steward act on the live worker, and then only by routing it into those documents
(`"re-read AGENTS.md before continuing"`), never by restating the policy in the prompt.
Policy that lives only in orchestrator messages does not exist.

**Red gate means stop, where gates are part of the repository's contract.** The first time one
goes red, the worker's current unit becomes diagnosing that failure: no authoring behind it and
no uncommitted work accumulating around it. A worker committing nothing while its tree grows is
wedged and gets the same intervention as a stalled chat. This does not apply to a repository
under a declared deferred-verification contract, where gates are deliberately off — diverting
such a worker into hook-passing or type-check golf mid-refactor, polishing files slated for
deletion, is itself the failure mode.

**Gates belong in tiers.** For a corpus repository the scarce thing is mathematics reaching
the tree, and gating each commit on whole-repository coherence directly obstructs it: a
worker who writes a definition referring to something not yet transcribed cannot bank the work
at all. Commit is a sanity check — does it parse, does it follow the conventions, did the unit
get its ledger entry. Push carries the hard work: full build, whole-environment audits, no
placeholders, paid once per batch. Contribution is the promise to anyone outside — coherent,
compilable, defensible — and that one never moves. **Tier by what the check costs and how far
its failure spreads, not by repository type**: `lean-categories` split its commit gate from a
~24-minute median to 23 seconds because its check was expensive and an incoherent
intermediate state is local, while `sage-categories` measures 62 seconds and is code other
agents read and imitate, so an ill-typed construction becomes the house style — a cheap check
against a compounding failure belongs on commit and should fail there every time. So: expensive
check, local failure → push tier; cheap check, propagating failure → commit tier. A steward
reading a red gate asks which tier it is on before calling anything wedged. **A gate red for
days is worse than a gate that is slow**, and it is the one a steward misreads: a check that
always fails cannot distinguish the commit in front of it from the hundred before, so workers
learn to annotate past it and the repository loses the defence entirely. Read it as an outage.

**Reworking a corpus is a triage phase at the end of a transcription milestone**, not
something interleaved with transcription. Interleaving it is what turns a sweep into an
unbounded refactor and is the usual reason a sweep runs for days without closing a unit.

**Check that the partition still covers the work before adding streams.** Scopes run out.
`new-qual-site` was fanned to eight streams against a partition naming eight collections out
of 392 in its corpus: the streams finished their assignments and went quiet with 3,232
unsolved cards in collections nobody had been given. Stream count was never the limit. When
several workers in one repository go idle near each other, suspect an exhausted partition
before suspecting the workers, and measure remaining work against the whole corpus rather than
the slice the plan happened to name.

**Measure output where the work lands.** Counting commits on `main` is only a throughput
measure if the workers commit to `main`; when they work on branches, `main` undercounts by
however much is unmerged — here, about 1,800 commits of finished solutions — and the steward
reads a productive fleet as a failing one, or the reverse.

### The managed workstreams

Keep this list current, at one or two lines per repository, and update it only when the
management shape changes — a repository added or dropped, a stream count changed.

- **`lean-categories`** (`/home/dzack/gitclones/lean-categories`): Sweep II corpus mapping
  across sources (FC08, FC10, FC11). Definitions close before theorems open.
- **`new-qual-site`** (`/home/dzack/gitclones/new-qual-site`): Quality audit and card-by-card
  solution remediation on problem collections; queue E intake.
- **`research`** (`/home/dzack/research`): Preamble construction workstreams — C (category
  foundations) and A0 (categorical group actions).
- **`sage-categories`** (`/home/dzack/gitclones/sage-categories`): Native engine remediation
  and foundational category framework implementation.

Send them messages per [What to send them](#what-to-send-them). The mechanics of driving a
chat — what a refusal means, which instrument lies in which direction, tabs, locks, memory,
rate limits, handoffs — are in
[`docs/fleet-operations.md`](./docs/fleet-operations.md). Read it when an instrument is about
to change what you do, and not otherwise.

### The fan-out schedule — `FANOUT-SCHEDULE.md`

[`FANOUT-SCHEDULE.md`](./FANOUT-SCHEDULE.md) is the canonical parallelization plan: per-repository
target stream counts, the claim partitions that make streams collision-free, the preconditions
that must hold before fanning out, and the **unlock triggers** — DAG events that change how wide
a repository can go. Saturation targets live there, not in steward judgement calls.

- **Spawn to the schedule.** When a repository is below target and its preconditions hold,
  launch to match — one worker per partition slot, each pointed at the repo's own documents and
  its assigned scope. Never exceed a stated cap: every width number is bound by a named
  constraint and exceeding it recreates a documented failure mode. **Space initial launch
  requests at least ten seconds apart**; a simultaneous burst trips rate limiting, and the
  stagger is invisible against hours-long streams. This applies to the kickoff burst only and
  never licenses delaying a continuation or a replacement.
- **Watch the triggers in the hourly sweep**, and when one fires, adjust and update the schedule
  in the same turn. A stale saturation target misroutes every subsequent spawn.
- **Per-repo claim protocols stay in each repository's own documents.** This file holds only the
  fleet-level plan and routes to them.

### Where a regression belongs

49 suites, named for the subsystem they cover. Vitest uses real filesystem, real processes
and real HTTP in many of them.

| Suite | Covers |
| --- | --- |
| `agents` | broker rules, prime/worker identity, at-least-once messaging |
| `bridge` | extension<->app HTTP bridge, routes, auth, orchestration |
| `chronology` | the order a recorded turn is read in |
| `codex-apply-patch-parity` | V4A parser / matcher / runtime parity |
| `codex-apply-patch-invocation-parity` | shell-intercepted `apply_patch` invocation |
| `codex-runtime-parity` | `exec_command` / `write_stdin` runtime parity |
| `codex-view-image-parity` | image validation, limits, transport adaptation |
| `computer` | desktop automation; frame-id crop, focus honesty, window queries |
| `config` | validation, migrations, read-only capability collapse |
| `content-script` | isolated-world recorder, turn lifecycle, Overwrite render |
| `continuation` | Compact & Resume transaction and its failure paths |
| `correlation` | requestId->conversationId persistence, restore, conflicts |
| `env` | the child environment handed to spawned processes |
| `exec` | `runCommand` and process-tree termination primitives |
| `extension` | service worker, journal, tab registry, reload recovery |
| `fiber` | MAIN-world React extraction and its allowlist |
| `fsops` | bounded text/image/file helpers |
| `goal` | the goal loop's prompt, privacy boundary, one-draft rule, OpenRouter failures |
| `ipc` | main<->renderer boundary and payload validation |
| `mcp` | surfaces, handlers, integration — the widest suite |
| `mcp-inbound` | `x-request-id` extraction and normalization |
| `mcp-shutdown` | draining an accepted mutation before closing its socket |
| `renderer-html` | sanitization of captured ChatGPT HTML |
| `renderer-layout` | session card / timeline layout contracts |
| `renderer-state` | unsolicited pushes must not clobber a focused dirty field |
| `resume` | resume and handoff paths |
| `sandbox` | path, root and containment policy — the security suite |
| `shutdown` | bounded teardown phases that always reach the exit; terminal sessions really dying |
| `search` | glob translation and `find` behavior |
| `secrets` | safeStorage-backed secret store |
| `session` | recorder merge and durable store behavior |
| `swarm` | multi-agent integration across identity and workspace |
| `text-match` | edit matching across line endings |
| `tunnel` | error classification, poll metrics, outage confirmation, route self-test |
| `workspace` | per-chat/agent workspace learning and keying |

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
`extension/manifest.json`, and run the full suite. After installing a local build, verify
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

Before changing one of these areas, reproduce the behavior against the current tree, preserve
fail-closed behavior, add a deterministic regression where practical, and verify neighboring
negative/security cases. Suspected security issues and reproduction details belong through the
private process in `SECURITY.md`, not in public issues, comments, or fixtures.

**Do not scatter fixes across symptoms before proving the shared root.**

## 22. Definition of done

- The reproduced failure is gone **for the root reason** — not hidden in the UI, not retried
  until lucky.
- The neighboring negative / security case still holds.
- A targeted regression captures the old failure ordering or input.
- Every producer and consumer of any changed protocol agrees.
- Model-visible schema and user-visible surface still match the implementation.
- Unrelated dirty work is untouched.
- Targeted tests pass and `npm run verify` passes.
- Build/packaging checked when the changed layer can differ after bundling.
- Comments and this file updated only where behavior genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.
