#!/usr/bin/env python3
"""Owner-authorized, 30-minute external liveness watchdog for managed workstreams.

This is NOT a workstream participant: it never calls MCP workstream(start/continue),
never claims the repository, and never invents a replacement chat on its own.
All interventions go through the controller's fenced recover/replace state machine.
The decision is based on evidence, not on lease expiry or a browser heartbeat.

The scheduling cadence is external (cron); a run completes after one finite pass.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


APP_DIR = Path.home() / ".config/chat-on-steroids"
STATE_DIR = Path.home() / ".local/state/chat-on-steroids"
BRIDGE_PORTS = range(8765, 8770)
ACTIVE_PHASES = {"active", "advancing"}
RECOVERABLE_PHASES = ACTIVE_PHASES | {"recovering", "blocked"}
NON_PROGRESS_TOOLS = {"write_stdin", "sleep", "session"}
MAX_EVENT_TAIL_BYTES = 1024 * 1024


class BridgeError(RuntimeError):
    pass


def log(level: str, workstream: str, message: str, **details: object) -> None:
    item = {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "level": level,
        "workstream": workstream,
        "message": message,
        **details,
    }
    print(json.dumps(item, sort_keys=True), flush=True)


class Bridge:
    def __init__(self, token_file: Path, port: int | None = None):
        self.token = token_file.read_text(encoding="utf-8").strip()
        if not self.token:
            raise BridgeError("The local bridge token is empty")
        self.base = self._discover(port)

    def _request(self, base: str, endpoint: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            base + endpoint, data=data, headers=headers,
            method="POST" if data is not None else "GET",
        )
        try:
            with urlopen(request, timeout=8) as response:
                result = json.load(response)
        except HTTPError as exc:
            body = exc.read(1024).decode("utf-8", "replace")
            raise BridgeError(f"{endpoint}: HTTP {exc.code}: {body}") from exc
        except (OSError, ValueError) as exc:
            raise BridgeError(f"{endpoint}: {exc}") from exc
        if not isinstance(result, dict):
            raise BridgeError(f"{endpoint}: expected a JSON object")
        return result

    def _discover(self, port: int | None) -> str:
        ports = [port] if port is not None else BRIDGE_PORTS
        for candidate in ports:
            base = f"http://127.0.0.1:{candidate}"
            try:
                info = self._request(base, "/hello")
            except BridgeError:
                continue
            if info.get("app") != "chat-on-steroids":
                continue
            if info.get("disconnected"):
                raise BridgeError("Bridge is deliberately disconnected; no intervention")
            return base
        raise BridgeError("Chat On Steroids bridge not found on localhost ports 8765-8769")

    def get(self, endpoint: str) -> dict:
        return self._request(self.base, endpoint)

    def post(self, endpoint: str, payload: dict) -> dict:
        return self._request(self.base, endpoint, payload)


def read_state(path: Path) -> dict:
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved.get("version") == 1 and isinstance(saved.get("streams"), dict):
            return saved
        raise ValueError("Unsupported state version or format")
    except FileNotFoundError:
        return {"version": 1, "streams": {}}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as output:
            json.dump(state, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def latest_nonpoll_tool(session_id: str | None, sessions_dir: Path) -> int | None:
    """Read the recorder, excluding poll-only calls that can renew a workstream lease.

    This is evidence of an action, not a certification of substantive progress.
    A different tool can itself be wasteful; the orchestrator reviews that decision.
    """
    if not session_id or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", session_id):
        return None
    events = sessions_dir / session_id / "events.jsonl"
    try:
        with events.open("rb") as handle:
            end = handle.seek(0, os.SEEK_END)
            start = max(0, end - MAX_EVENT_TAIL_BYTES)
            handle.seek(start)
            if start:
                handle.readline()  # discard the partial initial JSON line
            data = handle.read()
    except OSError:
        return None
    latest = None
    for raw in data.splitlines():
        try:
            item = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if item.get("kind") != "tool_call":
            continue
        call = item.get("call") or {}
        tool = call.get("tool")
        if tool in NON_PROGRESS_TOOLS:
            # Reading the completed result of a process is a meaningful transition;
            # polling a process which has not finished is not.
            result = str((call.get("result") or {}).get("text") or "")
            if tool != "write_stdin" or not re.search(
                r"Process exited with code -?\d+", result
            ):
                continue
        stamp = item.get("time")
        if isinstance(stamp, (float, int)) and stamp > 0:
            latest = max(latest or 0, int(stamp))
    return latest


def call_info(calls: list, stream_id: str) -> tuple[int, int]:
    matching = [
        c for c in calls
        if isinstance(c, dict) and c.get("workstreamId") == stream_id
    ]
    return len(matching), max(
        (int(c.get("ageMs") or 0) for c in matching), default=0
    )


def action_allowed(
    row: dict, state: dict, *, now: int, idle_ms: int,
    call_limit_ms: int, cooldown_ms: int, calls: list, sessions_dir: Path,
) -> tuple[str | None, str, dict]:
    """Return one recovery action and its evidence; never mutate controller state here."""
    ident = str(row["id"])
    phase = row.get("phase")
    if phase == "paused" or not row.get("autoAdvance") or ident == "orchestrator":
        return None, "not an active auto-advancing workstream", {}

    n_calls, longest_call = call_info(calls, ident)
    last_activity = int(row.get("lastActivity") or 0)
    fresh_recorded = latest_nonpoll_tool(row.get("sessionId"), sessions_dir)
    prior_recorded = int(state.get("lastNonpollSeenAt") or 0)
    recorded = max(prior_recorded, fresh_recorded or 0) or None
    if recorded is not None:
        state["lastNonpollSeenAt"] = recorded
    # A recent polling call is deliberately NOT a substitute for a non-polling
    # action. Use admitted-call activity only when the recorder has no such evidence.
    activity = recorded if recorded is not None else last_activity
    if recorded is None and row.get("sessionId"):
        event_file = sessions_dir / str(row["sessionId"]) / "events.jsonl"
        if event_file.is_file():
            # The recorder exists but the visible tail has only polling calls.
            # Never interpret those calls' refreshed lease as forward motion.
            first_poll_only = int(state.setdefault("firstPollOnlyAt", now))
            activity = min(activity or first_poll_only, first_poll_only)
    activity_age = max(0, now - activity) if activity else 0
    long_call = longest_call >= call_limit_ms
    evidence = {
        "phase": phase,
        "conversationId": row.get("conversationId"),
        "inFlightCalls": n_calls,
        "longestCallMs": longest_call,
        "lastNonpollToolAt": recorded,
        "activityAgeMs": activity_age,
    }

    previous = state.get("lastAction")
    if isinstance(previous, dict):
        # A new substantive tool call proves the last intervention achieved activity.
        # A new browser turn, renewed lease or poll alone does not.
        previous_activity = int(previous.get("baselineActivity") or 0)
        if activity > previous_activity and (
            recorded is not None or last_activity > previous_activity
        ):
            state.pop("lastAction", None)
            previous = None
        elif now - int(previous.get("at") or 0) < cooldown_ms:
            return None, "recent intervention is still within cooldown", evidence

    if phase in {"opening", "archiving"}:
        return None, "controller is already opening or archiving a conversation", evidence

    if n_calls:
        if not long_call:
            return None, "in-flight call within the five-minute execution budget", evidence
        if phase in RECOVERABLE_PHASES and (
            not previous or previous.get("kind") == "recover"
        ):
            # Recover refuses a running tool. Replacement *fences* its owner, but
            # opening still waits for that call to settle. Never claim this kills it.
            return "replace", "overlong tool call violates execution budget; fence owner", evidence
        return None, "overlong call persists; replacement cannot finish until it settles", evidence

    if phase == "blocked":
        if previous and previous.get("kind") == "replace":
            return None, "replacement is still blocked; needs controller/browser repair", evidence
        if activity_age < idle_ms and not previous:
            return None, "recently blocked; awaiting controller recovery", evidence
        return "replace", "blocked workstream requires a new continuation", evidence

    if phase == "recovering":
        if previous and previous.get("kind") == "replace":
            return None, "replacement already requested", evidence
        if int(row.get("nextCheck") or 0) > now:
            return None, "controller recovery response window remains open", evidence
        if previous or int(row.get("attempts") or 0) > 0:
            return "replace", "failed recovery did not resume execution", evidence
        return None, "controller is already handling recovery", evidence

    if phase not in ACTIVE_PHASES:
        return None, "phase not eligible for watchdog intervention", evidence
    if activity_age < idle_ms:
        return None, "recent tool activity", evidence

    if previous and previous.get("kind") == "replace":
        return None, "replacement already requested; no verified activity", evidence
    if previous and previous.get("kind") == "recover":
        return "replace", "same-chat recovery did not produce a new tool action", evidence
    if row.get("conversationId") or row.get("claimedBy"):
        return "recover", "no non-polling tool activity within inactivity horizon", evidence
    return "replace", "unbound idle workstream has no known claimant to revive", evidence


def run_watchdog(
    bridge: Bridge, persistent: dict, *,
    sessions_dir: Path, now: int, idle_ms: int, call_limit_ms: int,
    cooldown_ms: int, selected: set[str], dry_run: bool,
) -> int:
    current = bridge.get("/workstreams")
    rows = current.get("workstreams")
    if not isinstance(rows, list):
        raise BridgeError("Bridge returned no workstream list")
    if (current.get("connectorSchema") or {}).get("kind") != "current":
        raise BridgeError("ChatGPT has a stale connector schema; refresh before intervention")
    sleep = bridge.get("/sleep/status")
    calls = sleep.get("inFlightCalls")
    if not isinstance(calls, list):
        raise BridgeError("In-flight tool census unavailable; refusing unsafe intervention")
    if len(calls) >= 50:
        # The bridge intentionally returns at most 50. A truncated census
        # cannot prove that any particular workstream has no running calls.
        raise BridgeError("In-flight tool census may be truncated; refusing unsafe intervention")

    total, acted, problems = 0, 0, 0
    for row in rows:
        ident = row.get("id")
        if not isinstance(ident, str) or (selected and ident not in selected):
            continue
        if ident == "orchestrator" or not row.get("autoAdvance") or row.get("phase") == "paused":
            continue
        total += 1
        stored = persistent["streams"].setdefault(ident, {})
        action, reason, evidence = action_allowed(
            row, stored, now=now, idle_ms=idle_ms, call_limit_ms=call_limit_ms,
            cooldown_ms=cooldown_ms, calls=calls, sessions_dir=sessions_dir,
        )
        if action is None:
            severity = "error" if evidence.get("longestCallMs", 0) >= call_limit_ms else "info"
            log(severity, ident, reason, **evidence)
            if severity == "error":
                problems += 1
            continue
        endpoint = "/workstreams/recover" if action == "recover" else "/workstreams/replace"
        payload = {"id": ident}
        if action == "recover":
            payload["reason"] = (
                "30-minute external watchdog: no non-polling workstream tool activity; "
                "resume the existing unfinished task, not setup or broad test waits"
            )
        if dry_run:
            log("info", ident, f"DRY RUN: would {action}: {reason}", **evidence)
            continue
        try:
            reply = bridge.post(endpoint, payload)
        except BridgeError as exc:
            problems += 1
            log("error", ident, f"{action} failed: {exc}", **evidence)
            continue
        accepted = reply.get("recovering") if action == "recover" else reply.get("replacing")
        if accepted is not True:
            problems += 1
            log("error", ident, f"{action} was not accepted: {reply}", **evidence)
            continue
        stored["lastAction"] = {
            "at": now,
            "kind": action,
            "conversationId": row.get("conversationId"),
            "baselineActivity": evidence["lastNonpollToolAt"] or int(row.get("lastActivity") or 0),
            "reason": reason,
        }
        acted += 1
        log("warning", ident, f"{action} accepted: {reason}", **evidence)
    log("info", "watchdog", "pass finished", inspected=total, actions=acted, problems=problems)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workstream", action="append", default=[], help="limit to one ID (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="inspect without POSTs or state writes")
    parser.add_argument("--port", type=int, default=None, help="localhost bridge port, or autodetect")
    parser.add_argument("--idle-minutes", type=int, default=30)
    parser.add_argument("--call-limit-minutes", type=int, default=5)
    parser.add_argument("--cooldown-minutes", type=int, default=30)
    parser.add_argument("--state", type=Path, default=STATE_DIR / "workstream-watchdog-state.json")
    parser.add_argument("--sessions", type=Path, default=APP_DIR / "sessions")
    parser.add_argument("--token", type=Path, default=APP_DIR / "state/local-token")
    args = parser.parse_args(argv)
    if min(args.idle_minutes, args.call_limit_minutes, args.cooldown_minutes) <= 0:
        parser.error("Thresholds must be positive")
    args.state.parent.mkdir(parents=True, exist_ok=True)
    try:
        with (args.state.parent / (args.state.name + ".lock")).open("a+") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log("warning", "watchdog", "another watchdog run is already active; not overlapping")
                return 0
            state = read_state(args.state)
            bridge = Bridge(args.token, args.port)
            status = run_watchdog(
                bridge, state, sessions_dir=args.sessions, now=int(time.time() * 1000),
                idle_ms=args.idle_minutes * 60_000,
                call_limit_ms=args.call_limit_minutes * 60_000,
                cooldown_ms=args.cooldown_minutes * 60_000,
                selected=set(args.workstream), dry_run=args.dry_run,
            )
            if not args.dry_run:
                save_state(args.state, state)
            return status
    except (BridgeError, OSError, ValueError) as exc:
        log("error", "watchdog", str(exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
