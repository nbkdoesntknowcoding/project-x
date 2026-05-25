import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { razorpayPlanIds, subscriptions, workspaces } from '../db/schema.js';
import { createRazorpayCustomerForWorkspace, getRazorpayCustomerForWorkspace } from '../lib/razorpay/customer.js';
import { requireRole } from '../lib/role.js';

const subscribeSchema = z.object({
  plan_key: z.enum(['pro', 'team']),
  customer_id: z.string().optional(),
});

// STRIPE: ENABLE WHEN APPROVED
// import { stripe } from '../lib/stripe/client.js';
// import { config } from '../config/env.js';
// import { createStripeCustomerForWorkspace } from '../lib/stripe/customer.js';

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/billing/current', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'viewer');

    const wsRows = await db.select({ plan: workspaces.plan })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    if (wsRows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });

    // Billing details live in the subscriptions table, not on workspaces
    const subRows = await db.select({
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      razorpayCustomerId: subscriptions.razorpayCustomerId,
    })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, req.auth.tenant_id))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    const sub = subRows[0];
    return {
      plan: wsRows[0]!.plan,
      subscription_status: sub?.status ?? null,
      current_period_end: sub?.currentPeriodEnd?.toISOString() ?? null,
      has_razorpay_customer: Boolean(sub?.razorpayCustomerId),
      // STRIPE: ENABLE WHEN APPROVED
      // has_stripe_customer: Boolean(rows[0]!.stripeCustomerId),
    };
  });

  app.post('/api/billing/cancel', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'owner');

    // Get the active subscription for this workspace from the subscriptions table
    const subRows = await db.select({
      razorpaySubscriptionId: subscriptions.razorpaySubscriptionId,
      status: subscriptions.status,
    })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.workspaceId, req.auth.tenant_id),
        inArray(subscriptions.status, ['active', 'trialing', 'created']),
      ))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1);

    if (subRows.length === 0) {
      return reply.code(400).send({ error: 'no_active_subscription' });
    }

    const { razorpaySubscriptionId } = subRows[0]!;

    // Cancel at period end via Razorpay API
    const razorpay = (await import('../lib/razorpay/client.js')).razorpay;
    await razorpay.subscriptions.cancel(razorpaySubscriptionId, true);

    await db.update(subscriptions)
      .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
      .where(eq(subscriptions.razorpaySubscriptionId, razorpaySubscriptionId));

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

    const wsRows = await db.select({ slug: workspaces.slug, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, req.auth.tenant_id))
      .limit(1);

    if (wsRows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });

    // Look up existing customer ID from the subscriptions table
    let customerId = await getRazorpayCustomerForWorkspace(req.auth.tenant_id);
    if (!customerId) {
      customerId = await createRazorpayCustomerForWorkspace({
        workspaceId: req.auth.tenant_id,
        workspaceSlug: wsRows[0]!.slug,
        workspaceName: wsRows[0]!.name,
        ownerEmail: req.auth.email,
      });
    }

    return { razorpay_customer_id: customerId };
  });

  // Create a new Razorpay subscription and return the hosted payment link.
  // The caller passes the plan_key; we look up the Razorpay plan_id from the
  // razorpay_plan_ids table (seeded per environment).
  app.post('/api/billing/subscribe', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    await requireRole(req, 'owner');

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const { plan_key, customer_id } = parsed.data;

    // Resolve Razorpay plan_id for this plan_key + environment
    const planRows = await db.select({ razorpayPlanId: razorpayPlanIds.razorpayPlanId })
      .from(razorpayPlanIds)
      .where(and(
        eq(razorpayPlanIds.planKey, plan_key),
        eq(razorpayPlanIds.environment, config.RAZORPAY_ENVIRONMENT),
      ))
      .limit(1);

    if (planRows.length === 0) {
      return reply.code(400).send({ error: 'plan_not_configured' });
    }
    const razorpayPlanId = planRows[0]!.razorpayPlanId;

    // Ensure a Razorpay customer exists for this workspace
    let customerId = customer_id ?? await getRazorpayCustomerForWorkspace(req.auth.tenant_id);
    if (!customerId) {
      const wsRows = await db.select({ slug: workspaces.slug, name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, req.auth.tenant_id))
        .limit(1);
      if (wsRows.length === 0) return reply.code(404).send({ error: 'workspace_not_found' });
      customerId = await createRazorpayCustomerForWorkspace({
        workspaceId: req.auth.tenant_id,
        workspaceSlug: wsRows[0]!.slug,
        workspaceName: wsRows[0]!.name,
        ownerEmail: req.auth.email,
      });
    }

    const razorpay = (await import('../lib/razorpay/client.js')).razorpay;
    // The Razorpay SDK types are incomplete — customer_id is a valid field per
    // the API docs but missing from the TypeScript definitions.
    const subscription = await (razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      customer_id: customerId,
      quantity: 1,
      total_count: 120, // up to 10 years — effectively open-ended
      notes: { workspace_id: req.auth.tenant_id },
    } as Parameters<typeof razorpay.subscriptions.create>[0]) as Promise<{ id: string; short_url: string }>);

    return {
      subscription_id: subscription.id,
      short_url: subscription.short_url,
    };
  });
};
