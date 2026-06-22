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
import re
import time
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
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
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
    InputGate,
    WebOutputProcessor,
    register_output_ws,
    unregister_output_ws,
    report_roster,
    current_asker,
    RECALL_INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
)

MEETING_WS_SECRET = os.environ.get("MEETING_WS_SECRET", "")

# "Mnema" + common speech-to-text mishearings — used to decide when the bot is addressed.
# STT renders the name wildly (Nama, Nema, Nima, Neema, Nemo, Namah, Kneema …), so we ALSO
# accept anything matching the phonetic shape n/mn + vowel(s) + m + vowel(s) via _WAKE_RE,
# which covers the variants without matching ordinary words like "name"/"no"/"mama".
_WAKE_WORDS = frozenset((
    "mnema", "nima", "neema", "nema", "nemo", "nimo", "mneme", "menma", "namo", "amnema",
    "nama", "naima", "namah", "nemma", "nyema", "kneema", "knema", "neemah", "nemah",
))
_WAKE_RE = re.compile(r"m?n[aeiy][aeiy]?m[aiouh]*")
# "Live" questions whose answer is the current board/state, NOT a stored doc. For these we
# skip the doc-RAG injection (which can surface a stale snapshot like "no tasks in
# progress") and let the LLM call the live tools (list_project_tasks / list_recent_docs).
_LIVE_DATA_RE = re.compile(
    r"\b(task|tasks|in[- ]?progress|pending|backlog|to[- ]?do|status|latest|recent|sprint|"
    r"assigned|what'?s new|what is new|board|who('?s| is) (working|assigned)|deadline|due)\b",
    re.I,
)
# Fillers/greetings people naturally put before a vocative ("so Mnema", "um Mnema").
_GREETINGS = ("hey", "ok", "okay", "hi", "hello", "yo", "so", "um", "uh", "erm", "yeah", "alright", "and")


def _is_wake(tok: str) -> bool:
    return tok in _WAKE_WORDS or bool(_WAKE_RE.fullmatch(tok))

# Addressed-only ("speak only when spoken to") is the default. Set MEETING_REQUIRE_ADDRESS=0
# to go back to the legacy always-respond mode.
_STRICT = os.environ.get("MEETING_REQUIRE_ADDRESS", "1") != "0"
# Short window (seconds) an "addressed" decision stays valid — only long enough to bridge
# STT splitting one utterance into several segments + the LLM/tool round-trip for THAT
# turn. It is NOT a conversation timer: each new turn is re-judged by the classifier, so a
# real back-and-forth continues naturally and lapses the moment the talk isn't for the bot.
_ENGAGE_WINDOW = float(os.environ.get("MEETING_ENGAGE_WINDOW_S", "12"))
# Fast model that judges, per turn, whether the user is talking TO the bot.
_CLASSIFIER_MODEL = os.environ.get("MEETING_CLASSIFIER_MODEL", "gpt-4o-mini")

_CLASSIFY_SYS = (
    "You are the attention gate for a voice assistant named Mnema that sits silently in a "
    "live meeting between humans. Given the latest thing someone said, decide if it is "
    "directed AT Mnema — i.e. a question, request, or command for the assistant, or a "
    "direct follow-up to what Mnema just said — versus the people in the room talking to "
    "EACH OTHER. Most meeting talk is between the humans and is NOT for Mnema. When unsure, "
    "answer NO. Reply with exactly one word: YES or NO."
)

_classifier_client = None


def _get_classifier():
    global _classifier_client
    if _classifier_client is None:
        from openai import AsyncOpenAI
        _classifier_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _classifier_client


