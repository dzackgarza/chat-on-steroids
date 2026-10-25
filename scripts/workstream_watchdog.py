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
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


APP_DIR = Path.home() / ".config/chat-on-steroids"
STATE_DIR = Path.home() / ".local/state/chat-on-steroids"
BRIDGE_PORTS = range(8765, 8770)
ACTIVE_PHASES = {"active", "advancing"}
NON_PROGRESS_TOOLS = {"write_stdin", "sleep", "session"}
TERMINAL_TOOLS = {"exec_command", "write_stdin"}
MAX_EVENT_TAIL_BYTES = 1024 * 1024


class BridgeError(RuntimeError):
    pass


def _restart_daemon(service: str = "chat-on-steroids.service") -> None:
    # Cron normally has no XDG_RUNTIME_DIR, so `systemctl --user` cannot find
    # the existing user bus even though the service itself is healthy.
    env = os.environ.copy()
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    try:
        result = subprocess.run(
            ["systemctl", "--user", "restart", service],
            check=False, capture_output=True, text=True, timeout=25, env=env,
        )
        if result.returncode:
            raise BridgeError(
                f"cannot restart Core2 service {service}: "
                f"{result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'}"
            )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        raise BridgeError(f"cannot restart Core2 service {service}: {exc}") from exc


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
        def probe() -> str | None:
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
            return None

        live = probe()
        if live is not None:
            return live
        # The daemon exposes the bridge only after restoring durable sessions.
        # A running daemon may take considerably longer than its systemd start
        # acknowledgement to finish that restoration. Restarting it in this
        # state discards its progress and can perpetuate the outage.
        env = os.environ.copy()
        env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        try:
            service = subprocess.run(
                ["systemctl", "--user", "is-active", "chat-on-steroids.service"],
                check=False, capture_output=True, text=True, timeout=5, env=env,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BridgeError(f"Cannot establish daemon state; refusing blind restart: {exc}") from exc
        if service.returncode != 0:
            # An actually stopped daemon needs native service recovery.
            _restart_daemon()
        for _ in range(90):
            live = probe()
            if live is not None:
                return live
            time.sleep(0.5)
        raise BridgeError(
            "Chat On Steroids daemon is active but its bridge is not yet ready; "
            "leave initialization running and recheck on the next watchdog tick"
        )

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


def call_info(calls: list, stream_id: str) -> tuple[int, int, bool]:
    matching = [
        c for c in calls
        if isinstance(c, dict) and c.get("workstreamId") == stream_id
    ]
    return (
        len(matching),
        max((int(c.get("ageMs") or 0) for c in matching), default=0),
        all(c.get("tool") in TERMINAL_TOOLS for c in matching),
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

    n_calls, longest_call, terminal_only = call_info(calls, ident)
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

    # This is evaluated BEFORE the lease/phase/cooldown rules. An overlong
    # tool is not proof of progress and cannot veto its own cancellation.
    # In particular, archiving cannot complete while this call is running.
    if n_calls:
        if long_call:
            if not terminal_only:
                # The controller can abort terminal processes, not arbitrary
                # in-flight mutations. Restarting its daemon would kill an
                # unsupported apply_patch/read/etc. and possibly other workers.
                # This requires a model steward's judgment, not cron policy.
                return None, "overlong nonterminal tool requires steward diagnosis", evidence
            return "cancel-overlong", "tool execution exceeded five-minute budget", evidence
        return None, "in-flight call inside its execution budget", evidence

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
        if activity_age >= idle_ms and row.get("nextCheck", 0) <= now:
            return "restart-controller", "controller opening/archive transition is wedged", evidence
        return None, "controller is already opening or archiving a conversation", evidence

    if phase == "blocked":
        if activity_age < idle_ms and not previous:
            return None, "recently blocked; awaiting controller recovery", evidence
        return "replace", "blocked workstream requires a new continuation", evidence

    if phase == "recovering":
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
        return "replace", "replacement failed to resume the active workstream", evidence
    if previous and previous.get("kind") == "recover":
        return "replace", "same-chat recovery did not produce a new tool action", evidence
    if row.get("conversationId"):
        return "recover", "no non-polling tool activity within inactivity horizon", evidence
    claimants = row.get("claimedBy") or []
    last_claimant = claimants[-1] if claimants else None
    if last_claimant and last_claimant not in (row.get("retiredConversations") or []):
        return "recover", "unbound idle workstream has a nonretired claimant to revive", evidence
    return "replace", "unbound idle workstream has no eligible claimant to revive", evidence


def restart_controller(bridge: Bridge, service: str = "chat-on-steroids.service") -> dict:
    """Last-resort repair if the daemon cannot settle its own stuck MCP call."""
    _restart_daemon(service)
    # On 2026-10-25 the real service needed about 17 seconds from the
    # restart request to the bridge listener. The former 15-second probe
    # exhausted just as the bridge opened, misclassifying a successful
    # restart as a failed recovery. Allow a bounded 45-second readiness
    # window; a restart ACK alone is never treated as a live bridge.
    for _ in range(90):
        try:
            state = bridge.get("/workstreams")
            if isinstance(state.get("workstreams"), list):
                return state
        except BridgeError:
            pass
        time.sleep(0.5)
    raise BridgeError("Core2 restart was requested but bridge did not return")


def clear_overlong_call(bridge: Bridge, row: dict, minimum_age_ms: int) -> dict:
    """Cancel owned over-budget tools; verify settlement or restart Core2."""
    census = bridge.get("/sleep/status").get("inFlightCalls")
    if not isinstance(census, list):
        raise BridgeError("In-flight census unavailable before terminal cancellation")
    owned = [c for c in census if c.get("workstreamId") == row["id"]]
    if any(c.get("tool") not in TERMINAL_TOOLS for c in owned):
        raise BridgeError("Nonterminal call now in flight; cannot safely cancel or restart daemon")
    if not owned:
        raise BridgeError("The overlong terminal call has settled; reassess live worker state")
    payload = {
        "id": row["id"],
        "conversationId": row.get("conversationId"),
        "minimumAgeMs": minimum_age_ms,
    }
    try:
        cancelled = bridge.post("/workstreams/cancel-overlong", payload)
    except BridgeError as exc:
        # The original conversation can legitimately finish or be replaced
        # between our GET and POST. That race is success, not a reason to
        # restart the daemon and disrupt unrelated work.
        current = bridge.get("/workstreams")
        fresh = next((r for r in current["workstreams"] if r["id"] == row["id"]), {})
        calls = bridge.get("/sleep/status").get("inFlightCalls", [])
        if fresh.get("phase") == "paused" or (
            fresh.get("conversationId") != row.get("conversationId")
        ) or not any(
            c.get("workstreamId") == row["id"] and
            int(c.get("ageMs") or 0) >= minimum_age_ms for c in calls
        ):
            return fresh
        # The installed watchdog may precede its daemon's updated HTTP route.
        log("warning", row["id"], "native cancellation unavailable; restarting controller",
            error=str(exc))
        state = restart_controller(bridge)
        return next((r for r in state["workstreams"] if r["id"] == row["id"]), {})

    if not isinstance(cancelled.get("requested"), int):
        raise BridgeError("Cancellation endpoint returned no acknowledgement")
    for _ in range(12):
        in_flight = bridge.get("/sleep/status").get("inFlightCalls")
        if not isinstance(in_flight, list):
            raise BridgeError("In-flight census unavailable during cancellation")
        if not any(c.get("workstreamId") == row["id"] for c in in_flight):
            state = bridge.get("/workstreams")
            return next((r for r in state["workstreams"] if r["id"] == row["id"]), {})
        time.sleep(1)

    # A daemon still blocked after cancellation must be restarted, rather
    # than merely logging a permanent wedge for an absent human reader.
    log("warning", row["id"], "native cancellation did not settle; restarting controller",
        requested=cancelled["requested"], unsupported=cancelled.get("unsupported", []))
    state = restart_controller(bridge)
    return next((r for r in state["workstreams"] if r["id"] == row["id"]), {})


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
        if action in {"cancel-overlong", "restart-controller"}:
            if dry_run:
                log("info", ident, f"DRY RUN: would {action}: {reason}", **evidence)
                continue
            try:
                stuck_transition = action == "restart-controller"
                fresh = (
                    clear_overlong_call(bridge, row, call_limit_ms)
                    if action == "cancel-overlong"
                    else next(
                        (r for r in restart_controller(bridge)["workstreams"]
                         if r["id"] == ident), {}
                    )
                )
                if not fresh:
                    raise BridgeError("Workstream vanished during controller repair")
                if fresh.get("conversationId") != row.get("conversationId"):
                    # Another recovery bound a successor while cancellation
                    # was running. Never interrupt that new chat on stale facts.
                    log("info", ident, "new conversation already attached; repair completed")
                    acted += 1
                    continue
                row = fresh
                phase = row.get("phase")
                if phase == "paused":
                    # Owner decisions override an external watchdog tick even
                    # when they arrive during its bounded cancellation.
                    continue
                if phase in ACTIVE_PHASES:
                    previous = stored.get("lastAction") or {}
                    action = "replace" if previous.get("kind") == "recover" else "recover"
                elif phase == "blocked":
                    action = "replace"
                elif phase in {"recovering", "archiving", "opening"}:
                    if stuck_transition and phase in {"archiving", "opening"}:
                        # The daemon was restarted yet the existing handoff
                        # remained stranded. This phase already fences the
                        # previous worker. Open a fresh controller bootstrap
                        # with the existing durable brief instead of waiting
                        # another thirty minutes on a dead transition.
                        bootstrap = bridge.post("/workstreams/start", {
                            "id": ident,
                            "context": str(fresh.get("context") or ""),
                            "autoAdvance": True,
                        })
                        if not bootstrap.get("commandId"):
                            raise BridgeError("Fresh bootstrap was not accepted")
                        stored["lastAction"] = {
                            "at": now,
                            "kind": "force-open",
                            "conversationId": fresh.get("conversationId"),
                            "baselineActivity": int(fresh.get("lastActivity") or 0),
                            "reason": reason,
                        }
                        log("warning", ident, "fresh continuation bootstrap issued",
                            commandId=bootstrap["commandId"])
                    else:
                        log("warning", ident, "controller repaired; native handoff proceeding",
                            phase=phase)
                    acted += 1
                    continue
                else:
                    raise BridgeError(f"Workstream now has ineligible phase {phase!r}")
                reason += "; process settled and controller is resuming execution"
            except BridgeError as exc:
                problems += 1
                log("error", ident, f"automatic call/controller repair failed: {exc}", **evidence)
                continue
        endpoint = "/workstreams/recover" if action == "recover" else "/workstreams/replace"
        payload = {
            "id": ident,
            "expectedConversationId": row.get("conversationId"),
            "expectedLastActivity": int(row.get("lastActivity") or 0),
        }
        if action == "recover":
            payload["reason"] = (
                "30-minute external watchdog: no non-polling workstream tool activity; "
                "resume the existing unfinished task, not setup or broad test waits"
            )
        if dry_run:
            log("info", ident, f"DRY RUN: would {action}: {reason}", **evidence)
            continue
        reply = None
        failure = ""
        try:
            reply = bridge.post(endpoint, payload)
        except BridgeError as exc:
            failure = str(exc)
        accepted = (
            reply.get("recovering") if action == "recover" else reply.get("replacing")
        ) if reply is not None else False
        if accepted is not True:
            try:
                latest = bridge.get("/workstreams")
                fresh = next(
                    (r for r in latest["workstreams"] if r["id"] == ident), {}
                )
                # Concurrent progress invalidates the old observation.
                if not fresh or any(
                    fresh.get(k) != row.get(k)
                    for k in ("conversationId", "lastActivity", "phase")
                ):
                    log("info", ident, "workstream moved during intervention; no retry")
                    continue
                pending = bridge.get("/sleep/status").get("inFlightCalls")
                if not isinstance(pending, list) or len(pending) >= 50:
                    raise BridgeError("In-flight census incomplete after recovery refusal")
                if any(c.get("workstreamId") == ident for c in pending):
                    log("info", ident, "worker began a call during recovery; no replacement")
                    continue
                # A refusal from the live controller is NOT proof its daemon
                # is broken. The claimant can have retired since our sample;
                # restart would interrupt unrelated active workers. The same
                # observed idle row is eligible for native fenced replacement.
                if action == "recover" and fresh.get("phase") in ACTIVE_PHASES:
                    action = "replace"
                    endpoint = "/workstreams/replace"
                    payload.pop("reason", None)
                    reply = bridge.post(endpoint, payload)
                    accepted = reply.get("replacing")
                    row = fresh
            except BridgeError as exc:
                failure = f"{failure}; restart/retry failed: {exc}"
        if accepted is not True:
            problems += 1
            log("error", ident, f"all {action} attempts failed: {failure or reply}", **evidence)
            continue
        stored["lastAction"] = {
            "at": now,
            "kind": action,
            "conversationId": row.get("conversationId"),
            "baselineActivity": max(
                int(evidence["lastNonpollToolAt"] or 0),
                int(row.get("lastActivity") or 0),
            ),
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
    if min(args.idle_minutes, args.cooldown_minutes) <= 0 or args.call_limit_minutes < 5:
        parser.error("Inactivity/cooldown must be positive and execution limit at least 5 minutes")
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
