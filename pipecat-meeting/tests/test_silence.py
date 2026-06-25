"""
Unit tests for the SilentGate sentinel logic (audit fix: the literal "<silent>" token
was being spoken on forced/addressed turns). Tests the pure resolve_leading_silent helper.
Run: pytest pipecat-meeting/tests/test_silence.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from silence import resolve_leading_silent, finalize_forced_reply, forced_silence_fallback  # noqa: E402
from meeting_persona import SILENT_TOKEN  # noqa: E402


# ── STEP 1: addressed turn NEVER yields silence; non-addressed stays silent ──
def test_forced_turn_never_silent():
    fb = forced_silence_fallback()
    assert fb and SILENT_TOKEN not in fb
    # model returned pure <silent> on a forced (addressed) turn → honest fallback, not silence
    assert finalize_forced_reply(SILENT_TOKEN, forced=True) == fb
    assert finalize_forced_reply("", forced=True) == fb
    assert finalize_forced_reply("   ", forced=True) == fb
    # the fallback is itself never silence and survives the guard
    assert finalize_forced_reply(fb, forced=True) == fb


def test_forced_turn_keeps_real_answer():
    real = "Last call was the end of the month."
    assert finalize_forced_reply(real, forced=True) == real


def test_non_addressed_turn_stays_silent():
    # un-addressed side-chatter: empty/silent stays silent (NOT replaced by a spoken line)
    assert finalize_forced_reply("", forced=False) == ""
    assert finalize_forced_reply(SILENT_TOKEN, forced=False) == SILENT_TOKEN


# ── the bug: stray sentinel on a forced turn must be stripped, not spoken ─────────
def test_forced_turn_strips_leading_sentinel():
    action, text = resolve_leading_silent(f"{SILENT_TOKEN} Here's the rundown.", forced=True)
    assert action == "speak_stripped"
    assert text == "Here's the rundown."          # the "<silent>" is gone
    assert SILENT_TOKEN not in text


def test_forced_turn_sentinel_only_yields_empty():
    action, text = resolve_leading_silent(SILENT_TOKEN, forced=True)
    assert action == "speak_stripped"
    assert text == ""                             # nothing left to speak, but never the token


# ── non-forced turn: a genuine sentinel still means stay silent ───────────────────
def test_unforced_sentinel_drops():
    action, text = resolve_leading_silent(f"  {SILENT_TOKEN}", forced=False)
    assert action == "drop"
    assert text is None


# ── real content speaks immediately (fast path preserved for A3.4) ────────────────
def test_real_content_speaks_forced():
    action, text = resolve_leading_silent("Yes, I'm here.", forced=True)
    assert action == "speak"
    assert text == "Yes, I'm here."


def test_real_content_speaks_unforced():
    action, text = resolve_leading_silent("The backlog has 3 items.", forced=False)
    assert action == "speak"
    assert text == "The backlog has 3 items."


# ── partial leading text waits until the sentinel can be ruled in/out ─────────────
def test_partial_prefix_waits():
    assert resolve_leading_silent("", forced=True) == ("wait", None)
    assert resolve_leading_silent("<", forced=False) == ("wait", None)
    assert resolve_leading_silent("<sil", forced=True) == ("wait", None)


def test_token_lookalike_that_is_real_content_speaks():
    # starts with '<' but is not the sentinel → real content
    action, text = resolve_leading_silent("<note> see the doc", forced=False)
    assert action == "speak"
    assert text == "<note> see the doc"
