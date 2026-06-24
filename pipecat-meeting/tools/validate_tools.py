#!/usr/bin/env python3
"""
A3.2 — tool-schema validation harness.

Proves a candidate fast-silicon model uses the REAL Mnema MCP tool schema reliably
BEFORE the A3.1 swap. Replays representative meeting turns (graph-grounded Q&A, tool
calls, <silent> side-talk) against each configured model and measures tool-call FORMAT
validity + SELECTION accuracy + <silent> accuracy — not just latency.

Gate: a candidate must meet or beat the baseline (gpt-4o-mini) overall before A3.1 proceeds.

Usage:
  python tools/validate_tools.py             # run every model that has an API key set
  python tools/validate_tools.py --dry-run   # validate harness + tool schemas, NO API calls

Models (OpenAI-compatible, configured via env):
  baseline  : OPENAI_API_KEY                       model gpt-4o-mini
  groq      : GROQ_API_KEY      + GROQ_MODEL       base https://api.groq.com/openai/v1
  cerebras  : CEREBRAS_API_KEY  + CEREBRAS_MODEL   base https://api.cerebras.ai/v1
  gemini    : GEMINI_API_KEY    + GEMINI_MODEL     base https://generativelanguage.googleapis.com/v1beta/openai
"""
import os
import sys
import json
import asyncio
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from mnema_tool_defs import MNEMA_TOOL_DEFINITIONS  # noqa: E402
from meeting_persona import build_meeting_persona, SILENT_TOKEN  # noqa: E402

TOOL_NAMES = {t["function"]["name"] for t in MNEMA_TOOL_DEFINITIONS}

# Representative turns. expect = {"tool": name} | {"silent": True} | {"answer": True}
CASES = [
    {"id": "search-doc",     "utterance": "Mnema, what does the billing migration doc say about retries?", "expect": {"tool": "search_knowledge"}},
    {"id": "list-projects",  "utterance": "Mnema, what projects do we have?", "expect": {"tool": "list_projects"}},
    {"id": "whoami",         "utterance": "Mnema, what's my role here?", "expect": {"tool": "whoami"}},
    {"id": "create-task",    "utterance": "Mnema, create a task to follow up with the vendor by Friday.", "expect": {"tool": "create_task"}},
    {"id": "graph-traverse", "utterance": "Mnema, how does the voice clone project connect to the document processing work?", "expect": {"tool": "traverse_graph"}},
    {"id": "tasks-live",     "utterance": "Mnema, what tasks are in progress right now?", "expect": {"tool": "list_project_tasks"}},
    {"id": "side-talk-1",    "utterance": "yeah I think we should ship the pricing change next week", "expect": {"silent": True}},
    {"id": "side-talk-2",    "utterance": "can you send me that file after the call, John?", "expect": {"silent": True}},
    {"id": "greeting",       "utterance": "Mnema, hi there", "expect": {"answer": True}},
]


def validate_schemas():
    """Sanity-check the tool schemas are well-formed OpenAI function tools. Returns errors."""
    errs = []
    for t in MNEMA_TOOL_DEFINITIONS:
        if t.get("type") != "function":
            errs.append(f"tool missing type=function: {t.get('function', {}).get('name', t)}")
        fn = t.get("function", {})
        if not fn.get("name"):
            errs.append("function missing name")
        params = fn.get("parameters")
        if not isinstance(params, dict) or params.get("type") != "object":
            errs.append(f"{fn.get('name')}: parameters must be an object schema")
    return errs


def evaluate_response(expect: dict, tool_calls: list, content: str) -> dict:
    """Pure scorer for one case given a model's normalized response.
    tool_calls: list of {"name": str, "arguments": str|dict}; content: assistant text.
    Returns {kind, format_valid, selection_ok, silent_ok}."""
    content = (content or "").strip().lower()
    has_tool = bool(tool_calls)
    out = {"kind": "", "format_valid": True, "selection_ok": False, "silent_ok": False}

    if expect.get("tool"):
        out["kind"] = "tool"
        if not has_tool:
            return out  # missed the tool; format not violated (just no call)
        ok_fmt, selected = True, set()
        for tc in tool_calls:
            name = tc.get("name")
            args = tc.get("arguments")
            selected.add(name)
            if name not in TOOL_NAMES:
                ok_fmt = False
            try:
                json.loads(args) if isinstance(args, str) else dict(args or {})
            except Exception:
                ok_fmt = False
        out["format_valid"] = ok_fmt
        out["selection_ok"] = expect["tool"] in selected
    elif expect.get("silent"):
        out["kind"] = "silent"
        out["silent_ok"] = (not has_tool) and content.startswith(SILENT_TOKEN)
    elif expect.get("answer"):
        out["kind"] = "answer"
        out["selection_ok"] = (not has_tool) and not content.startswith(SILENT_TOKEN)
    return out


