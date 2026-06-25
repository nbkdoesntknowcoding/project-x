"""Local unit tests for the PURE parts of the realness harness (questions/checks/report).
The live turn/MCP/LLM/judge parts run on the VPS; these prove the scoring + rendering logic
is correct here, so a VPS run isn't wasted on a buggy scorer."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from realness import questions as Q  # noqa: E402
from realness import checks as C  # noqa: E402
from realness import report as R  # noqa: E402


# ── question set integrity ───────────────────────────────────────────────────
def test_question_set_shape():
    assert len(Q.QUESTIONS) == 23
    assert {q["id"] for q in Q.QUESTIONS} == {f"Q{i}" for i in range(1, 24)}
    # silence question is the only non-addressed one
    sil = Q.by_id("Q23")
    assert sil["expect"]["addressed"] is False
    assert Q.SILENCE in sil["rubrics"]
    # live-state questions require a tool
    for qid in ("Q11", "Q12", "Q13"):
        assert Q.by_id(qid)["expect"].get("must_call_tool") is True


# ── markdown detection ───────────────────────────────────────────────────────
def test_markdown_detection():
    assert C.score_no_markdown("Plain spoken sentence, nothing fancy.")[0] == 2
    assert C.score_no_markdown("end-to-end and well-tested is fine")[0] == 2  # hyphen-in-word ok
    assert C.score_no_markdown("- **Title:** Notes")[0] == 0
    assert C.score_no_markdown("# Heading")[0] == 0
    assert C.score_no_markdown("see `code`")[0] == 0
    assert C.score_no_markdown("a | b | c")[0] == 0
    assert C.score_no_markdown("read [the doc](http://x)")[0] == 0


# ── tool narration ───────────────────────────────────────────────────────────
def test_tool_narration():
    assert C.score_no_tool_narration("Last call was end of month.")[0] == 2
    assert C.score_no_tool_narration("Let me pull those for you now.")[0] == 2  # human, allowed
    assert C.score_no_tool_narration("I've been having some trouble retrieving the latest details.")[0] == 0
    assert C.score_no_tool_narration("According to the document, the date is set.")[0] == 0


# ── tool discipline ──────────────────────────────────────────────────────────
def test_tool_discipline():
    known = {"who_is_in_meeting", "search_knowledge", "list_project_tasks", "list_recent_docs"}
    # live-state, one valid tool → pass
    assert C.score_tool_discipline([{"name": "who_is_in_meeting"}], True, known)[0] == 2
    # live-state, no tool → fail
    assert C.score_tool_discipline([], True, known)[0] == 0
    # ghost tool → fail (the get_meeting_context 404 class)
    assert C.score_tool_discipline([{"name": "get_meeting_context"}], False, known)[0] == 0
    # >2 chained → thrash fail
    assert C.score_tool_discipline(
        [{"name": "search_knowledge"}, {"name": "list_recent_docs"}, {"name": "list_project_tasks"}],
        False, known)[0] == 0
    # 2 is allowed
    assert C.score_tool_discipline(
        [{"name": "list_projects" if False else "search_knowledge"}, {"name": "list_recent_docs"}],
        False, known)[0] == 2


def test_known_tools_excludes_removed_meeting_context():
    known = C.all_known_tools()
    assert "get_meeting_context" not in known
    assert "get_meeting_brief" not in known
    assert "who_is_in_meeting" in known and "search_knowledge" in known


# ── silence ──────────────────────────────────────────────────────────────────
def test_silence():
    assert C.score_silence("<silent>")[0] == 2
    assert C.score_silence("")[0] == 2
    assert C.score_silence("Sure, I think shipping it makes sense.")[0] == 0


# ── completeness ─────────────────────────────────────────────────────────────
def test_completeness():
    parts = Q.by_id("Q16")["expect"]["multipart"]
    assert C.score_completeness("The voice agent is close; we settled on Inworld for TTS.", parts)[0] == 2
    assert C.score_completeness("The voice agent is coming along well.", parts)[0] == 1
    assert C.score_completeness("Things are going fine overall.", parts)[0] == 0


# ── honesty + human delivery ─────────────────────────────────────────────────
def test_admits_no_data():
    assert C.admits_no_data("I don't have that recorded, so I won't guess.")
    assert C.admits_no_data("I can't see a budget number from here.")
    assert not C.admits_no_data("The budget we agreed was forty thousand dollars.")


def test_human_delivery_heuristic():
    good = "Last call was end of month — that hasn't shifted. Want the detail, or just the date?"
    sgood, _ = C.human_delivery_heuristic(good)
    assert sgood == 2
    # call-centre + flat
    bad = "I have processed your request. Is there anything else I can help you with today?"
    sbad, _ = C.human_delivery_heuristic(bad)
    assert sbad < 2


# ── aggregation + render ─────────────────────────────────────────────────────
def _row(qid, cat, answer, scores, tools=None):
    return {"id": qid, "category": cat, "text": "?", "answer": answer,
            "tool_calls": tools or [], "scores": scores, "human_heuristic": None}


def test_aggregate_and_render():
    rows = [
        _row("Q1", "grounded_recall", "It was about the voice agent.",
             {"GROUNDED": {"score": 2, "reason": "ok", "source": "judge"},
              "NO_MARKDOWN": {"score": 2, "reason": "clean", "source": "deterministic"}}),
        _row("Q14", "recitation_trap", "# Post-Meeting Notes\nJune 25",
             {"NO_RECITATION": {"score": 0, "reason": "dumped title+date as content", "source": "judge"},
              "NO_MARKDOWN": {"score": 0, "reason": "markdown present: heading", "source": "deterministic"}}),
    ]
    agg = R.aggregate_results(rows)
    assert 0 <= agg["realness_score"] <= 100
    # Q1 all 2s, Q14 all 0s → mean of [2,2,0,0]=1.0 → 50.0
    assert agg["realness_score"] == 50.0
    assert any("Q14 NO_RECITATION FAIL" in f for f in agg["fails"])
    assert any("Q14 NO_MARKDOWN FAIL" in f for f in agg["fails"])
    assert agg["rubric_rates"]["NO_MARKDOWN"]["fails"] == 1

    results = {"aggregate": agg, "rows": rows, "sequence_rows": [],
               "meta": {"model": "gpt-4o-mini", "judge_model": "gpt-4o",
                        "generated_at": "2026-06-25", "workspace": "The Boring People"}}
    md = R.render_report(results)
    assert "Realness score: 50.0 / 100" in md
    assert "Q14 NO_RECITATION FAIL" in md
    assert "Answer (verbatim)" in md
    assert "# Post-Meeting Notes" in md  # raw answer preserved for eyeballing
