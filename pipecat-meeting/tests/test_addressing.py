"""
Unit tests for addressing.is_addressed — A1.6 wake-word fast-path.

Pure module (no pipecat), so it imports directly. Verifies the bot is addressed only
when the wake word is vocative (start, or right after a greeting), and NOT when people
merely talk *about* Mnema. The semantic LLM classifier (pipeline._classify_addressed)
handles implicit address and is exercised live, not here.
Run: pytest pipecat-meeting/tests/test_addressing.py
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from addressing import is_addressed, is_wake, is_question_or_request  # noqa: E402


# ── STEP 1: deterministic addressing — direct question/request = addressed, every time ──
def test_question_or_request_is_deterministic_and_correct():
    # the gate is a PURE function: same input → same output (no LLM, no flicker)
    q = "who just spoke before me?"
    assert all(is_question_or_request(q) for _ in range(5))     # identical across repeats
    for addressed in ["what is on the board?", "what's in progress", "remind me what we shipped",
                      "catch me up", "is anything blocked", "did we ship the build",
                      "how's the voice agent coming along", "tell me the latest"]:
        assert is_question_or_request(addressed), addressed
    # bare declaratives / back-channels are NOT a question/request (stay silent)
    for ambient in ["yeah I think we should just ship it", "right", "totally",
                    "okay sounds good", "we should ship it", "let's move on"]:
        assert not is_question_or_request(ambient), ambient
    # leading greeting fillers are skipped before judging the first real token
    assert is_question_or_request("so what did we decide")
    assert not is_question_or_request("yeah we are good")


def test_side_chatter_not_wake_addressed():
    # Q23: ambient declarative, no wake word → the deterministic fast-path says not addressed
    assert is_addressed("yeah I think we should just ship it") is False


# ── STEP 3: greeting that names her is ADDRESSED (Q20 fix) ──
def test_greeting_with_name_is_addressed():
    assert is_addressed("Morning, Nema.") is True
    assert is_addressed("good morning Nema") is True
    assert is_addressed("evening, Mnema") is True
    assert is_addressed("thanks Nema") is True
    # but a greeting to a HUMAN (no wake word) is not addressed
    assert is_addressed("morning everyone") is False
    assert is_addressed("good morning team") is False


# ── addressed: vocative wake word ────────────────────────────────────────────────
def test_vocative_start():
    assert is_addressed("Mnema, what's the status of the billing task?")
    assert is_addressed("mnema can you pull up the doc")


def test_greeting_then_wake():
    assert is_addressed("hey Mnema, summarise that")
    assert is_addressed("so Mnema what did we decide")
    assert is_addressed("um nema are you there")


def test_common_mishearings_at_start():
    for variant in ["Nima", "Neema", "Nemo", "Namah", "Kneema", "nemma"]:
        assert is_addressed(f"{variant}, what's next?"), variant


# ── NOT addressed: talking ABOUT mnema, or side-talk ─────────────────────────────
def test_wake_word_mid_sentence_not_addressed():
    assert not is_addressed("let's put this in Mnema after the call")
    assert not is_addressed("I think Mnema captured that already")


def test_plain_side_talk_not_addressed():
    assert not is_addressed("can you pull up the Q3 doc?")   # implicit → handled by classifier, not the fast-path
    assert not is_addressed("yeah I agree with that")
    assert not is_addressed("")
    assert not is_addressed("...")


def test_ordinary_words_not_false_wake():
    # the phonetic regex must not fire on ordinary words
    for w in ["name", "no", "now", "mama", "menu", "any", "money"]:
        assert not is_addressed(f"{w} is fine"), w


# ── is_wake unit ─────────────────────────────────────────────────────────────────
def test_is_wake_direct():
    assert is_wake("mnema")
    assert is_wake("nima")
    assert not is_wake("name")
    assert not is_wake("hello")


# ── A1.6 state flag default ──────────────────────────────────────────────────────
def test_force_next_response_default_false():
    # import recall_io via the sibling test's stubs
    sys.path.insert(0, os.path.dirname(__file__))
    import test_recall_io  # noqa: F401 (installs stubs)
    import recall_io
    st = recall_io.BotState()
    assert st.force_next_response is False
    assert not hasattr(st, "force_until")
