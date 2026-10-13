/**
 * The machinery every model-facing tool sits on, independent of which surface it lives on.
 *
 * The tools themselves are split by connector — `tools-core.ts` and `tools-desktop.ts` —
 * because a connector is a discovery boundary and that split is the whole point of the
 * design (see `docs/tool-surface.md` §6.4). None of what is in this file is surface-shaped:
 * error mapping, the call clock, the recording context, the agent key and the result
 * formatters behave identically wherever a tool is registered, and duplicating them per
 * surface is how two connectors would quietly start reporting the same thing differently.
 *
 * A tool first appears when its capability is enabled. For the lifetime of a running MCP
 * endpoint the exposed surface is monotonic: if that permission is later revoked, the tool
 * stays registered so a cached ChatGPT tool snapshot does not break, while the live handler
 * returns TOOL_DISABLED. Read-only mode is applied upstream in effectiveCapabilities, so a
 * fresh endpoint starts with every write tool absent.
 *
 * Annotations matter for real behaviour, not just documentation: ChatGPT treats a tool
 * without readOnlyHint as a write action and asks the user to confirm each call, so every
 * genuinely read-only tool is marked as such.
 */

import { rawPromises as fs } from "../rawfs.js";
import { inboundConnectorSession, inboundRequestId } from "./inbound.js";
import {
  admitWorkstreamCall,
  workstreamWorkspace,
} from "../workstreams.js";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Capabilities, Root } from "../../shared/types.js";
import { FsOpError, formatBytes, type FileInfo } from "../fsops.js";
import { logInfo, logWarn } from "../logger.js";
import {
  SandboxError,
  isAbsoluteVirtualPath,
  isNativeWindowsPath,
  resolvePath,
  type Resolved,
} from "../sandbox.js";
import {
  currentWorkspace,
  learnWorkspace,
  setCurrentWorkspace,
} from "../workspace.js";
import { ExecError } from "../exec.js";
import { ComputerError } from "../computer/index.js";
import { getConfig } from "../config.js";
import {
  AgentError,
  acknowledgeOffers,
  acknowledgeOffersForWorkstream,
  dormantWorkerNoticeForWorkstream,
  endedWorkerNoticeForWorkstream,
  sleepSilentDetachedWorkers,
  noteAgentAliveForWorkstream,
  agentForCaller,
  agentForFinishCaller,
  offerMessages,
  offerMessagesForWorkstream,
  persistCriticalSwarmNow,
  requestWorkerRevivals,
  releaseQuiescentRun,
  retiredWorkerForWorkstream,
  stageQueuedWorkerRevivals,
  swarmRunning,
} from "../agents.js";
import type { SurfaceId } from "./surfaces.js";
import {
  currentCall,
  emptyEvidence,
  noteOutcome,
  runInCallContext,
  trackInFlight,
  trackMcpRequest,
  type CallContext,
} from "./call-context.js";
import { recordAgentMessage, recordToolCall } from "../session/recorder.js";
import { rulesGateRefusal } from "../rules-gate.js";
import { noteCommandMinted, noteSearch, reusePendingRefusal, snapshotBeforeCommand } from "../reuse-gate.js";
import { readOverflowText } from "../session/store.js";
import type { StoredText } from "../../shared/session.js";

export interface ToolContext {
  roots: Root[];
  /** Capabilities currently allowed by the live settings. */
  caps: Capabilities;
  /**
   * Capabilities whose tools must remain registered for the lifetime of the local MCP
   * endpoint. This prevents an already-cached ChatGPT tool snapshot from turning into
   * UNKNOWN when the user disables a permission mid-session. Calls are still checked
   * against `caps` and return TOOL_DISABLED instead of executing.
   */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** When on, an unspecified screenshot captures only the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session recording is live right now. Defaults to the live setting. */
  sessionTools?: boolean;
  /** Whether multi-agent mode is live right now. Defaults to the live setting. */
  agentTools?: boolean;
  /**
   * Whether these feature tools must stay registered for the lifetime of the endpoint,
   * for the same reason as `exposedCaps`: ChatGPT caches a tools/list snapshot, and a
   * tool that disappears from under a cached snapshot surfaces as a transport-level
   * failure rather than a tidy error. Default to the live values.
   */
  exposedSessionTools?: boolean;
  exposedAgentTools?: boolean;
  /**
   * Whether `find` must stay registered for the lifetime of the endpoint.
   *
   * `find` and the exec pair are mutually exclusive, and that choice cannot be derived
   * from `exposedCaps.command` on each request: `exposedCaps` only ever widens, so a user
   * switching command execution on mid-run would silently *delete* `find` from under a
   * cached ChatGPT snapshot — the exact stale-snapshot failure the monotonic rule exists
   * to prevent. So the decision is made once, from the live capabilities, and then only
   * ever added to. Defaults to the live answer when the caller does not track it.
   */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export const ok = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});
