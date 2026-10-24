"""Deterministic tests for the external workstream watchdog's decisions."""

import json
from pathlib import Path
import tempfile
import unittest

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
        if path == "/workstreams/recover":
            return {"recovering": True}
        if path == "/workstreams/replace":
            return {"replacing": True}
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
        calls = [{"workstreamId": "research", "ageMs": 6 * MINUTE}]
        action, why, _ = self.decision(row(lastActivity=NOW), calls=calls)
        self.assertEqual(action, "replace")
        self.assertIn("overlong", why)

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

    def test_replacement_is_not_repeated_without_progress(self):
        state = {"lastAction": {
            "kind": "replace", "at": NOW - 90 * MINUTE,
            "baselineActivity": NOW - 31 * MINUTE,
        }}
        self.assertIsNone(self.decision(state=state)[0])

    def test_blocked_must_be_stale_unless_recovery_failed(self):
        self.assertIsNone(self.decision(row(phase="blocked", lastActivity=NOW))[0])
        self.assertEqual(self.decision(row(phase="blocked"))[0], "replace")

    def test_opening_and_archiving_are_not_double_dispatched(self):
        for phase in ("opening", "archiving"):
            with self.subTest(phase=phase):
                self.assertIsNone(self.decision(row(phase=phase))[0])

    def test_no_known_claimant_goes_directly_to_replacement(self):
        self.assertEqual(
            self.decision(row(conversationId=None, claimedBy=[]))[0], "replace"
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
