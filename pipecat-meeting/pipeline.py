"""
pipecat-meeting/pipeline.py — Meeting-bot Pipecat pipeline (Recall.ai front end).

Recall joins the meeting and streams real-time MIXED audio to this service over a
public WebSocket (Caddy: meet-ws.theboringpeople.in → here:8765). The audio is
mono 16-bit LE PCM @ 16 kHz wrapped in `audio_mixed_raw.data` JSON messages
(see recall_io.RecallSerializer). The pipeline runs:

    Deepgram STT → GPT-4o-mini (+ Mnema tools) → ElevenLabs TTS (streaming PCM)

and streams each reply to the bot's Output Media webpage (recall_io.WebOutputProcessor
→ /output WS → the page plays PCM via Web Audio). SileroVAD on the user aggregator +
allow_interruptions give true barge-in: when someone talks over the bot, the page is
told to flush. Recall's realtime WS is input-only, so we never send audio over it.

Pipecat 1.2.1 (pinned). Imports verified against the installed package.
"""
import os
import asyncio
import logging

from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
import uvicorn

logger = logging.getLogger("pipecat-meeting")
logging.basicConfig(level=logging.INFO)

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService, LiveOptions
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.frames.frames import (
    Frame,
    TranscriptionFrame,
    LLMTextFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    LLMMessagesAppendFrame,
)

from meeting_persona import build_meeting_persona, SILENT_TOKEN
from latency import TurnMetrics, TurnMetricsEarly, TurnMetricsLate
from output_page import output_page_html
from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
from mnema_client import register_mnema_tools, MnemaMCP
from recall_io import (
    BotState,
    RecallSerializer,
    WebOutputProcessor,
    register_output_ws,
    unregister_output_ws,
    RECALL_INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
)

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


class NoiseGate(FrameProcessor):
    """Drop final TranscriptionFrames that are too short to be real speech (STT noise
    like a stray 'a' or punctuation on silence). Keeps junk out of the LLM context.
    Interim frames and all non-transcription frames pass through untouched."""

    MIN_CHARS = 3

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            # Require at least one letter/digit and a minimum length.
            if len(text) < self.MIN_CHARS or not any(c.isalnum() for c in text):
                return  # swallow — do not push downstream
        await self.push_frame(frame, direction)


class SilentGate(FrameProcessor):
    """Suppress the persona's [SILENT] sentinel before it reaches TTS, so the bot
    actually stays quiet when not addressed (rather than synthesizing "[SILENT]").

    Decides per LLM response from the first non-whitespace content: if it starts the
    sentinel ("[SILENT…"), drop the whole response; otherwise flush what was buffered
    and pass the rest through token-by-token (preserves streaming for real replies).
    Only LLMTextFrames are gated — tool-call frames and everything else pass through.
    """

    def __init__(self) -> None:
        super().__init__()
        self._buf = ""
        self._decided: bool | None = None  # None=undecided, True=silent, False=speak

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = ""
            self._decided = None
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            if self._decided is True:
                return  # silent — drop
            if self._decided is False:
                await self.push_frame(frame, direction)
                return
            # Undecided: accumulate until we can tell.
            self._buf += frame.text
            stripped = self._buf.lstrip()
            if not stripped:
                return  # whitespace only so far — wait
            if stripped[0] == "[":
                if stripped.startswith(SILENT_TOKEN):
                    self._decided = True
                    return
                if SILENT_TOKEN.startswith(stripped):
                    return  # still could become the sentinel — wait for more
            # Real speech — emit what we buffered, then stream the rest.
            self._decided = False
            await self.push_frame(LLMTextFrame(self._buf), direction)
            return

        await self.push_frame(frame, direction)


