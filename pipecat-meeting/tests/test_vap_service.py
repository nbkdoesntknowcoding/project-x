"""
Unit tests for vap_service — A1.4 audio conversion, result thresholds, and stub fallback.

The VAP model itself (vap_realtime) isn't installed here, so we test the deterministic,
model-free parts: PCM→16kHz-float64 conversion, the VapResult turn-taking helpers, and
that make_vap_service() returns a no-op stub when disabled. numpy is required (present).
Run: pytest pipecat-meeting/tests/test_vap_service.py
"""
import os
import sys
import struct

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import vap_service  # noqa: E402


def _pcm(samples) -> bytes:
    return b"".join(struct.pack("<h", s) for s in samples)


# ── audio conversion ─────────────────────────────────────────────────────────────
def test_16k_passthrough_no_resample():
    pcm = _pcm([16000, -16000, 8000, -8000])
    out = vap_service._pcm16_to_float64_16k(pcm, 16000)
    assert out.dtype.name == "float64"
    assert len(out) == 4  # 16k → 16k: no length change
    assert abs(out[0] - 16000 / 32768.0) < 1e-6


def test_24k_resampled_to_16k_length():
    # 300 samples @ 24k → ~200 samples @ 16k (2/3 ratio), via soxr or linear fallback
    pcm = _pcm([1000] * 300)
    out = vap_service._pcm16_to_float64_16k(pcm, 24000)
    assert out.dtype.name == "float64"
    assert 190 <= len(out) <= 210


def test_empty_pcm():
    out = vap_service._pcm16_to_float64_16k(b"", 16000)
    assert len(out) == 0


# ── VapResult turn-taking helpers ────────────────────────────────────────────────
def test_human_winding_down():
    # p_future (bot speaks next) high, p_future_human low → human yielding
    r = vap_service.VapResult(t=0.0, p_now=0.0, p_future=0.9, vad=[0.1, 0.1])
    assert r.p_future_bot == 0.9
    assert abs(r.p_future_human - 0.1) < 1e-9
    assert r.human_winding_down() is True
    assert r.human_holding() is False


def test_human_holding():
    # p_future_bot low → human likely to keep talking
    r = vap_service.VapResult(t=0.0, p_now=0.0, p_future=0.2, vad=[0.8, 0.0])
    assert r.human_winding_down() is False
    assert r.human_holding() is True


def test_bot_is_silent():
    r = vap_service.VapResult(t=0.0, p_now=0.0, p_future=0.5, vad=[0.5, 0.02])
    assert r.bot_is_silent() is True
    r2 = vap_service.VapResult(t=0.0, p_now=0.0, p_future=0.5, vad=[0.5, 0.9])
    assert r2.bot_is_silent() is False


# ── stub fallback ────────────────────────────────────────────────────────────────
def test_make_vap_service_disabled_returns_stub(monkeypatch):
    monkeypatch.setenv("MEETING_VAP", "0")
    svc = vap_service.make_vap_service()
    assert svc.__class__.__name__ == "VapServiceStub"
    assert svc.start() is False
    assert svc.latest_result is None
    # API is a no-op, never raises
    svc.push_human_audio(b"\x00\x00")
    svc.push_bot_audio(b"\x00\x00")
    svc.stop()


def test_make_vap_service_enabled_but_no_deps_returns_stub(monkeypatch):
    # MEETING_VAP on but vap_realtime not installed in this env → stub (never crashes)
    monkeypatch.setenv("MEETING_VAP", "1")
    monkeypatch.setattr(vap_service, "_VAP_AVAILABLE", False)
    svc = vap_service.make_vap_service()
    assert svc.__class__.__name__ == "VapServiceStub"
