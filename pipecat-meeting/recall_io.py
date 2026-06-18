"""
recall_io.py — Recall.ai audio bridge for the Pipecat meeting pipeline.

INPUT (meeting → pipeline):
  Recall connects to our public WS and pushes `audio_mixed_raw.data` messages
  (JSON text). Each carries base64 PCM — **mono 16-bit signed LE PCM @ 16 kHz**
  (confirmed via Recall MCP: how-to-get-mixed-audio-real-time). RecallSerializer
  decodes that to InputAudioRawFrame and also captures the bot id from the payload
  (`data.bot.id`) so the output path knows which bot to speak through.

OUTPUT (pipeline → meeting):
  Recall's realtime endpoint is INPUT-ONLY, so TTS does NOT go back over that WS.
  Instead we use Recall's **Output Audio** endpoint: POST an mp3 (base64) to
  `/api/v1/bot/{id}/output_audio/` and the bot plays it into the call. We capture
  each assistant turn's text (LLMFullResponse* + LLMTextFrame), synthesize it to
  mp3 directly via the ElevenLabs REST API (cloned voice), and POST it. Turn-based,
  no webpage hosting — see plan note: Output Media (low-latency streaming) is a
  future upgrade.

  NOTE: the bot must be created with an `automatic_audio_output` (a silent mp3) for
  the Output Audio endpoint to be usable — meeting-bot/src/recall.ts handles that.
"""
import os
import base64
import logging

import httpx

from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    LLMTextFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

from meeting_persona import SILENT_TOKEN

logger = logging.getLogger("pipecat-meeting.recall")

RECALL_REGION = os.environ.get("RECALL_REGION", "ap-northeast-1")
RECALL_BASE = f"https://{RECALL_REGION}.recall.ai/api/v1"
RECALL_API_KEY = os.environ.get("RECALL_API_KEY", "")

ELEVEN_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVEN_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "")
ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
# Recall Output Audio requires mp3; ElevenLabs returns mp3 directly for this format.
ELEVEN_OUTPUT_FORMAT = "mp3_44100_128"

RECALL_INPUT_SAMPLE_RATE = 16000  # Recall mixed audio is 16 kHz S16LE mono


class BotState:
    """Shared holder so the serializer (which sees Recall payloads) can hand the
    bot id to the speaker (which POSTs output audio)."""

    def __init__(self) -> None:
        self.bot_id: str | None = None


class RecallSerializer(FrameSerializer):
    """Decode Recall `audio_mixed_raw.data` JSON → InputAudioRawFrame (PCM16 16 kHz).
    Output is handled out-of-band via Output Audio, so serialize() emits nothing."""

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
            import json
            msg = json.loads(data)
        except Exception:  # noqa: BLE001
            return None
        if msg.get("event") != "audio_mixed_raw.data":
            return None
        d = msg.get("data", {}) or {}
        # Capture the bot id once so the speaker knows where to send audio.
        if self._state.bot_id is None:
            bot = d.get("bot") or {}
            if bot.get("id"):
                self._state.bot_id = bot["id"]
                logger.info("[recall] bound to bot %s", self._state.bot_id)
        buf = (((d.get("data") or {}).get("buffer")))
        if not buf:
            return None
        pcm = base64.b64decode(buf)
        return InputAudioRawFrame(
            audio=pcm, sample_rate=RECALL_INPUT_SAMPLE_RATE, num_channels=1
        )


async def _elevenlabs_mp3(text: str) -> bytes | None:
    """Synthesize `text` to mp3 bytes via the ElevenLabs REST API (cloned voice)."""
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE_ID}"
        f"?output_format={ELEVEN_OUTPUT_FORMAT}"
    )
    headers = {"xi-api-key": ELEVEN_API_KEY, "Content-Type": "application/json"}
    body = {"text": text, "model_id": ELEVEN_MODEL}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, headers=headers, json=body)
        if r.status_code != 200:
            logger.error("[recall] ElevenLabs %s: %s", r.status_code, r.text[:300])
            return None
        return r.content


async def _recall_output_audio(bot_id: str, mp3: bytes) -> None:
    """POST an mp3 to Recall so the bot plays it into the meeting."""
    url = f"{RECALL_BASE}/bot/{bot_id}/output_audio/"
    headers = {"Authorization": RECALL_API_KEY, "Content-Type": "application/json"}
    body = {"kind": "mp3", "b64_data": base64.b64encode(mp3).decode("ascii")}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, headers=headers, json=body)
        if r.status_code >= 300:
            logger.error("[recall] output_audio %s: %s", r.status_code, r.text[:300])
        else:
            logger.info("[recall] spoke %d bytes via bot %s", len(mp3), bot_id)


class RecallSpeaker(FrameProcessor):
    """Capture each assistant turn's text and speak it into the meeting via Recall
    Output Audio (ElevenLabs mp3). Pure passthrough for the pipeline's frames."""

    def __init__(self, state: BotState) -> None:
        super().__init__()
        self._state = state
        self._buf: list[str] = []
        self._capturing = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = []
            self._capturing = True
        elif isinstance(frame, LLMTextFrame) and self._capturing:
            self._buf.append(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame) and self._capturing:
            self._capturing = False
            text = "".join(self._buf).strip()
            self._buf = []
            # Persona emits the SILENT_TOKEN sentinel when it shouldn't speak —
            # strip it; if nothing real remains, stay quiet.
            text = text.replace(SILENT_TOKEN, "").strip()
            if text:
                # Fire-and-forget so we don't block the pipeline; Pipecat manages
                # the task lifecycle via create_task().
                self.create_task(self._speak(text))

        await self.push_frame(frame, direction)

    async def _speak(self, text: str) -> None:
        bot_id = self._state.bot_id
        if not bot_id:
            logger.warning("[recall] no bot id yet; dropping reply: %s", text[:80])
            return
        mp3 = await _elevenlabs_mp3(text)
        if mp3:
            await _recall_output_audio(bot_id, mp3)
