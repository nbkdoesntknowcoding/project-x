"""
addressing.py — wake-word / "is the bot addressed" detection (A1.6).

Extracted from pipeline.py so the addressing logic is unit-testable without importing
the heavy pipecat stack. Two PURE, deterministic paths: the wake word (is_addressed) and
a direct question / assistant-request (is_question_or_request). The old LLM classifier was
removed in STEP 1 — it was non-deterministic and flickered ADDRESSED/silent across runs.
"""
import re

# Known mishearings of "Mnema" (Deepgram keyterm prompting helps, but STT still drifts).
# The phonetic regex below covers variants without matching ordinary words like
# "name"/"no"/"mama".
WAKE_WORDS = frozenset((
    "mnema", "nima", "neema", "nema", "nemo", "nimo", "mneme", "menma", "namo", "amnema",
    "nama", "naima", "namah", "nemma", "nyema", "kneema", "knema", "neemah", "nemah",
))
WAKE_RE = re.compile(r"m?n[aeiy][aeiy]?m[aiouh]*")

# Fillers/greetings people naturally put before a vocative ("so Mnema", "morning Mnema").
# Includes time-of-day greetings (Q20 "Morning, Nema" must address her, not fall to silence)
# and "good" so "good morning, Nema" matches on the morning→name pair too.
GREETINGS = (
    "hey", "ok", "okay", "hi", "hello", "yo", "so", "um", "uh", "erm", "yeah", "alright", "and",
    "morning", "mornin", "afternoon", "evening", "good", "greetings", "heya", "hiya",
    "thanks", "cheers", "welcome",
)

# NOTE: the LLM addressing classifier (and its CLASSIFY_SYS prompt) was REMOVED in STEP 1 —
# it was non-deterministic (gpt-4o-mini, no seed) and flickered ADDRESSED/silent across runs.
# The deterministic is_question_or_request rule below replaces it.


def is_wake(tok: str) -> bool:
    return tok in WAKE_WORDS or bool(WAKE_RE.fullmatch(tok))


# ── deterministic "is this a direct question / request to the assistant" ─────────
# STEP 1: replaces the gpt-4o-mini addressing classifier on the non-wake path. That LLM call
# (temperature 0 but NO seed) was NOT bit-deterministic, so a borderline question like "who
# just spoke before me?" flipped ADDRESSED/silent across runs. This rule is PURE → identical
# input always yields identical classification. A direct question or an assistant-style request
# is ADDRESSED; a bare declarative / back-channel ("yeah I think we should just ship it",
# "right", "totally") is NOT — that stays the conservative, silent side.
_INTERROGATIVES = frozenset((
    "who", "what", "whats", "what's", "when", "where", "why", "which", "whose", "whom",
    "how", "hows", "how's", "whatre", "what're",
))
_AUX_FRONTED = frozenset((
    "is", "are", "am", "was", "were", "do", "does", "did", "can", "could", "would", "will",
    "should", "shall", "may", "might", "have", "has", "had", "won't", "wont", "isn't", "aren't",
))
_REQUEST_VERBS = frozenset((
    "remind", "tell", "show", "give", "list", "read", "walk", "catch", "pull", "find", "look",
    "fetch", "summarize", "summarise", "check", "explain", "describe", "recap", "share",
    "bring", "send", "note", "save", "search", "open", "fill", "draft", "remember",
))


def is_question_or_request(text: str) -> bool:
    """True if `text` is a direct question or an assistant-style request — deterministically.
    Question mark, leading interrogative (who/what/how…), aux-fronted question (is/do/can/
    should…), or an imperative request verb (remind/tell/show…), skipping leading greeting
    fillers. A bare declarative or back-channel → False (ambient → stays silent)."""
    t = (text or "").strip().lower()
    if not t:
        return False
    if t.endswith("?"):
        return True
    tokens = re.findall(r"[a-z']+", t)
    i = 0
    while i < len(tokens) and tokens[i] in GREETINGS:   # skip "so", "hey", "okay", "yeah" …
        i += 1
    if i >= len(tokens):
        return False
    first = tokens[i]
    return first in _INTERROGATIVES or first in _AUX_FRONTED or first in _REQUEST_VERBS


def is_addressed(text: str) -> bool:
    """True only when the bot is *addressed* — the wake word is at the START of the
    utterance (vocative: "Mnema, …"), or right after a greeting ("hey Mnema"). A wake
    word later in a sentence (people talking ABOUT Mnema — "let's put this in Mnema")
    does NOT count, which is what stops the bot replying to normal conversation."""
    tokens = re.findall(r"[a-z]+", (text or "").lower())
    if not tokens:
        return False
    if is_wake(tokens[0]):                              # "Mnema, …" (vocative, first word)
        return True
    # a filler/greeting immediately followed by the wake word ("hey/so/um Mnema …")
    for i in range(len(tokens) - 1):
        if tokens[i] in GREETINGS and is_wake(tokens[i + 1]):
            return True
    return False
