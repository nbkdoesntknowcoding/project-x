/**
 * POST /api/_internal/recall-webhook
 *
 * Recall.ai posts participant events here in real time, SIGNATURE-VERIFIED with the
 * workspace verification secret (Phase 4). This is the tamper-proof roster: the MCP
 * boundary validates a meeting bot's act-as identity against these `verified = true`
 * rows, so a leaked act-as key can't impersonate anyone Recall didn't confirm is
 * present.
 *
 * Self-authenticates via the signature (no JWT) → listed in PUBLIC_ROUTES. Needs the
 * raw body to verify, so it installs a buffer content-type parser (mirrors the
 * Razorpay webhook route). The trusted roster attaches to the `meetings` row created
 * by the bot's capture report (which carries workspace + organizer); events that
 * arrive before that row exists are acknowledged and dropped (later events re-cover).
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/env.js';
import { db } from '../../db/index.js';
import { meetingParticipants, meetings } from '../../db/schema.js';
import { resolveAttendee } from '../../lib/meeting-identity.js';
import { verifyRecallRequest } from '../../lib/recall-verify.js';

function extractEmail(p: Record<string, unknown>): string | null {
  const email = p.email as string | undefined;
  if (email) return email;
  const extra = (p.extra_data as Record<string, unknown> | undefined) ?? {};
  return (extra.email as string | undefined) ?? null;
}

export const recallWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Raw buffer — signature is over the exact bytes, before any JSON parse.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/api/_internal/recall-webhook', async (req, reply) => {
    // Feature off (no secret) → accept-and-ignore so Recall doesn't retry.
    if (!config.RECALL_WEBHOOK_SECRET) return reply.code(200).send({ ignored: true });

    const raw = req.body as Buffer;
    const payload = Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    if (!verifyRecallRequest({ secret: config.RECALL_WEBHOOK_SECRET, headers: req.headers, payload })) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: 'invalid_payload' });
    }

    const event = (body.event as string) ?? '';
    if (!event.startsWith('participant_events.')) return reply.code(200).send({ ok: true });

    const d = (body.data as Record<string, unknown>) ?? {};
    const inner = (d.data as Record<string, unknown>) ?? {};
    const p = (inner.participant as Record<string, unknown>) ?? {};
    const botId = ((d.bot as Record<string, unknown> | undefined)?.id as string) ?? undefined;
    const pid = p.id != null ? String(p.id) : null;
    if (!botId || !pid) {
      // Help diagnose payload-nesting mismatches without dumping PII.
      req.log.info(
        { event, botId: botId ?? null, dKeys: Object.keys(d), innerKeys: Object.keys(inner) },
        'recall-webhook: missing bot/participant id (check nesting)',
      );
      return reply.code(200).send({ ok: true });
    }

    const meeting = await db.query.meetings.findFirst({ where: eq(meetings.recallBotId, botId) });
    if (!meeting) {
      req.log.info({ event, botId }, 'recall-webhook: meeting row not found yet (pending)');
      return reply.code(200).send({ ok: true, pending: true });
    }

    // leave keeps the historical row; only join/update carry identity.
    if (event === 'participant_events.leave') return reply.code(200).send({ ok: true });

    const name = ((p.name as string) ?? '').trim() || null;
    const email = (extractEmail(p) ?? '').trim() || null;
    const isHost = Boolean(p.is_host);
    const resolvedUserId = await resolveAttendee(meeting.workspaceId, email, name);
    req.log.info(
      { event, pid, name, isHost, email: email ? 'yes' : 'no', resolved: !!resolvedUserId },
      'recall-webhook: verified participant',
    );

    await db
      .insert(meetingParticipants)
      .values({
        meetingId: meeting.id,
        recallParticipantId: pid,
        name,
        email,
        isHost,
        verified: true,
        resolvedUserId,
      })
      .onConflictDoUpdate({
        target: [meetingParticipants.meetingId, meetingParticipants.recallParticipantId],
        set: { name, email, isHost, verified: true, resolvedUserId },
      });

    return reply.code(200).send({ ok: true });
  });
};