class RAGContext(FrameProcessor):
    """Ground answers in the knowledge graph. When the bot is addressed ("Mnema, …"),
    retrieve top-k from Mnema search_docs and inject it as system context *before* the
    LLM runs, so replies are grounded without needing an explicit search tool call.
    Only fires when addressed (cheap + matches the silent-unless-addressed persona) and
    graceful-degrades on any error/timeout. Requires a live MNEMA_API_KEY."""

    def __init__(self, mnema: MnemaMCP) -> None:
        super().__init__()
        self._mnema = mnema

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text and "mnema" in text.lower():
                await self._inject(text, direction)
        await self.push_frame(frame, direction)

    async def _inject(self, query: str, direction: FrameDirection) -> None:
        try:
            res = await asyncio.wait_for(
                self._mnema.call("search_docs", {"query": query, "mode": "hybrid", "limit": 5}),
                timeout=2.5,
            )
        except Exception as e:  # noqa: BLE001 — never block the conversation on retrieval
            logger.warning("[rag] retrieval skipped: %s", e)
            return
        hits = (res or {}).get("results") or []
        if not hits:
            return
        blocks = []
        for h in hits[:5]:
            head = h.get("title") or ""
            if h.get("heading_path"):
                head = f"{head} › {h['heading_path']}"
            blocks.append(f"[{head}]\n{(h.get('snippet') or '').strip()}")
        content = (
            "[Context from the Mnema knowledge base — use naturally if relevant; "
            "do not mention you looked it up]\n\n" + "\n\n---\n\n".join(blocks)
        )
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": content}], run_llm=False
            ),
            direction,
        )
        logger.info("[rag] injected %d hits for: %s", len(hits), query[:60])


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
            # English by default — "multi" made Deepgram hallucinate foreign words on
            # silence/noise (e.g. "Sí, mi mamá"). Override via MEETING_STT_LANGUAGE.
            language=os.environ.get("MEETING_STT_LANGUAGE", "en"),
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
    # One persistent Mnema MCP session per meeting (low latency for per-turn search).
    mnema = MnemaMCP()
    register_mnema_tools(llm, mnema)

    # ── TTS — ElevenLabs cloned voice, streaming PCM for the Output Media webpage ──
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        voice_id=os.environ["ELEVENLABS_VOICE_ID"],
        model=os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        sample_rate=OUTPUT_SAMPLE_RATE,  # → pcm_24000; the page plays PCM16 @ this rate
    )

    # Stream TTS audio to the bot's Output Media webpage + signal barge-in.
    web_out = WebOutputProcessor(state)

    context = LLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=_mnema_tools_schema(),
    )
    # VAD on the user aggregator → emits UserStartedSpeakingFrame so the pipeline can
    # interrupt the bot mid-utterance (allow_interruptions below). Silero runs at 16 kHz.
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(sample_rate=RECALL_INPUT_SAMPLE_RATE),
        ),
    )

    metrics = TurnMetrics()

    pipeline = Pipeline([
        transport.input(),
        stt,
        NoiseGate(),            # drop sub-3-char STT noise before it reaches the LLM
        TurnMetricsEarly(metrics),  # stamp end-of-user-speech
        RAGContext(mnema),      # when addressed, inject knowledge-graph context
        aggregators.user(),     # VAD here → barge-in detection
        llm,
        SilentGate(),           # suppress the [SILENT] sentinel before TTS
        tts,
        TurnMetricsLate(metrics),   # stamp LLM/TTS milestones → log p50/p95
        web_out,                # stream PCM to the Output Media page; interrupt on barge-in
        aggregators.assistant(),
        transport.output(),     # control-frame sink (no audio leaves over Recall's WS)
    ])

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    logger.info("[meeting-pipeline] starting")
    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    finally:
        await mnema.aclose()
    logger.info("[meeting-pipeline] finished")


# ── WebSocket server: Recall connects to wss://meet-ws.../<MEETING_WS_SECRET> ──
app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok", "backend": "recall"}


@app.get("/output-page")
async def output_page():
    # The webpage Recall loads as the bot's camera for Output Media (Stage 2).
    return HTMLResponse(output_page_html())


@app.websocket("/output/{secret}")
async def output_ws(websocket: WebSocket, secret: str):
    # The bot's Output Media page connects here to receive streamed TTS audio.
    cid = websocket.query_params.get("cid")
    if not MEETING_WS_SECRET or secret != MEETING_WS_SECRET or not cid:
        await websocket.close(code=4403)
        return
    await websocket.accept()
    register_output_ws(cid, websocket)
    try:
        # The page rarely sends anything; this loop just keeps the socket open and
        # detects disconnect (raises when the page closes).
        while True:
            await websocket.receive_text()
    except Exception:  # noqa: BLE001
        pass
    finally:
        unregister_output_ws(cid)


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
