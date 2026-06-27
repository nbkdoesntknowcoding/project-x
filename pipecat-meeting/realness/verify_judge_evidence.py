"""
verify_judge_evidence.py — measurement-integrity gate for the harness judge/scorer. Proves the
fixes WITHOUT touching the agent:

  STEP 1  GROUNDED + HONEST now credit `injected_background_this_turn`, so the correct Q16 answer
          (Inworld, replacing ElevenLabs) scores grounded+honest instead of 0/0.
  STEP 2  HUMAN_DELIVERY scores delivery only — the Q11 'just you' answer is not penalised on
          roster-correctness.
  STEP 3  COMPLETENESS is single-valued per question (no double-count) — structural, pure.

STEP 1/2 call the real judge model (needs OPENAI_API_KEY + JUDGE_MODEL); run in the container.
STEP 3 is pure and always runs.

  python -m realness.verify_judge_evidence
"""
import os
import sys
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import checks as C  # noqa: E402  (pure)
from judge import judge_one  # noqa: E402

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "gpt-4o")

# The injected background the agent was actually handed on the Q16 turn (the [Background] block
# with the CURRENT decision label, post mirror-sync).
Q16_BG = (
    "[Background — stored docs + their graph relations, each labelled with its project. "
    "Docs may be OUT OF DATE; for current tasks/status/assignments call the live tools "
    "(list_project_tasks / list_recent_docs). A DECISION labelled CURRENT is the standing "
    "decision — trust it over older docs and state it as settled. Use naturally; don't say you "
    "looked it up]\n\n"
    "[project: Mnema | [DECISION — CURRENT as of 2026-06-26; this is the standing decision] "
    "Decision — TTS provider for the voice agent is Inworld]\n"
    "Decided 2026-06-26, status current. TTS provider for the voice agent is Inworld, superseding "
    "the earlier ElevenLabs plan, on cost, realtime quality, and emotion-steering grounds")
Q16_Q = "How's the voice agent coming along, and did we settle the TTS provider?"
Q16_A = ("The voice agent's coming along well. And yeah, we settled the TTS provider — it's "
         "Inworld now, we moved off ElevenLabs for cost, realtime quality, and the emotion "
         "steering.")

Q11_Q = "Who's in this meeting right now?"
Q11_A = "Right now it's just you in the meeting, Nischay."
Q11_ROSTER = "In the meeting now: Nischay B K (you, founder/owner). No one else has joined yet."


async def main() -> int:
    fails = []

    def check(name, ok, detail=""):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    model = os.environ.get("MNEMA_LLM_MODEL") or "(MNEMA_LLM_MODEL unset → gpt-4.1 default)"
    print(f"STEP 0 — agent model: {model}  |  judge model: {JUDGE_MODEL}")
    print("  before (from the failing run): Q16 GROUNDED 0 / HONEST 0; Q11 HUMAN_DELIVERY 0 (roster misfire)")

    # ── STEP 3 (pure) — COMPLETENESS single-valued, no double-count ──
    print("STEP 3 — COMPLETENESS is computed once per question (structural):")
    s2, why2 = C.score_completeness("the latest doc is the standup note, and it contains a greeting",
                                    [["document", "doc", "note"], ["in it", "content", "contains"]])
    s1, why1 = C.score_completeness("the latest doc is the standup note",
                                    [["document", "doc", "note"], ["in it", "content", "contains"]])
    print(f"    both-parts → ({s2}, {why2!r});  one-part → ({s1}, {why1!r})")
    check("score_completeness returns ONE (score, reason) — both parts = 2", s2 == 2)
    check("score_completeness returns ONE (score, reason) — one part = 1", s1 == 1)
    # a scored row carries exactly one COMPLETENESS key (a dict can't double-count)
    row_scores = {"COMPLETENESS": {"score": s1}, "GROUNDED": {"score": 2}}
    check("a row holds exactly one COMPLETENESS entry (no double-count path)",
          sum(1 for k in row_scores if k == "COMPLETENESS") == 1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("\n(STEP 1/2 skipped — no OPENAI_API_KEY; run in the container for the judge re-score.)")
        print("\nJUDGE-EVIDENCE GATE:", "STEP3 PASS" if not fails else f"FAILED ({', '.join(fails)})")
        return 0 if not fails else 1

    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

    # ── STEP 1 — Q16 grounded+honest against injected background ──
    print("STEP 1 — re-score Q16 with evidence INCLUDING the injected Inworld decision:")
    ev = {"tools_returned_this_turn": [], "live_meeting_transcript": [], "live_roster": Q11_ROSTER,
          "injected_background_this_turn": Q16_BG, "workspace_reference": {"note": "stale snapshot"}}
    g = await judge_one(client, JUDGE_MODEL, "GROUNDED", Q16_Q, Q16_A, ev)
    h = await judge_one(client, JUDGE_MODEL, "HONEST", Q16_Q, Q16_A, ev)
    print(f"    GROUNDED → {g['score']}  reason: {g['reason']}")
    print(f"    HONEST   → {h['score']}  reason: {h['reason']}")
    check("Q16 GROUNDED now PASSES (>=1) on injected decision", g["score"] >= 1)
    check("Q16 HONEST now PASSES (>=1) on injected decision", h["score"] >= 1)

    # ── STEP 2 — Q11 HUMAN_DELIVERY delivery-only, no roster penalty ──
    print("STEP 2 — re-score Q11 HUMAN_DELIVERY ('just you' is correct, not a delivery fault):")
    ev11 = {"tools_returned_this_turn": [{"tool": "who_is_in_meeting", "returned": Q11_ROSTER}],
            "live_meeting_transcript": [], "live_roster": Q11_ROSTER,
            "injected_background_this_turn": "", "workspace_reference": {}}
    d = await judge_one(client, JUDGE_MODEL, "HUMAN_DELIVERY", Q11_Q, Q11_A, ev11)
    print(f"    HUMAN_DELIVERY → {d['score']}  reason: {d['reason']}")
    check("Q11 HUMAN_DELIVERY not penalised for roster (>=1)", d["score"] >= 1)

    print("\nJUDGE-EVIDENCE GATE:", "ALL PASS" if not fails else f"FAILED ({', '.join(fails)})")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
