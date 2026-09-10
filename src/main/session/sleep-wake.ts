/**
 * Sleep/wake tab architecture for pushed conversations.
 *
 * Evidence base: docs/tabless-generation-experiment-2026-09-09.md. A ChatGPT MCP
 * tool-looping turn runs entirely at OpenAI — a turn kept producing calls for eleven
 * minutes after its tab was destroyed, *faster* than with the tab attached — so the tab is
 * needed only at turn boundaries: verify the push landed, record the finished turn, push
 * the next message. Between boundaries the tab is pure RAM cost, and page evidence from a
 * closed tab is actively false rather than merely absent.
 *
 * What this module owns, all behind `sleepWake.enabled` (default off — when off every
 * entry point is inert and app behavior is bit-identical):
 *
 * - **Sleep on verified send.** The bridge reports each committed local send; when the
 *   recorder then observes the fresh `turn_start` that verifies it, the conversation's tab
 *   is discarded after a short grace period (Target.closeTarget via the wired driver).
 * - **The push-correlated window.** The app knows which conversation it just pushed and
 *   pushes are serialized, so the session key whose calls begin inside a bounded window
 *   after the verification binds to that conversation (`push_correlated`, the strongest
 *   degraded tier — see connector-session.ts). This is the attribution path for slept
 *   fleets: it needs zero page evidence.
 * - **The wake detector.** A slept conversation with a bound key is woken when its call
 *   stream has been quiet past the threshold: the tab is remounted, the recorder captures
 *   the finished turn cold (the reload-recovery path), and a typed event says the worker
 *   is ready for its next push. Quiescence alone is never treated as completion — the
 *   final text-writing phase is call-silent — so a remount that shows the turn still
 *   generating re-sleeps and keeps monitoring. A slept conversation with NO bound key
 *   cannot observe quiescence and wakes on a slower fallback timer, and its events say so.
 * - **The single-driver invariant.** While a conversation is slept or waking, the send
 *   path refuses external pushes with a typed reason and a next-check hint instead of
 *   racing the wake (two drivers collided during the experiment).
 * - **Out-of-band sends.** A message typed into a managed conversation by something other
 *   than the app (see send-origin.ts) cancels that conversation's sleep at error level and
 *   closes any open correlation window: the app cannot know what was sent, so neither the
 *   sleep state machine nor a `push_correlated` binding may keep claiming otherwise.
 * - **Honest interplay with page evidence.** A slept conversation with a bound key is
 *   excluded from temporal-uniqueness computations (recorder.ts asks
 *   `isSleptWithBoundKey`): its server turn is real but its calls carry its own key, so it
 *   does not poison "exactly one generating" for the rest of the fleet. Slept *without* a
 *   key stays fail-closed — that chat's calls are indistinguishable and no moment is
 *   provably unique while it may be generating.
 *
 * Layering: this module imports config and connector-session only. The recorder and the
 * bridge call in; the tab driver (open/close over CDP) is injected by the entrypoint that
 * has one (headless.ts). No driver wired means sleeping fails loudly and the conversation
 * simply stays awake.
 */

import { getConfig, DEFAULT_SLEEP_WAKE } from '../config.js';
import type { SleepWakeSettings } from '../../shared/types.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logError, logInfo, logWarn } from '../logger.js';
import {
  boundKeyForConversation,
  condemnSessionKey,
  learnPushCorrelatedBinding,
  sessionBindingDetail
} from './connector-session.js';

export interface SleepWakeDriver {
  /** Remounts the conversation's chat page (PUT /json/new on the CDP endpoint, or equivalent). */
  openConversationTab(conversationId: string): Promise<void>;
  /** Discards the tab currently showing the conversation (Target.closeTarget / /json/close). */
  closeConversationTab(conversationId: string): Promise<void>;
}

type SleepState = 'pending_sleep' | 'slept' | 'waking';

interface SleptRecord {
  conversationId: string;
  state: SleepState;
  /** When the tab was actually discarded; null while still in the grace period. */
  sleptAt: number | null;
  /** The connector session key this conversation's calls carry, when one is bound. */
  sessionKey: string | null;
  /** Last connector call seen for the bound key — the quiescence clock. */
  lastCallAt: number | null;
  /** Why the current/most recent wake fired. */
  wakeCause: 'quiescence' | 'fallback_timer' | null;
  /** When the armed timer (grace, quiet check, fallback, or wake settle) fires. */
  nextCheckAt: number | null;
  timer: NodeJS.Timeout | null;
}

