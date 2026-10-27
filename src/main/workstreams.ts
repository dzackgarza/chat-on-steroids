/** Exclusive workstream leases and their bounded recovery policy. The bridge owns delivery. */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { durableRoot, writeDurableNow } from "./durable.js";
import { transferExecOwnership } from "./codex/ownership.js";
import { inFlightCallsForWorkstream, runningToolCallsForWorkstream } from "./mcp/call-context.js";
import { detachSessionConversation } from "./session/store.js";
import { logWarn } from "./logger.js";
import type { ChatObservation } from "./session/recorder.js";
import { retirePrimeRuns, workerEndedForWorkstream, workerOwnsWorkstream, workerWorkstreamsOf } from "./agents.js";

/** ChatGPT's client-only routes (`WEB:<uuid>`, `local-chatgpt:<uuid>`), later rewritten to a server id. */
export function provisionalRoute(conversationId: string): boolean {
  return /^(?:WEB|local-chatgpt):/i.test(conversationId);
}

/**
 * The lock's lifetime: five minutes after the last tool call the app received under it. Only
 * an admitted tool call renews it. Page activity (thinking, prose, turn boundaries) never does.
 * A running tool call holds the lock open. Lease expiry is not a diagnosis of stalled work
 * and never initiates conversation recovery; the steward owns that decision.
 */
export const WORKSTREAM_LEASE_MS = 5 * 60_000;
export const ORCHESTRATOR_WORKSTREAM_ID = "orchestrator";
/** How long a delivered revive gives the worker to resume before the chat is replaced. */
const REVIVE_RESPONSE_MS = 2 * 60_000;
export const RECOVERY_BACKOFF_MS = [30_000] as const;
const MAX_RECOVERY_ATTEMPTS = RECOVERY_BACKOFF_MS.length;
export const workstreamIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const rowSchema = z
  .object({
    id: workstreamIdSchema,
    context: z.string().max(40_000),
    workspace: z.string().nullable(),
    ownerKey: z.string(),
    conversationId: z.string().nullable(),
    sessionId: z.string().nullable().default(null),
    lock: z.string(),
    lastActivity: z.number(),
    /** A recorded terminal orchestrator turn fences its claim before the idle lease ends. */
    claimReleased: z.boolean().default(false),
    phase: z.enum([
      "active",
      "advancing",
      "recovering",
      "archiving",
      "opening",
      "blocked",
      "paused",
    ]),
    autoAdvance: z.boolean().default(false),
    lastAdvancedTurnId: z.string().nullable().default(null),
    lastAdvancedTurnTime: z.number().default(0),
    attempts: z.number().int().min(0).max(3),
    nextCheck: z.number(),
    commandId: z.string().nullable(),
    /**
     * The opening command whose delivery deadline passed with the row still unbound. ChatGPT
     * can start that chat anyway; its page then reports this id with its observations, which
     * is the same exact rendezvous the ACK would have been. Only the latest failed command is
     * kept, and only an unbound row with no newer command pending accepts it.
     */
    lateCommandId: z.string().nullable().optional(),
    actionId: z.string().nullable(),
    error: z.string().nullable(),
    retiredKeys: z.array(z.string()),
    retiredConversations: z.array(z.string()),
    /** Chats whose recorded claim line named this row, under its current lock or a retired
     * one. Exact evidence of which workstream a chat holds, kept across reclaims. */
    claimedBy: z.array(z.string()).default([]),
    /**
     * The conversation that demonstrably received the current `context`: the bind ACK of the
     * opening message that carried it, or the first call a carrying send started. `context` is
     * the steward's steering channel, so it reaches each conversation once per revision.
     * Re-sending it after every turn re-injected obsolete PIDs and source revisions as current
     * instructions (2026-10-20); never sending it to a bound chat drops the steward's redirect.
     */
    contextReceivedBy: z.string().nullable().default(null),
  })
  .strict();
export type Workstream = z.infer<typeof rowSchema>;
const stateSchema = z
  .object({ version: z.literal(1), rows: z.array(rowSchema) })
  .strict();
const rows = new Map<string, Workstream>();
let loadedRoot: string | null = null;
let serial: Promise<unknown> = Promise.resolve();

function snapshot() {
  return {
    version: 1 as const,
    rows: [...rows.values()].map((row) => structuredClone(row)),
  };
}
function save() {
  return writeDurableNow("workstreams", snapshot());
}
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = serial.then(fn);
  serial = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export async function restoreWorkstreams(): Promise<void> {
  return exclusive(async () => {
    // Headless starts MCP before restoring the broker, then starts the bridge. The second
    // restore is when terminal worker ownership is finally known.
    if (loadedRoot === durableRoot()) {
      if (retireEndedWorkerRows()) await save();
      return;
    }
    const saved: unknown = durableRoot()
      ? await fs
          .readFile(path.join(durableRoot(), "workstreams.json"), "utf8")
          .then(
            (raw) => JSON.parse(raw),
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          )
      : null;
    const restored = saved === null ? [] : stateSchema.parse(saved).rows;
    rows.clear();
    for (const row of restored) {
      if (rows.has(row.id)) throw new Error("Duplicate durable workstream");
      // Builds before the archive-route fix left a successfully archived frontend in
      // conversationId while the row was already opening its replacement. This shape is
      // unambiguous: opening + replace-* is reachable only after archive success, so the old
      // route is definitively retired and must not survive restart as the current reinjection
      // target.
      if (
        row.phase === "opening" &&
        row.actionId?.startsWith("replace-") &&
        row.conversationId
      ) {
        if (!row.retiredConversations.includes(row.conversationId))
          row.retiredConversations.push(row.conversationId);
        row.conversationId = null;
      }
      // A row's currently bound conversation is, by definition, its live owner-facing
      // browser conversation. Older builds could add that same id to retiredConversations
      // during an ordinary same-chat `continue`, which made parallel calls self-fence.
      if (row.conversationId)
        row.retiredConversations = row.retiredConversations.filter(
          (id) => id !== row.conversationId,
        );
      if (row.sessionId) {
        await detachSessionConversation(row.sessionId).catch((err: Error) =>
          logWarn(
            `workstream ${row.id}: could not detach legacy recorder session ${row.sessionId} from browser ownership during restore — ${err.message}`,
          ),
        );
      }
      rows.set(row.id, row);
    }
    loadedRoot = durableRoot();
    // Terminal agents retain their transcript in the swarm history, but their connector
    // claims are dead. Do not restore those claims as resumable workstreams.
    if (retireEndedWorkerRows()) await save();
  });
}
function ready() {
  if (loadedRoot !== durableRoot())
    throw new Error("Workstreams have not been restored");
}
export function workstreamStatus(): Workstream[] {
  ready();
  return [...rows.values()].map((row) => structuredClone(row));
}

