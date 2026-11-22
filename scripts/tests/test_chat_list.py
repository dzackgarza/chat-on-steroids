"""`just chats` decides which ChatGPT chats are active from ChatGPT's own replies.

The inputs below have the shape of real replies captured on 2026-11-22 from
POST /backend-api/conversations/batch (ISO `update_time`) and
GET /backend-api/conversation/<id>/stream_status (`COMPLETE` or `IS_STREAMING`).
The ids are placeholders.
"""

from datetime import datetime, timezone
import importlib.util
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "chat_list", Path(__file__).resolve().parent.parent / "chat-list.py"
)
chat_list = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(chat_list)

NOW = datetime(2026, 11, 22, 14, 0, tzinfo=timezone.utc).timestamp()
WINDOW = 10  # minutes
RUNNING, QUIET, OLD = "id-running", "id-quiet", "id-old"
TITLES = {RUNNING: "Roadmap", QUIET: "Notes", OLD: "Archive talk"}


def rows(activity, tabs=None, states=None, minutes=WINDOW):
    return {
        row["id"]: row
        for row in chat_list.activity_rows(
            sorted(activity), {c: TITLES.get(c, c) for c in activity},
            tabs or {}, states or {}, activity, NOW, minutes,
        )
    }


def test_a_turn_running_now_is_busy_even_though_the_sidebar_time_is_old():
    # The sidebar list froze at 12:54 while the turn ran; the batch update_time follows it.
    activity = {RUNNING: {"update_time": "2026-11-22T13:58:00.000000Z", "stream": "IS_STREAMING"}}
    assert rows(activity)[RUNNING]["state"] == "busy"


def test_a_streaming_flag_with_no_update_for_a_day_is_the_wedged_delivery_timeout_alert():
    # Measured 2026-11-23: a fresh tab on a chat whose backend says IS_STREAMING (async_status 3)
    # with no update since August polled ~13 min, then showed "Message delivery timed out".
    activity = {OLD: {"update_time": "2026-11-21T10:00:00.000000Z", "stream": "IS_STREAMING"}}
    row = rows(activity)[OLD]
    assert (row["state"], row["action"]) == ("alert", "Message delivery timed out. Please try again.")


def test_a_finished_chat_outside_the_window_is_not_listed():
    activity = {
        QUIET: {"update_time": "2026-11-22T08:36:11.000000Z", "stream": "COMPLETE"},
        RUNNING: {"update_time": "2026-11-22T13:55:00.000000Z", "stream": "COMPLETE"},
    }
    assert set(rows(activity)) == {RUNNING}


def test_window_zero_lists_every_chat_read():
    activity = {QUIET: {"update_time": "2026-11-22T08:36:11.000000Z", "stream": "COMPLETE"}}
    assert set(rows(activity, minutes=0)) == {QUIET}


def test_a_chat_whose_metadata_read_failed_stays_listed_with_its_status():
    # A 429 once emptied the whole list because rows with no time were treated as inactive.
    activity = {QUIET: {"batch_status": 429}}
    assert rows(activity)[QUIET]["status"] == 429


def test_a_chat_missing_from_the_batch_reply_stays_listed():
    assert rows({QUIET: {}})[QUIET]["status"] is None


def test_recorder_busy_becomes_idle_when_chatgpt_says_the_stream_is_over():
    activity = {QUIET: {"update_time": "2026-11-22T13:59:00.000000Z", "stream": "COMPLETE"}}
    states = {QUIET: (NOW * 1000, "busy", "send")}
    assert rows(activity, states=states)[QUIET]["state"] == "idle"


def test_an_open_tab_marking_the_turn_in_progress_is_busy():
    activity = {QUIET: {"update_time": "2026-11-22T13:59:00.000000Z", "stream": "COMPLETE"}}
    assert rows(activity, tabs={QUIET: "in_progress"})[QUIET]["state"] == "busy"


def test_rows_are_newest_first():
    activity = {
        QUIET: {"update_time": "2026-11-22T13:50:00.000000Z", "stream": "COMPLETE"},
        RUNNING: {"update_time": "2026-11-22T13:59:00.000000Z", "stream": "IS_STREAMING"},
    }
    ordered = chat_list.activity_rows(
        sorted(activity), TITLES, {}, {}, activity, NOW, WINDOW
    )
    assert [row["id"] for row in ordered] == [RUNNING, QUIET]


def test_a_failed_full_read_prints_its_http_status_in_the_model_column():
    activity = {RUNNING: {"update_time": "2026-11-22T13:58:00.000000Z", "stream": "IS_STREAMING"}}
    row = rows(activity)[RUNNING]
    row.update({"status": 429})
    line = chat_list.render([row], NOW).splitlines()[1]
    assert "!429" in line and "busy" in line and "2m" in line


def test_the_model_column_shows_the_latest_model_and_how_many_others_were_used():
    activity = {RUNNING: {"update_time": "2026-11-22T13:58:00.000000Z", "stream": "IS_STREAMING"}}
    row = rows(activity)[RUNNING]
    row.update({"model": "gpt-6-pro", "models": {"gpt-6-pro": 3, "gpt-6": 1},
                "user": 2, "assistant": 2, "tool": 1, "tokens": 12500})
    line = chat_list.render([row], NOW).splitlines()[1]
    assert "gpt-6-pro+1" in line and "12.5k" in line


def test_a_tab_showing_the_delivery_timeout_banner_is_listed_as_an_alert_with_its_text():
    # Captured 2026-11-22: tab marked `complete`, server said COMPLETE, last update hours old,
    # page showed <aside role="alert">Message delivery timed out. Please try again.</aside>.
    activity = {RUNNING: {"update_time": "2026-11-22T10:00:00.000000Z", "stream": "COMPLETE"}}
    tabs = {RUNNING: "alert:Message delivery timed out. Please try again."}
    row = rows(activity, tabs=tabs)[RUNNING]
    assert (row["state"], row["action"]) == ("alert", "Message delivery timed out. Please try again.")
