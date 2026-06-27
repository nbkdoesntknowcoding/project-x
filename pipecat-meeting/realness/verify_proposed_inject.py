"""
verify_proposed_inject.py — the Phase-3a STEP-4 gate at the inject layer: a 'proposed' (unverified,
human-gate) decision must NEVER be framed as the standing/current decision, in BOTH inject paths.

Exercises the REAL turn._background (harness mirror) via a fake MCP client, and cross-checks that
pipeline._inject (the live path) carries the IDENTICAL proposed label literal (the two paths are
hand-synced; drift here is the Q16 failure mode).

  python -m realness.verify_proposed_inject
"""
import os
import re
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # text_norm
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # turn

from unittest.mock import MagicMock  # noqa: E402
for _m in ("openai", "meeting_persona", "context_prune", "markdown_stream", "silence",
           "addressing", "llm_config", "mnema_client", "mcp", "mnema_tool_defs",
           "local_tools", "recall_io"):
    sys.modules.setdefault(_m, MagicMock())
from turn import TurnRunner  # noqa: E402

PIPELINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline.py")

CURRENT = {"title": "Decision — TTS provider is Inworld", "path": "decision-aaaa.md",
           "project_name": "Mnema", "decision_status": "current", "decided_at": "2026-06-26T00:00:00Z",
           "snippet": "TTS provider is Inworld, superseding ElevenLabs"}
PROPOSED = {"title": "Decision — switch CRM to Salesforce", "path": "decision-bbbb.md",
            "project_name": "Mnema", "decision_status": "proposed", "decided_at": "2026-06-27T00:00:00Z",
            "snippet": "switch CRM to Salesforce (captured from the standup)"}
REJECTED = {"title": "Decision — abandon the mobile rewrite REJECTEDMARKER", "path": "decision-cccc.md",
            "project_name": "Mnema", "decision_status": "rejected", "decided_at": "2026-06-27T00:00:00Z",
            "snippet": "abandon the mobile rewrite REJECTEDMARKER (discarded by reviewer)"}


class FakeMnema:
    def __init__(self, hits):
        self._hits = hits

    async def call(self, name, args, *a, **k):
        return {"results": self._hits} if name == "search_docs" else {"content": ""}


async def bg(hits, text="did we decide on that?"):
    r = TurnRunner.__new__(TurnRunner)
    r.mnema = FakeMnema(hits)
    r.messages = []
    await r._background(text)
    return next((m["content"] for m in r.messages if m["role"] == "system"), "")


async def main() -> int:
    fails = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    PROPOSED_LABEL = "[PROPOSED DECISION — NOT yet confirmed"
    CURRENT_LABEL = "[DECISION — CURRENT"

    print("STEP 4b — a PROPOSED-only result is never framed as settled:")
    only_prop = await bg([PROPOSED])
    check("proposed hit carries the [PROPOSED — NOT yet confirmed] label", PROPOSED_LABEL in only_prop)
    check("proposed hit is NOT given the [DECISION — CURRENT … standing decision] label", CURRENT_LABEL not in only_prop)
    check("no 'standing decision' disclaimer when only a proposed decision is present",
          "standing decision — trust it over older docs" not in only_prop)

    print("STEP 4a — CURRENT outranks/labels over PROPOSED on the same subject:")
    both = await bg([CURRENT, PROPOSED])
    ci = both.find(CURRENT_LABEL)
    pi = both.find(PROPOSED_LABEL)
    check("current hit gets the standing-decision label", ci != -1)
    check("proposed hit gets the proposed label", pi != -1)
    # search_docs (applyDecisionTemporal) floats current above proposed; the inject preserves order,
    # so the current label appears before the proposed one in the block.
    check("current is framed ahead of proposed in the injected block", ci != -1 and pi != -1 and ci < pi,
          f"current@{ci} < proposed@{pi}")

    print("STEP 4c — mirror in sync: pipeline._inject carries the IDENTICAL proposed label literal:")
    with open(PIPELINE, "r", encoding="utf-8") as f:
        pipe_src = f.read()
    check("pipeline.py contains the same [PROPOSED DECISION — NOT yet confirmed] literal",
          "PROPOSED DECISION — NOT yet confirmed" in pipe_src)
    check("pipeline.py only sets has_current_decision for 'current' (not proposed)",
          bool(re.search(r"status == \"current\":[\s\S]{0,200}has_current_decision = True", pipe_src))
          and "proposed" in pipe_src)

    print("STEP 5a — a REJECTED decision is fully skipped (never injected), mirror in sync:")
    rej = await bg([REJECTED])
    check("rejected decision is NOT injected at all (no label, no content)", "REJECTEDMARKER" not in rej)
    check("pipeline.py also skips rejected before labeling (mirror sync)",
          bool(re.search(r'status == "rejected":[\s\S]{0,80}continue', pipe_src)))

    print("\nPROPOSED-INJECT GATE:", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
