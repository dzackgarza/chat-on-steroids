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
 * The read runs inside the managed Chrome over its DevTools port, in a chatgpt.com page (an
 * existing one when available, otherwise a short-lived tab), with the page's own session.
 */

import { logInfo, logWarn } from "./logger.js";

const DEVTOOLS = `http://127.0.0.1:${process.env.CHROME_DEVTOOLS_PORT || "9222"}`;
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

let blockedUntil = 0;
let lastReadAt = 0;
let reading: Promise<void> | null = null;
/** Escalation: consecutive limit episodes hold longer. */
let strikes = 0;
let lastStrikeAt = 0;
/** First hold, doubling per strike up to the cap. */
const FIRST_HOLD_MS = 15 * 60_000;
const MAX_HOLD_MS = 4 * 60 * 60_000;
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
export function noteUsageLimitSignal(text: string | null | undefined): void {
  if (!isUsageLimitText(text)) return;
  const now = Date.now();
  if (now - lastStrikeAt > STRIKE_RESET_MS) strikes = 0;
  if (now - lastStrikeAt >= STRIKE_DEBOUNCE_MS) {
    strikes++;
    lastStrikeAt = now;
    const hold = Math.min(MAX_HOLD_MS, FIRST_HOLD_MS * 2 ** (strikes - 1));
    blockedUntil = Math.max(blockedUntil, now + hold);
    logWarn(
      `ChatGPT usage limit (strike ${strikes}): holding every send until ${new Date(blockedUntil).toISOString()}`,
    );
  }
  if (reading || now - lastReadAt < READ_INTERVAL_MS) return;
  lastReadAt = now;
  reading = readSendBlock()
    .then((resetsAt) => {
      if (resetsAt && resetsAt + RESET_MARGIN_MS > blockedUntil) {
        blockedUntil = resetsAt + RESET_MARGIN_MS;
        logWarn(`ChatGPT published a send-block reset at ${new Date(resetsAt).toISOString()}; hold extended to it`);
      } else if (resetsAt === null) {
        logInfo("ChatGPT usage-limit signal: conversation/init publishes no send block; the escalating hold stands");
      }
    })
    .catch((error: unknown) => logWarn(`could not read ChatGPT's usage limit (hold stands): ${String(error)}`))
    .finally(() => {
      reading = null;
    });
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The `send` block's reset time (epoch ms), null when sends are not blocked. */
export async function readSendBlock(): Promise<number | null> {
  const targets = (await (await fetch(`${DEVTOOLS}/json/list`)).json()) as Target[];
  let page = targets.find((t) => t.type === "page" && t.url.startsWith("https://chatgpt.com/"));
  let temporary: Target | null = null;
  if (!page) {
    temporary = (await (await fetch(`${DEVTOOLS}/json/new?https://chatgpt.com/`, { method: "PUT" })).json()) as Target;
    page = temporary;
  }
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
        const mine = ++id;
        const onMessage = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as { id?: number };
          if (message.id !== mine) return;
          ws.removeEventListener("message", onMessage);
          resolve(message as never);
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({ id: mine, method, params }));
      });
    const expression = `(async () => {
      for (let i = 0; i < 30 && location.origin !== 'https://chatgpt.com'; i++) await new Promise(r => setTimeout(r, 500));
      const session = await fetch('/api/auth/session').then(r => r.json());
      const response = await fetch('/backend-api/conversation/init', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gizmo_id: null, requested_default_model: null, conversation_id: null, timezone_offset_min: 0 }),
      });
      const body = await response.json();
      const send = (body.blocked_features || []).find(f => f.name === 'send');
      return send ? send.resets_after : null;
    })()`;
    if (temporary) await new Promise((resolve) => setTimeout(resolve, 8000));
    const reply = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    ws.close();
    const value = reply.result?.result?.value;
    return typeof value === "string" ? Date.parse(value) : null;
  } finally {
    if (temporary) await fetch(`${DEVTOOLS}/json/close/${temporary.id}`).catch(() => undefined);
  }
}
