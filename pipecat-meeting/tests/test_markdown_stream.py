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
