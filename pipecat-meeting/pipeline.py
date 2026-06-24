"""
pipecat-meeting/pipeline.py — Meeting-bot Pipecat pipeline (Recall.ai front end).

Recall joins the meeting and streams real-time SEPARATED per-participant audio to this
service over a public WebSocket (Caddy: meet-ws.theboringpeople.in → here:8765) — one
mono 16-bit LE PCM @ 16 kHz packet per participant in `audio_separate_raw.data` JSON
messages (see recall_io.RecallSerializer; A1.1). The pipeline runs:

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
    InputAudioRawFrame,
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
from vap_service import make_vap_service  # A1.4 predictive turn-taking (no-op stub unless MEETING_VAP=1)
from recall_io import (
    BotState,
    RecallSerializer,
    WebOutputProcessor,
    register_output_ws,
    unregister_output_ws,
    report_roster,
    current_asker,
    RECALL_INPUT_SAMPLE_RATE,
    OUTPUT_SAMPLE_RATE,
)

MEETING_WS_SECRET = os.environ.get("MEETING_WS_SECRET", "")

# A1.6: wake-word ("is the bot addressed") detection lives in addressing.py so it is
# unit-testable without the heavy pipecat/LLM imports. is_addressed = the fast-path;
# the semantic LLM classifier (_classify_addressed below) handles implicit address.
from addressing import is_addressed as _addressed  # noqa: E402
from silence import resolve_leading_silent  # noqa: E402  — pure SILENT_TOKEN gate logic

# "Live" questions whose answer is the current board/state, NOT a stored doc. For these we
# skip the doc-RAG injection (which can surface a stale snapshot like "no tasks in
# progress") and let the LLM call the live tools (list_project_tasks / list_recent_docs).
_LIVE_DATA_RE = re.compile(
    r"\b(task|tasks|in[- ]?progress|pending|backlog|to[- ]?do|status|latest|recent|sprint|"
    r"assigned|what'?s new|what is new|board|who('?s| is) (working|assigned)|deadline|due)\b",
    re.I,
)

# Addressed-only ("speak only when spoken to") is the default. Set MEETING_REQUIRE_ADDRESS=0
# to go back to the legacy always-respond mode.
_STRICT = os.environ.get("MEETING_REQUIRE_ADDRESS", "1") != "0"
# A1.6: semantic addressing. The fast LLM classifier judges, per turn, whether a
# non-wake-word utterance is directed at the bot (catches implicit address like "can you
# pull up the Q3 doc?"). Gated by env so it can be disabled if latency matters (the
# persona's <silent> path still decides); default on. Fail-closed (NO) on any error.
_SEMANTIC_ADDRESSING = os.environ.get("MEETING_SEMANTIC_ADDRESSING", "1") != "0"
_CLASSIFIER_MODEL = os.environ.get("MEETING_CLASSIFIER_MODEL", "gpt-4o-mini")

_CLASSIFY_SYS = (
    "You are the attention gate for a voice assistant named Mnema that sits silently in a "
    "live meeting between humans. Given the latest thing someone said, decide if it is "
    "directed AT Mnema — i.e. a question, request, or command for the assistant, or a "
    "direct follow-up to what Mnema just said — versus the people in the room talking to "
    "EACH OTHER. Most meeting talk is between the humans and is NOT for Mnema. When unsure, "
    "answer NO. Reply with exactly one word: YES or NO."
)


def _build_user_turn_strategies():
    """A1.5: end-of-utterance (EOU) turn-STOP strategy.

    Default: plain VAD-silence endpointing (~0.6s after the user stops) — fast,
    deterministic, no network. Pipecat 1.2.1's default SmartTurn v3 was avoided because
    on the continuous MIXED audio it kept deciding the turn wasn't over and stalled the
    LLM by tens of seconds. With A1.1 SEPARATED streams the analyzer sees one speaker, so
    a Smart Turn EOU can commit-to-respond at end-of-thought instead of on raw silence.

    Enable via MEETING_SMART_TURN=fal (+ FAL_KEY). Fully guarded: any import / version /
    key error logs and FALLS BACK to SpeechTimeout, so the pipeline never fails to start.
    NOTE: the exact pipecat-1.2.1 Smart Turn class path + the pipecat-ai[smart-turn] extra
    must be verified against the installed package at deploy (can't be read offline)."""
    mode = os.environ.get("MEETING_SMART_TURN", "off").lower()
    if mode in ("fal", "1", "on", "true"):
        try:
            from pipecat.audio.turn.smart_turn.fal_smart_turn import FalSmartTurnAnalyzer
            from pipecat.turns.user_stop import SmartTurnUserTurnStopStrategy
            analyzer = FalSmartTurnAnalyzer(api_key=os.environ.get("FAL_KEY"))
            logger.info("[turn] Smart Turn EOU enabled (Fal-hosted)")
            return UserTurnStrategies(stop=[SmartTurnUserTurnStopStrategy(analyzer)])
        except Exception as e:  # noqa: BLE001 — never block pipeline startup on this
            logger.warning(
                "[turn] Smart Turn requested but unavailable (%s) — falling back to "
                "VAD-silence endpointing. Verify the pipecat-1.2.1 Smart Turn API + the "
                "pipecat-ai[smart-turn] extra + FAL_KEY.", e,
            )
    return UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy()])