async def _classify_addressed(text: str, recently_engaged: bool) -> bool:
    """Ask the fast model whether `text` is directed at the bot. Fail-closed (NO) on any
    error/timeout so a classifier hiccup never makes the bot blurt into the room — the
    deterministic wake word still works as the manual override."""
    try:
        hint = ("The user has just been talking with Mnema, so a bare follow-up question "
                "is probably still for Mnema." if recently_engaged
                else "There is no recent exchange with Mnema.")
        res = await asyncio.wait_for(
            _get_classifier().chat.completions.create(
                model=_CLASSIFIER_MODEL, max_tokens=1, temperature=0,
                messages=[
                    {"role": "system", "content": _CLASSIFY_SYS},
                    {"role": "user", "content": f"{hint}\nLatest utterance: \"{text}\"\nDirected at Mnema?"},
                ],
            ),
            timeout=2.0,
        )
        return (res.choices[0].message.content or "").strip().lower().startswith("y")
    except Exception as e:  # noqa: BLE001 — never block the meeting on the gate
        logger.warning("[classify] failed (defaulting to NO): %s", e)
        return False


def _addressed(text: str) -> bool:
    """True only when the bot is *addressed* — the wake word is at the START of the
    utterance (vocative: "Mnema, …"), or right after a greeting ("hey Mnema"). A wake
    word later in a sentence (people talking ABOUT Mnema — "let's put this in Mnema")
    does NOT count, which is what stops the bot replying to normal conversation."""
    tokens = re.findall(r"[a-z]+", text.lower())
    if not tokens:
        return False
    if _is_wake(tokens[0]):                            # "Mnema, …" (vocative, first word)
        return True
    # a filler/greeting immediately followed by the wake word ("hey/so/um Mnema …")
    for i in range(len(tokens) - 1):
        if tokens[i] in _GREETINGS and _is_wake(tokens[i + 1]):
            return True
    return False


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
    """Deterministic addressing gate — the bot speaks only while it's "engaged", i.e. it
    was addressed by name within the last MEETING_ENGAGE_WINDOW_S (the window lives on
    BotState, opened by RAGContext). Using a time window rides over STT/VAD fragmentation
    (the wake word and the question often land in different segments/turns) and needs no
    sentinel from the LLM. In non-strict mode it's a pass-through.
    """

    def __init__(self, state) -> None:
        super().__init__()
        self._state = state
        self._drop = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            engaged = time.monotonic() < self._state.engaged_until
            self._drop = _STRICT and not engaged
            logger.info("[silentgate] %s", "suppressed (not addressed)" if self._drop else "speaking (engaged)")
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            if self._drop:
                return  # not engaged → stay silent
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