export const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** Maps runtime errors to short model-facing text without ever exposing real paths. */
export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError)
    return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "Not found";
  if (code === "EACCES" || code === "EPERM")
    return "Access denied by the operating system";
  if (code === "EBUSY") return "The file is in use by another program";
  if (code === "ENOTEMPTY") return "Directory is not empty";
  if (code === "EEXIST") return "Already exists";
  // Node filesystem errors routinely embed the absolute host path in `err.message`.
  // Unknown errno values (ELOOP, ENAMETOOLONG, EINVAL, ENOSPC, …) used to fall through
  // verbatim and violate the model-facing virtual-path contract. Keep the errno useful
  // without echoing the path Windows supplied.
  if (typeof code === "string" && code.length > 0)
    return `Filesystem error (${code})`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Epoch ms of the last tool ChatGPT actually ran, or null if it never has.
 *
 * Deliberately separate from "a request arrived". ChatGPT connects, initialises and
 * lists tools on every connect even when the model is then forbidden to use them —
 * which is precisely what an account with Developer mode switched off looks like from
 * here. Only a tool that ran proves the whole chain, model included, works.
 *
 * Kept per surface as well as overall. "Has ChatGPT ever run a tool here" is the only
 * honest proof a connector was created and works, and with two connectors the answer for
 * one says nothing about the other — a user whose Core connector is fine and whose
 * Desktop connector was never added would otherwise see setup reported as finished.
 */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/**
 * Turns any thrown error into a tool execution error the model can act on, and keeps
 * unexpected internals out of the response. Error results are logged with only their
 * first line, so Activity stays useful without copying command output or file contents.
 */
export async function guard(
  name: string,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const started = Date.now();
  // Counted before the work, and counted even when the tool is disabled or fails:
  // the question this answers is whether the model may call us at all.
  toolCallSeenAt = started;
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find(
          (item): item is Extract<ToolContent, { type: "text" }> =>
            item.type === "text",
        )
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      // A rejected edit, disabled permission, stale cursor, etc. is a normal tool
      // outcome, not evidence that the connector itself is unhealthy.
      noteOutcomeSafely("rejected");
      logInfo(
        `tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ""}`,
      );
    } else {
      noteOutcomeSafely("ok");
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof ComputerError ||
      err instanceof FsOpError ||
      err instanceof ExecError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely("rejected");
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely("error");
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return fail(message);
  }
}

// noteOutcome is only meaningful inside a call context. Internal paths can have none, and a
// missing context must not turn into an error.
function noteOutcomeSafely(outcome: "ok" | "rejected" | "error"): void {
  try {
    noteOutcome(outcome);
  } catch {
    /* no call context: nothing to record against */
  }
}

/** The only SDK handler context field this layer consumes; request identity comes from ingress ALS. */
type McpCallContext = Pick<ServerContext, "sessionId">;

/**
 * ChatGPT's id for this request, from `x-request-id`, without the per-attempt suffix.
 *
 * The header arrives as `wfr_<id>/<suffix>` and ChatGPT's own message model holds the
 * `wfr_<id>` half, so the suffix is dropped rather than matched on. Measured live on
 * 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`, page evidence
 * `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
 *
 * This is what makes caller identity a lookup instead of an inference. Before it, two
 * workers of the same run calling `agents` seconds apart were indistinguishable — both
 * conversations had named an unclaimed `agents` request inside the same window — and both
 * were refused WORKER_IDENTITY_LOST. Nothing about timing needs to be assumed now.
 */
function requestIdOf(mcpCtx: McpCallContext | undefined): string | null {
  // server.ts normalizes x-request-id exactly once at raw HTTP ingress and binds that value
  // to this async request. Re-reading the SDK header here would create a second parser/source
  // of truth for the correlation key.
  void mcpCtx;
  return inboundRequestId();
}

/** Diagnostic only: caller routing uses the app-issued key, regardless of transport. */
let transportIdentity: { checked: boolean; present: boolean } = {
  checked: false,
  present: false,
};

export function transportIdentityStatus(): {
  checked: boolean;
  present: boolean;
} {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? "MCP transport supplied a session id; caller identity uses workstream_id"
      : "MCP transport supplied no session id; caller identity uses workstream_id",
  );
}

/**
 * Appends the messages waiting for this agent to the tool result.
 *
 * This is the push-like delivery: an agent gets whatever has been said to it since its last
 * call, at the end of every result, with no polling loop. It works for a call this app could
 * place in a conversation, which is most of them and never all of them — so nothing is
 * retired here, and a message the page could not confirm is simply offered again next time.
 *
 * Messages are *offered* here, not retired. They are retired when this agent calls
 * again, because that is the first real evidence this result reached ChatGPT.
 */
