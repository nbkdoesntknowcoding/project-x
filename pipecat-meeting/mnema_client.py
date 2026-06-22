"""
mnema_client.py — Mnema tool layer for the meeting bot, over the MCP endpoint.

WHY MCP (not REST): the Mnema REST API (/api/*) is JWT-only and rejects API keys;
several routes the old client called don't even exist. Static API keys
(`mnema_api_…`) only authenticate against the **MCP endpoint** (POST /mcp), which
exposes the real tools: search_docs, get_doc, get_doc_section, create_task, the
graph tools, and propose/confirm doc writes. (See apps/api/src/mcp/*.)

This module:
  - holds ONE persistent MCP session per meeting (low latency for per-turn search),
  - exposes thin async tool fns mapped to the real MCP tools,
  - registers them as Pipecat function handlers (unchanged registration pattern).

Auth: Authorization: Bearer ${MNEMA_API_KEY} (must start with mnema_api_; scopes
tasks+write; workspace must be dev_project for create_task — ours is).
"""
import os
import json
import asyncio
import logging
from collections import OrderedDict
from contextlib import AsyncExitStack

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from recall_io import BotState, current_asker

logger = logging.getLogger("pipecat-meeting.mnema")

# Cap on simultaneously-cached per-asker MCP sessions (LRU-evicted). One small
# meeting rarely exceeds a handful of distinct speakers.
_MAX_SESSIONS = 8

MNEMA_API_URL = os.environ.get("MNEMA_API_URL", "").rstrip("/")
MNEMA_API_KEY = os.environ.get("MNEMA_API_KEY", "")
# Optional default project so tasks/docs land on the right board without the LLM
# needing to know the UUID.
MNEMA_PROJECT_ID = os.environ.get("MNEMA_PROJECT_ID") or None