export type SleepWakeEvent =
  | { kind: 'slept'; conversationId: string; at: number; sessionKeyBound: boolean }
  | { kind: 'sleep_failed'; conversationId: string; at: number; reason: string }
  | { kind: 'sleep_cancelled'; conversationId: string; at: number; reason: string }
  | {
      kind: 'wake_started';
      conversationId: string;
      at: number;
      cause: 'quiescence' | 'fallback_timer';
      /** Present on fallback wakes: no bound key, so quiescence was unobservable. */
      detail?: string;
      quietMs?: number;
    }
  | { kind: 'wake_failed'; conversationId: string; at: number; reason: string }
  | { kind: 'resleep_still_generating'; conversationId: string; at: number }
  | {
      /** The finished turn is recorded and the conversation accepts pushes again. */
      kind: 'woke_ready';
      conversationId: string;
      at: number;
      turnId: string | null;
      outcome: string;
      cause: 'quiescence' | 'fallback_timer' | 'external_observer';
    }
  | {
      /** The remount produced no turn evidence inside the settle window; sleep state is dropped honestly. */
      kind: 'woke_unconfirmed';
      conversationId: string;
      at: number;
      detail: string;
    }
  | { kind: 'restored'; conversationId: string; at: number; detail: string };

const MAX_EVENTS = 128;
const MAX_PENDING_SENDS = 64;
/**
 * How long a wake waits for the remounted page to produce turn evidence before the sleep
 * state is dropped with an honest `woke_unconfirmed`. Composer mount alone measured
 * 20–30s; the recorder then needs its ordinary observation cadence on top.
 */
const WAKE_SETTLE_MS = 3 * 60_000;
const DURABLE_STATE = 'sleep-wake';

interface DurableSleepWake {
  version: 1;
  conversations: Array<{ conversationId: string; state: SleepState; sleptAt: number | null }>;
}

const records = new Map<string, SleptRecord>();
/** conversation -> the committed-but-unverified send the bridge reported. */
const pendingTypedSends = new Map<string, { typedAt: number; horizonMs: number }>();
/** The one open push-correlation window. Pushes are serialized, so one is the invariant. */
let pushWindow: { conversationId: string; openedAt: number } | null = null;
const events: SleepWakeEvent[] = [];
let driver: SleepWakeDriver | null = null;

export function setSleepWakeDriver(next: SleepWakeDriver | null): void {
  driver = next;
}

export function sleepWakeSettings(): SleepWakeSettings {
  return getConfig().sleepWake ?? DEFAULT_SLEEP_WAKE;
}

function enabled(): boolean {
  return sleepWakeSettings().enabled;
}

function emit(event: SleepWakeEvent): void {
  events.push(event);
  while (events.length > MAX_EVENTS) events.shift();
  logInfo(`sleep/wake: ${event.kind} for conversation ${event.conversationId}`);
}

function persist(): void {
  const snapshot: DurableSleepWake = {
    version: 1,
    conversations: [...records.values()].map((record) => ({
      conversationId: record.conversationId,
      state: record.state,
      sleptAt: record.sleptAt
    }))
  };
  writeDurableSoon(DURABLE_STATE, records.size > 0 ? snapshot : null);
}

function clearTimer(record: SleptRecord): void {
  if (record.timer) clearTimeout(record.timer);
  record.timer = null;
  record.nextCheckAt = null;
}

function arm(record: SleptRecord, delayMs: number, fire: () => void): void {
  clearTimer(record);
  record.nextCheckAt = Date.now() + delayMs;
  record.timer = setTimeout(fire, delayMs);
  record.timer.unref?.();
}

function drop(record: SleptRecord): void {
  clearTimer(record);
  records.delete(record.conversationId);
  persist();
}

// ------------------------------------------------------------------ push side

/**
 * The bridge reports each committed local send here (the page ACKed the text as typed).
 * Not yet a verified push — verification is the recorder observing the fresh turn_start,
 * which arrives through noteObservedTurnStart below.
 */