function retireEndedWorkerRows(): boolean {
  let changed = false;
  for (const row of rows.values()) {
    if (!workerEndedForWorkstream(row.id) || inFlightCallsForWorkstream(row.id).length > 0)
      continue;
    rows.delete(row.id);
    changed = true;
  }
  return changed;
}

export function workstreamWorkspace(logicalWorkstream: string): string | null {
  ready();
  return rows.get(logicalWorkstream)?.workspace ?? null;
}

/** Whether this exact conversation holds a workstream, which the controller manages. */
export function managedWorkstreamForConversation(
  conversationId: string,
): boolean {
  ready();
  return [...rows.values()].some(
    (row) =>
      row.conversationId === conversationId &&
      !["paused", "blocked", "archiving", "opening"].includes(row.phase),
  );
}

/** The line a claiming chat prints so the app can bind the row to that exact chat. */
export const workstreamClaimLine = (lock: string): string => `Workstream claim: ${lock}`;
export const WORKSTREAM_CLAIM_LINE = /Workstream claim: (wl_[A-Za-z0-9_-]{43})/g;

/** Current browser route for one logical workstream, for observer/reinjection only. */
export function workstreamForConversation(
  conversationId: string,
): { id: string; sessionId: string | null } | null {
  ready();
  const matches = [...rows.values()].filter(
    (row) =>
      row.conversationId === conversationId &&
      !["paused", "blocked"].includes(row.phase),
  );
  if (matches.length !== 1) return null;
  const row = matches[0]!;
  return { id: row.id, sessionId: row.sessionId };
}

/** Current browser route for one logical workstream, when the controller knows one. */
export function workstreamConversation(id: string): string | null {
  ready();
  return rows.get(id)?.conversationId ?? null;
}

/**
 * Clears one stale browser reinjection route after the browser/backend has proved it no longer
 * exists. This changes no workstream ownership: logical id, opaque claim, recorder session,
 * workspace and activity all remain untouched.
 */
export async function invalidateWorkstreamConversation(
  id: string,
  conversationId: string,
): Promise<boolean> {
  return exclusive(async () => {
    ready();
    const row = rows.get(id);
    if (
      !row ||
      row.conversationId !== conversationId ||
      ["archiving", "opening"].includes(row.phase)
    )
      return false;
    if (!row.retiredConversations.includes(conversationId))
      row.retiredConversations.push(conversationId);
    row.conversationId = null;
    if (row.phase === "recovering") row.nextCheck = Date.now();
    await save();
    return true;
  });
}

/**
 * Promotes the current browser route when ChatGPT rewrites the same frontend tab from a
 * provisional WEB:<uuid> route to its stable conversation id.
 *
 * This is routing state only. Logical workstream identity, opaque claim, recorder session,
 * workspace and activity are untouched. Exact old-route matching is the authority: a page
 * cannot move an unrelated workstream merely by naming a new conversation id.
 */
export async function promoteWorkstreamConversation(
  previousConversationId: string,
  conversationId: string,
): Promise<boolean> {
  if (
    !previousConversationId ||
    !conversationId ||
    previousConversationId === conversationId
  )
    return false;
  return exclusive(async () => {
    ready();
    const matches = [...rows.values()].filter(
      (row) =>
        row.conversationId === previousConversationId &&
        row.phase !== "archiving",
    );
    if (matches.length !== 1) return false;
    const row = matches[0]!;
    if (
      [...rows.values()].some(
        (other) =>
          other.id !== row.id &&
          other.conversationId === conversationId,
      )
    )
      return false;
    if (!row.retiredConversations.includes(previousConversationId))
      row.retiredConversations.push(previousConversationId);
    row.conversationId = conversationId;
    row.retiredConversations = row.retiredConversations.filter(
      (id) => id !== conversationId,
    );
    await save();
    return true;
  });
}

/**
 * Whether this bridge command is the controller's own send for an auto-advancing
 * workstream. Needed for the initial fresh-chat bootstrap, before its conversation id is
 * known and bound back to the workstream row.
 */
export function autoAdvancingWorkstreamForCommand(commandId: string): boolean {
  ready();
  return [...rows.values()].some(
    (row) =>
      row.commandId === commandId &&
      row.autoAdvance &&
      !["paused", "blocked", "archiving"].includes(row.phase),
  );
}
export type WorkstreamSetupResult =
  | { ok: true; id: string; workstreamId: string }
  | {
      ok: false;
      code:
        | "WORKSTREAM_ALREADY_EXISTS"
        | "WORKSTREAM_PATH_TAKEN"
        | "WORKSTREAM_HELD"
        | "WORKSTREAM_NOT_FOUND"
        | "WORKSTREAM_UNAVAILABLE"
        | "WORKSTREAM_PAUSED";
      /** The workstream that already owns the requested path. */
      holder?: string;
      /** WORKSTREAM_HELD: when the holder's lease runs out, or null while a call of its is running. */
      freesAt?: number | null;
    };

export type WorkstreamAdmitResult =
  | {
      ok: true;
      id: string;
      workstreamId: string;
      sessionId: string | null;
    }
  | { ok: false; code: "WORKSTREAM_ID_NOT_CURRENT" | "WORKSTREAM_BUSY" };

function freshWorkstreamId(): string {
  return `wl_${randomBytes(32).toString("base64url")}`;
}

/**
 * Model-facing setup, `action=start`: register and claim a brand-new named logical
 * workstream on the path it declares, and issue its opaque attachment id. The path is fixed
 * for the life of the workstream, and one path has at most one workstream.
 */
export async function startWorkstream(
  logicalWorkstream: string,
  workspace: string,
  now = Date.now(),
): Promise<WorkstreamSetupResult> {
  return exclusive(async () => {
    ready();
    workstreamIdSchema.parse(logicalWorkstream);
    if (rows.has(logicalWorkstream))
      return { ok: false, code: "WORKSTREAM_ALREADY_EXISTS" };
    const holder = [...rows.values()].find((row) => row.workspace === workspace);
    if (holder)
      return { ok: false, code: "WORKSTREAM_PATH_TAKEN", holder: holder.id };
    const workstreamId = freshWorkstreamId();
    rows.set(logicalWorkstream, {
      id: logicalWorkstream,
      context: "",
      workspace,
      ownerKey: logicalWorkstream,
      conversationId: null,
      sessionId: null,
      lock: workstreamId,
      lastActivity: now,
      claimReleased: false,
      phase: "active",
      autoAdvance: false,
      lastAdvancedTurnId: null,
      lastAdvancedTurnTime: 0,
      attempts: 0,
      nextCheck: 0,
      commandId: null,
      actionId: null,
      error: null,
      retiredKeys: [],
      retiredConversations: [],
      claimedBy: [],
      contextReceivedBy: null,
    });
    await save();
    return { ok: true, id: logicalWorkstream, workstreamId };
  });
}

