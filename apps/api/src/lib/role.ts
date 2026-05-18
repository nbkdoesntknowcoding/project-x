import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { workspaceMembers } from '../db/schema.js';

/**
 * Application-layer role enforcement for `/api/*` route handlers.
 *
 * RLS doesn't know about roles — it only knows about `tenant_id`. Role
 * gating is therefore application-layer, called explicitly at each
 * protected endpoint. The surface is small (a few mutation endpoints in
 * 4.1, plus settings) so explicit > implicit.
 *
 * Strict ordering:
 *   viewer < editor < owner
 *
 * The `admin` enum value is reserved (Phase 5 may slot it between editor
 * and owner) but we never check for it in 4.1.
 */

export type Role = 'owner' | 'editor' | 'viewer';

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export class RoleError extends Error {
  constructor(
    public readonly reason: 'not_authenticated' | 'not_a_member' | string,
    public readonly status: number,
  ) {
    super(reason);
    this.name = 'RoleError';
  }
}

export async function getUserRole(
  userId: string,
  workspaceId: string,
): Promise<Role | null> {
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const r = rows[0]?.role;
  if (!r) return null;
  // The DB enum has 4 values (admin reserved); we narrow to the 3 we use.
  if (r === 'owner' || r === 'editor' || r === 'viewer') return r;
  // 'admin' or anything unexpected → treat as not a member for safety.
  return null;
}

/**
 * Throws RoleError if the request is unauthenticated, the user isn't a
 * member of the active tenant, or their role is below `minimumRole`.
 * Returns the actual role on success so callers can branch on it.
 */
export async function requireRole(
  req: FastifyRequest,
  minimumRole: Role,
): Promise<Role> {
  if (!req.auth) throw new RoleError('not_authenticated', 401);
  const role = await getUserRole(req.auth.sub, req.auth.tenant_id);
  if (!role) throw new RoleError('not_a_member', 403);
  if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) {
    throw new RoleError(`requires_${minimumRole}`, 403);
  }
  return role;
}
