"""STEP 2 tests — GPT-4.1 model string is read from env (new MNEMA_LLM_MODEL), key/base url
reuse the existing OpenAI wiring, and the advertised tool/function schema is sent UNCHANGED."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from llm_config import resolve_model, resolve_api_key, resolve_base_url, DEFAULT_MODEL  # noqa: E402


def test_default_is_gpt_4_1():
    assert DEFAULT_MODEL == "gpt-4.1"
    assert resolve_model({}) == "gpt-4.1"
    # whitespace/empty vars are ignored, not treated as a model
    assert resolve_model({"MNEMA_LLM_MODEL": "  "}) == "gpt-4.1"


def test_env_precedence():
    assert resolve_model({"MNEMA_LLM_MODEL": "gpt-4.1"}) == "gpt-4.1"
    # MNEMA_LLM_MODEL wins over the older swap vars
    assert resolve_model({"MNEMA_LLM_MODEL": "gpt-4.1", "MEETING_LLM_MODEL": "old",
                          "OPENAI_LLM_MODEL": "older"}) == "gpt-4.1"
    # falls back through the legacy vars when the new one is unset
    assert resolve_model({"MEETING_LLM_MODEL": "x"}) == "x"
    assert resolve_model({"OPENAI_LLM_MODEL": "y"}) == "y"
    # a future override still works (env-driven, no code change)
    assert resolve_model({"MNEMA_LLM_MODEL": "gpt-4.1-mini"}) == "gpt-4.1-mini"


def test_key_and_base_reuse_openai_wiring():
    assert resolve_api_key({"OPENAI_API_KEY": "sk-x"}) == "sk-x"
    assert resolve_api_key({"MEETING_LLM_API_KEY": "sk-swap", "OPENAI_API_KEY": "sk-x"}) == "sk-swap"
    assert resolve_base_url({}) is None  # default OpenAI endpoint for GPT-4.1
    assert resolve_base_url({"MEETING_LLM_BASE_URL": "https://api.groq.com/openai/v1"}) == \
        "https://api.groq.com/openai/v1"


def test_tool_schema_unchanged():
    # the function/tool schema the bot advertises is independent of the model swap
    from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
    from local_tools import LOCAL_TOOL_DEFINITIONS
    names = [t["function"]["name"] for t in MNEMA_TOOL_DEFINITIONS + LOCAL_TOOL_DEFINITIONS]
    assert len(names) == 17  # 15 mnema (post meeting-tool removal) + 2 local
    assert "who_is_in_meeting" in names and "search_knowledge" in names
    # the removed-from-advertised meeting tools stay gone regardless of model
    assert "get_meeting_context" not in names and "get_meeting_brief" not in names
    # every advertised tool is a well-formed function schema (sent as-is to GPT-4.1)
    for t in MNEMA_TOOL_DEFINITIONS + LOCAL_TOOL_DEFINITIONS:
        assert t["type"] == "function" and "name" in t["function"]