/**
 * Model-facing setup, `action=continue`: claim an existing logical workstream whose lock has
 * expired, and issue a FRESH opaque attachment id. The previously issued id becomes invalid
 * immediately — only the current `lock` admits a call. A lock renewed by a tool call within
 * WORKSTREAM_LEASE_MS, or held open by a running call, refuses the claim.
 *
 * The claim is itself a received tool call, so it starts the new holder's lease. The holder's
 * conversation is unknown until a generating page reports the new id from its own record
 * (bindWorkstreamConversation); a row reserved in `opening` keeps the replacement chat its command ACK bound.
 */
export async function continueWorkstream(
  logicalWorkstream: string,
  now = Date.now(),
): Promise<WorkstreamSetupResult> {
  return exclusive(async () => {
    ready();
    workstreamIdSchema.parse(logicalWorkstream);
    const prior = rows.get(logicalWorkstream);
    if (!prior) return { ok: false, code: "WORKSTREAM_NOT_FOUND" };
    if (["active", "advancing"].includes(prior.phase)) {
      if (runningToolCallsForWorkstream(prior.id) > 0)
        return { ok: false, code: "WORKSTREAM_HELD", freesAt: null };
      if (!prior.claimReleased && now < prior.lastActivity + WORKSTREAM_LEASE_MS)
        return { ok: false, code: "WORKSTREAM_HELD", freesAt: prior.lastActivity + WORKSTREAM_LEASE_MS };
    }
    // Setup has no browser-provenance dependency. A `blocked` row is a controller-side
    // delivery failure (e.g. the app-opened chat's conversation never bound); the model's own
    // explicit `continue` is the attach that reclaims it. Only an in-flight replacement
    // (`archiving`) genuinely refuses, because a distinct thread already owns the handoff.
    if (prior.phase === "archiving")
      return { ok: false, code: "WORKSTREAM_UNAVAILABLE" };
    // A pause is the owner's decision, and only resumeWorkstream() lifts it. The paused chat's
    // own calls are refused as not current, and its natural reaction is to re-attach; letting
    // that re-attach succeed undid the pause within seconds.
    if (prior.phase === "paused")
      return { ok: false, code: "WORKSTREAM_PAUSED" };
    const newLock = freshWorkstreamId();
    const retiredKeys = [...new Set([...prior.retiredKeys, prior.lock])].slice(-16);
    rows.set(logicalWorkstream, {
      id: logicalWorkstream,
      context: prior.context,
      workspace: prior.workspace,
      ownerKey: logicalWorkstream,
      conversationId: prior.phase === "opening" ? prior.conversationId : null,
      sessionId: prior.sessionId,
      lock: newLock,
      lastActivity: now,
      claimReleased: false,
      phase: "active",
      autoAdvance: prior.autoAdvance,
      lastAdvancedTurnId: prior.lastAdvancedTurnId,
      lastAdvancedTurnTime: prior.lastAdvancedTurnTime,
      attempts: 0,
      nextCheck: 0,
      // Keep the controller's commandId only while the row is still `opening`, so a late
      // browser ACK can fill the conversation without rotating the issued attachment id.
      commandId: prior.phase === "opening" ? prior.commandId : null,
      actionId: null,
      error: null,
      retiredKeys,
      retiredConversations: [...prior.retiredConversations],
      claimedBy: [...prior.claimedBy],
      contextReceivedBy: prior.contextReceivedBy,
    });
    await save();
    return {
      ok: true,
      id: logicalWorkstream,
      workstreamId: newLock,
    };
  });
}

/**
 * Controller-opened reservation. Creates (or reuses) a logical workstream in `opening`
 * phase before the worker's own `workstream action=continue` attaches it. No model-facing
 * attachment id is issued here — the bridge never pre-claims for a future model.
 */
export async function reserveWorkstream(
  logicalWorkstream: string,
  context: string,
  commandId: string,
  autoAdvance = true,
  now = Date.now(),
): Promise<WorkstreamSetupResult> {
  return exclusive(async () => {
    ready();
    workstreamIdSchema.parse(logicalWorkstream);
    const prior = rows.get(logicalWorkstream);
    const conversationId = prior?.conversationId ?? null;
    const lock = prior?.lock ?? freshWorkstreamId();
    rows.set(logicalWorkstream, {
      id: logicalWorkstream,
      context,
      workspace: prior?.workspace ?? null,
      ownerKey: logicalWorkstream,
      conversationId,
      sessionId: prior?.sessionId ?? null,
      lock,
      lastActivity: now,
      claimReleased: false,
      phase: "opening",
      autoAdvance,
      lastAdvancedTurnId: prior?.lastAdvancedTurnId ?? null,
      lastAdvancedTurnTime: prior?.lastAdvancedTurnTime ?? 0,
      attempts: 0,
      nextCheck: 0,
      commandId,
      actionId: `open-${commandId}`,
      error: null,
      retiredKeys: [...(prior?.retiredKeys ?? [])],
      retiredConversations: [...(prior?.retiredConversations ?? [])],
      claimedBy: [...(prior?.claimedBy ?? [])],
      contextReceivedBy: context === prior?.context ? prior.contextReceivedBy : null,
    });
    await save();
    return { ok: true, id: logicalWorkstream, workstreamId: lock };
  });
}

export async function setWorkstreamAutoAdvance(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  return exclusive(async () => {
    ready();
    const row = rows.get(id);
    if (!row) return false;
    row.autoAdvance = enabled;
    await save();
    return true;
  });
}

