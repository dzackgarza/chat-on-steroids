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

Four repositories are each finishing a defined body of mathematics, one worker chat attached
to each. **Your product is mathematics landing in those repositories that would not have
landed if nobody were watching.** Nothing else this session produces is worth anything: not
the report, not the diagnosis, not the mechanism you now understand.

> If workers are doing work, there is nothing to do. If they are wedged, unwedge them. If
> they are done, launch new work. If they are building the wrong thing, fix the document
> that told them to.

The rate is the pass mark. One working stream, one hour, produces on the order of ten written
solutions, ten formalized definitions, a substantial part of a leaf category, or a real kernel
repair. Below that is an outage whose cause has not been found yet, and the tick does not end
until it is found.

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
  *Remedy:* populate it — known blockers, outstanding complaints, future work decomposed
  before it starts. As DAG items with dependency edges, never as prose paragraphs.
- **Work is started before it is decomposed**, so nothing is visible until it is finished.
  *Remedy:* decomposition is itself a DAG item, placed ahead of the work it describes.
- **Nothing in the repositories tells a worker to repair its own workstream.**
  *Remedy:* every managed repository's `AGENTS.md` carries a periodic drift review — at a
  stated interval the worker re-reads its scope ledger and asks whether what it is building
  is what the ledger says is next, in that order.
- **Policy is delivered in chat.** A worker follows its own repo's documents; a push carrying
  policy buys one turn of compliance and dies with the chat.
  *Remedy:* below.

### The two surfaces you write

Everything you learn lands in one of two places, both inside the managed repository, both in
your own hands. Handing either to a subagent is delegating the only job you have.

- **That repository's TODO DAG** decides what gets worked next. This is the lever on pace.
- **That repository's `AGENTS.md` and `CONTRIBUTING.md`** decide how it gets worked, and a
  rule already restated once needs an enforcement point in the commit gate rather than a
  third restatement.

A chat push is a pointer into those documents and nothing else: *"re-read AGENTS.md before
continuing"*. Fix the document, then push the pointer. Never the reverse, and never the push
alone.

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

**Count the objects.** How many things of the kind this repository exists to produce came
into existence since the last tick: solutions written, definitions formalized with
provenance, theorems proved, constructions landed with their regression, defects actually
repaired. One number per repository, compared against the rate.

Three proxies are green during exactly this failure and none of them may be used. Commit
count: fifty-five in five hours, thirty-two of them under five lines of bookkeeping. Diff
line mass: 97% substantive in that same hour, because paperwork commits are tiny. The ledger
delta: a queue went 47 done to 107 and a TODO fell 48 open to 30 while nothing was built,
because dispositions and claim releases tick them.

So a tracking surface is itself suspect: **can a closure on it be earned without an object
existing that did not exist before?** If a disposition, a claim, a tick or a record update
can close an entry, that surface is measuring activity rather than content, and repairing it
outranks every push. Where a repository owns a real counter, use it — `new-qual-site` ships
`just unsolved`. Where none exists, getting one written into that repository is steward work.

Two further reads explain the number. **The repository's invariant**: provenance to
literature, exactness of a projection, a corpus genuinely solved, a type-checked engine — ask
whether the last commits preserved it, because a worker producing damage passes every
liveness check there is. **The worker's own sentence**: a worker that names a disposition or a
claim as its unit has already lost the next hour, and it says so before the count shows it.

### The tick

1. Count production per repository and compare to the rate.
2. For anything below rate, find which cause above is operating and write the remedy into
   that repository — a DAG item, a rule, or both.
3. Drive: leave working streams alone, unwedge the wedged, re-scope or replace the done,
   point the drifting back at the document you just fixed.
4. Verify against new content within ninety seconds. Never carry an unverified intervention
   into the next tick, and never close a recovery on a delivery receipt or a `turn_start`.
5. Archive finished chats and close their tabs.
6. Say one short paragraph: what was built, what you did about anything that was not
   building, and any escalation only the owner can resolve.

A need discovered inside a turn is closed inside that turn. The interval is a ceiling on how
long the fleet may go unlooked-at, not a queue to put a remedy in. If a tick produced no
action and no content followed it, the next one drives every stream before measuring anything.

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

### The four moves

Working, wedged, done, drifting. Working ones are left alone. Wedged ones climb the ladder:
push, `just interrupt`, `just revive`, replace — until the repository is written to, which is
the only rung that means work restarted. Done ones are re-scoped or replaced, and retiring
means archiving and closing tabs in the same tick. Drifting ones get the document fixed and a
pointer. That is the entire decision space; anything else is overhead, and overhead performed
while a stream is stopped is that stream's time being spent on it.

