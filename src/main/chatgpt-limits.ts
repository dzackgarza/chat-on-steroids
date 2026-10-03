/**
 * ChatGPT's subscription usage limit, read from the source instead of guessed.
 *
 * When a seat hits its usage limit, ChatGPT blocks the `send` feature until a fixed time and
 * the page removes its send button ("Our systems have detected unusual activity…", "You've hit
 * your rate limit"). The deadline is published: a chatgpt.com page's
 * `POST /backend-api/conversation/init` returns `blocked_features: [{name: "send",
 * resets_after}]`. Before this module the app answered the symptom with escalating guesses
 * (backoff, re-opened chats, re-sent recoveries), all of which failed until the fixed deadline
 * (2026-09-26 20:34 → 2026-09-27 06:45:27 UTC). Now the first sign of a limit makes the app
 * read the deadline and hold every workstream send until it passes.
 *
 * The read is a direct backend call with the owner-provisioned session (see readSendBlock).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { logError, logInfo, logWarn } from "./logger.js";

/** Signals arrive in bursts (one per chat); one read answers them all for a while. */
const READ_INTERVAL_MS = 2 * 60_000;
/** Resume a little after the published reset, not on the millisecond. */
const RESET_MARGIN_MS = 30_000;

const LIMIT_PHRASES = [
  "unusual activity",
  "hit your rate limit",
  "too many requests",
  "temporarily limited access",
  "chatgpt_rate_limited",
];

/**
 * The hold and its escalation survive a restart. Kept in memory only, a restart reopened sends
 * mid-hold and reset the strike count: on 2026-10-03 00:12 a deploy restart dropped strike 2's
 * hold nine minutes early while ChatGPT was still answering "Too many requests".
 */
const HOLD_FILE = `${process.env.HOME}/.config/chat-on-steroids/state/usage-hold.json`;
type HoldState = { blockedUntil: number; strikes: number; lastStrikeAt: number };

function loadHold(): HoldState {
  if (!existsSync(HOLD_FILE)) return { blockedUntil: 0, strikes: 0, lastStrikeAt: 0 };
  const state = JSON.parse(readFileSync(HOLD_FILE, "utf8")) as HoldState;
  for (const key of ["blockedUntil", "strikes", "lastStrikeAt"] as const)
    assert(Number.isFinite(state[key]), `${HOLD_FILE} carries a numeric ${key}`);
  return state;
}

function saveHold(): void {
  const state: HoldState = { blockedUntil, strikes, lastStrikeAt };
  writeFileSync(`${HOLD_FILE}.tmp`, JSON.stringify(state));
  renameSync(`${HOLD_FILE}.tmp`, HOLD_FILE);
}

const loaded = loadHold();
let blockedUntil = loaded.blockedUntil;
let lastReadAt = 0;
let reading: Promise<void> | null = null;
/** Escalation: consecutive limit episodes hold longer. */
let strikes = loaded.strikes;
let lastStrikeAt = loaded.lastStrikeAt;
/** First hold, doubling per strike up to the cap. */
const FIRST_HOLD_MS = 15 * 60_000;
const MAX_HOLD_MS = 4 * 60 * 60_000;
/** An observation older than this describes a past episode, not the account now. */
const SIGNAL_FRESH_MS = 2 * 60_000;
/** One burst of warnings (every chat reporting the same limit) is one strike, not dozens. */
const STRIKE_DEBOUNCE_MS = 5 * 60_000;
/** A quiet day resets the escalation. */
const STRIKE_RESET_MS = 6 * 60 * 60_000;

/** Until when every send is held (epoch ms); 0 when sends are open. */
export function sendBlockedUntil(now = Date.now()): number {
  return blockedUntil > now ? blockedUntil : 0;
}

