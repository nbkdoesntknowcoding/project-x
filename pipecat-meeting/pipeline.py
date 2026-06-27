"""
pipecat-meeting/pipeline.py — Meeting-bot Pipecat pipeline (Recall.ai front end).

Recall joins the meeting and streams real-time SEPARATED per-participant audio to this
service over a public WebSocket (Caddy: meet-ws.theboringpeople.in → here:8765) — one
mono 16-bit LE PCM @ 16 kHz packet per participant in `audio_separate_raw.data` JSON
messages (see recall_io.RecallSerializer; A1.1). The pipeline runs:

    Deepgram STT → GPT-4o-mini (+ Mnema tools) → Inworld TTS (streaming PCM)

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
from pipecat.services.inworld.tts import InworldTTSService  # 1.2.1: class lives in .tts (not re-exported)
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
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
    UserStoppedSpeakingFrame,
    TTSSpeakFrame,
    EndFrame,
    CancelFrame,
)

from meeting_persona import (
    build_meeting_persona, build_speaker_modulation_block, build_reanchor_block, SILENT_TOKEN,
)
from latency import TurnMetrics, TurnMetricsEarly, TurnMetricsLate
from output_page import output_page_html
from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
from mnema_client import register_mnema_tools, MnemaMCP, parse_whoami_identity
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
from addressing import is_addressed as _addressed, is_question_or_request  # noqa: E402
from silence import resolve_leading_silent  # noqa: E402  — pure SILENT_TOKEN gate logic
from text_norm import to_spoken_plaintext  # noqa: E402  — strip markdown from [Background]
from context_prune import prune_context  # noqa: E402  — STEP 1: keep per-turn context lean
from markdown_stream import SpokenStripper  # noqa: E402  — STEP 4: strip model markdown pre-TTS
from text_norm import looks_enumerated  # noqa: E402  — STEP 3: flag list-cadence (no mangle)
from llm_config import resolve_model, resolve_api_key, resolve_base_url  # noqa: E402  — GPT-4.1 swap
from silence import forced_silence_fallback  # noqa: E402  — STEP 1: never silent on a forced turn
from recap import recap_on_start, recap_on_end, build_start_recap, build_end_recap  # noqa: E402
from local_tools import LOCAL_TOOL_DEFINITIONS, register_local_tools  # noqa: E402  — #6 live-meeting tools

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
# A1.6 addressing is now DETERMINISTIC (STEP 1): wake word (is_addressed) OR a direct
# question/assistant-request (is_question_or_request), both pure. The old gpt-4o-mini
# semantic classifier was removed — it flickered across runs (no seed). See the gate below.

# Layer C drift re-anchor: re-state the persona character every N of Mnema's OWN spoken
# turns to counter long-context drift. Transient per-turn injection (not cached).
REANCHOR_EVERY_TURNS = int(os.environ.get("MEETING_REANCHOR_EVERY", "13"))

# STEP 1: rolling conversation window. Keep the last N user turns in the LLM context
# instead of replaying the whole meeting each turn (which buried the persona). System
# context — Layer A + the one-shot briefs — is always preserved; only old user/assistant
# turns age out, and only at user-turn boundaries (tool_call/result pairs never split).
# Tune via MEETING_CONTEXT_USER_TURNS; 0 disables the window (transient stripping stays on).
CONTEXT_USER_TURNS = int(os.environ.get("MEETING_CONTEXT_USER_TURNS", "10"))

# Semantic-addressing classifier prompt lives in addressing.CLASSIFY_SYS (shared with the
# realness harness mirror so the two never drift). Imported below with is_addressed.


def _build_user_turn_strategies():
    """A1.5 / audit #3: end-of-utterance (EOU) turn-STOP strategy. Three modes via
    MEETING_SMART_TURN — all guarded (any error logs and FALLS BACK to VAD silence, so the
    pipeline never fails to start):

      - "local" (recommended): LocalSmartTurnAnalyzerV3 — the ONNX CPU model bundled with
        pipecat (no torch, no Fal, no API cost). Benchmarked ~40ms median on this VPS at
        cpu_count=1 (more cores were noisier). Tune cores via MEETING_SMART_TURN_CPUS.
      - "fal": Fal-hosted Smart Turn (needs FAL_KEY; paid).
      - "off" (default): plain VAD-silence endpointing. The silence window is tunable via
        MEETING_EOU_SILENCE_SEC (default 0.6s) — raise it (~1.0s) to cut mid-sentence
        finalisation with no model at all.

    Smart Turn works well here because A1.1 feeds it SEPARATED single-speaker audio (on the
    old MIXED audio pipecat's analyzer stalled deciding the turn wasn't over)."""
    mode = os.environ.get("MEETING_SMART_TURN", "off").lower()
    if mode in ("local", "v3", "onnx"):
        try:
            from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
            from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
            cpus = int(os.environ.get("MEETING_SMART_TURN_CPUS", "1"))
            analyzer = LocalSmartTurnAnalyzerV3(cpu_count=cpus)
            logger.info("[turn] Smart Turn EOU enabled (local ONNX v3, cpu_count=%d)", cpus)
            return UserTurnStrategies(stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)])
        except Exception as e:  # noqa: BLE001 — never block pipeline startup on this
            logger.warning("[turn] local Smart Turn unavailable (%s) — falling back to VAD silence.", e)
    elif mode in ("fal", "1", "on", "true"):
        try:
            from pipecat.audio.turn.smart_turn.fal_smart_turn import FalSmartTurnAnalyzer
            from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
            analyzer = FalSmartTurnAnalyzer(api_key=os.environ.get("FAL_KEY"))
            logger.info("[turn] Smart Turn EOU enabled (Fal-hosted)")
            return UserTurnStrategies(stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=analyzer)])
        except Exception as e:  # noqa: BLE001
            logger.warning("[turn] Fal Smart Turn unavailable (%s) — falling back to VAD silence.", e)
    silence = float(os.environ.get("MEETING_EOU_SILENCE_SEC", "0.6"))
    logger.info("[turn] VAD-silence endpointing (user_speech_timeout=%.2fs)", silence)
    return UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=silence)])

# STEP 1: the old gpt-4o-mini addressing classifier (_classify_addressed / _get_classifier)
# was REMOVED — it was the source of the <silent> flicker (an unsneeded LLM call, temperature 0
# but NO seed, so borderline questions flipped ADDRESSED/silent across runs). The gate is now
# the two PURE functions imported from addressing.py: is_addressed (wake word) and
# is_question_or_request (direct question / assistant-style request). Both are deterministic.


def _mnema_tools_schema() -> ToolsSchema:
    """Convert the OpenAI-format Mnema tool dicts to Pipecat 1.2.1 FunctionSchemas."""
    fns = []
    for t in list(MNEMA_TOOL_DEFINITIONS) + list(LOCAL_TOOL_DEFINITIONS):  # #6 local tools
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
        self._emitted = 0                  # spoken frames pushed this response (STEP 1 guarantee)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = ""
            self._emitted = 0
            # _forced: non-strict mode OR an addressed turn (A1.6 per-turn force flag) means
            # THIS turn must be spoken. We still start undecided and inspect the leading
            # tokens so we can STRIP a stray "<silent>" the model may emit even on a forced
            # turn (audit fix) — otherwise the sentinel got spoken aloud. Consume the flag
            # here so it forces exactly THIS turn.
            self._forced = (not _STRICT) or self._state.force_next_response
            self._state.force_next_response = False
            if self._forced:
                self._state.last_response_monotonic = time.monotonic()
                self._decided = None   # inspect leading tokens (strip any stray sentinel)
            else:
                # _STRICT and NOT addressed (no wake word, classifier said NO) → stay silent
                # DETERMINISTICALLY. Previously this left the turn undecided and trusted the
                # model to emit <silent>, which it usually didn't — so the bot answered clear
                # human-to-human side-talk (audit 2026-06-24). Now un-addressed = dropped.
                self._decided = True
                logger.info("[silentgate] un-addressed turn — staying silent")
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            if self._decided is True:
                return  # resolved to silence — drop
            if self._decided is False:
                await self.push_frame(frame, direction)  # already speaking — stream through
                self._emitted += 1
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
            # Count THIS as one of Mnema's OWN spoken turns (drives the Layer C re-anchor).
            # Reached only when she commits to speaking — never on <silent>/dropped/un-addressed
            # turns. Dynamic attr on the shared BotState keeps this a single-file change.
            self._state.spoken_turns = getattr(self._state, "spoken_turns", 0) + 1
            if action == "speak_stripped":
                logger.info("[silentgate] stripped stray <silent> on forced turn; speaking: %s",
                            (text or "")[:60])
            else:
                logger.info("[silentgate] speaking: %s", (text or "")[:60])
            if text:
                await self.push_frame(LLMTextFrame(text), direction)
                self._emitted += 1
            return

        # STEP 1 guarantee: an addressed/forced turn must NEVER end silent. If the model
        # produced nothing speakable (pure <silent> / empty), speak the honest fallback before
        # the response closes — a direct question never returns silence.
        if isinstance(frame, LLMFullResponseEndFrame):
            if self._forced and self._emitted == 0:
                logger.info("[silentgate] forced turn produced no speech — honest fallback")
                await self.push_frame(LLMTextFrame(forced_silence_fallback()), direction)
                self._emitted += 1
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


class SpokenOutputNormalizer(FrameProcessor):
    """STEP 4: the output-side safety net. Every LLMTextFrame the model streams toward TTS
    passes through SpokenStripper, which converts any stray markdown the model emitted
    (despite the persona forbidding it — the log caught "- **Title:** …") into spoken
    plaintext right before synthesis. Sentence/line-buffered, so first-sentence streaming is
    preserved and no extra latency is added. Non-text frames (TTSSpeakFrame from the recap,
    control frames) pass straight through. Reset on each LLM response so buffers never leak
    between turns."""

    def __init__(self) -> None:
        super().__init__()
        self._stripper = SpokenStripper()
        self._spoken = ""   # accumulated cleaned reply — for the list-cadence flag only

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._stripper = SpokenStripper()  # fresh buffer per response
            self._spoken = ""
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, LLMTextFrame):
            for seg in self._stripper.feed(frame.text):
                self._spoken += seg
                await self.push_frame(LLMTextFrame(seg), direction)
            return  # original (possibly markdown/sign-off) frame is swallowed; cleaned segs emitted
        if isinstance(frame, LLMFullResponseEndFrame):
            tail = self._stripper.flush()
            if tail:
                self._spoken += tail
                await self.push_frame(LLMTextFrame(tail + " "), direction)
            # STEP 3: damp list-cadence — FLAG only, never mangle (a safe spoken-prose collapse
            # needs the model; mangling could change meaning). Persona + model carry the rewrite.
            if looks_enumerated(self._spoken):
                logger.info("[output] list-cadence flagged (not mangled): %s", self._spoken[:80])
            await self.push_frame(frame, direction)
            return
        await self.push_frame(frame, direction)


class RAGContext(FrameProcessor):
    """Ground answers in the knowledge graph. When the bot is addressed ("Mnema, …"),
    retrieve top-k from Mnema search_docs and inject it as system context *before* the
    LLM runs, so replies are grounded without needing an explicit search tool call.
    Only fires when addressed (cheap + matches the silent-unless-addressed persona) and
    graceful-degrades on any error/timeout. Requires a live MNEMA_API_KEY."""

    def __init__(self, mnema: MnemaMCP, state, context=None) -> None:
        super().__init__()
        self._mnema = mnema
        self._state = state
        self._context = context                # LLMContext — pruned each turn (STEP 1)
        self._prune_warned = False             # log the prune-API mismatch at most once
        self._spk_resolved = False             # whoami identity resolved + cached once
        self._spk: dict = {}                   # cached {name, role, team, access_level} for Layer B
        self._work_injected = False            # A2.4 speaker work-graph injected once
        self._startup_done = False             # A2.1: workspace brief injected once
        self._reanchors_done = 0               # Layer C re-anchors fired so far (milestones)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                # #6: log EVERY human utterance (addressed or not) with its speaker so the
                # bot can answer "who said X" from this live call. Capped to stay bounded.
                spk = current_asker(self._state).get("name")
                self._state.meeting_log.append({"speaker": spk, "text": text})
                if len(self._state.meeting_log) > 300:
                    del self._state.meeting_log[0]
                # A1.6 addressing — now FULLY DETERMINISTIC (STEP 1). Two pure paths set the
                # PER-TURN force flag so the next response is spoken:
                #   (a) wake word — vocative "Mnema, …" / "morning, Nema".
                #   (b) a direct question or assistant-style request (is_question_or_request).
                # Both are pure functions → identical input always classifies the same way. The
                # old gpt-4o-mini classifier (temperature 0 but NO seed) was non-deterministic
                # and flickered ADDRESSED/silent on borderline questions like "who just spoke
                # before me?" across runs — that LLM call is removed from the decision. A bare
                # declarative / back-channel stays non-addressed (silent), conservatively.
                addressed = False
                if _addressed(text):
                    self._state.force_next_response = True
                    addressed = True
                    logger.info("[gate] wake word: %s", text[:60])
                elif _STRICT and is_question_or_request(text):
                    self._state.force_next_response = True
                    addressed = True
                    logger.info("[gate] direct question/request: %s", text[:60])
                # STEP 1 per-turn context order, after the cached Layer A prefix and the
                # one-shot briefs. First PRUNE last turn's transient blocks + bound history,
                # then inject this turn's fresh blocks so the persona stays close to the live
                # question with NO duplicate system blocks:
                #   (once) startup brief → speaker work-graph
                #   [Layer C re-anchor, only on the trigger turn]
                #   [Background] (grounding) → Layer B "[Speaking now]" (LAST, nearest the
                #   user message). Layer B + grounding are per RESPONDING turn; brief/work-
                #   graph once; Layer C transient on triggers.
                if addressed:
                    self._prune_turn_context()                        # STEP 1: drop stale blocks + bound window
                    await self._ensure_meeting_context()              # M0: meeting id/title/project (once)
                    await self._ensure_identity_resolved()            # whoami → cache (once)
                    await self._inject_startup_brief(direction)       # A2.1 workspace brief (once)
                    await self._inject_work_graph(direction)          # A2.4 speaker work-graph (once)
                    await self._inject_reanchor(direction)            # Layer C (every N spoken turns)
                    await self._inject(text, direction)               # A2.2 graph-aware grounding ([Background])
                    await self._inject_addressed_directive(direction) # STEP 1: answer, don't go silent
                    await self._inject_speaker_modulation(direction)  # Layer B (per-turn) — closest to the user msg
        await self.push_frame(frame, direction)

    def _prune_turn_context(self) -> None:
        """STEP 1: at the START of an addressed turn, drop the PREVIOUS turn's transient
        system blocks (Layer B '[Speaking now]', Layer C re-anchor, '[Background]') and
        bound the conversation to the last N user turns — BEFORE this turn's fresh blocks
        are injected. Net effect: exactly one of each transient block survives, sitting
        next to the live question, and Layer A stays near the top instead of being buried.

        Operates directly on the shared LLMContext message list (get_messages/set_messages,
        verified against pipecat 1.2.1). Fully guarded: any API mismatch logs ONCE and
        no-ops, so this can never block the meeting (same degrade contract as the injects).
        Layer A + the one-shot briefs are preserved by prune_context (their markers aren't
        transient); tool_call/tool-result pairs are never split (cuts at user boundaries)."""
        # STEP 3: new addressed turn → reset the per-turn tool-call budget so the cap counts
        # only THIS turn's calls. STEP 1 (fan-out): also reset the per-tool-name counts.
        self._state.tool_calls_this_turn = 0
        self._state.tool_name_counts = {}
        ctx = self._context
        if ctx is None:
            return
        try:
            msgs = ctx.get_messages()
            pruned = prune_context(msgs, max_user_turns=CONTEXT_USER_TURNS)
            if len(pruned) != len(msgs):
                ctx.set_messages(pruned)
                logger.info("[ctx] pruned %d → %d messages (window=%d turns)",
                            len(msgs), len(pruned), CONTEXT_USER_TURNS)
        except Exception as e:  # noqa: BLE001 — never block the meeting on context hygiene
            if not self._prune_warned:
                self._prune_warned = True
                logger.warning("[ctx] prune skipped (LLMContext API mismatch?): %s", e)

    async def _inject_startup_brief(self, direction: FrameDirection) -> None:
        """A2.1 startup tier: give the bot a standing model of the workspace — its central
        topics (god-nodes) — so cold questions ("what is this about / what matters here")
        land in context with no tool call. Injected ONCE, early, off the turn path. Cached
        after the persona so the A3.3 stable prefix is preserved."""
        if self._startup_done:
            return
        self._startup_done = True
        # M5 / persona startup tier: the M3 room-safe meeting brief (where we left off) — already
        # ACL-scoped for THIS room server-side. Injected once so the bot reasons "what happened
        # last time" from context, no tool call. Best-effort; empty → skipped (degrade).
        bot_id = getattr(self._state, "bot_id", None)
        if bot_id:
            try:
                bres = await asyncio.wait_for(
                    self._mnema.call("get_meeting_brief", {"recall_bot_id": bot_id}), timeout=2.5)
                btext = ((bres or {}).get("content") or "").strip()
            except Exception as e:  # noqa: BLE001 — optional
                logger.debug("[startup] meeting brief skipped: %s", e)
                btext = ""
            if btext:
                logger.info("[startup] injected meeting brief (%d chars)", len(btext))
                await self.push_frame(
                    LLMMessagesAppendFrame(messages=[{"role": "system", "content": (
                        "[Last time, for continuity — already scoped to what everyone in this "
                        "room may see] " + btext[:1000]
                    )}], run_llm=False),
                    direction,
                )
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

    async def _ensure_meeting_context(self) -> None:
        """M0: fetch this meeting's identity ONCE (title / project / participants) via the
        get_meeting_context MCP tool, keyed by the live recall_bot_id, into BotState. The
        title supersedes the env/query stopgap for meeting_focus (Layer C); acl_scope bounds
        the Aspect-6 brief later. Degrades silently — any missing field stays None."""
        if self._state.meeting_ctx_done:
            return
        bot_id = self._state.bot_id
        if not bot_id:
            return  # bot_id not bound yet (no audio); retry on a later turn
        self._state.meeting_ctx_done = True
        try:
            res = await asyncio.wait_for(
                self._mnema.call("get_meeting_context", {"recall_bot_id": bot_id}), timeout=2.5) or {}
        except Exception as e:  # noqa: BLE001 — never block the meeting on it
            logger.warning("[meeting] get_meeting_context failed: %s", e)
            return
        if res.get("error"):
            return
        title = (res.get("title") or "").strip()
        if title:
            self._state.meeting_focus = title   # real title supersedes the startup env stopgap
        self._state.meeting_id = res.get("meetingId")
        self._state.project_id = res.get("projectId")
        self._state.acl_scope = res.get("aclScope")
        self._state.attendees = [p.get("name") for p in (res.get("participants") or [])
                                 if isinstance(p, dict) and p.get("name")]
        logger.info("[meeting] context: id=%s project=%s title=%s attendees=%d",
                    self._state.meeting_id, self._state.project_id, title or "-",
                    len(self._state.attendees))

    async def _ensure_identity_resolved(self) -> None:
        """Resolve the current speaker's identity ONCE via the server `whoami` tool (the bot
        acts as the resolved speaker) and cache the structured fields for Layer B. Resolution
        is UNCHANGED from before — whoami + Recall attribution; only the rendering moved to
        Layer B (build_speaker_modulation_block). The whoami tool still covers later 'who am
        I' asks directly."""
        if self._spk_resolved:
            return
        self._spk_resolved = True
        res: dict = {}
        try:
            res = await asyncio.wait_for(self._mnema.call("whoami", {}), timeout=2.5) or {}
        except Exception as e:  # noqa: BLE001 — never block on identity
            logger.warning("[identity] whoami failed: %s", e)
        asker = current_asker(self._state)
        # Prefer whoami's structured fields; fall back to parsing its sentence; name falls
        # back to Recall attribution. Anything unresolved stays None (Layer B degrades).
        self._spk = parse_whoami_identity(res, fallback_name=asker.get("name"))
        logger.info("[identity] speaker=%s role=%s team=%s access=%s",
                    self._spk.get("name"), self._spk.get("role"),
                    self._spk.get("team"), self._spk.get("access_level"))

    async def _inject_addressed_directive(self, direction: FrameDirection) -> None:
        """STEP 1: this turn was addressed to Mnema, so she MUST answer — never stay silent.
        A transient per-turn system line (pruned next turn) telling the model to answer in her
        own voice and, when she lacks the info, to say so plainly rather than emit the silence
        token. The deterministic SilentGate fallback still guarantees no silence if the model
        ignores this; the line just makes the right thing the model's first instinct. Persona
        character text is untouched — this is a pipeline instruction, not Layer A/B/C."""
        await self.push_frame(
            LLMMessagesAppendFrame(messages=[{"role": "system", "content": (
                "[You're being spoken to directly right now — answer in your own voice. If you "
                "don't have the information, say so plainly, like 'I don't have that' or 'I "
                "can't see that from here'. Never reply with only the silence token when you're "
                "addressed.]"
            )}], run_llm=False),
            direction,
        )

    async def _inject_speaker_modulation(self, direction: FrameDirection) -> None:
        """Layer B — the per-turn speaker-modulation block, appended FRESH each responding
        turn (never merged into the cached Layer A prefix). Verbatim text is built by
        build_speaker_modulation_block, which drops the '[Speaking now]' line when the
        speaker is unidentified and never emits 'unknown'."""
        block = build_speaker_modulation_block(
            self._spk.get("name"), self._spk.get("role"),
            self._spk.get("team"), self._spk.get("access_level"),
        )
        await self.push_frame(
            LLMMessagesAppendFrame(messages=[{"role": "system", "content": block}], run_llm=False),
            direction,
        )

    def _participant_names(self):
        """Cheap, in-memory list of current human participants (no tool call) → a natural
        spoken join, or None if unknown. Excludes the bot."""
        names, seen = [], set()
        for pid, p in (self._state.participants or {}).items():
            if pid == self._state.bot_participant_id:
                continue
            n = (p.get("name") or "").strip()
            if n and n.lower() not in seen:
                seen.add(n.lower())
                names.append(n)
        if not names:
            return None
        if len(names) == 1:
            return names[0]
        if len(names) == 2:
            return f"{names[0]} and {names[1]}"
        return ", ".join(names[:-1]) + f" and {names[-1]}"

    def _recent_topic(self):
        """Cheap recent-topic from the in-memory transcript (NO model call): the most recent
        substantive human utterance BEFORE this turn, trimmed to a short phrase. None if none.
        The current turn's utterance is already the last meeting_log entry, so we exclude it —
        'the thread just now' means the prior exchange, not the question being asked now."""
        log = self._state.meeting_log or []
        _tail_stop = {"to", "and", "the", "of", "a", "an", "for", "with", "in", "on",
                      "at", "is", "was", "that", "but", "or", "so", "we", "i"}
        for entry in reversed(log[:-1]):
            words = (entry.get("text") or "").split()
            if len(words) >= 4:  # skip backchannels / one-word turns
                phrase = [w.rstrip(".,!?") for w in words[:10]]
                while len(phrase) > 3 and phrase[-1].lower() in _tail_stop:
                    phrase.pop()  # don't end on a dangling preposition/conjunction
                return " ".join(phrase)
        return None

    async def _inject_reanchor(self, direction: FrameDirection) -> None:
        """Layer C — drift re-anchor. Fires on the first responding turn after every
        REANCHOR_EVERY_TURNS of Mnema's OWN spoken turns. Transient per-turn injection
        (appended after Layer B, before the brief), never cached. Placeholders are filled
        only from sources already cheaply in the loop — NO new LLM/network/blocking work;
        anything unavailable is passed as None and the builder drops that clause."""
        spoken = getattr(self._state, "spoken_turns", 0)
        due = spoken // REANCHOR_EVERY_TURNS
        if spoken == 0 or due <= self._reanchors_done:
            return
        self._reanchors_done = due
        # Cheap, already-in-memory sources only — no LLM/network/blocking work:
        #   participants  = the live roster, meeting_focus = the title captured at startup,
        #   recent_topic  = a trimmed recent human utterance from meeting_log.
        # Any absent source stays None and the builder drops that clause.
        block = build_reanchor_block(
            participants=self._participant_names(),
            meeting_focus=getattr(self._state, "meeting_focus", None),
            recent_topic=self._recent_topic(),
        )
        logger.info("[reanchor] drift re-anchor at %d spoken turns", spoken)
        await self.push_frame(
            LLMMessagesAppendFrame(messages=[{"role": "system", "content": block}], run_llm=False),
            direction,
        )

    async def _inject_work_graph(self, direction: FrameDirection) -> None:
        """A2.4 speaker tier: pull what this person is connected to in the graph (their tasks /
        meetings / team) so 'what's on my plate / what did I commit to' answer with no
        turn-time traversal. Best-effort, injected ONCE, separate from Layer B."""
        if self._work_injected:
            return
        self._work_injected = True
        speaker = (self._spk.get("name") or "").strip()
        if not speaker:
            return
        try:
            gres = await asyncio.wait_for(
                self._mnema.call("traverse_graph", {"from": speaker, "depth": 1}), timeout=2.0)
            gtxt = ((gres or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001 — optional
            logger.debug("[identity] speaker graph skipped: %s", e)
            return
        if not gtxt:
            return
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[{"role": "system", "content": (
                    "[What this person is connected to — their tasks, meetings, team. Answer "
                    "'what's on my plate / what did I commit to' from this]\n" + gtxt[:600])}],
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
        has_current_decision = False
        for h in hits[:3]:   # seed: top doc hits, project-labelled
            proj = h.get("project_name") or "Unfiled"
            head = h.get("title") or ""
            if h.get("heading_path"):
                head = f"{head} › {h['heading_path']}"
            # MD2: hand the agent the temporal order for a decision (it's weak at chronology and
            # must be told, not asked to infer). search_docs already floated `current` above
            # `historical`; this labels each so the agent states the current one and names the
            # superseded one as past — never the stale one as the answer.
            status = h.get("decision_status")
            if status:
                day = (h.get("decided_at") or "")[:10]
                if status == "current":
                    head = f"[DECISION — CURRENT{f' as of {day}' if day else ''}; this is the standing decision] {head}"
                    has_current_decision = True
                else:
                    head = f"[DECISION — HISTORICAL{f', decided {day}' if day else ''}; SUPERSEDED, do not state as current] {head}"
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

        # Strip markdown from the BODY so Mnema never reads markup aloud (persona §3/§5).
        # The "[Background …]" label/framing is kept exactly as is; retrieval/selection/order
        # are unchanged — this is a FORMAT-only pass at the single pre-injection point.
        body = to_spoken_plaintext("\n\n---\n\n".join(blocks))
        # MD2 carve-out: a CURRENT decision IS the standing truth, so the "may be out of date"
        # caveat must not undercut it. Appended ONLY when one is present — non-decision background
        # stays byte-identical to before.
        decision_note = (
            " A DECISION labelled CURRENT is the standing decision — trust it over older docs and state it as settled."
            if has_current_decision else ""
        )
        content = (
            "[Background — stored docs + their graph relations, each labelled with its project. "
            "Docs may be OUT OF DATE; for current tasks/status/assignments call the live tools "
            "(list_project_tasks / list_recent_docs)." + decision_note + " Use naturally; don't say you looked it up]"
            "\n\n" + body
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


class RecapProcessor(FrameProcessor):
    """Config-gated boundary recap — the ONLY unprompted speech. Default OFF (both flags) →
    pure passthrough, byte-identical to today. When enabled it speaks ONE calm intro after
    the meeting is active (recap_on_start) and/or ONE short closing on the end signal
    (recap_on_end), built from already-available context — NO LLM/summary call. Spoken via
    the normal TTS path (TTSSpeakFrame → tts → web_out), plain text (to_spoken_plaintext via
    the recap builders), so barge-in/output all apply. Placed between SilentGate and tts so
    it sees the VAD/end signals flowing down and its speech reaches tts directly."""

    def __init__(self, mnema: MnemaMCP, state) -> None:
        super().__init__()
        self._mnema = mnema
        self._state = state
        self._on_start = recap_on_start()
        self._on_end = recap_on_end()
        self._started_fired = False
        self._ended_fired = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        # END recap: speak the closing once, just before propagating the end signal.
        if (self._on_end and not self._ended_fired
                and isinstance(frame, (EndFrame, CancelFrame))):
            self._ended_fired = True
            text = build_end_recap(getattr(self._state, "captured_items", []))
            if text:
                logger.info("[recap] end recap (%d items)",
                            len(getattr(self._state, "captured_items", []) or []))
                await self.push_frame(TTSSpeakFrame(text), FrameDirection.DOWNSTREAM)
            await self.push_frame(frame, direction)
            return
        # START recap: once, after the first human finishes speaking (meeting is active and
        # we won't talk over anyone). Reuses the existing VAD UserStoppedSpeakingFrame — no
        # new detector.
        if (self._on_start and not self._started_fired
                and isinstance(frame, UserStoppedSpeakingFrame)
                and self._has_human_participants()):
            self._started_fired = True
            await self._speak_start_recap()
        await self.push_frame(frame, direction)

    def _has_human_participants(self) -> bool:
        return any(pid != self._state.bot_participant_id
                   for pid in (self._state.participants or {}))

    async def _speak_start_recap(self) -> None:
        # M5: prefer the M3 room-safe meeting brief (where we left off — ACL-scoped server-side,
        # already plain spoken text). Fall back to the A2.1 god-nodes workspace brief. Empty →
        # say nothing (never fabricate). NO LLM call (both are graph/record queries).
        text = ""
        bot_id = getattr(self._state, "bot_id", None)
        if bot_id:
            try:
                bres = await asyncio.wait_for(
                    self._mnema.call("get_meeting_brief", {"recall_bot_id": bot_id}), timeout=2.5)
                brief = ((bres or {}).get("content") or "").strip()
                if brief:
                    text = to_spoken_plaintext(brief)[:600]
            except Exception as e:  # noqa: BLE001 — recap must never break the meeting
                logger.debug("[recap] meeting brief skipped: %s", e)
        if not text:
            try:
                res = await asyncio.wait_for(self._mnema.call("get_god_nodes", {"limit": 6}), timeout=2.0)
                gbrief = ((res or {}).get("content") or "").strip()
            except Exception as e:  # noqa: BLE001
                logger.debug("[recap] start brief fetch skipped: %s", e)
                return
            text = build_start_recap(gbrief)
        if text:
            logger.info("[recap] start recap")
            await self.push_frame(TTSSpeakFrame(text), FrameDirection.DOWNSTREAM)


async def build_and_run_meeting_pipeline(websocket: WebSocket, system_prompt: str) -> None:
    """One meeting = one pipeline run. Audio in from Recall, replies out via Output Audio."""
    state = BotState()
    # Layer C meeting_focus: capture the meeting title/subject ONCE at startup from whatever
    # the join already provides (a WS query param, else an optional env). No fetch, no
    # per-turn cost — read from stored state. None when absent → the re-anchor drops the clause.
    state.meeting_focus = (
        (websocket.query_params.get("subject") or websocket.query_params.get("title")
         or os.environ.get("MNEMA_MEETING_TITLE") or "").strip() or None
    )
    if state.meeting_focus:
        logger.info("[meeting] focus captured at start: %s", state.meeting_focus)
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
    # The LLM is OpenAI-compatible. Model id comes from llm_config.resolve_model
    # (MNEMA_LLM_MODEL → MEETING_LLM_MODEL → OPENAI_LLM_MODEL → gpt-4.1). GPT-4.1 is the
    # locked default: reliable function-calling, 1M context, NO reasoning pause (a reasoning
    # step would add latency that breaks voice). Key/base url reuse the existing OpenAI env
    # wiring; the tool/function schema is sent UNCHANGED. base_url is only passed when set, so
    # the default OpenAI path is unchanged.
    _llm_kwargs = dict(
        api_key=resolve_api_key(os.environ),
        model=resolve_model(os.environ),
    )
    _llm_base_url = resolve_base_url(os.environ)
    if _llm_base_url:
        _llm_kwargs["base_url"] = _llm_base_url
    llm = OpenAILLMService(**_llm_kwargs)
    logger.info("[llm] model=%s base=%s", _llm_kwargs["model"], _llm_base_url or "openai-default")
    # Per-asker Mnema MCP sessions (meeting identity): MnemaMCP reads the active
    # speaker from BotState and answers each call scoped to that participant.
    mnema = MnemaMCP(state)
    register_mnema_tools(llm, mnema)
    register_local_tools(llm, state)   # #6: who_is_in_meeting / recall_what_was_said

    # ── TTS — Inworld (native pipecat InworldTTSService, websocket), streaming raw PCM ──
    # A3.4: first-sentence streaming is preserved — Inworld's realtime WS streams audio as
    # LLM text arrives (SilentGate pushes LLMTextFrames token-by-token, and the addressed/
    # forced path streams the first tokens immediately), so playback begins before generation
    # completes. encoding="PCM" → raw PCM16 (NO mp3, NO WAV header) at OUTPUT_SAMPLE_RATE, so
    # frames feed straight into web_out / the Output Media page with no decode step. Secrets
    # via env only (INWORLD_API_KEY = the Basic-auth value). Same TTSService interface, so
    # RecapProcessor / web_out / VAP are unchanged.
    tts = InworldTTSService(
        api_key=os.environ["INWORLD_API_KEY"],
        voice_id=os.environ["INWORLD_VOICE_ID"],
        model=os.environ.get("INWORLD_TTS_MODEL", "inworld-tts-1.5-max"),
        sample_rate=OUTPUT_SAMPLE_RATE,  # match the Output page rate exactly (PCM16 @ this rate)
        encoding="PCM",                  # raw PCM16 — no mp3 decode, no WAV header to strip
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
            vad_analyzer=SileroVADAnalyzer(
                sample_rate=RECALL_INPUT_SAMPLE_RATE,
                # Stiffen the VAD so background noise / brief blips don't register as speech and
                # falsely interrupt the bot mid-reply (audit: "no audio received while speaking,
                # forcing speech stop"). Tunable via env. Stricter than pipecat defaults
                # (conf 0.7 / start 0.2 / stop 0.2 / min_vol 0.6).
                params=VADParams(
                    confidence=float(os.environ.get("MEETING_VAD_CONFIDENCE", "0.8")),
                    start_secs=float(os.environ.get("MEETING_VAD_START_SECS", "0.3")),
                    stop_secs=float(os.environ.get("MEETING_VAD_STOP_SECS", "0.4")),
                    min_volume=float(os.environ.get("MEETING_VAD_MIN_VOLUME", "0.7")),
                ),
            ),
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
        RAGContext(mnema, state, context),  # track addressing + inject KG context when addressed (STEP 1: prunes context)
        aggregators.user(),     # VAD here → barge-in detection
        llm,
        SilentGate(state),      # speak only when the turn addressed the bot
        RecapProcessor(mnema, state),  # config-gated start/end recap (default OFF → passthrough)
        SpokenOutputNormalizer(),  # STEP 4: strip any model-emitted markdown right before TTS
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
