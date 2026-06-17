"""
pipecat-meeting/pipeline.py — Meeting-bot Pipecat pipeline (Recall.ai front end).

Recall joins the meeting and streams real-time MIXED audio to this service over a
public WebSocket (Caddy: meet-ws.theboringpeople.in → here:8765). The audio is
mono 16-bit LE PCM @ 16 kHz wrapped in `audio_mixed_raw.data` JSON messages
(see recall_io.RecallSerializer). The pipeline runs:

    Deepgram STT → GPT-4o-mini (+ Mnema tools) → [assistant text]

and speaks each reply back into the meeting via Recall's Output Audio endpoint
(ElevenLabs cloned voice → mp3 → POST), handled by recall_io.RecallSpeaker.
Recall's realtime WS is input-only, so we do NOT send audio back over it.

Pipecat 1.2.1 (pinned). Imports verified against the installed package.
"""
import os
import logging

from fastapi import FastAPI, WebSocket
import uvicorn

logger = logging.getLogger("pipecat-meeting")
logging.basicConfig(level=logging.INFO)

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService, LiveOptions
from pipecat.services.openai.llm import OpenAILLMService

from meeting_persona import build_meeting_persona
from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
from mnema_client import register_mnema_tools
from recall_io import BotState, RecallSerializer, RecallSpeaker, RECALL_INPUT_SAMPLE_RATE

MEETING_WS_SECRET = os.environ.get("MEETING_WS_SECRET", "")


def _mnema_tools_schema() -> ToolsSchema:
    """Convert the OpenAI-format Mnema tool dicts to Pipecat 1.2.1 FunctionSchemas."""
    fns = []
    for t in MNEMA_TOOL_DEFINITIONS:
        f = t["function"]
        params = f.get("parameters", {})
        fns.append(FunctionSchema(
            name=f["name"],
            description=f.get("description", ""),
            properties=params.get("properties", {}),
            required=params.get("required", []),
        ))
    return ToolsSchema(standard_tools=fns)


async def build_and_run_meeting_pipeline(websocket: WebSocket, system_prompt: str) -> None:
    """One meeting = one pipeline run. Audio in from Recall, replies out via Output Audio."""
    state = BotState()
    serializer = RecallSerializer(state)

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            serializer=serializer,
            audio_in_enabled=True,
            audio_in_sample_rate=RECALL_INPUT_SAMPLE_RATE,  # 16 kHz S16LE mono
            audio_out_enabled=False,  # output goes via Recall Output Audio, not this WS
            add_wav_header=False,
        ),
    )

    # ── STT — Deepgram Nova-3 (linear16 @ 16 kHz to match Recall mixed audio) ──
    stt = DeepgramSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        live_options=LiveOptions(
            model="nova-3",
            language="multi",
            encoding="linear16",
            sample_rate=RECALL_INPUT_SAMPLE_RATE,
            channels=1,
            interim_results=True,
        ),
    )

    # ── LLM — GPT-4o-mini with Mnema tools registered for real execution ──────
    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini"),
    )
    register_mnema_tools(llm)

    # ── Speak replies into the meeting (ElevenLabs mp3 → Recall Output Audio) ──
    speaker = RecallSpeaker(state)

    context = LLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=_mnema_tools_schema(),
    )
    aggregators = LLMContextAggregatorPair(context)

    pipeline = Pipeline([
        transport.input(),
        stt,
        aggregators.user(),
        llm,
        speaker,             # capture assistant text → speak via Recall Output Audio
        aggregators.assistant(),
        transport.output(),  # control-frame sink (no audio leaves over Recall's WS)
    ])

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    logger.info("[meeting-pipeline] starting")
    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
    logger.info("[meeting-pipeline] finished")


# ── WebSocket server: Recall connects to wss://meet-ws.../<MEETING_WS_SECRET> ──
app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok", "backend": "recall"}


@app.websocket("/{secret}")
async def meeting_ws(websocket: WebSocket, secret: str):
    # Recall connects from the public internet; gate on the shared secret in the path.
    if not MEETING_WS_SECRET or secret != MEETING_WS_SECRET:
        await websocket.close(code=4403)
        logger.warning("[meeting-ws] rejected connection (bad secret)")
        return
    await websocket.accept()
    logger.info("[meeting-ws] Recall connected")
    system_prompt = build_meeting_persona(
        workspace_name=os.environ.get("MNEMA_WORKSPACE", "The Boring People"),
    )
    try:
        await build_and_run_meeting_pipeline(websocket, system_prompt)
    except Exception as e:  # noqa: BLE001
        logger.exception("[meeting-ws] pipeline error: %s", e)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765)
