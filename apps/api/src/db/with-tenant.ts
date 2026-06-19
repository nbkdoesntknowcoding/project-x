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
  return await withTenantScoped(tenantId, {}, fn);
}

/**
 * Like withTenant, but also sets the Stage B GUCs (transaction-local):
 *   userId       → app.user_id       (per-user project-membership RLS)
 *   projectScope → app.project_scope (set ONLY for project-scoped API keys; when
 *                  present the whole session is hard-bounded to that one project —
 *                  this is what stops the meeting bot reaching other projects).
 * When a value is unset/null the corresponding GUC is left empty, and the project
 * RLS predicate is a no-op (identical to plain withTenant / today's behavior).
 */
export interface TenantScope {
  userId?: string | null;
  projectScope?: string | null;
}

export async function withTenantScoped<T>(
  tenantId: string,
  scope: TenantScope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    if (scope.userId) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${scope.userId}, true)`);
    }
    if (scope.projectScope) {
      await tx.execute(sql`SELECT set_config('app.project_scope', ${scope.projectScope}, true)`);
    }
    return await fn(tx);
  });
}
