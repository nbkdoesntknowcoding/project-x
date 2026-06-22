/**
 * Live VPS logs — admin-only SSE proxy to the isolated log-streamer sidecar.
 *
 * The streamer (infra/log-streamer) is the only container with Docker-socket
 * access; it tails `docker logs --follow` per service, redacts secrets, and emits
 * SSE frames. This endpoint re-checks staff access, audits the view, and pipes the
 * frames straight through. The streamer is never exposed publicly — only reachable
 * on the internal Docker network.
 */
import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/env.js';
import { requireAdmin, logAdminAction } from '../../lib/admin.js';
import { RoleError } from '../../lib/role.js';

const SERVICES = new Set(['api', 'workers', 'collab', 'meeting-bot', 'pipecat-meeting']);

export const adminLogsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/logs/stream', async (req, reply) => {
    try { requireAdmin(req); }
    catch (e) { if (e instanceof RoleError) return reply.code(e.status).send({ error: e.reason }); throw e; }

    const query = (req.query ?? {}) as { service?: string; tail?: string };
    const service = String(query.service ?? 'api');
    if (!SERVICES.has(service)) return reply.code(400).send({ error: 'unknown_service' });
    const tail = Math.min(2000, Math.max(1, parseInt(String(query.tail ?? '200'), 10) || 200));

    await logAdminAction(req, { action: 'logs.view', targetType: 'service', targetId: service });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const ctrl = new AbortController();
    req.raw.on('close', () => ctrl.abort());

    try {
      const upstream = await fetch(
        `${config.LOG_STREAMER_URL}/logs/${service}?tail=${tail}&follow=1`,
        { signal: ctrl.signal, headers: { accept: 'text/event-stream' } },
      );
      if (!upstream.ok || !upstream.body) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'streamer_unavailable', status: upstream.status })}\n\n`);
        reply.raw.end();
        return reply;
      }
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) reply.raw.write(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        try { reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'streamer_error' })}\n\n`); } catch { /* socket gone */ }
      }
    } finally {
      try { reply.raw.end(); } catch { /* already closed */ }
    }
    return reply;
  });
};
