"""
Unit tests for the A3.2 validation harness — the pure scorer + schema validator.
The live model runs need API keys; here we verify the deterministic scoring logic and
that the real tool schemas are well-formed. Run: pytest pipecat-meeting/tests/test_validate_tools.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import validate_tools as vt  # noqa: E402


# ── schema validation ────────────────────────────────────────────────────────────
def test_real_tool_schemas_are_well_formed():
    assert vt.validate_schemas() == []
    assert "search_knowledge" in vt.TOOL_NAMES
    assert "traverse_graph" in vt.TOOL_NAMES


def test_cases_cover_all_kinds():
    kinds = {next(iter(c["expect"])) for c in vt.CASES}
    assert {"tool", "silent", "answer"} <= kinds


# ── scorer: tool cases ───────────────────────────────────────────────────────────
def test_tool_correct_selection():
    r = vt.evaluate_response({"tool": "search_knowledge"},
                             [{"name": "search_knowledge", "arguments": '{"query":"x"}'}], "")
    assert r["selection_ok"] and r["format_valid"]


def test_tool_missed_no_call():
    r = vt.evaluate_response({"tool": "search_knowledge"}, [], "let me think")
    assert r["selection_ok"] is False
    assert r["format_valid"] is True  # no call → format not violated


def test_tool_wrong_tool():
    r = vt.evaluate_response({"tool": "search_knowledge"},
                             [{"name": "list_projects", "arguments": "{}"}], "")
    assert r["selection_ok"] is False and r["format_valid"] is True


def test_tool_unknown_name_is_format_invalid():
    r = vt.evaluate_response({"tool": "search_knowledge"},
                             [{"name": "made_up_tool", "arguments": "{}"}], "")
    assert r["format_valid"] is False


def test_tool_bad_json_args_is_format_invalid():
    r = vt.evaluate_response({"tool": "search_knowledge"},
                             [{"name": "search_knowledge", "arguments": "{not json"}], "")
    assert r["format_valid"] is False


# ── scorer: silent + answer cases ────────────────────────────────────────────────
def test_silent_correct():
    r = vt.evaluate_response({"silent": True}, [], "<silent>")
    assert r["silent_ok"] is True


def test_silent_violated_by_tool_call():
    r = vt.evaluate_response({"silent": True}, [{"name": "whoami", "arguments": "{}"}], "")
    assert r["silent_ok"] is False


def test_silent_violated_by_speaking():
    r = vt.evaluate_response({"silent": True}, [], "Sure, I can help with that.")
    assert r["silent_ok"] is False


def test_answer_correct():
    r = vt.evaluate_response({"answer": True}, [], "Hi! How can I help?")
    assert r["selection_ok"] is True


def test_answer_violated_by_silent():
    r = vt.evaluate_response({"answer": True}, [], "<silent>")
    assert r["selection_ok"] is False
