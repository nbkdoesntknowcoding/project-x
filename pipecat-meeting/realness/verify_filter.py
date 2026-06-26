"""
verify_filter.py — STEP 2 re-verification: prove list_project_tasks(project, status=in_progress)
agrees with the in-progress count list_projects reports. LIVE (needs MNEMA_API_URL/KEY + the
deployed API). Run inside the pipecat-meeting container:

    python -m realness.verify_filter            # read-only check against current state
    python -m realness.verify_filter --seed     # if all projects empty, seed ONE in-progress
                                                # task, verify, then mark it done (cleanup)

Prints the hard assertion line and exits non-zero if the counts disagree or it could only be
tested vacuously (all empty) without --seed. Uses the SAME key the bot uses, so the RLS/
project-scope view matches list_project_tasks exactly.
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mnema_client import MnemaMCP  # noqa: E402


def _in_progress(p: dict) -> int:
    return int((p.get("taskCounts") or {}).get("in_progress", 0) or 0)


def _tasklist_count(res: dict) -> int:
    if not isinstance(res, dict):
        return 0
    if isinstance(res.get("total"), int):
        return res["total"]
    return len(res.get("tasks") or [])


async def main(seed: bool) -> int:
    if not os.environ.get("MNEMA_API_URL") or not os.environ.get("MNEMA_API_KEY"):
        print("FATAL: MNEMA_API_URL / MNEMA_API_KEY not set.", file=sys.stderr)
        return 2
    mcp = MnemaMCP(None)  # raw key (same project-scope the bot's list_project_tasks runs under)
    seeded_task = None
    try:
        projs = (await mcp.call("list_projects", {"status": "all"})).get("projects") or []
        target = next((p for p in projs if _in_progress(p) > 0), None)

        if target is None:
            if not seed:
                print("RESULT: ALL EMPTY — no project currently has in-progress tasks. The filter "
                      "could only be tested VACUOUSLY. Re-run with --seed to create a known "
                      "in-progress task and verify a NON-empty case. NOT VERIFIED.")
                return 3
            if not projs:
                print("RESULT: NO PROJECTS in this workspace — cannot seed. NOT VERIFIED.")
                return 3
            pid = projs[0]["id"]
            created = await mcp.call("create_task", {
                "title": "[realness-filter-check] temporary verification task", "project_id": pid})
            seeded_task = ((created.get("task") or {}).get("id")
                           or created.get("id")
                           or (created.get("structuredContent") or {}).get("task", {}).get("id"))
            if not seeded_task:
                print(f"RESULT: could not read created task id from {created}. NOT VERIFIED.")
                return 3
            await mcp.call("claim_task", {"taskId": seeded_task})  # backlog → in_progress
            projs = (await mcp.call("list_projects", {"status": "all"})).get("projects") or []
            target = next((p for p in projs if p.get("id") == pid), None)
            print(f"(seeded in-progress task {seeded_task} in project {projs and pid})")

        slug = target.get("slug") or target.get("id")
        summary_n = _in_progress(target)
        tl = await mcp.call("list_project_tasks", {"project": slug, "status": "in_progress"})
        tasklist_n = _tasklist_count(tl)
        match = summary_n == tasklist_n
        print(f"FILTER VERIFIED on project={slug}: summary={summary_n} tasklist={tasklist_n} MATCH={match}")

        # contract: a project-filtered search must NOT raise "Invalid uuid" on a slug
        s = await mcp.call("search_docs", {"query": "status", "project_id": slug, "limit": 1})
        no_uuid_err = "invalid uuid" not in str(s).lower()
        print(f"search_knowledge(project=slug) no-uuid-error: {no_uuid_err}")

        ok = match and no_uuid_err
        print("STEP2 " + ("VERIFIED" if ok else "FAILED — STOP"))
        return 0 if ok else 1
    finally:
        if seeded_task:
            try:
                await mcp.call("complete_task", {"taskId": seeded_task})  # cleanup → done
                print(f"(cleanup: seeded task {seeded_task} marked done)")
            except Exception as e:  # noqa: BLE001
                print(f"(cleanup note: could not complete seeded task {seeded_task}: {e})")
        await mcp.aclose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(seed="--seed" in sys.argv)))
