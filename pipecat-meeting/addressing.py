"""
addressing.py — wake-word / "is the bot addressed" detection (A1.6).

Extracted from pipeline.py so the deterministic addressing logic is unit-testable
without importing the heavy pipecat/LLM stack. The wake word is the FAST-PATH; the
semantic LLM classifier (pipeline._classify_addressed) handles implicit address.
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

# Fillers/greetings people naturally put before a vocative ("so Mnema", "um Mnema").
GREETINGS = ("hey", "ok", "okay", "hi", "hello", "yo", "so", "um", "uh", "erm", "yeah", "alright", "and")


def is_wake(tok: str) -> bool:
    return tok in WAKE_WORDS or bool(WAKE_RE.fullmatch(tok))


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
