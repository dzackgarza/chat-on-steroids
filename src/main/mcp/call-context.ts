/**
 * Per-tool-call context.
 *
 * Two problems are solved by the same small store. Tool handlers know things the
 * generic recorder cannot infer — which files changed by how many lines, what a
 * command exited with, how many matches a search found — and the recorder wants that
 * evidence without every handler growing an extra parameter. And in multi-agent mode
 * every log line and every recorded call has to be attributed to the agent that made
 * it, which is decided once per request rather than at each call site.
 *
 * AsyncLocalStorage keeps this correct while several tool calls are in flight: each
 * call sees its own store, and code running outside a call sees nothing at all.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssetRef, FileChange, ToolOutcome } from '../../shared/session.js';

export interface CallEvidence {
  changes: FileChange[];
  assets: AssetRef[];
  /** Result count for searches and listings. */
  count: number | null;
  /** Free-form qualifier the summariser may use, e.g. "lines 200-420". */
  detail: string | null;
  exitCode: number | null;
  timedOut: boolean;
  /** Child/process lifetime when the command surface measured it itself. */
  durationMs: number | null;
  /** Explicit child state; null for non-process tools and older call sites. */
  running: boolean | null;
  /** Managed-process id when the command continues beyond one MCP response. */
  processSessionId: string | null;
}

/**
 * Per-call routing/diagnostic metadata.
 *
 * Ordinary caller authority is `CallContext.workstreamId` plus its opaque claim token. The
 * browser/request fields below are optional evidence about which ChatGPT frontend displayed a
 * call; they may support recording diagnostics but never grant tool/agent/workspace authority.
 */
export interface CallCaller {
  /** Logical workstream admitted for this call. Ordinary caller identity authority. */
  workstreamId?: string | null;
  transportKey: string | null;
  /**
   * ChatGPT's own id for this request, from the `x-request-id` header the connector
   * arrives with, trimmed to the part before the `/`.
   *
   * Historical/diagnostic join only. ChatGPT stamps the same id on the request in its own
   * message model and the extension may report it from a page.
   * Measured live on 2026-08-18: header `wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1`
   * against page evidence `read#wfr_01a014bdd7cd7a15b6b533d3ce2b42f2`.
   */
  requestId: string | null;
  /**
   * ChatGPT conversation associated by optional browser/request evidence. Not caller authority.
   */
  conversationId: string | null;
  /**
   * The opaque connector session key the transport arrived with (`x-openai-session`), when
   * it sent one. Not identity by itself; see connector-session.ts for how it becomes a
   * degraded attribution tier.
   */
  sessionKey?: string | null;
  /**
   * The conversation inferred from degraded evidence at arrival, when exact proof was
   * absent: the only managed chat generating (`temporal_unique`) or a session key bound at
   * such a moment (`connector_session`). Charge-scoping and recording diagnostics only.
   */
  inferredConversationId?: string | null;
  inferredMethod?: 'push_correlated' | 'temporal_unique' | 'connector_session' | null;
}

export interface CallContext {
  /** Wall-clock start of this MCP request, shared by identity-sensitive handlers. */
  startedAt: number;
  /** MCP tool name, so an in-flight call can be named in a refusal without a second lookup. */
  tool: string;
  /** Logical workstream admitted for this call, when the connector supplied one. */
  workstreamId: string | null;
  /** Opaque claim token that admitted this call; rotates on every workstream reclaim. */
  workstreamClaimId: string | null;
  /** Durable recorder session owned by the logical workstream, when already established. */
  workstreamSessionId: string | null;
  /** Stable per-conversation key when the transport offers one, else null. */
  transportKey: string | null;
  /** Resolved agent id in multi-agent mode, else null. */
  agent: string | null;
  /** Who this call was proven to be, for the broker tools to route by. */
  caller: CallCaller;
  /**
   * Set by the tool guard, which is the only code that can tell a refusal apart from
   * a genuine failure — both come back to the model as an error result.
   */
  outcome: ToolOutcome | null;
  evidence: CallEvidence;
}

const storage = new AsyncLocalStorage<CallContext>();

export function emptyEvidence(): CallEvidence {
  return {
    changes: [],
    assets: [],
    count: null,
    detail: null,
    exitCode: null,
    timedOut: false,
    durationMs: null,
    running: null,
    processSessionId: null
  };
}

