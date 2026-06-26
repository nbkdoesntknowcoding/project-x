"""
verify_md2.py — Decision Memory MD2 live acceptance + the end-to-end Q16 fix.

Asserts:
  • STEP 1 (temporal order): for the MD1-TEST decisions, the CURRENT one (beta) ranks ABOVE the
    HISTORICAL one (alpha) in search_docs, and both carry decision_status + decided_at.
  • Anti-deprecation: a NON-decision query returns hits with NO decision_status and in plain RRF
    order — the temporal pass is a no-op when there are no decisions (non-decision retrieval
    unchanged).
  • E2E (the whole point): record the REAL Inworld decision THROUGH the tool, then search_docs
    for the TTS provider returns the Inworld decision as CURRENT.

The full agent-answer ("did we settle the TTS provider?" → Inworld) is the realness harness Q16
re-run. Run with the bot key flipped non-act-as (write needs owner).

  python -m realness.verify_md2
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mnema_client import MnemaMCP  # noqa: E402

PROJECT = os.environ.get("MD2_PROJECT_ID", "4c3306f3-6074-42c6-aa1f-daf554bddc0c")  # "Mnema"
INWORLD = ("TTS provider for the voice agent is Inworld (Realtime TTS), superseding the earlier "
           "ElevenLabs plan, on cost, realtime quality, and emotion-steering grounds")


def sc(r):
    return (r.get("structuredContent") if isinstance(r, dict) else None) or (r if isinstance(r, dict) else {})


async def search(mcp, q, limit=8):
    r = await mcp.call("search_docs", {"query": q, "mode": "hybrid", "limit": limit}) or {}
    return r.get("results") or sc(r).get("results") or []


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
        print("STEP 1 — temporal order on the MD1-TEST decisions:")
        hits = await search(mcp, "MD1-TEST decision verification record")
        dec = [(i, h) for i, h in enumerate(hits) if (h.get("path") or "").startswith("decision-")]
        statuses = {h.get("decision_status") for _, h in dec}
        cur_idx = next((i for i, h in dec if h.get("decision_status") == "current"), None)
        hist_idx = next((i for i, h in dec if h.get("decision_status") == "historical"), None)
        for i, h in dec:
            print(f"    #{i} status={h.get('decision_status')} decided_at={h.get('decided_at')} {h.get('title')}")
        check("decision hits carry decision_status + decided_at", bool(dec) and None not in statuses and all(h.get("decided_at") for _, h in dec))
        check("CURRENT ranks above HISTORICAL", cur_idx is not None and hist_idx is not None and cur_idx < hist_idx, f"current#{cur_idx} < historical#{hist_idx}")

        print("Anti-deprecation — non-decision query is untouched (no decision_status, RRF order):")
        nd = await search(mcp, "voice agent modernization research")
        nd_decisionless = [h for h in nd if not (h.get("path") or "").startswith("decision-")]
        no_temporal = all(h.get("decision_status") in (None,) for h in nd_decisionless)
        ranks = [h.get("rank") for h in nd_decisionless if h.get("rank") is not None]
        # hybrid orders rrf_score DESC (higher rank = better), so the sequence is non-increasing.
        rrf_order = all(ranks[i] >= ranks[i + 1] for i in range(len(ranks) - 1)) if len(ranks) > 1 else True
        check("non-decision hits have NO decision_status (pass is a no-op)", no_temporal, f"{len(nd_decisionless)} non-decision hits")
        check("non-decision hits stay in RRF (rrf_score DESC) order", rrf_order)

        print("E2E — record the REAL Inworld decision through the tool, then retrieve it:")
        rec = await mcp.call("record_decision", {"decision_text": INWORLD, "project_id": PROJECT}) or {}
        print("    record_decision ->", sc(rec))
        check("Inworld decision recorded as a current node + doc", sc(rec).get("status") == "current" and bool(sc(rec).get("decision_node_id")))
        # Semantic recall needs the embedding job to land (Voyage call, async). Poll up to ~60s.
        inworld_hit = None
        for attempt in range(20):
            tts = await search(mcp, "did we settle the TTS provider for the voice agent")
            inworld_hit = next((h for h in tts if "inworld" in ((h.get("title") or "") + (h.get("snippet") or "")).lower()), None)
            if inworld_hit is not None:
                print(f"    found after {attempt * 3}s; top: {[(h.get('decision_status'), h.get('title')) for h in tts[:3]]}")
                break
            await asyncio.sleep(3)
        check("TTS query returns the Inworld decision as CURRENT (after embedding lands)",
              inworld_hit is not None and inworld_hit.get("decision_status") == "current")

        print("\nMD2 GATE:", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
        print("\nNext: re-run the realness harness — Q16 should now answer Inworld (from retrieval).")
        return 0 if not fails else 1
    finally:
        try:
            await mcp.aclose()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
