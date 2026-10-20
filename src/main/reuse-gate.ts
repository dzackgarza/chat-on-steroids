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
 * Each listed search must be one this conversation actually ran — a `find` call. A search for the
 * new name itself does not count: nothing can be found under a name that was just invented.
 * The app checks that the searches happened; whether they were adequate is read by whoever
 * reviews the record, which the session recorder keeps with the patch arguments.
 *
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { repositoryCommand } from "./managed-execution.js";
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

/** Per conversation: names covered by an accepted patch record. */
const accounted = new Map<string, Set<string>>();

function setFor(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}

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

/** Records a search this conversation ran. Only structured `find` requests count. */
export function noteSearch(tool: string, args: Record<string, unknown>): void {
  const key = readerKey();
  if (!key) return;
  const texts: string[] = [];
  if (tool === "find") {
    for (const value of Object.values(args)) {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) texts.push(...value.filter((item): item is string => typeof item === "string"));
    }

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

/** Words that only shape a definition search (`def\s+foo`), never a concept searched for. */
const DEFINITION_WORDS = new Set([
  "def", "class", "function", "interface", "type", "enum", "theorem", "lemma", "structure", "inductive",
  "instance", "abbrev", "fn", "struct", "trait", "export", "async", "pub", "private", "noncomputable",
]);

/**
 * The words a search looks for. A quoted argument is the pattern; otherwise a command's first
 * positional argument after the search tool is, and a `find` query is its own pattern. Regex
 * escapes (`\s`, `\b`) and alternation are separators, so `'cokernel|elementary_divisors'`
 * yields both words rather than one opaque string.
 */
function searchTerms(query: string): string[] {
  return [query]
    .flatMap((pattern) => pattern.replace(/\\[A-Za-z]/g, " ").split(/[^A-Za-z0-9_]+/))
    .filter((term) => term.length >= 2 && !DEFINITION_WORDS.has(term.toLowerCase()));
}

/**
 * Why one quoted search does or does not count. A search for the invented identifier itself
 * proves nothing, so a search counts only if it looks for at least one word that is not a new
 * name. A broader search that merely includes a new name among other terms counts: a helper
 * named `cokernel` does not make searching `cokernel|elementary_divisors` a search for itself.
 */
type SearchVerdict =
  | { kind: "counted"; query: string }
  | { kind: "not_run"; query: string }
  | { kind: "only_new_names"; query: string; names: string[] };

export function judgeSearch(query: string, ran: readonly string[], newNames: ReadonlySet<string>): SearchVerdict {
  const wanted = normalise(query);
  const terms = searchTerms(wanted);
  const fresh = terms.filter((term) => !newNames.has(term.toLowerCase()));
  if (terms.length > 0 && fresh.length === 0) return { kind: "only_new_names", query: wanted, names: [...new Set(terms)] };
  if (!wanted || !ran.some((done) => done.includes(wanted))) return { kind: "not_run", query: wanted };
  return { kind: "counted", query: wanted };
}

function newNameSet(minted: readonly string[]): Set<string> {
  return new Set(minted.map((name) => name.split("/").pop()!.replace(/\.[a-z]+$/, "").toLowerCase()));
}

/** The most recent searches this chat ran that would count, quoted as recorded. */
function countingSearches(key: string, minted: readonly string[]): string[] {
  const ran = searches.get(key) ?? [];
  const names = newNameSet(minted);
  const counting = ran.filter((query) => judgeSearch(query, ran, names).kind === "counted");
  return [...new Set(counting.reverse())].slice(0, 6);
}

/** What the chat can quote next, or the exact call that gives it something to quote. */
function quotableSearches(key: string, minted: readonly string[]): string {
  const counting = countingSearches(key, minted);
  if (counting.length > 0)
    return `Searches this chat has run that count (copy one exactly into searched): ${counting.map((q) => JSON.stringify(q)).join(", ")}.`;
  return (
    "This chat has run no search that counts yet. Call find with the concept's mathematical or domain name " +
    "(a word that is not one of the new names), then put that exact query in searched."
  );
}

function recordProblems(key: string, minted: readonly string[], record: readonly ReuseSearchEntry[]): string[] {
  const ran = searches.get(key) ?? [];
  const problems: string[] = [];
  const covered = new Set(record.flatMap((entry) => entry.names));
  const uncovered = minted.filter((name) => !covered.has(name));
  if (uncovered.length > 0) problems.push(`no reuse_search entry names ${uncovered.join(", ")}`);
  const newNames = newNameSet(minted);
  for (const entry of record) {
    const label = entry.names.join(", ") || "(an entry with no names)";
    if (!entry.found.trim() || !entry.why_new.trim()) problems.push(`${label}: found and why_new must both be filled in`);
    const verdicts = entry.searched.map((query) => judgeSearch(query, ran, newNames));
    if (verdicts.some((verdict) => verdict.kind === "counted")) continue;
    const reasons = verdicts.map((verdict) => {
      switch (verdict.kind) {
        case "not_run":
          return `${JSON.stringify(verdict.query)} was not run verbatim in this chat (as a find call or an rg/grep/fd/ast-grep/probe command)`;
        case "only_new_names":
          return `${JSON.stringify(verdict.query)} searches only for new names (${verdict.names.join(", ")}), which nothing can predate`;
        case "counted":
          return assert.fail("a counted search leaves no reason");
      }
    });
    problems.push(`${label}: no searched entry counts: ${reasons.length > 0 ? reasons.join("; ") : "searched is empty"}`);
  }
  return problems;
}

/** Null when the patch may proceed; otherwise the refusal text. */
export async function reuseGateRefusal(
  hunks: readonly Hunk[],
  record: readonly ReuseSearchEntry[] | undefined,
  root: string | null,
): Promise<string | null> {
  const key = readerKey();
  if (!key) return null;
  const done = accounted.get(key);
  let minted = mintedNames(hunks).filter((name) => !done?.has(name));
  if (root && minted.length > 0) {
    const existing = await alreadyDefined(root, "HEAD", minted);
    minted = minted.filter((name) => !existing.has(name));
  }
  if (minted.length === 0) return null;
  const how = `${HOW} Then send the same patch with reuse_search: [{names, searched, found, why_new}], one entry per new name or group of names.`;
  if (!record || record.length === 0)
    return `REUSE_SEARCH_REQUIRED: this patch adds ${minted.join(", ")}, so it was not applied. ${how}`;
  const problems = recordProblems(key, minted, record);
  if (problems.length > 0)
    return (
      `REUSE_SEARCH_REJECTED: this patch adds ${minted.join(", ")}, and its reuse_search record does not hold, so it was not applied: ` +
      `${problems.join("; ")}. ${quotableSearches(key, minted)} Then send the same patch with the corrected reuse_search.`
    );
  for (const name of minted) setFor(accounted, key).add(name);
  return null;
}

/** A git invocation's outcome as data: its exit status is the answer, not an exception. */
interface GitOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGit(root: string, args: string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    const command = repositoryCommand(currentCall()?.workstreamId ?? null, root, ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args]);
    const child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: null, stdout, stderr: String(error) }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A git command that must succeed: every fleet workspace is a git repository. */