/** Possession of the currently issued attachment id is the ordinary-tool admission capability. */
export async function admitWorkstreamCall(
  workstreamId: string,
  now = Date.now(),
): Promise<WorkstreamAdmitResult> {
  return exclusive(async () => {
    ready();
    const row = [...rows.values()].find(
      (candidate) =>
        candidate.lock === workstreamId &&
        !candidate.claimReleased &&
        ["active", "advancing", "recovering"].includes(candidate.phase),
    );
    if (!row) return { ok: false, code: "WORKSTREAM_ID_NOT_CURRENT" };
    // Re-attachment fenced the former opaque claim. Execution waits for calls already
    // admitted under retired claim ids to settle; their retained terminal sessions pass to
    // this claim, which inherits the running work instead of relaunching it.
    if (
      row.retiredKeys.some(
        (claimId) =>
          runningToolCallsForWorkstream(row.id, claimId) > 0,
      )
    )
      return { ok: false, code: "WORKSTREAM_BUSY" };
    transferExecOwnership(row.id, row.retiredKeys, row.lock);
    row.retiredKeys = [];
    // A replacement chat can begin executing before the browser ACK that names the concrete
    // conversation reaches the bridge. `continueWorkstream()` deliberately carries the
    // opening command id across that race while clearing its action id; keep that one marker
    // alive until bindWorkstreamReplacement() consumes the ACK. Clearing it on the first
    // ordinary call strands the row on the archived conversation, so the replacement's turn
    // boundaries can never auto-advance it and the controller eventually revives the wrong
    // chat. Recovery/advance commands still have an action id and are cancelled normally.
    const pendingReplacementBind =
      row.phase === "active" && row.commandId !== null && row.actionId === null;
    if (row.actionId !== null && row.conversationId !== null)
      row.contextReceivedBy = row.conversationId;
    row.lastActivity = now;
    row.phase = "active";
    row.attempts = 0;
    row.nextCheck = 0;
    if (!pendingReplacementBind) row.commandId = null;
    row.actionId = null;
    row.error = null;
    await save();
    return {
      ok: true,
      id: row.id,
      workstreamId: row.lock,
      sessionId: row.sessionId,
    };
  });
}

/** The logical workstream whose recorder session this is, or null for an ordinary chat. */
export function workstreamForSession(sessionId: string): string | null {
  for (const row of rows.values()) if (row.sessionId === sessionId) return row.id;
  return null;
}

/** Recorder session durably owned by one logical workstream, independent of browser routing. */
export function workstreamRecordingSession(id: string): string | null {
  ready();
  return rows.get(id)?.sessionId ?? null;
}

/**
 * Installs the recorder session for a logical workstream exactly once.
 *
 * A browser conversation may come and go; this id is the durable grouping thread for the
 * workstream's model/tool history. Refuse sharing one recorder session between logical
 * workstreams rather than silently merging provenance.
 */
export async function setWorkstreamRecordingSession(
  id: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  return exclusive(async () => {
    ready();
    const row = rows.get(id);
    if (!row) return false;
    if (row.sessionId === sessionId) return true;
    if (row.sessionId !== null) return false;
    if (
      [...rows.values()].some(
        (other) => other.id !== id && other.sessionId === sessionId,
      )
    )
      return false;
    row.sessionId = sessionId;
    await save();
    return true;
  });
}

/**
 * Binds a workstream to the one chat whose ChatGPT record holds its current lock. The lock is
 * a 256-bit secret that only the claim's own tool result carries, so the match is exact. A
 * chat holds one workstream: a row previously bound to this chat loses the binding.
 */
export async function bindWorkstreamConversation(
  lock: string,
  conversationId: string,
): Promise<string | null> {
  return exclusive(async () => {
    ready();
    // A claim line names its row even after the lock rotated: every reclaim nulls the row's
    // conversation, and a slept or `chat_error` page may never store the newer claim line.
    const claimed = [...rows.values()].find(
      (candidate) => candidate.lock === lock || candidate.retiredKeys.includes(lock),
    );
    if (claimed && !claimed.claimedBy.includes(conversationId)) {
      const previous = claimed.claimedBy[claimed.claimedBy.length - 1] ?? null;
      for (const other of rows.values())
        other.claimedBy = other.claimedBy.filter((id) => id !== conversationId);
      claimed.claimedBy = [...claimed.claimedBy, conversationId].slice(-8);
      // A new chat claiming the workstream is a prime change whichever path opened it.
      if (previous && !workerOwnsWorkstream(claimed.id)) retireReplacedPrimeRuns(claimed.id, previous);
      await save();
    }
    const row = [...rows.values()].find((candidate) => candidate.lock === lock);
    if (!row) return null;
    if (row.conversationId === conversationId) return row.id;
    for (const other of rows.values())
      if (other.id !== row.id && other.conversationId === conversationId)
        other.conversationId = null;
    row.conversationId = conversationId;
    row.retiredConversations = row.retiredConversations.filter(
      (id) => id !== conversationId,
    );
    await save();
    return row.id;
  });
}

/**
 * Turns a freshly observed managed turn boundary into the next controller action.
 * Completed work advances immediately. An observed abnormal end recovers immediately.
 * An outcome that only says the page lost sight of the turn changes nothing: the lease,
 * renewed by received tool calls alone, decides whether the holder stalled.
 */
