# Realness harness — "is she real?" measurement for the Mnema meeting bot

Proves her answers are **grounded**, **honest**, free of the production **robotic failure
modes**, and **human in delivery** — and emits a scored `test_report.md`. **Measurement
only**; it never changes the agent.

It does **not** make a fresh bare LLM call. `turn.py` reuses the agent's OWN modules and
reproduces `RAGContext`'s addressed-turn path line-for-line (persona → prune → one-shot
briefs → `[Background]` → `[Speaking now]` → real tool loop → SilentGate → markdown strip).
Tool execution runs the agent's **real** handlers (`register_mnema_tools` /
`register_local_tools`), so dedup + per-turn cap + `normalize_tool_result` all apply exactly
as live. Scoring: deterministic asserts (markdown, tool-discipline, silence, tool-narration,
completeness) + an **independent judge LLM** (default `gpt-4o`) for the subjective rubrics
(grounded / honest / no-recitation / human-delivery).

## Run it (on the VPS — needs `infra/.env` secrets + the pipecat/mcp deps)

The harness must run where the real deps + secrets live: the `pipecat-meeting` image.
From the repo root on the VPS:

```bash
# 1) rebuild so the image has the current code (STEP1–5 + this harness) + deps
docker compose -f docker-compose.meeting.yml build pipecat-meeting

# 2) run the harness in a throwaway container (does NOT touch the live bot);
#    it inherits OPENAI_API_KEY / MNEMA_API_URL / MNEMA_API_KEY from infra/.env
mkdir -p realness_out
docker compose -f docker-compose.meeting.yml run --rm \
  -v "$PWD/realness_out:/out" -e REALNESS_OUT_DIR=/out -e JUDGE_MODEL=gpt-4o \
  pipecat-meeting python -m realness.run

# 3) read the outputs
cat realness_out/test_report.md
```

Outputs (in `realness_out/`): `ground_truth.json`, `answers.json` (raw answers verbatim),
`test_report.md` (per-question table, per-category pass rates, top-level realness score,
every FAIL with its exact failure mode).

Flags / env:
- `--quick` — fresh pass only, skip the 5-question context-bloat/drift pass.
- `JUDGE_MODEL` (default `gpt-4o`) — the independent judge model.
- `REALNESS_BOT_ID` — attach a real Recall bot id so the M0/M3 meeting briefs populate
  (otherwise those once-injections are simply empty — fine for this test).
- `MEETING_LLM_MODEL` / `MEETING_LLM_BASE_URL` — mirror a swapped agent model (defaults to
  the live `gpt-4o-mini`).

## What's tested where
- **Pure** (`questions.py`, `checks.py`, `report.py`) — unit-tested locally in
  `tests/test_realness_checks.py` (no live deps).
- **Live** (`turn.py`, `groundtruth.py`, `judge.py`, `run.py`) — only run in the container
  above (need `openai`, `mcp`, and `infra/.env`).

## Keep in sync
There is **no shared entrypoint** with the live bot by design (measurement only — the bot
stays untouched). If `RAGContext`'s addressed-turn order changes, update `turn.py` to match
(the correspondence is documented at the top of that file).
