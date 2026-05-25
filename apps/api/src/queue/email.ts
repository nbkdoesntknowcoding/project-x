/**
 * BullMQ Queue declaration for the email pipeline.
 *
 * Mirrors the pattern from queue/embeddings.ts — imported by BOTH the api
 * process (which enqueues) AND the worker process (which dequeues).
 *
 * Job types:
 *   invitation   — workspace invitation email
 *   welcome      — new workspace welcome email
 *   login_alert  — sign-in notification
 *   payment_failed — payment failure notification
 *
 * Retry: 3 attempts with exponential backoff. On exhaustion, BullMQ moves
 * the job to the failed set and the worker logs the data so it can be
 * reprocessed manually if needed.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/env.js';

export const EMAIL_QUEUE_NAME = 'email';

export type EmailJobType = 'invitation' | 'welcome' | 'login_alert' | 'payment_failed';

export interface InvitationJobParams {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
}

export interface WelcomeJobParams {
  workspaceName: string;
  loginUrl: string;
}

export interface LoginAlertJobParams {
  ipAddress: string;
  userAgent: string;
  time: string;
  workspaceName: string;
}

export interface PaymentFailedJobParams {
  workspaceName: string;
  billingUrl: string;
  amount: string;
}

export type EmailJobParams =
  | InvitationJobParams
  | WelcomeJobParams
  | LoginAlertJobParams
  | PaymentFailedJobParams;

export interface EmailJobData {
  type: EmailJobType;
  to: string;
  params: EmailJobParams;
}

const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 86400 },
  },
});