export async function scheduleWorkstreamAfterTurn(
  conversationId: string,
  turnId: string,
  outcome: NonNullable<ChatObservation["outcome"]>,
  time: number,
  now = Date.now(),
  conversationLengthExhausted = false,
): Promise<boolean> {
  return exclusive(async () => {
    ready();
    if (!turnId || time > now + 5_000 || time < now - 60_000) return false;
    const row = [...rows.values()].find(
      (candidate) =>
        (candidate.conversationId === conversationId ||
          // A live model can resume a controller-unbound row with its retained
          // claim, perform real work, and complete a turn without emitting the
          // NEW claim line. The old line identifies its last recorded claimant
          // but cannot bind the newly rotated lock. At that exact terminal
          // boundary, restore routing only for the sole unretired claimant of
          // an active row with a recently admitted workstream tool call.
          // Otherwise the tab reaper closes the completed chat as unmanaged
          // and the controller never advances its next turn.
          (candidate.conversationId === null &&
            candidate.phase === "active" &&
            candidate.claimedBy.at(-1) === conversationId &&
            !candidate.retiredConversations.includes(conversationId) &&
            candidate.lastActivity >= time - WORKSTREAM_LEASE_MS &&
            ![...rows.values()].some(
              (other) => other.id !== candidate.id && other.conversationId === conversationId,
            ))) &&
        (candidate.autoAdvance || candidate.id === ORCHESTRATOR_WORKSTREAM_ID) &&
        (candidate.phase === "active" ||
          // The advance may have reached ChatGPT but its turn can end before
          // the new worker makes a Core call.  Ignoring that terminal result
          // strands the row in `advancing` with a committed command forever.
          (candidate.phase === "advancing" &&
            candidate.commandId !== null &&
            time > candidate.lastAdvancedTurnTime)),
    );
    if (
      !row ||
      (row.lastAdvancedTurnId === turnId && time <= row.lastAdvancedTurnTime)
    )
      return false;
    if (["stalled", "observer_lost", "unknown"].includes(outcome)) return false;

    // The unbound last claimant was authenticated by its existing claim-line
    // provenance plus fresh Core tool execution; it is not a new worker claim.
    // Restore only its browser route, leaving the opaque lock and lease intact.
    if (row.conversationId === null) row.conversationId = conversationId;

    if (row.id === ORCHESTRATOR_WORKSTREAM_ID) {
      // A real terminal turn frees the next scheduled tick. A call still executing
      // retains its claim until it settles (and the ordinary idle lease then applies).
      if (runningToolCallsForWorkstream(row.id) > 0) return false;
      row.lastAdvancedTurnId = turnId;
      row.lastAdvancedTurnTime = time;
      row.claimReleased = true;
      await save();
      return true;
    }

    const unclaimedAdvance = row.phase === "advancing";
    row.lastAdvancedTurnId = turnId;
    row.lastAdvancedTurnTime = time;
    row.commandId = null;
    row.error = null;
    if (outcome === "failed" && conversationLengthExhausted) {
      // ChatGPT explicitly rejected this *conversation*, not just this turn. Reviving
      // it returns to the same exhausted context and can repeat forever while ordinary
      // Core calls keep the workstream claim healthy. Enter the existing fenced
      // archive/replace state machine instead, once no tool call is in flight.
      row.phase = "recovering";
      row.attempts = MAX_RECOVERY_ATTEMPTS;
      row.nextCheck = now;
      row.actionId = null;
      row.error = "conversation_length_exhausted";
    } else if (outcome === "completed" && !unclaimedAdvance) {
      row.phase = "advancing";
      row.attempts = 0;
      row.nextCheck = 0;
      const suffix = createHash("sha256")
        .update(turnId)
        .digest("hex")
        .slice(0, 12);
      row.actionId = `advance-${row.lock}-${suffix}`;
    } else {
      row.phase = "recovering";
      row.attempts = 0;
      row.nextCheck = now;
      row.actionId = null;
      if (unclaimedAdvance)
        row.error = `advance_turn_ended_without_claim:${outcome}`;
    }
    await save();
    return true;
  });
}

export async function configureWorkstream(
  id: string,
  context: string,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row) return false;
    row.context = z.string().max(40_000).parse(context);
    row.contextReceivedBy = null;
    await save();
    return true;
  });
}

export async function pauseWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    // The steward controls worker pauses. Subjecting its own chat to the worker pause
    // boundary leaves it unable to run the tick that would resume the fleet.
    if (id === ORCHESTRATOR_WORKSTREAM_ID) return false;
    const row = rows.get(id);
    if (!row) return false;
    // A paused stream's swarm workers stop with it. Pausing only the prime row left 23
    // math-notes-ipad worker rows active for up to 86 hours after the owner paused that
    // stream (found 2026-10-09).
    for (const target of [row, ...workerWorkstreamsOf(id).flatMap((workerId) => rows.get(workerId) ?? [])]) {
      target.phase = "paused";
      target.commandId = null;
      target.actionId = null;
    }
    await save();
    return true;
  });
}

/** Retire an abandoned logical workstream after its owner has stopped it. Recordings and
 * broker history stay in their own stores; only this connector claim is removed. */
export async function retireWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      !["paused", "blocked"].includes(row.phase) ||
      inFlightCallsForWorkstream(id).length > 0 ||
      workerOwnsWorkstream(id) ||
      workerWorkstreamsOf(id).length > 0
    )
      return false;
    rows.delete(id);
    await save();
    return true;
  });
}

export async function resumeWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.phase !== "paused") return false;
    if (
      [...rows.values()].some(
        (other) =>
          other.id !== id &&
          other.ownerKey === row.ownerKey &&
          other.phase !== "paused",
      )
    )
      return false;
    // Resume the existing holder without inventing activity or interpreting an intentional
    // wait as a failed conversation. Older controllers persisted timer-only diagnoses.
    row.phase = "active";
    if (row.error?.startsWith("five_minute_")) row.error = null;
    row.attempts = 0;
    await save();
    return true;
  });
}

/** Script-owned hard recovery: fence the current owner and enter the same archive/replacement
 * path used after automatic revival exhaustion. This exists so an external steward can replace
 * a demonstrably dead workstream without reproducing the bridge's private state machine. */
export async function replaceWorkstream(
  id: string,
  expected?: Pick<Workstream, "conversationId" | "lastActivity">,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row) return false;
    if (expected && (
      row.conversationId !== expected.conversationId ||
      row.lastActivity !== expected.lastActivity
    )) return false;
    // A row whose chat never bound (opened by `just new`, so the app never saw it acknowledge)
    // has no chat to archive and no holder recovery can find. An explicit replace is the
    // steward's decision that no other chat holds it, so open a fresh one directly; automatic
    // recovery still blocks instead (2026-10-09: lean-cas-dsl stuck conversation_unbound).
    if (!row.conversationId && ["active", "recovering", "blocked"].includes(row.phase)) {
      row.phase = "opening";
      row.actionId = `replace-${row.lock}`;
      row.commandId = null;
      row.attempts = 0;
      row.error = null;
      await save();
      return true;
    }
    // The steward may replace an unclaimed advance after verifying the old
    // conversation has ended; the stranded command is not a surviving holder.
    if (!["active", "advancing", "recovering", "blocked"].includes(row.phase) || !row.conversationId) return false;
    row.phase = "archiving";
    row.attempts = 3;
    row.nextCheck = 0;
    row.commandId = null;
    row.actionId = `archive-${row.lock}`;
    if (!row.error?.startsWith("five_minute_")) row.error = null;
    await save();
    return true;
  });
}

