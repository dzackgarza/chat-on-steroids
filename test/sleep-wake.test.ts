/**
 * The sleep/wake tab architecture, at the recorder/attribution boundary.
 *
 * Evidence base: docs/tabless-generation-experiment-2026-09-09.md — a ChatGPT tool-looping
 * turn runs entirely server-side, so a pushed conversation's tab can be discarded after
 * the push is verified and remounted only to record the finished turn. What these tests
 * hold: the config gate (off means bit-identical behavior), the push-correlated binding
 * tier and its contradiction handling, the honest exclusion of slept conversations from
 * temporal uniqueness, the quiescence/fallback wake arithmetic, the re-sleep path for a
 * remount that shows the turn still generating, and the single-driver refusals.
 *
 * Real session files in a real temp folder, exactly like session.test.ts: the wake path's
 * whole-turn reconstruction runs through the durable log a restart would read.
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
import {
  findSessionByConversation,
  initSessionStore,
  readEvents,
  resetSessionStoreForTests
} from '../src/main/session/store.js';
import {
  resetSessionBindingsForTests,
  sessionBinding,
  sessionBindingConflicted
} from '../src/main/session/connector-session.js';
import {
  isSleptWithBoundKey,
  notePushTyped,
  quietRemainingMs,
  resetSleepWakeForTests,
  restoreSleepWake,
  sendRefusalFor,
  setSleepWakeDriver,
  sleepWakeStatus,
  type SleepWakeEvent
} from '../src/main/session/sleep-wake.js';
import { flushDurable, initDurableStore, resetDurableForTests } from '../src/main/durable.js';
import { makeTempDir, removeTempDir } from './helpers.js';
import type { SleepWakeSettings } from '../src/shared/types.js';

let dir: string;

/** Tabs the fake driver was asked to discard / remount, in order. */
const closedTabs: string[] = [];
const openedTabs: string[] = [];

async function configure(sleepWake?: Partial<SleepWakeSettings>): Promise<void> {
  const base = defaultConfig();
  await saveConfig({
    ...base,
    sessions: { ...base.sessions, record: true },
    sleepWake: { ...DEFAULT_SLEEP_WAKE, ...sleepWake }
  });
}

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

function eventKinds(): string[] {
  return events().map((event) => event.kind);
}

let turnSerial = 0;

/** Starts a page-observed generation in a chat, the way the extension reports one. */
async function startTurn(conversationId: string, turnId = `g-${conversationId}-${++turnSerial}`): Promise<string> {
  await recordChatObservations(conversationId, [{ kind: 'turn_start', time: Date.now(), turnId }]);
  return turnId;
}

async function endTurn(conversationId: string, turnId: string): Promise<void> {
  await recordChatObservations(conversationId, [{ kind: 'turn_end', time: Date.now(), turnId, outcome: 'completed' }]);
}

/**
 * The full push half: the bridge reports the send typed, and the recorder then observes
 * the fresh turn_start that verifies it — which opens the push-correlation window and
 * (when enabled) begins the sleep sequence.
 */
async function verifiedPush(conversationId: string): Promise<string> {
  notePushTyped(conversationId, Date.now(), 90_000);
  return startTurn(conversationId);
}

/** Verified push, grace elapsed, tab discarded, extension reported the tab gone. */
async function sleptConversation(conversationId: string, options: { bindKey?: string } = {}): Promise<string> {
  const turnId = await verifiedPush(conversationId);
  if (options.bindKey) {
    const claim = inferDegradedCaller(options.bindKey);
    expect(claim).toEqual({ conversationId, method: 'push_correlated' });
  }
  await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs + 50);
  expect(closedTabs).toContain(conversationId);
  // The extension observes the tab closing and reports it, exactly as for any closed tab.
  await closeConversation(conversationId);
  expect(sleepWakeStatus().conversations.find((c) => c.conversationId === conversationId)?.state).toBe('slept');
  return turnId;
}

