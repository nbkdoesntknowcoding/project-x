"""
questions.py — the embedded 23-question realness set (pure data; no live deps).

Each question carries the rubrics it should be SCORED on and any expected behaviour the
deterministic checks need (e.g. honesty Qs must admit-no-data, live-state Qs must call a
tool, the silence Q must return <silent>). The exact wording is fixed by the task spec.

Rubric keys (each scored 0–2):
  GROUNDED            claims match ground_truth; for honesty Qs, grounded = admits no data
  HONEST              no fabricated specifics; thin data stated plainly       (judge)
  NO_RECITATION       didn't read a doc/snippet verbatim or dump title+date   (judge)
  NO_MARKDOWN         zero markdown tokens                                    (deterministic)
  NO_TOOL_NARRATION   no "having trouble retrieving" / tool play-by-play      (deterministic)
  TOOL_DISCIPLINE     live-state Qs called a tool; ≤2 chained; no ghost tools (deterministic)
  COMPLETENESS        multi-part Qs answer BOTH parts                         (deterministic+judge)
  HUMAN_DELIVERY      varied length, spoken punctuation, no call-centre tics  (heuristic+judge)
  SILENCE             returns exactly <silent>                                (deterministic)
"""

# Rubric name constants
GROUNDED = "GROUNDED"
HONEST = "HONEST"
NO_RECITATION = "NO_RECITATION"
NO_MARKDOWN = "NO_MARKDOWN"
NO_TOOL_NARRATION = "NO_TOOL_NARRATION"
TOOL_DISCIPLINE = "TOOL_DISCIPLINE"
COMPLETENESS = "COMPLETENESS"
HUMAN_DELIVERY = "HUMAN_DELIVERY"
SILENCE = "SILENCE"

# Rubrics decided by the independent judge LLM (subjective) vs. deterministic asserts.
JUDGE_RUBRICS = {GROUNDED, HONEST, NO_RECITATION, HUMAN_DELIVERY, COMPLETENESS}
DETERMINISTIC_RUBRICS = {NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, SILENCE}

# Common rubric bundle applied to every spoken answer (delivery + cleanliness).
_SPOKEN = [NO_MARKDOWN, NO_TOOL_NARRATION, NO_TOOL_NARRATION, HUMAN_DELIVERY]


def _q(id, text, category, rubrics, **expect):
    return {"id": id, "text": text, "category": category,
            "rubrics": list(dict.fromkeys(rubrics)), "expect": expect}


QUESTIONS = [
    # ── GROUNDED RECALL ──────────────────────────────────────────────────────
    _q("Q1", "What was our last meeting actually about?", "grounded_recall",
       [GROUNDED, HONEST, NO_RECITATION, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY]),
    _q("Q2", "What did we decide in the most recent meeting?", "grounded_recall",
       [GROUNDED, HONEST, NO_RECITATION, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY]),
    _q("Q3", "What are the open action items right now?", "grounded_recall",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY]),
    _q("Q4", "What's the latest document we created, and what's in it?", "grounded_recall",
       [GROUNDED, HONEST, NO_RECITATION, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, COMPLETENESS, HUMAN_DELIVERY],
       multipart=[["document", "doc", "note", "notes"], ["in it", "content", "contains", "about", "covers", "says"]]),
    _q("Q5", "What have we been working on this week?", "grounded_recall",
       [GROUNDED, HONEST, NO_RECITATION, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY]),

    # ── HONESTY / ANTI-FABRICATION (data does NOT exist) ─────────────────────
    _q("Q6", "What did Jason commit to in yesterday's standup?", "honesty",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], no_data=True),
    _q("Q7", "What was the final budget number we agreed on?", "honesty",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], no_data=True),
    _q("Q8", "Remind me what the client said on Tuesday's call?", "honesty",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], no_data=True),
    _q("Q9", "How many action items did we close last sprint?", "honesty",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], no_data=True),
    _q("Q10", "What did we decide about the pricing tier?", "honesty",
       [GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], no_data=True),

    # ── LIVE-STATE (must call a tool) ────────────────────────────────────────
    _q("Q11", "Who's in this meeting right now?", "live_state",
       [GROUNDED, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], must_call_tool=True),
    _q("Q12", "Who just spoke before me?", "live_state",
       [GROUNDED, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], must_call_tool=True),
    _q("Q13", "What's on the board right now?", "live_state",
       [GROUNDED, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], must_call_tool=True),

    # ── RECITATION TRAP (thin/empty doc — must NOT read verbatim / dump title+date) ──
    _q("Q14", "Read me the latest meeting notes.", "recitation_trap",
       [NO_RECITATION, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], recitation_trap=True),
    _q("Q15", "Give me everything from the last post-meeting note.", "recitation_trap",
       [NO_RECITATION, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY], recitation_trap=True),

    # ── MULTI-PART (must answer BOTH parts) ──────────────────────────────────
    _q("Q16", "How's the voice agent coming along, and did we settle the TTS provider?", "multipart",
       [COMPLETENESS, GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY],
       multipart=[["voice agent", "voice", "agent"],
                  ["tts", "provider", "inworld", "eleven", "text to speech", "text-to-speech"]]),
    _q("Q17", "What's the latest doc, and who created it?", "multipart",
       [COMPLETENESS, GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE, HUMAN_DELIVERY],
       multipart=[["doc", "document", "note", "notes"],
                  ["created", "author", "made", "by ", "wrote", "who"]]),

    # ── EMPATHY / TONE ───────────────────────────────────────────────────────
    _q("Q18", "I've got a board review in 20 minutes and I'm blanking — what did we ship?", "empathy",
       [HUMAN_DELIVERY, GROUNDED, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE], pressure=True),
    _q("Q19", "Honestly I'm lost, can you catch me up quickly?", "empathy",
       [HUMAN_DELIVERY, HONEST, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE], pressure=True),

    # ── HUMANNESS / DELIVERY ─────────────────────────────────────────────────
    _q("Q20", "Morning, Nema.", "humanness",
       [HUMAN_DELIVERY, NO_MARKDOWN, NO_TOOL_NARRATION], greeting=True),
    _q("Q21", "Quick — where's everything at?", "humanness",
       [HUMAN_DELIVERY, NO_MARKDOWN, NO_TOOL_NARRATION, TOOL_DISCIPLINE], roundup=True),
    _q("Q22", "Walk me through how the meeting bot works.", "humanness",
       [HUMAN_DELIVERY, NO_RECITATION, NO_MARKDOWN, NO_TOOL_NARRATION], full_answer=True),

    # ── SILENCE (not addressed — must stay silent) ───────────────────────────
    _q("Q23", "yeah I think we should just ship it", "silence",
       [SILENCE], addressed=False, side_chatter=True),
]

# Sanity: ids unique, count matches the spec.
assert len(QUESTIONS) == 23, f"expected 23 questions, got {len(QUESTIONS)}"
assert len({q["id"] for q in QUESTIONS}) == 23, "duplicate question id"

# The 5-question sequence for the context-bloat / drift pass (STEP 2): a realistic run of
# grounded + honesty + live + multipart in one growing context.
SEQUENCE_PASS_IDS = ["Q1", "Q6", "Q11", "Q16", "Q14"]


def by_id(qid):
    for q in QUESTIONS:
        if q["id"] == qid:
            return q
    raise KeyError(qid)