class RAGContext(FrameProcessor):
    """Ground answers in the knowledge graph. When the bot is addressed ("Mnema, …"),
    retrieve top-k from Mnema search_docs and inject it as system context *before* the
    LLM runs, so replies are grounded without needing an explicit search tool call.
    Only fires when addressed (cheap + matches the silent-unless-addressed persona) and
    graceful-degrades on any error/timeout. Requires a live MNEMA_API_KEY."""

    def __init__(self, mnema: MnemaMCP, state) -> None:
        super().__init__()
        self._mnema = mnema
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                now = time.monotonic()
                wake = _addressed(text)
                # Dynamic addressee detection: a wake word always engages; otherwise a fast
                # classifier judges whether THIS turn is for the bot (question/request/
                # follow-up) vs the humans talking to each other. Re-judged every turn, so a
                # real back-and-forth keeps going without re-saying the name and it stays
                # quiet during normal conversation — no fixed conversation timer.
                addressed = wake or (_STRICT and await _classify_addressed(text, now < self._state.engaged_until))
                if addressed:
                    self._state.engaged_until = now + _ENGAGE_WINDOW
                    logger.info("[gate] engaged (%s): %s", "wake" if wake else "classified", text[:60])
                    await self._inject_identity(direction)
                    # For "live" questions (tasks/status/latest) DON'T inject stored docs —
                    # they go stale; force the LLM to use the live tools instead.
                    if not _LIVE_DATA_RE.search(text):
                        await self._inject(text, direction)
        await self.push_frame(frame, direction)

    async def _inject_identity(self, direction: FrameDirection) -> None:
        """Tell the LLM who it's talking to, so 'who am I / what's my role' work. The bot
        answers with the access of the resolved participant (host → the organizer)."""
        try:
            asker = current_asker(self._state)
        except Exception:  # noqa: BLE001
            return
        name = (asker.get("name") or "").strip()
        if not name:
            return
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": (
                    f"You are speaking with {name}, a participant in this meeting. If they ask "
                    f"\"who am I\", their name, role, team, or what they have access to, that is "
                    f"who they mean — use list_projects / the knowledge base to answer about "
                    f"{name} and their work; do not refuse as 'personal information'."
                )}],
                run_llm=False,
            ),
            direction,
        )

    async def _inject(self, query: str, direction: FrameDirection) -> None:
        # Search across everything the bot can access; results are project-labelled, so
        # the LLM grounds on the right one. (Explicit per-project scoping happens when the
        # LLM calls search_knowledge with a resolved project_id.)
        search_args = {"query": query, "mode": "hybrid", "limit": 5}
        try:
            res = await asyncio.wait_for(
                self._mnema.call("search_docs", search_args),
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
            proj = h.get("project_name") or "Unfiled"
            head = h.get("title") or ""
            if h.get("heading_path"):
                head = f"{head} › {h['heading_path']}"
            # Prefix each snippet with its project so the model never mixes projects.
            blocks.append(f"[project: {proj} | {head}]\n{(h.get('snippet') or '').strip()}")
        content = (
            "[Background reference from the knowledge base — each item is labelled with its "
            "project. These are stored DOCS and may be OUT OF DATE. For anything about current "
            "tasks, status, what's in progress, the latest, or assignments, IGNORE these and "
            "call the live tools (list_project_tasks / list_recent_docs / list_projects). Use "
            "naturally, don't mention you looked it up]\n\n" + "\n\n---\n\n".join(blocks)
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
            # THE actual fix for wake detection: Nova-3 keyterm prompting biases STT toward
            # the bot's made-up name, so it transcribes "Mnema" instead of guessing
            # Nava/Neva/Rima/Nama. Without this no wake-word list can catch the random
            # phonetic spellings. Configurable/extendable via MEETING_WAKE_KEYTERMS.
            keyterm=[k.strip() for k in os.environ.get("MEETING_WAKE_KEYTERMS", "Mnema").split(",") if k.strip()],
        ),
    )

    # ── LLM — GPT-4o-mini with Mnema tools registered for real execution ──────
    llm = OpenAILLMService(
        api_key=os.environ["OPENAI_API_KEY"],
        model=os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini"),
    )
    # Per-asker Mnema MCP sessions (meeting identity): MnemaMCP reads the active
    # speaker from BotState and answers each call scoped to that participant.
    mnema = MnemaMCP(state)
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
    # VAD on the user aggregator → emits UserStartedSpeakingFrame for barge-in.
    # IMPORTANT: override the default turn-STOP strategy. Pipecat 1.2.1 defaults to
    # SmartTurn v3 (TurnAnalyzer), which on continuous meeting audio keeps deciding the
    # turn isn't over and delays the LLM by tens of seconds. Use plain VAD-silence
    # endpointing (0.6s after the user stops) like the VAP — fast and deterministic.
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(sample_rate=RECALL_INPUT_SAMPLE_RATE),
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy()],
            ),
        ),
    )

    metrics = TurnMetrics()

    pipeline = Pipeline([
        transport.input(),
        InputGate(state),       # half-duplex: mute the bot's own echo while it speaks
        stt,
        NoiseGate(),            # drop sub-3-char STT noise before it reaches the LLM
        TurnMetricsEarly(metrics),  # stamp end-of-user-speech
        RAGContext(mnema, state),  # track addressing + inject KG context when addressed
        aggregators.user(),     # VAD here → barge-in detection
        llm,
        SilentGate(state),      # speak only when the turn addressed the bot
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
        # Final roster snapshot (marks the meeting ended) before tearing down.
        try:
            await report_roster(state, ended=True)
        except Exception:  # noqa: BLE001
            pass
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
