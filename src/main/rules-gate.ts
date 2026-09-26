/**
 * A workstream's chat must read its repository's AGENTS.md before it may act.
 *
 * Nothing else guarantees that a chat has seen the rules it is working under. A fresh chat is
 * told "read AGENTS.md", and whether it does is up to the model; replacement chats reached for
 * the TODO first and worked for hours against rules they had never opened. So the rules file
 * is a gate. Until every line of `<workspace>/AGENTS.md` has been returned to this conversation
 * by the `read` tool, any tool that can act (exec, patch, agents) is refused with the ranges
 * still unread. Reading tools stay open, since reading is how the gate is passed.
 *
 * Coverage belongs to the conversation, not to the claim. A chat that re-attaches after a
 * restart or recovery has the file in its context already; a replacement chat does not.
 * Coverage is durable (`rules-coverage`): forcing every chat to re-read a 200 KB file after
 * each app restart was pure load on the account, and ChatGPT flagged it as unusual activity.
 */

import { realpath } from "node:fs/promises";

import { readDurable, writeDurableSoon } from "./durable.js";
import { currentCall } from "./mcp/call-context.js";
import { workstreamConversation, workstreamWorkspace } from "./workstreams.js";

/** Tools that only read. They stay available so the rules can be read at all. */
export const RULES_EXEMPT_TOOLS = new Set(["read", "find", "view_image"]);

interface Coverage {
  /** Real path of the rules file this coverage is for. */
  path: string;
  totalLines: number | null;
  /** Disjoint, sorted, inclusive line intervals already returned to this conversation. */
  read: Array<[number, number]>;
}

const coverage = new Map<string, Coverage>();
let loaded: Promise<void> | null = null;

/** Loads the durable coverage once per app lifetime. */
function load(): Promise<void> {
  loaded ??= readDurable<Record<string, Coverage>>("rules-coverage").then((saved) => {
    for (const [key, entry] of Object.entries(saved ?? {})) if (!coverage.has(key)) coverage.set(key, entry);
  });
  return loaded;
}

function save(): void {
  writeDurableSoon("rules-coverage", Object.fromEntries(coverage));
}

function readerKey(workstreamId: string, claimId: string | null, realPath: string): string {
  const reader = workstreamConversation(workstreamId) ?? `claim:${claimId ?? ""}`;
  return `${workstreamId}\u0000${reader}\u0000${realPath}`;
}

function addInterval(read: Array<[number, number]>, first: number, last: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [a, b] of [...read, [first, last] as [number, number]].sort((x, y) => x[0] - y[0])) {
    const tail = merged[merged.length - 1];
    if (tail && a <= tail[1] + 1) tail[1] = Math.max(tail[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function unread(entry: Coverage): Array<[number, number]> {
  const total = entry.totalLines;
  if (total === null) return [[1, Number.POSITIVE_INFINITY]];
  const gaps: Array<[number, number]> = [];
  let next = 1;
  for (const [a, b] of entry.read) {
    if (a > next) gaps.push([next, Math.min(a - 1, total)]);
    next = Math.max(next, b + 1);
  }
  if (next <= total) gaps.push([next, total]);
  return gaps;
}

/** The virtual path of the rules file for a workstream, or null when it has none. */
function rulesVirtualPath(workstreamId: string): string | null {
  const workspace = workstreamWorkspace(workstreamId);
  return workspace ? `${workspace.replace(/\/+$/, "")}/AGENTS.md` : null;
}

/**
 * Records lines the `read` tool returned. Called for every text section it produces; only the
 * calling workstream's own rules file counts.
 */
export async function noteRulesRead(realPath: string, first: number, last: number, totalLines: number | null): Promise<void> {
  const call = currentCall();
  if (!call?.workstreamId || last < first || !realPath.endsWith("/AGENTS.md")) return;
  await load();
  const path = (await realpath(realPath).catch(() => null)) ?? realPath;
  const key = readerKey(call.workstreamId, call.workstreamClaimId, path);
  const prior = coverage.get(key) ?? { path, totalLines, read: [] };
  coverage.set(key, {
    path,
    totalLines: totalLines ?? prior.totalLines,
    read: addInterval(prior.read, first, last),
  });
  save();
}

/**
 * Null when the calling workstream may act; otherwise the refusal text, naming what is unread.
 *
 * `resolveRules` maps the virtual rules path to its real path, or null when the workspace has
 * no AGENTS.md (then there is nothing to gate on).
 */
export async function rulesGateRefusal(
  tool: string,
  resolveRules: (virtualPath: string) => Promise<string | null>,
): Promise<string | null> {
  if (RULES_EXEMPT_TOOLS.has(tool)) return null;
  const call = currentCall();
  if (!call?.workstreamId) return null;
  const virtual = rulesVirtualPath(call.workstreamId);
  if (!virtual) return null;
  const resolved = await resolveRules(virtual);
  if (!resolved) return null;
  await load();
  const real = (await realpath(resolved).catch(() => null)) ?? resolved;
  const current = coverage.get(readerKey(call.workstreamId, call.workstreamClaimId, real)) ?? {
    path: real,
    totalLines: null,
    read: [],
  };
  const gaps = unread(current);
  if (gaps.length === 0) return null;
  const ranges = gaps
    .map(([a, b]) => (Number.isFinite(b) ? `${a}-${b}` : `${a} to the end`))
    .join(", ");
  const size = current.totalLines ? ` (${current.totalLines} lines)` : "";
  return (
    `RULES_UNREAD: this workstream's rules are in ${virtual}${size}, and this chat has not read all of them yet, ` +
    `so nothing was run. Your next call is read with paths=["${virtual}"] and start_line=${gaps[0]![0]}: make it now, in this ` +
    `turn, without stopping; each result says where to continue. Still unread: lines ${ranges}. Then repeat this call and carry on. ` +
    "This is a step to do, not a blocker to report: never end your turn on it. read, find and view_image stay available."
  );
}
