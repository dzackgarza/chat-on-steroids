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
 * Shell commands are watched too. Around every `exec_command` / `write_stdin` the workspace's
 * git tree is compared with the HEAD from before the command (so a commit made inside the
 * command hides nothing). A name minted that way with no record becomes pending, and every
 * tool except reading ones and `reuse_record` is refused until `reuse_record` supplies the
 * same verified entries on its next apply_patch (a separate tool would change the connector's
 * published shape, which ChatGPT does not re-discover mid-conversation).
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

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

const run = promisify(execFile);
/** Per conversation: names covered by an accepted record, and names minted by a command with none. */
const accounted = new Map<string, Set<string>>();
const pending = new Map<string, Set<string>>();

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
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

const HOW =
  "Before minting anything, search for what the repository already owns: the concept, its mathematical or " +
  "domain name, likely owners and base classes, not the name you are about to invent.";

function recordProblems(key: string, minted: readonly string[], record: readonly ReuseSearchEntry[]): string[] {
  const ran = searches.get(key) ?? [];
  const problems: string[] = [];
  const covered = new Set(record.flatMap((entry) => entry.names));
  const uncovered = minted.filter((name) => !covered.has(name));
  if (uncovered.length > 0) problems.push(`no reuse_search entry names ${uncovered.join(", ")}`);
  const inventedNames = minted
    .map((name) => name.split("/").pop()!.replace(/\.[a-z]+$/, ""))
    .filter((name) => name.length >= 4);
  for (const entry of record) {
    const label = entry.names.join(", ") || "(an entry with no names)";
    if (!entry.found.trim() || !entry.why_new.trim()) problems.push(`${label}: found and why_new must both be filled in`);
    const counted = entry.searched.filter((query) => {
      const wanted = normalise(query);
      if (!wanted || inventedNames.some((name) => wanted.includes(name))) return false;
      return ran.some((done) => done.includes(wanted));
    });
    if (counted.length === 0)
      problems.push(
        `${label}: none of its searched entries matches a search this chat ran (a find call or an rg/grep/fd/ast-grep/probe command), ` +
          "excluding searches for the new name itself",
      );
  }
  return problems;
}

/** Null when the patch may proceed; otherwise the refusal text. */
export function reuseGateRefusal(hunks: readonly Hunk[], record: readonly ReuseSearchEntry[] | undefined): string | null {
  const key = readerKey();
  if (!key) return null;
  const done = accounted.get(key);
  const minted = mintedNames(hunks).filter((name) => !done?.has(name));
  if (minted.length === 0) return null;
  const how = `${HOW} Then send the same patch with reuse_search: [{names, searched, found, why_new}], one entry per new name or group of names.`;
  if (!record || record.length === 0)
    return `REUSE_SEARCH_REQUIRED: this patch adds ${minted.join(", ")}, so it was not applied. ${how}`;
  const problems = recordProblems(key, minted, record);
  if (problems.length > 0)
    return (
      `REUSE_SEARCH_REJECTED: this patch adds ${minted.join(", ")}, and its reuse_search record does not hold, so it was not applied: ` +
      `${problems.join("; ")}. ${how} Quote each search exactly as you ran it.`
    );
  for (const name of minted) setFor(accounted, key).add(name);
  return null;
}

/** Lets an apply_patch reuse_search also settle names a shell command minted. Null on success. */
export function settlePendingThroughPatch(record: readonly ReuseSearchEntry[] | undefined): string | null {
  const key = readerKey();
  if (!key || !pending.get(key)?.size) return null;
  if (!record?.length) return reusePendingRefusal("apply_patch", {});
  const accepted = acceptReuseRecord(record);
  return accepted.ok ? null : accepted.text;
}

// ------------------------------------------------------------------ shell-made definitions

interface Snapshot {
  key: string;
  root: string;
  base: string;
  before: Set<string>;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  return stdout;
}

