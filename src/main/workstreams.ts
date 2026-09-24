/** Exclusive workstream leases and their bounded recovery policy. The bridge owns delivery. */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { durableRoot, writeDurableNow, writeDurableSoon } from "./durable.js";
import { unifiedExecManager } from "./codex/manager.js";
import { execOwner } from "./codex/ownership.js";
import { runningToolCallsForWorkstream } from "./mcp/call-context.js";
import { detachSessionConversation } from "./session/store.js";
import { logWarn } from "./logger.js";
import type { ChatObservation } from "./session/recorder.js";

export const WORKSTREAM_LEASE_MS = 5 * 60_000;
/** A setup/reclaim is administrative, not substantive work. Give the model only enough time
 * to make its first ordinary claimed call before stale-work recovery remains eligible. */
const WORKSTREAM_CLAIM_GRACE_MS = 30_000;
/** Tool activity this recent proves a worker alive when only the observation of its turn ended. */
const OBSERVATION_LOSS_ACTIVITY_MS = 2 * 60_000;
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
    observations: z.record(z.string(), z.string()),
    ownerKey: z.string(),
    conversationId: z.string().nullable(),
    sessionId: z.string().nullable().default(null),
    lock: z.string(),
    lastActivity: z.number(),
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
    actionId: z.string().nullable(),
    error: z.string().nullable(),
    retiredKeys: z.array(z.string()),
    retiredConversations: z.array(z.string()),
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
    if (loadedRoot === durableRoot()) return;
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

export function workstreamWorkspace(logicalWorkstream: string): string | null {
  ready();
  return rows.get(logicalWorkstream)?.workspace ?? null;
}