export function notePushTyped(conversationId: string, typedAt: number, horizonMs: number): void {
  if (!enabled()) return;
  pendingTypedSends.set(conversationId, { typedAt, horizonMs });
  while (pendingTypedSends.size > MAX_PENDING_SENDS) {
    const oldest = pendingTypedSends.keys().next();
    if (oldest.done) break;
    pendingTypedSends.delete(oldest.value);
  }
}

/**
 * Non-consuming peek for the send-origin classifier (session/send-origin.ts): would this
 * observed turn_start verify a pending typed send? Same match arithmetic as
 * noteObservedTurnStart below, which stays the consumer.
 */
export function pendingSendMatches(conversationId: string, at: number): boolean {
  const pending = pendingTypedSends.get(conversationId);
  return pending !== undefined && at >= pending.typedAt - 2_000 && at - pending.typedAt <= pending.horizonMs;
}

/** The sleep state this module holds for a conversation, for the send-origin classifier. */
export function sleepStateFor(conversationId: string): SleepState | null {
  return records.get(conversationId)?.state ?? null;
}

/**
 * Recorder verdict (session/send-origin.ts): a message reached this conversation's composer
 * with no app-originated send to explain it. The sleep-managed case is the dangerous one:
 * while a conversation is slept the app is the only driver allowed to send into it, so page
 * evidence of a fresh turn means something else typed — or someone reopened the tab; the
 * app cannot tell which, and either way this state machine no longer describes what is in
 * that chat. Cancel the sleep loudly rather than waking into a turn the app never sent.
 * The `push_correlated` window is untouched on purpose: it only ever opens from the app's
 * own verified sends, and an out-of-band send must never arm or claim one.
 *
 * Returns true when a sleep-managed record was cancelled.
 */
export function noteOutOfBandSend(conversationId: string, at: number): boolean {
  // First, and regardless of whether this conversation is sleep-managed: close any open
  // correlation window. The window's whole premise is "the app just sent to exactly one
  // conversation and sends are serialized, so the next unbound key is that conversation's".
  // A message the app did not send is now generating calls somewhere in the fleet, and that
  // premise no longer holds — the next new key may well belong to the turn nobody
  // registered. Leaving the window open let a key armed by an *earlier* legitimate send bind
  // as `push_correlated` after an out-of-band send had already broken the assumption, which
  // is the tier poisoning this whole mechanism exists to prevent. Fail closed: the weaker
  // tiers still apply, and at worst one key stays unattributed.
  if (pushWindow) {
    logWarn(
      `sleep/wake: closing the open push-correlation window for conversation ${pushWindow.conversationId} — ` +
        `a message was typed into conversation ${conversationId} by something other than the app, so ` +
        'the next unbound session key can no longer be assumed to belong to the conversation the app sent to'
    );
    pushWindow = null;
  }
  const record = records.get(conversationId);
  if (!record) return false;
  logError(
    `sleep/wake: out-of-band send into ${record.state} conversation ${conversationId} — ` +
      'a message was typed into a chat this app was managing by something other than the app; ' +
      'two drivers on one conversation, so its sleep state is cancelled'
  );
  emit({
    kind: 'sleep_cancelled',
    conversationId,
    at,
    reason:
      'out_of_band_send: a turn started with no app-originated send while the conversation was sleep-managed; the app cannot know what was sent, so the sleep state is cancelled'
  });
  drop(record);
  return true;
}

/**
 * Pure quiescence arithmetic: how long until the quiet threshold is reached, from now.
 * Zero means the threshold has been reached or passed.
 */
export function quietRemainingMs(
  lastCallAt: number | null,
  sleptAt: number,
  quietMs: number,
  now: number
): number {
  const quietSince = lastCallAt ?? sleptAt;
  return Math.max(0, quietSince + quietMs - now);
}

