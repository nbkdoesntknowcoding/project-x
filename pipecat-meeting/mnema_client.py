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
from contextlib import AsyncExitStack

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger("pipecat-meeting.mnema")

MNEMA_API_URL = os.environ.get("MNEMA_API_URL", "").rstrip("/")
MNEMA_API_KEY = os.environ.get("MNEMA_API_KEY", "")
# Optional default project so tasks/docs land on the right board without the LLM
# needing to know the UUID.
MNEMA_PROJECT_ID = os.environ.get("MNEMA_PROJECT_ID") or None


class MnemaMCP:
    """A persistent MCP client session for the lifetime of one meeting.

    The server is stateless Streamable HTTP, so the SDK client handles the
    initialize handshake and each tools/call is an independent POST. We keep one
    ClientSession open to avoid re-handshaking on every per-turn search_docs call.
    """

    def __init__(self) -> None:
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None
        self._lock = asyncio.Lock()

    async def _ensure(self) -> ClientSession:
        if self._session is not None:
            return self._session
        async with self._lock:
            if self._session is not None:
                return self._session
            if not MNEMA_API_URL or not MNEMA_API_KEY:
                raise RuntimeError("MNEMA_API_URL / MNEMA_API_KEY not set")
            stack = AsyncExitStack()
            url = f"{MNEMA_API_URL}/mcp"
            headers = {"Authorization": f"Bearer {MNEMA_API_KEY}"}
            read, write, _ = await stack.enter_async_context(
                streamablehttp_client(url, headers=headers)
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            self._stack = stack
            self._session = session
            logger.info("[mnema] MCP session initialized at %s", url)
            return session

    async def call(self, name: str, args: dict | None = None) -> dict:
        """Call an MCP tool and return its parsed result dict. Reconnects once on error."""
        try:
            session = await self._ensure()
            res = await session.call_tool(name, args or {})
        except Exception as e:  # noqa: BLE001 — reconnect once, then surface
            logger.warning("[mnema] %s failed (%s); reconnecting", name, e)
            await self.aclose()
            session = await self._ensure()
            res = await session.call_tool(name, args or {})
        return _parse_result(res)

    async def aclose(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception:  # noqa: BLE001
                pass
        self._stack = None
        self._session = None


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


def _make_handler(name, fn, mcp: MnemaMCP):
    async def handler(params):  # params: FunctionCallParams
        args = dict(params.arguments or {})
        try:
            result = await fn(mcp, args)
        except Exception as e:  # noqa: BLE001
            logger.exception("[mnema-tool] %s failed: %s", name, e)
            result = {"success": False, "error": str(e)}
        await params.result_callback(result)
    return handler
