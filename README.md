# BOPPL Live Context Engine

The Live Context Engine for AI workflows — productized writing surface that publishes
context to MCP-aware clients (Claude.ai and others). This repo is a pnpm monorepo
covering the API (Fastify), the web app (Astro + React 19), and a shared TS package.

## Local-only build

This repository is **local-only** until the maintainer issues an explicit deployment
command. No prompt or script in this codebase will provision cloud resources, push
secrets, or configure custom domains. Deployment is **Phase D** in
[`BOPPL_Context_Engine_Claude_Code_Master_Outline.md`](./BOPPL_Context_Engine_Claude_Code_Master_Outline.md)
and only runs when the maintainer says so.

Running services and ports:

| Service | URL |
| --- | --- |
| Astro web | http://localhost:5173 |
| Fastify API | http://localhost:8080 |
| Postgres 16 + pgvector | localhost:5432 |
| Redis 7 | localhost:6379 |

## Setup

Prerequisites: Node 22 (use `nvm use`), pnpm 9+, Docker Desktop with Compose v2.

```bash
nvm use                      # Node 22
pnpm install
cp .env.example .env         # required before first run
docker compose up -d         # Postgres + Redis
pnpm db:migrate              # apply schema with RLS
pnpm dev                     # api + web in parallel
```

Verify the stack:

```bash
curl -s http://localhost:8080/health | jq
# { "status": "healthy", "services": { "database": true, "redis": true }, ... }

open http://localhost:5173   # placeholder landing page
```

## Useful commands

```bash
pnpm dev            # run api + web together
pnpm typecheck      # all workspaces
pnpm lint           # all workspaces
pnpm format         # prettier write across the repo
pnpm db:migrate     # apply pending Drizzle migrations
pnpm db:studio      # open Drizzle Studio against the local DB
docker compose down # stop services (volumes persist)
```

## Layout

```
apps/
  api/          Fastify + Drizzle + Pino (Node ESM)
  web/          Astro 5 + React 19 islands + Tailwind v4 tokens
packages/
  shared/       Cross-package TypeScript types
```

## Deployment

There are no deployment instructions in this README on purpose. See the
"Phase D — Deployment" section of the master outline; those prompts execute
**only** when the maintainer types the explicit deploy command.