export async function recoverWorkstreamNow(
  id: string,
  reason: string,
  now = Date.now(),
  expected?: Pick<Workstream, "conversationId" | "lastActivity">,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      (expected && (
        row.conversationId !== expected.conversationId ||
        row.lastActivity !== expected.lastActivity
      )) ||
      !["active", "advancing"].includes(row.phase) ||
      runningToolCallsForWorkstream(id) > 0
    )
      return false;
    // Explicit steward recovery is also needed after an automation-owned chat has
    // claimed this workstream without a live page to rebind the browser route.
    // A previously observed claim line identifies the exact chat to revive. Do
    // not guess an earlier claimant or revive a retired/provisional conversation:
    // the steward can choose the existing fenced replacement path in that case.
    const conversation = row.conversationId ?? row.claimedBy.at(-1) ?? null;
    if (
      !conversation ||
      provisionalRoute(conversation) ||
      row.retiredConversations.includes(conversation)
    )
      return false;
    row.conversationId = conversation;
    row.phase = "recovering";
    row.attempts = 0;
    row.nextCheck = now;
    row.commandId = null;
    row.actionId = null;
    row.error = reason;
    await save();
    return true;
  });
}

// A fresh chat has no conversational memory, but a replacement workstream already has a durable
// brief/handoff. Forcing every replacement to reread AGENTS.md + TODO from the top recreated the
// exact setup loop the controller is supposed to prevent: a worker could spend successive fresh
// turns rebuilding state instead of resuming implementation. The durable workstream context names
// the inherited unit and any repository-specific continuity surface; start there and read only the
// repository sections needed for the concrete edit. A genuinely new workstream's context remains
// responsible for asking for full orientation when that is actually necessary.
export const FRESH_CHAT_ORIENTATION =
  "Resume from this workstream's durable context and the inherited execution record above first: it is what your predecessors already read, ran and changed, so do not repeat it. Do not restart project setup or reread whole AGENTS/TODO files merely because this is a replacement chat; read only the specific repository sections needed for the inherited concrete edit. If the durable context explicitly says this is genuinely new work with no inherited unit, orient from the repository then. Start substantive implementation immediately. ";
export const BOUND_CHAT_ORIENTATION =
  "You have already read this repository's AGENTS.md and TODOs in this chat: resume the unit you were on, and re-read only the specific section you need. ";
export const STEWARD_CONTINUATION =
  "Continue the full original assignment. This message gives you no new goal, no narrower scope, and no new definition of completion. The original request and every obligation it entails remain in force, whether or not you mentioned them in your last response. " +
  "You stopped working and produced an answer. Whatever led you to decide to stop does not make the assignment complete. Nothing has been handed off. Nobody is receiving that answer as a progress report or taking over the work you left undone. Your own account of what remains unfinished is a reason to keep working, not a result delivered to anyone. " +
  "Resume the actual work. Do whatever the entire assignment still requires, including all outstanding work you already know about and all further work necessary to satisfy the original requirements. Use the tools available to you. When more information is needed, obtain it and apply it to the work. When an approach fails, resolve the problem and continue. Do not turn uncertainty, difficulty, elapsed effort, a partial result, or your latest diagnosis into a reason to stop. " +
  "Do not reinterpret this continuation message, your latest finding, or a recent subtask as the new assignment. Do not shrink the original goal to something you can readily report as finished. Do not replace the requested result with investigation, commentary, plans, status updates, explanations, or an account of what should happen next. Any work you can still identify as necessary remains your work to do. " +
  "Keep working on the original task in its full scope, under its existing repository rules and acceptance requirements, until it is actually complete. Your next response must not be another report from the middle of unfinished work: carry out that work instead.";
/**
 * The message the controller sends for one action. `connector` is the name the owner gave
 * this app's connector in ChatGPT, so a chat that has several connectors calls this one.
 * A bound chat is the proven holder of the lock and is handed it again; a fresh chat claims
 * the workstream itself.
 */
export function workstreamPrompt(row: Workstream, connector: string, inherited = ""): string {
  const handoff =
    row.conversationId !== null && row.contextReceivedBy === row.conversationId
      ? ""
      : row.context;
  const recoveryNotice =
    row.error?.startsWith("five_minute_")
      ? row.error.startsWith("five_minute_action_overrun:")
        ? `\nACTIVITY CHECK: An earlier controller flagged a long action: ${row.error.slice("five_minute_action_overrun:".length)}. A local run that long means the setup is wrong: move that run to CI or replace it with a small targeted test, and keep implementing. If it has already exited, consume its result; do not relaunch it locally.\n`
        : "\nACTIVITY CHECK: No recent activity was recorded. This does not establish whether the work is stalled. Inspect the current task, actual tool results and any background process. Continue a progressing required build without restarting it; consume a completed result; otherwise address the concrete obstruction or resume the unfinished task.\n"
      : "";
  const claim =
    row.phase === "opening"
      ? `Before any other connector operation, call \`workstream\` on the "${connector}" connector with action="continue" and workstream="${row.id}". Then include the returned workstream_id on every ordinary "${connector}" call.`
      : `This chat holds it. Include workstream_id="${row.lock}" on every ordinary "${connector}" connector call. Do not reclaim it routinely. If an ordinary call returns WORKSTREAM_SETUP_REQUIRED, follow that refusal: call \`workstream\` with action="continue" and workstream="${row.id}", then retry using its returned workstream_id. WORKSTREAM_BUSY instead requires retrying with the existing workstream_id, not reclaiming.`;
  return `Continue workstream ${row.id} on the "${connector}" connector. ${claim}\n${row.workspace ? `Project: ${row.workspace}\n` : ""}${handoff}${inherited ? `\n${inherited}\n` : ""}${recoveryNotice}\n${row.phase === "opening" ? FRESH_CHAT_ORIENTATION : BOUND_CHAT_ORIENTATION}${STEWARD_CONTINUATION}`;
}