/** Definition names and new code files in the working tree relative to `base`. */
export async function worktreeMinted(root: string, base: string): Promise<Set<string>> {
  const minted = new Set<string>();
  const diff = await git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", base, "--"]);
  let path = "";
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line.startsWith("+++ b/") ? line.slice(6) : "";
      continue;
    }
    if (line.startsWith("--- ") || !path || !CODE_FILE.test(path) || TEST_FILE.test(path)) continue;
    const pattern = definitionPattern(path);
    if (!pattern || !(line.startsWith("+") || line.startsWith("-"))) continue;
    const match = pattern.exec(line.slice(1));
    if (!match?.[1] || exempt(match[1])) continue;
    setFor(line.startsWith("+") ? added : removed, path).add(match[1]);
  }
  for (const [file, names] of added) for (const name of names) if (!removed.get(file)?.has(name)) minted.add(name);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of untracked) {
    if (!CODE_FILE.test(file) || TEST_FILE.test(file)) continue;
    minted.add(file);
    const pattern = definitionPattern(file);
    const text = pattern ? await readFile(`${root}/${file}`, "utf8").catch(() => "") : "";
    if (pattern) for (const name of names(text.slice(0, 1_000_000).split("\n"), pattern)) if (!exempt(name)) minted.add(name);
  }
  return minted;
}

/** Taken before a shell command runs in a workstream. Null when there is nothing to watch. */
export async function snapshotBeforeCommand(root: string | null): Promise<Snapshot | null> {
  const key = readerKey();
  if (!key || !root) return null;
  try {
    const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
    const base = (await git(top, ["rev-parse", "HEAD"])).trim();
    return { key, root: top, base, before: await worktreeMinted(top, base) };
  } catch {
    return null;
  }
}

/** After the command: names it minted with no record become pending for this conversation. */
export async function noteCommandMinted(snapshot: Snapshot | null): Promise<string[]> {
  if (!snapshot) return [];
  let after: Set<string>;
  try {
    after = await worktreeMinted(snapshot.root, snapshot.base);
  } catch {
    return [];
  }
  const done = accounted.get(snapshot.key);
  const fresh = [...after].filter((name) => !snapshot.before.has(name) && !done?.has(name));
  for (const name of fresh) setFor(pending, snapshot.key).add(name);
  return fresh;
}

/** Refusal while shell-minted names await their record; null otherwise. */
export function reusePendingRefusal(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "read" || tool === "find" || tool === "view_image") return null;
  // The record for shell-made names travels on the next apply_patch.
  if (tool === "apply_patch" && Array.isArray(args["reuse_search"])) return null;
  const key = readerKey();
  const waiting = key ? pending.get(key) : undefined;
  if (!waiting || waiting.size === 0) return null;
  return (
    `REUSE_SEARCH_PENDING: a command you ran added ${[...waiting].join(", ")} with no reuse record, so nothing was run. ` +
    `${HOW} Then call apply_patch with a reuse_search whose entries cover those names (the patch may be the next edit you ` +
    "were going to make, or a one-line comment change). If the addition was a mistake, " +
    "revert it and say so in why_new. read and find stay available meanwhile."
  );
}

/** The reuse_record tool: accepts a verified record for the pending names. */
export function acceptReuseRecord(record: readonly ReuseSearchEntry[]): { ok: true; text: string } | { ok: false; text: string } {
  const key = readerKey();
  if (!key) return { ok: false, text: "reuse_record works only inside a claimed workstream." };
  const waiting = [...(pending.get(key) ?? [])];
  if (waiting.length === 0) return { ok: true, text: "Nothing is pending; no record was needed." };
  const problems = recordProblems(key, waiting, record);
  if (problems.length > 0)
    return { ok: false, text: `REUSE_SEARCH_REJECTED: ${problems.join("; ")}. ${HOW} Quote each search exactly as you ran it.` };
  for (const name of waiting) setFor(accounted, key).add(name);
  pending.delete(key);
  return { ok: true, text: `Recorded. ${waiting.join(", ")} are accounted for; continue.` };
}