_classifier_client = None


def _get_classifier():
    global _classifier_client
    if _classifier_client is None:
        from openai import AsyncOpenAI
        _classifier_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _classifier_client


async def _classify_addressed(text: str, recently_engaged: bool, speaker: str | None = None) -> bool:
    """Ask the fast model whether `text` is directed at the bot. Fail-closed (NO) on any
    error/timeout so a classifier hiccup never makes the bot blurt into the room — the
    deterministic wake word still works as the manual override. A1.3 gives exact
    attribution, so the speaker's name is passed for sharper judgment."""
    try:
        hint = ("The user has just been talking with Mnema, so a bare follow-up question "
                "is probably still for Mnema." if recently_engaged
                else "There is no recent exchange with Mnema.")
        who = f"The speaker is {speaker}. " if speaker else ""
        res = await asyncio.wait_for(
            _get_classifier().chat.completions.create(
                model=_CLASSIFIER_MODEL, max_tokens=1, temperature=0,
                messages=[
                    {"role": "system", "content": _CLASSIFY_SYS},
                    {"role": "user", "content": f"{who}{hint}\nLatest utterance: \"{text}\"\nDirected at Mnema?"},
                ],
            ),
            timeout=2.0,
        )
        return (res.choices[0].message.content or "").strip().lower().startswith("y")
    except Exception as e:  # noqa: BLE001 — never block the meeting on the gate
        logger.warning("[classify] failed (defaulting to NO): %s", e)
        return False