/** Persistent action intent is written before delivery. The action id is its idempotency key. */
export async function nextWorkstreamActions(
  now: number,
  injecting: boolean,
  sendsHeld = false,
): Promise<Workstream[]> {
  return exclusive(async () => {
    ready();
    retireEndedWorkerRows();
    for (const row of rows.values()) {
      // Swarm workers are driven by agents.ts alone (see workerOwnsWorkstream).
      if (workerOwnsWorkstream(row.id)) continue;
      // An archive is performed by the extension, which is offered none while auto-continuation
      // is off (GET /workstreams/archive), so a row already parked there would never leave it.
      // Return it to `recovering` with its attempts intact; switching the owner's flag back on
      // re-enters the same archive on the next sweep.
      if (!injecting && row.phase === "archiving") {
        row.phase = "recovering";
        row.actionId = null;
        row.commandId = null;
        row.nextCheck = now;
      }
      // Older builds permanently blocked an auto-advancing replacement when the fresh-chat
      // send itself expired. `commandId` still being present distinguishes that case from an
      // archive failure (which clears it), while attempts===3 and an existing conversation
      // distinguish it from an initial bootstrap. Repair that durable state in place so an
      // newer controller immediately resumes the already-archived logical workstream.
      if (
        row.phase === "blocked" &&
        row.autoAdvance &&
        row.attempts >= MAX_RECOVERY_ATTEMPTS &&
        row.conversationId &&
        row.commandId
      ) {
        row.phase = "opening";
        row.actionId = `replace-${row.lock}`;
        row.commandId = null;
        row.error = null;
        // That conversation is the already-archived frontend, not a delivered replacement.
        if (!row.retiredConversations.includes(row.conversationId))
          row.retiredConversations.push(row.conversationId);
        row.conversationId = null;
      }
      // Older builds made every failed archive terminal, which is how the fleet stopped on
      // WEB:<uuid> routes the extension refused to archive. That shape (revival exhausted, old
      // route still current, no command) is reachable only from a failed archive. Re-enter the
      // same fenced archive; finishWorkstreamArchive() now opens the replacement either way.
      if (
        row.phase === "blocked" &&
        row.attempts >= MAX_RECOVERY_ATTEMPTS &&
        row.conversationId &&
        row.commandId === null
      ) {
        row.phase = "archiving";
        row.actionId = `archive-${row.lock}`;
        row.error = null;
      }
      // A revive in flight is judged by its own outcome, never by a timer racing its delivery:
      // the command's deadline bounds the wait, a failed or lost command releases the row
      // immediately, and a delivered one starts the response window below.
      if (row.phase === "recovering" && row.commandId !== null) continue;
      if (row.phase !== "recovering" || now < row.nextCheck) continue;
      // Every reclaim clears the binding, and a slept or chat_error page rarely stores the new
      // claim line, so an unbound row usually still has exact evidence of its holder: the last
      // chat whose recorded claim line named it. Revive that chat rather than block (2026-10-02:
      // new-qual-site and math-notes-ipad both blocked as unbound with their holders recorded).
      if (!row.conversationId && row.claimedBy.length > 0)
        row.conversationId = row.claimedBy[row.claimedBy.length - 1]!;
      if (!row.conversationId) {
        // The holder's chat was never found, so there is no chat to revive. A fresh chat would
        // be a second holder of work the first may still be doing: stop and say so.
        row.phase = "blocked";
        row.actionId = null;
        row.commandId = null;
        row.error =
          "conversation_unbound: the chat that holds this workstream was not found in the ChatGPT backend, so it cannot be revived";
        continue;
      }
      // A WEB:<uuid> route is a send ChatGPT had not accepted when it was bound, and it was
      // never promoted to a server conversation. There is nothing to revive (reopening the
      // route lands on an empty page) and nothing to archive (the backend rejects the id):
      // retire it and open the replacement directly.
      if (provisionalRoute(row.conversationId)) {
        if (!row.retiredConversations.includes(row.conversationId))
          row.retiredConversations.push(row.conversationId);
        row.conversationId = null;
        row.phase = "opening";
        row.actionId = `replace-${row.lock}`;
        row.commandId = null;
        row.nextCheck = now;
        continue;
      }
      // With auto-continuation off nothing delivers a revive or performs an archive, so
      // escalating would spend the attempts on sends that are dropped and then park the row in
      // an `archiving` no browser action will ever finish, where the chat's own `continue` is
      // refused. The row stays `recovering`: the steward's signal, and still attachable.
      if (!injecting) continue;
      // Under a usage-limit hold the bridge delivers no revive (chatgpt-limits.ts), so an
      // attempt spent now is a revive never sent. 2026-10-02 23:50: strike 2 held sends for 30
      // minutes, and the throttled chats of all three streams ran out of attempts undelivered and
      // were archived for fresh chats, which the same throttling then kept from opening. The row
      // waits in `recovering` with its pending revive, which goes out when the hold lifts.
      if (sendsHeld) continue;
      if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
        // Terminal context exhaustion or exhausted revives must not archive a
        // chat while a connector call accepted under its claim is still running.
        if (runningToolCallsForWorkstream(row.id) > 0) continue;
        row.phase = "archiving";
        row.actionId = `archive-${row.lock}`;
        row.commandId = null;
      } else {
        row.attempts++;
        row.actionId = `revive-${row.lock}-${row.attempts}`;
        row.commandId = null;
        row.nextCheck = now + RECOVERY_BACKOFF_MS[row.attempts - 1]!;
      }
    }
    await save();
    return workstreamStatus().filter(
      (row) =>
        row.actionId !== null &&
        !workerOwnsWorkstream(row.id) &&
        ["advancing", "recovering", "archiving", "opening"].includes(row.phase) &&
        // An opening row whose replacement chat already bound has been delivered; it waits for
        // that chat's `continue` (or the lease above), never for another fresh chat.
        (row.phase !== "opening" ||
          (now >= row.nextCheck && row.conversationId === null)),
    );
  });
}

/** The workstream a chat last claimed by a recorded claim line, or null without that evidence. */
export function claimedWorkstreamOf(conversationId: string): string | null {
  return (
    [...rows.values()].find((row) => row.claimedBy.includes(conversationId))?.id ?? null
  );
}

export function currentWorkstreamAction(
  id: string,
  actionId: string,
): Workstream | null {
  const row = rows.get(id);
  return row?.actionId === actionId ? structuredClone(row) : null;
}

export async function recordWorkstreamCommand(
  id: string,
  actionId: string,
  commandId: string,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId) return false;
    row.commandId = commandId;
    await save();
    return true;
  });
}

/**
 * A controller send reached a terminal delivery failure before ChatGPT could start the
 * intended turn. Do not spend the remainder of that attempt's model-response backoff on a
 * command that can no longer make progress: release the dead command and make recovery
 * immediately eligible for its next bounded step.
 */
export async function releaseFailedWorkstreamDelivery(
  id: string,
  actionId: string,
  commandId: string,
  now = Date.now(),
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      row.actionId !== actionId ||
      row.commandId !== commandId ||
      !["advancing", "recovering"].includes(row.phase)
    )
      return false;
    row.commandId = null;
    row.actionId = null;
    if (!row.error?.startsWith("five_minute_")) row.error = null;
    if (row.phase === "advancing") {
      row.phase = "recovering";
      row.attempts = 0;
    }
    row.nextCheck = now;
    await save();
    return true;
  });
}

/**
 * A revive message reached the stalled chat. The worker now has REVIVE_RESPONSE_MS from that
 * moment to make an ordinary claimed call (which reactivates the row); silence past it is the
 * failed revival that escalates to archive-and-replace.
 */
