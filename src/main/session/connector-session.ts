/**
 * Connector session key -> conversation bindings, for the headerless connector platform.
 *
 * Since the 2026-09 platform migration the MCP request carries no `x-request-id`, so the
 * exact page join in correlation.ts can never fire. What the request does carry is one
 * opaque `x-openai-session` key (see inbound.ts), measured live to be distinct across
 * concurrently generating worker chats and stable across each worker's own calls. The key
 * never appears in page evidence, so its owner cannot be *proved* — it can only be
 * *learned*, by one of two kinds of evidence:
 *
 * - a temporally unique moment: exactly one managed conversation was generating as a call
 *   arrived, so that call's key is bound to that conversation (`temporal_unique` learning);
 * - a push-correlated window: the app itself just delivered a verified send into one known
 *   conversation, pushes are serialized, and the key whose calls begin inside the bounded
 *   window after that verification is that conversation's (`push_correlated` learning —
 *   see session/sleep-wake.ts, which owns the window). This is the stronger of the two:
 *   it rests on what the app *did*, not on what the page fleet happened to look like, and
 *   it works with zero page evidence — which is what makes slept (tab-discarded)
 *   conversations attributable at all.
 *
 * The binding is only ever as strong as the evidence that taught it, and everything here
 * is built around not letting that weakness spread:
 *
 * - A key observed at a unique moment for a *different* conversation than its binding is a
 *   contradiction, and contradictions are sticky: the key becomes permanently unusable
 *   rather than letting either side win (same rule as correlation.ts). This applies
 *   identically to push-correlated bindings — stronger evidence does not get to survive
 *   contradiction, it only ranks higher while uncontradicted.
 * - Bindings are in-memory only. If OpenAI rotates keys per turn the stale binding simply
 *   never matches again; after a restart the tiers re-learn from the next unique moment or
 *   push window. Persisting a guess would let one wrong moment outlive every chance to
 *   correct it.
 * - Nothing here is identity authority. The dispatcher records and charge-scopes by these
 *   bindings under their own honest labels; agent identity, inboxes and workspaces still
 *   require exact evidence.
 */

import { logInfo, logWarn } from '../logger.js';

/** How a binding was learned. `push_correlated` outranks `temporal_unique` in honesty labeling. */
export type SessionBindingMethod = 'temporal_unique' | 'push_correlated';

interface HeldBinding {
  conversationId: string | null;
  /** A contradiction is sticky; null alone must not look absent. */
  conflicted: boolean;
  learnedAt: number;
  method: SessionBindingMethod;
}

const MAX_BINDINGS = 5000;

const byKey = new Map<string, HeldBinding>();
/**
 * When each session key was first presented to this process, bound or not.
 *
 * `byKey` only holds keys some tier managed to bind, so it cannot answer "is this key new?".
 * Under a busy fleet most keys never bind at all — `temporal_unique` needs exactly one
 * visible generator and there rarely is one — so a key that has been calling for twenty
 * minutes is indistinguishable, in `byKey`, from one that has never been seen. The
 * push-correlated window used to read that absence as "first sight" and claim it, which is
 * how a long-running worker's call stream was measured (2026-09-10) being bound to a chat
 * that had just been pushed and never made a call in its life.
 *
 * First sighting is the missing evidence: a key whose calls predate the push cannot be the
 * turn that push just started. Kept for every key, not just bound ones, and deliberately
 * separate from `byKey` so eviction of one never silently rejuvenates the other.
 */
const firstSeenByKey = new Map<string, number>();

function trim(): void {
  while (byKey.size > MAX_BINDINGS) {
    const first = byKey.keys().next().value as string | undefined;
    if (!first) break;
    byKey.delete(first);
  }
}

/** Moves a re-confirmed binding to the recency tail of the bounded registry. */
function refresh(sessionKey: string, held: HeldBinding): void {
  held.learnedAt = Date.now();
  // Recency is the bounded registry's eviction order; a re-confirmed live key must not sit
  // at the eviction head while genuinely stale keys survive.
  byKey.delete(sessionKey);
  byKey.set(sessionKey, held);
}

/**
 * Learns (or re-confirms) that `sessionKey` belongs to `conversationId`.
 *
 * Call only with temporally unique evidence: the caller must have observed exactly one
 * managed conversation generating when the key arrived. Re-learning the same owner is
 * idempotent and refreshes recency; a different owner is a contradiction and kills the key.
 */
export function learnSessionBinding(sessionKey: string, conversationId: string): 'stored' | 'same' | 'conflict' {
  const previous = byKey.get(sessionKey);
  if (!previous) {
    byKey.set(sessionKey, { conversationId, conflicted: false, learnedAt: Date.now(), method: 'temporal_unique' });
    trim();
    logInfo(`connector session attribution: learned key -> conversation ${conversationId} at a temporally unique moment`);
    return 'stored';
  }
  if (previous.conflicted || !previous.conversationId) {
    previous.conflicted = true;
    previous.conversationId = null;
    return 'conflict';
  }
  if (previous.conversationId === conversationId) {
    // Temporal re-confirmation never downgrades a push-correlated binding's label: the
    // stronger evidence already stands and the weaker observation merely agrees with it.
    refresh(sessionKey, previous);
    return 'same';
  }
  previous.conflicted = true;
  const prior = previous.conversationId;
  previous.conversationId = null;
  logWarn(
    `connector session attribution conflict: one session key was bound to conversation ${prior} (${previous.method}) ` +
      `and later temporally unique for ${conversationId}; the key is now permanently unusable for attribution`
  );
  return 'conflict';
}