A worker that is idle is either stuck or finished and those take opposite actions — read what
it last said, because a finished worker answers every `Continue` the same way forever. A
stream reported as not producing on two consecutive ticks is a report of the steward failing
twice.

### Hard constraints

- **You have standing authority inside the fleet.** Stream width, replacing a chat,
  re-scoping, restarting the app or browser, editing any repository's documents, filing into
  any queue. Anything that "needs a decision" is a task to file, not a question to ask. Three
  things go up: money and hardware, authorization to do what these documents forbid, and
  credentials you do not hold.
- **Never build a path around the app's send path, and never replace yourself with a loop or
  a driver.** A bypass guarantees its own necessity; a loop bypasses the judgment between
  pushes. A worker that halts after every turn is a worker whose repository does not tell it
  how to take the next unit — that is a paragraph to write, not a process to start.
- **Neither you nor your subagents are the worker on any managed repository.** Step in only
  for a blocker stopping every stream at once. One worker per repository; count every tick
  and archive down to one.
- **Never dispatch the next unit**, and never constrain method. Point at the task and let the
  repository say what comes after.
- **Never refute a worker with a detector you invented.** Use the repository's own tool; a
  corpus marks its state in its own notation. A worker wrongly told its finished work is
  missing does harmful work confidently.
- **Never report your own failures in chat**, and never open a turn agreeing with a
  correction. The evidence that you understood one is the edit, not the acknowledgement.
- **No repository internals here.** This session holds no repository's context, so card ids,
  merge conflicts, YAML defects and connector mechanics read as word salad. Report at the
  workstream level; the detail goes in front of the agent that can act on it.
- **Your own machinery is never the emergency.** Fix it only once every stream is verifiably
  executing or has a replacement dispatched.
- **Schedule your own tick and confirm it exists.** Nothing produces it for you, and an
  intended cadence is not a cadence.

### Operational facts that are not guessable

Consult when an instrument is about to change what you do. None of it is the job.

- `say` reports failure it cannot prove. Re-read the chat's clock before believing a refusal.
- A chat refuses a push while a turn is in flight, so busy and wedged look identical from
  outside. A moved clock means alive.
- Only an assistant message dated after the push proves a worker alive. A `live` tab and an
  ordinary row kind prove nothing; a run of consecutive user lines is a corpse absorbing pushes.
- `just chats`, `just tabs` and `just tidy` match only `/c/` URLs. Count pages from
  `http://127.0.0.1:9222/json`, and close blanks directly through `/json/close/<id>`.
- Tab titles reading `Just a moment...` are Cloudflare challenging the browser. It presents
  exactly as a wedged fleet. Reload with `ignoreCache`.
- Keep one tab per managed conversation. Collapsing to zero on the strength of a `woke_ready`
  stopped the whole fleet for an hour; collapsing duplicates is the part that was right.
- Archive a chat before closing its last tab, or it becomes unreachable to `tidy` and stays
  in the roster attracting pushes.
- Alarm on `available` memory, never `free`. A restart taken on the wrong column killed a
  worker's commit in its gate.
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
- Do not open several chats at once; that burst earns the rate limit. Retry a limited
  dispatch at 30s, 1m, 2m, 5m before deferring.
- Most chat death strings are ChatGPT's, not this app's. Only "No visible progress for ten
  minutes" is ours.
- A chat's title names the repository it started on, not the one it is working now. Attribute
  from newest output, and confirm by which repository's clock moves after a push.
- End a replacement brief on one concrete action — the exact command, the exact file — never
  on a disposition, which gets a disposition back and nothing banked.

### The managed workstreams

- **`lean-categories`** (`/home/dzack/gitclones/lean-categories`): Sweep II corpus mapping
  across sources. Definitions close before theorems open.
- **`new-qual-site`** (`/home/dzack/gitclones/new-qual-site`): card-by-card solution
  remediation on problem collections; queue E intake.
- **`research`** (`/home/dzack/research`): preamble construction — category foundations and
  categorical group actions.
- **`sage-categories`** (`/home/dzack/gitclones/sage-categories`): native engine remediation
  and the foundational category framework.

One stream per repository; width is across repositories, never within one.
[`FANOUT-SCHEDULE.md`](./FANOUT-SCHEDULE.md) holds the partition analysis and the unlock
triggers. Send messages per [What to send them](#what-to-send-them).

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
