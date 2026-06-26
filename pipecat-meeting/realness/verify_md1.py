"""
verify_md1.py — Decision Memory MD1 live acceptance gate. Drives the record_decision MCP tool
through the bot's MnemaMCP client and asserts the gate from the tool's own returns:

  • a recorded decision is a CURRENT, dated, first-class node (status=current) + retrievable doc;
  • idempotent on (project, text) — re-record returns the SAME node id, no duplicate;
  • retrievable by search_docs immediately;
  • supersede keeps both + links (new current, old id returned as superseded);
  • edge cases reject cleanly with nothing created: missing target, self-supersede, cycle.

Run inside the pipecat-meeting container with the bot key flipped non-act-as (write needs owner;
an act-as key guest-denies — same as verify_filter). The DB-state checks (old → historical, the
supersedes edge) are printed as psql queries to confirm the writes landed.

  python -m realness.verify_md1
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mnema_client import MnemaMCP  # noqa: E402

MNEMA_PROJECT = os.environ.get("MD1_PROJECT_ID", "4c3306f3-6074-42c6-aa1f-daf554bddc0c")  # "Mnema"
ALPHA = "[MD1-TEST] alpha decision — temporary verification record"
BETA = "[MD1-TEST] beta decision — supersedes alpha, temporary verification record"
NONEXISTENT = "00000000-0000-0000-0000-000000000000"


async def call(mcp, args):
    return await mcp.call("record_decision", args) or {}


def sc(r):
    """The tool's structuredContent (the MCP result nests it under 'structuredContent')."""
    return (r.get("structuredContent") if isinstance(r, dict) else None) or (r if isinstance(r, dict) else {})


def err(r):
    """True-ish error from either the MCP layer (success:false/error) or the tool (structuredContent.error)."""
    return (r.get("error") if isinstance(r, dict) else None) or sc(r).get("error")


async def main() -> int:
    if not os.environ.get("MNEMA_API_URL") or not os.environ.get("MNEMA_API_KEY"):
        print("FATAL: MNEMA_API_URL / MNEMA_API_KEY not set.", file=sys.stderr)
        return 2
    mcp = MnemaMCP(None)  # bare key = owner when act_as_user=false
    fails = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    try:
        a = await call(mcp, {"decision_text": ALPHA, "project_id": MNEMA_PROJECT})
        print("record alpha ->", sc(a))
        a_id = sc(a).get("decision_node_id")
        check("alpha is a current dated node + doc", sc(a).get("status") == "current" and bool(a_id) and bool(sc(a).get("doc_id")))

        a2 = await call(mcp, {"decision_text": ALPHA, "project_id": MNEMA_PROJECT})
        check("idempotent re-record (no duplicate node)", sc(a2).get("decision_node_id") == a_id and bool(a_id),
              f"{sc(a2).get('decision_node_id')} == {a_id}")

        s = await mcp.call("search_docs", {"query": "MD1-TEST alpha decision", "mode": "hybrid", "limit": 5}) or {}
        hits = s.get("results") or []
        found = any("MD1-TEST" in ((h.get("title") or "") + (h.get("snippet") or "")) for h in hits)
        check("retrievable by search_docs immediately", found, f"{len(hits)} hits")

        b = await call(mcp, {"decision_text": BETA, "project_id": MNEMA_PROJECT, "supersedes": a_id})
        print("record beta (supersedes alpha) ->", sc(b))
        b_id = sc(b).get("decision_node_id")
        check("supersede: beta current + names alpha as superseded",
              sc(b).get("status") == "current" and sc(b).get("superseded_old_id") == a_id)

        e1 = await call(mcp, {"decision_text": "[MD1-TEST] gamma", "project_id": MNEMA_PROJECT, "supersedes": NONEXISTENT})
        check("edge: supersede non-existent rejected (nothing orphaned)", bool(err(e1)), str(err(e1))[:90])

        e2 = await call(mcp, {"decision_text": ALPHA, "project_id": MNEMA_PROJECT, "supersedes": a_id})
        check("edge: self-supersede rejected", bool(err(e2)), str(err(e2))[:90])

        e3 = await call(mcp, {"decision_text": ALPHA, "project_id": MNEMA_PROJECT, "supersedes": b_id})
        check("edge: cycle (alpha→beta→alpha) rejected", bool(err(e3)), str(err(e3))[:90])

        print("\nMD1 GATE:", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
        if a_id and b_id:
            print("\nConfirm the DB writes landed (psql, read-only):")
            print(f"  SELECT id, status, supersedes, superseded_by FROM graph_nodes WHERE id IN ('{a_id}','{b_id}');")
            print(f"    -> expect: {a_id} status=historical superseded_by={b_id}")
            print(f"    ->         {b_id} status=current   supersedes={a_id}")
            print(f"  SELECT edge_type FROM graph_edges WHERE from_node_id='{b_id}' AND to_node_id='{a_id}';  -> expect: supersedes")
            print("\n(Test docs are titled 'Decision — [MD1-TEST] …' in the Decisions folder; delete via UI to clean up.)")
        return 0 if not fails else 1
    finally:
        try:
            await mcp.aclose()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
