/**
 * API proxy — forwards /api/* browser requests to the backend.
 *
 * Why this exists: client-side components (FlowCanvas, DocSidebar, etc.)
 * call relative /api/* URLs. In local dev, Vite proxies them to
 * localhost:8080. On Vercel there is no proxy, so they 404. This catch-all
 * Astro endpoint runs server-side, extracts the JWT from the iron-session
 * cookie, and forwards the request to PUBLIC_API_URL with the correct
 * Authorization header.
 */
import type { APIRoute } from 'astro';
import { getSession } from '../../lib/session.ts';

const BACKEND = (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

const handler: APIRoute = async (context) => {
  const { request, params, cookies } = context;
  const session = await getSession(cookies);

  const path = (params.path as string | undefined) ?? '';
  const url = new URL(request.url);

  // Reconstruct target: backend + /api/ + path + query string
  const target = `${BACKEND}/api/${path}${url.search}`;

  const forwardHeaders: Record<string, string> = {};

  // Forward content-type for mutation requests
  const ct = request.headers.get('content-type');
  if (ct) forwardHeaders['content-type'] = ct;

  // Inject JWT as Bearer token
  if (session?.jwt) {
    forwardHeaders['authorization'] = `Bearer ${session.jwt}`;
  }

  const isBodyMethod = !['GET', 'HEAD'].includes(request.method.toUpperCase());

  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers: forwardHeaders,
  };

  if (isBodyMethod && request.body) {
    init.body = request.body;
    init.duplex = 'half'; // required when streaming a ReadableStream body
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Backend unreachable', target }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }

  // Forward upstream response verbatim
  const responseHeaders: Record<string, string> = {};
  const upstreamCT = upstream.headers.get('content-type');
  if (upstreamCT) responseHeaders['content-type'] = upstreamCT;

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: responseHeaders,
  });
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
