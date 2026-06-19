#!/usr/bin/env bash
# restart-servers.sh — restart all Mnema local services
# Usage: ./scripts/restart-servers.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/mnema-api.log"

echo "▶ Restarting Mnema servers..."

# ── 1. Ensure Docker is running ───────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "  → Docker not running, launching Docker Desktop..."
  open -a Docker
  for i in $(seq 1 20); do
    sleep 3
    docker info >/dev/null 2>&1 && echo "  → Docker ready" && break
    [[ $i -eq 20 ]] && echo "✗ Docker failed to start after 60s" && exit 1
  done
else
  echo "  → Docker already running"
fi

# ── 2. Start Postgres + Redis containers ─────────────────────────────────────
echo "  → Starting Docker containers..."
cd "$PROJECT_ROOT"
docker compose up -d 2>&1 | grep -E "Running|Started|Created|Error" | sed 's/^/    /'

# ── 3. Kill any existing API server ──────────────────────────────────────────
echo "  → Stopping existing API server (port 8080)..."
lsof -ti :8080 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ── 4. Start API + collab + workers ──────────────────────────────────────────
echo "  → Starting API + collab + workers (log → $LOG_FILE)..."
cd "$PROJECT_ROOT/apps/api"
pnpm dev > "$LOG_FILE" 2>&1 &
API_PID=$!
echo "    PID: $API_PID"

# ── 5. Wait for health ────────────────────────────────────────────────────────
echo "  → Waiting for API to be healthy..."
for i in $(seq 1 15); do
  sleep 2
  STATUS=$(curl -s http://localhost:8080/health 2>/dev/null || true)
  if echo "$STATUS" | grep -q '"status":"healthy"'; then
    echo "  → Local API healthy"
    break
  fi
  [[ $i -eq 15 ]] && echo "✗ API not healthy after 30s — check $LOG_FILE" && exit 1
done

# ── 6. Tunnel check ───────────────────────────────────────────────────────────
TUNNEL=$(curl -s https://api.theboringpeople.in/health 2>/dev/null || true)
if echo "$TUNNEL" | grep -q '"status":"healthy"'; then
  echo "  → Tunnel healthy"
else
  echo "  ⚠ Tunnel may need a moment (Cloudflare reconnect)"
fi

echo ""
echo "✅ All Mnema servers running. Restart Claude Desktop to reconnect MCP tools."
