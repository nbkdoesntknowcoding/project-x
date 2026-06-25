"""Unit tests for the config-gated recap: builders (plain-text, degrade, no LLM) + flags."""
import os, sys, re, importlib
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import recap  # noqa: E402

def _no_markup(s):
    assert all(t not in s for t in ["#", "**", "`", "|", ">", "]("]) and "*" not in s

# ── default OFF (zero behavior change unless explicitly enabled) ──────────────────
def test_flags_default_off(monkeypatch):
    monkeypatch.delenv("MNEMA_RECAP_START", raising=False)
    monkeypatch.delenv("MNEMA_RECAP_END", raising=False)
    importlib.reload(recap)
    assert recap.recap_on_start() is False
    assert recap.recap_on_end() is False

def test_flags_enable(monkeypatch):
    monkeypatch.setenv("MNEMA_RECAP_START", "1")
    monkeypatch.setenv("MNEMA_RECAP_END", "true")
    assert recap.recap_on_start() is True and recap.recap_on_end() is True
    monkeypatch.setenv("MNEMA_RECAP_START", "off")
    assert recap.recap_on_start() is False

# ── start recap: from brief, plain text, degrade to silence ──────────────────────
def test_start_recap_from_brief_plaintext():
    out = recap.build_start_recap("**Billing** and the `migration` are the open threads.")
    assert out and "Billing" in out and "migration" in out
    _no_markup(out)

def test_start_recap_empty_brief_is_silent():
    assert recap.build_start_recap("") == ""
    assert recap.build_start_recap("   ") == ""

# ── end recap: only captured items, no fabrication, no LLM (pure string op) ───────
def test_end_recap_names_items():
    out = recap.build_end_recap(["follow up with the vendor", "ship the pricing change"])
    assert "follow up with the vendor" in out and "ship the pricing change" in out
    assert "2 follow-ups" in out
    _no_markup(out)

def test_end_recap_single_item():
    out = recap.build_end_recap(["email the deck"])
    assert "one follow-up" in out and "email the deck" in out

def test_end_recap_no_items_is_silent():
    assert recap.build_end_recap([]) == ""
    assert recap.build_end_recap(None) == ""
    assert recap.build_end_recap(["", "  "]) == ""

def test_builders_make_no_model_call():
    # recap module imports only os + text_norm (no openai / mcp / network)
    import inspect
    src = inspect.getsource(recap)
    for bad in ["import openai", "from openai", "AsyncOpenAI", "chat.completions",
                "import mcp", "from mcp", "requests", "httpx"]:
        assert bad not in src, bad
