/**
 * Refresh the ChatGPT browser session that rack's daemon reads (MIGRATION-TO-REMOTE-RACK.md §7).
 *
 * Reads the access token and cookies out of the local Chrome over CDP, writes
 * ~/.config/chat-on-steroids/chatgpt-session.json, proves the file with the daemon's own
 * usage-limit read, and only then copies it to rack. The access token is a ten-day JWT that
 * the browser renews near its expiry, so the systemd user timer in scripts/systemd/ runs this
 * hourly and rack stays within an hour of the browser. A bad read fails here and never leaves
 * this machine.
 *
 * Run from the repository root: node node_modules/tsx/dist/cli.mjs scripts/sync-rack-session.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { readSendBlock } from "../src/main/chatgpt-limits.js";

const DEVTOOLS = "http://127.0.0.1:9222";
const SESSION_FILE = `${homedir()}/.config/chat-on-steroids/chatgpt-session.json`;
const RACK = "dzack@rack";
const RACK_SESSION_FILE = ".config/chat-on-steroids/chatgpt-session.json";

type DevToolsTarget = { type: string; url: string; webSocketDebuggerUrl: string };
type Cookie = { name: string; value: string };
/** What chatgpt.com's /api/auth/session answers to its own page. */
type AuthSession = { accessToken?: string; expires: string; account: { id: string }; user: { email: string } };
type Evaluated = { result: { value: AuthSession }; exceptionDetails?: { text: string } };
/** A CDP reply's `result` is shaped per method; each call names the shape it reads. */
type CdpResult = ReturnType<typeof JSON.parse>;
type CdpReply = { id: number; result?: CdpResult; error?: { message: string } };

async function main(): Promise<void> {
  const targets = (await (await fetch(`${DEVTOOLS}/json`)).json()) as DevToolsTarget[];
  const page = targets.find((target) => target.type === "page" && target.url.startsWith("https://chatgpt.com/"));
  assert(page, `a ChatGPT tab is open in the Chrome at ${DEVTOOLS}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`the CDP socket of ${page.url} did not open`));
  });
  const pending = new Map<number, { resolve: (result: CdpResult) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data)) as CdpReply;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(`CDP: ${reply.error.message}`));
    else waiter.resolve(reply.result);
  };
  let nextId = 0;
  function cdp<T>(method: string, params: Record<string, string[] | string | boolean>): Promise<T> {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  const { cookies } = await cdp<{ cookies: Cookie[] }>("Network.getCookies", { urls: ["https://chatgpt.com"] });
  const evaluated = await cdp<Evaluated>("Runtime.evaluate", {
    expression: 'fetch("/api/auth/session", { credentials: "include" }).then((r) => r.json())',
    awaitPromise: true,
    returnByValue: true,
  });
  socket.close();
  assert(!evaluated.exceptionDetails, `/api/auth/session failed in the page: ${evaluated.exceptionDetails?.text}`);
  const session = evaluated.result.value;
  assert(typeof session.accessToken === "string", "the page's session carries an accessToken");

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

  const payload = session.accessToken.split(".")[1];
  assert(payload, "the access token is a JWT");
  const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
  console.log(`copied to ${RACK}: ${session.user.email}, access token valid until ${new Date(exp * 1000).toISOString()}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
