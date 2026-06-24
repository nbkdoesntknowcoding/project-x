"""
Unit tests for mnema_client.MnemaMCP._identity — A1.3 identity / act-as scoping.

The key security property: an UNIDENTIFIED speaker must fall back to GUEST scope,
never the organizer's (host) access. pipecat + mcp aren't installed here, so we stub
the few imports mnema_client needs (it reuses the recall_io stubs from the sibling test).
Run: pytest pipecat-meeting/tests/test_mnema_identity.py
"""
import sys
import os
import types

# Reuse the pipecat/httpx stubs + recall_io import from the sibling test module.
sys.path.insert(0, os.path.dirname(__file__))
import test_recall_io  # noqa: F401,E402  (installs stubs + imports recall_io)
import recall_io  # noqa: E402


def _install_mcp_stubs() -> None:
    if "mcp" in sys.modules:
        return
    mcp = types.ModuleType("mcp")

    class ClientSession:  # pragma: no cover - constructed only on real calls
        def __init__(self, *a, **k): pass

    mcp.ClientSession = ClientSession
    sys.modules["mcp"] = mcp
    mcp_client = types.ModuleType("mcp.client")
    sys.modules["mcp.client"] = mcp_client
    sh = types.ModuleType("mcp.client.streamable_http")
    sh.streamablehttp_client = lambda *a, **k: None
    sys.modules["mcp.client.streamable_http"] = sh


_install_mcp_stubs()
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mnema_client  # noqa: E402


def _state_with_speaker(name=None, email=None, is_host=False, bot_id="bot1"):
    st = recall_io.BotState()
    st.bot_id = bot_id
    st.participants["1"] = {"name": name, "email": email, "is_host": is_host}
    st.active_speaker_id = "1"
    return st


# ── A1.3: the security property ──────────────────────────────────────────────────
def test_unidentified_speaker_falls_back_to_guest_not_host():
    # A speaker with no email, no name, not host → no act-as headers → guest scope.
    st = _state_with_speaker(name=None, email=None, is_host=False)
    mcp = mnema_client.MnemaMCP(st)
    key, headers = mcp._identity()
    assert key == "guest"
    assert headers == {}
    assert "X-Mnema-Act-As-Host" not in headers


def test_no_speaker_at_all_is_guest():
    st = recall_io.BotState()
    st.bot_id = "bot1"
    mcp = mnema_client.MnemaMCP(st)
    key, headers = mcp._identity()
    assert key == "guest" and headers == {}


# ── identified speakers still scope correctly ────────────────────────────────────
def test_identified_email_speaker_scopes_to_them_without_host():
    st = _state_with_speaker(name="Alice", email="alice@x.com", is_host=False)
    mcp = mnema_client.MnemaMCP(st)
    key, headers = mcp._identity()
    assert headers.get("X-Mnema-Act-As-Email") == "alice@x.com"
    assert headers.get("X-Mnema-Act-As-Name") == "Alice"
    # crucial: a non-host identified speaker does NOT get host fallback
    assert "X-Mnema-Act-As-Host" not in headers
    assert headers.get("X-Mnema-Meeting-Id") == "bot1"
    assert "host" not in key


def test_host_speaker_asserts_host():
    st = _state_with_speaker(name="Owner", email="owner@x.com", is_host=True)
    mcp = mnema_client.MnemaMCP(st)
    key, headers = mcp._identity()
    assert headers.get("X-Mnema-Act-As-Host") == "true"
    assert "host" in key


def test_name_only_speaker_scopes_by_name():
    st = _state_with_speaker(name="Bob", email=None, is_host=False)
    mcp = mnema_client.MnemaMCP(st)
    key, headers = mcp._identity()
    assert headers.get("X-Mnema-Act-As-Name") == "Bob"
    assert "X-Mnema-Act-As-Email" not in headers
    assert "X-Mnema-Act-As-Host" not in headers


def test_no_state_is_guest():
    mcp = mnema_client.MnemaMCP(None)
    key, headers = mcp._identity()
    assert key == "guest" and headers == {}
