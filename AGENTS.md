# Chat On Steroids — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here. If you are
here to stand the watch over the managed fleet rather than to change this app, **§19's
"What a tick is for" is the job** — read it before the mechanism that surrounds it, because
every steward that read the mechanism first ended up reporting the fleet instead of driving
it.

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

### When a chat stops

Driving chats means most of the work is deciding whether one has stopped, and the rows lie in
both directions until you know how to read them.

**`say` reports failure it cannot prove.** It waits for the receipt the browser writes once it
has typed, and calls the push refused when none arrives in its window. A message that landed
slightly late reports as never typed. Re-read `just chats` before believing a refusal — a moved
timestamp means it landed.

**A refused push does not mean the chat is dead.** The page refuses to type while a turn is in
flight, so a chat that is merely busy refuses exactly like a wedged one. Compare the chat's
timestamp before and after the attempt: the push takes up to two minutes and a live chat emits
rows throughout, so a clock that moved means alive and a clock that did not means dead.

**The stall bar is eager, and the timestamp re-check is what makes that safe.** Recorded gaps
between rows inside a live turn run 8.2s at the median and 26s at p90; separating turns that
never stalled from turns that did barely changes the tail, so a multi-minute gap in the
recording is not evidence of slow work — it is the recording being coarser than the agent's
real contact with the app. `just chats` calls a turn stalled at ninety seconds. Being early
costs one refused push, since the re-check above leaves a chat alone when its clock moved.
Being late costs a whole polling interval of a chat doing nothing, which is the expensive
side.

**A stalled chat can only be rescued from inside the page, and now you can ask it to.** The
composer refuses while a turn is in flight, which is exactly the state worth rescuing, so
nothing outside the page can break it. The page breaks it three ways. On its own: the content
script presses Stop and sends `Continue` after a ten-minute stall, retrying every two minutes
because ChatGPT often ignores the first press, and the service worker reloads a tab that holds
a chat and will not act on the command for it. On request: `just interrupt <chat> "..."` makes
that same press happen now and types your message instead of `Continue`, and
`just revive <chat> "..."` reloads the page first. Both destroy or discard whatever the turn
was doing, so they are separate verbs from `say` — read `just state <chat>` before reaching for
one. A chat that is merely working is a chat to leave alone.

**A tab that renders is not a chat that answers.** `just tabs` calls a tab `live` when the
page is loaded and its chat was recently touched; neither half of that asks whether the chat
produced anything. A chat can hold a `live` tab, accept every push, and emit nothing: in
2026-09 `6aa27577` took twenty-one `Continue` pushes across fourteen hours with no assistant
message after 07:18, while `just tabs` showed it `live 0m` and `just chats` showed an ordinary
`turn_end stalled` row. Row kinds and tab verdicts are substrate metrics. The only evidence a
worker is alive is an assistant message dated after the last push, which costs one read:
`just transcript <chat> | grep -E '^## (assistant|user)' | tail -30`. A run of consecutive
`## user` lines with no assistant between them is a corpse absorbing pushes, and every tick
that re-pushes it is a tick that bought nothing.

**`typed_unverified` is not proof of non-delivery, and retrying it duplicates the stream.**
The outcome means the page reported the text accepted while no `turn_start` reached the
recording inside the horizon — a late receipt produces it just as reliably as a wedged draft.
On a `just new`, retrying blind is how one scope ends up with two workers on it. Read
`just chats 1` first: a conversation that was not there before, with a title matching what you
sent, means it landed.

**Unreachable is not dead, and archiving is not cheap to reverse.** A chat can refuse `say`,
`interrupt` and `revive` in succession while its worker is executing normally — `6aa3009c`
refused all three while inside a pytest run at 95% CPU that it went on to bank from. Send
paths fail for reasons that live in the page, not in the worker. Confirm against the worker's
own output — the host process it named, or its repository's clock — before archiving, because
the app archives through `PATCH is_archived` and carries no recipe to undo it.

**The composer gate closes on the steward, not on the worker, and retrying widens it.** The
page refuses to type while local tool calls are in flight, and an unattributed call is charged
against every chat — so a fleet where all four workers happen to be running tools is a fleet
with no reachable chat in it, and the refusal says nothing about any particular worker. Every
send attempt opens its own command tab, which is one more call against the same gate, so a
retry loop is the one response that reliably makes the next attempt fail too. Poll `just state
<chat>` until it reports no pending tool, then send once.

**A resend loop must verify in the transcript, not in the send's own outcome.** `say` reports
failure it cannot prove, so a loop that retries on a non-`delivered` result will happily
deliver the same message three times to a worker that received it the first time — and a
worker that reads its brief twice does the work twice. Before each attempt, grep the
transcript for a distinctive phrase from the message; treat its presence as landed and stop.
That check is also what closes a tick honestly: an intervention is landed when it is visible
in the worker's own transcript or in a moved commit clock, never when the send returned.

**A chat's title and its early transcript name the repository it started on, not the one it
is working now.** Long-lived chats get repurposed, and the tab title never follows — a chat
titled `Fix Lean Categories Blocker` spent hours on `sage-categories` while every path in its
transcript said so. Counting repository mentions across a whole transcript measures where a
chat has *been*, which is the wrong question; a steward that attributes a worker that way will
route a push at the wrong repo's queue and then read the wrong clock to verify it. Attribute
from the newest output only, and confirm by which repository's clock moves after the push.

Repurposing also runs backwards: telling a worker to re-read its repository's own documents is
the standard way to land policy, but a chat carrying an older identity can take that as an
instruction to return to the repository it started in. Watch the reply, not the send — if the
artifacts it names belong to a different repository than the one you addressed, say the working
directory explicitly and make it echo `pwd` before it does anything else.

**Do not diagnose a stubbornly wedged chat. Replace it.** Read the transcript tail, write a
short handoff — ambient task, tracking documents, current item — and `just new`. An hour spent
finding out why one chat will not accept a message is an hour of three chats not working, and
the handoff costs minutes.

Three things break every chat at once and none of them is the chat:

- **The app's bridge is not listening.** The app can be running, small and idle, with nothing
  on 8765-8769. Every send fails and nothing says why. `just install` restarts it.
- **A runaway process from a chat's `exec_command`.** It is orphaned to init, keeps the app's
  path in its argv so it looks like the app in `ps`, and holds a core indefinitely. Check for a
  process burning CPU for many minutes and kill it.
- **ChatGPT's model slider left on a mode that is out of usage.** The chat cannot answer, the
  app has no way to leave that mode, and every send into it fails. Replacing the chat does not
  help; the slider has to be changed.

### What a tick is for

Everything after this subsection is mechanism. This is the job. Every steward that has run
this watch has drifted off it in the same direction — toward describing the fleet instead of
driving it — and the drift is invisible from inside, because an accurate report *feels* like
work and the prose is usually good.

**The steward's product is worker-hours of production, and nothing else.** What this session
is worth is commits in the managed repositories that would not exist if nobody were watching.
The report is a receipt for that, addressed to an owner who is not watching the fleet
themselves. **A tick that ends with a precise, honest report and a stream that is not working
is a failed tick**, and the precision makes it worse rather than better: it means the steward
looked directly at a stopped stream, named it correctly, and left it stopped.

**A stream that is not producing is your outage, not its status.** `lean-categories | 0
commits | not producing` is not a row in a table. It is the steward's own failure, running for
as long as the row says, and there is no reading of it under which it is an acceptable thing
to report. On 2026-09-09 that row was carried across ticks for twenty hours while each
check-in restated it in slightly different words; the cause — a worker polling a build that
had been dead since the previous evening — took four minutes to find once anybody went
looking. A repository's whole working day was spent on the steward's willingness to write the
row again. **A stream reported as not producing on two consecutive ticks is a report of the
steward failing twice.** Hours without a commit is the one thing in this role that is an
emergency; treat it like one, and do not let the calm of the reporting format launder it into
a fact about the worker.

**There are three moves, and reading a stream means choosing between them.** A worker is
working, wedged, or done. Working ones are left alone. Wedged ones are unwedged — push,
interrupt, revive, replace, in that order, until the repository is written to. Done ones are
re-scoped, or replaced with a fresh chat on new scope. That is the entire decision space.
Anything a steward does that is not one of those three moves, or the shortest path to one of
them, is overhead — and overhead performed while a stream is stopped is that stream's time
being spent on it.