async function git(root: string, args: string[]): Promise<string> {
  const outcome = await runGit(root, args);
  assert.equal(outcome.status, 0, `git ${args.join(" ")} in ${root} failed: ${outcome.stderr.trim()}`);
  return outcome.stdout;
}

const ANY_DEFINITION =
  "(def|class|function\\*?|interface|type|enum|theorem|lemma|structure|inductive|instance|abbrev|fn|struct|trait)";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * The names among `candidates` that some tracked file at `rev` already defines. Defining one of
 * those again is an override or extension of an existing API (Sage's one(), zero(), _repr_ …),
 * not a new concept, so it is not minting. New file paths are never filtered.
 */
export async function alreadyDefined(root: string, rev: string, candidates: readonly string[]): Promise<Set<string>> {
  const names = candidates.filter((name) => !name.includes("/"));
  const found = new Set<string>();
  if (names.length === 0) return found;
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    const pattern = `${ANY_DEFINITION}\\s+(${batch.map(escapeRegex).join("|")})([^A-Za-z0-9_'.]|$)`;
    // git grep's exit status is the domain answer: 0 = some are defined, 1 = none are.
    const outcome = await runGit(top, ["grep", "-h", "-o", "-E", pattern, rev, "--"]);
    assert(outcome.status === 0 || outcome.status === 1, `git grep in ${top} failed: ${outcome.stderr.trim()}`);
    const out = outcome.stdout;
    for (const name of batch) if (new RegExp(`\\s${escapeRegex(name)}([^A-Za-z0-9_'.]|$)`).test(out)) found.add(name);
  }
  return found;
}
