/**
 * Who an unplaced tool call is allowed to hold busy.
 *
 * The 2026-09 connector platform sends no request id, so a large minority of MCP calls
 * arrive with no exact owner and only sometimes acquire an inferred one. Such a call used
 * to be charged against *every* conversation, and the page refuses to type into a chat
 * while any call is charged to it. At fleet width that is not caution, it is a deadlock:
 * with several workers tool-looping there is always at least one unplaced call in flight,
 * so `POST /send` into *any* chat — including a chat that has been idle for an hour —
 * ends `gave up polling in state 'queued'`, and the only way to tell a worker to stop is
 * to type into its chat. Measured live 2026-09-10 08:47–09:03: four managed repositories,
 * no file written for ten minutes, no commit for twenty, no chat reachable, and the gate
 * clearing only when the workers it was waiting on happened to finish by themselves.
 *
 * The narrowing this file pins down rests on one fact about the platform, not on a timer:
 * ChatGPT issues connector tool calls only from inside a turn. A conversation the app
 * *observed* to be quiescent at the moment the call arrived cannot be its origin, so
 * charging it is a false positive — and it is precisely the false positive that closes the
 * control path. Everything the app has not observed to be quiescent is still charged.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  closeConversation,
  mayOwnUnattributedCall,
  recordChatObservations,
  resetRecorderForTests
} from '../src/main/session/recorder.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import { resetSessionBindingsForTests } from '../src/main/session/connector-session.js';
import { resetSleepWakeForTests } from '../src/main/session/sleep-wake.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import {
  emptyEvidence,
  inFlightCallCensus,
  runningToolCalls,
  trackInFlight,
  type CallContext
} from '../src/main/mcp/call-context.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
let turnSerial = 0;

/** An MCP call no attribution tier could place, as it arrives from the headerless platform. */
function unplacedCall(startedAt: number, tool = 'exec_command'): CallContext {
  return {
    startedAt,
    tool,
    transportKey: null,
    agent: null,
    caller: { transportKey: null, requestId: null, conversationId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
}

/** Runs `fn` while `context` is in flight, exactly as the dispatcher holds one. */
async function whileRunning(context: CallContext, fn: () => void | Promise<void>): Promise<void> {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = trackInFlight(context, async () => {
    await held;
  });
  try {
    await fn();
  } finally {
    // A failed assertion must not leave the call in flight; the set is module-global, and
    // one leaked call turns a single real failure into a whole file of false ones.
    release();
    await call;
  }
}

async function startTurn(conversationId: string): Promise<string> {
  const turnId = `g-${conversationId}-${++turnSerial}`;
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: Date.now(), turnId }]);
  return turnId;
}

async function endTurn(conversationId: string, turnId: string): Promise<void> {
  await recordChatObservations(conversationId, [
    { kind: 'turn_end', time: Date.now(), turnId, outcome: 'completed' }
  ]);
}

/** A chat that answered once and has been sitting idle since — the steward's push target. */
async function idleChat(conversationId: string): Promise<void> {
  const turnId = await startTurn(conversationId);
  await endTurn(conversationId, turnId);
}

/** What the page is told, and therefore whether it will type: /activity's `pendingTools`. */
function pendingTools(conversationId: string): number {
  return runningToolCalls(conversationId, mayOwnUnattributedCall);
}

beforeAll(async () => {
  dir = await makeTempDir('clf-charge-scope-');
  initConfigPath(dir);
  initSessionStore(dir);
  initDurableStore(dir);
});