/** Whether this exact conversation belongs to a controller-driven workstream. */
export function autoAdvancingWorkstreamForConversation(
  conversationId: string,
): boolean {
  ready();
  return [...rows.values()].some(
    (row) =>
      row.conversationId === conversationId &&
      row.autoAdvance &&
      !["paused", "blocked", "archiving", "opening"].includes(row.phase),
  );
}

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
        !["paused", "blocked", "archiving"].includes(row.phase),
    );
    if (matches.length !== 1) return false;
    const row = matches[0]!;
    if (
      [...rows.values()].some(
        (other) =>
          other.id !== row.id &&
          other.conversationId === conversationId &&
          !["paused", "blocked"].includes(other.phase),
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
        | "WORKSTREAM_NOT_FOUND"
        | "WORKSTREAM_UNAVAILABLE";
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
 * workstream and issue its opaque attachment id. The logical name is supplied by the
 * model so the identity names the repository/task it is claiming rather than an invented
 * transport identifier.
 */
export async function startWorkstream(
  logicalWorkstream: string,
  now = Date.now(),
): Promise<WorkstreamSetupResult> {
  return exclusive(async () => {
    ready();
    workstreamIdSchema.parse(logicalWorkstream);
    if (rows.has(logicalWorkstream))
      return { ok: false, code: "WORKSTREAM_ALREADY_EXISTS" };
    const workstreamId = freshWorkstreamId();
    rows.set(logicalWorkstream, {
      id: logicalWorkstream,
      context: "",
      workspace: null,
      observations: {},
      ownerKey: logicalWorkstream,
      conversationId: null,
      sessionId: null,
      lock: workstreamId,
      lastActivity: now,
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
    });
    await save();
    return { ok: true, id: logicalWorkstream, workstreamId };
  });
}

/**
 * Model-facing setup, `action=continue`: claim an existing logical workstream and issue a
 * FRESH opaque attachment id. The previously issued id becomes invalid immediately — old
 * ids from replaced owners stay fenced because only the current `lock` admits a call.
 *
 * A row reserved by the controller in `opening` phase is activated here; this is the
 * transition that issues the model-visible attachment id. Re-attaching an already-bound
 * workstream rotates only the opaque token. The setup call deliberately has no browser
 * identity, so it must not guess that the row's current conversation is some other owner
 * and retire it. Genuine browser replacements are retired in bindWorkstreamReplacement(),
 * where both the old and new conversation ids are known exactly.
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
    // Setup has no browser-provenance dependency. A `blocked` row is a controller-side
    // delivery failure (e.g. the app-opened chat's conversation never bound); the model's own
    // explicit `continue` is the attach that reclaims it. Only an in-flight replacement
    // (`archiving`) genuinely refuses, because a distinct thread already owns the handoff.
    if (prior.phase === "archiving")
      return { ok: false, code: "WORKSTREAM_UNAVAILABLE" };
    const newLock = freshWorkstreamId();
    const retiredKeys = [...new Set([...prior.retiredKeys, prior.lock])].slice(-16);
    rows.set(logicalWorkstream, {
      id: logicalWorkstream,
      context: prior.context,
      workspace: prior.workspace,
      observations: prior.observations,
      ownerKey: logicalWorkstream,
      conversationId: prior.conversationId,
      sessionId: prior.sessionId,
      lock: newLock,
      // Claim rotation is not repository/model progress. Preserve the last substantive
      // activity timestamp; the first ordinary call admitted under this fresh claim renews it.
      lastActivity: prior.lastActivity,
      phase: "active",
      autoAdvance: prior.autoAdvance,
      lastAdvancedTurnId: prior.lastAdvancedTurnId,
      lastAdvancedTurnTime: prior.lastAdvancedTurnTime,
      attempts: 0,
      // Avoid a maintenance-sweep race between the setup result and the model's immediate first
      // ordinary call without granting another five-minute lease to a no-op claimant.
      nextCheck: now + WORKSTREAM_CLAIM_GRACE_MS,
      // Keep the controller's commandId only while the row is still `opening`, so a late
      // browser ACK can fill the conversation without rotating the issued attachment id.
      commandId: prior.phase === "opening" ? prior.commandId : null,
      actionId: null,
      error: null,
      retiredKeys,
      retiredConversations: [...prior.retiredConversations],
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
      observations: prior?.observations ?? {},
      ownerKey: logicalWorkstream,
      conversationId,
      sessionId: prior?.sessionId ?? null,
      lock,
      lastActivity: now,
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
        ["active", "recovering"].includes(candidate.phase),
    );
    if (!row) return { ok: false, code: "WORKSTREAM_ID_NOT_CURRENT" };
    // Re-attachment fenced the former opaque claim. Execution waits for calls already
    // admitted under retired claim ids to settle and kills their retained terminal processes.
    for (const process of unifiedExecManager.listProcesses()) {
      const owner = execOwner(process.processId);
      if (
        owner?.workstreamId === row.id &&
        row.retiredKeys.includes(owner.claimId)
      )
        await unifiedExecManager.terminateProcess(process.processId);
    }
    if (
      row.retiredKeys.some(
        (claimId) =>
          runningToolCallsForWorkstream(row.id, claimId) > 0,
      )
    )
      return { ok: false, code: "WORKSTREAM_BUSY" };
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

/** Only changed, freshly observed messages count. Polls, backfills and our own recovery text do not. */
export function noteWorkstreamChatActivity(
  conversationId: string,
  time: number,
  now = Date.now(),
): void {
  if (loadedRoot !== durableRoot() || time > now + 5_000 || time < now - 60_000)
    return;
  for (const row of rows.values()) {
    if (
      row.conversationId !== conversationId ||
      !["active", "recovering"].includes(row.phase)
    )
      continue;
    row.lastActivity = Math.max(row.lastActivity, time);
    row.phase = "active";
    row.attempts = 0;
    row.nextCheck = 0;
    row.commandId = null;
    row.actionId = null;
    writeDurableSoon("workstreams", snapshot());
  }
}

/** Liveness is independent of optional transcript retention. Keep bounded fingerprints,
 * not message contents, so journal replay and history hydration cannot renew a lease. */
export function observeWorkstreamMessages(
  conversationId: string,
  observations: readonly ChatObservation[],
  now = Date.now(),
): void {
  if (loadedRoot !== durableRoot()) return;
  const row = [...rows.values()].find(
    (candidate) =>
      candidate.conversationId === conversationId &&
      ["active", "recovering"].includes(candidate.phase),
  );
  if (!row) return;
  for (const item of observations) {
    if (
      !["user_message", "assistant_message", "page_tool"].includes(item.kind) ||
      !item.messageId ||
      !item.text
    )
      continue;
    if (
      item.kind === "user_message" &&
      item.text.startsWith("Continue workstream ")
    )
      continue;
    const id = `${item.kind}:${item.messageId}`;
    const digest = createHash("sha256").update(item.text).digest("hex");
    const previous = row.observations[id];
    if (previous === digest) continue;
    delete row.observations[id];
    row.observations[id] = digest;
    const keys = Object.keys(row.observations);
    for (const old of keys.slice(0, Math.max(0, keys.length - 64)))
      delete row.observations[old];
    // The fingerprint map is deliberately bounded, so an old DOM row can fall out of it
    // and later be observed again during history hydration. A page-tool row has no authored
    // timestamp: after a reload its `time` is merely the new observation time, so treating an
    // unknown first sight as fresh lets a static history with >64 rows continually evict and
    // re-add itself, renew the lease, and cancel recovery forever. First sight may renew the
    // lease only when ChatGPT supplied a stable authored timestamp. Otherwise the row must
    // already be in the bounded map and actually change before it counts as progress.
    if (
      item.time > row.lastActivity &&
      (previous !== undefined || item.authoredTime === true) &&
      item.time >= now - 60_000 &&
      item.time <= now + 5_000
    ) {
      noteWorkstreamChatActivity(conversationId, item.time, now);
    }
    writeDurableSoon("workstreams", snapshot());
  }
}

/**
 * Turns a freshly observed managed turn boundary into the next controller action.
 * Completed work advances immediately. An observed abnormal end recovers immediately;
 * silent/wedged turns still use the five-minute lease path in nextWorkstreamActions().
 */
export async function scheduleWorkstreamAfterTurn(
  conversationId: string,
  turnId: string,
  outcome: NonNullable<ChatObservation["outcome"]>,
  time: number,
  now = Date.now(),
): Promise<boolean> {
  return exclusive(async () => {
    ready();
    if (!turnId || time > now + 5_000 || time < now - 60_000) return false;
    const row = [...rows.values()].find(
      (candidate) =>
        candidate.conversationId === conversationId &&
        candidate.phase === "active" &&
        candidate.autoAdvance,
    );
    if (
      !row ||
      (row.lastAdvancedTurnId === turnId && time <= row.lastAdvancedTurnTime)
    )
      return false;
    // These outcomes say the app lost sight of the turn (a tab closed or reloaded, another tab
    // took over observing it, or the page could not classify the boundary), not that ChatGPT
    // ended it badly. While the worker is visibly working, recovering would press Stop on a
    // live turn; a real stall still surfaces through the five-minute lease.
    if (
      ["stalled", "observer_lost", "unknown"].includes(outcome) &&
      (runningToolCallsForWorkstream(row.id) > 0 ||
        now - row.lastActivity < OBSERVATION_LOSS_ACTIVITY_MS)
    )
      return false;

    row.lastAdvancedTurnId = turnId;
    row.lastAdvancedTurnTime = time;
    row.lastActivity = Math.max(row.lastActivity, time);
    row.commandId = null;
    row.error = null;
    if (outcome === "completed") {
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
    await save();
    return true;
  });
}

export function noteWorkstreamWorkspace(
  logicalWorkstream: string,
  workspace: string,
): void {
  if (loadedRoot !== durableRoot()) return;
  const row = rows.get(logicalWorkstream);
  // The logical workstream's workspace is its repository binding, not the cwd of the most
  // recent tool call. A worker may legitimately inspect a nested dependency repository (for
  // example `.lake/packages/mathlib`) without moving the workstream itself there. Learn the
  // repository once for an unbound workstream; replacements and subsequent calls preserve it.
  if (!row || row.phase !== "active" || row.workspace !== null) return;
  row.workspace = workspace;
  writeDurableSoon("workstreams", snapshot());
}

export async function pauseWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row) return false;
    row.phase = "paused";
    row.commandId = null;
    row.actionId = null;
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
    // Resuming management is not repository/model progress. Preserve the prior activity
    // timestamp so a chat that was already stale before the pause does not receive a fresh
    // five-minute lease merely because someone re-enabled its controller.
    row.phase = row.error?.startsWith("five_minute_")
      ? "recovering"
      : "active";
    row.attempts = 0;
    if (row.phase === "recovering") row.nextCheck = Date.now();
    await save();
    return true;
  });
}

