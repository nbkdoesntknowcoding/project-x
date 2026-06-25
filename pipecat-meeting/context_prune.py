"""
context_prune.py — keep the per-turn LLM context lean so the persona binds.

ROOT CAUSE (live-log audit, 2026-06-25): every addressed turn appends the Layer B
"[Speaking now]" block AND the "[Background]" grounding block as PERSISTENT system
messages (LLMMessagesAppendFrame). They are never removed, so after a handful of turns
the context holds a stack of stale [Speaking now]/[Background] copies and the whole
meeting replayed verbatim — pushing Layer A (the persona) thousands of tokens away from
the live question. gpt-4o-mini then falls back to its generic assistant voice and reads
markdown aloud. This module fixes the SHAPE of the context, not the wording.

Two pure operations on the raw universal message list (LLMContext.get_messages() returns
it; set_messages() replaces it — verified against pipecat 1.2.1):

  strip_transient_blocks(messages)
    Remove the PREVIOUS turns' transient per-turn system blocks (Layer B, Layer C
    re-anchor, [Background]). Called at the top of each addressed turn, BEFORE the fresh
    blocks for this turn are injected — so exactly ONE copy of each survives, sitting
    right next to the live question. Layer A (the first system message) and the one-shot
    startup briefs are NOT transient (their markers aren't listed) and are preserved.

  bound_conversation(messages, max_user_turns)
    Keep a rolling window of the last N user turns instead of the whole meeting. Cuts
    ONLY at user-message boundaries, so an assistant tool_calls message is never split
    from its tool-result reply (which would make the OpenAI-compatible API reject the
    request). All system messages (Layer A + one-shot briefs) are preserved regardless of
    age; only old conversation turns are dropped.

Pure list-in/list-out, no pipecat import, so the logic is unit-tested without the bot.
Messages may be plain dicts ({"role","content"}) or opaque non-dict provider objects
(tool-call wrappers); anything not a recognised plain system dict is left untouched.
"""
from typing import Any

# Leading markers identifying the TRANSIENT per-turn system blocks injected fresh every
# addressed turn (see pipeline.RAGContext). These must NOT accumulate.
#   "[Speaking now]"                 — Layer B, when the speaker is identified
#   "Read what this person needs"    — Layer B modulation paragraph, when no name (no header)
#   "[A reminder, partway through]"  — Layer C drift re-anchor
#   "[Background"                    — A2.2 per-turn graph grounding
# NOT listed (so they are KEPT — injected once, off the turn path):
#   "[Workspace —", "[What this person is connected to", "[Last time, for continuity",
#   "[Cross-project connections", and Layer A (the first system message).
TRANSIENT_PREFIXES = (
    "[Speaking now]",
    "Read what this person needs right now",
    "[A reminder, partway through]",
    "[Background",
    "[You're being spoken to directly",   # STEP 1 addressed-directive (re-injected each turn)
)


def _content_str(msg: Any) -> str | None:
    """The string content of a plain {'role','content'} dict message, else None.
    Non-dict messages and non-string content (tool calls, structured parts) return None
    so they are never matched/removed by the transient filter."""
    if not isinstance(msg, dict):
        return None
    if msg.get("role") != "system":
        return None
    c = msg.get("content")
    return c if isinstance(c, str) else None


def is_transient_system(msg: Any) -> bool:
    """True iff msg is a transient per-turn system block that should be re-injected fresh
    each turn rather than allowed to accumulate."""
    c = _content_str(msg)
    if c is None:
        return False
    return c.lstrip().startswith(TRANSIENT_PREFIXES)


def strip_transient_blocks(messages: list) -> list:
    """Return a NEW list with every transient per-turn system block removed. Order of all
    surviving messages is preserved. Layer A and the one-shot briefs survive."""
    return [m for m in messages if not is_transient_system(m)]


def bound_conversation(messages: list, max_user_turns: int = 8) -> list:
    """Keep at most the last `max_user_turns` user turns of conversation, dropping older
    user/assistant/tool messages. ALL system messages are preserved (Layer A + one-shot
    briefs). Cuts only at a user-message boundary so tool_calls/tool-result pairs are
    never split. max_user_turns <= 0 disables the bound (returns a copy)."""
    if max_user_turns <= 0:
        return list(messages)
    user_idx = [i for i, m in enumerate(messages)
                if isinstance(m, dict) and m.get("role") == "user"]
    if len(user_idx) <= max_user_turns:
        return list(messages)
    cut = user_idx[-max_user_turns]  # first index of the window we keep (a user message)
    kept = []
    for i, m in enumerate(messages):
        if i >= cut:
            kept.append(m)                      # inside the window — keep everything
        elif isinstance(m, dict) and m.get("role") == "system":
            kept.append(m)                      # older system context (persona/briefs) — keep
        # else: an old user/assistant/tool message outside the window — drop
    return kept


def prune_context(messages: list, max_user_turns: int = 8) -> list:
    """Full per-turn prune: drop stale transient blocks, then bound the conversation
    window. Run at the START of an addressed turn, before this turn's fresh blocks are
    injected. Pure; safe to call every turn."""
    return bound_conversation(strip_transient_blocks(messages), max_user_turns)


def count_system_blocks(messages: list) -> dict:
    """Diagnostic: count system messages by their leading marker (for the verification
    print and tests — proves no duplicate transient blocks remain)."""
    counts: dict[str, int] = {}
    for m in messages:
        c = _content_str(m)
        if c is None:
            continue
        head = c.lstrip()[:24].splitlines()[0] if c.strip() else "(empty)"
        counts[head] = counts.get(head, 0) + 1
    return counts
