import { claimWorkstream, workstreamForKey } from '../src/main/workstreams.js';
import { bindObservedConversationKey, conversationForKey } from '../src/main/session/conversation-key.js';

/** Existing boundary fixtures explicitly claim their own lease before exercising a tool. */
export async function fixtureLock(key: string): Promise<string> {
  await bindObservedConversationKey(key, conversationForKey(key));
  const previous = workstreamForKey(key);
  if (previous) return previous.lock;
  const lease = await claimWorkstream(key, conversationForKey(key), `fixture-${key.slice(3)}`);
  if (!lease.ok) throw new Error(lease.code);
  return lease.lock;
}