function withInbox(
  workstreamId: string | null | undefined,
  agent: string | null,
  result: ToolResult,
  onFinish = false,
): ToolResult {
  const scoped = offerMessagesForWorkstream(
    workstreamId,
    onFinish,
    onFinish,
  );
  const recipient = scoped?.agentId ?? agent;
  const messages =
    scoped?.messages ?? (agent ? offerMessages(agent, onFinish) : []);
  if (messages.length === 0) return result;
  const lines = messages
    .map(
      (message) =>
        `• [${message.id}] from ${message.from}${message.offers > 1 ? " (repeat — you may have seen this)" : ""}: ${message.text}`,
    )
    .join("\n");
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `\n--- ${messages.length} message(s) for ${recipient ?? "this conversation"} ---\n${lines}`,
      },
    ],
  };
}

/**
 * Runs one tool call inside a recording context.
 *
 * Registration is wrapped rather than each handler, so the arguments and the result
 * recorded are exactly the ones that crossed the wire — the recorder never has to
 * reconstruct a call from a log line — and so identity is resolved in one place.
 *
 * `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed
 * `agents` tool the terminal call is an *action* rather than a tool name, and the
 * re-offer rule has to follow the action.
 */
async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  workstreamId: string | null,
  workstreamClaimId: string | null,
  workstreamSessionId: string | null,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  // The context is built here, one layer out from where the work happens, because the
  // compaction barrier asks about the whole request and not just the handler. A call is
  // still unsettled while its outcome is being recorded and its result is on the way back — and a handoff written in any of
  // those gaps describes a machine that has not finished changing. The counter therefore
  // opens with the request and closes with it.
  const context: CallContext = {
    startedAt: Date.now(),
    tool: name,
    workstreamId,
    workstreamClaimId,
    workstreamSessionId,
    transportKey,
    agent: null,
    caller: {
      workstreamId,
      transportKey,
      requestId,
      conversationId: null,
      sessionKey: inboundConnectorSession(),
      inferredConversationId: null,
      inferredMethod: null,
    },
    outcome: null,
    evidence: emptyEvidence(),
  };
  return trackMcpRequest(() =>
    trackInFlight(context, () =>
      dispatchTracked(context, name, args, transportKey, surface, run),
    ),
  );
}

