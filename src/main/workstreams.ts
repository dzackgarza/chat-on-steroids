/** Exclusive workstream leases and their bounded recovery policy. The bridge owns delivery. */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { durableRoot, writeDurableNow, writeDurableSoon } from './durable.js';
import { unifiedExecManager } from './codex/manager.js';
import { execOwner } from './codex/ownership.js';
import { runningToolCalls } from './mcp/call-context.js';
import type { ChatObservation } from './session/recorder.js';

export const WORKSTREAM_LEASE_MS = 10 * 60_000;
export const RECOVERY_BACKOFF_MS = [60_000, 120_000, 240_000] as const;
export const workstreamIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const rowSchema = z.object({
  id: workstreamIdSchema,
  context: z.string().max(40_000),
  workspace: z.string().nullable(),
  observations: z.record(z.string(), z.string()),
  ownerKey: z.string(),
  conversationId: z.string().nullable(),
  lock: z.string(),
  lastActivity: z.number(),
  phase: z.enum(['active', 'recovering', 'archiving', 'opening', 'blocked', 'paused']),
  attempts: z.number().int().min(0).max(3),
  nextCheck: z.number(),
  commandId: z.string().nullable(),
  actionId: z.string().nullable(),
  error: z.string().nullable(),
  retiredKeys: z.array(z.string()),
  retiredConversations: z.array(z.string())
}).strict();
export type Workstream = z.infer<typeof rowSchema>;
const stateSchema = z.object({ version: z.literal(1), rows: z.array(rowSchema) }).strict();
const rows = new Map<string, Workstream>();
let loadedRoot: string | null = null;
let serial: Promise<unknown> = Promise.resolve();

function snapshot() { return { version: 1 as const, rows: [...rows.values()].map((row) => structuredClone(row)) }; }
function save() { return writeDurableNow('workstreams', snapshot()); }
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = serial.then(fn);
  serial = result.then(() => undefined, () => undefined);
  return result;
}
export async function restoreWorkstreams(): Promise<void> {
  return exclusive(async () => {
    if (loadedRoot === durableRoot()) return;
    const saved: unknown = durableRoot() ? await fs.readFile(path.join(durableRoot(), 'workstreams.json'), 'utf8').then(
      (raw) => JSON.parse(raw),
      (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; }
    ) : null;
    const restored = saved === null ? [] : stateSchema.parse(saved).rows;
    rows.clear();
    for (const row of restored) {
      if (rows.has(row.id)) throw new Error('Duplicate durable workstream');
      rows.set(row.id, row);
    }
    loadedRoot = durableRoot();
  });
}
function ready() {
  if (loadedRoot !== durableRoot()) throw new Error('Workstreams have not been restored');
}
export function workstreamStatus(): Workstream[] {
  ready();
  return [...rows.values()].map((row) => structuredClone(row));
}
export function workstreamForKey(key: string): Workstream | null {
  ready();
  return [...rows.values()].find((row) => row.ownerKey === key && row.phase !== 'paused') ?? null;
}

export type LeaseResult = { ok: true; lock: string; workstreamId: string } |
  { ok: false; code: 'WORKSTREAM_BUSY' | 'WORKSTREAM_RETIRED' | 'WORKSTREAM_LOCK_LOST' | 'WORKSTREAM_PAUSED' };

/** Claim is a handshake, never an admission to the requested tool operation. */
export async function claimWorkstream(key: string, conversationId: string | null, id: string, now = Date.now()): Promise<LeaseResult> {
  return exclusive(async () => {
    ready();
    workstreamIdSchema.parse(id);
    if ([...rows.values()].some((row) => row.retiredKeys.includes(key))) return { ok: false, code: 'WORKSTREAM_RETIRED' };
    const owned = workstreamForKey(key);
    const prior = rows.get(id);
    if (prior?.phase === 'paused') return { ok: false, code: 'WORKSTREAM_PAUSED' };
    if (prior && prior.ownerKey !== key && now < prior.lastActivity + WORKSTREAM_LEASE_MS) {
      return { ok: false, code: 'WORKSTREAM_BUSY' };
    }
    if (prior?.ownerKey === key && ['archiving', 'opening', 'blocked'].includes(prior.phase)) {
      return { ok: false, code: 'WORKSTREAM_RETIRED' };
    }
    if (owned && owned.id !== id) {
      owned.phase = 'paused';
      owned.actionId = null;
      owned.commandId = null;
    }
    const lock = prior?.ownerKey === key ? prior.lock : `wl_${randomBytes(32).toString('base64url')}`;
    rows.set(id, {
      id, context: prior?.context ?? '', workspace: prior?.workspace ?? null, observations: prior?.ownerKey === key ? prior.observations : {}, ownerKey: key, conversationId, lock, lastActivity: now,
      phase: 'active', attempts: 0, nextCheck: 0, commandId: null, actionId: null, error: null,
      retiredKeys: [...(prior?.retiredKeys ?? []), ...(prior && prior.ownerKey !== key ? [prior.ownerKey] : [])],
      retiredConversations: [...(prior?.retiredConversations ?? []), ...(prior?.conversationId && prior.ownerKey !== key ? [prior.conversationId] : [])]
    });
    await save();
    return { ok: true, lock, workstreamId: id };
  });
}

