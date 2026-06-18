"""
recall_io.py — Recall.ai audio bridge for the Pipecat meeting pipeline.

INPUT (meeting → pipeline):
  Recall pushes `audio_mixed_raw.data` messages (JSON text) to our public WS. Each
  carries base64 PCM — mono 16-bit LE PCM @ 16 kHz. RecallSerializer decodes that to
  InputAudioRawFrame and captures the per-meeting correlation id from the payload
  (`bot.metadata.cid`, set at createBot; falls back to `bot.id`) so the output path
  knows which Output Media webpage to stream to.

OUTPUT (pipeline → meeting) — Stage 2, true barge-in:
  Recall's realtime WS is input-only, so audio leaves via Recall **Output Media**: the
  bot loads our webpage (served at /output-page) as its camera; that page holds a WS to
  /output/<secret>?cid=<cid>. WebOutputProcessor streams the pipeline's TTSAudioRawFrame
  PCM to that page (which plays it via Web Audio) and, on UserStartedSpeakingFrame,
  sends an `interrupt` so the page flushes mid-utterance — real barge-in.
"""
import os
import json
import base64
import logging

from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

logger = logging.getLogger("pipecat-meeting.recall")

RECALL_INPUT_SAMPLE_RATE = 16000   # Recall mixed audio is 16 kHz S16LE mono
OUTPUT_SAMPLE_RATE = int(os.environ.get("MEETING_TTS_SAMPLE_RATE", "24000"))  # ElevenLabs pcm_24000


class BotState:
    """Shared holder so the serializer (which sees Recall payloads) can hand the
    per-meeting correlation id to the output processor."""

    def __init__(self) -> None:
        self.bot_id: str | None = None
        self.cid: str | None = None


class RecallSerializer(FrameSerializer):
    """Decode Recall `audio_mixed_raw.data` JSON → InputAudioRawFrame (PCM16 16 kHz).
    Output goes via Output Media (the webpage), so serialize() emits nothing."""

    def __init__(self, state: BotState) -> None:
        super().__init__()
        self._state = state

    async def serialize(self, frame: Frame):
        # Recall realtime WS is input-only — never send anything back over it.
        return None

    async def deserialize(self, data):
        if not isinstance(data, str):
            return None
        try:
            msg = json.loads(data)
        except Exception:  # noqa: BLE001
            return None
        if msg.get("event") != "audio_mixed_raw.data":
            return None
        d = msg.get("data", {}) or {}
        if self._state.cid is None:
            bot = d.get("bot") or {}
            meta = bot.get("metadata") or {}
            cid = meta.get("cid") or bot.get("id")
            if cid:
                self._state.cid = cid
                self._state.bot_id = bot.get("id")
                logger.info("[recall] bound to cid %s (bot %s)", cid, self._state.bot_id)
        buf = ((d.get("data") or {}).get("buffer"))
        if not buf:
            return None
        pcm = base64.b64decode(buf)
        return InputAudioRawFrame(
            audio=pcm, sample_rate=RECALL_INPUT_SAMPLE_RATE, num_channels=1
        )


# ── Output Media webpage registry ─────────────────────────────────────────────
# cid → the FastAPI WebSocket of the bot's Output Media page. Populated by the
# /output/{secret} endpoint (pipeline.py), read by WebOutputProcessor.
_OUTPUT_WS: dict[str, object] = {}


def register_output_ws(cid: str, ws) -> None:
    _OUTPUT_WS[cid] = ws
    logger.info("[recall] output page connected for cid %s", cid)


def unregister_output_ws(cid: str) -> None:
    if _OUTPUT_WS.pop(cid, None) is not None:
        logger.info("[recall] output page disconnected for cid %s", cid)


class WebOutputProcessor(FrameProcessor):
    """Stream TTS audio to the bot's Output Media webpage and signal barge-in.

    - TTSAudioRawFrame      → send raw PCM bytes to the page (it plays them gaplessly)
    - UserStartedSpeakingFrame → send {"type":"interrupt"} so the page flushes audio
    Pure passthrough otherwise.
    """

    def __init__(self, state: BotState) -> None:
        super().__init__()
        self._state = state

    def _ws(self):
        cid = self._state.cid
        return _OUTPUT_WS.get(cid) if cid else None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        ws = self._ws()
        if ws is not None:
            try:
                if isinstance(frame, UserStartedSpeakingFrame):
                    await ws.send_text(json.dumps({"type": "interrupt"}))
                elif isinstance(frame, TTSAudioRawFrame) and frame.audio:
                    await ws.send_bytes(frame.audio)
            except Exception as e:  # noqa: BLE001 — a dead page WS must not kill the pipeline
                logger.warning("[recall] output send failed (cid %s): %s", self._state.cid, e)

        await self.push_frame(frame, direction)
