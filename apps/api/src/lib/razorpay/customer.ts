import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { workspaces } from '../../db/schema.js';
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

  await db.update(workspaces)
    .set({ razorpayCustomerId: customer.id })
    .where(eq(workspaces.id, args.workspaceId));

  return customer.id;
}

export async function getRazorpayCustomerForWorkspace(workspaceId: string): Promise<string | null> {
  const rows = await db.select({ razorpayCustomerId: workspaces.razorpayCustomerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
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