afterAll(async () => {
  resetSessionStoreForTests();
  resetDurableForTests();
  await removeTempDir(dir);
});

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorderForTests();
  resetSessionStoreForTests();
  resetSessionBindingsForTests();
  resetSleepWakeForTests();
  initSessionStore(dir);
  const base = defaultConfig();
  await saveConfig({ ...base, sessions: { ...base.sessions, record: true } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an unplaced call and the chats it holds busy', () => {
  it('does not hold an observably quiescent chat busy', async () => {
    // The measured deadlock, from both ends. Two workers are mid-turn, so nothing is
    // temporally unique and their calls never acquire an owner. The steward's target chat
    // finished its turn before any of that started.
    await idleChat('conv-idle');
    await startTurn('conv-worker-a');
    await startTurn('conv-worker-b');
    await vi.advanceTimersByTimeAsync(60_000);

    await whileRunning(unplacedCall(Date.now()), () => {
      // The chat being pushed was not generating when this call arrived, so it cannot be
      // the caller. Zero here is the composer opening; anything above zero is the send
      // queueing until its deadline for a reason that has nothing to do with this chat.
      expect(pendingTools('conv-idle')).toBe(0);
      // And the conservative half is untouched: either worker may well have made the call.
      expect(pendingTools('conv-worker-a')).toBe(1);
      expect(pendingTools('conv-worker-b')).toBe(1);
      // Fleet-wide accounting still sees every call. The scoping is about who waits.
      expect(runningToolCalls(null, mayOwnUnattributedCall)).toBe(1);
      // And the behaviour this replaces, which is still what the counter does when no
      // evidence is supplied: the same call holds the idle chat busy too. That is the
      // state the whole fleet sat in — every chat charged for one worker's `exec_command`,
      // and no way to reach any of them to make it stop.
      expect(runningToolCalls('conv-idle')).toBe(1);
    });
  });

  it('keeps holding the chat that was generating when the call arrived, after its turn ends', async () => {
    // The ChatGPT-native compaction barrier depends on this. Interrupting the turn does not
    // stop an `exec_command` already running inside this process, so a handoff written the
    // moment the turn closed would describe a machine that is still being edited. The call
    // arrived while this chat was generating; the turn ending afterwards changes nothing
    // about who could have made it.
    const turnId = await startTurn('conv-compacting');
    await vi.advanceTimersByTimeAsync(5_000);
    const call = unplacedCall(Date.now());

    await whileRunning(call, async () => {
      expect(pendingTools('conv-compacting')).toBe(1);
      await endTurn('conv-compacting', turnId);
      expect(pendingTools('conv-compacting')).toBe(1);
      // A turn started after this call was already running is likewise still charged: the
      // chat is generating now, and the call has not gone anywhere.
      await vi.advanceTimersByTimeAsync(1_000);
      const next = await startTurn('conv-compacting');
      expect(pendingTools('conv-compacting')).toBe(1);
      await endTurn('conv-compacting', next);
    });
    expect(pendingTools('conv-compacting')).toBe(0);
  });

  it('charges a chat this app has no lifecycle evidence about', async () => {
    // No evidence is not evidence of quiescence. A conversation the recorder has never
    // seen, and one it has seen but never watched a turn finish in, both keep the original
    // charge-everyone answer.
    await startTurn('conv-never-finished');
    await vi.advanceTimersByTimeAsync(1_000);
    await whileRunning(unplacedCall(Date.now()), () => {
      expect(pendingTools('conv-unknown-to-this-app')).toBe(1);
      expect(pendingTools('conv-never-finished')).toBe(1);
    });
  });

  it('charges a chat whose turn was closed without anyone watching it end', async () => {
    // `observer_lost` and a tab that detached mid-turn are the two unobserved closures. The
    // page stopped watching; ChatGPT did not stop generating. Inside the uncertainty ceiling
    // the conversation is still a plausible caller, which is the same fail-closed rule
    // `soleGeneratingConversation()` applies to the same two states.
    await idleChat('conv-detached');
    await startTurn('conv-detached');
    await vi.advanceTimersByTimeAsync(1_000);
    await closeConversation('conv-detached');

    await whileRunning(unplacedCall(Date.now()), () => {
      expect(pendingTools('conv-detached')).toBe(1);
    });
  });

  it('shows an idle chat that nothing is holding it up, and a worker exactly what is', async () => {
    // The census is what a steward reads off a refusal, so it has to agree with the count
    // it explains. An idle chat that is refused for some *other* reason must not be handed
    // somebody else's call as the explanation.
    await idleChat('conv-idle');
    await startTurn('conv-worker');
    await vi.advanceTimersByTimeAsync(30_000);

    await whileRunning(unplacedCall(Date.now(), 'write_stdin'), () => {
      expect(inFlightCallCensus('conv-idle', 20, mayOwnUnattributedCall)).toEqual([]);
      expect(inFlightCallCensus('conv-worker', 20, mayOwnUnattributedCall)).toEqual([
        expect.objectContaining({ tool: 'write_stdin', attribution: 'unattributed', conversationId: null })
      ]);
    });
  });

  it('leaves an exactly attributed call charged to its own chat and nothing else', async () => {
    // The scope only ever narrows the unplaced case. A proven owner is still the owner,
    // whatever the target chat's lifecycle looks like.
    await idleChat('conv-idle');
    const owned = unplacedCall(Date.now());
    owned.caller.conversationId = 'conv-owner';
    await whileRunning(owned, () => {
      expect(pendingTools('conv-owner')).toBe(1);
      expect(pendingTools('conv-idle')).toBe(0);
    });
  });
});
