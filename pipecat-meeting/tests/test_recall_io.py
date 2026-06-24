"""
Unit tests for recall_io — A1.1 (separated per-participant audio) + A1.2 (echo gate removed).

pipecat isn't installed in this test env, so we inject lightweight stubs for the few
pipecat symbols recall_io imports, then exercise the pure parsing/attribution/silence logic.
Run: pytest pipecat-meeting/tests/test_recall_io.py
"""
import sys
import os
import json
import types
import struct
import base64
import asyncio


# ── Stub pipecat + httpx so recall_io imports without the real deps ─────────────
def _install_stubs() -> None:
    if "httpx" not in sys.modules:
        httpx = types.ModuleType("httpx")

        class _AC:  # pragma: no cover - only used if roster report fires
            def __init__(self, *a, **k): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            async def post(self, *a, **k): return None

        httpx.AsyncClient = _AC
        sys.modules["httpx"] = httpx

    pkgs = {
        "pipecat": types.ModuleType("pipecat"),
        "pipecat.serializers": types.ModuleType("pipecat.serializers"),
        "pipecat.serializers.base_serializer": types.ModuleType("pipecat.serializers.base_serializer"),
        "pipecat.frames": types.ModuleType("pipecat.frames"),
        "pipecat.frames.frames": types.ModuleType("pipecat.frames.frames"),
        "pipecat.processors": types.ModuleType("pipecat.processors"),
        "pipecat.processors.frame_processor": types.ModuleType("pipecat.processors.frame_processor"),
    }

    class FrameSerializer:
        def __init__(self, *a, **k): pass

    class Frame: pass

    class InputAudioRawFrame(Frame):
        def __init__(self, audio=b"", sample_rate=0, num_channels=1):
            self.audio = audio
            self.sample_rate = sample_rate
            self.num_channels = num_channels

    class TTSAudioRawFrame(Frame):
        def __init__(self, audio=b""): self.audio = audio

    class UserStartedSpeakingFrame(Frame): pass

    class FrameProcessor:
        def __init__(self, *a, **k): pass
        async def process_frame(self, *a, **k): pass
        async def push_frame(self, *a, **k): pass

    class FrameDirection:
        DOWNSTREAM = 1
        UPSTREAM = 2

    pkgs["pipecat.serializers.base_serializer"].FrameSerializer = FrameSerializer
    ff = pkgs["pipecat.frames.frames"]
    ff.Frame = Frame
    ff.InputAudioRawFrame = InputAudioRawFrame
    ff.TTSAudioRawFrame = TTSAudioRawFrame
    ff.UserStartedSpeakingFrame = UserStartedSpeakingFrame
    fp = pkgs["pipecat.processors.frame_processor"]
    fp.FrameProcessor = FrameProcessor
    fp.FrameDirection = FrameDirection
    sys.modules.update(pkgs)


_install_stubs()
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import recall_io  # noqa: E402

# Roster reporting touches the event loop / network — neutralise it for unit tests.
recall_io.schedule_roster_report = lambda *a, **k: None


# ── Helpers ─────────────────────────────────────────────────────────────────────
def _pcm_b64(samples) -> str:
    raw = b"".join(struct.pack("<h", s) for s in samples)
    return base64.b64encode(raw).decode()


LOUD = _pcm_b64([12000, -12000] * 80)   # peak 12000 >> threshold 250
SILENT = _pcm_b64([0, 1, -1, 0] * 60)   # peak 1 << threshold


def _audio_msg(buffer, participant, cid="cid1", bot_id="bot1"):
    return json.dumps({
        "event": "audio_separate_raw.data",
        "data": {
            "bot": {"id": bot_id, "metadata": {"cid": cid}},
            "data": {"buffer": buffer, "participant": participant},
        },
    })


def _join_msg(participant):
    return json.dumps({
        "event": "participant_events.join",
        "data": {"data": {"participant": participant}},
    })


def _run(coro):
    return asyncio.run(coro)


# ── A1.1: silence detection ──────────────────────────────────────────────────────
def test_is_silent_true_for_silence():
    raw = b"".join(struct.pack("<h", s) for s in [0, 1, -1] * 60)
    assert recall_io._is_silent(raw) is True


def test_is_silent_false_for_speech():
    raw = b"".join(struct.pack("<h", s) for s in [9000, -9000] * 60)
    assert recall_io._is_silent(raw) is False


# ── A1.1: separated audio → frame + exact attribution ────────────────────────────
def test_separate_audio_returns_frame_and_attributes_speaker():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    frame = _run(ser.deserialize(_audio_msg(LOUD, {"id": 5, "name": "Alice", "is_host": False})))
    assert frame is not None and frame.__class__.__name__ == "InputAudioRawFrame"
    assert frame.num_channels == 1 and frame.sample_rate == recall_io.RECALL_INPUT_SAMPLE_RATE
    # exact attribution recorded on state
    assert state.active_speaker_id == "5"
    assert state.last_speaker_id == "5"
    assert state.participants["5"]["name"] == "Alice"
    # cid bound from the separated payload
    assert state.cid == "cid1"


def test_speaker_switch_updates_attribution():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    _run(ser.deserialize(_audio_msg(LOUD, {"id": 1, "name": "Alice"})))
    assert state.active_speaker_id == "1"
    _run(ser.deserialize(_audio_msg(LOUD, {"id": 2, "name": "Bob"})))
    assert state.active_speaker_id == "2" and state.last_speaker_id == "2"


# ── A1.1: bot's own stream dropped (no echo) ─────────────────────────────────────
def test_bot_own_stream_dropped_by_name():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    frame = _run(ser.deserialize(_audio_msg(LOUD, {"id": 9, "name": "Mnema"})))
    assert frame is None
    assert state.bot_participant_id == "9"
    assert "9" not in state.participants  # never tracked as a speaker


def test_bot_own_stream_dropped_by_is_current_user():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    frame = _run(ser.deserialize(_audio_msg(LOUD, {"id": 9, "name": "Bot", "is_current_user": True})))
    assert frame is None and state.active_speaker_id is None


# ── A1.1: silent packets dropped ─────────────────────────────────────────────────
def test_silent_packet_dropped():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    assert _run(ser.deserialize(_audio_msg(SILENT, {"id": 3, "name": "Quiet"}))) is None
    # a loud packet from the same participant DOES come through
    assert _run(ser.deserialize(_audio_msg(LOUD, {"id": 3, "name": "Quiet"}))) is not None


# ── A1.1: roster + current_asker ─────────────────────────────────────────────────
def test_participant_join_then_audio_merges_email():
    state = recall_io.BotState()
    ser = recall_io.RecallSerializer(state)
    # join event carries the calendar email; audio event carries name/host
    _run(ser.deserialize(_join_msg({"id": 4, "name": "Cara", "extra_data": {"email": "cara@x.com"}, "is_host": True})))
    _run(ser.deserialize(_audio_msg(LOUD, {"id": 4, "name": "Cara", "is_host": True})))
    asker = recall_io.current_asker(state)
    assert asker["name"] == "Cara"
    assert asker["email"] == "cara@x.com"   # email preserved from the join event
    assert asker["is_host"] is True


def test_current_asker_empty_when_no_speaker():
    state = recall_io.BotState()
    asker = recall_io.current_asker(state)
    assert asker == {"email": None, "name": None, "is_host": False}


# ── A1.2: echo gate fully removed ────────────────────────────────────────────────
def test_input_gate_removed():
    assert not hasattr(recall_io, "InputGate")


def test_speaking_until_field_removed():
    state = recall_io.BotState()
    assert not hasattr(state, "speaking_until")
