"""
local_tools.py — live-meeting-awareness tools (audit #6).

The Mnema MCP tools answer questions about docs/tasks/graph, but the bot had NO way to
answer about the call it's IN: "who's here?", "did anyone else join?", "who said X?". It
would wrongly fall back to searching docs. These two LOCAL tools read BotState (which
already tracks the live roster via Recall participant_events, plus a rolling utterance log
fed by the pipeline) so the bot answers from the actual meeting.

Pure helpers (format_roster / search_meeting_log) hold the logic and are unit-tested with
no pipecat deps; register_local_tools wires them onto the LLM service exactly like the
Mnema tools (llm.register_function + params.result_callback).
"""
import re
import logging

logger = logging.getLogger("pipecat-meeting.local_tools")


LOCAL_TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "who_is_in_meeting",
            "description": (
                "Who is in THIS live call right now (and who joined earlier but left). Use for "
                "'who's here', 'did anyone else join', 'is <name> in this meeting'. This is the "
                "live call roster — NOT the docs; never use search_knowledge for it."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall_what_was_said",
            "description": (
                "Look up what was actually said earlier in THIS live meeting, attributed to the "
                "speaker. Use for 'who said X', 'who brought up <topic>', 'what did we just say "
                "about <topic>'. Searches the live transcript of this call — NOT stored docs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Word or phrase to look for. Omit for the most recent turns.",
                    },
                },
            },
        },
    },
]


def format_roster(participants: dict, roster_ever: dict, bot_participant_id=None) -> str:
    """Readable answer for 'who is in the meeting'. participants = currently present;
    roster_ever = everyone seen this call (so we can report who left). The bot's own
    participant id is excluded."""
    def _name(p):
        return (p.get("name") or "someone").strip()

    here_pids = {pid for pid in (participants or {}) if pid != bot_participant_id}
    here = [_name(participants[pid]) for pid in here_pids]
    left = [
        _name(p)
        for pid, p in (roster_ever or {}).items()
        if pid != bot_participant_id and pid not in here_pids
    ]

    parts = []
    if here:
        parts.append("In the call right now: " + ", ".join(sorted(here)) + ".")
    else:
        parts.append("I don't see anyone else in the call right now.")
    if left:
        parts.append("Joined earlier but not here now: " + ", ".join(sorted(set(left))) + ".")
    return " ".join(parts)


def search_meeting_log(meeting_log, topic=None, limit: int = 8) -> str:
    """Answer 'who said X' from the rolling [{speaker, text}] log of THIS meeting.
    With a topic: return matching turns (full-phrase match, else significant-word match).
    Without: the most recent turns. Speaker-attributed."""
    log = meeting_log or []
    if not log:
        return "I haven't captured anything said in this meeting yet."

    def _fmt(entries):
        return "\n".join(f"{(e.get('speaker') or 'Someone')}: {e.get('text')}" for e in entries)

    if topic and topic.strip():
        t = topic.strip().lower()
        words = [w for w in re.findall(r"[a-z0-9]+", t) if len(w) > 2]
        hits = []
        for e in log:
            low = (e.get("text") or "").lower()
            if t in low or (words and any(w in low for w in words)):
                hits.append(e)
        if not hits:
            return f'I don\'t recall anyone bringing up "{topic}" in this meeting.'
        return _fmt(hits[-limit:])

    return _fmt(log[-limit:])


def register_local_tools(llm, state) -> None:
    """Register the live-meeting tools on the LLM service (mirrors register_mnema_tools)."""
    async def _who(params):
        try:
            res = format_roster(state.participants, getattr(state, "roster_ever", {}),
                                state.bot_participant_id)
        except Exception as e:  # noqa: BLE001 — never crash a turn on this
            logger.warning("[local-tool] who_is_in_meeting failed: %s", e)
            res = "I couldn't read the call roster just now."
        await params.result_callback(res)

    async def _recall(params):
        try:
            topic = dict(params.arguments or {}).get("topic")
        except Exception:  # noqa: BLE001
            topic = None
        try:
            res = search_meeting_log(getattr(state, "meeting_log", []), topic)
        except Exception as e:  # noqa: BLE001
            logger.warning("[local-tool] recall_what_was_said failed: %s", e)
            res = "I couldn't search this meeting's transcript just now."
        await params.result_callback(res)

    llm.register_function("who_is_in_meeting", _who)
    llm.register_function("recall_what_was_said", _recall)
