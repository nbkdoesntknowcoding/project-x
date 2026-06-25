"""
turn.py — faithful mirror of the live bot's addressed-turn response path (LIVE: needs the
openai + mcp packages and the infra/.env secrets; runs in the pipecat-meeting container /
the VPS, NOT locally).

It does NOT make a fresh bare LLM call. It reuses the agent's OWN modules and reproduces
RAGContext's addressed-turn sequence line-for-line:

  RAGContext.process_frame (addressed)          →  run_turn() here
    _prune_turn_context()                        →  prune_context() + reset tool counter
    _ensure_meeting_context()  (M0, best-effort) →  _meeting_context()
    _ensure_identity_resolved() (whoami)         →  _resolve_identity()
    _inject_startup_brief()    (once)            →  _startup_brief()
    _inject_work_graph()       (once)            →  _work_graph()
    _inject_reanchor()         (Layer C)         →  _reanchor()  (fires by spoken_turns)
    _inject(text)              ([Background])    →  _background()  (mirrors _LIVE_DATA_RE skip)
    _inject_speaker_modulation() (Layer B)       →  _speaker_block()  (LAST, nearest user msg)
  llm  (OpenAILLMService tool loop)              →  _run_llm() (openai SDK, same model+tools)
  SilentGate (forced strip / un-addressed drop)  →  resolve_leading_silent / addressing gate
  SpokenOutputNormalizer (markdown strip)        →  SpokenStripper

Tool EXECUTION is the agent's real code: we register the real handlers
(register_mnema_tools / register_local_tools) onto a capture-LLM and invoke them, so the
dedup + per-turn cap + _trim_for_context + normalize_tool_result + annotate_failure all run
exactly as live. Tool calls are recorded for the TOOL_DISCIPLINE rubric.

If RAGContext changes, keep this mirror in sync (there is no shared entrypoint by design —
the live bot stays untouched: measurement only).
"""
import os
import re
import json
import asyncio
import logging

from openai import AsyncOpenAI

from meeting_persona import (
    build_meeting_persona, build_speaker_modulation_block, build_reanchor_block, SILENT_TOKEN,
)
from context_prune import prune_context
from text_norm import to_spoken_plaintext
from markdown_stream import SpokenStripper
from silence import resolve_leading_silent
from addressing import is_addressed
from mnema_client import MnemaMCP, register_mnema_tools, parse_whoami_identity
from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS
from local_tools import LOCAL_TOOL_DEFINITIONS, register_local_tools
from recall_io import current_asker

logger = logging.getLogger("realness.turn")

# Mirrors pipeline._LIVE_DATA_RE — questions whose answer is the live board/state, where the
# bot skips doc-RAG grounding and uses the live tools instead.
_LIVE_DATA_RE = re.compile(
    r"\b(task|tasks|in[- ]?progress|pending|backlog|to[- ]?do|status|latest|recent|sprint|"
    r"assigned|what'?s new|what is new|board|who('?s| is) (working|assigned)|deadline|due)\b",
    re.I,
)
_STRICT = os.environ.get("MEETING_REQUIRE_ADDRESS", "1") != "0"
_REANCHOR_EVERY = int(os.environ.get("MEETING_REANCHOR_EVERY", "13"))
_CONTEXT_USER_TURNS = int(os.environ.get("MEETING_CONTEXT_USER_TURNS", "10"))
_MAX_TOOL_ITERS = 8  # bound the function-calling loop (OpenAILLMService loops until no calls)

_TOOLS_OPENAI = [
    {"type": "function", "function": t["function"]}
    for t in (MNEMA_TOOL_DEFINITIONS + LOCAL_TOOL_DEFINITIONS)
]


# ── capture-LLM so we invoke the agent's REAL tool handlers ───────────────────
class _CaptureLLM:
    def __init__(self):
        self.handlers = {}

    def register_function(self, name, handler):
        self.handlers[name] = handler


class _Params:
    """Stand-in for pipecat FunctionCallParams: handlers read .arguments and call
    .result_callback(result)."""
    def __init__(self, arguments):
        self.arguments = arguments
        self.result = None

    async def result_callback(self, result):
        self.result = result


