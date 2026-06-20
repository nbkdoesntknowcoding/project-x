/**
 * Phase C — Google Calendar linking + sync.
 *
 *   GET  /api/calendar/connect    → redirect to Google consent (offline, calendar.readonly)
 *   GET  /api/calendar/callback   → exchange code, store encrypted refresh token
 *   GET  /api/calendar/status     → { connected: boolean }
 *   POST /api/calendar/sync       → pull upcoming events → upsert scheduled meetings
 *
 * Sync is idempotent and keyed on (workspace_id, calendar_event_id). New meetings
 * land as status='scheduled', admitted=false and drop a `meeting_detected`
 * notification; the user admits them from /app/meetings (which dispatches the bot).
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { meetings, notifications, workspaceMembers } from '../db/schema.js';
import {
  calendarConfigured, consentUrl, exchangeCode, listUpcoming, refreshAccess,
} from '../lib/google-calendar.js';
import { requireRole, RoleError } from '../lib/role.js';
import { decryptSecret, encryptSecret, signState, verifySignedState } from '../lib/secret-box.js';

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  function guard(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof RoleError) { reply.code(err.status).send({ error: err.reason }); return true; }
    return false;
  }

  // ── Start the link flow ────────────────────────────────────────────────────
  app.get('/api/calendar/connect', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!calendarConfigured()) return reply.code(503).send({ error: 'calendar_not_configured' });
    try { await requireRole(req, 'viewer'); } catch (e) { if (guard(e, reply)) return; throw e; }
    const state = signState({ sub: req.auth.sub, tenant: req.auth.tenant_id });
    return reply.redirect(consentUrl(state));
  });

  // ── Google redirects back here ─────────────────────────────────────────────
  app.get('/api/calendar/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const back = `${config.WEB_BASE_URL}/app/meetings`;
    if (q.error || !q.code || !q.state) return reply.redirect(`${back}?calendar=error`);
    const st = verifySignedState(q.state);
    if (!st) return reply.redirect(`${back}?calendar=error`);
    if (!calendarConfigured()) return reply.redirect(`${back}?calendar=error`);

    try {
      const tokens = await exchangeCode(q.code);
      if (!tokens.refresh_token) {
        // Google only returns refresh_token on first consent — prompt=consent forces it.
        req.log.warn('calendar callback: no refresh_token returned');
        return reply.redirect(`${back}?calendar=error`);
      }
      await db.update(workspaceMembers)
        .set({ calendarRefreshToken: encryptSecret(tokens.refresh_token) })
        .where(and(eq(workspaceMembers.workspaceId, st.tenant), eq(workspaceMembers.userId, st.sub)));
      return reply.redirect(`${back}?calendar=connected`);
    } catch (err) {
      req.log.error({ err }, 'calendar callback failed');
      return reply.redirect(`${back}?calendar=error`);
    }
  });

  // ── Connection status ──────────────────────────────────────────────────────
  app.get('/api/calendar/status', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const rows = await db.select({ tok: workspaceMembers.calendarRefreshToken })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, req.auth.tenant_id), eq(workspaceMembers.userId, req.auth.sub)))
      .limit(1);
    return reply.send({ connected: Boolean(rows[0]?.tok), configured: calendarConfigured() });
  });

  // ── Pull events → upsert scheduled meetings ────────────────────────────────
  app.post('/api/calendar/sync', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!calendarConfigured()) return reply.code(503).send({ error: 'calendar_not_configured' });
    try { await requireRole(req, 'viewer'); } catch (e) { if (guard(e, reply)) return; throw e; }

    const ws = req.auth.tenant_id;
    const me = req.auth.sub;
    const rows = await db.select({ tok: workspaceMembers.calendarRefreshToken })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws), eq(workspaceMembers.userId, me)))
      .limit(1);
    if (!rows[0]?.tok) return reply.code(400).send({ error: 'calendar_not_connected' });

    let events;
    try {
      const accessToken = await refreshAccess(decryptSecret(rows[0].tok));
      events = await listUpcoming(accessToken);
    } catch (err) {
      req.log.error({ err }, 'calendar sync failed');
      return reply.code(502).send({ error: 'sync_failed' });
    }

    let created = 0;
    let updated = 0;
    for (const ev of events) {
      const existing = await db.query.meetings.findFirst({
        where: and(eq(meetings.workspaceId, ws), eq(meetings.calendarEventId, ev.id)),
      });
      if (existing) {
        await db.update(meetings).set({
          title: ev.title,
          meetingUrl: ev.meetingUrl,
          scheduledStartAt: ev.start ? new Date(ev.start) : null,
          scheduledEndAt: ev.end ? new Date(ev.end) : null,
        }).where(eq(meetings.id, existing.id));
        updated++;
        continue;
      }
      const [m] = await db.insert(meetings).values({
        workspaceId: ws,
        organizerUserId: me,
        title: ev.title,
        meetingUrl: ev.meetingUrl,
        calendarEventId: ev.id,
        calendarProvider: 'google',
        scheduledStartAt: ev.start ? new Date(ev.start) : null,
        scheduledEndAt: ev.end ? new Date(ev.end) : null,
        status: 'scheduled',
        admitted: false,
      }).returning({ id: meetings.id });
      created++;

      await db.insert(notifications).values({
        workspaceId: ws,
        recipientId: me,
        actorId: me,
        kind: 'meeting_detected',
        title: `Meeting detected: ${ev.title}`,
        body: `${ev.start ? new Date(ev.start).toLocaleString() : 'soon'} · ${ev.attendeeCount} attendees. Admit to Mnema?`,
        link: '/app/meetings',
      }).catch(() => { /* notification is best-effort */ });
      void m;
    }

    return reply.send({ ok: true, created, updated, total: events.length });
  });
};
