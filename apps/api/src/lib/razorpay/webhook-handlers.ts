import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { subscriptions, workspaces } from '../../db/schema.js';
import { planKeyFromRazorpayPlanId } from './plan-state.js';

export interface RazorpaySubscriptionEntity {
  id: string;
  status: string;
  plan_id: string;
  customer_id: string;
  quantity: number;
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  ended_at?: number;
}

export interface RazorpayWebhookEvent {
  entity: string;
  account_id: string;
  event: string;
  contains: string[];
  payload: {
    subscription: {
      entity: RazorpaySubscriptionEntity;
    };
  };
  created_at: number;
}

// Razorpay doesn't provide stable top-level event IDs, so we derive one
// from the entity ID + event name + created_at timestamp.
export function computeEventId(event: RazorpayWebhookEvent): string {
  const sub = event.payload.subscription.entity;
  return `${event.event}:${sub.id}:${event.created_at}`;
}

async function upsertSubscription(
  event: RazorpayWebhookEvent,
  workspaceId: string,
  planKey: string,
): Promise<void> {
  const sub = event.payload.subscription.entity;
  const periodStart = sub.current_start != null ? new Date(sub.current_start * 1000) : null;
  const periodEnd = sub.current_end != null ? new Date(sub.current_end * 1000) : null;
  const canceledAt = sub.ended_at != null ? new Date(sub.ended_at * 1000) : null;

  await db.insert(subscriptions).values({
    workspaceId,
    razorpaySubscriptionId: sub.id,
    razorpayCustomerId: sub.customer_id || null,
    status: sub.status,
    planId: sub.plan_id,
    planKey,
    quantity: sub.quantity ?? 1,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    canceledAt,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: subscriptions.razorpaySubscriptionId,
    set: {
      status: sub.status,
      planId: sub.plan_id,
      planKey,
      quantity: sub.quantity ?? 1,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      canceledAt,
      updatedAt: new Date(),
    },
  });
}

async function findWorkspaceBySubscription(subscriptionId: string): Promise<string | null> {
  const rows = await db.select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.razorpaySubscriptionId, subscriptionId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function handleSubscriptionActivated(event: RazorpayWebhookEvent): Promise<void> {
  const sub = event.payload.subscription.entity;
  const planKey = await planKeyFromRazorpayPlanId(sub.plan_id);
  if (!planKey) {
    console.warn('[razorpay-webhook] plan_id not mapped to a plan key', { plan_id: sub.plan_id });
    return;
  }

  const wsId = await findWorkspaceBySubscription(sub.id);
  if (!wsId) {
    console.warn('[razorpay-webhook] no workspace found for subscription', { id: sub.id });
    return;
  }

  await upsertSubscription(event, wsId, planKey);

  const periodEnd = sub.current_end != null ? new Date(sub.current_end * 1000) : null;
  await db.update(workspaces).set({
    plan: planKey as 'pro' | 'team',
    razorpaySubscriptionId: sub.id,
    subscriptionStatus: 'active',
    subscriptionCurrentPeriodEnd: periodEnd,
  }).where(eq(workspaces.id, wsId));

  console.log(`[razorpay-webhook] subscription.activated → workspace ${wsId} plan=${planKey}`);
}

export async function handleSubscriptionHalted(event: RazorpayWebhookEvent): Promise<void> {
  const sub = event.payload.subscription.entity;
  const wsId = await findWorkspaceBySubscription(sub.id);
  if (!wsId) return;

  await db.update(subscriptions)
    .set({ status: 'halted', updatedAt: new Date() })
    .where(eq(subscriptions.razorpaySubscriptionId, sub.id));

  await db.update(workspaces).set({
    subscriptionStatus: 'halted',
  }).where(eq(workspaces.id, wsId));

  console.log(`[razorpay-webhook] subscription.halted → workspace ${wsId} (payment failed)`);
}

export async function handleSubscriptionCancelled(event: RazorpayWebhookEvent): Promise<void> {
  const sub = event.payload.subscription.entity;
  const wsId = await findWorkspaceBySubscription(sub.id);
  if (!wsId) return;

  await db.update(subscriptions).set({
    status: 'cancelled',
    canceledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(subscriptions.razorpaySubscriptionId, sub.id));

  await db.update(workspaces).set({
    plan: 'free',
    razorpaySubscriptionId: null,
    subscriptionStatus: 'cancelled',
    subscriptionCurrentPeriodEnd: null,
  }).where(eq(workspaces.id, wsId));

  console.log(`[razorpay-webhook] subscription.cancelled → workspace ${wsId} downgraded to free`);
}

export async function handleSubscriptionPaused(event: RazorpayWebhookEvent): Promise<void> {
  const sub = event.payload.subscription.entity;
  const wsId = await findWorkspaceBySubscription(sub.id);
  if (!wsId) return;

  await db.update(subscriptions)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(subscriptions.razorpaySubscriptionId, sub.id));

  await db.update(workspaces).set({
    subscriptionStatus: 'paused',
  }).where(eq(workspaces.id, wsId));

  console.log(`[razorpay-webhook] subscription.paused → workspace ${wsId}`);
}

// STRIPE: ENABLE WHEN APPROVED
// export async function handleSubscriptionEvent(event: Stripe.Event): Promise<void> { ... }
// export async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> { ... }
// export async function handleInvoicePaymentSucceeded(event: Stripe.Event): Promise<void> { ... }
// export async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> { ... }
