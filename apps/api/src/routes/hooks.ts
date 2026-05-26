/**
 * Hook receiver routes — Phase 1 AgentLens Task Layer.
 *
 * POST /api/hooks/claude-code — receives events from Claude Code hooks.
 *   Auth: Bearer token validated against workspaces.hook_token (SHA-256 hash).
 *   Fail-open: ALWAYS returns 202 so the agent is never blocked.
 *   Rate limit: 120 req/min per IP.
 *
 * POST /api/hooks/aider, /cursor, /generic — Phase 2 stubs (always 202).
 *
 * GET /install/claude-hooks.sh — installer shell script.
 *
 * Phase 2 will: parse full HookEvent, enqueue to BullMQ, process tool_calls,
 * cost_events, file_diffs. Route signatures won't change.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { agentSessions, workspaces } from '../db/schema.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import { verifyHookToken } from '../lib/dev/hook-token.js';
import { withTenant } from '../db/with-tenant.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;

// Simple in-memory rate limiter (per-IP). Phase 2 swaps to Redis.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true; // OK
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

export const hooksRoutes: FastifyPluginAsync = async (app) => {
  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/hooks/claude-code
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/hooks/claude-code', async (req, reply) => {
    const ip = req.ip;

    // Rate limit — 429 is the only non-202 response; still fail-open for the agent
    if (!checkRateLimit(ip)) {
      return reply.code(429).send({ message: 'Rate limit exceeded. The agent is still working.' });
    }

    // Extract Bearer token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

    if (!token) {
      // Fail-open: no token → 202 with a warning (agent misconfigured, not blocked)
      req.log.warn({ ip }, 'hooks/claude-code: missing Bearer token — failing open');
      return reply.code(202).send({ ok: true });
    }

    // Find workspace where hash(token) === hookToken.
    // We must scan under system privilege since hook_token isn't tenant-scoped.
    let workspaceId: string | null = null;
    try {
      const wsRows = await withSystemPrivilege(async (tx) =>
        tx
          .select({ id: workspaces.id, hookToken: workspaces.hookToken })
          .from(workspaces)
          .where(eq(workspaces.mode, 'dev_project'))
          .limit(200), // bounded scan — dev workspaces are rare
      );

      for (const ws of wsRows) {
        if (ws.hookToken && verifyHookToken(token, ws.hookToken)) {
          workspaceId = ws.id;
          break;
        }
      }
    } catch (err) {
      req.log.warn({ err }, 'hooks/claude-code: DB error during token validation — failing open');
      return reply.code(202).send({ ok: true });
    }

    if (!workspaceId) {
      req.log.warn({ ip }, 'hooks/claude-code: no matching workspace for token — failing open');
      return reply.code(202).send({ ok: true });
    }

    // Extract session id + developer id from body (Phase 1: minimal processing)
    const body = (req.body as Record<string, unknown>) ?? {};
    const rawSessionId = typeof body.session_id === 'string' ? body.session_id : null;
    const developerId = typeof body.developer_id === 'string' ? body.developer_id : 'unknown';

    // Upsert agent session (Phase 1: create if missing)
    try {
      if (rawSessionId) {
        // Try to update existing session by matching developer_id + workspace
        const existing = await withTenant(workspaceId, async (tx) =>
          tx
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(eq(agentSessions.id, rawSessionId))
            .limit(1),
        );
        if (existing[0]) {
          // Session exists — keep it alive (Phase 2 will update last_event_at)
        } else {
          // Create new session with the given id hint (best-effort)
          await withTenant(workspaceId, async (tx) =>
            tx.insert(agentSessions).values({
              workspaceId,
              developerId,
              agent: 'claude_code',
              status: 'active',
            }).onConflictDoNothing(),
          );
        }
      } else {
        // No session id — create a new session
        await withTenant(workspaceId, async (tx) =>
          tx.insert(agentSessions).values({
            workspaceId,
            developerId,
            agent: 'claude_code',
            status: 'active',
          }),
        );
      }
    } catch (err) {
      // Fail-open: session upsert error never blocks the agent
      req.log.warn({ err, workspaceId }, 'hooks/claude-code: session upsert failed — failing open');
    }

    // Always 202 — never block the agent
    return reply.code(202).send({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Stub adapters for Phase 2
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/hooks/aider', async (_req, reply) => {
    return reply.code(202).send({ message: 'Adapter coming in Phase 2' });
  });

  app.post('/api/hooks/cursor', async (_req, reply) => {
    return reply.code(202).send({ message: 'Adapter coming in Phase 2' });
  });

  app.post('/api/hooks/generic', async (_req, reply) => {
    return reply.code(202).send({ message: 'Generic adapter coming in Phase 2' });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /install/claude-hooks.sh — shell script installer
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/install/claude-hooks.sh', async (_req, reply) => {
    const script = `#!/bin/bash
# Mnema Claude Code hook installer
# Usage: MNEMA_HOOK_TOKEN=mnema_hook_xxx MNEMA_WORKSPACE_ID=ws_xxx bash <(curl -sf https://mnema.theboringpeople.in/install/claude-hooks.sh)

if [ -z "$MNEMA_HOOK_TOKEN" ] || [ -z "$MNEMA_WORKSPACE_ID" ]; then
  echo "Error: MNEMA_HOOK_TOKEN and MNEMA_WORKSPACE_ID must be set"
  exit 1
fi

HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/mnema-post-tool.sh" << 'HOOK'
#!/bin/bash
# Mnema AgentLens hook — fires after every Claude Code tool call
curl -sf -X POST "https://mnema.theboringpeople.in/api/hooks/claude-code" \\
  -H "Authorization: Bearer $MNEMA_HOOK_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"event\\": \\"tool_call\\",
    \\"session_id\\": \\"$CLAUDE_SESSION_ID\\",
    \\"developer_id\\": \\"$MNEMA_DEVELOPER_ID\\",
    \\"tool\\": \\"$CLAUDE_TOOL_NAME\\",
    \\"workspace_id\\": \\"$MNEMA_WORKSPACE_ID\\"
  }" > /dev/null 2>&1 &
# Background fork — never block Claude Code
HOOK

chmod +x "$HOOKS_DIR/mnema-post-tool.sh"

echo "\\n✓ Mnema hooks installed at $HOOKS_DIR/mnema-post-tool.sh"
echo "\\n  Add to your shell profile (~/.zshrc or ~/.bashrc):"
echo "  export MNEMA_HOOK_TOKEN=\\$MNEMA_HOOK_TOKEN"
echo "  export MNEMA_DEVELOPER_ID=<your-name-or-machine-id>"
echo "  export MNEMA_WORKSPACE_ID=\\$MNEMA_WORKSPACE_ID"
echo ""
echo "  Then configure Claude Code to run the hook on PostToolUse."
`;

    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(script);
  });
};
