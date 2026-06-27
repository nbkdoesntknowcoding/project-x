"""
verify_md2_mirror.py — prove the harness inject mirror (turn.py._background) now carries the MD2
temporal label verbatim from pipeline._inject, with the disclaimer carved out for current
decisions, AND that non-decision background is byte-identical to before (no leak).

Invokes the REAL TurnRunner._background through a fake MnemaMCP (no network), capturing the
[Background] system message it injects.

  python -m realness.verify_md2_mirror
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # for text_norm
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # for `import turn`

# Stub the heavy deps turn.py pulls at import (openai / mcp SDK / pipecat helpers) so this runs
# anywhere — we exercise the REAL _background method but never its network/LLM imports. text_norm
# is kept REAL (the render calls to_spoken_plaintext, so it must be the genuine function).
from unittest.mock import MagicMock  # noqa: E402
for _m in ("openai", "meeting_persona", "context_prune", "markdown_stream", "silence",
           "addressing", "llm_config", "mnema_client", "mcp", "mnema_tool_defs",
           "local_tools", "recall_io"):
    sys.modules.setdefault(_m, MagicMock())
from turn import TurnRunner, _LIVE_DATA_RE, to_spoken_plaintext  # noqa: E402

Q16 = "How's the voice agent coming along, and did we settle the TTS provider?"
# A non-decision query that RENDERS (no _LIVE_DATA_RE skip words like board/status/latest) so the
# byte-identical no-op is proven on a real rendered block, not on an empty skip.
NONDEC = "remind me how the knowledge graph fits together"

DECISION_HITS = [
    {"title": "Decision — TTS provider for the voice agent is Inworld (Realtime TTS), superseding ElevenLabs",
     "path": "decision-0beaeedb.md", "project_name": "Mnema", "decision_status": "current",
     "decided_at": "2026-06-26T13:31:56.089Z",
     "snippet": "_Decided 2026-06-26 · status: current_  TTS provider for the voice agent is Inworld, superseding the earlier ElevenLabs plan"},
    {"title": "Voice Agent Modernization Research", "path": "t_vMzmvpKo.md", "project_name": None,
     "snippet": "Aspect-by-aspect research to make the meeting agent more human-sounding and accurate"},
    {"title": "01 — System Architecture", "path": "-ucxa4mhA5.md", "project_name": None,
     "snippet": "Locked decisions this architecture assumes"},
]
NONDEC_HITS = [
    {"title": "Sprint Board", "path": "a.md", "project_name": "Mnema", "snippet": "tasks in progress this week"},
    {"title": "Roadmap", "path": "b.md", "project_name": "Mnema", "snippet": "what is planned next"},
]


class FakeMnema:
    def __init__(self, hits):
        self._hits = hits

    async def call(self, name, args, *a, **k):
        if name == "search_docs":
            return {"results": self._hits}
        return {"content": ""}  # traverse_graph → no graph block (keeps output deterministic)


def _runner(hits):
    r = TurnRunner.__new__(TurnRunner)  # bypass __init__ (no network / OpenAI)
    r.mnema = FakeMnema(hits)
    r.messages = []
    return r


async def _background_block(hits, text):
    r = _runner(hits)
    await r._background(text)
    sys_msgs = [m["content"] for m in r.messages if m["role"] == "system"]
    return sys_msgs[-1] if sys_msgs else ""


def _original_render(hits, text):
    """The PRE-change turn._background render (no decision label, original disclaimer) — the
    byte-identical baseline STEP 3 must match for non-decision hits."""
    if _LIVE_DATA_RE.search(text):
        return ""
    blocks = []
    for h in hits[:3]:
        proj = h.get("project_name") or "Unfiled"
        head = h.get("title") or ""
        if h.get("heading_path"):
            head = f"{head} › {h['heading_path']}"
        blocks.append(f"[project: {proj} | {head}]\n{(h.get('snippet') or '').strip()}")
    body = to_spoken_plaintext("\n\n---\n\n".join(blocks))
    return (
        "[Background — stored docs + their graph relations, each labelled with its project. "
        "Docs may be OUT OF DATE; for current tasks/status/assignments call the live tools "
        "(list_project_tasks / list_recent_docs). Use naturally; don't say you looked it up]"
        "\n\n" + body)[:2500]


async def main() -> int:
    fails = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    # Q16 must not be skipped by the live-data gate (else nothing is injected at all).
    if _LIVE_DATA_RE.search(Q16):
        print("FATAL: Q16 hits the _LIVE_DATA_RE skip — background would never inject. STOP.")
        return 2

    print("STEP 0 — DELTA: old mirror render vs new, for the SAME current-decision hit:")
    old_dec = _original_render(DECISION_HITS, Q16)
    new_dec = await _background_block(DECISION_HITS, Q16)
    print("  OLD (pre-sync) decision line:")
    print("   ", old_dec.split("\n\n", 1)[1].splitlines()[0])
    print("  NEW (synced) decision line:")
    print("   ", new_dec.split("\n\n", 1)[1].splitlines()[0])
    check("old mirror had NO decision label", "[DECISION — CURRENT" not in old_dec)
    if "[DECISION — CURRENT" in old_dec:
        print("STOP: baseline already had the label — diagnosis premise wrong.")
        return 1

    print("STEP 1 — synced mirror carries the verbatim CURRENT label for Q16:")
    print("   header:", new_dec.split("\n\n", 1)[0])
    check("Inworld hit labelled [DECISION — CURRENT … standing decision]",
          "[DECISION — CURRENT as of 2026-06-26; this is the standing decision]" in new_dec)

    print("STEP 2 — disclaimer carve-out: current decision is NOT flagged out-of-date:")
    header = new_dec.split("\n\n", 1)[0]
    check("header adds the 'standing decision — trust it over older docs' line",
          "A DECISION labelled CURRENT is the standing decision" in header)
    # historical hit still labelled superseded
    hist_hits = [{**DECISION_HITS[0], "decision_status": "historical"}]
    new_hist = await _background_block(hist_hits + DECISION_HITS[1:], Q16)
    check("historical hit labelled SUPERSEDED, do not state as current",
          "SUPERSEDED, do not state as current" in new_hist)

    print("STEP 3 — NO-OP GUARD: non-decision background BYTE-IDENTICAL to pre-change:")
    base = _original_render(NONDEC_HITS, NONDEC)
    new_nd = await _background_block(NONDEC_HITS, NONDEC)
    check("non-decision [Background] byte-identical (no label, disclaimer unchanged)",
          new_nd == base, "identical" if new_nd == base else f"len {len(new_nd)} vs {len(base)}")
    if new_nd != base:
        print("  --- baseline ---\n", base)
        print("  --- new ---\n", new_nd)

    print("\nMIRROR-SYNC GATE:", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
