/**
 * The execution record a replacement chat inherits from the chats that held its workstream.
 *
 * A workstream keeps one recorder session across every chat that holds it, so the exact tool
 * calls, results and file changes of a stopped or archived predecessor are on disk. Without
 * them a replacement starts from the static brief alone and repeats the discovery its
 * predecessor already did: setup, orientation, rereading the same source, relaunching the same
 * runs (2026-10-19/20: `sage-indefinite-port` re-selected issues twice and rebuilt runners it
 * already had). This renders that record into the opening message.
 *
 * It is a projection of recorded facts, never a judgment: the newest calls in order, the
 * predecessor's own last words, the last instruction it was given, the files it changed and the
 * processes still running for the workstream. Deciding what matters stays with the model.
 */
import type { SessionEvent, StoredText } from "../shared/session.js";
import { unifiedExecManager } from "./codex/manager.js";
import { execOwner } from "./codex/ownership.js";
import { readRecentEvents } from "./session/store.js";

const CALLS = 40;
const RESULT_TAILS = 10;
const RESULT_TAIL_CHARS = 600;
const ARGS_CHARS = 240;
const MESSAGE_CHARS = 2_000;
const RECORD_CHARS = 24_000;

type ToolCallEvent = Extract<SessionEvent, { kind: "tool_call" }>;
type TextEvent = Extract<SessionEvent, { kind: "assistant_message" | "user_message" }>;

const clock = (time: number) => new Date(time).toISOString().slice(5, 16).replace("T", " ");
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)} …` : flat;
};
const tail = (text: StoredText, max: number) =>
  text.text.length > max ? `… ${text.text.slice(-max)}` : text.text;

/**
 * Calls whose result the next chat needs verbatim: failures, and anything that changed files,
 * processes or agents. A clean read or command is fully described by its line and metric.
 */
const resultMatters = (call: ToolCallEvent["call"]) =>
  call.outcome !== "ok" ||
  call.summary.tone === "bad" ||
  call.summary.tone === "warn" ||
  ["edit", "create", "delete", "move", "process", "agent"].includes(call.summary.kind);

function callLine(event: ToolCallEvent): string {
  const { call } = event;
  const mark = call.outcome === "ok" ? "ok" : call.outcome;
  return `- ${clock(event.time)} ${mark} ${call.tool} ${oneLine(call.args.text, ARGS_CHARS)}${call.summary.metric ? ` (${call.summary.metric})` : ""}`;
}

/**
 * The inherited record for a workstream's recorder session, or "" when nothing was recorded.
 * The newest instruction that was not this controller's own continuation prompt is the last
 * thing the steward or owner asked of the stream.
 */
export async function inheritedExecutionRecord(workstreamId: string, sessionId: string | null): Promise<string> {
  if (!sessionId) return "";
  const calls = (await readRecentEvents(sessionId, CALLS, { kinds: ["tool_call"] })) as ToolCallEvent[];
  const messages = (await readRecentEvents(sessionId, 40, {
    kinds: ["assistant_message", "user_message"],
  })) as TextEvent[];
  if (calls.length === 0 && messages.length === 0) return "";

  // The current frontend's final answers record as bare `::chatgpt-content-reference{…}`
  // placeholders, which carry no prose (2026-10-21); only real text is the predecessor's word.
  const said = messages
    .filter(
      (event) =>
        event.kind === "assistant_message" &&
        event.final &&
        event.message.text.replace(/::chatgpt-content-reference\{[^}]*\}/g, "").trim() !== "",
    )
    .slice(-2);
  const asked = messages
    .filter((event) => event.kind === "user_message" && !event.message.text.startsWith("Continue workstream "))
    .at(-1);

  const changed = new Map<string, { added: number; removed: number }>();
  for (const { call } of calls)
    for (const change of call.changes ?? []) {
      const total = changed.get(change.path) ?? { added: 0, removed: 0 };
      changed.set(change.path, { added: total.added + change.added, removed: total.removed + change.removed });
    }

  const running = unifiedExecManager
    .listProcesses()
    .filter((process) => execOwner(process.processId)?.workstreamId === workstreamId);

  const tails = calls.filter((event) => resultMatters(event.call)).slice(-RESULT_TAILS);

  const sections = [
    "INHERITED EXECUTION RECORD — the exact recorded tail of the chats that held this workstream before you. " +
      "It is what was already done, read and run; continue from it instead of repeating it.",
  ];
  if (asked)
    sections.push(`Last instruction given to this workstream (${clock(asked.time)}):\n${oneLine(asked.message.text, MESSAGE_CHARS)}`);
  if (said.length)
    sections.push(
      `Predecessor's last messages:\n${said.map((event) => `- ${clock(event.time)} ${oneLine(event.message.text, MESSAGE_CHARS)}`).join("\n")}`,
    );
  if (running.length)
    sections.push(
      `Terminal sessions your predecessors left running. They pass to your claim on your first call: read them with write_stdin on these session ids instead of relaunching. A session not declared persistent is reaped ten minutes after its last write_stdin (exec-reaper.ts):\n${running
        .map((process) => `- session_id ${process.processId} (pid ${process.pid ?? "?"}) since ${clock(process.startedAt)} in ${process.cwd}: ${oneLine(process.command, ARGS_CHARS)}`)
        .join("\n")}`,
    );
  if (changed.size)
    sections.push(
      `Files changed by these calls:\n${[...changed]
        .map(([file, count]) => `- ${file} (+${count.added} −${count.removed})`)
        .join("\n")}`,
    );
  if (calls.length) sections.push(`Last ${calls.length} tool calls, oldest first:\n${calls.map(callLine).join("\n")}`);
  if (tails.length)
    sections.push(
      `Results of the last ${tails.length} calls that changed something or failed:\n${tails
        .map((event) => `- ${clock(event.time)} ${event.call.tool} ${event.call.outcome}:\n${tail(event.call.result, RESULT_TAIL_CHARS)}`)
        .join("\n")}`,
    );
  const record = sections.join("\n\n");
  return record.length > RECORD_CHARS ? `${record.slice(0, RECORD_CHARS)}\n… (record cut at ${RECORD_CHARS} characters)` : record;
}
