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

# Fillers/greetings people naturally put before a vocative ("so Mnema", "morning Mnema").
# Includes time-of-day greetings (Q20 "Morning, Nema" must address her, not fall to silence)
# and "good" so "good morning, Nema" matches on the morning→name pair too.
GREETINGS = (
    "hey", "ok", "okay", "hi", "hello", "yo", "so", "um", "uh", "erm", "yeah", "alright", "and",
    "morning", "mornin", "afternoon", "evening", "good", "greetings", "heya", "hiya",
    "thanks", "cheers", "welcome",
)

# Semantic-addressing classifier system prompt — the SINGLE source of truth shared by the
# live pipeline (_classify_addressed) and the realness harness mirror (turn._addressed) so
# the two never drift. Tightened (STEP 1): a direct QUESTION/REQUEST to her without a wake
# word counts as addressed (was wrongly dropped to silence on fresh/no-wake turns); ambient
# declarative cross-talk between people stays non-addressed.
CLASSIFY_SYS = (
    "You are the attention gate for a voice assistant named Mnema that sits in a live meeting. "
    "Decide if the latest utterance is directed AT Mnema (answer YES) or is humans talking to "
    "EACH OTHER (answer NO).\n"
    "Answer YES when it is a QUESTION, REQUEST, or COMMAND that an assistant would be asked — "
    "especially about the workspace, the meeting, status, history, docs, tasks, who's here, or "
    "what was said; about recalling/looking up/summarising/noting something; or a direct "
    "follow-up to what Mnema just said. A direct question does NOT need her name to count — a "
    "mid-meeting question like 'what did we decide on the budget?' or 'who just spoke?' or "
    "'remind me what we shipped' is FOR her. Lean YES on clear questions and requests. A "
    "GREETING that names her — 'morning, Nema', 'hey Mnema', 'thanks Nema' — is also FOR her "
    "(YES); answer it.\n"
    "Answer NO for ambient cross-talk between people: opinions, decisions, and statements they "
    "say to each other ('yeah I think we should just ship it', 'let's move on'), back-channels "
    "('right', 'totally'), and chit-chat not seeking information. A bare declarative statement "
    "to the room is NOT for Mnema.\n"
    "Reply with exactly one word: YES or NO."
)


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
