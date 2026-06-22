/**
 * SSE proxy — streams /api/admin/logs/stream from the backend (admin-only).
 * Mirrors the notifications stream proxy: forwards the session JWT and pipes the
 * body so EventSource gets a real streaming connection. The backend re-checks
 * staff access and audits the view.
 */
import type { APIRoute } from 'astro';
import { getSession } from '../../../../lib/session.ts';

const BACKEND = (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

export const GET: APIRoute = async ({ cookies, url }) => {
  const session = await getSession(cookies);
  const target = `${BACKEND}/api/admin/logs/stream${url.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: {
        ...(session?.jwt ? { authorization: `Bearer ${session.jwt}` } : {}),
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`event: error\ndata: ${JSON.stringify({ error: `Backend unreachable: ${msg}` })}\n\n`, {
      status: 502, headers: { 'content-type': 'text/event-stream' },
    });
  }

  if (!upstream.body) {
    return new Response('event: error\ndata: {"error":"no body"}\n\n', {
      status: 502, headers: { 'content-type': 'text/event-stream' },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
  });
};

export const maxDuration = 60;
