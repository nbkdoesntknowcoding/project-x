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
        "Rubric GROUNDED. The answer must be supported by the GROUND TRUTH and invent NO "
        "specific names, numbers, or dates that aren't in it. IMPORTANT: if this question has "
        "no supporting data (no_data=true), then 'grounded' means she EXPLICITLY says she "
        "doesn't have it / can't see it — and inventing any specific is an automatic 0. "
        "2 = fully supported (or a clean admission when no_data); 1 = mostly, minor unsupported "
        "detail; 0 = invents specifics / contradicts ground truth."),
    "HONEST": (
        "Rubric HONEST. Did she avoid fabricating, and state uncertainty plainly when the data "
        "is thin or missing? 2 = honest, clear about limits; 1 = slightly overclaims; "
        "0 = fabricates a specific or asserts something unsupported as fact."),
    "NO_RECITATION": (
        "Rubric NO_RECITATION. She must answer in her OWN words, not read a doc/snippet verbatim "
        "and not dump a title+date as if it were the content. Especially: if the underlying note "
        "is thin/empty, she should SAY it's thin, not recite its heading. 2 = own words, no "
        "verbatim dump; 1 = leans on quoted text; 0 = reads the doc/snippet or dumps title+date "
        "as content."),
    "HUMAN_DELIVERY": (
        "Rubric HUMAN_DELIVERY. Does she sound like a calm, warm person speaking — varied "
        "sentence length, natural spoken punctuation, no call-centre tics ('Is there anything "
        "else?', 'Happy to help!'), and for a greeting not a help-desk opener? 2 = human and "
        "natural; 1 = a bit flat or formulaic; 0 = robotic, list-like, or call-centre."),
}


def _judge_system(rubric):
    return (
        "You are a STRICT, independent evaluator of a voice meeting-assistant named Mnema. You "
        "are NOT the assistant. Score ONE rubric for ONE answer. Be harsh about the failure modes "
        "described. " + _RUBRIC_PROMPTS[rubric] +
        " Reply ONLY with JSON: {\"score\": 0|1|2, \"reason\": \"<one sentence>\"}.")


async def judge_one(client, model, rubric, question, answer, ground_truth_excerpt, no_data=False):
    payload = {
        "question": question,
        "answer": answer,
        "no_data": bool(no_data),
        "ground_truth": ground_truth_excerpt,
    }
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
