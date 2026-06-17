"""
mnema_client.py — Mnema API client + Pipecat function-call handlers.

Mirrors meeting-bot/src/tools/mnema-tools.ts (same endpoints/shape) but as async
handlers registered directly on the OpenAILLMService (Pipecat 1.2.1's
register_function), so the LLM's tool calls actually execute and create
tasks/docs in Mnema during the meeting.

Handler contract (verified against Pipecat 1.2.1 services/llm_service.py):
  register_function(name, handler) where
  `async def handler(params: FunctionCallParams)` and you deliver the result via
  `await params.result_callback(<json-able dict>)`. `params.arguments` is the dict.
"""
import os
import logging

import httpx

logger = logging.getLogger("pipecat-meeting.mnema")

MNEMA_API_BASE = os.environ.get("MNEMA_API_URL", "")  # e.g. https://api.theboringpeople.in
MNEMA_API_KEY = os.environ.get("MNEMA_API_KEY", "")

_headers = {
    "Authorization": f"Bearer {MNEMA_API_KEY}",
    "Content-Type": "application/json",
}


async def _post(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(f"{MNEMA_API_BASE}{path}", headers=_headers, json=body)
        r.raise_for_status()
        return r.json()


async def _get(path: str) -> dict:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{MNEMA_API_BASE}{path}", headers=_headers)
        r.raise_for_status()
        return r.json()


# ── Tool implementations (mirror mnema-tools.ts endpoints) ───────────────────
async def create_task(args: dict) -> dict:
    task = await _post("/api/tasks", {
        "title": args["title"],
        "description": args.get("description"),
        "project_id": args.get("project_id"),
    })
    return {"success": True, "task_id": task.get("id"),
            "message": f'Task created: "{args["title"]}"'}


async def create_doc(args: dict) -> dict:
    doc = await _post("/api/docs", {
        "title": args["title"],
        "content": args["content"],
        "folderId": args.get("project_id"),
    })
    return {"success": True, "doc_id": doc.get("id"),
            "message": f'Doc created: "{args["title"]}"'}


async def search_knowledge(args: dict) -> dict:
    from urllib.parse import quote
    res = await _get(f"/api/search?q={quote(args['query'])}")
    docs = (res or {}).get("docs", []) or []
    return {"results": [
        {"title": d.get("title"), "summary": d.get("summary") or (d.get("content") or "")[:200]}
        for d in docs[:3]
    ]}


async def get_project(args: dict) -> dict:
    from urllib.parse import quote
    res = await _get(f"/api/projects?name={quote(args['name'])}")
    if isinstance(res, list) and res:
        return res[0]
    return {"error": "Project not found"}


async def link_meeting_to_project(args: dict) -> dict:
    return await _post("/api/graph/meetings", {
        "project_id": args["project_id"],
        "meeting_title": args["meeting_title"],
        "call_id": args["call_id"],
    })


_TOOLS = {
    "create_task": create_task,
    "create_doc": create_doc,
    "search_knowledge": search_knowledge,
    "get_project": get_project,
    "link_meeting_to_project": link_meeting_to_project,
}


def register_mnema_tools(llm) -> None:
    """Register every Mnema tool as a function handler on the LLM service."""
    for name, fn in _TOOLS.items():
        llm.register_function(name, _make_handler(name, fn))


def _make_handler(name, fn):
    async def handler(params):  # params: FunctionCallParams
        args = dict(params.arguments or {})
        try:
            result = await fn(args)
        except Exception as e:  # noqa: BLE001
            logger.exception("[mnema-tool] %s failed: %s", name, e)
            result = {"success": False, "error": str(e)}
        await params.result_callback(result)
    return handler
