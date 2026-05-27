/**
 * API key generation and resolution utilities.
 * Keys follow the format: mnema_api_ + 48 random hex chars (total 58 chars).
 * Only the SHA-256 hash is stored. The plaintext is returned once at creation.
 */

import crypto from 'crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema.js';

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(48).toString('hex'); // 96 hex chars
  const plaintext = `mnema_api_${random}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  const prefix = plaintext.slice(0, 16); // "mnema_api_" + 6 chars
  return { plaintext, hash, prefix };
}

export async function resolveApiKey(
  bearerToken: string,
): Promise<{ workspaceId: string; scopes: string[] } | null> {
  if (!bearerToken?.startsWith('mnema_api_')) return null;

  const hash = crypto.createHash('sha256').update(bearerToken).digest('hex');

  const key = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.keyHash, hash),
      isNull(apiKeys.revokedAt),
      or(
        isNull(apiKeys.expiresAt),
        gt(apiKeys.expiresAt, new Date()),
      ),
    ),
  });

  if (!key) return null;

  // Update last used timestamp async (fire and forget)
  db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, key.id))
    .catch(() => {});

  return { workspaceId: key.workspaceId, scopes: key.scopes };
}

/**
 * Validate that requested scopes are a subset of allowed scope values.
 */
const VALID_SCOPES = new Set(['read', 'write', 'tasks']);

export function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) return ['read'];
  const valid = scopes.filter((s): s is string => typeof s === 'string' && VALID_SCOPES.has(s));
  return valid.length > 0 ? valid : ['read'];
}