/** Expiry permits a race to reclaim; the first claimant/tool activity wins atomically. */
export async function admitWorkstreamCall(key: string, lock: string, now = Date.now()): Promise<LeaseResult> {
  return exclusive(async () => {
    ready();
    const row = workstreamForKey(key);
    if (!row || row.lock !== lock || !['active', 'recovering'].includes(row.phase)) {
      return { ok: false, code: 'WORKSTREAM_LOCK_LOST' };
    }
    // Claim transfers ownership immediately. Execution waits for the former owner's
    // already-admitted calls to settle, and kills its retained terminal processes.
    for (const process of unifiedExecManager.listProcesses()) {
      const owner = execOwner(process.processId);
      if (owner && row.retiredConversations.includes(owner)) await unifiedExecManager.terminateProcess(process.processId);
    }
    if (row.retiredConversations.some((id) => runningToolCalls(id) > 0)) return { ok: false, code: 'WORKSTREAM_BUSY' };
    row.lastActivity = now;
    row.phase = 'active';
    row.attempts = 0;
    row.nextCheck = 0;
    row.commandId = null;
    row.actionId = null;
    row.error = null;
    await save();
    return { ok: true, lock, workstreamId: row.id };
  });
}

/** Only changed, freshly observed messages count. Polls, backfills and our own recovery text do not. */
export function noteWorkstreamChatActivity(conversationId: string, time: number, now = Date.now()): void {
  if (loadedRoot !== durableRoot() || time > now + 5_000 || time < now - 60_000) return;
  for (const row of rows.values()) {
    if (row.conversationId !== conversationId || !['active', 'recovering'].includes(row.phase)) continue;
    row.lastActivity = Math.max(row.lastActivity, time);
    row.phase = 'active';
    row.attempts = 0;
    row.nextCheck = 0;
    row.commandId = null;
    row.actionId = null;
    writeDurableSoon('workstreams', snapshot());
  }
}

/** Liveness is independent of optional transcript retention. Keep bounded fingerprints,
 * not message contents, so journal replay and history hydration cannot renew a lease. */
export function observeWorkstreamMessages(conversationId: string, observations: readonly ChatObservation[], now = Date.now()): void {
  if (loadedRoot !== durableRoot()) return;
  const row = [...rows.values()].find((candidate) => candidate.conversationId === conversationId && ['active', 'recovering'].includes(candidate.phase));
  if (!row) return;
  for (const item of observations) {
    if (!['user_message', 'assistant_message', 'page_tool'].includes(item.kind) || !item.messageId || !item.text) continue;
    if (item.kind === 'user_message' && item.text.startsWith('Continue workstream ')) continue;
    const id = `${item.kind}:${item.messageId}`;
    const digest = createHash('sha256').update(item.text).digest('hex');
    const previous = row.observations[id];
    if (previous === digest) continue;
    delete row.observations[id];
    row.observations[id] = digest;
    const keys = Object.keys(row.observations);
    for (const old of keys.slice(0, Math.max(0, keys.length - 64))) delete row.observations[old];
    if (previous !== undefined || (item.time >= now - 60_000 && item.time <= now + 5_000)) {
      noteWorkstreamChatActivity(conversationId, now, now);
    }
    writeDurableSoon('workstreams', snapshot());
  }
}

export async function configureWorkstream(id: string, context: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row) return false;
    row.context = z.string().max(40_000).parse(context);
    await save();
    return true;
  });
}

export async function recordWorkstreamStart(id: string, key: string, commandId: string): Promise<void> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.ownerKey !== key) throw new Error('Workstream start lost ownership');
    row.commandId = commandId;
    row.actionId = `start-${row.lock}`;
    await save();
  });
}