/**
 * How long until this slept conversation must be looked at, whatever its call stream does.
 *
 * Quiescence is the primary signal and stays primary; this is the ceiling on it. A bound key
 * that is not really this conversation's resets `lastCallAt` forever, so the quiet threshold
 * is never reached, the wake never fires, and the send path refuses every push for that chat
 * for the rest of the process's life — measured live on 2026-09-10, where an idle chat's
 * next-check hint walked from 1s back to 227s each time a foreign call landed. The binding
 * gate in claimPushCorrelation is the cure for how that key got bound; this is the bound on
 * what one still costs. It is not a bypass: waking only remounts the tab, and a remount that
 * finds the turn still generating re-sleeps (noteObservedTurnStart), so a genuinely busy
 * conversation is never pushed into and never interrupted — it just gets looked at.
 */
export function wakeDelayMs(
  lastCallAt: number | null,
  sleptAt: number,
  quietMs: number,
  fallbackWakeMs: number,
  now: number
): { delayMs: number; cause: 'quiescence' | 'fallback_timer' } {
  const quiet = quietRemainingMs(lastCallAt, sleptAt, quietMs, now);
  const fallback = Math.max(0, sleptAt + fallbackWakeMs - now);
  return quiet <= fallback ? { delayMs: quiet, cause: 'quiescence' } : { delayMs: fallback, cause: 'fallback_timer' };
}

function armQuiescenceCheck(record: SleptRecord): void {
  const { quietMs, fallbackWakeMs } = sleepWakeSettings();
  const sleptAt = record.sleptAt ?? Date.now();
  const next = wakeDelayMs(record.lastCallAt, sleptAt, quietMs, fallbackWakeMs, Date.now());
  arm(record, Math.max(next.delayMs, 1_000), () => {
    record.timer = null;
    if (record.state !== 'slept') return;
    const due = wakeDelayMs(
      record.lastCallAt,
      record.sleptAt ?? Date.now(),
      quietMs,
      fallbackWakeMs,
      Date.now()
    );
    if (due.delayMs > 0) {
      // Calls arrived since this check was armed: not quiet yet, re-arm for the remainder.
      armQuiescenceCheck(record);
      return;
    }
    void wake(record, due.cause);
  });
}

function armFallbackWake(record: SleptRecord): void {
  const { fallbackWakeMs } = sleepWakeSettings();
  const elapsed = Date.now() - (record.sleptAt ?? Date.now());
  arm(record, Math.max(1_000, fallbackWakeMs - elapsed), () => {
    record.timer = null;
    if (record.state !== 'slept') return;
    void wake(record, 'fallback_timer');
  });
}

function armWakeTimers(record: SleptRecord): void {
  if (record.sessionKey) armQuiescenceCheck(record);
  else armFallbackWake(record);
}

