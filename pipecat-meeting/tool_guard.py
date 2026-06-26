"""
tool_guard.py — stop the tool-thrash (STEP 3). Pure, testable decision logic; the wiring
lives in mnema_client._make_handler (which holds the BotState turn counter).

Live-log failure mode (2026-06-25): when a lookup failed or came back thin, the model
chained three to five more tool calls for the SAME question and narrated the mechanics —
"I've been having some trouble retrieving the latest meeting details…". The persona
already forbids that narration; this makes the PIPELINE enforce it by not letting the loop
happen:

  1. A per-turn cap (over_cap): after N tool calls in one user turn, short-circuit further
     calls with cap_result() — an instruction to answer from what's already gathered (or
     say it can't find it), never to keep searching. The counter is reset per user turn.
  2. A failure nudge (annotate_failure): when a single call fails or returns empty, attach
     a terse guidance note telling the model to answer with what it has and NOT to mention
     tools/searching — so one miss doesn't trigger a retry storm or mechanics talk.

Both keep retrieval working for legitimate multi-tool chains (resolve project → search →
fetch); the cap is generous and only bites on a runaway loop.
"""
from typing import Any

# Short, model-facing guidance. Phrased as the result the model reads back, so it nudges
# the next step without the bot ever speaking about tools.
_NO_MENTION = ("Answer the person now in your own words with what you already have, or say "
               "plainly that you can't find it. Do NOT search again, and never mention "
               "searching, tools, or 'having trouble retrieving'.")


def over_cap(count: int, cap: int) -> bool:
    """True once this turn's tool-call count has reached the cap (cap <= 0 disables)."""
    return cap > 0 and count >= cap


def cap_result(cap: int) -> dict:
    """The result returned INSTEAD of a real tool call once the per-turn cap is hit."""
    return {"capped": True,
            "note": f"Already checked {cap} things this turn. " + _NO_MENTION}


def over_same_tool_cap(count: int, cap: int) -> bool:
    """True once ONE tool has been called `cap` times in a single turn (cap <= 0 disables).
    This is the fan-out guard: gpt-4.1 answers a board/status question by calling
    list_project_tasks once PER project (5+ calls). The cross-project view is already in the
    list_projects counts, so repeating the same tool per project is wasted thrash."""
    return cap > 0 and count >= cap


def same_tool_cap_result(name: str, cap: int) -> dict:
    """Returned INSTEAD of a repeated same-tool call once its per-turn cap is hit — tells the
    model it already has what that tool returns and to answer from it, not fan out further.
    Crucially: if it was COUNTING across projects, it must NOT report a total from the partial
    data it gathered — either use list_projects' per-project counts (which already total it) or
    say plainly what it could and couldn't count. Never a number it didn't fully count."""
    return {"capped": True,
            "note": (f"You've already called {name} {cap} times this turn — stop calling it. "
                     f"If you're counting tasks across projects, do NOT add up only the few you "
                     f"fetched and report that as the total — that's a partial count. Instead use "
                     f"the per-project taskCounts from list_projects (they already cover every "
                     f"project in one call), or, if you truly can't, say what you have and name "
                     f"the gap ('I can see VAP's, but I didn't get the others') and give NO total. "
                     + _NO_MENTION)}


def is_failure(result: Any) -> bool:
    """True if a tool result is an error or empty — i.e. it gave the model nothing useful."""
    if result is None:
        return True
    if isinstance(result, dict):
        if result.get("success") is False or result.get("error"):
            return True
        # an MCP text/result envelope that came back empty
        if set(result.keys()) <= {"content", "results"}:
            content = result.get("content")
            results = result.get("results")
            empty_content = content is None or (isinstance(content, str) and not content.strip())
            empty_results = results is None or (isinstance(results, (list, tuple)) and len(results) == 0)
            has_content_key = "content" in result
            has_results_key = "results" in result
            if (not has_content_key or empty_content) and (not has_results_key or empty_results):
                return True
        return False
    if isinstance(result, str):
        return not result.strip()
    return False


def annotate_failure(result: Any) -> Any:
    """Attach the 'answer with what you have, don't mention tools' nudge to a failed/empty
    result. Non-dict results are wrapped so the note still rides along. Never raises."""
    note = _NO_MENTION
    if isinstance(result, dict):
        out = dict(result)
        out.setdefault("guidance", note)
        return out
    return {"result": result, "guidance": note}
