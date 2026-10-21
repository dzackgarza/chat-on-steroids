# Chat On Steroids — the agent map

The single orientation document for this repository. Read it before changing anything.

**How to use it.** §1–§3 is the mental model; read those once, in order. §4 is "where is the
thing". §5–§17 is one section per subsystem, each with the same shape — what it owns, its
files, its flow, **what must hold**, how it fails, which tests cover it. §18 is the fastest
entry point when you have a symptom and no theory. §19–§22 is how to work here. If you are
here to stand the watch over the managed fleet rather than to change this app, **§19's
"The steward's job" and the sections after it are the whole of it.** Each lesson there
is stated once; the dated incidents behind them are evidence in `docs/steward-incidents.md`, and
a steward never needs to read that file to act correctly. A replacement chat in this repository
must read every line of this file before it may act (the owner-requested rules gate,
`src/main/rules-gate.ts`), so every line here costs every replacement chat. Put evidence in the
incident file, not here.

**One file, complete.** This replaces the old `AGENTS.md` + `agent.md` split, which
duplicated roughly 60% of its content and had already drifted between copies. It is sized
for completeness rather than for any tool's default project-document budget; if your
harness truncates long project docs, raise its limit rather than cutting this down.

Because a truncated tail would drop §19 first, the one rule whose loss is irreversible is
repeated here: **this tree is usually dirty and shared with the user and other agents —
never `reset`, `checkout`, `clean`, reformat, or overwrite work you did not do.**

The second rule whose violation destroys the product is repeated here for the same reason:
**never neuter this app to restrict or control agent behaviour automatically.** It is an
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
decisions with that capability is corrected at the decision, by the steward (§19, "An
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

`workstreams.ts` owns durable exclusive claims for every logical workstream. Admitted tool
calls renew the five-minute lease; running calls hold it open. Lease expiry alone never
starts revival or replacement. The steward diagnoses stalled work from the actual task,
tool results and browser state. An intentional pause resumes the same holder without
inventing activity or treating the wait as a failed conversation. A new claim
invalidates the old opaque token and cancels pending recovery; retained terminals owned by
the old claim are stopped and already-admitted old calls must settle before successor
execution. Browser polls and replayed observations are not activity. The app's own
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
A brief that states what is already done is acceptance evidence the new chat will act on, so
take it from the repository's record (commits by path, the node's own ledger), never from the
old chat's prose: on 2026-10-02 a brief saying a copy pass "has read algebra, analysis,
topology" meant wiki pages, and the replacement closed the node with 1,600 corpus cards unread.
Name the ongoing task, never "the next" unit, or the chat stops after one.

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

### An intervention is a change in the worker's next decision

Supervision exists to correct a worker's execution decisions while they are being made. The thing
supervised is one chain per stream: **the operative unfinished objective → the last consequential
action → its actual result → the next action the worker chose.** Read that chain from the
transcript's tool calls and outputs. Activity counts, row phase, lease freshness and commit cadence
do not contain it.

The worker is otherwise unrestricted. It keeps its general-purpose tools and solves unforeseen
problems its own way. The one test the steward applies is whether each consequential decision
follows from the objective and from the result just observed. When it does not, that is the
divergence, whatever form it takes. The 2026-10-19/20 cases below show what failing that test
looked like. They are instances, not a checklist, and the next divergence will look different:

- **Rediscovery in place of resumption.** The worker repeats setup, orientation or task selection
  while an already-identified unfinished operation exists. On 2026-10-19 at 05:32 and 06:08 UTC the
  `sage-indefinite-port` worker re-selected issues despite an explicit instruction to continue
  unfinished #33. A chat replacement inherits the operative source, the unresolved construction,
  the relevant tool results and any running computation; it does not re-orient. The objective
  changes only when the existing obligation is completed or a real mathematical dependency is
  found. A turn ending is not either of those.
- **Specimen-reactive scope.** A failing specimen identifies a defect in the governing algorithm.
  It does not become the new scope of work. For a source-faithful port, the unit is the complete
  upstream routine with its dependencies and invariants. For research, the unit is the
  mathematical construction that owns the consumer's failure. Passing an isolated test does not
  discharge the governing contract.
- **An exception removed instead of a result delivered.** In `research` commit `0b11ac8b9e`, a
  PARI precision failure was "fixed" by replacing a bounded root enumeration with an exact search
  that the source itself admits never terminates when the roots do not generate the lattice. For
  `U(2)` the primitive reflective roots are `±e±f`, which span an index-two sublattice, so the
  search cannot terminate on that input. Its consumer `sage_genus.py:_root_span_data` calls it
  directly. The observed exception was removed and the consumer's required result was not
  delivered.
- **A computational wait in place of work.** The Sage worker spent turns launching full
  acceptance families on this host, wrapping them in 275- and 280-second bounds to fit one tool
  call, polling them, and relaunching them. The size of the bound was not the defect. The defect
  was that a giant run had become the worker's inner loop. Workers do work, and the inner loop is
  small targeted tests that answer the question the current edit raises. Significant runs (full
  families, full builds, whole suites) go to CI, run asynchronously, and are consumed when their
  verdict arrives. They never run serially on this box blocking a worker. A worker-run job here
  that takes more than five minutes means the setup is wrong. Repair the setup: give the run a CI
  route and give the worker a targeted test surface. Do not wait it out, wrap it in a shorter
  bound, or hand the wait to the orchestrator.