class MnemaMCP:
    """Per-asker MCP client sessions for the lifetime of one meeting.

    Meeting identity (Phase 2): the bot's API key is act-as enabled, so the server
    answers each request as whoever the X-Mnema-Act-As-* header names. Since the
    Streamable-HTTP transport binds headers at session creation, we keep ONE session
    PER asker identity (email / name / guest) and pick the right one per call based
    on the current active speaker (read from BotState). Sessions are reused across a
    speaker's turns (low latency) and LRU-evicted past _MAX_SESSIONS.

    Without a BotState (non-meeting use) every call goes over the plain "guest"
    session — i.e. just the Authorization header, no act-as.
    """

    def __init__(self, state: BotState | None = None) -> None:
        self._state = state
        # identity key -> (stack, session). OrderedDict = LRU.
        self._sessions: "OrderedDict[str, tuple[AsyncExitStack, ClientSession]]" = OrderedDict()
        self._lock = asyncio.Lock()

    def _identity(self) -> tuple[str, dict]:
        """(cache key, extra act-as headers) for the current asker.
        email first (calendar-matched), then name (saved alias), else guest."""
        if self._state is not None:
            asker = current_asker(self._state)
            email = (asker.get("email") or "").strip()
            name = (asker.get("name") or "").strip()
            headers: dict = {}
            key_parts = []
            if email:
                headers["X-Mnema-Act-As-Email"] = email
                key_parts.append(f"e:{email.lower()}")
            if name:
                headers["X-Mnema-Act-As-Name"] = name
                key_parts.append(f"n:{name.lower()}")
            # ALWAYS assert host as the final fallback. The server resolves in order
            # email → saved-name alias → host (= this bot's organizer / key creator) →
            # guest. So a recognised speaker still scopes to THEM, but an unidentified
            # speaker (no participant events / no alias) resolves to the organizer instead
            # of being guest-denied with zero knowledge. It's the organizer's own bot key,
            # so the organizer's access is its rightful default.
            headers["X-Mnema-Act-As-Host"] = "true"
            key_parts.append("host")
            # Phase 4: name the meeting so the server can validate the asserted identity
            # against Recall's tamper-proof roster for THIS meeting.
            if self._state.bot_id:
                headers["X-Mnema-Meeting-Id"] = self._state.bot_id
                key_parts.append(f"m:{self._state.bot_id}")
            if headers:
                return "|".join(key_parts), headers
        return "guest", {}

    async def _ensure(self, key: str, extra_headers: dict) -> ClientSession:
        existing = self._sessions.get(key)
        if existing is not None:
            self._sessions.move_to_end(key)
            return existing[1]
        async with self._lock:
            existing = self._sessions.get(key)
            if existing is not None:
                self._sessions.move_to_end(key)
                return existing[1]
            if not MNEMA_API_URL or not MNEMA_API_KEY:
                raise RuntimeError("MNEMA_API_URL / MNEMA_API_KEY not set")
            stack = AsyncExitStack()
            url = f"{MNEMA_API_URL}/mcp"
            headers = {"Authorization": f"Bearer {MNEMA_API_KEY}", **extra_headers}
            read, write, _ = await stack.enter_async_context(
                streamablehttp_client(url, headers=headers)
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._sessions[key] = (stack, session)
            self._sessions.move_to_end(key)
            logger.info("[mnema] MCP session initialized for %s", key)
            await self._evict_if_needed()
            return session

    async def _evict_if_needed(self) -> None:
        while len(self._sessions) > _MAX_SESSIONS:
            old_key, (stack, _sess) = self._sessions.popitem(last=False)
            try:
                await stack.aclose()
            except Exception:  # noqa: BLE001
                pass
            logger.info("[mnema] evicted MCP session for %s", old_key)

    async def _drop(self, key: str) -> None:
        entry = self._sessions.pop(key, None)
        if entry is not None:
            try:
                await entry[0].aclose()
            except Exception:  # noqa: BLE001
                pass

    async def call(self, name: str, args: dict | None = None) -> dict:
        """Call an MCP tool as the current asker. Reconnects that session once on error."""
        key, extra = self._identity()
        try:
            session = await self._ensure(key, extra)
            res = await session.call_tool(name, args or {})
        except Exception as e:  # noqa: BLE001 — reconnect once, then surface
            logger.warning("[mnema] %s failed for %s (%s); reconnecting", name, key, e)
            await self._drop(key)
            session = await self._ensure(key, extra)
            res = await session.call_tool(name, args or {})
        return _parse_result(res)

    async def aclose(self) -> None:
        for _key, (stack, _sess) in self._sessions.items():
            try:
                await stack.aclose()
            except Exception:  # noqa: BLE001
                pass
        self._sessions.clear()


def _parse_result(res) -> dict:
    """Extract a JSON dict from an MCP CallToolResult (structuredContent or text)."""
    sc = getattr(res, "structuredContent", None)
    if isinstance(sc, dict) and sc:
        return sc
    texts: list[str] = []
    for c in getattr(res, "content", None) or []:
        t = getattr(c, "text", None)
        if t:
            try:
                return json.loads(t)
            except Exception:  # noqa: BLE001
                texts.append(t)
    if getattr(res, "isError", False):
        return {"success": False, "error": "\n".join(texts) or "tool error"}
    return {"content": "\n".join(texts)} if texts else {}


# ── Tool implementations (mapped to the real MCP tools) ──────────────────────
async def create_task(mcp: MnemaMCP, args: dict) -> dict:
    payload: dict = {"title": args["title"]}
    if args.get("description"):
        payload["description"] = args["description"]
    if args.get("priority"):
        payload["priority"] = args["priority"]
    pid = args.get("project_id") or MNEMA_PROJECT_ID
    if pid:
        payload["project_id"] = pid
    return await mcp.call("create_task", payload)


async def create_doc(mcp: MnemaMCP, args: dict) -> dict:
    """No direct create_doc tool — propose a 'create' write, then confirm it."""
    prop = await mcp.call("propose_doc_write", {
        "operation": "create",
        "title": args["title"],
        "markdown": args["content"],
        **({"folder_id": args["folder_id"]} if args.get("folder_id") else {}),
    })
    token = prop.get("proposal_token") or (prop.get("structuredContent") or {}).get("proposal_token")
    if not token:
        return {"success": False, "error": "no proposal_token returned", "detail": prop}
    return await mcp.call("confirm_doc_write", {"proposal_token": token})


async def search_knowledge(mcp: MnemaMCP, args: dict) -> dict:
    payload: dict = {
        "query": args["query"],
        "mode": args.get("mode", "hybrid"),
        "limit": int(args.get("limit", 5)),
    }
    # Scope only when the LLM names a project (resolved via list_projects); otherwise
    # search across everything the bot can access — each result is labelled with its
    # project, so the LLM can answer about the right one without mixing them.
    if args.get("project_id"):
        payload["project_id"] = args["project_id"]
    return await mcp.call("search_docs", payload)


async def list_projects(mcp: MnemaMCP, args: dict) -> dict:
    """List the projects the bot can see — use to resolve a project name → id before
    scoping a search/list to it."""
    return await mcp.call("list_projects", {})


async def list_recent_docs(mcp: MnemaMCP, args: dict) -> dict:
    """Newest-first docs — for 'latest / recent docs' questions. Pass project_id to scope."""
    payload: dict = {"limit": int(args.get("limit", 10))}
    if args.get("project_id"):
        payload["project_id"] = args["project_id"]
    return await mcp.call("list_docs", payload)


async def list_project_tasks(mcp: MnemaMCP, args: dict) -> dict:
    """The live task board — for 'what's in progress / moved / latest build' questions.
    Pass project (id or slug) to scope to one project."""
    payload: dict = {"limit": int(args.get("limit", 20))}
    if args.get("status"):
        payload["status"] = args["status"]
    if args.get("project"):
        payload["project"] = args["project"]
    return await mcp.call("list_project_tasks", payload)


async def get_doc(mcp: MnemaMCP, args: dict) -> dict:
    a: dict = {}
    if args.get("id"):
        a["id"] = args["id"]
    elif args.get("path"):
        a["path"] = args["path"]
    return await mcp.call("get_doc", a)


async def get_doc_section(mcp: MnemaMCP, args: dict) -> dict:
    return await mcp.call("get_doc_section", {"id": args["id"], "heading": args["heading"]})


async def get_project(mcp: MnemaMCP, args: dict) -> dict:
    return await mcp.call("get_project", {k: v for k, v in args.items() if v})


async def traverse_graph(mcp: MnemaMCP, args: dict) -> dict:
    return await mcp.call("traverse_graph", {k: v for k, v in args.items() if v not in (None, "")})


async def get_god_nodes(mcp: MnemaMCP, args: dict) -> dict:
    return await mcp.call("get_god_nodes", {k: v for k, v in (args or {}).items() if v})


async def get_graph_report(mcp: MnemaMCP, args: dict) -> dict:
    return await mcp.call("get_graph_report", {})


_TOOLS = {
    "create_task": create_task,
    "create_doc": create_doc,
    "search_knowledge": search_knowledge,
    "list_projects": list_projects,
    "list_recent_docs": list_recent_docs,
    "list_project_tasks": list_project_tasks,
    "get_doc": get_doc,
    "get_doc_section": get_doc_section,
    "get_project": get_project,
    "traverse_graph": traverse_graph,
    "get_god_nodes": get_god_nodes,
    "get_graph_report": get_graph_report,
}


def register_mnema_tools(llm, mcp: MnemaMCP) -> None:
    """Register every Mnema tool as a function handler on the LLM service."""
    for name, fn in _TOOLS.items():
        llm.register_function(name, _make_handler(name, fn, mcp))


_MAX_ITEMS = 12        # max list rows kept in a tool result
_MAX_FIELD = 200       # max chars per string field (descriptions etc.)


def _trim_for_context(result):
    """Shrink big tool results before they enter the meeting LLM context. Dumping 20 full
    task objects (with long descriptions) made the model context balloon every turn and the
    bot lag badly. Keep structure + the key fields; drop redundant structuredContent."""
    if not isinstance(result, dict):
        return result
    out = {}
    has_summary = isinstance(result.get("content"), str)
    for k, v in result.items():
        # The voice bot only needs the human-readable "content" summary, not the full
        # structured objects alongside it.
        if k == "structuredContent" and has_summary:
            continue
        if isinstance(v, list):
            rows = []
            for item in v[:_MAX_ITEMS]:
                if isinstance(item, dict):
                    rows.append({
                        ik: (iv[:_MAX_FIELD] + "…" if isinstance(iv, str) and len(iv) > _MAX_FIELD else iv)
                        for ik, iv in item.items()
                    })
                else:
                    rows.append(item)
            out[k] = rows
            if len(v) > _MAX_ITEMS:
                out[k + "_note"] = f"showing first {_MAX_ITEMS} of {len(v)}"
        elif isinstance(v, str) and len(v) > 1500:
            out[k] = v[:1500] + "…"
        else:
            out[k] = v
    return out


def _make_handler(name, fn, mcp: MnemaMCP):
    async def handler(params):  # params: FunctionCallParams
        args = dict(params.arguments or {})
        try:
            result = await fn(mcp, args)
        except Exception as e:  # noqa: BLE001
            logger.exception("[mnema-tool] %s failed: %s", name, e)
            result = {"success": False, "error": str(e)}
        await params.result_callback(_trim_for_context(result))
    return handler