/** Whether a page error or receipt text is ChatGPT's usage-limit notice. */
export function isUsageLimitText(text: string | null | undefined): boolean {
  const lower = (text ?? "").toLowerCase();
  return LIMIT_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * A sign of a limit was seen: hold every send now, then read the published deadline.
 *
 * The hold does not wait for a reset time. On 2026-09-26 ChatGPT published none during its
 * "unusual activity" episode, the old handler therefore held nothing, and the app sent into
 * the limit 91 more times in 25 minutes. A hold is never shortened by a read; a published
 * resets_after only extends it.
 */
export function noteUsageLimitSignal(text: string | null | undefined, observedAt: number): void {
  if (!isUsageLimitText(text)) return;
  const now = Date.now();
  // Only a fresh observation describes the account now. The extension re-posts buffered page
  // events (after a reload or when a chat binds); on 2026-09-27 the 20:34-20:55 notices from the
  // night before were replayed at 15:36 and opened a false hold.
  if (now - observedAt > SIGNAL_FRESH_MS) return;
  if (now - lastStrikeAt > STRIKE_RESET_MS) strikes = 0;
  if (now - lastStrikeAt >= STRIKE_DEBOUNCE_MS) {
    // "Too many requests" is a request-rate 429, not the subscription limit: on 2026-10-03 it
    // fired seven times while ChatGPT published no send block and the chats kept working through
    // it, and its doubling holds froze the fleet for 2h, then 4h, then 4h again. It holds for the
    // first-hold window only and does not escalate; the usage-limit notices still double.
    const lower = (text ?? "").toLowerCase();
    const rateOnly = !LIMIT_PHRASES.some((phrase) => phrase !== "too many requests" && lower.includes(phrase));
    if (!rateOnly) strikes++;
    lastStrikeAt = now;
    const hold = rateOnly ? FIRST_HOLD_MS : Math.min(MAX_HOLD_MS, FIRST_HOLD_MS * 2 ** (strikes - 1));
    blockedUntil = Math.max(blockedUntil, now + hold);
    saveHold();
    logWarn(
      `ChatGPT usage limit (strike ${strikes}): holding every send until ${new Date(blockedUntil).toISOString()}; signal: ${JSON.stringify((text ?? "").slice(0, 200))}`,
    );
  }
  if (reading || now - lastReadAt < READ_INTERVAL_MS) return;
  lastReadAt = now;
  reading = readSendBlock()
    .then((resetsAt) => {
      if (resetsAt && resetsAt + RESET_MARGIN_MS > blockedUntil) {
        blockedUntil = resetsAt + RESET_MARGIN_MS;
        saveHold();
        logWarn(`ChatGPT published a send-block reset at ${new Date(resetsAt).toISOString()}; hold extended to it`);
      } else if (resetsAt === null) {
        logInfo("ChatGPT usage-limit signal: conversation/init publishes no send block; the escalating hold stands");
      }
    })
    // The one owned boundary of this background task: a broken read is reported as an error and
    // the hold above, already in force, is left closed.
    .catch((error: unknown) => logError(`could not read ChatGPT's usage limit; the escalating hold stands: ${String(error)}`))
    .finally(() => {
      reading = null;
    });
}

/**
 * The owner-provisioned ChatGPT browser session (mode 600). On the current frontend the page's
 * own /api/auth/session answers 403 to scripts, so the backend is read with this credential
 * directly: no browser tab, and so no race with the tab reaper.
 */
const SESSION_FILE = `${process.env.HOME}/.config/chat-on-steroids/chatgpt-session.json`;

function sessionHeaders(): Record<string, string> {
  const session = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as {
    accessToken: string;
    accountId: string;
    cookies: Record<string, string>;
    expires: string;
  };
  assert(typeof session.accessToken === "string", `${SESSION_FILE} carries an accessToken`);
  assert(Date.parse(session.expires) > Date.now(), `${SESSION_FILE} has not expired (${session.expires})`);
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "ChatGPT-Account-Id": session.accountId,
    Cookie: Object.entries(session.cookies).map(([name, value]) => `${name}=${value}`).join("; "),
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
  };
}

/** The `send` block's reset time (epoch ms), null when sends are open. */
export async function readSendBlock(): Promise<number | null> {
  const response = await fetch("https://chatgpt.com/backend-api/conversation/init", {
    method: "POST",
    headers: sessionHeaders(),
    body: JSON.stringify({ gizmo_id: null, requested_default_model: null, conversation_id: null, timezone_offset_min: 0 }),
  });
  assert.equal(response.status, 200, "conversation/init answers 200");
  const body = (await response.json()) as { blocked_features?: unknown };
  assert(Array.isArray(body.blocked_features), "conversation/init carries a blocked_features list");
  const send = (body.blocked_features as Array<{ name: string; resets_after: string }>).find((feature) => feature.name === "send");
  if (send === undefined) return null; // the send feature is not blocked: sends are open
  const resetsAt = Date.parse(send.resets_after);
  assert(!Number.isNaN(resetsAt), `resets_after is a timestamp: ${send.resets_after}`);
  return resetsAt;
}
