"""
text_norm.py — strip markdown FORMATTING to plain spoken prose (persona §3/§5: Mnema must
never read markup aloud). Applied to the [Background] grounding body right before it is
injected into the LLM context (see pipeline.RAGContext._inject). Regex/string only, no deps,
cheap enough for the turn path.

It removes SYNTAX, never content: headings, emphasis, inline/fenced code, bullet/numbered
lists, blockquotes, links/images, tables, and horizontal rules become plain words. Code-ish
identifiers (snake_case like list_project_tasks, dunders like __init__) are preserved — only
multi-word underscore emphasis is unwrapped, so identifiers are never mangled.
"""
import re

_MD_FENCE_RE   = re.compile(r"^\s*```")                       # ``` code fence markers
_MD_HR_RE      = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")  # --- *** ___ horizontal rule
_MD_TBL_SEP_RE = re.compile(r"^\s*\|?[\s:|-]*-{2,}[\s:|-]*$")  # | --- | --- | table divider
_MD_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*")             # ## Heading
_MD_QUOTE_RE   = re.compile(r"^\s{0,3}>\s?")                  # > blockquote
_MD_LIST_RE    = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")      # - item / 1. item
_MD_IMG_RE     = re.compile(r"!\[([^\]]*)\]\([^)]*\)")        # ![alt](url) -> alt
_MD_LINK_RE    = re.compile(r"\[([^\]]+)\]\([^)]*\)")         # [text](url) -> text
_MD_BOLD_RE    = re.compile(r"\*\*(.+?)\*\*", re.S)           # **bold** -> bold
_MD_ITAL_AST_RE = re.compile(r"\*(?!\s)(.+?)(?<!\s)\*", re.S)  # *italic* -> italic
# underscore emphasis ONLY for multi-word spans (has a space, no inner underscore) so
# snake_case / __dunders__ are left untouched.
_MD_EMPH_UND_RE = re.compile(r"(?<!\w)_{1,2}(?=\S)([^_]*?\s[^_]*?)(?<=\S)_{1,2}(?!\w)", re.S)
_MD_BAREURL_RE = re.compile(r"https?://\S+")
_MULTISPACE_RE = re.compile(r"[ \t]{2,}")
_MULTIBLANK_RE = re.compile(r"\n{3,}")


def to_spoken_plaintext(s: str) -> str:
    """Convert markdown to plain spoken prose. Strips formatting syntax only; keeps the words."""
    if not s:
        return ""
    lines = []
    for raw in s.splitlines():
        line = raw.rstrip()
        if _MD_FENCE_RE.match(line):                 # drop ``` fences, keep the code lines
            continue
        if _MD_HR_RE.match(line):                    # drop --- / *** rules
            continue
        if "|" in line and _MD_TBL_SEP_RE.match(line):  # drop table divider rows
            continue
        line = _MD_HEADING_RE.sub("", line)
        line = _MD_QUOTE_RE.sub("", line)
        line = _MD_LIST_RE.sub("", line)
        if line.lstrip().startswith("|") or line.count("|") >= 2:   # table row -> "a, b, c"
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            line = ", ".join(c for c in cells if c)
        elif " | " in line:                          # stray single pipe -> comma
            line = line.replace(" | ", ", ")
        lines.append(line)
    text = "\n".join(lines)
    text = _MD_IMG_RE.sub(r"\1", text)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _MD_BOLD_RE.sub(r"\1", text)
    text = _MD_ITAL_AST_RE.sub(r"\1", text)
    text = _MD_EMPH_UND_RE.sub(r"\1", text)
    text = text.replace("`", "")                     # inline code / leftover backticks
    text = _MD_BAREURL_RE.sub("", text)              # drop bare URLs
    text = _MULTISPACE_RE.sub(" ", text)
    text = _MULTIBLANK_RE.sub("\n\n", text)
    return text.strip()
