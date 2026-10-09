/**
 * Keep rack's ChatGPT browser session current (MIGRATION-TO-REMOTE-RACK.md §7).
 *
 * Rack's daemon reads ~/.config/chat-on-steroids/chatgpt-session.json for its usage-limit
 * checks. The file's accessToken is a JWT, and the browser renews it near its expiry. This
 * script, run hourly by the systemd user timer in scripts/systemd/, decodes the expiry of the
 * token rack holds and exits while more than REFRESH_LEAD_MS remains. Inside that window it
 * reads the session out of the local Chromium (opening Chromium, or a ChatGPT tab in it, when
 * there is none) and, once the browser holds a renewed token, writes the file, proves it with
 * the daemon's own usage-limit read, and copies it to rack. So the copy happens once per token
 * lifetime, and a bad read fails before anything leaves this machine.
 *
 * The local file is the record of what rack holds: this script writes it and copies it in one
 * step, and nothing else writes either copy.
 *
 * Run from the repository root: node node_modules/tsx/dist/cli.mjs scripts/sync-rack-session.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { readSendBlock } from "../src/main/chatgpt-limits.js";

const DEVTOOLS = "http://127.0.0.1:9222";
/** The owner's chromium.desktop Exec line: the browser that holds the ChatGPT login. */
const CHROMIUM = ["/usr/bin/chromium", "--remote-debugging-port=9222"];
const CHATGPT = "https://chatgpt.com/";
const SESSION_FILE = `${homedir()}/.config/chat-on-steroids/chatgpt-session.json`;
const RACK = "dzack@rack";
const RACK_SESSION_FILE = ".config/chat-on-steroids/chatgpt-session.json";
/** Start watching the browser for a renewed token when rack's has this much life left. */
const REFRESH_LEAD_MS = 24 * 60 * 60_000;
const BROWSER_START_MS = 60_000;
const PAGE_LOAD_MS = 60_000;

type DevToolsTarget = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
type Cookie = { name: string; value: string };
/** What chatgpt.com's /api/auth/session answers to its own page. */
type AuthSession = { accessToken?: string; expires: string; account: { id: string }; user: { email: string } };
type Evaluated = { result: { value: AuthSession }; exceptionDetails?: { text: string } };
type CdpParams = Record<string, string[] | string | boolean>;
/** A CDP reply's `result` is shaped per method; each call names the shape it reads. */
type CdpResult = ReturnType<typeof JSON.parse>;
type CdpReply = { id: number; result?: CdpResult; error?: { message: string } };

const iso = (ms: number): string => new Date(ms).toISOString();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Expiry (epoch ms) from the JWT's own `exp` claim. */
function tokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  assert(payload, "the access token is a JWT");
  const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
  return exp * 1000;
}

/** The token rack holds, from the local record; null before the first copy. */
function heldToken(): string | null {
  if (!existsSync(SESSION_FILE)) return null;
  return (JSON.parse(readFileSync(SESSION_FILE, "utf8")) as { accessToken: string }).accessToken;
}

/** DevTools' target list, or null when nothing listens on the port. */
async function devtoolsTargets(): Promise<DevToolsTarget[] | null> {
  try {
    return (await (await fetch(`${DEVTOOLS}/json`)).json()) as DevToolsTarget[];
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") return null;
    throw error;
  }
}

/** Start the owner's Chromium in its own transient unit, so it outlives this oneshot. */
async function launchChromium(): Promise<void> {
  const run = spawnSync(
    "systemd-run",
    ["--user", "--collect", "--description=Chromium with DevTools on 9222, opened by chat-on-steroids-rack-session", "--", ...CHROMIUM],
    { stdio: "inherit" },
  );
  assert.equal(run.status, 0, `systemd-run exited with ${run.status}`);
  const deadline = Date.now() + BROWSER_START_MS;
  while ((await devtoolsTargets()) === null) {
    assert(
      Date.now() < deadline,
      `Chromium did not open DevTools on ${DEVTOOLS} within ${BROWSER_START_MS / 1000}s; a Chromium already running without the port takes the launch over`,
    );
    await sleep(500);
  }
}

