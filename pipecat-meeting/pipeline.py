"""
pipecat-meeting/pipeline.py — Meeting-bot Pipecat pipeline (STEP 6).

Copied from voice-clone/media-worker/pipeline/assembler.py. Per the build prompt,
we change ONLY the transport: the VAP uses FastAPIWebsocketTransport +
TwilioFrameSerializer; the meeting bot keeps FastAPIWebsocketTransport but swaps
the serializer to RawMulawSerializer, because the meeting-bot CaptureBridge sends
RAW µ-law 8kHz binary frames (not Twilio's JSON/base64 wire format) and expects
raw µ-law 8kHz binary TTS frames back (forwarded to InjectionBridge).

Everything else — Deepgram STT, GPT-4o-mini LLM, ElevenLabs TTS, Silero VAD,
context aggregator — is UNCHANGED from the VAP.

This module also hosts the WebSocket server on :8765 that the CaptureBridge
connects to (ws://pipecat-meeting:8765).
"""
import os
import audioop  # µ-law <-> PCM16 (stdlib)
import logging

from fastapi import FastAPI, WebSocket
import uvicorn

logger = logging.getLogger("pipecat-meeting")
logging.basicConfig(level=logging.INFO)

# ── Pipecat imports (Pipecat 1.2.x, same as VAP) ─────────────────────────────
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.serializers.base_serializer import FrameSerializer, FrameSerializerType
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame

from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

from meeting_persona import build_meeting_persona


# ── Raw µ-law 8kHz serializer (replaces TwilioFrameSerializer) ───────────────
class RawMulawSerializer(FrameSerializer):
    """
    Wire format: raw µ-law 8kHz mono binary frames (no Twilio JSON/base64).
      IN  (deserialize): µ-law bytes from CaptureBridge → PCM16 → InputAudioRawFrame
      OUT (serialize):   OutputAudioRawFrame PCM16 → µ-law bytes → InjectionBridge
    Mirrors what TwilioFrameSerializer does, minus the Twilio Media Streams envelope.
    """

    SAMPLE_RATE = 8000

    @property
    def type(self) -> FrameSerializerType:
        return FrameSerializerType.BINARY

    async def serialize(self, frame: Frame):
        if isinstance(frame, OutputAudioRawFrame):
            # PCM16 (pipeline rate) -> µ-law 8kHz
            pcm = frame.audio
            if frame.sample_rate != self.SAMPLE_RATE:
                pcm, _ = audioop.ratecv(pcm, 2, 1, frame.sample_rate, self.SAMPLE_RATE, None)
            return audioop.lin2ulaw(pcm, 2)
        return None

    async def deserialize(self, data):
        if isinstance(data, (bytes, bytearray)):
            # µ-law 8kHz -> PCM16
            pcm = audioop.ulaw2lin(bytes(data), 2)
            return InputAudioRawFrame(audio=pcm, sample_rate=self.SAMPLE_RATE, num_channels=1)
        return None


async def build_and_run_meeting_pipeline(websocket: WebSocket, system_prompt: str) -> None:
    """One meeting = one pipeline run. Identical to the VAP chain, raw-µ-law serializer."""
    serializer = RawMulawSerializer()

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            serializer=serializer,
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            audio_out_sample_rate=8000,
        ),
    )

    # ── STT (unchanged from VAP) ─────────────────────────────────────────────
    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        live_options={
            "model": "nova-3",
            "language": "multi",
            "encoding": "mulaw",
            "sample_rate": 8000,
            "channels": 1,
            "interim_results": True,
            "endpointing": False,
        },
    )

    # ── LLM (unchanged) — Mnema tools registered via OpenAILLMContext tools ──
    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini"),
    )

    # ── TTS (unchanged) — ElevenLabs cloned voice ────────────────────────────
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        voice_id=os.environ["ELEVENLABS_VOICE_ID"],
        model="eleven_flash_v2_5",
    )

    # Mnema tool schemas, passed to GPT-4o-mini alongside any VAP tools (STEP 8).
    from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS  # OpenAI function-tool format
    context = OpenAILLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=MNEMA_TOOL_DEFINITIONS,
    )
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    logger.info("[meeting-pipeline] starting")
    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
    logger.info("[meeting-pipeline] finished")


# ── WebSocket server (CaptureBridge connects here: ws://pipecat-meeting:8765) ─
app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.websocket("/")
async def meeting_ws(websocket: WebSocket):
    await websocket.accept()
    logger.info("[meeting-ws] CaptureBridge connected")
    system_prompt = build_meeting_persona(
        workspace_name=os.environ.get("MNEMA_WORKSPACE", "The Boring People"),
    )
    try:
        await build_and_run_meeting_pipeline(websocket, system_prompt)
    except Exception as e:  # noqa: BLE001
        logger.exception("[meeting-ws] pipeline error: %s", e)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)
