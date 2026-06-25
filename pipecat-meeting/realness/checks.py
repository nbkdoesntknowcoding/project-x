"""
checks.py — deterministic rubric scorers (pure; no live deps). Each returns (score, reason)
with score in {0,1,2}. These are the ASSERTS — markdown, tool-discipline, silence,
tool-narration, completeness — plus the human-delivery heuristic and an honesty signal.
The subjective rubrics (grounded/honest/recitation/human nuance) go through the judge.
"""
import re
import statistics

from meeting_persona import SILENT_TOKEN

# ── markdown detection ───────────────────────────────────────────────────────
_MD_INLINE = re.compile(r"[*`|]|\]\(")                 # * ` | or a ](link
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s")
_MD_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")


def find_markdown(text: str) -> list[str]:
    """Return the markdown tokens present in `text` (empty = clean). A bare hyphen inside a
    word (end-to-end) is NOT flagged; only line-leading bullets and the inline tokens are."""
    hits = []
    if _MD_INLINE.search(text or ""):
        hits.append("inline(* ` | or link)")
    for ln in (text or "").splitlines():
        if _MD_HEADING.match(ln):
            hits.append(f"heading:{ln.strip()[:20]}")
        if _MD_BULLET.match(ln):
            hits.append(f"bullet:{ln.strip()[:20]}")
    return hits


def score_no_markdown(text: str):
    hits = find_markdown(text)
    if not hits:
        return 2, "no markdown tokens"
    return 0, "markdown present: " + "; ".join(hits[:4])


# ── tool-narration (the production failure phrasing) ─────────────────────────
_BANNED_NARRATION = [
    "having trouble retrieving", "trouble retrieving", "i've been having some trouble",
    "having some trouble", "according to the document", "the background says",
    "the document says", "the search results", "based on the search", "i searched the",
    "let me search", "i was unable to retrieve", "i couldn't retrieve", "retrieving the latest",
    "as an ai language model", "i'll look that up in the", "checking the knowledge base",
]


def score_no_tool_narration(text: str):
    low = (text or "").lower()
    hit = [p for p in _BANNED_NARRATION if p in low]
    if not hit:
        return 2, "no tool/mechanics narration"
    return 0, "tool-narration: " + "; ".join(hit[:3])


# ── tool discipline ──────────────────────────────────────────────────────────
def all_known_tools() -> set:
    """The real advertised tool surface (from the agent's own defs). Imported lazily so the
    module stays import-light; the def modules are pure (no mcp/pipecat)."""
    from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
    from local_tools import LOCAL_TOOL_DEFINITIONS
    return {t["function"]["name"] for t in MNEMA_TOOL_DEFINITIONS + LOCAL_TOOL_DEFINITIONS}


def score_tool_discipline(tool_calls: list, must_call_tool: bool, known: set | None = None):
    """tool_calls = [{'name':..., 'args':...}, …] actually made for ONE question.
    Fail (0) on: a call to a non-existent/unadvertised tool (the get_meeting_context 404
    class), OR more than 2 tools chained (the 5-tool thrash). If the question REQUIRES a
    live tool and none was called → 0. Otherwise 2."""
    known = known if known is not None else all_known_tools()
    names = [c.get("name") for c in (tool_calls or [])]
    ghosts = [n for n in names if n not in known]
    if ghosts:
        return 0, f"called non-existent tool(s): {', '.join(ghosts)}"
    if len(names) > 2:
        return 0, f"thrash: {len(names)} tools chained ({', '.join(names)})"
    if must_call_tool and not names:
        return 0, "live-state question but NO tool called (answered from memory)"
    detail = f"{len(names)} tool(s): {', '.join(names) or 'none'}"
    return 2, detail


# ── silence ──────────────────────────────────────────────────────────────────
def score_silence(text: str):
    t = (text or "").strip()
    if t == SILENT_TOKEN:
        return 2, "returned <silent> exactly"
    if not t:
        return 2, "stayed silent (empty, dropped)"
    return 0, f"spoke when it should have stayed silent: {t[:60]!r}"


# ── completeness (multi-part) ────────────────────────────────────────────────
def score_completeness(text: str, parts: list):
    """parts = list of synonym-groups (each a list of acceptable lowercase substrings); a
    part is covered if ANY of its synonyms appears. Both parts → 2, one → 1, none → 0."""
    low = (text or "").lower()
    covered = []
    for group in parts:
        syns = group if isinstance(group, (list, tuple)) else [group]
        covered.append(any(s.lower() in low for s in syns))
    n = sum(covered)
    if n == len(parts):
        return 2, f"all {len(parts)} parts covered"
    if n == 0:
        return 0, "neither part answered"
    return 1, f"only {n}/{len(parts)} parts covered"


# ── honesty signal (deterministic aid for honesty Qs) ────────────────────────
_ADMIT_PHRASES = [
    "i don't have", "i do not have", "i can't see", "i cannot see", "i don't see",
    "no record", "not in", "i'm not sure", "i am not sure", "can't find", "cannot find",
    "don't have that", "nothing on", "i haven't", "i don't know", "not something i have",
    "i don't think i have", "won't guess", "can't tell", "i don't have that recorded",
    "not tracked", "i don't have a record", "i'm not seeing",
]


def admits_no_data(text: str) -> bool:
    low = (text or "").lower()
    return any(p in low for p in _ADMIT_PHRASES)


_NUMBER_RE = re.compile(r"\b\d[\d,.]*\b")


def has_specific_number(text: str) -> bool:
    """A specific figure in the answer — for honesty Qs (Q7 budget, Q9 count) a number is a
    fabrication red flag unless it's clearly a refusal. Times/dates excluded loosely."""
    return bool(_NUMBER_RE.search(text or ""))


# ── human-delivery heuristic ─────────────────────────────────────────────────
_CALL_CENTRE = [
    "is there anything else", "happy to help", "how can i help", "how may i assist",
    "let me know if you need anything", "feel free to", "anything else i can",
    "i'm here to help", "glad to assist", "as always, ",
]
_SENT_SPLIT = re.compile(r"[.!?]+(?:\s|$)|\n+")


def _sentences(text: str) -> list:
    return [s.strip() for s in _SENT_SPLIT.split(text or "") if s.strip()]


def human_delivery_heuristic(text: str):
    """Heuristic 0–2 on cadence: spoken punctuation present, varied sentence length, no
    call-centre tics. Reported alongside the judge's HUMAN_DELIVERY score (not a substitute).
    Returns (score, details dict)."""
    t = text or ""
    low = t.lower()
    sents = _sentences(t)
    lengths = [len(s.split()) for s in sents] or [0]
    variance = statistics.pstdev(lengths) if len(lengths) > 1 else 0.0
    has_punct = bool(re.search(r"[,—…]|--|\.\.\.|\?", t))
    tics = [p for p in _CALL_CENTRE if p in low]
    flat = len(lengths) > 1 and variance < 1.0

    score = 2
    reasons = []
    if not has_punct:
        score -= 1
        reasons.append("no spoken punctuation (comma/em-dash/ellipsis/?)")
    if tics:
        score -= 1
        reasons.append("call-centre phrase: " + tics[0])
    if flat:
        score -= 1
        reasons.append(f"flat sentence length (stdev={variance:.1f})")
    score = max(0, score)
    details = {
        "sentences": len(sents),
        "lengths": lengths,
        "length_stdev": round(variance, 2),
        "has_spoken_punctuation": has_punct,
        "call_centre_phrases": tics,
        "reasons": reasons or ["varied length + spoken punctuation, no tics"],
    }
    return score, "; ".join(details["reasons"])
