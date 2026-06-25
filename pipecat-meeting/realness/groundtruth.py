"""
groundtruth.py — STEP 1: record the ACTUAL workspace facts every answer is scored against,
queried through the SAME MCP tools the bot uses (so "ground truth" is the real data, not
the harness's assumptions). LIVE (needs mcp + secrets). Saved as ground_truth.json.

Captures: recent docs (titles+dates), the latest doc's real content (the log showed one that
only held "Hey, nama. How are you?" — we record whatever is really there), the live roster,
the task board, a few facts that DO exist (for grounded recall), and the honesty probes that
should DEMONSTRABLY return nothing (Q6–Q10) — we run their searches and record the (empty/
irrelevant) results as proof of absence.
"""
import asyncio
import logging

logger = logging.getLogger("realness.groundtruth")

# Searches expected to FIND something (grounded recall anchors).
_PRESENT_PROBES = [
    "voice agent modernization", "TTS provider Inworld", "meeting bot", "knowledge graph",
]
# Honesty probes — expected to find NOTHING real (Q6–Q10 map to these).
_ABSENT_PROBES = {
    "Q6_jason_standup": "Jason standup commitment yesterday",
    "Q7_budget_number": "final agreed budget number amount",
    "Q8_tuesday_client_call": "client call Tuesday what client said",
    "Q9_sprint_close_count": "action items closed last sprint count",
    "Q10_pricing_tier": "pricing tier decision",
}


async def _call(mcp, name, args, timeout=6.0):
    try:
        return await asyncio.wait_for(mcp.call(name, args or {}), timeout=timeout) or {}
    except Exception as e:  # noqa: BLE001
        logger.warning("[gt] %s failed: %s", name, e)
        return {"error": str(e)}


async def build_ground_truth(mcp, state) -> dict:
    from local_tools import format_roster  # pure
    gt = {"recent_docs": [], "latest_doc": None, "post_meeting_notes": None,
          "board_tasks": [], "projects": [], "roster": None, "meeting_transcript": [],
          "present_facts": {}, "absent_probes": {}}

    # Live per-project task state (names + status counts incl. in-progress) — captured at run
    # start so the judge grades 'what's in progress' answers against the REAL board, not a
    # stale empty snapshot. Now that list_projects is RLS-consistent with list_project_tasks,
    # these counts reflect exactly what the bot can fetch.
    proj_res = await _call(mcp, "list_projects", {})
    for p in (proj_res.get("projects") or []):
        if isinstance(p, dict):
            tc = p.get("taskCounts") or {}
            gt["projects"].append({
                "name": p.get("name"), "slug": p.get("slug"), "id": p.get("id"),
                "task_counts": tc, "in_progress": tc.get("in_progress", 0),
            })

    # The live meeting transcript (what who-spoke / recall_what_was_said reads). Captured into
    # ground truth so reporting a line from it (e.g. 'Alex Kim said …') is correctly judged as
    # GROUNDED in the live call, not as fabrication against the docs.
    gt["meeting_transcript"] = list(getattr(state, "meeting_log", []) or [])

    # recent docs (titles + dates + ids)
    docs_res = await _call(mcp, "list_recent_docs", {"limit": 8})
    docs = docs_res.get("results") or docs_res.get("docs") or []
    for d in docs[:8]:
        if isinstance(d, dict):
            gt["recent_docs"].append({k: d.get(k) for k in
                                      ("id", "title", "updated_at", "created_at", "project_name", "author")
                                      if k in d})

    # latest doc's ACTUAL content
    if gt["recent_docs"]:
        top = gt["recent_docs"][0]
        if top.get("id"):
            doc = await _call(mcp, "get_doc", {"id": top["id"]})
            content = doc.get("content") or doc.get("markdown") or ""
            gt["latest_doc"] = {"title": top.get("title"), "id": top.get("id"),
                                "content_excerpt": content[:1200],
                                "content_len": len(content)}
        # the most recent post-meeting note specifically
        for d in gt["recent_docs"]:
            title = (d.get("title") or "").lower()
            if "post-meeting" in title or "meeting note" in title or "post meeting" in title:
                doc = await _call(mcp, "get_doc", {"id": d["id"]}) if d.get("id") else {}
                content = doc.get("content") or doc.get("markdown") or ""
                gt["post_meeting_notes"] = {"title": d.get("title"), "id": d.get("id"),
                                            "content_excerpt": content[:1200],
                                            "content_len": len(content)}
                break

    # live board
    tasks_res = await _call(mcp, "list_project_tasks", {"limit": 20})
    tasks = tasks_res.get("results") or tasks_res.get("tasks") or []
    for t in tasks[:20]:
        if isinstance(t, dict):
            gt["board_tasks"].append({k: t.get(k) for k in ("title", "status", "assignee", "priority") if k in t})

    # roster (from the seeded live state — what who_is_in_meeting will answer)
    gt["roster"] = format_roster(state.participants, getattr(state, "roster_ever", {}),
                                 state.bot_participant_id)

    # present facts
    for probe in _PRESENT_PROBES:
        r = await _call(mcp, "search_docs", {"query": probe, "mode": "hybrid", "limit": 3})
        hits = r.get("results") or []
        gt["present_facts"][probe] = [
            {"title": h.get("title"), "snippet": (h.get("snippet") or "")[:200],
             "project_name": h.get("project_name")}
            for h in hits[:3] if isinstance(h, dict)]

    # absent probes (Q6–Q10): record whatever search returns to PROVE absence
    for key, probe in _ABSENT_PROBES.items():
        r = await _call(mcp, "search_docs", {"query": probe, "mode": "hybrid", "limit": 3})
        hits = r.get("results") or []
        gt["absent_probes"][key] = {
            "probe": probe,
            "hits": [{"title": h.get("title"), "snippet": (h.get("snippet") or "")[:160]}
                     for h in hits[:3] if isinstance(h, dict)],
        }
    return gt
