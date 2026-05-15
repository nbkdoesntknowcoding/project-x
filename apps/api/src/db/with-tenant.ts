import { sql } from 'drizzle-orm';
import { db } from './index.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction with:
 *   1. SET LOCAL ROLE app_user — drops superuser so RLS actually applies.
 *   2. set_config('app.tenant_id', $1, true) — transaction-local tenant GUC
 *      that the RLS policies key off via app_current_tenant_id().
 *
 * The third arg to set_config is `true` (transaction-local). Session-local
 * would leak across pooled connections.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return await fn(tx);
  });
}