beforeAll(async () => {
  dir = await makeTempDir('clf-sleep-wake-');
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
  await configure({ enabled: true });
});

// The suite runs with fake timers by default (the architecture is made of timers); the
// afterEach restores real ones so the store's own async work is unaffected elsewhere.
afterEach(() => {
  vi.useRealTimers();
});

// ------------------------------------------------------------------ config gate

describe('the config gate', () => {
  it('changes nothing while sleepWake is disabled', async () => {
    await configure({ enabled: false });
    const chat = 'conv-gate-off';
    notePushTyped(chat, Date.now(), 90_000);
    await startTurn(chat);
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs * 4);

    // No sleep state, no tab touched, no refusal, no push window.
    expect(closedTabs).toEqual([]);
    expect(sleepWakeStatus().conversations).toEqual([]);
    expect(sendRefusalFor(chat)).toBeNull();
    // A first-seen key at this moment binds by the pre-existing temporal tier, not by any
    // push window: the chat is the sole generator, so the label must be temporal_unique.
    expect(inferDegradedCaller('key-gate-off')).toEqual({ conversationId: chat, method: 'temporal_unique' });
  });
});

// ------------------------------------------------------------------ push_correlated tier

describe('push-correlated session binding', () => {
  it('binds the first key after a verified push with zero temporal evidence, out-ranking the temporal tiers', async () => {
    // Two other chats are mid-turn, so no moment is temporally unique and the pre-existing
    // tiers can attribute nothing at all.
    await startTurn('conv-decoy-a');
    await startTurn('conv-decoy-b');
    const chat = 'conv-pushed';
    await verifiedPush(chat);
    expect(soleGeneratingConversation()).toBeNull();

    const placed = inferDegradedCaller('key-pushed');
    expect(placed).toEqual({ conversationId: chat, method: 'push_correlated' });
    // The binding sticks for the rest of the call stream, under the same honest label.
    expect(inferDegradedCaller('key-pushed')).toEqual({ conversationId: chat, method: 'push_correlated' });
    expect(sessionBinding('key-pushed')).toBe(chat);
  });

  it('labels the binding push_correlated even when the pushed chat is also the sole generator', async () => {
    const chat = 'conv-pushed-sole';
    await verifiedPush(chat);
    expect(soleGeneratingConversation()).toBe(chat);
    // Both tiers agree on the owner; the label must credit the stronger evidence.
    expect(inferDegradedCaller('key-sole')).toEqual({ conversationId: chat, method: 'push_correlated' });
  });

  it('claims only the first key: the window is consumed', async () => {
    await startTurn('conv-decoy-c');
    await startTurn('conv-decoy-d');
    const chat = 'conv-one-claim';
    await verifiedPush(chat);
    expect(inferDegradedCaller('key-first')?.method).toBe('push_correlated');
    // A second unknown key gets nothing: the window went with the first claim, and with
    // three chats generating there is no temporal evidence either.
    expect(inferDegradedCaller('key-second')).toBeNull();
  });

  it('expires the window after correlationWindowMs', async () => {
    const chat = 'conv-window-expired';
    const turnId = await verifiedPush(chat);
    await endTurn(chat, turnId); // also cancels the pending sleep
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.correlationWindowMs + 1_000);
    expect(inferDegradedCaller('key-late')).toBeNull();
    expect(sessionBinding('key-late')).toBeNull();
  });

  it('condemns a key whose first sight is claimed by the window and a different sole generator', async () => {
    const chat = 'conv-contradicted-push';
    const turnId = await verifiedPush(chat);
    // The pushed chat's turn ends (cancelling the pending sleep), and a different chat
    // becomes the sole visible generator while the window is still open.
    await endTurn(chat, turnId);
    await startTurn('conv-other-sole');

    // First sight of the key: the push window says conv-contradicted-push, temporal
    // uniqueness says conv-other-sole. Neither may win, and the kill is sticky.
    expect(inferDegradedCaller('key-torn')).toBeNull();
    expect(sessionBindingConflicted('key-torn')).toBe(true);
    // Even at a later clean unique moment the key stays dead.
    expect(inferDegradedCaller('key-torn')).toBeNull();
  });

  it('sticky-kills a push-correlated binding contradicted by later temporal evidence', async () => {
    const chat = 'conv-killed-later';
    const turnId = await verifiedPush(chat);
    expect(inferDegradedCaller('key-doomed')?.method).toBe('push_correlated');
    // The pushed chat finishes (its sleep is cancelled with it), then its key shows up
    // while a different chat is provably the only one generating: contradiction.
    await endTurn(chat, turnId);
    await startTurn('conv-usurper');
    expect(soleGeneratingConversation()).toBe('conv-usurper');

    expect(inferDegradedCaller('key-doomed')).toBeNull();
    expect(sessionBindingConflicted('key-doomed')).toBe(true);
    expect(sessionBinding('key-doomed')).toBeNull();
  });
});

