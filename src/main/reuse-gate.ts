/**
 * A patch that mints a new definition or code file must show the search that ruled out reuse.
 *
 * The recurring failure: "I couldn't immediately find X" (often without searching at all)
 * becomes "I will write a custom Y", and the repository accumulates parallel classes, helpers
 * and files for things it already owns. Repository rules already say "search before adding";
 * nothing made a chat do it. So a patch that adds a new top-level name (class, function,
 * method, Lean declaration, …) or a new code file is refused unless it carries `reuse_search`:
 * for every minted name, the searches run, what they found, and why none of it is reused.
 *
 * Each listed search must be one this conversation actually ran — a `find` call or a search
 * command (rg, grep, git grep, fd, ast-grep, probe, …) through `exec_command`. A search for the
 * new name itself does not count: nothing can be found under a name that was just invented.
 * The app checks that the searches happened; whether they were adequate is read by whoever
 * reviews the record, which the session recorder keeps with the patch arguments.
 *
 * Files created by shell commands inside `exec_command` do not pass through here; that route
 * is a known gap, visible in git as a new file with no reuse record.
 */

import { currentCall } from "./mcp/call-context.js";
import type { Hunk } from "./codex/apply-patch/index.js";
import { workstreamConversation } from "./workstreams.js";

export interface ReuseSearchEntry {
  /** The new names (or new file paths) this entry accounts for. */
  names: string[];
  /** Searches actually run in this chat, quoted as run (a find query or the search command). */
  searched: string[];
  /** Existing code the searches turned up, with paths; "nothing relevant" if they found none. */
  found: string;
  /** Why none of what was found is reused or extended instead. */
  why_new: string;
}

const SEARCH_COMMAND = /(^|[\s;&|(])(rg|grep|egrep|git\s+grep|fd|fdfind|find|ast-grep|sg|probe|ack|ag|loogle|just\s+placement)(\s|$)/;
const searches = new Map<string, string[]>();

function readerKey(): string | null {
  const call = currentCall();
  if (!call?.workstreamId) return null;
  const reader = workstreamConversation(call.workstreamId) ?? `claim:${call.workstreamClaimId ?? ""}`;
  return `${call.workstreamId}\u0000${reader}`;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Records a search this conversation ran. `find` arguments always count; commands only when they search. */
export function noteSearch(tool: string, args: Record<string, unknown>): void {
  const key = readerKey();
  if (!key) return;
  const texts: string[] = [];
  if (tool === "find") {
    for (const value of Object.values(args)) {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) texts.push(...value.filter((item): item is string => typeof item === "string"));
    }
  } else if (tool === "exec_command") {
    const commands = [args["cmd"], ...(Array.isArray(args["cmds"]) ? args["cmds"] : [])];
    for (const command of commands) if (typeof command === "string" && SEARCH_COMMAND.test(command)) texts.push(command);
  }
  if (texts.length === 0) return;
  const list = searches.get(key) ?? [];
  list.push(...texts.map(normalise));
  searches.set(key, list.slice(-2000));
}

const CODE_FILE = /\.(py|pyi|sage|ts|tsx|js|jsx|mjs|cjs|lean|rs)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[a-z]+$/;

function definitionPattern(path: string): RegExp | null {
  if (/\.(py|pyi|sage)$/.test(path)) return /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path))
    return /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
  if (/\.lean$/.test(path))
    return /^\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|partial|unsafe|nonrec)\s+)*(?:def|theorem|lemma|structure|class|inductive|instance|abbrev)\s+([^\s:({[]+)/;
  if (/\.rs$/.test(path)) return /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/;
  return null;
}

function names(lines: readonly string[], pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1]) found.add(match[1]);
  }
  return found;
}

function exempt(name: string): boolean {
  return /^__\w+__$/.test(name) || /^test(_|[A-Z0-9]|$)/.test(name);
}

/** New code files and definition names a patch introduces, excluding tests and protocol methods. */
export function mintedNames(hunks: readonly Hunk[]): string[] {
  const minted: string[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === "delete_file") continue;
    const path = hunk.kind === "update_file" ? (hunk.movePath ?? hunk.path) : hunk.path;
    if (!CODE_FILE.test(path) || TEST_FILE.test(path)) continue;
    const pattern = definitionPattern(path);
    if (hunk.kind === "add_file") {
      minted.push(path);
      if (pattern) for (const name of names(hunk.contents.split("\n"), pattern)) if (!exempt(name)) minted.push(name);
      continue;
    }
    if (!pattern) continue;
    const removed = names(hunk.chunks.flatMap((chunk) => chunk.oldLines), pattern);
    const added = names(hunk.chunks.flatMap((chunk) => chunk.newLines), pattern);
    for (const name of added) if (!removed.has(name) && !exempt(name)) minted.push(name);
  }
  return [...new Set(minted)];
}

/** Null when the patch may proceed; otherwise the refusal text. */
export function reuseGateRefusal(hunks: readonly Hunk[], record: readonly ReuseSearchEntry[] | undefined): string | null {
  const key = readerKey();
  if (!key) return null;
  const minted = mintedNames(hunks);
  if (minted.length === 0) return null;
  const how =
    "Before minting anything, search for what the repository already owns: the concept, its mathematical or " +
    "domain name, likely owners and base classes, not the name you are about to invent. Then send the same patch " +
    "with reuse_search: [{names, searched, found, why_new}], one entry per new name or group of names.";
  if (!record || record.length === 0)
    return `REUSE_SEARCH_REQUIRED: this patch adds ${minted.join(", ")}, so it was not applied. ${how}`;
  const ran = searches.get(key) ?? [];
  const problems: string[] = [];
  const covered = new Set(record.flatMap((entry) => entry.names));
  const uncovered = minted.filter((name) => !covered.has(name));
  if (uncovered.length > 0) problems.push(`no reuse_search entry names ${uncovered.join(", ")}`);
  for (const entry of record) {
    const label = entry.names.join(", ") || "(an entry with no names)";
    if (!entry.found.trim() || !entry.why_new.trim()) problems.push(`${label}: found and why_new must both be filled in`);
    const counted = entry.searched.filter((query) => {
      const wanted = normalise(query);
      if (!wanted) return false;
      const inventedNames = minted.map((name) => name.split("/").pop()!.replace(/\.[a-z]+$/, "")).filter((name) => name.length >= 4);
      if (inventedNames.some((name) => wanted.includes(name))) return false;
      return ran.some((done) => done.includes(wanted));
    });
    if (counted.length === 0)
      problems.push(
        `${label}: none of its searched entries matches a search this chat ran (a find call or an rg/grep/fd/ast-grep/probe command), ` +
          "excluding searches for the new name itself",
      );
  }
  if (problems.length === 0) return null;
  return (
    `REUSE_SEARCH_REJECTED: this patch adds ${minted.join(", ")}, and its reuse_search record does not hold, so it was not applied: ` +
    `${problems.join("; ")}. ${how} Quote each search exactly as you ran it.`
  );
}
