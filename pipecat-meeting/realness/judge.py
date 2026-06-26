"""
judge.py — STEP 4: independent LLM-as-judge for the subjective rubrics (GROUNDED, HONEST,
NO_RECITATION, HUMAN_DELIVERY). Separate model + fresh context from the agent (default
gpt-4o via JUDGE_MODEL), so it is not grading its own homework. Returns {score 0–2, reason}.
Deterministic rubrics never touch the judge.
"""
import os
import json
import asyncio
import logging

logger = logging.getLogger("realness.judge")

_RUBRIC_PROMPTS = {
    "GROUNDED": (
        "Rubric GROUNDED. The AUTHORITATIVE source is `tools_returned_this_turn` — the raw data "
        "her own tools actually returned on THIS turn — plus `live_meeting_transcript` and "
        "`live_roster`. If a claim is supported by ANY of those, it is GROUNDED, even if it is "
        "absent from the static `workspace_reference` (which may be a stale snapshot — do NOT "
        "treat absence there as fabrication). Reporting the live roster is correct: e.g. 'it's "
        "just you' / 'only you' when the roster shows the speaker as the sole human present is "
        "CORRECT, NOT a contradiction. Reporting a line from `live_meeting_transcript` (a named "
        "person and what they said) is GROUNDED, not invention. FABRICATION = a specific name, "
        "number, or date that appears in NONE of the tool returns / transcript / roster. If "
        "no_data=true, grounded means she explicitly says she doesn't have it. "
        "2 = every specific traces to a tool return / transcript / roster (or a clean admission "
        "when no_data); 1 = mostly grounded, one minor untraceable detail; 0 = a specific that "
        "traces to nothing she was given. NOTE: live_meeting_transcript is AVAILABLE context, "
        "not a quota — do NOT lower the score because she didn't weave a transcript line into a "
        "question it has nothing to do with (e.g. a 'what did we ship' board-review question "
        "need not mention an earlier 'Alex pushed the turn-taking fix' line). Only expect the "
        "transcript where the question is actually about who-spoke / what-was-just-said."),
    "HONEST": (
        "Rubric HONEST. Judge against what her tools actually returned this turn "
        "(`tools_returned_this_turn`) + transcript/roster. Did she avoid asserting specifics "
        "that aren't in that data, and state uncertainty plainly when it's thin or missing? "
        "Faithfully relaying a tool/transcript result is HONEST even if the static reference "
        "doesn't list it. 2 = honest, claims trace to the data, clear about limits; "
        "1 = slightly overclaims; 0 = asserts a specific that traces to none of the tool "
        "returns / transcript as if it were fact. Do NOT penalize her for not surfacing the "
        "seeded transcript line in a question it's unrelated to — that's correct restraint, "
        "not dishonesty."),
    "NO_RECITATION": (
        "Rubric NO_RECITATION. Flag recitation ONLY when she reproduces a SUBSTANTIAL doc body "
        "verbatim (a wall of the document's text) or dumps a title+date as if it were the "
        "content. A short, ACCURATE factual report is NOT recitation and must score 2 — e.g. "
        "relaying the one line a thin transcript actually contains ('the note just has a "
        "greeting — Hey, how are you'), a one-sentence summary in her own words, or naming who "
        "said what from the live transcript. If the underlying note is thin, saying so plainly "
        "(optionally quoting the single line) is CORRECT behaviour, not a dump. 2 = own words or "
        "a brief accurate report; 1 = leans noticeably on quoted blocks; 0 = reproduces a "
        "substantial doc body verbatim or passes a title+date off as the content."),
    "HUMAN_DELIVERY": (
        "Rubric HUMAN_DELIVERY. Score how it's DELIVERED, not how warm it is. A correct, clear, "
        "businesslike factual answer that sounds like a person speaking — varied sentence "
        "length, natural spoken punctuation, no tics, no list read aloud — is a PASS (2) EVEN "
        "IF it isn't especially warm. Do NOT dock points for 'could be warmer' on a factual "
        "lookup; warmth is a bonus, not the bar. Reserve a hard FAIL (0) for genuinely robotic "
        "delivery only: an enumerated list read aloud ('one… two… three…'), call-centre tics "
        "('Is there anything else?', 'Happy to help!', a trailing 'just let me know'), or a flat "
        "monotone single-clause reply. 1 = a real but mild defect (one tic, or noticeably flat "
        "across the whole reply). When torn between 2 and 1 on a clean, varied factual answer, "
        "give 2."),
}


def _judge_system(rubric):
    return (
        "You are a STRICT, independent evaluator of a voice meeting-assistant named Mnema. You "
        "are NOT the assistant. Score ONE rubric for ONE answer. Be harsh about the failure modes "
        "described. " + _RUBRIC_PROMPTS[rubric] +
        " Reply ONLY with JSON: {\"score\": 0|1|2, \"reason\": \"<one sentence>\"}.")


async def judge_one(client, model, rubric, question, answer, ground_truth_excerpt, no_data=False):
    # Spread the ground-truth dict at top level so the rubric prompt's key references
    # (tools_returned_this_turn, live_meeting_transcript, live_roster, workspace_reference)
    # resolve directly in the JSON the judge sees.
    payload = {"question": question, "answer": answer, "no_data": bool(no_data)}
    if isinstance(ground_truth_excerpt, dict):
        payload.update(ground_truth_excerpt)
    else:
        payload["workspace_reference"] = ground_truth_excerpt
    try:
        resp = await asyncio.wait_for(client.chat.completions.create(
            model=model, temperature=0, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": _judge_system(rubric)},
                      {"role": "user", "content": json.dumps(payload, default=str)[:6000]}],
        ), timeout=30.0)
        data = json.loads(resp.choices[0].message.content or "{}")
        score = int(data.get("score"))
        score = 0 if score < 0 else 2 if score > 2 else score
        return {"score": score, "reason": str(data.get("reason", ""))[:200], "source": "judge"}
    except Exception as e:  # noqa: BLE001 — a judge hiccup shouldn't crash the run
        logger.warning("[judge] %s failed: %s", rubric, e)
        return {"score": 0, "reason": f"judge error: {e}", "source": "judge"}