- **A run that cannot discharge the objective.** A targeted runner was prepared and then bypassed
  for another broad validation. Several runners were prepared and never produced a verdict. A full
  run was started on a source revision that later edits made non-final. A run whose verdict cannot
  close the current obligation is not the next step toward it. A result on earlier source is still
  diagnostic evidence; only a run on the final revision is acceptance.
- **A repeated failed operation**, such as the same probe, the same reread or the same relaunch,
  with nothing changed between attempts.

When the chain shows one of these, find the **earliest** incorrect decision and intervene there.
Do not intervene at the latest symptom. The correction goes to the existing worker and carries
three things: the unchanged objective, the decision that was wrong with the evidence for it, and
the specific operation to resume. It is not a generic continuation, not a new repository rule
(unless a rule authorized the decision), and not a new detector. If the same divergence recurs
after the correction was **delivered and read**, replace the chat. The replacement keeps the same
workstream row and the same source, and its handoff names the unfinished operation.

**The intervention succeeded only if the worker's next consequential action changed as
predicted.** A dispatch receipt, a journal entry, an instruction edit, another status check or an
accurate diagnosis does not complete the obligation. Neither does a new tool, harness, controller
patch, assignment verifier or confinement mechanism. If the next action did not change, the
intervention failed, however correct the finding or elaborate the machinery.

**The steward is held to the same standard.** On 2026-10-20 a supervising agent spent hours on
assignment verification, Docker confinement and specialized execution tools, and none of it
changed what the research worker did next. That is the worker failure moved one level up: an
easier adjacent activity was substituted for the required outcome. Control machinery is
legitimate only when it is itself the earliest cause of the worker's wrong decision, and even then
the correction stays open until the worker's action changes. Never correct a worker by removing
its general-purpose tools. A design that disables shell access contradicts what this product is
for, so reject it before any implementation.

Do not reread this file or repeat an investigation on every tick. Read the steward sections of §19
once per run. After that, read only the section that an observation is about to make you act on.
An investigation whose result is already in the journal is consumed, not re-run. Rereading the
instruction file and re-diagnosing the same Sage acceptance obstruction filled the orchestrator's
own 2026-10-20 recording.

**Attribute before crediting.** A commit in a repository made by an agent working on another
workstream is not the assigned worker's production. On 2026-10-20, `lattice-database` work landed
commits in `research` while research's recorder had shown no tool activity since 2026-10-19
07:14 UTC. An `active` row is not evidence that its chat is executing. A source edit is not
acceptance of its consumer. The converse also holds: source-backed algorithm construction before
an expensive acceptance finishes can be real progress. Establish which chat owns the execution,
and judge it against that stream's own current obligation.

**When the steward's own action fails, restoring its ability to act is the objective.** A
correction that cannot reach the worker, for any reason, leaves the stream exactly where it was.
Recording the failure again on the next tick is not an action. Neither is trying the same thing
unchanged, or treating the failure as background state. So the failed route becomes the
steward's current work: find out what actually blocks it, and repair it through its legitimate
route without bypassing an authority boundary. Verify that a correction then really reaches the
worker. If the repair needs authority the steward does not hold, put that one fact in front of
the owner once.

The instance that forced this: from 2026-10-20 on, the orchestrator's corrective calls were
refused upstream before dispatch on more than a dozen consecutive ticks. Each tick logged the
refusal and ended, and no correction reached any worker.

Scheduled automations stay enabled throughout. They are occasions for judgment, not worker-control
algorithms.

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
- **A mathematical repository is measured against its consumer.** A worker or steward
  calls its checks "integration", ties a node's acceptance to how a port or migration
  calls it, and then reports the library as blocked on that consumer. On 2026-10-09
  research's issue-401 node waited on the stopped `sage-indefinite-port`, and the steward
  relayed that to the owner as a decision. The owner's ruling: research is general mathematics,
  accepted by true assertions at each operation's owner, and no consumer gates it.
  *Remedy:* rewrite any such acceptance as mathematical assertions at the owner; a
  consumer's needs may order the work, never accept it.
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

### Principles learned from observed failures

