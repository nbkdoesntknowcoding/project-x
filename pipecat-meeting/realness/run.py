"""
run.py — realness harness entrypoint (LIVE; run in the pipecat-meeting container / VPS).

  python -m realness.run            # full run → ground_truth.json, answers.json, test_report.md
  python -m realness.run --quick    # fresh pass only, skip the sequence/drift pass

Needs in env (from infra/.env): OPENAI_API_KEY, MNEMA_API_URL, MNEMA_API_KEY (+ optional
MEETING_LLM_* to mirror a swapped agent model, JUDGE_MODEL, REALNESS_BOT_ID to attach a real
meeting for the M0/M3 briefs). MEASUREMENT ONLY — never mutates the workspace.
"""
import os
import sys
import json
import asyncio
import logging
import datetime

from openai import AsyncOpenAI

from recall_io import BotState
from realness import questions as Q
from realness import checks as C
from realness import report as R
from realness.turn import TurnRunner
from realness.groundtruth import build_ground_truth
from realness.judge import judge_one

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("realness.run")

SPEAKER_NAME = "Nischay B K"
SPEAKER_EMAIL = os.environ.get("REALNESS_SPEAKER_EMAIL", "nischaybk@theboringpeople.in")
OUT_DIR = os.environ.get("REALNESS_OUT_DIR", os.path.dirname(os.path.dirname(__file__)))
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "gpt-4o")


def seed_state() -> BotState:
    """A live meeting with ONLY Nischay present (matches the production log 'just you'), plus
    a prior utterance by someone else so 'who spoke before me' (Q12) has something to recall."""
    s = BotState()
    s.bot_id = os.environ.get("REALNESS_BOT_ID")  # optional real recall bot id for M0/M3 briefs
    s.bot_participant_id = "p_bot"
    s.participants = {"p_nischay": {"name": SPEAKER_NAME, "email": SPEAKER_EMAIL, "is_host": True}}
    s.roster_ever = dict(s.participants)
    s.active_speaker_id = "p_nischay"
    s.last_speaker_id = "p_nischay"
    s.meeting_log = [{"speaker": "Alex Kim", "text": "I pushed the turn-taking fix earlier this morning."}]
    s.spoken_turns = 0
    return s


def gt_excerpt(gt: dict, q: dict) -> dict:
    """A compact, relevant slice of ground truth for the judge."""
    ex = {
        "recent_docs": [{"title": d.get("title"), "date": d.get("updated_at") or d.get("created_at")}
                        for d in gt.get("recent_docs", [])[:6]],
        "latest_doc": gt.get("latest_doc"),
        "post_meeting_notes": gt.get("post_meeting_notes"),
        "roster": gt.get("roster"),
        "board_task_titles": [t.get("title") for t in gt.get("board_tasks", [])[:8]],
    }
    if q["expect"].get("no_data"):
        key = {"Q6": "Q6_jason_standup", "Q7": "Q7_budget_number", "Q8": "Q8_tuesday_client_call",
               "Q9": "Q9_sprint_close_count", "Q10": "Q10_pricing_tier"}.get(q["id"])
        if key:
            ex["this_probe_returned"] = gt.get("absent_probes", {}).get(key)
    return ex


async def score_row(q, result, gt, judge_client, known_tools):
    text = result["text"]
    tool_calls = result["tool_calls"]
    scores = {}
    judge_jobs = []  # (rubric, coroutine)

    for rubric in q["rubrics"]:
        if rubric == Q.NO_MARKDOWN:
            sc, why = C.score_no_markdown(text)
            scores[rubric] = {"score": sc, "reason": why, "source": "deterministic"}
        elif rubric == Q.NO_TOOL_NARRATION:
            sc, why = C.score_no_tool_narration(text)
            scores[rubric] = {"score": sc, "reason": why, "source": "deterministic"}
        elif rubric == Q.TOOL_DISCIPLINE:
            sc, why = C.score_tool_discipline(tool_calls, q["expect"].get("must_call_tool", False), known_tools)
            scores[rubric] = {"score": sc, "reason": why, "source": "deterministic"}
        elif rubric == Q.SILENCE:
            sc, why = C.score_silence(result["raw_text"])
            scores[rubric] = {"score": sc, "reason": why, "source": "deterministic"}
        elif rubric == Q.COMPLETENESS:
            sc, why = C.score_completeness(text, q["expect"].get("multipart", []))
            scores[rubric] = {"score": sc, "reason": why, "source": "deterministic"}
        elif rubric in Q.JUDGE_RUBRICS:
            judge_jobs.append((rubric, judge_one(
                judge_client, JUDGE_MODEL, rubric, q["text"], text,
                gt_excerpt(gt, q), no_data=q["expect"].get("no_data", False))))

    if judge_jobs:
        results = await asyncio.gather(*[c for _, c in judge_jobs])
        for (rubric, _), res in zip(judge_jobs, results):
            scores[rubric] = res

    # HUMAN_DELIVERY is judge-scored above; attach the deterministic heuristic details
    # alongside (sentence-length variance, punctuation, call-centre tics) for the human read.
    human_heuristic = _delivery_details(text) if Q.HUMAN_DELIVERY in q["rubrics"] else None

    return {"id": q["id"], "text": q["text"], "category": q["category"],
            "answer": text, "tool_calls": tool_calls, "scores": scores,
            "human_heuristic": human_heuristic}


