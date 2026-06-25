"""Unit tests for tool_guard — STEP 3: stop the tool-thrash. Covers the per-turn cap,
failure detection + nudge, and a simulated 'get_meeting_context keeps failing' turn proving
the loop is bounded and the guidance never narrates tool mechanics."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tool_guard import (  # noqa: E402
    over_cap, cap_result, is_failure, annotate_failure, over_same_tool_cap, same_tool_cap_result,
)


# ── STEP 1: per-tool fan-out cap (list_project_tasks once per project) ──
def test_same_tool_cap_blocks_fanout():
    cap = 2
    counts, real, blocked = {}, 0, 0
    for project in ["p1", "p2", "p3", "p4", "p5"]:
        name = "list_project_tasks"
        if over_same_tool_cap(counts.get(name, 0), cap):
            blocked += 1
            continue
        counts[name] = counts.get(name, 0) + 1
        real += 1
    assert real == 2 and blocked == 3            # hard-capped at 2, rest short-circuited
    msg = same_tool_cap_result("list_project_tasks", cap)
    assert msg["capped"] and "already called list_project_tasks" in msg["note"]
    assert "do not call it again" in msg["note"].lower() or "do not search again" in msg["note"].lower()


def test_same_tool_cap_allows_diverse_chain():
    cap = 2
    counts = {}
    for name in ["list_projects", "search_knowledge", "get_doc"]:
        assert not over_same_tool_cap(counts.get(name, 0), cap)  # different tools never capped
        counts[name] = counts.get(name, 0) + 1
    assert not over_same_tool_cap(0, 0)          # cap<=0 disables


def test_over_cap_threshold_and_disable():
    assert not over_cap(0, 6)
    assert not over_cap(5, 6)
    assert over_cap(6, 6)
    assert over_cap(9, 6)
    assert not over_cap(100, 0)   # 0 disables the cap


def test_cap_result_tells_model_to_answer_not_search():
    r = cap_result(6)
    assert r["capped"] is True
    note = r["note"].lower()
    assert "do not search again" in note or "do not search" in note
    assert "never mention searching" in note


def test_is_failure_detects_errors_and_empty():
    assert is_failure(None)
    assert is_failure({"success": False, "error": "Tool get_meeting_context not found"})
    assert is_failure({"error": "boom"})
    assert is_failure({"content": ""})
    assert is_failure({"content": "   "})
    assert is_failure({"results": []})
    assert is_failure("")
    assert is_failure({})


def test_is_failure_passes_real_results():
    assert not is_failure({"content": "The timeline is end of month."})
    assert not is_failure({"results": [{"title": "Doc"}]})
    assert not is_failure("an actual answer")
    assert not is_failure({"id": "abc", "title": "Project A"})


def test_annotate_failure_adds_nudge_without_mechanics():
    out = annotate_failure({"success": False, "error": "not found"})
    g = out["guidance"].lower()
    assert "never mention" in g and "tools" in g
    # original fields preserved
    assert out["error"] == "not found"
    # non-dict wrapped
    assert annotate_failure("x")["result"] == "x"


# ── simulate the live failure mode: get_meeting_context fails repeatedly ──────
def test_repeated_failure_turn_is_bounded_and_clean():
    """The model 'tries' the same failing lookup many times in one turn; the cap stops it
    and no result ever contains mechanics-narration phrasing."""
    cap = 6
    count = 0
    emitted = []
    for _ in range(12):                      # model attempts 12 calls
        if over_cap(count, cap):
            emitted.append(cap_result(cap))  # short-circuit, no real call
            continue
        count += 1
        result = {"success": False, "error": "Tool get_meeting_context not found"}
        emitted.append(annotate_failure(result))
    # real calls were bounded by the cap (no runaway loop)
    assert count == cap
    assert len(emitted) == 12 and sum(1 for e in emitted if e.get("capped")) == 12 - cap
    # every emitted result steers the model toward answering, not looping: it is either a
    # cap short-circuit or carries the "answer with what you have, don't mention tools" nudge
    assert all(("guidance" in e) or e.get("capped") for e in emitted)
    for e in emitted:
        note = (e.get("guidance") or e.get("note") or "").lower()
        assert "never mention searching, tools" in note  # forbids mechanics narration