Each principle below is one lesson that cost real fleet time, stated once with its test. The
dated incidents are in [`docs/steward-incidents.md`](docs/steward-incidents.md). That file is evidence, not instructions, and every
lesson it holds is stated here or under "Operational facts that are not guessable". The forms
listed under each principle are what failing its test has looked like so far. They are
instances, not the boundary: the next failure will take a different form, and the test is what
catches it. When a new failure appears, find the principle whose test should have caught it
before writing anything new (see the evidence file's preamble).

#### P1. Test the property, never the shape

A guard, gate, measure or acceptance written against the shape a failure once took catches only
that shape. The behaviour moves to the nearest uncaught form, because it is produced by
incentive, not malice: it is the cheapest thing that looks like progress. The test that survives
is the property. Did anything exist after this unit that did not exist before? What happens to
this number when the work goes perfectly? Can this entry close without the artifact its contract
names? Does the thing being counted have to exist at all, and has anything ever executed it? A
rule derived from one incident is written as the property that incident violated, with the
incident as an example.

Forms so far:
- paperwork moving from queue ticks to reconciliation notes to completion markers;
- node acceptance that was a receipt verb;
- counts whose denominator grew with good work;
- object counts that could not see reinvention or unexecuted work;
- an app "fix" that banned one class of mechanism.

Evidence: [7](docs/steward-incidents.md#gated-paperwork-reappears-in-the-nearest-ungated-form), [23](docs/steward-incidents.md#a-count-with-a-moving-denominator-is-not-a-progress-measure), [24](docs/steward-incidents.md#count-the-field-not-a-phrase-that-happens-to-appear-near-it), [43](docs/steward-incidents.md#ask-whether-the-work-should-have-existed-not-only-whether-it-happened), [53](docs/steward-incidents.md#production-nobody-has-executed-is-not-production), [54](docs/steward-incidents.md#the-acceptance-you-write-into-a-node-is-the-work-the-node-will-produce), [50](docs/steward-incidents.md#historical-failure-make-the-failure-impossible-was-read-as-remove-the-tool).

#### P2. Every signal is a projection with a blind state

Every instrument loses information and has a state it cannot distinguish. Name that state, pair
instruments that fail differently, and read them in order of truth:
1. in-flight tool calls and the transcript;
2. the process table;
3. the working tree;
4. worker-authored commits;
5. mtimes and commit subjects.

A slice supports "not found in what I read", never "not happening". A stored kind, a tree
signature, a recorder clock, a turn start or a count never decides a state alone. A
contradiction between two measurements is the finding, not noise to resolve toward the
convenient story.

Forms so far: a recording gap read as a stall; a commit that restored an earlier tree
signature; a generic transcript tail; a chat running tools while storing nothing; empty state
after a restart; turn starts the app did not send; merges invisible to an add filter.

Evidence: [1](docs/steward-incidents.md#a-chat-that-stores-your-message-and-never-starts-a-turn-is-dead), [2](docs/steward-incidents.md#noprogressforms-equal-to-generatingforms-means-unrecorded-not-stalled), [14](docs/steward-incidents.md#git-log---diff-filtera-does-not-see-merges-and-a-jump-is-as-likely-a-merge-as-production), [16](docs/steward-incidents.md#read-the-age-distribution-of-a-dirty-tree-not-its-size-or-its-signature), [17](docs/steward-incidents.md#a-tree-signature-says-nothing-on-its-own-because-committing-restores-an-earlier-one), [25](docs/steward-incidents.md#a-transcript-tail-of-generic-lines-is-not-evidence-of-inactivity), [26](docs/steward-incidents.md#a-burst-of-unsent-turn-starts-predicts-stalls-in-exactly-those-chats), [27](docs/steward-incidents.md#the-apps-send-registry-is-not-a-complete-record-of-what-starts-turns), [28](docs/steward-incidents.md#an-outlier-turn-duration-is-the-signal-not-silence-against-commit-age), [36](docs/steward-incidents.md#chat_error-is-a-fifth-state-running-at-the-tool-layer-storing-nothing), [48](docs/steward-incidents.md#verify-against-the-fastest-true-signal-not-the-most-convenient-one).

#### P3. Silence is not success

Almost every component of the tick reports success by printing nothing. So a step that never
runs, a sender killed by a wrapper, a waiter that expires and a script that dies at launch all
look exactly like a working fleet. Read what a maintenance or intervention command actually
printed at least once. Syntax-check and exercise a changed instrument on a harmless target
before aiming it at a stream. Never cut a sender off before its own deadline. Treat empty output
as failure until shown otherwise. Any number that encodes "long enough" has a shelf life, because
turns, tabs, gates and transcripts grow with the conversation. The tick that finds a threshold
too small fixes the threshold.

Evidence: [32](docs/steward-incidents.md#syntax-check-an-instrument-before-the-intervention-that-uses-it), [33](docs/steward-incidents.md#never-wrap-a-sender-in-a-timeout-shorter-than-its-own-deadline), [34](docs/steward-incidents.md#a-waiter-cannot-outlast-a-turn-and-turns-grow-with-the-conversation), [51](docs/steward-incidents.md#a-cleanup-step-that-has-never-once-run-looks-exactly-like-a-clean-fleet).

#### P4. Diagnose the layer; the remedy must carry what the failure lacks

- **Page-layer failures** (cannot store, frozen composer, dead turn) need a page repair.
- **Behaviour-layer failures** are information-shaped and need the missing fact delivered to the
  worker. A reload restores the loop along with the conversation.
- **Document-layer blocks** need the governing text fixed. A blocked worker is busy, competent and
  consistently adjacent, so it looks like disobedience. Before escalating, open the node, find the
  command that produces its deliverable, and check the repository lets the worker run it.
- **Host facts the worker cannot observe** (its process ended, the disk filled) are the steward's
  to check. No document makes a chat observe what it cannot see.
- **An instruction that is cheap to state and not followed** has a cost nobody has priced. Read
  what the gate or recipe charges before repeating it.
- **A worker that committed after your message is not ignoring it.** Check the last message landed
  before sending a stronger one.

Choose the action by layer, never by force. A chat that has already shown a pattern has used up
the benefit of waiting, so its horizon shortens.

Evidence: [3](docs/steward-incidents.md#ask-the-host-what-the-worker-cannot-see), [4](docs/steward-incidents.md#a-chat-that-stalls-the-same-way-twice-earns-a-shorter-horizon), [6](docs/steward-incidents.md#a-worker-can-report-a-commit-from-the-wrong-repository), [20](docs/steward-incidents.md#when-a-worker-will-not-do-a-cheap-thing-price-it-before-pushing-again), [29](docs/steward-incidents.md#revive-fixes-a-page-it-does-not-fix-a-loop-and-the-rungs-are-not-ordered-by-strength), [30](docs/steward-incidents.md#the-ladder-is-for-stopped-streams-not-for-streams-doing-the-wrong-thing), [52](docs/steward-incidents.md#check-the-work-is-possible-before-climbing-the-ladder).

#### P5. Correct with information, at the text that caused it

A correction states what was false and what is now true. An instruction to undo work already
underway is a separate decision with its own justification. Repair the document that actually
blocked the worker, not the one the steward edits most, and make a conditional rule point at
where its condition is checked. Send what was verified and no more. A cross-repository item in a
worker's record is re-checked at the producer and sent as a fact; the worker's observational
record is not overwritten. A premise that blocks work gets harder scrutiny than one that adds
work: state it as a claim and try to break it first. Afterwards, read what the worker actually did
with the correction.

Evidence: [9](docs/steward-incidents.md#a-recorded-failure-set-goes-stale-in-one-direction-and-nobody-is-watching-it), [40](docs/steward-incidents.md#a-correction-can-be-worse-than-the-mistake-say-what-was-wrong-not-what-to-undo), [41](docs/steward-incidents.md#verify-a-blocking-nodes-premise-harder-than-an-adding-nodes), [45](docs/steward-incidents.md#repair-the-document-that-states-the-rule-not-the-one-that-describes-the-work).

#### P6. An explanation is a hypothesis with a discriminator

An explanation reused on a second tick needs its discriminator written down and checked. For
batching, that is whether the tree is still moving. For a slow gate, it is whether the gate is
running. A true explanation is the most durable way to stop looking, because it survived scrutiny
once.
- Before attributing a rate change, bucket it over enough time.
- Before escalating a host trend, attribute it. The fleet is usually a small part of a host number.
- Before comparing error rates across streams, classify the errors.
- Report a tool's reclaim or improvement as the measured delta, not its own claim.

A plausible systemic story built on two samples will steer several ticks unless it is falsified.

Evidence: [11](docs/steward-incidents.md#space-du-cannot-account-for-is-held-by-deleted-but-open-files), [12](docs/steward-incidents.md#gate-churn-accumulates-in-caches-and-the-reclaim-is-smaller-than-the-tool-claims), [13](docs/steward-incidents.md#attribute-a-host-trend-before-escalating-it-and-expect-it-not-to-be-the-fleet), [15](docs/steward-incidents.md#one-tick-is-a-sample-a-trend-needs-the-buckets), [18](docs/steward-incidents.md#a-true-explanation-becomes-an-excuse-the-second-time-you-reach-for-it), [44](docs/steward-incidents.md#an-error-rate-is-not-comparable-across-streams-doing-different-work).

#### P7. A wrong measurement is wrong everywhere it was used

When a measure, detector or count is found wrong, correct every derivative: totals, rankings,
node text, instructions already sent, and the dashboard. The ranking is the dangerous one, because
it gets acted on. A detector's sampled hits prove precision only. Review its enumeration against
the domain, or compare a second implementation, to learn its recall. A count the steward measured
by hand does not go into a worker document; route the node to the command that regenerates it. A
failure mode found in one repository's documents is swept for in every other managed repository
in the same tick.

Evidence: [22](docs/steward-incidents.md#correcting-a-total-does-not-correct-the-worklist-built-from-it), [24](docs/steward-incidents.md#count-the-field-not-a-phrase-that-happens-to-appear-near-it), [46](docs/steward-incidents.md#fix-a-failure-mode-in-one-repository-then-sweep-the-other-three-for-it), [47](docs/steward-incidents.md#sampling-a-detectors-hits-proves-precision-and-says-nothing-about-recall).

#### P8. A contract produces exactly what it says

- An acceptance names an object that did not exist before. "Record", "note", "audit", "review",
  "reconcile" and "mark" produce receipts, and a node accepted by one will produce receipts.
- Close a node in the tick that proves it, in a format that can be closed. Verify an item is open
  before promoting it to work. Where a file cannot say whether an entry is open, that is the first
  defect.
- An audit asks first whether the thing should exist and whether a dependency owns it.
- A migration closes the old path in the same operation. Until it does, reconcile by diff, never
  by timestamp.
- Verification deferred to a phase makes that phase's readiness part of every tick. A ready,
  unstarted verification is a wedge, and repairs belong after execution.

Evidence: [21](docs/steward-incidents.md#closing-finished-nodes-is-the-stewards-work-and-an-unmarked-one-stays-ready-forever), [39](docs/steward-incidents.md#a-migration-that-leaves-the-old-path-writable-has-not-migrated-anything), [42](docs/steward-incidents.md#a-cleanup-loop-improves-what-it-finds-and-never-asks-whether-it-should-exist), [53](docs/steward-incidents.md#production-nobody-has-executed-is-not-production), [54](docs/steward-incidents.md#the-acceptance-you-write-into-a-node-is-the-work-the-node-will-produce), [55](docs/steward-incidents.md#check-a-complaint-is-open-before-filing-it-as-work).

#### P9. Attribute before acting or crediting

Confirm which chat is the repository's stream before driving one; recency decides only when
neither chat is demonstrably working. Measure the worker by what the worker did:
- steward commits, filings and document edits move the same clocks;
- another workstream's commits in a repository are not this worker's;
- an `active` row is not an executing chat;
- a cited hash may be real in a sibling repository.

Cross-repository failures are visible only to the steward. Diagnose them at the producer and file
on both sides; publication stays the owner's decision. Before filing work, name the worker who
will pick it up. Where none exists, do the safe, reversible thing yourself, and never defer
preservation.

Evidence: [5](docs/steward-incidents.md#before-pushing-a-chat-confirm-no-newer-chat-owns-its-repository), [6](docs/steward-incidents.md#a-worker-can-report-a-commit-from-the-wrong-repository), [9](docs/steward-incidents.md#a-recorded-failure-set-goes-stale-in-one-direction-and-nobody-is-watching-it), [10](docs/steward-incidents.md#a-blocker-that-spans-two-repositories-is-only-visible-to-the-steward), [38](docs/steward-incidents.md#filing-is-only-delegation-where-a-worker-exists-elsewhere-it-is-deferral), [56](docs/steward-incidents.md#in-this-repository-author-no-longer-separates-steward-from-worker), [57](docs/steward-incidents.md#do-not-count-your-own-commits-as-the-workers).

#### P10. The steward's own footprint is part of the system

Retries, wake attempts, watchers, detached commits and diagnostic walks consume tabs, memory,
index locks, I/O and workers' context, and the steward's instruments show none of it. Measure
your own cost before attributing a symptom to the fleet. Agent context is the scarcest resource
here: shared tooling prints what its caller can act on, and the fix belongs upstream. Stay with an
intervention until it lands or fails. A background watcher is never where an unverified
intervention goes.

Evidence: [8](docs/steward-incidents.md#a-watcher-that-reports-next-tick-is-carrying-the-intervention-into-the-next-tick), [19](docs/steward-incidents.md#shared-tooling-that-prints-for-a-human-is-a-context-tax-on-every-agent-that-calls-it), [37](docs/steward-incidents.md#the-stewards-own-footprint-does-not-appear-in-the-stewards-instruments).

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

### Fleet state: the entrypoint for every steward and orchestrator

Any agent that acts on the fleet (a steward session, the `orchestrator` workstream, a one-off
helper) starts here. No agent can see another agent's chat, so everything one agent does to the
fleet has to be recorded in these files for the others to see.

| Surface | What it holds | Authority |
| --- | --- | --- |
| `GET /workstreams` (bridge, port 8765) | logical workstreams in `workstreams`, broker worker claims in `workers` with `agentState`, and `connectorSchema` | live truth for what is running; sleeping workers are history, not fleet width |
| "Owner decisions" under "The managed workstreams" below, and `FANOUT-SCHEDULE.md` | which streams the owner has running or paused, and each stream's current frontier | the owner's standing instructions |
| `steward-dashboard/journal.md` (local, gitignored, never committed) | dated entries: each action taken on the fleet, each owner instruction received, and what the next tick must verify | the running log; read its last entries before acting |
| `steward-dashboard/tick-prompt.md` | the steward's tick prompt, verbatim | recreate the tick cron from it |

Before acting: read `GET /workstreams`, the owner-decision paragraph, and the tail of the journal.
After acting: append a journal entry that names its author (`steward`, `orchestrator`, ...), what
was done, and what must be verified next. An owner instruction that changes which streams run
also goes into the owner-decision paragraph and `FANOUT-SCHEDULE.md` in the same commit. The
journal alone does not bind agents that never read it.

**A paused stream stays paused.** Only the owner resumes a stream. Neither the running docs, a
stream's own TODO frontier, nor a stale "has fleet capacity" line counts as a resume. On
2026-09-28 the orchestrator resumed `sage-categories` eleven minutes after the owner paused it,
because the pause was recorded only in the steward's chat.

Verbs, authenticated with `Authorization: Bearer $(cat ~/.config/chat-on-steroids/state/local-token)`
(never print the token):

- pause or resume: `POST /workstreams/pause` or `/workstreams/resume` with `{"id": "<workstream>"}`;
- revive the recorded claimant of an active workstream whose browser conversation is unbound,
  **only after checking that its worker is actually stopped**: `POST /workstreams/recover`
  with `{"id": "<workstream>", "reason": "<observed failure>"}`. This enters the native
  revive/replace state machine; it refuses active tool calls and unknown or retired claimants.
- replace a blocked chat for an owned logical workstream: `POST /workstreams/replace`; retire an abandoned, paused or blocked logical workstream with no worker history: `POST /workstreams/retire` (both take the same `id` body);
- send a chat a pointer: `just say <conversation-id> "<text>"`;
- refresh ChatGPT's copy of the Core tool schema when `connectorSchema` is not `current`:
  `node steward-dashboard/tools/refresh-core-app.mjs <screenshot.png>` (the plugin page, then "…",
  Manage, Refresh). Do this yourself; never wait on the owner for it.

### The tick

The tick is a session-only cron job (`13,43 * * * *`) whose prompt is saved verbatim in
`steward-dashboard/tick-prompt.md`. A session continuation silently drops it, and on
2026-09-26 ticks stopped twice unnoticed. After any continuation, check that the job exists
and recreate it from that file.

Every tick reads `steward-dashboard/completion.md` for prior claims to verify, then examines each
agent's actual activity against its current task: its reasoning and tool results, source changes,
unresolved failures, and the dependency it is trying to resolve. Determine whether those actions
address the problem in front of it, or repeat checks, explore adjacent work, or manufacture records
without resolving that problem. Completion measures summarize established results; a flat or rising
measure never classifies a stream or triggers an intervention. Intervene on a diagnosed wedge,
blocker or drift, and verify that the intervention changes the relevant activity and outcome.

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
   With `sleepWake.enabled`, a verified push discards the chat's tab while its turn keeps
   running at OpenAI, so `just state` reads `generating:false`, a stale `lastPageToolAt` and a
   transcript that stops at the push, for a chat that is working. Read `GET /sleep/status`,
   the row's `lastActivity` and the `workstreamId` of in-flight calls before calling it stopped
   (2026-10-01: three sends went to a slept new-qual-site while it committed every minute).
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
   source is read, the worker starts the corrected node, or a worker-authored commit lands. For a
   correction, the signal is the worker's next consequential action changing as predicted. Stay
   with the intervention until that signal appears or the rung fails. Do not use a `turn_start`,
   delivery receipt, timer expiry, or your own repository edit as proof.
7. **Update durable control state only from proved transitions.** Close a completed node in the
   same tick that proves its acceptance. Correct a false blocker or stale worklist immediately.
   Do not add a rule merely to narrate what happened; change a rule only when it changes the next
   action under an observable condition.
8. **Perform the self-audit when due, then report the project state briefly.** For each workstream,
   report exactly two progress views: **current milestone** completion, remaining distance and
   derivative; then **overall project** completion, remaining distance and derivative, with
   uncertainty where material. Where the contract's units are discrete (for example, nine frozen
   families), report accepted units N of M beside the estimate. Never answer that the percentage
   is undefined or unquantifiable: build the best estimate and state its uncertainty (see "Report
   to the owner"). Never let rebuilding the estimate take the time the correction needs. Then state the dominant bottleneck and any owner-only decision. Do
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
alone. Working means doing work. The worker's own checks are small targeted tests that answer
the question its current edit raises. Significant runs (a full Lean build, a Sage/Julia acceptance
family, a whole suite) run asynchronously on CI against a named source revision, and the worker
keeps implementing while they run. It consumes their verdict when it arrives and never waits or
polls for it. A worker whose turn is a computational wait is not working, however legitimate the
computation. A job on this box that blocks a worker for more than five minutes is a setup defect
(see [the owner's 2026-10-21 rule](#the-managed-workstreams)). Repair it at its owner, for
example with a missing CI route or a missing targeted test entrypoint, instead of waiting it out.

**Wedged.** The objective is valid and executable, substantive work remains, but either there is no
live relevant action and no advancing tree/commit/transcript evidence, or its actual activity shows
a repeated failure to advance the assigned work. Elapsed time alone does not establish a wedge.
A chat or worker that has done nothing at all for five minutes, with no call in flight, is a real
ChatGPT failure mode (a dead or unstarted turn): act on it. Repeatedly polling a dead process, restarting the same build without resolving its
failure, or exploring adjacent tasks to avoid that failure requires intervention at the cause.
First inspect the dirty tree: if it holds coherent finished work, the first instruction
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
- **Wrong execution decision** (rediscovery, specimen-reactive scope, an invented bound, a run
  that cannot discharge the objective): correct the earliest wrong decision in the existing chat,
  per [An intervention is a change in the worker's next decision](#an-intervention-is-a-change-in-the-workers-next-decision).
- **Repeated failure of the same chat after the right-layer correction:** replace it. Characterize
  its dirty tree before handoff and preserve all banked work.
- **Your own corrective action fails:** restoring your ability to act is now the work. Do not
  re-record the failure or repeat the action unchanged.

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
- **Your standing authority never extends to neutering the app.** Control-plane repair means
  fixing the documents, routing, scheduling or tooling that misdirect a worker. It never means
  reducing what workers can do or making the app act on their behaviour without judgment (§1,
  "Who sets the limits"). If a remedy you are designing works by constraining agents rather than
  by informing a decision, stop: the correction belongs in the worker's next decision.
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

- `lastStoredKind: user_message` with `generating:false` and `generatingForMs:0` means no turn
  began. It reads identically for the first minutes after any push. A silent turn that exists is
  interrupted. A stored message with no turn, past the start window and across two pushes, is
  replaced. Before writing the handoff, check whether its last stated wait already resolved.
- `noProgressForMs` equal to `generatingForMs` means nothing was stored since the turn began. That
  is normal during any turn and is usually a recording gap; the commit clock stays authoritative.
  Judge a turn's duration against the fleet's current turn lengths, not a fixed threshold.
- `chat_error` while tool calls continue is a chat running at the tool layer and storing nothing.
  With an empty tree and no commits, revive it. The stored kind alone never decides.
- After a `chat-on-steroids.service` restart, `lastStoredKind` is empty until each chat stores
  once. Restart only with `pendingTools` at zero, because an in-flight `exec_command` dies with it.
- `journalctl --user -u chat-on-steroids.service | grep 'did not send'` lists turns the app did
  not start. Bursts predict stalls in exactly those chats. Turn starts are observations, never
  receipts for an intervention.
- An interrupt to a sleeping chat answers `that chat is sleeping … Waiting`: send one per chat,
  then `tidy`. A revive against a live, generating page fails with `No page redeemed` and opens a
  tab on each attempt.
- What a worker cannot see from inside: `pgrep -a -x 'lean|lake'`, `pgrep -af 'sage|mypy|pytest'`.
- Disk that `du` cannot find is held by deleted-but-open files: read `/proc/*/fd` for
  `(deleted)`. It is reclaimed by restarting the holder, and only after deciding it is yours to
  restart. `uv cache prune` over-reports; measure `df`.
- `git log --diff-filter=A` omits merges, and `HEAD@{<time>}` is a reflog position, not a time.
  Use `git rev-list -1 --before=`. `git log` without `-C` reports whichever repository the shell is
  in. Bucket `git log --pretty=%ct` by hour before reading a rate.
- Bucket a dirty tree by mtime. A floor that never moves is unbanked work. The worker instruction
  that prevents it is to commit anything older than the unit about to start.
- Steward edits to a file a worker may also be writing: join the edit and the commit with `&&`,
  name the paths, anchor on headings or ids that survive reflow, and amend an unpushed commit whose
  message turns out false.
- Attribution by author: in the managed repositories workers commit under the personal address
  and the steward under the noreply address, so filter with `--author`. In this repository both
  commit under noreply, so use commit time against your own record, or read the diff.
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
- A `say` that `expired` ("no page redeemed") while `just state` reads `generating:false` is
  usually a page still showing a dead turn's Stop button: the recorder lost that turn when the
  tab slept, the page will not type over it, and a retry expires the same way. Use `just
  interrupt`, which presses Stop first (2026-10-02: math-notes-ipad, three expiries, then one
  interrupt delivered).
- When every send `expires` across different chats and verbs while the pages themselves load
  and show a ready composer, the extension has stopped redeeming commands. Reload it:
  `node steward-dashboard/tools/reload-extension.mjs` (`chrome.runtime.reload()` in its service
  worker). 2026-10-02 07:00: four expiries on two chats, then both delivered on the first try
  after the reload. Do not replace chats for this; nothing is wrong with them.
  If sends still expire after the reload, including `just new`, read the Chrome processes: a
  renderer at gigabytes of RSS with the host load climbing starves every page. Restart
  `chat-on-steroids-browser.service`; the chats keep running server-side. 2026-10-02 11:01: a
  1.8 GB renderer at 61% CPU; after the restart the next say delivered to the same chat.
- `native-insert-no-text` repeating on one chat (`execCommand('insertText')` false with the
  composer focused, selection inside it, no Stop button, document focused) is that
  conversation's page, not the browser: other chats type fine meanwhile. It has hit only long
  conversations (new-qual-site at 2400+ nodes, math-notes-ipad after nine hours). After the
  second occurrence, hand off to a fresh chat (`just new` with the workstream brief); retries
  and interrupts waste the window, and an interrupt that fails here also stops the turn.
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

**2026-10-13: the owner resumed `sage-indefinite-port`, `research`, and the `orchestrator`.** Use the existing repository workstreams and their selected tasks. The orchestrator runs the evidence-based steward tick; every other managed workstream remains owner-paused. The orchestrator controls worker pauses and is not itself pausable through the worker `/workstreams/pause` endpoint. Its Core calls still use an attributed workstream identity. This supersedes the blanket pause below for these three rows only.

**2026-10-13 09:43 UTC: the owner paused all managed workstreams, including the orchestrator.**
The controller reported 207 retained rows at the time, including worker history; this was not
207 active streams. Do not resume, replace,
dispatch to, or auto-advance any workstream until a later explicit owner instruction. This
supersedes the active allocations below; keep their task frontiers as cold-resume context.

Owner decisions as of 2026-09-27: `lean-categories` and `new-qual-site` are **paused** to give
their capacity to sage and research. new-qual's `audited-deployment` checkpoint is deployed
(087e3b595) and its audit rounds resume from it. sage's live `TODO.md` has reopened current-head
Milestone-A/B obligations after the historical acceptance revisions; its dependency graph currently
selects `core-functor-cell-calculus` before the downstream A/B and `framework-complete` delivery
nodes. Publication remains downstream of those substantive acceptance obligations. Leaves in sage
are probes of the core, never products (sage `AGENTS.md`). research's top-priority node is
`placement-audit`.

**2026-10-01 18:41 UTC: the owner resumed `new-qual-site` and started `math-notes-ipad`; 2026-10-02 11:48 UTC: the owner started `sage-indefinite-port`** (`/home/dzack/gitclones/sage-indefinite-port`; its `TODO.md` is the DAG over the GitHub issue tree rooted at #4). These are the only active managed streams. new-qual-site's task is writing solutions (its TODO.md section 7, made current in 60456281f after a copy pass deleted 46 owner-written cards); no pass there may delete, merge or consolidate owner-written cards. The steward never pushes or publishes a managed repository; workers push their own branches. Auto-continuation (`autoContinue` in config.json) is on whenever streams are being stewarded: with it off, a stalled stream waits for the next steward tick (2026-10-02, owner). `math-notes-ipad` (`/home/dzack/gitclones/math-notes-app`, branch `ipad-port`) exists to build out the iPad app on that branch, ahead of that repository's v1-before-iPad sequencing, which still governs its `main`; it verifies Swift through `gh workflow run ios.yml --ref ipad-port` and never pushes `main`. The older `math-notes-app` and `math-notes-app-batch2` rows were bound to `/research` and stay as they are. Everything else stays under the pause below.

**2026-10-12: the owner explicitly resumed `sage-indefinite-port` and requested completion.** This supersedes the 2026-10-07 stop for this stream only. Its repository `AGENTS.md` and `TODO.md`/issue DAG govern completion and acceptance; continue the existing repository worker rather than opening competing work on the same tree. `research` and `lean-cas-dsl` remain active under their existing instructions; other owner-paused streams remain paused.

**2026-10-09: the owner started `lean-cas-dsl`** (`/home/dzack/gitclones/lean-cas-dsl`, cloned from `dzackgarza/lean-cas-dsl`; its `AGENTS.md` "Current task: construct B0" governs). The active managed streams are `research` and `lean-cas-dsl` (or the temporary stream standing in for it under the serial rule below); every other row stays paused unless a later owner instruction explicitly resumes it.

**2026-10-21, owner: workers do work, not wait on long runs.** Actual work uses small targeted
tests. Significant runs belong on CI, asynchronously, never serially on this box blocking work.
An agent running a job longer than five minutes means the whole setup has a serious problem, and
the steward repairs that setup (a CI route, a targeted test surface). It does not supervise the
wait. Five minutes with no activity at all is a real ChatGPT failure and is acted on. Neither fact
licenses removing workers' general tools or adding controller-side kill timers. This supersedes
the 2026-10-11 build-wait arrangement below and the background-wait procedure in "Managed
lean-cas-dsl validation runs".

**2026-10-11, owner: workers work; the orchestrator owns build waits (superseded 2026-10-21).** Required Lean builds run in
the background without an arbitrary duration cutoff. Workers continue useful adjacent work, or
the orchestrator temporarily pauses their workstream, owns the build, and resumes them promptly
with its result. This temporary build pause is not an owner stop requiring another permission to
resume. Inspect actual activity to diagnose drift or wedges; proxy changes never trigger intervention.

### Managed lean-cas-dsl validation runs

*Superseded 2026-10-21 by the owner rule in "The managed workstreams": significant runs go to CI
asynchronously and workers keep working; retained as cold-resume history only.*

Required Lean compilations and long-running acceptance-harness executions run
once in the background with a durable output log, source revision and identifiable
process. They are not worker-turn polling jobs:
while one runs, continue independent B0 construction and source-level repairs.
If no such work remains, give the live process and log to the fleet steward,
which owns the wait and may temporarily pause this stream until it can return
the actual compiler or harness result. Do not relaunch a live run or kill it for
elapsed time alone. A vanished compiler, harness, or terminal session is diagnosed from its
actual process and output before choosing the next action; repeated empty
`write_stdin` calls do not establish progress or acceptance.

**2026-10-10, owner rule: blocking work is serial.** When an active stream is blocked on work in another repository, pause the blocked stream and run a temporary workstream in the blocking repository in its place, whatever that repository's standing status, until the blocking task is delivered; then close it and resume the blocked stream. The blocked worker never "commissions" the work, and the blocked stream and its blocker do not run side by side. Applied the same day to `lean-cas-dsl` (paused), in order: `lean-cas-dsl-leaves` decodes the released descriptor forms (products, coproduct); `lean-categories` registers the named output forms of `colim.bil_w_form.cokernel`; `lean-cas-dsl-leaves` computes the discriminant cokernel; then `lean-cas-dsl` resumes.

**2026-10-08: the owner resumed `research` as the only active managed stream.** It works from its `HANDOFF.md` first, then its `TODO.md` DAG. `new-qual-site`, `math-notes-ipad` and every other row are paused, and `sage-indefinite-port` stays stopped (2026-10-07). This supersedes the 2026-10-04 allocation below; resume nothing else until a later explicit owner instruction.

**2026-10-04: the owner explicitly resumed the fleet under the three-stream allocation above.** `new-qual-site`, `math-notes-ipad`, and `sage-indefinite-port` are the active managed repository streams, and the `orchestrator` is active to steward them. This supersedes the 2026-09-28 blanket pause only for those rows; every other managed repository remains paused until a later explicit owner instruction.

**2026-09-28 08:2x UTC: the owner paused the whole fleet** (research, the orchestrator and every other
workstream). Nothing runs. Resume nothing until a later explicit owner instruction.

**2026-09-28 06:33 UTC: the owner paused `sage-categories`.** Only research has active fleet
capacity. Do not resume sage (no `/workstreams/resume`, no dispatch) until a later explicit owner
instruction; sage's `core-functor-cell-calculus` frontier above is its cold-resume point.

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
- The change passes both questions in §1, "Who sets the limits", or an explicit owner
  instruction named it.
- Relevant local checks pass and `npm run verify` passes; `npm run verify:live` also passes for ChatGPT/Chrome changes.
- Build/packaging checked when the changed layer can differ after bundling.
- Comments and this file updated only where behavior genuinely changed.

> **The rule.** Name the identity crossing the failing boundary, follow one concrete item
> end to end, and fix the earliest place where reality diverges from that identity or
> invariant.
