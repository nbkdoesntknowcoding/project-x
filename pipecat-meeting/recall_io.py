"""
recall_io.py — Recall.ai audio bridge for the Pipecat meeting pipeline.

INPUT (meeting → pipeline) — A1.1 separated streams:
  Recall pushes `audio_separate_raw.data` messages (JSON text) to our public WS — one
  packet PER participant, each carrying base64 PCM (mono 16-bit LE PCM @ 16 kHz) tagged
  with its producing participant. RecallSerializer decodes that to InputAudioRawFrame,
  (a) drops the bot's OWN stream outright (its TTS never re-enters STT — no echo gate),
  (b) drops empty/silent packets (Recall sends them for unmuted-but-silent participants),
  and (c) records EXACT per-packet attribution (the producer is named, not guessed from
  speech_on/off timing). It also captures the per-meeting correlation id from the payload
  (`bot.metadata.cid`, set at createBot; falls back to `bot.id`) so the output path knows
  which Output Media webpage to stream to.

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
import asyncio
import logging

import httpx

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
        # Meeting identity (Phase 2): roster + active speaker, fed by Recall
        # participant_events. participants: id -> {"name", "email", "is_host"}.
        # email is only present for calendar-matched attendees (may arrive late via
        # participant_events.update). last_speaker_id keeps the most recent speaker so
        # we can still attribute an utterance after speech_off has fired.
        self.participants: dict[str, dict] = {}
        self.active_speaker_id: str | None = None
        self.last_speaker_id: str | None = None
        # #6 live-meeting awareness. roster_ever keeps EVERYONE seen this call (never
        # removed on leave) so "was X in this meeting" works after they've gone.
        # meeting_log is a rolling speaker-attributed transcript of this call (fed by the
        # pipeline), so the bot can answer "who said X" from the live meeting, not the docs.
        self.roster_ever: dict[str, dict] = {}
        self.meeting_log: list[dict] = []
        # M0 meeting context: fetched once via the get_meeting_context MCP tool (keyed by
        # bot_id) into these fields. meeting_focus (the title) also feeds Layer C; acl_scope
        # bounds the Aspect-6 brief. All None/empty until fetched → downstream clauses drop.
        self.meeting_id: str | None = None
        self.project_id: str | None = None
        self.meeting_focus: str | None = None
        self.acl_scope: str | None = None
        self.attendees: list = []
        self.meeting_ctx_done: bool = False
        # The bot's OWN participant id (it joins as "Mnema"). Tracked so we never attribute
        # speech/identity to the bot itself ("who am I → you're Mnema").
        self.bot_participant_id: str | None = None
        # The model itself decides each turn whether to answer (it emits a silence sentinel
        # for human-to-human side-talk). A1.6: `force_next_response` is a PER-TURN override
        # (replaces the old 6s `force_until` time window that over-triggered) — set when the
        # turn is addressed (wake word OR semantic classifier), consumed by SilentGate for
        # exactly the next response, then cleared. Bridges STT splitting one utterance into
        # segments without a timer. `last_response_monotonic` is a soft hint for the
        # addressing classifier ("recently engaged" → a bare follow-up is probably still ours).
        self.force_next_response: bool = False
        self.last_response_monotonic: float = 0.0
        # A1.4: optional VAP predictive turn-taking service (set in pipeline.py; a no-op
        # stub unless MEETING_VAP=1 + vap_realtime installed). Fed the human stream + bot
        # TTS; exposes latest_result for the turn logic. None until wired.
        self.vap = None


def _extract_email(p: dict):
    """Pull an email from a Recall participant object, checking the common nests."""
    email = p.get("email")
    if email:
        return email
    extra = p.get("extra_data") or {}
    return extra.get("email") or None


def _is_silent(pcm: bytes, threshold: int = 250) -> bool:
    """Cheap peak-amplitude check over int16-LE samples (strided to stay fast).
    With separated streams Recall emits empty/near-silent packets for every
    unmuted-but-silent participant; dropping them keeps the single pipeline from
    being flooded with N participants' silence interleaved with the one speaker."""
    n = len(pcm)
    if n < 2:
        return True
    step = 2 * max(1, (n // 2) // 256)  # sample up to ~256 points
    peak = 0
    for i in range(0, n - 1, step):
        s = pcm[i] | (pcm[i + 1] << 8)
        if s >= 32768:
            s -= 65536
        a = -s if s < 0 else s
        if a > peak:
            peak = a
            if peak >= threshold:
                return False
    return peak < threshold


# ── Roster reporting (Phase 2b capture) ───────────────────────────────────────
# Report the meeting roster to Mnema so the organizer can map unrecognized
# attendees afterwards. Authenticated with the bot's own MCP key. Best-effort.
_MNEMA_API_URL = os.environ.get("MNEMA_API_URL", "").rstrip("/")
_MNEMA_API_KEY = os.environ.get("MNEMA_API_KEY", "")
_report_task: "asyncio.Task | None" = None


def schedule_roster_report(state: "BotState", ended: bool = False, delay: float = 3.0) -> None:
    """Debounced fire-and-forget roster report. Coalesces bursts of join/update
    events into one POST; `ended=True` reports immediately."""
    global _report_task
    if _report_task is not None and not _report_task.done():
        _report_task.cancel()
    try:
        _report_task = asyncio.create_task(_delayed_report(state, ended, delay))
    except RuntimeError:
        pass  # no running loop (shouldn't happen inside the pipeline)


async def _delayed_report(state: "BotState", ended: bool, delay: float) -> None:
    try:
        if not ended and delay > 0:
            await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    await report_roster(state, ended)


async def report_roster(state: "BotState", ended: bool = False) -> None:
    if not _MNEMA_API_URL or not _MNEMA_API_KEY or not state.bot_id:
        return
    payload = {
        "recall_bot_id": state.bot_id,
        "ended": ended,
        "participants": [
            {
                "recall_participant_id": pid,
                "name": p.get("name"),
                "email": p.get("email"),
                "is_host": bool(p.get("is_host")),
            }
            for pid, p in state.participants.items()
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{_MNEMA_API_URL}/api/_internal/meeting-participants",
                json=payload,
                headers={"Authorization": f"Bearer {_MNEMA_API_KEY}"},
            )
    except Exception as e:  # noqa: BLE001 — reporting must never break the meeting
        logger.warning("[recall] roster report failed: %s", e)


def current_asker(state: BotState) -> dict:
    """The participant currently (or most recently) speaking → {email, name, is_host}.
    Falls back to last_speaker_id because speech_off may fire before STT finalizes
    the utterance. Empty values when no speaker is known (→ backend guest-deny)."""
    pid = state.active_speaker_id or state.last_speaker_id
    if not pid:
        return {"email": None, "name": None, "is_host": False}
    p = state.participants.get(pid) or {}
    return {"email": p.get("email"), "name": p.get("name"), "is_host": bool(p.get("is_host"))}


class RecallSerializer(FrameSerializer):
    """Decode Recall `audio_separate_raw.data` JSON → InputAudioRawFrame (PCM16 16 kHz),
    one packet per participant. Drops the bot's own stream + silent packets and records
    exact per-packet attribution on BotState. Output goes via Output Media (the webpage),
    so serialize() emits nothing."""

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
        event = msg.get("event")
        d = msg.get("data", {}) or {}
        # Meeting identity (Phase 2): participant join/update build the roster;
        # speech_on/off track the active speaker. These produce no audio frame.
        if event and event.startswith("participant_events."):
            self._handle_participant_event(event, d)
            return None
        if event != "audio_separate_raw.data":
            return None
        # Bind the per-meeting correlation id (the output path needs it) from any audio payload.
        if self._state.cid is None:
            bot = d.get("bot") or {}
            meta = bot.get("metadata") or {}
            cid = meta.get("cid") or bot.get("id")
            if cid:
                self._state.cid = cid
                self._state.bot_id = bot.get("id")
                logger.info("[recall] bound to cid %s (bot %s)", cid, self._state.bot_id)

        # A1.1: each separated packet names its producing participant under data.participant.
        inner = d.get("data") or {}
        p = inner.get("participant") or {}
        pid = p.get("id")
        pid = str(pid) if pid is not None else None
        name = p.get("name")

        # Drop the bot's OWN stream — with separated audio the bot's TTS arrives as its own
        # participant stream, so it is structurally excluded from STT (no echo gate needed).
        is_self = (
            (pid is not None and pid == self._state.bot_participant_id)
            or bool(p.get("is_current_user"))
            or (name is not None and name.strip().lower() == "mnema")
        )
        if is_self:
            if pid is not None:
                self._state.bot_participant_id = pid
            return None

        buf = inner.get("buffer")
        if not buf:
            return None
        pcm = base64.b64decode(buf)
        # Drop silence so the single pipeline isn't flooded with every unmuted-but-silent
        # participant's packets interleaved with the active speaker's audio.
        if not pcm or _is_silent(pcm):
            return None

        # A1.1: EXACT attribution — the producer is known per packet, not guessed from
        # speech_on/off timing. Enrich the roster (email/host arrive via participant_events;
        # merge what the audio packet carries) and record the real speaker so current_asker()
        # resolves to whoever actually produced this audio.
        if pid is not None:
            existing = self._state.participants.get(pid, {})
            self._state.participants[pid] = {
                "name": name or existing.get("name"),
                "email": _extract_email(p) or existing.get("email"),
                "is_host": p.get("is_host") if p.get("is_host") is not None else existing.get("is_host"),
            }
            # A1.1 verification: log only on speaker change (not per packet) so the log
            # shows exact attribution — "audio from <name>" as the floor moves.
            if self._state.active_speaker_id != pid:
                logger.info("[recall] audio from participant %s (%s)", pid, name or "?")
            self._state.active_speaker_id = pid
            self._state.last_speaker_id = pid

        return InputAudioRawFrame(
            audio=pcm, sample_rate=RECALL_INPUT_SAMPLE_RATE, num_channels=1
        )

    def _handle_participant_event(self, event: str, d: dict) -> None:
        # Recall nests the real payload under data.data (same as audio's data.data.buffer).
        inner = d.get("data") or {}
        p = inner.get("participant") or {}
        pid = p.get("id")
        if pid is None:
            return
        pid = str(pid)
        st = self._state
        # Bind the Recall bot id early (also available on participant events) so the
        # roster reporter has it before audio starts flowing.
        if st.bot_id is None:
            bot = d.get("bot") or {}
            if bot.get("id"):
                st.bot_id = bot.get("id")
        if event in ("participant_events.join", "participant_events.update"):
            existing = st.participants.get(pid, {})
            name = p.get("name") or existing.get("name")
            # Identify the bot's OWN participant (Recall flags it, or it's named "Mnema")
            # and never track it as a speaker/asker.
            if p.get("is_current_user") or (name and name.strip().lower() == "mnema"):
                st.bot_participant_id = pid
                st.participants.pop(pid, None)
                return
            email = _extract_email(p) or existing.get("email")
            is_host = p.get("is_host")
            if is_host is None:
                is_host = existing.get("is_host")
            st.participants[pid] = {"name": name, "email": email, "is_host": is_host}
            st.roster_ever[pid] = {"name": name, "email": email, "is_host": is_host}  # #6
            logger.info(
                "[recall] participant %s name=%s email=%s host=%s",
                pid, name, "yes" if email else "no", is_host,
            )
            schedule_roster_report(st)
        elif event == "participant_events.speech_on":
            if pid == st.bot_participant_id:
                return  # the bot's own TTS — not a human asker
            st.active_speaker_id = pid
            st.last_speaker_id = pid
        elif event == "participant_events.speech_off":
            if st.active_speaker_id == pid:
                st.active_speaker_id = None
        elif event == "participant_events.leave":
            st.participants.pop(pid, None)
            if st.active_speaker_id == pid:
                st.active_speaker_id = None
            schedule_roster_report(st)


# A1.2: the half-duplex InputGate (echo guard) was removed. With A1.1 separated
# streams the bot's own audio is dropped at the serializer, so STT/VAD never see the
# bot's voice — no muting needed, and the user can now barge in mid-reply (true
# full-duplex). Barge-in is signalled by WebOutputProcessor forwarding `interrupt`.


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
        self._sent = 0
        self._warned = False

    def _ws(self):
        cid = self._state.cid
        return _OUTPUT_WS.get(cid) if cid else None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        ws = self._ws()
        try:
            if isinstance(frame, UserStartedSpeakingFrame):
                if ws is not None:
                    await ws.send_text(json.dumps({"type": "interrupt"}))
                    logger.info("[recall] sent interrupt to page (cid %s)", self._state.cid)
            elif isinstance(frame, TTSAudioRawFrame) and frame.audio:
                # A1.4: feed the bot's own TTS to VAP (channel 2) so it can predict
                # turn-shift / barge-in. No-op when VAP is disabled (stub).
                if self._state.vap is not None:
                    self._state.vap.push_bot_audio(frame.audio)
                if ws is None:
                    if not self._warned:
                        logger.warning(
                            "[recall] TTS audio produced but NO page WS connected (cid=%s)",
                            self._state.cid,
                        )
                        self._warned = True
                else:
                    await ws.send_bytes(frame.audio)
                    self._sent += 1
                    if self._sent == 1 or self._sent % 50 == 0:
                        logger.info(
                            "[recall] streamed %d audio chunks to page (cid %s)",
                            self._sent, self._state.cid,
                        )
        except Exception as e:  # noqa: BLE001 — a dead page WS must not kill the pipeline
            logger.warning("[recall] output send failed (cid %s): %s", self._state.cid, e)

        await self.push_frame(frame, direction)
