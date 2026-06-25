"""
markdown_stream.py — STEP 4: suppress MODEL-generated markdown at the output boundary.

The persona forbids markdown, but the live log still caught Mnema emitting "- **Title:** …"
and reading it aloud. This is the belt-and-braces net: every token the model streams toward
TTS passes through SpokenStripper, which converts any stray markdown to spoken plaintext
right before synthesis — even if the model slips. It reuses to_spoken_plaintext (the single
normalizer used for [Background] and tool results), so output and input are cleaned the same.

Streaming is preserved: text is buffered only to the next SAFE boundary (end of a sentence or
a line) and emitted immediately, so first-sentence TTS still starts before generation
finishes — no extra round-trip latency. A markdown span (e.g. **bold**) split across two
stream chunks is handled by a residual-asterisk sweep after normalization, so a half-seen
'**' never reaches the voice. Pure (no pipecat); the FrameProcessor wrapper lives in
pipeline.py and is unit-tested via this class.
"""
import re

from text_norm import to_spoken_plaintext, is_signoff, strip_trailing_offer_clause

# A safe flush boundary: up to and including the first sentence-ender (. ! ?) that is
# followed by whitespace or end-of-buffer, OR the first newline. Non-greedy so we cut at
# the EARLIEST boundary and keep streaming promptly. Ellipses ("..."): the lookahead only
# fires on the dot before a space, so "thinking... okay" flushes as one piece.
_FLUSH_RE = re.compile(r"^(.*?(?:[.!?](?=\s|$)|\n))", re.S)
# Residual emphasis sweep: after normalization, drop any leftover asterisks — these only
# survive when a **bold** / *italic* span was split across stream chunks (one marker in this
# segment, its partner in the next). Voice never wants an asterisk. Backticks are already
# stripped wholesale by to_spoken_plaintext.
_STRAY_AST_RE = re.compile(r"\*+")


def _clean(seg: str) -> str:
    """Normalize one segment to spoken plaintext + sweep residual asterisks. '' if blank."""
    if not seg or not seg.strip():
        return ""
    return _STRAY_AST_RE.sub("", to_spoken_plaintext(seg)).strip()


class SpokenStripper:
    """Incrementally turn a stream of LLM text into spoken-plaintext segments.

    feed(text)  → returns a list of finished, cleaned segments (each ending with a space so
                  they concatenate naturally at the TTS); buffers any unfinished tail.
    flush()     → returns the cleaned remaining tail (call on response end), or None.
    """

    def __init__(self) -> None:
        self._buf = ""
        # STEP 3: completed sentences that ARE sign-offs are held here, not emitted yet — they
        # might be trailing closers (drop) or mid-reply (a later substantive sentence releases
        # them). At flush, anything still held is trailing → dropped. Streaming is preserved:
        # substantive sentences are emitted immediately; only a closer is briefly delayed.
        self._held: list[str] = []

    def feed(self, text: str) -> list[str]:
        if not text:
            return []
        self._buf += text
        out: list[str] = []
        while True:
            m = _FLUSH_RE.match(self._buf)
            if not m:
                break
            seg = m.group(1)
            self._buf = self._buf[len(seg):]
            cleaned = _clean(seg)
            if not cleaned:
                continue
            if is_signoff(cleaned):
                self._held.append(cleaned)          # hold — possibly a trailing closer
            else:
                for h in self._held:                # a real sentence followed → held were mid-reply
                    out.append(h + " ")
                self._held = []
                out.append(cleaned + " ")
        return out

    def flush(self) -> str | None:
        seg, self._buf = self._buf, ""
        self._held = []                              # any held sign-offs are trailing → drop
        cleaned = _clean(seg)
        if not cleaned:
            return None
        cleaned = strip_trailing_offer_clause(cleaned)   # trim a trailing offer clause
        if not cleaned or is_signoff(cleaned):           # whole tail was a closer → drop
            return None
        return cleaned


def strip_markdown_reply(text: str) -> str:
    """Convenience one-shot: full reply text → clean spoken text (feed + flush). Used by
    tests and any non-streaming caller."""
    s = SpokenStripper()
    parts = s.feed(text)
    tail = s.flush()
    if tail:
        parts.append(tail)
    return "".join(parts).strip()