def _model_configs():
    """Discover configured models from env. Each: {label, base_url, model, api_key}."""
    cfgs = []
    if os.environ.get("OPENAI_API_KEY"):
        cfgs.append({"label": "baseline:gpt-4o-mini", "base_url": None,
                     "model": "gpt-4o-mini", "api_key": os.environ["OPENAI_API_KEY"]})
    if os.environ.get("GROQ_API_KEY"):
        cfgs.append({"label": f"groq:{os.environ.get('GROQ_MODEL', 'llama-3.3-70b-versatile')}",
                     "base_url": "https://api.groq.com/openai/v1",
                     "model": os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
                     "api_key": os.environ["GROQ_API_KEY"]})
    if os.environ.get("CEREBRAS_API_KEY"):
        cfgs.append({"label": f"cerebras:{os.environ.get('CEREBRAS_MODEL', 'llama-3.3-70b')}",
                     "base_url": "https://api.cerebras.ai/v1",
                     "model": os.environ.get("CEREBRAS_MODEL", "llama-3.3-70b"),
                     "api_key": os.environ["CEREBRAS_API_KEY"]})
    if os.environ.get("GEMINI_API_KEY"):
        cfgs.append({"label": f"gemini:{os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')}",
                     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
                     "model": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                     "api_key": os.environ["GEMINI_API_KEY"]})
    return cfgs


async def _run_case(client, model: str, case: dict) -> dict:
    from openai import AsyncOpenAI  # noqa: F401 (client already constructed)
    persona = build_meeting_persona(workspace_name="The Boring People")
    res = await client.chat.completions.create(
        model=model, temperature=0, max_tokens=120,
        tools=MNEMA_TOOL_DEFINITIONS,
        messages=[{"role": "system", "content": persona},
                  {"role": "user", "content": case["utterance"]}],
    )
    msg = res.choices[0].message
    tool_calls = [{"name": tc.function.name, "arguments": tc.function.arguments}
                  for tc in (msg.tool_calls or [])]
    return evaluate_response(case["expect"], tool_calls, msg.content or "")


async def _run_model(cfg: dict) -> dict:
    from openai import AsyncOpenAI
    client = AsyncOpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"])
    rows = []
    for case in CASES:
        try:
            r = await _run_case(client, cfg["model"], case)
        except Exception as e:  # noqa: BLE001
            r = {"kind": "error", "format_valid": False, "selection_ok": False, "silent_ok": False, "error": str(e)[:80]}
        rows.append((case["id"], case["expect"], r))
    # score
    tool_cases = [r for _, e, r in rows if e.get("tool")]
    sel = sum(r["selection_ok"] for r in tool_cases)
    fmt = sum(r["format_valid"] for r in tool_cases)
    silent_cases = [r for _, e, r in rows if e.get("silent")]
    sil = sum(r["silent_ok"] for r in silent_cases)
    ans_cases = [r for _, e, r in rows if e.get("answer")]
    ans = sum(r["selection_ok"] for r in ans_cases)
    total = len(CASES)
    overall = (sel + sil + ans) / total if total else 0.0
    return {
        "label": cfg["label"],
        "tool_selection": f"{sel}/{len(tool_cases)}",
        "tool_format": f"{fmt}/{len(tool_cases)}",
        "silent": f"{sil}/{len(silent_cases)}",
        "answer": f"{ans}/{len(ans_cases)}",
        "overall": round(overall, 3),
        "rows": rows,
    }


async def main_async(dry_run: bool):
    errs = validate_schemas()
    print(f"Tool schemas: {len(MNEMA_TOOL_DEFINITIONS)} defs, {len(TOOL_NAMES)} names — "
          + ("OK" if not errs else f"{len(errs)} ERRORS"))
    for e in errs:
        print("  ✗", e)
    print(f"Cases: {len(CASES)} ("
          f"{sum(1 for c in CASES if c['expect'].get('tool'))} tool, "
          f"{sum(1 for c in CASES if c['expect'].get('silent'))} silent, "
          f"{sum(1 for c in CASES if c['expect'].get('answer'))} answer)")

    if dry_run:
        print("\n[dry-run] harness + schemas validated; no API calls made.")
        return 0 if not errs else 1

    cfgs = _model_configs()
    if not cfgs:
        print("\nNo model API keys set (OPENAI_API_KEY / GROQ_API_KEY / ...). Nothing to run.")
        return 1
    results = [await _run_model(c) for c in cfgs]
    print(f"\n{'model':32} {'tool_sel':9} {'fmt':7} {'silent':7} {'answer':7} {'overall':7}")
    baseline = next((r for r in results if r["label"].startswith("baseline")), None)
    for r in results:
        print(f"{r['label']:32} {r['tool_selection']:9} {r['tool_format']:7} {r['silent']:7} {r['answer']:7} {r['overall']:<7}")
    if baseline:
        print(f"\nGate (candidate overall >= baseline {baseline['overall']}):")
        for r in results:
            if r is baseline:
                continue
            verdict = "PASS" if r["overall"] >= baseline["overall"] else "FAIL"
            print(f"  {r['label']:32} {r['overall']}  →  {verdict}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="validate harness + schemas, no API calls")
    args = ap.parse_args()
    sys.exit(asyncio.run(main_async(args.dry_run)))


if __name__ == "__main__":
    main()
