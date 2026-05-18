import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { subscriptions, workspaces } from '../db/schema.js';
import { createRazorpayCustomerForWorkspace } from '../lib/razorpay/customer.js';
import { requireRole } from '../lib/role.js';

// STRIPE: ENABLE WHEN APPROVED
// import { stripe } from '../lib/stripe/client.js';
// import { config } from '../config/env.js';
// import { createStripeCustomerForWorkspace } from '../lib/stripe/customer.js';

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/billing/current', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'viewer');

    const rows = await db.select({
      plan: workspaces.plan,
      subscriptionStatus: workspaces.subscriptionStatus,
      currentPeriodEnd: workspaces.subscriptionCurrentPeriodEnd,
      razorpayCustomerId: workspaces.razorpayCustomerId,
    })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    if (rows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });

    return {
      plan: rows[0]!.plan,
      subscription_status: rows[0]!.subscriptionStatus,
      current_period_end: rows[0]!.currentPeriodEnd?.toISOString() ?? null,
      has_razorpay_customer: Boolean(rows[0]!.razorpayCustomerId),
      // STRIPE: ENABLE WHEN APPROVED
      // has_stripe_customer: Boolean(rows[0]!.stripeCustomerId),
    };
  });

  app.post('/api/billing/cancel', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'owner');

    const rows = await db.select({
      razorpaySubscriptionId: workspaces.razorpaySubscriptionId,
      plan: workspaces.plan,
    })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    if (rows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });

    const { razorpaySubscriptionId, plan } = rows[0]!;

    if (plan === 'free' || !razorpaySubscriptionId) {
      return reply.code(400).send({ error: 'no_active_subscription' });
    }

    // Cancel at period end via Razorpay API
    const razorpay = (await import('../lib/razorpay/client.js')).razorpay;
    await razorpay.subscriptions.cancel(razorpaySubscriptionId, true);

    await db.update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId));

    await db.update(workspaces)
      .set({ subscriptionStatus: 'pending_cancel' })
      .where(eq(workspaces.id, req.auth.tenant_id));

    return { cancelled: true };

    // STRIPE: ENABLE WHEN APPROVED
    // app.post('/api/billing/portal', async (req, reply) => {
    //   const session = await stripe.billingPortal.sessions.create({
    //     customer: customerId,
    //     return_url: config.STRIPE_RETURN_URL,
    //   });
    //   return { url: session.url };
    // });
  });

  // Lazy-create Razorpay customer (called from checkout flow in Phase 5)
  app.post('/api/billing/ensure-customer', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'owner');

    const rows = await db.select({
      razorpayCustomerId: workspaces.razorpayCustomerId,
      slug: workspaces.slug,
      name: workspaces.name,
    })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    if (rows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });

    let customerId = rows[0]!.razorpayCustomerId;
    if (!customerId) {
      customerId = await createRazorpayCustomerForWorkspace({
        workspaceId: req.auth.tenant_id,
        workspaceSlug: rows[0]!.slug,
        workspaceName: rows[0]!.name,
        ownerEmail: req.auth.email,
      });
    }

    return { razorpay_customer_id: customerId };
  });
};