async function connect(url: string): Promise<{ call<T>(method: string, params?: CdpParams): Promise<T>; close(): void }> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`the CDP socket ${url} did not open`));
  });
  const pending = new Map<number, { resolve: (result: CdpResult) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data)) as CdpReply;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(`CDP ${reply.error.message}`));
    else waiter.resolve(reply.result);
  };
  let nextId = 0;
  return {
    call<T>(method: string, params: CdpParams = {}): Promise<T> {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => socket.close(),
  };
}

/** A ChatGPT tab in the local Chromium, opened when there is none, with its navigation committed. */
async function chatgptPage(): Promise<DevToolsTarget> {
  let targets = await devtoolsTargets();
  if (targets === null) {
    await launchChromium();
    targets = await devtoolsTargets();
    assert(targets, `DevTools answers on ${DEVTOOLS}`);
  }
  const open = targets.find((target) => target.type === "page" && target.url.startsWith(CHATGPT));
  if (open) return open;

  const created = await fetch(`${DEVTOOLS}/json/new?${CHATGPT}`, { method: "PUT" });
  assert.equal(created.status, 200, `DevTools opened a tab (HTTP ${created.status})`);
  const { id } = (await created.json()) as DevToolsTarget;
  const deadline = Date.now() + PAGE_LOAD_MS;
  for (;;) {
    const page = (await devtoolsTargets())?.find((target) => target.id === id);
    assert(page, "the ChatGPT tab is still open");
    if (page.url.startsWith(CHATGPT)) return page;
    assert(Date.now() < deadline, `the new tab did not reach ${CHATGPT} within ${PAGE_LOAD_MS / 1000}s`);
    await sleep(500);
  }
}

async function readSession(page: DevToolsTarget): Promise<{ session: AuthSession; cookies: Cookie[] }> {
  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await cdp.call("Runtime.evaluate", {
      expression: 'new Promise((done) => (document.readyState === "complete" ? done(true) : addEventListener("load", () => done(true))))',
      awaitPromise: true,
      returnByValue: true,
    });
    const { cookies } = await cdp.call<{ cookies: Cookie[] }>("Network.getCookies", { urls: [CHATGPT] });
    const evaluated = await cdp.call<Evaluated>("Runtime.evaluate", {
      expression: 'fetch("/api/auth/session", { credentials: "include" }).then((r) => r.json())',
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!evaluated.exceptionDetails, `/api/auth/session failed in the page: ${evaluated.exceptionDetails?.text}`);
    return { session: evaluated.result.value, cookies };
  } finally {
    cdp.close();
  }
}

async function main(): Promise<void> {
  const held = heldToken();
  const heldExpiry = held === null ? 0 : tokenExpiry(held);
  if (heldExpiry - Date.now() > REFRESH_LEAD_MS) return;

  const { session, cookies } = await readSession(await chatgptPage());
  assert(typeof session.accessToken === "string", "the page's session carries an accessToken");
  if (session.accessToken === held) {
    assert(heldExpiry > Date.now(), `the browser still holds the token that expired at ${iso(heldExpiry)}: log in to ChatGPT again`);
    console.log(`rack's token expires at ${iso(heldExpiry)} and the browser has not renewed it yet`);
    return;
  }

  const file = {
    accessToken: session.accessToken,
    accountId: session.account.id,
    expires: session.expires,
    cookies: Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value])),
  };
  writeFileSync(SESSION_FILE, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SESSION_FILE, 0o600);

  // The daemon's own read of the file just written.
  await readSendBlock();

  const copy = spawnSync("scp", ["-pq", "-o", "BatchMode=yes", SESSION_FILE, `${RACK}:${RACK_SESSION_FILE}`], { stdio: "inherit" });
  assert.equal(copy.status, 0, `scp to ${RACK} exited with ${copy.status}`);
  console.log(`copied to ${RACK}: ${session.user.email}, access token valid until ${iso(tokenExpiry(session.accessToken))}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
