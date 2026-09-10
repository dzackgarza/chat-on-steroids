/**
 * Send-origin attribution: which driver typed the message that started each observed turn.
 *
 * ("Send" throughout this module means a message typed into a ChatGPT composer. Nothing
 * here has anything to do with git.)
 *
 * Doctrine (FANOUT-SCHEDULE.md): the app's send path — `just say` → POST /send →
 * `sent_verified`, plus the app's own worker bootstraps, revival offers, resume handoffs
 * and goal drafts — is the sole normal way a composer is driven. Direct-CDP steward tooling
 * (`pusher2.sh`, `cdp_push.py` against port 9222) drives the composer without telling the
 * app: it bypasses the send registry, the draft ledger, single-driver enforcement,
 * sleep/wake, and the `push_correlated` attribution tier (which correlates a connector
 * session key to an app-originated *send*). This module is how the app stays consistent
 * with a composer it did not drive: it observes the turn, attributes it honestly, and
 * repairs its own bookkeeping for that conversation.
 *
 * The evidence layer: the recorder sees every page-observed `turn_start`; the bridge
 * reports every app-originated send here at its committed ACK. A turn_start that no
 * registered app send explains was sent out of band. Three honest verdicts, stored on the
 * turn's own record:
 *
 * - `app`         — a registered app send (or sleep/wake's own pending-send registry, which
 *                   is fed from the same ACKs) explains this start.
 * - `out_of_band` — nothing explains it: something other than the app typed into the chat.
 *                   One log line per occurrence plus a typed `out_of_band_send` event on the
 *                   bounded recent-events ring GET /sleep/status serves, describing what the
 *                   app did to its own state in response.
 * - `unknown`     — an evidence gap: the startup grace window (the send registry is RAM and
 *                   a message sent before a restart can verify after it), an observer-lost
 *                   or detached-mid-turn remount re-observing a generation it never saw
 *                   end, a conversation whose opening send is still in flight (the page can
 *                   report the turn before the ACK that registers the send lands). Never
 *                   guessed to `app`.
 *
 * An out-of-band send must never create `push_correlated` bindings — the app did not send
 * anything, so correlating a key to that conversation would poison the strongest degraded
 * tier. That holds structurally: the correlation window in sleep-wake.ts only ever opens
 * when a *pending app send* is verified by its turn_start, and this module never touches it.
 *
 * Layering: imports logger + shared types only. The recorder classifies through
 * it; the bridge feeds the registry and injects the in-flight-command probe. Sleep-wake
 * state is passed in by the recorder rather than imported, and the dangerous
 * out-of-band-into-slept transition is owned by sleep-wake.ts (`noteOutOfBandSend`).
 */

import { logError, logWarn } from '../logger.js';
import type { SendOrigin } from '../../shared/session.js';

/** Mirrors sleep-wake's verification tolerance for a turn_start observed just before the ACK lands. */
const TYPED_MATCH_EARLY_MS = 2_000;
const MAX_REGISTERED_SENDS = 64;
const MAX_EVENTS = 128;

/**
 * How long after a process start a turn_start with no registered send stays `unknown`
 * rather than `out_of_band`. The send registry is deliberately in-memory (a registry that
 * outlived the commands it describes would claim sends the restarted app cannot verify),
 * so a message typed before a restart can produce its turn_start after it — within the
 * send-verify horizon (default 90s), plus the extension's re-observation of turns that
 * were already generating when the daemon came back.
 */
export const STARTUP_GRACE_MS = 3 * 60_000;

export interface OutOfBandSendEvent {
  kind: 'out_of_band_send';
  conversationId: string;
  at: number;
  /** True when the send landed in a slept conversation and its sleep state was cancelled for it. */
  sleepCancelled: boolean;
  detail: string;
}

/** What the recorder knows at the moment a fresh turn_start is accepted. */
export interface TurnStartEvidence {
  /** sleep-wake's own pending-send registry verified this start (sleepWake-enabled deployments). */
  verifiedBySleepWake: boolean;
  sleepState: 'pending_sleep' | 'slept' | 'waking' | null;
  /** The conversation's open turn was recently closed as observer_lost. */
  observerLost: boolean;
  /** The conversation's tab detached while generating; this start may re-observe that turn. */
  detachedMidTurn: boolean;
  /** The app holds no local turn-lifecycle history for this chat: this is its first observed turn. */
  firstTurnForConversation: boolean;
}

let startedAt = Date.now();
/** conversation -> the newest committed app-originated send, awaiting its turn_start. */
const appSends = new Map<string, { typedAt: number; horizonMs: number }>();
const events: OutOfBandSendEvent[] = [];
/**
 * Injected by the bridge: whether a queued/leased command could still type into this
 * conversation (or, for a chat the app has no lifecycle history for, whether any fresh-chat
 * opener is in flight — its conversation id does not exist until the page ACKs).
 */
let inFlightProvider: ((conversationId: string, firstTurnForConversation: boolean) => boolean) | null = null;

