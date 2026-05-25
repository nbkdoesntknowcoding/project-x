/**
 * Email sender abstraction.
 *
 * Phase 4.1: stdout stub for local dev (StdoutEmailSender).
 * Phase C: ResendEmailSender for production — activated when RESEND_API_KEY
 * is set. The fallback to StdoutEmailSender means local dev without a key
 * still works — every "email" prints a clearly-bracketed block to stdout.
 *
 * The EmailSender interface is the public contract. All callers (invitations,
 * auth) import only the interface + the exported emailSender singleton.
 * Swapping implementations never touches call sites.
 */

import { Resend } from 'resend';
import { invitationEmail } from '../emails/templates.js';

// ── Public interfaces ──────────────────────────────────────────────────────

export interface InvitationEmailVars {
  recipientEmail: string;
  workspaceName: string;
  inviterName: string;
  acceptUrl: string;
  expiresInDays: number;
}

export interface EmailSender {
  /** Low-level send — used by welcome email and other one-off sends. */
  send(to: string, subject: string, html: string): Promise<void>;
  /** Convenience wrapper for the invitation flow. */
  sendInvitation(vars: InvitationEmailVars): Promise<void>;
}

// ── StdoutEmailSender (local dev / no API key) ────────────────────────────

class StdoutEmailSender implements EmailSender {
  async send(to: string, subject: string, html: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('\n========== EMAIL (dev mode — stdout) ==========');
    // eslint-disable-next-line no-console
    console.log(`To:      ${to}`);
    // eslint-disable-next-line no-console
    console.log(`Subject: ${subject}`);
    // eslint-disable-next-line no-console
    console.log('---');
    // eslint-disable-next-line no-console
    console.log(html);
    // eslint-disable-next-line no-console
    console.log('========== END EMAIL ==========\n');
  }

  async sendInvitation(vars: InvitationEmailVars): Promise<void> {
    const { subject, html } = invitationEmail({
      inviterName: vars.inviterName,
      workspaceName: vars.workspaceName,
      acceptUrl: vars.acceptUrl,
    });
    await this.send(vars.recipientEmail, subject, html);
  }
}

// ── ResendEmailSender (production / RESEND_API_KEY present) ───────────────

class ResendEmailSender implements EmailSender {
  private client: Resend;
  private from: string;

  constructor() {
    if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
    this.client = new Resend(process.env.RESEND_API_KEY);
    this.from = process.env.RESEND_FROM_ADDRESS ?? 'noreply@mnema.theboringpeople.in';
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });
    if (error) throw new Error(`Resend error: ${(error as { message?: string }).message ?? String(error)}`);
  }

  async sendInvitation(vars: InvitationEmailVars): Promise<void> {
    const { subject, html } = invitationEmail({
      inviterName: vars.inviterName,
      workspaceName: vars.workspaceName,
      acceptUrl: vars.acceptUrl,
    });
    await this.send(vars.recipientEmail, subject, html);
  }
}

// ── Singleton export ───────────────────────────────────────────────────────

// Use ResendEmailSender in production or when a key is explicitly provided
// for integration testing. Fall back to stdout for local dev without a key.
export const emailSender: EmailSender =
  process.env.NODE_ENV === 'production' || process.env.RESEND_API_KEY
    ? new ResendEmailSender()
    : new StdoutEmailSender();
