"""Unit tests for to_spoken_plaintext — markdown→spoken-prose for the [Background] block."""
import os, sys, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from text_norm import to_spoken_plaintext as norm  # noqa: E402
from text_norm import normalize_tool_result  # noqa: E402

def _no_markup(s):
    assert "#" not in s and "`" not in s and "|" not in s and ">" not in s
    assert "**" not in s and "](" not in s
    for ln in s.splitlines():
        assert not re.match(r"^\s*(?:[-*+]|\d+[.)])\s+", ln)  # no list markers

def test_strips_all_markdown_tokens():
    md = ("# Heading\n\nThis is **bold** and *italic* and `code`.\n\n"
          "- first item\n- second item\n1. step one\n\n"
          "> a quote\n\nSee [the doc](https://x.io/y) for more.\n\n"
          "| Col A | Col B |\n| --- | --- |\n| 1 | 2 |\n\n"
          "```python\nx = 1\n```\n")
    out = norm(md)
    _no_markup(out)
    for word in ["Heading", "bold", "italic", "code", "first item", "second item",
                 "step one", "a quote", "the doc", "Col A", "Col B", "x = 1"]:
        assert word in out, word

def test_preserves_snake_case_and_dunder():
    out = norm("Call **list_project_tasks** then `get_doc`; see __init__ for setup.")
    assert "list_project_tasks" in out and "get_doc" in out and "__init__" in out
    assert "**" not in out and "`" not in out

def test_multiword_underscore_emphasis_unwrapped():
    out = norm("this is _really important_ stuff")
    assert "really important" in out and "_really important_" not in out

def test_link_to_text_and_bare_url_dropped():
    out = norm("read [the spec](https://a.b/c) and https://bare.url/x here")
    assert "the spec" in out and "http" not in out

def test_table_flattened():
    out = norm("| Name | Role |\n| --- | --- |\n| Nischay | CEO |")
    assert "Name, Role" in out and "Nischay, CEO" in out and "|" not in out

def test_empty_and_plain_passthrough():
    assert norm("") == ""
    assert norm("just plain spoken words") == "just plain spoken words"


# ── STEP 2: normalize_tool_result — markdown out of tool RESULTS, ids preserved ──
def test_tool_result_get_doc_markdown_stripped():
    # the exact shape that made Mnema recite markup in the live log
    result = {"content": ("# Post-Meeting Notes\n## Transcript\n\n"
                          "**Nischay B K:** Hey, nama. How are you?\n\n"
                          "- action: ship the build\n- owner: Nischay\n")}
    out = normalize_tool_result(result)
    body = out["content"]
    assert "#" not in body and "**" not in body
    for ln in body.splitlines():
        assert not re.match(r"^\s*[-*+]\s+", ln)  # no bullet markers
    # content preserved
    assert "Post-Meeting Notes" in body and "Nischay B K" in body and "ship the build" in body


def test_tool_result_nested_list_rows_normalized():
    result = {"results": [
        {"title": "**Voice** Agent", "snippet": "see `pipeline.py` and the - notes",
         "id": "550e8400-e29b-41d4-a716-446655440000", "project_id": "abc-123"},
    ]}
    out = normalize_tool_result(result)
    row = out["results"][0]
    assert row["title"] == "Voice Agent"
    assert "`" not in row["snippet"] and "pipeline.py" in row["snippet"]
    # opaque ids preserved byte-exact (model passes them into follow-up calls)
    assert row["id"] == "550e8400-e29b-41d4-a716-446655440000"
    assert row["project_id"] == "abc-123"


def test_tool_result_preserves_non_strings_and_shape():
    result = {"limit": 5, "ok": True, "items": ["**a**", "b"], "nested": {"count": 2}}
    out = normalize_tool_result(result)
    assert out["limit"] == 5 and out["ok"] is True and out["nested"]["count"] == 2
    assert out["items"] == ["a", "b"]


def test_tool_result_path_and_token_preserved():
    result = {"path": "/docs/**weird**/path", "proposal_token": "tok_**abc**", "content": "**hi**"}
    out = normalize_tool_result(result)
    assert out["path"] == "/docs/**weird**/path"          # opaque — untouched
    assert out["proposal_token"] == "tok_**abc**"          # opaque — untouched
    assert out["content"] == "hi"                          # prose — normalized
