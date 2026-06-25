"""
report.py — aggregate scored rows into rates + a realness score, and render test_report.md.
Pure (no live deps): aggregate_results(rows) and render_report(results) are unit-tested.

Row shape (produced by run.py):
  {
    "id","text","category","answer","tool_calls":[{"name","args"}],
    "scores": { RUBRIC: {"score":0|1|2,"reason":str,"source":"deterministic|judge|heuristic"} },
    "human_heuristic": {...} | None,
  }
"""

# scoring: a rubric scored 2 = pass, 1 = partial, 0 = fail.
PASS, PARTIAL, FAIL = 2, 1, 0


def _fails_for_row(row) -> list:
    """Exact failure-mode strings for a row (score 0 = FAIL, score 1 = PARTIAL)."""
    out = []
    for rubric, s in row["scores"].items():
        if s["score"] == FAIL:
            out.append(f"{row['id']} {rubric} FAIL: {s['reason']}")
        elif s["score"] == PARTIAL:
            out.append(f"{row['id']} {rubric} PARTIAL: {s['reason']}")
    return out


def aggregate_results(rows: list) -> dict:
    """Compute per-category pass rates, per-rubric averages, the top-level realness score,
    and the flat FAIL list. Pure."""
    all_scores = []
    rubric_acc: dict = {}
    cat_acc: dict = {}
    fails = []
    for row in rows:
        rscores = [s["score"] for s in row["scores"].values()]
        all_scores.extend(rscores)
        for rubric, s in row["scores"].items():
            rubric_acc.setdefault(rubric, []).append(s["score"])
        # a question "passes" its category if it has NO hard fails (no score 0)
        cat = row["category"]
        cat_acc.setdefault(cat, {"pass": 0, "total": 0})
        cat_acc[cat]["total"] += 1
        if all(s["score"] >= 1 for s in row["scores"].values()) and rscores:
            if all(s["score"] == 2 for s in row["scores"].values()):
                cat_acc[cat]["pass"] += 1
        fails.extend(_fails_for_row(row))

    realness = round(100.0 * sum(all_scores) / (2 * len(all_scores)), 1) if all_scores else 0.0
    category_rates = {
        c: {"pass": v["pass"], "total": v["total"],
            "rate": round(100.0 * v["pass"] / v["total"], 0) if v["total"] else 0.0}
        for c, v in cat_acc.items()
    }
    rubric_rates = {
        r: {"avg": round(sum(v) / len(v), 2), "n": len(v),
            "fails": sum(1 for x in v if x == 0)}
        for r, v in rubric_acc.items()
    }
    return {"realness_score": realness, "category_rates": category_rates,
            "rubric_rates": rubric_rates, "fails": fails}


def _tool_str(tool_calls) -> str:
    if not tool_calls:
        return "—"
    return ", ".join(f"{c['name']}({_args(c.get('args'))})" for c in tool_calls)


def _args(a) -> str:
    if not a:
        return ""
    return ", ".join(f"{k}={str(v)[:24]}" for k, v in a.items())


def render_report(results: dict) -> str:
    """results = {meta, rows, sequence_rows, aggregate(...) merged}. Returns markdown text."""
    agg = results["aggregate"]
    meta = results.get("meta", {})
    L = []
    L.append("# Mnema Meeting Bot — Realness Test Report")
    L.append("")
    L.append(f"**Realness score: {agg['realness_score']} / 100**  "
             f"(mean of all rubric scores, 0–2 each, across {len(results['rows'])} questions)")
    L.append("")
    L.append(f"- Agent model: `{meta.get('model','?')}`  |  Judge model: `{meta.get('judge_model','?')}`")
    L.append(f"- Generated: {meta.get('generated_at','?')}  |  Workspace: {meta.get('workspace','?')}")
    L.append(f"- Speaker: {meta.get('speaker','Nischay B K')} (founder/owner)")
    L.append(f"- Ground truth: `{meta.get('ground_truth_path','ground_truth.json')}`")
    L.append("")

    # ── failures up top ──
    L.append("## FAILURES (every flagged row)")
    if agg["fails"]:
        for f in agg["fails"]:
            L.append(f"- {f}")
    else:
        L.append("- none")
    L.append("")

    # ── category rates ──
    L.append("## Pass rate by category")
    L.append("")
    L.append("| Category | Clean passes | Total |")
    L.append("|---|---|---|")
    for c, cr in sorted(agg["category_rates"].items()):
        L.append(f"| {c} | {cr['pass']} | {cr['total']} |")
    L.append("")

    # ── rubric averages ──
    L.append("## Rubric averages (0–2)")
    L.append("")
    L.append("| Rubric | Avg | n | hard fails |")
    L.append("|---|---|---|---|")
    for r in sorted(agg["rubric_rates"]):
        v = agg["rubric_rates"][r]
        L.append(f"| {r} | {v['avg']} | {v['n']} | {v['fails']} |")
    L.append("")

    # ── per-question detail ──
    L.append("## Per-question detail (answers verbatim — read for cadence)")
    L.append("")
    for row in results["rows"]:
        L.append(f"### {row['id']} · {row['category']}")
        L.append(f"**Q:** {row['text']}")
        L.append("")
        L.append(f"**Answer (verbatim):** {row['answer']!r}")
        L.append("")
        L.append(f"**Tool calls:** {_tool_str(row['tool_calls'])}")
        L.append("")
        L.append("| Rubric | Score | Source | Reason |")
        L.append("|---|---|---|---|")
        for rubric, s in row["scores"].items():
            L.append(f"| {rubric} | {s['score']} | {s['source']} | {s['reason'].replace(chr(10),' ')[:140]} |")
        if row.get("human_heuristic"):
            hh = row["human_heuristic"]
            L.append("")
            L.append(f"_delivery heuristic: sentences={hh.get('sentences')} "
                     f"lengths={hh.get('lengths')} stdev={hh.get('length_stdev')} "
                     f"spoken_punct={hh.get('has_spoken_punctuation')} "
                     f"tics={hh.get('call_centre_phrases')}_")
        L.append("")

    # ── sequence / drift pass ──
    if results.get("sequence_rows"):
        L.append("## Context-bloat / drift pass (5 questions in ONE growing context)")
        L.append("")
        L.append(f"Sequence: {', '.join(r['id'] for r in results['sequence_rows'])}. "
                 "Compare each answer + scores to its fresh-context run above to spot drift "
                 "(persona slipping, markdown creeping in, longer tool chains).")
        L.append("")
        for row in results["sequence_rows"]:
            avg = (sum(s["score"] for s in row["scores"].values()) /
                   max(1, len(row["scores"])))
            L.append(f"- **{row['id']}** (avg {avg:.2f}) — {row['answer']!r}  "
                     f"[tools: {_tool_str(row['tool_calls'])}]")
        L.append("")

    return "\n".join(L)
