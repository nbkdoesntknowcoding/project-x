#!/usr/bin/env bash
# Runs ON the VPS — called by GitHub Actions over SSH.
# Safe: only touches mnema-prod containers. Never runs host-wide prune commands.
set -euo pipefail

REPO_DIR="/srv/mnema"
cd "$REPO_DIR"

echo "==> Pulling latest code..."
git fetch --all --prune
git reset --hard origin/main

export DOCKER_BUILDKIT=0   # reuses cached base layers — avoids Docker Hub TLS timeouts

C="docker compose -f infra/docker-compose.prod.yml --env-file infra/.env"

echo "==> Building images (with retry)..."
built=0
for attempt in 1 2 3; do
  $C build api collab workers && { built=1; break; }
  echo "Build attempt ${attempt} failed — retrying in 20s..."
  sleep 20
done
[ "${built}" = 1 ] || { echo "ERROR: build failed after 3 attempts" >&2; exit 1; }

echo "==> Deploying..."
$C up -d api collab workers

# Prune only dangling images for this build — never docker image prune -a
docker image prune -f

echo "==> Done: $(git rev-parse --short HEAD)"
