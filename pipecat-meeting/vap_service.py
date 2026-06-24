"""
vap_service.py — VAP (Voice Activity Projection) predictive turn-taking for the meeting
bot (A1.4). In-process per-call sidecar adapted from voice-clone/media-worker's VapService.

Reuses inokoj/VAP-Realtime exactly as voice-clone does (CPU, two TCP-loopback input
channels), but for the MEETING bot's audio contract:
  - channel 1 ("human")  = the active human's SEPARATED 16 kHz PCM stream (A1.1) — no resample
  - channel 2 ("bot")    = the bot's TTS PCM (ElevenLabs, 24 kHz) → resampled to 16 kHz
Outputs p_now (who is speaking now) + p_future (turn-shift prediction) at 10 Hz, which
pipeline.VapTap exposes on BotState so the turn logic can hold through mid-utterance
pauses, suppress on backchannels, and time barge-in naturally.

DEPENDENCIES (provision in the pipecat-meeting image; guarded — falls back to a no-op
stub if missing so the pipeline always starts):
  - vap_realtime (inokoj/VAP-Realtime) + the vap model checkpoint (CPU)
  - soxr (preferred) for 24 kHz→16 kHz bot-audio resampling
Enable with MEETING_VAP=1.

Decision: in-process (mirrors voice-clone) rather than a separate WS sidecar — simplest,
reuses proven code, nothing extra to deploy. Switchable later if VPS CPU pressure demands.
"""
from __future__ import annotations

import os
import socket
import time
import logging
import threading
from collections import deque
from typing import Optional

import numpy as np

logger = logging.getLogger("pipecat-meeting.vap")

# ── Audio constants ──────────────────────────────────────────────────────────────
_HUMAN_RATE = 16000   # A1.1 separated human stream is 16 kHz S16LE mono
_BOT_RATE   = int(os.environ.get("MEETING_TTS_SAMPLE_RATE", "24000"))  # ElevenLabs pcm_24000
_VAP_RATE   = 16000   # VAP model expects 16 kHz
_VAP_FRAME  = 160     # samples per VAP frame (10 ms @ 16 kHz)
_VAP_DTYPE  = np.float64
_PORT_HUMAN = int(os.environ.get("MEETING_VAP_PORT_HUMAN", "15017"))
_PORT_BOT   = int(os.environ.get("MEETING_VAP_PORT_BOT", "15018"))

# Turn-taking thresholds (tunable live; defaults from voice-clone 07 §5).
SHIFT_THRESHOLD = float(os.environ.get("MEETING_VAP_SHIFT", "0.6"))   # human winding down → bot may take floor
HOLD_THRESHOLD  = float(os.environ.get("MEETING_VAP_HOLD", "0.4"))    # human likely to continue → hold
BC_NOW_THRESHOLD = 0.1   # bot considered silent below this (safe to backchannel)

try:
    import soxr as _soxr
    _SOXR_AVAILABLE = True
except ImportError:
    _SOXR_AVAILABLE = False

try:
    from vap_realtime import Vap, VapInput
    _VAP_AVAILABLE = True
except ImportError:
    _VAP_AVAILABLE = False


def _pcm16_to_float64_16k(pcm: bytes, src_rate: int) -> np.ndarray:
    """int16-LE PCM @ src_rate → float64 @ 16 kHz for VAP."""
    if not pcm:
        return np.empty(0, dtype=_VAP_DTYPE)
    s16 = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if src_rate == _VAP_RATE:
        return s16.astype(_VAP_DTYPE)
    if _SOXR_AVAILABLE:
        return _soxr.resample(s16, src_rate, _VAP_RATE).astype(_VAP_DTYPE)
    # Linear-interp fallback (low quality but functional for VAD-style features).
    n_out = max(1, round(len(s16) * _VAP_RATE / src_rate))
    xp = np.linspace(0.0, 1.0, num=len(s16), endpoint=False)
    x = np.linspace(0.0, 1.0, num=n_out, endpoint=False)
    return np.interp(x, xp, s16).astype(_VAP_DTYPE)


class VapResult:
    """Single VAP prediction frame. Channel 1 = human, channel 2 = bot."""
    __slots__ = ("t", "p_now_human", "p_now_bot", "p_future_bot", "p_future_human")

    def __init__(self, t: float, p_now: float, p_future: float, vad) -> None:
        self.t = t
        vad_list = vad.tolist() if hasattr(vad, "tolist") else (list(vad) if vad else [0.5, 0.5])
        self.p_now_human = float(vad_list[0]) if len(vad_list) > 0 else 0.5
        self.p_now_bot   = float(vad_list[1]) if len(vad_list) > 1 else 0.5
        # p_future = probability the BOT (channel 2) speaks next.
        self.p_future_bot   = float(p_future)
        self.p_future_human = 1.0 - float(p_future)

    def human_winding_down(self) -> bool:
        """True when the human is likely yielding the floor → the bot may take the turn."""
        return self.p_future_bot > SHIFT_THRESHOLD and self.p_future_human < HOLD_THRESHOLD

    def human_holding(self) -> bool:
        """True when the human is likely to keep talking (mid-utterance pause) → hold."""
        return self.p_future_human >= HOLD_THRESHOLD

    def bot_is_silent(self) -> bool:
        return self.p_now_bot < BC_NOW_THRESHOLD