**The tick is a reporting cadence. It is never a scheduler.** Twenty minutes is how often the
owner hears from the watch and a ceiling on how long the fleet may go unlooked-at. It is not a
queue you may put a remedy in. "Next tick it gets a handoff to a replacement unless a commit
lands first" — written about a stream already five hours dry — is a decision to spend twenty
further minutes of that stream on waiting, taken because the remedy felt like it belonged in a
later slot. It does not. **A need discovered inside a turn is closed inside that turn**, and
the turn stays open until it is; the tick has no authority to end a turn that still contains a
stopped stream. When a remedy genuinely cannot complete inside one turn — a real build that
must finish, a rate limit that must expire — the turn ends holding a *scheduled short check*,
minutes away and already created, never an intention to look again at the next check-in.

**Delivered is not started, and started is not working.** Every recovery has three rungs, and
only the last one is the job:

1. `sent_verified` — the app accepted the message and the page typed it. A receipt from your
   own machinery, nothing more.
2. `turn_start` in the recording — the worker began a turn. This proves the chat is alive. It
   does not prove the worker took the task up: a worker that answers, re-reads its own state
   and stops again reaches this rung and goes no further.
3. **A write in the managed repository** — a file changed or a commit landed after the push.
   This is the only rung that means work restarted, because it is the only one measured where
   the product is.

Each rung has its own short horizon and its own escalation, and a rung that does not arrive is
escalated, not reported. On 2026-09-10 at 16:31 four pushes all returned `delivered`; ninety
seconds later the repositories showed zero writes between them. The pushes were real, the
report was true, and no work had restarted. **Never close a recovery on rung 1 or 2.** If
rung 3 has not arrived by the second short check, the worker is not merely slow — go find what
it is blocked on, or replace it.

**You have standing authority over everything inside the fleet.** Stream width, parking a tab,
replacing a chat, re-scoping a partition, restarting the app or the browser, editing any
repository's `AGENTS.md`, filing work into any repository's queue: none of these needs asking,
and stopping to ask turns a twenty-minute tick into twenty minutes of nothing happening.
"Holding the remaining 11 streams at current width until you decide" and "that trade is a
resourcing call I should not make for you" were both written while streams sat idle. Take the
action, record it, and say what you did. Three kinds of thing go up and no others: money and
hardware, authorization to do something these documents forbid, and accounts or credentials
the steward does not hold. Everything else that "needs a decision" is a task with an
acceptance condition, filed in the repository that owns it.

**Explaining the mechanism is not progress, and it competes with progress.** Attribution
tiers, `pendingTools` bootstrap ordering, per-process swap tables, why one gate refuses while
another does not — a steward can spend an entire tick becoming genuinely expert in why the
fleet is stopped and produce a paragraph the owner cannot act on and no worker will ever read.
Mechanism is worth exactly as much as it shortens the path to a stream producing. When it
does, follow it, and then put what you learned in a commit — this file, `COMPLAINTS.md`, or
the repository that owns the defect. When it does not, it is a diversion that reads as
diligence, and it is where whole ticks go.

