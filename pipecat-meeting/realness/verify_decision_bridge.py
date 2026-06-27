"""
verify_decision_bridge.py — Phase-2 acceptance for the decision→doc umbrella bridge.

Records a throwaway decision through record_decision TWICE (idempotency) and asserts from the
tool returns that it's the same node+doc. The graph assertions (the bridge edge, no similarity
edge on the decision node, the 2-hop umbrella) are printed as read-only psql to run on the VPS —
the bridge edge is written synchronously by recordDecision, so STEP 1/3 hold immediately; STEP 2
(2-hop) holds once the decision doc has been embedded + the similarity pass has run.

Run in the container with the bot key flipped non-act-as (write needs owner).

  python -m realness.verify_decision_bridge
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mnema_client import MnemaMCP  # noqa: E402

PROJECT = os.environ.get("MD2_PROJECT_ID", "4c3306f3-6074-42c6-aa1f-daf554bddc0c")  # "Mnema"
TEXT = "[BRIDGE-TEST] umbrella bridge verification decision — temporary, safe to delete"


def sc(r):
    return (r.get("structuredContent") if isinstance(r, dict) else None) or (r if isinstance(r, dict) else {})


async def main() -> int:
    if not os.environ.get("MNEMA_API_URL") or not os.environ.get("MNEMA_API_KEY"):
        print("FATAL: MNEMA_API_URL / MNEMA_API_KEY not set.", file=sys.stderr)
        return 2
    mcp = MnemaMCP(None)
    fails = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    try:
        a = sc(await mcp.call("record_decision", {"decision_text": TEXT, "project_id": PROJECT}) or {})
        print("record #1 ->", a)
        node_id, doc_id = a.get("decision_node_id"), a.get("doc_id")
        check("recorded a decision node + doc", bool(node_id) and bool(doc_id))

        b = sc(await mcp.call("record_decision", {"decision_text": TEXT, "project_id": PROJECT}) or {})
        print("record #2 (idempotent) ->", b)
        check("re-record returns the SAME node + doc (idempotent)",
              b.get("decision_node_id") == node_id and b.get("doc_id") == doc_id)

        print("\nDECISION-BRIDGE GATE (tool layer):", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
        if node_id and doc_id:
            print("\nConfirm the bridge in the DB (read-only psql):")
            print("  STEP 1 — exactly one documented_by edge, decision → its doc node:")
            print(f"    SELECT e.edge_type, tn.entity_type AS to_type, count(*) FROM graph_edges e "
                  f"JOIN graph_nodes tn ON tn.id=e.to_node_id "
                  f"WHERE e.from_node_id='{node_id}' GROUP BY e.edge_type, tn.entity_type;")
            print(f"    -> expect: documented_by | doc | 1   (and to_node = the doc node for {doc_id})")
            print(f"    SELECT id FROM graph_nodes WHERE entity_type='doc' AND entity_id='{doc_id}';  -> the bridged doc node")
            print("  STEP 3 — the decision node has NO similarity edge (we bridged, not embedded):")
            print(f"    SELECT count(*) FROM graph_edges WHERE from_node_id='{node_id}' AND edge_type='semantically_similar_to';  -> expect 0")
            print("  STEP 2 — 2-hop umbrella reachable (after the decision doc is embedded + the similarity pass runs):")
            print(f"    WITH d AS (SELECT to_node_id AS doc FROM graph_edges WHERE from_node_id='{node_id}' AND edge_type='documented_by') "
                  f"SELECT e.edge_type, count(*) FROM graph_edges e, d "
                  f"WHERE e.from_node_id=d.doc OR e.to_node_id=d.doc GROUP BY e.edge_type;")
            print("    -> expect the doc node to carry semantically_similar_to / extraction edges = the umbrella, now 2 hops from the decision")
            print("\n(Throwaway: delete the 'Decision — [BRIDGE-TEST] …' doc in the Decisions folder to clean up.)")
        return 0 if not fails else 1
    finally:
        try:
            await mcp.aclose()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
