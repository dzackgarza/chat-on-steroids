"""Deterministic tests for the external workstream watchdog's decisions."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import workstream_watchdog as wd


NOW = 1_800_000_000_000
MINUTE = 60_000


class FakeBridge:
    def __init__(self, rows, calls=None, schema="current"):
        self.rows = rows
        self.calls = calls or []
        self.schema = schema
        self.posts = []

    def get(self, path):
        if path == "/workstreams":
            return {"connectorSchema": {"kind": self.schema}, "workstreams": self.rows}
        if path == "/sleep/status":
            return {"inFlightCalls": self.calls}
        raise AssertionError(path)

    def post(self, path, body):
        self.posts.append((path, body))
        if path == "/workstreams/cancel-overlong":
            self.calls = []
            return {"requested": 1, "unsupported": [], "remaining": 1}
        if path == "/workstreams/recover":
            return {"recovering": True}
        if path == "/workstreams/replace":
            return {"replacing": True}
        if path == "/workstreams/start":
            return {"id": body["id"], "commandId": "new-continuation-command"}
        raise AssertionError(path)


def row(**overrides):
    baseline = {
        "id": "research",
        "phase": "active",
        "autoAdvance": True,
        "conversationId": "conversation-1",
        "claimedBy": ["conversation-1"],
        "sessionId": None,
        "lastActivity": NOW - 31 * MINUTE,
        "nextCheck": 0,
        "attempts": 0,
    }
    baseline.update(overrides)
    return baseline


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sessions = Path(self.tmp.name)

    def decision(self, r=None, *, state=None, calls=None, now=NOW):
        state = state if state is not None else {}
        return wd.action_allowed(
            r or row(), state, now=now,
            idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
            cooldown_ms=30 * MINUTE,
            calls=calls or [], sessions_dir=self.sessions,
        )

    def test_inactivity_recovers_existing_claimant(self):
        action, _, _ = self.decision()
        self.assertEqual(action, "recover")

    def test_recent_work_is_not_interrupted(self):
        self.assertIsNone(self.decision(row(lastActivity=NOW - 2 * MINUTE))[0])

    def test_paused_and_non_auto_advance_are_untouched(self):
        self.assertIsNone(self.decision(row(phase="paused"))[0])
        self.assertIsNone(self.decision(row(autoAdvance=False))[0])
        self.assertIsNone(self.decision(row(id="orchestrator"))[0])

    def test_short_running_tool_prevents_recovery(self):
        calls = [{"workstreamId": "research", "ageMs": 4 * MINUTE}]
        self.assertIsNone(self.decision(calls=calls)[0])

    def test_overlong_tool_is_an_error_not_evidence_of_health(self):
        calls = [{"workstreamId": "research", "ageMs": 6 * MINUTE,
                  "tool": "exec_command"}]
        action, why, _ = self.decision(row(lastActivity=NOW), calls=calls)
        self.assertEqual(action, "cancel-overlong")
        self.assertIn("budget", why)
        self.assertEqual(
            self.decision(row(phase="archiving"), calls=calls)[0],
            "cancel-overlong",
        )

    def test_overlong_nonterminal_tool_never_triggers_unconditional_restart(self):
        calls = [{"workstreamId": "research", "ageMs": 6 * MINUTE,
                  "tool": "apply_patch"}]
        action, why, _ = self.decision(row(lastActivity=NOW), calls=calls)
        self.assertIsNone(action)
        self.assertIn("steward diagnosis", why)
        bridge = FakeBridge([row(lastActivity=NOW)], calls)
        with patch.object(wd, "restart_controller") as restart:
            with self.assertRaises(wd.BridgeError):
                wd.clear_overlong_call(bridge, row(), 5 * MINUTE)
        self.assertEqual(bridge.posts, [])
        restart.assert_not_called()

    def test_mixed_terminal_and_nonterminal_calls_do_not_restart_daemon(self):
        calls = [
            {"workstreamId": "research", "ageMs": 6 * MINUTE,
             "tool": "exec_command"},
            {"workstreamId": "research", "ageMs": MINUTE,
             "tool": "read"},
        ]
        self.assertIsNone(self.decision(calls=calls)[0])
        bridge = FakeBridge([row()], calls)
        with patch.object(wd, "restart_controller") as restart:
            with self.assertRaises(wd.BridgeError):
                wd.clear_overlong_call(bridge, row(), 5 * MINUTE)
        self.assertEqual(bridge.posts, [])
        restart.assert_not_called()

    def test_other_workstreams_calls_do_not_block_recovery(self):
        calls = [{"workstreamId": "other", "ageMs": 45 * MINUTE}]
        self.assertEqual(self.decision(calls=calls)[0], "recover")

    def test_cooldown_then_escalate_after_unsuccessful_recovery(self):
        state = {"lastAction": {
            "kind": "recover", "at": NOW - 10 * MINUTE,
            "baselineActivity": NOW - 31 * MINUTE,
        }}
        self.assertIsNone(self.decision(state=state)[0])
        state["lastAction"]["at"] = NOW - 31 * MINUTE
        self.assertEqual(self.decision(state=state)[0], "replace")

    def test_replacement_failure_is_retried_after_cooldown(self):
        state = {"lastAction": {
            "kind": "replace", "at": NOW - 90 * MINUTE,
            "baselineActivity": NOW - 31 * MINUTE,
        }}
        self.assertEqual(self.decision(state=state)[0], "replace")

    def test_blocked_must_be_stale_unless_recovery_failed(self):
        self.assertIsNone(self.decision(row(phase="blocked", lastActivity=NOW))[0])
        self.assertEqual(self.decision(row(phase="blocked"))[0], "replace")

    def test_opening_and_archiving_trigger_controller_repair_when_stale(self):
        for phase in ("opening", "archiving"):
            with self.subTest(phase=phase):
                self.assertEqual(self.decision(row(phase=phase))[0], "restart-controller")
                self.assertIsNone(
                    self.decision(row(phase=phase, lastActivity=NOW - MINUTE))[0]
                )

    def test_no_known_claimant_goes_directly_to_replacement(self):
        self.assertEqual(
            self.decision(row(conversationId=None, claimedBy=[]))[0], "replace"
        )
        self.assertEqual(
            self.decision(row(
                conversationId=None, claimedBy=["old-chat"],
                retiredConversations=["old-chat"],
            ))[0], "replace"
        )
        self.assertEqual(
            self.decision(row(
                conversationId=None, claimedBy=["current-chat"],
                retiredConversations=["old-chat"],
            ))[0], "recover"
        )

    def test_recorder_polls_cannot_mask_old_nonpoll_activity(self):
        sid = "2026-10-24-aabbccdd"
        folder = self.sessions / sid
        folder.mkdir()
        records = [
            {"kind": "tool_call", "time": NOW - 50 * MINUTE,
             "call": {"tool": "apply_patch", "result": {"text": "ok"}}},
            {"kind": "tool_call", "time": NOW - 1 * MINUTE,
             "call": {"tool": "write_stdin", "result": {"text": "Process still running"}}},
        ]
        (folder / "events.jsonl").write_text(
            "".join(json.dumps(x) + "\n" for x in records), encoding="utf-8"
        )
        state = {}
        action, _, evidence = self.decision(
            row(sessionId=sid, lastActivity=NOW - MINUTE), state=state
        )
        self.assertEqual(action, "recover")
        self.assertEqual(evidence["lastNonpollToolAt"], NOW - 50 * MINUTE)
        self.assertEqual(state["lastNonpollSeenAt"], NOW - 50 * MINUTE)

    def test_poll_only_recorder_does_not_refresh_the_clock_forever(self):
        sid = "2026-10-24-eeffaabb"
        folder = self.sessions / sid
        folder.mkdir()
        (folder / "events.jsonl").write_text(
            json.dumps({"kind": "tool_call", "time": NOW - MINUTE,
                        "call": {"tool": "write_stdin"}}) + "\n"
        )
        state = {}
        first = row(sessionId=sid, lastActivity=NOW - MINUTE)
        self.assertIsNone(self.decision(first, state=state)[0])
        self.assertEqual(
            self.decision(first, state=state, now=NOW + 31 * MINUTE)[0],
            "recover",
        )

    def test_dry_run_does_not_act_and_real_run_records_recovery(self):
        bridge = FakeBridge([row()])
        state = {"version": 1, "streams": {}}
        options = {
            "sessions_dir": self.sessions, "now": NOW,
            "idle_ms": 30 * MINUTE, "call_limit_ms": 5 * MINUTE,
            "cooldown_ms": 30 * MINUTE, "selected": set(),
        }
        self.assertEqual(wd.run_watchdog(bridge, state, **options, dry_run=True), 0)
        self.assertEqual(bridge.posts, [])
        self.assertEqual(wd.run_watchdog(bridge, state, **options, dry_run=False), 0)
        self.assertEqual(len(bridge.posts), 1)
        self.assertEqual(bridge.posts[0][0], "/workstreams/recover")
        self.assertEqual(state["streams"]["research"]["lastAction"]["kind"], "recover")
        # A legitimate 409 (e.g. claimant retired) is not a crashed daemon.
        # Escalate a still-idle, unchanged row to native fenced replacement.
        refusing = FakeBridge([row()])
        original_post = refusing.post
        def refused_recovery(path, body):
            if path == "/workstreams/recover":
                refusing.posts.append((path, body))
                return {"recovering": False}
            return original_post(path, body)
        refusing.post = refused_recovery
        with patch.object(wd, "restart_controller") as restart:
            self.assertEqual(wd.run_watchdog(
                refusing, {"version": 1, "streams": {}},
                **options, dry_run=False,
            ), 0)
        restart.assert_not_called()
        self.assertEqual(
            [p for p, _ in refusing.posts],
            ["/workstreams/recover", "/workstreams/replace"],
        )

    def test_overlong_tool_is_cancelled_and_recovery_actually_requested(self):
        bridge = FakeBridge([row(lastActivity=NOW)], [
            {"workstreamId": "research", "ageMs": 6 * MINUTE, "tool": "write_stdin"},
        ])
        state = {"version": 1, "streams": {}}
        result = wd.run_watchdog(
            bridge, state, sessions_dir=self.sessions, now=NOW,
            idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
            cooldown_ms=30 * MINUTE, selected=set(), dry_run=False,
        )
        self.assertEqual(result, 0)
        self.assertEqual(
            [p for p, _ in bridge.posts],
            ["/workstreams/cancel-overlong", "/workstreams/recover"],
        )
        self.assertEqual(state["streams"]["research"]["lastAction"]["kind"], "recover")

    def test_unsettled_tool_forces_controller_restart_then_recovery(self):
        bridge = FakeBridge([row(lastActivity=NOW)], [
            {"workstreamId": "research", "ageMs": 8 * MINUTE,
             "tool": "exec_command"},
        ])
        state = {"version": 1, "streams": {}}
        def still_inflight(path, body):
            bridge.posts.append((path, body))
            return {"requested": 0, "unsupported": ["exec_command"], "remaining": 1}
        bridge.post = still_inflight
        with patch.object(wd, "restart_controller", return_value={
            "workstreams": [row(lastActivity=NOW)]
        }) as restart, patch.object(wd.time, "sleep"):
            result = wd.clear_overlong_call(bridge, row(), 5 * MINUTE)
        self.assertEqual(result["id"], "research")
        restart.assert_called_once()

    def test_bridge_outage_is_repaired_not_just_reported(self):
        token = self.sessions / "local-token"
        token.write_text("test-local-credential", encoding="utf-8")
        with patch.object(
            wd.Bridge, "_request",
            side_effect=[wd.BridgeError("connection refused"), {"app": "chat-on-steroids"}],
        ), patch.object(wd, "_restart_daemon") as restart, patch.object(
            wd.subprocess, "run", return_value=wd.subprocess.CompletedProcess(
                args=[], returncode=3, stdout="inactive", stderr=""
            ),
        ):
            bridge = wd.Bridge(token, port=8765)
        self.assertEqual(bridge.base, "http://127.0.0.1:8765")
        restart.assert_called_once_with()
        # Real cold start on 2026-10-25 retained sessions for minutes before
        # exposing the bridge. Never bounce an already-running daemon just
        # because its listener is not yet ready at the old 15-second boundary.
        with patch.object(
            wd.Bridge, "_request",
            side_effect=[wd.BridgeError("still initializing")] * 36
                        + [{"app": "chat-on-steroids"}],
        ), patch.object(wd, "_restart_daemon") as restart, patch.object(
            wd.subprocess, "run", return_value=wd.subprocess.CompletedProcess(
                args=[], returncode=0, stdout="active", stderr=""
            ),
        ), patch.object(wd.time, "sleep") as sleep:
            delayed = wd.Bridge(token, port=8765)
        self.assertEqual(delayed.base, "http://127.0.0.1:8765")
        self.assertEqual(sleep.call_count, 35)
        restart.assert_not_called()
        # Run the real subprocess adapter with a cron-like empty environment.
        # The restart attempt must still receive the user-bus runtime directory.
        with patch.dict(wd.os.environ, {}, clear=True), patch.object(
            wd.subprocess, "run", return_value=wd.subprocess.CompletedProcess(
                args=[], returncode=0, stdout="", stderr=""
            ),
        ) as systemctl:
            wd._restart_daemon()
        self.assertEqual(
            systemctl.call_args.kwargs["env"]["XDG_RUNTIME_DIR"],
            f"/run/user/{wd.os.getuid()}",
        )

    def test_stale_archiving_forces_a_fresh_continuation_after_restart(self):
        stuck = row(phase="archiving", context="Preserve the unfinished implementation")
        bridge = FakeBridge([stuck])
        state = {"version": 1, "streams": {}}
        with patch.object(wd, "restart_controller",
                          return_value={"workstreams": [stuck]}) as restart:
            outcome = wd.run_watchdog(
                bridge, state, sessions_dir=self.sessions, now=NOW,
                idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
                cooldown_ms=30 * MINUTE, selected=set(), dry_run=False,
            )
        self.assertEqual(outcome, 0)
        restart.assert_called_once()
        self.assertEqual(bridge.posts, [
            ("/workstreams/start", {
                "id": "research",
                "context": "Preserve the unfinished implementation",
                "autoAdvance": True,
            }),
        ])
        self.assertEqual(state["streams"]["research"]["lastAction"]["kind"], "force-open")

    def test_concurrent_worker_resume_does_not_trigger_a_restart(self):
        bridge = FakeBridge([row()])
        state = {"version": 1, "streams": {}}
        def concurrently_resumed(path, body):
            bridge.rows[0] = row(lastActivity=NOW)
            raise wd.BridgeError("HTTP 409: stale expected observation")
        bridge.post = concurrently_resumed
        with patch.object(wd, "restart_controller") as restart:
            outcome = wd.run_watchdog(
                bridge, state, sessions_dir=self.sessions, now=NOW,
                idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
                cooldown_ms=30 * MINUTE, selected=set(), dry_run=False,
            )
        self.assertEqual(outcome, 0)
        restart.assert_not_called()

        # Admission of a new call can race with a refused recover even if the
        # row's observed phase and timestamps have not changed yet.
        active = FakeBridge([row()])
        def concurrent_call(path, body):
            active.posts.append((path, body))
            active.calls = [{"workstreamId": "research", "tool": "read", "ageMs": 1}]
            return {"recovering": False}
        active.post = concurrent_call
        with patch.object(wd, "restart_controller") as restart:
            outcome = wd.run_watchdog(
                active, {"version": 1, "streams": {}},
                sessions_dir=self.sessions, now=NOW,
                idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
                cooldown_ms=30 * MINUTE, selected=set(), dry_run=False,
            )
        self.assertEqual(outcome, 0)
        self.assertEqual(len(active.posts), 1)
        restart.assert_not_called()

    def test_unavailable_tool_census_fails_closed(self):
        bridge = FakeBridge([row()])
        bridge.calls = None
        with self.assertRaises(wd.BridgeError):
            wd.run_watchdog(
                bridge, {"version": 1, "streams": {}}, sessions_dir=self.sessions,
                now=NOW, idle_ms=30 * MINUTE, call_limit_ms=5 * MINUTE,
                cooldown_ms=30 * MINUTE, selected=set(), dry_run=False,
            )
        self.assertEqual(bridge.posts, [])


if __name__ == "__main__":
    unittest.main()
