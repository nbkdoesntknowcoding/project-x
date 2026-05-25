/**
 * Mnema transactional email templates.
 *
 * Each function returns { subject, html }. HTML is inlined — no external
 * fonts, no images. Dark-themed to match the product aesthetic.
 *
 * Design tokens:
 *   bg:       #0a0a0a
 *   surface:  #18181b
 *   text:     #fafafa
 *   muted:    #a1a1aa
 *   border:   #27272a
 *   cta-bg:   #fafafa
 *   cta-text: #0a0a0a
 *   font:     -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif
 */

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;

function base(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:${FONT};color:#fafafa;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#18181b;border-radius:12px;border:1px solid #27272a;padding:40px;">
        <tr><td>
          <p style="margin:0 0 32px;font-size:20px;font-weight:600;color:#fafafa;letter-spacing:-0.3px;">Mnema</p>
          ${content}
          <hr style="border:none;border-top:1px solid #27272a;margin:32px 0;" />
          <p style="margin:0;font-size:12px;color:#52525b;line-height:1.6;">
            Mnema by The Boring People &nbsp;·&nbsp;
            <a href="https://mnema.theboringpeople.in" style="color:#52525b;text-decoration:underline;">mnema.theboringpeople.in</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(text: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:#fafafa;color:#0a0a0a;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin:24px 0;">${text}</a>`;
}

// ── Templates ──────────────────────────────────────────────────────────────

export function welcomeEmail(params: {
  workspaceName: string;
  loginUrl: string;
}): { subject: string; html: string } {
  const subject = `Welcome to ${params.workspaceName} on Mnema`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">You're in. 🎉</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      Your workspace <strong style="color:#fafafa;">${params.workspaceName}</strong> is ready on Mnema.
      Start by inviting your team or creating your first document.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      Everything is stored in your workspace and accessible from Claude via the MCP integration.
    </p>
    ${ctaButton('Open Mnema', params.loginUrl)}
    <p style="margin:8px 0 0;font-size:13px;color:#52525b;">
      If you didn't create this workspace, you can safely ignore this email.
    </p>
  `);
  return { subject, html };
}

export function invitationEmail(params: {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
}): { subject: string; html: string } {
  const subject = `${params.inviterName} invited you to ${params.workspaceName} on Mnema`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">You've been invited</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      <strong style="color:#fafafa;">${params.inviterName}</strong> has invited you to join
      <strong style="color:#fafafa;">${params.workspaceName}</strong> on Mnema.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      Accept the invitation to access the workspace and collaborate with your team.
    </p>
    ${ctaButton('Accept Invitation', params.acceptUrl)}
    <p style="margin:8px 0 0;font-size:13px;color:#52525b;">
      This invitation link expires in 7 days. If you weren't expecting this, you can safely ignore it.
    </p>
  `);
  return { subject, html };
}

export function passwordResetEmail(params: {
  resetUrl: string;
}): { subject: string; html: string } {
  const subject = `Reset your Mnema password`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">Reset your password</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      We received a request to reset the password for your Mnema account.
      Click the button below to set a new password.
    </p>
    ${ctaButton('Reset Password', params.resetUrl)}
    <p style="margin:8px 0 0;font-size:13px;color:#52525b;">
      This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
    </p>
  `);
  return { subject, html };
}

export function loginAlertEmail(params: {
  ipAddress: string;
  userAgent: string;
  time: string;
  workspaceName: string;
}): { subject: string; html: string } {
  const subject = `New sign-in to your Mnema account`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">New sign-in detected</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      A new sign-in to your <strong style="color:#fafafa;">${params.workspaceName}</strong> workspace was detected.
    </p>
    <table style="background:#0a0a0a;border-radius:8px;padding:16px;margin:0 0 16px;width:100%;border:1px solid #27272a;" cellpadding="0" cellspacing="0">
      <tr><td style="padding:4px 0;font-size:13px;color:#a1a1aa;">Time</td><td style="padding:4px 0;font-size:13px;color:#fafafa;">${params.time}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#a1a1aa;">IP Address</td><td style="padding:4px 0;font-size:13px;color:#fafafa;">${params.ipAddress}</td></tr>
      <tr><td style="padding:4px 0;font-size:13px;color:#a1a1aa;">Device</td><td style="padding:4px 0;font-size:13px;color:#fafafa;">${params.userAgent}</td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      If this was you, no action is needed. If you don't recognise this sign-in,
      please secure your account immediately.
    </p>
    ${ctaButton('Review Account Security', 'https://mnema.theboringpeople.in/app')}
  `);
  return { subject, html };
}

export function paymentFailedEmail(params: {
  workspaceName: string;
  billingUrl: string;
  amount: string;
}): { subject: string; html: string } {
  const subject = `Payment failed for ${params.workspaceName}`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">Payment failed</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      We were unable to process your payment of <strong style="color:#fafafa;">${params.amount}</strong>
      for <strong style="color:#fafafa;">${params.workspaceName}</strong>.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      Your subscription will be paused if the payment is not resolved within the next few days.
      Please update your payment method to continue using Mnema without interruption.
    </p>
    ${ctaButton('Update Payment Method', params.billingUrl)}
    <p style="margin:8px 0 0;font-size:13px;color:#52525b;">
      If you believe this is an error, contact us at hello@theboringpeople.in.
    </p>
  `);
  return { subject, html };
}

export function subscriptionCancelledEmail(params: {
  workspaceName: string;
  endDate: string;
}): { subject: string; html: string } {
  const subject = `Your Mnema subscription has been cancelled`;
  const html = base(`
    <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#fafafa;">Subscription cancelled</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      The subscription for <strong style="color:#fafafa;">${params.workspaceName}</strong> has been cancelled.
      You'll continue to have access until <strong style="color:#fafafa;">${params.endDate}</strong>,
      after which the workspace will revert to the free plan.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#a1a1aa;line-height:1.6;">
      We're sorry to see you go. You can resubscribe at any time from your billing settings.
    </p>
    ${ctaButton('Resubscribe', 'https://mnema.theboringpeople.in/app')}
    <p style="margin:8px 0 0;font-size:13px;color:#52525b;">
      If you cancelled by mistake or have questions, contact us at hello@theboringpeople.in.
    </p>
  `);
  return { subject, html };
}
