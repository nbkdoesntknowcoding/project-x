"""Unit tests for to_spoken_plaintext — markdown→spoken-prose for the [Background] block."""
import os, sys, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from text_norm import to_spoken_plaintext as norm  # noqa: E402

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