export function setAppSendInFlightProvider(
  provider: ((conversationId: string, firstTurnForConversation: boolean) => boolean) | null
): void {
  inFlightProvider = provider;
}

/**
 * The bridge reports each committed composer send here (local send, worker bootstrap,
 * revival offer, resume handoff, goal draft), keyed by the conversation it landed in.
 * Always on — unlike sleep-wake's registry this one is not config-gated, because bypass
 * detection must not depend on the sleep/wake feature being enabled.
 */
export function noteAppOriginatedSend(conversationId: string, typedAt: number, horizonMs: number): void {
  appSends.set(conversationId, { typedAt, horizonMs });
  while (appSends.size > MAX_REGISTERED_SENDS) {
    const oldest = appSends.keys().next();
    if (oldest.done) break;
    appSends.delete(oldest.value);
  }
}

function consumeMatchingAppSend(conversationId: string, at: number): boolean {
  const send = appSends.get(conversationId);
  if (!send) return false;
  if (at < send.typedAt - TYPED_MATCH_EARLY_MS || at - send.typedAt > send.horizonMs) return false;
  // One send explains one turn. Leaving the entry would let a second turn inside the
  // horizon — exactly an out-of-band send following an app send — launder itself as 'app'.
  appSends.delete(conversationId);
  return true;
}

/**
 * The verdict for one accepted turn_start. Order matters:
 *
 * 1. Positive app evidence wins outright.
 * 2. `slept` beats every evidence-gap excuse below it: the app discarded that tab itself,
 *    so its own closure must never explain away page evidence of a new turn — while a
 *    conversation is slept, the app is the only driver allowed to send into it.
 * 3. `waking` is a genuine gap, and the only sleep state that is one: the app has just
 *    remounted the tab, and the page re-reports the generation it slept through. Note that
 *    `pending_sleep` is deliberately *not* excused — the tab is alive and the turn the app
 *    verified is running, so a second turn starting in that window is a second message, not
 *    an artifact of the app's own bookkeeping.
 * 4. Every remaining in-flight send, restart window, or observation gap is `unknown` —
 *    never guessed to `app`, and never reported as out-of-band.
 */
export function classifySendOrigin(conversationId: string, at: number, evidence: TurnStartEvidence): SendOrigin {
  // Both registries are consumed, never short-circuited. The bridge feeds sleep/wake's
  // pending-send registry and this one from the same committed ACK, so when sleep/wake
  // verifies the turn this entry is the same send and must be spent with it. Letting `||`
  // skip the consume left it behind to explain the *next* turn — which is precisely an
  // out-of-band send following an app send, laundered into `app`.
  const registered = consumeMatchingAppSend(conversationId, at);
  if (evidence.verifiedBySleepWake || registered) return 'app';
  if (evidence.sleepState === 'slept') return 'out_of_band';
  if (evidence.sleepState === 'waking') return 'unknown';
  if (inFlightProvider?.(conversationId, evidence.firstTurnForConversation) === true) return 'unknown';
  if (at - startedAt < STARTUP_GRACE_MS) return 'unknown';
  if (evidence.observerLost || evidence.detachedMidTurn) return 'unknown';
  return 'out_of_band';
}

/**
 * Records that a turn started which this app did not send, and says what the app did about
 * it: a journal line per occurrence (error level when the app had to cancel a sleep — it can
 * no longer describe that conversation) plus a typed event on the bounded recent-events ring.
 * Both describe the app's own bookkeeping; neither is a record kept against the steward.
 */
export function recordOutOfBandSend(conversationId: string, at: number, sleepCancelled: boolean): void {
  // Say what the app changed about its own state, so a steward reading this knows what the
  // app now believes about the conversation rather than being told off for driving it.
  const detail = sleepCancelled
    ? `a turn started that this app did not send; the app cannot know what was sent, so it cancelled the pending sleep for ${conversationId} and closed its correlation window`
    : `a turn started that this app did not send; the app holds no sleep state for ${conversationId}, so nothing of its own needed correcting — the send registry, draft ledger and push-correlated attribution simply do not describe this turn`;
  events.push({ kind: 'out_of_band_send', conversationId, at, sleepCancelled, detail });
  while (events.length > MAX_EVENTS) events.shift();
  const line = `send-origin: ${new Date(at).toISOString()} — ${detail}`;
  if (sleepCancelled) logError(line);
  else logWarn(line);
}

/** The steward-facing projection, served as the `sendOrigin` sibling on GET /sleep/status. */
export function sendOriginStatus(): { events: OutOfBandSendEvent[] } {
  return { events: [...events] };
}

export function resetSendOriginForTests(startedAtOverride: number = Date.now()): void {
  startedAt = startedAtOverride;
  appSends.clear();
  events.length = 0;
  // The in-flight provider is deliberately kept: the bridge wires it once at startup and
  // suites reset per-test state without restarting the bridge.
}
