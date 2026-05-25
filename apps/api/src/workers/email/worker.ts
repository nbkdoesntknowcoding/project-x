/**
 * BullMQ Worker for the email queue.
 *
 * Mirrors the pattern from workers/embeddings/worker.ts. Concurrency is
 * intentionally low (2) — email sends are fast I/O but we don't want to
 * hammer Resend's API limits on burst enqueues.
 *
 * On retry exhaustion, BullMQ keeps the job in the failed set with the
 * full job data — can be manually reprocessed via BullMQ dashboard or CLI.
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config/env.js';
import { emailSender } from '../../lib/email.js';
import {
  invitationEmail,
  loginAlertEmail,
  paymentFailedEmail,
  welcomeEmail,
} from '../../emails/templates.js';
import {
  type EmailJobData,
  EMAIL_QUEUE_NAME,
  type InvitationJobParams,
  type LoginAlertJobParams,
  type PaymentFailedJobParams,
  type WelcomeJobParams,
} from '../../queue/email.js';

export function startEmailWorker(): Worker<EmailJobData> {
  const connection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job) => {
      const { type, to, params } = job.data;

      switch (type) {
        case 'invitation': {
          const p = params as InvitationJobParams;
          const { subject, html } = invitationEmail(p);
          await emailSender.send(to, subject, html);
          break;
        }
        case 'welcome': {
          const p = params as WelcomeJobParams;
          const { subject, html } = welcomeEmail(p);
          await emailSender.send(to, subject, html);
          break;
        }
        case 'login_alert': {
          const p = params as LoginAlertJobParams;
          const { subject, html } = loginAlertEmail(p);
          await emailSender.send(to, subject, html);
          break;
        }
        case 'payment_failed': {
          const p = params as PaymentFailedJobParams;
          const { subject, html } = paymentFailedEmail(p);
          await emailSender.send(to, subject, html);
          break;
        }
        default:
          console.error(`[email-worker] unknown job type: ${String(type)}`);
      }
    },
    {
      connection,
      concurrency: 2,
    },
  );

  worker.on('completed', (job) => {
    // eslint-disable-next-line no-console
    console.log(`[email] ${job.id} sent type=${job.data.type} to=${job.data.to}`);
  });
  worker.on('failed', (job, err) => {
    console.error(
      `[email] ${job?.id ?? '?'} failed type=${job?.data.type} to=${job?.data.to}: ${err.message}`,
      { jobData: job?.data },
    );
  });
  worker.on('error', (err) => {
    console.error('[email] worker error:', err);
  });

  return worker;
}