/**
 * Learns (or upgrades) a binding from push-correlated evidence: the app verified its own
 * send into `conversationId` and this key's calls began inside the bounded window after it.
 *
 * Same contradiction rules as temporal learning — a key already bound to a different
 * conversation is killed, sticky, rather than re-owned. Agreement upgrades the method
 * label, because the push correlation is the stronger claim about who owns the key.
 */
export function learnPushCorrelatedBinding(
  sessionKey: string,
  conversationId: string
): 'stored' | 'same' | 'conflict' {
  const previous = byKey.get(sessionKey);
  if (!previous) {
    byKey.set(sessionKey, { conversationId, conflicted: false, learnedAt: Date.now(), method: 'push_correlated' });
    trim();
    logInfo(
      `connector session attribution: learned key -> conversation ${conversationId} from the push-correlated window`
    );
    return 'stored';
  }
  if (previous.conflicted || !previous.conversationId) {
    previous.conflicted = true;
    previous.conversationId = null;
    return 'conflict';
  }
  if (previous.conversationId === conversationId) {
    previous.method = 'push_correlated';
    refresh(sessionKey, previous);
    return 'same';
  }
  previous.conflicted = true;
  const prior = previous.conversationId;
  previous.conversationId = null;
  logWarn(
    `connector session attribution conflict: one session key was bound to conversation ${prior} ` +
      `and later push-correlated to ${conversationId}; the key is now permanently unusable for attribution`
  );
  return 'conflict';
}

/**
 * Kills a key outright on first-sight contradictory evidence — e.g. a fresh key arriving
 * while both a push window (for one conversation) and a temporally unique moment (for a
 * different one) claim it. Neither side may win, same as every other contradiction here.
 */
export function condemnSessionKey(sessionKey: string, reason: string): void {
  const previous = byKey.get(sessionKey);
  if (previous) {
    previous.conflicted = true;
    previous.conversationId = null;
  } else {
    byKey.set(sessionKey, { conversationId: null, conflicted: true, learnedAt: Date.now(), method: 'temporal_unique' });
    trim();
  }
  logWarn(`connector session attribution: key condemned — ${reason}`);
}

/** Exact key lookup. A contradicted and an absent key both resolve to null. */
export function sessionBinding(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const held = byKey.get(sessionKey);
  return held && !held.conflicted ? held.conversationId : null;
}

/** Exact key lookup carrying the honesty label the binding was learned under. */
export function sessionBindingDetail(
  sessionKey: string | null | undefined
): { conversationId: string; method: SessionBindingMethod } | null {
  if (!sessionKey) return null;
  const held = byKey.get(sessionKey);
  if (!held || held.conflicted || !held.conversationId) return null;
  return { conversationId: held.conversationId, method: held.method };
}

/**
 * The most recently learned live key bound to a conversation, or null.
 *
 * Used by the sleep path to record which key a conversation slept with. A conversation can
 * own several keys over time (OpenAI may rotate); the newest uncontradicted one is the one
 * its current server turn is calling with.
 */
export function boundKeyForConversation(conversationId: string): string | null {
  let found: string | null = null;
  for (const [key, held] of byKey) {
    if (!held.conflicted && held.conversationId === conversationId) found = key;
  }
  return found;
}

/**
 * Records that this key has now been seen, and answers when it was *first* seen.
 *
 * Called on every degraded call before any tier looks at the key, so the answer is "now"
 * exactly on a key's first sighting and the original timestamp forever after. That is the
 * evidence the push-correlated window needs: a key already calling before the window opened
 * belongs to a call stream the push did not start.
 */
export function noteSessionKeySeen(sessionKey: string, at: number = Date.now()): number {
  const seen = firstSeenByKey.get(sessionKey);
  if (seen !== undefined) return seen;
  firstSeenByKey.set(sessionKey, at);
  while (firstSeenByKey.size > MAX_BINDINGS) {
    const oldest = firstSeenByKey.keys().next().value as string | undefined;
    if (!oldest) break;
    firstSeenByKey.delete(oldest);
  }
  return at;
}

/** First sighting of a key, or null if this process has never seen it. Diagnosis/tests. */
export function sessionKeyFirstSeenAt(sessionKey: string): number | null {
  return firstSeenByKey.get(sessionKey) ?? null;
}

/** Whether this key has contradictory temporal evidence. Diagnosis/tests only. */
export function sessionBindingConflicted(sessionKey: string): boolean {
  return byKey.get(sessionKey)?.conflicted === true;
}

export function resetSessionBindingsForTests(): void {
  byKey.clear();
  firstSeenByKey.clear();
}
