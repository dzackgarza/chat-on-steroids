/**
 * Whether ChatGPT holds the tool schema this app serves.
 *
 * ChatGPT keeps its own snapshot of a connector's `tools/list` and only re-reads it when the
 * owner refreshes the app in ChatGPT's settings. A chat works against that snapshot: after
 * d002ef1 added `reuse_search` to `apply_patch`, only 9 of 48 patches carried it while the
 * reuse gate demanded it, and the fleet was set to work without anyone checking the chats
 * could do what the gates asked. This module records two facts and compares them:
 *
 * - served: a fingerprint of the Core `tools/list` this process answers, taken through the
 *   handler itself;
 * - fetched: the fingerprint of what the handler answered when ChatGPT (a request through the
 *   public tunnel) last asked for `tools/list`.
 *
 * Different fingerprints mean the chats hold an old schema, and workstream sends are held until
 * the owner refreshes the app.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { readDurable, writeDurableSoon } from "./durable.js";
import { logInfo, logWarn } from "./logger.js";

type Fetch = {
  fingerprint: string;
  at: number;
  via: "tunnel-tools-list";
};

export type SchemaState =
  | { kind: "unknown" }
  | { kind: "current"; served: string; fetchedAt: number }
  | { kind: "stale"; served: string; fetched: Fetch | null };

const DURABLE = "connector-schema-fetch";

let served: string | null = null;
let fetched: Fetch | null = null;
let listCore: (() => Promise<unknown>) | null = null;
let staleSince: number | null = null;

/** The canonical fingerprint of a tools/list result. */
function fingerprint(result: unknown): string {
  assert(result !== null && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools), "tools/list answers a tools array");
  const tools = (result as { tools: Array<{ name: string }> }).tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
}

/**
 * Called once the Core handler exists. `list` asks the handler for its tools/list exactly as a
 * client would, so the fingerprint is of what is actually served.
 */
export async function trackCoreSchema(list: () => Promise<unknown>): Promise<void> {
  listCore = list;
  const restored = await readDurable<Partial<Fetch>>(DURABLE);
  fetched =
    restored?.via === "tunnel-tools-list" &&
    typeof restored.fingerprint === "string" &&
    typeof restored.at === "number"
      ? (restored as Fetch)
      : null;
  served = fingerprint(await list());
  const state = schemaState();
  logWarn(`connector schema: serving Core ${served}; ${describe(state)}`);
}

/** ChatGPT asked for tools/list on Core: what it now holds is what the handler serves now. */
export async function noteChatGptListing(): Promise<void> {
  assert(listCore, "trackCoreSchema ran before the first request");
  served = fingerprint(await listCore());
  fetched = { fingerprint: served, at: Date.now(), via: "tunnel-tools-list" };
  writeDurableSoon(DURABLE, fetched);
  if (staleSince !== null) logWarn(`connector schema: ChatGPT fetched Core ${served}; workstream sends resume`);
  else logInfo(`connector schema: ChatGPT fetched Core ${served}`);
  staleSince = null;
}

export function schemaState(): SchemaState {
  if (served === null) return { kind: "unknown" };
  if (fetched !== null && fetched.fingerprint === served) return { kind: "current", served, fetchedAt: fetched.at };
  return { kind: "stale", served, fetched };
}

function describe(state: SchemaState): string {
  switch (state.kind) {
    case "unknown":
      return "not fingerprinted yet";
    case "current":
      return `ChatGPT fetched it at ${new Date(state.fetchedAt).toISOString()}`;
    case "stale":
      return state.fetched === null
        ? "ChatGPT has never fetched it through this app"
        : `ChatGPT last fetched ${state.fetched.fingerprint} at ${new Date(state.fetched.at).toISOString()}`;
  }
}

/**
 * Whether a workstream send must wait for the owner to refresh the app. Logs once per stale
 * episode, with the exact action that ends it.
 */
export function workstreamSendsHeldBySchema(now = Date.now()): boolean {
  const state = schemaState();
  if (state.kind !== "stale") return state.kind === "unknown";
  if (staleSince === null) {
    staleSince = now;
    logWarn(
      `connector schema: ChatGPT holds an old Core tool schema (${describe(state)}; serving ${state.served}). ` +
        "Workstream sends are held: refresh the app in ChatGPT (Settings → Apps → the Core app → Refresh).",
    );
  }
  return true;
}