// ------------------------------------------------------------------ sleep on verified send

describe('sleep on a verified send', () => {
  it('discards the tab after the grace period and records the sleep', async () => {
    const chat = 'conv-sleeps';
    await verifiedPush(chat);
    expect(closedTabs).toEqual([]); // grace period: the tab is still alive
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs + 50);

    expect(closedTabs).toEqual([chat]);
    const status = sleepWakeStatus();
    const entry = status.conversations.find((c) => c.conversationId === chat);
    expect(entry?.state).toBe('slept');
    expect(entry?.sleptAt).toBeTypeOf('number');
    expect(eventKinds()).toContain('slept');
  });

  it('cancels the sleep when the turn ends inside the grace period', async () => {
    const chat = 'conv-too-quick';
    const turnId = await verifiedPush(chat);
    await endTurn(chat, turnId);
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs * 4);

    expect(closedTabs).toEqual([]);
    expect(sleepWakeStatus().conversations).toEqual([]);
    expect(eventKinds()).toContain('sleep_cancelled');
  });

  it('aborts loudly instead of sleeping when no tab driver is wired', async () => {
    setSleepWakeDriver(null);
    const chat = 'conv-no-driver';
    await verifiedPush(chat);
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs + 50);

    expect(sleepWakeStatus().conversations).toEqual([]);
    expect(eventKinds()).toContain('sleep_failed');
    expect(sendRefusalFor(chat)).toBeNull();
  });
});

// ------------------------------------------------------------------ temporal honesty

describe('slept conversations and temporal uniqueness', () => {
  it('excludes a slept conversation with a bound key from exactly-one-generating', async () => {
    const chat = 'conv-slept-excluded';
    await sleptConversation(chat, { bindKey: 'key-excluded' });

    // Another chat starts generating. Without the sleep-state exclusion, the discarded
    // generating tab would fail the uniqueness claim closed for the entire fleet.
    await startTurn('conv-watched-later');
    expect(soleGeneratingConversation()).toBe('conv-watched-later');
    expect(inferDegradedCaller(null)).toEqual({ conversationId: 'conv-watched-later', method: 'temporal_unique' });
  });

  it('keeps failing closed for a slept conversation with no bound key', async () => {
    const chat = 'conv-slept-keyless';
    await sleptConversation(chat);
    expect(isSleptWithBoundKey(chat)).toBe(false);

    // The slept chat's calls are indistinguishable from anyone else's, so no moment is
    // provably unique while it may still be generating.
    await startTurn('conv-watched-anyway');
    expect(soleGeneratingConversation()).toBeNull();
    expect(inferDegradedCaller(null)).toBeNull();
  });

  it("attributes the slept chat's own calls by its key without contradiction-killing the binding", async () => {
    const chat = 'conv-slept-calls';
    await sleptConversation(chat, { bindKey: 'key-alive' });
    await startTurn('conv-visible-sole');
    expect(soleGeneratingConversation()).toBe('conv-visible-sole');

    // The slept chat's server turn keeps calling with its bound key while a different chat
    // is the sole *visible* generator. The call belongs to the slept chat; treating the
    // visible moment as temporal evidence about this key would assume its own conclusion.
    expect(inferDegradedCaller('key-alive')).toEqual({ conversationId: chat, method: 'push_correlated' });
    expect(sessionBinding('key-alive')).toBe(chat);
    expect(sessionBindingConflicted('key-alive')).toBe(false);
  });
});

