"""
silence.py — pure helper for the SILENT_TOKEN gate (audit fix: SilentGate spoke the
literal "<silent>" token on forced turns). No pipecat deps, so SilentGate's sentinel
logic is unit-testable. See pipeline.SilentGate.

Bug it fixes: on an ADDRESSED/forced turn the gate streamed every token verbatim — so
when the model still prefixed its reply with "<silent>" (e.g. "<silent> Here's the
rundown…"), the sentinel was spoken aloud. We now always inspect the leading text:
drop it as silence only when the turn is NOT forced; on a forced turn, strip a stray
sentinel and speak the remainder.
"""
from meeting_persona import SILENT_TOKEN


def resolve_leading_silent(buf: str, forced: bool):
    """Decide what SilentGate should do with the buffered leading reply text.

    Returns one of:
      ("wait", None)            — not enough text yet to rule the sentinel in/out
      ("drop", None)            — reply IS the <silent> sentinel and the turn is NOT
                                  forced → stay silent
      ("speak", text)           — real content; speak it
      ("speak_stripped", text)  — forced turn whose reply began with a stray <silent>;
                                  speak the remainder (text may be "")
    """
    stripped = buf.lstrip()
    low = stripped.lower()
    if not low:
        return ("wait", None)
    if low.startswith(SILENT_TOKEN):
        if forced:
            return ("speak_stripped", stripped[len(SILENT_TOKEN):].lstrip())
        return ("drop", None)
    if SILENT_TOKEN.startswith(low):
        return ("wait", None)  # could still become the sentinel — wait for more
    return ("speak", stripped)
