import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Walk up from this file to find the nearest .env (repo root or app root).
const here = dirname(fileURLToPath(import.meta.url));
let dir = here;
for (let i = 0; i < 6; i++) {
  const candidate = resolve(dir, '.env');
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(8080),
  COLLAB_PORT: z.coerce.number().int().positive().default(1234),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // WorkOS
  WORKOS_API_KEY: z.string().min(1),
  WORKOS_CLIENT_ID: z.string().min(1),
  WORKOS_REDIRECT_URI: z.string().url(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().url(),
  // MCP audience accepted on Bearer tokens. Local dev accepts both the REST
  // audience (so the existing /api/_internal/set-session JWT works directly
  // in the Inspector) and the MCP audience. Phase D narrows this to MCP-only
  // once WorkOS-issued tokens replace the local-secret path.
  JWT_AUDIENCE_MCP: z.string().url().default('http://localhost:8080/mcp'),

  // MCP (Phase 2.1)
  // The wire-protocol version we advertise on initialize.
  MCP_PROTOCOL_VERSION: z.string().min(1).default('2025-11-25'),
  // The canonical externally-visible URL of the api process. The MCP resource
  // identifier is `${MCP_BASE_URL}/mcp`; the protected-resource metadata
  // refers to it; tokens from the AS are expected to carry this as audience.
  MCP_BASE_URL: z.string().url().default('http://localhost:8080'),
  // The Authorization Server URL advertised in protected-resource metadata.
  // Phase 2.1 ships a placeholder so the route is testable; Phase 2.2 swaps
  // in the actual WorkOS AS URL once we wire DCR.
  MCP_AUTHORIZATION_SERVER: z.string().url().default('http://localhost:8080'),
  // Origins permitted to POST to /mcp. Comma-separated. Browser clients only;
  // the claude.ai connector and MCP Inspector are explicitly listed.
  MCP_ORIGIN_ALLOWLIST: z
    .string()
    .default('http://localhost:5173,http://localhost:6274'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
