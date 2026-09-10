/**
 * What the push-correlated window is allowed to claim, and how long a slept conversation
 * may stay unreachable.
 *
 * Both hold the same line from opposite ends. `sleep-wake.test.ts` covers the tier as
 * designed; this file covers the two ways it was measured failing on a live fleet
 * (2026-09-10), where a chat that had been pushed once could not be reached again at all:
 *
 * - The window bound the first key it saw with *no* evidence the key was new. Under load
 *   almost no key is ever bound — `temporal_unique` needs exactly one visible generator and
 *   there rarely is one — so an unbound key is normally a key that has been calling for
 *   twenty minutes, and the window claimed it. A long-running worker's whole call stream
 *   was consequently recorded into, and charged to, a freshly pushed chat that had never
 *   made a call.
 * - The wake detector reads quiescence off the bound key, so that mis-bound stream reset
 *   the quiet clock forever. The chat's next-check hint was observed walking down to ~1s
 *   and jumping back to ~227s, twice, while `POST /send` refused every push. Nothing in the
 *   module bounded that: with a key bound, the fallback timer was not armed at all.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SLEEP_WAKE, defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import {
  closeConversation,
  inferDegradedCaller,
  recordChatObservations,
  resetRecorderForTests,
  soleGeneratingConversation
} from '../src/main/session/recorder.js';
import { initSessionStore, resetSessionStoreForTests } from '../src/main/session/store.js';
import {
  noteSessionKeySeen,
  resetSessionBindingsForTests,
  sessionBinding,
  sessionKeyFirstSeenAt
} from '../src/main/session/connector-session.js';
import {
  notePushTyped,
  resetSleepWakeForTests,
  sendRefusalFor,
  setSleepWakeDriver,
  sleepWakeStatus,
  wakeDelayMs,
  type SleepWakeEvent
} from '../src/main/session/sleep-wake.js';
import { initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;
const closedTabs: string[] = [];
const openedTabs: string[] = [];
let turnSerial = 0;

function wireDriver(): void {
  setSleepWakeDriver({
    openConversationTab: async (conversationId) => {
      openedTabs.push(conversationId);
    },
    closeConversationTab: async (conversationId) => {
      closedTabs.push(conversationId);
    }
  });
}

function events(): SleepWakeEvent[] {
  return sleepWakeStatus().events;
}

async function startTurn(conversationId: string, turnId = `g-${conversationId}-${++turnSerial}`): Promise<string> {
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: Date.now(), turnId }]);
  return turnId;
}

/** The bridge reports the send typed; the recorder then sees the turn_start verifying it. */
async function verifiedPush(conversationId: string): Promise<string> {
  notePushTyped(conversationId, Date.now(), 90_000);
  return startTurn(conversationId);
}

