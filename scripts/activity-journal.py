#!/usr/bin/env python3
"""Read-only recorder activity feed for lnav, not a custom terminal viewer.

The recorder appends tool/turn/error events to events.jsonl, but rewrites
user/assistant messages in messages/*.json. This adapter merges both forms
and discovers new sessions during follow mode.
"""

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sys
import time


def clipped(value: object, limit: int = 220) -> str:
    text = " ".join(str(value or "").split())
    text = text.encode("utf-8", errors="replace").decode("utf-8")
    return text[: limit - 1] + "…" if len(text) > limit else text


def format_row(row: dict, session: str, title: str, *, revised: bool = False) -> tuple[int, str] | None:
    when = row.get("time")
    if not isinstance(when, (int, float)) or when <= 0:
        return None
    kind = str(row.get("kind") or "event") + ("_update" if revised else "")
    # Browser-rewritten tool labels duplicate authoritative MCP calls, and
    # generated citation widgets duplicate message text. Exclude both.
    if kind == "page_tool":
        return None
    if kind.startswith("assistant_message") and str((row.get("message") or {}).get("text") or "").startswith("::chatgpt-content-reference"):
        return None
    level = "INFO"
    if kind == "tool_call":
        call = row.get("call") or {}
        outcome = str(call.get("outcome") or "?")
        if outcome not in {"ok", "success"}:
            level = "ERROR" if outcome in {"error", "failed"} else "WARNING"
        summary = call.get("summary") or {}
        parts = [clipped(call.get("tool"), 40), clipped(outcome, 24),
                 clipped(summary.get("title"), 140), clipped(summary.get("detail"), 130)]
        action = " · ".join(part for part in parts if part)
        if call.get("callId"):
            action += f" · call={call['callId']}"
        label = call.get("workstreamId") or title
    elif kind in {"chat_error", "turn_end"}:
        outcome = row.get("outcome") or ""
        level = "ERROR" if kind == "chat_error" else ("INFO" if outcome == "completed" else "WARNING")
        action = clipped((row.get("message") or {}).get("text") or outcome)
        label = title
    elif kind.endswith("_message") or kind.endswith("_message_update"):
        message = row.get("message") or {}
        action = clipped(message.get("text") or ("[text in asset]" if message.get("assetId") else ""), 260)
        label = title
    elif kind == "agent_message":
        action = f"{row.get('from', '?')} → {row.get('to', '?')} ({row.get('delivery', '?')}) " + clipped((row.get("message") or {}).get("text"), 170)
        label = title
    elif kind == "turn_start":
        action = "started"
        label = title
    else:
        action = clipped(row.get("outcome") or row.get("detail") or "", 100)
        label = title
    stamp = dt.datetime.fromtimestamp(when / 1000, tz=dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return (int(when), f"{stamp} {level:<7} [{clipped(label, 44)}] {session} {kind}: {action}")


class Session:
    def __init__(self, folder: Path, title: str):
        self.folder = folder
        self.title = title
        self.offset = 0
        self.messages: dict[Path, tuple[int, int, bytes]] = {}

    def collect(self, cutoff_ms: int) -> list[tuple[int, str]]:
        found: list[tuple[int, str]] = []
        events = self.folder / "events.jsonl"
        try:
            if events.stat().st_size < self.offset:
                self.offset = 0
            with events.open("rb") as stream:
                stream.seek(self.offset)
                while line := stream.readline():
                    if not line.endswith(b"\n"):
                        break  # incomplete append; revisit at the same offset
                    self.offset = stream.tell()
                    try:
                        value = format_row(json.loads(line), self.folder.name, self.title)
                        if value and value[0] >= cutoff_ms:
                            found.append(value)
                    except (ValueError, TypeError, OverflowError):
                        continue
        except FileNotFoundError:
            pass

        for shard in (self.folder / "messages").glob("*.json"):
            try:
                stat = shard.stat()
                mark = (stat.st_mtime_ns, stat.st_size)
                previous = self.messages.get(shard)
                if previous is not None and previous[:2] == mark:
                    continue
                raw = shard.read_bytes()
                digest = hashlib.blake2s(raw, digest_size=8).digest()
                if previous is not None and previous[2] == digest:
                    self.messages[shard] = (*mark, digest)
                    continue  # the producer rewrote an identical message
                row = json.loads(raw)
                self.messages[shard] = (*mark, digest)
                if previous is not None:
                    # Streaming message rewrites keep their original row.time.
                    row["time"] = stat.st_mtime_ns // 1_000_000
                value = format_row(row, self.folder.name, self.title, revised=previous is not None)
                if value and value[0] >= cutoff_ms:
                    found.append(value)
            except (OSError, ValueError, TypeError, OverflowError):
                continue
        return found


def run() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--hours", default=6.0, type=float, help="hours of history; 0 for all")
    parser.add_argument("--lines", default=300, type=int, help="initial entries; 0 for all")
    parser.add_argument("--chat", default="", help="filter by session ID or title")
    parser.add_argument("--interval", default=2.0, type=float)
    parser.add_argument("--no-follow", action="store_true")
    args = parser.parse_args()
    if args.hours < 0 or args.lines < 0 or args.interval <= 0:
        parser.error("hours and lines must be nonnegative; interval must be positive")
    if not args.root.is_dir():
        parser.error(f"session directory does not exist: {args.root}")
    cutoff = int((time.time() - args.hours * 3600) * 1000) if args.hours else 0
    sessions: dict[Path, Session] = {}

    def collect() -> list[tuple[int, str]]:
        rows: list[tuple[int, str]] = []
        for meta_file in args.root.glob("*/meta.json"):
            folder = meta_file.parent
            session = sessions.get(folder)
            if session is None:
                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                    title = str(meta.get("title") or folder.name)
                    if args.chat and args.chat.lower() not in (folder.name + " " + title).lower():
                        continue
                    if cutoff and max(meta_file.stat().st_mtime, (folder / "events.jsonl").stat().st_mtime) * 1000 < cutoff:
                        continue
                    session = sessions[folder] = Session(folder, title)
                except (OSError, ValueError, TypeError):
                    continue
            rows.extend(session.collect(cutoff))
        return rows

    initial = sorted(collect())
    for _, line in (initial[-args.lines:] if args.lines else initial):
        print(line, flush=True)
    if args.no_follow:
        return
    try:
        while True:
            time.sleep(args.interval)
            for _, line in sorted(collect()):
                print(line, flush=True)
    except (BrokenPipeError, KeyboardInterrupt):
        return


if __name__ == "__main__":
    try:
        run()
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except OSError:
            pass