/** Script-owned hard recovery: fence the current owner and enter the same archive/replacement
 * path used after automatic revival exhaustion. This exists so an external steward can replace
 * a demonstrably dead workstream without reproducing the bridge's private state machine. */
export async function replaceWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      !["active", "recovering"].includes(row.phase) ||
      !row.conversationId
    )
      return false;
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
): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (
      !row ||
      !["active", "advancing"].includes(row.phase) ||
      !row.conversationId
    )
      return false;
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

export const STEWARD_CONTINUATION =
  "Read AGENTS.md and the repository TODOs. Read the vault plans when needed. Identify the next unblocked DAG work and start it immediately. Preserve other workers’ changes, finish the substantive work, and keep the workstream moving. Keep every command/tool action under five minutes. These managed workstreams are source/architecture/definition/card work, not release pipelines: do not push/publish, start watchers/servers, use foreground sleeps, declare persistent terminal sessions, or run broad/heavy test/build suites unless the CURRENT repository contract explicitly requires that exact action. Prefer focused owner-local checks. A command or test approaching five minutes is a major failure signal: stop it, re-read the explicit assigned task/DAG/phase boundary, check for drift or over-broad validation, and resume with a narrower action rather than waiting.";
export function workstreamPrompt(row: Workstream): string {
  const recoveryNotice =
    row.error?.startsWith("five_minute_")
      ? row.error.startsWith("five_minute_action_overrun:")
        ? `\nRECOVERY NOTICE: Your previous action exceeded the hard five-minute action ceiling: ${row.error.slice("five_minute_action_overrun:".length)}. This is not normal waiting. In these repository workstreams, no single command, test, build, or tool action should take more than five minutes. Treat this as a major red flag for drift, an over-broad or unacceptably slow test/build, unnecessary heavyweight work, or work outside the assigned phase such as push/publication. Re-read the CURRENT explicit task, AGENTS.md, TODO/DAG/frontier, and phase constraints before doing anything else. Verify that you are still on the repository-selected unit and are not attempting push/publication or broad validation unless explicitly required. Resume with a narrower source action or focused owner-local check; do not rerun the same long command.\n`
        : "\nRECOVERY NOTICE: This workstream made no substantive movement for five minutes. There is no autonomous waiting/wake-up state after tool activity stops; five minutes without movement means the worker is stalled. Re-read the CURRENT explicit task, AGENTS.md, TODO/DAG/frontier, and phase constraints, verify you are still on the selected unit, check for drift such as broad tests/builds or push/publication work, and resume immediately with a narrower substantive action.\n"
      : "";
  return `Continue workstream ${row.id}. Before any other connector operation, call \`workstream\` with action="continue" and workstream="${row.id}". Then include the returned workstream_id on every ordinary connector call.\n${row.workspace ? `Project: ${row.workspace}\n` : ""}${row.context}${recoveryNotice}\n${STEWARD_CONTINUATION}`;
}

