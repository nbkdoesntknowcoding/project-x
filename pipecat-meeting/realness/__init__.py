"""
realness/ — the "is she real?" measurement harness for the Mnema meeting bot.

Proves her answers are grounded, honest, free of the production robotic failure modes,
and human in delivery. MEASUREMENT ONLY — never changes agent behaviour.

It runs the SAME response path the live bot uses by importing and orchestrating the REAL
modules (meeting_persona, context_prune, mnema_client tools, text_norm, markdown_stream,
silence, addressing, tool_guard, local_tools) in the same order RAGContext does — see
turn.py, which documents the line-for-line correspondence. It is NOT a fresh bare LLM call.

Layout:
  questions.py   — the embedded 23-question set + per-question rubric applicability (pure)
  checks.py      — deterministic rubric scorers: markdown, tool-discipline, silence,
                   tool-narration, completeness, human-delivery heuristic (pure)
  report.py      — renders test_report.md from results (pure)
  turn.py        — faithful turn-path mirror (LIVE: needs mcp/openai/secrets — VPS only)
  groundtruth.py — STEP 1: build ground_truth.json from the real workspace (LIVE)
  judge.py       — STEP 4: independent LLM-as-judge for subjective rubrics (LIVE)
  run.py         — orchestrator / entrypoint (LIVE)

The pure modules (questions/checks/report) are unit-tested in tests/test_realness_checks.py
without any live deps; the LIVE modules only run where pipecat's deps + infra/.env secrets
exist (the pipecat-meeting container / the VPS).
"""