def _delivery_details(text):
    # re-run the heuristic to expose its details dict (kept separate to avoid touching checks API)
    import statistics
    import re as _re
    sents = [s.strip() for s in _re.split(r"[.!?]+(?:\s|$)|\n+", text or "") if s.strip()]
    lengths = [len(s.split()) for s in sents] or [0]
    var = statistics.pstdev(lengths) if len(lengths) > 1 else 0.0
    has_punct = bool(_re.search(r"[,—…]|--|\.\.\.|\?", text or ""))
    return {"sentences": len(sents), "lengths": lengths, "length_stdev": round(var, 2),
            "has_spoken_punctuation": has_punct,
            "call_centre_phrases": [p for p in C._CALL_CENTRE if p in (text or "").lower()]}


async def main(quick=False):
    for req in ("OPENAI_API_KEY", "MNEMA_API_URL", "MNEMA_API_KEY"):
        if not os.environ.get(req):
            print(f"FATAL: {req} not set (need infra/.env secrets). Aborting.", file=sys.stderr)
            return 2

    judge_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    known_tools = C.all_known_tools()

    # ── STEP 1: ground truth ──
    gt_state = seed_state()
    gt_runner = TurnRunner(gt_state)  # reuse its MnemaMCP (acts as Nischay)
    logger.info("[run] building ground truth from the live workspace…")
    gt = await build_ground_truth(gt_runner.mnema, gt_state)
    gt_path = os.path.join(OUT_DIR, "ground_truth.json")
    with open(gt_path, "w") as f:
        json.dump(gt, f, indent=2, default=str)
    logger.info("[run] ground_truth.json written (%d recent docs, latest_doc_len=%s)",
                len(gt.get("recent_docs", [])),
                (gt.get("latest_doc") or {}).get("content_len"))

    # ── STEP 2+3: fresh pass (each question in its OWN session) ──
    rows = []
    for q in Q.QUESTIONS:
        runner = TurnRunner(seed_state())  # fresh context, no carryover
        logger.info("[run] %s: %s", q["id"], q["text"])
        try:
            result = await runner.run_turn(q["text"], SPEAKER_NAME, q["expect"])
        except Exception as e:  # noqa: BLE001 — capture, don't abort the whole run
            logger.exception("[run] %s turn failed: %s", q["id"], e)
            result = {"text": f"<turn error: {e}>", "tool_calls": [], "addressed": True,
                      "raw_text": "", "context_len": 0}
        await runner.mnema.aclose()
        row = await score_row(q, result, gt, judge_client, known_tools)
        rows.append(row)

    # ── STEP 2: sequence / drift pass (5 questions in ONE growing context) ──
    sequence_rows = []
    if not quick:
        logger.info("[run] sequence/drift pass: %s", Q.SEQUENCE_PASS_IDS)
        seq_runner = TurnRunner(seed_state())
        for qid in Q.SEQUENCE_PASS_IDS:
            q = Q.by_id(qid)
            try:
                result = await seq_runner.run_turn(q["text"], SPEAKER_NAME, q["expect"])
            except Exception as e:  # noqa: BLE001
                logger.exception("[run] seq %s failed: %s", qid, e)
                result = {"text": f"<turn error: {e}>", "tool_calls": [], "addressed": True,
                          "raw_text": "", "context_len": 0}
            row = await score_row(q, result, gt, judge_client, known_tools)
            row["context_len"] = result.get("context_len")
            sequence_rows.append(row)
        await seq_runner.mnema.aclose()

    # ── STEP 5: aggregate + report ──
    agg = R.aggregate_results(rows)
    results = {
        "aggregate": agg, "rows": rows, "sequence_rows": sequence_rows,
        "category_rates": agg["category_rates"],
        "meta": {
            "model": os.environ.get("MEETING_LLM_MODEL", os.environ.get("OPENAI_LLM_MODEL", "gpt-4o-mini")),
            "judge_model": JUDGE_MODEL,
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "workspace": os.environ.get("MNEMA_WORKSPACE", "The Boring People"),
            "speaker": SPEAKER_NAME, "ground_truth_path": gt_path,
        },
    }
    md = R.render_report(results)
    report_path = os.path.join(OUT_DIR, "test_report.md")
    with open(report_path, "w") as f:
        f.write(md)
    with open(os.path.join(OUT_DIR, "answers.json"), "w") as f:
        json.dump([{"id": r["id"], "answer": r["answer"], "tool_calls": r["tool_calls"],
                    "scores": r["scores"]} for r in rows], f, indent=2, default=str)

    print("\n" + "=" * 70)
    print(f"REALNESS SCORE: {agg['realness_score']} / 100")
    print(f"report: {report_path}")
    print(f"FAILURES ({len(agg['fails'])}):")
    for fl in agg["fails"]:
        print("  -", fl)
    print("=" * 70)
    return 0


if __name__ == "__main__":
    quick = "--quick" in sys.argv
    raise SystemExit(asyncio.run(main(quick=quick)))