class VapService:
    """Per-call in-process VAP. Reuses voice-clone's VAP-Realtime integration; adapted to
    the meeting bot's PCM channels (16 kHz human, 24 kHz bot)."""

    def __init__(self, language: str = "en", frame_rate: int = 10) -> None:
        self._language = language
        self._frame_rate = frame_rate
        self._vap = None
        self._poll_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._human_buf: deque = deque()
        self._bot_buf: deque = deque()
        self._buf_lock = threading.Lock()
        self._human_sock: Optional[socket.socket] = None
        self._bot_sock: Optional[socket.socket] = None
        self._latest: Optional[VapResult] = None
        self._result_lock = threading.Lock()

    def start(self) -> bool:
        if not _VAP_AVAILABLE:
            logger.info("[vap] vap_realtime not installed — stub mode (set MEETING_VAP=0 to silence)")
            return False
        try:
            self._vap = Vap(
                mode="vap", frame_rate=self._frame_rate, context_len_sec=5.0,
                language=self._language,
                mic1=VapInput.TCPReceiver(ip="127.0.0.1", port=_PORT_HUMAN),
                mic2=VapInput.TCPReceiver(ip="127.0.0.1", port=_PORT_BOT),
                device="cpu",
            )
            self._vap.start_process()
            time.sleep(0.5)  # let the TCPReceivers bind before we connect
            self._human_sock = self._connect_tcp(_PORT_HUMAN)
            self._bot_sock = self._connect_tcp(_PORT_BOT)
            self._poll_thread = threading.Thread(target=self._poll_loop, daemon=True, name="vap-poll")
            self._poll_thread.start()
            logger.info("[vap] predictive turn-taking running (in-process, CPU)")
            return True
        except Exception as exc:  # noqa: BLE001
            logger.error("[vap] failed to start: %s", exc)
            return False

    def stop(self) -> None:
        self._stop_event.set()
        for sock in (self._human_sock, self._bot_sock):
            if sock:
                try: sock.close()
                except Exception: pass  # noqa: BLE001
        if self._poll_thread and self._poll_thread.is_alive():
            self._poll_thread.join(timeout=2.0)
        logger.info("[vap] stopped")

    def push_human_audio(self, pcm16: bytes) -> None:
        """Active human's separated 16 kHz PCM (A1.1) → VAP channel 1."""
        samples = _pcm16_to_float64_16k(pcm16, _HUMAN_RATE)
        if samples.size:
            with self._buf_lock:
                self._human_buf.extend(samples.tolist())
            self._drain_buf(self._human_buf, self._human_sock)

    def push_bot_audio(self, pcm16: bytes) -> None:
        """Bot TTS PCM (24 kHz) → resample → VAP channel 2."""
        samples = _pcm16_to_float64_16k(pcm16, _BOT_RATE)
        if samples.size:
            with self._buf_lock:
                self._bot_buf.extend(samples.tolist())
            self._drain_buf(self._bot_buf, self._bot_sock)

    @property
    def latest_result(self) -> Optional[VapResult]:
        with self._result_lock:
            return self._latest

    # ── internal ──
    def _connect_tcp(self, port: int, retries: int = 10) -> Optional[socket.socket]:
        for _ in range(retries):
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.connect(("127.0.0.1", port))
                return s
            except ConnectionRefusedError:
                time.sleep(0.2)
        logger.warning("[vap] could not connect to TCPReceiver on port %s", port)
        return None

    def _drain_buf(self, buf: deque, sock: Optional[socket.socket]) -> None:
        if sock is None:
            return
        while True:
            with self._buf_lock:
                if len(buf) < _VAP_FRAME:
                    break
                frame = np.array([buf.popleft() for _ in range(_VAP_FRAME)], dtype=_VAP_DTYPE)
            try:
                sock.sendall(frame.tobytes())
            except (BrokenPipeError, OSError):
                break

    def _poll_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                result = self._vap.get_result()
                if result:
                    vr = VapResult(
                        t=result.get("t", time.monotonic()),
                        p_now=result.get("p_now", 0.5),
                        p_future=result.get("p_future", 0.5),
                        vad=result.get("vad", [0.5, 0.5]),
                    )
                    with self._result_lock:
                        self._latest = vr
            except Exception as exc:  # noqa: BLE001
                logger.debug("[vap] poll error: %s", exc)
                time.sleep(0.01)


class VapServiceStub:
    """No-op when vap_realtime is unavailable or MEETING_VAP is off. Preserves the API."""
    def start(self) -> bool: return False
    def stop(self) -> None: pass
    def push_human_audio(self, pcm16: bytes) -> None: pass
    def push_bot_audio(self, pcm16: bytes) -> None: pass
    @property
    def latest_result(self): return None


def make_vap_service(language: str = "en"):
    """Factory: real VapService when enabled + deps present, else a no-op stub."""
    if os.environ.get("MEETING_VAP", "0") in ("0", "", "off", "false"):
        return VapServiceStub()
    if _VAP_AVAILABLE:
        return VapService(language=language)
    logger.warning("[vap] MEETING_VAP enabled but vap_realtime not installed — using stub")
    return VapServiceStub()
