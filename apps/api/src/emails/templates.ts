/**
 * Typed email template functions.
 *
 * Each function accepts a strongly-typed params object, renders the
 * corresponding HTML file via the CSS inliner, and returns
 * { subject, html } ready to pass to ResendEmailSender.
 *
 * Placeholder names mirror the {{double_curly}} vars in each HTML file —
 * see emails/html/<slug>.html for the authoritative list.
 *
 * unsubscribe_url is injected here; callers never supply it.
 */

import { renderTemplate } from './inliner.js';

const WEB_BASE_URL =
  process.env.WEB_BASE_URL ?? 'https://mnema.theboringpeople.in';
const UNSUBSCRIBE_URL = `${WEB_BASE_URL}/unsubscribe`;

// ─── Param interfaces ─────────────────────────────────────────────────────────

export interface WelcomeEmailParams {
  firstName: string;        // {{first_name}}
  workspaceName: string;    // {{workspace_name}}
  openUrl: string;          // {{open_url}}
}

export interface WorkspaceInvitationParams {
  inviterName: string;      // {{inviter_name}}
  workspaceName: string;    // {{workspace_name}}
  acceptUrl: string;        // {{accept_url}}
}

export interface InvitationAcceptedParams {
  inviteeName: string;      // {{invitee_name}}
  workspaceName: string;    // {{workspace_name}}
  membersUrl: string;       // {{members_url}}
}

export interface PaymentSuccessfulParams {
  planName: string;         // {{plan_name}}
  amount: string;           // {{amount}}
  date: string;             // {{date}}
  nextBillingDate: string;  // {{next_billing_date}}
  billingUrl: string;       // {{billing_url}}
}

export interface PaymentFailedParams {
  planName: string;         // {{plan_name}}
  amount: string;           // {{amount}}
  date: string;             // {{date}}
  gracePeriodEnd: string;   // {{grace_period_end}}
  updateUrl: string;        // {{update_url}}  (HTML uses update_url, not billing_url)
}

export interface SubscriptionCancelledParams {
  planName: string;         // {{plan_name}}
  accessEndDate: string;    // {{access_end_date}}
  reactivateUrl: string;    // {{reactivate_url}}
}

export interface LoginAlertParams {
  loginTime: string;        // {{login_time}}
  ipLocation: string;       // {{ip_location}}
  device: string;           // {{device}}
  secureUrl: string;        // {{secure_url}}
}

export interface TrialEndingParams {
  daysRemaining: string;    // {{days_remaining}}
  trialEndDate: string;     // {{trial_end_date}}
  upgradeUrl: string;       // {{upgrade_url}}
}

export interface RenewalReminderParams {
  planName: string;         // {{plan_name}}
  renewalDate: string;      // {{renewal_date}}
  amount: string;           // {{amount}}
  paymentMethod: string;    // {{payment_method}}
  billingUrl: string;       // {{billing_url}}
}

export interface McpConnectedParams {
  workspaceName: string;    // {{workspace_name}}
  connectionTime: string;   // {{connection_time}}
  device: string;           // {{device}}
  claudeUrl: string;        // {{claude_url}}  (HTML uses claude_url, not open_url)
}

// ─── Template functions ───────────────────────────────────────────────────────

export function welcomeEmail(p: WelcomeEmailParams) {
  return {
    subject: `Welcome to Mnema, ${p.firstName}`,
    html: renderTemplate('welcome', {
      first_name: p.firstName,
      workspace_name: p.workspaceName,
      open_url: p.openUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function workspaceInvitationEmail(p: WorkspaceInvitationParams) {
  return {
    subject: `${p.inviterName} invited you to ${p.workspaceName} on Mnema`,
    html: renderTemplate('workspace-invitation', {
      inviter_name: p.inviterName,
      workspace_name: p.workspaceName,
      accept_url: p.acceptUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

/** Alias kept so older imports of invitationEmail() still compile. */
export const invitationEmail = workspaceInvitationEmail;

export function invitationAcceptedEmail(p: InvitationAcceptedParams) {
  return {
    subject: `${p.inviteeName} joined ${p.workspaceName}`,
    html: renderTemplate('invitation-accepted', {
      invitee_name: p.inviteeName,
      workspace_name: p.workspaceName,
      members_url: p.membersUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function paymentSuccessfulEmail(p: PaymentSuccessfulParams) {
  return {
    subject: `Payment confirmed — ${p.planName} plan`,
    html: renderTemplate('payment-successful', {
      plan_name: p.planName,
      amount: p.amount,
      date: p.date,
      next_billing_date: p.nextBillingDate,
      billing_url: p.billingUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function paymentFailedEmail(p: PaymentFailedParams) {
  return {
    subject: 'Action needed — payment failed',
    html: renderTemplate('payment-failed', {
      plan_name: p.planName,
      amount: p.amount,
      date: p.date,
      grace_period_end: p.gracePeriodEnd,
      update_url: p.updateUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function subscriptionCancelledEmail(p: SubscriptionCancelledParams) {
  return {
    subject: 'Your Mnema subscription has been cancelled',
    html: renderTemplate('subscription-cancelled', {
      plan_name: p.planName,
      access_end_date: p.accessEndDate,
      reactivate_url: p.reactivateUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function loginAlertEmail(p: LoginAlertParams) {
  return {
    subject: 'New sign-in to your Mnema account',
    html: renderTemplate('login-alert', {
      login_time: p.loginTime,
      ip_location: p.ipLocation,
      device: p.device,
      secure_url: p.secureUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function trialEndingEmail(p: TrialEndingParams) {
  return {
    subject: `Your Mnema trial ends in ${p.daysRemaining} days`,
    html: renderTemplate('trial-ending', {
      days_remaining: p.daysRemaining,
      trial_end_date: p.trialEndDate,
      upgrade_url: p.upgradeUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function renewalReminderEmail(p: RenewalReminderParams) {
  return {
    subject: 'Your Mnema subscription renews in 7 days',
    html: renderTemplate('renewal-reminder', {
      plan_name: p.planName,
      renewal_date: p.renewalDate,
      amount: p.amount,
      payment_method: p.paymentMethod,
      billing_url: p.billingUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

export function mcpConnectedEmail(p: McpConnectedParams) {
  return {
    subject: `Claude is now connected to ${p.workspaceName}`,
    html: renderTemplate('mcp-connected', {
      workspace_name: p.workspaceName,
      connection_time: p.connectionTime,
      device: p.device,
      claude_url: p.claudeUrl,
      unsubscribe_url: UNSUBSCRIBE_URL,
    }),
  };
}

// ─── Legacy inline templates (kept for any direct callers not yet on queue) ───

/** @deprecated Use workspaceInvitationEmail() via the email queue instead. */
export function passwordResetEmail(_params: { resetUrl: string }): {
  subject: string;
  html: string;
} {
  return {
    subject: 'Reset your Mnema password',
    html: '<p>Password reset is handled by WorkOS — this stub should not be called.</p>',
  };
}
