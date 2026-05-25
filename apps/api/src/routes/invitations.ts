import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { invitations, users, workspaceMembers, workspaces } from '../db/schema.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import { withTenant } from '../db/with-tenant.js';
import { emailQueue } from '../queue/email.js';
import { signInvitationToken, verifyInvitationToken } from '../lib/invitation-token.js';
import { signJwt } from '../lib/jwt.js';
import { requireRole, RoleError } from '../lib/role.js';

const JWT_COOKIE = 'boppl_jwt';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;
const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

const createSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'editor', 'viewer']),
});

const acceptSchema = z.object({
  token: z.string().min(1),
});

const lookupSchema = z.object({
  token: z.string().min(1),
});

export const invitationsRoutes: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------------
  // POST /api/invitations — create a new invitation. Editor-or-higher
  // required. Only owners can create owners.
  //
  // Two collision checks before issuing the token:
  //   1. The email is not already a member of this workspace.
  //   2. No pending invitation for this email already exists.
  // Both return 409 — the UI distinguishes via the reason code.
  // ------------------------------------------------------------------------
  app.post('/api/invitations', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      await requireRole(req, 'editor');
    } catch (err) {
      if (err instanceof RoleError) {
        return reply.code(err.status).send({ error: err.reason });
      }
      throw err;
    }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    // Editors can invite editors/viewers; only owners can create owners.
    if (parsed.data.role === 'owner') {
      try {
        await requireRole(req, 'owner');
      } catch (err) {
        if (err instanceof RoleError) {
          return reply.code(err.status).send({ error: 'requires_owner_to_invite_owner' });
        }
        throw err;
      }
    }

    const email = parsed.data.email.toLowerCase();

    // Already-a-member check. Runs against the global users + memberships
    // join (no tenant GUC needed — citext email uniqueness covers it).
    const existingMember = await db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(users.email, email),
          eq(workspaceMembers.workspaceId, req.auth.tenant_id),
        ),
      )
      .limit(1);
    if (existingMember.length > 0) {
      return reply.code(409).send({ error: 'already_a_member' });
    }

    // Pending-invitation check. Tenant-scoped via withTenant.
    const existingPending = await withTenant(req.auth.tenant_id, async (tx) =>
      tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(
          and(
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .limit(1),
    );
    if (existingPending.length > 0) {
      return reply.code(409).send({ error: 'already_invited' });
    }

    const { token, jti } = await signInvitationToken({
      workspace_id: req.auth.tenant_id,
      email,
      role: parsed.data.role,
      invited_by: req.auth.sub,
    });

    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    // Pull inviter + workspace metadata for the email template. These run
    // against the global tables (users isn't tenant-scoped; workspaces by
    // id is fine without GUC for read-only).
    const inviterRows = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, req.auth.sub))
      .limit(1);
    const wsRows = await db
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    const [inserted] = await withTenant(req.auth.tenant_id, async (tx) =>
      tx
        .insert(invitations)
        .values({
          workspaceId: req.auth!.tenant_id,
          email,
          role: parsed.data.role,
          invitedBy: req.auth!.sub,
          tokenJti: jti,
          expiresAt,
        })
        .returning(),
    );

    const inviterName =
      inviterRows[0]?.displayName || inviterRows[0]?.email || 'A teammate';
    const acceptUrl = `${config.WEB_BASE_URL}/invite/${token}`;
    // Enqueue via BullMQ so the HTTP response returns immediately.
    await emailQueue.add('invitation', {
      type: 'invitation',
      to: parsed.data.email,
      params: {
        inviterName,
        workspaceName: wsRows[0]?.name ?? 'a workspace',
        acceptUrl,
      },
    });

    return {
      invitation: {
        id: inserted!.id,
        email: parsed.data.email,
        role: parsed.data.role,
        expires_at: expiresAt.toISOString(),
      },
    };
  });

  // ------------------------------------------------------------------------
  // GET /api/invitations — list pending invitations for the active tenant.
  // Editor-or-higher. (Viewers don't see pending invites at all.)
  // ------------------------------------------------------------------------
  app.get('/api/invitations', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      await requireRole(req, 'editor');
    } catch (err) {
      if (err instanceof RoleError) {
        return reply.code(err.status).send({ error: err.reason });
      }
      throw err;
    }

    const rows = await withTenant(req.auth.tenant_id, async (tx) =>
      tx
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
          invitedBy: invitations.invitedBy,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt)),
        )
        .orderBy(invitations.createdAt),
    );

    return { invitations: rows };
  });

  // ------------------------------------------------------------------------
  // DELETE /api/invitations/:id — revoke a pending invitation. Editor+.
  // Sets revoked_at; the token is now permanently dead (the accept-flow
  // checks for revoked_at IS NULL).
  // ------------------------------------------------------------------------
  app.delete('/api/invitations/:id', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      await requireRole(req, 'editor');
    } catch (err) {
      if (err instanceof RoleError) {
        return reply.code(err.status).send({ error: err.reason });
      }
      throw err;
    }

    const { id } = req.params as { id: string };

    const result = await withTenant(req.auth.tenant_id, async (tx) =>
      tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id }),
    );

    if (result.length === 0) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return { revoked: true };
  });

  // ------------------------------------------------------------------------
  // GET /api/invitations/lookup?token=... — unauthenticated preview.
  // Shows the invitee the workspace name + inviter so they can decide
  // whether to sign in and accept. Uses withSystemPrivilege because the
  // viewer is not (yet) a member of any tenant.
  //
  // Surfaces precise error reasons (404/410) so the UI can render the
  // right "expired" / "revoked" / "already accepted" copy.
  // ------------------------------------------------------------------------
  app.get('/api/invitations/lookup', async (req, reply) => {
    const parsed = lookupSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    let claims;
    try {
      claims = await verifyInvitationToken(parsed.data.token);
    } catch {
      return reply.code(400).send({ error: 'invalid_token' });
    }

    const inviteRow = await withSystemPrivilege(async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          workspaceId: invitations.workspaceId,
          email: invitations.email,
          role: invitations.role,
          invitedBy: invitations.invitedBy,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          expiresAt: invitations.expiresAt,
        })
        .from(invitations)
        .where(eq(invitations.tokenJti, claims.jti))
        .limit(1);
      return rows[0];
    });

    if (!inviteRow) return reply.code(404).send({ error: 'not_found' });
    if (inviteRow.acceptedAt) return reply.code(410).send({ error: 'already_accepted' });
    if (inviteRow.revokedAt) return reply.code(410).send({ error: 'revoked' });
    if (inviteRow.expiresAt < new Date()) return reply.code(410).send({ error: 'expired' });

    // Fetch workspace + inviter under system privilege for the same reason
    // (no tenant context yet). Read-only — narrow access.
    const ws = await withSystemPrivilege(async (tx) =>
      (
        await tx
          .select({ name: workspaces.name, slug: workspaces.slug })
          .from(workspaces)
          .where(eq(workspaces.id, inviteRow.workspaceId))
          .limit(1)
      )[0],
    );
    const inviter = await withSystemPrivilege(async (tx) =>
      (
        await tx
          .select({ displayName: users.displayName, email: users.email })
          .from(users)
          .where(eq(users.id, inviteRow.invitedBy))
          .limit(1)
      )[0],
    );

    return {
      workspace_name: ws?.name,
      workspace_slug: ws?.slug,
      inviter_name: inviter?.displayName || inviter?.email,
      email: inviteRow.email,
      role: inviteRow.role,
    };
  });

  // ------------------------------------------------------------------------
  // POST /api/invitations/accept — accept an invitation. Caller MUST be
  // signed in AND their email MUST match the invitation's email.
  //
  // The email-match check is a hard non-negotiable: a user signed in as A
  // cannot accept an invitation addressed to B. Without this, a leaked
  // invitation URL would give any signed-in user access.
  //
  // Inserts the workspace_members row, marks the invitation accepted,
  // re-mints the JWT scoped to the newly-joined workspace, sets the cookie.
  // ------------------------------------------------------------------------
  app.post('/api/invitations/accept', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized_must_be_signed_in' });
    }

    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    let claims;
    try {
      claims = await verifyInvitationToken(parsed.data.token);
    } catch {
      return reply.code(400).send({ error: 'invalid_token' });
    }

    // Hard email-match: signed-in user's email must equal the invitation's
    // email (case-insensitive). Don't weaken.
    if (req.auth.email.toLowerCase() !== claims.email.toLowerCase()) {
      return reply.code(403).send({ error: 'email_mismatch' });
    }

    const result = await withSystemPrivilege(async (tx) => {
      const rows = await tx
        .select({
          id: invitations.id,
          workspaceId: invitations.workspaceId,
          email: invitations.email,
          role: invitations.role,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          expiresAt: invitations.expiresAt,
        })
        .from(invitations)
        .where(eq(invitations.tokenJti, claims.jti))
        .limit(1);

      const row = rows[0];
      if (!row) return { error: 'not_found' as const };
      if (row.acceptedAt) return { error: 'already_accepted' as const };
      if (row.revokedAt) return { error: 'revoked' as const };
      if (row.expiresAt < new Date()) return { error: 'expired' as const };

      // Idempotent on conflict — if the user is somehow already a member
      // (e.g., manual psql intervention) we don't error.
      await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: row.workspaceId,
          userId: req.auth!.sub,
          role: row.role,
        })
        .onConflictDoNothing();

      await tx
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedBy: req.auth!.sub })
        .where(eq(invitations.id, row.id));

      return { workspace_id: row.workspaceId };
    });

    if ('error' in result) {
      return reply.code(410).send({ error: result.error });
    }

    const jwt = await signJwt({
      sub: req.auth.sub,
      tenant_id: result.workspace_id,
      email: req.auth.email,
      scopes: ['docs:read'],
    });
    reply.setCookie(JWT_COOKIE, jwt, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SEC,
    });

    return { workspace_id: result.workspace_id };
  });
};