def _model_kwargs():
    api_key = os.environ.get("MEETING_LLM_API_KEY") or os.environ["OPENAI_API_KEY"]
    model = os.environ.get("MEETING_LLM_MODEL", os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini"))
    base_url = os.environ.get("MEETING_LLM_BASE_URL")
    kw = {"api_key": api_key}
    if base_url:
        kw["base_url"] = base_url
    return model, kw


class TurnRunner:
    """Holds one meeting 'session' (BotState + MnemaMCP + registered real handlers) so a
    sequence of questions can share a growing context, exactly like the live pipeline."""

    def __init__(self, state):
        self.state = state
        self.mnema = MnemaMCP(state)
        self.capture = _CaptureLLM()
        register_mnema_tools(self.capture, self.mnema)
        register_local_tools(self.capture, state)
        model, kw = _model_kwargs()
        self.model = model
        self.client = AsyncOpenAI(**kw)
        # per-session "once" flags (mirror RAGContext instance flags)
        self._spk = {}
        self._spk_done = False
        self._meeting_done = False
        self._startup_done = False
        self._work_done = False
        self._reanchors_done = 0
        self.persona = build_meeting_persona(
            workspace_name=os.environ.get("MNEMA_WORKSPACE", "The Boring People"))
        # the running conversation (system persona is message 0, like LLMContext)
        self.messages = [{"role": "system", "content": self.persona}]

    # ── addressing gate (mirrors RAGContext + _classify_addressed) ───────────
    async def _addressed(self, text, expect):
        if expect.get("addressed") is False and not is_addressed(text):
            # side-chatter test: only a wake word would override
            return False
        if is_addressed(text):
            return True
        if not (_STRICT and os.environ.get("MEETING_SEMANTIC_ADDRESSING", "1") != "0"):
            return True  # non-strict → always respond
        # semantic classifier — same prompt as pipeline._CLASSIFY_SYS
        try:
            res = await asyncio.wait_for(self.client.chat.completions.create(
                model=os.environ.get("MEETING_CLASSIFIER_MODEL", "gpt-4o-mini"),
                max_tokens=1, temperature=0,
                messages=[
                    {"role": "system", "content": (
                        "You are the attention gate for a voice assistant named Mnema that sits "
                        "silently in a live meeting between humans. Given the latest thing someone "
                        "said, decide if it is directed AT Mnema — a question, request, or command "
                        "for the assistant, or a direct follow-up to what Mnema just said — versus "
                        "the people in the room talking to EACH OTHER. Most meeting talk is between "
                        "the humans and is NOT for Mnema. When unsure, answer NO. Reply with exactly "
                        "one word: YES or NO.")},
                    {"role": "user", "content": f'Latest utterance: "{text}"\nDirected at Mnema?'},
                ]), timeout=4.0)
            return (res.choices[0].message.content or "").strip().lower().startswith("y")
        except Exception as e:  # noqa: BLE001
            logger.warning("[addr] classify failed (NO): %s", e)
            return False

    # ── context injections (mirror RAGContext helpers) ───────────────────────
    async def _meeting_context(self):
        if self._meeting_done:
            return
        self._meeting_done = True
        bot_id = getattr(self.state, "bot_id", None)
        if not bot_id:
            return
        try:
            res = await asyncio.wait_for(
                self.mnema.call("get_meeting_context", {"recall_bot_id": bot_id}), timeout=2.5) or {}
            if not res.get("error"):
                title = (res.get("title") or "").strip()
                if title:
                    self.state.meeting_focus = title
        except Exception as e:  # noqa: BLE001
            logger.debug("[ctx] meeting_context skipped: %s", e)

    async def _resolve_identity(self, speaker_name):
        if self._spk_done:
            return
        self._spk_done = True
        res = {}
        try:
            res = await asyncio.wait_for(self.mnema.call("whoami", {}), timeout=2.5) or {}
        except Exception as e:  # noqa: BLE001
            logger.warning("[id] whoami failed: %s", e)
        self._spk = parse_whoami_identity(res, fallback_name=speaker_name)

    async def _startup_brief(self):
        if self._startup_done:
            return
        self._startup_done = True
        bot_id = getattr(self.state, "bot_id", None)
        if bot_id:
            try:
                bres = await asyncio.wait_for(
                    self.mnema.call("get_meeting_brief", {"recall_bot_id": bot_id}), timeout=2.5)
                btext = ((bres or {}).get("content") or "").strip()
                if btext:
                    self.messages.append({"role": "system", "content": (
                        "[Last time, for continuity — already scoped to what everyone in this "
                        "room may see] " + btext[:1000])})
            except Exception as e:  # noqa: BLE001
                logger.debug("[startup] brief skipped: %s", e)
        try:
            res = await asyncio.wait_for(self.mnema.call("get_god_nodes", {"limit": 8}), timeout=2.5)
            brief = ((res or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("[startup] god_nodes failed: %s", e)
            return
        if not brief:
            return
        surprising = ""
        try:
            sres = await asyncio.wait_for(
                self.mnema.call("get_surprising_connections", {"limit": 5}), timeout=2.0)
            stxt = ((sres or {}).get("content") or "").strip()
            if stxt:
                surprising = "\n\n[Cross-project connections worth surfacing when relevant]\n" + stxt[:600]
        except Exception as e:  # noqa: BLE001
            logger.debug("[startup] surprising skipped: %s", e)
        self.messages.append({"role": "system", "content": (
            "[Workspace — central topics & structure] The most connected things in this "
            "workspace's knowledge graph are below. Use them to ground answers about what "
            "the org/project is about, without calling a tool.\n\n" + brief[:1200] + surprising)})

    async def _work_graph(self):
        if self._work_done:
            return
        self._work_done = True
        speaker = (self._spk.get("name") or "").strip()
        if not speaker:
            return
        try:
            gres = await asyncio.wait_for(
                self.mnema.call("traverse_graph", {"from": speaker, "depth": 1}), timeout=2.0)
            gtxt = ((gres or {}).get("content") or "").strip()
        except Exception as e:  # noqa: BLE001
            logger.debug("[work] graph skipped: %s", e)
            return
        if gtxt:
            self.messages.append({"role": "system", "content": (
                "[What this person is connected to — their tasks, meetings, team. Answer "
                "'what's on my plate / what did I commit to' from this]\n" + gtxt[:600])})

    def _reanchor(self):
        spoken = getattr(self.state, "spoken_turns", 0)
        due = spoken // _REANCHOR_EVERY if _REANCHOR_EVERY else 0
        if spoken == 0 or due <= self._reanchors_done:
            return
        self._reanchors_done = due
        block = build_reanchor_block(
            participants=None,
            meeting_focus=getattr(self.state, "meeting_focus", None),
            recent_topic=None)
        self.messages.append({"role": "system", "content": block})

    async def _background(self, text):
        if _LIVE_DATA_RE.search(text):
            return
        try:
            res = await asyncio.wait_for(
                self.mnema.call("search_docs", {"query": text, "mode": "hybrid", "limit": 4}), timeout=2.5)
        except Exception as e:  # noqa: BLE001
            logger.warning("[bg] retrieval skipped: %s", e)
            return
        hits = (res or {}).get("results") or []
        if not hits:
            return
        blocks = []
        for h in hits[:3]:
            proj = h.get("project_name") or "Unfiled"
            head = h.get("title") or ""
            if h.get("heading_path"):
                head = f"{head} › {h['heading_path']}"
            blocks.append(f"[project: {proj} | {head}]\n{(h.get('snippet') or '').strip()}")
        top_label = (hits[0].get("title") or "").strip()
        if top_label:
            try:
                gres = await asyncio.wait_for(
                    self.mnema.call("traverse_graph", {"from": top_label, "depth": 1}), timeout=2.0)
                gtxt = ((gres or {}).get("content") or "").strip()
                if gtxt:
                    blocks.append("[Related in the knowledge graph — how this connects]\n" + gtxt[:600])
            except Exception as e:  # noqa: BLE001
                logger.debug("[bg] graph expand skipped: %s", e)
        body = to_spoken_plaintext("\n\n---\n\n".join(blocks))
        content = (
            "[Background — stored docs + their graph relations, each labelled with its project. "
            "Docs may be OUT OF DATE; for current tasks/status/assignments call the live tools "
            "(list_project_tasks / list_recent_docs). Use naturally; don't say you looked it up]"
            "\n\n" + body)[:2500]
        self.messages.append({"role": "system", "content": content})

    def _speaker_block(self):
        block = build_speaker_modulation_block(
            self._spk.get("name"), self._spk.get("role"),
            self._spk.get("team"), self._spk.get("access_level"))
        self.messages.append({"role": "system", "content": block})

    # ── tool execution via the agent's REAL handlers ─────────────────────────
    async def _exec_tool(self, name, args):
        handler = self.capture.handlers.get(name)
        if handler is None:
            return {"success": False, "error": f"Tool {name} not found"}
        p = _Params(args)
        await handler(p)
        return p.result

    # ── the LLM tool-calling loop (mirrors OpenAILLMService) ─────────────────
    async def _run_llm(self):
        tool_calls_made = []
        convo = list(self.messages)
        for _ in range(_MAX_TOOL_ITERS):
            resp = await self.client.chat.completions.create(
                model=self.model, temperature=0.6, messages=convo, tools=_TOOLS_OPENAI)
            msg = resp.choices[0].message
            if not msg.tool_calls:
                return (msg.content or ""), tool_calls_made, convo
            convo.append({"role": "assistant", "content": msg.content,
                          "tool_calls": [tc.model_dump() for tc in msg.tool_calls]})
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except Exception:  # noqa: BLE001
                    args = {}
                tool_calls_made.append({"name": tc.function.name, "args": args})
                result = await self._exec_tool(tc.function.name, args)
                convo.append({"role": "tool", "tool_call_id": tc.id,
                              "content": json.dumps(result, default=str)[:4000]})
        # ran out of iterations — ask for a final answer with no more tools
        resp = await self.client.chat.completions.create(
            model=self.model, temperature=0.6, messages=convo)
        return (resp.choices[0].message.content or ""), tool_calls_made, convo

    async def run_turn(self, text, speaker_name="Nischay B K", expect=None):
        """Run ONE addressed turn end-to-end. Returns a dict {text, tool_calls, addressed,
        context_len, raw_text}."""
        expect = expect or {}
        # 1) addressing gate
        addressed = await self._addressed(text, expect)
        if not addressed and _STRICT:
            # SilentGate drops the turn deterministically — she stays silent, no LLM call.
            return {"text": SILENT_TOKEN, "tool_calls": [], "addressed": False,
                    "context_len": len(self.messages), "raw_text": SILENT_TOKEN}

        # 2) prune + reset per-turn tool budget (mirror _prune_turn_context)
        self.state.tool_calls_this_turn = 0
        self.messages = prune_context(self.messages, max_user_turns=_CONTEXT_USER_TURNS)

        # 3) injections in the live order: once-briefs → reanchor → [Background] → [Speaking now]
        await self._meeting_context()
        await self._resolve_identity(speaker_name)
        await self._startup_brief()
        await self._work_graph()
        self._reanchor()
        await self._background(text)
        self._speaker_block()

        # 4) append the user turn + run the real LLM tool loop
        self.messages.append({"role": "user", "content": text})
        raw, tool_calls, _convo = await self._run_llm()

        # 5) SilentGate forced path: strip a stray <silent>, force speak (addressed turn)
        action, stripped = resolve_leading_silent(raw, forced=True)
        if action == "drop":
            spoken = ""
        else:
            spoken = stripped if stripped is not None else raw
            self.state.spoken_turns = getattr(self.state, "spoken_turns", 0) + 1

        # 6) SpokenOutputNormalizer: strip any model markdown right before TTS
        stripper = SpokenStripper()
        parts = stripper.feed(spoken)
        tail = stripper.flush()
        if tail:
            parts.append(tail)
        clean = "".join(parts).strip()

        # record the assistant turn into the running context (like aggregators.assistant())
        self.messages.append({"role": "assistant", "content": clean})
        return {"text": clean, "tool_calls": tool_calls, "addressed": True,
                "context_len": len(self.messages), "raw_text": raw}