async function dispatchTracked(
  context: CallContext,
  name: string,
  args: unknown,
  transportKey: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  // Recorded here rather than in `guard` because only this layer knows which server
  // answered, and "was this connector ever actually used from ChatGPT" is a per-connector
  // question the setup screen has to answer honestly.
  surfaceToolCallAt.set(surface, Date.now());
  const isFinish = isFinishCall(name, args);
  const startedAt = context.startedAt;
  // Workstream admission already established caller identity before dispatch. Browser
  // conversation/request evidence is irrelevant here. Two things about liveness happen before
  // the agent is resolved so the answer this call gets reflects the state this call established.
  //
  // A detached worker that has also stopped calling is put to sleep here rather than on a
  // timer: nothing about a run changes while nothing is happening, and this is the moment
  // something is happening. Sleep rather than failure, so being early about a slow worker
  // costs the run nothing — its own next call takes the slot straight back.
  const quietWorkers = sleepSilentDetachedWorkers();
  for (const quiet of quietWorkers) {
    if (quiet.report) await recordAgentMessage(quiet.report, "sent");
  }
  // The admitted workstream is first-hand evidence that this agent is active. It says nothing
  // about whether the browser route currently has a live page.
  const alive = noteAgentAliveForWorkstream(context.workstreamId);
  if (alive?.report) await recordAgentMessage(alive.report, "sent");
  // A prime message accepted while a worker's tab was closed could not safely be injected while
  // that server-side turn might still be running. If the silence check above has now proved the
  // worker stopped, carry that already-durable unread work into a revival instead of leaving it
  // stranded until the prime happens to send a second message. Do this after noteAgentAlive so a
  // tool call from the supposedly quiet worker wins and simply keeps the worker active.
  const deferredWake = stageQueuedWorkerRevivals(
    quietWorkers.map((entry) => entry.info.id),
  );
  if (deferredWake.waking.length > 0) {
    try {
      if (await persistCriticalSwarmNow()) {
        deferredWake.commit();
        requestWorkerRevivals(deferredWake.waking);
      } else {
        deferredWake.rollback();
        logWarn(
          "multi-agent: could not durably reserve queued work for a worker that just fell asleep",
        );
      }
    } catch (err) {
      deferredWake.rollback();
      logWarn(
        `multi-agent: could not durably reserve queued work for a worker that just fell asleep — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  context.agent = isFinish
    ? agentForFinishCaller(context.caller)
    : agentForCaller(context.caller);
  const refusal = workerFenceRefusal(context.workstreamId, isFinish);
  const result = await runInCallContext(context, () =>
    refusal ? Promise.resolve(fail(refusal)) : run(),
  );
  // Never erase an identity a handler proved more strongly (agents::callerNow). The old
  // post-handler pass could fail to rediscover evidence that callerNow had already reserved
  // and then set agent back to null, which is the live WORKER_IDENTITY_LOST / missing-inbox
  // split brain worker-1 observed.
  if (!context.agent) {
    context.agent = isFinish
      ? agentForFinishCaller(context.caller)
      : agentForCaller(context.caller);
  }
  // This call is the best evidence there is that the previous result reached the agent's
  // conversation, so anything offered then can be retired and written to its history —
  // except what was offered on a finish result, which this call may itself be the model's
  // retry after a lost result. The SDK exposes the JSON-RPC id, but a model-issued retry is
  // a new MCP request with a new id, so that id cannot prove the previous finish result was
  // seen. The broker therefore re-offers rather than assuming; see acknowledgeOffers.
  const acknowledgedForWorkstream = acknowledgeOffersForWorkstream(
    context.workstreamId,
    isFinish,
    startedAt,
    isFinish,
  );
  const acknowledged =
    acknowledgedForWorkstream?.messages ??
    (context.agent
      ? acknowledgeOffers(context.agent, isFinish, startedAt)
      : []);
  for (const message of acknowledged) {
    // Delivery ownership was already resolved by the admitted workstream above. Recording must
    // not re-resolve a parked prime through whichever browser conversation happens to be active.
    await recordAgentMessage(
      message,
      "delivered",
    );
  }
  // This is the MCP call's wall-clock latency. A managed child can outlive the call, and
  // its own lifetime is process evidence; letting that number overwrite ToolCallRecord's
  // duration is what made a 10s yield read like a command that had completed in 10s.
  const durationMs = Date.now() - startedAt;
  // Inbox messages are part of the MCP result ChatGPT actually receives. Build the delivered
  // result before recording so session(action=read, tool_call=T…) is genuine wire forensics rather than a
  // subtly earlier internal value that omits the worker report most likely to matter later.
  const delivered = withInbox(
    context.workstreamId,
    context.agent,
    result,
    isFinish,
  );
  const recorderStartedAt = Date.now();
  const recording = recordToolCall({
    tool: name,
    args,
    content: delivered.content,
    outcome: context.outcome ?? (result.isError ? "rejected" : "ok"),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent,
    requestId: context.caller.requestId,
    conversationId: context.caller.conversationId,
    workstreamId: context.workstreamId,
    workstreamSessionId: context.workstreamSessionId,
    attributionMethod: "workstream",
    inferredConversationId: context.caller.inferredConversationId ?? null,
    inferredMethod: context.caller.inferredMethod ?? null,
  });
  // The admitted workstream supplies identity before execution. Recording belongs to this
  // request's completion boundary, with no browser grace window or fleet-wide charge.
  await recording;
  if (name === "observe" || name === "computer") {
    logInfo(
      `desktop timing recorder_wait_ms=${Date.now() - recorderStartedAt} attributed=true`,
    );
  }
  // Retire a completed run only after this call has had every chance to acknowledge and
  // receive its inbox. Doing it inside acknowledgeOffers would let `agents status` destroy
  // the run halfway through identifying itself; here the handler and result are already done.
  releaseQuiescentRun();
  return delivered;
}

/** Why a call from this workstream may not run a local tool, or null when it may. */
function workerFenceRefusal(
  workstreamId: string | null,
  isFinish: boolean,
): string | null {
  // Parking a run releases its global execution claim without retiring its worker chats. Those
  // exact conversations remain workers, though: a stale sleeping/terminal worker tab must not
  // turn into an ordinary unidentified chat and keep running local tools merely because another
  // prime currently owns the active run (or because no run is active at all). Only the owning
  // prime's explicit agents message may wake a sleeping worker.
  const dormantWorker = isFinish
    ? null
    : dormantWorkerNoticeForWorkstream(workstreamId);
  if (dormantWorker) return dormantWorker;
  const retiredWorker = retiredWorkerForWorkstream(workstreamId);
  if (retiredWorker) {
    return (
      `WORKER_RETIRED: nothing was run. The app retired this worker chat (${retiredWorker.reason}), so no tool will run ` +
      "from it again. Files you changed stay in the repository. End your turn with a plain reply saying where you stopped."
    );
  }
  // A worker that really is over learns so on its own next call. Without this its calls
  // resolved to nobody and ran anyway, so a chat the user had ended went on writing files
  // in the name of no agent at all.
  // A terminal worker may do exactly one thing: retry its own idempotent finish after a lost
  // result. It still has a tombstone identity for that call so the dispatcher can re-offer the
  // inbox that rode on the missing result. Every other tool call from the same chat is refused
  // by endedWorkerNotice as before.
  return isFinish ? null : endedWorkerNoticeForWorkstream(workstreamId);
}

/**
 * One tool call made from inside a code-mode `exec` script.
 *
 * The child runs under the workstream claim that admitted its `exec` call; the registrar
 * re-admits that claim first, so a workstream reclaimed while the script awaits refuses its
 * next child. The child does not acknowledge or carry the worker inbox — that rides on the
 * outer result. It passes the same worker fences, the handler's live permission checks and
 * the per-tool gates, and it is recorded as its own tool call, marked nested.
 */
async function dispatchNested(
  parent: CallContext,
  name: string,
  args: unknown,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const context: CallContext = {
    startedAt: Date.now(),
    tool: name,
    workstreamId: parent.workstreamId,
    workstreamClaimId: parent.workstreamClaimId,
    workstreamSessionId: parent.workstreamSessionId,
    transportKey: parent.transportKey,
    agent: parent.agent,
    caller: { ...parent.caller },
    outcome: null,
    evidence: emptyEvidence(),
  };
  return trackMcpRequest(() =>
    trackInFlight(context, async () => {
      const refusal =
        name === "exec"
          ? "CODE_MODE_RECURSION: exec cannot call exec. No tool was run."
          : isFinishCall(name, args)
            ? "CODE_MODE_FINISH: call agents action=finish directly, not from exec. No tool was run."
            : workerFenceRefusal(context.workstreamId, false);
      const result = await runInCallContext(context, () =>
        refusal
          ? Promise.resolve(fail(refusal))
          : run(),
      );
      await recordToolCall({
        tool: name,
        args,
        content: result.content,
        outcome: context.outcome ?? (result.isError ? "rejected" : "ok"),
        durationMs: Date.now() - context.startedAt,
        startedAt: context.startedAt,
        evidence: context.evidence,
        agent: context.agent,
        requestId: context.caller.requestId,
        conversationId: context.caller.conversationId,
        workstreamId: context.workstreamId,
        workstreamSessionId: context.workstreamSessionId,
        attributionMethod: "workstream",
        inferredConversationId: context.caller.inferredConversationId ?? null,
        inferredMethod: context.caller.inferredMethod ?? null,
        nested: true,
      });
      surfaceToolCallAt.set(surface, Date.now());
      return result;
    }),
  );
}

/**
 * Adopts an identity established *inside* a tool call.
 *
 * The dispatcher can only resolve a caller from what the call carried, which for the prime
 * is nothing at all. The `agents` tool proves who is calling from evidence rendered after
 * that call began, and this is how that answer gets back to the layers that need it: the
 * record this call will be filed under, and the inbox attached to its result. Called only
 * from the one tool that does that work, and only with an id it has just proven.
 */
export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent) return;
  context.agent = agent;
  // Identity adoption is intentionally pure. A handler may prove identity more strongly than
  // ingress could, but it must not also retire inbox state: the dispatcher owns exactly one ACK
  // point after the handler, where it knows whether this call is a finish retry and can apply
  // the finish-specific at-least-once rule correctly.
}

function isFinishCall(name: string, args: unknown): boolean {
  if (name !== "agents") return false;
  if (!args || typeof args !== "object") return false;
  return (args as Record<string, unknown>)["action"] === "finish";
}

/**
 * A path named by a tool call, resolved against the chat's workspace when it is relative.
 *
 * Every path argument in every tool goes through here rather than calling `resolvePath`
 * directly, for two reasons. Shorthand then means the same thing in `read` as in `exec` as in
 * `apply_patch` — a model that learns it once has learned it everywhere — and the workspace is
 * learned from every absolute path a call has *proved* it can reach, so no tool has to
 * remember to teach it.
 *
 * The sandbox underneath is untouched. `resolvePath` still performs every root, containment,
 * `..` and symlink check it ever did; the workspace only supplies a prefix for a path that
 * arrived without one, before any of that runs. A chat with no workspace gets the same
 * refusal it would have got for a relative path before, which is why ambiguity here costs a
 * retry rather than reaching the wrong file.
 */
export async function resolveIn(
  roots: Parameters<typeof resolvePath>[0],
  requested: string,
  options: { allowMissing?: boolean; base?: string | null } = {},
): Promise<Resolved> {
  let workspace = currentWorkspace();
  if (!workspace && options.base === undefined) {
    const logicalWorkstream = currentCall()?.workstreamId ?? null;
    const remembered = logicalWorkstream
      ? workstreamWorkspace(logicalWorkstream)
      : null;
    if (remembered) {
      const restored = await resolvePath(roots, remembered);
      setCurrentWorkspace({ real: restored.real, virtual: restored.virtual });
      workspace = currentWorkspace();
    }
  }
  // An explicit adapter-supplied base beats the workspace; otherwise the workspace is the base.
  // Either way the joining happens inside `resolvePath`, ahead of validation,
  // so a `..` in the caller's text still meets `checkSegment` instead of being normalised
  // away first. Doing that join here is how a relative patch path could climb out of the
  // workspace: `posix.normalize('/root/a/../../elsewhere')` is a perfectly clean-looking
  // `/elsewhere`, and nothing downstream can tell it apart from a path that was always that.
  const base =
    options.base !== undefined
      ? options.base
      : (workspace?.virtual ?? null);
  const resolved = await resolvePath(roots, requested, {
    ...(options.allowMissing === undefined
      ? {}
      : { allowMissing: options.allowMissing }),
    base,
  });
  // Absolute only: a workspace learned from a relative path would let one loose resolution
  // decide where the next loose resolution points. See workspace.ts.
  if (isAbsoluteVirtualPath(requested) || isNativeWindowsPath(requested))
    await learnWorkspace(resolved);
  return resolved;
}

export interface ResolvedCwd {
  real: string;
  virtual: string;
  /** True when the caller named no folder, so the workspace or first root was used instead. */
  defaulted: boolean;
}

/**
 * The working directory a command tool may use, restricted to an approved root.
 *
 * The caller is told which folder this turned out to be, and whether it was a default,
 * because omitting `workdir` while working inside a nested project is a quiet way to run the
 * wrong build: a live run meant for `…/minecraft-web-demo` fell back to the first root and
 * rebuilt the parent Electron app instead, and nothing in the reply said so.
 */
export async function resolveCwd(
  ctx: ToolContext,
  virtualPath: string | undefined,
): Promise<ResolvedCwd> {
  // The chat's own folder before the first root: a command with no `workdir` should run where the
  // chat has been working, which is the whole point of the workspace and is exactly the case
  // the note above describes going wrong.
  const workspace = currentWorkspace();
  // Codex treats an explicitly empty workdir exactly like an omitted one.
  const provided = virtualPath !== undefined && virtualPath !== "";
  if (!provided && !workspace && swarmRunning()) {
    throw new SandboxError(
      "WORKSPACE_REQUIRED: this multi-agent chat has no proven workspace. Supply an explicit approved workdir before running a command.",
    );
  }
  const target = provided
    ? virtualPath
    : (workspace?.virtual ?? (ctx.roots[0] ? `/${ctx.roots[0].name}` : ""));
  if (!target)
    throw new SandboxError("No folder is approved, so there is nowhere to run");
  const resolved = await resolveIn(ctx.roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new SandboxError("workdir must be a folder");
  return {
    real: resolved.real,
    virtual: resolved.virtual,
    defaulted: !provided,
  };
}

// ------------------------------------------------------------------ shared args

export const pathArg = z.string().min(1).max(4096);
export const lineNumberArg = z.number().int().min(1).max(100_000_000);
export const windowIdArg = z.number().int().min(1).max(4_294_967_295);
export const imageCoordinateArg = z.number().int().min(-100_000).max(100_000);
// Zod's plain object parser strips unknown keys even though its generated JSON Schema says
// additionalProperties=false. Keep runtime validation as strict as the wire contract so a
// misspelled coordinate/crop field cannot be silently discarded.
export const pointArg = z
  .object({ x: imageCoordinateArg, y: imageCoordinateArg })
  .strict();
export const cropArg = z
  .object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(1).max(100_000),
  })
  .strict();
export const mouseButtonArg = z.enum(["left", "right", "middle"]);
// ------------------------------------------------------------------ registration

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * What a surface module is handed to register its tools with.
 *
 * Passing a small object rather than the raw `McpServer` is what keeps the two surface
 * modules from being able to diverge on the things that must not differ: every tool goes
 * through `dispatch`, every tool gets the agent key under the same condition, and every
 * capability refusal reads the same. A surface decides *which* tools exist, never how a
 * tool is wired up.
 */
export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  /** Whether `find` is part of this endpoint's surface. See ToolContext.exposedFind. */
  findExposed: boolean;
  register<Schema extends z.ZodObject>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: Schema;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>,
  ): void;
  /** Runs `fn` only while `cap` is live, and explains the refusal otherwise. */
  guarded(
    cap: keyof Capabilities,
    name: string,
    fn: () => Promise<ToolResult>,
  ): Promise<ToolResult>;
  /** Refusal used when a whole feature is off but its tool is still exposed. */
  featureDisabled(feature: string, setting: string): ToolResult;
  /** Names actually registered on this server, in registration order. */
  registered(): string[];
  /** Runs a registered tool from inside a code-mode `exec` script under its parent's claim. */
  invokeNested(
    name: string,
    args: unknown,
    parent: CallContext,
  ): Promise<ToolResult>;
  descriptions(): Array<{ name: string; description: string }>;
}

// ------------------------------------------------------------------ emergency recovery bypass
//
// Temporary, exact-chat maintenance exception, installed only while the unscoped
// setup/attachment operation was absent. Gated entirely on process environment so it is
// inert everywhere unless the daemon is launched with the recovery credentials.
//
// It does NOT create, claim, renew, retire, or otherwise touch a workstream, and it does
// NOT alter conversation-key bindings. It lets a single known chat reach the four
// filesystem/execution tools directly, bypassing workstream admission. Remove this block
// and its systemd drop-in once the `workstream` setup tool is confirmed live.

const recoveryConversationKey =
  process.env.COS_RECOVERY_CONVERSATION_KEY?.trim() ?? "";

const recoveryWorkstreamLock =
  process.env.COS_RECOVERY_WORKSTREAM_LOCK?.trim() ?? "";

const RECOVERY_TOOL_NAMES = new Set([
  "read",
  "exec_command",
  "apply_patch",
  "write_stdin",
]);

function isEmergencyRecoveryCall(
  toolName: string,
  workstreamId: string | undefined,
): boolean {
  if (!recoveryConversationKey || !recoveryWorkstreamLock) return false;
  // The recovery sentinel rides the ordinary workstream_id slot on this exact chat. It is
  // the value of the old `workstream_lock` recovery credential, now carried in the single
  // identity field the ordinary-tool schema exposes.
  if (workstreamId !== recoveryWorkstreamLock) return false;
  return RECOVERY_TOOL_NAMES.has(toolName);
}

/**
 * The per-tool gates every admitted call passes before its handler runs.
 *
 * `exec` passes none itself: it does no local work, and each child it dispatches passes them
 * under its own tool name.
 */
function gatedHandler(
  name: string,
  roots: Root[],
  handler: (args: never) => Promise<ToolResult>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  if (name === "exec") return (args) => handler(args as never);
  return async (args) => {
    // A chat acts only after it has read its repository's rules (rules-gate.ts).
    const unread = await rulesGateRefusal(
      name,
      async (virtualWorkspace) => (await resolvePath(roots, virtualWorkspace)).real,
    );
    if (unread) return fail(unread);
    const reusePending = reusePendingRefusal(name, args);
    if (reusePending) return fail(reusePending);
    noteSearch(name, args);
    if (name !== "exec_command" && name !== "write_stdin") return handler(args as never);
    // Shell commands can mint definitions without apply_patch; see reuse-gate.ts.
    // No workspace: the workstream has no repository to watch. A workspace that fails
    // to resolve is an error for this call, never an unwatched command.
    const workstreamId = currentCall()?.workstreamId ?? null;
    const workspace = workstreamId ? workstreamWorkspace(workstreamId) : null;
    const root = workspace ? (await resolvePath(roots, workspace)).real : null;
    const snapshot = await snapshotBeforeCommand(root);
    const result = await handler(args as never);
    const minted = await noteCommandMinted(snapshot);
    if (minted.length > 0 && result && Array.isArray((result as { content?: unknown }).content)) {
      (result as { content: Array<{ type: "text"; text: string }> }).content.push({
        type: "text",
        text:
          `REUSE_SEARCH_PENDING: this command added ${minted.join(", ")} without a reuse record. ` +
          "Every tool except read and find is now refused until an apply_patch carries a reuse_search covering those names: " +
          "the searches you ran for existing owners, what they found and why none is reused.",
      });
    }
    return result;
  };
}

/** `server` is null for the per-child registrar code mode builds against live permissions. */
export function createRegistrar(
  server: McpServer | null,
  ctx: ToolContext,
  surface: SurfaceId,
): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  // These two do not follow a capability checkbox: they are whole features the user
  // switches on in the app, and neither touches the filesystem. Like the capability
  // tools they are exposed monotonically and disabled at the handler, so switching a
  // feature off does not delete a tool a cached ChatGPT snapshot still believes in.
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;
  const findExposed =
    ctx.exposedFind ?? (!exposedCaps.command && exposedCaps.search);
  const names: string[] = [];
  const handlers = new Map<
    string,
    { description: string; run: (args: unknown) => Promise<ToolResult> }
  >();

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    descriptions: () =>
      [...handlers].map(([name, entry]) => ({ name, description: entry.description })),
    async invokeNested(name, args, parent) {
      const admitted = parent.workstreamClaimId
        ? await admitWorkstreamCall(parent.workstreamClaimId)
        : null;
      if (!admitted?.ok)
        return fail(
          "WORKSTREAM_SETUP_REQUIRED: the workstream this exec call ran under was claimed again while the script " +
            "was running, so this nested call did not run. Stop the script's work and call the workstream tool with " +
            'action="continue".',
        );
      return dispatchNested(parent, name, args, surface, async () => {
        const entry = handlers.get(name);
        return entry
          ? entry.run(args)
          : fail("UNKNOWN_TOOL: this tool is not available on this connector.");
      });
    },
    register(name, config, handler) {
      names.push(name);
      const gated = gatedHandler(name, ctx.roots, handler as (args: never) => Promise<ToolResult>);
      // The MCP SDK validates wire arguments; a code-mode child arrives without that layer,
      // so it is validated here against the same schema. Zod issues omit input values.
      handlers.set(name, {
        description: config.description,
        run: async (args) => {
          const parsed = await config.inputSchema.safeParseAsync(args);
          if (parsed.success) return gated(parsed.data as Record<string, unknown>);
          const details = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.map(String).join(".").slice(0, 80) || "arguments"}: ${issue.message.slice(0, 300)}`)
            .join("; ");
          return fail(`INVALID_ARGUMENTS: ${details}`);
        },
      });
      if (!server) return;
      const inputSchema = config.inputSchema.safeExtend({
        workstream_id: z
          .string()
          .min(1)
          .max(150)
          .describe(
            "The identity token returned after this chat registers/claims a logical workstream with the `workstream` setup tool. Reuse it on every ordinary Core/Desktop call under that workstream.",
          ),
      });
      server.registerTool(name, { ...config, inputSchema }, (async (
        input: Record<string, unknown>,
        mcpCtx?: McpCallContext,
      ) => {
        const { workstream_id, ...args } = input;
        if (isEmergencyRecoveryCall(name, workstream_id as string)) {
          logWarn(`EMERGENCY_RECOVERY_BYPASS tool=${name} surface=${surface}`);
          return dispatch(
            name,
            args,
            mcpCtx?.sessionId ?? null,
            requestIdOf(mcpCtx),
            surface,
            null,
            null,
            null,
            () => handler(args as never),
          );
        }
        const admitted = await admitWorkstreamCall(workstream_id as string);
        if (!admitted.ok) {
          if (admitted.code === "WORKSTREAM_BUSY")
            return fail(
              "WORKSTREAM_BUSY: a command started by an earlier chat of this workstream is still finishing " +
                "(usually within a minute), so nothing was run. Spend a minute reading or planning, then repeat this exact " +
                "call with the same workstream_id. Do not call the workstream tool again.",
            );
          return fail(
            "WORKSTREAM_SETUP_REQUIRED: this workstream_id is missing or out of date (the workstream was claimed " +
              "again, for example after a restart or by a newer chat), so nothing was run. Call the workstream tool " +
              'with action="continue" and your workstream name (action="start" only for a brand-new one), then repeat ' +
              "this call with the workstream_id it returns.",
          );
        }
        return dispatch(
          name,
          args,
          mcpCtx?.sessionId ?? null,
          requestIdOf(mcpCtx),
          surface,
          admitted.id,
          workstream_id as string,
          admitted.sessionId,
          () => gated(args),
        );
      }) as never);
    },
    guarded(cap, name, fn) {
      return guard(name, async () => {
        if (!caps[cap]) {
          return fail(
            `TOOL_DISABLED: ${name} is disabled by the current Chat On Steroids permissions. ` +
              "Ask the user to enable the permission in the app, then retry. If the tool list in this conversation is stale, start a new chat.",
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in Chat On Steroids. ` +
          `Ask the user to enable "${setting}" in the app, then try again.`,
      );
    },
  };
}

// ------------------------------------------------------------------ formatters

/**
 * Largest brief a handoff save will accept.
 *
 * Generous on purpose. A brief that hits this is a symptom — the compaction of a very
 * long session — and refusing it there would throw away the one artefact the whole flow
 * exists to produce. The bound is only to keep a runaway generation from being written
 * to disk unbounded; at roughly four characters per token this is comfortably past any
 * single ChatGPT answer.
 */
export const MAX_HANDOFF_CHARS = 400_000;

/**
 * Recovers the complete text behind a stored field.
 *
 * A long tool argument or result is bounded inline in the log and written whole beside
 * it; this reads the whole one back so recovery means the exact payload rather than
 * its first eight thousand characters. `complete` is false only when even the overflow
 * copy could not be written, and the caller says so instead of implying otherwise.
 */
export async function expandStored(
  sessionId: string,
  stored: StoredText,
): Promise<{ text: string; complete: boolean }> {
  if (!stored.truncated) return { text: stored.text, complete: true };
  if (stored.assetId) {
    const full = await readOverflowText(sessionId, stored.assetId);
    if (full !== null) return { text: full, complete: true };
  }
  return { text: stored.text, complete: false };
}

/** Splits on blank lines so a part never ends mid-sentence unless a block is huge. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const parts: string[] = [];
  let current = "";
  for (const block of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= size) {
      current = block;
    } else {
      for (let at = 0; at < block.length; at += size)
        parts.push(block.slice(at, at + size));
      current = "";
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [""];
}

/** The per-path header `read` prints. This is what `file_info` used to be. */
export function formatFileInfo(info: FileInfo): string {
  const lines = [
    `path: ${info.virtualPath}`,
    `type: ${info.type}`,
    `size: ${formatBytes(info.bytes)}`,
    `modified: ${info.modified}`,
    `created: ${info.created}`,
  ];
  if (info.readOnly) lines.push("readonly: true");
  if (info.binary !== null) lines.push(`binary: ${info.binary}`);
  if (info.lines !== null) lines.push(`lines: ${info.lines}`);
  if (info.sha256) lines.push(`sha256: ${info.sha256}`);
  return lines.join("\n");
}
