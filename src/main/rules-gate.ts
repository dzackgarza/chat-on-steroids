import assert from "node:assert/strict";
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { readDurable, writeDurableSoon } from "./durable.js";
import { type CallCaller, currentCall } from "./mcp/call-context.js";
import { ORCHESTRATOR_WORKSTREAM_ID, workstreamConversation, workstreamWorkspace } from "./workstreams.js";

export const RULES_EXEMPT_TOOLS = new Set(["read", "find", "view_image"]);

export const STEWARD_JOB_FILE = resolve(__dirname, "..", "..", "docs", "agents", "steward.md");

interface GatedFile {
  real: string;
  named: string;
}

interface Coverage {
  path: string;
  totalLines: number | null;
  read: Array<[number, number]>;
}

const coverage = new Map<string, Coverage>();
let loaded: Promise<void> | null = null;

function load(): Promise<void> {
  loaded ??= readDurable<Record<string, Coverage>>("rules-coverage").then((saved) => {
    for (const [key, entry] of Object.entries(saved ?? {})) if (!coverage.has(key)) coverage.set(key, entry);
  });
  return loaded;
}

function save(): void {
  writeDurableSoon("rules-coverage", Object.fromEntries(coverage));
}

function readerKey(workstreamId: string, claimId: string | null, realPath: string, caller: CallCaller): string {
  const reader =
    workstreamConversation(workstreamId) ??
    caller.conversationId ??
    (caller.sessionKey ? `session:${caller.sessionKey}` : null) ??
    `claim:${claimId ?? ""}`;
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

function rulesVirtualPath(workstreamId: string): string | null {
  const workspace = workstreamWorkspace(workstreamId);
  return workspace ? `${workspace.replace(/\/+$/, "")}/AGENTS.md` : null;
}

function isGatedFile(realPath: string): boolean {
  return realPath.endsWith("/AGENTS.md") || (existsSync(STEWARD_JOB_FILE) && realPath === realpathSync(STEWARD_JOB_FILE));
}

export async function noteRulesRead(realPath: string, first: number, last: number, totalLines: number | null): Promise<void> {
  const call = currentCall();
  if (!call?.workstreamId || last < first || !isGatedFile(realPath)) return;
  await load();
  const path = realPath;
  const key = readerKey(call.workstreamId, call.workstreamClaimId, path, call.caller);
  const prior = coverage.get(key) ?? { path, totalLines, read: [] };
  coverage.set(key, {
    path,
    totalLines: totalLines ?? prior.totalLines,
    read: addInterval(prior.read, first, last),
  });
  save();
}

type RulesFile =
  | { kind: "no-workspace" }
  | { kind: "no-rules-file"; workspace: string }
  | { kind: "rules"; virtual: string; path: string };

async function rulesFileFor(
  workstreamId: string,
  resolveReal: (path: string) => Promise<string>,
): Promise<RulesFile> {
  const workspace = workstreamWorkspace(workstreamId);
  if (workspace === null) return { kind: "no-workspace" };
  const path = join(await resolveReal(workspace), "AGENTS.md");
  const entry = statSync(path, { throwIfNoEntry: false });
  if (entry === undefined) return { kind: "no-rules-file", workspace };
  assert(entry.isFile(), `${path} exists but is not a file`);
  return { kind: "rules", virtual: rulesVirtualPath(workstreamId)!, path };
}

async function requiredFiles(
  workstreamId: string,
  resolveReal: (path: string) => Promise<string>,
): Promise<GatedFile[]> {
  const required: GatedFile[] = [];
  const rules = await rulesFileFor(workstreamId, resolveReal);
  if (rules.kind === "rules") required.push({ real: rules.path, named: rules.virtual });
  if (workstreamId === ORCHESTRATOR_WORKSTREAM_ID) {
    assert(existsSync(STEWARD_JOB_FILE), `the orchestrator's job file ${STEWARD_JOB_FILE} is missing`);
    required.push({ real: await resolveReal(STEWARD_JOB_FILE), named: STEWARD_JOB_FILE });
  }
  return required;
}

function refusal(named: string, entry: Coverage, gaps: Array<[number, number]>): string {
  const ranges = gaps
    .map(([a, b]) => (Number.isFinite(b) ? `${a}-${b}` : `${a} to the end`))
    .join(", ");
  const size = entry.totalLines ? ` (${entry.totalLines} lines)` : "";
  return (
    `RULES_UNREAD: this workstream's rules are in ${named}${size}, and this chat has not read all of them yet, ` +
    `so nothing was run. Your next call is read with paths=["${named}"] and start_line=${gaps[0]![0]}: make it now, in this ` +
    `turn, without stopping; each result says where to continue. Still unread: lines ${ranges}. Then repeat this call and carry on. ` +
    "This is a step to do, not a blocker to report: never end your turn on it. read, find and view_image stay available."
  );
}

export async function rulesGateRefusal(
  tool: string,
  resolveReal: (path: string) => Promise<string>,
): Promise<string | null> {
  if (RULES_EXEMPT_TOOLS.has(tool)) return null;
  const call = currentCall();
  assert(call, "rulesGateRefusal runs inside a tool call's context");
  if (call.workstreamId === null) return null;
  const required = await requiredFiles(call.workstreamId, resolveReal);
  if (required.length === 0) return null;
  await load();
  for (const file of required) {
    const current = coverage.get(readerKey(call.workstreamId, call.workstreamClaimId, file.real, call.caller)) ?? {
      path: file.real,
      totalLines: null,
      read: [],
    };
    const gaps = unread(current);
    if (gaps.length > 0) return refusal(file.named, current, gaps);
  }
  return null;
}
