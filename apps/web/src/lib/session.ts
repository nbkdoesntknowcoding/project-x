import type { SessionData } from '@boppl/shared';
import type { AstroCookies } from 'astro';
import { sealData, unsealData } from 'iron-session';

const SESSION_COOKIE = 'boppl_session';
const JWT_COOKIE = 'boppl_jwt';

function getPassword(): string {
  const value = import.meta.env.WORKOS_COOKIE_PASSWORD as string | undefined;
  if (!value || value.length < 32) {
    throw new Error('WORKOS_COOKIE_PASSWORD must be set (>=32 chars)');
  }
  return value;
}

export async function setSession(
  cookies: AstroCookies,
  data: SessionData,
): Promise<void> {
  const sealed = await sealData(data, { password: getPassword() });
  cookies.set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
  cookies.set(JWT_COOKIE, data.jwt, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
}

export async function getSession(
  cookies: AstroCookies,
): Promise<SessionData | null> {
  const value = cookies.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  try {
    const data = await unsealData<SessionData>(value, { password: getPassword() });
    // If the embedded JWT is expired, treat as no session → forces re-login.
    if (data?.jwt) {
      const parts = data.jwt.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1]!)) as { exp?: number };
          if (payload.exp && payload.exp * 1000 < Date.now()) {
            return null;
          }
        } catch {
          // malformed JWT payload — fall through, let API reject it
        }
      }
    }
    return data;
  } catch {
    return null;
  }
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
  cookies.delete(JWT_COOKIE, { path: '/' });
}