// ------------------------------------------------------------------ wake detector

describe('the wake detector', () => {
  it('computes quiet time from the last call, not from the sleep', () => {
    expect(quietRemainingMs(null, 1_000, 240_000, 1_000)).toBe(240_000);
    expect(quietRemainingMs(null, 1_000, 240_000, 241_000)).toBe(0);
    expect(quietRemainingMs(200_000, 1_000, 240_000, 241_000)).toBe(199_000);
    expect(quietRemainingMs(200_000, 1_000, 240_000, 500_000)).toBe(0);
  });

  it('wakes on quiescence and completes through the recovered final message', async () => {
    const chat = 'conv-wake-cycle';
    const turnId = await sleptConversation(chat, { bindKey: 'key-cycle' });

    // Mid-turn call traffic keeps deferring the wake: 3 minutes of quiet, a call, and the
    // 4-minute check finds the quiet clock reset.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(inferDegradedCaller('key-cycle')?.conversationId).toBe(chat);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(openedTabs).toEqual([]);

    // Then the stream goes quiet past the threshold (the final text phase is call-silent).
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 2_000);
    expect(openedTabs).toEqual([chat]);
    const started = events().find((event) => event.kind === 'wake_started');
    expect(started).toMatchObject({ cause: 'quiescence', conversationId: chat });
    expect(sendRefusalFor(chat)?.reason).toBe('waking');

    // The remounted page discovers the finished answer cold — a turn this app never saw
    // stream. The reload-recovery path closes the slept turn as completed, which is the
    // proof that the wake found a finished worker.
    await recordChatObservations(chat, [
      {
        kind: 'assistant_message',
        time: Date.now(),
        turnId,
        messageId: 'm-wake-final',
        text: 'The finished answer, discovered on remount.',
        final: true
      }
    ]);
    const session = await findSessionByConversation(chat);
    const ends = (await readEvents(session!.id, { kinds: ['turn_end'] })).filter((event) => event.kind === 'turn_end');
    expect(ends.map((event) => event.outcome)).toEqual(['observer_lost', 'completed']);

    const ready = events().find((event) => event.kind === 'woke_ready');
    expect(ready).toMatchObject({ conversationId: chat, turnId, outcome: 'completed', cause: 'quiescence' });
    // The cycle is closed: the conversation accepts the next push.
    expect(sleepWakeStatus().conversations).toEqual([]);
    expect(sendRefusalFor(chat)).toBeNull();
  });

  it('re-sleeps when the remount shows the turn still generating', async () => {
    const chat = 'conv-not-done';
    await sleptConversation(chat, { bindKey: 'key-not-done' });
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 2_000);
    expect(openedTabs).toEqual([chat]);

    // Quiet was not done: the remounted page reports a live generation.
    await startTurn(chat, 'g-conv-not-done-remount');
    expect(eventKinds()).toContain('resleep_still_generating');
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.graceMs + 50);
    expect(closedTabs).toEqual([chat, chat]);
    await closeConversation(chat);
    expect(sleepWakeStatus().conversations.find((c) => c.conversationId === chat)?.state).toBe('slept');
    // And the monitor is still armed: another quiet period wakes it again.
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 2_000);
    expect(openedTabs).toEqual([chat, chat]);
  });

  it('wakes a keyless slept conversation on the fallback timer, and says so', async () => {
    const chat = 'conv-keyless-fallback';
    await sleptConversation(chat);

    // The quiescence threshold passing means nothing here: with no bound key the call
    // stream is unobservable, so nothing fires at quietMs.
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 5_000);
    expect(openedTabs).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.fallbackWakeMs - DEFAULT_SLEEP_WAKE.quietMs);
    expect(openedTabs).toEqual([chat]);
    const started = events().find((event) => event.kind === 'wake_started');
    expect(started).toMatchObject({ cause: 'fallback_timer', conversationId: chat });
    expect((started as { detail?: string }).detail).toContain('no session key');
  });

  it('drops the sleep state honestly when a remount produces no turn evidence', async () => {
    const chat = 'conv-unconfirmed';
    await sleptConversation(chat, { bindKey: 'key-unconfirmed' });
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 2_000);
    expect(openedTabs).toEqual([chat]);

    // Nothing arrives from the page inside the settle window.
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(eventKinds()).toContain('woke_unconfirmed');
    expect(sleepWakeStatus().conversations).toEqual([]);
    expect(sendRefusalFor(chat)).toBeNull();
  });

  it('releases the sleep state when somebody else reopens the slept chat', async () => {
    const chat = 'conv-user-reopened';
    await sleptConversation(chat, { bindKey: 'key-reopened' });

    // A tab this app did not open starts observing the chat mid-sleep. That tab is not
    // ours to close; the conversation goes back to ordinary live observation.
    await startTurn(chat, 'g-user-reopened');
    const released = events().find((event) => event.kind === 'woke_unconfirmed');
    expect((released as { detail?: string })?.detail).toContain('a tab this app did not open');
    expect(sleepWakeStatus().conversations).toEqual([]);
  });
});

