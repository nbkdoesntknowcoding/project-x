import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { withTenant } from '../db/with-tenant.js';
import { workspaceMembers, workspaces } from '../db/schema.js';

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/auth/me', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { sub: userId, tenant_id, email, scopes } = req.auth;

    const result = await withTenant(tenant_id, async (tx) => {
      const wsRows = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, tenant_id))
        .limit(1);
      const memberRows = await tx
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, tenant_id))
        .limit(1);
      return { workspace: wsRows[0], role: memberRows[0]?.role };
    });

    return {
      user: { id: userId, email },
      workspace: result.workspace,
      role: result.role,
      scopes,
    };
  });
};
