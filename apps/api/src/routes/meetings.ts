/**
 * Meetings + post-meeting identity mapping (Phase 2b).
 *
 *   GET  /api/meetings                                   recent meetings + counts
 *   GET  /api/meetings/:id/participants                  attendees + resolution status
 *   POST /api/meetings/:id/participants/:pid/identity    map an attendee → a Mnema user
 *
 * Mapping writes a participant_aliases row (display_name → user) so the same person
 * is recognised by name in EVERY future meeting, and back-fills resolved_user_id on
 * any matching unresolved attendee. Reads are viewer+; mapping is editor+ (it's an
 * identity assertion that grants that name the mapped user's access).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  meetingParticipants,
  meetings,
  participantAliases,
  users,
  workspaceMembers,
} from '../db/schema.js';
import { requireRole, RoleError } from '../lib/role.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const identitySchema = z.object({ user_id: z.string().uuid() });

export const meetingsRoutes: FastifyPluginAsync = async (app) => {
  function roleGuard(err: unknown, reply: import('fastify').FastifyReply): boolean {
    if (err instanceof RoleError) {
      reply.code(err.status).send({ error: err.reason });
      return true;
    }
    return false;
  }

  // ── GET /api/meetings ──────────────────────────────────────────────────────
  app.get('/api/meetings', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    try { await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const rows = await db.execute(sql`
      SELECT m.id, m.meeting_url, m.started_at, m.ended_at,
             count(mp.id)::int AS participant_count,
             count(mp.id) FILTER (WHERE mp.resolved_user_id IS NULL)::int AS unresolved_count
      FROM meetings m
      LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id
      WHERE m.workspace_id = ${req.auth.tenant_id}::uuid
      GROUP BY m.id
      ORDER BY m.started_at DESC
      LIMIT 50`);
    return reply.send({ meetings: rows });
  });

  // ── GET /api/meetings/:id/participants ─────────────────────────────────────
  app.get('/api/meetings/:id/participants', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });

    const rows = await db
      .select({
        id:             meetingParticipants.id,
        name:           meetingParticipants.name,
        email:          meetingParticipants.email,
        isHost:         meetingParticipants.isHost,
        resolvedUserId: meetingParticipants.resolvedUserId,
        resolvedEmail:  users.email,
        resolvedName:   users.displayName,
      })
      .from(meetingParticipants)
      .leftJoin(users, eq(users.id, meetingParticipants.resolvedUserId))
      .where(eq(meetingParticipants.meetingId, id));
    return reply.send({ participants: rows });
  });

  // ── POST /api/meetings/:id/participants/:pid/identity ──────────────────────
  app.post('/api/meetings/:id/participants/:pid/identity', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id, pid } = req.params as { id: string; pid: string };
    if (!UUID_RE.test(id) || !UUID_RE.test(pid)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'editor'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const parsed = identitySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation' });
    const targetUserId = parsed.data.user_id;
    const tenant = req.auth.tenant_id;

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, tenant)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });

    const participant = await db.query.meetingParticipants.findFirst({
      where: and(eq(meetingParticipants.id, pid), eq(meetingParticipants.meetingId, id)),
    });
    if (!participant) return reply.code(404).send({ error: 'participant_not_found' });
    if (!participant.name) return reply.code(400).send({ error: 'participant_has_no_name' });

    // Target must be a member of this workspace.
    const member = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, targetUserId), eq(workspaceMembers.workspaceId, tenant)))
      .limit(1);
    if (!member[0]) return reply.code(400).send({ error: 'not_a_workspace_member' });

    // Save the name→user alias (recognised in every future meeting).
    await db
      .insert(participantAliases)
      .values({ workspaceId: tenant, displayName: participant.name, userId: targetUserId, createdBy: req.auth.sub })
      .onConflictDoUpdate({
        target: [participantAliases.workspaceId, participantAliases.displayName],
        set: { userId: targetUserId, createdBy: req.auth.sub },
      });

    // Back-fill this participant and any other unresolved attendee with the same
    // name in this workspace's meetings.
    await db
      .update(meetingParticipants)
      .set({ resolvedUserId: targetUserId })
      .where(
        and(
          eq(meetingParticipants.name, participant.name),
          isNull(meetingParticipants.resolvedUserId),
          sql`${meetingParticipants.meetingId} IN (SELECT id FROM meetings WHERE workspace_id = ${tenant}::uuid)`,
        ),
      );

    return reply.send({ ok: true });
  });
};
