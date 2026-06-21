/**
 * POST /api/_internal/meeting-participants
 *
 * Meeting identity (Phase 2b) capture. Called by the meeting bot (Python pipeline)
 * to report a meeting's roster so the organizer can map unrecognized attendees
 * afterwards. Authenticated with the bot's own `mnema_api_` key (Bearer) — the key
 * resolves to its workspace + creator (the organizer), so no extra secret is needed
 * and the write is bounded to that workspace.
 *
 * Upserts the `meetings` row (keyed by the Recall bot id) and each
 * `meeting_participants` row, resolving each attendee to a Mnema user the same way
 * the live MCP path does (email → saved name alias → else unresolved).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { meetingParticipants, meetings } from '../../db/schema.js';
import { resolveApiKey } from '../../lib/api-keys.js';
import { resolveAttendee } from '../../lib/meeting-identity.js';
import { enqueueMeetingEnd } from '../../queue/meeting-end.js';

const bodySchema = z.object({
  recall_bot_id: z.string().min(1),
  meeting_url: z.string().optional().nullable(),
  ended: z.boolean().optional(),
  participants: z
    .array(
      z.object({
        recall_participant_id: z.string().min(1),
        name: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        is_host: z.boolean().optional(),
      }),
    )
    .default([]),
});

export const meetingParticipantsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/_internal/meeting-participants', async (req, reply) => {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const key = token ? await resolveApiKey(token) : null;
    if (!key) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }
    const { recall_bot_id, meeting_url, ended, participants } = parsed.data;

    // Upsert the meeting (keyed by the Recall bot id).
    const [meeting] = await db
      .insert(meetings)
      .values({
        workspaceId: key.workspaceId,
        recallBotId: recall_bot_id,
        organizerUserId: key.userId,
        meetingUrl: meeting_url ?? null,
        ...(ended ? { endedAt: new Date() } : {}),
      })
      .onConflictDoUpdate({
        target: meetings.recallBotId,
        set: {
          ...(meeting_url ? { meetingUrl: meeting_url } : {}),
          ...(ended ? { endedAt: new Date() } : {}),
        },
      })
      .returning({ id: meetings.id });

    if (!meeting) return reply.code(500).send({ error: 'meeting_upsert_failed' });

    // Upsert each participant with its resolution status.
    for (const p of participants) {
      const name = p.name?.trim() || null;
      const email = p.email?.trim() || null;
      const resolvedUserId = await resolveAttendee(key.workspaceId, email, name);
      await db
        .insert(meetingParticipants)
        .values({
          meetingId: meeting.id,
          recallParticipantId: p.recall_participant_id,
          name,
          email,
          isHost: p.is_host ?? false,
          resolvedUserId,
        })
        .onConflictDoUpdate({
          target: [meetingParticipants.meetingId, meetingParticipants.recallParticipantId],
          set: { name, email, isHost: p.is_host ?? false, resolvedUserId },
        });
    }

    // Meeting just ended → kick off post-meeting processing (transcript →
    // summary → Post-Meeting Notes doc). Idempotent + retryable in the worker.
    if (ended) enqueueMeetingEnd(meeting.id, key.workspaceId, recall_bot_id);

    return { ok: true, meeting_id: meeting.id };
  });
};
