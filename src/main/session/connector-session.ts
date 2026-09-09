/**
 * Connector session key -> conversation bindings, for the headerless connector platform.
 *
 * Since the 2026-09 platform migration the MCP request carries no `x-request-id`, so the
 * exact page join in correlation.ts can never fire. What the request does carry is one
 * opaque `x-openai-session` key (see inbound.ts), measured live to be distinct across
 * concurrently generating worker chats and stable across each worker's own calls. The key
 * never appears in page evidence, so its owner cannot be *proved* — it can only be
 * *learned* at a temporally unique moment: when exactly one managed conversation was
 * generating as a call arrived, that call's key is bound to that conversation.
 *
 * The binding is therefore only ever as strong as the temporal evidence that taught it,
 * and everything here is built around not letting that weakness spread:
 *
 * - A key observed at a unique moment for a *different* conversation than its binding is a
 *   contradiction, and contradictions are sticky: the key becomes permanently unusable
 *   rather than letting either side win (same rule as correlation.ts).
 * - Bindings are in-memory only. If OpenAI rotates keys per turn the stale binding simply
 *   never matches again; after a restart the tiers re-learn from the next unique moment.
 *   Persisting a guess would let one wrong moment outlive every chance to correct it.
 * - Nothing here is identity authority. The dispatcher records and charge-scopes by these
 *   bindings under their own honest labels; agent identity, inboxes and workspaces still
 *   require exact evidence.
 */

import { logInfo, logWarn } from '../logger.js';

interface HeldBinding {
  conversationId: string | null;
  /** A contradiction is sticky; null alone must not look absent. */
  conflicted: boolean;
  learnedAt: number;
}

const MAX_BINDINGS = 5000;

const byKey = new Map<string, HeldBinding>();

function trim(): void {
  while (byKey.size > MAX_BINDINGS) {
    const first = byKey.keys().next().value as string | undefined;
    if (!first) break;
    byKey.delete(first);
  }
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
    byKey.set(sessionKey, { conversationId, conflicted: false, learnedAt: Date.now() });
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
    previous.learnedAt = Date.now();
    // Recency is the bounded registry's eviction order; a re-confirmed live key must not sit
    // at the eviction head while genuinely stale keys survive.
    byKey.delete(sessionKey);
    byKey.set(sessionKey, previous);
    return 'same';
  }
  previous.conflicted = true;
  const prior = previous.conversationId;
  previous.conversationId = null;
  logWarn(
    `connector session attribution conflict: one session key was temporally unique for conversation ${prior} ` +
      `and later for ${conversationId}; the key is now permanently unusable for attribution`
  );
  return 'conflict';
}

/** Exact key lookup. A contradicted and an absent key both resolve to null. */
export function sessionBinding(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const held = byKey.get(sessionKey);
  return held && !held.conflicted ? held.conversationId : null;
}

/** Whether this key has contradictory temporal evidence. Diagnosis/tests only. */
export function sessionBindingConflicted(sessionKey: string): boolean {
  return byKey.get(sessionKey)?.conflicted === true;
}

export function resetSessionBindingsForTests(): void {
  byKey.clear();
}