export function runInCallContext<T>(context: CallContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Tool-call lifetime state, split by what is still capable of changing the machine.
 *
 * `running` is the request that has not returned from dispatch yet. This is the count the
 * ChatGPT-native compaction barrier cares about: interrupting the ChatGPT turn does not stop
 * a command/edit already inside this process, and a handoff written while that work is still
 * live can describe a machine state that changes underneath the fresh chat.
 *
 * `settling` is deliberately different. It is a handler that has already returned and whose
 * MCP result has been released, but whose durable session record is still waiting for late
 * browser attribution. The recorder can spend REQUEST_ID_GRACE_MS there. Keeping that state
 * observable is useful for diagnostics and shutdown/orphan accounting, but it is bookkeeping:
 * it must not make every chat wait ~15 seconds before a compaction may describe an otherwise
 * settled machine.
 *
 * Both states are charged per conversation. A proven worker never blocks an unrelated prime;
 * an unproven owner is charged to every chat that could have issued the call, which without
 * an injected {@link UnattributedChargeScope} means every chat there is.
 */
const running = new Set<CallContext>();
const settling = new Set<CallContext>();
let inFlightRequests = 0;

/**
 * Whether a conversation could be the origin of an unplaced call that arrived at `arrivedAt`.
 *
 * Injected rather than imported: this module is the one every tool surface depends on, and
 * the evidence lives in the session recorder, which depends on *it*. The composition root
 * (bridge.ts) owns the wiring; passing nothing keeps the original charge-every-chat answer,
 * which is what the pure unit tests of this module measure.
 *
 * See `mayOwnUnattributedCall` in session/recorder.ts for the evidence behind a `false`.
 */
export type UnattributedChargeScope = (
  conversationId: string,
  arrivedAt: number,
  workstreamId?: string | null,
) => boolean;

function countFor(
  calls: Iterable<CallContext>,
  conversationId: string | null,
  scope: UnattributedChargeScope | null
): number {
  let count = 0;
  for (const call of calls) {
    if (charged(call, conversationId, scope)) count += 1;
  }
  return count;
}

/**
 * Whether `call` counts against `conversationId` (or, for a null id, against the fleet).
 *
 * An exact owner scopes the charge; a degraded-evidence inferred owner scopes it too — that
 * is the point of the 2026-09 tiers: the blast radius shrinks exactly where evidence exists.
 * The truly ambiguous call — no exact and no inferred owner — is the one that used to be
 * charged against every chat unconditionally, which deadlocked the control path at fleet
 * width. It is now charged against every chat that could actually have issued it, which is
 * still every chat whenever the app has no evidence to the contrary.
 */
function charged(
  call: CallContext,
  conversationId: string | null,
  scope: UnattributedChargeScope | null
): boolean {
  if (conversationId === null) return true;
  const owner = call.caller.conversationId ?? call.caller.inferredConversationId ?? null;
  if (owner !== null) return owner === conversationId;
  return scope === null || scope(conversationId, call.startedAt, call.workstreamId);
}

/** Requests still inside dispatch, and therefore still potentially doing tool work. */
export function runningToolCalls(
  conversationId: string | null = null,
  scope: UnattributedChargeScope | null = null
): number {
  return countFor(running, conversationId, scope);
}

/** One in-flight call, as a steward reading a refusal needs to see it. */
export interface InFlightCall {
  tool: string;
  ageMs: number;
  /** Stable logical workstream that admitted this call. */
  workstreamId: string | null;
  /** Opaque claim token that admitted this call. */
  workstreamClaimId: string | null;
  /** The conversation this call is charged to, or null when nothing has placed it yet. */
  conversationId: string | null;
  /** How that owner was established; `unattributed` is the charge-everyone case. */
  attribution: 'exact' | 'push_correlated' | 'temporal_unique' | 'connector_session' | 'unattributed';
}

/**
 * The calls a refusal is actually about, oldest first.
 *
 * A bare "3 tool calls in flight" is what drove the composer workaround: it cannot be told
 * apart from a wedged app, so a steward reading it has no next action. The same refusal
 * carrying "exec_command, 62 minutes, unattributed" is a decision the steward can make —
 * which is why the app reports the set and never judges it. Nothing here expires, abandons
 * or sweeps a call: a long call is a fact about the fleet, and the agent driving the fleet
 * is the one placed to know whether it is plausible.
 *
 * A row whose `conversationId` is null is an unplaced call: it is charged against every
 * conversation the scope predicate cannot rule out, so it is the row to watch when an idle
 * chat is refused.
 */
export function inFlightCallCensus(
  conversationId: string | null = null,
  limit = 20,
  scope: UnattributedChargeScope | null = null
): InFlightCall[] {
  const now = Date.now();
  const rows: InFlightCall[] = [];
  for (const call of running) {
    if (!charged(call, conversationId, scope)) continue;
    const exact = call.caller.conversationId ?? null;
    const owner = exact ?? call.caller.inferredConversationId ?? null;
    rows.push({
      tool: call.tool,
      ageMs: Math.max(0, now - call.startedAt),
      workstreamId: call.workstreamId,
      workstreamClaimId: call.workstreamClaimId,
      conversationId: owner,
      attribution: exact ? 'exact' : (call.caller.inferredMethod ?? 'unattributed')
    });
  }
  rows.sort((left, right) => right.ageMs - left.ageMs);
  return rows.slice(0, limit);
}

/** Running calls owned by one logical workstream, independent of browser attribution. */
export function runningToolCallsForWorkstream(
  workstreamId: string,
  claimId: string | null = null,
): number {
  let count = 0;
  for (const call of running) {
    if (call.workstreamId !== workstreamId) continue;
    if (claimId !== null && call.workstreamClaimId !== claimId) continue;
    count += 1;
  }
  return count;
}

/** In-flight calls owned by one logical workstream, oldest first. */
export function inFlightCallsForWorkstream(
  workstreamId: string,
  limit = 20,
): InFlightCall[] {
  const now = Date.now();
  return [...running]
    .filter((call) => call.workstreamId === workstreamId)
    .map((call) => {
      const exact = call.caller.conversationId ?? null;
      const owner = exact ?? call.caller.inferredConversationId ?? null;
      const attribution: InFlightCall['attribution'] = exact
        ? 'exact'
        : (call.caller.inferredMethod ?? 'unattributed');
      return {
        tool: call.tool,
        ageMs: Math.max(0, now - call.startedAt),
        workstreamId: call.workstreamId,
        workstreamClaimId: call.workstreamClaimId,
        conversationId: owner,
        attribution,
      };
    })
    .sort((left, right) => right.ageMs - left.ageMs)
    .slice(0, limit);
}

/** Finished tool work whose unattributed durable record is still landing. */
export function settlingToolCalls(
  conversationId: string | null = null,
  scope: UnattributedChargeScope | null = null
): number {
  return countFor(settling, conversationId, scope);
}

/**
 * Conservative total used by diagnostics/tests that mean "not fully accounted for yet".
 * A context can briefly appear in both sets during the handoff to recorder settling, so count
 * the union rather than summing the two public projections.
 */
export function inFlightToolCalls(
  conversationId: string | null = null,
  scope: UnattributedChargeScope | null = null
): number {
  const seen = new Set<CallContext>();
  for (const call of running) seen.add(call);
  for (const call of settling) seen.add(call);
  return countFor(seen, conversationId, scope);
}

/**
 * Keeps a finished call observable while its record is still being written.
 *
 * The unidentified path does not await its own recorder: the append may still spend a grace
 * window waiting for the page to name the conversation, and the model must not wait for
 * that. But the call is not settled either, and dropping it the moment the handler returned
 * left a window in which every chat read zero while an unattributed call was still landing —
 * an attribution/recorder diagnostic would otherwise show a false zero. It is intentionally
 * not part of `runningToolCalls()`: the handler has returned, so recorder bookkeeping cannot
 * mutate the workspace the compaction barrier is trying to freeze.
 */
export function holdWhileSettling(context: CallContext, work: Promise<unknown>): void {
  settling.add(context);
  void work.then(
    () => settling.delete(context),
    () => settling.delete(context)
  );
}

/**
 * MCP requests that have entered dispatch, including time spent waiting for exact browser
 * request-id evidence and the durable recorder append after the handler itself returns.
 * Orphan cleanup needs this wider counter so those gaps can never look like global idleness.
 */
export function inFlightMcpRequests(): number {
  return inFlightRequests;
}

export async function trackMcpRequest<T>(fn: () => Promise<T>): Promise<T> {
  inFlightRequests += 1;
  try {
    return await fn();
  } finally {
    inFlightRequests -= 1;
  }
}

/**
 * Counts one call for as long as it runs, however it ends.
 *
 * Takes the context rather than reading the async store, because it wraps `runInCallContext`
 * rather than running inside it — and holding the object means a conversation identified
 * part-way through the call is charged correctly from that moment on.
 */
export async function trackInFlight<T>(context: CallContext, fn: () => Promise<T>): Promise<T> {
  running.add(context);
  try {
    return await fn();
  } finally {
    running.delete(context);
  }
}

export function currentCall(): CallContext | null {
  return storage.getStore() ?? null;
}

/** Agent id for the call currently running, or null outside one. */
export function currentAgent(): string | null {
  return storage.getStore()?.agent ?? null;
}

/** Who the running call was proven to be. Empty outside a call. */
export function currentCaller(): CallCaller {
  return storage.getStore()?.caller ?? { transportKey: null, requestId: null, conversationId: null };
}

export function noteOutcome(outcome: ToolOutcome): void {
  const store = storage.getStore();
  if (!store) return;
  // A lower-severity wrapper result must never erase a more specific outcome the tool
  // already established. The concrete live failure was exec_command: noteExec() marked a
  // non-zero child exit as `error`, then guard() saw an ordinary (non-isError) ToolResult
  // and overwrote it with `ok`. Session history consequently showed a failed build as a
  // successful MCP call. Keep the strongest fact seen during the call instead.
  const rank: Record<ToolOutcome, number> = { ok: 0, rejected: 1, error: 2 };
  if (store.outcome === null || rank[outcome] > rank[store.outcome]) store.outcome = outcome;
}

export function noteChange(change: FileChange): void {
  storage.getStore()?.evidence.changes.push(change);
}

export function noteChanges(changes: readonly FileChange[]): void {
  const store = storage.getStore();
  if (store) store.evidence.changes.push(...changes);
}

export function noteAsset(asset: AssetRef): void {
  storage.getStore()?.evidence.assets.push(asset);
}

export function noteCount(count: number): void {
  const store = storage.getStore();
  if (store) store.evidence.count = count;
}

export function noteDetail(detail: string): void {
  const store = storage.getStore();
  if (store) store.evidence.detail = detail;
}

export function noteProcess(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  durationMs?: number;
}): void {
  const store = storage.getStore();
  if (!store) return;
  store.evidence.exitCode = result.exitCode;
  if (typeof result.running === 'boolean') store.evidence.running = result.running;
  if (typeof result.id === 'string' && result.id) store.evidence.processSessionId = result.id;
  if (typeof result.durationMs === 'number') store.evidence.durationMs = result.durationMs;
}