// ------------------------------------------------------------------ single driver

describe('the single-driver invariant', () => {
  it('refuses pushes while slept, with a concrete next-check hint', async () => {
    const chat = 'conv-refuse-sleeping';
    await sleptConversation(chat, { bindKey: 'key-refuse' });
    const refusal = sendRefusalFor(chat);
    expect(refusal?.reason).toBe('sleeping');
    expect(refusal!.nextCheckHintMs).toBeGreaterThan(0);
    expect(refusal!.nextCheckHintMs).toBeLessThanOrEqual(DEFAULT_SLEEP_WAKE.quietMs);
  });

  it('refuses pushes while waking', async () => {
    const chat = 'conv-refuse-waking';
    await sleptConversation(chat, { bindKey: 'key-refuse-waking' });
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.quietMs + 2_000);
    expect(sendRefusalFor(chat)?.reason).toBe('waking');
  });

  it('does not refuse a conversation it is not managing', () => {
    expect(sendRefusalFor('conv-total-stranger')).toBeNull();
  });
});

// ------------------------------------------------------------------ restart

describe('a restart mid-sleep', () => {
  it('restores slept conversations keyless, on the fallback timer, and says why', async () => {
    const chat = 'conv-restored';
    await sleptConversation(chat, { bindKey: 'key-lost-in-restart' });
    await flushDurable();

    // The daemon restarts: in-memory sleep state and key bindings are gone by design.
    resetSleepWakeForTests();
    resetSessionBindingsForTests();
    wireDriver();
    openedTabs.length = 0;
    await restoreSleepWake();

    const entry = sleepWakeStatus().conversations.find((c) => c.conversationId === chat);
    expect(entry?.state).toBe('slept');
    expect(entry?.sessionKeyBound).toBe(false);
    const restored = events().find((event) => event.kind === 'restored');
    expect((restored as { detail?: string })?.detail).toContain('do not survive restarts');
    // Keyless means the fallback timer carries the wake.
    await vi.advanceTimersByTimeAsync(DEFAULT_SLEEP_WAKE.fallbackWakeMs + 2_000);
    expect(openedTabs).toEqual([chat]);
  });
});
