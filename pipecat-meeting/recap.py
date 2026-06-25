"""
recap.py — config-gated start/end meeting recap (the ONLY unprompted speech). Cheap: NO
LLM/summary calls. Default OFF → zero behavior change (pure addressed-only / silent mode).

STEP 1 — CONFIG FINDINGS (what actually reaches the bot today):
  - meeting-bot POST /join carries ONLY {meetingUrl}; it stores a meetings row, nothing else.
  - The Recall realtime endpoint (recall.ts) passes ONLY a correlation id `cid` (+ the Output
    page TTS rate). No recap/intro/outro/summary field on the realtime query string.
  - pipecat reads MEETING_*/MNEMA_* env vars + the WS query (cid); no workspace recap setting
    is read via the MCP client.
  => There is NO real per-meeting/per-workspace recap setting reaching the bot. So this is
     gated on env flags here, DEFAULT OFF.
  TODO: a real per-meeting/per-workspace recap toggle needs the SAME upstream plumbing as
        meeting_focus — pass it /join → Recall realtime-endpoint query string, or read
        workspace settings via the MCP client. Not built in this task.

Content sources (already available, no generation):
  - start  → the Aspect 2.1 startup brief (get_god_nodes graph query — a tool call, NOT an LLM
             generation). Empty brief → say nothing.
  - end    → action items already captured this session (tasks created via create_task,
             recorded on BotState.captured_items). Nothing captured → minimal / nothing.
All recap text is run through to_spoken_plaintext (persona §3/§5: plain spoken, no markdown).
"""
import os

from text_norm import to_spoken_plaintext

_OFF = ("0", "", "off", "false", "no")


def recap_on_start() -> bool:
    return os.environ.get("MNEMA_RECAP_START", "0").strip().lower() not in _OFF


def recap_on_end() -> bool:
    return os.environ.get("MNEMA_RECAP_END", "0").strip().lower() not in _OFF


def build_start_recap(brief: str) -> str:
    """One brief, calm spoken intro from the already-available startup brief. Plain text.
    Returns '' when the brief is empty — never fabricates an opener."""
    brief = (brief or "").strip()
    if not brief:
        return ""
    return to_spoken_plaintext("Before we get going, here's where things stand. " + brief)[:600]


def build_end_recap(items) -> str:
    """One short closing naming ONLY action items already captured this meeting (no LLM, no
    summary). Returns '' when nothing was captured — never fabricates a summary."""
    items = [str(i).strip() for i in (items or []) if str(i).strip()]
    if not items:
        return ""
    if len(items) == 1:
        body = "one follow-up — " + items[0]
    else:
        body = (f"{len(items)} follow-ups — " + ", ".join(items[:-1]) + ", and " + items[-1])
    return to_spoken_plaintext("Before we wrap, " + body + ".")[:600]
