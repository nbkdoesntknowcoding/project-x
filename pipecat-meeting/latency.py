"""
latency.py — per-turn latency instrumentation for the meeting pipeline.

Ported (lightweight) from the VAP's dual TurnMetricsEarly/Late processors. Two probes
share one TurnMetrics object:
  - Early (before the user aggregator) stamps end-of-user-speech from the final
    TranscriptionFrame.
  - Late (after TTS) stamps LLM first response + TTS first audio + TTS done, then logs
    the breakdown and a running p50/p95.

asr_ms     = LLM start − EOS        (STT + retrieval + aggregation)
llm_ttft_ms = TTS first − LLM start (LLM time-to-first-token → first audio)
total_ms    = TTS done − EOS        (full round-trip)
"""
import time
import logging

from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
    LLMFullResponseStartFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)

logger = logging.getLogger("pipecat-meeting.latency")


class TurnMetrics:
    """Per-meeting latency state shared by the early/late probes."""

    def __init__(self) -> None:
        self.t_eos: float | None = None
        self.t_llm: float | None = None
        self.t_tts_first: float | None = None
        self.totals: list[float] = []

    def pctl(self, p: float) -> float:
        if not self.totals:
            return 0.0
        s = sorted(self.totals)
        k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
        return s[k]


class TurnMetricsEarly(FrameProcessor):
    """Stamp end-of-user-speech on the final TranscriptionFrame (passthrough)."""

    def __init__(self, m: TurnMetrics) -> None:
        super().__init__()
        self._m = m

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and (frame.text or "").strip():
            self._m.t_eos = time.monotonic()
            self._m.t_llm = None
            self._m.t_tts_first = None
        await self.push_frame(frame, direction)


class TurnMetricsLate(FrameProcessor):
    """Stamp LLM/TTS milestones and log the per-turn breakdown + p50/p95 (passthrough)."""

    def __init__(self, m: TurnMetrics) -> None:
        super().__init__()
        self._m = m

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        m = self._m
        now = time.monotonic()
        if isinstance(frame, LLMFullResponseStartFrame):
            if m.t_eos is not None and m.t_llm is None:
                m.t_llm = now
        elif isinstance(frame, TTSStartedFrame):
            if m.t_tts_first is None:
                m.t_tts_first = now
        elif isinstance(frame, TTSStoppedFrame):
            if m.t_eos is not None:
                total = (now - m.t_eos) * 1000
                asr = ((m.t_llm or now) - m.t_eos) * 1000
                ttft = ((m.t_tts_first or now) - (m.t_llm or now)) * 1000
                m.totals.append(total)
                logger.info(
                    "[latency] turn asr=%.0f llm_ttft=%.0f total=%.0fms | p50=%.0f p95=%.0f (n=%d)",
                    asr, ttft, total, m.pctl(50), m.pctl(95), len(m.totals),
                )
                m.t_eos = None
                m.t_llm = None
                m.t_tts_first = None
        await self.push_frame(frame, direction)