# _addressed (wake-word fast-path) is imported from addressing.py — see top of file.


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
    """The MODEL decides whether to answer (it understands the whole conversation): the
    persona answers when addressed and emits SILENT_TOKEN to stay quiet during clear
    human-to-human side-talk. This gate just suppresses a SILENT_TOKEN reply before it
    reaches TTS, streaming a real reply token-by-token otherwise. A recent wake word forces
    a spoken answer (override). No timers, no fixed window. Pass-through in non-strict mode.
    """

    def __init__(self, state) -> None:
        super().__init__()
        self._state = state
        self._buf = ""
        self._forced = False               # this turn must be spoken (addressed / non-strict)
        self._decided: bool | None = None  # None=undecided, True=silent, False=speak

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = ""
            # _forced: non-strict mode OR an addressed turn (A1.6 per-turn force flag) means
            # THIS turn must be spoken. We still start undecided and inspect the leading
            # tokens so we can STRIP a stray "<silent>" the model may emit even on a forced
            # turn (audit fix) — otherwise the sentinel got spoken aloud. Consume the flag
            # here so it forces exactly THIS turn.
            self._forced = (not _STRICT) or self._state.force_next_response
            self._state.force_next_response = False
            if self._forced:
                self._state.last_response_monotonic = time.monotonic()
            self._decided = None
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            if self._decided is True:
                return  # resolved to silence — drop
            if self._decided is False:
                await self.push_frame(frame, direction)  # already speaking — stream through
                return
            # Undecided: buffer the leading text just long enough to rule the sentinel in/out.
            self._buf += frame.text
            action, text = resolve_leading_silent(self._buf, self._forced)
            if action == "wait":
                return
            if action == "drop":
                self._decided = True
                logger.info("[silentgate] model chose silence")
                return
            # speak / speak_stripped
            self._decided = False
            if action == "speak_stripped":
                logger.info("[silentgate] stripped stray <silent> on forced turn; speaking: %s",
                            (text or "")[:60])
            else:
                logger.info("[silentgate] speaking: %s", (text or "")[:60])
            if text:
                await self.push_frame(LLMTextFrame(text), direction)
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
        self._identity_str: str | None = None  # cached whoami (role/team/access)
        self._startup_done = False             # A2.1: workspace brief injected once

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                # A1.6 semantic addressing. Two paths set the PER-TURN force flag so the
                # next response is spoken (the persona's <silent> still suppresses clear
                # side-talk when neither fires):
                #   (a) wake word — instant, deterministic fast-path ("Mnema, …").
                #   (b) else the fast LLM classifier judges implicit address ("can you pull
                #       up the Q3 doc?"). Gated by env, fail-closed (NO), skipped if the
                #       fast-path already fired. Replaces the old 6s force_until window.
                addressed = False
                if _addressed(text):
                    self._state.force_next_response = True
                    addressed = True
                    logger.info("[gate] wake word: %s", text[:60])
                elif _STRICT and _SEMANTIC_ADDRESSING:
                    recently = (time.monotonic() - self._state.last_response_monotonic) < 30.0
                    speaker = (current_asker(self._state).get("name") or None)
                    if await _classify_addressed(text, recently, speaker):
                        self._state.force_next_response = True
                        addressed = True
                        logger.info("[gate] classifier: addressed — %s", text[:60])
                await self._inject_startup_brief(direction)   # A2.1: workspace brief (once)
                await self._inject_identity(direction)         # speaker identity (once)
                if addressed:
                    await self._inject(text, direction)        # A2.2: graph-aware grounding
        await self.push_frame(frame, direction)

    async def _inject_startup_brief(self, direction: FrameDirection) -> None:
        """A2.1 startup tier: give the bot a standing model of the workspace — its central
        topics (god-nodes) — so cold questions ("what is this about / what matters here")
        land in context with no tool call. Injected ONCE, early, off the turn path. Cached
        after the persona so the A3.3 stable prefix is preserved."""
        if self._startup_done:
            return
        self._startup_done = True
        try:
            res = await asyncio.wait_for(self._mnema.call("get_god_nodes", {"limit": 8}), timeout=2.5)
            brief = ((res or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001 — never block on the brief
            logger.warning("[startup] god_nodes failed: %s", e)
            return
        if not brief:
            return
        # A2.5: also surface the top cross-domain links so the bot can VOLUNTEER a relevant
        # cross-project connection unprompted (not left as a model-elected tool).
        surprising = ""
        try:
            sres = await asyncio.wait_for(
                self._mnema.call("get_surprising_connections", {"limit": 5}), timeout=2.0)
            stxt = ((sres or {}).get("content") or "").strip()
            if stxt:
                surprising = ("\n\n[Cross-project connections worth surfacing when relevant]\n"
                              + stxt[:600])
        except Exception as e:  # noqa: BLE001 — optional
            logger.debug("[startup] surprising_connections skipped: %s", e)
        logger.info("[startup] injected workspace brief (%d chars)", len(brief))
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": (
                    "[Workspace — central topics & structure] The most connected things in this "
                    "workspace's knowledge graph are below. Use them to ground answers about what "
                    "the org/project is about, without calling a tool.\n\n" + brief[:1200] + surprising
                )}],
                run_llm=False,
            ),
            direction,
        )

    async def _inject_identity(self, direction: FrameDirection) -> None:
        """Tell the LLM WHO it's talking to AND their org role/team/access, so 'who am I /
        what's my role' work and the bot HOLDS that context. Fetched once via the server
        `whoami` tool (the bot acts as the resolved speaker), then cached + re-stated each
        turn so it stays in recent context."""
        if self._identity_str is not None:
            return  # fetched + injected once already; the whoami tool covers later asks
        self._identity_str = ""
        try:
            res = await asyncio.wait_for(self._mnema.call("whoami", {}), timeout=2.5)
            self._identity_str = ((res or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("[identity] whoami failed: %s", e)
        if not self._identity_str:
            return
        logger.info("[identity] %s", self._identity_str[:80])
        # A2.4 speaker tier: also pull what this person is connected to in the graph
        # (their tasks / meetings / team) so "what's on my plate / what did I commit to"
        # answer from the graph with no turn-time traversal. Best-effort, appended once.
        work_block = ""
        speaker = (current_asker(self._state).get("name") or "").strip()
        if speaker:
            try:
                gres = await asyncio.wait_for(
                    self._mnema.call("traverse_graph", {"from": speaker, "depth": 1}), timeout=2.0)
                gtxt = ((gres or {}).get("content") or "").strip()
                if gtxt:
                    work_block = ("\n\n[What this person is connected to — their tasks, meetings, "
                                  "team. Answer 'what's on my plate / what did I commit to' from "
                                  "this]\n" + gtxt[:600])
            except Exception as e:  # noqa: BLE001 — optional
                logger.debug("[identity] speaker graph skipped: %s", e)
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": (
                    f"[Who you are speaking with] {self._identity_str} When they ask who they "
                    f"are, their role, title, team, or what they can access, answer from this "
                    f"directly — never refuse it as personal information." + work_block
                )}],
                run_llm=False,
            ),
            direction,
        )

    async def _inject(self, query: str, direction: FrameDirection) -> None:
        """A2.2 per-turn tier: relationship-aware grounding injected BEFORE the LLM runs, in
        one pass, no tool round-trip. search_docs (vector seed) → traverse_graph from the top
        hit (1-hop neighbourhood) → path-prune (top hit + a few neighbours) → token-cap →
        inject. Live-board questions are routed to the reactive tools instead."""
        # Route live-state questions (tasks/status/board) to the live tools — stored docs
        # would surface a stale snapshot.
        if _LIVE_DATA_RE.search(query):
            return
        try:
            res = await asyncio.wait_for(
                self._mnema.call("search_docs", {"query": query, "mode": "hybrid", "limit": 4}),
                timeout=2.5,
            )
        except Exception as e:  # noqa: BLE001 — never block the conversation on retrieval
            logger.warning("[rag] retrieval skipped: %s", e)
            return
        hits = (res or {}).get("results") or []
        if not hits:
            return
        blocks = []
        for h in hits[:3]:   # seed: top doc hits, project-labelled
            proj = h.get("project_name") or "Unfiled"
            head = h.get("title") or ""
            if h.get("heading_path"):
                head = f"{head} › {h['heading_path']}"
            blocks.append(f"[project: {proj} | {head}]\n{(h.get('snippet') or '').strip()}")

        # A2.2 expansion: follow relationships from the TOP hit's node (1-hop) so answers
        # reflect how things connect, not just keyword similarity. Best-effort + capped.
        top_label = (hits[0].get("title") or "").strip()
        if top_label:
            try:
                gres = await asyncio.wait_for(
                    self._mnema.call("traverse_graph", {"from": top_label, "depth": 1}),
                    timeout=2.0,
                )
                gtxt = ((gres or {}).get("content") or "").strip()
                if gtxt:
                    blocks.append("[Related in the knowledge graph — how this connects]\n" + gtxt[:600])
            except Exception as e:  # noqa: BLE001 — graph expansion is optional
                logger.debug("[rag] graph expand skipped: %s", e)

        content = (
            "[Background — stored docs + their graph relations, each labelled with its project. "
            "Docs may be OUT OF DATE; for current tasks/status/assignments call the live tools "
            "(list_project_tasks / list_recent_docs). Use naturally; don't say you looked it up]"
            "\n\n" + "\n\n---\n\n".join(blocks)
        )[:2500]   # hard token-ish cap on the injection
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": content}], run_llm=False
            ),
            direction,
        )
        logger.info("[rag] injected %d hits + graph for: %s", len(hits[:3]), query[:60])