beforeAll(async () => {
  dir = await makeTempDir('clf-sleep-wake-binding-');
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
  closedTabs.length = 0;
  openedTabs.length = 0;
  wireDriver();
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: true },
    sleepWake: { ...DEFAULT_SLEEP_WAKE, enabled: true }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------- what the window may claim

describe('the push-correlated window and pre-existing keys', () => {
  it('refuses to claim a key whose calls began before the push', async () => {
    // The measured failure. Two workers are mid-turn, so nothing is temporally unique and
    // the busy worker's key never binds — it just keeps arriving, unplaced, for minutes.
    await startTurn('conv-worker-busy');
    await startTurn('conv-worker-other');
    expect(inferDegradedCaller('key-long-running')).toBeNull();
    expect(sessionBinding('key-long-running')).toBeNull();
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    // Now a third chat is pushed, and the worker's next call lands inside the window.
    const pushed = 'conv-just-pushed';
    await verifiedPush(pushed);
    expect(soleGeneratingConversation()).toBeNull();

    // It is not this chat's call: this chat's turn started seconds ago and that key's
    // stream started twenty minutes ago. Claiming it recorded a worker's whole call
    // stream into the wrong chat and then held that chat asleep on the wrong clock.
    expect(inferDegradedCaller('key-long-running')).toBeNull();
    expect(sessionBinding('key-long-running')).toBeNull();
  });

  it('still claims a key whose first call arrives inside the window', async () => {
    // The tier's actual job, unchanged: the pushed turn's own first call has no history,
    // and binding it is what makes a slept conversation attributable at all.
    await startTurn('conv-decoy-one');
    await startTurn('conv-decoy-two');
    const pushed = 'conv-fresh-key';
    await verifiedPush(pushed);

    expect(inferDegradedCaller('key-born-here')).toEqual({
      conversationId: pushed,
      method: 'push_correlated'
    });
    expect(sessionBinding('key-born-here')).toBe(pushed);
  });

  it('leaves the window open when a pre-existing key passes through it', async () => {
    // A stranger's call says nothing about whether the pushed turn's own first call is
    // still coming, so it must not consume the one window that call is waiting for.
    await startTurn('conv-noise-a');
    await startTurn('conv-noise-b');
    expect(inferDegradedCaller('key-stranger')).toBeNull();
    await vi.advanceTimersByTimeAsync(90_000);

    const pushed = 'conv-window-survives';
    await verifiedPush(pushed);
    expect(inferDegradedCaller('key-stranger')).toBeNull();
    expect(inferDegradedCaller('key-mine')).toEqual({ conversationId: pushed, method: 'push_correlated' });
  });

  it('remembers first sight for keys no tier ever managed to bind', () => {
    // The distinction the registry could not make before: unbound is not the same as unseen.
    const at = noteSessionKeySeen('key-seen-never-bound');
    expect(sessionKeyFirstSeenAt('key-seen-never-bound')).toBe(at);
    expect(sessionBinding('key-seen-never-bound')).toBeNull();
    expect(noteSessionKeySeen('key-seen-never-bound')).toBe(at);
    expect(sessionKeyFirstSeenAt('key-never-presented')).toBeNull();
  });
});

// ------------------------------------------------- how long a chat may stay unreachable

describe('the ceiling on a slept conversation', () => {
  it('prefers quiescence while the quiet clock can actually be reached', () => {
    const slept = 1_000_000;
    const { quietMs, fallbackWakeMs } = DEFAULT_SLEEP_WAKE;
    expect(wakeDelayMs(null, slept, quietMs, fallbackWakeMs, slept)).toEqual({
      delayMs: quietMs,
      cause: 'quiescence'
    });
    // A call one minute in defers the wake by a minute, and quiescence still wins.
    expect(wakeDelayMs(slept + 60_000, slept, quietMs, fallbackWakeMs, slept + 60_000)).toEqual({
      delayMs: quietMs,
      cause: 'quiescence'
    });
  });

  it('caps a quiet clock that keeps being reset at the fallback horizon', () => {
    const slept = 1_000_000;
    const { quietMs, fallbackWakeMs } = DEFAULT_SLEEP_WAKE;
    // Twelve minutes in, still being fed: quiescence is four minutes away, the horizon is
    // three. The horizon wins, and says so — this is the arithmetic that stops a foreign
    // call stream from owning a conversation for the life of the process.
    const now = slept + 12 * 60_000;
    expect(wakeDelayMs(now, slept, quietMs, fallbackWakeMs, now)).toEqual({
      delayMs: fallbackWakeMs - 12 * 60_000,
      cause: 'fallback_timer'
    });
    // Past the horizon it is due immediately.
    const late = slept + fallbackWakeMs + 30_000;
    expect(wakeDelayMs(late, slept, quietMs, fallbackWakeMs, late)).toEqual({
      delayMs: 0,
      cause: 'fallback_timer'
    });
  });

  it('wakes a conversation whose bound key never goes quiet, instead of refusing forever', async () => {
    const chat = 'conv-held-hostage';
    await verifiedPush(chat);
    expect(inferDegradedCaller('key-hostage')).toEqual({ conversationId: chat, method: 'push_correlated' });
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs + 50);
    await closeConversation(chat);
    expect(sleepWakeStatus().conversations.find((c) => c.conversationId === chat)?.state).toBe('slept');

    // A call every three minutes — under the four-minute quiet threshold — so the quiet
    // clock is reset before it can ever expire. This is the live shape: an idle chat whose
    // bound key belongs to a worker that is still going.
    for (let minute = 3; minute < DEFAULT_SLEEP_WAKE.fallbackWakeMs / 60_000; minute += 3) {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(openedTabs).toEqual([]);
      expect(sendRefusalFor(chat)?.reason).toBe('sleeping');
      expect(inferDegradedCaller('key-hostage')?.conversationId).toBe(chat);
    }

    // The horizon arrives and the tab is looked at anyway. Nothing is pushed and nothing is
    // interrupted: a remount that finds the turn still generating re-sleeps.
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.fallbackWakeMs);
    expect(openedTabs).toEqual([chat]);
    expect(events().find((event) => event.kind === 'wake_started')).toMatchObject({
      conversationId: chat,
      cause: 'fallback_timer'
    });
  });
});
