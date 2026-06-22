/**
 * Start impersonation (admin center, staff-only).
 *
 * Verifies the caller is staff, asks the backend to mint a short-lived JWT for the
 * target user, stashes the admin's own session in a restore cookie, then swaps the
 * active session to the impersonated principal with an `impersonating` marker (drives
 * the banner). "Return to admin" → /api/admin/stop-impersonate restores the stash.
 */
import type { APIRoute } from 'astro';
import type { SessionData } from '@boppl/shared';
import { getSession, setSession, setAdminOrigin } from '../../../lib/session.ts';
import { isAdminEmail } from '../../../lib/admin.ts';

const BACKEND = (import.meta.env.PUBLIC_API_URL as string | undefined) ?? 'http://localhost:8080';

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return json({ error: 'unauthorized' }, 401);
  if (!isAdminEmail(session.email)) return json({ error: 'forbidden' }, 403);
  // Don't allow nesting impersonation.
  if (session.impersonating) return json({ error: 'already_impersonating' }, 400);

  let body: { user_id?: string; workspace_id?: string };
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!body.user_id || !body.workspace_id) return json({ error: 'missing_fields' }, 400);

  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/admin/impersonate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.jwt}` },
      body: JSON.stringify({ user_id: body.user_id, workspace_id: body.workspace_id }),
    });
  } catch (e) {
    return json({ error: 'backend_unreachable', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
  if (!res.ok) return json({ error: 'mint_failed', status: res.status }, res.status);
  const minted = (await res.json()) as { jwt: string; email: string; workspace_id: string; until: number };

  // Stash the admin's real session, then swap to the impersonated one.
  await setAdminOrigin(cookies, session);
  const impersonatedSession: SessionData = {
    user_id: body.user_id,
    email: minted.email,
    tenant_id: minted.workspace_id,
    workos_user_id: '',
    access_token: '',
    jwt: minted.jwt,
    impersonating: {
      by_user_id: session.user_id,
      by_email: session.email,
      target_email: minted.email,
      until: minted.until,
    },
  };
  await setSession(cookies, impersonatedSession);
  return json({ ok: true, target: minted.email });
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
