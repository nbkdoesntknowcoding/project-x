"""
llm_config.py — single source of truth for the meeting bot's LLM wiring (pure; no SDK/pipecat
imports, so it is unit-testable and shared by BOTH the live pipeline and the realness harness
mirror). Secrets are read from env only; nothing is committed.

Model decision (locked): GPT-4.1 — OpenAI, openai-compatible, 1M context, reliable
function-calling, NO reasoning pause (a reasoning step would add latency that breaks voice).
The model id comes from MNEMA_LLM_MODEL (new), falling back to the older swap vars for
compatibility, defaulting to gpt-4.1. Key/base url reuse the existing OpenAI env wiring.
"""

DEFAULT_MODEL = "gpt-4.1"


def resolve_model(env) -> str:
    """The LLM model id. Precedence: MNEMA_LLM_MODEL (new, primary) → MEETING_LLM_MODEL →
    OPENAI_LLM_MODEL → gpt-4.1. Empty/whitespace values are ignored so an unset-but-present
    var doesn't blank the model."""
    for key in ("MNEMA_LLM_MODEL", "MEETING_LLM_MODEL", "OPENAI_LLM_MODEL"):
        v = (env.get(key) or "").strip()
        if v:
            return v
    return DEFAULT_MODEL


def resolve_api_key(env) -> str:
    """The OpenAI(-compatible) API key. MEETING_LLM_API_KEY overrides OPENAI_API_KEY (for a
    swapped provider); otherwise the standard OpenAI key. Never logged."""
    return (env.get("MEETING_LLM_API_KEY") or "").strip() or env.get("OPENAI_API_KEY", "")


def resolve_base_url(env):
    """Optional base url for an openai-compatible endpoint (MEETING_LLM_BASE_URL). None for
    the default OpenAI endpoint — GPT-4.1 uses the default."""
    return (env.get("MEETING_LLM_BASE_URL") or "").strip() or None
