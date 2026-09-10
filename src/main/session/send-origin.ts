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
 * session key to an app-originated *send*). That tooling is break-glass only now. This
 * module is the enforcement half of the demotion: it does not make bypass impossible —
 * break-glass must remain possible — it makes bypass *observed, attributed and counted*.
 *
 * The evidence layer: the recorder sees every page-observed `turn_start`; the bridge
 * reports every app-originated send here at its committed ACK. A turn_start that no
 * registered app send explains was sent out of band. Three honest verdicts, stored on the
 * turn's own record:
 *
 * - `app`         — a registered app send (or sleep/wake's own pending-send registry, which
 *                   is fed from the same ACKs) explains this start.
 * - `out_of_band` — nothing explains it: something other than the app typed into the chat.
 *                   One warn line per occurrence, a typed `out_of_band_send` event, and a
 *                   durable per-conversation tally, all served on GET /sleep/status — so
 *                   "how much bypass is happening" is a queryable number, not a journal grep.
 * - `unknown`     — an evidence gap: the startup grace window (the send registry is RAM and
 *                   a message sent before a restart can verify after it), an observer-lost
 *                   or detached-mid-turn remount re-observing a generation it never saw
 *                   end, a conversation whose opening send is still in flight (the page can
 *                   report the turn before the ACK that registers the send lands). Never
 *                   guessed to `app`, never counted as out-of-band.
 *
 * An out-of-band send must never create `push_correlated` bindings — the app did not send
 * anything, so correlating a key to that conversation would poison the strongest degraded
 * tier. That holds structurally: the correlation window in sleep-wake.ts only ever opens
 * when a *pending app send* is verified by its turn_start, and this module never touches it.
 *
 * Layering: imports durable + logger + shared types only. The recorder classifies through
 * it; the bridge feeds the registry and injects the in-flight-command probe. Sleep-wake
 * state is passed in by the recorder rather than imported, and the dangerous
 * out-of-band-into-slept transition is owned by sleep-wake.ts (`noteOutOfBandSend`).
 */

import { readDurable, writeDurableSoon } from '../durable.js';
import { logError, logWarn } from '../logger.js';
import type { SendOrigin } from '../../shared/session.js';

/** Mirrors sleep-wake's verification tolerance for a turn_start observed just before the ACK lands. */
const TYPED_MATCH_EARLY_MS = 2_000;
const MAX_REGISTERED_SENDS = 64;
const MAX_COUNTED_CONVERSATIONS = 200;
const MAX_EVENTS = 128;
const DURABLE_STATE = 'send-origin';

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

interface DurableSendOrigin {
  version: 1;
  total: number;
  byConversation: Record<string, { count: number; lastAt: number }>;
}

let startedAt = Date.now();
/** conversation -> the newest committed app-originated send, awaiting its turn_start. */
const appSends = new Map<string, { typedAt: number; horizonMs: number }>();
let outOfBandTotal = 0;
const outOfBandByConversation = new Map<string, { count: number; lastAt: number }>();
const events: OutOfBandSendEvent[] = [];
/**
 * Injected by the bridge: whether a queued/leased command could still type into this
 * conversation (or, for a chat the app has no lifecycle history for, whether any fresh-chat
 * opener is in flight — its conversation id does not exist until the page ACKs).
 */
let inFlightProvider: ((conversationId: string, firstTurnForConversation: boolean) => boolean) | null = null;
let restored = false;

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
 *    never guessed to `app`, never counted as out-of-band.
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
 * Counts one out-of-band send and says so where a steward will see it: a journal line per
 * occurrence (error level when it landed in a slept conversation — the two-drivers case),
 * a typed event, and the durable tally GET /sleep/status serves.
 */
export function recordOutOfBandSend(conversationId: string, at: number, sleepCancelled: boolean): void {
  outOfBandTotal += 1;
  const held = outOfBandByConversation.get(conversationId);
  outOfBandByConversation.set(conversationId, { count: (held?.count ?? 0) + 1, lastAt: at });
  while (outOfBandByConversation.size > MAX_COUNTED_CONVERSATIONS) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of outOfBandByConversation) {
      if (entry.lastAt < oldestAt) {
        oldestAt = entry.lastAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    outOfBandByConversation.delete(oldestKey);
  }
  // Say what actually happened, in terms a steward can act on. The parenthetical names the
  // machinery that was skipped, because that is the cost of the bypass and the reason the
  // app path is the normal surface.
  const bypassed =
    'direct-CDP steward tooling bypasses the send registry, draft ledger, single-driver enforcement, sleep/wake, and push-correlated attribution';
  const detail = sleepCancelled
    ? `a message was typed into this chat by something other than the app while the app had the chat asleep — two drivers on one conversation; the sleep state was cancelled because the app cannot know what was sent (${bypassed})`
    : `a message was typed into this chat by something other than the app (${bypassed})`;
  events.push({ kind: 'out_of_band_send', conversationId, at, sleepCancelled, detail });
  while (events.length > MAX_EVENTS) events.shift();
  const line =
    `send-origin: turn started in conversation ${conversationId} at ${new Date(at).toISOString()} ` +
    `with no matching app send — ${detail}`;
  if (sleepCancelled) logError(line);
  else logWarn(line);
  persist();
}

function persist(): void {
  const snapshot: DurableSendOrigin = {
    version: 1,
    total: outOfBandTotal,
    byConversation: Object.fromEntries(outOfBandByConversation)
  };
  writeDurableSoon(DURABLE_STATE, outOfBandTotal > 0 ? snapshot : null);
}

/** The steward-facing projection, served as the `sendOrigin` sibling on GET /sleep/status. */
export function sendOriginStatus(): {
  outOfBandSends: {
    /** Every out-of-band send ever counted on this install; the tally survives restarts. */
    total: number;
    byConversation: Array<{ conversationId: string; count: number; lastAt: number }>;
  };
  events: OutOfBandSendEvent[];
} {
  return {
    outOfBandSends: {
      total: outOfBandTotal,
      byConversation: [...outOfBandByConversation.entries()]
        .map(([conversationId, entry]) => ({ conversationId, count: entry.count, lastAt: entry.lastAt }))
        .sort((a, b) => b.lastAt - a.lastAt)
    },
    events: [...events]
  };
}

/**
 * Restores the durable tally across a restart. The migration metric only means something
 * if it survives daemon restarts; the send registry itself deliberately does not (see
 * STARTUP_GRACE_MS).
 */
export async function restoreSendOrigin(): Promise<void> {
  if (restored) return;
  restored = true;
  if (outOfBandTotal > 0) return;
  const stored = await readDurable<DurableSendOrigin>(DURABLE_STATE);
  if (!stored || stored.version !== 1 || typeof stored.total !== 'number') return;
  outOfBandTotal = stored.total;
  for (const [conversationId, entry] of Object.entries(stored.byConversation ?? {})) {
    if (typeof entry?.count !== 'number' || typeof entry?.lastAt !== 'number') continue;
    outOfBandByConversation.set(conversationId, { count: entry.count, lastAt: entry.lastAt });
    if (outOfBandByConversation.size >= MAX_COUNTED_CONVERSATIONS) break;
  }
}

export function resetSendOriginForTests(startedAtOverride: number = Date.now()): void {
  startedAt = startedAtOverride;
  appSends.clear();
  outOfBandTotal = 0;
  outOfBandByConversation.clear();
  events.length = 0;
  restored = false;
  // The in-flight provider is deliberately kept: the bridge wires it once at startup and
  // suites reset per-test state without restarting the bridge.
}
