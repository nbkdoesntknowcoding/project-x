/**
 * Web mirror of the server-side admin gate (apps/api/src/lib/admin.ts).
 * Used in Astro page front-matter to hide/redirect non-staff. The real boundary is
 * always the server — every /api/admin/* call re-checks. This is convenience only.
 */
const DOMAIN = (import.meta.env.PUBLIC_ADMIN_EMAIL_DOMAIN || 'theboringpeople.in').toLowerCase();
const ALLOW = new Set(
  (import.meta.env.ADMIN_EMAILS || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean),
);

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.endsWith(`@${DOMAIN}`) || ALLOW.has(e);
}
