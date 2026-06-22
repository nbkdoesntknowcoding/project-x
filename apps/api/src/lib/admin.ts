/**
 * Internal admin center gate + audit helper.
 *
 * Access is staff-only: the requester's email must match ADMIN_EMAIL_DOMAIN
 * (default theboringpeople.in) or be in the optional ADMIN_EMAILS allowlist.
 * Enforced server-side on every /api/admin/* route — the hidden UI is convenience
 * only, never the boundary.
 */
import type { FastifyRequest } from 'fastify';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { adminAuditLog } from '../db/schema.js';
import { RoleError } from './role.js';

const ALLOWLIST = new Set(
  (config.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.endsWith(`@${config.ADMIN_EMAIL_DOMAIN.toLowerCase()}`) || ALLOWLIST.has(e);
}

/** Throw 401 if unauthenticated, 403 if not staff. Call first in every admin handler. */
export function requireAdmin(req: FastifyRequest): { userId: string; email: string } {
  if (!req.auth) throw new RoleError('not_authenticated', 401);
  if (!isAdminEmail(req.auth.email)) throw new RoleError('admin_only', 403);
  return { userId: req.auth.sub, email: req.auth.email };
}

/** Append an immutable record of an admin action. Best-effort (never blocks the action). */
export async function logAdminAction(
  req: FastifyRequest,
  entry: { action: string; targetType?: string | null; targetId?: string | null; payload?: unknown },
): Promise<void> {
  try {
    await db.insert(adminAuditLog).values({
      actorUserId: req.auth?.sub ?? null,
      actorEmail: req.auth?.email ?? 'unknown',
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      payload: (entry.payload ?? null) as never,
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
    });
  } catch {
    /* audit is best-effort — never fail the action because logging failed */
  }
}