export function noteWorkstreamWorkspace(conversationId: string, workspace: string): void {
  if (loadedRoot !== durableRoot()) return;
  for (const row of rows.values()) {
    if (row.conversationId !== conversationId || row.phase !== 'active' || row.workspace === workspace) continue;
    row.workspace = workspace;
    writeDurableSoon('workstreams', snapshot());
  }
}

export async function pauseWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row) return false;
    row.phase = 'paused';
    row.commandId = null;
    row.actionId = null;
    await save();
    return true;
  });
}

export async function resumeWorkstream(id: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.phase !== 'paused') return false;
    if ([...rows.values()].some((other) => other.id !== id && other.ownerKey === row.ownerKey && other.phase !== 'paused')) return false;
    row.phase = 'active';
    row.lastActivity = Date.now();
    row.attempts = 0;
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
    if (!row || !['active', 'recovering'].includes(row.phase) || !row.conversationId) return false;
    row.phase = 'archiving';
    row.attempts = 3;
    row.nextCheck = 0;
    row.commandId = null;
    row.actionId = `archive-${row.lock}`;
    row.error = null;
    await save();
    return true;
  });
}

export const STEWARD_CONTINUATION = 'Read AGENTS.md and the repository TODOs. Read the vault plans when needed. Identify the next unblocked DAG work and start it immediately. Preserve other workers’ changes, finish the substantive work, and keep the workstream moving.';
export function workstreamPrompt(row: Workstream): string {
  return `Continue workstream ${row.id}. Claim it with workstream_lock="claim:${row.id}" before executing tools.\n${row.workspace ? `Project: ${row.workspace}\n` : ''}${row.context}\n${STEWARD_CONTINUATION}`;
}

/** Persistent action intent is written before delivery. The action id is its idempotency key. */
export async function nextWorkstreamActions(now = Date.now()): Promise<Workstream[]> {
  return exclusive(async () => {
    ready();
    for (const row of rows.values()) {
      if (row.phase === 'active' && now >= row.lastActivity + WORKSTREAM_LEASE_MS) {
        row.phase = 'recovering';
        row.nextCheck = now;
      }
      if (row.phase !== 'recovering' || now < row.nextCheck) continue;
      if (row.attempts === 3) {
        row.phase = 'archiving';
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
    return workstreamStatus().filter((row) => row.actionId !== null && ['recovering', 'archiving', 'opening'].includes(row.phase));
  });
}

export function currentWorkstreamAction(id: string, actionId: string): Workstream | null {
  const row = rows.get(id);
  return row?.actionId === actionId ? structuredClone(row) : null;
}

export async function recordWorkstreamCommand(id: string, actionId: string, commandId: string): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId) return false;
    row.commandId = commandId;
    await save();
    return true;
  });
}

export async function blockWorkstreamAction(id: string, actionId: string, error: string): Promise<void> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId) return;
    row.phase = 'blocked';
    row.error = error;
    row.actionId = null;
    await save();
  });
}

export async function finishWorkstreamArchive(id: string, actionId: string, error: string | null): Promise<boolean> {
  return exclusive(async () => {
    const row = rows.get(id);
    if (!row || row.actionId !== actionId || row.phase !== 'archiving') return false;
    row.phase = error ? 'blocked' : 'opening';
    row.error = error;
    row.actionId = error ? null : `replace-${row.lock}`;
    row.commandId = null;
    await save();
    return true;
  });
}

export async function bindWorkstreamReplacement(commandId: string, key: string, conversationId: string): Promise<void> {
  return exclusive(async () => {
    const row = [...rows.values()].find((candidate) => candidate.phase === 'opening' && candidate.commandId === commandId);
    if (!row) {
      const owned = workstreamForKey(key);
      if (owned && owned.conversationId === null) {
        owned.conversationId = conversationId;
        owned.commandId = null;
        owned.actionId = null;
        await save();
      }
      return;
    }
    row.retiredKeys.push(row.ownerKey);
    if (row.conversationId) row.retiredConversations.push(row.conversationId);
    row.ownerKey = key;
    row.observations = {};
    row.conversationId = conversationId;
    row.lock = `wl_${randomBytes(32).toString('base64url')}`;
    row.phase = 'active';
    row.lastActivity = Date.now();
    row.attempts = 0;
    row.commandId = null;
    row.actionId = null;
    await save();
  });
}
