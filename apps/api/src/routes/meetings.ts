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
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import {
  docs,
  folders,
  meetingParticipants,
  meetings,
  meetingTranscripts,
  participantAliases,
  projects,
  tasks,
  users,
  workspaceMembers,
} from '../db/schema.js';
import { requireRole, RoleError } from '../lib/role.js';
import { enqueuePreBrief } from '../queue/meeting-end.js';
import { syncMeetingNode } from '../lib/graph/meeting-graph.js';

/**
 * Ask the meeting-bot controller to send the Mnema bot into a meeting. Returns
 * true on success. Never throws — a bot-join failure must not fail the caller's
 * action (admit still succeeds; the meeting folder/docs are still created).
 */
async function dispatchBot(meeting: { id: string; workspaceId: string; meetingUrl: string | null }): Promise<boolean> {
  if (!meeting.meetingUrl) return false;
  try {
    const res = await fetch(`${config.MEETING_BOT_INTERNAL_URL}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meetingUrl: meeting.meetingUrl,
        meetingId: meeting.id,
        workspaceId: meeting.workspaceId,
        apiKey: config.MNEMA_MEETING_BOT_API_KEY,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
    let role;
    try { role = await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    // Visibility: workspace owners/admins see every member's meetings; everyone else sees
    // ONLY meetings they organize (meetings.organizer_user_id = them). Own meetings are always
    // visible. The frontend per-person filter is bounded by this — a non-admin only ever has
    // their own to filter.
    const isAdmin = role === 'owner' || role === 'admin';
    const scope = isAdmin
      ? sql``
      : sql`AND m.organizer_user_id = ${req.auth.sub}::uuid`;

    const rows = await db.execute(sql`
      SELECT m.id, m.title, m.meeting_url, m.started_at, m.ended_at,
             m.scheduled_start_at, m.scheduled_end_at, m.status, m.admitted, m.calendar_event_id,
             m.transcript_status, m.post_meeting_doc_id, (m.summary IS NOT NULL) AS has_summary,
             m.organizer_user_id,
             COALESCE(u.display_name, u.email) AS organizer_name,
             count(mp.id)::int AS participant_count,
             count(mp.id) FILTER (WHERE mp.resolved_user_id IS NULL)::int AS unresolved_count
      FROM meetings m
      LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id
      LEFT JOIN users u ON u.id = m.organizer_user_id
      WHERE m.workspace_id = ${req.auth.tenant_id}::uuid
        ${scope}
      GROUP BY m.id, u.display_name, u.email
      ORDER BY COALESCE(m.scheduled_start_at, m.started_at) DESC
      LIMIT 100`);
    return reply.send({ meetings: rows, viewer_can_see_all: isAdmin, viewer_user_id: req.auth.sub });
  });

  // ── GET /api/meetings/:id ──────────────────────────────────────────────────
  // Full detail for one meeting: summary (key points / decisions / action items),
  // transcript availability, and the linked post-meeting doc/folder. Viewer+.
  app.get('/api/meetings/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    let role;
    try { role = await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });
    // Non-admins may only read their own meetings (mirrors the list-endpoint visibility gate).
    if (role !== 'owner' && role !== 'admin' && meeting.organizerUserId && meeting.organizerUserId !== req.auth.sub) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Tasks auto-created from this meeting (with assignee name).
    const taskRows = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, assigneeName: users.displayName, assigneeEmail: users.email })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assignedMemberId))
      .where(and(eq(tasks.meetingId, meeting.id), eq(tasks.workspaceId, req.auth.tenant_id)));

    // Linked (related) meetings — resolve ids → titles.
    const linkedIds = (meeting.linkedMeetingIds ?? []).filter((x): x is string => !!x);
    const linked = linkedIds.length
      ? await db.select({ id: meetings.id, title: meetings.title, started_at: meetings.startedAt, scheduled_start_at: meetings.scheduledStartAt })
          .from(meetings).where(and(eq(meetings.workspaceId, req.auth.tenant_id), inArray(meetings.id, linkedIds)))
      : [];

    let projectName: string | null = null;
    if (meeting.projectId) {
      const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, meeting.projectId)).limit(1);
      projectName = p?.name ?? null;
    }

    return reply.send({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        meeting_url: meeting.meetingUrl,
        started_at: meeting.startedAt,
        ended_at: meeting.endedAt,
        scheduled_start_at: meeting.scheduledStartAt,
        scheduled_end_at: meeting.scheduledEndAt,
        status: meeting.status,
        admitted: meeting.admitted,
        summary: meeting.summary ?? null,
        transcript_status: meeting.transcriptStatus ?? 'none',
        post_meeting_doc_id: meeting.postMeetingDocId,
        pre_meeting_doc_id: meeting.preMeetingDocId,
        meeting_folder_id: meeting.meetingFolderId,
        project_id: meeting.projectId,
        project_name: projectName,
      },
      tasks: taskRows.map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assigneeName || t.assigneeEmail || null })),
      linked_meetings: linked,
    });
  });

  // ── GET /api/meetings/:id/transcript ───────────────────────────────────────
  // Transcript turns, ordered. Visible to any workspace member (viewer+).
  app.get('/api/meetings/:id/transcript', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    let role;
    try { role = await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });
    // Non-admins may only read their own meetings (mirrors the list-endpoint visibility gate).
    if (role !== 'owner' && role !== 'admin' && meeting.organizerUserId && meeting.organizerUserId !== req.auth.sub) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const turns = await db
      .select({
        seq: meetingTranscripts.seq,
        speaker: meetingTranscripts.speaker,
        text: meetingTranscripts.text,
        tsMs: meetingTranscripts.tsMs,
      })
      .from(meetingTranscripts)
      .where(eq(meetingTranscripts.meetingId, id))
      .orderBy(asc(meetingTranscripts.seq));

    return reply.send({ status: meeting.transcriptStatus ?? 'none', turns });
  });

  // ── GET /api/meetings/:id/participants ─────────────────────────────────────
  app.get('/api/meetings/:id/participants', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    let role;
    try { role = await requireRole(req, 'viewer'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });
    // Non-admins may only read their own meetings (mirrors the list-endpoint visibility gate).
    if (role !== 'owner' && role !== 'admin' && meeting.organizerUserId && meeting.organizerUserId !== req.auth.sub) {
      return reply.code(404).send({ error: 'not_found' });
    }

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

  // ── POST /api/meetings/:id/admit ───────────────────────────────────────────
  // Track this calendar meeting. If it starts within 15 minutes, dispatch the
  // bot immediately (bot-join failure is non-blocking). Editor+.
  app.post('/api/meetings/:id/admit', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'editor'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });

    await db.update(meetings).set({ admitted: true, status: 'scheduled' }).where(eq(meetings.id, id));

    // Phase 3: generate the pre-meeting brief (context + prior meeting + agenda),
    // filed in the meeting folder. Fire-and-forget — never blocks admit.
    enqueuePreBrief(id, req.auth.tenant_id, meeting.recallBotId);

    let botDispatched = false;
    const startMs = meeting.scheduledStartAt ? new Date(meeting.scheduledStartAt).getTime() : null;
    const minutesUntilStart = startMs != null ? (startMs - Date.now()) / 60000 : null;
    if (minutesUntilStart != null && minutesUntilStart <= 15) {
      botDispatched = await dispatchBot(meeting);
    }
    return reply.send({ ok: true, admitted: true, botDispatched, minutesUntilStart });
  });

  // ── POST /api/meetings/:id/ignore ──────────────────────────────────────────
  app.post('/api/meetings/:id/ignore', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'editor'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const updated = await db.update(meetings)
      .set({ admitted: false, status: 'ignored' })
      .where(and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)))
      .returning({ id: meetings.id });
    if (updated.length === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  });

  // ── POST /api/meetings/:id/dispatch ────────────────────────────────────────
  // Send the bot into an admitted meeting right now (manual trigger). Editor+.
  app.post('/api/meetings/:id/dispatch', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'editor'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const meeting = await db.query.meetings.findFirst({
      where: and(eq(meetings.id, id), eq(meetings.workspaceId, req.auth.tenant_id)),
    });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });
    if (!meeting.meetingUrl) return reply.code(400).send({ error: 'no_meeting_url' });

    const ok = await dispatchBot(meeting);
    return ok ? reply.send({ ok: true }) : reply.code(502).send({ error: 'bot_dispatch_failed' });
  });

  // ── POST /api/meetings/:id/project ─────────────────────────────────────────
  // Link (or unlink, project_id=null) a meeting to a project. Cascades the project
  // onto the meeting's notes/brief docs, its folder, and the tasks it created, and
  // refreshes the knowledge-graph edges so the meeting sits with that project. Editor+.
  app.post('/api/meetings/:id/project', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    try { await requireRole(req, 'editor'); } catch (e) { if (roleGuard(e, reply)) return; throw e; }

    const parsed = z.object({ project_id: z.string().uuid().nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation' });
    const projectId = parsed.data.project_id;
    const tenant = req.auth.tenant_id;

    const meeting = await db.query.meetings.findFirst({ where: and(eq(meetings.id, id), eq(meetings.workspaceId, tenant)) });
    if (!meeting) return reply.code(404).send({ error: 'not_found' });

    if (projectId) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, tenant))).limit(1);
      if (!p) return reply.code(400).send({ error: 'invalid_project' });
    }

    await db.update(meetings).set({ projectId }).where(eq(meetings.id, id));
    // Cascade the project onto everything the meeting produced, so its notes + tasks
    // live in that project (and the graph + project views pick them up).
    if (meeting.postMeetingDocId) await db.update(docs).set({ projectId }).where(eq(docs.id, meeting.postMeetingDocId));
    if (meeting.preMeetingDocId) await db.update(docs).set({ projectId }).where(eq(docs.id, meeting.preMeetingDocId));
    if (meeting.meetingFolderId) await db.update(folders).set({ projectId }).where(eq(folders.id, meeting.meetingFolderId));
    await db.update(tasks).set({ projectId }).where(and(eq(tasks.meetingId, id), eq(tasks.workspaceId, tenant)));

    // Refresh the meeting's graph edges immediately (meeting → project, etc.).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await syncMeetingNode(db as any, tenant, id); } catch { /* non-fatal */ }

    return reply.send({ ok: true, project_id: projectId });
  });
};
