"""Unit tests for markdown_stream — STEP 4: output-side markdown strip. Covers the exact
log offender ("- **Title:** …"), meaning preservation, streaming (segments emitted at
boundaries), and markdown split across stream chunks."""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from markdown_stream import SpokenStripper, strip_markdown_reply  # noqa: E402


def _no_markup(s):
    assert "*" not in s and "`" not in s and "#" not in s and "](" not in s
    for ln in s.splitlines():
        assert not re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", ln)


def test_strips_the_live_log_offender():
    # what Mnema actually emitted + read aloud in the 2026-06-25 log
    reply = ("Here's a brief overview:\n"
             "- **Title:** Post-Meeting Notes — Meeting.\n"
             "- **Date:** June 25, 2026, 11:31 AM.\n")
    out = strip_markdown_reply(reply)
    _no_markup(out)
    assert "Title: Post-Meeting Notes" in out
    assert "Date: June 25, 2026" in out


def test_meaning_preserved_plain_sentences():
    reply = "Last call was the end of the month. That hasn't shifted since the review."
    out = strip_markdown_reply(reply)
    assert out == "Last call was the end of the month. That hasn't shifted since the review."


def test_streaming_emits_at_sentence_boundary():
    s = SpokenStripper()
    # nothing emitted until the first sentence completes
    assert s.feed("Last call was ") == []
    assert s.feed("the end of the month.") == ["Last call was the end of the month. "]
    # second sentence buffers until its boundary
    assert s.feed(" That hasn't") == []
    out = s.feed(" shifted.")
    assert out == ["That hasn't shifted. "]


def test_bold_split_across_chunks_no_stray_marker():
    s = SpokenStripper()
    # "**bold**" arrives in two pieces straddling a flush boundary
    emitted = []
    emitted += s.feed("The key word is **bo")
    emitted += s.feed("ld** here. Next.")
    tail = s.flush()
    if tail:
        emitted.append(tail)
    joined = "".join(emitted)
    assert "*" not in joined
    assert "bold" in joined and "here" in joined and "Next" in joined


def test_headings_and_numbered_lists():
    reply = "# Summary\n\n1. First thing\n2. Second thing\n"
    out = strip_markdown_reply(reply)
    _no_markup(out)
    assert "Summary" in out and "First thing" in out and "Second thing" in out


def test_ellipsis_not_split_midword():
    out = strip_markdown_reply("Let me think... okay, it's the mid tier.")
    assert "think" in out and "mid tier" in out
    assert "*" not in out


def test_empty_and_whitespace():
    s = SpokenStripper()
    assert s.feed("") == []
    assert s.feed("   \n  ") == []
    assert s.flush() is None
    assert strip_markdown_reply("") == ""


def test_flush_emits_unterminated_tail():
    s = SpokenStripper()
    assert s.feed("no terminator here") == []
    assert s.flush() == "no terminator here"


# ── STEP 3: trailing service-desk sign-offs stripped, substance preserved ──
def test_trailing_signoff_sentence_stripped():
    out = strip_markdown_reply("Last call was end of month. Just let me know if you need the detail.")
    assert "last call was end of month" in out.lower()
    assert "let me know" not in out.lower()


def test_trailing_im_here_to_help_stripped():
    out = strip_markdown_reply("We closed zero items last sprint. I'm here to help.")
    assert "zero items" in out.lower()
    assert "here to help" not in out.lower()


def test_multiple_trailing_signoffs_all_dropped():
    out = strip_markdown_reply("Here's the status. Let me know if you need more. Happy to help!")
    assert "status" in out.lower()
    assert "let me know" not in out.lower() and "happy to help" not in out.lower()


def test_would_you_like_me_to_offer_stripped():
    out = strip_markdown_reply("The TTS decision isn't recorded yet. Would you like me to dig deeper?")
    assert "tts decision" in out.lower()
    assert "would you like me to" not in out.lower()


def test_substantive_clarifying_question_preserved():
    # the vague-ask exemplar — a real choice, NOT a formulaic closer → must survive
    out = strip_markdown_reply("The budget item, or the timeline one?")
    assert "budget item" in out.lower() and "timeline" in out.lower()


def test_midreply_signoffish_phrase_not_dropped_when_followed_by_content():
    # "let me know" mid-reply (a real request) is released because a substantive sentence follows
    out = strip_markdown_reply("Let me know the number and I'll log it. It's not on the board yet.")
    assert "log it" in out.lower() and "not on the board" in out.lower()


def test_honest_fallback_line_survives():
    # the STEP 1 forced-silence fallback must NOT be mistaken for a sign-off
    out = strip_markdown_reply("I don't have that to hand — I can't see it from what I've got here.")
    assert "don't have that" in out.lower()
