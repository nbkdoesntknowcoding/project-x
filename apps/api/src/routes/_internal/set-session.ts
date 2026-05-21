import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import { workspaceMembers } from '../../db/schema.js';
import { signJwt } from '../../lib/jwt.js';
import { scopesForRole } from '../../lib/scopes.js';
import { bootstrapUserAndWorkspace } from '../../lib/workspace.js';

const bodySchema = z.object({
  internal_secret: z.string(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  workos_user_id: z.string(),
});

export const setSessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/_internal/set-session', async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    if (parsed.data.internal_secret !== config.WORKOS_COOKIE_PASSWORD) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const { user_id, tenant_id } = await bootstrapUserAndWorkspace({
      email: parsed.data.email,
      displayName: parsed.data.display_name,
    });

    // Look up the user's role in the bootstrapped workspace so the JWT
    // includes workspace:write for owner/admin/editor (Phase 9.1).
    const memberRows = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, user_id),
          eq(workspaceMembers.workspaceId, tenant_id),
        ),
      )
      .limit(1);
    const role = memberRows[0]?.role ?? 'viewer';

    const jwt = await signJwt({
      sub: user_id,
      tenant_id,
      scopes: scopesForRole(role),
      email: parsed.data.email,
    });

    return { user_id, tenant_id, jwt };
  });
};
