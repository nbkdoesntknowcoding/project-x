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


# Keys whose VALUES are opaque machine identifiers the model passes back into later tool
# calls — never prose. We skip normalizing these so a UUID / token / path is preserved
# byte-exact (to_spoken_plaintext wouldn't usually alter them, but skipping is safer than
# relying on that). Everything else that is a string IS spoken text and gets normalized.
_OPAQUE_KEYS = frozenset({
    "id", "ids", "doc_id", "docid", "project_id", "projectid", "folder_id", "parent_id",
    "task_id", "node_id", "meeting_id", "meetingid", "recall_bot_id", "bot_id",
    "proposal_token", "token", "cid", "slug", "path", "url", "href", "uuid", "key",
})


def normalize_tool_result(obj, _key: str | None = None):
    """STEP 2: recursively convert every PROSE string in a tool result to spoken plaintext,
    so raw markdown from get_doc / search_knowledge / list_recent_docs (headings, bold,
    bullets, tables, links) never reaches the LLM context and gets read aloud. The SAME
    normalizer as the [Background] block — one normalizer for results and output.

    Structure is preserved (dict/list shape unchanged); only string leaves are cleaned.
    Values under opaque-identifier keys (id, project_id, token, path, …) are left exactly
    as-is so the model can still pass them into a follow-up tool call. snake_case / dunder
    identifiers inside prose are preserved by to_spoken_plaintext itself."""
    if isinstance(obj, dict):
        return {k: normalize_tool_result(v, _key=k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [normalize_tool_result(v, _key=_key) for v in obj]
    if isinstance(obj, str):
        if _key is not None and _key.lower() in _OPAQUE_KEYS:
            return obj
        return to_spoken_plaintext(obj)
    return obj