/** Persistent action intent is written before delivery. The action id is its idempotency key. */
export async function nextWorkstreamActions(
  now = Date.now(),
): Promise<Workstream[]> {
  return exclusive(async () => {
    ready();
    for (const row of rows.values()) {
      // A durable five-minute failure remains a failure until a real new model/tool action
      // begins. Controller restart/resume must not convert it back into a fresh active lease.
      if (
        row.phase === "active" &&
        row.error?.startsWith("five_minute_")
      ) {
        row.phase = "recovering";
        row.attempts = 0;
        row.nextCheck = now;
        row.commandId = null;
        row.actionId = null;
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
      if (
        row.phase === "advancing" &&
        now >= row.lastActivity + WORKSTREAM_LEASE_MS
      ) {
        row.phase = "recovering";
        row.attempts = 0;
        row.nextCheck = now;
        row.commandId = null;
        row.actionId = null;
        row.error = "five_minute_no_movement";
      }
      if (
        row.phase === "active" &&
        now >= row.lastActivity + WORKSTREAM_LEASE_MS &&
        now >= row.nextCheck
      ) {
        row.phase = "recovering";
        row.nextCheck = now;
        row.error = "five_minute_no_movement";
      }
      // A bound replacement chat whose model never attached is a stalled frontend like any
      // other: the bind started its lease, and expiry revives/replaces that exact chat.
      if (
        row.phase === "opening" &&
        row.conversationId &&
        row.commandId === null &&
        now >= row.lastActivity + WORKSTREAM_LEASE_MS
      ) {
        row.phase = "recovering";
        row.attempts = 0;
        row.nextCheck = now;
        row.actionId = null;
        row.error = "five_minute_no_movement";
      }
      // A revive in flight is judged by its own outcome, never by a timer racing its delivery:
      // the command's deadline bounds the wait, a failed or lost command releases the row
      // immediately, and a delivered one starts the response window below.
      if (row.phase === "recovering" && row.commandId !== null) continue;
      if (row.phase !== "recovering" || now < row.nextCheck) continue;
      if (!row.conversationId) {
        // No known frontend means there is nothing honest to revive or archive. This is the
        // expected state after a successful archive whose replacement failed, or whenever a
        // logical workstream has continued making tool progress without a controller-bound
        // browser route. Recovery must create a fresh frontend directly rather than waiting
        // forever for a conversation id that ordinary workstream calls intentionally do not
        // carry.
        row.phase = "opening";
        row.actionId = `replace-${row.lock}`;
        row.commandId = null;
        row.nextCheck = now;
        continue;
      }
      // A WEB:<uuid> route is a send ChatGPT had not accepted when it was bound, and it was
      // never promoted to a server conversation. There is nothing to revive (reopening the
      // route lands on an empty page) and nothing to archive (the backend rejects the id):
      // retire it and open the replacement directly.
      if (row.conversationId.startsWith("WEB:")) {
        if (!row.retiredConversations.includes(row.conversationId))
          row.retiredConversations.push(row.conversationId);
        row.conversationId = null;
        row.phase = "opening";
        row.actionId = `replace-${row.lock}`;
        row.commandId = null;
        row.nextCheck = now;
        continue;
      }
      if (row.attempts >= MAX_RECOVERY_ATTEMPTS) {
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
        ["advancing", "recovering", "archiving", "opening"].includes(row.phase) &&
        // An opening row whose replacement chat already bound has been delivered; it waits for
        // that chat's `continue` (or the lease above), never for another fresh chat.
        (row.phase !== "opening" ||
          (now >= row.nextCheck && row.conversationId === null)),
    );
  });
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
        candidate.commandId === commandId &&
        (candidate.phase === "opening" ||
          (candidate.phase === "active" && candidate.actionId === null)),
    );
    if (!row) return null;
    const previousConversationId = row.conversationId;
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
    // Delivery of the bootstrap starts the bound chat's lease.
    if (row.phase === "opening") row.lastActivity = Date.now();
    // The command id is retained only as a late-ACK rendezvous between the model's setup call
    // and this browser binding. Once the concrete conversation is known it has no remaining
    // controller meaning and must not survive as stale state on an active row.
    row.commandId = null;
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
    await save();
    return true;
  });
}
