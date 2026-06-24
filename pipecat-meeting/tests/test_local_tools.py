"""
Unit tests for the live-meeting-awareness tools (audit #6) — the pure helpers
format_roster and search_meeting_log. Run: pytest pipecat-meeting/tests/test_local_tools.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from local_tools import format_roster, search_meeting_log, LOCAL_TOOL_DEFINITIONS  # noqa: E402


# ── who_is_in_meeting / format_roster ────────────────────────────────────────────
def test_roster_current_only():
    participants = {"p1": {"name": "Nischay"}, "p2": {"name": "Aisha"}}
    out = format_roster(participants, participants, bot_participant_id=None)
    assert "Nischay" in out and "Aisha" in out
    assert "right now" in out.lower()


def test_roster_excludes_bot():
    participants = {"p1": {"name": "Nischay"}, "bot": {"name": "Mnema"}}
    out = format_roster(participants, participants, bot_participant_id="bot")
    assert "Nischay" in out
    assert "Mnema" not in out


def test_roster_reports_who_left():
    # Aisha was seen (roster_ever) but is no longer present (participants) → "joined earlier"
    participants = {"p1": {"name": "Nischay"}}
    roster_ever = {"p1": {"name": "Nischay"}, "p2": {"name": "Aisha"}}
    out = format_roster(participants, roster_ever, bot_participant_id=None)
    assert "Nischay" in out
    assert "Aisha" in out
    assert "earlier" in out.lower()


def test_roster_empty():
    out = format_roster({}, {}, bot_participant_id=None)
    assert "don't see anyone" in out.lower()


# ── recall_what_was_said / search_meeting_log ────────────────────────────────────
LOG = [
    {"speaker": "Nischay", "text": "I think we should ship the pricing change next week."},
    {"speaker": "Aisha", "text": "Did you finish the pricing deck?"},
    {"speaker": "Nischay", "text": "The budget cap is around twenty percent."},
]


def test_search_finds_topic_with_speaker():
    out = search_meeting_log(LOG, "pricing")
    assert "Nischay: I think we should ship the pricing change next week." in out
    assert "Aisha: Did you finish the pricing deck?" in out
    assert "budget" not in out  # unrelated turn excluded


def test_search_no_match():
    out = search_meeting_log(LOG, "kubernetes")
    assert "don't recall" in out.lower()


def test_search_no_topic_returns_recent():
    out = search_meeting_log(LOG, None, limit=2)
    assert "budget cap" in out
    assert out.count("\n") == 1  # only the last 2 turns


def test_search_empty_log():
    assert "haven't captured" in search_meeting_log([], "anything").lower()


# ── tool schemas well-formed ─────────────────────────────────────────────────────
def test_tool_defs_shape():
    names = {t["function"]["name"] for t in LOCAL_TOOL_DEFINITIONS}
    assert names == {"who_is_in_meeting", "recall_what_was_said"}
    for t in LOCAL_TOOL_DEFINITIONS:
        assert t["type"] == "function"
        assert t["function"]["parameters"]["type"] == "object"