**Every tick ends with the fleet no wider than the work.** Reading the fleet and acting on
it is the tick's substance; leaving behind exactly the chats and tabs the work needs is the
tick's cost of doing business, and it is not optional because it is cheap. Each tick, close
the chats you concluded were finished, archive what has run out of scope, and sweep the tabs
— the one-line `just tidy` with a freshly computed keep list, under
[Standing watch](#standing-watch-over-several-chats). Skipping it does not save time; it
defers a cost that compounds at the rate you push, and which lands as a host that cannot
carry the streams you already have. On 2026-09-11 that deferral had reached 107 browser
pages for 16 conversations and 4.4 GB of a 7.9 GB box, and the streams were swapping while
the roster looked healthy.

**Your own machinery is never the emergency.** Rewriting a push loop, installing a library,
fixing the wake check, building a better nudge — none of that is work on the fleet, and doing
it while a stream is stopped is effort substituting for effectiveness. Fix the machinery only
once every stream is verifiably executing or has a replacement dispatched.

### Standing watch over several chats

A steward keeps a handful of chats working across a whole day. Everything below was learned the
expensive way in one such run, and none of it is guessable from the code.

**Always keep current managed workstreams listed here.** Keep this list up-to-date with at most 1–2 lines of status per repository. Update the list only when major management changes occur (for example: adding primes for parallel work on a repository, or dropping repositories entirely):

- **`lean-categories`** (`/home/dzack/gitclones/lean-categories`): Sweep II corpus mapping across sources (FC08, FC10, FC11).
- **`new-qual-site`** (`/home/dzack/gitclones/new-qual-site`): Quality audit and card-by-card solution remediation on problem collections.
- **`research`** (`/home/dzack/research`): Preamble construction workstreams: C (category foundations) and A0 (categorical group actions).
- **`sage-categories`** (`/home/dzack/gitclones/sage-categories`): Native engine remediation and foundational category framework implementation.

**Check-in reporting** has one specification, under [Check-in reports](#check-in-reports)
below. It is deliberately not restated here; a second copy drifts from the first and a
steward then follows whichever it read last.

**Count tabs from the browser, never from `just tabs`.** Both `tabs` and `tidy` match only URLs
containing `/c/<id>`. A tab sitting on bare `chatgpt.com` is invisible to them: it is never
counted and never closed. A run once reported "14 tabs → 4" every twenty minutes while the
window actually held 144, because 139 of them were blank. Count what the browser reports:

```bash
curl -s -m 5 http://127.0.0.1:9222/json | python3 -c "import json,sys; p=[t for t in json.load(sys.stdin) if t.get('type')=='page' and 'chatgpt.com' in t.get('url','')]; print(len(p), 'tabs,', len([t for t in p if '/c/' not in t['url']]), 'blank')"
```

Blank tabs should stay near zero, since the service worker closes a command tab whose command
never acknowledged. Dozens of them means that has regressed. Close a tab directly through
`http://127.0.0.1:9222/json/close/<target id>`.

**A `woke_ready` event does not mean a conversation can be driven with no tab. Keep one
tab per managed conversation.** This rule replaces the one below it, which was written on
2026-09-11 from a single morning's observation and stopped the fleet that same afternoon.
What follows the arrow is the retraction, not the advice.

**Read the tab titles first.** `Just a moment...` is Cloudflare challenging the browser, and
it is the cheapest fleet-wide diagnostic there is — one `curl` against `/json`, no DOM
probing:

```bash
curl -s -m 5 http://127.0.0.1:9222/json | python3 -c "import json,sys; p=[t for t in json.load(sys.stdin) if t.get('type')=='page']; print(sum(1 for t in p if 'Just a moment' in (t.get('title') or '')), 'of', len(p), 'challenged')"
```

A challenged tab is indistinguishable from a wedged chat through every surface a steward
normally reads: the turn stays marked generating, nothing renders, the ten-minute watchdog
fires, `/send` returns `expired` or `no_live_composer_tab`, and `just new` reports
`No tab produced a usable composer`. It also poisons recorded state — a conversation's
`meta.json` title becomes the literal string `Just a moment...`, so a roster read from
titles is wrong in a way that looks like a dead stream. On 2026-09-11 six of sixteen pages
were challenged; a steward spent forty minutes on send-path verbs, substrate checks and a
DOM probe for a rate-limit modal before looking at the titles. `Page.reload` with
`ignoreCache` cleared all six, and repositories that had been silent for over an hour
committed within minutes.

The reasoning behind the retracted rule was: `/sleep/status` shows `slept` → `wake_started`
→ `woke_ready` cycles, the turn runs on chatgpt.com's servers, so the tab is only a view and
can go. Tabs were closed for every conversation with a `woke_ready`, taking the browser from
107 pages to 8. The fleet kept working for about two hours, which read as confirmation and
was not.

**The two causes compound, and the tab rule is what made the first one fatal.** Cloudflare
was the trigger; a thinned tab pool was why it took everything down at once. At 107 tabs
there are always already-cleared pages to fall back on and a challenge wave is absorbed
invisibly. At 8 there is no slack, and the same wave removes every path to every worker
simultaneously. Keeping one tab per conversation is the floor, not the target — it is
enough to be reachable and not enough to survive a challenge wave, so expect to clear
challenges by hand when the pool is thin. What happened after the pool was thinned: every managed repository went to zero writes for over an hour, `/send`
returned `expired` or `refused` for six of eight pushes, `just new` failed with
`No tab produced a usable composer for this chat`, and turns that did start rendered
nothing until the ten-minute watchdog killed them. Reopening one tab per conversation
restored delivery immediately — three of five pushes `delivered` where two of eight had
before — and the first repository commit landed within ten minutes.

Two lessons worth more than the rule they replace. **A sleep/wake cycle recorded in
`/sleep/status` proves the conversation slept and woke while a tab existed; it is not
evidence that the wake path can materialise a composer from nothing.** And **a fleet that
keeps working for two hours after a change has not validated it** — the tabs already open
were carrying the work, and the damage surfaced only when those conversations needed a
fresh composer.

What is still true from the original finding: every `/send` opens its own command tab
carrying a distinct `clf` token and nothing closes it, so duplicates accumulate one per
push and are the fleet's largest memory cost. Collapsing **duplicates** is correct and
recovered about 2 GB. Collapsing to **zero** is what broke it. Keep one tab per managed
conversation — prefer one whose URL carries `clf=`, which the app has adopted — and close
the rest.

---

*Retracted 2026-09-11 — see above. Retained so the next steward recognises the reasoning
if it re-occurs to them.*

**~~A conversation that has woken tablessly needs no tab at all, and tabs are the fleet's
largest memory cost.~~** Every `/send` opens its own command tab carrying a distinct `clf`
token, and nothing closes it afterwards, so tabs accumulate one per push for the life of a
stream. On 2026-09-11 the browser held **107 pages for 16 conversations** — one chat alone
had fourteen, another thirteen, twenty-seven were blank — at 4.4 GB of Chrome on a host with
7.9 GB total and 286 MB free. Collapsing it to 8 pages returned about 2 GB, which on this
box is the difference between workers running and workers swapping.

The tab is a view, not the conversation: the turn runs on chatgpt.com's servers and
`session/sleep-wake.ts` (§14) wakes a slept conversation with no tab open. So the question is
not whether a chat is busy, it is whether that chat has a proven wake path. Read
`/sleep/status` and keep a tab only for a conversation with no `woke_ready` event — one that
has never completed a wake cycle has nothing to wake it, and closing its last tab strands it
behind `no_live_composer_tab`:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.config/chat-on-steroids/state/local-token)" \
  http://127.0.0.1:8765/sleep/status |
  python3 -c "import json,sys; e=json.load(sys.stdin)['events']; print(sorted({x['conversationId'][:8] for x in e if x['kind']=='woke_ready'}))"
```

~~Everything with a `woke_ready` can lose every tab it has.~~ **Retracted — this is the
sentence that stopped the fleet.** Collapse duplicates to one per conversation and stop
there, preferring a tab whose URL carries `clf=`, which is one the app has adopted.

**This is tick work, not spring cleaning.** Tabs accrue at the rate you push, so the sweep
belongs in every check-in beside reading the fleet, and it costs one command:

```bash
just tidy 45 "$(just chats 5 2>/dev/null | grep -vE 'sitecustomize|ModuleNotFound' \
  | awk -F'\t' 'NF>1 && $2!=""{print $2}' | sort -u | paste -sd,)"
```

Check the keep list is non-empty before trusting that line. If `just chats` returns nothing
— the app down, the bridge not listening — the substitution collapses to `""` and `tidy`
archives every quiet conversation in the browser, including the whole managed fleet. An
empty keep list is never correct while streams exist.

`tidy`'s two arguments are what make it safe, and its behaviour is not what its name
suggests. It closes duplicate tabs for **every** conversation unconditionally, keep-listed or
not, which is most of the win. It archives only a conversation quiet longer than the first
argument *and* absent from the second — so the keep list must be the live fleet, computed
fresh in the same command, never a remembered one. A chat with no recording at all is kept
regardless. Follow it with the blank-tab close above, since `tidy` matches only
`chatgpt.com/c/` and cannot see a blank, and with the `woke_ready` close, since `tidy` always
leaves one tab per conversation.

**Archive before you close the last tab — the two rules above conflict in that order.**
`tidy` walks DevTools targets, so it only ever sees a conversation that still has a tab
open. A chat whose tabs you closed on the strength of a `woke_ready` is invisible to it:
it cannot be archived, and it stays in `just chats` attracting pushes forever. Observed
2026-09-11 — a cold lean stream sat through a full sweep untouched because it was already
tabless, while every chat that still had one was correctly kept or archived. So retire in
this order: decide the chat is finished, archive it, *then* close its tabs. The tab-closing
economy applies to chats you intend to keep working; a chat you intend to retire needs its
tab for one more command. If you find an already-tabless chat that should be retired, open
one on its conversation URL and archive through that, rather than leaving it in the roster.

**Archive a chat the moment it is known finished; do not leave it idling.** A worker that has
run out of scope says so plainly — "no remaining TODO in the collection-defined scope",
"nothing further to execute within the assigned scope" — and answers every further `Continue`
the same way. That chat is done: it will never produce again, it holds tabs and browser
memory for as long as it stays open, and it pads the fleet count so a real stall hides inside
an apparently healthy roster. Retiring it is the same verb as re-scoping it — archive it,
close its tabs, drop it from the keep list — and it is the steward's call, needing nobody's
permission. The distinction that matters is **finished versus merely quiet**: quietness alone
is why `tidy` needs an accurate keep list, and finishedness is read from what the chat last
said, not from its clock.

**An idle chat refused while its neighbours work is now a bug, not the design.** The gate that
refuses is the content script's own `pendingTools`, refreshed on its activity loop; the count
`just say` prints is the app's, sampled once at the POST, so the two can disagree. Until
2026-09-10 `countFor` in `src/main/mcp/call-context.ts` charged a call with no `conversationId`
against **every** conversation, so two chats running `exec_command` back to back held a third
unreachable — and at fleet width one unplaced call was always in flight, which closed the
control path entirely (four repositories idle for ten minutes, no chat reachable, and no way
in: the gate cleared only when the workers it was waiting on finished by themselves). An
unplaced call is now charged only against conversations the app cannot observe to have been
quiescent when it arrived (`recorder.ts::mayOwnUnattributedCall`, §11), which is evidence
rather than a timer and leaves the compaction barrier's own chat charged exactly as before.
If an observably idle chat is refused again, read `inFlightCalls` off the refusal: an
`unattributed` row against an idle chat means the recorder never watched that chat's last turn
end, which is the fact to go and fix. Do not replace the chat — a replacement needs the same
send path, and the chat has real in-flight work — and neither dismissing the app's error notice
nor reloading the tab does anything.

**Most chat deaths are ChatGPT's, not this app's.** A steward watching several chats will see
them go cold one after another and reach for a local cause. Check who wrote the error string
first. "A network error occurred. Please check your connection and try again." and "Message
delivery timed out." appear nowhere in this repository — the extension read them out of
chatgpt.com's own DOM. Only "No visible progress for ten minutes. The turn is still marked as
generating." is ours, at `extension/content.js`, and it is a watchdog for a turn that stays
marked generating while nothing renders. A turn that never completes cannot emit a tool call
either, so a chat whose `tool_call` events stop is showing the same upstream stall, not a
separate broken connector. Replacement is still the remedy — a wedged conversation stays
wedged and a fresh one gets a clean turn — but do not go looking for a local defect to fix,
and do not read a run of these as this app degrading.

**A chat sitting on a rate limit is not dead, and reopening its tab will not free it.** The
limit arrives as a modal dialog whose only control reads "Got it", it leaves the Stop button in
place so the page still looks like it is generating, and it belongs to the conversation rather
than the tab — so a reopened tab shows the same dialog. The content script clears this itself:
dismiss, Stop, `Continue`, on a five-minute floor. Leave such a chat for a tick and push it on
the next. A chat still showing that dialog after two ticks means the recovery has regressed.

**Two chats showing that error in one tick is the account, not the chats.** Retry dispatch or pushes at stepped intervals: 30s, 1m, 2m, and 5m. Defer pushing or replacements to the next tick only when repeated rate limits persist across those retries. One chat can be limited while others run normally, so test whether any chat accepts a push before declaring an account-level block.

**Do not open several chats at once.** That is a burst of requests from one account and it earns
the limit described above, which then lands on the chats themselves. Recovery already spaces the
tabs it opens; a steward should space its own pushes the same way.

**Judge a wedge by the *kind* of row the clock moved to.** A push that moves the clock only to a
`page_tool`, a `chat_error`, or a turn ending without work has not woken anything. A `turn_start`
right after a push is alive. A chat that answers one push and refuses the next with an unmoved
clock is dead.

**The recording is the only evidence that a chat is still working.** A chat that has lost the
connector can still talk: it answers every push, reports progress, and describes work it never
did, because reasoning and writing fail separately. Its `tool_call` events are the proof, so
sample the newest one per chat each tick and compare them against each other — a chat at
forty-five minutes beside siblings at seconds is cold, whatever it says:

```bash
dir=$(grep -rl "<conversation id>" ~/.config/chat-on-steroids/sessions/*/meta.json | head -1 | xargs dirname)
grep '"kind":"tool_call"' "$dir/events.jsonl" | tail -1 | sed -n 's/^{"time":\([0-9]\+\).*/\1/p'
```

Never scan a recording with `jq`. Some contain an invalid surrogate-pair escape that makes it
abort mid-file, and with stderr hidden it then reports the newest call among only the lines
before the bad one — a healthy chat looks frozen for hours. Line-wise `grep` and `sed` read the
whole file. The confirming signature of a cold chat is consecutive `turn_start`/`turn_end` pairs
with outcome `unknown` or `failed` and no `tool_call` between them. A brand-new chat with no
calls yet is not stale, and neither is asking a chat to run a shell command to prove itself: it
answers from its own sandbox, and only the recording settles it.

**A worker polling a dead process defeats that test, so check the host too.** The one state
the recording cannot distinguish is a chat waiting on a long-running `exec_command` session
that has already been killed — by a daemon restart, or by the OOM killer on a loaded box. Its
calls keep flowing because polling *is* a call, the transcript stays specific and plausible,
and the progress figure it quotes is real but frozen. Nothing inside the chat can see that the
process is gone. So when a chat says it is waiting on a build, a hook or a test run, confirm
from outside that the thing exists — the process, and fresh writes to whatever it produces:

```bash
/usr/bin/ps -eo pid,etime,pcpu,args | grep -iE 'lake|lean|sage-eval|pytest' | grep -v grep
find <repo>/<build dir> -newermt '30 minutes ago' -type f | wc -l
```

No process and no new artifacts means the wait will never end. Tell the chat plainly — that is
external context it cannot obtain, not a hint about method — and say what the host looks like
now, so it does not relaunch a multi-thousand-job build into a machine that cannot carry one.

**`say`'s verdict is not evidence; the chat's clock is.** It reports failure whenever no receipt
arrives inside its window, and under the send gate above most pushes report refused and land
anyway. Always re-read `just chats` afterwards and judge by whether the clock moved. When a push
is genuinely refused, push a different chat in the same window: if that one moves into real work,
the bridge is fine and the gate is transient rather than the first chat being dead.

**Carry findings into the handoff, not just the task.** A replacement that has to rediscover
which corpus block is already promoted, or that a repository's commit gate reports a known
baseline of pre-existing errors, spends its first hour re-deriving what the dead chat already
knew. Read the transcript tail for what it established and put that in the message. Check
`git status` too: uncommitted work belongs to the previous owner and must be built on, and
untracked files it left are its work rather than debris.

Three things belong in every handoff and are cheap to establish. Name the timestamp of the
predecessor's last `tool_call` and say plainly that anything it claimed after that point is
unverified reasoning rather than landed work. List its scratch files in `/tmp` by name, since
they hold search work a replacement will otherwise repeat — and when two chats share a subject,
ownership of a file is decidable rather than guessable:

```bash
grep -l "<filename>" ~/.config/chat-on-steroids/sessions/*/events.jsonl
```

Name its long-running `exec_command` session ids as well. Those sessions outlive the
conversation, and `write_stdin` against one from a different chat is refused by the ownership
rule, so a replacement that inherits an id without being warned reads that refusal as a broken
tool instead of starting its own session.

**Two small traps in the surrounding tools.** `ps` on this machine is aliased to `exa`, which
rejects the flags a parent-process check needs — use `/usr/bin/ps -o pid,ppid,etime,args -p <pid>`
before deciding whether a CPU-heavy process is a chat's orphan or another session's test run
already wrapped in its own `timeout`. And `agent-memory sync status` carries a `last_failure`
whose vault path is under `/tmp/pytest-of-dzack`; that is a test fixture, not this vault, and it
does not mean a sync is broken.

**Two chats on one body of work will duplicate it.** When they share a task, tell each
replacement to check what has already landed and to reuse recorded audits; and when one chat's
transcript shows that a unit another was told to start is already done, send that correction to
the chat holding the stale instruction rather than letting it find out.

### Reading the fleet

Every mistake in this section has been made, and each one turned a working fleet into a
reported outage. They share a shape: the steward measured its own machinery and reported
the answer as a fact about the work.

**The fleet's output is in the repositories, not in your outbox.** Whether a push landed
says nothing about whether the program moved. `git log --all --since=...` in each managed
repo is the measurement, and it is two seconds away. On 2026-09-10 a steward reported "no
file written in any managed repo for ten minutes, no commits for twenty" and declared an
app-wide deadlock; `new-qual-site` took eight commits in that exact window, seven of them
on `main`, and they were solved algebra problems and recovered analysis proofs. The
workers were fine. What had stopped was the steward's ability to push, and it never
checked the difference. **"I cannot reach a worker" and "the fleet is stopped" are
different claims and need different evidence.**

**Never tell a worker its process is dead on the strength of missing artifacts.** The
liveness test is the process, and specifically whether a child's cumulative CPU is
advancing between two samples — not whether files have appeared. Long stages write
nothing for many minutes: a Lean exporter or axiom audit can run for the better part of
an hour with zero writes under `.lake/build` while doing real work. On 2026-09-10 a
steward saw no artifacts in five minutes, told a worker its build was gone and to stop
re-running it, and the build was in fact alive and had simply moved to a stage that
writes nothing — the message was a instruction to abandon work in progress. Sample
`/usr/bin/ps -o pid,times,pcpu --ppid <pid>` twice, twenty seconds apart, and read
`times`; only "no process at all" is death. **And a false statement to a worker has to be
retracted immediately and confirmed landed** — it will act on the wrong fact within one
turn, and the chat is usually busy doing exactly that, so the retraction must be retried
until it delivers rather than left for the next tick.

**Archive a conversation the moment it stops being a managed stream.** Every replaced
worker, retired duplicate, failed launch and one-off probe stays in the owner's ChatGPT
sidebar forever unless somebody archives it, and a day of stewarding produces dozens.
They are not only clutter: a steward reading `just chats` has to tell live streams from
dead ones on every tick, and a dead chat that still answers is exactly how duplicate work
starts. `just archive <full conversation id>` takes a chat whether or not it has a tab
open and is reversible, so there is no reason to defer it. Archive as part of the same
action that ends the stream — when you launch a replacement, archive the predecessor;
when a launch fails and leaves an empty chat, archive it then — rather than letting a
cleanup pass accumulate. On 2026-09-11 the sidebar held thirty-six conversations of which
eight were live.

**A send batch the harness kills is not a failed send.** Under memory pressure the
steward's own shell gets killed mid-batch, so the terminal states for the remaining
pushes never print — and on 2026-09-11 that happened three times in one hour while every
one of those chats went on to move its clock. Read the outcome from `just chats`, never
from whether your batch survived to report it. The corollary is to keep batches small
when memory is tight: a batch of six serial sends holds a shell for ten minutes and is a
fat target, where two batches of three usually both survive.

**Count the browser's tabs every tick; they accumulate and they degrade the control
path silently.** Tab count is a substrate metric like disk and load, and it is the one
that presents as chat trouble rather than as a browser problem. As it climbs, sends
start returning `expired` and `no_live_composer_tab` — *"ChatGPT never exposed a usable
composer for bootstrap"* — and `just new` stops working, so replacements cannot be
launched exactly when wedged chats make them necessary. On 2026-09-10 it reached 47 and
every new-chat launch failed; hours later it reached 100 and sends were expiring across
the whole fleet. Restarting `chat-on-steroids-browser.service` clears it, costs nothing
that is not recreated on demand, and on both occasions the next send landed immediately.
Read it with the CDP endpoint rather than `just tabs`, which only matches `/c/` URLs:

```bash
curl -s -m 8 http://127.0.0.1:9222/json | grep -c '"type": "page"'
```

**Check the substrate before you blame the app.** `df -h`, `uptime`, `/usr/bin/ps` — a
few seconds, before any theory about attribution tiers or gates. A full volume does not
present as a disk error; it presents as killed processes, dying `exec_command` sessions
and workers that look like they have gone stupid, and it reads as worker misbehaviour for
hours until somebody runs `df`. In the same 2026-09-10 window a worker committed
`docs: clear resolved filesystem blocker` while the volume filled from 27 duplicated
worktrees, and the steward diagnosed an attribution deadlock instead. The
cheapest check that could refute your hypothesis goes first, not last.

**You are inside the system you are measuring, and your remedy is part of the load.**
Every send opens a command tab and counts against every chat's gate, so pushing harder
into a saturated fleet produces fewer deliveries, not more. If your corrective action
makes the symptom worse, stop treating the symptom as external. The steward that filed
the deadlock complaint had written exactly this mechanism into the header comment of its
own push loop, and left the loop running.

**Queued is not failed.** A send that ends in state `queued` is held by the app and typed
when the page's in-flight calls settle. Re-sending stacks a second queued message for the
same chat and consumes the gate the first one is waiting on. Read the terminal states —
`sent_verified`, `typed_unverified`, `refused`, `expired` — and treat everything else as
in progress. The same applies to `just say` printing a hint and waiting: that is the app
working, not the app stuck.

**"There is no way in" is nearly always false; enumerate what you still have.** You have
a shell. You have every read-only route on the bridge (`/conversation/status`,
`/sleep/status`, `/send/outcome`), every managed repository's git history, the process
table, and the disk. A steward that concludes it is locked out has usually stopped at the
first closed door — the composer — and not looked at the room. Before escalating a
control-path failure, state which of those you checked and what they said.

**A rule reaches workers only where workers read.** Fleet-level documents in this
repository are read by the steward and by nobody else. A worker follows its own repo's
`AGENTS.md` and `CONTRIBUTING.md`, and if those say something different, that is what
happens — regardless of how many times the rule was explained in chat or written into a
schedule here. `new-qual-site` rebuilt 27 worktrees and filled the volume while the
no-worktrees rule sat in `FANOUT-SCHEDULE.md`, because its own `AGENTS.md` still carried a
`# Worktrees` chapter telling every stream to open one. **And a rule that has already been
restated once needs an enforcement point, not a third restatement** — a check in that
repo's commit gate, so the next stream that violates it finds out at its next commit
instead of at 100% disk.

### Check-in reports

At each check-in (every twenty minutes), report the status of each managed repository workstream
directly in chat:
- Current local time and anticipated time of the next scheduled wakeup.
- **The repository's tracked surface**: what its own queues, TODO checkboxes or generated
  counts say about progress since the last check-in. This is the first cell because it is
  the repository's own belief about whether the work is advancing, and it is the one that
  exposes a stream doing the wrong work correctly.
- **Commits landed since the last check-in**, read from `git log --all` — `--all` because
  a worker on a branch is invisible without it — never inferred from whether your own
  pushes succeeded.
- **The worker's own last sentence**, quoted or closely paraphrased from its transcript,
  not the row kind from `just chats`. "page_tool" and "turn_end completed" are not
  activity summaries; "the child Lean process has advanced" and "the sole owned range
  remains complete" are, and the difference between those two is the whole job.
- How long ago that activity occurred.
- Free space on the volume, whenever any stream looks degraded.
- The decision on what to do with it (allow it to continue, inject continuation prompt, determine
  if wedged, orchestrate manual handoff, tidy tabs, etc.).

A report whose activity column contains row kinds rather than the worker's own words was
written without reading the transcripts, and is not a check-in. The three reads are the
tick; the table is only how they are reported.

**The report is written after the tick's actions, and describes what is now true.** It is not
a plan and it is not a queue. No cell in it may name a future intervention: "will replace next
tick", "watching it", "judging it on the next commit", or `continue` against a stream that has
written nothing — each of those is a remedy that should already have been executed by the time
the report is composed. A row for a stream that is not producing must carry the remedy run
*this turn* and which of the three rungs it reached; a row that reached rung 1 or 2 is an
escalation still in flight, not a status, and the turn is not over. The decision column exists
to record what was done, not to schedule it.

Keep the report concise. Additionally, escalate immediately if there is: a decision the user alone
can make; a fault in this app or another repository that the watch cannot fix; a policy breach, such
as a commit made with `--no-verify`; or an error of the watcher's own that changed what happened.


### The job here is delegation and continuation

That is the whole role, and its boundaries are hard:

- Do not judge the work for completeness.
- Do not step in and do the work.
- Do not pull repository detail into your own context to check theirs, outside the bounded
  hourly sweep below.
- Do revise their documents. That is the exception, and it is the steward's own hands — see
  the next paragraph but one. The ban is on doing a worker's *work*, never on writing the
  rules the worker reads.

**Neither the steward nor its subagents are the worker on any managed repository.**
Dispatching a subagent into a managed repo to merge branches, resolve conflicts or
repair its data is the same violation as doing it yourself — it just spends different
tokens. The steward may step in briefly to clear a blocker that stops every stream at
once and cannot be delegated; everything else, including work the steward discovered and
understands perfectly, goes into that repository's own queue or TODO and is assigned to
its worker.

**The documents are the exception, and they are the steward's own hands.** Every rule a
worker follows lives in its repository's `AGENTS.md` and `CONTRIBUTING.md`, and writing
those is not repo work delegated downward — it is the whole substance of orchestration.
A steward that discovers a failure mode and hands the doc edit to a subagent has
delegated the one thing it exists to do, and has usually done it because the finding was
fresh and writing it up felt like overhead. Write the rule yourself, in the repository
where the worker will read it, in that repository's own voice. Pair it with an
enforcement point in that repo's gate when the rule has already been restated once and
ignored; a third restatement is not a remedy. Check first whether the rule is already
there — a doc that has already been corrected needs verifying, not rewriting.

**Steward writing is meta-work, and every managed repository documents a route for it.** When the steward edits a repository's `AGENTS.md`, `TODO.md`, queue files or complaints, it is not contributing that repository's code and the full commit gate is not the applicable standard. Each of these repos already says so in its own words — `new-qual-site` calls it "the authorized docs-only route" and names `--no-verify` outright, `sage-categories` says "a docs-only edit runs no repository verification", `research` makes it `DEV-58`'s prose-only exemption. Find that rule before committing, and cite it in the message.

The failure to avoid is fighting a gate that was never aimed at your change. On 2026-09-11 a steward spent several attempts and two dead-end diagnoses trying to land a queue-metadata edit through `new-qual-site`'s full commit gate, which was failing for a reason unrelated to the edit — a sibling stream's staged corpus file tripping a hook that stages inside `pre-commit`. The repository's prose route, four lines in its own `AGENTS.md`, would have landed it immediately. Inspect the diff, confirm it is documents only, take the route the repo names.

This is not licence to bypass a gate on repository code, and it is the opposite of the known-red habit: the point is that a *different* standard applies to documents, not that the standard is optional. A steward commit that touches code, data or a card takes the ordinary gate like anyone else.

**Never build a path around this app's own send path.** Typing into the page over CDP
delivers a message and bypasses everything the app does with it: no entry in the send
registry, no `sent_verified`, no sleep cycle armed, and no `push_correlated` attribution
binding. In 2026-09 a steward built exactly that as a "fallback" while the app path was
refusing under the unattributed-call gate, and the bypass then guaranteed its own
necessity — every push it delivered was a push that bound no key, so the gate never
opened, which was cited as the reason to keep the bypass. The fleet stayed unattributed
for a day because its recovery tooling was routing around the mechanism that would have
fixed it. If `/send` cannot deliver, that is a defect to file against this repository
with the terminal state it returned. It is never a reason to type into the page.

**The steward is an agent in a session. Never replace it with a loop.** Using `/send`
correctly is not enough: a `while true` that pushes a fixed string into every idle chat
uses the sanctioned path and still bypasses the whole workflow, because the thing being
bypassed is the *judgment* between pushes. A steward reads what a worker said, decides
whether it is finished, stuck, wrong, or asking for something, and sends the message that
situation needs. A loop cannot do any of that and does not know it cannot.

One was found on 2026-09-10 after running seven hours: `steward-loop.sh`, `sleep 20`, the
literal word `Continue` to every chat `just chats` did not report busy. Its parent was
PID 1, so it had been detached from the session that made it; its script and log had been
moved to Trash, so that session had tried to clean up and the process outlived the
cleanup. Nothing could stop it, nothing was reading its output, and it went on driving the
fleet long after its author was gone.

If a stream needs feeding on a cadence, that cadence is a scheduled *agent* turn, not a
detached shell process. A loop that survives its session is unattended automation nobody
owns: it cannot be corrected, it cannot notice it is wrong, and killing it is the only
control anyone still has over it.

**Treat the disappearance of your own tooling as a signal, not an accident.** A steward
whose scripts vanish should find out who removed them and why before recreating them —
the same rule that applies to every other artifact of unknown provenance. Restoring a
deleted bypass within the minute, without asking, is how a correction gets undone
faster than it can be made.

**Anything that "needs a decision" is a task to file, not a question to ask.** A red
gate, an unmergeable branch, two competing proofs of one card, a corrupted artifact —
these are work items for the repository that owns them. File them in that repo's queue
with the evidence and the acceptance condition, and point a worker at it. Escalate to
the owner only what no worker in any repo could act on: resourcing, authorization,
external accounts.

**Never report your own failures in chat. Record them here instead.** A steward is an
LLM: this session ends and takes every insight in it with it, so an account of what went
wrong, however candid, teaches nothing and changes nothing. It produces the appearance of
learning while the same mistake waits intact for tomorrow's session, and it spends the
owner's attention on a confession they cannot act on. The honest response to discovering
your own error is a commit to this file — the rule that would have prevented it, written
so the next steward reads it before repeating it. Then say what the fleet's state is.
Correct a factual claim the owner is currently relying on, in one line; everything else
about your own conduct goes in the doc or nowhere.

**Do not discuss repository internals in the orchestration chat.** This session holds no
repository's context, so card ids, merge conflicts, YAML defects and file paths are
noise here and read as word salad however carefully they are written. Report at the
workstream level — which repositories have a worker producing, which are stuck, which
have run out of scope, and what was dispatched. The detail belongs in the repo, in
front of the agent that can act on it.

Point, send, and continue until the task is done, the chat is wedged, or its context is full.

**Set your own wakeup timer before anything else, and confirm it exists.** A steward
runs on a twenty-minute tick, and nothing produces that tick for you: without a
scheduled job the watch advances only when the owner happens to say something, and the
fleet silently runs unattended in between. On 2026-09-10 a watch went twelve hours
between checks that way while a repository sat wedged — the steward believed it was on
a cadence it had never actually created. The first action of any watch is to schedule
the recurring check-in and then list the scheduled jobs to see it there; an intended
cadence is not a cadence. Jobs are session-only, so a steward taking over an existing
watch must schedule its own rather than assume it inherited one.

**Judge banking cadence against the repository's own gate, not a clock you carry
between repos.** A commit costs what that repo's gate costs, and they differ by orders of
magnitude: a card repo commits prose in seconds, while lean-categories runs an aggregate
build and audit chain that has been measured at eighty-seven minutes and holds
`.git/index.lock` throughout. Ninety minutes without a commit is a stall in the first and
a single gate cycle in the second. On 2026-09-11 a steward had a lean worker one read
away from replacement on exactly that arithmetic — no commit in ninety minutes, no writes
in twenty — when its transcript showed it had passed a focused build and was clearing a
lint warning before entering the full gate. Before concluding a worker is not banking,
find out what a commit costs where it is working, and read what it last said it was
doing; replacing a worker mid-gate throws away the hour it has already spent.

**Read three things every tick, and read them in this order: the repository's tracked
surface, its recent commits, and the worker's own last message.** The chat's `idle` or
`busy` state is the weakest signal available and it is the one a steward reaches for
first, because it is cheapest. It answers "did my push land", not "is the assigned work
advancing", and those come apart constantly. What the tracked surface says — queue counts
ticking down, TODO checkboxes moving, the unsolved file regenerating — is what the
repository itself believes about progress. What the commits say is what actually landed.
What the worker last said is what it thinks it is doing, and it is the only one of the
three that catches a worker doing the wrong work correctly.

On 2026-09-11 a stream answered every push for five and a half hours with the same
sentence — "the sole owned range remains complete" — because a re-scope had never taken.
Its clock moved on every push, its state alternated idle and busy exactly like a healthy
stream, and its repository's queue sat unchanged the whole time. Any one of the three
reads would have caught it in the first twenty minutes; the state check never would,
however many times it was repeated.

**An empty execution graph is not an empty backlog — unfolding the backlog into it is
the work.** Repositories that track through a DAG, a node list or a dependency graph show
zero ready nodes in two completely different situations: everything is genuinely done, or
the outstanding obligations have not been expanded into nodes yet. The second is far more
common and it reads identically from outside, so a steward that counts checkboxes will
report a finished repo while its plan still carries unclaimed work. When the graph is
empty and the plan is not, the next task *is* the unfolding: take the outstanding
obligations from whatever owns them — the approved plan, the issue tree, the prose
sections the graph defers to — and expand them into nodes with dependency edges, then
work the frontier that appears. A worker sitting idle because "there are no ready nodes"
has mistaken the absence of a map for the absence of territory, and the steward's job is
to say so rather than to record the repository as complete.

**An idle worker is either stuck or finished, and those take opposite actions.** `just
chats` reports both as `idle`; nothing in the state distinguishes them. Read what the
chat last said before pushing. A worker that is stuck says what it is waiting on; a
worker that is finished says so plainly — "all unsolved Algebra cards have been
completed and committed", "there is no remaining TODO in the collection-defined scope
for this stream" — and pushing `Continue` at it returns "nothing further to execute
within the assigned scope" for as long as you keep asking. That is not a stalled chat
to nudge, it is a finished one to re-scope or retire, and treating it as the former
burns the stream and reads as a fleet-wide stall that is really a planning gap.
Retiring means archiving it and closing its tabs in the same tick you conclude it is
finished — a finished chat left open costs browser memory indefinitely, and it keeps
inflating the roster so the next stall hides behind a stream that stopped producing
hours ago. Re-scope it or archive it; leaving it idle is neither.

**Never leave a worker asleep or idle.** A sleeping or stalled chat produces zero progress; nothing restarts on its own. The steward does not wait for work to begin spontaneously. When a worker finishes a turn, stalls, or dies to an error (such as a delivery timeout), the steward must act immediately: push `Continue` if viable, or launch a replacement with `just new` and a brief handoff.

**Do not invent phantom constraints or delay dispatch on hypothetical risks.** Never delay replacing or continuing an idle worker out of speculative worry about rate limits, bursts, or unobserved barriers. Act on observable state: if a worker is asleep, dispatch its continuation or replacement immediately. Address limits only when an actual error or throttle arrives. If rate limits are hit, retry dispatch at stepped intervals: 30s, 1m, 2m, and 5m. Defer until the next tick only when repeated limits persist across those retries.

**Do not dig into a managed repository's specifics to perform its orchestration.** Inspecting source files, internal status ledgers, git history, or memory vaults to decide domain-level work violates delegation. The managed chat owns the work and the traversal in its repository; the steward only provides the ambient pointer and maintains momentum.

**Do not muddle prompts by dictating methods or synthesizing procedural checklists.** Point the worker directly at the task and instruct it to proceed through the repository's existing TODOs, plans, or guidelines (e.g. `"proceed through the repo todos"`). Never inject procedural micromanagement—such as detailing step-by-step loops to inspect files, execute test suites, or structure commits. The managed chat is a frontier reasoning agent; its repository's own artifacts already establish standards and execution flow. External step lists constrain the model, degrade its autonomous traversal, and lead to premature halting.

**An intervention is a receipt; only worker state is evidence, and only a repository write is proof.** This applies to every recovery action without exception — pushing `Continue`, running a nudge script, closing and reopening a tab, activating a renderer, launching a replacement, or any custom machinery the steward builds. What the action's own output reports (`nudged`, `already_generating`, `sent`, `delivered`, a clean exit code, the DOM's appearance at click time) is a receipt from the steward's process, not an observation of the worker. Worker state — clock advancing, real `tool_call` events flowing — is the second rung and proves only that the chat is alive. The third rung, a file changed or a commit landed in the managed repository, is the one that means work restarted; see [What a tick is for](#what-a-tick-is-for). Status tables and check-in reports may contain only state observations in their state columns — never intervention receipts — and "all N running" may be asserted only from N fresh state observations, never from N dispatched actions.

**Verify every recovery action on a 30–90s horizon; never bridge to the next tick.** The 20-minute check-in is purely a reporting cadence to the user, not an operational sleep timer, and an unverified intervention earns no grace period from it. The asymmetry is decisive: verification costs 30–90 seconds (live turn gaps run 8.2s median, 26s p90 — inactivity past 90 seconds is a stall), while a wrong success assumption costs the full 20-minute tick per stream, which is exactly how measured fleet duty cycle collapses. So after any recovery action: wait the short horizon, read the next rung up, and only then either move on or escalate — probe the browser, kill frozen tabs, launch a fresh replacement with `just new` and a clean handoff. Escalate on each rung that fails to arrive; a recovery is closed only when the repository has been written to. When an intervention fails, the next step is observing the worker and escalating, **not debugging the intervention tooling**: rewriting nudge scripts and installing libraries while the worker sits unverified is effort substituting for effectiveness — fix the machinery only after every stream is verifiably executing or has a replacement dispatched.

**Recovering a stalled worker is a call to the app's send path**, which owns the browser behaviors that make a send land: it activates the tab before typing (a background tab reports its send button enabled, no-ops the click, and leaves a draft that wedges the next send), selects the live tab among the two or three the browser holds per conversation, recycles a frozen one, resolves any pre-existing draft by authorship, and reports success only on a fresh `turn_start` in the recording. Send, then read the outcome — `sent_verified` is the evidence, and the typed refusals name their own next action.

**Check that the partition still covers the work before adding streams.** A fan-out
plan names scopes, and scopes run out. new-qual-site was fanned to eight streams against
a partition naming eight collections out of the 392 in its corpus: the streams finished
their assignments and went quiet with 3,232 unsolved cards sitting in collections nobody
had been given. Stream count was never the limit and adding streams would not have
helped. When several workers in one repository go idle near each other, suspect an
exhausted partition before suspecting the workers, and measure remaining work against
the whole corpus rather than against the slice the plan happened to name.

**Measure output where the work lands, not where you expect it.** Counting commits on
`main` is only a throughput measure if the workers commit to `main`. When they work on
branches, `main` undercounts the fleet by however much is unmerged — here, about 1,800
commits of finished solutions — and the steward reads a productive fleet as a failing
one, or the reverse. Check what is unmerged (`git rev-list --count main..<branch>` across
every branch) before believing any number derived from `main`.

**Track task DAGs and saturate parallel workflows.** Track the basic DAG of tasks in each managed repository (identifying decoupled workstreams, independent chapters, isolated problem collections, or non-overlapping module targets). When a repository's task structure permits parallel work without coordination deadlocks or merge collisions, increase the number of active managed worker chats under that repository to saturate throughput rather than running independent branches serially.

**Dispatch immediately; never narrate a ready action.** When analysis reveals a dispatchable parallel path, a completable continuation, or a launchable replacement, execute it in the same turn. Do not report it as "ready," "identified," or "available" and wait for the user to authorize it. The steward's role is autonomous momentum. Describing a possible action instead of taking it is pure spectator behavior — it consumes a turn, produces zero progress, and forces the user to re-issue an instruction the steward already had all the information to execute.

**Instruct fresh agents to read AGENTS.md / CONTRIBUTING.md and log to COMPLAINTS.md.** Any new or fresh agent launched across any managed repository must always be instructed to read `AGENTS.md` and `CONTRIBUTING.md` before writing any code, and to file any issues, deficiencies, papercuts, tool friction, or setup blockers in a `COMPLAINTS.md` file in that repository before or during their work.

**Red gate means stop — where gates are part of the repo's contract.** In repositories whose workflow runs commit gates, hooks, or QC stages, the first time one goes red the worker's current task becomes diagnosing that failure. Workers must not keep authoring behind a red gate or accumulate uncommitted work around it — root-cause and fix, or report the blocker. A steward who observes a worker committing nothing while its tree grows must treat that as a wedged worker and intervene with a pointer to this rule, exactly as it would a stalled chat. This rule does NOT apply to repositories under a declared deferred-verification contract (e.g. research's DEV-58 phase-T policy, where all refactor work commits with `--no-verify` by design): there, gates are deliberately off, and diverting a worker into hook-passing or type-check golf mid-refactor — polishing files slated for deletion — is itself the failure mode. Stewards must never chase such workers back into running standard gated commits; those workers address real defects observed in the work itself and otherwise keep landing the refactor.

**Gates belong in tiers, and a transcription repository's commit tier is the wrong place for a hard one.** The rule above is about a gate that is part of a repository's contract; it is not a licence for every check to sit on `git commit`. For the corpus repositories — a book formalized into Lean, a problem bank written up, a framework transcribed — the scarce thing is mathematics reaching the tree, and gating each commit on whole-repository coherence directly obstructs it: a worker who writes a definition referring to something not yet transcribed cannot bank the work at all, so it sits unbanked in exactly the state `LC-04` and its kin forbid. Three tiers, three different questions:

- **Commit** is a sanity check. Does it parse, does it follow the conventions, did the unit get its ledger entry — the things the author forgot or overlooked, caught while the fix costs seconds. Cheap, and it must not demand that the repository elaborate or build as a whole.
- **Push** carries the hard work: full build, whole-environment audits, no placeholders. Paid once per batch rather than once per declaration.
- **Contribution** is the promise to anyone outside — coherent, compilable, defensible. That one never moves.

Reworking a corpus — repairing owners, consolidating duplicated notions, fixing mappings later found wrong — is a triage phase at the end of a transcription milestone, not something interleaved with transcription. Interleaving it is what turns a sweep into an unbounded refactor, and is the usual reason a sweep runs for days without closing a unit.

**Tier by what the check costs and how far its failure spreads — not by repository type.** The split above is right for `lean-categories` for two specific reasons, and both have to be checked before it is applied anywhere else: the check was expensive (a 24-minute median), and an incoherent intermediate state is *local* — a half-transcribed definition harms nothing but itself until the sweep closes. Invert either and the answer inverts. `sage-categories` is the case in point: its full commit tier measures **62 seconds**, and it is code other agents read and imitate, so an ill-typed construction does not stay where it was written — the next worker copies the pattern from a neighbouring module and it becomes the house style. A cheap check against a compounding failure belongs on commit and should fail there every time. Telling that repository to defer its static gate was a mistake I made by porting lean's answer to it (corrected in `a88bf69`).

So: expensive check, local failure → push tier. Cheap check, propagating failure → commit tier. The repository being a corpus does not decide it.

A steward reading a red gate therefore has to ask which tier it is on before calling anything wedged. A worker banking behind a red *commit* gate in a repository built this way is working correctly. A worker that cannot push, or whose tree grows while nothing is banked anywhere, is the one to intervene on. `lean-categories` measured this: splitting the tiers took its commit gate from a ~24-minute median to 23 seconds (`8a31f94`).

**A gate red for days is a worse signal than a gate that is slow, and it is the one a steward misreads.** A check that always fails informs nobody — it cannot distinguish the commit in front of it from the hundred before — so workers learn to annotate past it and the repository loses the defence entirely. The tell is in the commit subjects: when a standing tag like `[known red: ...]` appears on most commits, that is not a repository with a known issue, it is a repository whose gate has been switched off by convention. `sage-categories` reached 25 of 41 commits in a day that way, against 457 accumulated lint errors nobody owned. Read it as an outage, not as housekeeping: the fix is paying the debt to green, and it is usually bounded — 417 of those 457 were auto-fixable. Every worker who inherits a red gate and annotates past it has made the next worker's case for doing the same, which is how "pre-existing" becomes permanent.

**One front at a time, closed to acceptance.** In repositories organized around a dependency DAG or ordered queue, workers take exactly one node in plan order and drive it to its acceptance criteria before opening another. Shared-substrate edits are in scope only when the current node's spec requires them. A steward who observes multi-front breadth with no closures dispatches a corrective continuation naming the nearest-to-acceptance node.

**Claim state stays fresh; no off-ledger work.** In repositories with shared queues or claim ledgers, workers reconcile the queue against actual repository state (all branches) at every claim and record every release before moving on; work without a live claim, and batch-committing work authored off-ledger, are prohibited. A steward who observes duplicate solving or unclaimed diffs points the worker at the repository's claim protocol rather than resolving the duplication itself.

### The failure modes to police, and the hourly sweep

Managed workers author well but bank poorly: the recurring losses are not in the quality
of the work but in the loop between doing work and landing it as verified, tracked,
coordinated state. Five failure modes account for nearly all of it. Each has an
observable **state signature** — detected from repository state (plan files, git refs,
timestamps, mtimes), never from transcripts, which explain causes but do not measure
anything:

1. **Blocker tolerance** — a worker routes around an obstacle instead of diagnosing it.
   Signature: the working tree grows while commits stop; a gate or hook is red across
   consecutive attempts; a started refactor sits half-applied and unclaimed.
2. **Breadth without closure** — real work spread across many plan fronts, none driven to
   acceptance. Signature: diffs touch several DAG nodes while the formally tracked plan
   surface (TODO/DAG checkboxes, queue counts) does not move.
3. **Stale coordination state** — parallel workers act on unreconciled shared state.
   Signature: the same card/node solved on two branches; a queue still listing items
   another branch already closed; files from one workstream dirty in another's worktree.
4. **Observability decay** — repository state stops reflecting the work. Signature:
   batch commits landing many hours of work in minutes; changes uncommitted for hours on
   a stalled branch; placeholder author identities; deferral tags (`[unverified]` and
   kin) with no named discharge contract.
5. **Idle capacity** — hours-on-task, not pace, is the loss. Signature: no writes for an
   extended stretch in a repository with open plan nodes and a live worker attached.
6. **Waiting on a dead process** — a worker blocks on a long-running `exec_command`
   session that has already been killed, and cannot see that from inside the chat, so it
   polls forever and reports itself busy the entire time. Signature: the chat emits rows
   and describes a build, hook or test it is waiting on, while no such process exists on
   the host and the artifacts it would write have not changed. This is the most expensive
   mode in the catalogue because every surface a steward normally trusts says the worker
   is fine: the clock advances, the transcript is coherent and specific, and the named
   progress figure is real — it is simply frozen. It cost lean-categories a full working
   day in 2026-09 waiting on an aggregate build stopped at 4760/4761 that no longer
   existed. Daemon restarts kill every exec session, and so does the OOM killer on a
   loaded host, so suspect it after either. **A full volume produces the same signature
   and is the easiest cause to miss**: it kills processes mid-run and leaves no disk
   error anywhere a steward looks, so the fleet presents as a dozen misbehaving workers
   at once. It also strands a `.git/index.lock` from whatever git process it killed,
   which then refuses every commit in that repository until someone proves it stale and
   moves it aside. Check `df -h` before concluding anything about a repository that has
   stopped banking — it costs one command and it is the difference between re-scoping a
   fleet and replacing workers that were never at fault. Nothing self-heals here, which is why it runs
   for hours: the chat is *busy*, not stalled, so the content script's own Stop-and-
   `Continue` recovery never fires, and any steward loop that pushes only what is idle or
   stalled will never target it either. The composer refuses to type while a turn is in
   flight, so the only way in is to press Stop first — which costs nothing, because the
   turn being stopped is a poll of something that no longer exists.

**Every hour, sweep every managed repository for these signatures.** The sweep is
state-level and cheap — `git log`/`status` timestamps across branches and worktrees,
plan-file deltas, queue files cross-checked against solved state, mtimes — and it is the
sanctioned, bounded exception to the rule against digging into managed repositories:
it inspects only the signatures above and never judges domain content. Respect each
repository's own contract while sweeping: a deferred-verification repository (research's
DEV-58) has no gates by design, so signature 1's gate clause does not apply there.

**On evidence, dispatch a corrective subagent — never rely on a steward message.**
Chat messages to workers are ephemeral and get forgotten; the durable enforcement layer
is each repository's own documentation. The dispatched subagent's remit is to repair the
managed repository's own surfaces so the failure mode is prevented in-repo: amend its
`AGENTS.md`/`CONTRIBUTING.md` rules where they were silent or ambiguous, fix the queue or
claim tooling that allowed staleness, repair the gate or hook that was wedged, and
checkpoint or quarantine stranded state. Only after the repo's own docs carry the rule
does the steward act on the live worker — and then only by routing it into those docs
(`"re-read AGENTS.md before continuing"`), never by restating the policy in the prompt.
The orchestrator's lever is routing agents into each repository's own documentation;
policy that lives only in orchestrator messages does not exist.

### One worker per repository

A managed repository gets exactly one worker at a time. Parallelise across repositories,
never inside one. This is not a throughput preference and it is not softened by giving the
two workers disjoint directories: a git checkout has one index and one working tree, so
neither worker can hold a lock the other knows about, and a pathspec commit still captures
whatever else is sitting in that path. The losses on record are a reset tree that destroyed
21 authored solutions under a live worker in `new-qual-site`, and three workers in this
repository whose commits were swept into each other's until the messages stopped describing
their contents.

The steward violates this by accretion rather than by decision: a stream is replaced but the
old chat keeps a tab, a second is launched for a scope the first was not covering, and a
third survives from an earlier fan-out. So count workers per repository every tick, from
`just tabs` grouped by the repo each chat is working, and archive down to one. A retired
chat must be archived, not merely left unpushed — an unarchived chat is still a worker
someone can wake.

Collapsing to one worker means the survivor must carry the whole queue. Hand it the full
sequence in order rather than the current stage, so it moves from one to the next without a
push; a worker that stops between stages to be told what is next is idle capacity that the
one-worker rule would otherwise have created. `just unarchive <chat>` brings one back if the
count was cut wrong.

### The fan-out schedule — `FANOUT-SCHEDULE.md`

[`FANOUT-SCHEDULE.md`](./FANOUT-SCHEDULE.md) at this repo's root is the canonical
parallelization plan for the managed fleet: per-repository target stream counts, the
claim partitions that make streams collision-free, the preconditions that must hold
before fanning out, and the **unlock triggers** — DAG events (a node accepting, a
sweep closing, the rack migration landing) that change how wide a repository can go.
It operationalizes the "Track task DAGs and saturate parallel workflows" directive:
saturation targets live there, not in steward judgment calls.

How stewards use it:

- **Spawn to the schedule.** When a repository is below its target stream count and
  its preconditions are met, launch workers to match — one worker per partition slot,
  each pointed (per the fresh-agent directive) at the repo's own docs and its assigned
  claim scope. Never exceed a repo's stated cap: every width number is bound by a
  named constraint, and exceeding it recreates a documented failure mode. **Space the
  initial launch requests at least 10 seconds apart** — firing a fan-out as a
  simultaneous burst trips rate limiting; the stagger is invisible against
  hours-long streams. (This spacing is for the kickoff burst only — it does not
  license delaying continuations or replacements, which remain immediate per the
  no-phantom-constraints directive.)
- **Watch triggers in the hourly sweep.** The failure-mode sweep already reads each
  repo's plan surfaces; while there, check the schedule's unlock triggers. When one
  fires, adjust stream counts per the schedule's post-unlock section and dispatch a
  subagent to update `FANOUT-SCHEDULE.md` to the new state.
- **Keep it current.** The schedule is a living document owned by the steward, on
  `main` like everything here. When measured velocity, a re-planned DAG, or a fired
  trigger invalidates a section, update the schedule in the same turn the change is
  observed — a stale saturation target misroutes every subsequent spawn. Per-repo
  claim protocols stay in each repository's own docs; this file holds only the
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