class VapTap(FrameProcessor):
    """A1.4: feed the active human's separated 16 kHz stream to the VAP service
    (channel 1). Pure passthrough — the bot's TTS (channel 2) is fed from
    WebOutputProcessor. No-op when VAP is the stub (MEETING_VAP off / deps missing)."""

    def __init__(self, state) -> None:
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and self._state.vap is not None and frame.audio:
            try:
                self._state.vap.push_human_audio(frame.audio)
            except Exception as e:  # noqa: BLE001 — VAP must never break the audio path
                logger.debug("[vap] push_human_audio failed: %s", e)
        await self.push_frame(frame, direction)


async def build_and_run_meeting_pipeline(websocket: WebSocket, system_prompt: str) -> None:
    """One meeting = one pipeline run. Audio in from Recall, replies out via Output Audio."""
    state = BotState()
    serializer = RecallSerializer(state)
    # A1.4: predictive turn-taking. make_vap_service() returns a no-op stub unless
    # MEETING_VAP=1 and vap_realtime is installed, so this is safe by default.
    state.vap = make_vap_service()
    state.vap.start()

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
    # A3.1: the LLM is OpenAI-compatible and swappable to a validated fast-silicon open
    # model (Groq / Cerebras / Gemini 2.5 Flash) purely by config — tool registration is
    # unchanged. Defaults to OpenAI gpt-4o-mini; set MEETING_LLM_BASE_URL + MEETING_LLM_MODEL
    # (+ MEETING_LLM_API_KEY) to point at the model A3.2 validated. base_url is only passed
    # when set, so the default path is byte-identical to before.
    _llm_kwargs = dict(
        api_key=os.environ.get("MEETING_LLM_API_KEY") or os.environ["OPENAI_API_KEY"],
        model=os.environ.get("MEETING_LLM_MODEL", os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini")),
    )
    _llm_base_url = os.environ.get("MEETING_LLM_BASE_URL")
    if _llm_base_url:
        _llm_kwargs["base_url"] = _llm_base_url
    llm = OpenAILLMService(**_llm_kwargs)
    logger.info("[llm] model=%s base=%s", _llm_kwargs["model"], _llm_base_url or "openai-default")
    # Per-asker Mnema MCP sessions (meeting identity): MnemaMCP reads the active
    # speaker from BotState and answers each call scoped to that participant.
    mnema = MnemaMCP(state)
    register_mnema_tools(llm, mnema)

    # ── TTS — ElevenLabs cloned voice, streaming PCM for the Output Media webpage ──
    # A3.4: first-sentence streaming is already the architecture — ElevenLabs Flash streams
    # audio as LLM text arrives (SilentGate pushes LLMTextFrames token-by-token, and the
    # addressed/forced path streams the first tokens immediately without buffering), so
    # playback begins before generation completes. No batching of the full reply.
    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        voice_id=os.environ["ELEVENLABS_VOICE_ID"],
        model=os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        sample_rate=OUTPUT_SAMPLE_RATE,  # → pcm_24000; the page plays PCM16 @ this rate
    )

    # Stream TTS audio to the bot's Output Media webpage + signal barge-in.
    web_out = WebOutputProcessor(state)

    # A3.3: the persona is the FIRST, STABLE system message — the cacheable prefix. All
    # dynamic content (identity, A2 graph brief/RAG) is APPENDED after it via
    # LLMMessagesAppendFrame, never prepended, so OpenAI-compatible providers (OpenAI /
    # Groq auto-cache long stable prefixes) reuse the prefill on turn 2+. The full win
    # lands once A2.1's startup brief becomes part of this prefix.
    context = LLMContext(
        messages=[{"role": "system", "content": system_prompt}],
        tools=_mnema_tools_schema(),
    )
    # VAD on the user aggregator → emits UserStartedSpeakingFrame for barge-in.
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(sample_rate=RECALL_INPUT_SAMPLE_RATE),
            user_turn_strategies=_build_user_turn_strategies(),
        ),
    )

    metrics = TurnMetrics()

    pipeline = Pipeline([
        transport.input(),      # A1.1: separated streams; bot's own audio dropped at the serializer
        VapTap(state),          # A1.4: tap the human stream into VAP (no-op unless MEETING_VAP=1)
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
        try:
            state.vap.stop()
        except Exception:  # noqa: BLE001
            pass
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