async function executeSleep(record: SleptRecord): Promise<void> {
  if (record.state !== 'pending_sleep') return;
  if (!driver) {
    // Fail loudly: enabled without a wired tab driver is a wiring defect, not a fallback.
    logWarn(
      `sleep/wake: cannot discard the tab for ${record.conversationId} — no tab driver is wired in this entrypoint`
    );
    emit({ kind: 'sleep_failed', conversationId: record.conversationId, at: Date.now(), reason: 'no tab driver wired' });
    drop(record);
    return;
  }
  try {
    await driver.closeConversationTab(record.conversationId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn(`sleep/wake: could not discard the tab for ${record.conversationId} — ${reason}`);
    emit({ kind: 'sleep_failed', conversationId: record.conversationId, at: Date.now(), reason });
    drop(record);
    return;
  }
  record.state = 'slept';
  record.sleptAt = Date.now();
  // The push-correlation window may already have bound this conversation's key before the
  // grace period ended; otherwise adopt whatever earlier binding the tiers learned.
  record.sessionKey ??= boundKeyForConversation(record.conversationId);
  emit({
    kind: 'slept',
    conversationId: record.conversationId,
    at: record.sleptAt,
    sessionKeyBound: record.sessionKey !== null
  });
  armWakeTimers(record);
  persist();
}

async function wake(record: SleptRecord, cause: 'quiescence' | 'fallback_timer'): Promise<void> {
  if (record.state !== 'slept') return;
  if (!driver) {
    logWarn(`sleep/wake: cannot remount ${record.conversationId} — no tab driver is wired in this entrypoint`);
    emit({ kind: 'wake_failed', conversationId: record.conversationId, at: Date.now(), reason: 'no tab driver wired' });
    // The tab is gone and nothing can bring it back from here. Dropping the record at
    // least stops refusing pushes for a conversation this process cannot manage.
    drop(record);
    return;
  }
  record.state = 'waking';
  record.wakeCause = cause;
  emit({
    kind: 'wake_started',
    conversationId: record.conversationId,
    at: Date.now(),
    cause,
    ...(cause === 'quiescence'
      ? { quietMs: sleepWakeSettings().quietMs }
      : { detail: 'no session key is bound to this slept conversation, so call-stream quiescence is unobservable; woken by the fallback timer instead' })
  });
  persist();
  try {
    await driver.openConversationTab(record.conversationId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn(`sleep/wake: could not remount ${record.conversationId} — ${reason}`);
    emit({ kind: 'wake_failed', conversationId: record.conversationId, at: Date.now(), reason });
    // The tab stayed closed; go back to sleep and try again a full cycle later.
    record.state = 'slept';
    record.wakeCause = null;
    armWakeTimers(record);
    persist();
    return;
  }
  // The remounted page now has WAKE_SETTLE_MS to produce turn evidence through the
  // recorder: a turn_start (still generating -> re-sleep) or an observed turn end /
  // recovered final (finished -> woke_ready). Silence past the window is reported
  // honestly rather than holding the conversation in `waking` forever.
  arm(record, WAKE_SETTLE_MS, () => {
    record.timer = null;
    if (record.state !== 'waking') return;
    emit({
      kind: 'woke_unconfirmed',
      conversationId: record.conversationId,
      at: Date.now(),
      detail:
        'the remounted page produced no turn evidence inside the settle window; the conversation is treated as awake — inspect the tab'
    });
    drop(record);
  });
}

// ------------------------------------------------------------------ recorder side

/**
 * Recorder hook: a fresh page-observed turn_start for this conversation.
 *
 * Three meanings, disambiguated by state: the verification of a pending typed send (open
 * the push window, begin the sleep); a waking remount showing the turn still generating
 * (re-sleep); or page evidence arriving for a conversation believed slept (someone else
 * opened the tab — hand it back to ordinary observation).
 */
export function noteObservedTurnStart(conversationId: string, at: number): void {
  const pending = pendingTypedSends.get(conversationId);
  if (pending && at >= pending.typedAt - 2_000 && at - pending.typedAt <= pending.horizonMs) {
    pendingTypedSends.delete(conversationId);
    if (!enabled()) return;
    // Verified push: the recording shows the turn starting. Open the (single) correlation
    // window — a newer verified push supersedes an older unclaimed window, which is
    // exactly the serialized-pushes contract.
    pushWindow = { conversationId, openedAt: Date.now() };
    const existing = records.get(conversationId);
    if (existing) {
      // Wake->record->push-next completed and the next push has landed; this is the next
      // cycle of the same conversation. (Reachable only through internal callers: the
      // bridge refuses external pushes while a record exists.)
      clearTimer(existing);
      existing.state = 'pending_sleep';
      existing.sleptAt = null;
      existing.wakeCause = null;
    } else {
      records.set(conversationId, {
        conversationId,
        state: 'pending_sleep',
        sleptAt: null,
        sessionKey: boundKeyForConversation(conversationId),
        lastCallAt: null,
        wakeCause: null,
        nextCheckAt: null,
        timer: null
      });
    }
    const record = records.get(conversationId)!;
    arm(record, sleepWakeSettings().graceMs, () => {
      record.timer = null;
      void executeSleep(record);
    });
    persist();
    return;
  }

  const record = records.get(conversationId);
  if (!record) return;
  if (record.state === 'waking') {
    // Quiet was not done: the remount shows the turn still generating. Re-sleep after the
    // grace period and keep monitoring.
    emit({ kind: 'resleep_still_generating', conversationId, at });
    record.state = 'pending_sleep';
    record.sleptAt = null;
    arm(record, sleepWakeSettings().graceMs, () => {
      record.timer = null;
      void executeSleep(record);
    });
    persist();
    return;
  }
  // A `slept` record cannot reach here. Page evidence of a fresh turn in a chat whose tab
  // this app discarded is, by definition, a second driver: the app is the only driver
  // allowed to send into a slept conversation, so the send-origin classifier
  // (session/send-origin.ts) rules every such start either `app` — which took the
  // pending-send branch above — or `out_of_band`, and the recorder routes `out_of_band`
  // through noteOutOfBandSend() before calling here, which cancels the sleep at error level.
  // This used to be treated as a benign reopened tab and released with a quiet
  // `woke_unconfirmed`; that reading is what made a bypass look like ordinary observation.
}

/**
 * Recorder hook: a page-observed end (explicit turn_end, or the reload-recovery path
 * closing an open turn from a recovered final assistant message). Never called for the
 * app's own observer_lost closures — those are not observed evidence.
 */
export function noteObservedTurnEnd(conversationId: string, turnId: string | null, outcome: string, at: number): void {
  const record = records.get(conversationId);
  if (!record) return;
  if (record.state === 'pending_sleep') {
    // The turn finished before the grace period closed the tab: nothing to sleep through.
    emit({ kind: 'sleep_cancelled', conversationId, at, reason: `the turn ended (${outcome}) before the tab was discarded` });
    drop(record);
    return;
  }
  const cause = record.state === 'waking' ? (record.wakeCause ?? 'quiescence') : 'external_observer';
  emit({ kind: 'woke_ready', conversationId, at, turnId, outcome, cause });
  drop(record);
}

/**
 * Recorder hook, on every degraded-attribution call: feeds the quiescence clock of the
 * slept conversation whose bound key this is, if any.
 */
export function noteConnectorActivity(sessionKey: string): void {
  if (records.size === 0) return;
  const held = sessionBindingDetail(sessionKey);
  const owner = held ? records.get(held.conversationId) : null;
  const record = owner ?? [...records.values()].find((entry) => entry.sessionKey === sessionKey) ?? null;
  if (!record) return;
  record.lastCallAt = Date.now();
  // No timer churn per call: the armed quiet check re-computes from lastCallAt when it
  // fires and re-arms itself for the remainder.
}

/**
 * The push-correlated learning step, called by the recorder for a key with no binding.
 *
 * `soleVisible` is the temporal tier's answer for the same moment. When both tiers claim
 * the key for different conversations, the first-sight evidence is contradictory and the
 * key is condemned outright — neither side may win ('contradicted').
 *
 * `firstSeenAt` is when this process first saw the key at all (connector-session.ts), and
 * it is a hard gate: the window may only claim a key whose call stream *began* inside it.
 */
export function claimPushCorrelation(
  sessionKey: string,
  soleVisible: string | null,
  firstSeenAt: number | null
): string | 'contradicted' | null {
  if (!enabled() || !pushWindow) return null;
  const { correlationWindowMs } = sleepWakeSettings();
  if (Date.now() - pushWindow.openedAt > correlationWindowMs) {
    pushWindow = null;
    return null;
  }
  // The window's whole claim is "the app just started a turn in exactly one conversation, so
  // the calls that turn begins making are that conversation's". A key that was already
  // calling before the window opened was started by something else, and binding it was the
  // measured 2026-09-10 failure: a long-running worker's key was bound to a freshly pushed
  // chat, which then recorded that worker's calls, charged them to the wrong conversation,
  // and — because the wake detector reads quiescence off the bound key — held an idle chat
  // asleep past every push, permanently unreachable through the send path.
  //
  // Not a reason to close the window: an unrelated key arriving says nothing about whether
  // the pushed conversation's own first call is still coming.
  if (firstSeenAt === null || firstSeenAt < pushWindow.openedAt) return null;
  const claimant = pushWindow.conversationId;
  if (soleVisible && soleVisible !== claimant) {
    condemnSessionKey(
      sessionKey,
      `first seen while the push window claimed conversation ${claimant} but ${soleVisible} was the sole visible generator`
    );
    pushWindow = null;
    return 'contradicted';
  }
  const learned = learnPushCorrelatedBinding(sessionKey, claimant);
  if (learned === 'conflict') return 'contradicted';
  // First key claims the window; pushes are serialized so there is nothing left to bind.
  pushWindow = null;
  const record = records.get(claimant);
  if (record && record.sessionKey !== sessionKey) {
    record.sessionKey = sessionKey;
    record.lastCallAt = Date.now();
    // A keyless fallback timer can now become a real quiescence watch.
    if (record.state === 'slept') armQuiescenceCheck(record);
  }
  return claimant;
}

/**
 * Whether this conversation is sleep-managed *and* its calls are accounted for by a bound
 * session key — the condition under which the recorder may exclude it from
 * temporal-uniqueness computations. Slept without a key stays fail-closed there.
 */
export function isSleptWithBoundKey(conversationId: string): boolean {
  const record = records.get(conversationId);
  return record !== undefined && record.sessionKey !== null;
}

// ------------------------------------------------------------------ bridge side

/**
 * The single-driver invariant: one serialized wake->record->push-next sequence per
 * conversation. While a conversation is sleep-managed, an external push is refused with a
 * typed reason and a concrete hint for when to check again.
 */
export function sendRefusalFor(
  conversationId: string
): { reason: 'sleeping' | 'waking'; nextCheckHintMs: number } | null {
  const record = records.get(conversationId);
  if (!record) return null;
  if (record.state === 'waking') return { reason: 'waking', nextCheckHintMs: 15_000 };
  const hint = record.nextCheckAt !== null ? Math.max(1_000, record.nextCheckAt - Date.now()) : sleepWakeSettings().quietMs;
  return { reason: 'sleeping', nextCheckHintMs: hint };
}

/** The steward-facing projection served by GET /sleep/status on the bridge. */
export function sleepWakeStatus(): {
  enabled: boolean;
  conversations: Array<{
    conversationId: string;
    state: SleepState;
    sleptAt: number | null;
    sessionKeyBound: boolean;
    lastCallAt: number | null;
    nextCheckAt: number | null;
    wakeCause: 'quiescence' | 'fallback_timer' | null;
  }>;
  events: SleepWakeEvent[];
} {
  return {
    enabled: enabled(),
    conversations: [...records.values()].map((record) => ({
      conversationId: record.conversationId,
      state: record.state,
      sleptAt: record.sleptAt,
      sessionKeyBound: record.sessionKey !== null,
      lastCallAt: record.lastCallAt,
      nextCheckAt: record.nextCheckAt,
      wakeCause: record.wakeCause
    })),
    events: [...events]
  };
}

// ------------------------------------------------------------------ lifecycle

/**
 * Restores sleep state across a restart. Session-key bindings are deliberately in-memory
 * only (see connector-session.ts), so every restored conversation comes back *keyless*:
 * quiescence is unobservable until its key re-binds, and the fallback timer carries the
 * wake. The restore event says exactly that.
 */
export async function restoreSleepWake(): Promise<void> {
  const stored = await readDurable<DurableSleepWake>(DURABLE_STATE);
  if (!stored || stored.version !== 1 || !Array.isArray(stored.conversations)) return;
  for (const entry of stored.conversations) {
    if (typeof entry.conversationId !== 'string' || entry.conversationId === '') continue;
    if (records.has(entry.conversationId)) continue;
    const record: SleptRecord = {
      conversationId: entry.conversationId,
      // A pending_sleep or waking crash side collapses to slept: the tab state is unknown
      // and the wake remounts it either way.
      state: 'slept',
      sleptAt: typeof entry.sleptAt === 'number' ? entry.sleptAt : Date.now(),
      sessionKey: null,
      lastCallAt: null,
      wakeCause: null,
      nextCheckAt: null,
      timer: null
    };
    records.set(entry.conversationId, record);
    emit({
      kind: 'restored',
      conversationId: entry.conversationId,
      at: Date.now(),
      detail:
        'slept state restored after a restart; session-key bindings do not survive restarts, so this conversation is keyless until its key re-binds and wakes on the fallback timer'
    });
    // From restore time, not the stored sleptAt: a daemon that was down for an hour must
    // not wake its whole slept fleet in the same instant it boots.
    record.sleptAt = Date.now();
    armFallbackWake(record);
  }
  persist();
}

export function resetSleepWakeForTests(): void {
  for (const record of records.values()) clearTimer(record);
  records.clear();
  pendingTypedSends.clear();
  pushWindow = null;
  events.length = 0;
  driver = null;
}