export async function noteWorkstreamRecoveryDelivered(
  id: string,
  actionId: string,
  commandId: string,
  deliveredAt: number,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      row.phase !== "recovering" ||
      row.actionId !== actionId ||
      row.commandId !== commandId
    )
      return false;
    row.commandId = null;
    // The revive was delivered. Its action is complete; only the response
    // deadline remains. Leaving actionId set makes nextWorkstreamActions() return
    // the same row on the very next sweep and queues another stop-first send,
    // interrupting the newly restarted ChatGPT turn before it can re-attach.
    row.actionId = null;
    row.nextCheck = deliveredAt + REVIVE_RESPONSE_MS;
    await save();
    return true;
  });
}

/**
 * Replacement-chat delivery failed after the old owner had already been archived. The
 * archive transaction is complete at this point, so blocking the logical workstream would
 * make a transient browser/open-chat failure terminal. Keep the same replacement action
 * identity, release only the failed command, and let the next sweep issue a fresh command.
 */
export async function retryFailedWorkstreamReplacementDelivery(
  id: string,
  actionId: string,
  commandId: string,
  nextCheck = 0,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      row.phase !== "opening" ||
      row.actionId !== actionId ||
      row.commandId !== commandId ||
      !actionId.startsWith("replace-")
    )
      return false;
    row.commandId = null;
    row.nextCheck = nextCheck;
    if (!row.error?.startsWith("five_minute_")) row.error = null;
    await save();
    return true;
  });
}

export async function blockWorkstreamAction(
  id: string,
  actionId: string,
  error: string,
): Promise<void> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId) return;
    row.phase = "blocked";
    row.error = error;
    row.actionId = null;
    await save();
  });
}

/** Sleeps the worker runs of a workstream whose prime chat was just replaced, and says so. */
function retireReplacedPrimeRuns(workstreamId: string, previousConversationId: string): void {
  const slept = retirePrimeRuns(workstreamId, previousConversationId, `prime chat of workstream ${workstreamId} was replaced`);
  if (slept > 0)
    logWarn(`workstream ${workstreamId}: slept ${slept} worker(s) of the replaced prime ${previousConversationId}`);
}

export async function finishWorkstreamArchive(
  id: string,
  actionId: string,
  error: string | null,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId || row.phase !== "archiving")
      return false;
    // Archiving is browser hygiene, not the fence. The old frontend lost admission when this row
    // left active/recovering, and the replacement's `continue` rotates the claim it holds. A
    // failed ChatGPT archive therefore must never strand the logical workstream: retire the old
    // route (the retired-tab sweep closes it) and open the replacement either way.
    if (error)
      logWarn(
        `workstream ${row.id}: archiving ${row.conversationId} failed (${error}); retiring it unarchived and opening the replacement`,
      );
    row.phase = "opening";
    if (!row.error?.startsWith("five_minute_")) row.error = null;
    if (row.conversationId) {
      // The old frontend stops being a valid reinjection route here. Do not keep it as
      // "current" while the replacement bootstrap is still opening: if that fresh bootstrap
      // fails, or an independently running claimant renews the logical workstream before the
      // ACK arrives, retaining the old id would later make recovery revive/archive the wrong
      // frontend. The replacement ACK installs the next route in bindWorkstreamReplacement().
      if (!row.retiredConversations.includes(row.conversationId))
        row.retiredConversations.push(row.conversationId);
      retireReplacedPrimeRuns(row.id, row.conversationId);
      row.conversationId = null;
    }
    row.actionId = `replace-${row.lock}`;
    row.commandId = null;
    await save();
    return true;
  });
}

/**
 * Records which concrete ChatGPT conversation the controller opened for a reserved
 * (`opening`) workstream. This is observation/orchestration state only: it must never
 * rotate the issued model-facing workstream_id, and it never counts as model attachment —
 * the worker's own `workstream action=continue` is what activates the row.
 */
export interface WorkstreamReplacementBinding {
  id: string;
  sessionId: string | null;
  previousConversationId: string | null;
  conversationId: string;
}

export async function bindWorkstreamReplacement(
  commandId: string,
  conversationId: string,
): Promise<WorkstreamReplacementBinding | null> {
  return exclusive(async () => {
    const row = [...rows.values()].find(
      (candidate) =>
        (candidate.commandId === commandId &&
          (candidate.phase === "opening" ||
            (candidate.phase === "active" && candidate.actionId === null))) ||
        // A failed opening command whose chat ChatGPT started anyway (see `lateCommandId`).
        (candidate.lateCommandId === commandId &&
          candidate.phase === "active" &&
          candidate.actionId === null &&
          candidate.commandId === null &&
          candidate.conversationId === null),
    );
    if (!row) return null;
    const previousConversationId = row.conversationId;
    if (previousConversationId && previousConversationId !== conversationId)
      retireReplacedPrimeRuns(row.id, previousConversationId);
    if (
      row.conversationId &&
      row.conversationId !== conversationId &&
      !row.retiredConversations.includes(row.conversationId)
    ) {
      row.retiredConversations.push(row.conversationId);
    }
    row.conversationId = conversationId;
    row.retiredConversations = row.retiredConversations.filter(
      (id) => id !== conversationId,
    );
    // The opening message carried the context; its ACK is the receipt.
    row.contextReceivedBy = conversationId;
    // Delivery of the bootstrap starts the bound chat's lease.
    if (row.phase === "opening") row.lastActivity = Date.now();
    // The command id is retained only as a late-ACK rendezvous between the model's setup call
    // and this browser binding. Once the concrete conversation is known it has no remaining
    // controller meaning and must not survive as stale state on an active row.
    row.commandId = null;
    row.lateCommandId = null;
    await save();
    return {
      id: row.id,
      sessionId: row.sessionId,
      previousConversationId,
      conversationId,
    };
  });
}

/**
 * Releases the late-ACK rendezvous after its browser command became impossible.
 *
 * A replacement model can attach while the browser is still waiting to ACK the concrete
 * conversation id.  That intentionally leaves an active row with commandId set and actionId
 * cleared.  If the browser command later fails (or disappears across restart before producing
 * any receipt), no future ACK can consume that marker.  Clear only that marker; liveness and
 * recovery remain governed by the ordinary workstream lease.
 */
export async function releaseFailedWorkstreamReplacementBind(
  id: string,
  commandId: string,
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      row.phase !== "active" ||
      row.actionId !== null ||
      row.commandId !== commandId
    )
      return false;
    row.commandId = null;
    if (row.conversationId === null) row.lateCommandId = commandId;
    await save();
    return true;
  });
}
