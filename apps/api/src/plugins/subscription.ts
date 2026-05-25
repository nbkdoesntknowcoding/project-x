/**
 * Subscription gating middleware.
 *
 * `requireActiveSubscription` checks that the workspace has an active or
 * trialing Razorpay subscription before allowing access to paid features
 * (MCP endpoint, collab WebSocket). Free workspaces and workspaces with
 * halted/cancelled subscriptions receive a 402 with a machine-readable
 * reason so the UI can redirect to the billing page.
 *
 * Usage:
 *   import { requireActiveSubscription } from '../plugins/subscription.js';
 *   // In a route:
 *   const gate = await requireActiveSubscription(req, reply);
 *   if (gate) return; // already sent 402
 */

import { desc, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { subscriptions } from '../db/schema.js';

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'created']);

export async function requireActiveSubscription(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!req.auth) {
    reply.code(401).send({ error: 'unauthorized' });
    return true;
  }

  const rows = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, req.auth.tenant_id))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);

  const status = rows[0]?.status ?? null;

  if (!status || !ACTIVE_STATUSES.has(status)) {
    reply.code(402).send({
      error: 'subscription_required',
      subscription_status: status,
      message:
        status === 'halted'
          ? 'Payment failed — please update your payment method.'
          : status === 'cancelled' || status === 'paused'
            ? 'Your subscription has ended. Please re-subscribe to continue.'
            : 'An active subscription is required to use this feature.',
    });
    return true;
  }

  return false;
}
