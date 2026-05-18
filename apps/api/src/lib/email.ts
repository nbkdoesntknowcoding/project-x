import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Email sender abstraction.
 *
 * Phase 4.1: stdout. Every "email" prints a clearly-bracketed block to
 * the api stdout containing the recipient, subject, and body — including
 * any accept URLs. The block is deliberately copy-pasteable so the dev
 * smoke flow is: invite → see stdout → copy URL → open in new tab.
 *
 * Phase D swaps this implementation for SendGrid/Resend. The interface
 * shape (`EmailSender.sendInvitation`) stays — production wiring just
 * provides a new class.
 *
 * Templates live in `src/emails/*.md` so copy edits don't need code
 * changes. `{{var}}` placeholders are interpolated by the simple
 * `render()` helper below — keep it dependency-free.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '..', 'emails');

export interface InvitationEmailVars {
  recipientEmail: string;
  workspaceName: string;
  inviterName: string;
  acceptUrl: string;
  expiresInDays: number;
}

export interface EmailSender {
  sendInvitation(vars: InvitationEmailVars): Promise<void>;
}

function loadTemplate(name: string): string {
  return readFileSync(join(TEMPLATE_DIR, `${name}.md`), 'utf-8');
}

function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

class StdoutEmailSender implements EmailSender {
  async sendInvitation(vars: InvitationEmailVars): Promise<void> {
    const body = render(loadTemplate('invitation'), {
      workspace_name: vars.workspaceName,
      inviter_name: vars.inviterName,
      accept_url: vars.acceptUrl,
      expires_in_days: vars.expiresInDays,
    });
    const subject = `${vars.inviterName} invited you to ${vars.workspaceName} on Mnema`;
    // eslint-disable-next-line no-console
    console.log('\n========== EMAIL (dev mode — stdout) ==========');
    // eslint-disable-next-line no-console
    console.log(`To:      ${vars.recipientEmail}`);
    // eslint-disable-next-line no-console
    console.log(`Subject: ${subject}`);
    // eslint-disable-next-line no-console
    console.log('---');
    // eslint-disable-next-line no-console
    console.log(body.trim());
    // eslint-disable-next-line no-console
    console.log('========== END EMAIL ==========\n');
  }
}

// Phase D will conditionally export a SendGrid/Resend sender when an
// EMAIL_PROVIDER env var is set. For 4.1 it's stdout, period.
export const emailSender: EmailSender = new StdoutEmailSender();