export function noteExec(result: {
  id?: string;
  running?: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /**
   * The caller has proven this non-zero exit is a reported result, not a failure.
   *
   * Only `exec_command` can know this, because only it has the command line: `rg` spends
   * exit 1 on "no matches". Left false everywhere else, so `write_stdin` and every older
   * call site keep the original behaviour exactly.
   */
  benignExit?: boolean;
}): void {
  const store = storage.getStore();
  if (!store) return;
  noteProcess(result);
  store.evidence.timedOut = result.timedOut === true;
  // A command that ran and failed is not an `ok` call. The dispatcher's fallback only sees
  // `result.isError`, and a completed non-zero shell result is not a transport error, so a
  // failed build was being stored beside a successful one with nothing to tell them apart.
  // A still-running process has `exitCode === null` and has not failed yet; leave it alone,
  // and never overwrite an outcome a tool set deliberately.
  //
  // The `benignExit` exemption is narrow and deliberate: a non-zero exit that the caller
  // proved is a *result* would otherwise make the error count uninterpretable, which is the
  // opposite of what marking failures was for. A timeout is never exempt — it is a failure
  // whatever the program's exit convention says.
  const failed = result.timedOut === true || (result.exitCode !== null && result.exitCode !== 0);
  const exempt = result.benignExit === true && result.timedOut !== true;
  if (!store.outcome && failed && !exempt) {
    store.outcome = 'error';
  }
}
