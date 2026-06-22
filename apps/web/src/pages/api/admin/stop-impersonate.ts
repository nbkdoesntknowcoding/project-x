/**
 * Stop impersonation — restore the admin's stashed session (admin center).
 * Safe to call even if not impersonating (no-op restore).
 */
import type { APIRoute } from 'astro';
import { getSession, setSession, getAdminOrigin, clearAdminOrigin } from '../../../lib/session.ts';

export const POST: APIRoute = async ({ cookies }) => {
  const origin = await getAdminOrigin(cookies);
  if (origin) {
    await setSession(cookies, origin);
    clearAdminOrigin(cookies);
    return json({ ok: true, restored: origin.email });
  }
  // Nothing stashed — clear any stale impersonation marker by leaving the current
  // session as-is. Caller should reload either way.
  const cur = await getSession(cookies);
  return json({ ok: true, restored: cur?.email ?? null });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
