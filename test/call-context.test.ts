import { describe, expect, it } from 'vitest';
import {
  emptyEvidence,
  inFlightCallCensus,
  inFlightToolCalls,
  runningToolCalls,
  settlingToolCalls,
  trackInFlight,
  type CallContext
} from '../src/main/mcp/call-context.js';

function callFrom(conversationId: string | null, options: { tool?: string; startedAt?: number } = {}): CallContext {
  return {
    startedAt: options.startedAt ?? Date.now(),
    tool: options.tool ?? 'exec_command',
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId },
    outcome: null,
    evidence: emptyEvidence()
  };
}

/** Runs `fn` while a call attributed to `conversationId` is in flight. */
async function whileRunning(context: CallContext, fn: () => void | Promise<void>): Promise<void> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = trackInFlight(context, async () => {
    await held;
  });
  await fn();
  release();
  await call;
}

describe('local calls still running', () => {
  it('does not let one chat’s work hold another chat busy', async () => {
    // The compaction barrier waits for this to reach zero before it submits a settled brief.
    // A swarm runs every chat through this one process, so a global count meant a worker's
    // long build kept the prime's finished compaction waiting until the watch expired and
    // aborted it — blocked by work the prime has nothing to do with and cannot see.
    const worker = callFrom('conversation-b');
    await whileRunning(worker, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(runningToolCalls('conversation-b')).toBe(1);
      expect(settlingToolCalls('conversation-b')).toBe(0);
    });
    expect(inFlightToolCalls('conversation-b')).toBe(0);
  });

  it('still holds a chat busy for its own call', async () => {
    // The other half, and the reason the barrier exists: a handoff written while this chat's
    // own edit is mid-flight describes a machine that has changed by the time it is read.
    const own = callFrom('conversation-a');
    await whileRunning(own, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
    });
    expect(inFlightToolCalls('conversation-a')).toBe(0);
  });

  it('charges a call whose chat is not yet known to every chat', async () => {
    // Attribution is proven from page evidence and can still be pending. Until it lands the
    // call could belong to the chat that is asking, so it counts against all of them — the
    // same conservative answer the global count gave, kept for exactly the unproven case.
    const unknown = callFrom(null);
    await whileRunning(unknown, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(inFlightToolCalls(null)).toBe(1);
      expect(runningToolCalls('conversation-a')).toBe(1);
      expect(settlingToolCalls('conversation-a')).toBe(0);
    });
  });

  it('charges a degraded-evidence inferred call only to its inferred chat', async () => {
    // The 2026-09 connector platform sends no exact join key, so an owner can be inferred
    // from temporal/session evidence at arrival. That inference is charge-scoping only:
    // it must shrink the blast radius from "every chat" to the inferred chat, while the
    // truly ambiguous call (no exact and no inferred owner) keeps charging everyone.
    const inferred = callFrom(null);
    inferred.caller.inferredConversationId = 'conversation-b';
    inferred.caller.inferredMethod = 'temporal_unique';
    await whileRunning(inferred, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
      expect(runningToolCalls('conversation-b')).toBe(1);
      expect(inFlightToolCalls(null)).toBe(1);
    });
    expect(inFlightToolCalls('conversation-b')).toBe(0);
  });

  /**
   * The census exists because a bare count is not actionable.
   *
   * "3 local tool calls in flight" reads identically whether three agents are each two
   * seconds into a build or one call has been open since before lunch, and a steward who
   * cannot tell those apart from the refusal has no next move — which is how a direct-CDP
   * composer workaround got written instead of a bug report. The app reports the set and
   * declines to judge it: whether a long call is plausible depends on what that worker was
   * asked to do, which the driving agent knows and this process does not.
   */
  it('names the calls a refusal is about, oldest first, with their ages and attribution', async () => {
    const now = Date.now();
    const old = callFrom(null, { tool: 'exec_command', startedAt: now - 62 * 60_000 });
    const fresh = callFrom('conversation-b', { tool: 'apply_patch', startedAt: now - 1_500 });
    await whileRunning(old, async () => {
      await whileRunning(fresh, () => {
        const census = inFlightCallCensus(null);
        expect(census.map((row) => row.tool)).toEqual(['exec_command', 'apply_patch']);
        expect(census[0]?.ageMs).toBeGreaterThanOrEqual(62 * 60_000);
        expect(census[0]?.conversationId).toBeNull();
        expect(census[0]?.attribution).toBe('unattributed');
        expect(census[1]?.attribution).toBe('exact');
        expect(census[1]?.conversationId).toBe('conversation-b');
      });
    });
    expect(inFlightCallCensus(null)).toEqual([]);
  });

  it('shows an idle chat exactly the calls being charged to it', async () => {
    // The collateral-refusal case, made legible: conversation-a is doing nothing, and the
    // only reason its send is refused is a call nobody has managed to place. The census
    // must show that call to conversation-a — and must not show it the placed one, which
    // is not charged to it and is not why it is waiting.
    const unplaced = callFrom(null, { tool: 'write_stdin' });
    const other = callFrom('conversation-b', { tool: 'exec_command' });
    await whileRunning(unplaced, async () => {
      await whileRunning(other, () => {
        const census = inFlightCallCensus('conversation-a');
        expect(census).toHaveLength(1);
        expect(census[0]?.tool).toBe('write_stdin');
        expect(census[0]?.attribution).toBe('unattributed');
      });
    });
  });

  it('labels an inferred owner by the tier that placed it', async () => {
    const inferred = callFrom(null, { tool: 'exec_command' });
    inferred.caller.inferredConversationId = 'conversation-b';
    inferred.caller.inferredMethod = 'push_correlated';
    await whileRunning(inferred, () => {
      expect(inFlightCallCensus('conversation-b')).toEqual([
        expect.objectContaining({ conversationId: 'conversation-b', attribution: 'push_correlated' })
      ]);
      // Scoped, so an unrelated chat is told nothing is holding it up.
      expect(inFlightCallCensus('conversation-a')).toEqual([]);
    });
  });

  it('follows a call whose chat is identified part-way through it', async () => {
    // trackInFlight holds the context object, not a copy of the id it had at the start, so
    // the moment the caller is proven the count moves with it.
    const late = callFrom(null);
    await whileRunning(late, () => {
      expect(inFlightToolCalls('conversation-a')).toBe(1);
      late.caller.conversationId = 'conversation-b';
      expect(inFlightToolCalls('conversation-a')).toBe(0);
      expect(inFlightToolCalls('conversation-b')).toBe(1);
    });
  });
});
