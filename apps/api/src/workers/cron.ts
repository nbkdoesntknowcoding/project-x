/**
 * Cron workers:
 *   01:00 UTC — refresh workspace_session_stats materialized view
 *   02:00 UTC — optimization engine (all dev_project workspaces)
 *   03:00 UTC — data retention cleanup (tool_calls, file_diffs, optimization_findings, fix_history)
 */

import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import { workspaces } from '../db/schema.js';
import { redisConnection } from '../lib/redis.js';
import { runOptimizationForWorkspace } from '../lib/dev/optimization/runner.js';

const log = pino({ name: 'cron' });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// postgres-js RowList has a `count` property (number of affected rows)
interface PgResult {
  count: number;
}

// ── Queues ────────────────────────────────────────────────────────────────────

const statsQueue        = new Queue('stats-refresh-cron',  { connection: redisConnection });
const optimizationQueue = new Queue('optimization-cron',   { connection: redisConnection });
const retentionQueue    = new Queue('retention-cron',      { connection: redisConnection });

async function registerCronJobs(): Promise<void> {
  await statsQueue.add('hourly-stats-refresh', {}, {
    repeat: { pattern: '0 * * * *' }, // every hour on the hour
    jobId: 'stats-hourly',
  });

  await optimizationQueue.add('nightly-run', {}, {
    repeat: { pattern: '0 2 * * *' },
    jobId: 'optimization-nightly',
  });

  await retentionQueue.add('nightly-cleanup', {}, {
    repeat: { pattern: '0 3 * * *' },
    jobId: 'retention-nightly',
  });

  log.info('Cron jobs registered: stats@every-hour, optimization@02:00 UTC, retention@03:00 UTC');
}

// ── Stats refresh cron processor ──────────────────────────────────────────────

async function processStatsRefreshCron(_job: Job): Promise<void> {
  try {
    await withSystemPrivilege((tx) =>
      tx.execute(sql`SELECT refresh_workspace_session_stats()`),
    );
    log.info('Refreshed workspace_session_stats materialized view');
  } catch (err) {
    log.error({ err }, 'Stats refresh cron failed');
  }
}

// ── Optimization cron processor ───────────────────────────────────────────────

async function processOptimizationCron(_job: Job): Promise<void> {
  const rows = await withSystemPrivilege((tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.mode, 'dev_project')),
  );

  log.info({ workspaceCount: rows.length }, 'Running optimization engine for all dev_project workspaces');

  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const { id } = rows[i]!;
    try {
      const newFindings = await runOptimizationForWorkspace(id);
      total += newFindings;
      if (i < rows.length - 1) await sleep(100);
    } catch (err) {
      log.error({ err, workspaceId: id }, 'Optimization cron failed for workspace');
    }
  }

  log.info({ total }, 'Optimization cron complete');
}

// ── Retention cron processor ──────────────────────────────────────────────────

async function batchDelete(query: () => Promise<unknown>): Promise<number> {
  let totalDeleted = 0;
  let deleted: number;
  do {
    const result = await query() as PgResult;
    deleted = result.count ?? 0;
    totalDeleted += deleted;
    if (deleted > 0) await sleep(100);
  } while (deleted > 0);
  return totalDeleted;
}

async function processRetentionCron(_job: Job): Promise<void> {
  const rows = await withSystemPrivilege((tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.mode, 'dev_project')),
  );

  for (const { id: workspaceId } of rows) {
    try {
      // Job 1: tool_calls older than 30 days (batch delete)
      const toolCallsDeleted = await batchDelete(() =>
        withSystemPrivilege((tx) =>
          tx.execute(sql`
            DELETE FROM tool_calls
            WHERE id IN (
              SELECT id FROM tool_calls
              WHERE workspace_id = ${workspaceId}
              AND timestamp < NOW() - INTERVAL '30 days'
              LIMIT 1000
            )
          `),
        ),
      );

      // Job 2: file_diffs older than 30 days
      const fileDiffsResult = (await withSystemPrivilege((tx) =>
        tx.execute(sql`
          DELETE FROM file_diffs
          WHERE workspace_id = ${workspaceId}
          AND timestamp < NOW() - INTERVAL '30 days'
        `),
      )) as unknown as PgResult;

      // Job 3: applied optimization_findings older than 30 days
      const findingsResult = (await withSystemPrivilege((tx) =>
        tx.execute(sql`
          DELETE FROM optimization_findings
          WHERE workspace_id = ${workspaceId}
          AND applied = true
          AND created_at < NOW() - INTERVAL '30 days'
        `),
      )) as unknown as PgResult;

      // Job 4: fix_history older than 90 days
      const fixHistoryResult = (await withSystemPrivilege((tx) =>
        tx.execute(sql`
          DELETE FROM fix_history
          WHERE workspace_id = ${workspaceId}
          AND created_at < NOW() - INTERVAL '90 days'
        `),
      )) as unknown as PgResult;

      log.info({
        workspaceId,
        toolCallsDeleted,
        fileDiffsDeleted: fileDiffsResult.count ?? 0,
        findingsDeleted: findingsResult.count ?? 0,
        fixHistoryDeleted: fixHistoryResult.count ?? 0,
      }, 'Retention cleanup complete for workspace');

    } catch (err) {
      log.error({ err, workspaceId }, 'Retention cron failed for workspace');
    }
  }
}

// ── Worker startup ────────────────────────────────────────────────────────────

export function startCronWorkers(): { close(): Promise<void> } {
  const conn1 = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const conn2 = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const conn3 = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });

  const statsWorker = new Worker('stats-refresh-cron', processStatsRefreshCron, {
    connection: conn1,
    concurrency: 1,
  });

  const optWorker = new Worker('optimization-cron', processOptimizationCron, {
    connection: conn2,
    concurrency: 1,
  });

  const retWorker = new Worker('retention-cron', processRetentionCron, {
    connection: conn3,
    concurrency: 1,
  });

  statsWorker.on('failed', (job, err) => log.error({ jobId: job?.id, err }, 'Stats refresh cron failed'));
  optWorker.on('failed',   (job, err) => log.error({ jobId: job?.id, err }, 'Optimization cron job failed'));
  retWorker.on('failed',   (job, err) => log.error({ jobId: job?.id, err }, 'Retention cron job failed'));

  void registerCronJobs();

  return {
    async close() {
      await statsWorker.close();
      await optWorker.close();
      await retWorker.close();
    },
  };
}
