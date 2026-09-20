/** App-issued routing keys carried by models, independent of transport headers.
 * Possession selects a conversation; it does not authenticate a ChatGPT account.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { durableRoot, readDurable, writeDurableNow, writeDurableSoon } from '../durable.js';

const stateSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    key: z.string().regex(/^ck_[A-Za-z0-9_-]{43}$/),
    conversationId: z.string().min(1).max(200).nullable(),
    commandId: z.string().min(1).max(200).nullable()
  }).strict())
}).strict();
type Entry = z.infer<typeof stateSchema>['entries'][number];
const entries = new Map<string, Entry>();
let loadedRoot: string | null = null;
let loading: Promise<void> | null = null;

export async function restoreConversationKeys(): Promise<void> {
  if (loadedRoot === durableRoot()) return;
  if (loading) return loading;
  loading = (async () => {
    const saved = await readDurable<unknown>('conversation-keys');
    const rows = saved === null ? [] : stateSchema.parse(saved).entries;
    entries.clear();
    for (const row of rows) {
      if (entries.has(row.key)) throw new Error('Duplicate conversation key in durable state');
      entries.set(row.key, row);
    }
    loadedRoot = durableRoot();
  })();
  try { await loading; } finally { loading = null; }
}

function snapshot(): z.infer<typeof stateSchema> {
  return { version: 1, entries: [...entries.values()].map((entry) => ({ ...entry })) };
}

export async function persistConversationKeys(): Promise<void> {
  await writeDurableNow('conversation-keys', snapshot());
}

function issue(conversationId: string | null, commandId: string | null): Entry {
  if (loadedRoot !== durableRoot()) throw new Error('Conversation keys have not been restored');
  const entry = { key: `ck_${randomBytes(32).toString('base64url')}`, conversationId, commandId };
  entries.set(entry.key, entry);
  writeDurableSoon('conversation-keys', snapshot());
  return entry;
}

/** A standalone chat can start without any browser observer or transport identity. */
export async function startConversationKey(): Promise<string> {
  await restoreConversationKeys();
  const entry = issue(randomUUID(), null);
  await persistConversationKeys();
  return entry.key;
}

/** The browser command owns provisioning; retries receive exactly the same key. */
export function conversationKeyForCommand(commandId: string, conversationId: string | null): string {
  const existing = [...entries.values()].find((entry) => entry.commandId === commandId);
  if (existing) return existing.key;
  if (conversationId) {
    const bound = [...entries.values()].find((entry) => entry.conversationId === conversationId);
    if (bound) return bound.key;
  }
  return issue(conversationId, commandId).key;
}

export async function bindCommandConversationKey(commandId: string, conversationId: string): Promise<void> {
  const entry = [...entries.values()].find((item) => item.commandId === commandId);
  if (!entry) return; // A restored command may predate key provisioning.
  if (entry.conversationId !== null && entry.conversationId !== conversationId) {
    throw new Error('Conversation key is already bound to another conversation');
  }
  entry.conversationId = conversationId;
  await persistConversationKeys();
}

export function conversationForKey(key: string): string {
  const entry = entries.get(key);
  if (!entry) throw new Error('UNKNOWN_CONVERSATION_KEY: use only the key issued to this conversation.');
  if (!entry.conversationId) throw new Error('CONVERSATION_KEY_PENDING: the browser has not acknowledged this chat yet. Retry after acknowledgement.');
  return entry.conversationId;
}

export function browserConversationForKey(key: string): string | null {
  const entry = entries.get(key);
  return entry?.commandId ? entry.conversationId : null;
}

/** A standalone model publishes its issued key in an assistant message. The paired
 * observer supplies that message's actual conversation, never an active-tab guess. */
export async function bindObservedConversationKey(key: string, conversationId: string): Promise<boolean> {
  const entry = entries.get(key);
  if (!entry || entry.commandId !== null) return false;
  entry.conversationId = conversationId;
  entry.commandId = `observed:${conversationId}`;
  await persistConversationKeys();
  return true;
}

export function conversationKeyInstruction(key: string): string {
  return `Chat On Steroids conversation_key: ${key}\nInclude this exact conversation_key in every connector tool call. Keep it for this conversation; never copy another chat's key. A continuation must use its newly supplied key, not a key quoted in its brief.`;
}
