import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { subscriptions } from '../../db/schema.js';
import { razorpay } from './client.js';

interface CreateCustomerArgs {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  ownerEmail: string;
}

export async function createRazorpayCustomerForWorkspace(args: CreateCustomerArgs): Promise<string> {
  // fail_existing: 0 — return existing customer if email already registered
  const customer = await (razorpay.customers.create({
    name: args.workspaceName,
    email: args.ownerEmail,
    fail_existing: 0,
    notes: {
      workspace_id: args.workspaceId,
      workspace_slug: args.workspaceSlug,
    },
  }) as Promise<{ id: string }>);

  // razorpayCustomerId is stored per-subscription in the subscriptions table,
  // not on workspaces. The customer ID will be persisted when the first
  // subscription is created (via the webhook upsert).
  return customer.id;
}

export async function getRazorpayCustomerForWorkspace(workspaceId: string): Promise<string | null> {
  // Customer ID is stored per-subscription in the subscriptions table.
  // Return the most recent non-null customer ID for this workspace.
  const rows = await db.select({ razorpayCustomerId: subscriptions.razorpayCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0]?.razorpayCustomerId ?? null;
}

// STRIPE: ENABLE WHEN APPROVED
// export async function createStripeCustomerForWorkspace(args: CreateCustomerArgs): Promise<string> {
//   const customer = await stripe.customers.create({
//     email: args.ownerEmail,
//     name: args.workspaceName,
//     metadata: { workspace_id: args.workspaceId, workspace_slug: args.workspaceSlug },
//   });
//   await db.update(workspaces).set({ stripeCustomerId: customer.id }).where(eq(workspaces.id, args.workspaceId));
//   return customer.id;
// }
